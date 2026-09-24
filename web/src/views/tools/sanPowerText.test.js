import { describe, it, expect } from 'vitest';
import { powerText, powerPartialOf } from './sanPowerText.js';

describe('sanPowerText (v2.601 COL-2601-06)', () => {
  it('전 PSU 값이 있으면 합만', () => {
    expect(powerText({ powerWatts: 480, psuDetail: [{ powerW: 240 }, { powerW: 240 }] })).toBe('480 W');
  });
  it('일부 PSU 값이 없으면 부분 합임을 밝힌다(psuDetail 폴백)', () => {
    expect(powerText({ powerWatts: 240, psuDetail: [{ powerW: 240 }, { powerW: null }] })).toBe('240 W (PSU 2개 중 1개 합 — 나머지는 값 없음)');
  });
  it('서버 powerPartial 이 우선', () => {
    expect(powerPartialOf({ powerPartial: { read: 1, total: 3 }, psuDetail: [] })).toEqual({ read: 1, total: 3 });
  });
  it('서버 powerPartial:null(전부 읽음)이면 잘린 psuDetail 로 다시 판정하지 않는다', () => {
    expect(powerPartialOf({ powerPartial: null, psuDetail: [{ powerW: 1 }, { powerW: null }] })).toBe(null);
  });
  it('값이 없으면 빈 문구(0 W 금지)', () => {
    expect(powerText({ powerWatts: null })).toBe('');
    expect(powerText({})).toBe('');
  });
});
