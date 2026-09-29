// v2.655 — GPU 추이 집계 단위 화면 판정(순수 함수).
import { describe, it, expect } from 'vitest';
import { GPU_HIST_BUCKETS, periodAllowed, fitPeriod, bucketNote } from './GpuHistModal.jsx';

describe('GPU 추이 집계 단위', () => {
  it('키는 서버와 같다', () => {
    expect(GPU_HIST_BUCKETS.map(([k]) => k)).toEqual(['auto', '1m', '10m', '1h', '6h']);
  });
  it('점 3,000개를 넘는 기간은 막는다', () => {
    expect(periodAllowed('auto', 1830)).toBe(true);
    expect(periodAllowed('1m', 1)).toBe(true);
    expect(periodAllowed('1m', 7)).toBe(false);
    expect(periodAllowed('10m', 7)).toBe(true);
    expect(periodAllowed('10m', 30)).toBe(false);
    expect(periodAllowed('1h', 30)).toBe(true);
    expect(periodAllowed('1h', 365)).toBe(false);
    expect(periodAllowed('6h', 365)).toBe(true);
    expect(periodAllowed('6h', 1830)).toBe(false);
  });
  it('단위를 바꾸면 되는 가장 긴 기간으로 줄인다', () => {
    expect(fitPeriod('1m', 30)).toBe(1);
    expect(fitPeriod('10m', 365)).toBe(7);
    expect(fitPeriod('6h', 1830)).toBe(365);
    expect(fitPeriod('1h', 7)).toBe(7);
  });
  it('안내는 단위·잘림·수집 주기를 말하고, 값이 없으면 비운다', () => {
    expect(bucketNote({}, '')).toBe('');
    expect(bucketNote({ bucketMs: 600_000 }, '10분')).toContain('집계 단위 10분');
    expect(bucketNote({ bucketMs: 60_000, sampleSec: 60 }, '1분')).toContain('같은 값이 이어지거나');
    expect(bucketNote({ bucketMs: 3_600_000, sampleSec: 60 }, '1시간')).not.toContain('같은 값');
    expect(bucketNote({ bucketMs: 60_000, truncated: true, coveredSince: Date.UTC(2026, 0, 2, 3, 4), limit: 3000 }, '1분')).toContain('이후만 그렸습니다');
  });
});
