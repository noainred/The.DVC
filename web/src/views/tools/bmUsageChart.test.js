/**
 * bmUsageChart.js 회귀(v2.551) — 추이 차트가 만들 수 있는 거짓을 고정한다.
 */
import { describe, it, expect } from 'vitest';
import {
  CHART_SERIES, RANGES, rangeOf, gapMsFor, seriesPoints, linePath,
  yMaxFor, yTicks, xTicks, chartEmptyNote, sourceNote,
} from './bmUsageChart.js';

const NOW = Date.parse('2026-09-18T00:00:00Z');
const cpu = CHART_SERIES[0];
const mkRaw = (n, step = 300_000, val = (i) => 20 + i) =>
  Array.from({ length: n }, (_, i) => ({ ts: NOW + i * step, cpu_pct: val(i) }));

describe('결측 처리', () => {
  it('값이 null 인 점은 **버린다** — 남기면 chartEmptyNote 가 비었다고 말하지 못한다', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ ts: NOW + i * 300_000, cpu_pct: null }));
    const pts = seriesPoints({ raw: rows, series: cpu, source: 'raw' });
    expect(pts).toHaveLength(0);
    expect(chartEmptyNote({ series: cpu, points: pts, hasRows: true })).toContain('없습니다');
  });
  it('⚠ Number(null)===0 함정 — 결측이 0% 로 둔갑하지 않는다', () => {
    const pts = seriesPoints({ raw: [{ ts: NOW, cpu_pct: null }, { ts: NOW + 1, cpu_pct: 0 }], series: cpu, source: 'raw' });
    expect(pts).toHaveLength(1);
    expect(pts[0].v).toBe(0);   // 진짜 0 은 남는다
  });
  it('수집이 없던 구간은 선을 잇지 않는다', () => {
    const pts = seriesPoints({ raw: [...mkRaw(5), ...mkRaw(5, 300_000, (i) => 50 + i).map((r) => ({ ...r, ts: r.ts + 7_200_000 }))], series: cpu, source: 'raw' });
    const p = linePath(pts, { gapMs: 750_000 });
    expect(p.breaks).toBe(1);
    expect((p.d.match(/M/g) || []).length).toBe(2);
  });
  it('점이 1개면 선을 그리지 않는다(추세를 지어내지 않는다)', () => {
    expect(linePath([{ ts: NOW, v: 50 }])).toBeNull();
    expect(chartEmptyNote({ series: cpu, points: [{ ts: NOW, v: 50 }], hasRows: true })).toContain('1개');
  });
});

describe('y축 — 착시 방지', () => {
  it('퍼센트는 0~100 고정 (자동 스케일이면 3% 잔물결이 거의 100% 처럼 보인다)', () => {
    expect(yMaxFor('pct', [{ v: 3 }, { v: 4 }])).toBe(100);
    expect(yTicks('pct')).toEqual([0, 25, 50, 75, 100]);
    // 실제로 좌표가 눌려 있는지 — 3% 는 바닥 근처여야 한다
    const p = linePath([{ ts: NOW, v: 3 }, { ts: NOW + 1000, v: 4 }], { h: 100, yMax: 100 });
    const ys = [...p.d.matchAll(/,(\d+\.\d)/g)].map((m) => Number(m[1]));
    expect(Math.min(...ys)).toBeGreaterThan(95);
  });
  it('처리량은 상한이 없으니 데이터 최대에 맞춘다', () => {
    const pts = [{ v: 1e6 }, { v: 5e6 }];
    expect(yMaxFor('bps', pts)).toBeCloseTo(5.5e6);
    expect(yTicks('bps', 1000)).toEqual([0, 500, 1000]);
  });
  it('값이 전부 0 이어도 yMax 가 0 이 되지 않는다(0 으로 나누지 않게)', () => {
    expect(yMaxFor('bps', [{ v: 0 }])).toBe(1);
  });
});

