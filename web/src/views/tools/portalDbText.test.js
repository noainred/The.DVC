import { describe, it, expect } from 'vitest';
import { fmtBytes, fcText, perDayText, basisText, totalConfText, totalDailyMetaText } from './portalDbText.js';

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
  it('합계 신뢰도 문구는 낮음·보통이면 이유(짧은 관측에서 나온 증가 비율)를 함께 말한다', () => {
    expect(totalConfText({ available: true, confidence: 'low', shortShare: { under1d: 0.92, under7d: 0.92 } })).toBe('신뢰도 낮음 · 증가의 92%가 1일 미만 관측');
    expect(totalConfText({ available: true, confidence: 'medium', shortShare: { under1d: 0, under7d: 0.4 } })).toBe('신뢰도 보통 · 증가의 40%가 7일 미만 관측');
    expect(totalConfText({ available: true, confidence: 'high', shortShare: { under1d: 0, under7d: 0 } })).toBe('신뢰도 높음(7일+ 관측)');
    expect(totalConfText({ available: true, confidence: 'low' })).toBe('신뢰도 낮음');
    expect(totalConfText({ available: true, confidence: 'low', shortShare: { under1d: 0.996 } })).toBe('신뢰도 낮음 · 증가의 99%가 1일 미만 관측');
    expect(totalConfText({ available: true, confidence: 'low', shortShare: { under1d: 1 } })).toBe('신뢰도 낮음 · 증가의 100%가 1일 미만 관측');
    expect(totalConfText({ available: false, confidence: 'high' })).toBe('');
    expect(totalConfText(null)).toBe('');
  });
  it('합계 일 증가량 부가 문구 — 근거 · 미산정 · 감소 중 파일', () => {
    const files = [{ trend: { basis: 'daily', perDayBytes: 1 } }];
    expect(totalDailyMetaText({ files, perDayUnknown: 2, totalForecast: { available: true, shrinkingFiles: 1 } }))
      .toBe('일 표본 기울기(최근 30일) · 미산정 2개 제외 · 감소 중 1개는 증가 0으로 셈');
    expect(totalDailyMetaText({ files, perDayUnknown: 0, totalForecast: { available: true } })).toBe('일 표본 기울기(최근 30일)');
    expect(totalDailyMetaText({ files: [], totalForecast: { available: false, reason: '관측 30분 — 1시간 이상 필요(약 30분 뒤 표시)' } }))
      .toBe('관측 30분 — 1시간 이상 필요(약 30분 뒤 표시)');
    expect(totalDailyMetaText(null)).toBe('표본 부족');
  });
});
