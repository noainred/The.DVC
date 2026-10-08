import { describe, it, expect } from 'vitest';
import { roleLabel, generatedAtText, SEARCH_PLACEHOLDER } from './headerText.js';

describe('headerText(v2.727) — 헤더 역할 표기', () => {
  it('① super_admin 은 요청 문맥 표지(superAdmin)로 판정한다 — role 원문을 보이지 않는다', () => {
    expect(roleLabel({ role: 'admin', superAdmin: true })).toBe('슈퍼 관리자');
    expect(roleLabel({ role: 'super_admin' })).toBe('super_admin'); // 접히지 않은 원문은 지어내지 않는다
  });
  it('② 데모 계정이 역할보다 먼저다', () => {
    expect(roleLabel({ role: 'admin', demoGuest: true })).toBe('데모 계정');
    expect(roleLabel({ role: 'admin', demoGuest: true, superAdmin: true })).toBe('데모 계정');
  });
  it('③ 세 역할은 한글이고 모르는 역할·빈 사용자는 원문/빈 문자열', () => {
    expect(roleLabel({ role: 'admin' })).toBe('관리자');
    expect(roleLabel({ role: 'operator' })).toBe('운영자');
    expect(roleLabel({ role: 'viewer' })).toBe('조회자');
    expect(roleLabel({ role: 'auditor' })).toBe('auditor');
    expect(roleLabel(null)).toBe('');
  });
  it('④ 수집 시각은 읽지 못하면 빈 문자열(— 를 붙이지 않는다)', () => {
    expect(generatedAtText(null)).toBe('');
    expect(generatedAtText('not-a-date')).toBe('');
    expect(generatedAtText('2026-10-08T12:46:25Z')).toMatch(/\d/);
  });
  it('⑤ 검색 문구는 VM 이름을 약속하지 않는다(팔레트는 기능·화면만 찾는다)', () => {
    expect(SEARCH_PLACEHOLDER).not.toMatch(/VM/);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../test/_stripComments.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appSrc = stripComments(fs.readFileSync(path.join(here, '..', 'App.jsx'), 'utf8'));
const css = stripComments(fs.readFileSync(path.join(here, '..', 'styles.css'), 'utf8'));

describe('헤더 C안(v2.727) — 소스 계약', () => {
  it('⑥ 역할 칸은 roleLabel 하나 — super_admin 원문을 헤더에 그리지 않는다', () => {
    expect(appSrc).toMatch(/className="user-role muted">\{roleLabel\(user\)\}/);
    expect(appSrc).not.toMatch(/\?\s*'super_admin'\s*:/);
  });
  it('⑦ .user-role 에 text-transform 이 없다(capitalize 가 Super_admin 을 만들었다)', () => {
    const rule = css.match(/\.user-role\s*\{[^}]*\}/);
    expect(rule).toBeTruthy();
    expect(rule[0]).not.toMatch(/text-transform/);
  });
  it('⑧ ⌘K 단축키는 기본 셸에서만 — V4·V5·V6·콘솔이 켜져 있으면 걸지 않는다(두 번 열림 방지)', () => {
    expect(appSrc).toMatch(/if \(consoleOn \|\| v4On \|\| v5On \|\| v6On\) return undefined;/);
    expect(appSrc).toMatch(/<Palette includePages=\{false\}/);
  });
  it('⑨ 검색·팔레트 CSS 는 .topbar / .tb- / .hdr-palette 아래로만(V4 셸 v4.css 와 섞이지 않게)', () => {
    const sels = [...css.matchAll(/(^|\})\s*([^{}@]+)\{/g)].map((m) => m[2].trim()).filter((s) => /tb-search|tb-cmdk|v4-palette|v3-/.test(s));
    expect(sels.length).toBeGreaterThan(5);
    for (const s of sels) for (const part of s.split(',')) expect(part.trim()).toMatch(/^(\.topbar|\.tb-cmdk|\.hdr-palette)/);
  });
});