describe('원시와 롤업을 섞지 않는다', () => {
  it('기간마다 출처가 정해져 있다', () => {
    expect(rangeOf('24h').source).toBe('raw');
    expect(rangeOf('90d').source).toBe('daily');
    expect(RANGES.every((r) => r.source === 'raw' || r.source === 'daily')).toBe(true);
  });
  it('출처를 문구가 말한다', () => {
    expect(sourceNote(rangeOf('24h'))).toContain('원시 표본');
    expect(sourceNote(rangeOf('90d'), { dailyStat: 'max' })).toContain('최대');
    expect(sourceNote(rangeOf('90d'), { dailyStat: 'avg' })).toContain('평균');
    expect(sourceNote(rangeOf('90d'))).toContain('뜻이 다릅니다');
  });
  it('조회 상한으로 잘렸으면 밝힌다(조용한 상한 금지)', () => {
    expect(sourceNote(rangeOf('7d'), { rawTruncated: true })).toContain('잘렸습니다');
    expect(sourceNote(rangeOf('7d'), { rawTruncated: false })).not.toContain('잘렸');
  });
  it('롤업에 평균이 없는 지표는 평균을 지어내지 않는다', () => {
    const net = CHART_SERIES.find((s) => s.key === 'net');
    expect(net.avg).toBeNull();
    const daily = [{ day: '2026-09-17', net_max: 30 }];
    expect(seriesPoints({ daily, series: net, source: 'daily', dailyStat: 'avg' })).toHaveLength(0);
    expect(seriesPoints({ daily, series: net, source: 'daily', dailyStat: 'max' })).toHaveLength(1);
  });
});

describe('선을 끊는 간격', () => {
  it('⚠ 주기를 숫자로 박지 않는다 — 서버가 주는 intervalMs 를 쓴다', () => {
    expect(gapMsFor(rangeOf('24h'), 60_000)).toBe(180_000);
    expect(gapMsFor(rangeOf('24h'), 600_000)).toBe(1_500_000);
    expect(gapMsFor(rangeOf('90d'), 300_000)).toBe(2.5 * 86_400_000);
  });
  it('intervalMs 가 없으면 하한이 있다(0 으로 끊어 전부 점이 되지 않게)', () => {
    expect(gapMsFor(rangeOf('24h'), null)).toBeGreaterThanOrEqual(180_000);
    expect(gapMsFor(rangeOf('24h'), 0)).toBeGreaterThanOrEqual(180_000);
  });
});

describe('x축 눈금', () => {
  it('한국 시각으로 표시한다(사용자는 한국에 있다)', () => {
    const tk = xTicks(NOW, NOW + 3_600_000, { count: 2, source: 'raw' });
    expect(tk[0].label).toBe('09:00');   // UTC 00:00 → KST 09:00
  });
  it('롤업 기간은 날짜로', () => {
    const tk = xTicks(NOW, NOW + 86_400_000 * 10, { count: 2, source: 'daily' });
    expect(tk[0].label).toBe('09/18');
  });
  it('구간이 없으면 눈금을 만들지 않는다', () => {
    expect(xTicks(NOW, NOW)).toEqual([]);
    expect(xTicks(null, NOW)).toEqual([]);
  });
});

describe('빈 차트의 이유를 구분해 말한다', () => {
  it("이 경로에 원래 없는 것은 '기다려도 안 된다' 고 말한다", () => {
    const diskIo = CHART_SERIES.find((s) => s.key === 'diskIo');
    const s = chartEmptyNote({ series: diskIo, points: [], absent: ['diskbusy'], hasRows: true });
    expect(s).toContain('기다려도 나오지 않습니다');
  });
  it('표본이 아예 없으면 기간을 넓히라고 말한다', () => {
    expect(chartEmptyNote({ series: cpu, points: [], hasRows: false })).toContain('기간을 넓히');
  });
  it('그릴 수 있으면 문구를 만들지 않는다(같은 말이 화면을 덮지 않게)', () => {
    expect(chartEmptyNote({ series: cpu, points: seriesPoints({ raw: mkRaw(5), series: cpu, source: 'raw' }), hasRows: true })).toBe('');
  });
});

describe('차트 지표 계약', () => {
  it('사용자가 지정한 다섯 지표가 모두 있다', () => {
    const keys = CHART_SERIES.map((s) => s.key);
    for (const k of ['cpu', 'mem', 'diskIo', 'net', 'hba']) expect(keys).toContain(k);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('모든 지표에 색과 종류가 있다', () => {
    for (const s of CHART_SERIES) {
      expect(s.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(['pct', 'bps']).toContain(s.kind);
    }
  });
});
