/**
 * issueText2882.test.js — 이슈 확장 v2.882 화면 판정(순수): 칩 글 · 칩 지우기(한 식) · 오류 밑줄 · 번다운 선 · 스프린트 표시 · 에픽 선택지 · 하위 표시 · 이력 문장.
 */
import { describe, it, expect } from 'vitest';
import {
  QUICK_FILTERS, chipText, chipValueText, removeChip, errorSegments, burnPoints, sprintRangeText, sprintName, sprintOptions, epicOptions, childText, historyText, TYPE_TEXT,
} from './issueText.js';

describe('칩 — 사람 말 · 지우면 한 식이 그대로 고쳐진다', () => {
  const q = 'assignee = me() AND status in (progress, review) AND updated >= -7d ORDER BY priority ASC';
  // 서버 parseQuery 가 주는 구간과 같은 꼴(원문 구간)
  const span = (t) => ({ start: q.indexOf(t), end: q.indexOf(t) + t.length });
  const clauses = [
    { field: 'assignee', op: '=', values: ['me()'], ...span('assignee = me()') },
    { field: 'status', op: 'in', values: ['progress', 'review'], ...span('status in (progress, review)') },
    { field: 'updated', op: '>=', values: ['-7d'], ...span('updated >= -7d') },
  ];
  const orderStart = q.indexOf('ORDER');
  it('칩 글', () => {
    expect(chipText(clauses[0], { me: 'kim' })).toBe('담당자 = 나(kim)');
    expect(chipText(clauses[1])).toBe('상태 ∈ 진행 중 · 검토');
    expect(chipText(clauses[2])).toBe('갱신 ≥ 7일 전');
    expect(chipText({ field: 'assignee', op: 'is empty', values: [] })).toBe('담당자 비어 있음');
    expect(chipText({ field: '', op: 'expr', values: [] })).toMatch(/묶음/);
    expect(chipValueText('sprint', 'Sabc', { sprintName: () => '2026-11 ②' })).toBe('2026-11 ②');
    expect(chipValueText('vcenter', 'vc-a', { vcName: () => '서울' })).toBe('서울');
    expect(chipValueText('priority', 'p0')).toBe('P0 긴급');
  });
  it('가운데 칩을 지우면 앞뒤를 AND 로 다시 잇고 정렬은 그대로', () => {
    expect(q.slice(clauses[1].start, clauses[1].end)).toBe('status in (progress, review)');
    expect(removeChip(q, clauses, 1, orderStart)).toBe('assignee = me() AND updated >= -7d ORDER BY priority ASC');
    expect(removeChip(q, clauses, 0, orderStart)).toBe('status in (progress, review) AND updated >= -7d ORDER BY priority ASC');
    expect(removeChip('a = b', [{ start: 0, end: 5 }], 0, -1)).toBe('');
    expect(removeChip(q, clauses, 9, orderStart)).toBe(q);
  });
});

describe('오류 밑줄', () => {
  it('첫 오류 구간만 · 끝에서 난 오류도 한 칸', () => {
    const segs = errorSegments('status = runnig', [{ msg: '알 수 없는 값', start: 9, end: 15, hint: 'progress 를 뜻했나요?' }]);
    expect(segs).toEqual([{ text: 'status = ', bad: false }, { text: 'runnig', bad: true, title: '알 수 없는 값 — progress 를 뜻했나요?' }]);
    expect(errorSegments('a =', [{ msg: '값이 없습니다', start: 3, end: 3 }]).some((s) => s.bad)).toBe(true);
    expect(errorSegments('x', [])).toEqual([{ text: 'x', bad: false }]);
  });
});

