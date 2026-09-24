/**
 * nsx/scope.js — NSX 조회의 사용자 scope 판정(v2.320, 2026-08-13 감사 보류 갭 적용).
 *
 * 설계(사용자 승인 '잔여작업 진행' — 매니저↔vCenter 귀속 규칙):
 *   범위 계정에게 NSX 매니저는 ① 매니저.vcenterId ∈ 허용 vCenter 이거나
 *   ② 매니저.region ∈ (허용 vCenter 들의 location.region 집합) 일 때만 보인다.
 *   **귀속 정보가 둘 다 없는 매니저는 범위 계정에 숨긴다** — server/CLAUDE.md
 *   'vCenter 귀속 없는 데이터는 범위 계정에 노출 금지' 불변조건. 전체 범위 계정(allowed=null)은
 *   기존대로 전부 본다.
 *
 * 순수 함수로 분리한 이유: 라우트(overviewNsx.js)와 테스트(nsxRemoteScope.test.js)가 같은
 * 판정을 공유 — 규칙이 라우트 안에 인라인이면 회귀 테스트가 라우트 서버 기동을 요구한다.
 */

/** 허용 vCenter 들의 region 집합(빈 region 은 제외 — '' 매칭으로 무귀속 매니저가 새는 것 방지). */
export function allowedRegions(vcenters, allowedSet) {
  const out = new Set();
  for (const v of vcenters || []) {
    if (allowedSet.has(v.id) && v.location?.region) out.add(v.location.region);
  }
  return out;
}

/** 범위 계정에 보이는 매니저 목록. allowedSet=null(전체 범위)이면 전부. */
export function visibleNsxManagers(managers, vcenters, allowedSet) {
  if (!allowedSet) return managers || [];
  const regions = allowedRegions(vcenters, allowedSet);
  return (managers || []).filter((m) =>
    (m.vcenterId && allowedSet.has(m.vcenterId)) || (m.region && regions.has(m.region)));
}

/** 단일 매니저(레지스트리 항목 — location.region 형태)가 범위 안인가(group-members 검사용). */
export function managerInScope(mgr, vcenters, allowedSet) {
  if (!allowedSet) return true;
  const region = mgr.region || mgr.location?.region || '';
  const regions = allowedRegions(vcenters, allowedSet);
  return !!((mgr.vcenterId && allowedSet.has(mgr.vcenterId)) || (region && regions.has(region)));
}

/**
 * 필터된 리소스 기준 rollup 재계산 — 범위 계정에 전 함대 집계(nsx/store.js rollup — 매니저/
 * 게이트웨이/세그먼트/DFW 총계)가 새지 않게, 보이는 것만으로 같은 필드를 다시 센다
 * (필드 구성은 nsx/store.js rollup() 과 동일하게 유지할 것 — UI 가 같은 키를 읽는다).
 */
/*
 * v2.600(감사 COL-2600-06 후속): 매니저가 어떤 목록을 **읽지 못했으면**(nsx/client.js `listsFailed`) 그 목록에서 나온
 * 합계는 '0개' 가 아니라 **모른다**(null)다 — 예전에는 빈 배열 길이·`|| 0` 으로 0 이 더해져 '세그먼트 0' 같은 거짓이 됐다.
 * 실패한 매니저 수는 `listsFailed`({목록:매니저 수})로 밝힌다(뺀 사실을 숨기지 않는다).
 */
const LIST_FIELDS = {
  transportNodes: ['hostNodes', 'edgeNodes'],
  tier0s: ['t0'],
  tier1s: ['t1'],
  segments: ['segments', 'overlaySegments', 'vlanSegments'],
  securityPolicies: ['dfwPolicies', 'dfwRules'],
  groups: ['groups'],
};

/** 매니저들이 읽지 못한 목록 → { 목록: 매니저 수 }. */
export function nsxListsFailed(managers) {
  const out = {};
  for (const x of managers || []) {
    for (const k of Array.isArray(x?.listsFailed) ? x.listsFailed : []) out[k] = (out[k] || 0) + 1;
  }
  return out;
}

export function scopedNsxRollup({ managers, gateways, segments, transportNodes }) {
  const g = gateways || [], tn = transportNodes || [], m = managers || [], seg = segments || [];
  // 값이 null 인 매니저가 하나라도 있으면 합계도 null(부분 합을 전체라 말하지 않는다).
  const sumOrNull = (f) => { let a = 0; for (const x of m) { const v = f(x); if (v == null) return null; a += Number(v) || 0; } return a; };
  const r = {
    managers: m.length,
    managersUp: m.filter((x) => x.status === 'connected').length,
    managersDegraded: m.filter((x) => x.status === 'degraded').length,
    t0: g.filter((x) => x.tier === 'T0').length,
    t1: g.filter((x) => x.tier === 'T1').length,
    segments: seg.length,
    overlaySegments: seg.filter((s) => s.type === 'OVERLAY').length,
    vlanSegments: seg.filter((s) => s.type === 'VLAN').length,
    hostNodes: tn.filter((x) => x.type === 'host').length,
    edgeNodes: tn.filter((x) => x.type === 'edge').length,
    // firewall 이 아예 없는 매니저(구버전 스냅샷)는 예전처럼 0 으로 둔다 — null 은 '조회 실패' 표식일 때만.
    dfwPolicies: sumOrNull((x) => (x.firewall ? x.firewall.policies : 0)),
    dfwRules: sumOrNull((x) => (x.firewall ? x.firewall.rules : 0)),
    groups: sumOrNull((x) => (x.groups === undefined ? 0 : x.groups)),
  };
  const failed = nsxListsFailed(m);
  for (const [list, fields] of Object.entries(LIST_FIELDS)) {
    if (failed[list]) for (const f of fields) r[f] = null;
  }
  if (Object.keys(failed).length) r.listsFailed = failed;
  return r;
}
