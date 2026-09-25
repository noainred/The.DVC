/**
 * version_4/tree.js — V4 좌측 내비 정보구조(v2.508, 순수). 시안 ⑧(InfoArch.dc.html)의 11그룹.
 *
 * 담는 것: V4 화면 9개 + 개발 포탈 탭 14개 + 특수 기능 도구 전부(specialToolsList.js — 개수는 적지 않는다, v2.613) = **미분류 0**.
 *   · 도구는 **주소속 1곳**에 정확히 1회 배치한다(`alias: true` 는 편의상 한 번 더 보여주는 것이라
 *     커버리지 계산에서 제외한다). 이 규칙을 깨면 '어디에 있더라' 가 다시 시작된다.
 *   · **상태를 바꾸는 도구**(rma · vm-clone · vmprovision · shutdown · diskadd · backup · massdeploy ·
 *     agent-scans)는 무조건 `운영 작업` 이 주소속이다 — 조회 그룹에서 실행 버튼을 만나지 않게.
 *   · 라벨·아이콘·권한(adminOnly)은 여기 **복사하지 않는다**. `specialToolsList.js` 하나가 소유하고
 *     화면이 조인한다 — 복사해 두면 도구 이름을 바꾼 날 트리만 낡는다(v2.507 이 겪은 유형).
 *
 * 노드 종류:
 *   { kind: 'page', id }                 → V4 내부 화면(#/v4/<id>)
 *   { kind: 'tab',  id, name, hash }     → 개발 포탈 탭으로 이동(셸 밖)
 *   { kind: 'tool', k, alias?: true }    → 개발 포탈 도구(#/tools/<k>)로 이동
 *
 * ⚠ `k` 문자열은 어떤 경우에도 바꾸지 않는다 — permissions.json 의 toolsDenied 값이자
 *   딥링크이자 server/src/auth/toolAccess.js 의 집행 매핑이다.
 */

const page = (id) => ({ kind: 'page', id });
const tab = (id, name, hash) => ({ kind: 'tab', id, name, hash });
const tool = (k, alias = false) => (alias ? { kind: 'tool', k, alias: true } : { kind: 'tool', k });

export const TREE = Object.freeze([
  {
    id: 'home', label: '홈', items: [
      page('overview'),
      tab('summary', '요약 리포트', '#/summary'),
      tab('vcenters', '법인 · 플랫폼', '#/vcenters'),
      tool('insights-hub'), tool('aisearch'), tool('deepsearch'), tool('explore'),
    ],
  },
  {
    id: 'compute', label: '컴퓨트', items: [
      page('compute'),
      tab('hosts', 'VM호스트 목록', '#/hosts'),
      tab('vms', '가상머신 목록', '#/vms'),
      tool('vmfinder'), tool('vm-track'), tool('vmtools'), tool('guestos'), tool('real-os'),
      tool('esxi'), tool('vcversion'), tool('solutions'), tool('vm-export'), tool('snapshots'),
      tool('curuser'),
      tool('topo3d'),
      tool('esxitemp', true), tool('gpu', true),
    ],
  },
  {
    id: 'storage', label: '스토리지', items: [
      page('storage'),
      tab('datastores', '데이터스토어 목록', '#/datastores'),
      tool('dsusage'), tool('storage-track'), tool('orphanvmdk'), tool('guest-disk'),
      tool('hba'), tool('storage-mon'), tool('storage-growth'), tool('bm-storage'), tool('san-switch'),
      tool('dir-usage'), tool('thinvms'), tool('portaldb'),
    ],
  },
  {
    id: 'network', label: '네트워크', items: [
      page('network'),
      tab('networks', '포트그룹 목록', '#/networks'),
      tool('ipam'), tool('nsx'), tool('dupip'), tool('net-check'), tool('net-traffic'),
      tool('net-issues'), tool('relaytopo'), tool('relaycheck'), tool('link-check'), tool('comm-map'), tool('data-flow'), tool('device-flow'),
      tool('cvp'),
      tool('nic-speed'), tool('nic-models'),
      tool('hba', true),
    ],
  },
  {
    id: 'facility', label: '물리 · 설비', items: [
      page('facility'),
      page('power'),
      tool('fleet'), tool('hardware'), tool('serveranalysis'), tool('gpu'), tool('esxitemp'),
      tool('roomtemp'), tool('powermap'), tool('pdu'), tool('serial-lookup'), tool('part-faults'),
      tool('bm-usage'),
      tool('nic-speed', true), tool('nic-models', true),
    ],
  },
  {
    id: 'capacity', label: '용량 · 최적화', items: [
      page('compare'),
      tool('capacity'), tool('waste'), tool('rightsizing'), tool('capacity-forecast'),
      tool('forecast'), tool('zombie-vms'), tool('capacity-advisor'), tool('insights'),
      tool('thinvms', true), tool('storage-track', true),
    ],
  },
  {
    id: 'monitoring', label: '모니터링 · 알람', items: [
      page('alarms'),
      tab('svcmon', '서비스 모니터', '#/svcmon'),
      tool('svcmon-config'), tool('alert-channels'), tool('davinci-svc'),
    ],
  },
  {
    id: 'report', label: '리포트', items: [
      tool('daily-health'), tool('compliance-report'), tool('change-history'),
      tool('unprotected-vms'), tool('snapshot-age'), tool('cert-expiry'),
      tool('licenses'), tool('license-expiry'), tool('vmware-backup'),
      tool('snapshots', true),
    ],
  },
  {
    id: 'security', label: '보안 · 계정', items: [
      tool('threats'), tool('secret-scan'), tool('codex-check'),
      tool('credentials'), tool('login-fails'),
    ],
  },
  {
    id: 'ops', label: '운영 작업', items: [
      tool('rma'), tool('vmprovision'), tool('vm-clone'), tool('agent-scans'),
      tool('diskadd'), tool('backup'), tool('massdeploy'), tool('shutdown'),
    ],
  },
  {
    id: 'admin', label: '관리', items: [
      page('tools'),
      tab('settings', '설정 · 권한', '#/settings'),
      tab('upgrade', '업그레이드', '#/upgrade'),
      tab('legacy-tools', '특수 기능 (레거시 그리드)', '#/tools'),
      tool('mail-diag'), tool('service-hub'), tool('edge-log'), tool('portal-check'),
      tool('portaldb', true),
    ],
  },
]);

