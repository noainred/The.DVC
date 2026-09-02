/**
 * storageUnits 회귀 테스트(v2.406) — 용량 표시 단위(자동/PB/TB/GB).
 * 사용자 목적이 '사용량 증가 추적'이므로, TB/GB 고정에서 **증가분이 표시로 드러나는지**를
 * 핵심으로 고정한다(자동/PB 는 소수 둘째 자리에 묻힌다 — 그게 이 기능을 만든 이유).
 */

import { describe, it, expect } from 'vitest';
import { formatBytes, normalizeUnit, UNIT_OPTIONS } from './storageUnits.js';

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

  it('0/널/NaN 은 0 으로 표기(호출부가 값 유무를 이미 판단한다)', () => {
    expect(formatBytes(0, 'tb')).toBe('0.0 TB');
    expect(formatBytes(null, 'tb')).toBe('0.0 TB');
    expect(formatBytes('x', 'gb')).toBe('0 GB');
  });
});

describe('normalizeUnit', () => {
  it('모르는 값은 auto 로 떨어진다(저장된 값이 깨져도 화면이 안 깨지게)', () => {
    expect(normalizeUnit('nope')).toBe('auto');
    expect(normalizeUnit(undefined)).toBe('auto');
    for (const u of UNIT_OPTIONS) expect(normalizeUnit(u.value)).toBe(u.value);
  });
});
