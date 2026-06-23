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
import { loadGpuGuestSettings, resolveVmCreds } from './settings.js';
import { setGuestGpu, pruneGuestGpu, guestGpuCounts } from './store.js';
import { collectVmGpu, VimSoapClient } from './guestops.js';

let timer = null;
let lastRun = null;
let running = false;

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

// 데모(mock): 선택 법인의 패스쓰루 호스트/VM에 합성 사용률을 채운다.
function pollMock(snap, vcId) {
  const hostNames = passthruHostIds(snap, vcId);
  const hosts = [];
  const vms = [];
  const t = Date.now() / 60000;
  for (const h of snap.hosts || []) {
    if (h.vcenterId !== vcId || !hostNames.has(h.name)) continue;
    const util = Math.round(40 + 45 * Math.abs(Math.sin((hashStr(h.id) % 50) + t / 7)));
    hosts.push({ hostId: h.id, utilPct: Math.min(100, util) });
  }
  for (const v of snap.vms || []) {
    if (v.vcenterId !== vcId || !hostNames.has(v.host) || v.powerState !== 'POWERED_ON') continue;
    const util = Math.round(30 + 60 * Math.abs(Math.sin((hashStr(v.id) % 80) + t / 5)));
    vms.push({ vmId: v.id, host: v.host, vcenterId: vcId, utilPct: Math.min(100, util), memUsedPct: Math.min(100, util + 10) });
  }
  return { hosts, vms };
}

const hashStr = (s) => { let h = 0; for (let i = 0; i < String(s).length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };

// 라이브(beta): VMware Tools 게스트 작업으로 nvidia-smi 실행.
async function pollLive(snap, vc, s) {
  const hostNames = passthruHostIds(snap, vc.id);
  if (!hostNames.size) return { hosts: [], vms: [] };
  // 대상 VM: 패스쓰루 호스트 위 + 전원 On + Tools 동작 + 자격증명(VM별/법인 공용)이
  // 해석되는 VM만. 상한은 maxVmsPerVcenter(기본 1000)로 폭주만 방지(과거 32 상한 제거).
  const cands = (snap.vms || []).filter((v) => v.vcenterId === vc.id && hostNames.has(v.host)
    && vmUsesPassthroughGpu(v) && v.powerState === 'POWERED_ON' && v.toolsStatus === 'RUNNING' && resolveVmCreds(s, vc.id, v.id))
    .slice(0, s.maxVmsPerVcenter || 1000);
  if (!cands.length) return { hosts: [], vms: [] };
  const c = new VimSoapClient(vc);
  await c.login();
  const vms = [];
  const byHost = new Map();
  try {
    await eachLimited(cands, s.concurrency, async (v) => {
      const creds = resolveVmCreds(s, vc.id, v.id);
      if (!creds) return;
      const moref = String(v.id).split(':').slice(1).join(':');
      const isWindows = /windows/i.test(v.guestOS || '');
      const r = await collectVmGpu(c, moref, creds, { isWindows, timeoutMs: s.timeoutMs }).catch(() => null);
      if (r && r.utilPct != null) {
        vms.push({ vmId: v.id, host: v.host, vcenterId: vc.id, utilPct: r.utilPct, memUsedPct: r.memUsedPct });
        const arr = byHost.get(v.host) || []; arr.push(r.utilPct); byHost.set(v.host, arr);
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
  return { hosts, vms };
}

async function pollOnce() {
  if (running) return;
  running = true;
  try {
    const s = loadGpuGuestSettings();
    if (!s.enabled) { lastRun = { at: Date.now(), skipped: '비활성' }; return; }
    const snap = store.get();
    const enabledIds = Object.entries(s.vcenters).filter(([, v]) => v.enabled).map(([id]) => id);
    if (!enabledIds.length) { lastRun = { at: Date.now(), skipped: '대상 법인 없음' }; return; }

    const mock = snap.source === 'mock';
    const reg = mock ? [] : (loadVcenterConfig().vcenters || []);
    let collectedHosts = 0; let collectedVms = 0; let errors = 0;

    await eachLimited(enabledIds, Math.min(4, enabledIds.length), async (vcId) => {
      try {
        let result;
        if (mock) result = pollMock(snap, vcId);
        else {
          const vc = reg.find((x) => x.id === vcId);
          if (!vc) return; // 자격증명은 VM별/법인 공용을 pollLive에서 VM 단위로 해석
          result = await pollLive(snap, vc, s);
        }
        setGuestGpu(result);
        collectedHosts += result.hosts.length; collectedVms += result.vms.length;
      } catch (e) { errors++; console.warn(`[gpu-guest] ${vcId} 수집 실패: ${e.message}`); }
    });

    // 3주기 이상 갱신 안 된 항목 정리.
    pruneGuestGpu(s.pollIntervalMs * 3 + 30_000);
    lastRun = { at: Date.now(), mode: mock ? 'mock' : 'live', vcenters: enabledIds.length, hosts: collectedHosts, vms: collectedVms, errors, overlay: guestGpuCounts() };
  } finally { running = false; }
}

export function gpuGuestStatus() {
  const s = loadGpuGuestSettings();
  return { enabled: s.enabled, pollIntervalMs: s.pollIntervalMs, monitored: Object.values(s.vcenters).filter((v) => v.enabled).length, lastRun, overlay: guestGpuCounts() };
}

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
