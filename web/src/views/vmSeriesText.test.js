/**
 * vmSeriesText 회귀(v2.510) — '미측정' 과 '스파이크 0' 을 섞지 않는다 · 주기 경고는 서버 값으로만 · 템플릿 2종.
 */
import { describe, it, expect } from 'vitest';
import { TEMPLATES, intervalWarning, thresholdText, localPhase, localPhaseText, coverageText, coverageCells, historicalIntervalText, peakNote, lastRunText, fmtSec, scopeSummaryText } from './vmSeriesText.js';

describe('templates', () => {
  it('vCenter Only · Local + vCenter 두 가지, 키 고정', () => {
    expect(TEMPLATES.map((t) => t.k)).toEqual(['vcenter', 'both']);
    expect(TEMPLATES[0].label).toBe('vCenter Only');
    expect(TEMPLATES[1].label).toBe('Local + vCenter');
  });
});

describe('intervalWarning', () => {
  it('50분: 겹침 10분 · 소실 40분', () => {
    const t = intervalWarning(50);
    expect(t).toMatch(/겹침 10분/); expect(t).toMatch(/40분 구간/); expect(t).toMatch(/30분 이하/);
  });
  it('30분: 겹침 30분 · 무손실 권고 없음', () => {
    const t = intervalWarning(30);
    expect(t).toMatch(/겹침 30분/); expect(t).not.toMatch(/30분 이하로/);
  });
  it('60분 이상: 겹침 없음 경고', () => { expect(intervalWarning(60)).toMatch(/겹침이 없어/); });
  it('값 없음: 빈 문자열(숫자를 지어내지 않는다)', () => { expect(intervalWarning(undefined)).toBe(''); });
});

describe('localPhase / text', () => {
  it('no-db · empty · ok 를 구분한다', () => {
    expect(localPhase(null)).toBe('loading');
    expect(localPhase({ available: false })).toBe('no-db');
    expect(localPhase({ available: true, empty: true })).toBe('empty');
    expect(localPhase({ available: true, empty: false, runs: { count: 0 } })).toBe('ok');
  });
  it('표본 없음은 "스파이크 0" 이라고 말하지 않는다', () => {
    const t = localPhaseText({ available: true, empty: true, settings: { enabled: true } });
    expect(t.long).toMatch(/0 이라는 뜻이 아닙니다/);
    const off = localPhaseText({ available: true, empty: true }, { settings: { enabled: false } });
    expect(off.long).toMatch(/꺼져 있습니다/);
  });
  it('ok 인데 스파이크 0: 관측 구간 한정 + 미측정 시간 언급', () => {
    const t = localPhaseText({ available: true, empty: false, runs: { count: 0 }, coverage: { measuredHours: 100, unmeasuredHours: 68 } });
    expect(t.short).toMatch(/관측 구간/);
    expect(t.long).toMatch(/미측정 68시간은 알 수 없습니다/);
  });
  it('ok 스파이크 있음: 횟수·최장·하루 평균', () => {
    const t = localPhaseText({ available: true, empty: false, runs: { count: 12, maxSec: 140, perDay: 1.7 }, coverage: { measuredHours: 160, unmeasuredHours: 8 } });
    expect(t.short).toBe('스파이크 12회');
    expect(t.long).toMatch(/최장 2분 20초/); expect(t.long).toMatch(/하루 평균 1.7회/);
  });
});

describe('coverage', () => {
  it('미측정이 있으면 "관측 없음" 을 명시', () => {
    expect(coverageText({ pct: 71.4, measuredHours: 120, expectedHours: 168, unmeasuredHours: 48 })).toMatch(/미측정 48시간은 스파이크 0 이 아니라 관측 없음/);
    expect(coverageText({ pct: 100, measuredHours: 168, expectedHours: 168, unmeasuredHours: 0 })).not.toMatch(/미측정/);
  });
  it('셀: 7일은 시간, 그 이상은 일 평균', () => {
    const H = 3_600_000; const hours = Array.from({ length: 48 }, (_, i) => ({ h: i * H, pct: i < 24 ? 100 : 0 }));
    expect(coverageCells(hours, 7)).toHaveLength(48);
    const d = coverageCells(hours, 30);
    expect(d).toHaveLength(2); expect(d[0].pct).toBe(100); expect(d[1].pct).toBe(0);
  });
});

describe('historicalIntervalText', () => {
  it('없으면 미확인(기본값을 지어내지 않는다)', () => { expect(historicalIntervalText(null)).toMatch(/미확인/); });
  it('있으면 실측값으로', () => {
    const t = historicalIntervalText({ intervals: [{ samplingPeriod: 300, length: 86400, level: 1 }, { samplingPeriod: 1800, length: 604800, level: 2 }] });
    expect(t).toMatch(/5분·보관 1일·레벨 1/); expect(t).toMatch(/30분·보관 1주·레벨 2/);
  });
});

describe('peakNote · lastRunText · misc', () => {
  it('peakNote 는 배수와 "산정은 롤업 기준" 을 말한다', () => {
    const t = peakNote(300000, 194880, 7200);
    expect(t).toMatch(/1.54배/); expect(t).toMatch(/산정은 롤업 기준/);
    expect(peakNote(null, 1, 20)).toBe('');
  });
  it('lastRunText — mock·disk·정상', () => {
    expect(lastRunText(null)).toMatch(/아직/);
    expect(lastRunText({ mock: true })).toMatch(/mock/);
    expect(lastRunText({ paused: 'disk', freeBytes: 1024 ** 3, minFreeBytes: 5 * 1024 ** 3 })).toMatch(/디스크 여유 부족/);
    expect(lastRunText({ at: 0, vcenters: 3, vms: 100, hosts: 10, samples: 18000, moments: 42, ms: 12000, errors: [{}] })).toMatch(/실패 1/);
  });
  it('fmtSec · thresholdText · scopeSummaryText', () => {
    expect(fmtSec(20)).toBe('20초'); expect(fmtSec(3660)).toBe('1시간 1분');
    expect(thresholdText({ cpuPct: 50, memPct: 50, readyPct: 5 })).toBe('CPU ≥ 50% · 메모리(active) ≥ 50% · Ready ≥ 5%/vCPU · 벌룬·스왑 > 0');
    expect(thresholdText({ cpuPct: 0, memPct: 60, readyPct: 0 })).toBe('메모리(active) ≥ 60% · 벌룬·스왑 > 0');
    expect(scopeSummaryText({ scope: 'selected' }, [{ mode: 'selected', vms: 3, hosts: 1 }, { mode: 'none', vms: 0, hosts: 0 }])).toBe('선택 범위 — vCenter 1개 · VM 3대 · 호스트 1대');
  });
});
