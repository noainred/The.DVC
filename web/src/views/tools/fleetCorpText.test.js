import { describe, it, expect } from 'vitest';
import { inCorp, corpOptions, CORP_SRC, UNASSIGNED } from './fleetCorpText.js';

describe('fleetCorpText', () => {
  it('필터 — 법인 id · 미지정 · 전체', () => {
    expect(inCorp({ corpId: 'AZ' }, '')).toBe(true);
    expect(inCorp({ corpId: 'AZ' }, 'AZ')).toBe(true);
    expect(inCorp({ corpId: 'AZ' }, 'NJ')).toBe(false);
    expect(inCorp({ corpId: '' }, UNASSIGNED)).toBe(true);
    expect(inCorp({ corpId: 'AZ' }, UNASSIGNED)).toBe(false);
    expect(inCorp({}, UNASSIGNED)).toBe(true);
  });
  it('선택지는 서버 순서 그대로 + 대수', () => {
    expect(corpOptions([{ id: 'OC2', name: 'OC2', bm: 153, vh: 0 }, { id: UNASSIGNED, name: '미지정', bm: 1 }])).toEqual([
      { value: 'OC2', label: 'OC2 (물리 153 · 가상화 0)' }, { value: UNASSIGNED, label: '미지정 (물리 1 · 가상화 0)' }]);
    expect(corpOptions(null)).toEqual([]);
  });
  it('출처 이름은 서버 corp.js 의 src 와 같다', () => {
    expect(Object.keys(CORP_SRC).sort()).toEqual(['agent', 'scan', 'vcenter', 'vcgroup']);
  });
});
