import { describe, it, expect } from 'vitest';
import {
  scheduleText, draftIssues, toggleDay, GROUP_FILTERS, groupRowMatches, groupFilterCounts, pickable, buildGroupTree, checkState,
  fireText, fireTone, nextText, storageText, NEW_SCHEDULE,
  isDaily, setCadence, scheduleParts, keepText, stepKeep, keepMeaning, keepParts, fireKeepBadge, untilText, memberResults, resultBadge, folderSummary, sizeSum,
} from './bareosGroupText.js';

// 서버 bareosGroups2830 ① 과 같은 입력·같은 글자(두 벌이라 대조한다)
describe('scheduleText — 서버 groupSchedule.scheduleText 와 같은 글자', () => {
  it('요일·매일·Full 요일·꺼짐', () => {
    expect(scheduleText({ enabled: true, days: [1, 3, 5], time: '02:10', level: 'Incremental', fullDays: [5] })).toBe('월·수·금 02:10 Incremental (Full: 금)');
    expect(scheduleText({ enabled: true, days: [0, 1, 2, 3, 4, 5, 6], time: '02:10', level: 'Incremental' })).toBe('매일 02:10 Incremental');
    expect(scheduleText({ enabled: false, days: [1, 3, 5], time: '02:10', level: 'Incremental', fullDays: [5] })).toBe('스케줄 꺼짐(수동 실행만)');
    expect(scheduleText(null)).toBe('스케줄 꺼짐(수동 실행만)');
    expect(scheduleText(NEW_SCHEDULE)).toBe('매일 02:10 Incremental');
  });
});

describe('편집 창 판정', () => {
  it('이름·VM·상한·시각·요일', () => {
    expect(draftIssues({ name: '웹', vmIds: ['a'], schedule: NEW_SCHEDULE })).toEqual([]);
    const bad = draftIssues({ name: ' ', vmIds: [], schedule: { enabled: true, days: [], time: '2:10' } });
    expect(bad).toHaveLength(4);
    expect(draftIssues({ name: 'x', vmIds: ['a', 'b', 'c'], schedule: NEW_SCHEDULE }, { maxMembers: 2 })[0]).toMatch(/2대까지/);
    expect(draftIssues({ name: 'x', vmIds: ['a'], schedule: { enabled: false, days: [], time: '23:59' } })).toEqual([]);
  });
  it('요일 끄면 그 요일의 Full 도 빠진다 · 정렬 유지', () => {
    let s = { ...NEW_SCHEDULE, fullDays: [0, 5] };
    s = toggleDay(s, 5);
    expect(s.days).toEqual([0, 1, 2, 3, 4, 6]);
    expect(s.fullDays).toEqual([0]);
    s = toggleDay(s, 5);
    expect(s.days).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(toggleDay(s, 3, 'fullDays').fullDays).toEqual([0, 3]);
  });
});

const VMS = [
  { id: 'a', name: 'web-01', folder: 'DC/web', method: 'bareos', job: { id: 'j1' }, eligible: true, groupId: 'g1', power: 'POWERED_ON' },
  { id: 'b', name: 'web-02', folder: 'DC/web', method: 'veeam', job: null, eligible: true, groupId: '' },
  { id: 'c', name: 'vapp', folder: 'DC/app', method: '', job: null, eligible: false, reason: '경로 없음', groupId: '' },
  { id: 'd', name: 'db', folder: 'DC/app/db', method: 'bareos', job: { id: 'j4' }, eligible: true, groupId: 'g2', power: 'POWERED_ON' },
];
const NAME = (id) => ({ g1: '웹', g2: 'DB' }[id] || '');

