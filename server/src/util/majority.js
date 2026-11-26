/**
 * util/majority.js — '다수 값'(같은 묶음에서 가장 많은 서버가 쓰는 값) 판정 하나(v3.45 물리서버 점검 — 펌웨어 기준선 · BIOS 설정 편차).
 *
 *  · 모르는 값(null · undefined · 빈 글자 · 객체)은 **세지 않는다** — 못 읽은 서버를 '빈 값을 쓰는 서버' 로 세면 그 빈 값이 다수가 된다.
 *  · 다수 = **유일한 최다 값**이고 2대 이상이 쓸 때만. 동률이거나 아는 값이 하나뿐이면 다수가 없다(어느 쪽이 옳다고 말하지 않는다 —
 *    hostcfg 드리프트와 같은 규칙).
 *  · 다수는 '가장 많다' 이지 '옳다' 가 아니다 — 호출부 문구가 그렇게 써야 한다.
 * ⚠ util/ 규약: 도메인 모듈을 import 하지 않는다. 순수.
 *
 * @param {Array<unknown>} values
 * @returns {{ value: string|null, count: number, known: number, distinct: number, tie: boolean }}
 *   value 다수 값(없으면 null) · count 그 값을 쓰는 수 · known 값을 아는 수 · distinct 서로 다른 값의 수 · tie 값이 갈려 다수가 없다
 */
export function majorityOf(values) {
  const counts = new Map();
  let known = 0;
  for (const v of Array.isArray(values) ? values : []) {
    const s = typeof v === 'string' ? v : (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' ? String(v) : null;
    if (s == null || s === '') continue;
    known += 1;
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  let top = null; let topN = 0; let secondN = 0;
  for (const [v, n] of counts) {
    if (n > topN) { secondN = topN; top = v; topN = n; } else if (n > secondN) secondN = n;
  }
  const unique = topN >= 2 && topN > secondN;
  return { value: unique ? top : null, count: unique ? topN : 0, known, distinct: counts.size, tie: !unique && counts.size >= 2 };
}

export default majorityOf;
