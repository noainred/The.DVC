// v2.916 설정 화면 왼쪽 목록 — 검색 · 상태 요약 · 배지 · 최근/즐겨찾기 · 단축키(views/settingsMenu.js).
import { describe, it, expect } from 'vitest';
import { badgeOf, filterByGrade, groupTone, isSearchHotkey, pushRecent, readKeyList, searchItems, summarize, toggleFav } from './settingsMenu.js';

const ITEMS = [
  { k: 'vcenter-admin', label: 'vCenter 등록·관리', group: 'infra', desc: '수집할 vCenter 의 주소 · 계정' },
  { k: 'mail', label: '메일 발송', group: 'notify', desc: '포탈 모든 기능이 함께 쓰는 SMTP 설정' },
  { k: 'alerts', label: '알림', group: 'notify', desc: '임계 규칙과 알림 채널 — 메일 · 웹훅' },
  { k: 'gpu-guest', label: 'GPU 게스트 수집', group: 'guestgpu', desc: 'nvidia-smi 로 수집' },
];
const GL = { infra: '인프라 등록', notify: '알림·메일', guestgpu: '게스트·GPU' };

describe('searchItems', () => {
  it('빈 검색은 그대로', () => { expect(searchItems(ITEMS, '  ', GL)).toBe(ITEMS); });
  it('이름 · 설명 · 묶음 · 키에서 찾고, 낱말은 모두 맞아야 한다', () => {
    expect(searchItems(ITEMS, 'smtp', GL).map((i) => i.k)).toEqual(['mail']);
    expect(searchItems(ITEMS, '게스트·gpu', GL).map((i) => i.k)).toEqual(['gpu-guest']);
    expect(searchItems(ITEMS, 'gpu-guest', GL).map((i) => i.k)).toEqual(['gpu-guest']);
    expect(searchItems(ITEMS, '메일 웹훅', GL).map((i) => i.k)).toEqual(['alerts']);
    expect(searchItems(ITEMS, '없는말', GL)).toEqual([]);
  });
  it('이름이 맞는 항목이 설명만 맞는 항목보다 앞', () => {
    expect(searchItems(ITEMS, '메일', GL).map((i) => i.k)).toEqual(['mail', 'alerts']);
    expect(searchItems(ITEMS, '알림', GL).map((i) => i.k)).toEqual(['alerts', 'mail']);
  });
});

describe('상태 배지 · 요약', () => {
  const st = { mail: { grade: 'unset', text: 'SMTP 미설정' }, alerts: { grade: 'warn', text: 'x', count: 3 }, 'gpu-guest': { grade: 'off', text: '꺼짐' } };
  it('badgeOf — 정상(등급 없음 · 모르는 등급)은 null, 주의는 수를 붙인다', () => {
    expect(badgeOf(undefined)).toBe(null);
    expect(badgeOf({ grade: 'ok' })).toBe(null);
    expect(badgeOf(st.mail)).toEqual({ tone: 'unset', short: '미설정', text: 'SMTP 미설정' });
    expect(badgeOf(st.alerts).short).toBe('주의 3');
    expect(badgeOf({ grade: 'warn', text: 'y' }).short).toBe('주의');
    expect(badgeOf({ grade: 'unknown', text: '상태를 읽지 못함' }).short).toBe('?');
  });
  it('summarize — 보이는 항목만 센다 · 상태를 못 받았으면 0', () => {
    expect(summarize(ITEMS, st)).toEqual({ unset: 1, warn: 1, new: 0, unknown: 0, off: 1 });
    expect(summarize(ITEMS.slice(0, 1), st)).toEqual({ unset: 0, warn: 0, new: 0, unknown: 0, off: 0 });
    expect(summarize(ITEMS, null).unset).toBe(0);
  });
  it('groupTone — 주의 > 미설정 > 새 버전, 꺼짐만 있으면 표지 없음', () => {
    expect(groupTone(ITEMS.filter((i) => i.group === 'notify'), st)).toBe('warn');
    expect(groupTone(ITEMS.filter((i) => i.k === 'mail'), st)).toBe('unset');
    expect(groupTone(ITEMS.filter((i) => i.group === 'guestgpu'), st)).toBe(null);
  });
  it('filterByGrade — 상태를 못 받았는데 칩으로 거르면 빈 목록(지어내지 않는다)', () => {
    expect(filterByGrade(ITEMS, st, 'unset').map((i) => i.k)).toEqual(['mail']);
    expect(filterByGrade(ITEMS, null, 'unset')).toEqual([]);
    expect(filterByGrade(ITEMS, st, null)).toBe(ITEMS);
  });
});

describe('최근 · 즐겨찾기 · 저장소 값', () => {
  const VALID = ['a', 'b', 'c', 'd'];
  it('pushRecent — 맨 앞 · 중복 제거 · 모르는 키 버림 · 상한', () => {
    expect(pushRecent(['b', 'a'], 'a', VALID)).toEqual(['a', 'b']);
    expect(pushRecent(['x', 'b'], 'c', VALID)).toEqual(['c', 'b']);
    expect(pushRecent(['a', 'b', 'c'], 'd', VALID, 2)).toEqual(['d', 'a']);
    expect(pushRecent(null, 'a', VALID)).toEqual(['a']);
  });
  it('toggleFav — 넣고 빼기 · 상한', () => {
    expect(toggleFav(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleFav(['a', 'b'], 'a')).toEqual(['b']);
    expect(toggleFav(['a', 'b'], 'c', 2)).toEqual(['b', 'c']);
  });
  it('readKeyList — 깨진 JSON · 배열 아님 · 모르는 키 · 중복은 버린다', () => {
    expect(readKeyList(null, VALID)).toEqual([]);
    expect(readKeyList('{x', VALID)).toEqual([]);
    expect(readKeyList('{"a":1}', VALID)).toEqual([]);
    expect(readKeyList('["a","zz","a",3,"b"]', VALID)).toEqual(['a', 'b']);
  });
});

describe('isSearchHotkey', () => {
  const ev = (o) => ({ key: '/', target: { tagName: 'BODY' }, ...o });
  it('본문에서 / 만 받는다', () => {
    expect(isSearchHotkey(ev({}))).toBe(true);
    expect(isSearchHotkey(ev({ key: 'a' }))).toBe(false);
    expect(isSearchHotkey(ev({ ctrlKey: true }))).toBe(false);
    expect(isSearchHotkey(ev({ isComposing: true }))).toBe(false);
  });
  it('입력 중에는 받지 않는다', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) expect(isSearchHotkey(ev({ target: { tagName } }))).toBe(false);
    expect(isSearchHotkey(ev({ target: { tagName: 'DIV', isContentEditable: true } }))).toBe(false);
  });
});
