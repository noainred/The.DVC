import { describe, it, expect } from 'vitest';
import { ratioOrNull, serverRatio, ratioLabel, ratioBadge, ratioKpi, numCell } from './virtRatioText.js';

describe('virtRatioText (v2.611 WEB2611-06)', () => {
  it('분모 0·결측이면 비율 null — 0 : 1 로 만들지 않는다', () => {
    expect(ratioOrNull(0, 0)).toBe(null);
    expect(ratioOrNull(10, 0)).toBe(null);
    expect(ratioOrNull(10, null)).toBe(null);
    expect(ratioOrNull(10, '')).toBe(null);
    expect(ratioOrNull(null, 8)).toBe(null);
    expect(ratioOrNull(16, 4)).toBe(4);
    expect(ratioOrNull(0, 4)).toBe(0);
  });
  it('서버 비율은 분모로 다시 판정한다', () => {
    expect(serverRatio(0, 0)).toBe(null);
    expect(serverRatio(0, 0, 100)).toBe(null);
    expect(serverRatio(3.5, 128)).toBe(3.5);
    expect(serverRatio(120, 2048, 100)).toBe(1.2);
  });
  it('미수집은 회색 배지 — 초록 정상 금지', () => {
    expect(ratioBadge(null, 'cpu')).toEqual({ cls: 'gray', text: '미수집' });
    expect(ratioBadge(null, 'mem').cls).toBe('gray');
    expect(ratioBadge(5, 'cpu')).toEqual({ cls: 'amber', text: '높음' });
    expect(ratioBadge(2, 'cpu')).toEqual({ cls: 'green', text: '정상' });
    expect(ratioBadge(1.6, 'mem').cls).toBe('amber');
  });
  it('표시는 단위 없이 —', () => {
    expect(ratioLabel(null)).toBe('—');
    expect(ratioLabel(2)).toBe('2 : 1');
    expect(numCell(null)).toBe('—');
    expect(numCell(undefined)).toBe('—');
    expect(numCell(0)).toBe('0');
    expect(numCell(1234)).toBe((1234).toLocaleString());
  });
  it('KPI 는 미수집을 초록으로 칠하지 않는다', () => {
    expect(ratioKpi(null, 'cpu').accent).not.toBe('var(--green)');
    expect(ratioKpi(null, 'mem').sub).toContain('미수집');
    expect(ratioKpi(5, 'cpu').accent).toBe('var(--amber)');
    expect(ratioKpi(1.2, 'mem').sub).toBe('물리 초과 할당');
  });
});
