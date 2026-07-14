/**
 * GPU 게스트 폴러 — 설정에서 선택한 법인(vCenter)의 패스쓰루 GPU VM을 게스트 OS
 * 계정으로 폴링해 사용률을 수집한다. 결과는 gpu/store.js 오버레이에 저장되어
 * /tools/gpu 와 metrics 샘플러가 사용한다.
 *
 * 설계 원칙(CLAUDE.md): 법인별 병렬 + per-VM 타임아웃 + 동시성 제한으로 고RTT·
 * 다수 vCenter에서도 이벤트 루프를 막지 않는다. 모든 실패는 격리한다.
 */

import { config, loadVcenterConfig } from '../config.js';
import { store } from '../store.js';
import { loadGpuGuestSettings, resolveVmCreds, resolveVmIp } from './settings.js';
import { setGuestGpu, pruneGuestGpu, guestGpuCounts } from './store.js';
import { collectVmGpu, VimSoapClient } from './guestops.js';
import { collectVmGpuSsh, guestIps } from './sshCollect.js';
import { isStopped } from '../security/emergencyStop.js';

let timer = null;
let lastRun = null;
let lastDiag = null; // { at, mode, vcenters:[{vcId, stage, counts, results, error}] }
let running = false;
const learnedMethod = new Map(); // vmId -> 'ssh'|'guestops' : auto 모드에서 직전에 성공한 수집 방식(다음 주기 우선)

// 간단한 동시성 제한 실행기.
async function eachLimited(items, limit, fn) {
  const q = [...items];
  const workers = Array.from({ length: Math.min(limit, q.length || 1) }, async () => {
    while (q.length) { const it = q.shift(); try { await fn(it); } catch { /* isolated */ } }
  });
  await Promise.all(workers);
}

export function passthruHostIds(snap, vcId) {
  const ids = new Set();
  for (const h of snap.hosts || []) {
    if (h.vcenterId !== vcId) continue;
    if ((h.gpus || []).some((g) => (g.mode || (g.vgpuMode ? 'vgpu' : 'passthrough')) === 'passthrough')) ids.add(h.name);
  }
  return ids;
}

/** 이 VM이 GPU를 '패스쓰루(DirectPath I/O)'로 할당받았는지 — 게스트 수집 대상 판별. */
export function vmUsesPassthroughGpu(v) {
  const g = v && v.gpu;
  if (!g) return false;
  return (g.passthrough || 0) > 0 || g.type === 'passthrough' || g.type === 'mixed';
}

/** GPU가 달린 호스트(패스쓰루+vGPU 모두). 게스트 수집 호스트 후보. */
export function gpuHostIds(snap, vcId) {
  const ids = new Set();
  for (const h of snap.hosts || []) { if (h.vcenterId === vcId && (h.gpus || []).length) ids.add(h.name); }
  return ids;
}

/** GPU가 할당된 VM이면 게스트 수집 대상(패스쓰루·vGPU 공통). nvidia-smi는 vGPU 게스트에서도 동작. */
export function vmUsesGpu(v) { return !!(v && v.gpu); }

// 데모(mock): 선택 법인의 패스쓰루 호스트/VM에 합성 사용률을 채운다.
function pollMock(snap, vcId) {
  const hostNames = gpuHostIds(snap, vcId);
  const hosts = [];
  const vms = [];
  const t = Date.now() / 60000;
  for (const h of snap.hosts || []) {
    if (h.vcenterId !== vcId || !hostNames.has(h.name)) continue;
    const util = Math.round(40 + 45 * Math.abs(Math.sin((hashStr(h.id) % 50) + t / 7)));
    hosts.push({ hostId: h.id, utilPct: Math.min(100, util) });
  }
  for (const v of snap.vms || []) {
    if (v.vcenterId !== vcId || !hostNames.has(v.host) || v.powerState !== 'POWERED_ON' || !vmUsesGpu(v) || v.template) continue;
    const util = Math.round(30 + 60 * Math.abs(Math.sin((hashStr(v.id) % 80) + t / 5)));
    vms.push({ vmId: v.id, host: v.host, vcenterId: vcId, utilPct: Math.min(100, util), memUsedPct: Math.min(100, util + 10) });
  }
  return { hosts, vms };
}

