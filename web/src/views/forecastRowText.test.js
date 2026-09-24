import { describe, it, expect } from 'vitest';
import { forecastPctText, forecastLimitKind } from './forecastRowText.js';

describe('용량예측 표 칸 (v2.601 WEB2601-07)', () => {
  it('usagePct null 은 — (예전: "%" 만)', () => {
    expect(forecastPctText(null)).toBe('—');
    expect(forecastPctText('')).toBe('—');
    expect(forecastPctText(0)).toBe('0%');
    expect(forecastPctText(87.5)).toBe('87.5%');
  });
  it('이미 한계에 닿은 DS 는 안정이 아니라 포화', () => {
    expect(forecastLimitKind({ daysToLimit: null, current: 1000, capacityGB: 1000, slopePerDay: 5 })).toBe('full');
    expect(forecastLimitKind({ daysToLimit: null, current: 1200, capacityGB: 1000, slopePerDay: -1 })).toBe('full');
    expect(forecastLimitKind({ daysToLimit: null, current: 400, capacityGB: 1000, slopePerDay: -1 })).toBe('stable');
    expect(forecastLimitKind({ daysToLimit: 12, current: 900, capacityGB: 1000, slopePerDay: 8 })).toBe('days');
  });
});
