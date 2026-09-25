/**
 * version_5/tree.js — V5 좌측 메뉴 배치(순수, v2.616).
 *
 * 사용자 요청(2026-09-26): "좌측의 메뉴들에 맞게 특수기능을 기능들을 좌측에 맞게 넣어줘" + 시안 승인
 * (자산 그룹은 소제목으로 나눈다). 배치 규칙 — v2.508 V4 트리와 같은 약속이다:
 *   · 특수 기능 카탈로그(views/specialToolsList.js) **전부가 정확히 1회** 배치된다(미분류 0 · 중복 0 · 유령 0).
 *     새 도구를 추가하고 여기 넣지 않으면 V5 내비에서 **영원히 못 찾는다** — tree.test.js 가 막는다.
 *   · **상태를 바꾸는 도구는 '자동화'** 에만 둔다 — 조회 그룹을 훑다가 실행 버튼을 만나지 않게.
 *   · 도구 키(k)는 절대 바꾸지 않는다(permissions.json toolsDenied 값 · 딥링크 · 서버 집행 매핑).
 *
 * ⚠ 숨김·잠금 판정은 **여기서 하지 않는다** — views/toolVisibility.js(toolHidden·lockReasonOf)를 그대로 쓴다.
 *   탭 노출은 App 이 이미 계산한 visibleTabs 의 id 를 받는다(권한 규칙을 두 벌 만들지 않는다).
 * ⚠ 그룹 개수는 **실제로 보이는 항목 수**다 — 시안 캡처의 숫자는 예시였다.
 */
import { toolHidden, lockReasonOf } from '../views/toolVisibility.js';

const tab = (id, name) => ({ kind: 'tab', id, name });
const tool = (k) => ({ kind: 'tool', k });
const sub = (label) => ({ kind: 'sub', label });

/** 개발 포탈 탭 이름(App.jsx TABS 와 같은 id). */
export const TAB_NAMES = Object.freeze({
  overview: 'Overview', summary: 'Summary', vcenters: 'Platform', svcmon: 'Monitoring',
  hosts: 'VM호스트', vms: '가상머신', datastores: '스토리지', networks: '네트워크', ipam: 'IP관리',
  alarms: '알람', tools: '특수 기능 전체', settings: '설정', upgrade: '업그레이드',
});

export const HOME = Object.freeze([tab('overview', 'Overview'), tab('summary', 'Summary')]);

export const GROUPS = Object.freeze([
  {
    id: 'ops', section: 'OPERATIONS', label: '운영 관제', icon: 'pulse',
    items: [tab('alarms', '알람'), tab('svcmon', 'Monitoring'), tool('insights'), tool('insights-hub'), tool('part-faults'),
      tool('esxitemp'), tool('curuser'), tool('daily-health'), tool('alert-channels'), tool('svcmon-config'), tool('roomtemp')],
  },
  {
    id: 'assets', section: 'OPERATIONS', label: '자산', icon: 'server',
    items: [
      sub('인벤토리'), tab('vcenters', 'Platform'), tab('hosts', 'VM호스트'), tab('vms', '가상머신'), tab('datastores', '스토리지'),
      tool('vm-export'), tool('fleet'), tool('serveranalysis'),
      sub('장비'), tool('storage-mon'), tool('san-switch'), tool('pdu'), tool('hardware'), tool('hba'), tool('gpu'),
      tool('nic-speed'), tool('nic-models'),
      sub('검색'), tool('aisearch'), tool('explore'), tool('vmfinder'), tool('deepsearch'), tool('serial-lookup'),
      sub('버전 · 구성'), tool('guestos'), tool('real-os'), tool('solutions'), tool('esxi'), tool('vcversion'),
    ],
  },
  {
    id: 'capacity', section: 'OPERATIONS', label: '용량 · 최적화', icon: 'gauge',
    items: [tool('storage-growth'), tool('bm-usage'), tool('bm-storage'), tool('vm-track'), tool('storage-track'), tool('capacity'),
      tool('waste'), tool('forecast'), tool('dsusage'), tool('thinvms'), tool('orphanvmdk'), tool('guest-disk'), tool('zombie-vms'),
      tool('rightsizing'), tool('capacity-forecast'), tool('powermap'), tool('dir-usage')],
  },
  {
    id: 'network', section: 'OPERATIONS', label: '네트워크', icon: 'net',
    items: [tab('networks', '네트워크'), tool('ipam'), tool('nsx'), tool('dupip'), tool('net-check'), tool('net-traffic'),
      tool('net-issues'), tool('relaytopo'), tool('relaycheck'), tool('link-check'), tool('comm-map'), tool('data-flow'),
      tool('device-flow'), tool('cvp'), tool('topo3d')],
  },
  {
    id: 'protect', section: 'OPERATIONS', label: '보호 · 규정', icon: 'shield',
    items: [tool('vmtools'), tool('snapshots'), tool('snapshot-age'), tool('cert-expiry'), tool('compliance-report'),
      tool('change-history'), tool('unprotected-vms'), tool('licenses'), tool('license-expiry'), tool('vmware-backup')],
  },
  {
    id: 'auto', section: 'OPERATIONS', label: '자동화', icon: 'bolt',
    items: [tool('rma'), tool('vmprovision'), tool('vm-clone'), tool('agent-scans'), tool('shutdown'), tool('diskadd'),
      tool('backup'), tool('massdeploy')],
  },
  {
    id: 'security', section: 'ADMINISTRATION', label: '보안', icon: 'lock',
    items: [tool('threats'), tool('secret-scan'), tool('codex-check'), tool('credentials'), tool('login-fails')],
  },
  {
    id: 'platform', section: 'ADMINISTRATION', label: '플랫폼 관리', icon: 'gear',
    items: [tab('settings', '설정'), tab('upgrade', '업그레이드'), tab('tools', '특수 기능 전체'), tool('service-hub'),
      tool('portal-check'), tool('edge-log'), tool('davinci-svc'), tool('capacity-advisor'), tool('portaldb'), tool('mail-diag')],
  },
]);

