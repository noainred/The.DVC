// v2.891 단독 메뉴로 추가(사용자 요청 '메뉴 수정에서 단독 메뉴로 추가하는 기능 만들어줘'):
//   아무 항목(그룹 안 항목 · 특수 기능 도구)이나 그룹 없이 한 줄 메뉴로 둔다 — 해석(sideMenu) · 편집(menuEdit) · 위치(topMenu.locate) · 화면 소스.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MENU_GROUPS, locate, visibleMenu, entryOf, hashOf } from '../topMenu.js';
import { TOOLS } from '../specialToolsList.js';
import { resolveMenu, missingDefaults, isSingle, fixedSingleKeys } from './sideMenu.js';
import {
  toEditable, toStored, addSingle, detachToSingle, removeGroup, addItem, placedIn, countItems, changeCount, sameMenu, availableTools, firstGroupId, moveItem, removeItem,
} from './menuEdit.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const editorSrc = fs.readFileSync(path.join(here, 'MenuEditor.jsx'), 'utf8');
const sidebarSrc = fs.readFileSync(path.join(here, 'Sidebar.jsx'), 'utf8');

const base = () => toEditable(MENU_GROUPS);
// 기본 메뉴에 없는(특수 기능에서만 더할 수 있는) 도구 하나
const extra = () => availableTools(TOOLS, base()).find((t) => !t.placedLabel && !t.adminOnly);
const serverGi = () => base().findIndex((g) => g.id === 'server');

describe('해석 — 저장된 단독 메뉴(최상위 tool · 그룹 항목 tab)', () => {
  it('특수 기능 도구 단독: 라벨은 카탈로그(이름 덮어쓰기 따름) · 특수 기능 아이콘 · 저장 라벨이 없어도 "내 그룹" 이 아니다', () => {
    const t = extra();
    const mine = { v: 1, groups: [{ id: 'overview', tab: 'overview' }, { id: 'custom-1', tool: t.k }, { id: 'tools', tab: 'tools' }] };
    let r = resolveMenu({ mine, catalog: TOOLS });
    const one = r.groups.find((g) => g.id === 'custom-1');
    expect(isSingle(one)).toBe(true);
    expect([one.tool, one.label, one.fromTools, one.iconOf]).toEqual([t.k, t.label, true, 'tools']);
    r = resolveMenu({ mine, catalog: TOOLS, overrides: { [t.k]: { label: '내 이름' } } });
    expect(r.groups.find((g) => g.id === 'custom-1').label).toBe('내 이름');
    expect(r.unknown).toBe(0);
  });
  it('그룹 안 항목(tab · 기본 도구+조각)도 단독으로 · 아이콘은 그 항목의 기본 그룹 · 모르는 도구는 unknown 으로 센다', () => {
    const mine = { v: 1, groups: [
      { id: 'custom-1', tab: 'vms' }, { id: 'custom-2', tool: 'gpu' }, { id: 'custom-3', tool: 'no-such-tool' }, { id: 'tools', tab: 'tools' },
    ] };
    const r = resolveMenu({ mine, catalog: TOOLS });
    const vms = r.groups.find((g) => g.id === 'custom-1');
    // v2.915: 단독으로 저장한 옛 '가상화 서버'(tab:vms)는 별칭으로 가상화 플랫폼 항목이 된다
    // v2.994: tab:vms 는 이제 'Virtual Machine(VM)' 항목의 정체 키(처음 여는 탭 vms · tabs 에 vcenters)
    const virt = MENU_GROUPS.find((g) => g.id === 'server').children.find((c) => c.id === 'virt');
    expect([vms.tab, vms.iconOf, vms.label]).toEqual(['vms', 'server', virt.label]);
    expect(vms.tabs).toEqual(['vcenters']);
    expect(r.groups.find((g) => g.id === 'custom-2').iconOf).toBe('resource');
    expect(r.groups.some((g) => g.id === 'custom-3')).toBe(false);
    expect(r.unknown).toBe(1);
    // 같은 항목이 단독 · 그룹 둘 다면 앞의 것만 — v2.994: tab:vms 는 Virtual Machine(VM) · tab:hosts 는 Hypervisor(별개 항목)라 서버 그룹에는 hv 만 남는다
    const dup = resolveMenu({ mine: { v: 1, groups: [{ id: 'custom-1', tab: 'vms' }, { id: 'server', children: [{ tab: 'vms' }, { tab: 'hosts' }] }] }, catalog: TOOLS });
    expect(dup.groups.map((g) => g.id)).toEqual(['custom-1', 'server']);
    expect(dup.groups.find((g) => g.id === 'server').children.map((c) => c.id)).toEqual(['hv']);
    // 단독 tab:vms 와 그룹의 tab:vcenters(별칭)도 같은 항목 — 그룹 쪽은 빠진다
    const dup2 = resolveMenu({ mine: { v: 1, groups: [{ id: 'custom-1', tab: 'vms' }, { id: 'server', children: [{ tab: 'vcenters' }, { tab: 'alarms' }] }] }, catalog: TOOLS });
    expect(dup2.groups.find((g) => g.id === 'server').children.map((c) => c.tab)).toEqual(['alarms']);
    expect(dup2.unknown).toBe(0);
  });
  it('기본 메뉴로 되돌려도 예전과 같다(기본 단독 · 라벨 규칙 그대로)', () => {
    const stored = toStored(base());
    expect(stored.groups.every((g) => !('label' in g))).toBe(true);
    expect(sameMenu(toEditable(resolveMenu({ mine: stored, catalog: TOOLS }).groups), base())).toBe(true);
    expect([...fixedSingleKeys()].sort()).toEqual(MENU_GROUPS.filter((g) => !g.children).map((g) => `tab:${g.tab}`).sort());
  });
});

