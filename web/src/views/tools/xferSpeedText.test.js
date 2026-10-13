import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STATE_TEXT, FAIL_TEXT, REASON_TEXT, mbpsText, logWidth, spanText, bytesText, clockText, vsBadge, rowReasonText,
  sortRows, sparkPath, heatColor, heatTitle, trafficLines, statusLine, lastRunNote, chartModel, statCells, settingsPatch, SETTING_FIELDS,
  intervalText, scheduleText, checkScheduleForm, scheduleForSave, newSchedule, nextOccurrence, runsPerDayPreview, scheduleStateText,
  planSummary, countText, MISSED_TEXT, INTERVAL_PRESETS,
} from './xferSpeedText.js';

const HOUR = 3_600_000;

describe('xferSpeedText — 값 없음은 단위 없는 대시', () => {
  it('mbpsText', () => {
    expect(mbpsText(null)).toBe('—');
    expect(mbpsText('')).toBe('—');
    expect(mbpsText(0)).toBe('0.00 Mbps');
    expect(mbpsText(842.4)).toBe('842 Mbps');
    expect(mbpsText(61.43)).toBe('61.4 Mbps');
    expect(mbpsText(5.123, { unit: false })).toBe('5.12');
  });
  it('logWidth — 로그 눈금, 1·10·100·1000 같은 간격', () => {
    expect(logWidth(null)).toBe(0);
    expect(logWidth(0)).toBe(0);
    expect(logWidth(1)).toBe(1.5);
    expect(Math.round(logWidth(10))).toBe(33);
    expect(Math.round(logWidth(100))).toBe(67);
    expect(logWidth(1000)).toBe(100);
    expect(logWidth(5000)).toBe(100);
  });
  it('spanText·bytesText·clockText', () => {
    expect(spanText(null)).toBe('—');
    expect(spanText(120_000)).toBe('2분');
    expect(spanText(30 * 60_000)).toBe('30분');
    expect(bytesText(10 * 1_048_576)).toBe('10.0MB');
    expect(bytesText(null)).toBe('—');
    // 포탈 오프셋(한국 +540분) — 브라우저 시간대와 무관하다.
    expect(clockText(Date.UTC(2026, 9, 13, 1, 5), 540)).toBe('10-13 10:05');
    expect(clockText(0)).toBe('—');
  });
});

describe('xferSpeedText — 판정 문구', () => {
  it('상태·실패·사유 문구가 다 있다(서버 코드와 1:1 은 서버 테스트가 대조)', () => {
    expect(Object.keys(STATE_TEXT).sort()).toEqual(['excluded', 'fail', 'no-data', 'ok', 'slow', 'stale']);
    for (const v of Object.values(FAIL_TEXT)) { expect(v.label).toBeTruthy(); expect(v.fix).toBeTruthy(); }
    expect(REASON_TEXT.never).toBeTruthy();
  });
  it('측정 없음·오래됨을 정상 색으로 칠하지 않는다', () => {
    expect(STATE_TEXT['no-data'].color).not.toBe(STATE_TEXT.ok.color);
    expect(STATE_TEXT.stale.color).not.toBe(STATE_TEXT.ok.color);
  });
  it('vsBadge — 기준 없음·실패·느림', () => {
    expect(vsBadge({ state: 'ok', vsPct: null }).text).toBe('기준 없음');
    expect(vsBadge({ state: 'fail', vsPct: 90 }).tone).toBe('red');
    expect(vsBadge({ state: 'slow', vsPct: 58 }, 70)).toMatchObject({ text: '58%', tone: 'amber' });
    expect(vsBadge({ state: 'ok', vsPct: 98 }, 70).tone).toBe('green');
    expect(vsBadge({ state: 'no-data' }).text).toBe('—');
    expect(vsBadge({ state: 'ok', vsPct: 90, reason: 'partial-baseline' }).title).toContain('한쪽 방향');
  });
  it('rowReasonText — 구버전 엣지는 업그레이드를 먼저, 실패는 종류별 조치', () => {
    expect(rowReasonText({ state: 'no-data', reason: 'never', edgeOld: true, edgeVersion: '2.700.0' }, '2.735.0')).toContain('2.735.0');
    expect(rowReasonText({ state: 'fail', reason: 'auth' })).toContain('토큰');
    expect(rowReasonText({ state: 'no-data', reason: 'no-url' })).toContain('URL');
  });
});

