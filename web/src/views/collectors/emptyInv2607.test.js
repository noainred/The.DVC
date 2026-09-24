import { describe, it, expect } from 'vitest';
import { collectModeText } from './emptyInvText.js';

describe('collectModeText (RECENT2607-08)', () => {
  it('collectMode 는 site/direct 축, REST 폴백은 따로 말한다', () => {
    expect(collectModeText({ collectMode: 'direct', collectSource: 'rest' })).toBe('직접 · REST 폴백(경보·클러스터 미수집)');
    expect(collectModeText({ collectMode: 'site', collectSource: '' })).toBe('사이트 위임');
    expect(collectModeText({ collectMode: 'direct' })).toBe('직접');
    expect(collectModeText({ collectMode: 'rest' })).toBe('직접 · REST 폴백(경보·클러스터 미수집)'); // 구버전 엣지
    expect(collectModeText({})).toBe('직접');
  });
});
