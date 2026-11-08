/**
 * 리눅스 성능 6단계 — 서버 비교(2~5대 · 설계 PROFILES §15). 고정하는 규약(security-api.md · idrac-server.md 6단계):
 *   ① 계산(순수): 창 통계는 결측을 0 으로 채우지 않고 센다 · 편차는 결측 뺀 2대 이상 · 최소 0 이면 null · 스큐 후보는 같은 용도 3대 이상 · 지표 화이트리스트
 *   ② 실제 api 라우터: 기본 같은 법인만(other-corp 열은 값 없음) · 범위 계정 cross=1 → 404 · 범위 밖 키와 없는 키는 같은 모양(none) · 상한 400 · 실제 계열(시간 단위 파일)
 *   ③ 엣지 대행: collector 경로(토큰 · 대상 밖) · 중앙 정제(아는 지표만 · 수 · 시각 clamp · 상한) · 구버전 old-version(문구 = 릴리스 노트의 6단계 번호)
 *   ④ 5대 동시 집중: 전 서버 먼저 검사(조회 밖 404 · 쓰기 밖 403 — 아무것도 시작 안 함) · 사유 1회 · 법인 상한 → 대기열 · 감사 origin compare
 *   ⑤ 저장된 세트: 사용자별 · 범위 계정 cross 400 · 상한 · 손상 503 + 보존 + 저장 거부 · 동시 저장 유실 없음
 * 기준 시각: 정시 −30분(v2.517 규약).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bms6cmp-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = '';
process.env.COLLECTOR_TOKEN = 'tok-s6-cmp';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 2, matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }
const M = await import('../src/bmusage/multiCompare.js');

test('① 창 통계 · 표(편차 · 최고 · 스큐) — 결측은 0 이 아니다', () => {
  const from = NOW - HOUR; const to = NOW;
  const pts = [{ t: from + 300_000, avg: 10, max: 10, peak: 40 }, { t: from + 600_000, avg: null, max: null, peak: null }, { t: from + 900_000, avg: 30, max: 30, peak: null }];
  const st = M.seriesStats(pts, { from, to, stepMs: 300_000 });
  assert.equal(st.avg, 20, '값 있는 점만 평균'); assert.equal(st.peak, 40); assert.equal(st.n, 2); assert.equal(st.expected, 12); assert.equal(st.missing, 10, '결측은 센다');
  assert.ok(st.spark.some((p) => p[1] == null), '값 없는 칸은 null(0 으로 채우지 않는다)');
  assert.deepEqual(st.last, { t: from + 900_000, avg: 30, peak: null }, '마지막 점에 피크 표본이 없으면 피크도 없다(평균으로 메우지 않는다 — 반증 F7)');
  assert.equal(st.peakN, 1); assert.equal(st.max, 30, '창 최대(피크 표본 아님)는 따로');
  // 반증 F12 — 1분 간격이면 기대 주기는 창 ÷ 1분(예전: 창 ÷ 5분 = 12 인데 n 60)
  const m1 = Array.from({ length: 60 }, (_, i) => ({ t: from + i * 60_000, avg: 5, max: 5, peak: null }));
  const s1 = M.seriesStats(m1, { from, to, stepMs: 300_000, cycleMs: 60_000 });
  assert.equal(s1.expected, 60); assert.equal(s1.missing, 0); assert.equal(s1.peak, null, '피크 표본 없음 — 피크 —');
  // 반증 F7 — 평균+피크 모드에서 피크 없는 서버가 섞이면 모두 평균으로(다른 양을 섞어 대지 않는다) · 피크 모드는 피크 있는 서버만
  const pc = (key, avg, peak) => ({ key, state: 'ok', series: { cpu_pct: { avg, peak } }, hwValues: {} });
  let mx = M.buildCompareTable([pc('a', 50, 90), pc('b', 60, null)], { metrics: ['cpu_pct'], value: 'avgpeak' });
  assert.equal(mx.rows[0].basis, 'avg'); assert.equal(mx.rows[0].top, 'b', '평균으로 대 보면 b 가 높다(예전: a 의 피크 90 vs b 의 평균 60)');
  mx = M.buildCompareTable([pc('a', 50, 90), pc('b', 60, 70)], { metrics: ['cpu_pct'], value: 'avgpeak' });
  assert.equal(mx.rows[0].basis, 'peak'); assert.equal(mx.rows[0].top, 'a');
  mx = M.buildCompareTable([pc('a', 50, 90), pc('b', 60, null)], { metrics: ['cpu_pct'], value: 'peak' });
  assert.equal(mx.rows[0].dev, null, '피크 모드 — 피크 없는 서버는 판정에서 빠진다(값 있는 서버 1대)');
  assert.equal(M.seriesStats([], { from, to, stepMs: 300_000 }).avg, null);
  const col = (key, v, extra = {}) => ({ key, state: 'ok', series: { cpu_pct: v == null ? { avg: null, peak: null } : { avg: v, peak: v * 1.5, last: { avg: v, peak: v } } }, hwValues: {}, ...extra });
  let tb = M.buildCompareTable([col('a', 10), col('b', 40), col('c', null), { key: 'd', state: 'none' }], { metrics: ['cpu_pct'], value: 'avg' });
  assert.equal(tb.rows[0].dev, 4, '결측(c) · 없음(d)은 빼고 max÷min'); assert.equal(tb.rows[0].top, 'b'); assert.equal(tb.rows[0].devHigh, true);
  assert.equal(tb.rows[0].cells.length, 3, 'none 열은 표에 값 칸이 없다');
  tb = M.buildCompareTable([col('a', 10), col('c', null)], { metrics: ['cpu_pct'], value: 'avg' });
  assert.equal(tb.rows[0].dev, null, '값 있는 서버 2대 미만이면 —');
  tb = M.buildCompareTable([col('a', 0), col('b', 5)], { metrics: ['cpu_pct'], value: 'avg' });
  assert.equal(tb.rows[0].dev, null, '최소가 0 이면 나누지 않는다');
  tb = M.buildCompareTable([col('g1', 10, { purposeGroup: 'gpdb' }), col('g2', 12, { purposeGroup: 'gpdb' }), col('g3', 96, { purposeGroup: 'gpdb' }), col('x', 90)], { metrics: ['cpu_pct'], value: 'avg' });
  assert.deepEqual(tb.rows[0].skew, { group: 'gpdb', key: 'g3' }, '같은 용도 그룹 3대 중 한 대만 높다');
  tb = M.buildCompareTable([col('g1', 10, { purposeGroup: 'gpdb' }), col('g3', 96, { purposeGroup: 'gpdb' })], { metrics: ['cpu_pct'], value: 'avg' });
  assert.equal(tb.rows[0].skew, null, '그룹 2대면 스큐로 단정하지 않는다');
  tb = M.buildCompareTable([col('a', 30), col('b', 80)], { metrics: ['disk_await_ms'] });
  assert.equal(tb.rows[0].scale, 50, '고정 눈금');
  tb = M.buildCompareTable([{ key: 'a', state: 'ok', series: { disk_await_ms: { avg: 18, peak: 212 } } }, col('b', 1)], { metrics: ['disk_await_ms'] });
  assert.equal(tb.rows[0].cells[0].clipped, true, '눈금 밖은 잘림 표시');
  assert.deepEqual(M.parseCompareMetrics('cpu_pct,evil,__proto__,mem_pct'), ['cpu_pct', 'mem_pct'], '화이트리스트');
  assert.deepEqual(M.parseCompareMetrics('', { group: 'hw' }), ['power_w', 'power_cap_pct', 'inlet_c']);
  const w = M.compareWindow({ from: NOW - 40 * 86_400_000, to: NOW, now: NOW });
  assert.equal(w.to - w.from, M.COMPARE_MAX_SPAN_MS, '직접 창은 14일까지');
  assert.equal(M.worstDeviation({ cpu_pct: { ratio: 1.1, out: 'in' }, mem_pct: { ratio: 2.9, out: 'above' }, net_pct: { reason: 'few-weeks' } }).metric, 'mem_pct');
  assert.deepEqual(M.worstDeviation({ cpu_pct: { reason: 'no-history' } }), { reason: 'no-history' });
});

async function setupRouter(t) {
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [] }));
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [
    { id: 'o-a1', name: 'bm-a1', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: [] },
    { id: 'o-a2', name: 'bm-a2', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: [] },
    { id: 'o-b1', name: 'bm-b1', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: [] },
  ] }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true, vcB: true }, osSsh: true, idracTelemetry: false }));
  const poller = await import('../src/bmusage/poller.js');
  poller._setFleetForTest(async () => ({ bareMetal: [
    { serverId: 's-a1', name: 'bm-a1', serviceTag: 'TAGA1', vcenterId: 'vcA' },
    { serverId: 's-a2', name: 'bm-a2', serviceTag: 'TAGA2', vcenterId: 'vcA' },
    { serverId: 's-b1', name: 'bm-b1', serviceTag: 'TAGB1', vcenterId: 'vcB' },
  ], virtualizationHosts: [] }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  const db = await import('../src/bmusage/db.js');
  const rows = [];
  for (let i = 0; i < 12; i++) {
    const ts = NOW - HOUR + (i + 1) * 300_000;
    rows.push({ key: 'TAGA1', ts, cpu_pct: 20 + i, cpu_pct_peak: 60 + i, cpu_pct_peak_at: ts - 1000, mem_pct: 40, disk_busy_pct: 10, os_at: ts });
    rows.push({ key: 'TAGA2', ts, cpu_pct: i % 3 === 0 ? null : 80, cpu_pct_peak: i % 3 === 0 ? null : 99, mem_pct: 60, disk_busy_pct: 30, os_at: ts });
    rows.push({ key: 'TAGB1', ts, cpu_pct: 5, mem_pct: 10, os_at: ts });
  }
  const { config } = await import('../src/config.js');
  await db.insertUsage(rows, config.agent?.name || '');
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { collectorRouter } = await import('../src/routes/collector.js');
  const USERS = {
    viewer: { username: 'v', role: 'viewer', scope: null },
    opA: { username: 'opa', role: 'operator', scope: { vcenters: ['vcA'] } },
    opA2: { username: 'opa2', role: 'operator', scope: { vcenters: ['vcA'] } },
    rw: { username: 'rw', role: 'admin', scope: { vcenters: [], writeVcenters: ['vcA'] } },
    adm: { username: 'adm', role: 'admin', scope: null },
  };
  const app = express();
  app.use('/api/collector', collectorRouter);
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { srv.close(); poller._setFleetForTest(null); });
  return { base: `http://127.0.0.1:${srv.address().port}`, poller };
}

test('② 실제 라우터 — 같은 법인만 · cross 는 전체 범위만 · 범위 밖 = 없음 · 실제 계열', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const { base } = await setupRouter(t);
  const get = async (u, qs) => { const r = await fetch(`${base}/api/tools/bm-usage/compare?${qs}`, { headers: { 'x-u': u } }); return { status: r.status, body: await r.json() }; };
  const r1 = await get('adm', `keys=TAGA1,TAGA2,TAGB1&range=1h&group=util6&value=avg&to=${NOW}&from=${NOW - HOUR}`);
  assert.equal(r1.status, 200, JSON.stringify(r1.body).slice(0, 300));
  assert.equal(r1.body.corp, 'vcA', '첫 서버의 법인');
  const byKey = Object.fromEntries(r1.body.columns.map((c) => [c.key, c]));
  assert.equal(byKey.TAGA1.state, 'ok'); assert.equal(byKey.TAGB1.state, 'other-corp', '같은 법인만 — 다른 법인 열은 값을 당기지 않는다');
  assert.equal(byKey.TAGB1.series, undefined);
  assert.equal(byKey.TAGA1.series.cpu_pct.avg, 25.5, '실제 시간 단위 파일에서 읽은 평균');
  assert.equal(byKey.TAGA2.series.cpu_pct.n, 8, '결측 4점은 세지 않는다');
  assert.ok(byKey.TAGA2.series.cpu_pct.missing >= 4, '결측 수를 밝힌다');
  const cpu = r1.body.table.rows.find((x) => x.col === 'cpu_pct');
  // 다음 점검 ①: 표의 열 식별은 요청한 (법인, 키) 쌍 cid(법인 없이 보냈으면 '|키') — 같은 키 · 다른 법인 두 열이 표에서 섞이지 않게
  assert.equal(cpu.top, '|TAGA2'); assert.equal(byKey.TAGA2.cid, '|TAGA2'); assert.equal(cpu.cells.length, 2, 'other-corp 열은 표에서 빠진다');
  assert.equal(r1.body.crossAllowed, true);
  assert.ok(r1.body.corps.some((c) => c.vcenterId === 'vcA' && c.readAt != null), '법인별 읽은 시각');
  const r2 = await get('adm', `keys=TAGA1,TAGB1&cross=1&range=1h&to=${NOW}&from=${NOW - HOUR}`);
  assert.equal(r2.body.columns.find((c) => c.key === 'TAGB1').state, 'ok', '법인 간 허용이면 섞는다');
  // 범위 계정 — cross=1 은 404(기능 은닉) · 범위 밖 키는 없는 키와 같은 모양
  assert.equal((await get('opA', 'keys=TAGA1,TAGA2&cross=1')).status, 404);
  const r3 = await get('opA', 'keys=TAGA1,TAGB1,NOPE');
  const s3 = Object.fromEntries(r3.body.columns.map((c) => [c.key, c]));
  assert.deepEqual(s3.TAGB1, { key: 'TAGB1', cid: '|TAGB1', state: 'none' }, '범위 밖');
  assert.deepEqual(s3.NOPE, { key: 'NOPE', cid: '|NOPE', state: 'none' }, '없는 키 — 같은 모양(존재 은닉 · cid 는 요청 그대로)');
  assert.equal(r3.body.crossAllowed, false);
  const tooMany = await get('adm', 'keys=a,b,c,d,e,f');
  assert.equal(tooMany.status, 400); assert.equal(tooMany.body.code, 'too-many');
  assert.equal((await get('adm', 'keys=')).status, 400);
  // 비관리자는 주소 가림 표지
  assert.equal(r3.body.addressHidden, true);
});

test('③ 엣지 대행 — collector 경로 · 중앙 정제 · 구버전 old-version(릴리스 노트 6단계 번호)', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const { base } = await setupRouter(t);
  const col = (p) => fetch(`${base}/api/collector${p}`, { headers: { 'X-Collector-Token': 'tok-s6-cmp' } });
  assert.equal((await fetch(`${base}/api/collector/bm-usage/compare-series?key=TAGA1`)).status, 403, '토큰 없음');
  assert.equal((await col('/bm-usage/compare-series?key=NOPE')).status, 404, '대상 밖');
  const ok = await (await col(`/bm-usage/compare-series?key=TAGA1&metrics=cpu_pct,evil&from=${NOW - HOUR}&to=${NOW}`)).json();
  assert.equal(ok.ok, true); assert.deepEqual(Object.keys(ok.metrics), ['cpu_pct'], '화이트리스트 밖 지표 무시');
  const P = await import('../src/central/bmComparePull.js');
  const s = P.sanitizeCompareSeries({ ok: true, key: 'k', evil: 1, from: NOW, to: NOW + 9e9, res: '5m', metrics: { cpu_pct: { avg: '7.5', peak: 'x', last: { t: NOW + 9e9, avg: 1 }, spark: Array.from({ length: 500 }, (_, i) => [NOW + i, i, null]) }, rm_rf: { avg: 1 }, __proto__: { avg: 2 } },
    dev: { cpu_pct: { ratio: '2.5', out: 'evil' }, mem_pct: { reason: 'pwn' }, evil: { ratio: 9 } } }, NOW);
  assert.equal(s.evil, undefined); assert.equal(s.to, NOW, '엣지 미래 시각은 수신 시각으로');
  assert.deepEqual(Object.keys(s.metrics), ['cpu_pct']); assert.equal(s.metrics.cpu_pct.avg, 7.5); assert.equal(s.metrics.cpu_pct.peak, null);
  assert.equal(s.metrics.cpu_pct.spark.length, 120, '스파크 상한'); assert.equal(s.metrics.cpu_pct.last.t, NOW);
  assert.equal(s.dev.cpu_pct.ratio, 2.5); assert.equal(s.dev.cpu_pct.out, 'in'); assert.equal(s.dev.mem_pct.reason, 'no-history'); assert.equal(s.dev.evil, undefined);
  // 구버전 엣지 — 경로 없음(401 · 404) → old-version · 문구의 최소 버전은 릴리스 노트에서
  const http = await import('node:http');
  const mk = (status) => new Promise((r) => { const sv = http.createServer((_q, res) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end('{"error":"x"}'); }); sv.listen(0, '127.0.0.1', () => r(sv)); });
  const s401 = await mk(401);
  t.after(() => s401.close());
  const reg = await import('../src/collector/registry.js');
  assert.equal(reg.addCollector({ id: 'edge-s6old', name: 'edge-s6old', url: `http://127.0.0.1:${s401.address().port}`, token: 'tok-old' }).ok, true);
  const V = (await import('../src/central/featureMinEdgeVersion.js')).stage6MinEdgeVersion();
  const old = await P.pullEdgeCompareSeries('edge-s6old', { key: 'K', metrics: ['cpu_pct'], from: NOW - HOUR, to: NOW });
  assert.equal(old.kind, 'old-version'); assert.ok(old.reason.includes(`v${V}`), '문구의 최소 버전 = 릴리스 노트 6단계(없으면 package.json)');
  // 엣지 위임 서버 — 봉투 보관분이 있으면 엣지 실패 열은 ‘오래됨’(값은 보관분) · 다른 열은 그대로
  const E = await import('../src/central/bmUsageEdgePull.js');
  E.putEdgeBmUsage('edge-s6old', { ok: true, snap: { node: { agent: 'edge-s6old', role: 'edge' }, targets: [{ key: 'EKEY', name: 'bm-e', vcenterId: 'vcA', paths: ['os'] }],
    perf: [{ key: 'EKEY', ts: NOW, verdict: 'ok', coverage: 'os', perResource: { cpu: 'ok' } }], rows: [] } });
  t.after(() => E._resetForTest());
  const r = await (await fetch(`${base}/api/tools/bm-usage/compare?keys=TAGA1,EKEY&range=1h`, { headers: { 'x-u': 'adm' } })).json();
  const e = r.columns.find((c) => c.key === 'EKEY');
  assert.equal(e.state, 'old-version'); assert.equal(e.verdict, 'ok', '보관분 판정은 그대로 싣는다'); assert.equal(e.series, null);
  assert.equal(r.columns.find((c) => c.key === 'TAGA1').state, 'ok', '한 엣지 실패는 그 열만');
  assert.equal(r.minEdgeVersion, V);
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fs.readFileSync(path.join(import.meta.dirname, '../src/central/bmComparePull.js'), 'utf8'));
  assert.doesNotMatch(src, /minVersion:\s*'\d/, '최소 버전을 숫자로 박지 않는다');
});

test('④ 5대 동시 집중 — 전 서버 먼저 검사 · 사유 1회 · 법인 상한 · 감사', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const { base } = await setupRouter(t);
  const F = await import('../src/bmusage/focus/run.js');
  F._resetFocusForTest();
  const timers = [];
  F._setFocusDepsForTest({ loadRules: async () => ({ focus: { intervalS: 60, durationMin: 2, corpMax: 1, nodeMax: 10 }, daily: { manualFocus: 20 } }),
    osAuthStop: async () => null, idracAuthStop: async () => null, collectOs: async () => ({ ok: true }), idracJob: async () => null, prevFor: async () => null,
    recordOsAuth: async () => {}, recordIdracAuth: async () => {}, buildUsage: async () => ({ row: { cpu_pct: 1 }, next: {} }), buildEntry: async () => ({ verdict: 'ok' }),
    hwReader: async () => () => null, rawBefore: async () => ({ rows: [] }), setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; }, clearTimer: () => {} });
  t.after(() => F._resetFocusForTest());
  const post = async (u, body) => { const r = await fetch(`${base}/api/tools/bm-usage/compare/focus`, { method: 'POST', headers: { 'x-u': u, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  assert.equal((await post('viewer', { keys: ['TAGA1'], reason: '보기' })).status, 403);
  assert.equal((await post('opA', { keys: ['TAGA1', 'TAGA2'] })).status, 400, '사유 필수');
  const out = await post('opA', { keys: ['TAGA1', 'TAGB1'], reason: '범위 밖 섞기' });
  assert.equal(out.status, 404, '하나라도 조회 밖이면 404');
  assert.equal(F.focusActiveCount() + F.focusQueuedCount(), 0, '아무것도 시작하지 않았다');
  const wr = await post('rw', { keys: ['TAGA1', 'TAGB1'], reason: '쓰기 밖 섞기' });
  assert.equal(wr.status, 403, '하나라도 쓰기 밖이면 403');
  assert.equal(F.focusActiveCount() + F.focusQueuedCount(), 0, '일부만 시작하지 않는다');
  const ok = await post('opA', { keys: ['TAGA1', 'TAGA2'], reason: '비교 화면 동시 집중' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 300)); assert.equal(ok.body.started, 2);
  assert.deepEqual(ok.body.results.map((r) => r.status).sort(), ['queued', 'running'], '법인 상한 1 → 두 번째는 대기열');
  const audit = await import('../src/audit.js');
  const acts = audit.auditEntriesWithAction('bm-perf.focus').filter((a) => /"origin":"compare"/.test(a.detail || ''));
  assert.equal(acts.length, 2, '서버마다 감사 · 비교에서 건 표지');
});

test('⑤ 저장된 세트 — 사용자별 · 범위 cross 400 · 상한 · 손상 503 · 동시 저장 유실 없음', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const { base } = await setupRouter(t);
  const put = async (u, body) => { const r = await fetch(`${base}/api/tools/bm-usage/compare/sets`, { method: 'PUT', headers: { 'x-u': u, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const list = async (u) => (await (await fetch(`${base}/api/tools/bm-usage/compare/sets`, { headers: { 'x-u': u } })).json());
  assert.equal((await put('viewer', { name: 'x', keys: ['a', 'b'] })).status, 403, '쓰기는 operator 이상');
  assert.equal((await put('opA', { name: '법인 간', keys: ['TAGA1', 'TAGB1'], cross: true })).status, 400, '범위 계정은 cross 세트 불가');
  const a = await put('opA', { name: '  DB 2대\u0007 ', keys: ['TAGA1', 'TAGA2', 'TAGA2'] });
  assert.equal(a.status, 200); assert.equal(a.body.set.name, 'DB 2대', '제어문자 제거'); assert.deepEqual(a.body.set.keys, ['TAGA1', 'TAGA2']);
  assert.equal((await list('opA2')).sets.length, 0, '사용자별');
  assert.equal((await put('opA', { name: 'x', keys: ['a'] })).status, 400, '2대 미만');
  assert.equal((await put('opA', { name: 'x', keys: ['a', 'b', 'c', 'd', 'e', 'f'] })).status, 400, '상한 초과');
  // 동시 저장 — 읽기-수정-쓰기가 한 동기 구간이라 유실 없음
  await Promise.all(Array.from({ length: 10 }, (_, i) => put('opA2', { name: `s${i}`, keys: ['TAGA1', 'TAGA2'] })));
  assert.equal((await list('opA2')).sets.length, 10, '동시 저장 10건 전부 남는다');
  for (let i = 10; i < 20; i++) assert.equal((await put('opA2', { name: `s${i}`, keys: ['a', 'b'] })).status, 200);
  assert.equal((await put('opA2', { name: 's20', keys: ['a', 'b'] })).status, 409, '사용자당 상한');
  const del = await fetch(`${base}/api/tools/bm-usage/compare/sets/${a.body.set.id}`, { method: 'DELETE', headers: { 'x-u': 'opA2' } });
  assert.equal(del.status, 404, '남의 세트는 못 지운다');
  assert.equal((await fetch(`${base}/api/tools/bm-usage/compare/sets/${a.body.set.id}`, { method: 'DELETE', headers: { 'x-u': 'opA' } })).status, 200);
  // 손상 → 보존 + 503 + 저장 거부(빈 목록으로 덮어 다른 사용자의 세트를 지우지 않는다)
  const f = path.join(DIR, 'bm-perf-compare-sets.json');
  fs.writeFileSync(f, '{"users": [ broken');
  const bad = await fetch(`${base}/api/tools/bm-usage/compare/sets`, { headers: { 'x-u': 'opA2' } });
  assert.equal(bad.status, 503);
  assert.ok(fs.readdirSync(DIR).some((x) => x.startsWith('bm-perf-compare-sets.json.corrupt')), '손상본 보존');
  assert.equal((await put('opA2', { name: 'after', keys: ['a', 'b'] })).status, 503, '못 읽은 동안 저장 거부');
});
