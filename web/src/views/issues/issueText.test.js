// issueText.test.js — 이슈 트래커 화면 판정·문구(v2.864).
import { describe, it, expect } from 'vitest';
import {
  dueInfo, dateText, initialOf, colorIndexOf, groupByStatus, filterRows, myWork, loadPct, toDateInput, fromDateInput, parseLabels,
  saveFailText, persistNote, historyText, peopleOptions, STATUS_ORDER, makeLatest,
} from './issueText.js';

// 기준 시각은 실제 시각에서 정시 경계로 떨어뜨려 고정한다(docs/rules/common.md — Date.now 직접·고정 epoch 둘 다 깨진다).
const HOUR = 3600_000; const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / HOUR) * HOUR + 30 * 60_000;

describe('dueInfo — 기한 판정', () => {
  it('없으면 null · 지난 것은 over · 오늘·내일·모레는 soon · 그 뒤는 여유', () => {
    expect(dueInfo(null, { now: NOW })).toBeNull();
    expect(dueInfo('', { now: NOW })).toBeNull();
    expect(dueInfo(NOW - 2 * DAY, { now: NOW }).tone).toBe('over');
    expect(dueInfo(NOW - 2 * DAY, { now: NOW }).text).toMatch(/2일 초과/);
    expect(dueInfo(NOW, { now: NOW }).tone).toBe('soon');
    expect(dueInfo(NOW, { now: NOW }).text).toMatch(/^오늘/);
    expect(dueInfo(NOW + DAY, { now: NOW }).text).toMatch(/^내일/);
    expect(dueInfo(NOW + 2 * DAY, { now: NOW }).text).toMatch(/^D-2/);
    expect(dueInfo(NOW + 5 * DAY, { now: NOW }).tone).toBe('');
  });
  it('완료된 이슈는 지난 기한을 초과로 말하지 않는다', () => {
    expect(dueInfo(NOW - 3 * DAY, { now: NOW, done: true })).toEqual({ text: dateText(NOW - 3 * DAY, NOW), tone: '', days: null });
  });
});

describe('표시 보조', () => {
  it('initialOf — 빈 이름은 + · 영문은 대문자 · 한글은 첫 글자', () => {
    expect(initialOf('')).toBe('+');
    expect(initialOf('kim')).toBe('K');
    expect(initialOf('김민수')).toBe('김');
    expect(initialOf('DOMAIN\\lee')).toBe('D');
  });
  it('colorIndexOf 는 0~5 안정값', () => {
    expect(colorIndexOf('kim')).toBe(colorIndexOf('kim'));
    for (const n of ['a', 'kim', '김민수', 'zzz']) expect(colorIndexOf(n)).toBeGreaterThanOrEqual(0);
    for (const n of ['a', 'kim', '김민수', 'zzz']) expect(colorIndexOf(n)).toBeLessThan(6);
  });
  it('groupByStatus 는 순서를 지키고 모르는 상태를 버리지 않는다', () => {
    const g = groupByStatus([{ key: 'a', status: 'todo' }, { key: 'b', status: 'weird' }, { key: 'c', status: 'todo' }]);
    expect(Object.keys(g).slice(0, 5)).toEqual([...STATUS_ORDER]);
    expect(g.todo.map((r) => r.key)).toEqual(['a', 'c']);
    expect(g.unknown.map((r) => r.key)).toEqual(['b']);
  });
  it('toDateInput/fromDateInput 왕복 · 잘못된 값은 null', () => {
    const t = fromDateInput('2026-11-03');
    expect(toDateInput(t)).toBe('2026-11-03');
    expect(fromDateInput('11/03')).toBeNull();
    expect(toDateInput(null)).toBe('');
  });
  it('parseLabels 는 쉼표·공백으로 나눈다', () => {
    expect(parseLabels('vcenter, 수집  pl-waw')).toEqual(['vcenter', '수집', 'pl-waw']);
    expect(parseLabels('')).toEqual([]);
  });
});

