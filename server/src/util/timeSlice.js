/**
 * util/timeSlice.js — 시간 기준 양보(v2.672).
 *
 * 개수 기준 양보('N개마다 setImmediate')는 한 건이 느리면 아무것도 막지 못한다. 2026-10-01 운영 장애에서
 * /tools/capacity-forecast 는 데이터스토어 100개마다 양보했는데, 한 개가 원본 표본 17만 행을 집계하느라
 * 100개 사이가 64~70초였다(운영 stallwatch 스택). 그래서 '마지막 양보 뒤 sliceMs 가 지났는가' 로 판단한다.
 *
 * 대가와 한계: 동기 SQL 한 번이 sliceMs 보다 길면 그 한 번은 막는다 — 양보는 '사이' 에서만 가능하다.
 * 그래서 이 도구는 한 건의 비용을 줄이는 수정(롤업 전용 조회 등)과 함께 쓴다.
 */

/**
 * @param {number} [sliceMs=15] 이만큼 연속으로 돌았으면 양보한다
 * @returns {() => Promise<boolean>} 양보했으면 true
 */
export function createYielder(sliceMs = 15) {
  const ms = Number.isFinite(sliceMs) && sliceMs > 0 ? sliceMs : 15;
  let last = performance.now();
  let yields = 0;
  const maybeYield = async () => {
    if (performance.now() - last < ms) return false;
    await new Promise((r) => { setImmediate(r); });
    last = performance.now();
    yields++;
    return true;
  };
  maybeYield.count = () => yields;
  return maybeYield;
}
