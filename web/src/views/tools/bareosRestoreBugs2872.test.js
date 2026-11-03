/**
 * v2.872 Bareos 복원 · 검증 점검(5축 + 반증 1인) 확정분 — 화면 쪽(bareosRestoreText.js · bareosRestoreTree.js).
 *  ① B5-01 결과 모름 복원(jobid 없음)은 서버와 같은 시한 동안 다시 고르지 못한다 · 폴더 표 상태 칸 · 묶음 진행의 결과 모름 수
 *  ② B5-01 · B5-02 묶음 복원 응답 → 화면 결과: 부분 시작은 경고 + 시작하지 못한 항목 사유 · 결과 모름은 마법사 비움 · 확정 실패는 마법사에 남김
 *  ③ B4-02 법인별 마지막 회차 · B3-01 정리 칸(지웠는지 모르면 '남김' 으로 단정하지 않는다)
 */
import { describe, it, expect } from 'vitest';
import * as T from './bareosRestoreText.js';
import { restoreStateText } from './bareosRestoreTree.js';

const NOW = Date.UTC(2026, 10, 4, 0, 0);
const J = (id, extra = {}) => ({ id, vmName: `vm-${id}`, folder: '/', vcenterId: 'vc-a', directorId: 'D1', writable: true, restores: [], ...extra });
const U = (at) => ({ unknown: true, jobid: null, state: 'unknown', at, mode: 'newVm', target: { name: 'x-r' }, batchId: 'rb-1' });

describe('v2.872 ① 결과 모름 붙잡기', () => {
  it('서버와 같은 시한(6시간) — 그동안 고를 수 없다 · 지나면 놓는다 · jobid 가 있으면 진행 중 판정을 탄다', () => {
    expect(T.RESTORE_UNKNOWN_HOLD_MS).toBe(6 * 3600_000);
    expect(T.pickBlock(J('1', { restores: [U(NOW - 1000)] }), { now: NOW })).toMatch(/결과 모름/);
    expect(T.pickBlock(J('1', { restores: [U(NOW - T.RESTORE_UNKNOWN_HOLD_MS - 1)] }), { now: NOW })).toBe('');
    expect(T.restoreUnknownHeld({ ...U(NOW), jobid: 5 }, NOW)).toBe(false);
    expect(T.restoreIsOpen(U(NOW))).toBe(false);
  });
  it('폴더 표 상태 칸 · 묶음 진행 수', () => {
    expect(restoreStateText(J('1', { restores: [U(NOW - 1000)] }), NOW)).toEqual({ text: '직전 복원 결과 모름', tone: 'warn' });
    const b = T.batchView([J('1', { restores: [U(NOW)] }), J('2', { restores: [{ jobid: 7, state: 'running', batchId: 'rb-1', at: NOW }] })], 'rb-1');
    expect([b.total, b.open, b.unknown, b.ok, b.bad]).toEqual([2, 1, 1, 0, 0]);
  });
});

