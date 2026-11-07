/**
 * 리눅스 성능 6단계 — 서버 비교 · 수집 건강 · 운영 주석 · 공유 링크 · 진단 플레이북 · 목표선 화면의 문구 · 그리기 회귀.
 * ⚠ 판정은 서버(multiCompare · collectHealth · annotations · playbooks · slo) — 여기서는 ① 웹 문구 표 = 서버 열거(1:1) ② 서버 함수가 만든 값을 그대로 그리는지(SSR)
 *   ③ 웹이 다시 판정하지 않는지(소스 스윕) ④ 결측을 0 으로 그리지 않는지 ⑤ 폴링이 없는지를 고정한다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as C from './bmCompareText.js';
import { CompareSide, CompareTable, CompareOverlay, createCompareLoader } from './BmCompareView.jsx';
import { matrixRows } from './BmPerfBoard.jsx';
import { groupCompareKeys } from './BmOpsFleet.jsx';
import { COMPARE_GROUPS, COMPARE_METRICS, buildCompareTable, seriesStats } from '../../../../server/src/bmusage/multiCompare.js';
import * as K from './bmCollectText.js';
import { CollectHealthView } from './BmCollectHealth.jsx';
import { HEALTH_REASON_CODES, NODE_FLAGS, summarizeCycle } from '../../../../server/src/bmusage/collectHealth.js';
import { nodeStateOf } from '../../../../server/src/routes/api/bmCollectHealth.js';
import * as N from './bmAnnotText.js';
import { AnnotTable } from './BmAnnotations.jsx';
import { TrendSvg } from './BmTrendChart.jsx';
import { ANNOT_KINDS } from '../../../../server/src/bmusage/annotations.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const H = 3_600_000;
const NOW = Math.floor(Date.now() / H) * H - 30 * 60_000;
const h = React.createElement;
const src = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('서버 비교 — 문구 표 = 서버 열거', () => {
  it('묶음 · 지표 이름 · 열 상태', () => {
    expect(Object.keys(C.COMPARE_GROUP_TEXT).sort()).toEqual(Object.keys(COMPARE_GROUPS).sort());
    for (const m of COMPARE_METRICS) expect(C.metricLabel(m.col)).not.toBe(m.col);
    for (const s of ['ok', 'stale', 'none', 'other-corp', 'old-version', 'no-sample']) expect(C.COLUMN_STATE_TEXT[s]).toBeTruthy();
    expect(C.columnStateView('old-version', { minEdgeVersion: '2.950.0' }).note).toMatch('v2.950.0');
  });
});

describe('서버 비교 — 그리기는 서버 값 그대로 · 결측은 ‘—’', () => {
  const from = NOW - H; const to = NOW;
  const ser = (vals) => seriesStats(vals.map((v, i) => ({ t: from + (i + 1) * 300_000, avg: v, max: v, peak: v == null ? null : v + 10 })), { from, to, stepMs: 300_000 });
  const cols = [
    { key: 'a', name: 'bm-a', state: 'ok', vcenterId: 'vcA', verdict: 'saturated', series: { cpu_pct: ser([10, 20, null, 40]) }, hwValues: { power_w: 412 } },
    { key: 'b', name: 'bm-b', state: 'ok', vcenterId: 'vcA', verdict: 'ok', series: { cpu_pct: ser([null, null, null, null]) }, hwValues: {} },
    { key: 'c', name: 'bm-c', state: 'other-corp', vcenterId: 'vcB' },
  ];
  const table = buildCompareTable(cols, { metrics: ['cpu_pct', 'power_w'] });
  const resp = { ok: true, from, to, columns: cols, table, metricMeta: Object.fromEntries(COMPARE_METRICS.map((m) => [m.col, { unit: m.unit, scaleMax: m.scaleMax, src: m.src }])) };
  const nameOf = (k) => cols.find((c) => c.key === k)?.name || k;
  const colors = C.colorPlan(cols.map((c) => c.key));
  it('나란히 — 값 없는 서버는 ‘—’(0 이 아니다) · 다른 법인 열은 없다 · 400 폭 블록도 같은 값', () => {
    const html = renderToStaticMarkup(h(CompareSide, { resp, nameOf, colors, valueMode: 'avgpeak', devHigh: true }));
    expect(html).toContain('bm-a'); expect(html).not.toContain('bm-c');
    expect(html).toContain('—'); expect(html).not.toMatch(/>0%</);
    expect(html).toContain('bmcmp-stack');
    expect(html).toContain('412W');
  });
  it('표 — 편차는 서버 값(결측 뺀 2대 미만이면 ‘—’) · 판정 행 · 베이스라인 행', () => {
    const html = renderToStaticMarkup(h(CompareTable, { resp, nameOf, valueMode: 'avgpeak', devHigh: true }));
    expect(table.rows[0].dev).toBe(null);
    expect(html).toContain('USE 판정'); expect(html).toContain('베이스라인 이탈');
    expect(html).toContain('편차는 결측을 뺀');
  });
  it('겹쳐서 — 서버마다 선 · 범례 · 하드웨어 지표는 겹칠 추이가 없다', () => {
    const html = renderToStaticMarkup(h(CompareOverlay, { resp, nameOf, colors, valueMode: 'avg', metric: 'cpu_pct', onMetric: () => {} }));
    expect(html).toContain('<path'); expect(html).toContain('bm-b');
  });
  it('스파크는 값 없는 점에서 끊는다', () => {
    const d = C.sparkPath([[0, 1, null], [1, null, null], [2, 3, null]], { pick: 1, scale: 10, w: 10, h: 10, from: 0, to: 2 });
    expect(d.match(/M/g).length).toBe(2);
    expect(C.sparkPath([], {})).toBe('');
  });
  it('CSV — 결측은 빈 칸 · 수식 가드', () => {
    const csv = C.compareCsv(resp, { view: 'table', nameOf: () => '=evil' });
    expect(csv).toContain("'=evil"); expect(csv).not.toContain('null'); expect(csv).not.toContain('NaN');
  });
  it('색은 키에 고정(선택 순서와 무관)', () => {
    expect(C.keyColor('bm-a')).toBe(C.keyColor('bm-a'));
    const p1 = C.colorPlan(['x', 'y']); const p2 = C.colorPlan(['y', 'x']);
    expect(p1.x.stroke).toBe(p2.x.stroke);
  });
  it('담기 상한 · 중복', () => {
    expect(C.addKey(['a', 'b'], 'c', 2).error).toMatch('2대까지');
    expect(C.addKey(['a'], 'a', 5).list).toEqual(['a']);
  });
  it('늦게 온 이전 응답은 버린다', async () => {
    let r1; const slow = new Promise((r) => { r1 = r; });
    let calls = 0;
    const L = createCompareLoader(() => { calls += 1; return calls === 1 ? slow : Promise.resolve({ ok: true, n: 2 }); });
    const got = [];
    const p1 = L.load({}, (p) => got.push(p)); const p2 = L.load({}, (p) => got.push(p));
    expect(await p2).toBe('ok'); r1({ ok: true, n: 1 }); expect(await p1).toBe('stale');
    expect(got.filter((x) => x.resp).map((x) => x.resp.n)).toEqual([2]);
  });
  it('보드 행 체크 — 서버 칸 안(열 수 불변)', () => {
    const rows = matrixRows([{ key: 'k1', name: 's1', agent: '', target: { paths: [] }, entry: null }], { onPickCmp: () => {}, cmpKeys: ['k1'] });
    const html = renderToStaticMarkup(h('table', null, h('tbody', null, rows)));
    expect((html.match(/<td/g) || []).length).toBe(18);
    expect(html).toContain('type="checkbox"'); expect(html).toContain('checked');
  });
  it('용도 그룹 상위 5 — 나쁜 판정 먼저', () => {
    const servers = [{ key: 'ok1', apps: ['gpdb'], status: 'ok' }, { key: 'bad1', apps: ['gpdb'], status: 'bad' }, { key: 'x', apps: ['airflow'], status: 'bad' }, { key: 'w1', apps: ['gpdb'], status: 'warn' }];
    expect(groupCompareKeys(servers, 'gpdb')).toEqual(['bad1', 'w1', 'ok1']);
  });
  it('소스 스윕 — 편차 · 스큐 · 눈금 판정을 웹이 다시 하지 않는다 · 폴링 없음', () => {
    const s = strip(src('bmCompareText.js')) + strip(src('BmCompareView.jsx'));
    expect(s).not.toMatch(/Math\.max\(\.\.\.[^)]*\)\s*\/\s*Math\.min/);
    expect(s).not.toMatch(/SKEW_RATIO|DEV_HIGH_RATIO|>=\s*2\s*\*/);
    expect(s).not.toMatch(/setInterval|usePolling/);
  });
});

