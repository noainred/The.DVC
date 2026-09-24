/**
 * GPU 게스트 폴러 — 설정에서 선택한 법인(vCenter)의 패스쓰루 GPU VM을 게스트 OS
 * 계정으로 폴링해 사용률을 수집한다. 결과는 gpu/store.js 오버레이에 저장되어
 * /tools/gpu 와 metrics 샘플러가 사용한다.
 *
 * 설계 원칙(CLAUDE.md): 법인별 병렬 + per-VM 타임아웃 + 동시성 제한으로 고RTT·
 * 다수 vCenter에서도 이벤트 루프를 막지 않는다. 모든 실패는 격리한다.
 */

import { config, loadVcenterConfig } from '../config.js';
import { morefOf } from '../vcenter/registry.js';   // v2.447: vcenterId 에 콜론이 있어도 안전한 moref 추출(감사 B1)
import { store } from '../store.js';
import { loadGpuGuestSettings, resolveVmCreds, resolveVmIp, resolveCollectMethod } from './settings.js';
import { setGuestGpu, pruneGuestGpu, guestGpuCounts } from './store.js';
import { collectVmGpu, VimSoapClient } from './guestops.js';
import { collectVmGpuSsh, guestIps, gpuAuthGuard, gpuStopView, isGpuAuthError, pinnedIpCheck } from './sshCollect.js';
import { vcAuthGuard, isVcAuthError } from '../vcenter/restClient.js';
import { isStopped } from '../security/emergencyStop.js';
import { poolSettled } from '../util/pool.js'; // v2.579: 동시성 풀 단일 소스(util/pool.js) — 손으로 쓴 사본 제거

let timer = null;
let lastRun = null;
let lastDiag = null; // { at, mode, vcenters:[{vcId, stage, counts, results, error}] }
let running = false;
const learnedMethod = new Map(); // vmId -> 'ssh'|'guestops' : auto 모드에서 직전에 성공한 수집 방식(다음 주기 우선)

// 간단한 동시성 제한 실행기.

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
/**
 * v2.606(EDGE2606-01): 이 vCenter 의 인벤토리를 **읽었는가**(순수). 첫 수집 전(emptySnapshot)·대기·연결 실패·점검중이면
 * 'GPU 호스트 없음' 이 아니라 **모른다** — 그 빈 결과로 엣지가 push 하면 중앙이 그 법인 GPU 사용률을 지운다.
 * @returns {string} 못 읽은 사유('' = 읽음)
 */
export function inventoryUnreadReason(snap, vcId) {
  const vcs = Array.isArray(snap?.vcenters) ? snap.vcenters : [];
  const v = vcs.find((x) => x && x.id === vcId);
  if (!v) return '인벤토리 미수집(스냅샷에 이 vCenter 없음)';
  const st = String(v.status || '');
  if (st && st !== 'connected') return `인벤토리 미수집(상태 ${st})`;
  if (!(snap.hosts || []).some((h) => h && h.vcenterId === vcId)) return '인벤토리 미수집(호스트 0)';
  return '';
}

