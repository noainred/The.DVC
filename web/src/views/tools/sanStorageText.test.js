/**
 * sanStorageText.test.js — v2.948 'SAN 스토리지 성능' 화면의 순수 계산 · 문구.
 *  ① 조회 파라미터: 90일까지 hours · 1년 · 과거 창은 from/to
 *  ② 문구: 값 없음은 '—'(0 · 단위 금지) · 7일 대비 톤
 *  ③ 차트: 결측은 선 · 면적을 끊는다(gaps) · 세로 최대는 보기 좋은 값 · 시리즈 4개 초과는 '그 밖' 으로(색을 늘리지 않는다)
 *  ④ 요약: now 는 한계 안일 때만 · 평균은 결측을 분모에서 뺀다 · 히트맵은 포탈 하루(오프셋)로 접는다
 *  ⑤ 목록: 모르는 값은 정렬에서 뒤 · 거르기는 이름 · 시리얼 · 스위치 · KPI 는 측정 없음을 '—' 로
 */
import { describe, it, expect } from 'vitest';
import * as T from './sanStorageText.js';

const HOUR = 3_600_000;
// 기준 시각은 실제 시각에서 정시 경계로 떨어뜨려 고정한다(CLAUDE.md 테스트 규칙).
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 2 * HOUR + 17 * 60_000;

describe('① 조회 파라미터', () => {
  it('90일까지는 hours, 1년 · 과거 창은 from/to', () => {
    expect(T.rangeQuery('24h', { now: NOW })).toEqual({ hours: 24 });
    expect(T.rangeQuery('90d', { now: NOW })).toEqual({ hours: 2160 });
    const y = T.rangeQuery('1y', { now: NOW });
    expect(y.to).toBe(NOW); expect(y.to - y.from).toBe(8760 * HOUR);
    const b = T.rangeQuery('24h', { now: NOW, back: 2 });
    expect(b.to).toBe(NOW - 48 * HOUR); expect(b.from).toBe(NOW - 72 * HOUR);
    expect(T.windowLabel('24h', 0)).toMatch(/최신/); expect(T.windowLabel('7d', 3)).toMatch(/3개 전/);
  });
});

describe('② 문구', () => {
  it('값 없음은 — · 단위 없음', () => {
    expect(T.rateText(null)).toBe('—'); expect(T.rateText('')).toBe('—'); expect(T.pctText(undefined)).toBe('—');
    expect(T.rateText(2.5e9 / 8)).toBe('2.5 Gb/s'); expect(T.rateText(50e6 / 8)).toBe('50.0 Mb/s');
    expect(T.deltaOf(null)).toEqual({ text: '—', tone: 'none' });
    expect(T.deltaOf(9)).toEqual({ text: '▲ 9%', tone: 'up' }); expect(T.deltaOf(-14)).toEqual({ text: '▼ 14%', tone: 'dn' }); expect(T.deltaOf(0)).toEqual({ text: '— 0%', tone: 'flat' });
    expect(T.dayTB(null)).toBe(null); expect(T.dayTB(1e12 / 86_400)).toBeCloseTo(1, 6);
    expect(T.deltaNote({ delta7d: null, avg24: 1, prevHours: 2 }, 6)).toMatch(/2시간뿐/);
    expect(T.liveText({ lastSampleAt: NOW - 90_000, intervalMs: 300_000, pollMs: 60_000, now: NOW })).toBe('마지막 표본 2분 전 · 수집 주기 5분(설정값) · 1분마다 다시 읽음');
    expect(T.liveText({ lastSampleAt: null, now: NOW })).toBe('마지막 표본 없음');
    expect(T.stateTag({ state: 'edge-missing', stateText: '엣지 미보고' })).toEqual({ tone: 'crit', text: '엣지 미보고', code: 'edge-missing' });
    expect(T.imbalanceTag({ imbalance: { group: 'FA-1D', ratio: 2.1 } }).text).toBe('편중 · FA-1D 2.1×');
  });
});

describe('③ 차트', () => {
  it('스파크 · 쌓기 — 결측은 끊는다 · 4개 초과는 그 밖', () => {
    const segs = T.sparkSegments([1, 2, null, 3, 4], 100, 20);
    expect(segs.length).toBe(2);
    expect(T.sparkSegments([null, null])).toEqual([]);
    const buckets = [0, 1, 2, 3].map((i) => NOW + i * HOUR);
    const m = T.stackModel(buckets, [{ key: 'a', values: [1e9, 1e9, null, 1e9] }, { key: 'b', values: [1e9, 2e9, 1e9, 1e9] }], { w: 400, h: 100 });
    expect(m.gaps).toEqual([2]);
    expect(m.areas.length).toBe(2);
    expect(m.areas[1].d.split('M').length - 1).toBe(2);   // 결측 좌우 조각 둘
    expect(m.yMax).toBe(50);                                 // (1e9+2e9)×8/1e9 = 24 → 50
    expect(T.niceMax(0)).toBe(1); expect(T.niceMax(7)).toBe(10); expect(T.niceMax(1.4)).toBe(2);
    const folded = T.foldSeries([1, 2, 3, 4, 5, 6].map((n) => ({ key: `s${n}`, label: `s${n}`, values: [n * 1e6, n * 1e6] })));
    expect(folded.length).toBe(5);
    expect(folded[4].key).toBe('__other'); expect(folded[4].folded).toBe(2); expect(folded[4].values).toEqual([3e6, 3e6]);
    expect(folded[0].key).toBe('s6'); expect(folded[0].color).toBe('var(--viz-1)');
    expect(T.tickLabels(buckets, 2).map((t) => t.i)).toEqual([0, 3]);
    expect(T.tickLabels([], 3)).toEqual([]);
  });
});

