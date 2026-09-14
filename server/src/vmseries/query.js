/**
 * vmseries/query.js — 저장된 스파이크 순간을 리포트가 쓰는 형태로(v2.510).
 *
 * 리포트 'Local + vCenter' 템플릿은 평균·p95·곡선을 vCenter 롤업에서, **최대·스파이크 횟수·지속·
 * 커버리지**를 여기서 받는다. 두 출처를 섞어 산정하지 않는다(권고 vCPU 는 여전히 vCenter 데이터).
 *
 * 정직 규약
 *  - DB 파일이 없으면 `available:false` + 이유. 있는데 창에 표본이 없으면 커버리지 0 으로 밝힌다.
 *  - 커버리지는 (관측 표본 수) / (창 시간 × 180) — 수집 시작 이전·실패 주기는 그대로 구멍으로 남는다.
 *    화면은 미측정 시간을 '스파이크 0' 이 아니라 음영으로 그린다.
 *  - 순간 점이 maxPoints 를 넘으면 버킷별 최대만 남긴다(모멘트 수를 응답에 밝힌다 — 잘라낸 사실을 숨기지 않는다).
 */
import { COUNTERS_BY_KIND, REALTIME_STEP_SEC } from './counters.js';
import { unpackMoments, runsOf } from './spikes.js';
import { spikeRows, coverageOf, vmSeriesMeta, topInWindow } from './db.js';

const HOUR = 3_600_000; const DAY = 86_400_000;
const r2 = (x) => Math.round(x * 100) / 100;

/** 저장 당시 cols(이름 배열) → 표시 정의(현재 카탈로그에서 div/unit 을 찾고, 없으면 div 1). */
function colDefs(kind, names) {
  const cat = COUNTERS_BY_KIND[kind] || [];
  return names.map((n) => cat.find((c) => c.name === n) || { name: n, div: 1, unit: '' });
}