describe('편집 — + 단독 · 단독으로 빼기 · ✕', () => {
  it('+ 단독: 추가 대상 그룹 없이 특수 기능 앞에 · 저장 모양은 { id, tool } (라벨 없음) · 왕복', () => {
    const t = extra();
    const r = addSingle(base(), t.item);
    expect(r.ok).toBe(true);
    const g = r.groups[r.gi];
    expect(r.groups[r.gi + 1].tab).toBe('tools');
    expect([g.id, g.tool, g.custom, g.fixed, g.label]).toEqual(['custom-1', t.k, true, false, t.label]);
    const stored = toStored(r.groups);
    expect(stored.groups.find((x) => x.id === 'custom-1')).toEqual({ id: 'custom-1', tool: t.k });
    const again = toEditable(resolveMenu({ mine: stored, catalog: TOOLS }).groups);
    expect(sameMenu(again, r.groups)).toBe(true);
    expect(changeCount(base(), r.groups)).toBe(2);   // 그룹 1 더함 + 항목 1 더함
    expect(countItems(r.groups)).toBe(countItems(base()) + 1);
    expect(availableTools(TOOLS, r.groups).find((x) => x.k === t.k).placedLabel).toBe('단독 메뉴');
    expect(placedIn(r.groups, `tool:${t.k}`).single).toBe(true);
    // 이미 있으면 다시 넣지 않는다 — 그룹에도, 단독에도
    expect(addSingle(r.groups, t.item).reason).toMatch(/이미 단독 메뉴/);
    expect(addItem(r.groups, serverGi(), t.item).reason).toMatch(/이미 단독 메뉴/);
    expect(addSingle(base(), base()[serverGi()].children[0]).reason).toMatch(/이미 '서버' 에 있습니다|이미 '.+' 에 있습니다/);
  });
  it('단독으로 빼기: 그 그룹에서 빠지고 그룹 바로 아래 · 저장 모양 { id, tab }', () => {
    const gi = serverGi();
    const first = base()[gi].children[0];
    const r = detachToSingle(base(), gi, 0);
    expect(r.ok).toBe(true);
    expect(r.gi).toBe(gi + 1);
    expect(r.groups[gi].children.some((c) => c.key === first.key)).toBe(false);
    expect([r.groups[gi + 1].tab, r.groups[gi + 1].iconOf, r.groups[gi + 1].label]).toEqual([first.tab, 'server', first.label]);
    expect(toStored(r.groups).groups[gi + 1]).toEqual({ id: 'custom-1', tab: first.tab });
    expect(detachToSingle(base(), gi, 99).ok).toBe(false);
    expect(detachToSingle(base(), 0, 0).ok).toBe(false);   // 단독(Overview)에서 빼기 없음
  });
  it('✕: 만든 단독은 지우고(오른쪽 목록으로 돌아감) 기본 단독은 못 지운다 · 단독은 추가 대상 · 항목 연산 대상이 아니다', () => {
    const r = detachToSingle(base(), serverGi(), 0);
    const one = r.groups[r.gi];
    expect(missingDefaults(r.groups).some((m) => m.key === one.key)).toBe(false);
    const del = removeGroup(r.groups, r.gi);
    expect(del.ok).toBe(true);
    expect(missingDefaults(del.groups).some((m) => m.key === one.key)).toBe(true);
    expect(removeGroup(base(), 0).ok).toBe(false);   // 기본 단독(Overview)
    expect(addItem(r.groups, r.gi, extra().item).ok).toBe(false);
    expect(moveItem(r.groups, r.gi, 0, 1)).toBe(r.groups);
    expect(removeItem(r.groups, r.gi, 0)).toBe(r.groups);
    expect(isSingle(r.groups.find((g) => g.id === firstGroupId(r.groups)))).toBe(false);   // '여기에 추가' 기본 대상은 그룹만
  });
});

