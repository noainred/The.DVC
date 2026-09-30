/**
 * version_6/menus.js — V6 상위 메뉴 10개 배치(순수, v2.623).
 *
 * 사용자 제공 핸드오프(`design_handoff_portal_home` — Portal Home.dc.html 의 MENUS)를 그대로 옮겼다.
 * '특수 기능' 탭을 없애고 카탈로그 전부를 10개 상위 메뉴로 격상한다. 규칙(V4·V5 트리와 같은 약속):
 *   · 특수 기능 카탈로그(views/specialToolsList.js) **전부가 정확히 1회** 배치된다 — menus.test.js 가 고정한다.
 *     새 도구를 추가하고 여기 넣지 않으면 V6 메뉴에서 **영원히 못 찾는다**.
 *   · **상태를 바꾸는 도구는 '자동화'** 에만(조회 메뉴를 훑다가 실행 버튼을 만나지 않게).
 *   · 도구 키(k)는 절대 바꾸지 않는다(permissions.json toolsDenied · 딥링크 · 서버 집행 매핑).
 * ⚠ 숨김·잠금 판정은 여기서 하지 않는다 — views/toolVisibility.js(toolHidden·lockReasonOf)를 그대로 쓴다.
 *   탭 노출은 App 이 계산한 visibleTabs 의 id 를 받는다(권한 규칙을 두 벌 만들지 않는다).
 * ⚠ 개수는 **실제로 보이는 항목 수**다(시안의 숫자는 예시였다).
 */
import { toolHidden, lockReasonOf } from '../views/toolVisibility.js';

/** 기존 화면(App 탭). desc 는 시안 문구. */
export const TAB_INFO = Object.freeze({
  alarms: { icon: '🚨', label: '알람', desc: 'vCenter 알람 전체 · 심각도/리전/vCenter 필터' },
  svcmon: { icon: '📡', label: 'Monitoring', desc: '서비스 모니터 — 대상별 점검 트리 · 상태 칩 · Test name 검색' },
  hosts: { icon: '🖳', label: 'VM호스트 목록', desc: 'ESXi 호스트 전체 · 상태(정상/점검/연결끊김) 필터 · 상세' },
  vms: { icon: '🖥️', label: '가상머신 목록', desc: 'VM 전체 · 전원 필터 · 이름/IP/OS 검색 · 콘솔/메트릭' },
  networks: { icon: '🕸️', label: '포트그룹 목록', desc: 'Standard / Distributed 포트그룹 전체' },
  ipam: { icon: '📒', label: 'IP관리', desc: '센터별 IP 관리대장 · 대역/할당 현황 · 자체 vCenter 범위 선택' },
  datastores: { icon: '🗄️', label: '데이터스토어 목록', desc: 'VMFS / NFS / vSAN 데이터스토어 전체 · 용량·사용률' },
  vcenters: { icon: '🏢', label: 'Platform (vCenter)', desc: 'vCenter 연결 현황 · 법인별 드릴다운' },
  settings: { icon: '⚙️', label: '설정', desc: '사용자·권한 · 감사 로그 · 컬렉터 · 특수 기능 분류' },
  upgrade: { icon: '⬆️', label: '업그레이드', desc: '새 버전 적용 · 릴리즈 노트' },
});
export const TAB_IDS = Object.freeze(Object.keys(TAB_INFO));

export const SECTIONS = Object.freeze([
  { label: 'OPERATE', ids: ['ops', 'asset', 'opt'] },
  { label: 'INFRA', ids: ['server', 'net', 'storage'] },
  { label: 'GOVERN', ids: ['protect', 'auto', 'sec'] },
  { label: 'ADMIN', ids: ['platform'] },
]);

export const SEG_INFO = Object.freeze({
  phys: { label: '물리 서버', code: 'PHYSICAL', color: 'var(--accent-2)', note: 'iDRAC 수집 · 베어메탈 포함' },
  host: { label: '가상화 호스트', code: 'HYPERVISOR', color: 'var(--accent)', note: 'ESXi · vCenter 수집' },
  vm: { label: '가상화 서버', code: 'VIRTUAL', color: 'var(--green)', note: 'VM · 게스트 OS' },
});

