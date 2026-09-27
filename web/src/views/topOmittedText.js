/**
 * 탐색·랭킹(Explore) Top 목록의 '뺀 것' 한 줄 — v2.632 WEB2632-07.
 *
 * 서버 `/top`(v2.631 WEB2631-05)은 값이 없는 항목(REST 폴백 VM 의 사용률·사용량 미상 DS·끊긴·무응답 호스트)을
 * 순위에서 빼고 개수를 `omitted[<목록 이름>]` 로 싣는데 화면이 그것을 읽지 않았다 — 목록이 '전부 중 상위' 로 읽혔다
 * (조용한 제외). 0 이거나 없으면 null(문구를 띄우지 않는다).
 */
const UNIT = { vm: '대', host: '대', datastore: '개' };
const WHAT = { vm: 'VM', host: '호스트', datastore: '데이터스토어' };

export function topOmittedNote(omitted, listName, type) {
  const n = omitted && typeof omitted === 'object' ? omitted[listName] : null;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) return null;
  const extra = type === 'host' ? '(연결 끊김·무응답 포함)' : '';
  return `값을 읽지 못한 ${WHAT[type] || '항목'} ${n.toLocaleString('en-US')}${UNIT[type] || '개'}${extra}는 순위에서 뺐습니다`;
}
