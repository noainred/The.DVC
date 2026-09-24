import { describe, it, expect } from 'vitest';
import { vcLogTotalText, vcLogCanLoadMore } from './vcLogPaging.js';

describe('vcLogPaging (그룹 f 이관 — vclogs totalCapped)', () => {
  it('상한에 닿았으면 N건 이상', () => {
    expect(vcLogTotalText({ total: 10000, totalCapped: true, totalCap: 10000 }, (n) => n.toLocaleString('en-US'))).toBe('10,000건 이상');
    expect(vcLogTotalText({ total: 42, totalCapped: false })).toBe('42건');
  });
  it('상한이면 마지막 응답이 limit 을 채웠을 때 계속 — 1만 행에서 멈추지 않는다', () => {
    expect(vcLogCanLoadMore({ loaded: 10000, total: 10000, totalCapped: true, lastBatch: 200, limit: 200 })).toBe(true);
    expect(vcLogCanLoadMore({ loaded: 10150, total: 10000, totalCapped: true, lastBatch: 150, limit: 200 })).toBe(false);
  });
  it('정확 COUNT 면 예전대로 loaded < total', () => {
    expect(vcLogCanLoadMore({ loaded: 200, total: 350, totalCapped: false, lastBatch: 200, limit: 200 })).toBe(true);
    expect(vcLogCanLoadMore({ loaded: 350, total: 350, totalCapped: false, lastBatch: 150, limit: 200 })).toBe(false);
  });
});
