/**
 * 데이터 흐름 지도(v2.587) 회귀 — 이 화면이 만들 수 있는 거짓을 막는다:
 *   ① 경로 목록이 실제 라우터와 어긋나기(손 등록) · 분류되지 않은 경로가 조용히 사라지기
 *   ② 기록 없는 연결을 '정상' 으로 칠하기  ③ 회복된 옛 실패가 방금 성공을 덮기
 *   ④ 주기가 긴 경로를 숫자 하나로 '낡음' 처리하기  ⑤ 증명 못 한 이름을 신뢰하기
 *   ⑥ 계측기 — GET 은 선언 경로로만 키를 만든다 · 중앙→엣지 기록은 쿼리(토큰)를 버린다
 *   ⑦ 라우트 — admin 200 · 범위 계정 403 · 응답에 토큰 없음
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'df2587-'));
process.env.CONFIG_DIR = DIR;

const { buildDataFlow, linkState, kindOf, catOf, CATS, STALE_MIN_MS, STALE_FACTOR } = await import('../src/dataflow/build.js');
const { declaredRoutes } = await import('../src/routes/api/dataFlow.js');
const { recordPull, pullStats, resetPullStats } = await import('../src/central/pullStats.js');
const { recordOutbound, outboundStats, resetOutboundStats } = await import('../src/util/outboundStats.js');

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000; // 경계에서 떨어진 고정 기준(v2.517 규약)

test('① 경로는 실제 라우터 선언에서 오고 전부 분류된다', () => {
  const routes = declaredRoutes();
  assert.ok(routes.length >= 58, `선언 경로 ${routes.length}`);
  assert.ok(routes.some((r) => r.side === 'central' && r.path === '/inventory' && r.method === 'POST'));
  assert.ok(routes.some((r) => r.side === 'collector' && r.path === '/export' && r.method === 'GET'));
  const f = buildDataFlow({ now: NOW, routes });
  assert.deepEqual(f.unmapped, [], '새 경로는 dataflow/build.js CATS 에 분류해야 한다');
  assert.equal(f.routes.length, new Set(routes.map((r) => `${r.side}:${r.method} ${r.path}`)).size);
  assert.equal(f.cats.reduce((a, c) => a + c.routes, 0), f.routes.length, '종류별 합 = 경로 수');
  assert.ok(f.cats.every((c) => CATS.some((d) => d.id === c.id)), '기타 종류 없음');
});

test('① 모르는 경로는 버리지 않고 other/undeclared 로 밝힌다', () => {
  const f = buildDataFlow({ now: NOW, routes: [{ side: 'central', method: 'POST', path: '/zzz-new' }],
    ingest: { rows: [{ agent: 'gm1', byEndpoint: [{ endpoint: '/old-path', count: 1, lastAt: NOW - 1000 }] }] } });
  assert.deepEqual(f.unmapped.sort(), ['central:POST /old-path', 'central:POST /zzz-new']);
  assert.deepEqual(f.undeclared, ['central:POST /old-path']);
  assert.ok(f.cats.some((c) => c.id === 'other'));
});

test('방향 분류', () => {
  assert.equal(kindOf('central', 'POST', '/storage-data'), 'push');
  assert.equal(kindOf('central', 'POST', '/idrac-scan-result'), 'reply');
  assert.equal(kindOf('central', 'GET', '/storage-config'), 'pull');
  assert.equal(kindOf('central', 'GET', '/capture-jobs'), 'job');
  assert.equal(kindOf('central', 'POST', '/rma-poll'), 'job');
  assert.equal(kindOf('collector', 'GET', '/export'), 'cpull');
  assert.equal(kindOf('collector', 'POST', '/upgrade'), 'cpush');
  assert.equal(catOf('central', '/gpu-guest-data'), 'gpu');
  assert.equal(catOf('central', '/pdu-data'), 'power');
  assert.equal(catOf('collector', '/idrac-scan'), 'idrac');
});

test('② 기록 없는 연결은 만들지 않고 경로는 none', () => {
  const f = buildDataFlow({ now: NOW, routes: [{ side: 'central', method: 'POST', path: '/inventory' }], collectors: [{ id: 'gm1', url: 'https://10.0.0.1:3000' }] });
  assert.equal(f.links.length, 0);
  assert.equal(f.routes[0].state, 'none');
  assert.equal(f.totals.routesNone, 1);
  assert.equal(linkState({ now: NOW }), null);
});

test('③ 실패가 성공보다 뒤일 때만 fail', () => {
  assert.equal(linkState({ okAt: NOW - 1000, failAt: NOW - 500, now: NOW }), 'fail');
  assert.equal(linkState({ okAt: NOW - 500, failAt: NOW - 1000, now: NOW }), 'ok');
});

test('④ 낡음 경계는 관측 간격 × 계수, 하한 있음', () => {
  // 1시간 주기 경로가 20분 전 → 정상(숫자 하나였다면 낡음이 됐다)
  assert.equal(linkState({ okAt: NOW - 20 * 60_000, intervalMs: HOUR, now: NOW }), 'ok');
  assert.equal(linkState({ okAt: NOW - (STALE_FACTOR * HOUR + 60_000), intervalMs: HOUR, now: NOW }), 'stale');
  // 간격을 모르면 하한
  assert.equal(linkState({ okAt: NOW - STALE_MIN_MS + 1000, now: NOW }), 'ok');
  assert.equal(linkState({ okAt: NOW - STALE_MIN_MS - 1000, now: NOW }), 'stale');
});

test('⑤ 증명 못 한 이름은 unverified · 등록부 밖 이름은 노드로 남긴다', () => {
  const f = buildDataFlow({ now: NOW, routes: [{ side: 'central', method: 'GET', path: '/storage-config' }, { side: 'central', method: 'POST', path: '/inventory' }],
    collectors: [{ id: 'gm1', name: 'GM1', url: 'https://10.0.0.1:3000' }],
    pulls: { rows: [{ agent: 'GM1', verified: false, byEndpoint: [{ endpoint: '/storage-config', count: 2, lastOkAt: NOW - 1000, lastFailAt: 0 }] }] },
    rejects: { rows: [{ agent: 'ghost', total: 3 }], recent: [{ at: NOW - 100, agent: 'ghost', endpoint: '/inventory', kind: 'auth', reason: '토큰 불일치' }] } });
  const pull = f.links.find((l) => l.route === 'central:GET /storage-config');
  assert.equal(pull.edge, 'gm1', '표시 이름은 id 로 접는다');
  assert.equal(pull.unverified, true);
  const rej = f.links.find((l) => l.route === 'central:POST /inventory');
  assert.equal(rej.state, 'fail'); assert.equal(rej.unverified, true); assert.equal(rej.reason, '토큰 불일치');
  const ghost = f.edges.find((e) => e.name === 'ghost');
  assert.equal(ghost.registered, false); assert.equal(ghost.unverifiedOnly, true);
  assert.equal(f.rejectsWithoutTime, 2, '원문이 밀려난 거부 수를 밝힌다');
});

test('중앙→엣지 기록은 origin 으로 엣지에 붙는다', () => {
  const f = buildDataFlow({ now: NOW, routes: [{ side: 'collector', method: 'GET', path: '/export' }], collectors: [{ id: 'gm1', url: 'https://10.0.0.1:3000/sub' }],
    outbound: { rows: [{ origin: 'https://10.0.0.1:3000', path: '/api/collector/export', method: 'GET', count: 4, lastOkAt: NOW - 30_000, lastFailAt: NOW - 10_000, lastError: 'ETIMEDOUT' },
      { origin: 'https://10.0.0.1:3000', path: '/api/central/inventory', method: 'POST', count: 1, lastOkAt: NOW }] } });
  assert.equal(f.links.length, 1, '/api/central/* (이 노드가 엣지일 때의 기록)는 중앙 지도에 넣지 않는다');
  assert.equal(f.links[0].edge, 'gm1'); assert.equal(f.links[0].state, 'fail'); assert.equal(f.links[0].reason, 'ETIMEDOUT');
});

test('⑥ outboundStats — 추적 경로만 · 쿼리를 버린다', () => {
  resetOutboundStats();
  recordOutbound('https://10.0.0.1:3000/api/collector/export?token=SECRET', { status: 200, bytes: 10 });
  recordOutbound('https://10.0.0.1:3000/api/collector/export?x=1', { error: 'ECONNRESET' });
  recordOutbound('https://example.com/other', { status: 200 });
  const rows = outboundStats().rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, '/api/collector/export');
  assert.equal(rows[0].okCount, 1); assert.equal(rows[0].failCount, 1);
  assert.ok(!JSON.stringify(rows).includes('SECRET'));
});

test('⑥ resilientFetch 는 포탈 사이 호출을 기록한다(성공·실패 모두)', async () => {
  resetOutboundStats();
  const http = await import('node:http');
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { resilientFetch } = await import('../src/util/resilientFetch.js');
  const url = `http://127.0.0.1:${srv.address().port}/api/collector/ping?t=1`;
  try { await resilientFetch(url, { retries: 0, timeoutMs: 3000 }); } catch { /* SSRF 가드가 루프백을 막아도 실패로 기록돼야 한다 */ }
  srv.close();
  const rows = outboundStats().rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, '/api/collector/ping');
  assert.equal(rows[0].count, 1);
});

