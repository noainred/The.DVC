/**
 * 값 + 단위 표기 — **값이 없으면 단위를 붙이지 않는다**(v2.575 BUG-20).
 *
 * ⚠⚠ `— ℃` · `— MB` · `—%` 는 **0 처럼 읽힌다**. CLAUDE.md v2.534 가 전산실 온도 월보드에서
 *   똑같은 결함을 스크린샷 판독으로 잡아 고쳤는데("값이 없으면 단위를 붙이지 말 것 —
 *   `— ℃` 로 나오면 0℃ 처럼 읽힌다") 같은 형태가 다른 화면 **9곳**에 남아 있었다.
 *   `${v ?? '—'}${단위}` 를 새로 쓰지 말고 이 함수를 쓸 것.
 *
 * 판정은 `util/numOrNull.js`(v2.561)와 같은 방향이다 — **타입부터 좁힌다**:
 *   `Number(null)===0` · `Number('')===0` · `Number([])===0` 이라 `Number.isFinite(Number(v))`
 *   만 보면 '읽지 못한 값' 이 0 으로 둔갑한다(이 저장소의 7회 재발 계열).
 *   다만 여기는 **표시 전용**이라 숫자가 아닌 문자열(예: 버전 `5.4.0`)도 그대로 받는다 —
 *   빈 값·null 만 걸러낸다.
 */

/** 표시할 값이 없는가(null·undefined·빈 문자열·NaN). 0 은 값이다. */
export function isBlank(v) {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '' || v === '—';
  if (typeof v === 'number') return !Number.isFinite(v);
  if (typeof v === 'boolean') return false;
  return true; // 객체·배열은 표시할 값이 아니다
}

/**
 * @param {*} v      값
 * @param {string} unit  단위(`'℃'`·`' MB'`·`'%'` — 공백 포함 여부는 호출부가 정한다)
 * @param {object} [opt]
 * @param {string} [opt.dash='—']  값이 없을 때 쓸 표기
 * @param {(v:*)=>string} [opt.fmt]  값 포맷터(천 단위 구분 등)
 * @returns {string} 값이 있으면 `값+단위`, 없으면 **단위 없는** dash
 */
export function unitText(v, unit = '', { dash = '—', fmt = null } = {}) {
  if (isBlank(v)) return dash;
  return `${fmt ? fmt(v) : v}${unit}`;
}

export default unitText;
