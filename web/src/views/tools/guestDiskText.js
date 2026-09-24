/**
 * views/tools/guestDiskText.js — 게스트 디스크 리포트 안내 문구(순수, v2.600 감사 LO2600-07).
 * 서버(`guestdisk/service.js`·`poller.js lastResult.partsUnknown`)가 여유 공간을 보고하지 않은 파티션을
 * 할당·사용 합계에서 **빼고** 개수를 준다. 화면이 말하지 않으면 '전부 반영했다' 는 거짓이 된다.
 */
/** @returns {string} 빈 문자열이면 표시하지 않는다. */
export function partsUnknownNote(n) {
  const k = Number(n);
  if (!Number.isFinite(k) || k <= 0) return '';
  return `최근 수집에서 여유 공간을 보고하지 않은 파티션 ${k}개는 할당·사용 합계와 회수 후보에서 **제외**했습니다(0 으로 채우지 않았습니다).`;
}