describe('트리·고르기', () => {
  it('필터 수', () => {
    expect(groupFilterCounts(VMS)).toEqual({ all: 4, nogroup: 2, on: 2, nojob: 2 });
    expect(GROUP_FILTERS.map(([k]) => k)).toEqual(Object.keys(groupFilterCounts([])));
    expect(VMS.filter((r) => groupRowMatches(r, 'nojob')).map((r) => r.id)).toEqual(['b', 'c']);
    // v2.831: 편집 중인 그룹의 VM 은 '그룹 없음' 에도 보인다(고를 수 있으므로)
    expect(VMS.filter((r) => groupRowMatches(r, 'nogroup', 'g1')).map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(groupFilterCounts(VMS, 'g2').nogroup).toBe(3);
  });
  it('고를 수 있나 — 다른 그룹·등록 불가는 못 고른다 · 편집 중 그룹의 VM 은 고른다', () => {
    expect(pickable(VMS[0], { groupName: NAME }).ok).toBe(false);
    expect(pickable(VMS[0], { groupName: NAME }).why).toMatch(/‘웹’/);
    expect(pickable(VMS[0], { editingId: 'g1', groupName: NAME }).ok).toBe(true);
    expect(pickable(VMS[1]).ok).toBe(true);
    expect(pickable(VMS[2]).why).toBe('경로 없음');
  });
  it('폴더마다 고를 수 있는 VM id · 체크 상태', () => {
    const t = buildGroupTree(VMS, { groupName: NAME });
    const dc = t.children[0];
    expect(dc.name).toBe('DC');
    expect(dc.pickIds.sort()).toEqual(['b']);
    const t2 = buildGroupTree(VMS, { editingId: 'g2', groupName: NAME });
    expect(t2.children[0].pickIds.sort()).toEqual(['b', 'd']);
    expect(checkState(['b', 'd'], new Set(['b']))).toBe('some');
    expect(checkState(['b', 'd'], new Set(['b', 'd']))).toBe('all');
    expect(checkState([], new Set(['b']))).toBe('none');
    const filtered = buildGroupTree(VMS, { filter: 'nogroup', q: 'web' });
    expect(filtered.children[0].children.map((c) => c.name)).toEqual(['web']);
  });
});

describe('실행 결과 문구', () => {
  it('0 인 칸은 빼고 · 색 · 기록 없음은 —', () => {
    const at = new Date(2026, 9, 31, 2, 10).getTime();
    expect(fireText({ at, trigger: 'timer', total: 4, started: 3, skipped: 1, failed: 0, unknown: 0 })).toBe('10-31 02:10 예약 · 시작 3 · 건너뜀 1');
    expect(fireText({ at, trigger: 'manual', total: 2, started: 0, skipped: 0, failed: 0, unknown: 0 })).toBe('10-31 02:10 수동 · VM 2대');
    expect(fireText(null)).toBe('—');
    expect(fireTone({ started: 3, failed: 1 })).toBe('bad');
    expect(fireTone({ started: 3, unknown: 1 })).toBe('warn');
    expect(fireTone({ started: 3 })).toBe('ok');
    expect(fireTone({ error: 'x' })).toBe('bad');
    expect(fireTone({ started: 1, notSent: 2 })).toBe('bad');
    expect(fireText({ at, trigger: 'timer', total: 3, started: 1, notSent: 2 })).toBe('10-31 02:10 예약 · 시작 1 · 보내지 못함 2');
    expect(nextText(null)).toBe('—');
    expect(nextText({ at, level: 'Full' })).toBe('10-31 02:10 Full');
    expect(storageText({ storage: '', pool: 'Long' }, { storage: 'kr-sd', pool: 'P' })).toBe('기본(kr-sd) · Long');
  });
});

describe('v2.831 시안 — 스케줄·보관·실행 이력', () => {
  it('매일 ↔ 매주 · 두 줄 스케줄', () => {
    const s0 = { ...NEW_SCHEDULE, fullDays: [0] };
    expect(isDaily(s0)).toBe(true);
    const w = setCadence(s0, false);
    expect(w.days).toEqual([0]);
    expect(w.fullDays).toEqual([0]);
    const w2 = setCadence({ ...s0, days: [1, 3], fullDays: [0] }, false);
    expect(w2.days).toEqual([1, 3]);
    expect(w2.fullDays).toEqual([], 'Full 요일은 실행 요일 안에서만');
    expect(setCadence(w2, true).days).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(scheduleParts({ ...s0, time: '02:00' })).toEqual({ main: '매일 02:00', sub: 'Incremental · 일요일 Full' });
    expect(scheduleParts({ enabled: true, days: [1, 3, 5], time: '23:00', level: 'Full', fullDays: [] })).toEqual({ main: '매주 월·수·금 23:00', sub: 'Full' });
    expect(scheduleParts({ ...s0, enabled: false })).toEqual({ main: '—', sub: '수동 실행만' });
  });
  it('보관 개수 — 서버 groupRetention.keepText 와 같은 글자 · −/+ 범위 · 풀이', () => {
    expect(keepText(null)).toBe('보관 개수 제한 없음');
    expect(keepText(14)).toBe('최근 14회 보관');
    expect(stepKeep(1, -1)).toBe(1);
    expect(stepKeep(365, 1)).toBe(365);
    expect(stepKeep(7, 1)).toBe(8);
    expect(keepMeaning(14, NEW_SCHEDULE)).toBe('매일이면 14일치');
    expect(keepMeaning(6, { enabled: true, days: [1, 3, 5] })).toBe('주 3회면 약 2주치');
    expect(keepMeaning(3, { enabled: false })).toBe('수동 실행 3회분');
  });
  it('보관 두 줄 — 정리 전 · 보유 범위 · 체인 유지 · 실패', () => {
    expect(keepParts({ keep: null }).main).toBe('제한 없음');
    expect(keepParts({ keep: 14, lastPrune: null }).sub).toMatch(/첫 정리 전/);
    const at = new Date(2026, 9, 31, 2, 40).getTime();
    expect(keepParts({ keep: 14, lastPrune: { at, keptMin: 14, keptMax: 14, deleted: 12 } })).toEqual({ main: '14개 중 14개 보유', sub: '마지막 정리 10-31 02:40 · 12건 지움', bad: false });
    const k = keepParts({ keep: 7, lastPrune: { at, keptMin: 3, keptMax: 9, deleted: 0, failed: 1, noBase: 2 } });
    expect(k.main).toBe('3~9개 보유 · 보관 7회');
    expect(k.sub).toMatch(/정리 실패 1.*기준 Full 없음 2대.*Full 체인 유지로 더 남김/);
    expect(k.bad).toBe(true);
    expect(keepParts({ keep: 7, lastPrune: { at, keptMin: null, keptMax: null } }).main).toBe('7개 중 —개 보유');
    expect(keepParts({ keep: 7, lastPrune: { at, keptMin: 7, keptMax: 7, unknownDeleted: 2 } })).toMatchObject({ main: '7개 중 7개 보유', bad: true });
  });
  it('실행 이력 보관 표지 — 다음 회차가 기준 Full 이하면 정리됨 · 없거나 뒤면 보관 중 · 그 사이 일부 · 모르면 표지 없음', () => {
    const g = { keep: 3, lastPrune: { baseMin: 1000, baseMax: 2000 } };
    expect(fireKeepBadge({ at: 500, started: 2 }, { at: 900 }, g)).toBe('pruned');
    expect(fireKeepBadge({ at: 900, started: 2 }, { at: 1500 }, g)).toBe('partial');
    expect(fireKeepBadge({ at: 1500, started: 2 }, { at: 2500 }, g)).toBe('kept');
    expect(fireKeepBadge({ at: 2500, started: 2 }, null, g)).toBe('kept');
    expect(fireKeepBadge({ at: 2500, started: 0 }, null, g)).toBe(null);
    expect(fireKeepBadge({ at: 2500, started: 2 }, null, { keep: null, lastPrune: g.lastPrune })).toBe(null);
    expect(fireKeepBadge({ at: 2500, started: 2 }, null, { keep: 3, lastPrune: null })).toBe(null);
    expect(fireKeepBadge({ at: 2500, started: 2 }, null, { keep: 3, lastPrune: { baseMin: null, baseMax: null } })).toBe(null);
  });
  it('남은 시간 · 멤버 결과 · 폴더 요약 · 용량 합(못 읽은 값은 따로)', () => {
    expect(untilText(0)).toBe('');
    expect(untilText(-5)).toBe('');
    expect(untilText(25 * 60_000)).toBe('25분 뒤');
    expect(untilText((17 * 60 + 55) * 60_000)).toBe('17시간 55분 뒤');
    expect(untilText(50 * 3_600_000)).toBe('2일 2시간 뒤');
    const rows = [{ b: { st: 'ok' } }, { b: { st: 'warning' } }, { b: { st: 'error' } }, { b: { run: 'running', st: 'ok' } }, { b: null }];
    const m = memberResults(rows);
    expect(m).toEqual({ n: 5, ok: 2, warn: 1, fail: 1, run: 1, never: 1 });
    expect(resultBadge(m)).toEqual({ text: '진행 1/5', tone: 'run' });
    expect(resultBadge({ ...m, run: 0 }).text).toBe('실패 1 · 성공 3');
    expect(resultBadge({ n: 2, ok: 2, warn: 0, fail: 0, run: 0, never: 0 })).toEqual({ text: '성공 2/2', tone: 'ok' });
    expect(resultBadge({ n: 2, ok: 0, warn: 0, fail: 0, run: 0, never: 2 }).text).toBe('백업 기록 없음');
    expect(folderSummary([{ folder: 'A/DB' }, { folder: 'A/DB' }])).toBe('A/DB');
    expect(folderSummary([{ folder: 'B' }, { folder: 'A' }, { folder: '' }])).toBe('A 외 1곳');
    expect(folderSummary([])).toBe('—');
    expect(sizeSum([{ gb: 10 }, { gb: null }, { gb: 0 }, {}])).toEqual({ gb: 10, unknown: 2 });
  });
});
