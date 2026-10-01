import { describe, it, expect } from 'vitest';
import { fmtBytes, fcText, perDayText, basisText } from './portalDbText.js';

describe('portalDbText (v2.674)', () => {
  const GB = 1024 ** 3;
  it('예측이 없으면 숫자를 지어내지 않는다', () => {
    expect(fcText({ available: false, in1w: null }, 'in1w')).toBe('—');
    expect(fcText(null, 'in1y')).toBe('—');
    expect(perDayText(0, { available: false })).toBe('—');
    expect(perDayText(null, { available: true })).toBe('—');
    expect(fmtBytes('')).toBe('—');
  });
  it('일 증가량은 부호·단위를 붙이고 0 은 변화 없음', () => {
    expect(perDayText(GB, { available: true })).toBe('+1.0 GB/일');
    expect(perDayText(-2 * GB, { available: true })).toBe('-2.0 GB/일');
    expect(perDayText(0, { available: true })).toBe('변화 없음');
    expect(fcText({ available: true, in1w: 7 * GB }, 'in1w')).toBe('7.0 GB');
  });
  it('근거 문구는 일 표본·최근 표본 개수를 말한다', () => {
    const f = (basis, perDayBytes = 1) => ({ trend: { basis, perDayBytes } });
    expect(basisText({ files: [f('daily'), f('daily')] })).toBe('일 표본 기울기(최근 30일)');
    expect(basisText({ files: [f('daily'), f('recent')] })).toBe('일 표본 1개 · 최근 표본 1개');
    expect(basisText({ files: [f('recent')] })).toBe('최근 표본 차이(관측 짧음)');
  });
});
