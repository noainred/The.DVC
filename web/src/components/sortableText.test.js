import { describe, it, expect } from 'vitest';
import React from 'react';
import { textOf, sortKeyOf, compareKeys, sortChildren, nextSortState, headerSortable, cellText } from './sortableText.js';

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
  it('cellText: colSpan 을 고려한 열 인덱스', () => {
    const tr = h('tr', null, h('td', { colSpan: 2 }, 'AB'), h('td', null, 'C'));
    expect(cellText(tr, 0)).toBeNull();
    expect(cellText(tr, 2)).toBe('C');
  });
});