test('⑥ 중앙 라우터 GET 은 선언 경로로 기록된다(매칭 안 된 요청은 제외)', async () => {
  resetPullStats();
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express(); app.use('/api/central', centralRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api/central`;
  await fetch(`${base}/storage-config?agent=gm1`).then((r) => r.text());
  await fetch(`${base}/no-such-route-${'x'.repeat(40)}`).then((r) => r.text());
  srv.close();
  const rows = pullStats().rows;
  const eps = rows.flatMap((r) => r.byEndpoint.map((e) => e.endpoint));
  assert.ok(eps.every((e) => !e.startsWith('/no-such-route')), '없는 경로로 키를 만들지 않는다');
  // 토큰 없는 요청은 인증에서 막힌다(라우트 매칭 전) — 그래도 선언 경로라 **실패로** 기록돼야 한다
  const blocked = rows.find((r) => r.agent === 'gm1')?.byEndpoint.find((x) => x.endpoint === '/storage-config');
  assert.ok(blocked, '막힌 pull 도 기록한다');
  assert.equal(blocked.failCount, 1); assert.equal(blocked.okCount, 0);
  for (const r of rows) assert.equal(r.verified, false);
  recordPull('gm1', '/storage-config', { status: 200, verified: true, now: NOW });
  recordPull('gm1', '/storage-config', { status: 403, now: NOW + 60_000 });
  const e = pullStats().rows.find((r) => r.agent === 'gm1').byEndpoint.find((x) => x.endpoint === '/storage-config');
  assert.equal(e.okCount >= 1 && e.failCount >= 1, true);
  assert.equal(e.intervalMs, 60_000);
});

test('⑦ 라우트 — admin 200 · 범위 계정 403 · 응답에 토큰 없음', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df2587r-'));
  fs.writeFileSync(path.join(dir, 'collectors.json'), JSON.stringify({ collectors: [{ id: 'gm1', name: 'GM1', url: 'https://127.0.0.1:1/x?token=Q', token: 'SECRET-TOKEN-XYZ', enabled: true }] }));
  const script = `
    process.env.CONFIG_DIR = ${JSON.stringify(dir)}; process.env.DATA_SOURCE = 'mock'; process.env.AUTH_ENABLED = 'false'; process.env.COLLECTOR_PULL_INTERVAL_MS = '0';
    const express = (await import('express')).default;
    const { store } = await import('../src/store.js');
    try { await store.refresh(); } catch {}
    const { api } = await import('../src/routes/api.js');
    const app = express();
    app.use((req, _res, next) => { req.user = req.get('x-s') ? { username: 'sc', role: 'viewer', scope: { vcenters: ['x'] } } : { username: 'ad', role: 'admin', scope: null }; next(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const a = await fetch(base + '/api/tools/data-flow'); const at = await a.text();
    const s = await fetch(base + '/api/tools/data-flow', { headers: { 'x-s': '1' } });
    console.log(JSON.stringify({ a: a.status, s: s.status, hasToken: at.includes('SECRET-TOKEN') || at.includes('token=Q'), body: JSON.parse(at) }));
    srv.close(); process.exit(0);
  `;
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 });
  const r = JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).pop());
  assert.equal(r.a, 200); assert.equal(r.s, 403); assert.equal(r.hasToken, false);
  assert.equal(r.body.ok, true);
  assert.ok(r.body.routes.length >= 58);
  assert.deepEqual(r.body.unmapped, []);
  assert.equal(r.body.edges[0].origin, 'https://127.0.0.1:1');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('웹 문구·색 키가 서버 코드와 1:1(한쪽만 늘면 화면이 코드를 그대로 보여준다)', async () => {
  const { KINDS } = await import('../src/dataflow/build.js');
  const web = fs.readFileSync(new URL('../../web/src/views/tools/dataFlowText.js', import.meta.url), 'utf8');
  const block = (name) => web.slice(web.indexOf(`export const ${name}`), web.indexOf('});', web.indexOf(`export const ${name}`)));
  const keysOf = (name) => [...block(name).matchAll(/\b([a-z]+): '/g)].map((m) => m[1]);
  assert.deepEqual(keysOf('KIND_LABEL').sort(), [...KINDS].sort());
  assert.deepEqual(keysOf('KIND_SHORT').sort(), [...KINDS].sort());
  const catIds = [...block('CAT_COLOR').matchAll(/([a-z]+): '#/g)].map((m) => m[1]);
  for (const c of [...CATS.map((x) => x.id), 'other']) assert.ok(catIds.includes(c), `CAT_COLOR 에 ${c}`);
});