describe('수집 건강 — 문구 표 = 서버 열거 · 결측은 ‘—’', () => {
  it('사유 · 칸 · 노드 상태 1:1', () => {
    expect(Object.keys(K.REASON_TEXT).sort()).toEqual([...HEALTH_REASON_CODES].sort());
    for (const f of NODE_FLAGS) expect(K.FLAG_TEXT[f]).toBeTruthy();
    const states = new Set(['off', 'old-version', 'no-cycle', 'edge-stale', 'ok', 'attention', 'no-snapshot']);
    expect(nodeStateOf({ via: 'edge', enabled: true, hasField: false })).toBe('old-version');
    expect(nodeStateOf({ via: 'local', enabled: false })).toBe('off');
    for (const st of states) expect(K.NODE_STATE_TEXT[st]).toBeTruthy();
  });
  it('값 없으면 단위 없이 ‘—’ · 0 은 값', () => {
    expect(K.msText(null)).toBe('—'); expect(K.msText(0)).toBe('0ms'); expect(K.pctText1(null)).toBe('—'); expect(K.gbText(undefined)).toBe('—');
    expect(K.cycleText(null, 300_000)).toBe('—'); expect(K.sshText({ n: 0, p50Ms: null })).toBe('—'); expect(K.concText(null)).toBe('—');
  });
  it('SSR — 서버 요약 그대로(사유 · 며칠째 · 노드 숨김)', () => {
    const sum = summarizeCycle({ results: [{ ok: false, target: { key: 'a', vcenterId: 'vcA', paths: ['os'] }, os: { ok: false, error: 'OS 수집 시한 초과' }, osMs: 61_000 }], startedAt: NOW - 1000, endedAt: NOW, intervalMs: 300_000, concurrency: 32, slotPeak: 1, now: NOW });
    const resp = { minEdgeVersion: '2.950.0', kpi: { corps: 2, servers: 1, successPct: 0, okN: 0, worstCycle: null, dbBytes: null }, reasons: [{ path: 'os', code: 'timeout', n: 1, since: NOW - 3 * 86_400_000, state: 'idracOnlyUnread' }],
      nodes: [{ agent: 'edge-a', via: 'edge', state: 'attention', flags: ['success'], node: { ...sum.node, db: { bytes: null, families: {} } }, trend: [] }, { agent: 'edge-old', via: 'edge', state: 'old-version', flags: [], nodeHidden: false }],
      rows: [{ vcenterId: 'vcA', agent: 'edge-a', via: 'edge', nodeState: 'attention', servers: 1, ok: 0, fail: 1, successPct: 0, reasons: [{ path: 'os', code: 'timeout', n: 1 }], cycleMs: 1000, budgetMs: 300_000 },
        { vcenterId: 'vcB', agent: 'x', via: 'edge', nodeState: 'ok', nodeHidden: true, servers: null, reasons: [] }] };
    const html = renderToStaticMarkup(h(CollectHealthView, { resp, now: NOW }));
    expect(html).toContain('시한 초과'); expect(html).toContain('3일째'); expect(html).toContain('OS 못 읽음');
    expect(html).toContain('노드 값 숨김'); expect(html).toContain('성공률 낮음');
    expect(html).not.toMatch(/>0GB</); expect(html).not.toContain('NaN');
  });
  it('CSV — 결측은 빈 칸', () => {
    const csv = K.collectCsv({ rows: [{ vcenterId: 'vcA', agent: 'e', servers: null, reasons: [] }] });
    expect(csv).not.toContain('null'); expect(csv.split('\r\n')[1]).toMatch(/^vcA,e,,/);
  });
  it('소스 스윕 — 기준값 비교 · 폴링 없음', () => {
    const s2 = strip(src('bmCollectText.js')) + strip(src('BmCollectHealth.jsx'));
    expect(s2).not.toMatch(/cyclePct\s*>=|successPct\s*</);
    expect(s2).not.toMatch(/setInterval|setTimeout\(\s*load|usePolling/);
  });
});

describe('운영 주석 — ◆ 핀 · 목록 · 연결', () => {
  const win = { from: NOW - 6 * H, to: NOW };
  const list = [
    { id: 'A1', at: NOW - 2 * H, end: NOW - H, kind: 'work', text: 'pg_dump 수동', by: 'kim', target: { type: 'servers', names: ['db01', 'db02'], count: 2 }, links: { issue: 'ISS-12', wiki: { space: 'pub', id: 'W3' } }, edits: [], canEdit: true },
    { id: 'A2', at: NOW - 3 * H, kind: 'memo', text: '', by: 'lee', deleted: { at: NOW - H, by: 'lee' }, target: { type: 'server', names: ['db01'] }, links: {}, edits: [] },
    { id: 'A3', at: NOW - 30 * H, kind: 'memo', text: '창 밖', by: 'x', target: { type: 'corp', vcenterIds: ['vcA'] }, links: {} },
  ];
  it('종류 1:1 · 핀은 창 안 · 지운 것 제외 · 범위 주석은 끝을 싣는다', () => {
    expect(Object.keys(N.ANNOT_KIND_TEXT).sort()).toEqual([...ANNOT_KINDS].sort());
    const m = N.annotMarks(list, win);
    expect(m.length).toBe(1); expect(m[0].pin).toBe(true); expect(m[0].end).toBe(NOW - H); expect(m[0].title).toContain('pg_dump');
  });
  it('연결은 해시 링크(권한은 여는 사람) · 입력 본문은 빈 칸을 보내지 않는다', () => {
    expect(N.annotLinks(list[0].links).map((l) => l.href)).toEqual(['#/issues/list/ISS-12', '#/wiki/pub/W3']);
    expect(N.annotBody({ keys: ['k'], at: 1, kind: 'memo', text: 'x' })).toEqual({ keys: ['k'], at: 1, kind: 'memo', text: 'x' });
    expect(N.annotBody({ corp: 'vcA', at: 1, end: 2, kind: 'work', text: 'y', issue: ' iss-3 ' }).links).toEqual({ issue: 'ISS-3' });
    expect(N.annotTargetText({ target: { type: 'corp', vcenterIds: ['vcA'] } })).toBe('법인 vcA');
  });
  it('목록 SSR — 삭제됨 흔적 · 고치기는 canEdit 일 때만', () => {
    const html = renderToStaticMarkup(h(AnnotTable, { list }));
    expect(html).toContain('삭제됨(lee'); expect(html).toContain('ISS-12');
    expect((html.match(/고치기/g) || []).length).toBe(1);
  });
  it('추이 SVG — ◆ 핀은 HTML 겹침(SVG 도형이 아니다) · 핀이 없으면 예전 출력 그대로', () => {
    const plain = renderToStaticMarkup(h(TrendSvg, { series: [], win, marks: [] }));
    expect(plain.startsWith('<svg')).toBe(true);
    const withPin = renderToStaticMarkup(h(TrendSvg, { series: [], win, marks: N.annotMarks(list, win) }));
    expect(withPin).toContain('bmt-pin'); expect(withPin).toContain('◆');
  });
  it('소스 스윕 — 폴링 없음', () => {
    const s3 = strip(src('BmAnnotations.jsx')) + strip(src('bmAnnotText.js'));
    expect(s3).not.toMatch(/setInterval|usePolling|setTimeout/);
  });
});