describe('xferSpeedText — 정렬', () => {
  const rows = [
    { id: 'a', name: 'B-서울', state: 'ok', vsPct: 99, down: { latest: { ok: true, mbps: 800 } }, up: { latest: { ok: true, mbps: 600 } } },
    { id: 'b', name: 'A-뉴저지', state: 'slow', vsPct: 40, down: { latest: { ok: true, mbps: 8 } }, up: { latest: { ok: true, mbps: 5 } } },
    { id: 'c', name: 'C-미시간', state: 'fail', vsPct: null, down: { latest: { ok: false } }, up: { latest: null } },
    { id: 'd', name: 'D-자카르타', state: 'no-data', vsPct: null, down: {}, up: {} },
    { id: 'e', name: 'E-오창', state: 'ok', vsPct: 80, down: { latest: { ok: true, mbps: 50 } }, up: { latest: { ok: true, mbps: 30 } } },
  ];
  it('문제 먼저 — 실패 · 느림 · 정상(느린 순) · 측정 없음', () => {
    expect(sortRows(rows, 'slow').map((r) => r.id)).toEqual(['c', 'b', 'e', 'a', 'd']);
  });
  it('이름 순·평소 대비(값 없는 행은 뒤)', () => {
    expect(sortRows(rows, 'name').map((r) => r.id)).toEqual(['b', 'a', 'c', 'd', 'e']);
    expect(sortRows(rows, 'vs').map((r) => r.id).slice(0, 3)).toEqual(['b', 'e', 'a']);
  });
});

describe('xferSpeedText — 그림', () => {
  const now = 1_800_000_000_000;
  it('sparkPath — 실패·큰 간격에서 끊고, 점 1개는 선이 아니다', () => {
    const from = now - 24 * HOUR;
    expect(sparkPath([[now - HOUR, 10]], { from, to: now })).toBe('');
    const p = sparkPath([[now - 3 * HOUR, 10], [now - 2.5 * HOUR, 12], [now - 2 * HOUR, null], [now - 1.5 * HOUR, 11], [now - HOUR, 13]], { from, to: now });
    expect((p.match(/M/g) || []).length).toBe(2);
    const gap = sparkPath([[now - 10 * HOUR, 10], [now - 9.5 * HOUR, 12], [now - 2 * HOUR, 11], [now - 1.5 * HOUR, 13]], { from, to: now });
    expect((gap.match(/M/g) || []).length).toBe(2);
  });
  it('heatColor — null 은 측정 없음(색 없음), 비율이 낮을수록 어둡다', () => {
    expect(heatColor(null)).toBe(null);
    expect(heatColor(0.4)).toBe('#7c2d12');
    expect(heatColor(1.3)).toBe('#22d3ee');
    expect(heatTitle('KR', 3, null)).toContain('측정 없음');
    expect(heatTitle('KR', 9, { avg: 50, n: 4, ratio: 0.5 })).toContain('평소의 50%');
  });
  it('chartModel — 원시: 실패 ✕ · 간격 끊김 · 일 요약: 최저~최고 띠', () => {
    const raw = { source: 'raw', days: 1, series: { down: [{ ts: now - 3 * HOUR, mbps: 10, ok: true }, { ts: now - 2.5 * HOUR, mbps: 12, ok: true }, { ts: now - 2 * HOUR, mbps: null, ok: false }], up: [] }, stats: { down: { median: 11 } } };
    const m = chartModel(raw, { now });
    expect(m.fails.length).toBe(1);
    expect(m.points.down).toBe(2);
    expect(m.baseline('down')).not.toBe(null);
    expect(m.baseline('up')).toBe(null);
    const daily = { source: 'daily', days: 90, series: { down: [{ day: '2026-10-01', n: 48, okN: 47, avg: 50, min: 30, max: 70 }, { day: '2026-10-02', n: 48, okN: 48, avg: 52, min: 31, max: 72 }], up: [] }, stats: {} };
    const d = chartModel(daily, { now: Date.UTC(2026, 9, 3) });
    expect(d.band.length).toBe(1);
    expect(d.fails.length).toBe(0);
  });
  it('statCells — 값이 없으면 대시', () => {
    const c = statCells({ down: { avg: 10, median: null, okRate: 50, ok: 1, n: 2 }, up: null });
    expect(c[0].down).toBe('10.0 Mbps');
    expect(c[1].down).toBe('—');
    expect(c[0].up).toBe('—');
    expect(c[4].down).toBe('50% (1/2)');
  });
});

