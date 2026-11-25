/**
 * sanswitch/storageBaseline.js — **자기 기준선**(요일 × 시간 · 지난 N주) 대비 '평소와 다름' 표시(순수 · v2.950 · 설계 §12.2-7).
 *
 * 왜: 벤더 임계값이 없는 지표(응답 시간 · 한가한 어레이의 처리량)에도 **지어내지 않는 기준**이 필요하다 — 기준 = 그 어레이의 자기 과거.
 * 어떻게: 지난 weeks 주(기본 4)의 1시간 집계를 포탈 하루(DAY_OFFSET_MIN) 기준 요일 × 시간 168칸으로 접어 칸마다 평균 · 표본 수 · 표준편차를 둔다.
 *   비교 창의 칸(1시간 이하 버킷)은 같은 요일 × 시간 칸의 평균과 견줘 **비율**(value ÷ 평균)과 z(표준편차 배수)를 낸다.
 *   '평소와 다름' 은 표본이 minSamples(기본 3) 이상인 칸에서 비율이 (1 ± tolerance) 를 벗어나고 **절대 차이가 minAbsBps 이상**일 때만(한가할 때의 10배는 뜻이 없다).
 * 하지 않는 것: 판정(ok/warn/bad)을 바꾸지 않는다 — '평소와 다름' 은 표시 · 개수일 뿐이다. 기준선이 없는 칸(표본 부족)은 null(다르지 않음이 아니라 모름).
 */
import { numOrNull } from '../util/numOrNull.js';
import { DAY_OFFSET_MIN } from '../util/dayKey.js';

export const BASELINE_WEEKS_DEF = 4;
export const BASELINE_MIN_SAMPLES = 3;
export const BASELINE_TOLERANCE_DEF = 0.5;        // ±50% — 설정값(storageCheckSettings baselineTolerancePct)이 있으면 그것
export const BASELINE_MIN_ABS_BPS = 62_500_000;   // 0.5 Gb/s — 편중 하한과 같은 뜻
const HOUR = 3_600_000; const DAY = 24 * HOUR; const WEEK = 7 * DAY;

/** 시각 → 포탈 요일(0=월) · 시(0~23). */
export function cellOf(ts, offsetMin = DAY_OFFSET_MIN) {
  const t = ts + offsetMin * 60_000;
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7;
  return { day, hour: d.getUTCHours(), idx: day * 24 + d.getUTCHours() };
}

/**
 * 기준선 접기(순수): 1시간 집계(buckets · values — 같은 길이, null 은 결측)를 168칸으로. `until` 이전 칸만(비교 창 자체를 기준선에 넣지 않는다).
 * @returns {{cells:Array<{n:number, mean:number|null, sd:number|null}>, weeks:number, from:number, until:number, measured:number}}
 */
export function foldBaseline(buckets = [], values = [], { until = Date.now(), weeks = BASELINE_WEEKS_DEF, offsetMin = DAY_OFFSET_MIN } = {}) {
  const from = until - Math.max(1, weeks) * WEEK;
  const acc = Array.from({ length: 168 }, () => ({ n: 0, s: 0, ss: 0 }));
  let measured = 0;
  for (let i = 0; i < buckets.length; i++) {
    const t = numOrNull(buckets[i]); const v = numOrNull(values[i]);
    if (t == null || v == null || t < from || t >= until) continue;
    const c = acc[cellOf(t, offsetMin).idx];
    c.n += 1; c.s += v; c.ss += v * v; measured += 1;
  }
  const cells = acc.map((c) => {
    if (!c.n) return { n: 0, mean: null, sd: null };
    const mean = c.s / c.n;
    const varr = c.n > 1 ? Math.max(0, (c.ss - c.n * mean * mean) / (c.n - 1)) : 0;
    return { n: c.n, mean, sd: Math.sqrt(varr) };
  });
  return { cells, weeks, from, until, measured };
}

/**
 * 비교(순수): 창의 칸마다 기준선 칸과 견준다. 버킷이 1시간보다 길면(하루 등) 요일 × 시간 비교가 뜻이 없어 전부 null.
 * @returns {{marks:Array<null|{ratio:number, z:number|null, mean:number, n:number, off:boolean}>, offCount:number, compared:number, applicable:boolean}}
 */
export function compareToBaseline(buckets = [], values = [], baseline, { bucketMs = HOUR, tolerance = BASELINE_TOLERANCE_DEF, minSamples = BASELINE_MIN_SAMPLES, minAbs = BASELINE_MIN_ABS_BPS, offsetMin = DAY_OFFSET_MIN } = {}) {
  const applicable = !!baseline && bucketMs > 0 && bucketMs <= HOUR;
  if (!applicable) return { marks: buckets.map(() => null), offCount: 0, compared: 0, applicable: false };
  const tol = Math.max(0.05, Math.min(5, numOrNull(tolerance) ?? BASELINE_TOLERANCE_DEF));
  let offCount = 0; let compared = 0;
  const marks = buckets.map((b, i) => {
    const t = numOrNull(b); const v = numOrNull(values[i]);
    if (t == null || v == null) return null;
    const c = baseline.cells[cellOf(t, offsetMin).idx];
    if (!c || c.n < minSamples || c.mean == null) return null;
    compared += 1;
    const ratio = c.mean > 0 ? v / c.mean : (v > 0 ? Infinity : 1);
    const z = c.sd != null && c.sd > 0 ? (v - c.mean) / c.sd : null;
    const off = Math.abs(v - c.mean) >= minAbs && (ratio > 1 + tol || ratio < 1 - tol);
    if (off) offCount += 1;
    return { ratio: Number.isFinite(ratio) ? Math.round(ratio * 100) / 100 : null, z: z == null ? null : Math.round(z * 10) / 10, mean: Math.round(c.mean), n: c.n, off };
  });
  return { marks, offCount, compared, applicable: true };
}

/** 기준선 전체 요약(화면 각주): 칸 168 중 기준선이 있는 칸 수 · 가장 바쁜 칸 평균. */
export function baselineSummary(baseline) {
  if (!baseline) return { cells: 0, busiest: null };
  let busiest = null; let cells = 0;
  baseline.cells.forEach((c, idx) => { if (c.n >= BASELINE_MIN_SAMPLES) { cells += 1; if (!busiest || c.mean > busiest.mean) busiest = { day: Math.floor(idx / 24), hour: idx % 24, mean: Math.round(c.mean), n: c.n }; } });
  return { cells, busiest };
}
