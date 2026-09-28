// v2.634 — 미갱신 서버 안내(사용자 신고 '측정 서버 0/980 · 미갱신 975').
import { describe, it, expect } from 'vitest';
import { spanText, staleCardMeta, staleBannerText } from './roomTempView.js';

const MIN = 60_000;

describe('spanText', () => {
  it('값이 없으면 null(0초로 만들지 않는다)', () => {
    expect(spanText(null)).toBe(null);
    expect(spanText('')).toBe(null);
    expect(spanText(-1)).toBe(null);
  });
  it('단위', () => {
    expect(spanText(30_000)).toBe('30초');
    expect(spanText(15 * MIN)).toBe('15분');
    expect(spanText(90 * MIN)).toBe('1.5시간');
  });
});

describe('staleCardMeta', () => {
  it('넓히지 않았으면 예전 문구 + 가장 최근 표본 나이', () => {
    expect(staleCardMeta({ staleMs: 15 * MIN, staleMsMax: 15 * MIN, totals: { staleNewestAgeMs: 20 * MIN } }))
      .toBe('15분 이상 갱신 없음 — 집계 제외(동결값 방지) · 빠진 것 중 가장 최근 표본 20분 전');
  });
  it('넓혔으면 그 사실을 말한다(15분이라 적고 41분을 쓰면 거짓)', () => {
    const m = staleCardMeta({ staleMs: 15 * MIN, staleMsMax: 41 * MIN, totals: {} });
    expect(m).toContain('최대 41분까지 넓힘');
  });
  it('구버전 서버 응답(새 필드 없음)도 깨지지 않는다', () => {
    expect(staleCardMeta({ staleMs: 15 * MIN, totals: {} })).toBe('15분 이상 갱신 없음 — 집계 제외(동결값 방지)');
  });
  it('백틱·별표를 쓰지 않는다(BoldText 없이 그려진다)', () => {
    const m = staleCardMeta({ staleMs: 15 * MIN, staleMsMax: 41 * MIN, totals: { staleNewestAgeMs: 5 * MIN } });
    expect(m).not.toMatch(/[`*]/);
  });
});

describe('staleBannerText', () => {
  it('정상이면 배너 없음', () => {
    expect(staleBannerText({ totals: { withData: 10, stale: 0 }, pollCycle: { durationMs: MIN, intervalMs: MIN } })).toBe(null);
    expect(staleBannerText({ totals: {} })).toBe(null);
  });
  it('주기가 간격의 3배를 넘으면 말한다', () => {
    const t = staleBannerText({ totals: { withData: 5, stale: 1 }, pollCycle: { durationMs: 20 * MIN, intervalMs: MIN, runningForMs: 3 * MIN } });
    expect(t).toContain('한 주기가 20분');
    expect(t).toContain('지금 주기 3분째');
    expect(t).not.toContain('넓혔습니다');
    const w = staleBannerText({ staleMs: 15 * MIN, staleMsMax: 41 * MIN, totals: { withData: 5, stale: 1 }, pollCycle: { durationMs: 20 * MIN, intervalMs: MIN } });
    expect(w).toContain('최대 41분까지 넓혔습니다');
  });
  it('측정 0대 · 미갱신 N대면 두 가능성을 함께 말한다(단정하지 않는다)', () => {
    const t = staleBannerText({ totals: { withData: 0, stale: 975, staleNewestAgeMs: 16 * MIN }, pollCycle: null });
    expect(t).toContain('975대');
    expect(t).toContain('16분 전');
    expect(t).toContain('멈췄거나');
    expect(t).not.toMatch(/[`*]/);
  });
});
