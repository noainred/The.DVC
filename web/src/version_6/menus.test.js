import { describe, it, expect } from 'vitest';
import { TOOLS } from '../views/specialToolsList.js';
import { MENUS, TAB_IDS, MUTATING_TOOLS, allMenuKeys, menuOfKey, resolveMenu, resolveNav, activePageOf, menuById } from './menus.js';
import { parseMenuHash, isV6Hash, v6EntryTarget, menuHash, readShellV6, writeShellV6, SHELL_V6 } from './route.js';
import { readShell, writeShell, SHELL_KEY } from '../version_5/route.js';

const fakeStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

describe('V6 메뉴 배치(핸드오프 MENUS)', () => {
  it('특수 기능 카탈로그 전부가 정확히 1회 배치된다(미분류 0 · 중복 0)', () => {
    const keys = allMenuKeys();
    const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dup).toEqual([]);
    const missing = TOOLS.map((t) => t.k).filter((k) => !keys.includes(k));
    expect(missing).toEqual([]);
  });
  it('유령 키가 없다 — 모든 항목은 카탈로그 도구이거나 기존 화면(탭)이다', () => {
    const cat = new Set(TOOLS.map((t) => t.k));
    expect(allMenuKeys().filter((k) => !cat.has(k) && !TAB_IDS.includes(k))).toEqual([]);
  });
  it('상태를 바꾸는 도구는 자동화 메뉴에만 있다', () => {
    for (const k of MUTATING_TOOLS) expect(menuOfKey(k), k).toBe('auto');
  });
  it('서버 메뉴는 물리·호스트·VM 세 구분이고 각 그룹이 seg 를 가진다', () => {
    expect(menuById('server').groups.map((g) => g.seg)).toEqual(['phys', 'host', 'vm']);
  });
  it('메뉴는 10개다', () => { expect(MENUS).toHaveLength(10); });
});

describe('resolveMenu — 권한 판정은 기존 모듈을 쓴다', () => {
  const allTabs = TAB_IDS.slice();
  it('관리자는 관리자 표시 도구가 잠기지 않는다', () => {
    const m = resolveMenu(menuById('platform'), TOOLS, { isAdmin: true, visibleTabIds: allTabs });
    const pc = m.groups.flatMap((g) => g.items).find((i) => i.k === 'portal-check');
    expect(pc.locked).toBe(false);
    expect(pc.badge).toBe('admin');
  });
  it('operator 에게 관리자 전용 도구는 숨기지 않고 🔒(잠금)으로 보인다', () => {
    const m = resolveMenu(menuById('platform'), TOOLS, { isAdmin: false, visibleTabIds: ['vcenters'] });
    const pc = m.groups.flatMap((g) => g.items).find((i) => i.k === 'portal-check');
    expect(pc.locked).toBe(true);
    expect(pc.lockReason).toMatch(/관리자/);
  });
  it('보이지 않는 탭(설정·업그레이드)은 항목에서 빠진다 — 개수도 실제 보이는 수', () => {
    const m = resolveMenu(menuById('platform'), TOOLS, { isAdmin: false, visibleTabIds: ['vcenters'] });
    const keys = m.groups.flatMap((g) => g.items).map((i) => i.k);
    expect(keys).not.toContain('settings');
    expect(keys).not.toContain('upgrade');
    expect(m.count).toBe(keys.length);
  });
  it('서비스 허브 주소가 없으면 그 항목은 없다(죽은 링크 금지)', () => {
    const a = resolveMenu(menuById('platform'), TOOLS, { isAdmin: true, visibleTabIds: allTabs });
    expect(a.groups.flatMap((g) => g.items).some((i) => i.k === 'service-hub')).toBe(false);
    const b = resolveMenu(menuById('platform'), TOOLS, { isAdmin: true, visibleTabIds: allTabs, serviceHubUrl: 'https://hub.example' });
    const hub = b.groups.flatMap((g) => g.items).find((i) => i.k === 'service-hub');
    expect(hub.href).toBe('https://hub.example');
    expect(hub.badge).toBe('external');
  });
  it('허용 목록 모드는 목록 밖 도구를 숨긴다(v2.555 규약)', () => {
    const m = resolveMenu(menuById('storage'), TOOLS, { isAdmin: false, toolsAllowed: ['storage-mon'], visibleTabIds: [] });
    expect(m.groups.flatMap((g) => g.items).map((i) => i.k)).toEqual(['storage-mon']);
  });
  it('비상 정지는 위험 표지, 준비 중 도구는 준비 중 표지', () => {
    const m = resolveMenu(menuById('auto'), TOOLS, { isAdmin: true, visibleTabIds: allTabs });
    const it = (k) => m.groups.flatMap((g) => g.items).find((i) => i.k === k);
    expect(it('shutdown').badge).toBe('danger');
    expect(it('diskadd').badge).toBe('soon');
  });
  it('보이는 항목이 0 인 메뉴는 사이드바에서 빠진다', () => {
    const nav = resolveNav(TOOLS, { isAdmin: false, toolsAllowed: [], visibleTabIds: [] });
    expect(nav).toEqual([]);
  });
});

describe('V6 주소', () => {
  it('진입 신호 → 실제 주소', () => {
    expect(isV6Hash('#/v6')).toBe(true);
    expect(isV6Hash('#/v5')).toBe(false);
    expect(v6EntryTarget('#/v6')).toBe('#/overview');
    expect(v6EntryTarget('#/v6/m/server')).toBe('#/m/server');
  });
  it('메뉴 주소 판정 — 서버 구분은 세 값만', () => {
    expect(parseMenuHash('#/m/ops')).toEqual({ menuId: 'ops', seg: '' });
    expect(parseMenuHash('#/m/server/vm')).toEqual({ menuId: 'server', seg: 'vm' });
    expect(parseMenuHash('#/m/server/zzz')).toEqual({ menuId: 'server', seg: '' });
    expect(parseMenuHash('#/m')).toBe(null);
    expect(parseMenuHash('#/vms')).toBe(null);
    expect(menuHash('server', 'host')).toBe('#/m/server/host');
  });
  it('활성 메뉴 — 도구·탭은 그것이 속한 메뉴', () => {
    expect(activePageOf('#/tools/storage-mon', null)).toBe('storage');
    expect(activePageOf('#/vms', null)).toBe('server');
    expect(activePageOf('#/overview', null)).toBe('overview');
    expect(activePageOf('#/m/net', parseMenuHash('#/m/net'))).toBe('net');
  });
  it('셸 플래그 — V5 와 같은 키를 쓰고 동시에 켜지지 않는다', () => {
    const s = fakeStore();
    writeShellV6(true, s);
    expect(s.getItem(SHELL_KEY)).toBe(SHELL_V6);
    expect(readShellV6(s)).toBe(true);
    expect(readShell(s)).toBe(false);
    writeShell(true, s);                 // V5 로 바꾸면
    expect(readShellV6(s)).toBe(false);
    writeShellV6(false, s);              // V6 끄기가 V5 까지 끄지 않는다
    expect(readShell(s)).toBe(true);
  });
  it('저장소가 throw 해도 V6 가 아니다(기존 화면이 안전한 기본값)', () => {
    const bad = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => {} };
    expect(readShellV6(bad)).toBe(false);
    expect(writeShellV6(true, bad)).toBe(false);
  });
});
