import { describe, it, expect } from 'vitest';
import { scopeSaveNotes, scopeSaveSuffix } from './scopeSaveText.js';

describe('scopeSaveNotes (WEB2607-02 · RECENT2607-06)', () => {
  it('all-mode unapplied 는 서버 사유를 그대로 경고한다', () => {
    const r = { ok: true, unapplied: 'all-mode', unappliedReason: '대상이 전체라 적용하지 않았습니다.' };
    expect(scopeSaveNotes(r)).toEqual(['대상이 전체라 적용하지 않았습니다.']);
    expect(scopeSaveSuffix(r)).toContain('일부는 적용되지 않았습니다');
  });
  it('ignoredOutOfScope·ignoredGlobal 을 말한다', () => {
    const notes = scopeSaveNotes({ ignoredOutOfScope: 2, ignoredGlobal: ['enabled', 'threshold'], ignoredReason: '전역 값 미적용.' });
    expect(notes.join(' ')).toContain('범위 밖 vCenter 2개');
    expect(notes.join(' ')).toContain('enabled, threshold');
  });
  it('해당 없으면 빈 배열·빈 문자열(평소 문구가 그대로)', () => {
    expect(scopeSaveNotes({ ok: true, dropped: [] })).toEqual([]);
    expect(scopeSaveSuffix({ ok: true })).toBe('');
    expect(scopeSaveNotes(null)).toEqual([]);
    expect(scopeSaveNotes({ ignoredOutOfScope: '3' })).toEqual([]);
  });
  it('백틱을 쓰지 않는다', () => {
    const all = scopeSaveNotes({ unapplied: 'x', ignoredGlobal: ['a'], ignoredOutOfScope: 1 }).join('');
    expect(all.includes('`')).toBe(false);
  });
});
