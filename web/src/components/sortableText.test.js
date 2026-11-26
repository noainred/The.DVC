import { describe, it, expect } from 'vitest';
import React from 'react';
import { textOf, sortKeyOf, compareKeys, sortChildren, nextSortState, headerSortable, cellText, rowIdsOf, managesSort } from './sortableText.js';

const h = React.createElement;

describe('sortableText (v2.422 표 자동 정렬)', () => {
  it('textOf: 문자열/숫자/배열/엘리먼트/컴포넌트 props/data-sort', () => {
    expect(textOf('a')).toBe('a');
    expect(textOf(12)).toBe('12');
    expect(textOf(['a', null, 'b'])).toBe('a b');
    expect(textOf(h('td', null, h('b', null, 'X'), ' · ', 'Y'))).toBe('X  ·  Y'.replace(/\s+/g, ' ') === 'X · Y' ? textOf(h('td', null, h('b', null, 'X'), ' · ', 'Y')) : 'X · Y');
    expect(textOf(h('td', { 'data-sort': 42 }, 'sth'))).toBe('42');
    const Comp = () => null;
    expect(textOf(h('td', null, h(Comp, { pct: 73 })))).toBe('73');
    expect(textOf(h('td', null, h('input', { type: 'checkbox', checked: true })))).toBe('1');
  });
  it('sortKeyOf: 숫자·단위·콤마·%·시간·한국식/ISO 날짜·빈 값', () => {
    expect(sortKeyOf('1,234')).toEqual({ kind: 'num', v: 1234 });
    expect(sortKeyOf('12.5 GB').v).toBe(12.5e9);
    expect(sortKeyOf('2 TB').v).toBeGreaterThan(sortKeyOf('900 GB').v);
    expect(sortKeyOf('45%').v).toBe(45);
    expect(sortKeyOf('3.2 Gbps').v).toBe(3.2e9);
    expect(sortKeyOf('250 W').v).toBe(250);
    expect(sortKeyOf('90 ms').v).toBe(0.09);
    expect(sortKeyOf('2분').v).toBe(120);
    expect(sortKeyOf('—').kind).toBe('empty');
    expect(sortKeyOf('').kind).toBe('empty');
    const ko = sortKeyOf('2026. 9. 7. 오후 11:21:35');
    expect(ko.kind).toBe('num');
    expect(new Date(ko.v).getHours()).toBe(23);
    expect(sortKeyOf('2026. 10. 1. 오전 12:05').v).toBeGreaterThan(ko.v);
    expect(sortKeyOf('2026-09-07 23:21').kind).toBe('num');
    expect(sortKeyOf('host-10').kind).toBe('str');
  });
  it('compareKeys: 빈 값은 항상 뒤, 숫자 < 문자열, 문자열은 숫자 인식 localeCompare', () => {
    expect(compareKeys(sortKeyOf('—'), sortKeyOf('1'))).toBeGreaterThan(0);
    expect(compareKeys(sortKeyOf('5'), sortKeyOf('abc'))).toBeLessThan(0);
    expect(compareKeys(sortKeyOf('host-2'), sortKeyOf('host-10'))).toBeLessThan(0);
  });
  it('sortChildren: 열 기준 정렬, desc 에서도 빈 값은 뒤, colSpan 안내 행은 뒤, Fragment 쌍은 함께 이동', () => {
    const tr = (k, a, b) => h('tr', { key: k }, h('td', null, a), h('td', null, b));
    const rows = [tr('a', 'z', '10 GB'), tr('b', 'x', '—'), tr('c', 'y', '2 TB'), h('tr', { key: 'e' }, h('td', { colSpan: 2 }, '없음'))];
    const asc = sortChildren(rows, 1, 'asc').map((r) => r.key);
    expect(asc).toEqual(['a', 'c', 'b', 'e']);
    const desc = sortChildren(rows, 1, 'desc').map((r) => r.key);
    expect(desc).toEqual(['c', 'a', 'b', 'e']);
    const byName = sortChildren(rows, 0, 'asc').map((r) => r.key);
    expect(byName).toEqual(['b', 'c', 'a', 'e']);
    const frag = [h(React.Fragment, { key: 'f1' }, tr('f1a', 'b', '1'), h('tr', { key: 'f1b' }, h('td', { colSpan: 2 }, 'detail'))), h(React.Fragment, { key: 'f2' }, tr('f2a', 'a', '2'))];
    expect(sortChildren(frag, 0, 'asc').map((r) => r.key)).toEqual(['f2', 'f1']);
    // 합계 행은 방향과 무관하게 항상 맨 아래
    const withTotal = [tr('t', '합계', '999 TB'), tr('a', 'z', '10 GB'), tr('c', 'y', '2 TB')];
    expect(sortChildren(withTotal, 1, 'desc').map((r) => r.key)).toEqual(['c', 'a', 't']);
    expect(sortChildren(withTotal, 1, 'asc').map((r) => r.key)).toEqual(['a', 'c', 't']);
    // 키 없는 자식에는 원래 인덱스 키를 붙인다
    const nokey = [h('tr', null, h('td', null, 'b')), h('tr', null, h('td', null, 'a'))];
    expect(sortChildren(nokey, 0, 'asc').map((r) => r.key)).toEqual(['s1', 's0']);
  });
  it('nextSortState: asc → desc → 해제, 다른 열은 asc', () => {
    expect(nextSortState(null, 2)).toEqual({ col: 2, dir: 'asc' });
    expect(nextSortState({ col: 2, dir: 'asc' }, 2)).toEqual({ col: 2, dir: 'desc' });
    expect(nextSortState({ col: 2, dir: 'desc' }, 2)).toBeNull();
    expect(nextSortState({ col: 2, dir: 'desc' }, 0)).toEqual({ col: 0, dir: 'asc' });
  });
  it('headerSortable: onClick/컨트롤/colSpan/data-nosort/빈 헤더는 제외', () => {
    expect(headerSortable(h('th', null, '이름'))).toBe(true);
    expect(headerSortable(h('th', { onClick: () => {} }, '이름'))).toBe(false);
    expect(headerSortable(h('th', null, h('input', { type: 'checkbox' })))).toBe(false);
    expect(headerSortable(h('th', { colSpan: 2 }, '그룹'))).toBe(false);
    expect(headerSortable(h('th', { 'data-nosort': true }, '작업'))).toBe(false);
    expect(headerSortable(h('th', null, ''))).toBe(false);
    expect(headerSortable(h('td', null, 'x'))).toBe(false);
  });
  it('cellText: td 가 없는 컴포넌트 셀(<Cell data-sort>)도 셀로 인식한다(v2.425)', () => {
    const Cell = () => null;
    const tr = h('tr', null, h(Cell, { 'data-sort': 'zeta', col: {}, r: {} }), h(Cell, { 'data-sort': '42', col: {}, r: {} }));
    expect(cellText(tr, 0)).toBe('zeta');
    expect(cellText(tr, 1)).toBe('42');
    const rows = [h('tr', { key: 'a' }, h(Cell, { 'data-sort': '10' })), h('tr', { key: 'b' }, h(Cell, { 'data-sort': '2' }))];
    expect(sortChildren(rows, 0, 'asc').map((r) => r.key)).toEqual(['b', 'a']);
  });
  it('cellText: colSpan 을 고려한 열 인덱스', () => {
    const tr = h('tr', null, h('td', { colSpan: 2 }, 'AB'), h('td', null, 'C'));
    expect(cellText(tr, 0)).toBeNull();
    expect(cellText(tr, 2)).toBe('C');
  });
});

