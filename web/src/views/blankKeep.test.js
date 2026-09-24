import { describe, it, expect } from 'vitest';
import { keepIfBlank, applyDrafts } from './blankKeep.js';

describe('keepIfBlank (v2.600 T2600-05)', () => {
  it('빈 칸·공백·숫자 아님은 이전 값 유지', () => {
    expect(keepIfBlank('', 900_000, (n) => n * 1000)).toBe(900_000);
    expect(keepIfBlank('  ', 6)).toBe(6);
    expect(keepIfBlank('abc', 22)).toBe(22);
    expect(keepIfBlank(null, 300)).toBe(300);
  });
  it('숫자는 map 을 거친다 — 명시적 0 도 값', () => {
    expect(keepIfBlank('120', 900_000, (n) => Math.max(10, n) * 1000)).toBe(120_000);
    expect(keepIfBlank('0', 900_000, (n) => Math.max(10, n) * 1000)).toBe(10_000);
    expect(keepIfBlank('2222', 22, (n) => Math.max(1, n))).toBe(2222);
  });
});

describe('applyDrafts (v2.601 RECENT2601-05 — 입력 중에는 원문, 저장 시 한 번만 변환)', () => {
  const maps = { pollIntervalMs: (n) => Math.max(10, n) * 1000, sshPort: (n) => Math.max(1, n) };
  const form = { pollIntervalMs: 60_000, sshPort: 22, enabled: true };
  it('건드리지 않은 칸은 그대로, 빈 칸은 이전 값', () => {
    expect(applyDrafts(form, {}, maps)).toEqual(form);
    expect(applyDrafts(form, { pollIntervalMs: '' }, maps).pollIntervalMs).toBe(60_000);
  });
  it('중간 입력(60→6→30)은 저장 전까지 변환되지 않는다 — 마지막 원문만 적용', () => {
    // 예전: 입력 중 keepIfBlank('6') → 하한 10 → 칸이 '10' 이 되어 이어 치면 '100' 이 됐다.
    expect(applyDrafts(form, { pollIntervalMs: '30' }, maps).pollIntervalMs).toBe(30_000);
    expect(applyDrafts(form, { pollIntervalMs: '6' }, maps).pollIntervalMs).toBe(10_000); // 하한은 저장 시에만
  });
  it('모르는 키·원본 불변', () => {
    const f2 = { ...form };
    applyDrafts(f2, { sshPort: '2222', bogus: '1' }, maps);
    expect(f2).toEqual(form);
    expect(applyDrafts(form, { bogus: '1' }, maps)).not.toHaveProperty('bogus');
  });
});
