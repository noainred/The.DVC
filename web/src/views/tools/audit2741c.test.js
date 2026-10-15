/**
 * v2.741 점검 그룹 GC(아이실론 디렉터리 사용량) — 화면 쪽 회귀.
 *  · RECENT-02  잘못된 % 조각이 든 대상 주소(#/…/t/%)에서 주소 해석이 던지지 않는다(렌더 중 URIError → 특수 기능 탭 전체 오류 화면).
 *  · DEV-05     '다음 시도' 는 서버 poller.isDue 와 같은 규칙 — 오래 돈 실패 뒤는 주기만큼 쉰다(서버 상수와 대조).
 *  · TIMING-02  '지금 수집' 응답의 대기열(queued)을 조용히 빼지 않고 말한다 · 대기 중 대상의 수집 상태 칸.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { viewOfSegs, hashOfView, nextRunOf, attemptText, runQueueNote, LONG_FAIL_MS, isLongFailure, DEFAULT_SUBVIEW } from './isiduOverviewText.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(here, '../../../../server/src');
const src = (p) => fs.readFileSync(path.join(SERVER, p), 'utf8');
const MIN = 60_000; const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 15, 3, 0, 0);
const BASE = ['tools', 'isilon-dirusage'];

describe('RECENT-02 대상 주소 해석', () => {
  it('잘못된 % 조각은 던지지 않고 첫 화면(법인 현황)으로 연다', () => {
    for (const bad of ['%', '%E0%A4%A', 'abc%zz', '%%']) {
      expect(() => viewOfSegs([...BASE, 't', bad])).not.toThrow();
      expect(viewOfSegs([...BASE, 't', bad])).toEqual({ view: DEFAULT_SUBVIEW, targetId: '' });
    }
  });
  it('정상 인코딩은 그대로 되돌린다(왕복) · id 에 % 가 들어 있어도 hashOfView 가 만든 주소면 열린다', () => {
    for (const id of ['tgt-1', 't%x', '한글 대상', 'a/b']) {
      const h = hashOfView('target', id, BASE).replace(/^#\//, '').split('/');
      expect(viewOfSegs(h)).toEqual({ view: 'target', targetId: id });
    }
    expect(viewOfSegs([...BASE, 't'])).toEqual({ view: 'target', targetId: '' });
  });
});

describe('DEV-05 다음 시도 — 오래 돈 실패는 주기만큼 쉰다', () => {
  it('서버 LONG_FAIL_MS · isLongFailure 와 같은 값·규칙', () => {
    const p = src('isidu/poller.js');
    const m = p.match(/export const LONG_FAIL_MS = (\d+) \* 60_000;/);
    expect(m, '서버 LONG_FAIL_MS 를 찾지 못했다').toBeTruthy();
    expect(LONG_FAIL_MS).toBe(Number(m[1]) * MIN);
    expect(p).toMatch(/if \(isLongFailure\(last\)\) return now - last\.ts >= iv;/);
    expect(p).toMatch(/return last\.durationMs != null && Number\.isFinite\(d\) && d >= LONG_FAIL_MS;/);
    // 목록 응답이 기준을 함께 준다
    expect(src('routes/api/isilonDirUsage.js')).toMatch(/failLongMs: LONG_FAIL_MS/);
  });
  it('오래 돈 실패 뒤 = 주기 · 빨리 끝난 실패 뒤 = min(주기, 재시도) · 소요 모름 = 예전 규칙', () => {
    const t = (lastTry) => ({ intervalHours: 24, lastTry });
    expect(nextRunOf(t({ ts: NOW - 2 * HOUR, ok: false, durationMs: 2 * HOUR }), HOUR, NOW)).toBe(NOW - 2 * HOUR + 24 * HOUR);
    expect(nextRunOf(t({ ts: NOW - 2 * HOUR, ok: false, durationMs: 3_000 }), HOUR, NOW)).toBe('soon');
    expect(nextRunOf(t({ ts: NOW - 10 * MIN, ok: false }), HOUR, NOW)).toBe(NOW + 50 * MIN);
    expect(nextRunOf(t({ ts: NOW - 10 * MIN, ok: false, durationMs: LONG_FAIL_MS - 1 }), HOUR, NOW)).toBe(NOW + 50 * MIN);
    expect(nextRunOf(t({ ts: NOW - 10 * MIN, ok: false, durationMs: LONG_FAIL_MS }), HOUR, NOW)).toBe(NOW - 10 * MIN + 24 * HOUR);
    expect(isLongFailure({ ok: true, durationMs: 3 * HOUR })).toBe(false);
    expect(isLongFailure({ ok: false, durationMs: '' })).toBe(false); // 빈 값은 0 이 아니다(모름)
  });
  it('수집 상태 칸이 오래 돈 실패의 쉬는 이유를 말한다', () => {
    expect(attemptText({ lastTry: { ts: NOW - HOUR, ok: false, durationMs: 2 * HOUR } }, NOW).text).toMatch(/^실패 · .*오래 걸린 실패라 주기 뒤에 다시 시도/);
    expect(attemptText({ lastTry: { ts: NOW - HOUR, ok: false, durationMs: 1_000 } }, NOW).text).not.toMatch(/오래 걸린/);
  });
});

describe('TIMING-02 지금 수집 대기열', () => {
  it('대기열에 넣은 대상을 말한다(없으면 빈 문자열)', () => {
    const t = runQueueNote({ started: ['a', 'b'], queued: ['c', 'd', 'e', 'f'], concurrency: 2 });
    expect(t).toMatch(/동시 실행 상한\(2개\)/);
    expect(t).toMatch(/4개는 대기열/);
    expect(runQueueNote({ started: ['a'], queued: [] })).toBe('');
    expect(runQueueNote({ started: ['a'] })).toBe('');
    expect(runQueueNote(null)).toBe('');
    expect(t).not.toMatch(/`/); // BoldText 백틱 금지
  });
  it('대기 중 대상: 다음 시도는 곧 · 수집 상태 칸은 대기 중', () => {
    const q = { intervalHours: 24, queued: { since: NOW - 2 * MIN, trigger: 'manual' }, lastTry: { ts: NOW - HOUR, ok: true } };
    expect(nextRunOf(q, HOUR, NOW)).toBe('soon');
    expect(attemptText(q, NOW).text).toMatch(/^대기 중 · 동시 실행 상한/);
  });
  it('지금 수집 결과 문구에 대기열을 붙인다(화면 소스)', () => {
    const jsx = fs.readFileSync(path.join(here, 'IsilonDirUsageTool.jsx'), 'utf8');
    expect(jsx).toMatch(/runQueueNote\(r\)/);
    // 서버 run 응답이 queued·concurrency 를 싣는다
    expect(src('routes/api/isilonDirUsage.js')).toMatch(/queued: lr\.queued \|\| \[\], concurrency: lr\.concurrency \?\? null/);
  });
});