/** V4 내부 화면 목록 — 트리에서 뽑는다(따로 적으면 어긋난다). */
export const PAGE_IDS = Object.freeze(
  [...new Set(TREE.flatMap((g) => g.items.filter((i) => i.kind === 'page').map((i) => i.id)))],
);

/** 주소속(별칭 제외) 도구 키 목록. 커버리지 검증과 '이 도구는 어느 그룹인가' 에 쓴다. */
export function primaryToolKeys() {
  return TREE.flatMap((g) => g.items.filter((i) => i.kind === 'tool' && !i.alias).map((i) => i.k));
}

/** 도구 키 → 주소속 그룹 라벨. 팔레트가 '어느 그룹의 기능인지' 를 보여줄 때 쓴다. */
export function groupLabelOfTool(k) {
  for (const g of TREE) {
    if (g.items.some((i) => i.kind === 'tool' && !i.alias && i.k === k)) return g.label;
  }
  return null;
}

/** 도구 키 → 그 도구가 보이는 모든 그룹 라벨(주소속 + 별칭). 검색이 분류명으로도 걸리게 한다. */
export function groupLabelsOfTool(k) {
  return TREE.filter((g) => g.items.some((i) => i.kind === 'tool' && i.k === k)).map((g) => g.label);
}

/**
 * 역할·권한으로 트리를 거른다. 도구의 잠금 판정은 views/toolVisibility.js lockReasonOf 가 소유하므로(v2.613) 여기서는
 * **보일지 말지**만 정한다 — 잠긴 도구는 숨기지 않고 회색으로 보여주는 것이 기존 정책이다
 * (SpecialTools: "숨김보다 회색 잠금"). 항목이 하나도 없는 그룹만 접는다.
 */
export function visibleTree(TOOLS, { isAdmin, pageAllowed, tabAllowed, toolShown } = {}) {
  const byKey = new Map((TOOLS || []).map((t) => [t.k, t]));
  return TREE.map((g) => ({
    ...g,
    items: g.items.filter((i) => {
      if (i.kind === 'page') return pageAllowed ? pageAllowed(i.id) : true;
      if (i.kind === 'tab') return tabAllowed ? tabAllowed(i.id) : true;
      const t = byKey.get(i.k);
      if (!t) return false;                       // 목록에 없는 키는 그리지 않는다(유령 항목 금지)
      /*
       * v2.555: 도구를 **숨길지**는 `views/toolVisibility.js toolHidden` 하나가 판정한다 —
       * 카드 그리드·이 트리·⌘K 팔레트가 같은 답을 써야 한다. 여기서 규칙을 다시 쓰면
       * "내비에는 없는데 팔레트로는 열린다" 가 된다. 호출부가 주지 않으면(테스트·구버전
       * 호출) 예전 규칙(관리자 전용만 숨김)을 그대로 쓴다.
       */
      if (toolShown) return toolShown(t);
      if (t.adminOnly && !isAdmin) return false;  // 관리자 전용은 비관리자에게 아예 보이지 않는다
      return true;
    }),
  })).filter((g) => g.items.length);
}
