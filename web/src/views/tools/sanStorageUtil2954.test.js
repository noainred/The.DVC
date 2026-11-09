/**
 * v2.954(점검 B-5) — 회선 사용률 KPI 문구가 분모(지금 값이 있는 어레이의 포트 속도 합 — 서버 rowTotals)와 맞는다.
 */
import { describe, it, expect } from 'vitest';
import * as T from './sanStorageText.js';

describe('B-5 회선 사용률 분모 문구', () => {
  it('지금 값이 있는 어레이만이라고 밝힌다 · 백틱 없음', () => {
    const k = T.kpisOf({ totals: { nowBps: 1e9, avgBps: 1e9, speedSumBps: 4e9, arrays: 2, imbalance: 0, unmeasured: 1 }, counts: {}, allDatacenters: [] });
    const u = k.find((x) => x.k === 'util');
    expect(u.value).toBe('25.0');
    expect(u.meta).toMatch(/지금 값이 있는 어레이의 포트 속도 합/);
    expect(u.meta.includes('`')).toBe(false);
  });
});
