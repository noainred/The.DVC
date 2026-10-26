// storageUsageText.test.js — 스토리지 사용량 보고서 화면 규칙(v2.788).
// 서버 storage/usageReport.js · usageMailRules.js · resources.js · isidu/mailRules.js 와 **같은 입력으로 대조**한다(번들 경계라 두 벌).
import { describe, it, expect } from 'vitest';
import {
  aggregateCells, deltaOf, expectedIn, bytesText, deltaText, pctText, pctTone, inexactNote, partialNote, probeLine, PROBE_TEXT, SKIP_TEXT,
  groupSummary, chartSeries, SERIES_COLORS, OTHER_COLOR, wideCsv, longCsv, csvFileName, isEmail, parseMailList, recipientCount, daysText, mailDirty,
} from './storageUsageText.js';

const S = await import('../../../../server/src/storage/usageReport.js');
const SM = await import('../../../../server/src/storage/usageMailRules.js');
const SR = await import('../../../../server/src/storage/resources.js');
const SE = await import('../../../../server/src/isidu/mailRules.js');

const T = 1024 ** 4;
const G = 1024 ** 3;
const cell = (t, u, day, exact = true) => ({ day, exact, totalBytes: t, usedBytes: u, pct: u == null ? null : Math.round((u / t) * 1000) / 10 });
const PS = S.buildPeriods({ gran: 'daily', asOfDay: 100, count: 3 });
const DEVS = [
  { deviceId: 'a', name: 'A', type: 'isilon', datacenterId: 'dc1', firstDay: 50, enabled: true, cells: [cell(10 * T, 5 * T, 98), cell(10 * T, 6 * T, 99), cell(10 * T, 7 * T, 100)], resources: [] },
  { deviceId: 'b', name: 'B', type: 'unity480', datacenterId: 'dc2', firstDay: 50, enabled: true, cells: [cell(20 * T, 10 * T, 98), null, cell(20 * T, null, 100)],
    resources: [{ rkey: 'lun:sv_1', kind: 'lun', name: 'Davinci_01', cells: [cell(120 * G, 40 * G, 98), cell(120 * G, 41 * G, 99), null] }] },
  { deviceId: 'c', name: 'C', type: 'isilon', datacenterId: 'dc1', firstDay: 100, enabled: true, cells: [null, null, cell(5 * T, T, 100)], resources: [] },
  { deviceId: 'd', name: 'D', type: 'vmax', datacenterId: 'dc2', firstDay: 10, lastDay: 60, enabled: false, cells: [null, null, null], resources: [] },
];

describe('서버 사본 대조', () => {
  it('aggregateCells · deltaOf · expectedIn 이 서버와 같다', () => {
    const subsets = [DEVS, DEVS.slice(0, 2), DEVS.slice(1), [DEVS[3]], []];
    for (const s of subsets) expect(aggregateCells(s, PS)).toEqual(S.aggregateCells(s, PS));
    for (const d of DEVS) for (const p of PS) expect(expectedIn(d, p)).toBe(S.expectedIn(d, p));
    const agg = aggregateCells(DEVS, PS);
    for (const [a, b] of [[agg[0], agg[1]], [agg[1], agg[2]], [null, agg[0]], [{ usedBytes: null }, agg[0]]]) expect(deltaOf(a, b)).toBe(S.deltaOf(a, b));
  });
  it('하위 항목 표지 문구는 서버 상태 목록과 1:1 · 메일 생략 사유도 1:1', () => {
    expect(Object.keys(PROBE_TEXT).sort()).toEqual([...SR.PROBE_STATES].sort());
    expect(Object.keys(SKIP_TEXT).sort()).toEqual([...SM.SKIP_CODES].sort());
  });
  it('주소 판정이 서버와 같다(화면이 받는데 서버가 400 으로 거절하지 않게)', () => {
    for (const a of ['ok@corp.local', 'A.B+c@x.co.kr', 'bad', 'x@y', 'a@b.c', '"q"@x.com', 'a b@x.com', `${'a'.repeat(65)}@x.com`, 'a@-x.com', 'a@x-.com']) {
      expect(isEmail(a)).toBe(SE.isEmail(a));
    }
  });
});

