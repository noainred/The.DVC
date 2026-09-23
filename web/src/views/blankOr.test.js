import { describe, it, expect } from 'vitest';
import { blankOr } from './blankOr.js';

describe('blankOr', () => {
  it('빈 칸·null·숫자 아님은 undefined(보내지 않는다) · 명시적 0 은 0', () => {
    expect(blankOr('')).toBe(undefined);
    expect(blankOr('  ')).toBe(undefined);
    expect(blankOr(null)).toBe(undefined);
    expect(blankOr('x')).toBe(undefined);
    expect(blankOr('0')).toBe(0);
    expect(blankOr(12)).toBe(12);
    expect(JSON.stringify({ a: blankOr('') })).toBe('{}');
  });
});
