import { describe, it, expect } from 'vitest';
import { demoOmitNote } from './demoOmitText.js';

describe('보안 잔여 11-27 L7 반증 2회차 — 데모 계정 판본 안내(demoOmitNote)', () => {
  it('demoOnly 가 true 이고 개수가 양의 정수일 때만 말한다', () => {
    expect(demoOmitNote(null, 'saved')).toBe(null);
    expect(demoOmitNote({ demoMasked: { saved: 2 } }, 'saved')).toBe(null);
    expect(demoOmitNote({ demoOnly: 'true', demoMasked: { saved: 2 } }, 'saved')).toBe(null);
    for (const bad of [0, -1, 1.5, '2', null, undefined]) expect(demoOmitNote({ demoOnly: true, demoMasked: { saved: bad } }, 'saved')).toBe(null);
    expect(demoOmitNote({ demoOnly: true, demoMasked: { saved: 2 } }, 'jobs')).toBe(null);
    expect(demoOmitNote({ demoOnly: true, demoMasked: { other: 2 } }, 'other')).toBe(null);
  });
  it('두 종류 문구 — 개수 · 데모 계정 · 백틱 없음', () => {
    for (const k of ['saved', 'jobs']) {
      const t = demoOmitNote({ demoOnly: true, demoMasked: { [k]: 3 } }, k);
      expect(t).toMatch(/데모 계정/);
      expect(t).toMatch(/3건/);
      expect(t).not.toMatch(/`/);
    }
  });
});
