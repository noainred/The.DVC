// loadErrorText.js — 결정(56~75 남긴 것) G2: 설정 · 저장소 파일을 못 읽은 동안의 화면 표지 문구(순수 — vitest 가 고정한다).
//   서버 공용 로더(server/src/util/jsonFileLoad.js)의 표지 `{ reason, at, readError }` 를 받는다. reason 은 서버가 만든 요약이다(파일 조각 없음 —
//   읽기 오류면 '다시 읽고 풀린다' 는 안내까지 들어 있다). 손상이면 풀 방법(서비스 점검 확정 · 보존본 복구)을 덧붙인다.
//   ⚠ 주기 · 간격 숫자를 화면에 박지 않는다(서버 reason 이 말한다) · 문구에 백틱 금지.

/** 표지 → 한 줄 문구. 표지가 없으면 ''. effect = 그동안 화면 값에 생기는 일(예: '수동 분류가 빠진 자동 분류로 보입니다'). */
export function loadErrorText(what, le, effect = '') {
  if (!le || typeof le !== 'object') return '';
  const why = typeof le.reason === 'string' && le.reason.trim() ? le.reason.trim().slice(0, 240) : '파일을 읽지 못했습니다';
  const fix = le.readError ? '' : ' 서비스 점검에서 기본값으로 확정하거나 손상 보존본을 되돌리세요.';
  return `${what} — ${why}.${fix}${effect ? ` ${effect}` : ''} 그동안 저장은 거절합니다.`;
}

/**
 * 128회차(123회차가 남긴 ‘손상본 보존’ 문구): 못 읽은 사유별 **조치** 한 줄 — 화면 30여 줄이 사유를 가리지 않고 ‘손상본은 .corrupt 로 보존했습니다 · 보존본을 되돌리세요’ 라고만 말했다.
 *   읽기 오류(readError — 권한 · 소유자 · 디스크)는 원본이 제자리에 있어 **보존본이 없고** 서비스 점검에서 확정할 수도 없다. 서버가 표지에 readError 를 싣는 화면만 이 함수를 쓴다.
 * @param {object|null} le  표지 `{ reason, readError }`
 * @param {{ corrupt?:string }} [o]  손상일 때의 조치 문구(화면마다 있던 문장을 그대로 넘긴다)
 */
export function unreadFixText(le, { corrupt = '서비스 점검에서 기본값으로 확정하거나 손상 보존본을 되돌리세요.' } = {}) {
  if (!le || typeof le !== 'object') return '';
  return le.readError === true
    ? '읽기 오류라 손상 보존본은 없습니다 — 원본은 그대로 있으니 파일 권한 · 소유자 · 디스크를 확인하세요(읽히면 풀립니다).'
    : corrupt;
}
