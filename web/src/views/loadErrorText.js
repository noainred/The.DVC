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
