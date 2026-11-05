import { describe, it, expect } from 'vitest';
import {
  ageText, cancelChip, cancelButton, jobCancelNotes, groupPlanView, groupCancelNotes, nameMatches, cancelAcceptedText, canceledText, groupStopState, progressSegments,
} from './bareosCancelText.js';
import { fireText, fireTone, FIRE_STATE_TEXT, memberResults, resultBadge } from './bareosGroupText.js';

const NOW = 1_800_000_000_000;
const all = (o) => JSON.stringify(o);

describe('v2.867 취소 문구 — 판정은 서버 cancelInfo 값 그대로', () => {
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
    expect(c.short).toBe('멈추는 중');
    expect(c.sub).toBe('1분 12초째 · hong · 그룹 중단');
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

  it('groupStopState — v2.906 회차 중단 없이 행마다 취소한 이번 회차 실행(sentFire)을 구분한다', () => {
    // 남은 이번 회차 실행이 전부 행마다 취소로 멈추는 중 — 예전에는 표지 없음(kind null)
    expect(groupStopState({ stop: { phase: null, sent: 1, stuck: 0, sentFire: 1, stuckFire: 0 } })).toMatchObject({ kind: 'stopping', text: '멈추는 중(실행별 취소)' });
    // 다른 실행이 아직 돈다 — 실행 중 + 행마다 취소 수
    expect(groupStopState({ stop: { phase: 'running', fire: 3, sent: 1, sentFire: 1 } })).toMatchObject({ kind: 'cancelable', text: '실행 중 · 실행별 취소 1', canStop: true });
    // 그 밖 실행(스케줄)만 취소한 경우는 이번 회차가 아니다 — 예전 그대로
    expect(groupStopState({ stop: { phase: null, sent: 1, stuck: 0, sentFire: 0, extra: 0 } })).toMatchObject({ kind: null });
    // 회차 중단 기록이 있으면 그 판정이 먼저(멈추는 중)
    expect(groupStopState({ stop: { phase: null, sent: 2, stuck: 0, sentFire: 2 }, lastFire: { canceled: { at: NOW } } })).toMatchObject({ kind: 'stopping', text: '멈추는 중' });
    // 옛 서버(sentFire 없음)는 예전 판정
    expect(groupStopState({ stop: { phase: null, sent: 1, stuck: 0 } })).toMatchObject({ kind: null });
  });

  it('progressSegments — 시작 · 보냈지만 시작 못 함 · 보낼 차례(0 인 칸 뺌)', () => {
    expect(progressSegments({ progress: { toSend: 50, sent: 12, started: 9 } }).map((x) => [x.tone, x.n])).toEqual([['run', 9], ['bad', 3], ['muted', 38]]);
    expect(progressSegments({ progress: { queued: true } })).toEqual([]);
    expect(progressSegments({})).toEqual([]);
  });

  it('canceledText · cancelAcceptedText · fireText — 0 인 칸은 빼고 중단 표시', () => {
    const c = { at: NOW, by: 'kim', phase: 'running', scope: 'all', canceled: 14, finished: 0, cleared: 0, failed: 1, unknown: 0, busy: 0, halted: 9, extra: { canceled: 1, finished: 0, cleared: 0, failed: 0, unknown: 0, busy: 0 }, skipKey: '2026-11-08 23:00' };
    const t = canceledText(c, () => '11-01 23:48');
    expect(t).toBe('중단 요청 11-01 23:48 kim · 취소 14 · 시작 전 멈춤 9 · 취소 실패 1 · 그 밖 실행 취소 1 · 범위 그룹 VM 전부 · 2026-11-08 23:00 회차 건너뜀');
    expect(cancelAcceptedText({ phase: 'queued', fire: 0, extra: 0, halted: 20, skipKey: '' }, 'WEB')).toContain('시작 전 멈춤 20대');
    const f = { at: NOW, trigger: 'timer', started: 23, halted: 9, canceled: c };
    expect(fireText(f)).toContain(' · 중단 · ');
    expect(fireText({ ...f, canceled: { ...c, effective: false } })).toContain('중단 못 함');
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

  it('memberResults — 사람이 멈춘 실행(canceled)은 실패와 따로 센다 · 표지', () => {
    const m = memberResults([{ b: { st: 'canceled' } }, { b: { st: 'canceled' } }, { b: { st: 'ok' } }, { b: { st: 'error' } }]);
    expect(m).toMatchObject({ n: 4, ok: 1, fail: 1, cancel: 2 });
    expect(resultBadge(memberResults([{ b: { st: 'canceled' } }, { b: { st: 'ok' } }]))).toEqual({ text: '취소 1 · 성공 1', tone: 'warn' });
    expect(memberResults([{ b: { st: 'canceled' } }], { resultsKnown: false }).cancel).toBe(null);
  });

  it('canceledText — 멈추지 못한 시도는 중단하지 못함 + 사유', () => {
    const t = canceledText({ at: NOW, by: 'kim', effective: false, failed: 2, reason: '취소 실패 — 엣지를 업그레이드' }, () => 'T');
    expect(t).toBe('중단하지 못함 T kim · 취소 실패 2 · 사유: 취소 실패 — 엣지를 업그레이드');
    expect(groupStopState({ stop: { phase: 'running', fire: 2 }, lastFire: { canceled: { effective: false } } })).toMatchObject({ kind: 'stopfail', canStop: true });
  });

  it('v2.870 감사 A1-04 · A1-05 — 줄 대기 · 보내는 중은 이전 회차의 중단 기록을 보지 않는다 · 시작 결과 모름 수', () => {
    // 직전 회차 중단이 실패했어도 새 회차가 보내는 중이면 '보내는 중'(예전: '중단하지 못함')
    expect(groupStopState({ stop: { phase: 'sending' }, lastFire: { canceled: { effective: false } } })).toMatchObject({ kind: 'cancelable', text: '보내는 중', canStop: true });
    expect(groupStopState({ stop: { phase: 'queued' }, lastFire: { canceled: { at: NOW } } })).toMatchObject({ kind: 'cancelable', text: '차례 대기' });
    // 직전 회차 중단 성공 뒤 새 회차가 보내는 중이고 그룹 VM 하나를 단건 취소(sent 1) — '멈추는 중' 이 아니다
    expect(groupStopState({ stop: { phase: 'sending', sent: 1, stuck: 0 }, lastFire: { canceled: { at: NOW } } }).kind).toBe('cancelable');
    const t = canceledText({ at: NOW, by: 'kim', canceled: 3, startUnknown: 2 }, () => 'T');
    expect(t).toBe('중단 요청 T kim · 취소 3 · 시작 결과 모름 2(취소 못 함 — Director 에서 확인)');
    expect(canceledText({ at: NOW, canceled: 1 }, () => 'T')).not.toMatch(/시작 결과 모름/);
  });
});