describe('filterRows · myWork', () => {
  const rows = [
    { key: 'ISS-1', title: 'vCenter 타임아웃', status: 'progress', priority: 'p0', type: 'incident', assignee: 'kim', reporter: 'jung', dueAt: NOW + DAY, labels: ['vcenter'], updatedAt: 1 },
    { key: 'ISS-2', title: '용량 조정', status: 'todo', priority: 'p2', type: 'task', assignee: 'lee', reporter: 'kim', dueAt: NOW - DAY, labels: [], updatedAt: 2 },
    { key: 'ISS-3', title: '온보딩', status: 'backlog', priority: 'p1', type: 'task', assignee: '', reporter: 'kim', dueAt: null, labels: [], updatedAt: 3 },
    { key: 'ISS-4', title: '끝', status: 'done', priority: 'p3', type: 'improve', assignee: 'kim', reporter: 'lee', dueAt: NOW - 5 * DAY, labels: [], updatedAt: 4, closedAt: NOW },
  ];
  it('필터 축 — 담당자·미할당·우선순위·유형·상태·검색어·내 것', () => {
    expect(filterRows(rows, { assignee: 'kim' }).map((r) => r.key)).toEqual(['ISS-1', 'ISS-4']);
    expect(filterRows(rows, { assignee: '__none' }).map((r) => r.key)).toEqual(['ISS-3']);
    expect(filterRows(rows, { priority: 'p2' }).map((r) => r.key)).toEqual(['ISS-2']);
    expect(filterRows(rows, { type: 'task' }).length).toBe(2);
    expect(filterRows(rows, { status: 'done' }).map((r) => r.key)).toEqual(['ISS-4']);
    expect(filterRows(rows, { q: 'VCENTER' }).map((r) => r.key)).toEqual(['ISS-1']);
    expect(filterRows(rows, { mine: true, me: 'lee' }).map((r) => r.key)).toEqual(['ISS-2']);
    expect(filterRows(rows, {}).length).toBe(4);
  });
  it('myWork — 내 열린 이슈(기한순)·내가 보고한 것·미할당·기한 요약 (완료는 세지 않는다)', () => {
    const w = myWork(rows, 'kim', NOW);
    expect(w.mine.map((r) => r.key)).toEqual(['ISS-1']);
    expect(w.reported.map((r) => r.key)).toEqual(['ISS-2', 'ISS-3']);
    expect(w.unassigned.map((r) => r.key)).toEqual(['ISS-3']);
    expect(w.soon).toBe(1);
    expect(w.overdue).toBe(0);
    const l = myWork(rows, 'lee', NOW);
    expect(l.overdue).toBe(1);
  });
  it('loadPct 는 상한에서 100', () => {
    expect(loadPct(2)).toBe(40);
    expect(loadPct(9)).toBe(100);
    expect(loadPct(null)).toBe(0);
  });
});

describe('문구', () => {
  it('saveFailText — issues-full 은 문장으로, 그 밖은 사유 그대로', () => {
    expect(saveFailText({ reason: 'issues-full', bytes: 16 * 1048576, max: 16 * 1048576 })).toMatch(/상한\(16\.0 MB\)/);
    expect(saveFailText({ reason: 'title: 비어 있습니다' })).toBe('저장하지 못했습니다 — title: 비어 있습니다');
    expect(saveFailText(null)).toBe('저장하지 못했습니다.');
  });
  it('persistNote — saved 는 빈 문자열, failed 는 원인과 함께', () => {
    expect(persistNote({ state: 'saved' })).toBe('');
    expect(persistNote({ state: 'pending' })).toMatch(/기다리는 중/);
    expect(persistNote({ state: 'failed', error: { code: 'ENOSPC', message: '디스크 공간이 부족합니다' } })).toMatch(/ENOSPC/);
  });
  it('historyText — 상태·담당자(사유)·보류·본문', () => {
    expect(historyText({ by: 'kim', field: 'status', from: 'todo', to: 'progress' })).toBe('kim · 상태 할 일 → 진행 중');
    expect(historyText({ by: 'jung', field: 'assignee', from: 'lee', to: 'kim', note: 'vCenter 담당' })).toBe('jung · 담당자 lee → kim (사유: vCenter 담당)');
    expect(historyText({ by: 'kim', field: 'assignee', from: '', to: '' })).toBe('kim · 담당자 미할당 → 미할당');
    expect(historyText({ by: 'kim', field: 'blocked', from: '', to: 'ISS-2 대기' })).toBe('kim · 보류: ISS-2 대기');
    expect(historyText({ by: 'kim', field: 'blocked', from: 'ISS-2 대기', to: '' })).toBe('kim · 보류 해제 (ISS-2 대기)');
    expect(historyText({ by: 'kim', field: 'body' })).toBe('kim · 본문 수정');
    expect(historyText({ by: 'kim', field: 'created', to: 'ISS-1' })).toBe('kim · 이슈 생성 ISS-1');
    expect(historyText(null)).toBe('');
  });
  it('peopleOptions — 서버 목록 + 지금 값, 이름순, 표시 이름은 괄호', () => {
    const o = peopleOptions([{ username: 'lee', name: '이서연' }, { username: 'kim', name: 'kim' }], 'DOMAIN\\park');
    expect(o.map((x) => x.username)).toEqual(['DOMAIN\\park', 'kim', 'lee']);
    expect(o.find((x) => x.username === 'lee').label).toBe('lee (이서연)');
  });
  it('makeLatest — 늦게 온 이전 응답은 최신이 아니다', () => {
    const l = makeLatest();
    const a = l.next(); const b = l.next();
    expect(l.isLatest(a)).toBe(false);
    expect(l.isLatest(b)).toBe(true);
    l.invalidate();
    expect(l.isLatest(b)).toBe(false);
  });
});
