// 전체 점검 82회차 F2 — 서버가 보존 기간 설정 파일을 못 읽어 보존 정리를 멈춘 사실(lastPrune.held)을 ‘정리했다’ 로 읽히지 않게 말한다.
import { describe, it, expect } from 'vitest';
import { lastPruneNote } from './tools/bmUsageText.js';

const HOUR = 3_600_000;
const NOW = Math.floor(1_790_000_000_000 / HOUR) * HOUR;   // 정시 경계로 고정

describe('82회차 F2 lastPruneNote — 보존 정리 멈춤', () => {
  it('설정 파일을 못 읽으면 무엇을 멈췄는지 말한다', () => {
    const t = lastPruneNote({ at: NOW - 60_000, ok: true, held: ['settings'] }, NOW);
    expect(t).toMatch(/\*\*보존 정리 멈춤\*\*/);
    expect(t).toMatch(/사용률 설정/);
    expect(t).not.toMatch(/`/);
  });
  it('알림 규칙 파일만 못 읽으면 그 묶음만', () => {
    const t = lastPruneNote({ at: NOW - 60_000, ok: true, rawDeleted: 3, dailyDeleted: 0, done: true, held: ['perf-rules'] }, NOW);
    expect(t).toMatch(/원시 3행/);
    expect(t).toMatch(/알림 규칙/);
    expect(t).not.toMatch(/사용률 설정/);
  });
  it('멈춘 것이 없으면 예전 문구 그대로', () => {
    expect(lastPruneNote({ at: NOW - 60_000, ok: true, rawDeleted: 1, dailyDeleted: 0, done: true }, NOW)).not.toMatch(/멈춤/);
    expect(lastPruneNote({ at: NOW - 60_000, ok: true, held: ['unknown'] }, NOW)).not.toMatch(/멈춤/);
  });
});
