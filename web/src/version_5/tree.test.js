/**
 * version_5/tree.js 회귀(v2.616) — V4 트리와 같은 약속: 카탈로그 전부가 정확히 1회 · 유령 0.
 * 새 도구를 추가하고 V5 트리에 넣지 않으면 V5 내비에서 영원히 못 찾는다 — 여기서 막는다.
 */
import { describe, it, expect } from 'vitest';
import { GROUPS, HOME, MUTATING_TOOLS, treeToolKeys, treeTabIds, groupOfTool, resolveTree, activeKeyOf } from './tree.js';
import { TOOLS } from '../views/specialToolsList.js';

const ALL_TABS = ['overview', 'summary', 'vcenters', 'svcmon', 'hosts', 'vms', 'datastores', 'networks', 'ipam', 'alarms', 'tools', 'settings', 'upgrade'];

describe('V5 트리 커버리지', () => {
  it('모든 도구가 정확히 1회 — 누락 0 · 중복 0 · 유령 0', () => {
    const keys = treeToolKeys();
    const all = TOOLS.map((t) => t.k);
    expect(all.filter((k) => !keys.includes(k))).toEqual([]);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
    expect(keys.filter((k) => !all.includes(k))).toEqual([]);
  });
  it('개발 포탈 탭 전부(ipam 은 도구로)가 들어간다', () => {
    const tabs = [...treeTabIds(), 'ipam'];
    expect([...tabs].sort()).toEqual([...ALL_TABS].sort());
  });
  it('상태를 바꾸는 도구는 전부 자동화 그룹', () => {
    for (const k of MUTATING_TOOLS) expect(groupOfTool(k)?.label).toBe('자동화');
    const auto = GROUPS.find((g) => g.id === 'auto').items.map((i) => i.k);
    expect([...auto].sort()).toEqual([...MUTATING_TOOLS].sort());
  });
  it('자산 그룹은 소제목 4개로 나뉘고 항목은 25개', () => {
    const g = GROUPS.find((x) => x.id === 'assets');
    expect(g.items.filter((i) => i.kind === 'sub').map((i) => i.label)).toEqual(['인벤토리', '장비', '검색', '버전 · 구성']);
    expect(g.items.filter((i) => i.kind !== 'sub').length).toBe(25);
  });
  it('HOME 은 Overview · Summary', () => {
    expect(HOME.map((i) => i.id)).toEqual(['overview', 'summary']);
  });
});

describe('resolveTree — 판정은 toolVisibility 가 한다', () => {
  it('admin: 전부 보이고 개수 = 보이는 항목 수(소제목 제외)', () => {
    const t = resolveTree(TOOLS, { isAdmin: true, visibleTabIds: ALL_TABS, serviceHubUrl: 'https://hub' });
    const assets = t.groups.find((g) => g.id === 'assets');
    expect(assets.count).toBe(25);
    const total = t.groups.reduce((a, g) => a + g.count, 0);
    // 도구 91 + 탭 11(HOME 2 제외, ipam 은 도구 항목으로 1회)
    expect(total).toBe(TOOLS.length + ALL_TABS.length - 2 - 1);
  });
  it('서비스 허브는 주소가 없으면 숨긴다', () => {
    const t = resolveTree(TOOLS, { isAdmin: true, visibleTabIds: ALL_TABS, serviceHubUrl: '' });
    expect(t.groups.flatMap((g) => g.items).some((i) => i.key === 'tool:service-hub')).toBe(false);
  });
  it('viewer: 관리자 전용 도구는 숨기고, 권한 없는 도구는 잠근다', () => {
    const t = resolveTree(TOOLS, {
      isAdmin: false, visibleTabIds: ['overview', 'summary', 'vms'], can: (p) => p !== 'inv.nsx', toolAllowed: () => true,
    });
    const items = t.groups.flatMap((g) => g.items);
    expect(items.some((i) => i.key === 'tool:storage-mon')).toBe(false); // adminOnly
    expect(items.find((i) => i.key === 'tool:nsx')?.locked).toBe(true);   // perm inv.nsx
    expect(items.some((i) => i.key === 'tab:settings')).toBe(false);
    expect(items.some((i) => i.key === 'tab:ipam')).toBe(false);          // 탭이 안 보이면 ipam 도 안 보인다
    for (const g of t.groups) expect(g.count).toBe(g.items.filter((i) => i.kind !== 'sub').length);
  });
  it('허용 목록 모드: 목록 밖은 숨기고 빈 소제목은 버린다', () => {
    const t = resolveTree(TOOLS, { isAdmin: false, toolsAllowed: ['storage-mon'], visibleTabIds: [], toolAllowed: (k) => k === 'storage-mon' });
    expect(t.groups.map((g) => g.id)).toEqual(['assets']);
    expect(t.groups[0].items.map((i) => i.name)).toEqual(['장비', TOOLS.find((x) => x.k === 'storage-mon').label]);
  });
  it('준비 중 도구는 표시', () => {
    const t = resolveTree(TOOLS, { isAdmin: true, visibleTabIds: ALL_TABS });
    expect(t.groups.flatMap((g) => g.items).find((i) => i.key === 'tool:backup')?.comingSoon).toBe(true);
  });
});

describe('activeKeyOf', () => {
  it('주소 → 활성 항목', () => {
    expect(activeKeyOf('#/vms')).toBe('tab:vms');
    expect(activeKeyOf('#/tools')).toBe('tab:tools');
    expect(activeKeyOf('#/tools/storage-mon/faults')).toBe('tool:storage-mon');
    expect(activeKeyOf('')).toBe('tab:overview');
  });
});
