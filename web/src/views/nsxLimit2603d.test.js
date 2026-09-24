import { describe, it, expect } from 'vitest';
import { nsxLimitNotes, nsxFailedShort } from './nsxLimitText.js';

// v2.603 감사 COL-2603-04·05 — 서버가 싣는 규칙 조회 실패·IDS 이벤트 상한·IDS/라이선스 조회 실패를 화면이 말한다.
describe('nsxLimitText v2.603', () => {
  it('규칙 목록을 읽지 못한 정책 수를 말한다(규칙 0개가 아니다)', () => {
    const notes = nsxLimitNotes([{ name: 'M1', firewall: { policies: 3, rules: 5, rulesFailed: 2, rulesPartial: true } }]);
    expect(notes.some((n) => /DFW 정책 2개의 규칙 목록을 읽지 못했습니다/.test(n))).toBe(true);
  });
  it('IDS 이벤트 상한에 닿으면 하한이라고 말한다', () => {
    const notes = nsxLimitNotes([{ name: 'M1', idsEventsTruncated: true }]);
    expect(notes.some((n) => /IDS 이벤트가 조회 상한/.test(n))).toBe(true);
  });
  it('IDS·라이선스 조회 실패를 한글 라벨로 말한다', () => {
    const notes = nsxLimitNotes([{ name: 'M1', listsFailed: ['idsProfiles', 'idsEvents', 'licenses'] }]);
    expect(notes[0]).toContain('IDS 프로파일·IDS 이벤트·라이선스');
    expect(nsxFailedShort({ listsFailed: { licenses: 1 } })).toBe('조회 실패: 라이선스');
  });
  it('실패·상한이 없으면 새 문구가 없다', () => {
    expect(nsxLimitNotes([{ name: 'M1', firewall: { policies: 1, rules: 2 } }])).toEqual([]);
  });
});
