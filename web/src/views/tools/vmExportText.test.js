// v2.799 'VM 전체 정보 내보내기' 화면 도우미 — 출처 배지 · 상태 타일(모름은 '—') · 저장값(고른 것만) · 요청 본문 · 순서 바꾸기.
import { describe, it, expect } from 'vitest';
import {
  SLOT_COUNT, MISSING, LIVE_LATER, badgeOf, sourceTiles, agoText, moveCol, dropCol, toggleCol, addCols, dropCols, initialState, valueToSave, applyValue,
  slotLabel, defaultLine, savedText, exportBody, targetCount, liveMissCount, footerText, cellKind,
} from './vmExportText.js';

const OK = { live: { state: 'ok' }, parts: { on: true }, tags: { state: 'ok' } };
const SITE = { live: { state: 'blocked', reason: '엣지 위임 vCenter — 담당 엣지가 수집하므로 중앙이 직접 로그인하지 않습니다', skipReason: 'site' }, parts: { on: false }, tags: { state: 'not-collected' } };

describe('출처 배지 — 그 vCenter 의 실제 상태로 말한다', () => {
  it('항상 · 캐시 · 캐시·실시간 · 캐시로 대체', () => {
    expect(badgeOf({ src: 'snap' }, OK)).toEqual({ text: '항상', tone: 'ok' });
    expect(badgeOf({ src: 'cache' }, SITE).text).toBe('캐시');
    expect(badgeOf({ src: 'both' }, OK).text).toBe('캐시 · 실시간');
    expect(badgeOf({ src: 'both' }, SITE).text).toBe('캐시로 대체');
    expect(badgeOf({ src: 'both' }, OK, false).text).toBe('캐시');
  });
  it('실시간 전용 — 엣지 위임이면 이 vCenter 불가 · 끄면 실시간 끔', () => {
    expect(badgeOf({ src: 'live' }, OK)).toEqual({ text: '실시간', tone: 'live' });
    expect(badgeOf({ src: 'live' }, SITE)).toEqual({ text: '이 vCenter 불가', tone: 'no' });
    expect(badgeOf({ src: 'live' }, OK, false).text).toBe('실시간 끔');
  });
  it('파티션 · 태그', () => {
    expect(badgeOf({ src: 'parts' }, OK).text).toBe('실시간');
    expect(badgeOf({ src: 'parts' }, SITE).text).toBe('수집 꺼짐');
    expect(badgeOf({ src: 'parts' }, { ...SITE, parts: { on: true } }).text).toBe('수집 켜야 함');
    expect(badgeOf({ src: 'tags' }, OK).text).toBe('캐시');
    expect(badgeOf({ src: 'tags' }, SITE).text).toBe('수집 전');
    expect(badgeOf({ src: 'tags' }, { tags: { state: 'unsupported' } }).text).toBe('이 vCenter 미지원');
  });
});

describe('상태 타일 — 모르는 수는 0 이 아니라 —', () => {
  const now = Date.UTC(2026, 9, 27, 0, 0);
  it('값이 있으면 그대로 · 못 읽은 VM 수 · 실시간 불가 사유', () => {
    const t = sourceTiles({ ...SITE, vmTotal: 214, vmOn: 200, templates: 3, cfgVms: 210, devVms: 205, invAt: now - 41_000, parts: { on: true, vms: 180, at: now - 3 * 3_600_000 }, tags: { state: 'ok', categories: 7, at: now - 7_200_000 } }, { now });
    expect(t.map((x) => x.key)).toEqual(['inv', 'cfg', 'live', 'parts', 'tags']);
    expect(t[0]).toMatchObject({ value: '214대', meta: '켜짐 200 · 템플릿 3 · 마지막 41초 전' });
    expect(t[1].meta).toContain('아직 못 읽은 VM 4대');
    expect(t[2]).toMatchObject({ value: '쓸 수 없음', tone: 'no' });
    expect(t[2].meta).toContain('엣지 위임');
    expect(t[3]).toMatchObject({ value: '180대', meta: '수집 켜짐 · Tools 가 도는 VM 만 · 3시간 전' });
    expect(t[4]).toMatchObject({ value: '카테고리 7', meta: '마지막 수집 2시간 전' });
  });
  it('모르면 — · 실시간 끔', () => {
    const t = sourceTiles({}, { liveOn: false, now });
    expect(t[0].value).toBe('—대');
    expect(t[1].value).toBe('— / —');
    expect(t[2].value).toBe('끔');
    expect(t[3].value).toBe('—');
    expect(t[4].value).toBe('—');
    expect(agoText(null)).toBe('');
    expect(agoText(now - 90_000, now)).toBe('1분 전');
    expect(agoText(now - 3 * 86_400_000, now)).toBe('3일 전');
  });
});

