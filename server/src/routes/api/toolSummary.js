/**
 * routes/api/toolSummary.js — 특수 기능 도구의 '요약 모드'(v3.21.0 — VM 분석 화면 · docs/design/vm-insight §10) 공용 선언.
 *
 * 규약(docs/rules/security-api.md '도구 요약 모드'):
 *  · 새 경로를 만들지 않는다 — 기존 도구 라우트에 `?summary=1` 을 더해 **같은 게이트**(requirePerm('tools') + toolGate 도구별 거부 +
 *    vCenter 범위)를 그대로 지난 뒤 요약만 돌려준다. 새 경로면 toolGate 매핑 · 범위 처리를 다시 걸어야 하고 빠뜨리기 쉽다.
 *  · 요약 = 법인(vCenter)별 줄 + 법인별 상위 N. 화면이 고른 법인의 줄을 더하고 상위 N 을 다시 고른다
 *    (합집합의 상위 N 은 법인별 상위 N 의 합집합 안에 있다 — 선택을 바꿀 때 서버 왕복이 없다).
 *  · 판정은 도구 그대로(새 계산 금지) · 기준값은 응답에 싣는다 · 화면 목록 상한(LIST_LIMIT · ROWS_MAX)에 잘린 행으로 세지 않는다.
 *  · memoJson 라우트는 열쇠에 요청 URL 이 들어가 `summary=1` 이 원본과 다른 칸을 쓴다 — 범위 서명(extraKey)은 원본 그대로 실린다.
 */
export const SUMMARY_TOP_N = 5;

/** `?summary=1`(또는 true) 인가. 글자가 아닌 값(배열 · 객체)은 아니다. */
export function isSummaryQuery(query) {
  const v = query?.summary;
  return typeof v === 'string' && (v === '1' || v.toLowerCase() === 'true');
}

/**
 * 배열을 vCenter 별로 묶는다(순서 유지). keyOf 기본 = vcenterId.
 * @returns {Map<string, any[]>}
 */
export function groupByVc(arr, keyOf = (x) => x?.vcenterId) {
  const m = new Map();
  for (const x of arr || []) {
    const k = String(keyOf(x) ?? '');
    let a = m.get(k);
    if (!a) { a = []; m.set(k, a); }
    a.push(x);
  }
  return m;
}
