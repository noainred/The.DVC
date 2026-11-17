// 91회차(90회차 결정 ⓐ): Horizon 전체 추이에서 영구 실패 서버를 뺀 사실을 말하는 문구 — 없으면 빈 문자열 · 백틱 없음.
import { describe, it, expect } from 'vitest';
import { hzPersistentNote } from './horizonSessionText.js';

describe('hzPersistentNote', () => {
  it('뺀 서버가 없으면 빈 문자열', () => {
    expect(hzPersistentNote(null)).toBe('');
    expect(hzPersistentNote({ serversPersistent: 0, persistentCycles: 3 })).toBe('');
  });
  it('뺀 서버 수 · 주기를 말한다', () => {
    const t = hzPersistentNote({ serversPersistent: 2, persistentCycles: 3 });
    expect(t).toContain('**2대**');
    expect(t).toContain('3주기 넘게');
    expect(t).toContain('전체 추이 계산에서 제외');
    expect(t).not.toContain('`');
  });
  it('주기를 모르면 숫자를 지어내지 않는다', () => {
    expect(hzPersistentNote({ serversPersistent: 1 })).toContain('여러 주기 동안');
  });
});
