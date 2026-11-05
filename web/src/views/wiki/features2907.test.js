/**
 * features2907.test.js — v2.907 기능 추천 1~5 화면 판정(정리 화면 주소 · 링크 갱신 안내).
 */
import { describe, expect, it } from 'vitest';
import { parseWikiHash, wikiHash } from './wikiText.js';
import { linkFixText } from './Wiki.jsx';

describe('v2.907 위키 정리 · 링크 갱신', () => {
  it("'정리' 화면 주소가 왕복한다", () => {
    expect(wikiHash({ space: 'pub', view: 'tidy' })).toBe('#/wiki/pub/tidy');
    expect(parseWikiHash('#/wiki/pub/tidy').view).toBe('tidy');
  });
  it('링크 갱신 안내 — 고친 수 · 못 고친 수 · 없으면 빈 글', () => {
    expect(linkFixText({ fixed: 2, skipped: 0 })).toMatch(/다른 문서 2개의 링크/);
    expect(linkFixText({ fixed: 1, skipped: 1 })).toMatch(/못 고친 문서 1개/);
    expect(linkFixText({ fixed: 0, skipped: 0 })).toBe('');
    expect(linkFixText(null)).toBe('');
  });
});
