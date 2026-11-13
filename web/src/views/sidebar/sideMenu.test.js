// sideMenu.test.js — 좌측 사이드바 메뉴 해석(v2.726)의 계약.
import { describe, it, expect } from 'vitest';
import { MENU_GROUPS, locate, visibleMenu, hashOf } from '../topMenu.js';
import { TOOLS } from '../specialToolsList.js';
import { resolveMenu, defaultMenu, missingDefaults, itemKey, toolEligible, retryDelayMs, MENU_RETRY_MS, nextOpenGroup, itemAliases } from './sideMenu.js';

describe('resolveMenu — 내 메뉴 > 배포 메뉴 > 포탈 기본', () => {
  it('저장된 메뉴가 없으면 포탈 기본 메뉴 그대로다', () => {
    const r = resolveMenu({ mine: null, distributed: null, catalog: TOOLS });
    expect(r.source).toBe('default');
    expect(r.groups).toBe(MENU_GROUPS);
    expect(r.unknown).toBe(0);
  });
  it('기본 메뉴를 저장 모양으로 되돌리면 같은 그룹·같은 항목이 나온다(라벨은 기본 메뉴에서)', () => {
    const r = resolveMenu({ mine: defaultMenu(), catalog: TOOLS });
    expect(r.source).toBe('mine');
    expect(r.groups.map((g) => g.id)).toEqual(MENU_GROUPS.map((g) => g.id));
    expect(r.groups.map((g) => g.label)).toEqual(MENU_GROUPS.map((g) => g.label));
    const server = r.groups.find((g) => g.id === 'server');
    expect(server.children.map((c) => c.id)).toEqual(['virt', 'hv', 'bm', 'veeam', 'alarm']);   // v2.787 서버 › Veeam · v2.915 가상화 플랫폼(세 탭 한 항목) · v2.994 Hypervisor(hv) 분리
    expect(server.children.find((c) => c.id === 'bm')).toMatchObject({ tool: 'serveranalysis', seg: 'baremetal', adminOnly: true });
    expect(server.custom).toBe(false);
  });
  it('배포 메뉴는 내 메뉴가 없을 때만 쓴다', () => {
    const dist = { v: 1, groups: [{ id: 'overview', tab: 'overview' }, { id: 'net', label: '망', children: [{ tab: 'networks' }] }] };
    expect(resolveMenu({ mine: null, distributed: dist, catalog: TOOLS }).source).toBe('distributed');
    expect(resolveMenu({ mine: null, distributed: dist, catalog: TOOLS }).groups.map((g) => g.label)).toEqual(['Overview', '망']);
    expect(resolveMenu({ mine: defaultMenu(), distributed: dist, catalog: TOOLS }).source).toBe('mine');
  });
  it('특수 기능에서 더한 도구는 카탈로그 라벨(덮어쓰기 우선)이고 fromTools·adminOnly 를 단다 · 모르는 키는 버리고 센다', () => {
    const mine = { v: 1, groups: [
      { id: 'custom-1', children: [{ tool: 'esxitemp' }, { tool: 'portal-check' }, { tool: 'no-such-tool' }, { tab: 'no-such-tab' }, { tool: 'service-hub' }] },
      { id: 'gone', tab: 'nope' },
      { id: 'tools', tab: 'tools' },
    ] };
    const r = resolveMenu({ mine, catalog: TOOLS, overrides: { esxitemp: { label: '온도 보드' } } });
    expect(r.unknown).toBe(4); // no-such-tool · no-such-tab · 외부 포탈(service-hub) · 없는 탭 그룹
    const g = r.groups[0];
    expect(g.label).toBe('내 그룹');
    expect(g.custom).toBe(true);
    expect(g.children.map((c) => c.label)).toEqual(['온도 보드', '포탈 점검']);
    expect(g.children[0]).toMatchObject({ id: 't-esxitemp', tool: 'esxitemp', fromTools: true });
    expect(g.children[1].adminOnly).toBe(true);
    expect(r.groups.map((x) => x.id)).toEqual(['custom-1', 'tools']);
  });
  it('같은 항목이 두 그룹에 있으면 앞의 것만 남고, 빈 그룹은 사라진다 · 단독 항목은 하위로도 들어간다', () => {
    const mine = { v: 1, groups: [
      { id: 'a', label: 'A', children: [{ tab: 'vms' }, { tab: 'board' }] },
      { id: 'b', label: 'B', children: [{ tab: 'vms' }] },
      { id: 'board', tab: 'board' },
    ] };
    const r = resolveMenu({ mine, catalog: TOOLS });
    expect(r.groups.map((g) => g.id)).toEqual(['a']);
    expect(r.groups[0].children.map((c) => c.id)).toEqual(['virt', 'board']);   // v2.994: tab:vms 는 Virtual Machine(VM) 항목의 정체 키
    expect(r.unknown).toBe(0);
  });
  it('해석된 메뉴로도 locate·visibleMenu·hashOf 가 그대로 동작한다(사용자 그룹에 넣은 도구는 그 그룹이 켜진다)', () => {
    const mine = { v: 1, groups: [{ id: 'overview', tab: 'overview' }, { id: 'custom-1', label: '내 그룹', children: [{ tool: 'esxitemp' }, { tab: 'hosts' }] }, { id: 'tools', tab: 'tools' }] };
    const { groups } = resolveMenu({ mine, catalog: TOOLS });
    expect(locate('tools', '#/tools/esxitemp', groups)).toEqual({ group: 'custom-1', child: 't-esxitemp' });
    // v2.994: tab:hosts 는 이제 별칭이 아니라 실제 항목 Hypervisor(hv) — 그 그룹에 hv 가 켜지고, VM 항목이 없는 메뉴에서 vCenter 탭은 어느 항목도 아니다
    expect(locate('hosts', '#/hosts', groups)).toEqual({ group: 'custom-1', child: 'hv' });
    expect(locate('vcenters', '#/vcenters', groups)).toEqual({ group: null, child: null });
    expect(locate('tools', '#/tools/pdu', groups)).toEqual({ group: 'tools', child: null });
    expect(hashOf(groups[1].children[0])).toBe('#/tools/esxitemp');
    const vis = visibleMenu({ tabOk: () => true, toolOk: (k) => k !== 'esxitemp' }, groups);
    expect(vis.find((g) => g.id === 'custom-1').children.map((c) => c.id)).toEqual(['hv']);
  });
});