// v3.17.3(2차 공통 기능 점검 2회차): DataTable 의 원값 비교 — 빈 값은 방향과 무관하게 뒤 · 숫자 인식 · NaN 은 빈 값.
import { compareCellValues, isEmptyCellValue } from './sortableText.js';
describe('compareCellValues(DataTable 원값 정렬)', () => {
  const sortBy = (vals, dir = 'asc') => [...vals].sort((a, b) => {
    const { empty, cmp } = compareCellValues(a, b);
    if (empty != null) return empty;
    return dir === 'asc' ? cmp : -cmp;
  });
  it('빈 값(null · undefined · 빈 글자 · — · NaN)은 오름 · 내림 모두 뒤', () => {
    const vals = [3, '', null, 1, '—', Number.NaN, 2, undefined];
    expect(sortBy(vals).slice(0, 3)).toEqual([1, 2, 3]);
    expect(sortBy(vals, 'desc').slice(0, 3)).toEqual([3, 2, 1]);
    expect(sortBy(vals).slice(3).every(isEmptyCellValue)).toBe(true);
    expect(sortBy(vals, 'desc').slice(3).every(isEmptyCellValue)).toBe(true);
  });
  it('글자는 숫자를 인식한다(vc-2 < vc-10) · 0 은 값이다', () => {
    expect(sortBy(['vc-10', 'vc-2', 'vc-1'])).toEqual(['vc-1', 'vc-2', 'vc-10']);
    expect(isEmptyCellValue(0)).toBe(false);
    expect(sortBy([0, -1, 5])).toEqual([-1, 0, 5]);
  });
});

