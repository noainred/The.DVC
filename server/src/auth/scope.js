// 사용자 데이터 범위(scope) 해석 — "이 사용자가 볼 수 있는 vCenter"를 계산한다.
// scope = { vcenters:[id...], regions:[name...] }. 둘 다 비면 제한 없음(전체).
// 명시 vCenter + 지정 리전에 속한 모든 vCenter 의 합집합을 허용 집합으로 반환한다.
// 반환: 허용 vCenter id Set, 또는 제한 없으면 null.
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
