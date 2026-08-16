import { describe, it, expect } from 'vitest';
import { dropZone } from './useTreeDnd.js';

// v2.319 모듈화 #10 — 커서 Y→드롭 존 판정(순수 함수)의 의미 고정.
// SvcMonitor 의 인라인 zone2 와 동일 의미: 폴더 상30/중40/하30, 리프 상/하 50.
describe('useTreeDnd dropZone', () => {
  it('폴더 — before(상 30%)/inside(중 40%)/after(하 30%)', () => {
    expect(dropZone(2, 100, true)).toBe('before');
    expect(dropZone(29, 100, true)).toBe('before');
    expect(dropZone(30, 100, true)).toBe('inside');   // 경계: y<0.3h 만 before
    expect(dropZone(50, 100, true)).toBe('inside');
    expect(dropZone(70, 100, true)).toBe('inside');   // 경계: y>0.7h 만 after
    expect(dropZone(71, 100, true)).toBe('after');
    expect(dropZone(99, 100, true)).toBe('after');
  });
  it('리프(대상) — 상/하 50% = before/after(inside 없음)', () => {
    expect(dropZone(10, 100, false)).toBe('before');
    expect(dropZone(49, 100, false)).toBe('before');
    expect(dropZone(50, 100, false)).toBe('after');
    expect(dropZone(90, 100, false)).toBe('after');
  });
  it('height 0 방어 — 원본 h||1 폴백 보존(0 나눗셈 없음)', () => {
    expect(['before', 'inside', 'after']).toContain(dropZone(0, 0, true));
  });
});
