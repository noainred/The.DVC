/**
 * issueText2885.test.js — v2.885 C-3 화면 판정: 시간 입력 · 기록/예상 · SLA 배지 · 단계 문구 · 버전 비교 · 이력 문구.
 * 서버 모양과의 대조: 분 문구는 server/src/issues/store.js minutesText 와 같은 입력에 같은 답.
 */
import { describe, it, expect } from 'vitest';
import { minutesText, parseDuration, timeTrackText, slaBadge, slaStageText, versionCmp, fixVersionState, historyText, csvParams } from './issueText.js';
import { minutesText as serverMinutes } from '../../../../server/src/issues/store.js';

describe('시간', () => {
  it('분 문구 — 서버와 같은 모양', () => {
    for (const m of [0, 1, 59, 60, 61, 90, 120, 1439, 1440, 129600]) expect(minutesText(m)).toBe(serverMinutes(m));
    expect(minutesText(null)).toBe('—');
  });
  it('입력 읽기 — 숫자 · h/m · 시간/분 · 소수 시간 · 잘못된 값은 null', () => {
    expect(parseDuration('90')).toBe(90);
    expect(parseDuration('1h 30m')).toBe(90);
    expect(parseDuration('1.5h')).toBe(90);
    expect(parseDuration('2시간')).toBe(120);
    expect(parseDuration('1시간 15분')).toBe(75);
    expect(parseDuration('45분')).toBe(45);
    for (const bad of ['', '0', '0m', 'abc', '1d', '-5', '1h30', `${'9'.repeat(30)}`]) expect(parseDuration(bad), bad).toBe(null);
  });
  it('기록 / 예상', () => {
    expect(timeTrackText({ estimateMin: 240, spentMin: 150, worklogCount: 2 })).toBe('기록 2h 30m / 예상 4h (63%)');
    expect(timeTrackText({ estimateMin: null, spentMin: 0, worklogCount: 0 })).toBe('');
    expect(timeTrackText({ estimateMin: 60, spentMin: 0, worklogCount: 0 })).toBe('예상 1h', '기록이 없으면 0 이 아니라 표시하지 않는다');
  });
});

describe('SLA', () => {
  const now = 1_800_000_000_000;
  it('배지 — 초과 · 임박(남은 시간) · 멈춤만, 진행 · 지킴 · 없음은 null', () => {
    expect(slaBadge(null)).toBe(null);
    expect(slaBadge({ respond: { state: 'met' }, resolve: { state: 'running' } })).toBe(null);
    expect(slaBadge({ respond: { state: 'breached', targetMin: 15, usedMin: 20 }, resolve: { state: 'running' } }, now)).toMatchObject({ cls: 'bad', text: 'SLA 응답 초과' });
    expect(slaBadge({ respond: { state: 'met' }, resolve: { state: 'warning', targetMin: 240, usedMin: 200, dueAt: now + 40 * 60000 } }, now)).toMatchObject({ cls: 'warn', text: 'SLA 해결 40m 남음' });
    expect(slaBadge({ respond: { state: 'paused', targetMin: 15, usedMin: 5 }, resolve: { state: 'paused' } }, now)).toMatchObject({ cls: 'mute', text: 'SLA 멈춤' });
  });
  it('단계 문구', () => {
    expect(slaStageText('respond', { state: 'met', usedMin: 12, targetMin: 15 })).toBe('응답: 지킴 · 12m / 목표 15m');
    expect(slaStageText('resolve', { state: 'running', usedMin: 62, targetMin: 240, dueAt: now + 178 * 60000 }, now)).toBe('해결: 진행 · 1h 2m / 목표 4h · 2h 58m 남음');
    expect(slaStageText('respond', { state: 'off', targetMin: 0 })).toBe('응답: 보지 않음(목표 0)');
  });
});

