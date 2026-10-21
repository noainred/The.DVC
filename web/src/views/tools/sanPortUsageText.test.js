import { describe, it, expect } from 'vitest';
import {
  levelColor, LEVELS, pctOf, rateText, cellInfo, cellTitle, usageKpis, deltaPct, usageChartRows, navInfo, colLabels,
  rowHasData, mapTiles, mapKpis, tileStyle, sparkPoints, usageParams, timeText, USAGE_NOTES,
} from './sanPortUsageText.js';

// v2.748 — SAN 포트 사용량·포트 배치 탭의 판정(순수). now 를 주입하므로 고정 시각을 쓴다.
const KST0 = Date.UTC(2026, 9, 20, 15, 0);   // 2026-10-21 00:00 KST
const NOW = KST0 + 11.5 * 3_600_000;

describe('색 단계·포화도', () => {
  it('경계는 이상 쪽에 붙고, 모르면 null', () => {
    expect(levelColor(19.9)).toBe(LEVELS[0].color);
    expect(levelColor(20)).toBe(LEVELS[1].color);
    expect(levelColor(80)).toBe(LEVELS[4].color);
    expect(levelColor(null)).toBe(null);
    expect(levelColor('')).toBe(null);
  });
  it('속도·값을 모르면 포화도는 null(0% 가 아니다)', () => {
    expect(pctOf(1e9, 2e9)).toBe(50);
    expect(pctOf(null, 2e9)).toBe(null);
    expect(pctOf(1e9, null)).toBe(null);
    expect(pctOf(1e9, 0)).toBe(null);
    expect(rateText(null)).toBe('—');
    expect(rateText(125e6)).toBe('1.00 Gbps');
  });
});

describe('cellInfo — 미래·값 없음·값', () => {
  it('지금 이후 칸은 future, 값이 없으면 gap(0 이 아님), 아니면 기준값의 %', () => {
    expect(cellInfo([1, 2, 1], { capBps: 10, start: NOW + 1, now: NOW }).kind).toBe('future');
    expect(cellInfo(null, { capBps: 10, start: KST0, now: NOW }).kind).toBe('gap');
    expect(cellInfo([1, null, 1], { capBps: 10, metric: 'peak', start: KST0, now: NOW }).kind).toBe('gap');
    const v = cellInfo([2, 9, 1], { capBps: 10, metric: 'peak', start: KST0, now: NOW });
    expect(v.kind).toBe('val'); expect(v.pct).toBe(90); expect(v.color).toBe(LEVELS[4].color);
    expect(cellInfo([2, 9, 1], { capBps: 10, metric: 'avg', start: KST0, now: NOW }).pct).toBe(20);
    const unknown = cellInfo([2, 9, 1], { capBps: null, start: KST0, now: NOW });
    expect(unknown.pct).toBe(null); expect(unknown.color).toBeTruthy();
  });
  it('툴팁은 값 없음을 0 이라 하지 않고, 하루 칸은 값 있는 시간 수를 말한다', () => {
    expect(cellTitle({ kind: 'gap' }, { label: 'x' })).toContain('0 이 아닙니다');
    expect(cellTitle({ kind: 'val', value: 125e6, pct: 50, n: 12 }, { label: 'x', metric: 'peak', colMs: 86_400_000 })).toContain('24시간 중 12시간');
  });
});

describe('KPI·차트 행', () => {
  const chart = { since: KST0, bucketMs: 3_600_000, avg: [10, null, 30], peak: [20, null, 60], avgMean: 20, peakMax: 60, peakAt: KST0 + 2 * 3_600_000,
    prev: { since: KST0 - 86_400_000, bucketMs: 900_000, avg: [1, 2, 3, 4, 5, 6, 7, 8, 9], peak: [1, 2, 3, 4, 5, 6, 7, 8, 9] } };
  it('피크 포화도는 회선 대비, 속도를 모르면 null', () => {
    expect(usageKpis(chart, 100)).toEqual({ avg: 20, peak: 60, peakPct: 60, peakAt: KST0 + 2 * 3_600_000 });
    expect(usageKpis(chart, null).peakPct).toBe(null);
    expect(usageKpis(null, 1).avg).toBe(null);
  });
  it('값 없는 칸은 null 로 남기고(선이 끊긴다), 앞 기간은 경과 시간으로 맞춘다(칸 폭이 달라도)', () => {
    const rows = usageChartRows(chart, { capBps: 100, withPrev: true });
    expect(rows[1].avg).toBe(null);
    expect(rows[0].cap).toBe(100);
    expect(rows[1].prevAvg).toBe(5);   // 1시간째 = 15분 칸 4번
    expect(rows[2].prevAvg).toBe(9);
    expect(usageChartRows(chart, { capBps: null })[0].cap).toBe(undefined);
  });
  it('변화율은 둘 다 있을 때만', () => {
    expect(deltaPct(120, 100)).toBe(20);
    expect(deltaPct(null, 100)).toBe(null);
    expect(deltaPct(10, 0)).toBe(null);
  });
});

