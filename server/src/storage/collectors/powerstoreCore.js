/**
 * storage/collectors/powerstoreCore.js — PowerStore 수집기 공용 판정(순수, v2.599).
 * REST(powerstore.js)와 SSH(powerstoreSsh.js)가 **같은 규칙**을 쓰게 하는 단일 소스다 — 두 벌이면 한쪽만 고쳐지고
 * (감사 C2599-02: SSH 는 '마지막 점' 을 쓰고 있었다) 판정이 갈라진다. import 없음(순환 방지).
 */

/**
 * 공간 시계열 응답에서 쓸 점 하나 고르기(순수).
 * PowerStore 는 응답을 배열로 주는데 정렬 방향이 경로마다 다르고(오름/내림), 최신 점이 아직
 * 집계 전이라 physical_total 이 비어 있는 경우도 있다. 그래서 '물리 총량이 있는 점' 중
 * timestamp 가 가장 큰 것을 고르고, timestamp 가 없으면 배열 뒤쪽(대개 최신)을 우선한다.
 */
export function pickLatestSpacePoint(metrics) {
  const list = (Array.isArray(metrics) ? metrics : [metrics]).filter(Boolean);
  const withTotal = list.filter((p) => Number(p.physical_total) > 0);
  const pool = withTotal.length ? withTotal : list;
  if (!pool.length) return null;
  const ts = (p) => Date.parse(p.timestamp || '') || 0;
  if (pool.some((p) => ts(p))) return pool.reduce((a, b) => (ts(b) >= ts(a) ? b : a));
  return pool[pool.length - 1];
}

/**
 * 알람 1건이 '미해결' 인가(순수, v2.513).
 * 폴백 경로(장비가 `state=eq.ACTIVE` 를 못 받는 버전)에서만 쓴다 — 전체를 받아 코드에서 거른다.
 * PowerStore 는 `state` 를 ACTIVE/CLEARED 로 주는데, 버전에 따라 이 필드가 없고
 * `is_acknowledged` 만 있는 응답도 있다. **필드가 없다고 해서 미해결이라고 단정하지 않는다** —
 * 확인(acknowledged)된 것만 제외하고 나머지는 남긴다(건수를 줄여 '조용한 축소' 를 만들지 않기 위함).
 */
export function isActiveAlert(a) {
  const s = String(a?.state ?? '').trim().toUpperCase();
  if (s) return s === 'ACTIVE';
  return a?.is_acknowledged !== true;
}