/** 상태를 바꾸는 도구 — '자동화' 가 주소속이어야 한다(테스트 고정). */
export const MUTATING_TOOLS = Object.freeze(['rma', 'vmprovision', 'vm-clone', 'agent-scans', 'shutdown', 'diskadd', 'backup', 'massdeploy']);

export const treeToolKeys = () => GROUPS.flatMap((g) => g.items.filter((i) => i.kind === 'tool').map((i) => i.k));
export const treeTabIds = () => [...HOME, ...GROUPS.flatMap((g) => g.items)].filter((i) => i.kind === 'tab').map((i) => i.id);
export const groupOfTool = (k) => GROUPS.find((g) => g.items.some((i) => i.kind === 'tool' && i.k === k)) || null;
export const groupOfTab = (id) => GROUPS.find((g) => g.items.some((i) => i.kind === 'tab' && i.id === id)) || null;

/**
 * 현재 주소 → 활성 항목 키('tab:vms' · 'tool:storage-mon'). 도구 안 서브탭(#/tools/k/sub)도 그 도구다.
 * `#/tools` 만 있으면 특수 기능 전체(tab:tools).
 */
export function activeKeyOf(hash) {
  const segs = String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
  if (!segs.length) return 'tab:overview';
  if (segs[0] === 'tools') return segs[1] ? `tool:${segs[1]}` : 'tab:tools';
  return `tab:${segs[0]}`;
}

/**
 * 보이는 메뉴 트리를 만든다(순수 — 권한 판정은 인자로 받는다).
 * @param {object[]} tools  specialToolsList.js TOOLS
 * @param {object} o
 * @param {boolean} o.isAdmin
 * @param {string[]|null} o.toolsAllowed   허용 목록 모드면 배열
 * @param {string[]} o.visibleTabIds       App 이 계산한 visibleTabs 의 id
 * @param {(p:string)=>boolean} [o.can]
 * @param {(k:string)=>boolean} [o.toolAllowed]
 * @param {string} [o.serviceHubUrl]      외부 포탈 주소(없으면 그 항목은 보이지 않는다)
 * @returns {{home:object[], groups:object[]}}  각 그룹 {id,section,label,icon,count,items[]}
 *   item: {key, kind:'tab'|'tool'|'sub', name, icon?, hash?, href?, locked?, lockReason?, comingSoon?}
 */
export function resolveTree(tools, { isAdmin = false, toolsAllowed = null, visibleTabIds = [], can = null, toolAllowed = null, serviceHubUrl = '' } = {}) {
  const byK = new Map((tools || []).map((t) => [t.k, t]));
  const tabs = new Set(visibleTabIds || []);
  const tabItem = (i) => (tabs.has(i.id) ? { key: `tab:${i.id}`, kind: 'tab', id: i.id, name: i.name, hash: `#/${i.id}` } : null);
  const toolItem = (i) => {
    const t = byK.get(i.k);
    if (!t) return null;
    if (t.topTab) {
      // 상단 탭으로 승격된 도구(ipam) — 탭 노출 규칙(도구별 접근 포함)을 App 이 이미 계산했다.
      return tabs.has(t.k) ? { key: `tab:${t.k}`, kind: 'tab', id: t.k, name: TAB_NAMES[t.k] || t.label, icon: t.icon, hash: `#/${t.k}` } : null;
    }
    if (toolHidden(t, { isAdmin, toolsAllowed, hideAdminOnly: true })) return null;
    if (t.external) {
      const url = t.external === 'serviceHubUrl' ? serviceHubUrl : '';
      if (!url) return null; // 미설정 환경에 죽은 항목을 남기지 않는다(특수 기능 그리드와 같은 규칙)
      return { key: `tool:${t.k}`, kind: 'tool', k: t.k, name: t.label, icon: t.icon, href: url, external: true };
    }
    const lockReason = lockReasonOf(t, { isAdmin, toolsAllowed, can, toolAllowed });
    return {
      key: `tool:${t.k}`, kind: 'tool', k: t.k, name: t.label, icon: t.icon, hash: `#/tools/${t.k}`,
      locked: !!lockReason, lockReason: lockReason || null, comingSoon: !!t.comingSoon,
    };
  };
  const resolve = (i) => (i.kind === 'tab' ? tabItem(i) : i.kind === 'tool' ? toolItem(i) : { key: `sub:${i.label}`, kind: 'sub', name: i.label });
  const home = HOME.map(resolve).filter(Boolean);
  const groups = GROUPS.map((g) => {
    const raw = g.items.map(resolve).filter(Boolean);
    // 뒤따르는 항목이 전부 숨겨진 소제목은 버린다(빈 소제목을 그리지 않는다).
    const items = raw.filter((it, idx) => it.kind !== 'sub' || (raw[idx + 1] && raw[idx + 1].kind !== 'sub'));
    const count = items.filter((it) => it.kind !== 'sub').length;
    return { id: g.id, section: g.section, label: g.label, icon: g.icon, count, items };
  }).filter((g) => g.count > 0);
  return { home, groups };
}