async function pollLive(snap, vc, s) {
  // v2.606(EDGE2606-01): 인벤토리를 못 읽은 vCenter 는 '읽지 못함'(unread) — 빈 목록을 정상 결과로 내지 않는다.
  const invUnread = inventoryUnreadReason(snap, vc.id);
  if (invUnread) {
    return { hosts: [], vms: [], unread: invUnread, diag: { vcId: vc.id, at: Date.now(), stage: invUnread, counts: {}, results: [], error: null, unread: true } };
  }
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
  // v2.590(감사 F1): vCenter 계정이 인증 실패로 멈춰 있으면 로그인하지 않는다 — 인벤토리 수집(store)과 **같은
  //   계정**이라 여기서 1분마다 따로 로그인하면 store 가 멈춰도 잠금은 그대로다(같은 정지 기록을 본다).
  const vcStop = vcAuthGuard.authStopFor(vc);
  if (vcStop) {
    diag.stage = 'vCenter 인증 실패 정지'; diag.error = vcStop.reason; diag.authStopped = gpuStopView(vcStop); diag.unread = true;
    return { hosts: [], vms: [], diag, unread: 'vCenter 인증 실패 정지' };
  }
  const c = new VimSoapClient(vc);
  try { await c.login(); }
  catch (e) {
    diag.stage = 'vCenter 로그인 실패'; diag.error = e.message; console.warn(`[gpu-guest] ${vc.id} vCenter 로그인 실패: ${e.message}`);
    if (isVcAuthError(e)) diag.authStopped = gpuStopView(vcAuthGuard.markAuthStopped(vc.id, vc, e.message));
    diag.unread = true;
    return { hosts: [], vms: [], diag, unread: 'vCenter 로그인 실패' };
  }
  diag.stage = '수집';
  console.log(`[gpu-guest] ${vc.id} vCenter 로그인 OK → ${cands.length}개 VM 수집 시작(동시 ${s.concurrency}, 타임아웃 ${Math.round((s.timeoutMs || 20000) / 1000)}s)`);
  const vms = [];
  const byHost = new Map();
  try {
    await poolSettled(cands, s.concurrency, async (v) => {
      const isWindows = /windows/i.test(v.guestOS || '');
      const creds = resolveVmCreds(s, vc.id, v.id, isWindows);
      if (!creds) return;
      const moref = morefOf(v.id, vc.id);
      const dlHosts = dlByHost.get(v.host) || [];
      // Windows는 기본적으로 OpenSSH 서버가 없어 SSH 단독('ssh')이면 수집이 실패한다. Windows VM은
      // VMware Tools 게스트 작업(cmd.exe /c nvidia-smi.exe) 우선(auto)으로 자동 조정(리눅스는 그대로).
      const method = resolveCollectMethod(s.collectMethod, isWindows);
      const winAdjusted = isWindows && (s.collectMethod || 'auto') === 'ssh';
      // v2.590(감사 F2): 이 VM 의 게스트 계정이 인증 실패로 멈춰 있으면 주기 수집에서 건너뛴다(이 폴러는 주기
      //   전용이다 — 수동 확인은 설정 화면의 '게스트 테스트'). 비밀번호를 고치면 credHash 가 바뀌어 자동 재개.
      const guestAuthId = `vm|${vc.id}|${v.id}`;
      const credDev = { id: guestAuthId, username: creds.username, password: creds.password };
      const gStop = gpuAuthGuard.authStopFor(credDev);
      if (gStop) {
        if (diag.results.length < 200) diag.results.push({ vm: v.name, host: v.host, vcenterId: vc.id, os: isWindows ? 'Windows' : 'Linux', account: `${creds.username}(${creds.source})`, ok: false, authStopped: gpuStopView(gStop), error: `인증 실패로 주기 수집 정지(${gStop.attempts}회) — 비밀번호를 고치면 자동 재개합니다` });
        diag.authStoppedVms = (diag.authStoppedVms || 0) + 1;
        return;
      }
      console.log(`[gpu-guest]   → ${v.name} (${moref}) host=${v.host} 계정=${creds.username}(${creds.source}) OS=${isWindows ? 'Windows' : 'Linux'} 방식=${method}${winAdjusted ? '(Windows용 게스트작업 우선 조정)' : ''} dl후보=[${dlHosts.join(', ')}]`);
      let err = null;
      let authFail = null;   // v2.590: 자격증명 거부(게스트 작업 InvalidGuestLogin · SSH client-authentication)
      // 'ssh'=직접 SSH+nvidia-smi · 'auto'=게스트작업 먼저→실패 시 SSH(+VM별 성공 방식 학습) · 'guestops'=VMware Tools.
      // v2.606(LEFT2606-01): 저장된 고정 IP 는 그 VM 이 보고한 IP 일 때만 쓴다 — 아니면 핀을 버리고(VM 의 알려진 IP 로만
      //   시도) 사유를 진단에 남긴다. 저장 자격증명을 VM 이 보고한 적 없는 주소로 보내지 않는다(연결 테스트와 같은 판정).
      const pin = pinnedIpCheck(v, resolveVmIp(s, vc.id, v.id));
      if (!pin.ok) {
        diag.pinRejected = (diag.pinRejected || 0) + 1;
        console.warn(`[gpu-guest]   ${v.name}: 고정 IP 가 이 VM 의 알려진 IP(${pin.known.join(', ') || '없음'})가 아니라 쓰지 않습니다(저장 자격증명 보호)`);
      }
      const viaSsh = () => collectVmGpuSsh(v, creds, { timeoutMs: s.timeoutMs, port: s.sshPort, preferIp: pin.ip });
      const viaGuestops = () => collectVmGpu(c, moref, creds, { isWindows, timeoutMs: s.timeoutMs, dlHosts });
      let r = null, usedMethod = method;
      if (method === 'ssh') {
        r = await viaSsh().catch((e) => { err = e.message; if (isGpuAuthError(e)) authFail = e; return null; });
      } else if (method === 'auto') {
        // 직전 성공 방식을 먼저(학습). 처음엔 게스트작업 → 실패하면 SSH 폴백. 추가 설정 없이 자동 수집.
        // Windows는 SSH 폴백이 대개 무의미(무sshd)하므로 항상 게스트작업 우선(학습된 ssh 무시).
        const order = (!isWindows && learnedMethod.get(v.id) === 'ssh') ? ['ssh', 'guestops'] : ['guestops', 'ssh'];
        // v2.583: 시도마다 사유를 따로 모은다. 예전에는 err 하나를 덮어써 **마지막 시도(대개 SSH 폴백)의
        // 사유만** 남았다 — Windows VM 은 sshd 가 없어 항상 'SSH 타임아웃' 이 찍히고, 정작 실패한
        // 게스트 작업(VMware Tools)의 원인이 로그·진단 어디에도 남지 않았다(중앙 저널 판독에서 확인).
        const tried = [];
        for (const m of order) {
          let mErr = '';
          r = await (m === 'ssh' ? viaSsh() : viaGuestops()).catch((e) => { mErr = e.message; if (isGpuAuthError(e)) authFail = e; return null; });
          if (!(r && r.utilPct != null)) tried.push(`${m === 'ssh' ? 'SSH' : '게스트작업'}: ${mErr || 'nvidia-smi 결과 없음'}`);
          if (r && r.utilPct != null) {
            // 삭제된 VM의 키가 무한 누적되지 않도록 상한 — 넘으면 비우고 다시 학습(무해).
            if (learnedMethod.size > 20000) learnedMethod.clear();
            usedMethod = m; learnedMethod.set(v.id, m); break;
          }
          // v2.590(감사 F2): **자격증명 거부면 다른 방식으로 폴백하지 않는다** — 두 방식 모두 같은 게스트 계정이라
          //   결과가 같고, 폴백하면 실패 로그인이 주기마다 두 배가 된다(공용 계정이면 VM 50대 법인에서 1분에 100회).
          if (authFail) break;
        }
        if (!(r && r.utilPct != null) && tried.length) err = tried.join(' / ');
      } else {
        r = await viaGuestops().catch((e) => { err = e.message; if (isGpuAuthError(e)) authFail = e; return null; });
      }
      if (!(r && r.utilPct != null) && err) console.warn(`[gpu-guest]   ✗ ${v.name}: ${err}`);
      // v2.590: 자격증명 거부 → 이 VM 의 주기 수집을 멈춘다(조용히 멈추지 않는다 — 진단 결과에 `authStopped`).
      let authRec = null;
      if (authFail && !(r && r.utilPct != null)) {
        authRec = gpuAuthGuard.markAuthStopped(guestAuthId, credDev, err || authFail.message);
        diag.authStoppedVms = (diag.authStoppedVms || 0) + 1;
        console.warn(`[gpu-guest]   ${v.name}: 인증 실패로 주기 수집 정지(${authRec.attempts}회) — 비밀번호를 고치면 자동 재개합니다`);
      } else if (r && r.utilPct != null) {
        gpuAuthGuard.clearAuthStop(guestAuthId);
      }
      // 진단에 시도한 OS/계정·실제 사용 방식도 남긴다(인증 실패 시 식별 — 비번 제외).
      const osLabel = isWindows ? 'Windows' : 'Linux';
      const acct = `${creds.username}(${creds.source})·${usedMethod}`;
      if (r && r.utilPct != null) {
        console.log(`[gpu-guest]   ✓ ${v.name}: util=${r.utilNA ? 'N/A(MIG)' : `${r.utilPct}%`} mem=${r.memUsedPct ?? '-'}% gpus=${r.count}`);
        // v2.593(감사 DATA-02): MIG 모드로 GPU 단위 사용률이 없으면(utilNA) 파서가 0 을 채운다 — 그 0 을 그대로 저장하면
        //   '사용률 0%(유휴)' 가 되어 호스트 대표값·평균을 끌어내린다. 사용률은 null + utilNA 로 싣고 호스트 대표값에서 뺀다.
        vms.push({ vmId: v.id, host: v.host, vcenterId: vc.id, utilPct: r.utilNA ? null : r.utilPct, utilNA: !!r.utilNA, memUsedPct: r.memUsedPct });
        if (!r.utilNA) { const arr = byHost.get(v.host) || []; arr.push(r.utilPct); byHost.set(v.host, arr); }
        if (diag.results.length < 200) diag.results.push({ vm: v.name, host: v.host, vcenterId: vc.id, os: osLabel, account: acct, ok: true, util: r.utilNA ? null : r.utilPct, utilNA: !!r.utilNA, mem: r.memUsedPct ?? null, gpus: r.count });
      } else if (diag.results.length < 200) {
        diag.results.push({ vm: v.name, host: v.host, vcenterId: vc.id, os: osLabel, account: acct, ok: false, error: err || 'nvidia-smi 결과 없음(stdout 비어있음)', ...(authRec ? { authStopped: gpuStopView(authRec) } : {}) });
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
    // v2.606(EDGE2606-01): 이번 폴에서 **읽지 못한** vCenter(인벤토리 미수집·인증 정지·로그인 실패·미등록·예외).
    //   엣지 push 보류(gpuGuestPushWithhold)가 이것을 보고 '전부 읽은 폴' 에만 중앙 목록을 교체한다.
    const unreadVcenters = [];

    await poolSettled(enabledIds, Math.min(4, enabledIds.length), async (vcId) => {
      try {
        let result;
        if (mock) result = pollMock(snap, vcId);
        else {
          const vc = reg.find((x) => x.id === vcId);
          if (!vc) { unreadVcenters.push({ vcId, reason: 'vCenter 미등록' }); diags.push({ vcId, at: Date.now(), stage: 'vCenter 미등록(vcenters.json)', counts: {}, results: [], error: '이 agent의 vcenters.json에 해당 id가 없음' }); return; }
          result = await pollLive(snap, vc, s);
        }
        if (result.unread) unreadVcenters.push({ vcId, reason: String(result.unread) });
        setGuestGpu(result);
        if (result.diag) diags.push(result.diag);
        collectedHosts += result.hosts.length; collectedVms += result.vms.length;
      } catch (e) { errors++; console.warn(`[gpu-guest] ${vcId} 수집 실패: ${e.message}`); unreadVcenters.push({ vcId, reason: '예외' }); diags.push({ vcId, at: Date.now(), stage: '예외', counts: {}, results: [], error: e.message }); }
    });

    // 3주기 이상 갱신 안 된 항목 정리.
    pruneGuestGpu(s.pollIntervalMs * 3 + 30_000);
    // v2.590: 인증 실패로 주기 수집이 멈춘 VM·vCenter 수를 함께 싣는다(설정 화면이 '멈췄다' 를 말한다).
    const authStoppedVms = diags.reduce((a, d) => a + (d.authStoppedVms || 0), 0);
    const vcAuthStopped = diags.filter((d) => d.authStopped).map((d) => d.vcId);
    lastRun = { at: Date.now(), mode: mock ? 'mock' : 'live', vcenters: enabledIds.length, hosts: collectedHosts, vms: collectedVms, errors, overlay: guestGpuCounts(), authStoppedVms, ...(vcAuthStopped.length ? { vcAuthStopped } : {}), unreadVcenters };
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
  // v2.591 L9: 기동 스태거 전 reschedule 이 먼저 왔으면 그 interval 을 지운다(게스트 로그인 주기가 두 벌이 되지 않게).
  if (timer) clearInterval(timer);
  timer = setInterval(() => pollOnce().catch(() => {}), pollIntervalMs);
  timer.unref?.();
  console.log(`[gpu-guest] poller started (every ${Math.round(pollIntervalMs / 1000)}s)`);
}
