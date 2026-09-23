import { describe, it, expect } from 'vitest';
import { metricStats } from './vmMetricStats.js';

describe('metricStats (v2.598 VC2598-02)', () => {
  it('결측(null)은 평균·최대·마지막에 넣지 않는다', () => {
    const s = metricStats([{ v: 40 }, { v: null }, { v: 60 }, { v: null }]);
    expect(s.avg).toBe(50);            // 예전: (40+0+60+0)/4 = 25
    expect(s.peak).toBe(60);
    expect(s.last).toBe(60);           // 예전: 마지막 점 null
    expect(s.missing).toBe(2);
    expect(s.measured).toBe(2);
  });
  it('읽은 값이 없으면 전부 null', () => {
    expect(metricStats([{ v: null }])).toEqual({ last: null, avg: null, peak: null, missing: 1, measured: 0 });
    expect(metricStats([])).toMatchObject({ avg: null, peak: null, last: null });
  });
  it('0 은 값이다', () => {
    expect(metricStats([{ v: 0 }, { v: 0 }])).toMatchObject({ avg: 0, peak: 0, last: 0, missing: 0 });
  });
});
