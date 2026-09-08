import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { STable } from './STable.jsx';

const h = React.createElement;
const table = (thRow, rows) => h(STable, { className: 'x' }, h('thead', null, thRow), h('tbody', null, rows));

describe('STable (v2.422)', () => {
  it('일반 th 에 정렬 표시(↕)·title·cursor 를 붙이고 props 는 그대로 전달한다', () => {
    const html = renderToStaticMarkup(table(h('tr', null, h('th', null, '이름'), h('th', null, '값')), [h('tr', { key: 'a' }, h('td', null, 'a'), h('td', null, '1'))]));
    expect(html).toContain('<table class="x">');
    expect((html.match(/↕/g) || []).length).toBe(2);
    expect(html).toContain('cursor:pointer');
    expect(html).toContain('클릭하면 이 열로 정렬');
    expect(html).toContain('<td>a</td>');
  });
  it('자체 정렬 표(onClick th / 컴포넌트 th)는 손대지 않는다', () => {
    const html = renderToStaticMarkup(table(h('tr', null, h('th', { onClick: () => {} }, '이름'), h('th', null, '값')), []));
    expect(html).not.toContain('↕');
    const Th = ({ children }) => h('th', null, children);
    const html2 = renderToStaticMarkup(table(h('tr', null, h(Th, null, '이름'), h('th', null, '값')), []));
    expect(html2).not.toContain('↕');
  });
  it('컨트롤/colSpan/data-nosort 열은 제외, sortable=false 면 전체 제외, thead 없으면 그대로', () => {
    const html = renderToStaticMarkup(table(h('tr', null, h('th', null, h('input', { type: 'checkbox' })), h('th', { colSpan: 2 }, '그룹'), h('th', { 'data-nosort': true }, '작업'), h('th', null, '이름')), []));
    expect((html.match(/↕/g) || []).length).toBe(1);
    const off = renderToStaticMarkup(h(STable, { sortable: false }, h('thead', null, h('tr', null, h('th', null, '이름'))), h('tbody', null)));
    expect(off).not.toContain('↕');
    const bare = renderToStaticMarkup(h(STable, null, h('tbody', null, h('tr', null, h('td', null, 'x')))));
    expect(bare).toBe('<table><tbody><tr><td>x</td></tr></tbody></table>');
  });
});