describe('번다운 · 스프린트', () => {
  it('아직 오지 않은 날(null)은 그리지 않는다 · 기준선은 첫날 → 끝날 0', () => {
    const p = burnPoints([{ remaining: 4 }, { remaining: 3 }, { remaining: null }, { remaining: null }], 100, 50, 0);
    expect(p.actual.split(' ').length).toBe(2);
    expect(p.max).toBe(4); expect(p.last).toBe(3); expect(p.lastIdx).toBe(1);
    expect(p.ideal).toBe('0.0,0.0 100.0,50.0');
    expect(burnPoints([{ remaining: null }], 100, 50).actual).toBe('');
    // 중간에 넣은 스프린트 — 첫날 0 이어도 기준선은 가장 많이 남았던 수에서 시작한다
    expect(burnPoints([{ remaining: 0 }, { remaining: 4 }, { remaining: null }], 100, 50, 0).ideal).toBe('0.0,0.0 100.0,50.0');
    expect(burnPoints([{ remaining: 0 }, { remaining: 0 }], 100, 50, 0).ideal).toBe('', '0 뿐이면 기준선 없음');
  });
  it('기간 · 이름 · 고를 수 있는 것', () => {
    expect(sprintRangeText({ startDay: '2026-11-03', endDay: '2026-11-14', state: 'active', daysLeft: 10 })).toBe('11-03 ~ 11-14 · 남은 10일');
    expect(sprintRangeText({ startDay: '2026-10-20', endDay: '2026-10-31', state: 'closed' })).toBe('10-20 ~ 10-31 · 끝남');
    expect(sprintRangeText(null)).toBe('—');
    const list = [{ id: 'S1', name: '①', state: 'closed' }, { id: 'S2', name: '②', state: 'active' }];
    expect(sprintName(list, 'S2')).toBe('②'); expect(sprintName(list, 'S9')).toBe('S9'); expect(sprintName(list, '')).toBe('');
    expect(sprintOptions(list).map((s) => s.id)).toEqual(['S2']);
    expect(sprintOptions(list, 'S1').map((s) => s.id)).toEqual(['S1', 'S2'], '지금 값은 끝났어도 보인다');
  });
});

describe('에픽 · 하위 · 이력', () => {
  it('에픽 선택지 — 같은 법인 또는 공용 에픽만', () => {
    const epics = [{ key: 'ISS-1', type: 'epic', vcenterId: '' }, { key: 'ISS-2', type: 'epic', vcenterId: 'vc-a' }, { key: 'ISS-3', type: 'epic', vcenterId: 'vc-b' }];
    expect(epicOptions(epics, { key: 'ISS-9', vcenterId: 'vc-a' }).map((e) => e.key)).toEqual(['ISS-1', 'ISS-2']);
    expect(epicOptions(epics, { key: 'ISS-9', vcenterId: '' }).map((e) => e.key)).toEqual(['ISS-1']);
  });
  it('하위 n/m · 에픽은 이슈 n/m', () => {
    expect(childText({ type: 'task', childCount: 4, childDone: 2 })).toBe('하위 2/4');
    expect(childText({ type: 'epic', childCount: 3, childDone: 1 })).toBe('이슈 1/3');
    expect(childText({ type: 'task', childCount: 0 })).toBe('');
  });
  it('이력 — 상위 · 스프린트', () => {
    expect(historyText({ field: 'parent', by: 'kim', from: '', to: 'ISS-20' })).toBe('kim · 상위 없음 → ISS-20');
    expect(historyText({ field: 'parent', by: 'kim', from: 'ISS-20', to: '' })).toMatch(/상위에서 뺌/);
    expect(historyText({ field: 'sprint', by: 'kim', from: 'S1', to: '', note: '스프린트 끝내기: ② → 백로그' })).toBe('kim · 스프린트 스프린트 끝내기: ② → 백로그');
    expect(TYPE_TEXT.epic).toBe('에픽');
  });
  it('빠른 필터는 검색식 한 줄씩', () => {
    expect(QUICK_FILTERS.length).toBeGreaterThan(3);
    expect(QUICK_FILTERS.every((f) => typeof f.query === 'string' && f.query.length > 5)).toBe(true);
  });
});
