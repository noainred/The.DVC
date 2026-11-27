/**
 * cvp/trend.js — 일 기록 직선 추세 · 도달 예상(순수, v3.38 — docs/design/cvp-network-features §3 '예측' · 'GBIC 추세').
 *
 * 규칙: 점이 minDays 개(서로 다른 날) 미만이면 '기록 부족'(short) — 추세를 지어내지 않는다. 기울기가 목표 쪽으로 가지 않으면 '예측 없음'(flat).
 *   값이 null 인 날은 점으로 넣지 않는다(못 읽은 값은 0 이 아니다). 도달 날짜는 지금보다 앞이면 '이미 넘음'(already).
 */
export const DAY_MS = 86_400_000;
/** 예측 지평선(일) — 화면은 이 값을 응답으로 받아 '○년 안 · ○년 넘게' 를 쓴다(v3.42 D11 — 화면에 박지 않는다). */
export const HORIZON_DAYS = 365;

/**
 * 최소제곱 직선. points: [[ms, y], …] (y null 은 버린다).
 * @returns {{ n:number, slopePerDay:number, at:(ms:number)=>number, first:number, last:number } | null}
 */
export function linFit(points) {
  const pts = (Array.isArray(points) ? points : []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && p[1] != null && Number.isFinite(Number(p[1])));
  if (pts.length < 2) return null;
  const x0 = pts[0][0];
  let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
  for (const [ms, yv] of pts) { const x = (ms - x0) / DAY_MS; const y = Number(yv); sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const n = pts.length;
  const den = n * sxx - sx * sx;
  if (den === 0) return null;
  const slope = (n * sxy - sx * sy) / den;
  const icpt = (sy - slope * sx) / n;
  return { n, slopePerDay: slope, at: (ms) => icpt + slope * ((ms - x0) / DAY_MS), first: pts[0][0], last: pts[pts.length - 1][0] };
}

/** 서로 다른 날 수(null 제외). */
export const dayCount = (points) => new Set((Array.isArray(points) ? points : []).filter((p) => p && p[1] != null).map((p) => Math.floor(p[0] / DAY_MS))).size;

/**
 * 목표값 도달 예상.
 * @param {Array<[number, number|null]>} points
 * @param {{ target:number, dir:'up'|'down', minDays?:number, now?:number, horizonDays?:number, minSlopePerDay?:number }} o
 * @returns {{ state:'short'|'flat'|'already'|'eta'|'far', days:number, slopePerDay:number|null, eta:number|null, current:number|null }}
 *   short = 기록 부족 · flat = 목표 쪽으로 늘지(줄지) 않음 · already = 지금 값이 이미 목표를 넘음 · eta = horizon 안 도달 예상 · far = horizon 밖
 */
export function forecast(points, { target, dir = 'up', minDays = 90, now = Date.now(), horizonDays = HORIZON_DAYS, minSlopePerDay = 0, staleDays = 3 } = {}) {
  const days = dayCount(points);
  const valid = (Array.isArray(points) ? points : []).filter((p) => p && p[1] != null);
  const current = valid.length ? Number(valid[valid.length - 1][1]) : null;
  // v3.42(버그 점검 1회차 A2-F3): 마지막 기록이 오래됐으면 '지금 값' · '이미 넘음' 으로 쓰지 않는다(120일 전 값이 '이미 넘음' 으로 나왔다).
  const lastAt = valid.length ? valid[valid.length - 1][0] : null;
  if (lastAt != null && Number.isFinite(staleDays) && now - lastAt > staleDays * DAY_MS) return { state: 'stale', days, slopePerDay: null, eta: null, current, lastAt };
  if (current != null && Number.isFinite(target) && (dir === 'up' ? current >= target : current <= target)) return { state: 'already', days, slopePerDay: null, eta: null, current };
  if (days < minDays) return { state: 'short', days, slopePerDay: null, eta: null, current };
  const f = linFit(valid);
  if (!f) return { state: 'flat', days, slopePerDay: 0, eta: null, current };
  const s = f.slopePerDay;
  const toward = dir === 'up' ? s > minSlopePerDay : s < -minSlopePerDay;
  if (!toward || !Number.isFinite(target)) return { state: 'flat', days, slopePerDay: s, eta: null, current };
  // 직선 위의 '지금' 값에서 목표까지(마지막 측정값이 아니라 직선 — 하루 튐에 날짜가 흔들리지 않게).
  const base = f.at(now);
  const needDays = (target - base) / s;
  if (!Number.isFinite(needDays)) return { state: 'flat', days, slopePerDay: s, eta: null, current };
  if (needDays <= 0) return { state: 'eta', days, slopePerDay: s, eta: now, current };
  const eta = now + needDays * DAY_MS;
  return { state: needDays > horizonDays ? 'far' : 'eta', days, slopePerDay: s, eta, current };
}

/**
 * 계단식 회복(교체 · 청소)이 있으면 그날부터 다시 — 직전 날보다 jumpDb 이상 오르면 그 점부터 자른다(마지막 회복 기준).
 * @param {Array<[number, number|null]>} points 날 오름차순
 */
export function sinceLastRecovery(points, jumpDb = 2) {
  const pts = Array.isArray(points) ? points : [];
  let cut = 0; let prev = null;
  for (let i = 0; i < pts.length; i++) {
    const v = pts[i] && pts[i][1];
    if (v == null) continue;
    if (prev != null && Number(v) - prev >= jumpDb) cut = i;
    prev = Number(v);
  }
  return { points: pts.slice(cut), resetAt: cut > 0 ? pts[cut][0] : null };
}
