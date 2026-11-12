/**
 * vmtrack/scopeIds.js — VM 수량 추이 조회의 vCenter 집합(순수 · v2.958).
 *
 * 왜: 가상화 플랫폼 허브의 범위 바가 '리전' 으로도 좁혀지는데 `/tools/vm-track` 은 vcenterId 하나만 받았다 —
 * 리전을 고르면 KPI(VM 증가 · 스토리지 증가)가 전 법인 값을 그대로 보였다(사용자 지적 2026-11-10).
 *
 * 규약
 *  - 사용자 범위(allowed · null = 전체)가 먼저다 — 요청의 region 은 그 **교집합**만 좁힌다(scope 우회 금지).
 *  - region 이 비었으면 allowed 그대로(null 이면 null — service 의 '전체' 경로 유지).
 *  - region 에 맞는 vCenter 가 하나도 없으면 **빈 Set**(service 는 빈 집합을 '없음' 으로 집계한다 — 전체로 넓히지 않는다).
 *  - 리전 비교는 저장된 문자열 그대로(대소문자 · 공백을 손대지 않는다 — 허브 범위 바가 같은 값을 보낸다).
 */
export function trackScopeIds({ allowed = null, region = '', vcenters = [] } = {}) {
  const r = typeof region === 'string' ? region.trim() : '';
  if (!r) return allowed;
  const ids = (Array.isArray(vcenters) ? vcenters : [])
    .filter((v) => v && typeof v === 'object' && String(v.location?.region ?? '') === r)
    .map((v) => String(v.id))
    .filter((id) => !allowed || allowed.has(id));
  return new Set(ids);
}
