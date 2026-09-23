import { describe, it, expect } from 'vitest';
import { areasStopNote, areaBadgeSuffix } from './areasStopText.js';

describe('areasStopText (v2.598 T2598-01)', () => {
  it('멈추지 않았으면 안내가 없다', () => {
    expect(areasStopNote({})).toBeNull();
    expect(areasStopNote(null)).toBeNull();
  });
  it('사유별로 다른 문구와 시도하지 않은 개수를 밝힌다', () => {
    const t = areasStopNote({ areasStopped: 'transport', areasNotTried: 37 });
    expect(t.text).toContain('응답하지 않아');
    expect(t.text).toContain('37개');
    expect(areasStopNote({ areasStopped: 'auth', areasNotTried: 5 }).tone).toBe('red');
    expect(areasStopNote({ areasStopped: 'deadline' }).text).toContain('시한');
  });
  it('모르는 사유도 숨기지 않고, 문구에 백틱이 없다', () => {
    expect(areasStopNote({ areasStopped: 'xyz' }).text).toContain('xyz');
    for (const k of ['auth', 'deadline', 'transport', 'xyz']) {
      const n = areasStopNote({ areasStopped: k, areasNotTried: 1 });
      expect(n.text + n.fix).not.toContain('`');
    }
  });
  it('미시도와 비활성을 다른 배지로 그린다', () => {
    expect(areaBadgeSuffix({ skipped: true, notTried: true })).toBe(' (미시도)');
    expect(areaBadgeSuffix({ skipped: true })).toBe(' (비활성)');
    expect(areaBadgeSuffix({ ok: 3, failed: 1 })).toBe(' 3/4');
    expect(areaBadgeSuffix({ ok: 3, failed: 0 })).toBe('');
  });
});