describe('고른 항목 — 순서 · 끌어 놓기 · 묶음', () => {
  it('moveCol · dropCol · toggle · add/drop', () => {
    expect(moveCol(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveCol(['a', 'b'], 'a', -1)).toEqual(['a', 'b']);
    expect(dropCol(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
    expect(dropCol(['a', 'b'], 'x', 'a')).toEqual(['a', 'b']);
    expect(dropCol(['a', 'b'], 'a', 'a')).toEqual(['a', 'b']);
    expect(toggleCol(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleCol(['a', 'b'], 'a')).toEqual(['b']);
    expect(addCols(['b'], ['a', 'b', 'c'])).toEqual(['b', 'a', 'c']);
    expect(dropCols(['a', 'b', 'c'], ['a', 'c'])).toEqual(['b']);
  });
});

describe('저장값 — 고른 것만 싣고 불러올 때 그것만 바꾼다', () => {
  const cat = { defaultPreset: 'asset', presets: [{ id: 'legacy', keys: ['x'] }, { id: 'asset', keys: ['name', 'uuid'] }] };
  it('처음 상태 = 기본 조합 · 내 기본값이 있으면 그것', () => {
    expect(initialState(cat, null)).toEqual({ cols: ['name', 'uuid'], fmt: 'csv', disk: 'slots', tagCols: false, live: true, target: 'all', folder: '', tmpl: true });
    expect(initialState(cat, { def: { cols: ['vcenter'], fmt: 'xlsx', live: false } })).toMatchObject({ cols: ['vcenter'], fmt: 'xlsx', live: false, disk: 'slots' });
  });
  it('valueToSave — what 에서 고른 것만', () => {
    const st = { cols: ['a'], fmt: 'xlsx', disk: 'join', tagCols: true, live: false, target: 'folder', folder: 'Prod', tmpl: false };
    expect(valueToSave(st, {}, '이름')).toEqual({ name: '이름', cols: ['a'] });
    expect(valueToSave(st, { fmt: true, view: true, live: true, target: true }, 'x'.repeat(40))).toEqual({ name: 'x'.repeat(30), cols: ['a'], fmt: 'xlsx', disk: 'join', tagCols: true, live: false, target: 'folder', folder: 'Prod', tmpl: false });
    expect(valueToSave({ ...st, target: 'on' }, { target: true }).folder).toBe('');
  });
  it('applyValue — 없는 것은 지금 화면 값 그대로 · 모르는 값은 무시', () => {
    const st = { cols: ['a'], fmt: 'csv', disk: 'slots', tagCols: false, live: true, target: 'all', folder: '', tmpl: true };
    expect(applyValue(st, { cols: ['b'] })).toEqual({ ...st, cols: ['b'] });
    expect(applyValue(st, { cols: ['b'], fmt: 'pdf', disk: 'x', target: 'folder', folder: 'Dev' })).toEqual({ ...st, cols: ['b'], target: 'folder', folder: 'Dev' });
    expect(applyValue(st, null)).toBe(st);
  });
  it('칸 · 기본값 줄 · 저장 문구', () => {
    expect(SLOT_COUNT).toBe(5);
    expect(slotLabel(null, 2)).toEqual({ no: '3', name: '이름3 — 비어 있음', empty: true, cols: 0 });
    expect(slotLabel({ name: '월간', cols: ['a', 'b'] }, 0)).toEqual({ no: '1', name: '월간', empty: false, cols: 2 });
    expect(defaultLine(null)).toContain('포탈 기본 조합');
    expect(defaultLine({ def: { from: 1, cols: ['a'], droppedCols: 2 }, slots: [{ name: '월간' }] })).toContain("1번 ‘월간’ · 1개 항목 · 없어진 항목 2개 뺌");
    expect(savedText(2, { name: '용량', cols: ['a'], fmt: 'csv', live: false }, true)).toBe('2번 ‘용량’ 에 저장했습니다(1개 항목 · 형식 · 실시간 보강) · 기본값으로도 씁니다.');
    expect(savedText('default', { cols: ['a', 'b'] })).toBe('기본값으로 저장했습니다(2개 항목).');
  });
});

describe('요청 본문 · 아래 막대 · 칸 모양', () => {
  it('exportBody — 폴더는 폴더 대상일 때만 · 저장값 이름', () => {
    expect(exportBody({ cols: ['a'], live: false, disk: 'join', tagCols: true, target: 'all', folder: 'x', tmpl: false })).toEqual({ cols: ['a'], live: false, disk: 'join', tagCols: true, target: 'all', tmpl: false });
    expect(exportBody({ cols: ['a'], target: 'folder', folder: 'Prod' }, '월간')).toEqual({ cols: ['a'], live: true, disk: 'slots', tagCols: false, target: 'folder', folder: 'Prod', tmpl: true, prefName: '월간' });
  });
  it('대상 수 · 실시간 미수집 경고 수 · 아래 막대 글자', () => {
    const status = { vmTotal: 10, vmOn: 7, folders: [{ path: 'Prod', count: 4 }], ...SITE };
    expect([targetCount(status, 'all'), targetCount(status, 'on'), targetCount(status, 'folder', 'Prod'), targetCount(status, 'folder', 'x')]).toEqual([10, 7, 4, undefined]);
    const itemOf = new Map([['uuid', { src: 'live' }], ['name', { src: 'snap' }], ['nics', { src: 'live' }]]);
    expect(liveMissCount(['uuid', 'name', 'nics'], itemOf, status, true)).toBe(2);
    expect(liveMissCount(['uuid'], itemOf, OK, true)).toBe(0);
    expect(liveMissCount(['uuid'], itemOf, OK, false)).toBe(1);
    expect(footerText({ items: 21, colsCount: 55, rows: 642 })).toBe('21개 항목 · 55열 · 642대');
    expect(footerText({ items: 3, colsCount: null, rows: undefined })).toBe('3개 항목 · 열 수 계산 중 · —대');
  });
  it('칸 모양 — 서버 글자와 같다', () => {
    expect(MISSING).toBe('수집 안 됨');
    expect(LIVE_LATER).toBe('내려받을 때 조회');
    expect([cellKind(MISSING), cellKind(LIVE_LATER), cellKind(''), cellKind(0)]).toEqual(['missing', 'later', '', '']);
  });
});
