/**
 * storageUnits 회귀 테스트(v2.406) — 용량 표시 단위(자동/PB/TB/GB).
 * 사용자 목적이 '사용량 증가 추적'이므로, TB/GB 고정에서 **증가분이 표시로 드러나는지**를
 * 핵심으로 고정한다(자동/PB 는 소수 둘째 자리에 묻힌다 — 그게 이 기능을 만든 이유).
 */

import { describe, it, expect } from 'vitest';
import { formatBytes, capacityTotals, normalizeUnit, UNIT_OPTIONS } from './storageUnits.js';

const TB = 1024 ** 4;

describe('formatBytes', () => {
  it('auto: 1024TB 미만은 TB, 이상은 PB(기존 동작 유지)', () => {
    expect(formatBytes(40.7 * TB, 'auto')).toBe('40.7 TB');
    expect(formatBytes(1331.2 * TB, 'auto')).toBe('1.30 PB');
  });

  it('tb 고정: 큰 값도 TB 로 — 천 단위 구분자 포함', () => {
    expect(formatBytes(1331.2 * TB, 'tb')).toBe('1,331.2 TB');
    expect(formatBytes(40.7 * TB, 'tb')).toBe('40.7 TB');
  });

  it('gb 고정: 정수 GB', () => {
    expect(formatBytes(1 * TB, 'gb')).toBe('1,024 GB');
    expect(formatBytes(0.5 * TB, 'gb')).toBe('512 GB');
  });

  it('pb 고정: 작은 값도 PB(0.04 PB)', () => {
    expect(formatBytes(40.7 * TB, 'pb')).toBe('0.04 PB');
  });

  it('핵심: PB 표기의 해상도(0.01 PB = 10.24 TB)보다 작은 증가는 auto/PB 에서 묻힌다', () => {
    // PB 는 소수 2자리라 10.24TB 단위로만 움직인다. 그보다 작은 하루치 증가(여기선 +5TB)는
    // 자동/PB 표기에서 같은 값으로 보인다 — 이 기능(TB/GB 고정)이 필요한 이유다.
    const before = 1331.2 * TB;
    const after = 1336.2 * TB; // +5 TB
    expect(formatBytes(before, 'auto')).toBe(formatBytes(after, 'auto'));
    expect(formatBytes(before, 'pb')).toBe(formatBytes(after, 'pb'));
    // TB/GB 고정에서는 그대로 드러난다.
    expect(formatBytes(before, 'tb')).not.toBe(formatBytes(after, 'tb'));
    expect(formatBytes(before, 'gb')).not.toBe(formatBytes(after, 'gb'));
  });

  it('TB 표기는 0.1TB(=102.4GB) 단위까지 보인다 — 그보다 작으면 GB 로 봐야 한다', () => {
    const a = 1331.20 * TB;
    const b = 1331.22 * TB; // +0.02 TB → 같은 0.1TB 버킷이라 TB 표기로는 같다
    expect(formatBytes(a, 'tb')).toBe(formatBytes(b, 'tb'));
    expect(formatBytes(a, 'gb')).not.toBe(formatBytes(b, 'gb'));
  });

  it('0 은 0, 널/빈 값/숫자 아님은 — (v2.594 — 못 읽은 값을 0 으로 그리지 않는다)', () => {
    expect(formatBytes(0, 'tb')).toBe('0.0 TB');
    expect(formatBytes(null, 'tb')).toBe('—');
    expect(formatBytes(undefined, 'tb')).toBe('—');
    expect(formatBytes('', 'tb')).toBe('—');
    expect(formatBytes('x', 'gb')).toBe('—');
  });

  it('capacityTotals — 사용량 결측 장비는 사용률 분모에서 빼고 개수를 밝힌다(v2.594)', () => {
    const rows = [
      { c: { totalBytes: 100, usedBytes: 80 } },
      { c: { totalBytes: 100, usedBytes: null } },
      { c: null },
      { c: { totalBytes: 0, usedBytes: 0 } },
    ];
    const t = capacityTotals(rows, (r) => r.c);
    expect(t.total).toBe(200);
    expect(t.used).toBe(80);
    expect(t.pct).toBe(80);          // 예전 방식이면 40
    expect(t.unknownUsed).toBe(1);
    const none = capacityTotals([{ c: { totalBytes: 50, usedBytes: null } }], (r) => r.c);
    expect(none.used).toBe(null);
    expect(none.pct).toBe(null);
    expect(capacityTotals([], (r) => r.c)).toMatchObject({ total: 0, used: 0, pct: null });
  });
});

describe('normalizeUnit', () => {
  it('모르는 값은 auto 로 떨어진다(저장된 값이 깨져도 화면이 안 깨지게)', () => {
    expect(normalizeUnit('nope')).toBe('auto');
    expect(normalizeUnit(undefined)).toBe('auto');
    for (const u of UNIT_OPTIONS) expect(normalizeUnit(u.value)).toBe(u.value);
  });
});

describe('alertTotals (v2.602 RECENT2602-02 후속)', () => {
  it('경보 개수를 못 읽은 장비(null)는 0 으로 더하지 않고 unknown 으로 센다', async () => {
    const { alertTotals } = await import('./storageUnits.js');
    const rows = [{ a: 3 }, { a: null }, { a: 0 }, { a: undefined }, { a: '' }];
    expect(alertTotals(rows, (r) => r.a)).toEqual({ total: 3, unknown: 3, counted: 2 });
    expect(alertTotals([], (r) => r.a)).toEqual({ total: 0, unknown: 0, counted: 0 });
  });
  it('화면은 (f(x) || 0) 합산을 쓰지 않고 미확인 대수를 KPI 에 밝힌다(소스)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./StorageMonTool.jsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/f\(x\) \|\| 0/);
    expect(src).toMatch(/경보 미확인 \$\{totals\.alertsUnknown\}대/);
  });
});