describe('위치 · 표시 · 이동', () => {
  it('단독 도구 화면은 그 단독 메뉴가 활성(child null) · 권한 없으면 숨김 · 누르면 그 주소', () => {
    const t = extra();
    const r = resolveMenu({ mine: { v: 1, groups: [{ id: 'custom-1', tool: t.k }, { id: 'tools', tab: 'tools' }] }, catalog: TOOLS });
    expect(locate('tools', `#/tools/${t.k}`, r.groups)).toEqual({ group: 'custom-1', child: null });
    expect(locate('tools', '#/tools/some-other', r.groups)).toEqual({ group: 'tools', child: null });
    expect(visibleMenu({ toolOk: () => false }, r.groups).map((g) => g.id)).toEqual(['tools']);
    const one = r.groups[0];
    expect(entryOf(one)).toBe(one);
    expect(hashOf(one)).toBe(`#/tools/${t.k}`);
  });
});

describe('화면 소스', () => {
  it('편집 창: + 단독 · 단독으로 빼기 · 만든 단독만 ✕', () => {
    expect(editorSrc).toMatch(/onClick=\{\(\) => addOne\(t\.item\)\}>\+ 단독</);
    expect(editorSrc).toMatch(/onClick=\{\(\) => addOne\(missingItem\(m\)\)\}>\+ 단독</);
    expect(editorSrc).toMatch(/aria-label="단독 메뉴로 빼기"[^>]*onClick=\{\(\) => apply\(detachToSingle\(groups, gi, ii\)\)\}/);
    expect(editorSrc).toMatch(/\{single && !g\.fixed && <button[^>]*aria-label="단독 메뉴 삭제"/);
    expect(editorSrc).not.toMatch(/g\.tab \?/);
  });
  it('사이드바: 단독 아이콘은 iconOf(그 항목의 기본 그룹)', () => {
    expect(sidebarSrc).toMatch(/iconNameOf\(g\.iconOf \|\| g\.id\)/);
  });
});
