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

/**
 * 부분 합 VM 안내(v2.631 감사 A6-2631-04 — 서버 v2.630 A2-01·v2.631 R2631-01 의 화면 부분).
 * 서버(`guestdisk/db.js commitCollection` → `poller.js lastResult`)는 여유를 보고하지 않은 파티션이 있는 VM 의 값이
 * **부분 합**이라 추이(vm_series)에 적재하지 않고, 최신 표에는 직전 온전한 값을 유지하거나(partialHeld) 부분 합을
 * 표지와 함께 넣거나(partialShown) 새 값을 만들 수 없어 직전 행을 그대로 둔다(partialStale). 필드가 없으면(구버전 서버·
 * 부분 합 0) 표시하지 않는다.
 * @returns {string} 빈 문자열이면 표시하지 않는다.
 */
export function partialVmsNote(lastResult) {
  const cnt = (v) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0);
  const r = lastResult || {};
  const vms = cnt(r.partialVms);
  if (!vms) return '';
  const held = cnt(r.partialHeld);
  const shown = cnt(r.partialShown);
  const stale = cnt(r.partialStale);
  const parts = [];
  if (held) parts.push(`직전 온전한 값 유지 ${held}대`);
  if (shown) parts.push(`부분 합을 표지와 함께 표시 ${shown}대`);
  if (stale) parts.push(`새 값을 만들 수 없어 직전 행 그대로 ${stale}대`);
  return `최근 수집에서 일부 파티션의 여유를 보고하지 않은 VM ${vms}대는 값이 **부분 합**이라 **추이에 적재하지 않았습니다**${parts.length ? `(${parts.join(' · ')})` : ''} — 그 VM 의 추이는 이번 주기에 비어 있을 수 있습니다.`;
}
