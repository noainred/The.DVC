/**
 * 페이징 인자 정규화(v2.594, 감사 SEC-2594-01~03).
 *
 * 왜 하나로 두는가: `Math.min(1000, Number(q.limit) || 200)` 형태는 **하한이 없다** — `limit=-1` 이
 * 그대로 SQLite `LIMIT ?` 로 가면 SQLite 는 음수를 '제한 없음' 으로 읽어 상한 1,000행이 사라지고
 * (operator 가 기본 보유한 tools 권한으로 전 로그를 동기 조회 — 이벤트 루프 정지), 배열 `slice(offset, offset-1)`
 * 에서는 마지막 한 행만 뺀 전량이 된다. 실수·1e20 같은 값은 SQLite 바인드에서 datatype mismatch(500)다.
 * 라우트마다 고치면 다음 라우트에서 또 빠지므로 헬퍼 하나로 둔다.
 *
 * @returns {{limit:number, offset:number}} limit ∈ [1, max] 정수 · offset ∈ [0, MAX_SAFE_INTEGER] 정수
 */
export function pageArgs(q = {}, { def = 200, max = 1000 } = {}) {
  const intOr = (v, d) => {
    if (v == null || v === '') return d;
    const n = Math.trunc(Number(v));
    return Number.isFinite(n) ? n : d;
  };
  const limit = Math.max(1, Math.min(max, intOr(q.limit, def) || def));
  const offset = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, intOr(q.offset, 0)));
  return { limit, offset };
}
