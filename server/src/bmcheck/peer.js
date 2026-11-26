/**
 * bmcheck/peer.js — 물리서버 **같은 묶음 대비**의 판정 코어(v3.48 · 설계 docs/design/bm-feature-proposals ⑨). 순수.
 *
 *  · 묻는 것: ‘같은 일을 하는 다른 서버’ 와 견줘 이 서버만 다른가(혼자만 바쁜 · 혼자만 뜨거운 서버). 포탈의 기존 이상 탐지는 ‘그 장비의 평소 값’ 과 견준다 — 다른 질문이다.
 *  · 묶음 = 같은 법인 · 같은 폴더 · 같은 모델(물리서버 폴더에 넣은 서버만 — 폴더가 ‘같은 일’ 의 단서다. BIOS 편차와 같은 묶음).
 *  · 지표: CPU · 메모리 · 전력 = **지난 24시간 평균**(수집 노드의 계열 — 사용률 DB · 전력 시간당 롤업 `idrac/db.js power_hourly`) /
 *    흡기 온도 = **지금 값**(서버별 흡기 온도 계열은 기본 설정에서 디스크에 쌓지 않는다 — `IDRAC_TEMP_SERIES_DETAIL` · 메모리 표본은 재시작에 사라진다) — 화면이 기준을 밝힌다.
 *    ⚠ 첫 판본은 ‘전력 계열이 없다’ 고 보고 지금 값을 썼다(틀린 전제 — 2026-11-26 정정). 기준이 다른 값(지금 값 · 평균)을 한 지표에 섞지 않는다.
 *  · 묶음의 폭 = 사분위 범위 울타리(Q1 − w · Q3 + w, w = max(1.5 × IQR, 바닥값)). 바닥값은 값이 거의 같은 묶음에서 1~2 % 차이를 ‘밖’ 으로 부르지 않게 둔다.
 *    폭 밖 = 그 묶음과 다르다는 뜻이지 **문제라는 판정이 아니다**(문구는 웹 peerText.js).
 *  · 값이 없는 서버는 묶음에서 빼고 몇 대를 뺐는지 밝힌다(0 으로 넣지 않는다). 값이 있는 서버가 PEER_MIN 대 미만이면 판정하지 않는다(few).
 */
import { numOrNull } from '../util/numOrNull.js';

export const PEER_MIN = 5;          // 판정에 필요한 ‘값이 있는 서버’ 수(이 서버 포함)
export const PEER_GROUP_MAX = 80;   // 한 번에 견주는 묶음 상한(넘으면 앞에서부터 — 넘친 수를 밝힌다)
/**
 * ‘24시간 평균’ 으로 볼 조건 — 표본 수 **그리고** 구간 비율(창을 같은 길이로 나눈 칸 중 값이 있는 칸의 비율 — 수집 노드가 센다).
 *   표본 수만 보면 최근 1시간의 점 12개가 ‘하루 평균’ 이 되고, 비율만 보면 점 하나가 두 칸 중 한 칸(50 %)을 채운다 — 둘 다 본다.
 *   조건에 못 미치면 값 없음으로 둔다(0 이 아니다 · 화면이 비율을 밝힌다).
 */
export const PEER_AVG_MIN_SAMPLES = 12;
export const PEER_AVG_MIN_COVERAGE = 0.5;
/**
 * 그 계열에 요구하는 표본 수 — `PEER_AVG_MIN_SAMPLES` 와 ‘창이 담을 수 있는 수(expected)의 절반’ 중 작은 것.
 *   수집 주기를 길게(3시간 · 6시간) 둔 법인은 하루 표본이 8개 · 4개라 12개를 영원히 못 채웠다(반증 A4). expected 를 모르면 PEER_AVG_MIN_SAMPLES.
 */
export function minSamplesFor(stat, minSamples = PEER_AVG_MIN_SAMPLES) {
  const exp = numOrNull(stat?.expected);
  return exp != null && exp > 0 ? Math.max(2, Math.min(minSamples, Math.ceil(exp / 2))) : minSamples;
}
/** 계열 통계({ avg, n, expected, cov }) → 24시간 평균 값 또는 null(못 읽음 · 표본 부족 · 구간 부족 · 비율 모름). */
export function avgValueOf(stat, { minSamples = PEER_AVG_MIN_SAMPLES, minCoverage = PEER_AVG_MIN_COVERAGE } = {}) {
  if (!stat || typeof stat !== 'object') return null;
  const avg = numOrNull(stat.avg); const cnt = numOrNull(stat.n); const cov = numOrNull(stat.cov);
  return avg != null && cnt != null && cnt >= minSamplesFor(stat, minSamples) && cov != null && cov >= minCoverage ? avg : null;
}
/**
 * 지표 — basis: avg24(지난 24시간 평균) · now(지금 값). floor = 폭의 바닥값(절대) · floorPct = 가운데값의 %(둘 중 큰 것).
 *   lower · upper = 그 지표가 가질 수 있는 값의 끝(폭을 여기서 자른다 — ‘묶음의 폭 7 % ~ 124 %’ 처럼 있을 수 없는 값을 폭으로 내지 않는다. 판정은 바뀌지 않는다: 값이 그 밖에 있을 수 없다).
 */
