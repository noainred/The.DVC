import { describe, it, expect } from 'vitest';
import { allSummaryText, allReportDoc, hasUncheckedPart, failedNamesText } from './sanHealthText.js';

describe('SAN 전체 점검 failed (LEFT2607-03)', () => {
  const payload = {
    summary: { devices: 2, registered: 3, byOverall: { ok: 2, warn: 0, bad: 0, unknown: 0 }, missing: 0, failed: 1, uncheckedItems: 0 },
    results: [], failed: [{ deviceId: 'd3', name: 'SAN-C', reason: '스냅샷 형식 오류' }], baselines: [],
  };
  it('요약 한 줄에 점검 중 오류 대수가 나온다', () => {
    expect(allSummaryText(payload.summary)).toMatch(/점검 중 오류 1대/);
  });
  it('실패만 있어도 결론 경고 조건이 참이다', () => {
    expect(hasUncheckedPart(payload.summary)).toBe(true);
    expect(hasUncheckedPart({ byOverall: { ok: 3 }, missing: 0, failed: 0, uncheckedItems: 0 })).toBe(false);
  });
  it('PDF note 에 실패 스위치 이름이 들어간다', () => {
    const doc = allReportDoc(payload);
    const note = doc.blocks.find((x) => x.type === 'note');
    expect(note && note.text).toMatch(/점검 중 오류로 빠진 스위치 1대 — SAN-C/);
  });
  it('이름 목록 상한', () => {
    expect(failedNamesText(Array.from({ length: 22 }, (_, i) => ({ name: `s${i}` })))).toMatch(/외 2대$/);
    expect(failedNamesText(null)).toBe('');
  });
});
