/**
 * sanswitch/perfRollup.js — 포트 사용량 집계 표(15분·1시간)의 순수 계산(v2.728 SAN 2차).
 *
 * 왜: 화면을 열 때마다 원본(포트마다 5분에 1행)을 처음부터 다시 집계했다. 운영 DB(약 16GB · 1억 행 추정)에서는
 *   7일 조회가 캐시에 있어도 수 초, 디스크에서 읽으면 30초를 넘었다(합성 DB 실측 — v2.727 이전 조사 보고).
 *   15분·1시간 단위로 미리 합쳐 둔 표를 읽으면 7일 조회가 읽는 행이 1/12 이 된다.
 *
 * 결과 동일성 — 이 모듈의 핵심 계약:
 *   집계 표 한 행은 (장비, 집계 버킷, 포트) 의 **표본 수 n · 합 s · 최대 mx · 마지막 시각 lt** 다. 평균을 저장하지 않는다 —
 *   n 과 s 가 있으면 여러 행을 합쳐도 원본의 AVG 와 같은 값이 나온다(s/n). 조회 버킷이 집계 버킷의 정배수일 때만 집계 표를
 *   쓰고(rollupGranularity), 조회 구간의 앞뒤 자투리(집계 버킷 하나를 다 채우지 못하는 부분)와 아직 집계 표가 완성되지 않은
 *   구간은 **원본**으로 읽는다(planSegments). 그래서 원본이 남아 있는 한 결과는 예전 한 문장 집계와 같다(테스트가 대조한다).
 *   유일한 예외: 원본이 보존일로 이미 지워진 구간의 머리 자투리는 그 집계 버킷 전체를 쓴다(원본으로는 0 행이라 — 근사).
 */

export const G15 = 900_000;
export const G1H = 3_600_000;
const MIN = 60_000;

export const alignDown = (t, g) => Math.floor(t / g) * g;
export const alignUp = (t, g) => Math.ceil(t / g) * g;

/**
 * 조회 버킷 폭을 집계 표에 맞춘다(rangeOf 가 부른다). 원래 폭 = 구간 ÷ 점 수.
 *  - 10분 미만: 그대로(원본을 읽는다 — 1시간·6시간·12시간 조회).
 *  - 10분 이상 45분 미만: 15분의 정배수로 올린다(24시간 → 12분 → 15분, 96점).
 *  - 45분 이상: 1시간의 정배수로 올린다(7일 → 84분 → 2시간, 84점 · 30일 → 6시간 · 90일 → 18시간).
 *  - allow15=false(15분 집계 보관 기간보다 오래된 구간)면 10분 이상은 전부 1시간 정배수로 올린다.
 * 점 수가 조금 줄어든다(24시간 120 → 96, 7일 120 → 84). 화면은 buckets 배열을 그대로 그리므로 영향이 없다.
 */
export function snapBucketMs(rawMs, { allow15 = true } = {}) {
  const r = Number(rawMs);
  if (!Number.isFinite(r) || r < 10 * MIN) return r;
  if (r >= 45 * MIN || !allow15) return Math.ceil(r / G1H) * G1H;
  return Math.ceil(r / G15) * G15;
}

/** 조회 버킷이 어느 집계 표로 정확히 채워지는가. 1시간 정배수면 1시간 표, 15분 정배수면 15분 표, 아니면 0(원본). */
export function rollupGranularity(bucketMs) {
  const b = Number(bucketMs);
  if (!Number.isFinite(b) || b <= 0) return 0;
  if (b % G1H === 0) return G1H;
  if (b % G15 === 0) return G15;
  return 0;
}

/**
 * 조회 구간을 '집계 표로 읽을 구간' 과 '원본으로 읽을 구간' 으로 나눈다(끝은 전부 **제외**).
 * @param {{ since:number, until:number, g:number, availFrom:number|null, rawOldest:number|null }} p
 *   until 은 포함(원본 조회의 `ts <= until` 과 같은 뜻). availFrom = 이 시각 이후는 집계 표가 완성돼 있다(null 이면 쓰지 않는다).
 *   rawOldest = 원본의 가장 오래된 표본 시각(null = 원본 없음).
 * @returns {{ rollup: [number, number]|null, raw: Array<[number, number]>, headApprox: boolean }}
 */
export function planSegments({ since, until, g, availFrom = null, rawOldest = null }) {
  const lo = Number(since);
  const end = Number(until) + 1;
  if (!g || availFrom == null || !Number.isFinite(Number(availFrom)) || !(end > lo)) return { rollup: null, raw: end > lo ? [[lo, end]] : [], headApprox: false };
  const avail = alignUp(Number(availFrom), g);
  let rs = Math.max(alignUp(lo, g), avail);
  const re = alignDown(end, g);
  let headApprox = false;
  // 머리 자투리의 원본이 이미 지워졌으면(보존일 밖) 그 집계 버킷 전체를 쓴다 — 원본으로는 0 행이다.
  if (rs === alignUp(lo, g) && rs > lo && (rawOldest == null || lo < Number(rawOldest))) {
    const head = alignDown(lo, g);
    if (head >= avail) { rs = head; headApprox = true; }
  }
  if (!(rs < re)) return { rollup: null, raw: [[lo, end]], headApprox: false };
  const raw = [];
  if (rs > lo) raw.push([lo, Math.min(rs, end)]);
  if (re < end) raw.push([Math.max(re, lo), end]);
  return { rollup: [rs, re], raw, headApprox };
}

/**
 * 집계 표 조회를 몇 버킷씩 끊어 읽을지(한 문장이 읽는 행 수를 묶는다 — 1시간 표 7일 · 15분 표 2일).
 * 포트 128개 장비면 한 문장이 약 2만 행이다. 30일씩 읽던 첫 판은 한 문장 9만 행을 한 번에 배열로 만들어 최장 멈춤이
 * 300ms 를 넘었다(합성 2천만 행 · 40대 · 14일 조회 실측).
 */
export function rollupChunkBuckets(g) { return g === G1H ? 168 : 192; }
