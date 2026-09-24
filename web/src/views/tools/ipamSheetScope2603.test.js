// v2.603 감사 WEB2603-01 — IPAM '서브넷 대장(엑셀형)' 버튼이 React 클릭 이벤트를 vCenter id 로 넘겨 대장이 통째로 비던 결함.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sheetScopeArg } from './IpamCore.jsx';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', '..');

describe('WEB2603-01 sheetScopeArg', () => {
  it('클릭 이벤트(객체)·인자 없음은 현재 범위를 쓴다', () => {
    const fakeEvent = { type: 'click', target: {}, preventDefault() {} };
    expect(sheetScopeArg(fakeEvent, 'vc-a')).toBe('vc-a');
    expect(sheetScopeArg(undefined, 'vc-a')).toBe('vc-a');
    expect(sheetScopeArg(fakeEvent, '')).toBe('');
  });
  it('문자열 id 와 null(전체 — 스캔 칩)은 그대로', () => {
    expect(sheetScopeArg('vc-b', 'vc-a')).toBe('vc-b');
    expect(sheetScopeArg('', 'vc-a')).toBe('');
    expect(sheetScopeArg(null, 'vc-a')).toBeNull();
  });
});

// 전수 스윕 — 기본 인자를 받는 함수를 onClick 에 그대로 넘기면 클릭 이벤트가 그 인자가 된다.
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== 'node_modules') walk(p, out); }
    else if (/\.jsx$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('WEB2603-01 소스 스윕', () => {
  it('기본 인자 함수를 onClick 등 이벤트 핸들러에 직접 넘기는 곳 0건', () => {
    const hits = [];
    for (const f of walk(SRC)) {
      const s = fs.readFileSync(f, 'utf8');
      const names = new Set();
      for (const m of s.matchAll(/const\s+(\w+)\s*=\s*(?:async\s*)?\(\s*\w+\s*=[^=>]/g)) names.add(m[1]);
      for (const m of s.matchAll(/function\s+(\w+)\s*\(\s*\w+\s*=[^=>]/g)) names.add(m[1]);
      for (const n of names) {
        const re = new RegExp(`on(?:Click|Change|Submit|DoubleClick|KeyDown)=\\{${n}\\}`, 'g');
        for (const m of s.matchAll(re)) hits.push(`${path.relative(SRC, f)}:${s.slice(0, m.index).split('\n').length} ${m[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
