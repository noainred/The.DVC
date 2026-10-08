/**
 * views/topMenu.js — 개발 포탈 상단 메뉴(대메뉴 10개 + 하위 메뉴 줄)의 단일 소스(v2.725, 사용자 요청 메뉴 재구성 · 시안 A '2단 탭').
 *
 * 화면은 새로 만들지 않는다 — 하위 메뉴는 **지금 있는 탭(#/<tab>) 또는 특수 기능 도구(#/tools/<k>)** 를 가리킬 뿐이다.
 * 그래서 옛 주소(#/hosts · #/vms · #/vcenters …)는 그대로 열리고, 특수 기능 카드도 그대로 남는다.
 *
 * 규칙(회귀 방지):
 *  · 탭 id·도구 키를 바꾸지 말 것 — 탭 id 는 V5·V6 틀과 해시 라우팅이, 도구 키는 permissions.json(toolsDenied)과
 *    auth/toolAccess.js 가 쓴다. 여기서는 **이름(label)과 묶음**만 정한다.
 *  · App 의 TABS 에 있는 탭은 전부 어느 메뉴엔가 들어 있어야 한다(빠지면 그 화면은 메뉴로 갈 길이 없다 — 테스트가 고정).
 *  · 지금 주소가 어느 메뉴인지는 locate() 하나가 판정한다. 특수 기능 카드로 같은 도구를 열어도 그 도구가 속한
 *    메뉴가 켜진다(같은 화면은 같은 자리 — 위치가 두 개가 되지 않게).
 *  · 권한 판정을 여기서 다시 쓰지 않는다 — 탭은 App 의 isAllowed, 도구는 toolVisibility.lockReasonOf 를 **인자로** 받는다
 *    (순수 모듈 — 웹 테스트는 node 환경이다).
 */

/** 물리 서버 = 서버 분석 › 구분 Baremetal(미가상화 물리) · 전체 법인. 주소의 셋째 조각이 이 값이면 그 모드다. */
export const BAREMETAL_SEG = 'baremetal';

export const MENU_GROUPS = Object.freeze([
  { id: 'overview', label: 'Overview', tab: 'overview' },
  { id: 'summary', label: 'Summary', tab: 'summary' },
  { id: 'server', label: '서버', children: [
    { id: 'vm', label: '가상화 서버', tab: 'vms' },
    { id: 'esxi', label: 'ESXi 호스트', tab: 'hosts' },
    { id: 'vc', label: 'vCenter', tab: 'vcenters' },
    { id: 'bm', label: '물리 서버', tool: 'serveranalysis', seg: BAREMETAL_SEG },
    { id: 'alarm', label: '알람', tab: 'alarms' },
  ] },
  { id: 'storage', label: '스토리지', children: [
    { id: 'mon', label: '스토리지 현황', tool: 'storage-mon' },
    { id: 'ds', label: '데이터스토어', tab: 'datastores' },
    { id: 'growth', label: '스토리지 증가량 보고서', tool: 'storage-growth' },
    { id: 'track', label: '스토리지 사용량 추이', tool: 'storage-track' },
    { id: 'bmstor', label: '베어메탈 스토리지', tool: 'bm-storage' },
    { id: 'san', label: 'SAN 스토리지 성능 측정', tool: 'san-switch' },
  ] },
  { id: 'network', label: '네트워크', children: [
    { id: 'cvp', label: '전체 네트워크 장비', tool: 'cvp' },
    { id: 'pg', label: '가상화 네트워크', tab: 'networks' },
    { id: 'comm', label: '통신 지도', tool: 'comm-map' },
    { id: 'netcheck', label: '글로벌 네트워크 점검', tool: 'net-check' },
    { id: 'ipam', label: 'IP관리', tab: 'ipam' },
    { id: 'svcmon', label: 'Monitoring', tab: 'svcmon' },
  ] },
  { id: 'resource', label: '자원관리', children: [
    { id: 'sa', label: '서버 분석', tool: 'serveranalysis' },
    { id: 'gpu', label: 'GPU 인벤토리', tool: 'gpu' },
    { id: 'power', label: '전력 분석', tool: 'powermap' },
  ] },
  { id: 'optimize', label: '자원 최적화', children: [
    { id: 'waste', label: 'Optimization', tool: 'waste' },
    { id: 'idrac', label: 'iDRAC 통합 추이', tool: 'idrac-trend' },
  ] },
  { id: 'tools', label: '특수 기능', tab: 'tools' },
  { id: 'board', label: '게시판', tab: 'board' },
  { id: 'settings', label: '설정', children: [
    { id: 'settings', label: '설정', tab: 'settings' },
    { id: 'upgrade', label: '업그레이드', tab: 'upgrade' },
  ] },
]);