// v3.44 — STable onOrder: 보이는 행 순서(data-rowid)를 정렬 · 상한 뒤 그대로 알린다(물리서버 상세 드로어의 ‹ › 순서).
describe('rowIdsOf — 보이는 행의 data-rowid', () => {
  const tr = (id, name, v) => h('tr', { key: id, 'data-rowid': id }, h('td', null, name), h('td', null, v));
  const rows = [tr('st:B', 'b', '2'), tr('st:A', 'a', '10'), tr('st:C', 'c', '1')];

  it('원래 순서 · 정렬한 순서를 그대로 돌려준다(키의 콜론 · 접두가 바뀌지 않는다)', () => {
    expect(rowIdsOf(rows)).toEqual(['st:B', 'st:A', 'st:C']);
    expect(rowIdsOf(sortChildren(rows, 0, 'asc'))).toEqual(['st:A', 'st:B', 'st:C']);
    expect(rowIdsOf(sortChildren(rows, 1, 'desc'))).toEqual(['st:A', 'st:B', 'st:C']);   // 숫자 열 내림차순: 10 · 2 · 1
  });
  it('상한은 정렬한 뒤 앞에서부터(표가 그리는 행과 같다)', () => {
    expect(rowIdsOf(sortChildren(rows, 0, 'asc'), 2)).toEqual(['st:A', 'st:B']);
    expect(rowIdsOf(rows, 0)).toHaveLength(3);
  });
  it('data-rowid 가 없는 행 · 빈 값 · null 자식은 건너뛴다(지어내지 않는다)', () => {
    const mixed = [rows[0], null, false, h('tr', { key: 'sum' }, h('td', null, '합계')), h('tr', { key: 'e', 'data-rowid': '' }, h('td', null, 'x')), rows[2]];
    expect(rowIdsOf(mixed)).toEqual(['st:B', 'st:C']);
    expect(rowIdsOf(undefined)).toEqual([]);
    expect(rowIdsOf([])).toEqual([]);
  });
  it('중첩 배열(조각으로 나눠 그린 tbody)도 편다 — 깊이에 상관없이', () => {
    expect(rowIdsOf([[rows[0]], [rows[1], [rows[2]]]])).toEqual(['st:B', 'st:A', 'st:C']);
    expect(rowIdsOf([[[[[rows[0]]]]], [[[[[[rows[1]]]]]]]])).toEqual(['st:B', 'st:A']);   // 깊이 4 이상도(예전에는 3 까지만 폈다)
  });
  it('상한은 id 를 거르기 전의 행 단위에 건다 — 표가 그린 줄만 알린다(id 없는 안내 줄도 한 줄로 센다)', () => {
    // 표는 [안내 줄, B, A, C] 에서 앞 2줄(안내 줄 · B)만 그린다 → 알릴 것은 B 하나. 거른 뒤에 자르면 화면에 없는 A 까지 알린다(반증 B3 M2).
    const note = h('tr', { key: 'note' }, h('td', null, '안내'));
    expect(rowIdsOf([note, ...rows], 2)).toEqual(['st:B']);
    expect(rowIdsOf([null, false, note, ...rows], 2)).toEqual(['st:B']);   // null · false 는 줄이 아니다(React 가 그리지 않는다)
    expect(rowIdsOf([note, ...rows], 1)).toEqual([]);
    expect(rowIdsOf(rows, 1.9)).toEqual(['st:B']);    // 상한은 내림
    expect(rowIdsOf(rows, -1)).toHaveLength(3);        // 0 이하는 상한 없음
    expect(rowIdsOf(rows, 'x')).toHaveLength(3);
  });
  it('조각(Fragment) · 감싼 컴포넌트 안의 행은 전부 알린다 — 첫 행만 보지 않는다', () => {
    const frag = h(React.Fragment, { key: 'f' }, rows[0], rows[1]);
    expect(rowIdsOf([frag, rows[2]])).toEqual(['st:B', 'st:A', 'st:C']);
    // 조각 하나가 상한의 한 단위다(표의 상한도 조각 단위로 자른다)
    expect(rowIdsOf([frag, rows[2]], 1)).toEqual(['st:B', 'st:A']);
    // 행 안의 표(칸 안에 든 다른 표)의 행은 세지 않는다 — tr 을 만나면 그 안으로 들어가지 않는다
    const nested = h('tr', { key: 'o', 'data-rowid': 'outer' }, h('td', null, h('table', null, h('tbody', null, h('tr', { 'data-rowid': 'inner' }, h('td', null, 'x'))))));
    expect(rowIdsOf([nested])).toEqual(['outer']);
    expect(rowIdsOf(['글자', 3, rows[0]])).toEqual(['st:B']);   // 글자 · 숫자 자식은 건너뛴다
  });
});

