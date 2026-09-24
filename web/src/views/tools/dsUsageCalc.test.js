import { describe, it, expect } from 'vitest';
import { dsRowPct, dsAgg, dsUsedOf, dsUsageColor } from './dsUsageCalc.js';

describe('DS 사용량 계산 (v2.601 LO2601-04)', () => {
  const unknown = { capacityGB: 1000, usedGB: null, freeGB: null, usagePct: null };
  const known = { capacityGB: 1000, usedGB: 800, freeGB: 200, usagePct: 80 };
  it('사용량을 모르는 DS 의 행 사용률은 null(0% 가 아니다)', () => {
    expect(dsRowPct(unknown)).toBeNull();
    expect(dsUsedOf(unknown)).toBeNull();
    expect(dsUsageColor(null)).not.toBe('var(--green)');
  });
  it('usagePct 가 없으면 used/cap 또는 cap−free 로 계산, 보고된 0 은 값', () => {
    expect(dsRowPct({ capacityGB: 200, usedGB: 50 })).toBe(25);
    expect(dsRowPct({ capacityGB: 200, freeGB: 150 })).toBe(25);
    expect(dsRowPct({ capacityGB: 200, usedGB: 0, usagePct: 0 })).toBe(0);
  });
  it('합계는 사용량을 읽은 DS 끼리 — 모르는 DS 용량이 사용량으로 부풀지 않는다', () => {
    const a = dsAgg([known, unknown]);
    expect(a.capacityGB).toBe(2000);
    expect(a.usedGB).toBe(800); expect(a.freeGB).toBe(200);
    expect(a.pct).toBe(80); // 예전: cap 2000 − free 200 = 1800 → 90%
    expect(a.unknown).toBe(1);
  });
  it('전부 모르면 사용률 null', () => {
    expect(dsAgg([unknown, unknown]).pct).toBeNull();
    expect(dsAgg([]).pct).toBeNull();
  });
});
