import { describe, it, expect } from 'vitest';
import { keepIfBlank } from './blankKeep.js';

describe('keepIfBlank (v2.600 T2600-05)', () => {
  it('빈 칸·공백·숫자 아님은 이전 값 유지', () => {
    expect(keepIfBlank('', 900_000, (n) => n * 1000)).toBe(900_000);
    expect(keepIfBlank('  ', 6)).toBe(6);
    expect(keepIfBlank('abc', 22)).toBe(22);
    expect(keepIfBlank(null, 300)).toBe(300);
  });
  it('숫자는 map 을 거친다 — 명시적 0 도 값', () => {
    expect(keepIfBlank('120', 900_000, (n) => Math.max(10, n) * 1000)).toBe(120_000);
    expect(keepIfBlank('0', 900_000, (n) => Math.max(10, n) * 1000)).toBe(10_000);
    expect(keepIfBlank('2222', 22, (n) => Math.max(1, n))).toBe(2222);
  });
});