/** 한 엔티티의 창 안 순간 전부(표시 단위로 변환, 창 밖 순간 제외). */
export async function momentsOf(vcenterId, kind, ref, fromTs, toTs) {
  const rows = await spikeRows(vcenterId, kind, ref, fromTs, toTs);
  if (rows == null) return null;
  const out = [];
  for (const r of rows) {
    let names = [];
    try { names = JSON.parse(r.cols); } catch { continue; }
    const defs = colDefs(kind, names);
    for (const m of unpackMoments(r.data, Number(r.t0), names.length)) {
      if (m.ts < fromTs || m.ts > toTs) continue;
      const o = { t: m.ts };
      defs.forEach((d, i) => { const v = m.vals[i]; o[d.name] = (v == null || v < 0) ? null : (d.div > 1 ? r2(v / d.div) : v); });
      out.push(o);
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** cpu.ready.summation(ms/20초) → vCPU 당 %. */
const readyPctOf = (ms, vcpu) => (ms == null || !(vcpu > 0) ? null : r2((ms / (REALTIME_STEP_SEC * 1000) / vcpu) * 100));

/**
 * 리포트 로컬 섹션.
 * @returns {{ available:boolean, reason?:string, ... }}
 */
export async function localReportFor({ vcenterId, kind = 'vm', ref, days = 30, now = Date.now(), thresholds = {}, vcpu = 0, maxPoints = 3000 }) {
  const end = now; const start = end - days * DAY;
  const cov = await coverageOf(vcenterId, kind, ref, start - HOUR, end);
  if (cov == null) return { available: false, reason: 'no-db', text: '이 vCenter 의 포탈 수집 DB 가 없습니다 — 설정 › VM 성능 원본 수집에서 대상에 포함되어 있는지, 수집이 켜져 있는지 확인하세요.' };
  const moments = (await momentsOf(vcenterId, kind, ref, start, end)) || [];
  const hoursMap = new Map(cov.hours.map((h) => [h.h, h.samples]));
  const startH = Math.floor(start / HOUR) * HOUR;
  const expectedHours = Math.max(1, Math.ceil((end - startH) / HOUR));
  const perHour = 3600 / REALTIME_STEP_SEC;
  let samples = 0; let measuredHours = 0;
  const hours = [];
  for (let h = startH; h < end; h += HOUR) {
    const s = hoursMap.get(h) || 0;
    if (s > 0) measuredHours++;
    samples += s;
    hours.push({ h, samples: s, pct: Math.min(100, Math.round((s / perHour) * 100)) });
  }
  const coverage = {
    pct: Math.round((samples / (expectedHours * perHour)) * 1000) / 10,
    measuredHours, expectedHours, unmeasuredHours: expectedHours - measuredHours,
    samples, expectedSamples: expectedHours * perHour, perHour,
    firstTs: cov.firstH, lastTs: cov.lastH != null ? cov.lastH + HOUR : null,
    hours,
  };
  if (!moments.length && samples === 0) {
    return { available: true, empty: true, reason: 'no-samples', window: { start, end, days }, intervalSec: REALTIME_STEP_SEC, coverage, moments: [], runs: { count: 0, maxSec: 0, totalSec: 0 }, freq: [], peak: null, thresholds, historicalInterval: await vmSeriesMeta(vcenterId, 'historicalInterval') };
  }

  // run(연속 구간) — 트리거와 무관하게 '저장된 순간' 이 곧 스파이크 순간이다.
  const runs = runsOf(moments.map((m) => ({ ts: m.t })));
  // 빈도 버킷: 7일 이하 시간당, 그 이상 일당. run 은 시작 시각 버킷에 센다.
  const bucketMs = days <= 7 ? HOUR : DAY;
  const bucketOf = (t) => Math.floor(t / bucketMs) * bucketMs;
  const freqMap = new Map();
  for (const r of runs.runs) { const b = bucketOf(r.t0); const e = freqMap.get(b) || { t: b, runs: 0, moments: 0, maxSec: 0 }; e.runs++; e.moments += r.n; e.maxSec = Math.max(e.maxSec, r.n * REALTIME_STEP_SEC); freqMap.set(b, e); }
  const maxByBucket = new Map();
  for (const m of moments) {
    const b = bucketOf(m.t); const e = maxByBucket.get(b) || { maxCpuPct: null, maxMemPct: null };
    if (m.cpuUsagePct != null && (e.maxCpuPct == null || m.cpuUsagePct > e.maxCpuPct)) e.maxCpuPct = m.cpuUsagePct;
    if (m.memUsagePct != null && (e.maxMemPct == null || m.memUsagePct > e.maxMemPct)) e.maxMemPct = m.memUsagePct;
    maxByBucket.set(b, e);
  }
  const freq = [];
  for (let b = bucketOf(start); b <= end; b += bucketMs) {
    const f = freqMap.get(b); const mx = maxByBucket.get(b);
    // 그 버킷에 관측 표본이 하나라도 있었는지 — 없으면 '미측정'(막대 0 이 아니라 음영).
    let measured = false;
    for (let h = b; h < b + bucketMs; h += HOUR) if ((hoursMap.get(h) || 0) > 0) { measured = true; break; }
    freq.push({ t: b, runs: f?.runs || 0, moments: f?.moments || 0, maxSec: f?.maxSec || 0, maxCpuPct: mx?.maxCpuPct ?? null, maxMemPct: mx?.maxMemPct ?? null, measured });
  }

  // 피크(값과 시각)
  const peakOf = (key) => { let best = null; for (const m of moments) { const v = m[key]; if (v != null && (best == null || v > best.v)) best = { v, t: m.t }; } return best; };
  const peak = {
    cpuUsagePct: peakOf('cpuUsagePct'), cpuUsageMhz: peakOf('cpuUsageMhz'),
    memUsagePct: peakOf('memUsagePct'), memActiveMB: peakOf('memActiveMB'), memConsumedMB: peakOf('memConsumedMB'),
    memBalloonMB: peakOf('memBalloonMB'), memSwappedMB: peakOf('memSwappedMB'),
  };
  const rp = peakOf('cpuReadyMs');
  peak.cpuReadyPct = rp ? { v: readyPctOf(rp.v, vcpu), t: rp.t } : null;

  // 점이 너무 많으면 버킷(1분 이상)별 CPU 최대 순간만 남긴다 — 잘라낸 사실을 밝힌다.
  let points = moments.map((m) => ({ ...m, cpuReadyPct: readyPctOf(m.cpuReadyMs, vcpu) }));
  let downsampled = false;
  if (points.length > maxPoints) {
    downsampled = true;
    const step = Math.ceil((end - start) / maxPoints);
    const keep = new Map();
    for (const p of points) {
      const b = Math.floor(p.t / step);
      const cur = keep.get(b);
      if (!cur || (p.cpuUsagePct ?? -1) > (cur.cpuUsagePct ?? -1)) keep.set(b, p);
    }
    points = [...keep.values()].sort((a, b) => a.t - b.t);
  }
  return {
    available: true, empty: false, window: { start, end, days }, intervalSec: REALTIME_STEP_SEC,
    coverage, thresholds, vcpu,
    moments: points, momentCount: moments.length, downsampled,
    runs: { count: runs.count, maxSec: runs.maxSec, totalSec: runs.totalSec, perDay: r2(runs.count / Math.max(1, days)) },
    freq, bucketMs, peak,
    historicalInterval: await vmSeriesMeta(vcenterId, 'historicalInterval'),
  };
}

/** 전 VM 순위(행 집계 — BLOB 미해제). */
export async function topSpikers(vcenterId, days, limit = 200, now = Date.now()) {
  const end = now; const start = end - days * DAY;
  const rows = await topInWindow(vcenterId, start, end, limit);
  if (rows == null) return null;
  return rows.map((r) => ({ ...r, mxcpuPct: r.mxcpu >= 0 ? r2(r.mxcpu / 100) : null, mxmemPct: r.mxmem >= 0 ? r2(r.mxmem / 100) : null }));
}
