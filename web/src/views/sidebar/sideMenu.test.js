// sideMenu.test.js — 좌측 사이드바 메뉴 해석(v2.726)의 계약.
import { describe, it, expect } from 'vitest';
import { MENU_GROUPS, locate, visibleMenu, hashOf } from '../topMenu.js';
import { TOOLS } from '../specialToolsList.js';
import { resolveMenu, defaultMenu, missingDefaults, toolsChildren, activeToolsChild, catHash, catFromHash, itemKey, toolEligible, CAT_SEG } from './sideMenu.js';

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
    expect(server.children.map((c) => c.id)).toEqual(['vm', 'esxi', 'vc', 'bm', 'alarm']);
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
    expect(r.groups[0].children.map((c) => c.id)).toEqual(['vm', 'board']);
    expect(r.unknown).toBe(0);
  });
  it('해석된 메뉴로도 locate·visibleMenu·hashOf 가 그대로 동작한다(사용자 그룹에 넣은 도구는 그 그룹이 켜진다)', () => {
    const mine = { v: 1, groups: [{ id: 'overview', tab: 'overview' }, { id: 'custom-1', label: '내 그룹', children: [{ tool: 'esxitemp' }, { tab: 'hosts' }] }, { id: 'tools', tab: 'tools' }] };
    const { groups } = resolveMenu({ mine, catalog: TOOLS });
    expect(locate('tools', '#/tools/esxitemp', groups)).toEqual({ group: 'custom-1', child: 't-esxitemp' });
    expect(locate('hosts', '#/hosts', groups)).toEqual({ group: 'custom-1', child: 'esxi' });
    expect(locate('tools', '#/tools/pdu', groups)).toEqual({ group: 'tools', child: null });
    expect(hashOf(groups[1].children[0])).toBe('#/tools/esxitemp');
    const vis = visibleMenu({ tabOk: () => true, toolOk: (k) => k !== 'esxitemp' }, groups);
    expect(vis.find((g) => g.id === 'custom-1').children.map((c) => c.id)).toEqual(['esxi']);
  });
});

describe('missingDefaults · toolEligible · itemKey', () => {
  it('지운 기본 항목과 새로 생긴 항목이 목록에 온다(그룹 이름과 함께)', () => {
    const mine = { v: 1, groups: [{ id: 'server', children: [{ tab: 'vms' }] }, { id: 'tools', tab: 'tools' }] };
    const { groups } = resolveMenu({ mine, catalog: TOOLS });
    const miss = missingDefaults(groups);
    expect(miss.map((m) => m.key)).toContain('tab:hosts');
    expect(miss.map((m) => m.key)).toContain('tool:serveranalysis/baremetal');
    expect(miss.map((m) => m.key)).toContain('tab:overview');
    expect(miss.map((m) => m.key)).not.toContain('tab:vms');
    expect(miss.find((m) => m.key === 'tab:hosts').groupLabel).toBe('서버');
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

describe('특수 기능 하위(분류 바로가기)', () => {
  it('전체 카드 + 켜진 분류 · 주소는 #/tools/_cat/<id>', () => {
    const subs = toolsChildren([{ id: 'server', label: '서버', icon: '🖥️' }, { id: 'ops', label: '운영 작업' }]);
    expect(subs.map((s) => s.id)).toEqual(['all', 'cat:server', 'cat:ops']);
    expect(subs[1].hash).toBe(`#/tools/${CAT_SEG}/server`);
    expect(toolsChildren([])).toHaveLength(1);
    expect(toolsChildren(null)[0].hash).toBe('#/tools');
  });
  it('catHash ↔ catFromHash 왕복 · 분류 주소는 locate 에서 특수 기능 그룹이다', () => {
    expect(catHash('server')).toBe('#/tools/_cat/server');
    expect(catHash('all')).toBe('#/tools');
    expect(catHash('')).toBe('#/tools');
    expect(catFromHash('#/tools/_cat/server')).toBe('server');
    expect(catFromHash('#/tools/_cat/%ED%95%9C')).toBe('한');
    expect(catFromHash('#/tools/esxitemp')).toBe('');
    expect(catFromHash('#/tools')).toBe('');
    expect(locate('tools', '#/tools/_cat/server')).toEqual({ group: 'tools', child: null });
  });
  it('activeToolsChild — 목록은 all, 분류는 cat:<id>, 도구가 열려 있으면 null', () => {
    expect(activeToolsChild('tools', '#/tools')).toBe('all');
    expect(activeToolsChild('tools', '#/tools/_cat/ops')).toBe('cat:ops');
    expect(activeToolsChild('tools', '#/tools/_cat')).toBe('all');
    expect(activeToolsChild('tools', '#/tools/esxitemp')).toBe(null);
    expect(activeToolsChild('vms', '#/vms')).toBe(null);
  });
  it('도구 키에 _cat 같은 예약어가 없다(둘째 조각 충돌 방지)', () => {
    for (const t of TOOLS) expect(t.k.startsWith('_'), t.k).toBe(false);
  });
});
