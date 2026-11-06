// v2.911 — 성능 화면 순수 보조(vmPerfText) 회귀: 결측은 0 이 아니다 · 창 계산은 보관 주기에서 · 롤업 글자는 응답값 · CSV 결측은 빈 칸.
import { describe, it, expect } from 'vitest';
import {
  RANGES, RANGE_KEYS, rangeOf, METRICS, METRIC_KEYS, metricOf, OVERLAYS, chartKeys, fmtRate, fmtVal, rollupLabel, fmtClock, durText, seriesStats,
  maxBackOf, windowOf, windowLabel, windowRangeText, dateJumpEnd, dateInputOf, backForEnd, yMaxOf, ticksOf, chartModel, hoverIndex, csvText, csvFileName,
} from './vmPerfText.js';

// 기준 시각은 정시 경계로 고정(docs/rules/common.md) — 2026-11-05T22:00:00Z.
const T0 = Date.UTC(2026, 10, 5, 22, 0, 0);
const RET = { realtime: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 };
const iso = (ms) => new Date(ms).toISOString();

describe('상수 · 글자', () => {
  it('기간 5 · 지표 4 · 겹쳐 보기는 같은 단위끼리', () => {
    expect(RANGE_KEYS).toEqual(['realtime', 'day', 'week', 'month', 'year']);
    expect(METRIC_KEYS).toEqual(['cpu', 'mem', 'disk', 'net']);
    expect(rangeOf('nope').k).toBe('day');
    expect(metricOf('nope').k).toBe('cpu');
    expect(RANGES.find((r) => r.k === 'realtime').nav).toBe(false);
    expect(RANGES.find((r) => r.k === 'year').nav).toBe(false);
    expect(chartKeys('one', 'mem')).toEqual(['mem']);
    expect(chartKeys('one', 'nope')).toEqual(['cpu']);
    expect(chartKeys('cpumem', 'disk')).toEqual(['cpu', 'mem']);
    expect(chartKeys('disknet', 'cpu')).toEqual(['disk', 'net']);
    for (const o of OVERLAYS) if (o.keys) expect(new Set(o.keys.map((k) => metricOf(k).unit)).size).toBe(1);
    for (const m of METRICS) expect(m.label).not.toMatch(/`/);
  });
  it('값 글자 — 결측은 단위 없이 — · KBps 는 사람이 읽는 단위', () => {
    expect(fmtVal(null, '%')).toBe('—');
    expect(fmtVal('', '%')).toBe('—');
    expect(fmtVal(0, '%')).toBe('0%');
    expect(fmtVal(38.64, '%')).toBe('38.6%');
    expect(fmtVal(97, '%')).toBe('97%');
    expect(fmtRate(512)).toBe('512 KB/s');
    expect(fmtRate(1843.2)).toBe('1.8 MB/s');
    expect(fmtRate(1024 * 1024 * 2.5)).toBe('2.5 GB/s');
    expect(fmtVal(1843.2, 'KBps')).toBe('1.8 MB/s');
    expect(fmtRate(null)).toBe('—');
  });
  it('롤업 글자는 응답 sampleSec 그대로 · 모르는 값도 지어내지 않는다', () => {
    expect(rollupLabel(20)).toBe('20초');
    expect(rollupLabel(300)).toBe('5분 평균');
    expect(rollupLabel(1800)).toBe('30분 평균');
    expect(rollupLabel(7200)).toBe('2시간 평균');
    expect(rollupLabel(86400)).toBe('1일 평균');
    expect(rollupLabel(600)).toBe('10분 평균');
    expect(rollupLabel(null)).toBe('—');
    expect(durText(3900)).toBe('1시간 05분');
    expect(durText(0)).toBe('0분');
    expect(durText(null)).toBe('0분');
    expect(fmtClock(null)).toBe('—');
    expect(fmtClock(T0)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe('구간 통계 — 결측은 분모에서 빼고 시각을 함께', () => {
  it('최대 · 최저 시각 · 과부하 지속 초 · 전부 결측이면 null', () => {
    const pts = [{ t: iso(T0), v: 10 }, { t: iso(T0 + 300e3), v: null }, { t: iso(T0 + 600e3), v: 95 }, { t: iso(T0 + 900e3), v: 92 }, { t: iso(T0 + 1200e3), v: '' }, { t: iso(T0 + 1500e3), v: 40 }];
    const s = seriesStats(pts, { overloadPct: 90, sampleSec: 300 });
    expect(s.measured).toBe(4); expect(s.missing).toBe(2);
    expect(s.avg).toBe(59.3);                 // (10+95+92+40)/4 = 59.25 → 59.3 (결측을 0 으로 더하면 39.5)
    expect(s.max).toBe(95); expect(s.maxAt).toBe(iso(T0 + 600e3));
    expect(s.min).toBe(10); expect(s.minAt).toBe(iso(T0));
    expect(s.last).toBe(40);
    expect(s.overSec).toBe(600);
    expect(seriesStats(pts, { overloadPct: null, sampleSec: 300 }).overSec).toBe(null);
    expect(seriesStats([{ t: iso(T0), v: null }]).avg).toBe(null);
    expect(seriesStats([]).missing).toBe(0);
    expect(seriesStats(null).max).toBe(null);
  });
});

describe('과거 창 — 보관 주기에서 계산 · 놓을 때만 조회하는 쪽의 산수', () => {
  it('뒤로 갈 수 있는 칸: 24시간은 1달 보관(2시간 평균 12점) · 7일 · 30일은 1년 · 실시간 · 1년은 0 · 보관을 모르면 0', () => {
    expect(maxBackOf('day', RET)).toBe(29);
    expect(maxBackOf('week', RET)).toBe(51);
    expect(maxBackOf('month', RET)).toBe(11);
    expect(maxBackOf('realtime', RET)).toBe(0);
    expect(maxBackOf('year', RET)).toBe(0);
    expect(maxBackOf('day', null)).toBe(0);
    expect(maxBackOf('day', { month: '' })).toBe(0);
    expect(maxBackOf('day', { month: 7 * 86400 })).toBe(6);   // 보관이 짧은 vCenter 는 그만큼만
  });
  it('창 · 라벨 · 날짜로 이동 · 끝 시각 → 칸', () => {
    const w = windowOf(T0, 2, 'day');
    expect(w).toEqual({ start: T0 - 3 * 86400e3, end: T0 - 2 * 86400e3 });
    expect(windowOf(T0, 0, 'day').end).toBe(T0);
    expect(windowLabel(0, 'day')).toBe('최근 구간');
    expect(windowLabel(3, 'week')).toBe('3칸 전 (7일 단위)');
    expect(windowRangeText(w.start, w.end)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2} ~ \d{2}-\d{2} \d{2}:\d{2}$/);
    expect(windowRangeText(null, w.end)).toBe('');
    expect(dateJumpEnd('2026-11-05')).toBe(new Date(2026, 10, 6, 0, 0, 0, 0).getTime());
    expect(dateJumpEnd('11/05/2026')).toBe(null);
    expect(dateInputOf(new Date(2026, 10, 6, 0, 0, 0, 0).getTime())).toBe('2026-11-05');   // 창 끝(다음 날 0시) 바로 전 = 그 날
    expect(dateInputOf(null)).toBe('');
    expect(backForEnd(T0, T0 - 5 * 86400e3, 'day', 29)).toBe(5);
    expect(backForEnd(T0, T0 - 500 * 86400e3, 'day', 29)).toBe(29);   // 범위 밖은 잘라낸다
    expect(backForEnd(T0, T0 + 86400e3, 'day', 29)).toBe(0);
  });
});

describe('차트 좌표 · 축 · 결측 끊김', () => {
  const pts = [{ t: iso(T0), v: 0 }, { t: iso(T0 + 600e3), v: 50 }, { t: iso(T0 + 1200e3), v: null }, { t: iso(T0 + 1800e3), v: 100 }];
  it('결측 뒤는 M 으로 다시 시작 · 값은 max 로 잘린다 · 시각으로 x', () => {
    const m = chartModel(pts, { x0: 0, x1: 300, y0: 0, y1: 100, max: 100 });
    expect(m.path).toBe('M0.0 100.0 L100.0 50.0 M300.0 0.0');
    expect(m.pts[2].v).toBe(null); expect(m.pts[2].y).toBe(null); expect(m.pts[2].x).toBe(200);
    expect(m.tMin).toBe(T0); expect(m.tMax).toBe(T0 + 1800e3);
    const c = chartModel([{ t: iso(T0), v: 250 }], { x0: 0, x1: 100, y0: 0, y1: 100, max: 100, startMs: T0 - 1000, endMs: T0 + 1000 });
    expect(c.path).toBe('M50.0 0.0');
    expect(chartModel([], { x0: 0, x1: 1, y0: 0, y1: 1 }).path).toBe('');
    expect(chartModel(null, { x0: 0, x1: 1, y0: 0, y1: 1 }).pts).toEqual([]);
  });
  it('y 최대: % 는 100 고정 · KBps 는 최대값 1.15배를 보기 좋은 수로 · 0 이면 1', () => {
    expect(yMaxOf('%', [[{ v: 300 }]])).toBe(100);
    expect(yMaxOf('KBps', [[{ v: 800 }, { v: null }], [{ v: 1800 }]])).toBe(2500);
    expect(yMaxOf('KBps', [[]])).toBe(1);
    expect(yMaxOf('KBps', [[{ v: 9 }]])).toBe(20);
  });
  it('눈금 · 마우스 오버 색인', () => {
    const t = ticksOf(T0, T0 + 86400e3, 4);
    expect(t.length).toBe(5); expect(t[0].ms).toBe(T0); expect(t[4].ms).toBe(T0 + 86400e3);
    expect(t[0].label).toMatch(/^\d{2}:\d{2}$/);
    expect(ticksOf(T0, T0 + 30 * 86400e3, 2)[0].label).toMatch(/^\d{2}-\d{2}$/);
    expect(ticksOf(T0, T0 + 7 * 86400e3, 3)[0].label).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(ticksOf(T0, T0 + 7 * 86400e3, 3, { short: true })[0].label).toMatch(/^\d{2}-\d{2}$/);   // 좁은 화면은 MM-DD 만
    expect(ticksOf(T0, T0, 4)).toEqual([]);
    const m = chartModel(pts, { x0: 0, x1: 300, y0: 0, y1: 100, max: 100 });
    expect(hoverIndex(m.pts, 140)).toBe(1);
    expect(hoverIndex(m.pts, 190)).toBe(2);   // 결측 점도 후보(상자가 '결측' 이라고 말한다)
    expect(hoverIndex([], 10)).toBe(-1);
  });
});

describe('CSV — 받은 값 그대로 · 결측은 빈 칸 · 시각순', () => {
  it('열은 지표(단위) · 시각 합집합', () => {
    const series = {
      cpu: { unit: '%', points: [{ t: iso(T0 + 300e3), v: 20 }, { t: iso(T0), v: 10 }] },
      mem: { unit: '%', points: [{ t: iso(T0), v: null }] },
      disk: { unit: 'KBps', points: null },
    };
    const text = csvText(series, ['cpu', 'mem', 'disk', 'net']);
    expect(text.split('\n')[0]).toBe('time,cpu(%),mem(%)');
    expect(text).toBe(`time,cpu(%),mem(%)\n${iso(T0)},10,\n${iso(T0 + 300e3)},20,\n`);
    expect(csvText({}, ['cpu'])).toBe('time\n');
    expect(csvFileName('web kr1/023', 'day', new Date(2026, 10, 6).getTime())).toBe('perf_web_kr1_023_day_2026-11-05.csv');
    expect(csvFileName('', 'year', null)).toBe('perf_entity_year_latest.csv');
  });
});
