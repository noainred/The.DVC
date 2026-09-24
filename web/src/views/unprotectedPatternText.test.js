import { describe, it, expect } from 'vitest';
import { unprotectedPatternNote } from './unprotectedPatternText.js';

describe('unprotectedPatternNote (WEB2607-07)', () => {
  it('버린 패턴 수와 실제 사용 패턴을 말한다', () => {
    const t = unprotectedPatternNote({ patterns: ['veeam', 'commvault'], patternsOmitted: 1, maxPatterns: 32, maxPatternLen: 64 });
    expect(t).toMatch(/1개는 상한\(최대 32개·각 64자\)/);
    expect(t).toMatch(/veeam, commvault/);
  });
  it('버린 것이 없으면 빈 문자열', () => {
    expect(unprotectedPatternNote({ patterns: ['a'], patternsOmitted: 0 })).toBe('');
    expect(unprotectedPatternNote(undefined)).toBe('');
  });
});
