/**
 * 물리(베어메탈) GPU 서버 폴러 — 등록된 가상화 안 한 서버에 직접 SSH로 nvidia-smi를 돌려
 * GPU 사용률을 수집한다. VM 게스트 수집과 같은 sshCollect 로직을 재사용하되, 대상은 vCenter VM이
 * 아니라 등록부의 물리 서버다. 실패는 서버별로 격리하고, 긴급중단 시 멈춘다.
 */

import { loadGpuGuestSettings } from './settings.js';
import { loadPhysical } from './physicalRegistry.js';
import { collectVmGpuSsh } from './sshCollect.js';
import { setPhysicalGpu, prunePhysicalGpu, physicalGpuCounts } from './physicalStore.js';
import { isStopped } from '../security/emergencyStop.js';

let timer = null;
let lastRun = null;
let running = false;

async function eachLimited(items, limit, fn) {
  const q = [...items];
  const workers = Array.from({ length: Math.min(limit, q.length || 1) }, async () => {
    while (q.length) { const it = q.shift(); try { await fn(it); } catch { /* isolated */ } }
  });
  await Promise.all(workers);
}

export async function pollPhysicalOnce() {
  if (running) return lastRun;
  running = true;
  try {
    if (isStopped()) { lastRun = { at: Date.now(), skipped: '긴급중단' }; return lastRun; }
    const servers = loadPhysical().filter((s) => s.enabled !== false && s.host && s.username);
    const s = loadGpuGuestSettings();
    let ok = 0; let failed = 0;
    await eachLimited(servers, Math.max(1, s.concurrency || 4), async (sv) => {
      const vm = { name: sv.name, ipAddresses: [sv.host], ipAddress: sv.host };
      const creds = { username: sv.username, password: sv.password || '' };
      try {
        const r = await collectVmGpuSsh(vm, creds, { timeoutMs: s.timeoutMs, port: sv.port || 22 });
        setPhysicalGpu(sv.id, {
          id: sv.id, name: sv.name, host: sv.host, vcenterId: sv.vcenterId || '',
          count: r.count, utilPct: r.utilPct, utilNA: !!r.utilNA, memUsedPct: r.memUsedPct, gpus: r.gpus || [], error: null,
        });
        ok++;
      } catch (e) {
        setPhysicalGpu(sv.id, { id: sv.id, name: sv.name, host: sv.host, vcenterId: sv.vcenterId || '', error: e.message });
        failed++;
      }
    });
    prunePhysicalGpu(new Set(servers.map((x) => x.id)));
    lastRun = { at: Date.now(), servers: servers.length, ok, failed, overlay: physicalGpuCounts() };
    return lastRun;
  } finally { running = false; }
}

export function physicalPollerStatus() {
  const { pollIntervalMs } = loadGpuGuestSettings();
  return { intervalMs: pollIntervalMs, servers: loadPhysical().length, lastRun, overlay: physicalGpuCounts() };
}

export function reschedulePhysicalPoller() {
  if (timer) clearInterval(timer);
  const { pollIntervalMs } = loadGpuGuestSettings();
  timer = setInterval(() => pollPhysicalOnce().catch(() => {}), pollIntervalMs);
  timer.unref?.();
  return pollIntervalMs;
}

export function startPhysicalGpuPoller() {
  setTimeout(() => pollPhysicalOnce().catch((e) => console.error('[gpu-physical] 폴 실패:', e.message)), 20_000).unref?.();
  const { pollIntervalMs } = loadGpuGuestSettings();
  timer = setInterval(() => pollPhysicalOnce().catch(() => {}), pollIntervalMs);
  timer.unref?.();
  console.log(`[gpu-physical] poller started (every ${Math.round(pollIntervalMs / 1000)}s)`);
}
