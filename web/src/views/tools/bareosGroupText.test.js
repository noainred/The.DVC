import { describe, it, expect } from 'vitest';
import {
  scheduleText, draftIssues, toggleDay, GROUP_FILTERS, groupRowMatches, groupFilterCounts, pickable, buildGroupTree, checkState,
  fireText, fireTone, nextText, storageText, NEW_SCHEDULE,
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
  { id: 'a', name: 'web-01', folder: 'DC/web', method: 'bareos', job: { id: 'j1' }, eligible: true, groupId: 'g1' },
  { id: 'b', name: 'web-02', folder: 'DC/web', method: 'veeam', job: null, eligible: true, groupId: '' },
  { id: 'c', name: 'vapp', folder: 'DC/app', method: '', job: null, eligible: false, reason: '경로 없음', groupId: '' },
  { id: 'd', name: 'db', folder: 'DC/app/db', method: 'bareos', job: { id: 'j4' }, eligible: true, groupId: 'g2' },
];
const NAME = (id) => ({ g1: '웹', g2: 'DB' }[id] || '');

describe('트리·고르기', () => {
  it('필터 수', () => {
    expect(groupFilterCounts(VMS)).toEqual({ all: 4, bareos: 2, nojob: 2, nogroup: 2, ingroup: 2 });
    expect(GROUP_FILTERS.map(([k]) => k)).toEqual(Object.keys(groupFilterCounts([])));
    expect(VMS.filter((r) => groupRowMatches(r, 'nojob')).map((r) => r.id)).toEqual(['b', 'c']);
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
