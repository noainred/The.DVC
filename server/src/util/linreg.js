/**
 * util/linreg.js — 최소제곱 기울기(순수). v2.672 에 routes/api/shared.js 에서 옮겼다 —
 * 도메인 모듈(tools/dsGrowth.js)이 routes/ 를 import 하지 않게(의존 방향은 한쪽 — arch2579).
 * shared.js 는 같은 이름으로 다시 내보낸다(호출부 무변경).
 */

/** Least-squares slope of y over x. 점이 2개 미만이거나 x 가 전부 같으면 null. */
export function linregSlope(xs, ys) {
  const n = xs.length; if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n; const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0; let den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den === 0 ? null : num / den;
}
