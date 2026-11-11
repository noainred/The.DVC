/**
 * 집중 모니터링(v2.976) 화면 문구 · 차트 좌표 — 순수 함수 회귀.
 *  · 못 읽은 값(null · '' · undefined)은 0 이 아니라 '—'(단위 없음) · 선은 끊는다.
 *  · 서버가 보내는 수집 상태 이름(central/focusMonEdge.js STATES)과 화면 문구(STATE_TEXT)가 1:1.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  DASH, STATE_TEXT, STATE_KEYS, pctText, msText, bpsText, bytesText, iostatText, metricValueText, remainText, etText,
  levelOf, awaitLevel, cardBadge, sessionPill, installCommand, shouldStopPolling, IOSTAT_LABEL, SUMMARY_COLS, TABS,
} from './focusMonText.js';
import { niceMax, yScale, linePath, areaPath, stackedAreas, spreadLabels, heatColor, HEAT_EMPTY, cellShade, seriesMax, indexAt } from './focusMonChart.js';

const SETTINGS = { warnPct: 80, critPct: 90, wAwaitWarnMs: 20 };

describe('수집 상태 이름 — 서버와 1:1', () => {
  it('central/focusMonEdge.js STATES 와 STATE_TEXT 키가 같다', () => {
    const src = fs.readFileSync(new URL('../../../../server/src/central/focusMonEdge.js', import.meta.url), 'utf8');
    const m = src.match(/const STATES = new Set\(\[([^\]]+)\]\)/);
    expect(m).toBeTruthy();
    const server = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    expect([...STATE_KEYS].sort()).toEqual(server);
    for (const k of STATE_KEYS) expect(['ok', 'warn', 'crit', 'off']).toContain(STATE_TEXT[k].tone);
  });
  it('iostat 열 이름 · 요약 열은 서버 IOSTAT_COLS 안에 있다', () => {
    const src = fs.readFileSync(new URL('../../../../server/src/focusmon/rates.js', import.meta.url), 'utf8');
    const m = src.match(/export const IOSTAT_COLS = Object\.freeze\(\[([^\]]+)\]\)/) || src.match(/export const IOSTAT_COLS = \[([^\]]+)\]/);
    expect(m).toBeTruthy();
    const cols = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect(cols.length).toBe(13);
    expect(Object.keys(IOSTAT_LABEL).sort()).toEqual([...cols].sort());
    for (const c of SUMMARY_COLS) expect(cols).toContain(c);
  });
});

describe('값 문구 — 못 읽은 값은 0 이 아니다', () => {
  it('null · 빈 문자열 · undefined 는 단위 없이 —', () => {
    for (const v of [null, undefined, '', 'x']) {
      expect(pctText(v)).toBe(DASH); expect(msText(v)).toBe(DASH); expect(bpsText(v)).toBe(DASH);
      expect(bytesText(v)).toBe(DASH); expect(iostatText('wAwait', v)).toBe(DASH); expect(remainText(v)).toBe(DASH); expect(etText(v)).toBe(DASH);
    }
    expect(pctText(0)).toBe('0%');
    expect(iostatText('util', 0)).toBe('0%');
    expect(iostatText('wAwait', 0)).toBe('0.00');
  });
  it('단위 · 자릿수', () => {
    expect(bpsText(8_454_275_262)).toBe('8.5 Gb/s');
    expect(bpsText(299_000_000)).toBe('299 Mb/s');
    expect(bytesText(274_877_906_944)).toBe('256 GB');
    expect(msText(3076.4)).toBe('3,076 ms');
    expect(msText(7.81)).toBe('7.8 ms');
    expect(metricValueText('disk', 'util', 31.2)).toBe('31%');
    expect(metricValueText('net', 'rx', 1e9)).toBe('1.0 Gb/s');
    expect(remainText(14 * 60_000 + 10_000)).toBe('14:10');
    expect(etText(111_600)).toBe('1일 07:00');
    expect(etText(3600)).toBe('01:00:00');
  });
});

describe('판정 · 배지', () => {
  it('임계 — 경계값 포함 · 결측은 판정 없음', () => {
    expect(levelOf(79.9, SETTINGS)).toBe(''); expect(levelOf(80, SETTINGS)).toBe('warn'); expect(levelOf(90, SETTINGS)).toBe('crit');
    expect(levelOf(null, SETTINGS)).toBe(''); expect(levelOf(95, null)).toBe('');
    expect(awaitLevel(20, SETTINGS)).toBe('warn'); expect(awaitLevel(null, SETTINGS)).toBe('');
  });
  it('카드 배지 — 정상 아님 > 지연 > 값 없음 > 응답 없는 디스크 > 가장 높은 지표', () => {
    expect(cardBadge({ status: { state: 'auth' } }, { cpu: 99 }, SETTINGS)).toEqual({ label: '키 로그인 거부', tone: 'warn' });
    expect(cardBadge({ status: { state: 'ok', stale: true } }, { cpu: 99 }, SETTINGS).label).toBe('지연');
    expect(cardBadge({ status: null }, null, SETTINGS)).toEqual({ label: '값 없음', tone: 'off' });
    expect(cardBadge({ status: { state: 'ok' } }, { stuck: true, cpu: 10 }, SETTINGS).tone).toBe('crit');
    expect(cardBadge({ status: { state: 'ok' } }, { cpu: 40, mem: 88, net: 82, disk: 89 }, SETTINGS)).toEqual({ label: '주의 · 디스크', tone: 'warn' });
    expect(cardBadge({ status: { state: 'ok' } }, { cpu: 40, mem: 50 }, SETTINGS)).toBeNull();
  });
  it('수집 알약 · 폴링 중단', () => {
    expect(sessionPill(null, 0).live).toBe(false);
    const p = sessionPill({ mode: 'watch', until: 70_000, targets: [1, 2], interval: 2 }, 10_000);
    expect(p).toMatchObject({ live: true, text: '수집 중', remain: '01:00' });
    expect(shouldStopPolling({ status: 403 })).toBe(true); expect(shouldStopPolling({ status: 404 })).toBe(true);
    expect(shouldStopPolling({ status: 500 })).toBe(false); expect(shouldStopPolling(null)).toBe(false);
  });
  it('탭 키는 주소 조각 — 바꾸지 않는다', () => {
    expect(TABS.map((t) => t.key)).toEqual(['overview', 'compare', 'procs', 'targets']);
  });
});

describe('설치 명령', () => {
  it('계정 이름이 셸 안전하지 않으면 예시 계정으로 · 키가 없으면 빈 글', () => {
    expect(installCommand('', 'dvcmon')).toBe('');
    const c = installCommand('ssh-ed25519 AAAA test', 'a;rm -rf /');
    expect(c).not.toMatch(/rm -rf/);
    expect(c).toMatch(/useradd -m dvcmon/);
    expect(installCommand('ssh-ed25519 AAAA test', 'svc.mon')).toMatch(/~svc\.mon\/\.ssh/);
  });
});

describe('차트 좌표', () => {
  it('niceMax · yScale', () => {
    expect(niceMax(3076)).toBe(5000); expect(niceMax(24.2)).toBe(25); expect(niceMax(null)).toBe(1); expect(niceMax(0)).toBe(1);
    const y = yScale({ max: 100, top: 0, bottom: 100 });
    expect(y(0)).toBe(100); expect(y(100)).toBe(0); expect(y(150)).toBe(0);
    const yl = yScale({ max: 1000, log: true, top: 0, bottom: 100 });
    expect(yl(0)).toBe(100); expect(Math.round(yl(1000))).toBe(0); expect(yl(10)).toBeLessThan(80);
  });
  it('null 은 선 · 면을 끊는다(0 으로 그리지 않는다)', () => {
    const y = (v) => 100 - v;
    const d = linePath([1, 2, null, 4, 5], { x0: 0, x1: 4, y });
    expect(d.match(/M/g).length).toBe(2);
    expect(d).not.toMatch(/ 100\.0/);
    expect(linePath([], { x0: 0, x1: 1, y })).toBe('');
    expect(areaPath([1, null, 3], { x0: 0, x1: 2, y, base: 100 })).toBe('');
    expect(areaPath([1, 2, null], { x0: 0, x1: 2, y, base: 100 })).toMatch(/Z$/);
  });
  it('쌓은 면 — 한 층이라도 결측인 칸은 모든 층에서 끊는다', () => {
    const y = (v) => 100 - v;
    const [a, b] = stackedAreas([[10, 10, 10], [5, null, 5]], { x0: 0, x1: 2, y });
    expect(a).toBe(''); expect(b).toBe('');
    const [c, d] = stackedAreas([[10, 10], [5, 5]], { x0: 0, x1: 1, y });
    expect(c).toMatch(/^M0\.0 90\.0/); expect(d).toMatch(/^M0\.0 85\.0/);
  });
  it('끝 이름표 · 색 · 칸', () => {
    expect(spreadLabels([{ key: 'a', y: 10 }, { key: 'b', y: 12 }, { key: 'c', y: null }])).toEqual({ a: 10, b: 26 });
    expect(heatColor(null, 10)).toBe(HEAT_EMPTY);
    expect(heatColor(10, 10)).not.toBe(heatColor(0, 10));
    expect(cellShade(null, 10)).toBe(''); expect(cellShade(0, 10)).toBe(''); expect(cellShade(5, 10)).toMatch(/^rgba/);
    expect(seriesMax([[1, null, 3], null, ['', 2]])).toBe(3); expect(seriesMax([[null]])).toBeNull();
    expect(indexAt(50, { x0: 0, x1: 100, count: 3 })).toBe(1); expect(indexAt(-60, { x0: 0, x1: 100, count: 3 })).toBeNull();
  });
});
