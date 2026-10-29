import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { forecastPctText, forecastLimitKind, forecastGpuLimitKind } from './forecastRowText.js';
import { stripComments } from '../test/_stripComments.js';

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

/*
 * v2.781(점검 G4 E-B1): 서버가 이미 한계에 닿은 항목에 `full: true` 를 싣는다(daysToLimit 은 null 그대로 — 계약 유지).
 *   판정은 forecastLimitKind 한 벌 — 예전에는 GPU 칸이 `daysToLimit == null ? '안정'` 을 따로 써서 100% GPU 를 '안정' 으로 그렸다.
 */

describe('E-B1 포화(full) 판정 한 벌 — DS·GPU', () => {
  it('서버 full 표지가 먼저다(용량 값이 없거나 숫자가 아니어도)', () => {
    expect(forecastLimitKind({ full: true, daysToLimit: null, current: 999.6, capacityGB: 1000, slopePerDay: 0 })).toBe('full');
    expect(forecastLimitKind({ full: true, daysToLimit: null, current: 1000 })).toBe('full');
    // 이상한 조합(full 인데 daysToLimit 값)이어도 '0일' 이 아니라 포화
    expect(forecastLimitKind({ full: true, daysToLimit: 0, current: 1000, capacityGB: 1000 })).toBe('full');
    // full:false 는 예전 판정 그대로
    expect(forecastLimitKind({ full: false, daysToLimit: 12, current: 900, capacityGB: 1000 })).toBe('days');
    expect(forecastLimitKind({ full: false, daysToLimit: null, current: 400, capacityGB: 1000 })).toBe('stable');
  });
  it('GPU — 100% 는 안정이 아니라 포화(구버전 서버처럼 full 이 없어도 current ≥ limit)', () => {
    expect(forecastGpuLimitKind({ current: 100, limit: 100, daysToLimit: null, slopePerDay: 1.38, full: true })).toBe('full');
    expect(forecastGpuLimitKind({ current: 100, limit: 100, daysToLimit: null, slopePerDay: 1.38 })).toBe('full');
    expect(forecastGpuLimitKind({ current: 100, daysToLimit: null })).toBe('full');          // limit 없음 → 100
    expect(forecastGpuLimitKind({ current: 100, limit: '', daysToLimit: null })).toBe('full'); // 못 읽은 limit 은 0 이 아니다 → 100
    expect(forecastGpuLimitKind({ current: 60, limit: 100, daysToLimit: 20 })).toBe('days');
    expect(forecastGpuLimitKind({ current: 60, limit: 100, daysToLimit: null, slopePerDay: -0.5 })).toBe('stable');
    expect(forecastGpuLimitKind({ current: null, limit: 100, daysToLimit: null })).toBe('stable');
  });
  it('Insights.jsx GPU 칸이 같은 판정을 쓴다(따로 만든 안정 분기 없음)', () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const src = stripComments(fs.readFileSync(path.join(dir, 'Insights.jsx'), 'utf8'));
    expect(src).toMatch(/forecastGpuLimitKind\(g\)/);
    expect(src).not.toMatch(/g\.daysToLimit\s*==\s*null\s*\?\s*'안정'/);
  });
});