describe('missingDefaults · toolEligible · itemKey', () => {
  it('지운 기본 항목과 새로 생긴 항목이 목록에 온다(그룹 이름과 함께)', () => {
    const mine = { v: 1, groups: [{ id: 'server', children: [{ tab: 'vms' }] }, { id: 'tools', tab: 'tools' }] };
    const { groups } = resolveMenu({ mine, catalog: TOOLS });
    const miss = missingDefaults(groups);
    // v2.994: tab:vms 는 Virtual Machine(VM) 항목 그 자체 — 별칭 tab:vcenters 는 후보가 아니고, 새 기본 항목 Hypervisor(tab:hosts)는 '다시 넣기' 후보다
    expect(miss.map((m) => m.key)).toContain('tab:hosts');
    expect(miss.find((m) => m.key === 'tab:hosts')).toMatchObject({ id: 'hv', label: 'Hypervisor', groupLabel: '서버' });
    expect(miss.map((m) => m.key)).not.toContain('tab:vcenters');
    expect(miss.map((m) => m.key)).toContain('tab:alarms');
    expect(miss.map((m) => m.key)).toContain('tool:serveranalysis/baremetal');
    expect(miss.map((m) => m.key)).toContain('tab:overview');
    expect(miss.map((m) => m.key)).not.toContain('tab:vms');
    expect(miss.find((m) => m.key === 'tab:alarms').groupLabel).toBe('서버');
    expect(missingDefaults(MENU_GROUPS)).toEqual([]);
  });
  it('외부 포탈·승격 탭·준비 중 도구는 메뉴에 넣을 수 없다', () => {
    expect(toolEligible(TOOLS.find((t) => t.k === 'service-hub'))).toBe(false);
    expect(toolEligible(TOOLS.find((t) => t.k === 'esxitemp'))).toBe(true);
    expect(toolEligible({ k: 'x', comingSoon: true })).toBe(false);
    expect(toolEligible({ k: 'x', topTab: true })).toBe(false);
  });
  it('itemKey 는 탭·도구+조각을 구분한다', () => {
    expect(itemKey({ tab: 'vms' })).toBe('tab:vms');
    expect(itemKey({ tool: 'serveranalysis' })).toBe('tool:serveranalysis');
    expect(itemKey({ tool: 'serveranalysis', seg: 'baremetal' })).toBe('tool:serveranalysis/baremetal');
    expect(itemKey({})).toBe('');
  });
});

