/**
 * v2.732 점검 2회차 그룹 f — B1-02: 진단 › 서버 메모리(누수 추적)의 '표본 N건'.
 *   서버 memtrack.memMeta 는 v2.731(A6-04)부터 표본 수를 세지 않는다(count: null — SQLite·NDJSON 폴백 둘 다 metaRange 를 가진다).
 *   화면은 `count || 0` 이라 표본이 수십만 건이어도 언제나 '표본 0건' 이라고 말했다(결측을 0 으로 — v2.525·v2.561 규약 위반).
 *   이제 count 를 모르면 표본 수 조각을 빼고 수집 개시만 말한다. 숫자로 받은 count(옛 서버의 meta())만 '표본 N건' 이다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { memMetaText } from './Diagnostics.jsx';
import { stripComments } from '../test/_stripComments.js';

// 경계에서 떨어진 고정 시각(Date.now() 를 쓰지 않는다)
const FIRST = Date.UTC(2025, 5, 15, 3, 30, 0);
const dateText = new Date(FIRST).toLocaleDateString('ko-KR');

describe('B1-02 memMetaText — 세지 않은 표본 수를 0건으로 말하지 않는다', () => {
  it('count:null(지금 서버의 기본) → 표본 수 없이 수집 개시만', () => {
    const t = memMetaText({ firstTs: FIRST, lastTs: FIRST + 86_400_000, count: null });
    expect(t).not.toMatch(/표본/);
    expect(t).not.toMatch(/0건/);
    expect(t).toBe(`수집 개시 ${dateText}`);
  });
  it('count 를 숫자로 받으면(옛 서버 meta()) 예전처럼 표본 N건 · 수집 개시', () => {
    expect(memMetaText({ firstTs: FIRST, count: 1234 })).toBe(`표본 ${(1234).toLocaleString()}건 · 수집 개시 ${dateText}`);
    // 실제로 0건이라고 셌다면 0건이 맞다(세지 않은 것과 다르다)
    expect(memMetaText({ firstTs: null, count: 0 })).toBe('표본 0건');
  });
  it('결측 형태(undefined·빈 문자열·객체 없음)는 0 으로 둔갑하지 않는다', () => {
    expect(memMetaText({ firstTs: FIRST })).toBe(`수집 개시 ${dateText}`);
    expect(memMetaText({ firstTs: FIRST, count: '' })).toBe(`수집 개시 ${dateText}`);
    expect(memMetaText({ count: null, firstTs: null })).toBe('');
    expect(memMetaText(null)).toBe('');
    expect(memMetaText(undefined)).toBe('');
  });
  it('화면이 이 함수를 쓰고 `count || 0` 을 되살리지 않는다(주석 제거 후 소스 검사)', () => {
    const src = stripComments(fs.readFileSync(new URL('./Diagnostics.jsx', import.meta.url), 'utf8'));
    expect(src).not.toMatch(/meta\?\.count\s*\|\|\s*0/);
    expect(src).toMatch(/\{memMetaText\(mem\.meta\)\}/);
  });
});
