/**
 * v2.929(리눅스 성능 5단계) — 집중 모니터링 · 점검 소모품 · 변경 이벤트 · 베이스라인 · 구간 비교 · 알림 규칙 화면의 문구 · 그리기 회귀.
 * ⚠ 판정은 서버(focus/run · health · changes · baseline · compare · perfRules · perfAlerts) — 여기서는 ① 웹 문구 표 = 서버 열거(1:1) ② 서버 함수가 만든 값을 그대로 그리는지(SSR)
 *   ③ 웹이 다시 판정하지 않는지(소스 스윕 — 기준값 키 비교 없음) ④ 폴링은 집중 진행 중 화면만(상한) ⑤ 결측을 0 으로 그리지 않는지를 고정한다.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as T from './bmPerfOpsText.js';
import { FocusSessionView, FocusSessionList, ProgressBand } from './BmFocusTab.jsx';
import { HealthCard, HealthFleetTable, FocusFleetTable } from './BmPerfOpsParts.jsx';
import { ChangeTable } from './BmTrendOps.jsx';
import BmPerfRulesPanel, { canEditRules } from './BmPerfRulesPanel.jsx';
import { DETAIL_TABS } from './bmPerfText.js';
import { setCurrentUser } from '../../api.js';
import { FOCUS_STATUS, FOCUS_MISS, FOCUS_CODES, FOCUS_COLS, summarizeFocus } from '../../../../server/src/bmusage/focus/run.js';
import { HEALTH_CELLS, HEALTH_CODES, HEALTH_GRADE, judgeHealth, compactHealth } from '../../../../server/src/bmusage/health.js';
import { CHANGE_KINDS } from '../../../../server/src/bmusage/changes.js';
import { RULE_IDS, RULE_CONDS, CHANNELS, BASELINE_METRICS } from '../../../../server/src/bmusage/perfRules.js';
import { COMPARE_METRICS } from '../../../../server/src/bmusage/compare.js';
import { bandOf, slotHours, hourStart } from '../../../../server/src/bmusage/baseline.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const H = 3_600_000; const D = 24 * H;
const NOW = Math.floor(Date.now() / H) * H - 30 * 60_000;
const h = React.createElement;

describe('웹 문구 표 = 서버 열거(1:1)', () => {
  it('집중 — 상태 · 결측 사유 · 결과 code · 지표', () => {
    expect(Object.keys(T.FOCUS_STATUS_TEXT).sort()).toEqual([...FOCUS_STATUS].sort());
    expect(Object.keys(T.FOCUS_MISS_TEXT).sort()).toEqual([...FOCUS_MISS].sort());
    expect(Object.keys(T.FOCUS_CODE_TEXT).sort()).toEqual([...FOCUS_CODES].sort());
    for (const c of FOCUS_COLS) expect(T.FOCUS_METRIC_TEXT[c], c).toBeTruthy();
    for (const r of T.FOCUS_ROWS) expect(FOCUS_COLS).toContain(r);
  });
  it('소모품 — 칸 · code · 근거 등급(서버 값 그대로)', () => {
    expect(Object.keys(T.HEALTH_CELL_TEXT)).toEqual([...HEALTH_CELLS]);
    expect(Object.keys(T.HEALTH_CODE_TEXT).sort()).toEqual([...HEALTH_CODES].sort());
    for (const k of HEALTH_CELLS) expect(T.HEALTH_CELL_TEXT[k].grade, k).toBe(HEALTH_GRADE[k]);
  });
  it('변경 이벤트 종류 · 규칙 · 조건 · 채널 · 비교 지표 · 베이스라인 지표', () => {
    expect(Object.keys(T.CHANGE_KIND_TEXT).sort()).toEqual([...CHANGE_KINDS].sort());
    expect(Object.keys(T.RULE_TEXT).sort()).toEqual([...RULE_IDS].sort());
    for (const id of RULE_IDS) expect(Object.keys(T.RULE_TEXT[id].conds).sort(), id).toEqual([...RULE_CONDS[id]].sort());
    expect(Object.keys(T.CHANNEL_TEXT).sort()).toEqual([...CHANNELS].sort());
    expect(Object.keys(T.COMPARE_METRIC_TEXT).sort()).toEqual([...COMPARE_METRICS].sort());
    for (const m of BASELINE_METRICS) expect(T.FOCUS_METRIC_TEXT[m], m).toBeTruthy();
  });
  it('서버 상세 탭에 ‘집중 모니터링’ 이 있다', () => {
    expect(DETAIL_TABS.map((x) => x.id)).toContain('focus');
  });
});

describe('그리기 — 결측은 0 이 아니다 · 서버 판정 그대로', () => {
  const samples = [
    { idx: 0, minuteTs: NOW, osOk: true, idracOk: true, verdict: 'saturated', vals: { disk_await_ms: { avg: 24, peak: 96 }, cpu_pct: { avg: 58, peak: 80 }, power_w: { avg: 418 }, _res: { disk: 'saturated' } }, snap: { ioTop: [{ name: 'pg_dump', readBps: 0, writeBps: 2e8 }], cpuTop: [{ name: 'postgres', cpuPct: 41 }] } },
    { idx: 1, minuteTs: NOW + 60_000, osOk: false, idracOk: true, verdict: null, missOs: 'timeout', vals: { power_w: { avg: 449 } }, snap: null },
    { idx: 2, minuteTs: NOW + 120_000, osOk: true, idracOk: true, verdict: 'ok', vals: { disk_await_ms: { avg: 3, peak: 4 }, cpu_pct: { avg: 40, peak: 50 } }, snap: { ioTop: [{ name: 'pg_dump', readBps: 1e6, writeBps: 0 }], cpuTop: [{ name: 'postgres', cpuPct: 30 }] } },
  ];
  const session = { id: 's1', key: 'K', status: 'running', trigger: 'manual', start: NOW, created: NOW, intervalS: 60, count: 10, done: 3, missOs: 1, missIdrac: 0, reason: '디스크 포화 확인',
    summary: summarizeFocus(samples, { before: { disk_await_ms: { avg: 0.4, max: 2.1, n: 12 } }, hasOs: true, hasIdrac: true }) };
  it('진행 띠 — 결측 칸은 점선(판정 색 없음) · 나머지는 아직', () => {
    const cells = T.progressCells(session, samples);
    expect(cells.length).toBe(10);
    expect(cells[1].state).toBe('missing'); expect(cells[1].title).toMatch(/결측\(SSH 시한 초과\) · iDRAC 만 있음/);
    expect(cells[0].tone).toBe('bad'); expect(cells[3].state).toBe('pending');
    const html = renderToStaticMarkup(h(ProgressBand, { session, samples }));
    expect((html.match(/bmf-missing/g) || []).length).toBe(1);
  });
  it('히트 표 — 결측 분의 OS 지표는 ‘—’(0 이 아니다) · iDRAC 지표는 남는다 · 값이 없는 지표 행은 없다', () => {
    const rows = T.heatRows(samples);
    const aw = rows.find((r) => r.metric === 'disk_await_ms');
    expect(aw.cells[1]).toEqual({ miss: true });
    expect(rows.find((r) => r.metric === 'power_w').cells[1]).toEqual({ avg: 449, peak: null });
    expect(rows.some((r) => r.metric === 'swap_out_ps')).toBe(false);
    const html = renderToStaticMarkup(h(FocusSessionView, { resp: { session, samples, changes: [{ ts: NOW + 30_000, kind: 'cron', item: 'pg_dump-adhoc', before: '없음', after: 'crc 5e6d0a11' }] }, name: 'bm-db01' }));
    expect(html).toContain('원인 후보(상관)'); expect(html).toContain('pg_dump');
    expect(html).toContain('인과는 담당자가 확인합니다');
    expect(html).toContain('결측 — SSH 시한 초과');
    expect(html).toContain('크론 pg_dump-adhoc 없음 → crc 5e6d0a11');
    expect(html).not.toMatch(/\*\*/);
    expect(html).toContain('임시');
  });
  it('세션 목록 — 실행자 열은 응답에 by 가 있을 때만(서버가 관리자에게만 준다) · 대기 순번', () => {
    const a = renderToStaticMarkup(h(FocusSessionList, { sessions: [{ ...session, status: 'queued', queuePos: 2 }] }));
    expect(a).not.toContain('실행자'); expect(a).toContain('대기 2번째');
    const b = renderToStaticMarkup(h(FocusSessionList, { sessions: [{ ...session, by: 'kim.ops' }] }));
    expect(b).toContain('실행자'); expect(b).toContain('kim.ops');
  });
  it('소모품 카드 — 서버 judgeHealth 결과를 그대로(값 · 기준 · 등급 · 며칠째) · 확인 불가는 주의로 세지 않는다', () => {
    const hl = judgeHealth({ hfacts: { chrony: { offsetMs: -150, stratum: 3, leap: 'Normal', synced: true }, dmesg: { failed: true, rc: 1 }, upS: 41 * 86_400, needsRestart: true, fd: { alloc: 1, max: 100, pct: 1 }, conntrack: null, oomTotal: 0, sections: { chrony: 'ok', dmesg: 'ok', changes: 'ok' } },
      tuning: { units: { failed: 0 } }, row: { oom_kill_delta: 0 }, cert: null, th: {}, now: NOW });
    hl.since = { chrony: NOW - 3 * D, uptime: NOW };
    const html = renderToStaticMarkup(h(HealthCard, { health: hl, now: NOW }));
    expect(html).toContain('-150 ms'); expect(html).toContain('기준 ±100ms(설정)'); expect(html).toContain('3일째');
    expect(html).toContain('권한 부족 또는 실패'); expect(html).toContain('41일 · 재부팅 필요'); expect(html).toContain('해당 없음');
    expect(html).toContain('주의 2'); expect(html).not.toMatch(/\*\*/);
    expect(renderToStaticMarkup(h(HealthCard, { health: null }))).toContain('소모품 칸이 없습니다');
  });
  it('함대 ‘소모품 주의’ — 주의 · 이상 칸만 · 며칠째 = 가장 오래된 since · 못 읽은 칸은 세지 않는다', () => {
    const items = [
      { key: 'A', name: 'a', vcenterId: 'vcA', entry: { health: compactHealth({ cells: { chrony: { code: 'warn' }, units: { code: 'ok' } }, since: { chrony: NOW - 6 * D }, attention: 1 }) } },
      { key: 'B', name: 'b', vcenterId: 'vcA', entry: { health: compactHealth({ cells: { chrony: { code: 'missing' } }, attention: 0 }) } },
      { key: 'C', name: 'c', vcenterId: 'vcB', entry: { health: compactHealth({ cells: { oom: { code: 'bad' } }, since: { oom: NOW }, attention: 1 }) } },
    ];
    const rows = T.healthAttentionRows(items, NOW);
    expect(rows.map((r) => r.key)).toEqual(['C', 'A'], '이상 먼저');
    expect(T.daysSinceText(rows[1].since, NOW)).toBe('6일째'); expect(T.daysSinceText(rows[0].since, NOW)).toBe('오늘');
    const html = renderToStaticMarkup(h(HealthFleetTable, { items, now: NOW }));
    expect(html).toContain('시각 동기(chrony)'); expect(html).not.toContain('>b<');
    expect(renderToStaticMarkup(h(FocusFleetTable, { sessions: [] }))).toContain('없습니다');
  });
  it('변경 이벤트 표 · 추이 점 — 창 밖 이벤트는 점이 없다 · 같은 시각은 한 점', () => {
    const ev = [{ ts: NOW - H, kind: 'sysctl', item: 'vm.dirty_ratio', before: '20', after: '10' }, { ts: NOW - H, kind: 'sysctl-file', item: '99-gp.conf', before: 'crc 1', after: 'crc 2' }, { ts: NOW - 3 * D, kind: 'kernel', item: 'k', before: 'a', after: 'b' }];
    const marks = T.changeMarks(ev, { from: NOW - D, to: NOW });
    expect(marks.length).toBe(1); expect(marks[0].n).toBe(2);
    const html = renderToStaticMarkup(h(ChangeTable, { events: ev }));
    expect(html).toContain('vm.dirty_ratio'); expect(html).toContain('20 → 10');
    expect(renderToStaticMarkup(h(ChangeTable, { events: [] }))).toContain('첫 관찰은 적지 않습니다');
  });
  it('베이스라인 띠 — 서버 bandOf 결과로 다각형 · 띠 없는 시간에서 끊는다 · 띠 밖 점', () => {
    const hs = slotHours(NOW, 4);
    const b = bandOf(hs.map((x) => ({ h: x, avg: 10, samples: 12 })), { bandPct: 40, minWeeks: 4, maxMissingPct: 25 });
    const t0 = hourStart(NOW - 5 * H);
    const series = [{ t: t0, ...b }, { t: t0 + H, ...b }, { t: t0 + 2 * H, reason: 'few-weeks' }, { t: t0 + 3 * H, ...b }];
    const polys = T.bandPolys(series, { from: t0, to: t0 + 5 * H, yMax: 100 });
    expect(polys.length).toBe(2, 'reason 칸에서 끊긴다');
    const outs = T.outsidePoints([{ t: t0 + 60_000, avg: 29 }, { t: t0 + H + 60_000, avg: 9 }, { t: t0 + 2 * H + 60_000, avg: 99 }], series);
    expect(outs.map((p) => p.avg)).toEqual([29], '띠 없는 시간의 값은 밖으로 세지 않는다');
    expect(T.bandSummaryText({ series: [{ t: 1, reason: 'few-weeks' }], weeks: 4, minWeeks: 4, maxMissingPct: 25 })).toMatch(/^베이스라인 없음 — 표본 주 수 부족/);
  });
  it('구간 비교 프리셋 — 같은 길이 · B 는 선택 구간 또는 최근 1시간', () => {
    const p = T.comparePair({ preset: 'yesterday', now: NOW });
    expect(p.b).toEqual({ from: NOW - H, to: NOW }); expect(p.a).toEqual({ from: NOW - H - D, to: NOW - D });
    const w = T.comparePair({ preset: 'lastweek', sel: { from: NOW - 2 * H, to: NOW - H }, now: NOW });
    expect(w.a.to - w.a.from).toBe(H); expect(w.a.from).toBe(NOW - 2 * H - 7 * D);
    const f = T.comparePair({ preset: 'focus', now: NOW, session: { start: NOW - D, end: NOW - D + 10 * 60_000 } });
    expect(f.a.to - f.a.from).toBe(f.b.to - f.b.from);
    expect(T.diffText(4400)).toBe('+4,400%'); expect(T.diffText(null)).toBe('—');
    expect(T.compareCsv({ metrics: [{ metric: 'cpu_pct', a: { avg: 1 }, b: { avg: 2 }, diffAvgPct: 100 }] })).toContain('cpu_pct,1,,2,,100');
  });
  it('집중 CSV — 결측은 빈 칸(0 이 아니다)', () => {
    const csv = T.focusCsv(session, samples);
    const line = csv.split('\r\n')[2];
    expect(line).toMatch(/,0,1,timeout,/); expect(line).not.toMatch(/,0,0,0,0/);
  });
  it('결측 문구 — 경로가 없는 쪽은 ‘경로 없음’(0 분이 아니다) · 서버 summarizeFocus 의 null 을 그대로', () => {
    const smp = [{ idx: 0, minuteTs: NOW, osOk: true, idracOk: null, verdict: 'ok', missOs: null, missIdrac: null, vals: { cpu_pct: { avg: 10 } } }];
    const sumNoIdrac = summarizeFocus(smp, { hasOs: true, hasIdrac: false });
    expect(sumNoIdrac.missIdrac).toBe(null);
    const mp = T.missPathParts({ missOs: 0, missIdrac: 0 }, sumNoIdrac);
    expect(mp.os).toBe('OS 0분'); expect(mp.idrac).toBe('iDRAC 경로 없음'); expect(mp.total).toBe(0);
    expect(T.conclusionParts(sumNoIdrac, { status: 'done', missOs: 0, missIdrac: 0 }).join(' ')).toContain('iDRAC 경로 없음');
    // 요약도 카운터도 없으면 '—'(0 으로 채우지 않음)
    expect(T.missPathParts({}, {})).toEqual({ os: 'OS —', idrac: 'iDRAC —', total: null });
  });
});