describe('v2.994 저장 메뉴 별칭 — 이름 변경 · Hypervisor 분리 뒤에도 옛 저장 메뉴가 깨지지 않는다', () => {
  it('별칭은 tab:vcenters → tab:vms(Virtual Machine(VM)) 하나다 · tab:hosts 는 별칭이 아니다', () => {
    expect([...itemAliases()]).toEqual([['tab:vcenters', 'tab:vms']]);
  });
  it('v2.942~v2.993 저장 모양(서버 그룹에 tab:vcenters 하나) → Virtual Machine(VM) 하나 · 중복 · unknown 없음 · Hypervisor 는 다시 넣기 후보', () => {
    const mine = { v: 1, groups: [{ id: 'overview', tab: 'overview' }, { id: 'server', children: [{ tab: 'vcenters' }, { tool: 'bm-folders' }, { tool: 'serveranalysis', seg: 'baremetal' }] }, { id: 'tools', tab: 'tools' }] };
    const r = resolveMenu({ mine, catalog: TOOLS });
    expect(r.unknown).toBe(0);
    const server = r.groups.find((g) => g.id === 'server');
    expect(server.children.map((c) => [c.id, c.label])).toEqual([['virt', 'Virtual Machine(VM)'], ['t-bm-folders', 'Bare Metal Server'], ['bm', 'Physical Server · Baremetal']]);
    expect(locate('vcenters', '#/vcenters', r.groups)).toEqual({ group: 'server', child: 'virt' });
    expect(locate('vms', '#/vms', r.groups)).toEqual({ group: 'server', child: 'virt' });
    expect(locate('hosts', '#/hosts', r.groups)).toEqual({ group: null, child: null });   // 넣기 전에는 어느 항목도 켜지지 않는다(자동으로 넣지 않는다 — 결정 4)
    expect(missingDefaults(r.groups).map((m) => m.key)).toContain('tab:hosts');
    // 다시 넣으면 Hypervisor 가 그 자리에 생긴다
    const again = resolveMenu({ mine: { ...mine, groups: mine.groups.map((g) => (g.id === 'server' ? { ...g, children: [g.children[0], { tab: 'hosts' }, ...g.children.slice(1)] } : g)) }, catalog: TOOLS });
    expect(again.groups.find((g) => g.id === 'server').children.map((c) => c.id)).toEqual(['virt', 'hv', 't-bm-folders', 'bm']);
    expect(missingDefaults(again.groups).map((m) => m.key)).not.toContain('tab:hosts');
  });
  it('v2.914 이전 저장 모양(tab:vms · tab:hosts · tab:vcenters 셋) → Virtual Machine(VM) · Hypervisor 둘 · 중복 없음 · unknown 0', () => {
    const mine = { v: 1, groups: [{ id: 'server', children: [{ tab: 'vms' }, { tab: 'hosts' }, { tab: 'vcenters' }, { tab: 'alarms' }] }] };
    const r = resolveMenu({ mine, catalog: TOOLS });
    expect(r.unknown).toBe(0);
    expect(r.groups[0].children.map((c) => c.id)).toEqual(['virt', 'hv', 'alarm']);
    // 순서가 달라도(vcenters 가 먼저) 같은 항목은 한 번만 — 자리는 처음 나온 것
    const r2 = resolveMenu({ mine: { v: 1, groups: [{ id: 'server', children: [{ tab: 'vcenters' }, { tab: 'hosts' }, { tab: 'vms' }] }] }, catalog: TOOLS });
    expect(r2.groups[0].children.map((c) => c.id)).toEqual(['virt', 'hv']);
    expect(r2.unknown).toBe(0);
    // 단독 메뉴로 저장된 tab:vcenters 도 같은 항목
    const r3 = resolveMenu({ mine: { v: 1, groups: [{ id: 'my-vc', tab: 'vcenters' }, { id: 'my-vm', tab: 'vms' }, { id: 'my-h', tab: 'hosts' }] }, catalog: TOOLS });
    expect(r3.groups.map((g) => [g.id, g.label])).toEqual([['my-vc', 'Virtual Machine(VM)'], ['my-h', 'Hypervisor']]);
    expect(r3.unknown).toBe(0);
    const miss3 = missingDefaults(r3.groups).map((m) => m.key);
    for (const k of ['tab:vms', 'tab:hosts', 'tab:vcenters']) expect(miss3, k).not.toContain(k);
  });
  it('기본 메뉴를 저장 모양으로 → 새 저장 키는 tab:vms · tab:hosts(tab:vcenters 는 저장하지 않는다)', () => {
    const server = defaultMenu().groups.find((g) => g.id === 'server');
    expect(server.children.slice(0, 2)).toEqual([{ tab: 'vms' }, { tab: 'hosts' }]);
  });
});