describe('④ 요약 · 히트맵', () => {
  it('now 는 한계 안일 때만 · 평균은 결측 제외 · 히트맵은 오프셋으로 접는다', () => {
    const buckets = [0, 1, 2, 3].map((i) => NOW + i * 60_000);
    const s = T.seriesStats([10, null, 30, 20], [12, null, 35, 25], buckets, { until: NOW + 3 * 60_000, carryMs: 120_000, bucketMs: 60_000 });
    expect(s.now).toBe(20); expect(s.avg).toBe(20); expect(s.max).toBe(30); expect(s.maxTs).toBe(buckets[2]); expect(s.peakMax).toBe(35); expect(s.measured).toBe(3); expect(s.stale).toBe(false);
    const st = T.seriesStats([10, null, null, null], [], buckets, { until: NOW + 3 * 60_000, carryMs: 60_000, bucketMs: 60_000 });
    expect(st.stale).toBe(true); expect(st.now).toBe(null); expect(st.nowTs).toBe(buckets[0]);
    // 월요일 09:00 KST = 일요일 24:00 UTC — 오프셋 540 이면 월 9시 칸, 0 이면 일 0시 칸
    const mon9 = Date.UTC(2026, 10, 9, 0, 0, 0);   // 2026-11-09 00:00Z = 월요일 09:00 KST
    const h = T.foldHeatmap([mon9, mon9 + HOUR], [8, null], 540);
    expect(h.cells[0][9].avg).toBe(8); expect(h.cells[0][10].avg).toBe(null); expect(h.busiest).toEqual({ day: 0, hour: 9, avg: 8 });
    const h0 = T.foldHeatmap([mon9], [8], 0);   // 오프셋 0 이면 UTC 월요일 00:00 칸
    expect(h0.cells[0][0].avg).toBe(8); expect(h0.cells[0][9].avg).toBe(null);
    const csv = T.csvText([mon9], [1e9 / 8], [{ label: 'FA-1D', values: [null] }]);
    expect(csv.split('\r\n')[0]).toBe('시각,합계(Gb/s),FA-1D(Gb/s)');
    expect(csv.split('\r\n')[1]).toBe(`${new Date(mon9).toISOString()},1.000,`);
    expect(T.csvFileName('SYMMETRIX::0001', '24h', mon9)).toMatch(/^san-storage_SYMMETRIX_0001_24h_\d{8}\.csv$/);
  });
});

describe('⑤ 목록 · KPI', () => {
  const rows = [
    { key: 'a', name: 'PMAX-A', serial: '0001', datacenterId: 'kr', datacenterName: 'KR1', vendor: 'powermax', now: { bps: 5 }, utilPct: 2, delta7d: 9, switches: [{ name: 'SW-A' }] },
    { key: 'b', name: 'PS-B', serial: '', datacenterId: 'pl', datacenterName: 'PL1', vendor: 'powerstore', now: null, utilPct: null, delta7d: null, imbalance: { ratio: 1.7, group: 'Node A' }, switches: [] },
    { key: 'c', name: 'UN-C', serial: '', datacenterId: 'kr', datacenterName: 'KR1', vendor: 'unity', now: { bps: 9 }, utilPct: 1, delta7d: -3, switches: [] },
  ];
  it('모르는 값은 뒤 · 거르기 · KPI 의 측정 없음은 —', () => {
    expect(T.sortRowsBy(rows, 'now').map((r) => r.key)).toEqual(['c', 'a', 'b']);
    expect(T.sortRowsBy(rows, 'imbalance').map((r) => r.key)).toEqual(['b', 'a', 'c']);
    expect(T.sortRowsBy(rows, 'name').map((r) => r.key)).toEqual(['a', 'b', 'c']);
    expect(T.filterRows(rows, { vendor: 'unity' }).map((r) => r.key)).toEqual(['c']);
    expect(T.filterRows(rows, { q: 'sw-a' }).map((r) => r.key)).toEqual(['a']);
    expect(T.filterRows(rows, { q: '0001' }).map((r) => r.key)).toEqual(['a']);
    const k = T.kpisOf({ totals: { nowBps: null, avgBps: null, arrays: 3, imbalance: 1, unmeasured: 1, speedSumBps: null }, counts: { host: 68, unknown: 0 }, edgeMissing: 1, allDatacenters: [{}, {}], imbalanceRule: { ratio: 1.4 } });
    expect(k[0].value).toBe('—'); expect(k[0].unit).toBe(''); expect(k[0].meta).toMatch(/0 이 아닙니다/);
    expect(k[1].value).toBe('—'); expect(k[3].value).toBe('1'); expect(k[4].value).toBe('2');
    const k2 = T.kpisOf({ totals: { nowBps: 8e9 / 8, avgBps: 7e9 / 8, speedSumBps: 80e9 / 8, arrays: 1, imbalance: 0, unmeasured: 0 }, counts: {}, allDatacenters: [] });
    expect(k2[0].value).toBe('8.0'); expect(k2[0].meta).toMatch(/14% 높음/); expect(k2[1].value).toBe('10.0');
    expect(T.overallText({ overall: 'ok', uncheckedCount: 2 })).toBe('정상(일부 미확인)'); expect(T.overallText({ overall: 'bad' })).toBe('이상');
    expect(T.thresholdText({ unit: '%' }, null)).toBe('비움(판정 안 함)');
  });
});
