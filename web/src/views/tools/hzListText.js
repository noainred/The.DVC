/**
 * Horizon 연결 서버 관리 섹션의 요약 문구(v2.612 WEB2612-04).
 *
 * 등록 목록 조회가 403 이 아닌 이유(시한·500·연결 실패)로 실패하거나 아직 오지 않았을 때
 * 예전에는 `(0대 등록)` + 펼침으로 그려져 **'등록 0대'** 라고 말했다 — 사용자가 이미 있는 id 로
 * 새로 등록해 덮어쓸 여지도 생긴다. 못 읽음·불러오는 중은 개수를 말하지 않는다.
 */
export function hzSummary(hz, err) {
  if (err) return { label: '🖥️ Horizon 연결 서버 관리 (등록 목록을 읽지 못함)', open: false, known: false };
  if (!Array.isArray(hz)) return { label: '🖥️ Horizon 연결 서버 관리 (불러오는 중)', open: false, known: false };
  return { label: `🖥️ Horizon 연결 서버 관리 (${hz.length}대 등록)`, open: hz.length === 0, known: true };
}