describe('xferSpeedText — 상태·설정', () => {
  it('statusLine — 측정 중 진행 · 꺼짐 · 다음 주기', () => {
    const now = 1_800_000_000_000;
    expect(statusLine({ running: true, progress: { done: 3, total: 9, current: ['A'] } }).text).toContain('3 / 9');
    expect(statusLine({ enabled: false, last: null }).text).toContain('꺼짐');
    expect(statusLine({ enabled: true, intervalMs: 30 * 60_000, last: { at: now - 10 * 60_000 } }, now).text).toContain('20분 후');
    expect(statusLine({ role: 'edge' }).text).toContain('엣지');
  });
  it('lastRunNote — 재지 못한 엣지·DB 실패를 숨기지 않는다', () => {
    const t = lastRunNote({ at: 1, targets: 28, measured: 20, failed: 1, notTried: 8, skipped: 2, ms: 1_440_000, dbOk: false, dbError: 'locked' });
    expect(t).toContain('8곳은 재지 못했습니다');
    expect(t).toContain('DB 에 쓰지 못했습니다');
  });
  it('trafficLines — 대상 0 이면 그 사실만', () => {
    expect(trafficLines({ targets: 0 })[0]).toContain('측정할 엣지가 없습니다');
    const l = trafficLines({ targets: 28, sizeMB: 10, cyclesPerDay: 48, bytesPerCycle: 28 * 20 * 1_048_576, bytesPerDayCentral: 28 * 20 * 48 * 1_048_576, bytesPerDayEdge: 20 * 48 * 1_048_576 });
    expect(l[0]).toContain('26.3GB');
    expect(l[1]).toContain('960.0MB');
  });
  it('settingsPatch — 바뀐 칸만, 빈 칸·숫자 아님은 보내지 않는다', () => {
    const saved = { enabled: false, intervalMs: 30 * 60_000, sizeMB: 10, timeoutMs: 120_000, concurrency: 1, slowPct: 70, sampleRetentionDays: 180, dailyRetentionDays: 1825, excluded: ['A'] };
    const form = { enabled: true, intervalMs: '60', sizeMB: '', timeoutMs: 'abc', concurrency: '1', slowPct: '70', sampleRetentionDays: '180', dailyRetentionDays: '1825', excluded: ['a'] };
    expect(settingsPatch(form, saved)).toEqual({ enabled: true, intervalMs: 3_600_000 });
    expect(settingsPatch({ ...form, enabled: false, intervalMs: '30', excluded: ['A', 'B'] }, saved)).toEqual({ excluded: ['A', 'B'] });
    expect(SETTING_FIELDS.every((f) => f.toSrv(f.toUi(saved[f.key])) === saved[f.key])).toBe(true);
  });
  it('화면 문구에 백틱이 없다', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, 'xferSpeedText.js'), 'utf8') + fs.readFileSync(path.join(here, 'XferSpeedTool.jsx'), 'utf8');
    const strings = src.match(/'[^'\n]*'/g) || [];
    expect(strings.filter((s) => s.includes('`'))).toEqual([]);
  });
});


