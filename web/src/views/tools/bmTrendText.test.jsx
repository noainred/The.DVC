/**
 * v2.923 — 리눅스 베어메탈 통합 성능 3b(서버 상세 ‘추이’ 탭 · 확대 팝업 · 장치 토글 · CVP 포트 절)의 문구 · 그리기 · 토글 · 조회기 회귀.
 * ⚠ 창 · 해상도 · 결측 · 기준선 · 포트 상태 · 대조 판정은 서버(trendWindow · portCompare) — 여기서는 서버 응답을 그리기만 하는지와
 *   웹 쪽 표(지표 · 피크 열 · 상태 · 판정 이름)가 서버 표와 같은지(두 벌이면 대조)를 고정한다.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as T from './bmTrendText.js';
import { createTrendLoader } from './bmTrendLoad.js';
import { TrendRow, Spark } from './BmTrendChart.jsx';
import BmTrendTab from './BmTrendTab.jsx';
import BmTrendPopup from './BmTrendPopup.jsx';
import { BmPerfDetailView } from './BmPerfDetail.jsx';
import { DETAIL_TABS } from './bmPerfText.js';
import { sortChildren } from '../../components/sortableText.js';
import * as VP from '../../components/vmperf/vmPerfText.js';
import { SERVER_METRICS, DEVICE_METRICS, RES_MS, gapsOf, toPoints } from '../../../../server/src/bmusage/trendWindow.js';
import { PEAK_COLS, DEVICE_PEAK_COLS, PEAK_SRC } from '../../../../server/src/bmusage/perfCols.js';
import { PORT_STATES, COMPARE_VERDICTS, compareTraffic } from '../../../../server/src/bmusage/portCompare.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const H = 3_600_000;
const NOW = Math.floor(Date.now() / H) * H - 30 * 60_000;   // 정시 경계에서 30분 앞(docs/rules/common.md 권장형)
const WIN = { from: NOW - 24 * H, to: NOW };
const pt = (t, avg, peak = null, o = {}) => ({ t, avg, max: avg, peak, peakAt: peak == null ? null : t - 1000, n: 1, ...o });

describe('웹 지표 표 = 서버 표(두 벌이면 대조)', () => {
  it('서버 지표 이름은 서버 화이트리스트 안 · 피크 열 유무는 PEAK_COLS 와 같다', () => {
    for (const [m, info] of Object.entries(T.SERVER_METRIC_INFO)) {
      expect(SERVER_METRICS).toContain(m);
      expect(info.peak).toBe(PEAK_COLS.includes(m));
    }
    // 서버 피크 열은 웹 표에 전부 있다(빠지면 피크 화면에서 사라진다)
    for (const c of PEAK_COLS) expect(Object.keys(T.SERVER_METRIC_INFO)).toContain(c);
  });
  it('장치 지표는 종류별 화이트리스트 안 · 피크 열은 DEVICE_PEAK_COLS 와 같다', () => {
    for (const kind of ['disk', 'nic', 'mount']) {
      for (const [m, info] of Object.entries(T.DEVICE_METRIC_INFO[kind])) {
        expect(DEVICE_METRICS[kind]).toContain(m);
        expect(info.peak).toBe(DEVICE_PEAK_COLS.includes(m));
      }
    }
  });
  it('패널 · 추천 행이 부르는 지표는 모두 서버가 받는 이름이다(400 을 부르지 않는다)', () => {
    for (const m of [...T.panelMetrics(), ...T.recoMetrics()]) expect(SERVER_METRICS).toContain(m);
    for (const r of T.PANEL_ROWS.filter((x) => x.devKind)) expect(DEVICE_METRICS[r.devKind]).toContain(r.devMetric);
  });
  it('피크 출처 · 포트 상태 · 대조 판정 · 해상도 이름이 서버 표와 같다', () => {
    expect(Object.keys(T.PEAK_SRC_TEXT).sort()).toEqual([...PEAK_SRC].sort());
    expect(Object.keys(T.PORT_STATE_INFO).sort()).toEqual([...PORT_STATES].sort());
    expect([...T.PORT_STATE_ORDER].sort()).toEqual([...PORT_STATES].sort());
    expect(Object.keys(T.COMPARE_INFO).sort()).toEqual([...COMPARE_VERDICTS].sort());
    expect(Object.keys(T.RES_TEXT).sort()).toEqual(Object.keys(RES_MS).sort());
  });
  it('추천 지표 12행 · 출처 태그 6 — 행마다 태그 · 각주 · 지표가 있다', () => {
    expect(T.RECO_TILES).toHaveLength(12);
    expect(T.SOURCE_ORDER).toEqual(['SRE', 'NF', 'USE', 'DELL', 'ND', 'CM']);
    for (const x of T.RECO_TILES) {
      expect(x.tags.length).toBeGreaterThan(0);
      for (const tg of x.tags) expect(T.SOURCE_TAGS[tg]).toBeTruthy();
      expect(x.note.length).toBeGreaterThan(10);
      expect(x.metrics.length).toBeGreaterThan(0);
    }
    expect(T.SOURCE_TAGS.SRE.grade).toBe('●');
    expect(T.SOURCE_TAGS.CM.grade).toBe('○');
  });
});

describe('그리기 — 결측은 서버 gaps 로 끊는다(다시 계산하지 않는다)', () => {
  const step = 300_000;
  const t0 = WIN.from + step;
  it('값이 null 이면 끊고 · 홀로 남은 점은 점(dots)으로', () => {
    const pts = [pt(t0, 10), pt(t0 + step, 20), pt(t0 + 2 * step, null), pt(t0 + 3 * step, 30), pt(t0 + 4 * step, null), pt(t0 + 5 * step, 40), pt(t0 + 6 * step, 50)];
    const p = T.seriesPath(pts, { ...WIN, yMax: 100 });
    expect((p.d.match(/M/g) || []).length).toBe(2);
    expect(p.dots).toHaveLength(1);
    expect(p.drawn).toBe(5);
  });
  it('서버가 준 결측 구간이 두 점 사이에 걸치면 끊는다 — 서버 gapsOf 결과 그대로', () => {
    const pts = [t0, t0 + step, t0 + 2 * step, t0 + 10 * step, t0 + 11 * step].map((t) => pt(t, 5));
    const gaps = gapsOf(pts, { ...WIN, stepMs: step });
    const p = T.seriesPath(pts, { ...WIN, yMax: 100, gaps });
    expect((p.d.match(/M/g) || []).length).toBe(2);
  });
  it('서버가 결측이라 하지 않은 간격은 잇는다(웹이 거리로 결측을 다시 판정하지 않는다)', () => {
    const pts = [pt(t0, 5), pt(t0 + 50 * step, 6)];
    expect((T.seriesPath(pts, { ...WIN, yMax: 100, gaps: [] }).d.match(/M/g) || []).length).toBe(1);
  });
  it('창 밖의 점은 그리지 않고 · 값은 yMax 로 잘린다 · 창이 이상하면 빈 결과', () => {
    const p = T.seriesPath([pt(WIN.from - step, 1), pt(t0, 500), pt(t0 + step, 0)], { ...WIN, yMax: 100, w: 1000, h: 100 });
    expect(p.drawn).toBe(2);
    expect(p.d).toMatch(/ 0\.0 /);   // 500 → 맨 위(y 0)
    expect(T.seriesPath([pt(t0, 1)], { from: 5, to: 5 })).toEqual({ d: '', dots: [], drawn: 0 });
    expect(T.seriesPath([], WIN).d).toBe('');
  });
  it('피크 계열은 peak 값으로 · 롤업 최대는 max 로', () => {
    const pts = [pt(t0, 10, 90), pt(t0 + step, 10, 95)];
    const a = T.seriesPath(pts, { ...WIN, pick: 'avg', yMax: 100 });
    const b = T.seriesPath(pts, { ...WIN, pick: 'peak', yMax: 100 });
    expect(a.d).not.toBe(b.d);
  });
  it('결측 띠 · 피크 없는 주기 띠 · 시각 ↔ 좌표', () => {
    const bands = T.gapBands([{ from: WIN.from - H, to: WIN.from + 6 * H, reason: 'migrating' }], { ...WIN, w: 1000 });
    expect(bands).toHaveLength(1);
    expect(bands[0].x).toBe(0);
    expect(bands[0].width).toBeCloseTo(250, 3);
    expect(T.gapReasonText('migrating')).toContain('옮기는 중');
    const runs = T.noPeakRuns([pt(t0, 1, 5), pt(t0 + step, 1, null), pt(t0 + 2 * step, 1, null), pt(t0 + 3 * step, null, null), pt(t0 + 4 * step, 1, 3)], { stepMs: step });
    expect(runs).toEqual([{ from: t0 + step, to: t0 + 3 * step }]);
    expect(T.xOf(WIN.from + 12 * H, { ...WIN, w: 1000 })).toBe(500);
    expect(T.xOf(WIN.to + 1, WIN)).toBeNull();
    expect(T.timeAtRatio(0.5, WIN)).toBe(WIN.from + 12 * H);
    expect(T.nearestPoint([pt(t0, 1), pt(t0 + step, 2)], t0 + step - 10).avg).toBe(2);
    expect(T.nearestPoint([], t0)).toBeNull();
  });
  it('서버 toPoints 가 만든 점(롤업 평균 = 합 ÷ 개수, 개수 0 이면 null)을 그대로 그린다', () => {
    const rows = [{ h: t0, cpu_sum: 100, cpu_n: 4, cpu_max: 60, cpu_pct_peak: 90, cpu_pct_peak_at: t0 + 5 }, { h: t0 + H, cpu_sum: null, cpu_n: 0, cpu_max: null }];
    const pts = toPoints(rows, { metric: 'cpu_pct', res: '1h' });
    expect(pts[0]).toMatchObject({ avg: 25, max: 60, peak: 90 });
    expect(pts[1].avg).toBeNull();
    expect(T.seriesPath(pts, { ...WIN, yMax: 100 }).dots).toHaveLength(1);
  });
});

describe('구간 요약 — 공용 seriesStats(결측은 분모에서 뺀다)', () => {
  const step = 300_000;
  const pts = [pt(NOW - 4 * step, 10, 40), pt(NOW - 3 * step, null), pt(NOW - 2 * step, 30, 95), pt(NOW - step, 90, 60)];
  it('평균 · 최대 · 피크(+그 점의 peakAt) · 결측 수', () => {
    const s = T.windowSummary(pts, { peak: true });
    expect(s.avg).toBeCloseTo(43.3, 1);
    expect(s.max).toBe(90);
    expect(s.peak).toBe(95);
    expect(s.peakAt).toBe(NOW - 2 * step - 1000);
    expect(s.missing).toBe(1);
    expect(s.measured).toBe(3);
  });
  it('선택 구간만 · 기준 이상 비율은 응답 baseline.warn 로 · 기준이 없으면 null', () => {
    const s = T.windowSummary(pts, { sel: { from: NOW - 3 * step, to: NOW }, baseline: { warn: 80, bad: 90 }, peak: true });
    expect(s.avg).toBe(60);
    expect(s.overRatio).toBe(50);
    expect(T.windowSummary(pts, { baseline: null }).overRatio).toBeNull();
    expect(T.windowSummary(pts, { peak: false }).peak).toBeNull();
    const e = T.windowSummary([]);
    expect([e.avg, e.max, e.peak, e.overRatio]).toEqual([null, null, null, null]);
  });
  it('피크/평균 · 기준선 글자(설정값만)', () => {
    expect(T.peakRatioText({ peak: 90, avg: 30 })).toBe('3×');
    expect(T.peakRatioText({ peak: 90, avg: 0 })).toBe('—');
    expect(T.peakRatioText({ peak: null, avg: 3 })).toBe('—');
    expect(T.baselineText({ warn: 80, bad: 90 }, '%')).toBe('기준(설정값) 주의 80% · 초과 90%');
    expect(T.baselineText(null, '%')).toBe('');
    expect(T.baselineText({ warn: null, bad: null }, '%')).toBe('');
  });
});

describe('문구 — 피크 출처 · 해상도 · 응답 안내 · 값 글자', () => {
  it('피크 옆 출처는 창 길이까지(줄였으면 그 사실) · 0 이면 꺼짐 · 여럿이면 다 적는다', () => {
    expect(T.peakSrcText(['window10'], 10)).toContain('10초 창');
    expect(T.peakSrcText(['window10'], 5)).toContain('주기 예산으로 줄임');
    expect(T.peakSrcText(['window10'], 0)).toContain('꺼짐');
    expect(T.peakSrcText(['psi'])).toContain('피크 값이 아님');
    expect(T.peakSrcText(['window10', 'none'])).toContain('피크 없음');
    expect(T.peakSrcText([])).toContain('기록 없음');
    expect(T.peakSrcText(['zzz'])).toContain('‘zzz’');
  });
  it('피크 점 — 1초 표본은 펼치지 않는다(샘플러도 아직 없다고 말한다)', () => {
    expect(T.peakPointText('window10', 5)).toContain('5초 창 표본 5개');
    expect(T.peakPointText('window10', 5)).toContain('펼칠 수 없습니다');
    expect(T.peakPointText('sampler')).toContain('지금은 펼칠 표본이 없습니다');
    expect(T.peakPointText('psi')).toContain('피크 값이 아닙니다');
  });
  it('해상도 · 사유 · 전환 안내', () => {
    expect(T.resText({ res: '1h', resReason: 'retention' })).toBe('해상도 1시간(자동) — 그 해상도의 보존 기간 밖이라 한 단계 거친 해상도로 읽었습니다');
    expect(T.resText({ res: '5m', resReason: '' })).toBe('해상도 5분(자동)');
    expect(T.resText({})).toBe('해상도 —');
    expect(T.resHint('1h')).toContain('5분 값의 평균');
    expect(T.resHint('5m')).toContain('1초 창');
    expect(T.resHint(null)).toBe('');
  });
  it('응답 안내 — 엣지 대행 · 점 상한 · 빠진 기간 · 파일 상한 · 옮기는 중', () => {
    const notes = T.trendNotes({ via: 'edge', agent: 'kr-edge', ms: 812.4, truncated: 12, truncatedRows: true, missingPeriods: [{ period: '2026-09' }, { period: '2026-10' }], filesCapped: 2, migration: 'copy-raw', sanitizeTruncated: 3 });
    const all = notes.join('\n');
    expect(all).toContain('**kr-edge**');
    expect(all).toContain('812ms');
    expect(all).toContain('저장하지 않습니다');
    expect(all).toContain('**12개**');
    expect(all).toContain('‘2026-09’ · ‘2026-10’');
    expect(all).toContain('**2개**');
    expect(all).toContain('‘copy-raw’');
    expect(all).toContain('**3개**');
    expect(T.trendNotes({ via: 'local' })).toEqual([]);
    const e = T.trendNotes({ error: 'db-unavailable' }).join('\n');
    expect(e).toContain('일부 구간이 빠졌을 수');
    expect(e).not.toContain('db-unavailable');   // 원문을 싣지 않는다
  });
  it('오류 — 404 는 없거나 범위 밖(구분하지 않는다) · 엣지 실패는 그 사유', () => {
    expect(T.trendErrorText({ status: 404, message: 'x' })).toContain('볼 수 있는 범위 밖');
    expect(T.trendErrorText(null, { ok: false, via: 'edge', agent: 'e1', reason: '엣지 응답 없음' })).toBe('엣지 e1 에서 추이를 읽지 못했습니다: 엣지 응답 없음');
    expect(T.trendErrorText(new Error('boom'))).toBe('추이를 읽지 못했습니다: boom');
  });
  it('값 글자 — 결측은 단위 없이 ‘—’ · 0 은 0', () => {
    for (const u of ['%', 'B/s', 'ms', '건', '/s', 'pages/s', '', 'bit/s']) expect(T.valText(null, u)).toBe('—');
    expect(T.valText('', '%')).toBe('—');
    expect(T.valText(0, '%')).toBe('0%');
    expect(T.valText(12.34, '%')).toBe('12.3%');
    expect(T.valText(212.4, 'ms')).toBe('212ms');
    expect(T.valText(18.04, 'ms')).toBe('18ms');
    expect(T.valText(38512, '/s')).toBe('38.5k/s');
    expect(T.valText(3, '건')).toBe('3건');
    expect(T.valText(2048, 'B/s')).toBe('2.0 KB/s');
    expect(T.valText(1.234, '')).toBe('1.23');
    expect(T.yMaxFor('%', [[1, 2]])).toBe(100);
    expect(T.yMaxFor('ms', [[null, 180]])).toBe(250);
    expect(T.yMaxFor('ms', [[null]])).toBe(1);
  });
});

describe('장치 토글(§12) — 색 고정 · 범례 · 8개 상한 · 파티션', () => {
  const dv = (dev, ord, info) => ({ dev, ord, color: ord - 1, ...(info ? { info } : {}) });
  const devices = {
    disk: [dv('sda', 3), dv('nvme0n1', 1), dv('nvme1n1p1', 4, 'part'), dv('nvme1n1', 2)],
    nic: Array.from({ length: 10 }, (_, i) => dv(`eno${i + 1}`, i + 1)),
    mount: [dv('/', 1)],
  };
  it('색은 서버 순서(color)로만 — 필터해도 바뀌지 않는다 · 6색 다음은 점선', () => {
    const list = T.toggleDevices(devices, 'disk');
    expect(list.map((d) => d.dev)).toEqual(['nvme0n1', 'nvme1n1', 'sda']);
    const only = T.planDevices(list, 'overlay', ['sda']).shown;
    expect(only.map((d) => d.dev)).toEqual(['sda']);
    expect(T.deviceStyle(only[0].color)).toEqual(T.deviceStyle(2));
    expect(T.deviceStyle(0).stroke).toBe(T.DEVICE_PALETTE[0]);
    expect(T.deviceStyle(6)).toEqual({ stroke: T.DEVICE_PALETTE[0], dash: '6 4' });
    expect(T.deviceStyle(0).dash).toBe('');
    for (const c of T.DEVICE_PALETTE) expect(c).toMatch(/^var\(--[a-z0-9-]+\)$/);
  });
  it('파티션은 info=part 만 · 디스크별에서는 뺀다', () => {
    expect(T.toggleDevices(devices, 'part').map((d) => d.dev)).toEqual(['nvme1n1p1']);
    expect(T.toggleDevices(devices, 'disk').some((d) => d.info === 'part')).toBe(false);
    expect(T.toggleDevices(devices, 'all')).toEqual([]);
  });
  it('범례: 누르면 그 장치만 · 다시 누르면 모두 · Shift 는 더하기/빼기', () => {
    const all = T.toggleDevices(devices, 'disk');
    expect(T.legendNext(null, 'sda', { all })).toEqual(['sda']);
    expect(T.legendNext(['sda'], 'sda', { all })).toBeNull();
    expect(T.legendNext(['sda'], 'nvme0n1', { shift: true, all })).toEqual(['sda', 'nvme0n1']);
    expect(T.legendNext(['sda', 'nvme0n1'], 'sda', { shift: true, all })).toEqual(['nvme0n1']);
    expect(T.legendNext(['sda'], 'sda', { shift: true, all })).toBeNull();
    expect(T.legendNext(['sda', 'nvme0n1'], 'nvme1n1', { shift: true, all })).toBeNull();   // 모두 고르면 ‘모두’
    expect(T.legendNext(null, 'sda', { shift: true, all })).toEqual(['nvme0n1', 'nvme1n1']);
  });
  it('8개 초과면 앞 8개 · 남은 수 · 겹침은 행 나눔으로 자동', () => {
    const list = T.toggleDevices(devices, 'nic');
    const p = T.planDevices(list, 'overlay');
    expect(p.shown).toHaveLength(8);
    expect(p.rest).toBe(2);
    expect(p.layout).toBe('rows');
    expect(p.autoRows).toBe(true);
    expect(T.restNote(2)).toContain('2개는 그리지 않았습니다');
    expect(T.restNote(0)).toBe('');
    const small = T.planDevices(list.slice(0, 3), 'overlay');
    expect([small.layout, small.autoRows, small.rest]).toEqual(['overlay', false, 0]);
  });
  it('패널 계획 — 전체는 대표값 · 개별은 장치 계열(행 나눔이면 묶음 첫 행 표시) · 장치가 없으면 빈 행', () => {
    const base = T.panelPlan(T.DEFAULT_TOGGLE, devices);
    expect(base.map((x) => x.id)).toEqual(T.PANEL_ROWS.map((r) => r.id));
    expect(base.every((x) => x.series.length === 1 && x.series[0].kind === 'server')).toBe(true);
    const ov = T.panelPlan({ disk: 'disk', net: 'all', layout: 'overlay' }, devices);
    const disk = ov.find((x) => x.id === 'disk');
    expect(disk.series.map((s) => s.dev)).toEqual(['nvme0n1', 'nvme1n1', 'sda']);
    expect(disk.series.every((s) => s.kind === 'disk' && s.metric === 'busy_pct')).toBe(true);
    expect(disk.legend).toBe(true);
    const rows = T.panelPlan({ disk: 'all', net: 'nic', layout: 'overlay' }, devices);
    const netRows = rows.filter((x) => x.row.id === 'net');
    expect(netRows).toHaveLength(8);
    expect(netRows.filter((x) => x.firstOfGroup)).toHaveLength(1);
    expect(netRows[0].series[0]).toMatchObject({ kind: 'nic', metric: 'util_pct', dev: 'eno1' });
    const empty = T.panelPlan({ disk: 'part', net: 'all', layout: 'overlay' }, { disk: [], nic: [] });
    expect(empty.find((x) => x.id === 'disk').empty).toBe(true);
    expect(T.DEVICE_EMPTY_TEXT.part).toContain('파티션 I/O');
    const lg = T.panelPlan({ disk: 'disk', net: 'all', layout: 'overlay' }, devices, { disk: ['sda'] });
    expect(lg.find((x) => x.id === 'disk').series.map((s) => s.dev)).toEqual(['sda']);
    // 범례로 하나만 골라도 그 장치의 색은 그대로(서버 순서 color 2 — 고른 목록의 첫째라서 0 이 되면 안 된다)
    expect(lg.find((x) => x.id === 'disk').series[0].color).toBe(T.deviceStyle(2).stroke);
    expect(lg.find((x) => x.id === 'disk').series[0].color).not.toBe(T.deviceStyle(0).stroke);
  });
  it('계열 키 · 이름', () => {
    expect(T.seriesKey({ kind: 'disk', metric: 'busy_pct', dev: 'sda' })).toBe('disk|busy_pct|sda');
    expect(T.seriesKey({ metric: 'cpu_pct' })).toBe('server|cpu_pct|');
    expect(T.seriesLabel({ kind: 'nic', metric: 'util_pct', dev: 'eno1' })).toBe('사용률 — eno1');
    expect(T.metricInfo('server', 'nope').label).toBe('nope');
  });
});

describe('구간 이동 — 공용 코어(vmPerfText windowSpan · backForSpan)', () => {
  it('windowSpan · backForSpan 은 기존 windowOf · backForEnd 와 같은 값', () => {
    for (const r of VP.RANGES) {
      expect(VP.windowSpan(NOW, 3, r.ms)).toEqual(VP.windowOf(NOW, 3, r.k));
      expect(VP.backForSpan(NOW, NOW - 2 * r.ms, r.ms, 10)).toBe(VP.backForEnd(NOW, NOW - 2 * r.ms, r.k, 10));
    }
    expect(VP.windowSpan(NOW, 2, 6 * H)).toEqual({ start: NOW - 18 * H, end: NOW - 12 * H });
    expect(VP.backForSpan(NOW, NOW - 50 * H, 6 * H, 4)).toBe(4);
  });
  it('뒤로 갈 칸 — 보존(일)을 알 때만 · 모르면 null(슬라이더 없음)', () => {
    expect(T.trendMaxBack(24 * H, 1825)).toBe(1824);
    expect(T.trendMaxBack(30 * 24 * H, 90)).toBe(2);
    expect(T.trendMaxBack(24 * H, null)).toBeNull();
    expect(T.trendMaxBack(24 * H, 0)).toBeNull();
  });
  it('보존(일)은 이 노드 설정에서 상세로 넘기고 · 엣지 위임 항목에는 넘기지 않는다(배선)', () => {
    expect(fs.readFileSync(path.join(HERE, 'BmUsage.jsx'), 'utf8')).toMatch(/<BmPerfDetail[\s\S]{0,400}keepDays=\{\{ server: data\?\.settings\?\.dailyRetentionDays \?\? null, dev: data\?\.settings\?\.store\?\.devHourlyDays \?\? null \}\}/);
    expect(fs.readFileSync(path.join(HERE, 'BmPerfDetail.jsx'), 'utf8')).toMatch(/keepDays=\{item\?\.agent \? null : keepDays\}/);
  });
  it('화면 파일은 창 계산을 따로 두지 않는다(공용 코어를 import)', () => {
    for (const f of ['BmTrendTab.jsx', 'BmTrendPopup.jsx', 'BmTrendChart.jsx', 'bmTrendText.js', 'bmTrendLoad.js']) {
      const src = fs.readFileSync(path.join(HERE, f), 'utf8');
      expect(src).not.toMatch(/function\s+(windowOf|windowSpan|backForEnd|backForSpan|dateJumpEnd|dateInputOf|seriesStats|gapsOf|pickRes|normalizeWindow)\b/);
    }
    expect(fs.readFileSync(path.join(HERE, 'BmTrendPopup.jsx'), 'utf8')).toMatch(/import \{[^}]*windowSpan[^}]*\} from '..\/..\/components\/vmperf\/vmPerfText\.js'/);
  });
});

describe('CSV — 토글 상태대로 그린 계열 · 결측은 빈 칸', () => {
  it('머리글 · 시각 정렬 · 피크 열은 피크 있는 계열만', () => {
    const csv = T.trendCsv([
      { label: 'CPU 사용률', unit: '%', peak: true, points: [pt(NOW, 10, 50), pt(NOW - H, null, null)] },
      { label: '디스크 busy — sda', unit: '%', peak: false, points: [pt(NOW, 3)] },
    ]);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('time,CPU 사용률 평균(%),CPU 사용률 피크(%),디스크 busy — sda 평균(%)');
    expect(lines[1]).toBe(`${new Date(NOW - H).toISOString()},,,`);
    expect(lines[2]).toBe(`${new Date(NOW).toISOString()},10,50,3`);
    expect(T.trendCsvName('bm/kr db', '24h', NOW)).toMatch(/^bm-trend_bm_kr_db_24h_\d{4}-\d{2}-\d{2}\.csv$/);
  });
});

describe('CVP 스위치 포트(§10) — 서버 code 를 문장으로만', () => {
  it('상태 5종 + 확정 · 모르는 상태는 code 그대로', () => {
    expect(T.portStateView('candidate').label).toContain('확인 필요');
    expect(T.portStateView('no-cvp').body).toContain('‘—’');
    expect(T.portStateView('no-counters').body).toContain('빈 응답');
    expect(T.portStateView('no-permission').label).toBe('권한 없음');
    const u = T.portStateView('denied');
    expect(u.label).toBe('상태 ‘denied’');
    expect(u.tone).toBe('idle');
  });
  it('대조 ⑤ — 서버 compareTraffic 결과를 그대로 문장으로(후보로만) · 창 불일치 사유 · 값 없음 사유', () => {
    const at = NOW;
    const ok = compareTraffic({ server: { txBps: 1e8, rxBps: 2e8, at, spanMs: 3e5 }, port: { in_bps: 8e8, out_bps: 16e8, rate_ts: at, spanMs: 3e5 } });
    expect(T.compareView(ok).label).toBe('일치');
    const mm = compareTraffic({ server: { txBps: 1e8, rxBps: 2e8, at, spanMs: 3e5 }, port: { in_bps: 6e8, out_bps: 16e8, rate_ts: at, spanMs: 3e5 } });
    expect(mm.verdict).toBe('mismatch');
    expect(T.compareView(mm).body).toContain('**후보**');
    const wm = compareTraffic({ server: { txBps: 1e8, rxBps: 1e8, at, spanMs: 3e5 }, port: { in_bps: 8e8, out_bps: 8e8, rate_ts: at - 6e5, spanMs: 3e5 } });
    expect(wm.verdict).toBe('window-mismatch');
    expect(T.compareView(wm).body).toContain(wm.reason);
    expect(T.compareView({ verdict: 'no-data', reason: 'window-unknown' }).body).toContain('계측 창을 모름');
    expect(T.compareView(null)).toBeNull();
    expect(T.pairText(ok.tx)).toContain('차이 0%');
    expect(T.pairText({ server: 1, port: 2, diffPct: 0, idle: true })).toContain('거의 0');
    expect(T.pairText(null)).toBe('—');
  });
  it('매핑 출처 4 — 개수는 응답에서 센다 · LLDP/MAC 는 만들지 않았다고', () => {
    const resp = { notBuilt: ['lldp', 'mac'], nics: [{ nic: 'eno1', mapping: { cvpId: 'c' } }, { nic: 'eno2', mapping: null }], candidates: [{}, {}] };
    const rows = T.mapSourceRows(resp);
    expect(rows).toHaveLength(4);
    expect(rows[0].state).toBe('수집 중 · 확정 1개');
    expect(rows[1].state).toBe('수집 중 · 후보 2개');
    expect(rows[2].state).toContain('만들지 않음');
    expect(rows[3].state).toContain('만들지 않음');
    expect(T.portStateCounts({ nics: [{ state: 'mapped' }, { state: 'mapped' }, { state: 'stale' }] })).toEqual({ mapped: 2, stale: 1 });
  });
  it('범위 계정 — 다른 법인 CVP 매핑은 숨긴 수만 말한다 · CVP 미등록은 ‘—’ 이지 0 이 아니다', () => {
    const n1 = T.portNotes({ cvpRegistered: true, hiddenOutOfScope: 2 }).join('\n');
    expect(n1).toContain('**2개**');
    expect(n1).toContain('범위 계정은 자기 법인 CVP 포트만');
    expect(T.portNotes({ cvpRegistered: false }).join('\n')).toContain('0 이 아닙니다');
    expect(T.portNotes({ nicError: '엣지 응답 없음' }).join('\n')).toContain('엣지 응답 없음');
    expect(T.portNotes({ cvpAccess: false, reason: 'CVP 도구가 꺼진 역할' }).join('\n')).toContain('권한이 없어');
  });
});

describe('조회기 — 동시 4 · 같은 계열 한 번 · 늦은 이전 창 응답 버림', () => {
  const defer = () => { let res; let rej; const p = new Promise((a, b) => { res = a; rej = b; }); return { p, res, rej }; };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  it('동시 요청은 4개를 넘지 않고 · 같은 계열은 다시 부르지 않는다', async () => {
    let active = 0; let peak = 0; const calls = []; const ds = [];
    const loader = createTrendLoader((spec) => { calls.push(spec.metric); active += 1; peak = Math.max(peak, active); const d = defer(); ds.push(d); return d.p.finally(() => { active -= 1; }); });
    loader.setWindow('w1');
    const got = {};
    const specs = Array.from({ length: 10 }, (_, i) => ({ kind: 'server', metric: `m${i}` }));
    loader.request(specs, WIN, (k, v) => { got[k] = v.status; });
    loader.request(specs.slice(0, 3), WIN, (k, v) => { got[k] = v.status; });
    await flush();
    expect(calls).toHaveLength(4);
    while (ds.some((d) => !d.done)) { for (const d of ds) if (!d.done) { d.done = true; d.res({ ok: true, points: [] }); } await flush(); await flush(); }
    expect(peak).toBe(4);
    expect(calls).toHaveLength(10);
    expect(Object.values(got).every((s) => s === 'ok')).toBe(true);
    const again = []; loader.request([specs[0]], WIN, (k, v) => again.push(v.status));
    expect(again).toEqual(['ok']);
    expect(calls).toHaveLength(10);
  });
  it('창이 바뀌면 이전 창 응답은 버린다 · ok:false 는 fail · 던지면 error', async () => {
    const ds = {};
    const loader = createTrendLoader((spec, win) => { const d = defer(); ds[`${win.from}|${spec.metric}`] = d; return d.p; });
    const seen = [];
    loader.setWindow('a');
    loader.request([{ metric: 'cpu_pct' }], { from: 1, to: 2 }, (k, v) => seen.push(['a', v.status]));
    await flush();
    loader.setWindow('b');
    loader.request([{ metric: 'cpu_pct' }, { metric: 'mem_pct' }, { metric: 'net_pct' }], { from: 3, to: 4 }, (k, v) => seen.push(['b', k, v.status]));
    await flush();
    ds['1|cpu_pct'].res({ ok: true, points: [] });
    ds['3|cpu_pct'].res({ ok: true, points: [] });
    ds['3|mem_pct'].res({ ok: false, reason: '엣지' });
    ds['3|net_pct'].rej(Object.assign(new Error('x'), { status: 500 }));
    await flush(); await flush();
    expect(seen.filter((x) => x[0] === 'a' && x[1] !== 'loading')).toEqual([]);
    expect(seen).toContainEqual(['b', 'server|cpu_pct|', 'ok']);
    expect(seen).toContainEqual(['b', 'server|mem_pct|', 'fail']);
    expect(seen).toContainEqual(['b', 'server|net_pct|', 'error']);
  });
  it('기본 조회 경로 — 키는 인코딩 · 장치 · 창을 쿼리로', async () => {
    vi.resetModules();
    const calls = [];
    vi.doMock('../../api.js', () => ({ fetchJson: (p, q) => { calls.push([p, q]); return Promise.resolve({ ok: true }); } }));
    const { trendFetcher } = await import('./bmTrendLoad.js');
    await trendFetcher('a/b c')({ kind: 'disk', metric: 'busy_pct', dev: 'sda' }, { from: 10.7, to: 20.2 });
    expect(calls[0][0]).toBe('/tools/bm-usage/perf/a%2Fb%20c/history');
    expect(calls[0][1]).toEqual({ kind: 'disk', metric: 'busy_pct', dev: 'sda', from: 10, to: 20 });
    vi.doUnmock('../../api.js');
  });
});

describe('렌더 스모크(SSR) · 빈 데이터 · 범위 계정', () => {
  it('서버 상세 탭 열에 ‘추이(평균 · 피크)’ 가 있고 그 탭을 고르면 추이 탭을 그린다', () => {
    expect(DETAIL_TABS.map((x) => x.id)).toContain('trend');
    const entry = { key: 'K1', ts: NOW, coverage: 'both', verdict: 'ok', line: '정상', codes: {}, perResource: {}, cross: [], detail: { disks: [], nics: [] } };
    const html = renderToStaticMarkup(<BmPerfDetailView itemKey="K1" resp={{ ok: true, key: 'K1', entry, target: { name: 'bm-kr1-db01' } }} tab="trend" now={NOW} />);
    expect(html).toContain('① 평균');
    expect(html).toContain('② 피크');
    expect(html).toContain('장치별 보기');
    expect(html).toContain('스위치 포트 연동');
    expect(html).not.toContain('`');
  });
  it('추이 탭 — 첫 그림(응답 전): 컨트롤 · 토글 · 9행 × 2 패널 · 불러오는 중', () => {
    const html = renderToStaticMarkup(<BmTrendTab itemKey="K1" name="srv" narrowOverride={false} />);
    for (const s of ['6시간', '24시간', '7일', '30일', '평균+피크', '커서 동기', '디스크 행', '네트워크 행', '평균 · 피크 패널에 같이 적용', '추천 지표 불러오기']) expect(html).toContain(s);
    expect((html.match(/class="bmt-row"/g) || []).length).toBe(T.PANEL_ROWS.length * 2);
    expect(html).toContain('불러오는 중');
    expect(html).toContain('소켓 메모리');
  });
  it('행 — 값이 없으면 0 으로 그리지 않고 문구 · 값이 있으면 경로와 기준선', () => {
    const empty = renderToStaticMarkup(<TrendRow title="CPU" series={[]} win={WIN} yMax={100} message="이 구간에 값이 없습니다 — 0 으로 그리지 않습니다" />);
    expect(empty).toContain('0 으로 그리지 않습니다');
    expect(empty).not.toMatch(/<path d="M/);
    const step = 300_000;
    const pts = [pt(NOW - 3 * step, 10, 40), pt(NOW - 2 * step, 20, 60), pt(NOW - step, null)];
    const full = renderToStaticMarkup(<TrendRow title="CPU" series={[{ points: pts, pick: 'avg', color: 'var(--accent)' }, { points: pts, pick: 'peak', color: 'var(--red)' }]} win={WIN} yMax={100} baseline={{ warn: 80, bad: 90 }} gaps={[{ from: WIN.from, to: NOW - 3 * step, reason: 'no-data' }]} />);
    expect((full.match(/<path d="M/g) || []).length).toBe(2);
    expect(full).toContain('stroke="var(--amber)"');
    expect(full).toContain('결측 — 값 없음');
    const sp = renderToStaticMarkup(<Spark points={pts} win={WIN} peak onOpen={() => {}} label="x" />);
    expect(sp).toContain('크게 보기');
  });
  it('확대 팝업 — 대화상자 · Esc 안내 · 400 은 전체 화면 · 보존을 모르면 슬라이더 없음(엣지 위임)', () => {
    const init = { kind: 'disk', metric: 'await_ms', dev: 'nvme1n1', rangeK: '24h', show: 'both' };
    const h = renderToStaticMarkup(<BmTrendPopup itemKey="K1" init={init} devices={{ disk: [{ dev: 'nvme1n1', ord: 1, color: 0 }] }} keepDays={null} onClose={() => {}} narrowOverride={false} />);
    expect(h).toContain('role="dialog"');
    expect(h).toContain('aria-modal="true"');
    expect(h).toContain('닫기(Esc)');
    expect(h).toContain('nvme1n1 · await');
    expect(h).toContain('슬라이더를 두지 않았습니다');
    expect(h).not.toContain('type="range"');
    expect(h).not.toContain('bmt-pop full');
    const n = renderToStaticMarkup(<BmTrendPopup itemKey="K1" init={{ kind: 'server', metric: 'cpu_pct', rangeK: '24h' }} keepDays={{ server: 1825, dev: 90 }} onClose={() => {}} narrowOverride />);
    expect(n).toContain('bmt-pop full');
    expect(n).toContain('type="range"');
    expect(n).toContain('뒤로 1824칸까지');
    expect(n).not.toContain('⤢ 전체 화면');   // 400 은 이미 전체 화면
    // Esc 닫기 — 공용 EscClose(중첩 모달은 최상단만)를 onClose 로 단다(SSR 은 효과를 돌리지 않아 소스로 고정 · 동작은 Chromium 확인)
    expect(fs.readFileSync(path.join(HERE, 'BmTrendPopup.jsx'), 'utf8')).toMatch(/<EscClose onClose=\{onClose\} \/>/);
  });
  it('요약 표 열 정렬 — ‘—’ 는 오름 · 내림 모두 뒤(실제 sortChildren)', () => {
    const rows = [5, null, 1].map((v, i) => <tr key={i}><td data-sort={`m${i}`}>m{i}</td><td className="right" data-sort={v ?? ''}>{T.valText(v, '%')}</td></tr>);
    const val = (kids) => kids.map((r) => r.props.children[1].props.children);
    expect(val(sortChildren(rows, 1, 'asc'))).toEqual(['1%', '5%', '—']);
    expect(val(sortChildren(rows, 1, 'desc'))).toEqual(['5%', '1%', '—']);
  });
});

describe('문구 규약 — 소스 스윕', () => {
  const strings = () => {
    const out = [];
    const walk = (v) => { if (typeof v === 'string') out.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
    walk([T.SERVER_METRIC_INFO, T.DEVICE_METRIC_INFO, T.PANEL_ROWS, T.SOCKET_NOTE, T.SOURCE_TAGS, T.RECO_TILES, T.RES_REASON_TEXT, T.PEAK_SRC_TEXT, T.GAP_REASON_TEXT,
      T.PORT_STATE_INFO, T.COMPARE_INFO, T.DEVICE_EMPTY_TEXT, T.DISK_MODES, T.NET_MODES, T.LAYOUTS, T.SHOW_MODES, T.TREND_RANGES]);
    return out;
  };
  it('문구에 백틱이 없다(BoldText 는 **강조** 만)', () => {
    for (const s of strings()) expect(s.includes('`')).toBe(false);
  });
  it('화면 파일 — text-transform · 폴링(setInterval) · 새 hex 색 · 날 select 가 없다', () => {
    for (const f of ['BmTrendTab.jsx', 'BmTrendPopup.jsx', 'BmTrendChart.jsx', 'bmTrendText.js', 'bmTrendLoad.js', 'bmTrend.css']) {
      const src = fs.readFileSync(path.join(HERE, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(src).not.toMatch(/text-?transform/i);
      expect(src).not.toMatch(/setInterval\(/);
      expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src).not.toMatch(new RegExp(`<${'sel'}ect[\\s>]`));   // 날 드롭다운 금지(공용 Select) — 이 줄 자체가 스윕에 걸리지 않게 나눠 쓴다
    }
  });
  it('문구 모듈은 판정하지 않는다 — 기준선 값과 비교 연산을 쓰지 않는다(요약은 공용 seriesStats 가 센다)', () => {
    const src = fs.readFileSync(path.join(HERE, 'bmTrendText.js'), 'utf8');
    expect(src).not.toMatch(/\.(warn|bad)\)?\s*[<>]=?|[<>]=?\s*[\w.()]*\.(warn|bad)\b/);
    expect(src).not.toMatch(/(utilWarn|utilBad|runqWarn|runqBad|queueWarn|queueBad|retransWarn|retransBad)/);
  });
  it('훅은 조기 return 위(추이 탭 · 팝업)', () => {
    for (const f of ['BmTrendTab.jsx', 'BmTrendPopup.jsx']) {
      const src = fs.readFileSync(path.join(HERE, f), 'utf8');
      const body = src.slice(src.indexOf('export default function'));
      const ret = body.search(/\n\s+if \(![^)]*\) return null;/);
      expect(ret).toBeGreaterThan(0);
      expect(body.slice(ret)).not.toMatch(/\buse(State|Effect|Memo|Ref|Callback)\(/);
    }
  });
});
