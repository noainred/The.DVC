/**
 * IP 스캔 폴러 — 설정된 대역을 주기적으로 TCP 커넥트 스캔해 결과를 저장한다.
 * 분산 환경에서는 각 사이트 인스턴스(에이전트)에서 enable하고 그 사이트 대역을 등록.
 * 한 번에 한 스캔만 실행(중복 방지), 실패는 격리, 이벤트 루프 비차단.
 */

import { scanRanges } from './scan.js';
import { loadScanSettings, mergeScanResults, pruneScanResults } from './scanStore.js';

let timer = null;
let running = false;
let lastRun = null;

export async function runScanOnce({ manual = false } = {}) {
  if (running) return { ok: false, reason: '이미 스캔 중입니다.' };
  const s = loadScanSettings();
  if (!manual && !s.enabled) { lastRun = { at: Date.now(), skipped: '비활성' }; return { ok: false, reason: '비활성' }; }
  if (!s.ranges.length) { lastRun = { at: Date.now(), skipped: '대역 없음' }; return { ok: false, reason: '스캔 대역이 없습니다.' }; }
  running = true;
  const started = Date.now();
  try {
    const { scanned, alive } = await scanRanges(s.ranges, {
      ports: s.ports, concurrency: s.concurrency, timeoutMs: s.timeoutMs, reverseDns: s.reverseDns,
    });
    mergeScanResults(alive, Date.now());
    pruneScanResults(s.retentionDays);
    lastRun = { at: Date.now(), durationMs: Date.now() - started, scanned, alive: alive.length, manual };
    return { ok: true, ...lastRun };
  } catch (e) {
    lastRun = { at: Date.now(), error: e.message, manual };
    return { ok: false, reason: e.message };
  } finally { running = false; }
}

export function scanStatus() {
  const s = loadScanSettings();
  return { enabled: s.enabled, ranges: s.ranges.length, intervalMs: s.intervalMs, running, lastRun };
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
  console.log(`[ipscan] poller started (enabled=${s.enabled}, ranges=${s.ranges.length}, every ${Math.round(s.intervalMs / 1000)}s)`);
}