describe('버전 · 이력', () => {
  it('숫자 마디 비교 — 2.90.0 < 2.885.0', () => {
    expect(versionCmp('2.90.0', '2.885.0')).toBe(-1);
    expect(versionCmp('2.885.0', '2.885')).toBe(0);
    expect(versionCmp('R24.11', '2.885.0')).toBe(null);
    expect(fixVersionState('2.884.0', '2.885.0')).toBe('in');
    expect(fixVersionState('2.886.0', '2.885.0')).toBe('later');
    expect(fixVersionState('hotfix-1', '2.885.0')).toBe(null);
  });
  it('이력 문구', () => {
    expect(historyText({ by: 'kim', field: 'worklog', from: '', to: '+1h 30m', note: '현장' })).toBe('kim · 작업 기록 +1h 30m — 현장');
    expect(historyText({ by: 'kim', field: 'worklog', from: '30m(lee)', to: '' })).toBe('kim · 작업 기록 지움 — 30m(lee)');
    expect(historyText({ by: 'kim', field: 'estimate', from: '', to: '4h' })).toBe('kim · 예상 없음 → 4h');
    expect(historyText({ by: 'kim', field: 'fixVersion', from: '', to: '2.885.0' })).toBe('kim · 수정 버전 없음 → 2.885.0');
  });
});

describe('CSV 매개변수', () => {
  it('화면 걸러보기 → 서버 매개변수', () => {
    expect(csvParams({ q: ' 장애 ', assignee: '__none', vcenterId: '__none', priority: 'p0' }, 'kim')).toEqual({ done: 'recent', q: '장애', assignee: '', vcenterId: '', priority: 'p0' });
    expect(csvParams({ mine: true, assignee: 'lee' }, 'kim', { query: 'type = incident' })).toEqual({ done: 'recent', query: 'type = incident', assignee: 'kim' });
  });
});

describe('검색식 필드 이름 — 서버 FIELDS 와 화면 이름표가 같은 목록', () => {
  it('모든 서버 필드에 이름표가 있다', async () => {
    const { FIELDS } = await import('../../../../server/src/issues/query.js');
    const { QUERY_FIELD_TEXT } = await import('./issueText.js');
    expect(Object.keys(FIELDS).filter((k) => !QUERY_FIELD_TEXT[k])).toEqual([]);
  });
});

describe('v2.886 캘린더', () => {
  it('달 칸 — 월요일 시작 · 앞뒤 달 칸 · 주 수', async () => {
    const { monthGrid, issuesByDay, sprintMarks, shiftMonth } = await import('./issueText.js');
    const g = monthGrid(2026, 11); // 2026-11-01 은 일요일
    expect(g[0][0]).toEqual({ day: '2026-10-26', inMonth: false });
    expect(g[0][6]).toEqual({ day: '2026-11-01', inMonth: true });
    expect(g.length).toBe(6);
    expect(g[g.length - 1][6].day).toBe('2026-12-06');
    expect(monthGrid(2027, 2).length).toBe(4, '2027-02-01 은 월요일 · 28일 = 정확히 4주');
    const t = new Date(2026, 10, 4, 9).getTime();
    const { byDay, none } = issuesByDay([{ key: 'ISS-2', num: 2, priority: 'p2', dueAt: t }, { key: 'ISS-1', num: 1, priority: 'p0', dueAt: t }, { key: 'ISS-3', num: 3, dueAt: null }]);
    expect(byDay.get('2026-11-04').map((r) => r.key)).toEqual(['ISS-1', 'ISS-2']);
    expect(none).toBe(1);
    expect(sprintMarks([{ name: 'S1', startDay: '2026-11-04', endDay: '2026-11-17' }], '2026-11-04')).toEqual([{ name: 'S1', kind: 'start' }]);
    expect(shiftMonth({ y: 2026, m: 12 }, 1)).toEqual({ y: 2027, m: 1 });
    expect(shiftMonth({ y: 2026, m: 1 }, -1)).toEqual({ y: 2025, m: 12 });
  });
});