const segsOf = (hash) => String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);

/** 하위 메뉴(또는 하위 메뉴 없는 대메뉴)가 여는 주소. */
export function hashOf(item) {
  if (!item) return '#/overview';
  if (item.tool) return `#/tools/${item.tool}${item.seg ? `/${item.seg}` : ''}`;
  return `#/${item.tab}`;
}

/**
 * 지금 화면(활성 탭 + 주소)이 어느 대메뉴·하위 메뉴인가. 모르면 { group: null, child: null }.
 * 도구는 주소 둘째 조각(#/tools/<k>)으로, 물리 서버는 셋째 조각(baremetal)으로 가른다.
 * 메뉴에 없는 도구(특수 기능 카드에만 있는 것)는 '특수 기능' 이다.
 */
export function locate(tab, hash, groups = MENU_GROUPS) {
  const segs = segsOf(hash);
  const toolKey = tab === 'tools' && segs[0] === 'tools' ? (segs[1] || '') : '';
  // v2.727(감사 A-06): 도구는 메뉴의 자기 자리(그룹·조각)가 먼저다 — 사용자 메뉴에서 '특수 기능' 이 하위 항목({tab:'tools'})으로
  //   들어가면 예전 순서(탭 검사 먼저)는 **모든** 도구 화면을 그 항목으로 가리켰다. 메뉴에 없는 도구만 '특수 기능' 항목(단독 그룹이든
  //   하위 항목이든 — id 를 박지 않는다)으로 떨어진다.
  if (toolKey) {
    const hit = groupOfTool(toolKey, segs[2], groups);
    if (hit) return hit;
  }
  for (const g of groups) {
    if (!g.children) {
      if (g.tab === tab) return { group: g.id, child: null };
      continue;
    }
    for (const c of g.children) {
      if (c.tab && c.tab === tab) return { group: g.id, child: c.id };
    }
  }
  return { group: null, child: null };
}

/** 도구 키(+셋째 조각) → { group, child } · 메뉴에 없으면 null. seg 가 맞는 항목을 먼저 본다(물리 서버 ↔ 서버 분석). */
function groupOfTool(k, seg3, groups) {
  let plain = null;
  for (const g of groups) {
    for (const c of g.children || []) {
      if (c.tool !== k) continue;
      if (c.seg) { if (seg3 === c.seg) return { group: g.id, child: c.id }; }
      else if (!plain) plain = { group: g.id, child: c.id };
    }
  }
  return plain;
}

/**
 * 이 사용자에게 보이는 메뉴. 하위 메뉴가 모두 가려진 대메뉴는 뺀다(빈 줄을 보이지 않는다).
 * @param {(tab:string)=>boolean} tabOk  App 의 isAllowed
 * @param {(k:string)=>boolean} toolOk  도구 잠금이 없는가(toolVisibility.lockReasonOf 가 null)
 */
export function visibleMenu({ tabOk = () => true, toolOk = () => true } = {}, groups = MENU_GROUPS) {
  const ok = (it) => (it.tool ? toolOk(it.tool) : tabOk(it.tab));
  const out = [];
  for (const g of groups) {
    if (!g.children) { if (g.tab === 'tools' || ok(g)) out.push(g); continue; }
    const children = g.children.filter(ok);
    if (children.length) out.push({ ...g, children });
  }
  return out;
}

/**
 * 대메뉴를 눌렀을 때 갈 곳 — 그 대메뉴에서 마지막으로 본 하위 메뉴(보이는 것 중), 없으면 첫 하위 메뉴.
 * @param {object} g  visibleMenu() 의 항목
 * @param {Record<string,string>} last  { [groupId]: childId }
 */
export function entryOf(g, last = {}) {
  if (!g) return null;
  if (!g.children) return g;
  return g.children.find((c) => c.id === last[g.id]) || g.children[0] || null;
}