describe('xferSpeedText — 실행 일정(간격 · 예약)', () => {
  const KST = 540;
  const kst = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi) - KST * 60_000;
  it('intervalText·countText', () => {
    expect(INTERVAL_PRESETS.map(intervalText)).toEqual(['30분', '1시간', '2시간', '3시간', '6시간', '12시간', '1일']);
    expect(intervalText(90)).toBe('1시간 30분');
    expect(intervalText(null)).toBe('—');
    expect(countText(48)).toBe('48');
    expect(countText(49.29)).toBe('49.3');
    expect(countText(null)).toBe('—');
  });
  it('scheduleText — 종류별 한 줄', () => {
    expect(scheduleText({ kind: 'daily', time: '09:00' })).toBe('매일 09:00');
    expect(scheduleText({ kind: 'weekly', time: '18:30', days: [1, 4] })).toBe('매주 월·목 18:30');
    expect(scheduleText({ kind: 'monthly', time: '06:00', monthDays: [1, 15] })).toBe('매월 1·15일 06:00');
    expect(scheduleText({ kind: 'once', time: '14:00', date: '2026-10-20' })).toBe('2026-10-20 14:00 1회');
  });
  it('checkScheduleForm — 문제 없으면 빈 문자열, 있으면 사유', () => {
    expect(checkScheduleForm({ kind: 'daily', time: '09:00' })).toBe('');
    expect(checkScheduleForm({ kind: 'weekly', time: '09:00', days: [] })).toContain('요일');
    expect(checkScheduleForm({ kind: 'monthly', time: '09:00', monthDays: [] })).toContain('날짜');
    expect(checkScheduleForm({ kind: 'once', time: '09:00', date: '2026-02-30' })).toContain('날짜');
    expect(checkScheduleForm({ kind: 'daily', time: '' })).toContain('시각');
  });
  it('scheduleForSave — 종류에 맞는 칸만, since 는 보내지 않는다', () => {
    expect(scheduleForSave({ id: 's-1', kind: 'weekly', time: '09:00', days: [4, 1, 1], monthDays: [3], date: '2026-01-01', since: 5, enabled: true }))
      .toEqual({ id: 's-1', kind: 'weekly', time: '09:00', days: [1, 4], enabled: true });
    expect(newSchedule(kst(2026, 10, 13, 23, 30), KST).date).toBe('2026-10-13');
  });
  it('nextOccurrence — 포탈 시각 · 매월 마지막 날 · 1회 지남', () => {
    expect(nextOccurrence({ kind: 'daily', time: '09:00' }, kst(2026, 10, 13, 9, 30), KST)).toBe(kst(2026, 10, 14, 9, 0));
    expect(nextOccurrence({ kind: 'monthly', time: '06:00', monthDays: [31] }, kst(2027, 2, 1), KST)).toBe(kst(2027, 2, 28, 6, 0));
    expect(nextOccurrence({ kind: 'once', time: '14:00', date: '2026-10-20' }, kst(2026, 10, 21), KST)).toBe(null);
  });
  it('runsPerDayPreview — 간격 + 반복 예약(하루 평균), 끈 예약·잘못된 예약은 빼고', () => {
    expect(runsPerDayPreview({ intervalOn: true, intervalMin: 30, schedules: [] })).toBe(48);
    expect(runsPerDayPreview({ intervalOn: false, intervalMin: 30, schedules: [{ kind: 'daily', time: '09:00', enabled: true }, { kind: 'weekly', time: '09:00', days: [1, 4], enabled: true }, { kind: 'daily', time: '09:00', enabled: false }, { kind: 'weekly', time: '09:00', days: [], enabled: true }] })).toBe(1.29);
  });
  it('statusLine — 다음 실행(예약·간격·없음)', () => {
    const now = kst(2026, 10, 13, 8, 0);
    expect(statusLine({ enabled: true, offsetMin: KST, next: { at: kst(2026, 10, 13, 9, 0), kind: 'schedule', id: 'a' }, last: null }, now).text).toContain('10-13 09:00 예약');
    expect(statusLine({ enabled: true, next: { at: now + 20 * 60_000, kind: 'interval' }, last: { at: now - 10 * 60_000 } }, now).text).toContain('다음 간격 실행 약 20분 후');
    expect(statusLine({ enabled: true, next: null, last: null }, now).text).toContain('다음 실행 예정 없음');
  });
  it('scheduleStateText — 놓침은 사유와 함께', () => {
    const t = scheduleStateText({ next: null, last: { lastAt: kst(2026, 10, 13, 9, 0), result: 'missed', reason: 'down' } }, KST, kst(2026, 10, 13, 12));
    expect(t).toContain('놓침');
    expect(t).toContain(MISSED_TEXT.down);
    expect(scheduleStateText({ last: { lastAt: kst(2026, 10, 13, 9, 0), result: 'ran' } }, KST)).toContain('실행함');
  });
  it('planSummary — 간격 · 예약 개수(사용 중인 것만)', () => {
    expect(planSummary({ intervalOn: true, intervalMs: 30 * 60_000, schedules: [] })).toBe('30분마다');
    expect(planSummary({ intervalOn: false, intervalMs: 30 * 60_000, schedules: [] })).toBe('간격 실행 꺼짐 · 사용 중인 예약 없음');
    expect(planSummary({ intervalOn: true, intervalMs: 3_600_000, schedules: [{ kind: 'daily', time: '09:00', enabled: true }, { kind: 'daily', time: '10:00', enabled: false }] })).toBe('1시간마다 · 예약 1개(매일 09:00)');
  });
  it('settingsPatch — 간격 켬/끔 · 예약은 바뀌었을 때만', () => {
    const saved = { enabled: true, intervalOn: true, intervalMs: 30 * 60_000, sizeMB: 10, timeoutMs: 120_000, concurrency: 1, slowPct: 70, sampleRetentionDays: 180, dailyRetentionDays: 1825, excluded: [], schedules: [{ id: 's-1', kind: 'daily', time: '09:00', enabled: true, since: 5 }] };
    const base = { enabled: true, intervalOn: true, intervalMs: '30', sizeMB: '10', timeoutMs: '120', concurrency: '1', slowPct: '70', sampleRetentionDays: '180', dailyRetentionDays: '1825', excluded: [], schedules: [{ id: 's-1', kind: 'daily', time: '09:00', enabled: true, since: 5, date: '2026-10-13', days: [1], monthDays: [1] }] };
    expect(settingsPatch(base, saved)).toEqual({});
    expect(settingsPatch({ ...base, intervalOn: false }, saved)).toEqual({ intervalOn: false });
    const p = settingsPatch({ ...base, schedules: [...base.schedules, { id: '', kind: 'weekly', time: '18:00', days: [2], enabled: true }] }, saved);
    expect(p.schedules).toEqual([{ id: 's-1', kind: 'daily', time: '09:00', enabled: true }, { kind: 'weekly', time: '18:00', days: [2], enabled: true }]);
  });
});
