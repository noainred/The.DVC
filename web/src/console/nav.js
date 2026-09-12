/**
 * nav.js — DVC 콘솔 좌측 내비(8 도메인) 정의(v2.487, 순수).
 *
 * 디자인 핸드오프의 8개 그룹(개요·컴퓨트·스토리지·네트워크·물리/설비·모니터링·운영·관리)을 그대로 두되,
 * 콘솔 안에 실제 화면이 있는 항목(page)만 콘솔 페이지로 열고, 나머지는 **기존 개발 포탈의 해당 탭**으로
 * 이동한다(hash) — 화면이 없는 메뉴를 빈 페이지로 두지 않기 위함. admin 항목은 관리자에게만 보인다.
 * count 는 DvcConsole 이 실 API 값(호스트 수 등)으로 채운다.
 */
export const PAGE_IDS = ['overview', 'compute', 'storage', 'network', 'facility', 'alarms'];

export const PAGE_META = {
  overview: { group: '개요', title: '전사 현황', crumb: 'OVERVIEW' },
  compute: { group: '컴퓨트', title: 'vCenter · 호스트 · VM', crumb: 'COMPUTE' },
  storage: { group: '스토리지', title: '데이터스토어 · 어레이 · SAN', crumb: 'STORAGE' },
  network: { group: '네트워크', title: '포트그룹 · NSX · IPAM', crumb: 'NETWORK' },
  facility: { group: '물리 · 설비', title: 'BMC · 전력 · 온도', crumb: 'FACILITY' },
  alarms: { group: '모니터링', title: '알람 센터', crumb: 'MONITORING' },
};

export const NAV_GROUPS = [
  { id: 'overview', label: '개요', items: [
    { id: 'overview', name: '전사 현황', page: true },
    { id: 'summary', name: '요약 리포트', hash: '#/summary' },
    { id: 'insights', name: '인사이트', hash: '#/insights' },
  ] },
  { id: 'compute', label: '컴퓨트', items: [
    { id: 'compute', name: 'vCenter · 호스트 · VM', page: true, count: 'hosts' },
    { id: 'hosts', name: 'VM호스트 목록', hash: '#/hosts' },
    { id: 'vms', name: '가상머신 목록', hash: '#/vms' },
    { id: 'gpu', name: 'GPU', hash: '#/tools/gpu' },
    { id: 'capacity', name: '용량 리포트', hash: '#/tools/capacity' },
  ] },
  { id: 'storage', label: '스토리지', items: [
    { id: 'storage', name: '데이터스토어 · 어레이', page: true, count: 'datastores' },
    { id: 'san', name: 'SAN 스위치', hash: '#/tools/san-switch', admin: true },
    { id: 'disktrend', name: '용량 추세', hash: '#/tools/storage-track' },
  ] },
  { id: 'network', label: '네트워크', items: [
    { id: 'network', name: '포트그룹 · NSX', page: true, count: 'networks' },
    { id: 'ipam', name: 'IP 관리', hash: '#/ipam' },
    { id: 'relay', name: '중계 토폴로지', hash: '#/tools/relaytopo', admin: true },
  ] },
  { id: 'facility', label: '물리 · 설비', items: [
    { id: 'facility', name: 'BMC · 전력 · 온도', page: true, count: 'powerReporting' },
    { id: 'hardware', name: '하드웨어 · 펌웨어', hash: '#/tools/hardware' },
    { id: 'powermap', name: '전력 맵', hash: '#/tools/powermap' },
  ] },
  { id: 'monitoring', label: '모니터링', items: [
    { id: 'alarms', name: '알람 센터', page: true, count: 'alarms' },
    { id: 'svcmon', name: '성능 점검', hash: '#/svcmon' },
    { id: 'threats', name: '위협 탐지', hash: '#/tools/threats' },
  ] },
  { id: 'ops', label: '운영', items: [
    { id: 'remote', name: '원격 명령', hash: '#/tools/rma', admin: true },
    { id: 'deploy', name: '대량 배포', hash: '#/tools/massdeploy', admin: true },
    { id: 'collectors', name: '컬렉터', hash: '#/settings/collectors', admin: true },
  ] },
  { id: 'admin', label: '관리', items: [
    { id: 'settings', name: '설정 · 권한', hash: '#/settings', admin: true },
    { id: 'audit', name: '감사 로그', hash: '#/settings/audit', admin: true },
    { id: 'upgrade', name: '업그레이드', hash: '#/upgrade', admin: true },
  ] },
];

/** 그룹 점 색을 정할 때 쓰는 '그룹 → 도메인 타일 인덱스' 매핑(buildDomainTiles 순서). */
export const GROUP_TILE = { overview: [0, 1, 2, 3, 4, 5], compute: [0], storage: [1], network: [2], facility: [3, 4], monitoring: [5] };

/** 사용자 역할로 항목을 거른다(admin 전용은 관리자에게만). */
export function visibleGroups(user) {
  const admin = user?.role === 'admin';
  return NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((it) => admin || !it.admin) })).filter((g) => g.items.length);
}
