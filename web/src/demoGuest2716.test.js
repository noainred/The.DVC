// demoGuest2716.test.js — mock 모드 내장 데모 계정(v2.716)의 화면 쪽 계약(소스 검사).
// 서버가 집행한다(auth/demoGuest.js) — 화면은 업그레이드 탭을 숨기고, 역할을 '관리자' 로 보이지 않게 한다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const read = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

describe('데모 계정 화면 계약', () => {
  const app = read('App.jsx');
  it('업그레이드 탭은 데모 계정에 숨긴다(isAllowed·visibleTabs 둘 다)', () => {
    expect(app).toMatch(/id: 'upgrade'[^\n]*noDemoGuest: true/);
    expect(app).toMatch(/!\(t\.noDemoGuest && user\.demoGuest\)/);
    expect(app).toMatch(/if \(t\.noDemoGuest && user\.demoGuest\) return false;/);
  });
  it('역할 표기는 admin 이 아니라 데모 계정이다(개발 포탈 · V4)', () => {
    // v2.727(헤더 C안): 개발 포탈 헤더는 views/headerText.js roleLabel 이 판정한다 — 데모 계정이 먼저다.
    expect(app).toMatch(/\{roleLabel\(user\)\}/);
    expect(read('views/headerText.js')).toMatch(/if \(user\.demoGuest\) return '데모 계정';/);
    expect(read('version_4/V4App.jsx')).toMatch(/user\?\.demoGuest \? '데모 계정'/);
  });
});
