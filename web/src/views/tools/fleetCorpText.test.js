import { describe, it, expect } from 'vitest';
import { inCorp, corpOptions, bulkConfirmText, dcAssignDoneText, CORP_SRC, UNASSIGNED } from './fleetCorpText.js';

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
    expect(Object.keys(CORP_SRC).sort()).toEqual(['agent', 'manual', 'scan', 'vcenter', 'vcgroup']);
  });
  it('일괄 문구 · 완료 문구(실패 본문은 던진다)', () => {
    expect(bulkConfirmText(3, 'dc', 'NJ')).toBe("선택한 3대의 법인(DataCenter)을(를) 'NJ'(으)로 지정할까요?");
    expect(bulkConfirmText(2, 'dc', '')).toMatch(/자동 판정/);
    expect(bulkConfirmText(2, 'vc', '')).not.toMatch(/자동 판정/);
    expect(dcAssignDoneText({ ok: true, changed: 1, total: 3 })).toBe('3대 중 1대의 법인 지정을 바꿨습니다(나머지는 이미 같은 값).');
    expect(() => dcAssignDoneText({ ok: false, reason: '없는 법인' })).toThrow('없는 법인');
    expect(dcAssignDoneText({ ok: true })).toMatch(/응답에 없습니다/);
  });
});
