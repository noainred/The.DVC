/**
 * components/tableKeys.js — 표 행 React key 를 **고유하게**(v3.12.5 · 2차 루프 5회차).
 *  - DataTable 은 행 key 로 `r.id || r.key || i` 를 썼다. 라이선스 표는 가림 처리된 키(XXXXX-…-AAAAA)가 여러 vCenter 에서 같아
 *    key 가 겹쳤고, 정렬을 바꿀 때마다 React 가 행을 지우지 못해 **표가 불어났다**(재현: 55 → 105 → 155 → … · 운영 빌드).
 *  - 겹치는 key 는 나온 차례대로 `~1`, `~2` 를 붙인다(첫 것은 그대로 — 겹치지 않는 표의 key 는 바뀌지 않는다).
 */
export function uniqueKeys(baseKeys) {
  const seen = new Map();
  return (Array.isArray(baseKeys) ? baseKeys : []).map((b) => {
    const k = String(b); const n = seen.get(k) || 0; seen.set(k, n + 1);
    return n ? `${k}~${n}` : k;
  });
}
/** DataTable 의 기본 행 key(예전과 같은 우선순위) — id → key → 차례. */
export const baseRowKey = (r, i) => (r && (r.id || r.key)) || i;
