/**
 * 조회 키와 '직전 결과 유지' 판정(v2.612 RECENT2612-06, 순수).
 *
 * v2.611 WEB2611-07·08 은 조회 실패 시 직전 행을 지우지 않고 배너로 말하게 했다 — **같은 조회의 재시도**에는 맞다.
 * 그러나 범위·필터를 바꾼 뒤의 실패에서는 그 행이 **다른 vCenter·필터의 결과**라서, 새 선택 아래 보이면
 * 거짓이 된다(DavinciChecks 가 같은 이유로 미리보기를 비운다 — 형제 비대칭). 행을 받은 조회 키를 함께 들고,
 * 실패한 조회의 키와 다르면 비운다.
 */

/** 조회 조건 → 비교용 문자열(키 순서 무관). 빈 값('', null, undefined, false)은 조건이 없는 것과 같다. */
export function queryKey(params) {
  const o = params && typeof params === 'object' ? params : {};
  const ent = Object.keys(o).filter((k) => o[k] !== '' && o[k] != null && o[k] !== false).sort().map((k) => [k, String(o[k])]);
  return JSON.stringify(ent);
}

/** 실패했을 때 직전 행을 남겨도 되는가 — 그 행이 **지금 조회와 같은 조건**으로 받은 것일 때만. */
export function keepRowsOnError(rowsKey, failedKey) {
  return rowsKey != null && rowsKey === failedKey;
}