describe('표시', () => {
  it('못 읽은 값은 — 이고 단위를 붙이지 않는다', () => {
    expect(bytesText(null)).toBe('—'); expect(bytesText('')).toBe('—'); expect(deltaText(null)).toBe('—'); expect(pctText(null)).toBe('—');
    expect(bytesText(0)).toBe('0.0 GB');
    expect(bytesText(282.8 * T)).toBe('282.8 TB');
    expect(bytesText(6.1 * 1024 * T)).toBe('6.1 PB');
    expect(bytesText(122880 * G, 'GB')).toBe('122880.0 GB');
    expect(deltaText(-2 * T)).toBe('−2.0 TB'); expect(deltaText(0)).toBe('0');
    expect(pctTone(null)).toBe('none'); expect(pctTone(79.9)).toBe('ok'); expect(pctTone(80)).toBe('warn'); expect(pctTone(90)).toBe('crit');
  });
  it('≈ 표지와 부분 합 표지', () => {
    expect(inexactNote(cell(1, 1, S.buildPeriods({ gran: 'daily', asOfDay: 20750, count: 1 })[0].day, false))).toMatch(/^≈ \d\d-\d\d 관측$/);
    expect(inexactNote(cell(1, 1, 5, true))).toBe('');
    const agg = aggregateCells(DEVS, PS);
    expect(partialNote(agg[0])).toBe('');
    expect(partialNote(agg[1])).toBe('값 있음 1/2대');
    expect(partialNote(agg[2])).toBe('값 있음 2/3대 · 사용량 미확인 1대');
  });
  it('표지가 없는 이유를 하나로 단정하지 않는다', () => {
    expect(probeLine('LUN', null)).toMatch(/구버전 수집기·엣지이거나 아직 새 수집 전/);
    expect(probeLine('LUN', { state: 'ok', count: 2 })).toBe('LUN: 읽음 2개');
    expect(probeLine('파일시스템', { state: 'skipped', detail: 'x' })).toMatch(/건너뜀 — x$/);
  });
});

describe('묶음 요약·차트', () => {
  it('직전 대비·범위 변화는 양쪽이 완전한 합계일 때만', () => {
    const g = groupSummary('all', '전체', DEVS, PS);
    expect(g.delta).toBe(null);                       // 마지막 두 시점이 부분 합
    expect(g.deltaWhy).toMatch(/부분 합/);
    expect(g.range).toBe(null);
    const ok = groupSummary('a', 'A', [DEVS[0]], PS);
    expect(ok.delta).toBe(T); expect(ok.range).toBe(2 * T); expect(ok.avg).toBe(T); expect(ok.rangeSteps).toBe(2);
  });
  it('색은 고정 순서를 따른다(필터로 다시 칠하지 않는다) · 8번째부터 회색 기타 하나 · 부분 합 점은 끊는다', () => {
    const groups = Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, label: `L${i}`, list: [DEVS[0]], cells: aggregateCells([DEVS[0]], PS) }));
    const order = groups.map((g) => g.key);
    const all = chartSeries(groups, order, PS);
    expect(all.series.map((s) => s.color)).toEqual([...SERIES_COLORS, OTHER_COLOR]);
    expect(all.series[7].label).toBe('기타 2개');
    const filtered = chartSeries([groups[3], groups[1]], order, PS);
    expect(filtered.series.map((s) => [s.key, s.color])).toEqual([['k1', SERIES_COLORS[1]], ['k3', SERIES_COLORS[3]]]);
    const part = chartSeries([{ key: 'p', label: 'P', list: DEVS, cells: aggregateCells(DEVS, PS) }], ['p'], PS);
    expect(part.data.map((r) => r.p)).toEqual([aggregateCells(DEVS, PS)[0].pct, null, null]);
    expect(part.cutPoints).toBe(2);
  });
});

