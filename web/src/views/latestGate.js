/**
 * 늦은 응답 가드(v2.606 LEFT2606-05 — v2.596 WS-1~4 규약). 요청마다 `next()` 로 세대를 올리고, 돌려받은 함수로
 * 응답 도착 시 '아직 최신 요청인가' 를 본다. 대상·기간을 빠르게 바꾸면 이전 요청의 응답이 나중에 와도 버린다.
 */
export function makeLatestGate() {
  let gen = 0;
  return {
    next() { const mine = ++gen; return () => mine === gen; },
  };
}
