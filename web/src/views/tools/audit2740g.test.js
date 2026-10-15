// v2.740 점검 그룹 g — 화면 정직성 3건(축 F 재확인분).
//  F-01 IP 스캔 '에이전트별 대역·보고 현황' — 실패·시한 초과(미완료)·건너뜀도 `at` 이 90분 안이면 초록 '정상' 이었다.
//  F-02 스토리지 증가량 합계·그룹 행 증가율(%) — 분모가 '사용량을 읽은 전 장비' 라 증가량을 못 잰 장비가 섞이면 과소였다.
//  F-09 진단 › 서버 메모리 — /admin/memtrack 403 을 catch{} 로 삼켜 '불러오는 중…' 이 영원히 보이고 60초 폴링이 계속됐다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { reportState, agentReportRows, reportKpis, REPORT_STATE_TEXT, REPORT_STATE_TITLE, REPORT_STATE_TONE, reportStateNote, reportStateDetail, REPORT_STALE_MS } from './scanRangeImportText.js';
import { aggregateGrowth, growthPct, aggregateGrowthPct, totalCell } from './storageGrowthText.js';
import { createMemPoller, MemPlaceholder } from '../Diagnostics.jsx';
import { stripComments } from '../../test/_stripComments.js';
import { HttpError } from '../../api.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = 1_800_000_000_000;
const src = (f) => fs.readFileSync(path.resolve(HERE, f), 'utf8');

