// menuEdit.test.js — 내 메뉴 편집 연산(v2.726)의 계약.
import { describe, it, expect } from 'vitest';
import { MENU_GROUPS } from '../topMenu.js';
import { TOOLS } from '../specialToolsList.js';
import { resolveMenu } from './sideMenu.js';
import {
  toEditable, toStored, defaultEditable, moveGroup, moveItem, removeItem, addItem, newGroup, renameGroup, removeGroup,
  placedIn, countItems, sameMenu, changeCount, availableTools, filterTools, LIMITS,
} from './menuEdit.js';

const base = () => toEditable(MENU_GROUPS);
const toolItem = (k) => availableTools(TOOLS, base()).find((t) => t.k === k).item;

describe('편집 모양 ↔ 저장 모양', () => {
  it('기본 메뉴는 저장 모양에서 라벨을 싣지 않는다(기본 라벨이 바뀌면 따라가게) · 왕복이 같다', () => {
    const stored = toStored(base());
    expect(stored.v).toBe(1);
    expect(stored.groups.every((g) => !('label' in g))).toBe(true);
    expect(stored.groups.map((g) => g.id)).toEqual(MENU_GROUPS.map((g) => g.id));
    const again = toEditable(resolveMenu({ mine: stored, catalog: TOOLS }).groups);
    expect(sameMenu(again, base())).toBe(true);
    expect(changeCount(base(), again)).toBe(0);
  });
  it('이름을 바꾼 그룹·사용자 그룹은 라벨을 싣는다 · 빈 그룹은 뺀다', () => {
    let g = renameGroup(base(), 2, '서버 모음');
    g = newGroup(g, '').groups;
    const stored = toStored(g);
    expect(stored.groups.find((x) => x.id === 'server').label).toBe('서버 모음');
    expect(stored.groups.some((x) => x.id === 'custom-1')).toBe(false); // 비어 있어 뺐다
    expect(countItems(g)).toBe(countItems(base()));
  });
  it('defaultEditable 은 기본 메뉴와 같다', () => {
    expect(sameMenu(defaultEditable(TOOLS), base())).toBe(true);
  });
});