export const MENUS = Object.freeze([
  { id: 'ops', code: 'OPERATIONS', label: '운영관제', desc: '지금 대응할 것 — 알람·서비스 감시·일일 점검·분석', groups: [
    { name: '알람 · 감시', items: ['alarms', 'svcmon', 'svcmon-config', 'alert-channels', 'part-faults'] },
    { name: '점검 · 리포트', items: ['daily-health', 'davinci-svc', 'change-history'] },
    { name: '분석 · 검색', items: ['insights-hub', 'insights', 'aisearch', 'deepsearch'] }] },
  { id: 'asset', code: 'ASSETS', label: '자산', desc: '장비·소프트웨어·라이선스 인벤토리 — 무엇을 얼마나 갖고 있나', groups: [
    { name: '인벤토리', items: ['explore', 'hardware', 'serial-lookup', 'vm-export', 'topo3d'] },
    { name: '라이선스', items: ['licenses', 'license-expiry'] },
    { name: '버전 · 솔루션', items: ['vcversion', 'solutions'] }] },
  { id: 'opt', code: 'OPTIMIZATION', label: '인프라 최적화', desc: '회수·적정화·예측 — 남는 자원을 찾고 부족해지기 전에 안다', groups: [
    { name: '회수', items: ['waste', 'zombie-vms', 'thinvms', 'orphanvmdk', 'guest-disk'] },
    { name: '적정화', items: ['rightsizing', 'capacity', 'capacity-advisor'] },
    { name: '예측', items: ['capacity-forecast', 'forecast'] }] },
  { id: 'server', code: 'SERVERS', label: '서버', desc: '물리 서버 · 가상화 호스트 · 가상화 서버(VM)를 나눠서 본다', groups: [
    { seg: 'phys', name: '물리 서버', items: ['fleet', 'serveranalysis', 'idrac-trend', 'bm-usage', 'corp-usage', 'power-total', 'gpu', 'esxitemp', 'roomtemp', 'pdu', 'powermap', 'nic-speed', 'nic-models'] },
    { seg: 'host', name: '가상화 호스트', items: ['hosts', 'esxi', 'hba'] },
    { seg: 'vm', name: '가상화 서버', items: ['vms', 'vmfinder', 'guestos', 'real-os', 'vmtools', 'curuser', 'vm-track'] }] },
  { id: 'net', code: 'NETWORK', label: '네트워크', desc: '포트그룹·IP·NSX·스위치 — 인벤토리와 경로 점검', groups: [
    { name: '인벤토리', items: ['networks', 'ipam', 'nsx', 'cvp', 'dupip'] },
    { name: '점검 · 분석', items: ['net-check', 'net-traffic', 'net-issues'] },
    { name: '중계 (HAProxy)', items: ['relaytopo', 'relaycheck'] }] },
  { id: 'storage', code: 'STORAGE', label: '스토리지', desc: '데이터스토어·스토리지 어레이·SAN — 용량과 증가 추이', groups: [
    { name: '인벤토리', items: ['datastores', 'dsusage', 'storage-mon', 'san-switch', 'bm-storage'] },
    { name: '추이 · 보고', items: ['storage-track', 'storage-growth', 'dir-usage'] }] },
  { id: 'protect', code: 'PROTECTION · COMPLIANCE', label: '보호/규정', desc: '백업 공백·스냅샷·인증서·버전 준수', groups: [
    { name: '백업 · 복제', items: ['unprotected-vms', 'vmware-backup'] },
    { name: '스냅샷', items: ['snapshots', 'snapshot-age'] },
    { name: '준수', items: ['cert-expiry', 'compliance-report'] }] },
  { id: 'auto', code: 'AUTOMATION', label: '자동화', desc: '상태를 바꾸는 작업만 모았다 — 조회 메뉴에서 실행 버튼을 만나지 않게', groups: [
    { name: '프로비저닝 · 복제', items: ['vmprovision', 'vm-clone', 'diskadd', 'massdeploy', 'backup'] },
    { name: '원격 작업', items: ['rma', 'agent-scans'] },
    { name: '비상', items: ['shutdown'] }] },
  { id: 'sec', code: 'SECURITY', label: '보안', desc: '위협·자격증명·접근 기록', groups: [
    { name: '위협 · 접근', items: ['threats', 'login-fails'] },
    { name: '점검', items: ['secret-scan', 'codex-check'] },
    { name: '계정', items: ['credentials'] }] },
  { id: 'platform', code: 'PLATFORM', label: '플랫폼 관리', desc: 'vCenter 연결·포탈 설정·엣지 통신', groups: [
    { name: 'vCenter · 포탈', items: ['vcenters', 'settings', 'upgrade', 'portaldb', 'mail-diag'] },
    { name: '엣지 통신', items: ['link-check', 'comm-map', 'data-flow', 'device-flow', 'portal-check', 'edge-log'] },
    { name: '바로가기', items: ['service-hub'] }] },
]);

