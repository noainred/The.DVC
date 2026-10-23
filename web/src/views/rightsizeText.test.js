import { describe, it, expect } from 'vitest';
import { suggestCell, heldNote, HELD_LABEL, HELD_SPEC_LABEL } from './rightsizeText.js';

// v2.604 감사 RECENT2604-04 — 피크 미확인으로 권고를 보류한 차원을 초록 '추천' 으로 그리지 않는다.
describe('suggestCell', () => {
  it('held 차원은 현재 사양이 아니라 권고 보류로 말한다', () => {
    const r = { vcpu: 4, ramGB: 32, suggestedVcpu: 2, suggestedRamGB: 16, held: ['mem'] };
    expect(suggestCell(r, 'mem')).toEqual(expect.objectContaining({ held: true, label: HELD_LABEL }));
    expect(suggestCell(r, 'cpu')).toEqual({ held: false, text: '2' });
  });
  it('held 가 없으면 그대로 추천값', () => {
    expect(suggestCell({ suggestedVcpu: 4, suggestedRamGB: 8 }, 'mem')).toEqual({ held: false, text: '8GB' });
    expect(suggestCell({ suggestedVcpu: 4, suggestedRamGB: 8, held: ['cpu'] }, 'cpu').held).toBe(true);
  });
  // v2.762(H-S1): 피크는 읽었고 현재 사양을 못 읽은 행에 '피크 미확인' 이라고 하지 않는다.
  it('현재 사양을 못 읽어 보류한 차원은 사양 미확인으로 말한다', () => {
    const r = { vcpu: 4, ramGB: null, memMax: 10, cpuMax: 20, suggestedVcpu: 2, suggestedRamGB: null, held: ['mem'] };
    expect(suggestCell(r, 'mem')).toEqual(expect.objectContaining({ held: true, label: HELD_SPEC_LABEL }));
    expect(suggestCell({ vcpu: null, ramGB: 8, held: ['cpu'] }, 'cpu').label).toBe(HELD_SPEC_LABEL);
    expect(suggestCell({ vcpu: 4, ramGB: 8, cpuMax: null, held: ['cpu'] }, 'cpu').label).toBe(HELD_LABEL);
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
