/**
 * audit2601f.test.js — v2.601 감사 수정 그룹 f(웹·지도·점검) 서버 회귀.
 *
 *  · WEB2601-01 경로 접두가 있는 수집 서버 URL(`https://gw/siteA`)의 중앙 → 엣지 호출이 기록되고 그 엣지에 붙는다.
 *  · WEB2601-02 같은 주소를 쓰는 두 수집 서버의 기록을 첫 엣지에 합치지 않는다(태그 있으면 그 엣지, 없으면 모호로 밝힘).
 *  · WEB2601-06 한 번도 성공하지 못한 엣지의 첫 실패는 ok:false · at:null(깜빡임 유예는 직전까지 정상이던 엣지만).
 *
 * 기준 시각에 Date.now() 를 쓰지 않는다(CLAUDE.md v2.517) — 판정 입력은 고정 NOW, 실제 pull 은 상태 필드만 본다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2601f-'));
process.env.SSRF_ALLOW_LOOPBACK = 'true'; // 로컬 목 엣지(127.0.0.1)로 실제 pull 을 돌린다

const { recordOutbound, outboundStats, resetOutboundStats, withOutboundTag, isTrackedPath } = await import('../src/util/outboundStats.js');
const { buildDataFlow, baseOf } = await import('../src/dataflow/build.js');
const { buildDeviceFlow } = await import('../src/devflow/build.js');

const NOW = 1_800_000_000_000;
const ROUTES = [{ side: 'collector', method: 'GET', path: '/export' }, { side: 'collector', method: 'GET', path: '/token-check' }];

test('WEB2601-01 outboundStats — 경로 접두가 있어도 기록하고 base 를 따로 싣는다(쿼리는 버린다)', () => {
  resetOutboundStats();
  recordOutbound('https://gw.example:8443/siteA/api/collector/export?token=SECRET', { status: 200, bytes: 5 });
  recordOutbound('https://gw.example:8443/api/collector/export', { status: 200 });
  recordOutbound('https://gw.example:8443/siteA/other', { status: 200 });
  const rows = outboundStats().rows;
  assert.equal(rows.length, 2, '추적 경로 2건만(경로 접두 행 포함) — 예전엔 접두 행이 조용히 버려졌다');
  const a = rows.find((r) => r.base.endsWith('/siteA'));
  assert.ok(a, JSON.stringify(rows));
  assert.equal(a.path, '/api/collector/export');
  assert.equal(a.origin, 'https://gw.example:8443');
  assert.ok(!JSON.stringify(rows).includes('SECRET'));
  assert.equal(isTrackedPath('/siteA/api/central/inventory'), true);
  assert.equal(isTrackedPath('/siteA/other'), false);
});

test('WEB2601-02 outboundStats — withOutboundTag 는 await 너머까지 태그를 싣고 키를 나눈다', async () => {
  resetOutboundStats();
  await withOutboundTag('edge-a', async () => { await new Promise((r) => setTimeout(r, 1)); recordOutbound('http://127.0.0.1:4864/api/collector/export', { status: 200 }); });
  await withOutboundTag('edge-b', async () => { recordOutbound('http://127.0.0.1:4864/api/collector/export', { status: 403 }); });
  recordOutbound('http://127.0.0.1:4864/api/collector/export', { status: 200 }); // 태그 없음
  const rows = outboundStats().rows;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.tag).sort(), ['', 'edge-a', 'edge-b']);
  assert.equal(rows.find((r) => r.tag === 'edge-b').failCount, 1);
});

test('WEB2601-01·02 dataflow — 경로 접두 엣지는 제 노드에, 같은 주소 두 엣지는 태그로 나누고 태그 없는 기록은 합치지 않는다', () => {
  assert.equal(baseOf('https://gw/siteA/'), 'https://gw/siteA');
  assert.equal(baseOf('http://127.0.0.1:4864'), 'http://127.0.0.1:4864');
  const collectors = [
    { id: 'edge-path', url: 'https://gw/siteA' },
    { id: 'edge-other', url: 'https://gw/siteB' },
    { id: 'edge-self', url: 'http://127.0.0.1:4864' },
    { id: 'edge-bad', url: 'http://127.0.0.1:4864' },
  ];
  const outbound = { rows: [
    { origin: 'https://gw', base: 'https://gw/siteA', path: '/api/collector/export', tag: '', method: 'GET', count: 3, lastOkAt: NOW - 1000 },
    { origin: 'http://127.0.0.1:4864', base: 'http://127.0.0.1:4864', path: '/api/collector/export', tag: 'edge-self', method: 'GET', count: 5, lastOkAt: NOW - 1000 },
    { origin: 'http://127.0.0.1:4864', base: 'http://127.0.0.1:4864', path: '/api/collector/export', tag: 'edge-bad', method: 'GET', count: 5, failCount: 5, lastFailAt: NOW - 1000, lastError: 'HTTP 403' },
    { origin: 'http://127.0.0.1:4864', base: 'http://127.0.0.1:4864', path: '/api/collector/token-check', tag: '', method: 'GET', count: 2, lastOkAt: NOW - 500 },
  ] };
  const f = buildDataFlow({ now: NOW, routes: ROUTES, collectors, outbound });
  const byEdge = (id) => f.links.filter((l) => l.edge === id);
  assert.equal(byEdge('edge-path').length, 1, '경로 접두 엣지에 기록이 붙는다');
  assert.equal(byEdge('edge-other').length, 0, '같은 origin 의 다른 경로 엣지에 섞이지 않는다');
  assert.equal(byEdge('edge-self')[0].state, 'ok');
  assert.equal(byEdge('edge-bad')[0].state, 'fail', '매분 403 인 엣지가 회색(기록 없음)이 아니다');
  assert.equal(f.links.filter((l) => l.route.endsWith('/token-check')).length, 0, '태그 없는 같은 주소 기록은 어느 엣지에도 붙이지 않는다');
  assert.equal(f.sharedUrl.length, 1);
  assert.deepEqual(f.sharedUrl[0].edges.sort(), ['edge-bad', 'edge-self']);
  assert.equal(f.sharedUrl[0].origin, 'http://127.0.0.1:4864');
  assert.deepEqual(f.edges.find((e) => e.id === 'edge-self').sharedUrlWith, ['edge-bad']);
  assert.equal(f.edges.find((e) => e.id === 'edge-path').sharedUrlWith, undefined);
  // 3단 지도도 같은 사실을 싣는다
  const d = buildDeviceFlow({ now: NOW, comm: { edges: [{ id: 'edge-self', name: 'edge-self' }] }, flow: f });
  assert.deepEqual(d.edges.find((e) => e.id === 'edge-self').sharedUrlWith, ['edge-bad']);
  assert.equal(d.sharedUrl.length, 1);
});

test('WEB2601-06 puller — 한 번도 성공 못 한 엣지의 첫 실패는 ok:false·at:null, 성공 이력이 있으면 한 주기 유예 · 호출에 수집 서버 태그', async () => {
  let mode = 'fail';
  const srv = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'fail') { res.statusCode = 404; res.end('{}'); return; }
    res.end(JSON.stringify({ power: { byHost: [] }, servers: [], version: '2.601.0' }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const { addCollector } = await import('../src/collector/registry.js');
    const { pullNow } = await import('../src/collector/puller.js');
    const { getCollectorStatus } = await import('../src/collector/state.js');
    const port = srv.address().port;
    const r = addCollector({ id: 'edge-never', name: 'edge-never', url: `http://127.0.0.1:${port}/siteA`, token: 't', enabled: true });
    assert.ok(r?.ok !== false, JSON.stringify(r));
    resetOutboundStats();
    await pullNow();
    const st = getCollectorStatus('edge-never');
    assert.equal(st.ok, false, '닿은 적 없는 엣지를 정상(저하)으로 두지 않는다');
    assert.equal(st.degraded, false);
    assert.equal(st.at, null, 'at 은 마지막 정상 pull — 실패 시각을 넣지 않는다(v2.548 H5)');
    assert.equal(st.neverOk, true);
    const row = outboundStats().rows.find((x) => x.path === '/api/collector/export');
    assert.ok(row, '경로 접두 URL 의 pull 도 기록된다');
    assert.equal(row.tag, 'edge-never');
    assert.ok(row.base.endsWith('/siteA'));
    // 성공 후 첫 실패는 예전처럼 한 주기 유예(깜빡임 방지) — 직전 at 을 유지한다
    mode = 'ok';
    await pullNow();
    const okSt = getCollectorStatus('edge-never');
    assert.equal(okSt.ok, true); assert.ok(okSt.at > 0); assert.equal(okSt.neverOk, undefined);
    mode = 'fail';
    await pullNow();
    const deg = getCollectorStatus('edge-never');
    assert.equal(deg.ok, true); assert.equal(deg.degraded, true); assert.equal(deg.at, okSt.at);
    await pullNow();
    assert.equal(getCollectorStatus('edge-never').ok, false);
    assert.equal(getCollectorStatus('edge-never').at, okSt.at);
  } finally { srv.close(); }
});

/* ── 후속(코디네이터 지시): ① temps 주기 ③ 다른 중앙 → 엣지 호출 태그 ④ edge.reportAt ─────────── */