describe('v2.727 감사 A-01 — 조회 실패는 포탈 기본 메뉴가 아니다', () => {
  it('failed 면 source 는 unknown 이고 그룹은 기본(또는 마지막으로 읽은 메뉴)으로 그린다', () => {
    const r = resolveMenu({ mine: null, distributed: null, catalog: TOOLS, failed: true });
    expect(r.source).toBe('unknown');
    expect(r.groups).toBe(MENU_GROUPS);
    const kept = resolveMenu({ mine: defaultMenu(), catalog: TOOLS, failed: true });
    expect(kept.source).toBe('unknown');
    expect(kept.groups.map((g) => g.id)).toEqual(MENU_GROUPS.map((g) => g.id));
    expect(resolveMenu({ mine: null, catalog: TOOLS, failed: false }).source).toBe('default');
    expect(resolveMenu({ mine: null, catalog: TOOLS }).source).toBe('default');
  });
  it('재시도 간격은 5초 → 15초 → 60초 상한', () => {
    expect(MENU_RETRY_MS).toEqual([5000, 15000, 60000]);
    expect([0, 1, 2, 3, 10].map(retryDelayMs)).toEqual([5000, 15000, 60000, 60000, 60000]);
    expect(retryDelayMs(-1)).toBe(5000);
    expect(retryDelayMs(undefined)).toBe(5000);
  });
});

describe('v2.727 감사 A-06 — 특수 기능이 하위 항목인 메뉴에서의 locate', () => {
  it('도구는 자기 자리가 먼저고, 메뉴에 없는 도구만 특수 기능 하위 항목으로 떨어진다(그룹 id 를 박지 않는다)', () => {
    const mine = { v: 1, groups: [{ id: 'custom-1', label: '내 그룹', children: [{ tab: 'tools' }, { tool: 'storage-mon' }] }] };
    const { groups } = resolveMenu({ mine, catalog: TOOLS });
    expect(groups.map((g) => g.id)).toEqual(['custom-1']);
    expect(locate('tools', '#/tools/storage-mon', groups)).toEqual({ group: 'custom-1', child: 'mon' });
    expect(locate('tools', '#/tools/storage-mon/faults', groups)).toEqual({ group: 'custom-1', child: 'mon' });
    expect(locate('tools', '#/tools/pdu', groups)).toEqual({ group: 'custom-1', child: 'tools' });
    expect(locate('tools', '#/tools', groups)).toEqual({ group: 'custom-1', child: 'tools' });
    // 특수 기능 항목이 아예 없는 메뉴에서는 모르는 도구가 어느 그룹도 켜지 않는다(없는 'tools' 그룹을 지어내지 않는다)
    const none = resolveMenu({ mine: { v: 1, groups: [{ id: 'overview', tab: 'overview' }] }, catalog: TOOLS }).groups;
    expect(locate('tools', '#/tools/pdu', none)).toEqual({ group: null, child: null });
  });
});

describe('sideMenu.nextOpenGroup(v2.727) — 아코디언: 펼친 그룹은 하나', () => {
  it('닫힌 그룹을 누르면 그 그룹만 열린다(이전 그룹은 닫힌다)', () => {
    expect(nextOpenGroup('server', 'storage')).toBe('storage');
    expect(nextOpenGroup(null, 'storage')).toBe('storage');
  });
  it('열린 그룹을 다시 누르면 닫힌다(0개 허용) · 빈 id 는 변화 없음', () => {
    expect(nextOpenGroup('server', 'server')).toBe(null);
    expect(nextOpenGroup('server', '')).toBe('server');
    expect(nextOpenGroup(undefined, null)).toBe(null);
  });
});