export const PEER_METRICS = Object.freeze([
  Object.freeze({ id: 'cpu', unit: '%', basis: 'avg24', floor: 10, floorPct: 0, lower: 0, upper: 100 }),
  Object.freeze({ id: 'mem', unit: '%', basis: 'avg24', floor: 10, floorPct: 0, lower: 0, upper: 100 }),
  Object.freeze({ id: 'power', unit: 'W', basis: 'avg24', floor: 20, floorPct: 15, lower: 0, upper: null }),
  Object.freeze({ id: 'inlet', unit: '℃', basis: 'now', floor: 3, floorPct: 0, lower: null, upper: null }),
]);

const r1 = (v) => Math.round(v * 10) / 10;
/** 정렬된 배열의 분위(선형 보간 — R-7). 빈 배열은 null. */
export function quantile(sorted, q) {
  const n = Array.isArray(sorted) ? sorted.length : 0;
  if (!n) return null;
  const pos = (n - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos); const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * 한 지표의 판정.
 * @param {Array<number|null>} values 묶음 서버들의 값(이 서버 포함 · 없는 값은 null)
 * @param {number|null} self 이 서버의 값
 * @param {{ floor?:number, floorPct?:number, min?:number, lower?:number|null, upper?:number|null }} opt
 * @returns {{ state:'high'|'low'|'in'|'few'|'none', value:number|null, n:number, missing:number, median?:number, lo?:number, hi?:number, min?:number, max?:number, points?:number[] }}
 *   none = 이 서버의 값이 없다 · few = 값이 있는 서버가 모자라 판정하지 않는다(값 · 대수는 싣는다)
 */
export function judgePeer(values, self, { floor = 0, floorPct = 0, min = PEER_MIN, lower = null, upper = null } = {}) {
  const all = Array.isArray(values) ? values : [];
  const nums = [];
  for (const v of all) { const x = numOrNull(v); if (x != null) nums.push(x); }
  nums.sort((a, b) => a - b);
  const value = numOrNull(self);
  const base = { value: value == null ? null : r1(value), n: nums.length, missing: all.length - nums.length };
  if (value == null) return { state: 'none', ...base };
  if (nums.length < min) return { state: 'few', ...base };
  const q1 = quantile(nums, 0.25); const med = quantile(nums, 0.5); const q3 = quantile(nums, 0.75);
  const w = Math.max(1.5 * (q3 - q1), numOrNull(floor) || 0, ((numOrNull(floorPct) || 0) / 100) * Math.abs(med));
  // 폭은 그 지표가 가질 수 있는 값 안으로 자른다(판정 뒤가 아니라 앞에 잘라도 같다 — 값은 그 끝을 넘지 못한다)
  const lb = numOrNull(lower); const ub = numOrNull(upper);
  const lo = r1(lb == null ? q1 - w : Math.max(lb, q1 - w)); const hi = r1(ub == null ? q3 + w : Math.min(ub, q3 + w));
  // 판정은 화면에 쓰는 수(소수 한 자리)로 — ‘이 서버 33.8 · 폭 ~ 33.8’ 인데 ‘밖’ 이라 하지 않게(반증 A9)
  const v1 = r1(value);
  const state = v1 > hi ? 'high' : v1 < lo ? 'low' : 'in';
  return { state, ...base, median: r1(med), lo, hi, min: r1(nums[0]), max: r1(nums[nums.length - 1]), points: nums.map(r1) };
}

/**
 * 묶음 판정 — 서버별 값 표에서 이 서버의 네 지표를 낸다.
 * @param {Array<{ id:string, cpu?:number|null, mem?:number|null, power?:number|null, inlet?:number|null }>} rows 묶음 서버(이 서버 포함)
 * @param {string} selfId
 * @returns {{ metrics: Record<string, object>, out: number, judged: number }} out = 폭 밖 지표 수 · judged = 판정한 지표 수
 */
export function judgePeerGroup(rows, selfId) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
  const self = list.find((r) => r.id === selfId) || null;
  const metrics = {}; let out = 0; let judged = 0;
  for (const m of PEER_METRICS) {
    const j = judgePeer(list.map((r) => r[m.id]), self ? self[m.id] : null, { floor: m.floor, floorPct: m.floorPct, lower: m.lower, upper: m.upper });
    metrics[m.id] = { ...j, unit: m.unit, basis: m.basis };
    if (j.state === 'high' || j.state === 'low') out += 1;
    if (j.state === 'high' || j.state === 'low' || j.state === 'in') judged += 1;
  }
  return { metrics, out, judged };
}
