/**
 * version_4/nav.js — V4 화면 메타(v2.508, 순수). 내비 구조 자체는 tree.js(시안 ⑧ IA 11그룹)가 소유한다.
 *
 * v2.490 의 version_3/nav.js 에서 승격했다. 그때는 내비 8그룹·화면 6개를 이 파일이 다 들고 있었는데,
 * 도구 79개까지 트리에 편입하면서 **구조는 tree.js**, **화면 메타는 여기**로 나눴다.
 */
export { PAGE_IDS } from './tree.js';

export const PAGE_META = {
  overview: { crumb: '개요 · 전사', title: '전사 현황' }, // sub 는 V4App 이 실 수치로 만든다
  compare: {
    crumb: '용량 · 최적화', title: '법인 비교 · 용량',
    sub: '어느 법인이 먼저 한계에 닿는가 — 비교 매트릭스 · 클러스터 여력 · 소진 타임라인',
  },
  power: {
    crumb: '물리 · 설비', title: '전력 · 비용 · 탄소',
    sub: 'iDRAC 실측 전력을 경영 단위로 환산 — 단가 · PUE · CO₂ 계수는 설정값이다',
  },
  compute: {
    crumb: '컴퓨트', title: 'vCenter · 호스트 · 가상머신',
    sub: 'Platform + VM호스트 + 가상머신 탭 통합 · 리전/vCenter 범위 적용',
  },
  storage: {
    crumb: '스토리지', title: '데이터스토어 · 어레이 · SAN',
    sub: 'Datastores + StorageMon + SanSwitch · 고아 VMDK · 게스트 디스크 회수',
  },
  network: { crumb: '네트워크', title: '스위치 · NSX · 트래픽 · IPAM', sub: 'Networks + NSX + IPAM 통합' },
  facility: {
    crumb: '물리 · 설비', title: 'BMC · 전력 · 온도',
    sub: 'IdracAdmin + PduTool + RoomTemp · iDRAC 온도 추이 · 하드웨어 인벤토리',
  },
  alarms: { crumb: '모니터링', title: '알람 센터', sub: 'vSphere 알람 + svcmon 실패 · 도메인 교차 상관' },
  tools: {
    crumb: '관리', title: '기능 찾기',
    sub: '특수 기능 · 개발 포탈 탭 · V4 화면을 한 트리에서 — ⌘K 로 바로 찾기',
  },
};

/**
 * 그룹 점 색 — 그 그룹이 대표하는 도메인 타일 인덱스(Overview 타일 순서: 컴퓨트 · 스토리지 ·
 * 네트워크 · 설비 · BMC · 서비스 점검).
 *
 * 대응하는 수집 지표가 없는 그룹(용량 · 리포트 · 보안 · 운영 · 관리)은 **점을 찍지 않는다** —
 * 없는 판정을 색으로 지어내지 않는다. `monitoring` 만 알람 심각도를 추가로 본다(V4App).
 */
export const GROUP_TILE = {
  home: [0, 1, 2, 3, 4, 5], compute: [0], storage: [1], network: [2], facility: [3, 4], monitoring: [5],
};
