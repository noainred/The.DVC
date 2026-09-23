// v2.582 BUG-3 — 브라우저 쪽 날짜 표기는 로컬 날짜이고, 뷰에 UTC 날짜(toISOString().slice(0,10))가 남아 있지 않다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dayStamp } from './dayStamp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== 'intro') walk(p, out); } else if (/\.(jsx?|tsx?)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

describe('dayStamp', () => {
  it('로컬 날짜 구성요소를 쓴다(UTC 가 아니다)', () => {
    const d = new Date(2026, 8, 23, 0, 30); // 로컬 2026-09-23 00:30 — UTC 로는 (KST 기준) 22일 15:30
    expect(dayStamp(d)).toBe('2026-09-23');
    expect(dayStamp(d.getTime())).toBe('2026-09-23');
  });
  it('못 읽으면 빈 문자열', () => {
    expect(dayStamp(NaN)).toBe('');
    expect(dayStamp('abc')).toBe('');
    expect(dayStamp(new Date('x'))).toBe('');
  });
  it('스윕 — 뷰·컴포넌트에 new Date().toISOString().slice(0, 10) 이 남아 있지 않다', () => {
    const bad = [];
    for (const f of walk(HERE)) {
      if (f.endsWith('dayStamp.js')) continue;
      const s = fs.readFileSync(f, 'utf8');
      if (/toISOString\(\)\.slice\(0, ?10\)/.test(s) || /toISOString\(\)\.split\('T'\)\[0\]/.test(s)) bad.push(path.relative(HERE, f));
    }
    expect(bad).toEqual([]);
  });
});
