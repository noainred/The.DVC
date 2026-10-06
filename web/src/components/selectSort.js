/**
 * selectSort.js — 드롭다운(<select>) 선택지 정렬(순수, v2.708 — 사용자 요청 "모든 드롭박스 메뉴를 정렬해서 보이게,
 * 앞으로 만드는 드롭박스도 정렬"). 화면은 `components/Select.jsx` 를 쓰고, 날 `<select>` 는 테스트가 금지한다.
 *
 * 규칙
 *  · 선택지는 **보이는 글자**(없으면 value)로 오름차순 — 숫자 인식·대소문자 무시(`vcenter-2` < `vcenter-10`).
 *  · **고정 선택지는 맨 위에 원래 순서로 둔다**: value 가 빈 값('')·`all`·`*`·`__…`(예: `__local__`) 이거나,
 *    글자가 '전체'·'모든'·'—'·'(' 로 시작하거나, `data-pin` 이 붙은 것. '전체 vCenter'·'선택…'·'— 자동 —' 이 정렬 중간에
 *    섞이면 고르는 사람이 그것을 찾지 못한다.
 *  · `<optgroup>` 은 자리를 지키고 그 안의 선택지를 같은 규칙으로 정렬한다.
 *  · 의미 순서가 곧 정보인 목록(기간·심각도·권장 먼저·단계)은 호출부가 `sort={false}` 로 끈다.
 */
import React from 'react';

const COLLATOR = (() => { try { return new Intl.Collator('ko', { numeric: true, sensitivity: 'base' }); } catch { return null; } })();
const cmp = COLLATOR ? (a, b) => COLLATOR.compare(a, b) : (a, b) => a.localeCompare(b, 'ko', { numeric: true, sensitivity: 'base' });

/** React 노드의 보이는 글자. */
export function optionText(node, depth = 0) {
  if (node == null || typeof node === 'boolean' || depth > 10) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((n) => optionText(n, depth + 1)).join('');
  if (React.isValidElement(node)) return optionText(node.props?.children, depth + 1);
  return '';
}

const PIN_VALUES = new Set(['', 'all', '*']);
const PIN_TEXT = /^\s*(전체|모든|—|-\s|\(|선택)/;

/** 맨 위에 고정할 선택지인가. */
export function isPinnedOption(el) {
  const p = el?.props || {};
  if (p['data-pin'] != null && p['data-pin'] !== false) return true;
  const v = p.value == null ? null : String(p.value);
  if (v != null && (PIN_VALUES.has(v) || v.startsWith('__'))) return true;
  return PIN_TEXT.test(optionText(p.children));
}

function flatten(children, out = []) {
  React.Children.forEach(children, (c) => {
    if (c == null || typeof c === 'boolean') return;
    if (React.isValidElement(c) && c.type === React.Fragment) { flatten(c.props.children, out); return; }
    out.push(c);
  });
  return out;
}

function sortList(items) {
  const pinned = []; const rest = []; const others = [];
  items.forEach((el, i) => {
    if (!React.isValidElement(el)) { others.push({ el, i }); return; }
    if (el.type === 'optgroup') { others.push({ el: React.cloneElement(el, {}, sortList(flatten(el.props.children))), i }); return; }
    if (el.type !== 'option') { others.push({ el, i }); return; }
    (isPinnedOption(el) ? pinned : rest).push({ el, i, t: optionText(el.props.children) || String(el.props.value ?? '') });
  });
  rest.sort((a, b) => cmp(a.t, b.t) || a.i - b.i);
  return [...pinned.map((x) => x.el), ...rest.map((x) => x.el), ...others.map((x) => x.el)];
}

/** <select> 자식들을 정렬한 배열(키는 React.Children 이 붙인 그대로 유지된다). */
export function sortSelectChildren(children) {
  const flat = flatten(children).map((c, i) => (React.isValidElement(c) && c.key == null ? React.cloneElement(c, { key: `__o${i}` }) : c));
  return sortList(flat);
}