/* ── F-01 ─────────────────────────────────────────────────────────────── */
describe('F-01 IP 스캔 보고 상태 — 실패·미완료·건너뜀은 정상이 아니다', () => {
  const LOCAL = { name: '__local__', enabled: true };
  const ROW = { agent: '__local__', valid: true, size: 254 };

  it('재현 — 이 포탈 lastRun 이 시한 초과 실패면 미완료(fail), KPI 정상 0', () => {
    const lastRun = { at: NOW - 60_000, error: 'SCAN_DEADLINE: 스캔 시한 초과', manual: false, incomplete: true, code: 'SCAN_DEADLINE', durationMs: 900_000, partialAlive: 3, done: 120, total: 254 };
    const rows = agentReportRows({ agents: [LOCAL], rows: [ROW], reports: {}, localLast: lastRun, now: NOW });
    expect(rows[0].state).toBe('fail');
    // 시도 시각을 '마지막 보고(완료)' 로 쓰지 않는다 — 완료된 적이 없다
    expect(rows[0].at).toBeNull();
    expect(rows[0].failAt).toBe(NOW - 60_000);
    expect(rows[0].alive).toBeNull(); // 부분 결과(partialAlive)를 응답 수로 세지 않는다
    const k = reportKpis(rows);
    expect(k).toMatchObject({ total: 1, ok: 0, fail: 1 });
    expect(reportStateNote(rows[0])).toContain('시한 초과');
    expect(reportStateDetail(rows[0])).toContain('120/254');
  });

  it('직전 완료 뒤 실패 — 마지막 보고는 완료 시각 그대로, 상태는 미완료 · 연속 횟수는 서버 기록에서', () => {
    const reports = { __local__: { at: NOW - 40 * 60_000, scanned: 254, alive: 31, incomplete: { at: NOW - 60_000, since: NOW - 30 * 60_000, streak: 2, code: 'SCAN_DEADLINE', reason: '시한' } } };
    const lastRun = { at: NOW - 60_000, error: '시한', incomplete: true, code: 'SCAN_DEADLINE' };
    const [x] = agentReportRows({ agents: [LOCAL], rows: [ROW], reports, localLast: lastRun, now: NOW });
    expect(x.state).toBe('fail');
    expect(x.at).toBe(NOW - 40 * 60_000);
    expect(x.alive).toBe(31);
    expect(reportStateNote(x)).toContain('연속 2회');
  });

  it('건너뜀(대역 없음)은 보고로 세지 않는다 — 정상이 아니라 건너뜀', () => {
    const rows = agentReportRows({ agents: [LOCAL], rows: [ROW], reports: {}, localLast: { at: NOW - 1000, skipped: '대역 없음' }, now: NOW });
    expect(rows[0].state).toBe('skip');
    expect(rows[0].at).toBeNull();
    expect(reportStateNote(rows[0])).toContain('대역 없음');
    // 완료 보고 뒤의 건너뜀도 건너뜀 — '정상' 으로 보지 않는다
    const r2 = agentReportRows({ agents: [LOCAL], rows: [ROW], reports: { __local__: { at: NOW - 30 * 60_000, scanned: 10, alive: 2 } }, localLast: { at: NOW - 1000, skipped: '대역 없음' }, now: NOW });
    expect(r2[0].state).toBe('skip');
    expect(r2[0].at).toBe(NOW - 30 * 60_000);
  });

  it('엣지 — reports[name].incomplete 가 마지막 완료보다 같거나 늦으면 미완료(서버 completionOf 와 같은 규칙)', () => {
    const reports = {
      'Edge-A': { at: NOW - 10 * 60_000, scanned: 100, alive: 9, incomplete: { at: NOW - 60_000, since: NOW - 3 * 3_600_000, streak: 5, code: 'error', reason: 'ECONNRESET' } },
      'Edge-B': { at: NOW - 10 * 60_000, scanned: 100, alive: 9, incomplete: { at: NOW - 20 * 60_000, streak: 1, code: 'SCAN_DEADLINE' } }, // 그 뒤 완료 — 정상
      'Edge-C': { at: null, scanned: null, alive: null, incomplete: { at: NOW - 60_000, streak: 1, code: 'SCAN_DEADLINE' } }, // 완료한 적 없음
      'Edge-D': { at: NOW - 3 * REPORT_STALE_MS, incomplete: { at: NOW - 3 * REPORT_STALE_MS, streak: 9, code: 'SCAN_DEADLINE' } }, // 같은 시각 = 미완료(늦음보다 먼저)
    };
    const list = agentReportRows({ agents: [], rows: [], reports, now: NOW });
    const by = Object.fromEntries(list.map((x) => [x.name, x.state]));
    expect(by).toEqual({ 'Edge-A': 'fail', 'Edge-B': 'ok', 'Edge-C': 'fail', 'Edge-D': 'fail' });
    expect(reportStateNote(list.find((x) => x.name === 'Edge-A'))).toContain('연속 5회');
    expect(reportStateDetail(list.find((x) => x.name === 'Edge-A'))).toContain('ECONNRESET');
  });

  it('reportState — 꺼짐이 먼저 · 실패 > 건너뜀 > 예전 판정(호출 호환)', () => {
    expect(reportState({ enabled: false, at: null, ranges: 1, failAt: NOW }, NOW)).toBe('off');
    expect(reportState({ enabled: true, at: NOW - 1000, ranges: 1, failAt: NOW - 500 }, NOW)).toBe('fail');
    expect(reportState({ enabled: true, at: NOW - 500, ranges: 1, failAt: NOW - 1000 }, NOW)).toBe('ok');
    expect(reportState({ enabled: true, at: NOW - 2000, ranges: 1, failAt: NOW - 1500, skipAt: NOW - 500 }, NOW)).toBe('fail');
    expect(reportState({ enabled: true, at: NOW - 2000, ranges: 1, skipAt: NOW - 500 }, NOW)).toBe('skip');
    expect(reportState({ enabled: true, at: NOW - 60_000, ranges: 1 }, NOW)).toBe('ok');
    expect(reportState({ enabled: true, at: null, ranges: 3 }, NOW)).toBe('waiting');
  });

  it('KPI 칸은 겹치지 않는다 — 합계 = 정상 + 늦음 + 미완료 + 꺼짐 + 대기(건너뜀·보고 없음 포함)', () => {
    const list = agentReportRows({
      agents: [LOCAL, { name: 'Edge-Off', enabled: false }, { name: 'Edge-Wait', enabled: true }],
      rows: [ROW, { agent: 'Edge-Wait', valid: true, size: 10 }],
      reports: { 'Edge-Late': { at: NOW - 3 * REPORT_STALE_MS, alive: 1 }, 'Edge-Ok': { at: NOW - 1000, alive: 4 }, 'Edge-Fail': { at: NOW - 5000, alive: 2, incomplete: { at: NOW - 1000, streak: 1, code: 'error' } } },
      localLast: { at: NOW - 1000, skipped: '대역 없음' }, now: NOW,
    });
    const k = reportKpis(list);
    expect(k.total).toBe(list.length);
    expect(k.ok + k.late + k.fail + k.off + k.waiting).toBe(k.total);
    expect(k).toMatchObject({ ok: 1, late: 1, fail: 1, off: 1, waiting: 2, skip: 1 });
    // 응답 IP 합은 완료 보고만(실패 엣지는 마지막 완료값을 그대로 든다)
    expect(k.alive).toBe(1 + 4 + 2);
  });

  it('상태 표 1:1 — 문구·제목·톤이 모든 상태에 있고, 실패는 빨강·초록은 정상뿐', () => {
    for (const s of ['ok', 'late', 'fail', 'skip', 'off', 'waiting', 'none']) {
      expect(REPORT_STATE_TEXT[s]).toBeTruthy(); expect(REPORT_STATE_TITLE[s]).toBeTruthy(); expect(REPORT_STATE_TONE[s]).toBeTruthy();
    }
    expect(REPORT_STATE_TONE.fail).toBe('red');
    expect(Object.entries(REPORT_STATE_TONE).filter(([, t]) => t === 'green').map(([k]) => k)).toEqual(['ok']);
  });

  it('화면은 톤 표를 쓰고 미완료 KPI 칸을 그린다(상태 → 색을 다시 판정하지 않는다)', () => {
    const s = stripComments(src('IpScanSettings.jsx'));
    expect(s).toContain('REPORT_STATE_TONE[x.state]');
    expect(s).not.toMatch(/x\.state === 'ok' \? 'green'/);
    expect(s).toContain('kpi.fail');
    expect(s).toContain('reportStateNote(x)');
  });
});

