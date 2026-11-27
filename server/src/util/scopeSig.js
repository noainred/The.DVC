// 범위 서명 — vCenter id 집합(조회 범위 · 쓰기 범위 · 고른 법인 등)을 캐시 열쇠 조각으로 바꾸는 **유일한** 함수.
//   **단사여야 한다**(서로 다른 집합 = 다른 글자). 등록부(vcenter/registry.js normalize)는 id 에 쉼표도 'all' 도 '*' 도 허용한다 —
//   예전 `[...a].sort().join(',')` · 무제한 'all' 은 ['KR,Seoul'] 과 ['KR','Seoul'], scope ['all'] 과 무제한을 같은 열쇠로 만들어
//   memoJson 캐시 · ETag 를 다른 범위의 계정과 함께 썼다(dbg3231 · v3.23.2 — 범위 계정이 범위 밖 법인의 값을 받을 수 있었다).
//   규칙: 무제한(null · undefined) = SCOPE_SIG_ALL('*' — 's:' 로 시작하지 않으므로 어떤 범위 서명과도 겹치지 않는다) ·
//   범위 = 's:' + JSON(중복 제거 · 문자열화 · 정렬한 배열). 무제한 판정은 이 표식과 비교한다('all' 글자 비교 금지).
//   글자 join 으로 범위 열쇠를 만들지 말 것 — server/test/scopeSig3232.test.js 의 소스 스윕이 막는다.
export const SCOPE_SIG_ALL = '*';

/** ids: Set · 배열 · 기타 iterable(범위) 또는 null/undefined(무제한). */
export function scopeSig(ids) {
  if (ids == null) return SCOPE_SIG_ALL;
  return `s:${JSON.stringify([...new Set([...ids].map(String))].sort())}`;
}
