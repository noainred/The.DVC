// palette2932.test.js — v2.932 최근 변경 점검 확정분(묶음 usage-login: C1-05 · C1-06) ⌘K 찾기(Palette.jsx) 회귀.
//  C1-05 한글 조합 중 Enter · Tab · Esc 를 선택 · 칩 순환 · 닫기로 먹지 않는다 — onKey 첫 줄이 조합 판정(isComposing · 229).
//        같은 판정을 쓰는 형제(MentionBox · Wiki · IssuesPlus — docs/rules/web.md v2.904)도 함께 대조한다.
//  C1-06 '직전 검색 복원' 이 계정을 구분한다 — 다른 계정이면 복원하지 않고 지운다(로그아웃은 새로 고침 없이 화면만 바꾼다).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { rememberLastSearch, takeLast } from './Palette.jsx';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const IME_GUARD = /^\s*if \(e\.nativeEvent\?\.isComposing \|\| e\.keyCode === 229\) return;/;

describe('C1-05 한글 조합 판정(소스 대조)', () => {
  it('Palette onKey 의 첫 줄이 조합 판정이다(Escape · Enter · Tab 판정보다 앞)', () => {
    const lines = read('./Palette.jsx').split('\n');
    const i = lines.findIndex((l) => /^\s*const onKey = \(e\) => \{\s*$/.test(l));
    expect(i, 'onKey 정의').toBeGreaterThan(-1);
    expect(lines[i + 1], 'onKey 첫 줄').toMatch(IME_GUARD);
    const body = lines.slice(i + 1, i + 20).join('\n');
    for (const k of ["e.key === 'Escape'", "e.key === 'Enter'", "e.key === 'Tab'"]) {
      expect(body.indexOf(k), k).toBeGreaterThan(body.indexOf('isComposing'));
    }
  });
  it('형제 입력칸도 같은 판정을 유지한다(MentionBox · Wiki · IssuesPlus · FeatureUsage 제외 계정 — v2.932)', () => {
    for (const rel of ['./MentionBox.jsx', '../views/wiki/Wiki.jsx', '../views/issues/IssuesPlus.jsx', '../views/FeatureUsage.jsx']) {
      expect(read(rel), rel).toMatch(/e\.nativeEvent\?\.isComposing \|\| e\.keyCode === 229\) return;/);
    }
  });
});

describe('C1-06 직전 검색 복원은 계정별', () => {
  const T0 = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * 60_000;
  it('같은 계정 · 10분 안이면 복원한다', () => {
    rememberLastSearch({ q: '10.20.1.7', kindSel: 'vm', username: 'alice', now: T0 });
    expect(takeLast('alice', T0 + 60_000)).toMatchObject({ q: '10.20.1.7', kindSel: 'vm' });
  });
  it('다른 계정이면 복원하지 않고 지운다(그 뒤 원래 계정도 복원 없음)', () => {
    rememberLastSearch({ q: 'SN-1234', username: 'alice', now: T0 });
    expect(takeLast('bob', T0 + 60_000)).toBe(null);
    expect(takeLast('alice', T0 + 61_000), '다른 계정이 연 순간 버렸다').toBe(null);
  });
  it('10분이 지나면 버린다(예전 그대로)', () => {
    rememberLastSearch({ q: 'web01', username: 'alice', now: T0 });
    expect(takeLast('alice', T0 + 10 * 60_000 + 1)).toBe(null);
  });
  it('화면은 로그인 계정을 넘겨 저장 · 복원한다(소스 대조)', () => {
    const src = read('./Palette.jsx');
    expect(src).toMatch(/useState\(\(\) => takeLast\(username\)\)/);
    expect(src).toMatch(/rememberLastSearch\(\{ q, kindSel, username \}\)/);
    expect(src, '모듈 변수를 직접 쓰는 곳이 남지 않는다').not.toMatch(/^\s*if \(q\.trim\(\)\) _lastSearch = /m);
  });
});
