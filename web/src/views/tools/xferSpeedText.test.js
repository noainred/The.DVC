import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STATE_TEXT, FAIL_TEXT, REASON_TEXT, mbpsText, logWidth, spanText, bytesText, clockText, vsBadge, rowReasonText,
  sortRows, sparkPath, heatColor, heatTitle, trafficLines, statusLine, lastRunNote, chartModel, statCells, settingsPatch, SETTING_FIELDS, LATENCY_NOTE,
  intervalText, scheduleText, checkScheduleForm, scheduleForSave, newSchedule, nextOccurrence, runsPerDayPreview, scheduleStateText,
  planSummary, countText, MISSED_TEXT, INTERVAL_PRESETS, PERIODS, DEFAULT_PERIOD_DAYS,
  hoverAt, maxBackOf, windowEndOf, windowLabel, windowRangeText, cadenceOf,
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
  it('statCells — 지연(중앙값)은 ↑ 도 같은 칸 · 설명 문구에 백틱 없음(v2.735.2)', () => {
    const c = statCells({ down: { ttfbMedian: 80 }, up: { ttfbMedian: 83 } });
    const lat = c.find((x) => x.label === '지연(중앙값)');
    expect(lat).toBeTruthy();
    expect(lat.down).toBe('80ms');
    expect(lat.up).toBe('83ms');
    expect(c.some((x) => x.label.includes('응답 시작'))).toBe(false);
    expect(LATENCY_NOTE).toMatch(/전체 − 엣지 수신 구간/);
    expect(LATENCY_NOTE).not.toMatch(/`/);
  });
});

describe('xferSpeedText — 기본 기간(v2.735.2)', () => {
  it('법인 상세는 24시간으로 열린다 — 기간 버튼에 있는 값이고 화면이 그 상수를 쓴다', () => {
    expect(DEFAULT_PERIOD_DAYS).toBe(1);
    expect(PERIODS.find((p) => p.days === DEFAULT_PERIOD_DAYS)?.label).toBe('24시간');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, 'XferSpeedTool.jsx'), 'utf8');
    expect(src).toMatch(/useState\(DEFAULT_PERIOD_DAYS\)/);
    expect(src).not.toMatch(/const \[days, setDays\] = useState\(\d+\)/);
  });
});

describe('xferSpeedText — 이전 구간 보기(v2.735.3)', () => {
  const DAY = 24 * HOUR;
  // 정시에서 떨어뜨린 고정 시각(KST 2026-10-14 13:30).
  const END = Date.UTC(2026, 9, 14, 4, 30);
  it('windowEndOf — back 칸만큼 같은 길이로 과거, 범위로 자른다', () => {
    expect(windowEndOf(END, 0, 1).end).toBe(END);
    expect(windowEndOf(END, 3, 1).end).toBe(END - 3 * DAY);
    expect(windowEndOf(END, 2, 7).end).toBe(END - 14 * DAY);
    expect(windowEndOf(END, 9, 1, 4)).toEqual({ end: END - 4 * DAY, back: 4 });
    expect(windowEndOf(END, -2, 1).back).toBe(0);
    expect(windowEndOf(END, 'x', 1).back).toBe(0);
  });
  it('maxBackOf — 원시 보기는 가장 오래된 원시 표본, 일 요약 보기는 가장 오래된 날까지', () => {
    const hist = { days: 1, rawMaxDays: 31, offsetMin: 540, oldest: { sampleTs: END - 2.5 * DAY, day: '2026-01-01' } };
    // 창 끝 − 0.5일 이 표본이 들어가는 마지막 칸 = 2칸 전([END−3d, END−2d])
    expect(maxBackOf(hist, END)).toBe(2);
    expect(maxBackOf({ ...hist, oldest: { sampleTs: END - 0.5 * DAY } }, END)).toBe(0, '첫 창 안에만 기록이 있으면 갈 곳이 없다');
    expect(maxBackOf({ ...hist, oldest: { sampleTs: null } }, END)).toBe(0);
    expect(maxBackOf({ ...hist, oldest: null }, END)).toBe(0);
    expect(maxBackOf({ ...hist, oldest: { sampleTs: END + DAY } }, END)).toBe(0);
    // 90일 보기는 일 요약 — 2026-01-01(KST 자정) 까지
    const d90 = { days: 90, rawMaxDays: 31, offsetMin: 540, oldest: { sampleTs: END - DAY, day: '2026-01-01' } };
    const oldMs = Date.parse('2026-01-01T00:00:00Z') - 540 * 60_000;
    expect(maxBackOf(d90, END)).toBe(Math.ceil((END - oldMs) / (90 * DAY)) - 1);
    expect(maxBackOf({ ...d90, oldest: { day: '2026-1-1' } }, END)).toBe(0, '형식이 틀린 날짜는 기록 없음으로');
    expect(maxBackOf({ days: 1, oldest: { sampleTs: END - 100000 * DAY } }, END)).toBe(3650, '상한');
  });
  it('windowLabel · windowRangeText', () => {
    expect(windowLabel(0, 1)).toBe('최근 구간');
    expect(windowLabel(3, 1)).toBe('3칸 전 (24시간 단위)');
    expect(windowLabel(2, 7)).toBe('2칸 전 (7일 단위)');
    expect(windowRangeText(END, 1, 540)).toBe(`${clockText(END - DAY, 540)} ~ ${clockText(END, 540)}`);
    expect(windowRangeText(null, 1)).toBe('');
  });
  it('chartModel — 축은 서버가 준 창(end)을 따른다', () => {
    const hist = { days: 1, end: END - 5 * DAY, source: 'raw', series: { down: [{ ts: END - 5.5 * DAY, mbps: 20, ok: true }], up: [] }, stats: {} };
    const m = chartModel(hist, { w: 1000, h: 260, now: END });
    expect(m.to).toBe(END - 5 * DAY);
    expect(m.from).toBe(END - 6 * DAY);
    expect(m.pts.down[0].x).toBeCloseTo(m.padL + (m.w - m.padL - m.padR) / 2, 0);
    const legacy = chartModel({ ...hist, end: undefined }, { now: END });
    expect(legacy.to).toBe(END, 'end 가 없는 구버전 응답은 지금 기준');
  });
});

describe('xferSpeedText — 차트 마우스 오버(v2.735.3)', () => {
  const END = Date.UTC(2026, 9, 14, 4, 30);
  const hist = {
    days: 1, end: END, source: 'raw', offsetMin: 540, stats: {},
    series: {
      down: [
        { ts: END - 10 * HOUR, mbps: 28.8, ok: true, bytes: 10_485_760, latMs: 449 },
        { ts: END - 4 * HOUR, mbps: null, ok: false, kind: 'timeout', bytes: null, latMs: null },
      ],
      up: [{ ts: END - 10 * HOUR + 30_000, mbps: 23.1, ok: true, bytes: 10_485_760, latMs: 246 }],
    },
  };
  const m = chartModel(hist, { w: 1000, h: 260, now: END });
  const pxOf = (ts) => m.padL + ((ts - m.from) / (m.to - m.from)) * (m.w - m.padL - m.padR);
  it('가장 가까운 측정 — 시각·두 방향 속도·바이트·지연', () => {
    const hv = hoverAt(m, pxOf(END - 10 * HOUR + 60_000), 540);
    expect(hv.head).toBe(clockText(END - 10 * HOUR + 30_000, 540));
    const [d, u] = hv.lines;
    expect(d.dir).toBe('down');
    expect(d.text).toContain('28.8 Mbps');
    expect(d.text).toContain(bytesText(10_485_760));
    expect(d.text).toContain('지연 449ms');
    expect(u.text).toContain('23.1 Mbps');
    expect(hv.dots).toHaveLength(2);
  });
  it('실패는 실패 사유 · 다른 방향은 측정 없음 · 측정이 없던 곳은 null', () => {
    const hv = hoverAt(m, pxOf(END - 4 * HOUR), 540);
    expect(hv.lines[0].text).toContain('실패');
    expect(hv.lines[0].text).toContain(FAIL_TEXT.timeout.label);
    expect(hv.lines[0].ok).toBe(false);
    expect(hv.lines[1]).toEqual({ dir: 'up', text: '측정 없음', ok: null });
    expect(hv.dots).toHaveLength(0, '실패 점에는 값 동그라미를 찍지 않는다');
    expect(hoverAt(m, pxOf(END - 20 * HOUR), 540)).toBeNull();
    expect(hoverAt(m, 2, 540)).toBeNull('왼쪽 여백 = 축 시작 — 그 근처에 측정이 없으면 null');
    expect(hoverAt(m, m.w + 5, 540)).toBeNull('차트 밖');
    expect(hoverAt(null, 100)).toBeNull();
  });
  it('좌우 여백에 마우스가 있으면 축 끝으로 본다 — 좁은 화면에서 끝 점을 고를 수 있게', () => {
    const eh = { days: 1, end: END, offsetMin: 540, stats: {},
      series: { down: [{ ts: END - 5 * 60_000, mbps: 41, ok: true, bytes: 10_485_760, latMs: 30 }], up: [] } };
    const em = chartModel(eh, { w: 318, h: 220, now: END });
    const hv = hoverAt(em, em.w - em.padR / 2, 540);
    expect(hv).not.toBeNull();
    expect(hv.lines[0].text).toContain('41.0 Mbps');
  });
  it('일 요약 — 평균(최저·최고)·성공 횟수, 값을 지어내지 않는다', () => {
    const dh = { days: 90, end: END, source: 'daily', offsetMin: 540, stats: {},
      series: { down: [{ day: '2026-10-10', n: 48, okN: 47, avg: 22.5, min: 5.47, max: 34.8 }], up: [{ day: '2026-10-10', n: 48, okN: 0, avg: null, min: null, max: null }] } };
    const dm = chartModel(dh, { w: 1000, h: 260, now: END });
    const ts = Date.parse('2026-10-10T12:00:00Z') - 540 * 60_000;   // 포탈 시각 정오
    const px = dm.padL + ((ts - dm.from) / (dm.to - dm.from)) * (dm.w - dm.padL - dm.padR);
    const hv = hoverAt(dm, px, 540);
    expect(hv.head).toBe('2026-10-10 하루 요약');
    expect(hv.lines[0].text).toBe('평균 22.5 Mbps (최저 5.47 · 최고 34.8) · 성공 47/48');
    expect(hv.lines[1].text).toBe('성공 측정 없음 · 실패 48회');
  });
  it('화면 — 과거 구간은 1분 갱신을 하지 않고, 스크롤·오버를 그린다', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, 'XferSpeedTool.jsx'), 'utf8');
    expect(src).toMatch(/if \(alive && end == null && !shouldStopPolling\(e\)\) timer = setTimeout\(loop, 60_000\)/);   // v2.740 D-05: 403·404 면 멈춘다
    expect(src).toMatch(/<WindowScroll /);
    expect(src).toMatch(/hoverAt\(m, hoverPx/);
    expect(src).toMatch(/const key = `\$\{agent\}\|\$\{days\}`/);
  });
});

describe('xferSpeedText — 리뷰 확정분(v2.735.3)', () => {
  const END = Date.UTC(2026, 9, 14, 4, 30);
  const series = (stepMs, n, base = END - 23 * HOUR) => Array.from({ length: n }, (_, i) => ({ ts: base + i * stepMs, mbps: 100 + i, ok: true }));
  it('cadenceOf — 연속 점 간격의 중앙값', () => {
    expect(cadenceOf([{ ts: 0 }, { ts: 10 }, { ts: 20 }, { ts: 100 }])).toBe(10);
    expect(cadenceOf([{ ts: 0 }, { ts: 10 }, { ts: 200 }])).toBe(10, '짝수 개면 아래쪽 중앙값');
    expect(cadenceOf([{ ts: 5 }])).toBeNull();
    expect(cadenceOf([])).toBeNull();
  });
  it('XS-01 측정 간격이 2시간·3시간이어도 선을 긋는다 — 끊는 간격은 데이터 주기에서', () => {
    for (const stepH of [2, 3]) {
      const m = chartModel({ days: 1, end: END, source: 'raw', stats: {}, series: { down: series(stepH * HOUR, Math.floor(22 / stepH)), up: [] } }, { now: END });
      expect(m.down).toContain('L');
      expect(m.singles.down).toHaveLength(0);
    }
    // 30분 주기 + 측정이 빠진 4시간 구멍은 여전히 끊는다
    const pts = [...series(30 * 60_000, 6), ...series(30 * 60_000, 6, END - 8 * HOUR)];
    const m2 = chartModel({ days: 1, end: END, source: 'raw', stats: {}, series: { down: pts, up: [] } }, { now: END });
    expect((m2.down.match(/M/g) || []).length).toBe(2);
  });
  it('XS-01 이어지지 못한 점은 점으로(singles)', () => {
    const pts = [{ ts: END - 20 * HOUR, mbps: 50, ok: true }, { ts: END - 19.5 * HOUR, mbps: 60, ok: true }, { ts: END - 2 * HOUR, mbps: 70, ok: true }];
    const m = chartModel({ days: 1, end: END, source: 'raw', stats: {}, series: { down: pts, up: [] } }, { now: END });
    expect(m.singles.down).toHaveLength(1);
  });
  it('XS-01 스파크라인 — 2시간 주기도 선', () => {
    const pts = Array.from({ length: 10 }, (_, i) => [END - 22 * HOUR + i * 2 * HOUR, 100 + i]);
    expect(sparkPath(pts, { from: END - 24 * HOUR, to: END })).toContain('L');
  });
  it('XS-02 눈금은 포탈 시각 경계 — 7일 보기 날짜 눈금이 00:00(KST)', () => {
    const m = chartModel({ days: 7, end: END, source: 'raw', offsetMin: 540, stats: {}, series: { down: series(HOUR, 3), up: [] } }, { now: END });
    expect(m.xticks.length).toBeGreaterThan(5);
    for (const t of m.xticks) expect(clockText(t.ts, 540)).toMatch(/ 00:00$/);
    const d1 = chartModel({ days: 1, end: END, source: 'raw', offsetMin: 540, stats: {}, series: { down: series(HOUR, 3), up: [] } }, { now: END });
    for (const t of d1.xticks) expect(clockText(t.ts, 540)).toMatch(/ (00|06|12|18):00$/);
  });
  it('XS-09 일 요약 점은 그날 포탈 정오 — 축 끝을 넘지 않는다', () => {
    const day = '2026-10-14';
    const m = chartModel({ days: 90, end: END, source: 'daily', offsetMin: 540, stats: {}, series: { down: [{ day, n: 1, okN: 1, avg: 1, min: 1, max: 1 }], up: [] } }, { now: END });
    expect(clockText(m.pts.down[0].ts, 540)).toBe('10-14 12:00');
  });
  it('XS-03 엣지 수집 경로 꺼짐 문구가 있다', () => {
    expect(FAIL_TEXT['collector-off'].fix).toContain('COLLECTOR_TOKEN');
  });
  it('화면 — 메인 폴링은 세대 번호로 하나만, 상세 CSV 는 보고 있는 구간', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, 'XferSpeedTool.jsx'), 'utf8');
    expect(src).toMatch(/if \(alive && gen === genRef\.current && !stopRef\.current\) timer = setTimeout/);   // v2.740 D-05: 403·404 면 멈춘다
    expect(src).toMatch(/export\.csv\?days=\$\{Math\.min\(730, days\)\}&agent=\$\{encodeURIComponent\(agent\)\}\$\{end != null/);
    expect(src).toMatch(/측정 \$\{n\}회/);
    expect(src).not.toMatch(/한국 시각/);
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

describe('xferSpeedText — v2.740 감사(B-09·D-03·D-04·D-05·D-07)', () => {
  it('D-03 숫자가 아닌 칸은 저장하지 않고 칸 이름과 함께 말한다(예전엔 조용히 버리고 창을 닫았다)', async () => {
    const { settingsIssues, NO_CHANGE_TEXT, XFER_RANGES } = await import('./xferSpeedText.js');
    const a = settingsIssues({ intervalMs: '60분' });
    expect(a.map((x) => x.key)).toEqual(['intervalMs']);
    expect(a[0].label).toBe('측정 주기');
    expect(a[0].reason).toMatch(/숫자만/);
    expect(settingsIssues({ sizeMB: '1,000' }).map((x) => x.key)).toEqual(['sizeMB']);
    expect(settingsIssues({ sizeMB: '1e1' }).map((x) => x.key)).toEqual(['sizeMB'], '지수 표기도 숫자 칸 입력이 아니다');
    expect(settingsIssues({ intervalMs: '', sizeMB: '  ' })).toEqual([], '빈 칸은 그대로 둔다(문제 아님)');
    expect(settingsIssues({ intervalMs: '30', sizeMB: '10', timeoutMs: '120', concurrency: '1', slowPct: '70', sampleRetentionDays: '180', dailyRetentionDays: '1825' })).toEqual([]);
    expect(NO_CHANGE_TEXT).toMatch(/바뀐 값이 없습니다/);
    expect(Object.keys(XFER_RANGES).sort()).toEqual(SETTING_FIELDS.map((f) => f.key).sort(), '폼 칸 = 범위 키');
  });
  it('D-04 범위 밖은 화면 단위로 막는다(경계는 받는다)', async () => {
    const { settingsIssues } = await import('./xferSpeedText.js');
    const big = settingsIssues({ sizeMB: '200' });
    expect(big[0].reason).toMatch(/1~50MB/);
    expect(settingsIssues({ sizeMB: '50' })).toEqual([]);
    expect(settingsIssues({ concurrency: '10' }).map((x) => x.key)).toEqual(['concurrency']);
    expect(settingsIssues({ intervalMs: '9' }).map((x) => x.key)).toEqual(['intervalMs'], '10분 미만');
    expect(settingsIssues({ intervalMs: '10' })).toEqual([]);
    expect(settingsIssues({ intervalMs: '10081' }).map((x) => x.key)).toEqual(['intervalMs'], '7일 초과');
    expect(settingsIssues({ sizeMB: '60' }, { sizeMB: { min: 1, max: 100 } })).toEqual([], '서버가 준 범위를 먼저 쓴다');
  });
  it('D-05 403·404 는 다시 물어도 같다 — 폴링 루프를 멈춘다(그 밖의 실패는 계속)', async () => {
    const { shouldStopPolling } = await import('./xferSpeedText.js');
    expect(shouldStopPolling({ status: 403 })).toBe(true);
    expect(shouldStopPolling({ status: 404 })).toBe(true);
    expect(shouldStopPolling({ status: 500 })).toBe(false);
    expect(shouldStopPolling(new Error('timeout'))).toBe(false);
    expect(shouldStopPolling(null)).toBe(false);
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'XferSpeedTool.jsx'), 'utf8');
    expect((src.match(/shouldStopPolling\(/g) || []).length).toBeGreaterThanOrEqual(2, '메인·상세 두 루프');
    expect(src).not.toMatch(/if \(!Object\.keys\(patch\)\.length\) \{ onClose\(\); return; \}/, '바뀐 것이 없다고 아무 말 없이 닫지 않는다');
    expect(src).toMatch(/settingsIssues\(form/);
  });
  it('D-07 다시 읽기 실패는 직전 값 위에 한 줄로 말한다', async () => {
    const { heatReloadNote } = await import('./xferSpeedText.js');
    expect(heatReloadNote(null)).toBe('');
    expect(heatReloadNote(new Error('HTTP 500'))).toMatch(/다시 읽지 못했습니다 — 직전에 받은 값.*HTTP 500/);
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'XferSpeedTool.jsx'), 'utf8');
    expect(src).toMatch(/reloadNote=\{heatReloadNote\(heatErr\)\}/);
  });
  it('B-09 시계 어긋남 사유·놓침 사유 문구', async () => {
    const { REASON_TEXT: R, MISSED_TEXT: M } = await import('./xferSpeedText.js');
    expect(R['clock-skew']).toMatch(/지금보다 앞서/);
    expect(M.clock).toMatch(/시계/);
  });
});
