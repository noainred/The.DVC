import { describe, it, expect } from 'vitest';
import {
  rateText, sizeText, elapsedText, progressPct, liveCodeText, corpBadge, corpMatches, corpFilterCounts, sortCorps,
  sparkSegments, totalHist, slowRows, levelWord, triggerText, reasonText, REASON_HINT, STUCK_TEXT, sortWaiting,
} from './bareosLiveText.js';

// v2.833 진행 현황판 — 못 읽은 값은 '모름'(0 이 아니다) · 실행이 없으면 '—'
describe('숫자 문구', () => {
  it('속도·크기·경과·추정 진척', () => {
    expect(rateText(168_000_000)).toBe('168.0 MB/s');
    expect(rateText(null)).toBe('모름');
    expect(rateText(-1)).toBe('모름');
    expect(rateText(0)).toBe('0 B/s');
    expect(sizeText(412_345_678_912)).toBe('412.3 GB');
    expect(sizeText(null)).toBe('—');
    expect(elapsedText(40_000)).toBe('40초');
    expect(elapsedText(6 * 60_000)).toBe('6분');
    expect(elapsedText(72 * 60_000)).toBe('1시간 12분');
    expect(elapsedText(null)).toBe('—');
    expect(progressPct(512 * 1024 ** 3, 1024)).toBe(50);
    expect(progressPct(5 * 1024 ** 4, 1)).toBe(100);
    expect(progressPct(null, 10)).toBe(null);
    expect(progressPct(10, null)).toBe(null);
    expect(liveCodeText('timeout')).toMatch(/시한/);
    expect(liveCodeText('weird')).toBe('상태 조회 실패');
    expect(levelWord('F')).toBe('Full');
    expect(levelWord('')).toBe('—');
    expect(triggerText({ trigger: 'group-schedule' })).toBe('그룹 예약');
    expect(triggerText({ trigger: '', by: 'adm' })).toBe('수동');
  });
});

const C = (o) => ({ vcenterId: o.id || 'x', vcName: o.name || o.id || 'x', running: 0, waiting: 0, slow: 0, rateNow: 0, live: null, hist: [], rows: [], today: { ok: 0, warn: 0, fail: 0 }, ...o });
describe('법인 표지·거르기·순서', () => {
  it('실행 없음 · 조회 전 · 조회 실패 · 느림 · 대기만 · 정상', () => {
    expect(corpBadge(C({})).key).toBe('idle');
    expect(corpBadge(C({ running: 1 })).key).toBe('pending');
    expect(corpBadge(C({ running: 1, live: { ok: false, code: 'timeout' } })).key).toBe('fail');
    expect(corpBadge(C({ running: 1, slow: 2, live: { ok: true } })).text).toBe('느림 2');
    expect(corpBadge(C({ waiting: 1, live: { ok: true } })).key).toBe('wait');
    expect(corpBadge(C({ running: 1, live: { ok: true } })).key).toBe('ok');
  });
  it('거르기 수 · 순서(실행 중 먼저, 속도 큰 순, 모름은 뒤)', () => {
    const cs = [C({ id: 'a' }), C({ id: 'b', running: 1, rateNow: null, live: { ok: false } }), C({ id: 'c', running: 2, rateNow: 5, live: { ok: true }, slow: 1 }), C({ id: 'd', running: 1, rateNow: 9, live: { ok: true } })];
    expect(corpFilterCounts(cs)).toEqual({ active: 3, stuck: 0, slow: 1, fail: 1, all: 4 });
    expect(sortCorps(cs).map((c) => c.vcenterId)).toEqual(['d', 'c', 'b', 'a']);
    expect(corpMatches(cs[0], 'active')).toBe(false);
  });
});

describe('흐름 — 모르는 점은 선을 끊는다 · 부분 합은 전체처럼 그리지 않는다', () => {
  it('sparkSegments', () => {
    expect(sparkSegments([[0, 1]])).toEqual([]);
    const segs = sparkSegments([[0, 0], [10, 10], [20, null], [30, 5], [40, 10]], 40, 20, 0);
    expect(segs).toEqual(['0.0,20.0 10.0,0.0', '30.0,10.0 40.0,0.0']);
  });
  it('totalHist', () => {
    const t = totalHist([C({ hist: [[30_000, 5], [60_000, 6]] }), C({ hist: [[30_000, 1], [60_000, null]] })]);
    expect(t).toEqual([{ at: 30_000, rate: 6, partial: false }, { at: 60_000, rate: null, partial: true }]);
  });
  it('느린 잡 — 비율 작은 순', () => {
    const r = slowRows([C({ name: 'A', rows: [{ jobid: 1, slow: true, rateNow: 5, baseline: 100 }, { jobid: 2, rateNow: 1, baseline: 100 }] }), C({ name: 'B', rows: [{ jobid: 3, slow: true, rateNow: 1, baseline: 100 }] })]);
    expect(r.map((x) => [x.corp, x.jobid])).toEqual([['B', 3], ['A', 1]]);
    expect(r[0].ratio).toBe(0.01);
  });
});

// v2.833.1 — Director 상태 문구 · 멈춤 의심 · 대기 사유
describe('Director 상태 · 멈춤 의심', () => {
  it('사유 문구 — 모르는 키는 기타', () => {
    expect(reasonText('running')).toBe('실행 중');
    expect(reasonText('maxjobs')).toBe('동시 실행 상한');
    expect(reasonText('unknown')).toBe('사유 모름');
    expect(reasonText('zzz')).toBe('기타');
    expect(REASON_HINT.maxjobs).toMatch(/Maximum Concurrent Jobs/);
    expect(STUCK_TEXT['no-report']).toMatch(/3시간/);
    expect(STUCK_TEXT.zero).toMatch(/속도 0/);
  });
  it('멈춤 의심은 조회 실패보다 앞 · 거르기에서 느림과 함께 센다', () => {
    const st = C({ id: 's', running: 2, stuck: 1, slow: 1, live: { ok: true } });
    expect(corpBadge(st)).toEqual({ key: 'stuck', text: '멈춤 의심 1', tone: 'warn' });
    expect(corpBadge(C({ running: 1, stuck: 1, live: { ok: false } })).key).toBe('stuck');
    expect(corpBadge(C({ running: 1, stuck: 0, live: { ok: true } })).key).toBe('ok');
    const cs = [st, C({ id: 'n', running: 1, stuck: 1, live: { ok: true } }), C({ id: 'o', running: 1, slow: 1, live: { ok: true } })];
    expect(corpFilterCounts(cs)).toEqual({ active: 3, stuck: 2, slow: 2, fail: 0, all: 3 });
    expect(corpMatches(cs[1], 'slow')).toBe(false);
  });
  it('대기 — 오래 기다린 순 · 보낸 시각 모름은 뒤 · 원본 불변', () => {
    const rows = [{ jobid: 1, since: 300 }, { jobid: 2, since: null }, { jobid: 3, since: 100 }, { jobid: 4 }];
    expect(sortWaiting(rows).map((r) => r.jobid)).toEqual([3, 1, 2, 4]);
    expect(rows.map((r) => r.jobid)).toEqual([1, 2, 3, 4]);
    expect(sortWaiting(null)).toEqual([]);
  });
});
