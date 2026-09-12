/**
 * version_3/nav.js — 신규 포탈(V3) 좌측 내비 8 도메인(v2.490, 순수). 아트보드 'DVC Console.dc.html' 의 항목명을 그대로 쓴다.
 * page=true 인 6개는 V3 안의 화면, 나머지는 기존 개발 포탈의 해당 탭(hash)으로 이동(빈 화면을 만들지 않는다).
 * admin 항목은 관리자에게만 보인다. count 는 V3App 이 실 API 값으로 채운다.
 */
export const PAGE_IDS = ['overview', 'compute', 'storage', 'network', 'facility', 'alarms'];

export const PAGE_META = {
  overview: { crumb: '개요 · 전사', title: '전사 현황' },
  compute: { crumb: '컴퓨트', title: 'vCenter · 호스트 · 가상머신', sub: 'Platform + VM호스트 + 가상머신 탭 통합 · 리전/vCenter 범위 적용' },
  storage: { crumb: '스토리지', title: '데이터스토어 · 어레이 · SAN', sub: 'Datastores + StorageMon + SanSwitch 통합' },
  network: { crumb: '네트워크', title: '스위치 · NSX · 트래픽 · IPAM', sub: 'Networks + NSX + IPAM 통합' },
  facility: { crumb: '물리 · 설비', title: 'BMC · 전력 · 온도', sub: 'IdracAdmin + PduTool + RoomTemp 통합' },
  alarms: { crumb: '모니터링', title: '알람 센터', sub: 'vSphere 알람 + svcmon 실패 · 도메인 교차 상관' },
};

export const NAV_GROUPS = [
  { id: 'overview', label: '개요', items: [
    { id: 'overview', name: '전사 현황', page: true },
    { id: 'summary', name: '요약 리포트', hash: '#/summary' },
    { id: 'insights', name: '인사이트', hash: '#/insights' },
  ] },
  { id: 'compute', label: '컴퓨트', items: [
    { id: 'compute', name: 'vCenter · 호스트 · VM', page: true, count: 'hosts' },
    { id: 'clusters', name: '클러스터', hash: '#/tools/capacity' },
    { id: 'gpu', name: 'GPU', hash: '#/tools/gpu', count: 'gpu' },
    { id: 'capacity', name: '용량 · 라이트사이징', hash: '#/tools/waste' },
  ] },
  { id: 'storage', label: '스토리지', items: [
    { id: 'storage', name: '데이터스토어 · 어레이', page: true, count: 'datastores' },
    { id: 'san', name: 'SAN 스위치', hash: '#/tools/san-switch', admin: true },
    { id: 'disktrend', name: '용량 추세', hash: '#/tools/storage-track' },
  ] },
  { id: 'network', label: '네트워크', items: [
    { id: 'network', name: '스위치 · NSX · 트래픽', page: true, count: 'networks' },
    { id: 'ipam', name: 'IP 관리', hash: '#/ipam' },
    { id: 'relay', name: '릴레이 토폴로지', hash: '#/tools/relaytopo', admin: true },
  ] },
  { id: 'facility', label: '물리 · 설비', items: [
    { id: 'facility', name: 'BMC · 전력 · 온도', page: true, count: 'powerReporting' },
    { id: 'hardware', name: '하드웨어 · 펌웨어', hash: '#/tools/hardware' },
    { id: 'powermap', name: '전력 맵', hash: '#/tools/powermap' },
  ] },
  { id: 'monitoring', label: '모니터링', items: [
    { id: 'alarms', name: '알람 센터', page: true, count: 'alarms' },
    { id: 'svcmon', name: '성능 점검', hash: '#/svcmon' },
    { id: 'anomaly', name: '이상 탐지', hash: '#/settings/anomaly', admin: true },
  ] },
  { id: 'ops', label: '운영', items: [
    { id: 'remote', name: '원격 명령', hash: '#/tools/rma', admin: true },
    { id: 'deploy', name: '배포 · 에이전트', hash: '#/settings/agent-deploy', admin: true },
    { id: 'collectors', name: '컬렉터', hash: '#/settings/collectors', admin: true },
  ] },
  { id: 'admin', label: '관리', items: [
    { id: 'settings', name: '설정 · 권한', hash: '#/settings', admin: true },
    { id: 'audit', name: '감사 로그', hash: '#/settings/audit', admin: true },
    { id: 'upgrade', name: '업그레이드', hash: '#/settings/upgrade', admin: true, count: 'version' },
  ] },
];

/** 그룹 점 색 — 그룹이 대표하는 도메인 타일 인덱스(pages/Overview 타일 순서: 컴퓨트·스토리지·네트워크·설비·BMC·서비스 점검). */
export const GROUP_TILE = { overview: [0, 1, 2, 3, 4, 5], compute: [0], storage: [1], network: [2], facility: [3, 4], monitoring: [5] };

/** 역할로 항목을 거른다(admin 전용은 관리자에게만). 항목이 하나도 없는 그룹은 숨긴다. */
export function visibleGroups(user) {
  const admin = user?.role === 'admin';
  return NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((it) => admin || !it.admin) })).filter((g) => g.items.length);
}