describe('순서 · 추가 · 빼기 · 그룹', () => {
  it('그룹 ▲▼ 는 경계에서 아무 일도 하지 않는다', () => {
    const g = base();
    expect(moveGroup(g, 0, -1)).toBe(g);
    expect(moveGroup(g, g.length - 1, 1)).toBe(g);
    const m = moveGroup(g, 2, -1);
    expect(m.map((x) => x.id).slice(0, 3)).toEqual(['overview', 'server', 'summary']);
    expect(changeCount(g, m)).toBe(1); // summary 하나만 자리가 바뀌었다
  });
  it('항목 ▲▼·✕ 는 그 그룹 안에서만', () => {
    const g = base();
    const gi = g.findIndex((x) => x.id === 'server');
    const m = moveItem(g, gi, 0, 1);
    expect(m[gi].children.map((c) => c.id).slice(0, 2)).toEqual(['esxi', 'vm']);
    expect(moveItem(g, gi, 0, -1)).toBe(g);
    expect(moveItem(g, 0, 0, 1)).toBe(g); // 단독 항목
    const r = removeItem(m, gi, 0);
    expect(r[gi].children.map((c) => c.id)[0]).toBe('vm');
    expect(changeCount(g, r)).toBe(1); // esxi 가 빠졌다(아래 항목이 밀린 것은 바뀐 것이 아니다)
    expect(changeCount(g, m)).toBe(1); // vm·esxi 를 맞바꾼 것은 하나가 움직인 것
  });
  it('특수 기능 도구를 더한다 — 같은 도구는 한 그룹에만, 단독 그룹에는 못 넣는다', () => {
    const g = base();
    const gi = g.findIndex((x) => x.id === 'storage');
    const a = addItem(g, gi, toolItem('esxitemp'));
    expect(a.ok).toBe(true);
    expect(a.groups[gi].children.at(-1)).toMatchObject({ key: 'tool:esxitemp', tool: 'esxitemp', fromTools: true, label: '서버 온도' });
    const again = addItem(a.groups, 0 + 2, toolItem('esxitemp'));
    expect(again.ok).toBe(false);
    expect(again.reason).toMatch(/스토리지/);
    expect(addItem(g, 0, toolItem('esxitemp')).ok).toBe(false); // overview 는 단독
    // 이미 메뉴에 있는 도구(서버 분석)는 넣을 수 없다 — placedLabel 이 말한다
    expect(availableTools(TOOLS, g).find((t) => t.k === 'serveranalysis').placedLabel).toBe('자원관리');
    expect(availableTools(TOOLS, g).find((t) => t.k === 'esxitemp').placedLabel).toBe('');
    expect(placedIn(g, 'tab:overview')).toMatchObject({ single: true });
  });
  it('새 그룹은 특수 기능 앞에 생기고 id 는 custom-n 으로 겹치지 않는다 · 단독 항목은 지울 수 없다', () => {
    const r1 = newGroup(base(), '내 모음');
    expect(r1.ok).toBe(true);
    expect(r1.groups[r1.gi]).toMatchObject({ id: 'custom-1', label: '내 모음', custom: true });
    expect(r1.groups[r1.gi + 1].id).toBe('tools');
    const r2 = newGroup(r1.groups, 'x'.repeat(100));
    expect(r2.groups[r2.gi].id).toBe('custom-2');
    expect(r2.groups[r2.gi].label).toHaveLength(LIMITS.label);
    expect(removeGroup(base(), 0).ok).toBe(false);
    const rm = removeGroup(base(), 2);
    expect(rm.ok).toBe(true);
    expect(rm.groups.some((x) => x.id === 'server')).toBe(false);
    expect(renameGroup(base(), 2, '   ')[2].label).toBe('서버'); // 빈 이름은 무시
  });
  it('상한 — 그룹 40 · 항목 400 에서 거부하고 사유를 돌려준다', () => {
    let g = base();
    while (g.length < LIMITS.groups) g = newGroup(g, 'g').groups;
    expect(newGroup(g, 'more').ok).toBe(false);
    const many = [{ id: 'a', label: 'A', custom: true, children: Array.from({ length: LIMITS.items }, (_, i) => ({ key: `tool:k${i}`, id: `t-k${i}`, label: `k${i}`, tool: `k${i}` })) }];
    expect(addItem(many, 0, { key: 'tool:extra', tool: 'extra', label: 'x' }).ok).toBe(false);
  });
});

describe('availableTools · filterTools', () => {
  it('외부 포탈·승격 탭은 목록에 없고, 이름 덮어쓰기·잠금 사유가 붙는다', () => {
    const list = availableTools(TOOLS, base(), { overrides: { esxitemp: { label: '온도' } }, lockOf: (t) => (t.adminOnly ? '관리자 전용' : null) });
    expect(list.some((t) => t.k === 'service-hub')).toBe(false);
    expect(list.some((t) => t.topTab)).toBe(false);
    const temp = list.find((t) => t.k === 'esxitemp');
    expect(temp.label).toBe('온도');
    expect(temp.origLabel).toBe('서버 온도');
    expect(temp.item.label).toBe('온도');
    expect(list.find((t) => t.k === 'portal-check').lock).toBe('관리자 전용');
    expect(list.find((t) => t.k === 'gpu').lock).toBe(null);
  });
  it('검색은 이름·키·설명·옛 이름을 본다', () => {
    const list = availableTools(TOOLS, base());
    expect(filterTools(list, 'esxitemp').map((t) => t.k)).toContain('esxitemp');
    expect(filterTools(list, '인사이트').some((t) => t.k === 'insights-hub')).toBe(true);
    expect(filterTools(list, 'finops').some((t) => t.k === 'insights-hub')).toBe(true); // aka
    expect(filterTools(list, '')).toBe(list);
    expect(filterTools(list, 'zzz-none')).toEqual([]);
  });
});
