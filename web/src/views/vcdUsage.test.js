// v2.492 — VM 기간 실사용률 표시 로직(순수) 회귀 고정.
// 핵심: (1) 조회 대상은 '펼쳐진 폴더/호스트의 VM' 뿐인가(전량 조회 금지 — 고RTT 보호),
// (2) 기간별로 따로 캐시해 기간을 되돌렸을 때 재조회하지 않는가, (3) 표본 없음(null)을 0% 로
// 바꾸지 않는가, (4) 요청 기간보다 표본이 짧으면 툴팁이 그 사실을 밝히는가.
import { describe, it, expect } from 'vitest';
import {
  USAGE_DAYS, DEFAULT_USAGE_DAYS, normUsageDays, usageDaysLabel, usageKey,
  visibleTreeVmIds, visibleHostVmIds, pendingIds, mergeUsage, usageText, usageTitle, usagePctColor,
} from './vcdUsage.js';

const vm = (id) => ({ id, name: id });
// 트리: /CDO/{MGMT:[a,b]} · /OC2:[c] · 루트 직속 [z](현재 트리가 렌더하지 않음)
const tree = {
  folders: {
    CDO: { folders: { MGMT: { folders: {}, vms: [vm('a'), vm('b')], count: 2 } }, vms: [vm('d')], count: 3 },
    OC2: { folders: {}, vms: [vm('c')], count: 1 },
  },
  vms: [vm('z')],
  count: 5,
};

describe('기간 프리셋', () => {
  it('기본 30일이고 목록 밖 값은 기본값으로 떨어진다', () => {
    expect(USAGE_DAYS).toEqual([7, 30, 90, 180, 365]);
    expect(DEFAULT_USAGE_DAYS).toBe(30);
    expect(normUsageDays(90)).toBe(90);
    expect(normUsageDays('7')).toBe(7);
    expect(normUsageDays(45)).toBe(30);
    expect(normUsageDays(undefined)).toBe(30);
    expect(usageDaysLabel(365)).toBe('365일');
  });
});

describe('조회 대상 — 화면에 그려지는 행만', () => {
  it('접힌 폴더의 VM 은 대상이 아니다', () => {
    expect(visibleTreeVmIds(tree, {})).toEqual([]);
  });
  it('펼친 폴더의 VM 만, 중첩 폴더는 부모도 펼쳐져야 포함된다', () => {
    expect(visibleTreeVmIds(tree, { 'f:/CDO': true })).toEqual(['d']);
    expect(visibleTreeVmIds(tree, { 'f:/CDO': true, 'f:/CDO/MGMT': true })).toEqual(['a', 'b', 'd']);
    // 부모가 접혀 있으면 자식이 열려 있어도 렌더되지 않으므로 제외
    expect(visibleTreeVmIds(tree, { 'f:/CDO/MGMT': true })).toEqual([]);
  });
  it('루트 직속 VM 은 현재 트리가 렌더하지 않으므로 제외한다(상한 낭비 방지)', () => {
    expect(visibleTreeVmIds(tree, { 'f:/CDO': true, 'f:/OC2': true })).not.toContain('z');
  });
  it('호스트 탭은 펼친 호스트의 VM 만', () => {
    const hosts = [{ id: 'h1', name: 'esx1' }, { id: 'h2', name: 'esx2' }];
    const byHost = new Map([['esx1', [vm('a')]], ['esx2', [vm('b')]]]);
    expect(visibleHostVmIds(hosts, byHost, {})).toEqual([]);
    expect(visibleHostVmIds(hosts, byHost, { 'h:h2': true })).toEqual(['b']);
  });
});

describe('중복 조회 방지·상한', () => {
  it('이미 받은 VM 은 제외하고 상한만큼만 자른다', () => {
    const have = { [usageKey(30, 'a')]: { cpuPct: 5 }, [usageKey(30, 'b')]: null };
    // b 는 '표본 없음' 으로 이미 알고 있으므로 다시 조회하지 않는다
    expect(pendingIds(['a', 'b', 'c', 'd'], 30, have, 10)).toEqual(['c', 'd']);
    expect(pendingIds(['c', 'd', 'e'], 30, have, 2)).toEqual(['c', 'd']);
    expect(pendingIds(['c', 'c', 'd'], 30, have, 10)).toEqual(['c', 'd']); // 중복 제거
  });
  it('기간이 다르면 다시 조회한다(기간별 캐시)', () => {
    const have = { [usageKey(30, 'a')]: { cpuPct: 5 } };
    expect(pendingIds(['a'], 30, have, 10)).toEqual([]);
    expect(pendingIds(['a'], 90, have, 10)).toEqual(['a']);
  });
  it('병합은 기간 키를 붙이고 표본 없음을 null 로 기억한다', () => {
    const next = mergeUsage({}, 7, { a: { cpuPct: 12, memPct: 40 }, b: null });
    expect(next[usageKey(7, 'a')]).toEqual({ cpuPct: 12, memPct: 40 });
    expect(next[usageKey(7, 'b')]).toBe(null);
    expect(usageKey(7, 'a')).not.toBe(usageKey(30, 'a'));
  });
});

describe('문구·색 — 추정 금지', () => {
  it('값이 없으면 문구를 만들지 않는다(0% 로 채우지 않는다)', () => {
    expect(usageText(null, 30)).toBe(null);
    expect(usageText(undefined, 30)).toBe(null);
  });
  it('한쪽 지표만 있으면 없는 쪽은 —', () => {
    expect(usageText({ cpuPct: 12.4, memPct: null }, 30)).toBe('30일 평균 CPU 12% · MEM —');
  });
  it('툴팁은 최대·표본 수와 출처를 밝히고, 표본이 짧으면 경고한다', () => {
    const t = usageTitle({ cpuPct: 10, cpuMax: 55, memPct: 40, memMax: 70, samples: 48, coverageDays: 4 }, 30);
    expect(t).toContain('최대 55%');
    expect(t).toContain('표본 48개');
    expect(t).toContain('4일');
    expect(t).toContain('vCenter 성능 롤업');
    // 커버리지가 요청 기간과 사실상 같으면 경고를 붙이지 않는다
    expect(usageTitle({ cpuPct: 10, cpuMax: 11, memPct: 1, memMax: 2, samples: 30, coverageDays: 29.5 }, 30)).not.toContain('⚠');
  });
  it('합성(데모) 값은 실측이 아님을 툴팁에 밝힌다', () => {
    expect(usageTitle({ cpuPct: 1, memPct: 1, samples: 1, coverageDays: 1 }, 7, { synthesized: true })).toContain('실측이 아닙니다');
    expect(usageTitle(null, 7)).toContain('표본이 없습니다');
  });
  it('색 임계는 트리의 호스트 행과 같다(60/85)', () => {
    expect(usagePctColor(null)).toBe('var(--text-faint)');
    expect(usagePctColor(59)).toBe('var(--green)');
    expect(usagePctColor(60)).toBe('var(--amber)');
    expect(usagePctColor(85)).toBe('var(--red)');
  });
});
