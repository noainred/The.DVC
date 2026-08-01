// 사용자 데이터 범위(scope) 해석 — "이 사용자가 볼 수 있는 vCenter"를 계산한다.
// scope = { vcenters:[id...], regions:[name...] }. 둘 다 비면 제한 없음(전체).
// 명시 vCenter + 지정 리전에 속한 모든 vCenter 의 합집합을 허용 집합으로 반환한다.
// 반환: 허용 vCenter id Set, 또는 제한 없으면 null.
/**
 * 단건(:id) 조회용 scope 검사 — 그 자원의 vCenter 가 사용자의 허용 범위에 있는지.
 * 목록 API 는 applyFilters 가 걸러주지만, /vms/:id/console 처럼 id 를 직접 받는 경로는
 * 이 함수로 명시 검사해야 범위 밖 자원의 콘솔·성능·상세가 새지 않는다.
 * 제한 없는 사용자(scope 미설정)는 항상 true.
 */
export function inUserScope(user, snap, vcenterId) {
  const allowed = scopedVcenterIds(user, snap);
  return !allowed || allowed.has(vcenterId);
}

export function scopedVcenterIds(user, snap) {
  const sc = user && user.scope;
  const vcs = sc && Array.isArray(sc.vcenters) ? sc.vcenters : [];
  const regions = sc && Array.isArray(sc.regions) ? sc.regions : [];
  if (!vcs.length && !regions.length) return null; // 제한 없음(전체)
  const set = new Set(vcs);
  if (regions.length) {
    const rset = new Set(regions);
    for (const v of ((snap && snap.vcenters) || [])) if (rset.has(v.location?.region)) set.add(v.id);
  }
  return set;
}
