/**
 * svcmon/svcmonAccess.js — Monitoring 화면의 **'전체 범위 관리자'** 판정(v2.930 점검 D1-09).
 *
 * 서버 게이트 `adminOnly + fullScopeOnly`(routes/svcmon/shared.js · routes/admin/shared.js fullScopeOnlyWith → auth/scope.js scopedVcenterIds)와
 * 같은 기준을 화면이 **한 군데**에서 계산한다. 예전에는 Monitoring 설정 › 알림 · 설정 연동이 `role === 'admin'` 만 봐서 범위가 지정된 admin 에게
 * 체크박스·저장이 열려 있었고(누르면 403), 개요 배너(SvcMonitor) · 등록 마법사(BulkTab)는 vCenter 범위만 봐 지역(regions) 범위 admin 을 놓쳤다.
 *   · 범위: scopedVcenterIds 는 vcenters 와 regions 가 **둘 다 비었을 때만** 전체다.
 *   · 데모 계정(mock): 요청 문맥 역할은 admin 이지만 조회·저장이 막힌다(auth/demoGuest.js READ_DENY · SAFE_ACTIONS 밖) — 버튼을 열지 않는다.
 * 화면 판정은 UX 게이팅일 뿐이다 — 진실은 서버 게이트다.
 */
export function isFullScopeAdmin(me) {
  if (!me || me.role !== 'admin' || me.demoGuest === true) return false;
  const sc = me.scope || {};
  return !(Array.isArray(sc.vcenters) && sc.vcenters.length) && !(Array.isArray(sc.regions) && sc.regions.length);
}
