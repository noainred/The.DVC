/**
 * v2.742 감사 그룹 c — 엣지 계약(export 센서 상세 변경분 · 지속형 503 · vCenter 라이선스·솔루션 정제).
 *
 * EDGE-01 엣지 export 가 60초 pull 마다 전 서버의 센서 상세를 다시 싣던 것 → 바뀐 서버만(커서 sdSince/sdCursor).
 *   구버전 중앙(쿼리 없음)·구버전 엣지(쿼리 무시)·잘못된 커서는 예전처럼 전량이고, 뺀 서버는 중앙이 직전 상세를 그대로 쓴다.
 * EDGE-03 중앙 지속형 503(등록부·설정 손상 · DB 불가)에 Retry-After · 큰 본문 push(isidu·edge-log-result)는 503 을 호출 안에서 다시 보내지 않는다.
 * VC-07 /inventory 의 vcenter.licenses·solutions 를 배열·객체 원소·아는 필드·상한으로 좁히고 뺀 개수를 밝힌다.
 * 전부 실제 함수·실제 라우터(collectorRouter·centralRouter·puller)를 호출해 동작으로 본다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2742c-'));
Object.assign(process.env, {
  CONFIG_DIR: CFG, CENTRAL_TOKEN: 'shared-2742c', COLLECTOR_TOKEN: 'col-2742c', AGENT_NAME: 'edge-gc-a',
  DATA_SOURCE: 'live', AUTH_ENABLED: 'true', IPAM_WRITE_WORKER: '0', SSRF_ALLOW_LOOPBACK: 'true',
});
fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: [] }));
// 엣지 쪽 iDRAC 등록부(같은 프로세스가 엣지 export 와 중앙 pull 을 모두 한다).
fs.writeFileSync(path.join(CFG, 'idrac.json'), JSON.stringify({ servers: [
  { id: 's1', name: 'srv-1', host: 'https://10.9.0.1', username: 'root', password: 'x' },
  { id: 's2', name: 'srv-2', host: 'https://10.9.0.2', username: 'root', password: 'x' },
  { id: 's3', name: 'srv-3', host: 'https://10.9.0.3', username: 'root', password: 'x' },
] }));
// EDGE-03: 손상된 iDRAC 스캔 배정 파일 — /assignment 가 settingsUnreadable 503 으로 답해야 한다.
fs.writeFileSync(path.join(CFG, 'agent-assignments.json'), '{ broken');

const express = (await import('express')).default;
const { collectorRouter } = await import('../src/routes/collector.js');
const { centralRouter } = await import('../src/routes/central.js');

const seen = [];
const app = express();
app.use((req, _res, next) => { if (req.path === '/api/collector/export') seen.push(req.originalUrl); next(); });
app.use('/api/collector', collectorRouter);
app.use(express.json({ limit: '8mb' }));
app.use('/api/central', centralRouter);
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const BASE = `http://127.0.0.1:${srv.address().port}`;
test.after(() => srv.close());
const H = { 'Content-Type': 'application/json', 'X-Central-Token': 'shared-2742c' };

const therm = (reading, at) => [
  { name: 'System Board Inlet Temp', kind: 'temperature', reading, unit: 'Cel', health: 'OK', thresholds: { warnMax: 42, critMax: 47 }, source: 'thermal' },
  { name: 'CPU1 Temp', kind: 'temperature', reading: reading + 30, unit: 'Cel', health: 'OK', thresholds: { critMax: 95 }, source: 'thermal' },
];
const T_PAST = Date.now() - 120_000;

// ─── EDGE-01 ──────────────────────────────────────────────────────────────────

test('EDGE-01(엣지): 커서 뒤로 바뀌지 않은 서버의 상세는 빼고 표지만 싣는다 — 잘못된 커서·쿼리 없음은 전량', async () => {
  const cache = await import('../src/idrac/sensorDetailCache.js');
  const agent = await import('../src/collector/agent.js');
  agent._resetSensorDetailDeltaForTest?.();
  for (const id of ['s1', 's2', 's3']) cache.setThermalDetail(id, therm(22, T_PAST), T_PAST);

  const full = await agent.buildExport();
  assert.equal(full.servers.length, 3);
  assert.ok(full.servers.every((s) => s.sensorDetail && s.sensorDetail.list.length === 2), '첫 export 는 전량');
  assert.match(String(full.sdCursor), /^[0-9a-f]{12}:\d+$/, '커서를 싣는다(수정 전: 없음)');
  assert.equal(full.sensorDetailOmitted, 0);

  const same = await agent.buildExport({ sdSince: full.sdCursor });
  assert.equal(same.sensorDetailOmitted, 3, '변경 없음 → 3대 모두 뺀다');
  assert.ok(same.servers.every((s) => s.sensorDetail == null && s.sensorDetailSame === true));
  assert.equal(same.sdCursor, full.sdCursor, '바뀐 것이 없으면 세대가 그대로다');

  cache.setThermalDetail('s2', therm(25, T_PAST + 60_000), T_PAST + 60_000);
  const one = await agent.buildExport({ sdSince: full.sdCursor });
  assert.equal(one.sensorDetailOmitted, 2);
  const s2 = one.servers.find((s) => s.id === 's2');
  assert.ok(s2.sensorDetail && !s2.sensorDetailSame, '바뀐 서버만 상세를 싣는다');
  assert.notEqual(one.sdCursor, full.sdCursor);

  const boot = String(full.sdCursor).split(':')[0];
  const other = boot === 'aaaaaaaaaaaa' ? 'bbbbbbbbbbbb' : 'aaaaaaaaaaaa';
  for (const bad of ['zzz', `${other}:1`, `${boot}:999999`, `${boot}:-1`, '', 12]) {
    const r = await agent.buildExport({ sdSince: bad });
    assert.equal(r.sensorDetailOmitted, 0, `잘못된 커서(${JSON.stringify(bad)})는 전량`);
    assert.ok(r.servers.every((s) => s.sensorDetail && !s.sensorDetailSame));
  }
});

test('EDGE-01(라우트+pull): 실제 collectorRouter 와 puller — 두 번째 pull 부터 커서를 보내고, 뺀 서버는 직전 상세로 채워 전량과 같다', async () => {
  const cache = await import('../src/idrac/sensorDetailCache.js');
  const agent = await import('../src/collector/agent.js');
  const inv = await import('../src/collector/remoteInventory.js');
  const { addCollector } = await import('../src/collector/registry.js');
  const puller = await import('../src/collector/puller.js');
  const st = await import('../src/collector/state.js');
  agent._resetSensorDetailDeltaForTest?.();
  for (const id of ['s1', 's2', 's3']) cache.setThermalDetail(id, therm(22, T_PAST), T_PAST);
  const add = addCollector({ id: 'edge-gc', name: 'edge-gc', url: BASE, token: 'col-2742c', enabled: true });
  assert.ok(add?.ok !== false, JSON.stringify(add));
  seen.length = 0;

  assert.equal(await puller.pullCollectorByAgent('edge-gc'), true);
  assert.ok(!seen[0].includes('sdSince'), '첫 pull 은 쿼리 없음(전량)');
  const fullOf = (id) => inv.sanitizeRemoteSensorDetail(cache.exportSensorDetail(id), { now: Date.now() });
  for (const id of ['s1', 's2', 's3']) assert.deepEqual(inv.findRemoteServer(id).sensorDetail, fullOf(id));

  assert.equal(await puller.pullCollectorByAgent('edge-gc'), true);
  assert.match(seen[1], /[?&]sdSince=/, '두 번째 pull 은 커서를 보낸다(수정 전: 언제나 전량 요청)');
  assert.deepEqual(st.getCollectorStatus('edge-gc').sensorDetailDelta, { kept: 3, missing: 0 }, '엣지가 3대를 빼고 중앙이 직전 값으로 채웠다');
  for (const id of ['s1', 's2', 's3']) {
    const got = inv.findRemoteServer(id).sensorDetail;
    assert.deepEqual(got, fullOf(id), `${id}: 다시 쓴 상세가 전량을 받았을 때와 같다(나이 판정도 같다)`);
    assert.ok(!('sensorDetailSame' in inv.findRemoteServer(id)), '표지는 보관하지 않는다');
  }

  cache.setThermalDetail('s3', therm(30, T_PAST + 90_000), T_PAST + 90_000);
  assert.equal(await puller.pullCollectorByAgent('edge-gc'), true);
  assert.deepEqual(st.getCollectorStatus('edge-gc').sensorDetailDelta, { kept: 2, missing: 0 });
  assert.equal(inv.findRemoteServer('s3').sensorDetail.thermalAt, T_PAST + 90_000, '바뀐 서버는 새 값');
  assert.deepEqual(inv.findRemoteServer('s3').sensorDetail, fullOf('s3'));
});

test('EDGE-01(중앙): 직전 값이 없는 표지는 비우고 커서를 버린다(다음 pull 전량) · 구버전 엣지(커서 없음)는 커서를 저장하지 않는다', async () => {
  const inv = await import('../src/collector/remoteInventory.js');
  const det = { at: T_PAST, thermalAt: T_PAST, collAt: null, collOk: null, collError: '', omitted: 0, list: [{ n: 'Inlet', k: 'temperature', v: 22, u: 'Cel', h: 'OK' }] };
  const curA = 'abcdefabcdef:3';
  // 처음 보는 수집 서버인데 표지가 왔다(겹친 pull 등) — 지어내지 않고 비운다.
  const r1 = inv.setCollectorServers('edge-x', 'DC', inv.sanitizeRemoteServers([{ id: 'x1', name: 'x1', sensorDetailSame: true }]).servers, { sdCursor: curA, sdSince: 'abcdefabcdef:2' });
  assert.deepEqual(r1, { kept: 0, missing: 1 });
  assert.equal(inv.findRemoteServer('x1').sensorDetail, null);
  assert.equal(inv.sensorDetailCursorOf('edge-x'), null, '직전 값이 없으면 커서를 버린다');
  // 전량을 받으면 커서를 저장한다.
  inv.setCollectorServers('edge-x', 'DC', inv.sanitizeRemoteServers([{ id: 'x1', name: 'x1', sensorDetail: det }]).servers, { sdCursor: curA });
  assert.equal(inv.sensorDetailCursorOf('edge-x'), curA);
  // 저장한 커서와 다른 커서로 요청한 응답(겹친 pull)은 값은 쓰되 커서를 버린다.
  const r2 = inv.setCollectorServers('edge-x', 'DC', inv.sanitizeRemoteServers([{ id: 'x1', name: 'x1', sensorDetailSame: true }]).servers, { sdCursor: 'abcdefabcdef:4', sdSince: 'abcdefabcdef:1' });
  assert.deepEqual(r2, { kept: 1, missing: 0 });
  assert.equal(inv.findRemoteServer('x1').sensorDetail.list.length, 1);
  assert.equal(inv.sensorDetailCursorOf('edge-x'), null);
  // 구버전 엣지: sdCursor 없음 → 저장 안 함(다음 pull 도 쿼리 없음).
  const clean = inv.sanitizeEdgeExport({ servers: [{ id: 'x1', name: 'x1', sensorDetail: det }] });
  assert.equal(clean.sdCursor, null);
  inv.setCollectorServers('edge-x', 'DC', clean.servers, { sdCursor: clean.sdCursor });
  assert.equal(inv.sensorDetailCursorOf('edge-x'), null);
  // 표지와 상세가 함께 오면 상세가 이긴다(표지는 상세가 없을 때만 받는다).
  const both = inv.sanitizeRemoteServers([{ id: 'x2', name: 'x2', sensorDetail: det, sensorDetailSame: true }]).servers[0];
  assert.ok(!both.sensorDetailSame && both.sensorDetail);
  // 엣지 시계가 앞서 잘렸던 상세를 다시 쓸 때는 지금 기준으로 다시 자른다 — 전량을 다시 받았을 때와 같다.
  const N0 = Date.now() - 600_000;
  const raw = { ...det, at: N0 + 60_000, thermalAt: N0 + 60_000 };
  const first = inv.sanitizeRemoteServers([{ id: 'y1', name: 'y1', sensorDetail: raw }], { now: N0 }).servers;
  assert.equal(first[0].sensorDetail.at, N0, '처음에는 받은 시각으로 잘렸다');
  inv.setCollectorServers('edge-y', 'DC', first, { sdCursor: curA, now: N0 });
  const later = N0 + 120_000;
  const r3 = inv.setCollectorServers('edge-y', 'DC', inv.sanitizeRemoteServers([{ id: 'y1', name: 'y1', sensorDetailSame: true }], { now: later }).servers, { sdCursor: curA, sdSince: curA, now: later });
  assert.deepEqual(r3, { kept: 1, missing: 0 });
  assert.deepEqual(inv.findRemoteServer('y1').sensorDetail, inv.sanitizeRemoteSensorDetail(raw, { now: later }), '다시 자른 결과 == 전량 정제 결과');
  assert.equal(inv.findRemoteServer('y1').sensorDetail.at, N0 + 60_000);
  assert.equal(inv.sensorDetailCursorOf('edge-y'), curA);
  inv.clearCollectorServers?.('edge-x'); inv.clearCollectorServers?.('edge-y');
});

// ─── EDGE-03 ──────────────────────────────────────────────────────────────────

const hits = { isidu: 0, result: 0, p503: 0, p502: 0 };
const fake = express();
const drain = (req) => new Promise((r) => { req.on('data', () => {}); req.on('end', r); req.on('error', r); });
fake.post('/api/central/isidu-data', async (req, res) => { hits.isidu += 1; await drain(req); res.status(503).json({ ok: false, dbUnavailable: true }); });
fake.get('/api/central/edge-log-jobs', (_q, res) => res.json({ ok: true, job: { since: 0, level: '', limit: 5, withStatus: false } }));
fake.post('/api/central/edge-log-result', async (req, res) => { hits.result += 1; await drain(req); res.status(503).json({ ok: false, reason: 'busy' }); });
fake.post('/p503', async (req, res) => { hits.p503 += 1; await drain(req); res.status(503).json({ ok: false }); });
fake.post('/p502', async (req, res) => { hits.p502 += 1; await drain(req); res.status(502).json({ ok: false }); });
const fsrv = await new Promise((r) => { const s = fake.listen(0, '127.0.0.1', () => r(s)); });
const FAKE = `http://127.0.0.1:${fsrv.address().port}`;
test.after(() => fsrv.close());

async function asEdge(fn) {
  const { config } = await import('../src/config.js');
  const prev = config.agent.centralUrl;
  config.agent.centralUrl = FAKE;
  try { return await fn(); } finally { config.agent.centralUrl = prev; }
}

test('EDGE-03(헬퍼): 503 은 한 번만 보내고, 그 밖의 일시 상태(502)는 예전처럼 호출 안에서 재시도한다', async () => {
  const { postNo503Retry } = await import('../src/agent/edgeLogWorker.js');
  const r1 = await postNo503Retry(`${FAKE}/p503`, { method: 'POST', body: 'x', timeoutMs: 5000, retries: 5 }, { backoffMs: 5 });
  assert.equal(r1.status, 503);
  assert.equal(hits.p503, 1, 'init.retries 를 넘겨도 503 은 다시 보내지 않는다');
  const r2 = await postNo503Retry(`${FAKE}/p502`, { method: 'POST', body: 'x', timeoutMs: 5000 }, { backoffMs: 5 });
  assert.equal(r2.status, 502);
  assert.equal(hits.p502, 3, '502 는 예전처럼 3번(재시도 2회)');
});

test('EDGE-03(isidu push): 중앙 503 이면 같은 본문을 한 호출에 한 번만 올리고 다음 주기에 맡긴다', async () => {
  const push = await import('../src/isidu/push.js');
  push._resetForTest();
  const r = await asEdge(() => push.pushIsiduNow());
  assert.equal(r.ok, false);
  assert.match(String(r.reason), /503/);
  assert.equal(hits.isidu, 1, '수정 전: retries:2 로 3번 올렸다');
});

test('EDGE-03(edge-log-result): 회신 503 은 다시 보내지 않고 사유를 상태에 남긴다', async () => {
  const w = await import('../src/agent/edgeLogWorker.js');
  const r = await asEdge(() => w.runEdgeLogWorkerOnce());
  assert.equal(r.ok, false);
  assert.equal(hits.result, 1, '수정 전: 3번 올렸다');
  const s = w.edgeLogWorkerStatus();
  const last = s?.last || s;
  assert.equal(last.httpStatus, 503);
  assert.equal(last.kind, 'central-busy');
});

test('EDGE-03(중앙): 설정 손상 503 에 Retry-After 60 을 싣고, central.js 의 503 은 전부 지속형 헬퍼를 지난다', async () => {
  const r = await fetch(`${BASE}/api/central/assignment?agent=edge-gc-a`, { headers: H });
  const j = await r.json();
  assert.equal(r.status, 503, JSON.stringify(j));
  assert.equal(j.reason, 'settingsUnreadable');
  assert.equal(r.headers.get('retry-after'), '60', '수정 전: Retry-After 없음 — 엣지가 400·800ms 뒤 두 번 더 보냈다');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fs.readFileSync(new URL('../src/routes/central.js', import.meta.url), 'utf8'));
  const n = (src.match(/status\(\s*503\s*\)/g) || []).length;
  const ok = (src.match(/status\(\s*503\s*\)\.set\(PERSISTENT_503_HEADERS\)/g) || []).length;
  assert.ok(n >= 1);
  assert.equal(ok, n, `central.js 의 503 응답은 전부 지속형 머리(Retry-After)를 싣는다(503 ${n}곳 중 ${ok}곳)`);
});

// ─── VC-07 ────────────────────────────────────────────────────────────────────

test('VC-07(정제): licenses·solutions 는 배열·객체 원소·아는 필드·상한만 — 뺀 개수를 센다', async () => {
  const c = await import('../src/routes/central.js');
  assert.deepEqual(c.sanitizeVcLicenses('ab'), { value: null, dropped: 1 }, '배열이 아니면 null(모름)');
  const l = c.sanitizeVcLicenses([{ name: 'vSphere 8', total: '32', used: 'abc', key: 'K', evil: { a: 1 }, edition: { x: 1 } }, null, 'x', [1]]);
  assert.equal(l.value.length, 1);
  assert.deepEqual(l.value[0], { name: 'vSphere 8', key: 'K', total: 32, used: null });
  assert.equal(l.dropped, 5, '객체 아닌 원소 3 + 모르는 형식 필드(edition) 1 + 수가 아닌 used 1');
  const big = c.sanitizeVcLicenses(Array.from({ length: c.VC_LICENSES_MAX + 7 }, (_, i) => ({ name: `l${i}` })));
  assert.equal(big.value.length, c.VC_LICENSES_MAX);
  assert.equal(big.dropped, 7);
  const s = c.sanitizeVcSolutions([{ key: 'com.vmware.vsan', version: '8.0', label: 'x'.repeat(5000) }, { version: '1' }, 7]);
  assert.equal(s.value.length, 1);
  assert.equal(s.value[0].label.length, 256);
  assert.equal(s.dropped, 2, 'key 없는 원소·객체 아닌 원소');
});

test('VC-07(/inventory): 문자열 solutions·라이선스 오염 원소를 저장 전에 좁히고 응답 dropped 로 밝힌다', async () => {
  const body = {
    agent: 'edge-inv', vcenterId: 'vc-2742c',
    vcenter: { name: 'vc-2742c', status: 'ok', solutions: 'x', licenses: [{ name: 'lic', total: 16, used: 4, costUnit: 'cpuPackage' }, { 0: 'a' }, 'ab'] },
    hosts: [{ id: 'h1', name: 'esx-1' }], datastores: [], vms: [],
  };
  const r = await fetch(`${BASE}/api/central/inventory`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  const { getInventory } = await import('../src/central/inventory.js');
  const vc = getInventory('vc-2742c').data.vcenter;
  assert.equal(vc.solutions, null, '문자열 solutions 는 null(수정 전: 그대로 저장 → /tools/solutions 500)');
  assert.deepEqual(vc.licenses, [{ name: 'lic', costUnit: 'cpuPackage', total: 16, used: 4 }], '아는 필드가 없는 원소({0:a})·글자 원소는 버린다');
  assert.equal(j.dropped?.vcSolutions, 1);
  assert.equal(j.dropped?.vcLicenses, 2, '아는 필드 없는 원소 1 + 객체 아닌 원소 1');
  // 키가 없거나 null 이면 건드리지 않는다(수집기가 조회 실패를 null 로 실을 수 있다).
  const r2 = await fetch(`${BASE}/api/central/inventory`, { method: 'POST', headers: H, body: JSON.stringify({ ...body, vcenter: { name: 'vc-2742c', status: 'ok', licenses: null, licensesError: 'NoPermission '.repeat(100) } }) });
  const j2 = await r2.json();
  assert.equal(r2.status, 200);
  assert.ok(!j2.dropped?.vcLicenses && !j2.dropped?.vcSolutions);
  const vc2 = getInventory('vc-2742c').data.vcenter;
  assert.equal(vc2.licenses, null);
  assert.equal(vc2.licensesError.length, 300, '조회 실패 사유는 글자 상한');
  // 실패 사유가 글자가 아니면 버리고 센다(vcListUnread 가 객체를 사유로 읽지 않게).
  const r3 = await fetch(`${BASE}/api/central/inventory`, { method: 'POST', headers: H, body: JSON.stringify({ ...body, vcenter: { name: 'vc-2742c', status: 'ok', solutions: null, solutionsError: { x: 1 } } }) });
  const j3 = await r3.json();
  assert.equal(j3.dropped?.vcSolutions, 1);
  assert.ok(!('solutionsError' in getInventory('vc-2742c').data.vcenter));
});
