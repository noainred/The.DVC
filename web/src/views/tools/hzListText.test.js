import { describe, it, expect } from 'vitest';
import { hzSummary } from './hzListText.js';

describe('WEB2612-04 Horizon 등록 목록 — 못 읽음·불러오는 중을 0대로 말하지 않는다', () => {
  it('조회 실패는 개수를 말하지 않고 펼치지 않는다', () => {
    const s = hzSummary(null, '시간 초과');
    expect(s.label).toMatch(/읽지 못함/);
    expect(s.label).not.toMatch(/0대/);
    expect(s.open).toBe(false);
  });
  it('아직 오지 않았으면 불러오는 중', () => {
    const s = hzSummary(null, null);
    expect(s.label).toMatch(/불러오는 중/);
    expect(s.label).not.toMatch(/대 등록/);
  });
  it('실제 0대면 0대 등록 + 펼침', () => {
    expect(hzSummary([], null)).toMatchObject({ label: expect.stringMatching(/0대 등록/), open: true, known: true });
    expect(hzSummary([{ id: 'a' }], null).label).toMatch(/1대 등록/);
  });
});
