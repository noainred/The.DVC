// v2.622(감사 DATA-06): 합집합이 하한이면 '최소 N명' 으로 말한다.
import { describe, it, expect } from 'vitest';
import { combinedNote, unionValueText } from './horizonSessionText.js';

describe('DATA-06 합집합 하한 표기', () => {
  it('unionLowerBound 면 카드 값과 문구가 최소 N명', () => {
    const c = { union: 4001, sum: 4001, both: 0, unionLowerBound: true, lowerBoundSources: [{ key: 'vdi', label: 'Horizon(VDI)' }] };
    expect(unionValueText(c)).toBe('최소 4001명');
    const t = combinedNote(c);
    expect(t).toContain('**최소 4001명**');
    expect(t).toContain('Horizon(VDI)');
    expect(t).not.toContain('`');
  });
  it('하한이 아니면 예전 그대로, 값이 없으면 —', () => {
    expect(unionValueText({ union: 3, sum: 3, both: 0 })).toBe('3명');
    expect(combinedNote({ union: 3, sum: 3, both: 0 })).not.toContain('최소');
    expect(unionValueText({ union: null })).toBe('—');
    expect(unionValueText(null)).toBe('—');
  });
});