describe('v2.872 ② 묶음 복원 응답 → 화면 결과', () => {
  it('부분 시작(202) — 경고 톤 · 시작하지 못한 항목 사유 · 마법사 비움', () => {
    const o = T.bulkRestoreOutcome({ ok: true, started: 1, total: 3, items: [
      { id: 'a', vmName: 'web-01', ok: true },
      { id: 'b', vmName: 'web-02', ok: false, code: 'unknown', reason: '복원 명령을 보낸 뒤 응답이 끊겼습니다(timeout)' },
      { id: 'c', vmName: 'web-03', ok: false, code: 'skipped', reason: '건너뜀 — Director 연결 문제' },
    ] });
    expect(o.tone).toBe('warn');
    expect(o.reset).toBe(true);
    expect(o.text).toMatch(/1 \/ 3대/);
    expect(o.text).toMatch(/결과 모름 1대/);
    expect(o.items.map((x) => [x.vmName, x.unknown])).toEqual([['web-02', true], ['web-03', false]]);
  });
  it('전부 시작 — 성공 톤 · 항목 없음 · 저장 실패는 경고', () => {
    expect(T.bulkRestoreOutcome({ ok: true, started: 2, total: 2, items: [{ ok: true }, { ok: true }] }).tone).toBe('ok');
    const s = T.bulkRestoreOutcome({ ok: true, started: 2, total: 2, items: [], saveError: '원장에 남기지 못했습니다' });
    expect([s.tone, /원장에 남기지/.test(s.text)]).toEqual(['warn', true]);
  });
  it('결과 모름(504 본문 · 시한으로 본문 없음) — 다시 누르지 못하게 마법사를 비운다', () => {
    const o = T.bulkRestoreOutcome({ ok: false, started: 0, total: 1, unknown: 1, code: 'unknown', reason: '1대는 결과를 모릅니다', items: [{ vmName: 'db-01', ok: false, code: 'unknown', reason: '끊김' }] }, { unknown: true, message: '' });
    expect([o.tone, o.reset, o.items.length]).toEqual(['bad', true, 1]);
    expect(o.text).toMatch(/이미 시작됐을 수 있습니다/);
    const t = T.bulkRestoreOutcome(null, { unknown: true, message: '시간 초과' });
    expect([t.reset, t.items.length, /시간 초과/.test(t.text)]).toEqual([true, 0, true]);
  });
  it('확정 실패(502 · 400) — 마법사에 남기고 항목 사유를 보인다', () => {
    const o = T.bulkRestoreOutcome({ ok: false, started: 0, total: 2, code: 'none-started', reason: '한 대도 시작하지 못했습니다', items: [{ vmName: 'a', ok: false, code: 'invalid', reason: '체인 없음' }, { vmName: 'b', ok: false, code: 'skipped', reason: '건너뜀' }] }, { message: 'x' });
    expect([o.reset, o.tone, o.text, o.items.length]).toEqual([false, 'bad', '한 대도 시작하지 못했습니다', 2]);
  });
});

describe('v2.872 ③ 검증 회차 · 정리 칸', () => {
  it('법인별 마지막 회차 — Director 순서 · 이전 기록 수 · 0대 회차는 bad', () => {
    const runs = [
      { id: 'r3', directorId: 'D2', at: NOW, trigger: 'timer', items: [{ ok: false, vmName: 'big', reason: '여유 부족' }], reason: '보낼 수 있는 대상이 없습니다' },
      { id: 'r2', directorId: 'D1', at: NOW - 1000, trigger: 'manual', items: [{ ok: true }, { ok: false, reason: 'x' }] },
      { id: 'r1', directorId: 'D1', at: NOW - 9000, trigger: 'timer', items: [{ ok: true }] },
    ];
    const out = T.rehearsalLastRuns(runs, [{ id: 'D1' }, { id: 'D2' }]);
    expect(out.map((x) => [x.directorId, x.run.id, x.older])).toEqual([['D1', 'r2', 1], ['D2', 'r3', 0]]);
    expect(T.rehearsalRunTone(out[0].run)).toBe('warn');
    expect(T.rehearsalRunTone(out[1].run)).toBe('bad');
    expect(T.rehearsalRunText(out[1].run)).toMatch(/정기 · 시작 0대 · 건너뜀 · 실패 1대 — 보낼 수 있는 대상이 없습니다/);
    expect(T.rehearsalRunText({ at: NOW, trigger: 'timer', items: [{ ok: true }], moreItems: 4 })).toMatch(/건너뜀 · 실패 4대/);
  });
  it("정리 칸 — 지움 · 남김 · 모름(옛 엣지 회신에는 deleted 가 없다)", () => {
    expect(T.cleanupText({ verify: 'ok', deleted: true })).toBe('지움');
    expect(T.cleanupText({ verify: 'ok', deleted: false })).toBe('남김');
    expect(T.cleanupText({ verify: 'ok' })).toMatch(/^모름/);
    expect(T.cleanupText({ verify: 'failed', deleted: false })).toBe('남김');
    expect(T.cleanupText(null)).toBe('—');
  });
});
