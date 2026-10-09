import { describe, it, expect } from 'vitest';
import { countsAtNote } from './sanPerfDbText.js';

describe('countsAtNote', () => {
  const T = 1_750_000_000_000;
  it('집계 시각을 밝힌다', () => {
    expect(countsAtNote({ countsAt: T - 42_000 }, T)).toContain('42초 전 집계');
    expect(countsAtNote({ countsAt: T - 1_000 }, T)).toContain('방금 집계');
  });
  it('countsAt 이 없거나 모양이 틀리면 null(지어내지 않는다)', () => {
    expect(countsAtNote({}, T)).toBeNull();
    expect(countsAtNote({ countsAt: null }, T)).toBeNull();
    expect(countsAtNote({ countsAt: '123' }, T)).toBeNull();
    expect(countsAtNote(null, T)).toBeNull();
  });
});

// v2.728(SAN 1·2차): 행 수 어림 표시와 집계 표 상태.
import { rowsText, rollupStatusText } from './sanPerfDbText.js';
describe('rowsText — 어림값이면 약', () => {
  it('어림값이면 약을 붙이고 아니면 붙이지 않는다', () => {
    expect(rowsText(1234567, true)).toBe('약 1,234,567행');
    expect(rowsText(12, false)).toBe('12행');
  });
  it('없는 값은 — (0 으로 둔갑하지 않는다)', () => {
    expect(rowsText(null, true)).toBe('—');
    expect(rowsText('abc', true)).toBe('—');
  });
});
describe('rollupStatusText — 상태별 문구', () => {
  const ret = { retention: { m15Days: 31, h1Days: 730 } };
  it('완료는 보관 기간을 말한다', () => {
    const r = rollupStatusText({ state: 'done', pct: 100, ...ret });
    expect(r.tone).toBe('ok');
    expect(r.text).toContain('15분 표 31일');
    expect(r.text).toContain('1시간 표 730일');
  });
  it('진행 중은 비율과 느릴 수 있음을 말한다', () => {
    const r = rollupStatusText({ state: 'running', pct: 42, slices: 7, ...ret });
    expect(r.tone).toBe('busy');
    expect(r.text).toContain('42%');
    expect(r.text).toContain('원본에서 읽어');
  });
  it('실패는 사유와 원본으로 계속 된다는 사실을 말한다', () => {
    const r = rollupStatusText({ state: 'error', error: 'disk I/O error', ...ret });
    expect(r.tone).toBe('bad');
    expect(r.text).toContain('disk I/O error');
    expect(r.text).toContain('원본으로 계속');
  });
  it('꺼짐은 환경변수를 말한다', () => {
    expect(rollupStatusText({ state: 'off', ...ret }).text).toContain('SANSW_PERF_ROLLUP_BACKFILL=0');
  });
  it('모르는 상태·없는 값은 null', () => {
    expect(rollupStatusText({ state: 'weird' })).toBeNull();
    expect(rollupStatusText(null)).toBeNull();
  });
  it('문구에 백틱·별표가 없다(화면 문자열 규약)', () => {
    for (const st of ['done', 'running', 'paused', 'idle', 'error', 'off', 'unavailable']) {
      const t = rollupStatusText({ state: st, pct: 10, error: 'x', ...ret }).text;
      expect(t).not.toMatch(/[`*]/);
    }
  });
});
