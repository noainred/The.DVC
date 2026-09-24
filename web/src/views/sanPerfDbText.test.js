import { describe, it, expect } from 'vitest';
import { countsAtNote } from './sanPerfDbText.js';

describe('countsAtNote', () => {
  const T = 1_750_000_000_000;
  it('집계 시각을 밝힌다', () => {
    expect(countsAtNote({ countsAt: T - 42_000 }, T)).toContain('42초 전 집계');
    expect(countsAtNote({ countsAt: T - 1_000 }, T)).toContain('방금 집계');
  });
  it('countsAt 이 없거나 모양이 틀리면 null(지어내지 않는다)', () => {
    expect(countsAtNote({}, T)).toBeNull();
    expect(countsAtNote({ countsAt: null }, T)).toBeNull();
    expect(countsAtNote({ countsAt: '123' }, T)).toBeNull();
    expect(countsAtNote(null, T)).toBeNull();
  });
});
