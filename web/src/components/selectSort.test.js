// v2.708 — 드롭다운 선택지 정렬(selectSort.js) + 날 <select> 금지 스윕.
import { describe, it, expect } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sortSelectChildren, isPinnedOption, optionText } from './selectSort.js';

const h = React.createElement;
const labels = (arr) => arr.map((el) => optionText(el.props.children));
const opt = (value, label, extra = {}) => h('option', { value, key: extra.key ?? value, ...extra }, label);

describe('sortSelectChildren', () => {
  it('보이는 글자 순(숫자 인식 · 대소문자 무시)', () => {
    const out = sortSelectChildren([opt('c', 'vcenter-10'), opt('a', 'vcenter-2'), opt('b', 'Alpha'), opt('d', 'beta')]);
    expect(labels(out)).toEqual(['Alpha', 'beta', 'vcenter-2', 'vcenter-10']);
  });
  it('전체·선택·빈 값·__local__ 은 맨 위에 원래 순서로', () => {
    const out = sortSelectChildren([
      opt('', '전체 vCenter'), opt('__local__', '이 포탈에서 직접'), opt('z', 'Zeta'), opt('a', 'Alpha'), opt('all', '모든 종류'),
    ]);
    expect(labels(out)).toEqual(['전체 vCenter', '이 포탈에서 직접', '모든 종류', 'Alpha', 'Zeta']);
  });
  it('data-pin 은 고정', () => {
    const out = sortSelectChildren([opt('b', 'B'), opt('x', 'X 고정', { 'data-pin': true }), opt('a', 'A')]);
    expect(labels(out)).toEqual(['X 고정', 'A', 'B']);
  });
  it('map 배열·조건부 false·Fragment 를 평탄화한다', () => {
    const out = sortSelectChildren([
      false, h(React.Fragment, { key: 'f' }, opt('b', '나'), opt('a', '가')), ['다', '라'].map((x) => opt(x, x)).reverse(),
    ]);
    expect(labels(out)).toEqual(['가', '나', '다', '라']);
  });
  it('optgroup 은 자리를 지키고 안쪽만 정렬', () => {
    const g = h('optgroup', { label: 'G', key: 'g' }, opt('2', 'two'), opt('1', 'one'));
    const out = sortSelectChildren([opt('', '선택…'), g]);
    expect(out[1].type).toBe('optgroup');
    expect(labels(React.Children.toArray(out[1].props.children))).toEqual(['one', 'two']);
  });
  it('JSX 안 여러 조각 글자(문자열+숫자)를 이어 읽는다', () => {
    const out = sortSelectChildren([h('option', { value: 'b', key: 'b' }, 'host-', 10), h('option', { value: 'a', key: 'a' }, 'host-', 9)]);
    expect(labels(out)).toEqual(['host-9', 'host-10']);
  });
  it('고정 판정 — 데이터 값은 고정이 아니다', () => {
    expect(isPinnedOption(opt('vc-1', 'vcenter-1'))).toBe(false);
    expect(isPinnedOption(opt('', 'x'))).toBe(true);
    expect(isPinnedOption(opt('x', '— 자동 —'))).toBe(true);
  });
});

// 날 <select> 금지 — 새 드롭다운도 자동으로 정렬되게(eslint no-restricted-syntax 와 같은 규칙의 소스 스윕).
describe('날 <select> 금지', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.jsx$/.test(f.name)) files.push(p); } };
  walk(root);
  it('공용 컴포넌트 밖에서 <select·<datalist 가 0건', () => {
    const own = (p) => p.endsWith(path.join('components', 'Select.jsx')) || p.endsWith(path.join('components', 'DataList.jsx'));
    const bad = files.filter((p) => !own(p) && /<(select|datalist)\b/.test(fs.readFileSync(p, 'utf8'))).map((p) => path.relative(root, p));
    expect(bad).toEqual([]);
  });
  it('DataList 사용처가 import 를 갖는다', () => {
    const miss = files.filter((p) => { const s = fs.readFileSync(p, 'utf8'); return /<DataList\b/.test(s) && !/import DataList from '[^']*DataList\.jsx'/.test(s) && !p.endsWith('DataList.jsx'); });
    expect(miss.map((p) => path.relative(root, p))).toEqual([]);
  });
  it('Select 사용처가 import 를 갖는다', () => {
    const miss = files.filter((p) => { const s = fs.readFileSync(p, 'utf8'); return /<Select\b/.test(s) && !/import Select from '[^']*Select\.jsx'/.test(s) && !p.endsWith('Select.jsx'); });
    expect(miss.map((p) => path.relative(root, p))).toEqual([]);
  });
});
