/**
 * 에이전트 작업(스캔 결과) 표시용 순수 헬퍼(v2.598, 감사 CENTRAL-03 방어선).
 *
 * 서버가 보고에 없던 수치를 **0 이 아니라 null** 로 준다(central/assignments.js sanitizeScanResult) —
 * 0 으로 칠하면 '미응답 0' 이라는 거짓이 된다. 그리고 예전 저장본에는 객체가 섞여 있을 수 있어,
 * 그대로 렌더하면 React #31 로 화면 전체가 죽는다. 그래서 **유한한 숫자만** 글자로 내고 나머지는 '—' 다.
 */
export function countText(v) {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '—';
}

/** 소요 시간(ms) → '12s'. 못 읽으면 빈 문자열(표시하지 않는다). */
export function durationText(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ` · ${(ms / 1000).toFixed(0)}s` : '';
}

/** found 원소의 글자 필드 — 문자열이 아니면 '' (객체를 렌더하지 않는다). */
export function strField(v) {
  return typeof v === 'string' ? v : '';
}
