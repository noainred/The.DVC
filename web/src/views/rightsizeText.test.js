import { describe, it, expect } from 'vitest';
import { suggestCell, heldNote, HELD_LABEL } from './rightsizeText.js';

// v2.604 감사 RECENT2604-04 — 피크 미확인으로 권고를 보류한 차원을 초록 '추천' 으로 그리지 않는다.
describe('suggestCell', () => {
  it('held 차원은 현재 사양이 아니라 권고 보류로 말한다', () => {
    const r = { suggestedVcpu: 2, suggestedRamGB: 16, held: ['mem'] };
    expect(suggestCell(r, 'mem')).toEqual(expect.objectContaining({ held: true, label: HELD_LABEL }));
    expect(suggestCell(r, 'cpu')).toEqual({ held: false, text: '2' });
  });
  it('held 가 없으면 그대로 추천값', () => {
    expect(suggestCell({ suggestedVcpu: 4, suggestedRamGB: 8 }, 'mem')).toEqual({ held: false, text: '8GB' });
    expect(suggestCell({ suggestedVcpu: 4, suggestedRamGB: 8, held: ['cpu'] }, 'cpu').held).toBe(true);
  });
  it('값이 없으면 단위를 붙이지 않는다', () => {
    expect(suggestCell({ suggestedRamGB: null }, 'mem')).toEqual({ held: false, text: '—' });
  });
});

describe('heldNote', () => {
  it('보류 행이 있을 때만 개수와 함께 말한다', () => {
    expect(heldNote([{ held: ['mem'] }, {}, { held: ['cpu', 'mem'] }])).toContain('2대');
    expect(heldNote([{}, { held: [] }])).toBe('');
  });
});