describe('알림 규칙 화면', () => {
  afterEach(() => setCurrentUser(null));
  it('저장 버튼 — 설정 소유자 등급만(서버 403 과 같은 판단) · 범위 계정 읽기 전용', () => {
    setCurrentUser({ username: 'own', role: 'admin', settingsOwnerTier: true });
    expect(canEditRules({ readOnly: false })).toBe(true);
    expect(canEditRules({ readOnly: true })).toBe(false);
    setCurrentUser({ username: 'adm', role: 'admin', settingsOwnerTier: false, isSettingsOwner: true });
    expect(canEditRules({ readOnly: false })).toBe(false, '소유자 목록이지만 범위 계정(등급 false)');
    setCurrentUser({ username: 'op', role: 'operator', settingsOwnerTier: true });
    expect(canEditRules({ readOnly: false })).toBe(false);
  });
  it('첫 그리기는 읽는 중(조회 1회 — SSR)', () => {
    expect(renderToStaticMarkup(h(BmPerfRulesPanel, { vcenters: [] }))).toContain('읽는 중');
  });
});

describe('소스 스윕', () => {
  const files = ['BmFocusTab.jsx', 'BmPerfOpsParts.jsx', 'BmTrendOps.jsx', 'BmPerfRulesPanel.jsx', 'bmPerfOpsText.js'];
  const src = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(HERE, f), 'utf8')]));
  it('웹이 다시 판정하지 않는다 — 기준값 키(chronyMs · fdPct · bandPct · diffPct …)와 비교 연산이 없다', () => {
    for (const [f, s] of Object.entries(src)) {
      expect(s, f).not.toMatch(/(chronyMs|fdPct|conntrackPct|dmesgErr24h|certDays|bandPct|diffPct|minWeeks)\s*[<>]=?/);
      expect(s, f).not.toMatch(/[<>]=?\s*(th|limits?)\.(chronyMs|fdPct|conntrackPct|dmesgErr24h|certDays|bandPct|diffPct)/);
    }
  });
  it('폴링은 집중 진행 중 화면만(setTimeout 1곳 · FOCUS_POLL_MS · 상한) — setInterval · usePolling 없음', () => {
    for (const [f, s] of Object.entries(src)) { expect(s, f).not.toMatch(/setInterval\(|usePolling\(/); }
    expect((src['BmFocusTab.jsx'].match(/setTimeout\(/g) || []).length).toBe(2, '폴링 1 + 내려받기 URL 해제 1');
    expect(src['BmFocusTab.jsx']).toMatch(/focusPollMax/);
    expect(T.focusPollMax({ count: 10, intervalS: 60 })).toBe(24);
  });
  it('text-transform uppercase 없음(날 드롭다운은 전역 스윕 selectSort.test.js 가 본다)', () => {
    for (const [f, s] of Object.entries(src)) { expect(s, f).not.toMatch(/text-transform\s*:\s*uppercase|textTransform/); }
  });
});
