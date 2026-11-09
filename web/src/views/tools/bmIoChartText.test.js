// v2.915 — 장비별 디스크 성능 차트 문구 · 좌표 규칙(설계 bm-san-compare §4.6).
import { describe, it, expect } from 'vitest';
import {
  RANGES, METRICS, rangeOf, bucketLabel, sampleText, basisText, seriesColors, toChartData, yDomain, timeTick, tipTime,
  retentionDaysFor, maxBackOf, windowTo, windowLabel, defaultPicks, rankRows, pointsText, partialNote, MAX_PICKS,
} from './bmIoChartText.js';

describe('bmIoChartText', () => {
  it('범위 4종 · 지표 3종 · 모르는 키는 실시간', () => {
    expect(RANGES.map((r) => r.k)).toEqual(['1h', '24h', '7d', '30d']); expect(METRICS.map((m) => m.k)).toEqual(['total', 'read', 'write']);
    expect(rangeOf('zzz').k).toBe('1h'); expect(rangeOf('1h').live).toBe(true); expect(rangeOf('24h').live).toBe(false); expect(MAX_PICKS).toBe(8);
  });
  it('격자 · 점 간격 · 기준 문구는 API 값으로 만든다', () => {
    expect(bucketLabel(900e3)).toBe('15분 집계'); expect(bucketLabel(3600e3)).toBe('1시간 집계'); expect(bucketLabel(6 * 3600e3)).toBe('6시간 집계');
    expect(bucketLabel(30e3)).toBe('30초 격자'); expect(bucketLabel(60e3)).toBe('1분 격자'); expect(bucketLabel(null)).toBe('');
    expect(sampleText(60e3)).toBe('점 1분'); expect(sampleText(300e3)).toBe('점 5분'); expect(sampleText(null)).toBe('');
    expect(basisText('bm', { avg: 'counter', peak: 'sample2s' })).toMatch(/카운터 차분 평균.*하한/); expect(basisText('san')).toMatch(/포트 사용량 표본/);
  });
  it('색은 종류별 계열 · 차트 데이터는 null 을 그대로(끊긴 선) · y 범위', () => {
    const series = [{ id: 'bm:all', kind: 'bm', avg: [1, null, 3], peak: [2, null, 9] }, { id: 'san:all', kind: 'san', avg: [10, 20, null], peak: [15, 25, null] }];
    const c = seriesColors(series); expect(c.get('bm:all')).toBe('#34e0b4'); expect(c.get('san:all')).toBe('#3b82f6');
    const data = toChartData([100, 200, 300], series);
    expect(data).toHaveLength(3); expect(data[1]).toEqual({ t: 200, 'bm:all|avg': null, 'bm:all|peak': null, 'san:all|avg': 20, 'san:all|peak': 25 });
    expect(yDomain(series)).toEqual([0, Math.ceil(25 * 1.1)]); expect(yDomain([])).toEqual([0, 1]);
    expect(yDomain(series, { log: true })).toEqual([1, 100]);
  });
  it('시각 눈금 · 보존 · 창 계산', () => {
    const t = new Date(2026, 10, 9, 16, 5).getTime();
    expect(timeTick(t, '1h')).toBe('16:05'); expect(timeTick(t, '7d')).toBe('11/9 16시'); expect(tipTime(t)).toBe('11/9 16:05'); expect(timeTick('x', '1h')).toBe('');
    const ret = { rawDays: 3, r15Days: 31, r1hDays: 730 };
    expect(retentionDaysFor('1h', ret)).toBe(3); expect(retentionDaysFor('24h', ret)).toBe(31); expect(retentionDaysFor('30d', ret)).toBe(730); expect(retentionDaysFor('1h', null)).toBe(null);
    expect(maxBackOf('1h', ret)).toBe(71); expect(maxBackOf('24h', ret)).toBe(30); expect(maxBackOf('7d', ret)).toBe(103); expect(maxBackOf('30d', ret)).toBe(23); expect(maxBackOf('1h', null)).toBe(0);
    expect(windowTo('24h', 0, 1000)).toBe(null); expect(windowTo('24h', 2, 1000 + 2 * 86400e3)).toBe(1000);
    expect(windowLabel('24h', 0)).toBe('최근 구간'); expect(windowLabel('7d', 3)).toBe('3칸 전 (7일 단위)');
  });
  it('기본 선택은 합계 둘 + 평균 최대 베어메탈 · SAN 하나씩, 순위는 평균 높은 순 · 측정 없음은 뒤 · 접힘', () => {
    const rank = [
      { id: 'bm:a', kind: 'bm', avgBps: 100, peakBps: 400 }, { id: 'san:x', kind: 'san', avgBps: 1000, peakBps: 2400 },
      { id: 'bm:b', kind: 'bm', avgBps: 500, peakBps: 900 }, { id: 'san:y', kind: 'san', avgBps: null, peakBps: null, reason: 'serial-unmatched' },
    ];
    expect(defaultPicks(rank)).toEqual(['bm:all', 'san:all', 'bm:b', 'san:x']); expect(defaultPicks([])).toEqual(['bm:all', 'san:all']);
    const r = rankRows(rank, { fold: 2 });
    expect(r.rows.map((x) => x.id)).toEqual(['san:x', 'bm:b', 'bm:a', 'san:y']); expect(r.max).toBe(2400);
    expect(r.rows[0].avgPct).toBeCloseTo((1000 / 2400) * 100); expect(r.rows[3].avgPct).toBe(0); expect(r.rows[3].peakPct).toBe(null);
    expect(r.shown).toHaveLength(2); expect(r.hidden).toBe(2); expect(r.measured).toBe(3); expect(r.unmeasured).toBe(1);
    expect(pointsText({ kind: 'bm', points: 1440 }, 60e3)).toBe('1분 표본 1,440개(카운터 평균)'); expect(pointsText({ kind: 'san', points: 288 }, 300e3)).toBe('5분 표본 288개'); expect(pointsText({ points: 0 })).toBe('');
    expect(partialNote({ kind: 'bm', partial: [1, 2] })).toMatch(/2칸.*서버/); expect(partialNote({ kind: 'san', partialBuckets: 3 })).toMatch(/3칸.*어레이/); expect(partialNote({})).toBe('');
  });
});
