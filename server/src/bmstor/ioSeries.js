/**
 * bmstor/ioSeries.js — 디스크 I/O 시계열 산수(순수, v2.915 — 설계 docs/design/bm-san-compare §4.5 · §4.6).
 *
 * 버킷은 SAN 포트 사용량과 **같은 격자**(perfDb.rangeOf 가 준 bucketMs — 15분 · 1시간 정배수)에 맞춘다. 그래야 베어메탈 선과
 * 어레이 선이 한 차트에서 같은 x 를 쓴다. 베어메탈 행(원시 · 15분 · 1시간 표)을 그 격자로 다시 묶는다:
 *  · 평균 = Σ(구간 평균 × 표본 수) ÷ Σ표본 수  (구간 평균이 없는 행 — 첫 행 · 재부팅 · 공백 — 은 분모에 넣지 않는다)
 *  · 피크 = 2초 표본(inst)과 구간 평균 중 큰 값의 최댓값 — 실제 순간 피크의 **하한**(화면이 말한다). v2.969: 예전에는 2초 표본만 써서
 *    한가한 순간에 걸리면 피크 < 평균이 나왔다(구간의 실제 최고치는 그 구간 평균보다 작을 수 없다).
 * 못 읽은 버킷은 0 이 아니라 null 이다.
 */
import { numOrNull } from '../util/numOrNull.js';

export const RANGES = Object.freeze({
  '1h': { hours: 1, label: '실시간 1시간' },
  '24h': { hours: 24, label: '24시간' },
  '7d': { hours: 24 * 7, label: '7일' },
  '30d': { hours: 24 * 30, label: '30일' },
});
export const RANGE_KEYS = Object.freeze(Object.keys(RANGES));
export function rangeKeyOf(q) { return RANGE_KEYS.includes(String(q || '')) ? String(q) : '1h'; }

/** 버킷 시작 시각 배열 — [since, until) 를 bucketMs 로. 상한 2,000 칸(요청이 이상해도 메모리를 지키게). */
export function bucketsOf(since, until, bucketMs) {
  const b = Math.max(1, Math.floor(Number(bucketMs) || 0));
  const s = Math.floor(Number(since) / b) * b;
  const out = [];
  for (let t = s; t < Number(until) && out.length < 2000; t += b) out.push(t);
  return out;
}

/** 어느 표에서 읽을지 — 격자가 1시간 정배수면 1시간 표, 15분 정배수면 15분 표, 그 밖(실시간 30초 등)은 원시. */
export function sourceFor(bucketMs, { G15 = 900_000, G1H = 3_600_000 } = {}) {
  const b = Number(bucketMs) || 0;
  if (b >= G1H && b % G1H === 0) return 'r1h';
  if (b >= G15 && b % G15 === 0) return 'r15';
  return 'raw';
}

/** v2.969 — 둘 중 큰 값(한쪽이 없으면 있는 쪽) · 칸마다 피크를 평균 위로(제자리). */
const upOf = (a, b) => { const x = numOrNull(a); const y = numOrNull(b); return x == null ? y : y == null ? x : Math.max(x, y); };
function liftPeaks(s) { for (let i = 0; i < s.avg.length; i++) s.peak[i] = upOf(s.peak[i], s.avg[i]); return s; }

const emptySeries = (n) => ({ avg: new Array(n).fill(null), peak: new Array(n).fill(null), busy: new Array(n).fill(null), nAvg: new Array(n).fill(0) });

/**
 * 원시 행 → 격자. 행: { ts, avgTotal|null, instTotal|null, busy|null }.
 */
export function seriesFromRaw(rows, buckets, bucketMs) {
  const n = buckets.length; const s = emptySeries(n);
  if (!n) return s;
  const b0 = buckets[0]; const b = Math.max(1, Number(bucketMs) || 1);
  const sum = new Array(n).fill(0);
  for (const r of rows || []) {
    const i = Math.floor((Number(r.ts) - b0) / b);
    if (i < 0 || i >= n) continue;
    const a = numOrNull(r.avgTotal);
    if (a != null) { sum[i] += a; s.nAvg[i] += 1; }
    const p = upOf(r.instTotal, a);
    if (p != null) s.peak[i] = s.peak[i] == null ? p : Math.max(s.peak[i], p);
    const bz = upOf(r.busy, r.avgBusy);
    if (bz != null) s.busy[i] = s.busy[i] == null ? bz : Math.max(s.busy[i], bz);
  }
  for (let i = 0; i < n; i++) s.avg[i] = s.nAvg[i] ? Math.round(sum[i] / s.nAvg[i]) : null;
  return liftPeaks(s);
}

