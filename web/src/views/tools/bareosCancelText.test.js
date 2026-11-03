import { describe, it, expect } from 'vitest';
import {
  ageText, cancelChip, cancelButton, jobCancelNotes, groupPlanView, groupCancelNotes, nameMatches, cancelAcceptedText, canceledText, groupStopState, progressSegments,
} from './bareosCancelText.js';
import { fireText, fireTone, FIRE_STATE_TEXT } from './bareosGroupText.js';

const NOW = 1_800_000_000_000;
const all = (o) => JSON.stringify(o);

describe('v2.865 취소 문구 — 판정은 서버 cancelInfo 값 그대로', () => {
  it('ageText — 초 · 분 초 · 시간 분 · 모름', () => {
    expect(ageText(8_000)).toBe('8초');
    expect(ageText(72_000)).toBe('1분 12초');
    expect(ageText(3_780_000)).toBe('1시간 3분');
    expect(ageText(-1)).toBe('—');
    expect(ageText(null)).toBe('—');
  });

  it('cancelChip — 멈추는 중 경과 · 멈추지 않음 · 없음', () => {
    expect(cancelChip(null)).toBe(null);
    const c = cancelChip({ at: NOW - 72_000, by: 'hong', via: 'group', stuck: false }, { now: NOW, waitMs: 600_000 });
    expect(c.text).toBe('멈추는 중 1분 12초');
    expect(c.tone).toBe('stop');
    expect(c.title).toContain('그룹 중단');
    expect(c.title).toContain('10분');
    const s = cancelChip({ at: NOW - 700_000, by: 'hong', via: 'single', stuck: true }, { now: NOW });
    expect(s.text).toBe('멈추지 않음');
    expect(s.tone).toBe('warn');
  });

  it('cancelButton — 실행 아님 · 보냄(잠김) · 멈추지 않음(다시) · 잠금 사유', () => {
    expect(cancelButton({ running: false })).toBe(null);
    expect(cancelButton({ running: true, cancel: null })).toMatchObject({ label: '취소…', disabled: false });
    expect(cancelButton({ running: true, cancel: { stuck: false } })).toMatchObject({ label: '취소 보냄', disabled: true });
    expect(cancelButton({ running: true, cancel: { stuck: true } })).toMatchObject({ label: '다시 보내기…', disabled: false });
    expect(cancelButton({ running: true, cancel: null, lockReason: '조회 전용' })).toMatchObject({ disabled: true, title: '조회 전용' });
  });

  it('groupPlanView — 단계별 설명 · 멈출 것 없음', () => {
    expect(groupPlanView({ phase: 'queued' }).lines[0]).toContain('줄에서 빼고');
    const s = groupPlanView({ phase: 'sending', progress: { toSend: 50, sent: 12, started: 9 } });
    expect(s.lines[0]).toContain('보냄 12 / 50');
    expect(s.lines[0]).toContain('약 38대');
    expect(s.lines[1]).toContain('끊지 않고');
    expect(groupPlanView({ phase: 'running', fire: 9 }).lines[0]).toContain('9대');
    const none = groupPlanView({ phase: null, fire: 0, extra: 0, sent: 2, stuck: 0 });
    expect(none.canStop).toBe(false);
    expect(none.lines[0]).toContain('다시 보내지 않습니다');
    expect(groupPlanView({ phase: null, extra: 1 }).canStop).toBe(true);
  });

  it('nameMatches — 앞뒤 공백만 무시 · 대소문자 구분(서버와 같은 비교)', () => {
    expect(nameMatches('  DB-야간 ', 'DB-야간')).toBe(true);
    expect(nameMatches('db-야간', 'DB-야간')).toBe(false);
    expect(nameMatches('', 'x')).toBe(false);
  });

  it('groupStopState — 멈추는 중 · 이번 회차 · 중단됨 · 버튼 열기', () => {
    expect(groupStopState({ canceling: { at: NOW }, stop: { phase: 'running' } })).toMatchObject({ kind: 'stopping', canStop: false });
    expect(groupStopState({ stop: { phase: 'sending' } })).toMatchObject({ kind: 'cancelable', text: '보내는 중', canStop: true });
    expect(groupStopState({ stop: { phase: null, sent: 2, stuck: 0 }, lastFire: { canceled: { at: NOW } } })).toMatchObject({ kind: 'stopping', canStop: false });
    expect(groupStopState({ stop: { phase: null, sent: 2, stuck: 2 }, lastFire: { canceled: { at: NOW } } })).toMatchObject({ kind: 'stopped' });
    expect(groupStopState({ stop: { phase: null, extra: 3 } })).toMatchObject({ kind: null, canStop: false });   // 그 밖 실행만이면 열지 않는다
    expect(groupStopState({ stop: { phase: 'running', pruning: true } }).canStop).toBe(false);
  });

  it('progressSegments — 시작 · 보냈지만 시작 못 함 · 보낼 차례(0 인 칸 뺌)', () => {
    expect(progressSegments({ progress: { toSend: 50, sent: 12, started: 9 } }).map((x) => [x.tone, x.n])).toEqual([['run', 9], ['bad', 3], ['muted', 38]]);
    expect(progressSegments({ progress: { queued: true } })).toEqual([]);
    expect(progressSegments({})).toEqual([]);
  });

  it('canceledText · cancelAcceptedText · fireText — 0 인 칸은 빼고 중단 표시', () => {
    const c = { at: NOW, by: 'kim', phase: 'running', scope: 'all', canceled: 14, finished: 0, cleared: 0, failed: 1, unknown: 0, busy: 0, halted: 9, extra: { canceled: 1, finished: 0, cleared: 0, failed: 0, unknown: 0, busy: 0 }, skipKey: '2026-11-08 23:00' };
    const t = canceledText(c, () => '11-01 23:48');
    expect(t).toBe('중단됨 11-01 23:48 kim · 취소 14 · 시작 전 멈춤 9 · 취소 실패 1 · 그 밖 실행 취소 1 · 범위 그룹 VM 전부 · 2026-11-08 23:00 회차 건너뜀');
    expect(cancelAcceptedText({ phase: 'queued', fire: 0, extra: 0, halted: 20, skipKey: '' }, 'WEB')).toContain('시작 전 멈춤 20대');
    const f = { at: NOW, trigger: 'timer', started: 23, halted: 9, canceled: c };
    expect(fireText(f)).toContain('중단됨');
    expect(fireText(f)).toContain('시작 전 멈춤 9');
    expect(fireTone(f)).toBe('warn');
    expect(FIRE_STATE_TEXT.canceled).toBe('취소');
    expect(FIRE_STATE_TEXT.halted).toBe('시작 전 멈춤');
  });

  it('문구에 백틱이 없다(BoldText 규칙)', () => {
    const texts = [...jobCancelNotes({ group: 'G', waitMs: 600_000 }), ...groupCancelNotes({ waitMs: 600_000 }), ...groupPlanView({ phase: 'sending', progress: { toSend: 2, sent: 1 } }).lines,
      all(cancelChip({ at: NOW, by: 'a', stuck: false }, { now: NOW, waitMs: 1 })), all(cancelChip({ at: NOW, by: 'a', stuck: true }, { now: NOW })), all(cancelButton({ running: true, cancel: { stuck: false } }))];
    for (const t of texts) expect(t).not.toContain('`');
  });
});
