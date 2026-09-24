import { describe, it, expect } from 'vitest';
import { nsxLimitNotes, dfwRulesCell, nsxCount, nsxAdd, nsxFailedShort } from './nsxLimitText.js';
import { readFileSync } from 'node:fs';

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

describe('NSX 합계 표기 (v2.600 COL-2600-06 후속)', () => {
  it('null 은 0 도 null 도 아니라 — 이고, 합은 하나라도 모르면 모른다', () => {
    expect(nsxCount(null)).toBe('—');
    expect(nsxCount(undefined)).toBe('—');
    expect(nsxCount(0)).toBe('0');
    expect(nsxCount(12)).toBe('12');
    expect(nsxAdd(3, 4)).toBe(7);
    expect(nsxAdd(3, null)).toBe(null);
    expect(nsxCount(nsxAdd(null, 2))).toBe('—');
  });
  it('listsFailed 가 있으면 짧은 실패 문구, 없으면 빈 문자열', () => {
    expect(nsxFailedShort({ listsFailed: { segments: 1, securityPolicies: 2 } })).toBe('조회 실패: 세그먼트·DFW 정책');
    expect(nsxFailedShort({ segments: 3 })).toBe('');
    expect(nsxFailedShort(null)).toBe('');
  });
  it('세 화면이 null 합계를 직접 더하거나 그대로 찍지 않는다(소스)', () => {
    for (const f of ['./Nsx.jsx', '../version_4/pages/Network.jsx', '../console/pages/ConsoleNetwork.jsx']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(src, f).not.toMatch(/r\.hostNodes\s*\+\s*r\.edgeNodes|\(r\.hostNodes \?\? 0\) \+/);
      expect(src, f).not.toMatch(/Overlay \$\{r\.overlaySegments/);
      expect(src, f).not.toMatch(/r\.segments \?\? 0|m\.segments \?\? 0/);
      expect(src, f).toMatch(/nsxFailedShort\(r\)/);
    }
  });
});

describe('v2.602 COL-2602-01 — 클러스터 상태 조회 실패', () => {
  it('listsFailed 의 clusterStatus 를 한글 라벨로 말한다', () => {
    const notes = nsxLimitNotes([{ name: 'm1', listsFailed: ['clusterStatus'] }]);
    expect(notes.join('\n')).toMatch(/클러스터 상태 목록을 읽지 못했습니다/);
    expect(nsxFailedShort({ listsFailed: { clusterStatus: 1 } })).toBe('조회 실패: 클러스터 상태');
  });
  it('매니저 상태 unknown 에 라벨이 있다(원문 unknown 을 그대로 찍지 않는다)', () => {
    const src = readFileSync(new URL('./Nsx.jsx', import.meta.url), 'utf8');
    expect(src).toMatch(/unknown: '상태 확인 불가'/);
  });
});