describe('managesSort — 이 표의 정렬 · 상한을 STable 이 맡는가', () => {
  const th = (label, props = {}) => h('th', { key: label, ...props }, label);
  const thead = (...rows) => h('thead', null, ...rows);
  it('글자 th 만 있는 마지막 머리글 줄 → 맡는다', () => {
    expect(managesSort(thead(h('tr', null, th('이름'), th('값'))))).toBe(true);
    expect(managesSort(thead(h('tr', null, th('이름', { 'data-nosort': true }))))).toBe(true);   // 정렬 끈 열이 있어도 표는 맡는다
  });
  it('자체 정렬 표(onClick th · 컴포넌트 th) → 맡지 않는다(손대지 않는다)', () => {
    expect(managesSort(thead(h('tr', null, th('이름', { onClick: () => {} }), th('값'))))).toBe(false);
    const SortTh = () => h('th', null, 'x');
    expect(managesSort(thead(h('tr', null, h(SortTh, { key: 'c' }), th('값'))))).toBe(false);
  });
  it('판정은 마지막 머리글 줄로 — 윗줄(묶음 머리)의 onClick 은 보지 않는다', () => {
    expect(managesSort(thead(h('tr', { key: 'g' }, th('묶음', { onClick: () => {} })), h('tr', { key: 'c' }, th('이름'))))).toBe(true);
    expect(managesSort(thead(h('tr', { key: 'g' }, th('묶음')), h('tr', { key: 'c' }, th('이름', { onClick: () => {} }))))).toBe(false);
  });
  it('머리글 줄이 없거나 thead 가 아니면 → 맡지 않는다', () => {
    expect(managesSort(thead())).toBe(false);
    expect(managesSort(thead(null, false))).toBe(false);
    expect(managesSort(null)).toBe(false);
    expect(managesSort(undefined)).toBe(false);
    expect(managesSort('thead')).toBe(false);
  });
});
