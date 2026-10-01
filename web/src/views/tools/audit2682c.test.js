/**
 * v2.682 3회차 점검 — 그룹 C 웹.
 *  R3A-06 aggregateGrowth 가 서버 totalsOf 와 같은 지연(lagging) 규칙을 쓴다(응답 asOfDay)
 *  R3A-02 트래픽 카드가 '보고 없는 시리즈 N개 제외' 와 멈춘 스위치 시리즈를 말한다
 *  R3A-03 현재 사용자 '일부 확인' 문구가 추이에서 뺀 영구 실패 서버 수를 말한다
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { aggregateGrowth } from './storageGrowthText.js';
import { trafficSummary } from './sanSwitchViewText.js';
import { collectStateNote, persistentFailNote } from './curUserText.js';

const P = [{ key: '7d', days: 7 }];
const dev = (id, latestDay, bytes) => ({ deviceId: id, latestDay, usedBytes: 100, totalBytes: 200, growth: { '7d': { bytes } } });

describe('R3A-06 aggregateGrowth lagging', () => {
  it('기준일보다 하루 넘게 오래된 장비의 증가량은 더하지 않고 센다', () => {
    const a = aggregateGrowth([dev('a', 100, 10), dev('b', 97, 1000), dev('c', 99, 5)], P, { asOfDay: 100 });
    expect(a.growth['7d'].bytes).toBe(15);
    expect(a.growth['7d'].measured).toBe(2);
    expect(a.growth['7d'].missing).toBe(1);
    expect(a.growth['7d'].lagging).toBe(1);
    expect(a.growth['7d'].partial).toBe(true);
    expect(a.usedBytes).toBe(300);   // 사용량 합계에서는 빼지 않는다(서버 totalsOf 와 같다)
  });
  it('기준일을 모르면 예전처럼 판정하지 않는다', () => {
    const a = aggregateGrowth([dev('a', 100, 10), dev('b', 97, 1000)], P);
    expect(a.growth['7d'].bytes).toBe(1010);
    expect(a.growth['7d'].lagging).toBeUndefined();
  });
  it('화면이 응답 asOfDay 를 넘긴다', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, 'StorageGrowthTool.jsx'), 'utf8');
    const calls = src.match(/aggregateGrowth\([^)]*\)/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const c of calls) expect(c).toMatch(/asOfDay/);
  });
});

describe('R3A-02 트래픽 카드 시리즈 제외 안내', () => {
  const base = { enabled: true, datacenters: 1, arrays: 2, hours: 24, now: { ts: Date.now(), bps: 1000 }, avg: 1000, peak: { bps: 1000, ts: Date.now() } };
  it('retiredSeries·heldSeries 를 말한다', () => {
    const s = trafficSummary({ ...base, retiredSeries: 2, heldSeries: 1 });
    expect(s.notes.join(' ')).toContain('보고 없는 시리즈 2개 제외');
    expect(s.notes.join(' ')).toContain('시리즈 1개는 빼지 않고');
  });
  it('0 이면 말하지 않는다', () => {
    const s = trafficSummary({ ...base, retiredSeries: 0, heldSeries: 0 });
    expect(s.notes.join(' ')).not.toContain('시리즈');
  });
});

describe('R3A-03 영구 실패 서버 안내', () => {
  it('persistentFailNote', () => {
    expect(persistentFailNote(null)).toBe('');
    expect(persistentFailNote({ persistentFailures: 0 })).toBe('');
    const t = persistentFailNote({ persistentFailures: 3, persistentCycles: 3 });
    expect(t).toContain('**3대**');
    expect(t).toContain('3주기 넘게');
    expect(t).not.toMatch(/`/);
  });
  it('일부 확인 상태 문구에 붙는다', () => {
    const d = { settings: { enabled: true }, targets: 5, kinds: { ok: 4, 'guest-error': 1 }, records: [1, 2, 3, 4, 5],
      poller: { lastResult: { persistentFailures: 1, persistentCycles: 3 } } };
    const n = collectStateNote(d);
    expect(n.kind).toBe('partial');
    expect(n.body).toContain('추이 계산에서 제외');
  });
});