/* ── F-02 ─────────────────────────────────────────────────────────────── */
describe('F-02 합계·그룹 증가율의 분모는 증가량을 더한 장비의 기준일 사용량이다', () => {
  const TB = 1e12;
  const P = [{ key: 'd30', days: 30 }];

  it('재현 — 기준선 없는 대형 장비가 섞여도 증가율은 측정 장비 기준', () => {
    const devices = [
      { id: 'A', usedBytes: 100 * TB, totalBytes: 200 * TB, growth: { d30: { bytes: 10 * TB, exact: true, spanDays: 30 } } },
      { id: 'B', usedBytes: 900 * TB, totalBytes: 1000 * TB, growth: { d30: { bytes: null } } },
    ];
    const t = aggregateGrowth(devices, P);
    expect(t.growth.d30.usedMeasured).toBe(100 * TB);
    expect(aggregateGrowthPct(t.growth.d30)).toBe(11.1);
    expect(aggregateGrowthPct(t.growth.d30)).toBe(growthPct(devices[0].growth.d30, devices[0].usedBytes));
    // 예전 계산(분모 = 전 장비 사용량 − 증가량)은 1.0% — 이 값으로 되돌아가면 안 된다
    expect(growthPct(t.growth.d30, t.usedBytes)).toBe(1);
    expect(totalCell(t.growth.d30).title).toContain('증가율(%)은 합산한 1대');
  });

  it('lagging·inexact 로 뺀 장비의 사용량도 분모에 넣지 않는다 · 측정 장비의 사용량을 모르면 null(지어내지 않는다)', () => {
    const devices = [
      { id: 'A', usedBytes: 50 * TB, latestDay: 100, growth: { d30: { bytes: 5 * TB, spanDays: 30 } } },
      { id: 'L', usedBytes: 500 * TB, latestDay: 90, growth: { d30: { bytes: 50 * TB, spanDays: 30 } } },  // lagging
      { id: 'I', usedBytes: 500 * TB, latestDay: 100, growth: { d30: { bytes: 50 * TB, spanDays: 365 } } }, // inexact
    ];
    const t = aggregateGrowth(devices, P, { asOfDay: 100 });
    expect(t.growth.d30.usedMeasured).toBe(50 * TB);
    expect(aggregateGrowthPct(t.growth.d30)).toBe(11.1);
    const odd = aggregateGrowth([{ id: 'X', usedBytes: null, growth: { d30: { bytes: TB, spanDays: 30 } } }], P);
    expect(odd.growth.d30.usedMeasured).toBeNull();
    expect(aggregateGrowthPct(odd.growth.d30)).toBeNull();
    expect(aggregateGrowthPct(null)).toBeNull();
    expect(aggregateGrowthPct({ bytes: TB })).toBeNull(); // 구버전 집계(usedMeasured 없음)는 추측하지 않는다
  });

  it('화면 합계·그룹 행은 aggregateGrowthPct 를 쓴다 — 전 장비 사용량(usedBytes)을 분모로 넘기지 않는다', () => {
    const s = stripComments(src('StorageGrowthTool.jsx'));
    expect(s).not.toMatch(/growthPct\(t\.growth\?\.\[p\.key\], t\.usedBytes\)/);
    expect(s).not.toMatch(/growthPct\(a\.growth\?\.\[p\.key\], a\.usedBytes\)/);
    expect((s.match(/aggregateGrowthPct\(/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});

/* ── F-09 ─────────────────────────────────────────────────────────────── */
describe('F-09 진단 › 서버 메모리 — 403 은 폴링을 멈추고 권한 안내를 보인다', () => {
  // 서버 fleetOnly 거부의 실제 모양(api.js httpFail 이 만드는 HttpError)
  const err403 = new HttpError('전체 범위 계정만 볼 수 있습니다', { status: 403, path: '/admin/memtrack', body: { error: 'forbidden', reason: '전체 범위 계정만 볼 수 있습니다' } });

  it('403 이면 오류를 기록하고 폴링을 멈춘다 · 일시 오류는 오류만 기록하고 계속 · 성공은 오류를 지운다', async () => {
    const calls = []; let stops = 0;
    const mk = (fetchMem) => createMemPoller({ fetchMem, onData: (r) => calls.push(['data', r]), onError: (e) => calls.push(['err', e == null ? null : (e?.status ?? 'x')]), onStop: () => { stops += 1; }, isActive: () => true });
    await mk(async () => { throw err403; })();
    expect(calls).toEqual([['err', 403]]);
    expect(stops).toBe(1);
    calls.length = 0;
    await mk(async () => { throw new Error('Failed to fetch'); })();
    expect(calls).toEqual([['err', 'x']]);
    expect(stops).toBe(1);
    calls.length = 0;
    await mk(async () => ({ window: '24h' }))();
    expect(calls).toEqual([['data', { window: '24h' }], ['err', null]]);
    // 언마운트 뒤의 늦은 응답은 상태를 바꾸지 않는다
    calls.length = 0;
    await createMemPoller({ fetchMem: async () => ({}), onData: () => calls.push('d'), onError: () => calls.push('e'), onStop: () => calls.push('s'), isActive: () => false })();
    expect(calls).toEqual([]);
  });

  it('데이터가 없을 때 — 오류가 없으면 불러오는 중, 403 이면 권한 안내(영원히 불러오는 중이 아니다)', () => {
    expect(renderToStaticMarkup(React.createElement(MemPlaceholder, { err: null }))).toContain('불러오는 중');
    const html = renderToStaticMarkup(React.createElement(MemPlaceholder, { err: err403 }));
    expect(html).not.toContain('불러오는 중');
    expect(html).toContain('권한이 없습니다');
    expect(html).not.toMatch(/\[object Object\]/);
  });

  it('소스 — memtrack 실패를 빈 catch 로 삼키지 않는다', () => {
    const s = stripComments(src('../Diagnostics.jsx'));
    const i = s.indexOf("'/admin/memtrack'");
    expect(i).toBeGreaterThan(0);
    expect(s.slice(i, i + 400)).not.toMatch(/catch\s*\{\s*\}/);
    expect(s).toContain('createMemPoller');
  });
});