const hashStr = (s) => { let h = 0; for (let i = 0; i < String(s).length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };

// 라이브(beta): VMware Tools 게스트 작업으로 nvidia-smi 실행. {hosts, vms, diag} 반환.
async function pollLive(snap, vc, s) {
  const hostNames = gpuHostIds(snap, vc.id);
  // 선별 깔때기 — 어느 조건에서 VM이 빠지는지 단계별로 로깅 + 진단 데이터.
  // 대상: GPU(패스쓰루+vGPU) 할당 VM. nvidia-smi는 vGPU 게스트에서도 사용률을 보고한다.
  const onHost = (snap.vms || []).filter((v) => v.vcenterId === vc.id && hostNames.has(v.host));
  const gpuVms = onHost.filter((v) => vmUsesGpu(v) && !v.template);
  // 수집 가능 상태: guestops는 Tools RUNNING 필요. ssh/auto는 Tools 미동작이어도 게스트 IP가 있으면 SSH로 수집 가능.
  const method = s.collectMethod || 'auto';
  const onTools = gpuVms.filter((v) => v.powerState === 'POWERED_ON'
    && (v.toolsStatus === 'RUNNING' || (method !== 'guestops' && guestIps(v).length > 0)));
  const cands = onTools.filter((v) => resolveVmCreds(s, vc.id, v.id, /windows/i.test(v.guestOS || ''))).slice(0, s.maxVmsPerVcenter || 1000);
  const counts = { gpuHosts: hostNames.size, vmsOnHost: onHost.length, gpuVms: gpuVms.length, onTools: onTools.length, candidates: cands.length };
  console.log(`[gpu-guest] ${vc.id} 선별: GPU호스트=${counts.gpuHosts} · 호스트위VM=${counts.vmsOnHost} · GPU할당VM=${counts.gpuVms} · On+Tools=${counts.onTools} · 계정있음(수집대상)=${counts.candidates}`);
  const diag = { vcId: vc.id, at: Date.now(), stage: '선별', counts, results: [], error: null };
  if (!cands.length) {
    diag.stage = counts.gpuHosts === 0 ? 'GPU 호스트 없음'
      : counts.gpuVms === 0 ? 'GPU 할당 VM 없음'
        : counts.onTools === 0 ? 'On+Tools VM 없음' : '수집 대상 계정 없음';
    return { hosts: [], vms: [], diag };
  }
  // 호스트명 → 게스트파일 다운로드 후보. guestFile은 오직 "그 VM이 떠 있는 ESXi 호스트"만
  // 서빙한다(vCenter는 항상 HTTP404). 따라서 ESXi 자신의 주소만 후보로 둔다:
  //   h.mgmtIp = ESXi 관리 vmk IP(예: 192.168.10.x), h.name = ESXi FQDN.
  // ⚠️ h.mgmtServerIp 는 'ESXi를 관리하는 vCenter IP'라 404만 유발 → 후보에서 제외.
  // (readGuestFile이 마지막 폴백으로 vCenter host를 한 번 더 시도하므로 누락 위험 없음)
  const dlByHost = new Map();
  for (const h of snap.hosts || []) if (h.vcenterId === vc.id) dlByHost.set(h.name, [h.mgmtIp, h.name].filter(Boolean));
  const c = new VimSoapClient(vc);
  try { await c.login(); }
  catch (e) { diag.stage = 'vCenter 로그인 실패'; diag.error = e.message; console.warn(`[gpu-guest] ${vc.id} vCenter 로그인 실패: ${e.message}`); return { hosts: [], vms: [], diag }; }
  diag.stage = '수집';
  console.log(`[gpu-guest] ${vc.id} vCenter 로그인 OK → ${cands.length}개 VM 수집 시작(동시 ${s.concurrency}, 타임아웃 ${Math.round((s.timeoutMs || 20000) / 1000)}s)`);
  const vms = [];
  const byHost = new Map();
  try {
    await eachLimited(cands, s.concurrency, async (v) => {
      const isWindows = /windows/i.test(v.guestOS || '');
      const creds = resolveVmCreds(s, vc.id, v.id, isWindows);
      if (!creds) return;
      const moref = String(v.id).split(':').slice(1).join(':');
      const dlHosts = dlByHost.get(v.host) || [];
      const method = s.collectMethod || 'auto';
      console.log(`[gpu-guest]   → ${v.name} (${moref}) host=${v.host} 계정=${creds.username}(${creds.source}) 방식=${method} dl후보=[${dlHosts.join(', ')}]`);
      let err = null;
      // 'ssh'=직접 SSH+nvidia-smi · 'auto'=게스트작업 먼저→실패 시 SSH(+VM별 성공 방식 학습) · 'guestops'=VMware Tools.
      const viaSsh = () => collectVmGpuSsh(v, creds, { timeoutMs: s.timeoutMs, port: s.sshPort, preferIp: resolveVmIp(s, vc.id, v.id) });
      const viaGuestops = () => collectVmGpu(c, moref, creds, { isWindows, timeoutMs: s.timeoutMs, dlHosts });
      let r = null, usedMethod = method;
      if (method === 'ssh') {
        r = await viaSsh().catch((e) => { err = e.message; return null; });
      } else if (method === 'auto') {
        // 직전 성공 방식을 먼저(학습). 처음엔 게스트작업 → 실패하면 SSH 폴백. 추가 설정 없이 자동 수집.
        const order = learnedMethod.get(v.id) === 'ssh' ? ['ssh', 'guestops'] : ['guestops', 'ssh'];
        for (const m of order) {
          r = await (m === 'ssh' ? viaSsh() : viaGuestops()).catch((e) => { err = e.message; return null; });
          if (r && r.utilPct != null) {
            // 삭제된 VM의 키가 무한 누적되지 않도록 상한 — 넘으면 비우고 다시 학습(무해).
            if (learnedMethod.size > 20000) learnedMethod.clear();
            usedMethod = m; learnedMethod.set(v.id, m); break;
          }
        }
      } else {
        r = await viaGuestops().catch((e) => { err = e.message; return null; });
      }
      if (!(r && r.utilPct != null) && err) console.warn(`[gpu-guest]   ✗ ${v.name}: ${err}`);
      // 진단에 시도한 OS/계정·실제 사용 방식도 남긴다(인증 실패 시 식별 — 비번 제외).
      const osLabel = isWindows ? 'Windows' : 'Linux';
      const acct = `${creds.username}(${creds.source})·${usedMethod}`;
      if (r && r.utilPct != null) {
        console.log(`[gpu-guest]   ✓ ${v.name}: util=${r.utilPct}% mem=${r.memUsedPct ?? '-'}% gpus=${r.count}`);
        vms.push({ vmId: v.id, host: v.host, vcenterId: vc.id, utilPct: r.utilPct, memUsedPct: r.memUsedPct });
        const arr = byHost.get(v.host) || []; arr.push(r.utilPct); byHost.set(v.host, arr);
        if (diag.results.length < 200) diag.results.push({ vm: v.name, host: v.host, vcenterId: vc.id, os: osLabel, account: acct, ok: true, util: r.utilPct, mem: r.memUsedPct ?? null, gpus: r.count });
      } else if (diag.results.length < 200) {
        diag.results.push({ vm: v.name, host: v.host, vcenterId: vc.id, os: osLabel, account: acct, ok: false, error: err || 'nvidia-smi 결과 없음(stdout 비어있음)' });
      }
    });
  } finally { await c.logout().catch(() => {}); }
  // 호스트 사용률 = 그 호스트 GPU VM들의 최댓값(대표).
  const hosts = [];
  for (const h of snap.hosts || []) {
    if (h.vcenterId !== vc.id) continue;
    const arr = byHost.get(h.name);
    if (arr && arr.length) hosts.push({ hostId: h.id, utilPct: Math.max(...arr) });
  }
  diag.stage = '완료'; diag.collected = vms.length;
  console.log(`[gpu-guest] ${vc.id} 수집 완료: 호스트=${hosts.length} · VM=${vms.length}`);
  return { hosts, vms, diag };
}

async function pollOnce() {
  if (running) return;
  running = true;
  try {
    if (isStopped()) { lastRun = { at: Date.now(), skipped: '긴급중단' }; return; }
    const s = loadGpuGuestSettings();
    if (!s.enabled) { lastRun = { at: Date.now(), skipped: '비활성' }; return; }
    const snap = store.get();
    const enabledIds = Object.entries(s.vcenters).filter(([, v]) => v.enabled).map(([id]) => id);
    if (!enabledIds.length) { lastRun = { at: Date.now(), skipped: '대상 법인 없음' }; return; }

    const mock = snap.source === 'mock';
    const reg = mock ? [] : (loadVcenterConfig().vcenters || []);
    let collectedHosts = 0; let collectedVms = 0; let errors = 0;
    const diags = [];

    await eachLimited(enabledIds, Math.min(4, enabledIds.length), async (vcId) => {
      try {
        let result;
        if (mock) result = pollMock(snap, vcId);
        else {
          const vc = reg.find((x) => x.id === vcId);
          if (!vc) { diags.push({ vcId, at: Date.now(), stage: 'vCenter 미등록(vcenters.json)', counts: {}, results: [], error: '이 agent의 vcenters.json에 해당 id가 없음' }); return; }
          result = await pollLive(snap, vc, s);
        }
        setGuestGpu(result);
        if (result.diag) diags.push(result.diag);
        collectedHosts += result.hosts.length; collectedVms += result.vms.length;
      } catch (e) { errors++; console.warn(`[gpu-guest] ${vcId} 수집 실패: ${e.message}`); diags.push({ vcId, at: Date.now(), stage: '예외', counts: {}, results: [], error: e.message }); }
    });

    // 3주기 이상 갱신 안 된 항목 정리.
    pruneGuestGpu(s.pollIntervalMs * 3 + 30_000);
    lastRun = { at: Date.now(), mode: mock ? 'mock' : 'live', vcenters: enabledIds.length, hosts: collectedHosts, vms: collectedVms, errors, overlay: guestGpuCounts() };
    lastDiag = { at: Date.now(), mode: mock ? 'mock' : 'live', vcenters: diags };
  } finally { running = false; }
}

export function gpuGuestStatus() {
  const s = loadGpuGuestSettings();
  return { enabled: s.enabled, pollIntervalMs: s.pollIntervalMs, monitored: Object.values(s.vcenters).filter((v) => v.enabled).length, lastRun, overlay: guestGpuCounts() };
}

/** 마지막 수집 진단(선별 깔때기 + VM별 성공/실패·에러) — 웹 '수집 진단'에서 사용. */
export function getGpuGuestDiag() { return lastDiag; }

export function rescheduleGpuGuestPoller() {
  if (timer) clearInterval(timer);
  const { pollIntervalMs } = loadGpuGuestSettings();
  timer = setInterval(() => pollOnce().catch(() => {}), pollIntervalMs);
  timer.unref?.();
  return pollIntervalMs;
}

export function startGpuGuestPoller() {
  setTimeout(() => pollOnce().catch((e) => console.error('[gpu-guest] 폴 실패:', e.message)), 18_000).unref?.();
  const { pollIntervalMs } = loadGpuGuestSettings();
  timer = setInterval(() => pollOnce().catch(() => {}), pollIntervalMs);
  timer.unref?.();
  console.log(`[gpu-guest] poller started (every ${Math.round(pollIntervalMs / 1000)}s)`);
}