describe('CSV', () => {
  const opts = { dcName: (id) => ({ dc1: '서울 법인', dc2: '=HACK' }[id] || id), typeLabel: (t) => t, kindGroup: { lun: 'SAN', fs: 'NAS' } };
  it('표 그대로 — 머리 3줄(법인 / 장비·항목 / 지표) · 단위는 머리에 · 숫자 칸은 숫자만 · 못 읽음은 빈 칸', () => {
    const csv = wideCsv(DEVS.slice(0, 2), PS, opts);
    const lines = csv.split('\r\n');
    expect(lines.length).toBe(3 + PS.length);
    expect(lines[0].startsWith('법인,서울 법인,서울 법인,서울 법인,\'=HACK')).toBe(true);   // 수식 가드
    expect(lines[1]).toContain('B › SAN Davinci_01');
    expect(lines[2]).toBe('일자,Total Usable (TB),Used (TB),Percent (%),Total Usable (TB),Used (TB),Percent (%),Size (GB),Used (GB),Percent (%)');
    expect(lines[3].split(',')).toEqual([PS[0].label, '10', '5', '50', '20', '10', '50', '120', '40', '33.3']);
    expect(lines[4].split(',').slice(4, 7)).toEqual(['', '', ''], '값이 없으면 빈 칸(0 이 아니다)');
  });
  it('행 단위 — 한 줄 = 기간 × 장비/항목 · 관측일 · 직전 대비', () => {
    const csv = longCsv([DEVS[1]], PS, { ...opts, unit: 'GB' });
    const rows = csv.split('\r\n').map((l) => l.split(','));
    expect(rows[0]).toEqual(['기간', '기준일', '관측일', '법인', '종류', '장비', '구분', '항목', '전체(GB)', '사용(GB)', '사용률(%)', '직전 대비(GB)']);
    expect(rows.length).toBe(1 + 2 * PS.length);
    const lun = rows.filter((r) => r[6] === 'SAN');
    expect(lun[1][9]).toBe('41'); expect(lun[1][11]).toBe('1');
    expect(lun[2][9]).toBe(''); expect(lun[2][2]).toBe('', '관측이 없으면 관측일도 빈 칸');
  });
  it('파일 이름', () => {
    expect(csvFileName({ gran: 'weekly', asOfLabel: '2026-10-26', kind: 'wide', filtered: true })).toBe('storage-usage-weekly-2026-10-26-wide-filtered.csv');
  });
});

describe('메일 폼', () => {
  it('주소 파싱·받는 사람 수(대소문자 무시 한 번)·요일 표기·변경 감지', () => {
    expect(parseMailList('a@corp.local\nbad, B@corp.local')).toEqual({ list: ['a@corp.local', 'B@corp.local'], invalid: ['bad'] });
    expect(recipientCount(true, ['A@corp.local'], ['a@corp.local', 'b@corp.local'])).toBe(2);
    expect(recipientCount(false, ['A@corp.local'], [])).toBe(0);
    expect(daysText([1, 2, 3, 4, 5])).toBe('평일'); expect(daysText([0, 1, 2, 3, 4, 5, 6])).toBe('매일'); expect(daysText([3, 1])).toBe('월·수');
    const saved = { enabled: true, days: [1], time: '08:00', includeAdmin: true, to: ['a@corp.local'], gran: 'weekly', count: 5, includeDevices: true, includeResources: false };
    expect(mailDirty({ ...saved }, saved)).toBe(false);
    expect(mailDirty({ ...saved, to: ['b@corp.local'] }, saved)).toBe(true);
    expect(mailDirty({ ...saved, days: [1, 3] }, saved)).toBe(true);
  });
});
