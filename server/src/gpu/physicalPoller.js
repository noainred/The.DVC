/**
 * 물리(베어메탈) GPU 서버 폴러 — 등록된 가상화 안 한 서버에 직접 SSH로 nvidia-smi를 돌려
 * GPU 사용률을 수집한다. VM 게스트 수집과 같은 sshCollect 로직을 재사용하되, 대상은 vCenter VM이
 * 아니라 등록부의 물리 서버다. 실패는 서버별로 격리하고, 긴급중단 시 멈춘다.
 */

import { loadGpuGuestSettings } from './settings.js';
import { loadPhysical, updatePhysical } from './physicalRegistry.js';
import { collectVmGpuSsh, detectPhysicalGpu } from './sshCollect.js';
import { setPhysicalGpu, prunePhysicalGpu, physicalGpuCounts } from './physicalStore.js';
import { isStopped } from '../security/emergencyStop.js';

let timer = null;
let lastRun = null;
let running = false;

// 수집 실패 원인 분류 — UI에서 로그인/드라이버/접속/오류로 구분 표시.
function classifyErr(e) {
  const m = String(e?.message || '');
  if (e?.sshConnected) {
    if (/nvidia-smi|드라이버|파싱|출력 없음/i.test(m)) return { errorCode: 'nodriver', errorLabel: '드라이버 없음' };
    return { errorCode: 'error', errorLabel: '오류' };
  }
  if (/인증|auth|permission|비밀번호|publickey/i.test(m)) return { errorCode: 'login', errorLabel: '로그인 안됨' };
  if (/거부|refused|타임아웃|timeout|미도달|경로|unreach|ETIMEDOUT|ECONNREFUSED/i.test(m)) return { errorCode: 'unreachable', errorLabel: '접속 불가' };
  return { errorCode: 'error', errorLabel: '오류' };
}

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
        // GPU 모델명이 없으면(수동 등록) 1회 감지해 등록부에 백필 → 서버 분석 GPU 찾기에 모델별 합산.
        if (!(sv.gpuModels && sv.gpuModels.length)) {
          try { const det = await detectPhysicalGpu(sv.host, creds, { timeoutMs: s.timeoutMs, port: sv.port || 22 }); if (det.gpuModels.length) updatePhysical(sv.id, { gpuModels: det.gpuModels }); } catch { /* best effort */ }
        }
        ok++;
      } catch (e) {
        setPhysicalGpu(sv.id, { id: sv.id, name: sv.name, host: sv.host, vcenterId: sv.vcenterId || '', error: e.message, ...classifyErr(e) });
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