test('WEB2601-05 후속 — /admin/idrac/temps 응답이 수집 주기(intervalMs)를 싣는다', async () => {
  const { adminRouter } = await import('../src/routes/admin.js');
  const { config } = await import('../src/config.js');
  const layer = adminRouter.stack.find((l) => l.route?.path === '/idrac/temps' && l.route.methods.get);
  assert.ok(layer);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const body = await new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve(b); } };
    try { handler({ query: {}, user: { username: 't', role: 'admin' } }, res, reject); } catch (e) { reject(e); }
  });
  assert.equal(body.intervalMs, config.idrac.pollIntervalMs);
  assert.ok(body.intervalMs > 0);
});

test('WEB2601-02 후속 — 토큰 점검·엣지 로그·사용률·ping 프로브·번들 push 도 수집 서버 태그를 싣는다', async () => {
  const srv = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.statusCode = 404; res.end('{}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const { addCollector } = await import('../src/collector/registry.js');
    const url = `http://127.0.0.1:${srv.address().port}`;
    assert.ok(addCollector({ id: 'tag-a', name: 'tag-a', url, token: 't', enabled: true })?.ok !== false);
    resetOutboundStats();
    const { pullTokenCheck } = await import('../src/central/tokenCheckPull.js');
    const { pullEdgeLog } = await import('../src/central/edgeLogPull.js');
    const { pullBmUsage } = await import('../src/central/bmUsageEdgePull.js');
    const { probeCollectorPing } = await import('../src/portalcheck/tokenProbe.js');
    const { pushBundleToCollector } = await import('../src/collector/upgradePush.js');
    await pullTokenCheck('tag-a');
    await pullEdgeLog('tag-a');
    await pullBmUsage('tag-a');
    await probeCollectorPing({ url, agent: 'tag-a', collector: { set: true } }, { token: 't' });
    await pushBundleToCollector({ id: 'tag-a', url, token: 't' }, Buffer.from('x'), { timeout: 5000 });
    const { pushIdracScan } = await import('../src/central/idracScanPush.js');
    const pr = pushIdracScan('tag-a', { ips: ['10.9.9.9'], username: 'u', password: 'p' });
    assert.equal(pr.ok, true, JSON.stringify(pr));
    for (let i = 0; i < 100 && !outboundStats().rows.some((x) => x.path === '/api/collector/idrac-scan'); i++) await new Promise((r) => setTimeout(r, 50));
    const rows = outboundStats().rows;
    for (const p of ['/api/collector/token-check', '/api/collector/edge-log', '/api/collector/bm-usage', '/api/collector/ping', '/api/collector/upgrade', '/api/collector/idrac-scan']) {
      const r = rows.find((x) => x.path === p);
      assert.ok(r, `${p} 기록`);
      assert.equal(r.tag, 'tag-a', `${p} 태그`);
    }
  } finally { srv.close(); }
});

test('WEB2601-03 후속 — mergeEdgeReport 가 reportAt 을 따로 싣는다(at 은 호환상 마지막 시도)', async () => {
  const { mergeEdgeReport } = await import('../src/portalcheck/tokenScan.js');
  const out = mergeEdgeReport({ rows: [{ agent: 'e1' }, { agent: 'e2' }] }, [
    { agent: 'e1', at: NOW, ok: false, kind: 'auth', reportAt: null, report: null, lastAttempt: { at: NOW, ok: false, kind: 'auth' } },
    { agent: 'e2', at: NOW, ok: false, kind: 'timeout', reportAt: NOW - 60_000, report: { tokens: {}, node: { agent: 'e2' } }, lastAttempt: { at: NOW, ok: false } },
  ]);
  const e1 = out.rows.find((r) => r.agent === 'e1').edge;
  const e2 = out.rows.find((r) => r.agent === 'e2').edge;
  assert.equal(e1.reportAt, null); assert.equal(e1.at, NOW);
  assert.equal(e2.reportAt, NOW - 60_000);
});
