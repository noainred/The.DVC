import { describe, it, expect } from 'vitest';
import { nsxLimitNotes, dfwRulesCell } from './nsxLimitText.js';

describe('nsxLimitNotes (v2.599 C2599-05)', () => {
  it('절단·생략·하한을 각각 말한다', () => {
    const notes = nsxLimitNotes([
      { name: 'M1', listsTruncated: ['groups', 'segments'], firewall: { policies: 70, rules: 200, policiesOmitted: 10, policiesRuleLimit: 60, rulesPartial: true } },
      { name: 'M2', firewall: { policies: 3, rules: 9 } },
    ], [{ portsTruncated: true }, {}]);
    expect(notes).toHaveLength(4);
    expect(notes[0]).toMatch(/보안그룹·세그먼트/);
    expect(notes[1]).toMatch(/70개 중 10개/);
    expect(notes[2]).toMatch(/하한/);
    expect(notes[3]).toMatch(/세그먼트 1개/);
    expect(notes.join('')).not.toMatch(/`/);
  });
  it('v2.600 COL-2600-06: 조회 실패 목록은 0 이 아니라 확인 불가라고 말한다', () => {
    const notes = nsxLimitNotes([{ name: 'M1', listsFailed: ['segments', 'securityPolicies'], firewall: { policies: null, rules: null, failed: true } }], []);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/세그먼트·DFW 정책 목록을 읽지 못했습니다/);
    expect(notes[0]).toMatch(/확인 불가/);
    expect(dfwRulesCell({ firewall: { policies: null, rules: null, failed: true } })).toBe('—');
  });
  it('아무 것도 잘리지 않았으면 빈 배열', () => {
    expect(nsxLimitNotes([{ name: 'M', firewall: { policies: 1, rules: 2 } }], [{}])).toEqual([]);
    expect(nsxLimitNotes(null, null)).toEqual([]);
  });
  it('DFW 칸 — 하한이면 +, 없으면 —', () => {
    expect(dfwRulesCell({ firewall: { rules: 5 } })).toBe('5');
    expect(dfwRulesCell({ firewall: { rules: 5, policiesOmitted: 2 } })).toBe('5+');
    expect(dfwRulesCell({ firewall: { rules: 0, rulesPartial: true } })).toBe('0+');
    expect(dfwRulesCell({})).toBe('—');
  });
});