/** 상태를 바꾸는 도구 — '자동화' 가 주소속이어야 한다(테스트 고정 · V5 tree.js 와 같은 목록). */
export const MUTATING_TOOLS = Object.freeze(['rma', 'vmprovision', 'vm-clone', 'agent-scans', 'shutdown', 'diskadd', 'backup', 'massdeploy']);
/** 위험 표지(시안 flag 'd') — 비상 정지만. */
export const DANGER_TOOLS = Object.freeze(['shutdown']);

export const menuById = (id) => MENUS.find((m) => m.id === id) || null;
export const allMenuKeys = () => MENUS.flatMap((m) => m.groups.flatMap((g) => g.items));
/** 도구 키·탭 id → 그 항목이 속한 메뉴 id(없으면 null). */
export const menuOfKey = (k) => MENUS.find((m) => m.groups.some((g) => g.items.includes(k)))?.id || null;

/**
 * 현재 주소 → 사이드바에서 활성으로 칠할 페이지 id.
 * `#/m/<id>` → id · `#/overview`·`#/summary` → 그대로 · 탭·도구 → 그 항목이 속한 메뉴 · `#/tools` → null.
 */
export function activePageOf(hash, menuParse) {
  if (menuParse) return menuParse.menuId;
  const s = String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
  if (!s.length) return 'overview';
  if (s[0] === 'overview' || s[0] === 'summary') return s[0];
  if (s[0] === 'tools') return s[1] ? menuOfKey(s[1]) : null;
  return menuOfKey(s[0]);
}

/**
 * 메뉴 한 개를 화면용으로 푼다(순수 — 권한 판정은 인자로 받는다).
 * @returns {{id,code,label,desc, screens:number, tools:number, count:number, groups:{name,seg,items:object[]}[]}}
 *   item: {key, k, kind:'tab'|'tool', label, icon, desc, hash?, href?, badge?, locked, lockReason, comingSoon, danger}
 */
export function resolveMenu(menu, tools, { isAdmin = false, toolsAllowed = null, visibleTabIds = [], can = null, toolAllowed = null, serviceHubUrl = '' } = {}) {
  if (!menu) return null;
  const byK = new Map((tools || []).map((t) => [t.k, t]));
  const tabs = new Set(visibleTabIds || []);
  const itemOf = (k) => {
    const t = byK.get(k);
    if (TAB_INFO[k] && (!t || t.topTab)) {
      // 기존 화면(탭) — App 의 탭 노출 규칙(역할·기능 권한·도구별 접근)이 이미 계산돼 있다.
      if (!tabs.has(k)) return null;
      const info = TAB_INFO[k];
      return { key: `tab:${k}`, k, kind: 'tab', label: info.label, icon: t?.icon || info.icon, desc: info.desc, hash: `#/${k}`, badge: 'screen', locked: false, lockReason: null, comingSoon: false, danger: false };
    }
    if (!t) return null;
    if (toolHidden(t, { isAdmin, toolsAllowed, hideAdminOnly: false })) return null;
    const base = { key: `tool:${k}`, k, kind: 'tool', label: t.label, icon: t.icon, desc: t.desc || '', comingSoon: !!t.comingSoon, danger: DANGER_TOOLS.includes(k) };
    if (t.external) {
      const url = t.external === 'serviceHubUrl' ? serviceHubUrl : '';
      if (!url) return null; // 미설정 환경에 죽은 항목을 남기지 않는다(특수 기능 그리드·V5 와 같은 규칙)
      return { ...base, href: url, badge: 'external', locked: false, lockReason: null };
    }
    const lockReason = lockReasonOf(t, { isAdmin, toolsAllowed, can, toolAllowed });
    const badge = base.danger ? 'danger' : t.comingSoon ? 'soon' : t.adminOnly ? 'admin' : null;
    return { ...base, hash: `#/tools/${k}`, badge, locked: !!lockReason, lockReason: lockReason || null };
  };
  const groups = menu.groups.map((g) => ({ name: g.name, seg: g.seg || '', items: g.items.map(itemOf).filter(Boolean) }))
    .filter((g) => g.items.length > 0);
  const all = groups.flatMap((g) => g.items);
  return {
    id: menu.id, code: menu.code, label: menu.label, desc: menu.desc, groups,
    screens: all.filter((i) => i.kind === 'tab').length, tools: all.filter((i) => i.kind === 'tool').length, count: all.length,
  };
}

/** 사이드바 — 섹션별 메뉴와 보이는 항목 수. 보이는 항목이 0 인 메뉴는 뺀다. */
export function resolveNav(tools, opts = {}) {
  return SECTIONS.map((s) => ({
    label: s.label,
    menus: s.ids.map((id) => resolveMenu(menuById(id), tools, opts)).filter((m) => m && m.count > 0),
  })).filter((s) => s.menus.length > 0);
}
