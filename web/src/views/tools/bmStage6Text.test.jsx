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
import { PEAK_PLAN_REASONS } from '../../../../server/src/bmusage/peakPlan.js';
import * as N from './bmAnnotText.js';
import { AnnotTable } from './BmAnnotations.jsx';
import { TrendSvg } from './BmTrendChart.jsx';
import { ANNOT_KINDS } from '../../../../server/src/bmusage/annotations.js';
import * as S from './bmShare.js';
import * as RB from './bmRunbookText.js';
import { PlaybookView, SloTable } from './BmRunbookTabs.jsx';
import { STEP_KINDS, playbookCatalog, allJudgmentIds } from '../../../../server/src/bmusage/playbooks.js';
import { SLO_METRICS, SLO_BASES, SLO_OPS, evaluateGoal } from '../../../../server/src/bmusage/slo.js';
import { inlineSvgPaint, captureName, footerHeight } from './bmCapture.js';

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
    expect(Object.keys(K.PEAK_REASON_TEXT).sort()).toEqual([...PEAK_PLAN_REASONS].sort());
    expect(K.peakReasonText('rm -rf')).toBe(''); expect(K.peakReasonText('no-targets')).toBe('대상 없음');
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
    // 합에서 뺀 ‘모름’ 개수 · 크기를 못 읽은 DB · 버린 엣지 법인 값
    const html2 = renderToStaticMarkup(h(CollectHealthView, { resp: { ...resp, corpsDropped: 2, kpi: { ...resp.kpi, corpsUnknown: 1, dbUnknown: 1 }, nodes: [{ ...resp.nodes[0], node: { ...resp.nodes[0].node, db: { bytes: null, unread: 3, families: {} } } }] }, now: NOW }));
    expect(html2).toContain('법인 1곳 모름(합에서 뺌)'); expect(html2).toContain('노드 1곳 모름'); expect(html2).toContain('파일 3개의 크기를 읽지 못해'); expect(html2).toContain('2건은 싣지 않았습니다');
    expect(K.unknownText(0, '법인')).toBe(''); expect(K.unknownText(null, '법인')).toBe('');
  });
  it('주기 소요 추이 — 칸 1개 · 결측 사이 1칸은 굵은 점(가장자리에 잘리지 않게) · 결측은 잇지 않는다', () => {
    const one = K.trendPaths([{ t: NOW, maxMs: 23, budgetMs: 300_000 }]);
    expect(one.n).toBe(1); expect(one.msDots).toMatch(/^M500,/); expect(one.budgetDots).toMatch(/^M500,6 /);
    const y = Number(one.msDots.split(',')[1].split(' ')[0]); expect(y).toBeGreaterThan(6 - 0.01); expect(y).toBeLessThanOrEqual(134);
    const gap = K.trendPaths([{ t: NOW, maxMs: 10, budgetMs: 100 }, { t: NOW + 3_600_000, maxMs: null, budgetMs: 100 }, { t: NOW + 7_200_000, maxMs: 20, budgetMs: 100 }, { t: NOW + 10_800_000, maxMs: 30, budgetMs: 100 }]);
    expect(gap.ms.match(/M/g).length).toBe(2, '결측 칸에서 끊긴다(0 으로 잇지 않는다)'); expect(gap.msDots.match(/M/g).length).toBe(1, '홀로 남은 첫 칸은 점');
    expect(K.trendPaths([]).msDots).toBe('');
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

describe('공유 링크 · 캡처', () => {
  it('왕복 — 상세(탭 · 기간 · 창 끝 · 커서 · 구간 · 토글) · 비교(서버 · 법인 간 · 보기 · 묶음 · 값 · 지표)', () => {
    const d = { view: 'detail', key: 'TAG1', tab: 'trend', range: '7d', show: 'peak', to: NOW, cursor: NOW - H, sel: { from: NOW - 3 * H, to: NOW - 2 * H }, disk: 'disk', net: 'nic', layout: 'rows' };
    expect(S.parseShareHash(S.shareHashOf(d))).toEqual(d);
    const c = { view: 'compare', keys: ['a', 'b'], cross: true, range: '7d', cv: 'table', group: 'use', value: 'avg', metric: 'cpu_pct' };
    expect(S.parseShareHash(S.shareHashOf(c))).toEqual(c);
    expect(S.shareHashOf(c).startsWith('#/tools/bm-usage/share?')).toBe(true);
  });
  it('형식 밖은 버린다 — 모르는 보기 · 탭 · 키 · 수 · 다른 화면 해시', () => {
    expect(S.parseShareHash('#/tools/bm-usage/share?view=evil&key=a')).toBe(null);
    expect(S.parseShareHash('#/tools/gpu/share?view=detail&key=a')).toBe(null);
    expect(S.parseShareHash('#/tools/bm-usage/share?view=detail&key=a%2Fb')).toBe(null);
    const x = S.parseShareHash('#/tools/bm-usage/share?view=detail&key=k&tab=evil&to=abc&sel=5~1&cur=99999999999999999&disk=rm');
    expect(x).toMatchObject({ key: 'k', tab: 'summary', to: null, sel: null, cursor: null, disk: null });
    const many = S.parseShareHash(`#/tools/bm-usage/share?view=compare&keys=${Array.from({ length: 20 }, (_, i) => `k${i}`).join(',')}`);
    expect(many.keys.length).toBe(8);
    expect(S.shareHashOf({ view: 'detail', key: 'a b' })).toBe('#/tools/bm-usage');
  });
  it('캡처 각주 — 맥락 줄(값 없으면 ‘—’) · 파일 이름 ASCII', () => {
    const f = S.captureFooter({ title: 'T', servers: ['db01'], corps: ['vcA', 'vcA'], from: NOW - H, to: NOW, cursor: null, source: 'OS 13:35', by: 'kim', at: NOW });
    expect(f.length).toBe(4); expect(f[1]).toContain('vcA'); expect(f[1].match(/vcA/g).length).toBe(1); expect(f[3]).toContain('kim');
    expect(S.captureFooter({}).join('\n')).toContain('—');
    expect(captureName('detail-trend', NOW)).toMatch(/^bm-detail-trend_\d{8}-\d{4}\.png$/);
    expect(footerHeight(['a', 'b'])).toBe(56);
  });
  it('SVG 칠 인라인 — 계산값만(var( 가 남은 값은 건드리지 않는다)', () => {
    const set = []; const el = { style: { setProperty: (p, v) => set.push([p, v]) } };
    const root = { querySelectorAll: () => [el] };
    const doc = { defaultView: { getComputedStyle: () => ({ getPropertyValue: (p) => ({ stroke: 'rgb(1, 2, 3)', fill: 'var(--x)', opacity: '0.5' })[p] || '' }) } };
    expect(inlineSvgPaint(doc, root)).toBe(2);
    expect(set).toEqual([['stroke', 'rgb(1, 2, 3)'], ['opacity', '0.5']]);
    expect(inlineSvgPaint({}, root)).toBe(0);
  });
  it('캡처 코어는 하나 — 리포트 저장의 html2canvas 경로(이미 있는 의존성) · 새 캡처 라이브러리 없음', () => {
    const s4 = strip(src('bmCapture.js'));
    expect(s4).toMatch(/from '\.\/reportExport\.js'/);
    expect(s4).not.toMatch(/import\(['"]html2canvas|from ['"](html-to-image|dom-to-image)/);
    const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '../../../package.json'), 'utf8'));
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((k) => /html-to-image|dom-to-image/.test(k))).toEqual([]);
  });
});

describe('진단 플레이북 · 목표선', () => {
  it('문구 표 = 서버 열거(1:1)', () => {
    expect(Object.keys(RB.STEP_KIND_TEXT).sort()).toEqual([...STEP_KINDS].sort());
    expect(Object.keys(RB.SLO_METRIC_TEXT).sort()).toEqual([...SLO_METRICS].sort());
    expect(Object.keys(RB.SLO_BASIS_TEXT).sort()).toEqual([...SLO_BASES].sort());
    expect(Object.keys(RB.SLO_OP_TEXT).sort()).toEqual([...SLO_OPS].sort());
    const looks = new Set(playbookCatalog().flatMap((p) => p.steps.flatMap((x) => x.look || [])));
    for (const l of looks) expect(RB.LOOK_TEXT[l]).toBeTruthy();
    for (const id of allJudgmentIds()) expect(RB.judgmentText(id)).not.toBe('');
  });
  it('플레이북 SSR — 지금 판정에 맞는 것이 열리고 명령은 복사용(자리표시는 서버 값으로) · 포탈은 실행하지 않는다', () => {
    const catalog = { playbooks: playbookCatalog() };
    const pb = { ids: ['use:disk'], matched: [{ id: 'disk-await', ids: ['use:disk'] }], fill: { '{장치}': 'nvme1n1' }, portal: { values: { disk_await_ms: 212, disk_busy_pct: null } } };
    const html = renderToStaticMarkup(h(PlaybookView, { pb, catalog, sel: '', onSel: () => {} }));
    expect(html).toContain('/sys/block/nvme1n1/queue/scheduler'); expect(html).toContain('복사');
    expect(html).toContain('포탈은 실행하지 않습니다'); expect(html).toContain('212ms'); expect(html).not.toContain('NaN');
    expect(html).toContain('#/wiki/pub/search?q=');
  });
  it('목표선 SSR — 달성률 없으면 ‘—’ · 자료 없음 · 정비 창 원천 없음 · 일 추이 결측은 ·', () => {
    const from = NOW - 2 * H; const to = NOW;
    const g = { id: 'x', metric: 'cpu_pct', basis: 'avg', op: 'lt', value: 80, objectivePct: 99, source: 'profile:gpdb' };
    const ev = evaluateGoal(g, [], { from, to, stepMs: 300_000, now: NOW });
    const html = renderToStaticMarkup(h(SloTable, { resp: { items: [{ goal: g, ...ev }] } }));
    expect(html).toContain('자료 없음'); expect(html).toContain('원천 없음'); expect(html).toContain('용도 gpdb'); expect(html).not.toMatch(/>0%</);
    expect(RB.dailySpark([{ pct: 100 }, { pct: null }, { pct: 0 }])).toBe('▁·█');
    expect(RB.violationBands({ items: [{ goal: { metric: 'cpu_pct' }, bands: [{ from: 1, to: 2 }] }, { goal: { metric: 'mem_pct' }, error: 'x' }] })).toEqual({ cpu_pct: [{ from: 1, to: 2 }] });
  });
  it('소스 스윕 — 플레이북 화면은 명령을 보내지 않는다(POST 없음) · 폴링 없음', () => {
    const s5 = strip(src('BmRunbookTabs.jsx')) + strip(src('bmRunbookText.js'));
    expect(s5).not.toMatch(/postJson|sendJson\([^)]*POST/);
    expect(s5).not.toMatch(/setInterval|usePolling/);
  });
});
