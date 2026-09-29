// v2.655 — GPU 추이 집계 단위 화면 판정(순수 함수).
import { describe, it, expect } from 'vitest';
import { GPU_HIST_BUCKETS, periodAllowed, fitPeriod, bucketNote, gapRows, gapNote } from './GpuHistModal.jsx';

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

// v2.656 — 수집 공백 구간은 선을 잇지 않는다.
describe('GPU 추이 공백 끊기', () => {
  const H = 3_600_000;
  const T0 = 1_800_000_000_000;
  const pt = (h, v) => ({ ts: T0 + h * H, avg: v, max: v + 5 });
  it('단위 × 2 를 넘는 간격 사이에 빈 점을 넣는다', () => {
    const { rows, gaps } = gapRows([pt(0, 10), pt(1, 11), pt(2, 12), pt(8, 13), pt(9, 14)], H, 60);
    expect(gaps).toBe(1);
    const i = rows.findIndex((r) => r.gap);
    expect(rows[i - 1].ts).toBe(T0 + 2 * H);
    expect(rows[i].avg).toBeNull();
    expect(rows[i].max).toBeNull();
    expect(rows[i + 1].ts).toBe(T0 + 8 * H);
  });
  it('연속 구간은 그대로 — 빈 점 없음', () => {
    const { rows, gaps } = gapRows([pt(0, 1), pt(1, 2), pt(2, 3)], H, 60);
    expect(gaps).toBe(0);
    expect(rows).toHaveLength(3);
    expect(rows.some((r) => r.iso)).toBe(false);
  });
  it('양옆이 빈 외톨이 점은 iso 로 표시한다(선이 없어 사라지지 않게)', () => {
    const { rows } = gapRows([pt(0, 1), pt(1, 2), pt(5, 3), pt(9, 4), pt(10, 5)], H, 60);
    const lone = rows.find((r) => r.ts === T0 + 5 * H);
    expect(lone.iso).toBe(true);
    expect(rows.find((r) => r.ts === T0).iso).toBeUndefined();
  });
  it('수집 주기가 단위보다 길면 그 주기 × 2 가 기준이다', () => {
    const M = 60_000;
    const pts = [0, 5, 10, 15].map((m) => ({ ts: T0 + m * M, avg: 1, max: 1 }));
    expect(gapRows(pts, M, 300).gaps).toBe(0); // 수집 5분 — 1분 단위 칸이 비는 것은 공백이 아니다
    expect(gapRows(pts, M, 60).gaps).toBe(3);
  });
  it('단위를 모르면 간격 중앙값을 단위로 본다', () => {
    const { gaps } = gapRows([pt(0, 1), pt(1, 1), pt(2, 1), pt(3, 1), pt(9, 1)], null, null);
    expect(gaps).toBe(1);
  });
  it('null 값은 0 으로 바꾸지 않는다 · 순서가 섞여 와도 정렬한다', () => {
    const { rows } = gapRows([pt(1, null), pt(0, 5)], H, 60);
    expect(rows[0].avg).toBe(5);
    expect(rows[1].avg).toBeNull();
  });
  it('gapNote — 0 이면 빈 문자열', () => {
    expect(gapNote(0)).toBe('');
    expect(gapNote(2)).toContain('2곳');
  });
});