/**
 * 집계 표 행 → 격자. 행: { b(버킷 시작 ts), nAvg, sumAvg, maxInst, maxBusy } — 격자가 표 단위의 정배수라 여러 행이 한 칸에 들어간다.
 */
export function seriesFromRollup(rows, buckets, bucketMs) {
  const n = buckets.length; const s = emptySeries(n);
  if (!n) return s;
  const b0 = buckets[0]; const b = Math.max(1, Number(bucketMs) || 1);
  const sum = new Array(n).fill(0);
  for (const r of rows || []) {
    const i = Math.floor((Number(r.b) - b0) / b);
    if (i < 0 || i >= n) continue;
    const k = Number(r.nAvg) || 0;
    if (k > 0 && Number.isFinite(Number(r.sumAvg))) { sum[i] += Number(r.sumAvg); s.nAvg[i] += k; }
    const p = numOrNull(r.maxInst);
    if (p != null) s.peak[i] = s.peak[i] == null ? p : Math.max(s.peak[i], p);
    const bz = numOrNull(r.maxBusy);
    if (bz != null) s.busy[i] = s.busy[i] == null ? bz : Math.max(s.busy[i], bz);
  }
  for (let i = 0; i < n; i++) s.avg[i] = s.nAvg[i] ? Math.round(sum[i] / s.nAvg[i]) : null;
  return liftPeaks(s);   // v2.969 이전 집계 행의 max_inst 는 2초 표본뿐 — 칸 평균 위로
}

/**
 * 여러 서버의 합(bm:all). 측정된 서버(값이 하나라도 있는 계열)만 더하고, 버킷마다 **측정 서버 전부에 값이 있을 때만** 합을 낸다 —
 * 아니면 null + partial. 모르는 것을 0 으로 더하지 않는다(SAN 포트 합과 같은 규칙).
 * 피크 합 = 구성원 피크(하한)의 합 — 같은 시각에 일어났다는 보장은 없다(v2.968 까지의 ‘동시 피크의 상한’ 은 틀린 설명 — 정정).
 * v2.969: 피크도 **구성원 전부**로 더한다 — 피크가 빈 구성원은 그 칸 평균으로(평균이 그 구성원 피크의 하한). 예전에는 피크 있는 구성원만 더해
 * 묶음 피크가 평균 합보다 작아질 수 있었다(부분 합).
 */
export function sumSeries(list, n) {
  const measured = (list || []).filter((s) => s && Array.isArray(s.avg) && s.avg.some((v) => v != null));
  const avg = new Array(n).fill(null); const peak = new Array(n).fill(null); const partial = [];
  for (let i = 0; i < n; i++) {
    if (!measured.length) continue;
    let a = 0; let p = 0; let broken = false;
    for (const s of measured) {
      if (s.avg[i] == null) { broken = true; break; }
      a += s.avg[i];
      p += upOf(s.peak?.[i], s.avg[i]);
    }
    if (broken) { partial.push(i); continue; }
    avg[i] = a; peak[i] = p || null;
  }
  return { avg, peak, measured: measured.length, total: (list || []).length, partial };
}

/** 계열 요약 — avgTotal(평균의 평균) · peakTotal(피크의 최댓값) · maxAvg · points(값 있는 칸). 값이 없으면 null. */
export function summarize(series) {
  const av = (series?.avg || []).filter((v) => v != null);
  const pk = (series?.peak || []).filter((v) => v != null);
  return {
    avgTotal: av.length ? Math.round(av.reduce((a, b) => a + b, 0) / av.length) : null,
    maxAvg: av.length ? Math.max(...av) : null,
    peakTotal: pk.length ? Math.max(...pk) : null,
    points: av.length,
  };
}

/** `ids=bm:x,san:y,bm:all` → [{ kind, key }] (상한 maxIds · 중복 제거 · 모르는 접두는 버린다). */
export function parseSeriesIds(q, { maxIds = 10 } = {}) {
  const out = []; const seen = new Set();
  for (const raw of String(q || '').split(',')) {
    const t = raw.trim();
    const m = /^(bm|san):(.{1,128})$/.exec(t);
    if (!m) continue;
    const key = `${m[1]}:${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push({ kind: m[1], key: m[2] });
    if (out.length >= maxIds) break;
  }
  return out;
}

/** 지표 선택 — 'total' | 'read' | 'write'. 원시 행에서 그 지표의 값을 뽑는다(SAN 은 합계만 있다 — 읽기 · 쓰기는 null). */
export function metricOf(q) { return ['total', 'read', 'write'].includes(String(q || '')) ? String(q) : 'total'; }
