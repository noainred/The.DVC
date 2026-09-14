/**
 * vmseries/mock.js — 데모(mock) 모드용 합성 로컬 섹션(v2.510).
 *
 * 폴러는 mock 에서 아무것도 수집하지 않는다(없는 스파이크를 지어내지 않는다). 하지만 화면을 확인할 수
 * 있어야 하므로 리포트 API 만 `synthesized:true` 를 달아 합성값을 준다 — 화면은 이 배지를 반드시 표시한다.
 * 형태는 query.localReportFor 와 같다.
 */
import { REALTIME_STEP_SEC } from './counters.js';

const HOUR = 3_600_000; const DAY = 86_400_000;

export function mockLocalReport(vm, days, thresholds, now = Date.now()) {
  const end = now; const start = end - days * DAY;
  const seed = [...String(vm.id)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
  let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296; };
  const vcpu = Number(vm.cpuCount) || 2; const mhz = 2400; const memMB = Number(vm.memMB) || 4096;
  const base = Number(vm.cpuUsagePct) || 8;
  const moments = [];
  const runs = [];
  // 하루 1~3회, 각 1~8분짜리 스파이크(임계 이상) — 최근 며칠은 미측정 구간을 하나 둔다(커버리지 표시 확인용).
  const holeStart = end - 2.3 * DAY; const holeEnd = end - 1.9 * DAY;
  for (let d = 0; d < days; d++) {
    const nRuns = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < nRuns; k++) {
      const t0 = start + d * DAY + Math.floor(rnd() * DAY);
      if (t0 >= holeStart && t0 <= holeEnd) continue;
      const n = 3 + Math.floor(rnd() * 24);
      runs.push({ t0, n });
      for (let i = 0; i < n; i++) {
        const t = t0 + i * REALTIME_STEP_SEC * 1000;
        const cpuPct = Math.min(100, thresholds.cpuPct + 5 + rnd() * 45);
        moments.push({ t, cpuUsagePct: Math.round(cpuPct * 100) / 100, cpuUsageMhz: Math.round(vcpu * mhz * cpuPct / 100), cpuReadyMs: Math.round(rnd() * 400), cpuReadyPct: null,
          memUsagePct: Math.round((base + rnd() * 20) * 100) / 100, memActiveMB: Math.round(memMB * (0.2 + rnd() * 0.3)), memConsumedMB: Math.round(memMB * 0.8), memBalloonMB: 0, memSwappedMB: 0, diskKBps: Math.round(rnd() * 20000), netKBps: Math.round(rnd() * 5000) });
      }
    }
  }
  moments.sort((a, b) => a.t - b.t);
  for (const m of moments) m.cpuReadyPct = Math.round((m.cpuReadyMs / (REALTIME_STEP_SEC * 1000) / vcpu) * 10000) / 100;
  const perHour = 3600 / REALTIME_STEP_SEC;
  const startH = Math.floor(start / HOUR) * HOUR; const hours = [];
  let samples = 0; let measured = 0; let expectedHours = 0;
  for (let h = startH; h < end; h += HOUR) {
    expectedHours++;
    const inHole = h >= holeStart && h < holeEnd;
    const sN = inHole ? 0 : perHour;
    if (sN > 0) measured++;
    samples += sN; hours.push({ h, samples: sN, pct: inHole ? 0 : 100 });
  }
  const bucketMs = days <= 7 ? HOUR : DAY;
  const bucketOf = (t) => Math.floor(t / bucketMs) * bucketMs;
  const fm = new Map();
  for (const r of runs) { const b = bucketOf(r.t0); const e = fm.get(b) || { t: b, runs: 0, moments: 0, maxSec: 0 }; e.runs++; e.moments += r.n; e.maxSec = Math.max(e.maxSec, r.n * REALTIME_STEP_SEC); fm.set(b, e); }
  const freq = [];
  for (let b = bucketOf(start); b <= end; b += bucketMs) {
    const f = fm.get(b);
    const ms = moments.filter((m) => m.t >= b && m.t < b + bucketMs);
    const inHole = b + bucketMs > holeStart && b < holeEnd && bucketMs === HOUR;
    freq.push({ t: b, runs: f?.runs || 0, moments: f?.moments || 0, maxSec: f?.maxSec || 0, maxCpuPct: ms.length ? Math.max(...ms.map((m) => m.cpuUsagePct)) : null, maxMemPct: ms.length ? Math.max(...ms.map((m) => m.memUsagePct)) : null, measured: !inHole });
  }
  const peakOf = (key) => { let best = null; for (const m of moments) { const v = m[key]; if (v != null && (best == null || v > best.v)) best = { v, t: m.t }; } return best; };
  let maxSec = 0; let totalSec = 0; for (const r of runs) { maxSec = Math.max(maxSec, r.n * REALTIME_STEP_SEC); totalSec += r.n * REALTIME_STEP_SEC; }
  return {
    available: true, empty: moments.length === 0, window: { start, end, days }, intervalSec: REALTIME_STEP_SEC,
    coverage: { pct: Math.round((samples / (expectedHours * perHour)) * 1000) / 10, measuredHours: measured, expectedHours, unmeasuredHours: expectedHours - measured, samples, expectedSamples: expectedHours * perHour, perHour, firstTs: startH, lastTs: end, hours },
    thresholds, vcpu, moments, momentCount: moments.length, downsampled: false,
    runs: { count: runs.length, maxSec, totalSec, perDay: Math.round((runs.length / Math.max(1, days)) * 100) / 100 },
    freq, bucketMs,
    peak: { cpuUsagePct: peakOf('cpuUsagePct'), cpuUsageMhz: peakOf('cpuUsageMhz'), memUsagePct: peakOf('memUsagePct'), memActiveMB: peakOf('memActiveMB'), memConsumedMB: peakOf('memConsumedMB'), memBalloonMB: peakOf('memBalloonMB'), memSwappedMB: peakOf('memSwappedMB'), cpuReadyPct: peakOf('cpuReadyPct') },
    historicalInterval: { at: now, intervals: [
      { key: 1, samplingPeriod: 300, length: 86400, name: 'Past day', level: 1, enabled: true },
      { key: 2, samplingPeriod: 1800, length: 604800, name: 'Past week', level: 1, enabled: true },
      { key: 3, samplingPeriod: 7200, length: 2592000, name: 'Past month', level: 1, enabled: true },
      { key: 4, samplingPeriod: 86400, length: 31536000, name: 'Past year', level: 1, enabled: true },
    ] },
    settings: { enabled: true, intervalMin: 50, retentionDays: 60 }, lastPollAt: now - 20 * 60_000,
  };
}
