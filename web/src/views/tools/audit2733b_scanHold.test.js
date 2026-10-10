// v2.733(점검 3회차 C1-02): 스캔 상태 화면이 '스캔 미완료' 와 '해제 판정 보류' 를 짧게 말한다(서버 판정 — 화면은 문장만).
//   값이 없으면 '—'(0·null·undefined·NaN 금지) · 강조는 **만(BoldText 로 그린다) · 백틱 금지 · 마지막 완료보다 오래된 미완료는 말하지 않는다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { scanIncompleteLines, releaseHoldLines } from './IpamScanStatus.jsx';

const clean = (lines) => {
  for (const l of lines) {
    expect(l, l).not.toMatch(/`/);
    expect(l, l).not.toMatch(/\b(null|undefined|NaN)\b/);
    expect((l.match(/\*\*/g) || []).length % 2, l).toBe(0);
  }
};

describe('scanIncompleteLines', () => {
  it('마지막 완료보다 새 미완료만 · 새 것부터 · 모르는 완료 시각은 —', () => {
    const lines = scanIncompleteLines({
      __local__: { at: 1_000, scanned: 254, alive: 3, incomplete: { at: 2_000, code: 'SCAN_DEADLINE', done: 3, total: 254, partial: 1, streak: 2 } },
      'edge-a': { at: 5_000, scanned: 10, alive: 1, incomplete: { at: 4_000, code: 'SCAN_DEADLINE' } }, // 그 뒤 완료 — 말하지 않는다
      'edge-b': { at: null, scanned: null, alive: null, incomplete: { at: 3_000, code: 'error', streak: 1 } },
      'edge-c': { at: 9_000, scanned: 1, alive: 1 },
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\*\*edge-b\*\* 스캔 미완료\(실패\)/);
    expect(lines[0]).toMatch(/마지막 완료 —$/);
    expect(lines[1]).toMatch(/^\*\*이 포탈\*\* 스캔 미완료\(시한 초과 · 3\/254 스캔 · 생존 1개만 확인 · 연속 2회\)/);
    clean(lines);
  });
  it('비었거나 모양이 틀리면 빈 목록', () => {
    expect(scanIncompleteLines(null)).toEqual([]);
    expect(scanIncompleteLines({ x: null, y: { incomplete: 'x' }, z: { incomplete: { at: 'abc' } } })).toEqual([]);
  });
});

describe('releaseHoldLines', () => {
  it('보류 개수 · 에이전트별 사유 · 보류 시한(모르면 —) · 미확인 해제 누적', () => {
    const lines = releaseHoldLines({
      held: 3, expired: 2,
      agents: [
        { agent: '__local__', held: 2, reason: 'scan-incomplete', holdUntil: 1_800_000_000_000 },
        { agent: 'edge-x', held: 1, reason: 'no-recent-scan', holdUntil: null },
        { agent: 'edge-y', held: 0, expired: 2, reason: 'no-recent-scan' },
      ],
    });
    expect(lines[0]).toMatch(/^\*\*해제 판정 보류 3개\*\* — /);
    expect(lines[1]).toMatch(/^이 포탈: 2개 · 마지막 스캔 미완료 · 보류 시한 /);
    expect(lines[2]).toBe('edge-x: 1개 · 완료 보고 없음 · 보류 시한 —(지나면 미확인 해제로 기록)');
    expect(lines.some((l) => /edge-y/.test(l))).toBe(false); // 보류 0 인 에이전트는 줄을 만들지 않는다
    expect(lines.at(-1)).toBe('보류 시한이 지나 **미확인 해제**로 기록한 IP 2개(서버 시작 이후)');
    clean(lines);
  });
  it('보류·만료가 없으면 아무것도 말하지 않는다', () => {
    expect(releaseHoldLines(null)).toEqual([]);
    expect(releaseHoldLines({ held: 0, expired: 0, agents: [] })).toEqual([]);
  });
});

describe('화면 — 두 줄 묶음을 BoldText 로 그린다(별표가 글자로 새지 않게)', () => {
  it('IpamScanStatus.jsx', () => {
    const src = fs.readFileSync(new URL('./IpamScanStatus.jsx', import.meta.url), 'utf8');
    expect(src).toMatch(/\[\.\.\.scanIncompleteLines\(d\.reports\), \.\.\.releaseHoldLines\(st\?\.releaseHold\)\]/);
    expect(src).toMatch(/<BoldText text=\{t\} \/>/);
  });
});
