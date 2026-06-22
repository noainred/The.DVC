/**
 * IP 스캔 폴러 — 설정된 대역을 주기적으로 TCP 커넥트 스캔해 결과를 저장한다.
 * 분산 환경에서는 각 사이트 인스턴스(에이전트)에서 enable하고 그 사이트 대역을 등록.
 * 한 번에 한 스캔만 실행(중복 방지), 실패는 격리, 이벤트 루프 비차단.
 */

import { scanRanges } from './scan.js';
import { loadScanSettings, mergeScanResults, pruneScanResults, recordAgentReport, sweepReleases, LOCAL } from './scanStore.js';

// 일정 시간 응답이 없으면 'IP 해제'로 간주(이력에 down 기록). 스캔 주기의 3배 또는 최소 3시간.
function releaseIdleMs() { return Math.max(loadScanSettings().intervalMs * 3, 3 * 3_600_000); }

let timer = null;
let releaseTimer = null;
let running = false;
let lastRun = null;
let progress = null; // 실행 중 진행률: { total, done, alive, startedAt }

export async function runScanOnce({ manual = false } = {}) {
  if (running) return { ok: false, reason: '이미 스캔 중입니다.' };
  const s = loadScanSettings();
  if (!manual && !s.enabled) { lastRun = { at: Date.now(), skipped: '비활성' }; return { ok: false, reason: '비활성' }; }
  if (!s.ranges.length) { lastRun = { at: Date.now(), skipped: '대역 없음' }; return { ok: false, reason: '스캔 대역이 없습니다.' }; }
  running = true;
  const started = Date.now();
  progress = { total: 0, done: 0, alive: 0, startedAt: started };
  try {
    const { scanned, alive } = await scanRanges(s.ranges, {
      ports: s.ports, concurrency: s.concurrency, timeoutMs: s.timeoutMs, reverseDns: s.reverseDns,
      onProgress: (done, total, aliveCount) => { progress = { total, done, alive: aliveCount, startedAt: started }; },
    });
    mergeScanResults(alive, Date.now(), LOCAL);
    recordAgentReport(LOCAL, { scanned, alive: alive.length, durationMs: Date.now() - started });
    sweepReleases(releaseIdleMs()); // 미응답 IP를 '해제'로 마킹(사용 이력)
    pruneScanResults(s.retentionDays);
    lastRun = { at: Date.now(), durationMs: Date.now() - started, scanned, alive: alive.length, manual };
    return { ok: true, ...lastRun };
  } catch (e) {
    lastRun = { at: Date.now(), error: e.message, manual };
    return { ok: false, reason: e.message };
  } finally { running = false; progress = null; }
}

/** 비동기로 스캔 시작(요청은 즉시 반환, 창을 닫아도 백그라운드에서 계속 실행). */
export function startScan({ manual = true } = {}) {
  if (running) return { ok: false, reason: '이미 스캔 중입니다.', running: true };
  const s = loadScanSettings();
  if (!s.ranges.length) return { ok: false, reason: '스캔 대역이 없습니다.' };
  runScanOnce({ manual }).catch((e) => console.error('[ipscan] 백그라운드 스캔 실패:', e.message));
  return { ok: true, started: true };
}

export function scanStatus() {
  const s = loadScanSettings();
  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : null;
  return { enabled: s.enabled, ranges: s.ranges.length, intervalMs: s.intervalMs, running, lastRun, progress: progress ? { ...progress, pct } : null };
}

export function rescheduleScanPoller() {
  if (timer) clearInterval(timer);
  const { intervalMs } = loadScanSettings();
  timer = setInterval(() => runScanOnce().catch(() => {}), intervalMs);
  timer.unref?.();
  return intervalMs;
}

export function startIpScanPoller() {
  const s = loadScanSettings();
  // 첫 스캔은 부팅 30초 후(다른 수집과 겹치지 않게), 이후 주기 반복.
  setTimeout(() => runScanOnce().catch((e) => console.error('[ipscan] 실패:', e.message)), 30_000).unref?.();
  timer = setInterval(() => runScanOnce().catch(() => {}), s.intervalMs);
  timer.unref?.();
  // 분산 에이전트가 중앙으로 보고하는 경우 로컬 스캔이 꺼져 있어도 '해제' 전이는 기록해야 하므로
  // 별도 주기(10분)로 미응답 IP를 마킹한다(중앙/로컬 공통).
  releaseTimer = setInterval(() => { try { sweepReleases(releaseIdleMs()); } catch { /* */ } }, 10 * 60_000);
  releaseTimer.unref?.();
  console.log(`[ipscan] poller started (enabled=${s.enabled}, ranges=${s.ranges.length}, every ${Math.round(s.intervalMs / 1000)}s)`);
}