describe('이전·다음·열 머리', () => {
  it('하한(보관 기간)과 현재에서 버튼을 잠근다', () => {
    expect(navInfo({ unit: 'd', off: 0, minOff: -730 })).toEqual({ prevDisabled: false, nextDisabled: true, todayText: '오늘로' });
    expect(navInfo({ unit: 'm', off: -23, minOff: -23 }).prevDisabled).toBe(true);
    expect(navInfo({ unit: 'w', off: -3, minOff: -103 }).todayText).toBe('이번 7일로');
  });
  it('열 머리는 서버 오프셋(한국) 기준으로 만든다', () => {
    expect(colLabels({ unit: 'd' })).toHaveLength(24);
    expect(colLabels({ unit: 'w', offsetMin: 540, days: [KST0] })[0]).toBe('10-21(수)');
    expect(colLabels({ unit: 'm', offsetMin: 540, days: [KST0] })[0]).toBe('21');
    expect(timeText(KST0, 540)).toBe('10-21 00:00');
    expect(timeText(null, 540)).toBe('—');
  });
  it('행에 값이 하나라도 있는가', () => {
    expect(rowHasData({ cells: [null, null] })).toBe(false);
    expect(rowHasData({ cells: [null, [1, 2, 1]] })).toBe(true);
  });
  it('요청 파라미터 — 앞 기간은 켰을 때만', () => {
    expect(usageParams({ unit: 'd', off: -2, view: 'port', target: 5, prev: false })).toEqual({ unit: 'd', off: '-2', view: 'port', target: '5' });
    expect(usageParams({ unit: 'w', off: 0, view: 'storage', target: null, prev: true })).toEqual({ unit: 'w', off: '0', view: 'storage', prev: '1' });
  });
  it('정직 표기 — 백틱을 쓰지 않는다(BoldText 는 **강조** 만 해석)', () => {
    for (const n of USAGE_NOTES) expect(n).not.toContain('`');
  });
});

describe('포트 배치 — 타일·KPI', () => {
  const list = [
    { index: 0, slotPort: '0', state: 'online', speed: '16G', attachedName: 'A' },
    { index: 1, slotPort: '1', state: 'online', speed: '16G', attachedName: 'B' },
    { index: 2, slotPort: '2', state: 'online', speed: '', attachedName: 'C' },
    { index: 3, slotPort: '3', state: 'offline', speed: '16G' },
    { index: 4, slotPort: '4', state: 'online', speed: '16G' },
  ];
  const perf = { series: [
    { port: 0, avg: [1.7e9, 1.7e9], peak: [1.8e9, 1.9e9], max: 1.9e9 },     // 2GB/s 회선의 95%
    { port: 1, avg: [1e6, null], peak: [2e6, null], max: 2e6 },             // 0.1% → 유휴
    { port: 2, avg: [5e8], peak: [6e8], max: 6e8 },                           // 속도 모름
  ] };
  it('피크는 원시 최댓값(max), 평균은 칸 평균의 평균 · 속도를 모르면 %는 null', () => {
    const t = mapTiles(list, perf, 'peak');
    expect(t[0].value).toBe(1.9e9); expect(t[0].pct).toBe(95);
    expect(mapTiles(list, perf, 'avg')[0].value).toBe(1.7e9);
    expect(t[2].pct).toBe(null);
    expect(t[4].value).toBe(null);
  });
  it('KPI: 꺼짐은 사용 중이 아니고, 값 없음·속도 모름은 80%·유휴에 넣지 않는다', () => {
    const k = mapKpis(mapTiles(list, perf, 'peak'));
    expect(k).toEqual({ online: 4, hot: 1, idle: 1, noData: 1, total: 5 });
  });
  it('타일 색 — 사용 중인데 값 없음은 빗금, 속도 모름은 중립', () => {
    const t = mapTiles(list, perf, 'peak');
    expect(tileStyle(t[4]).background).toContain('repeating-linear-gradient');
    expect(tileStyle(t[2]).background).toBe('#475569');
    expect(tileStyle(t[0]).background).toBe(LEVELS[4].color);
  });
  it('스파크라인은 값 없는 칸에서 끊는다', () => {
    const s = sparkPoints([1, 2, null, 4], 30, 10);
    expect(s).toHaveLength(2);
    expect(sparkPoints([null, null])).toEqual([]);
  });
});
