// v2.599 감사 수정 — 그룹 b(중앙 수신 경계). 실제 central 라우터를 express 에 띄워 상태코드·응답·저장 결과로 본다.
//   CEN-2599-01·02·03·04·05 · EDGE2599-03 · WEB2599-01 · WEB2599-04
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOUR = 3_600_000;
const NOW = 1_790_000_000_000 - 30 * 60_000; // 고정 기준 시각(Date.now() 를 쓰지 않는다 — v2.517 규약)
const TOKEN = 'tok-2599b-shared';
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2599b-'));
process.env.CONFIG_DIR = CFG;
process.env.CENTRAL_TOKEN = TOKEN;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'true';
fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: 'vc-site1', name: 'Site1', host: 'https://10.0.0.1', collectMode: 'site' },
  { id: 'vc-other', name: 'Other', host: 'https://10.0.0.2', collectMode: 'site' },
] }));

let srv; let base;
before(async () => {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use('/api/central', centralRouter);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api/central`;
});
after(() => { srv?.close(); });

const post = (p, body, { token = TOKEN, headers = {} } = {}) => fetch(`${base}${p}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Central-Token': token } : {}), ...headers },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

// ── CEN-2599-01·02·03: /inventory 원소 정리 ─────────────────────────────────
test('CEN-2599-01·02·03 — /inventory 는 객체 아닌 원소·다른 vCenter 원소를 빼고 표시 필드 객체를 null 로 바꾼다', async () => {
  const { getInventory } = await import('../src/central/inventory.js');
  const r = await post('/inventory', {
    agent: 'edge-a', vcenterId: 'vc-site1', vcenter: { id: 'vc-other', name: 'Site1' },
    hosts: [null, 'x', 7, { id: 'h9', name: 'injected-host', vcenterId: 'vc-other' }, { id: 'h1', name: 'esx1', vcenterId: 'vc-site1', connectionState: 'CONNECTED' }],
    vms: [{ id: 'v1', name: { x: 1 }, vcenterId: 'vc-site1' }, { id: { o: 1 }, name: 'bad-id' }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.hosts, 1, '객체 아닌 원소·다른 vCenter 원소는 저장하지 않는다');
  assert.equal(r.body.rejected, 5, JSON.stringify(r.body));
  assert.deepEqual({ ...r.body.dropped, coerced: undefined }, { notObject: 3, otherVcenter: 1, badId: 1, coerced: undefined });
  const inv = getInventory('vc-site1');
  assert.equal(inv.data.vcenter.id, 'vc-site1', 'vcenter.id 는 본문 vcenterId 로 고정');
  assert.deepEqual(inv.data.hosts.map((h) => h.id), ['h1']);
  assert.equal(inv.data.vms[0].name, null, '객체 이름은 null(화면 React #31 방지)');
  assert.equal(inv.data.vms[0].vcenterId, 'vc-site1');
  // vcenter 가 객체가 아니면 400
  const bad = await post('/inventory', { vcenterId: 'vc-site1', vcenter: 'Site1', hosts: [] });
  assert.equal(bad.status, 400);
});

test('CEN-2599-01 2차 방어 — 디스크에 이미 저장된 null 원소가 있어도 store.refresh 가 스냅샷을 만든다', async () => {
  const { setInventory } = await import('../src/central/inventory.js');
  const { store } = await import('../src/store.js');
  setInventory('vc-site1', { vcenter: { id: 'vc-site1', name: 'Site1' },
    hosts: [null, { id: 'h1', name: 'esx1', vcenterId: 'vc-site1', connectionState: 'CONNECTED' }, { id: 'hx', vcenterId: 'vc-other', name: 'inj' }],
    vms: [], datastores: [], networks: [], alarms: [] }, 'edge-a', null);
  await store.refresh({ force: true });
  assert.equal(store.lastError, null, `refresh 실패: ${store.lastError}`);
  const snap = store.get();
  assert.deepEqual(snap.hosts.filter((h) => h.vcenterId === 'vc-site1').map((h) => h.id), ['h1']);
  assert.ok(!snap.hosts.some((h) => h.id === 'hx'), '다른 vCenter 원소를 병합하지 않는다');
});

// ── CEN-2599-03·05: storage/pdu/sanswitch 원소 정리 ─────────────────────────
test('CEN-2599-03·05 — storage-data(공유 토큰)는 null·글자·숫자·예약 id 원소를 빼고 개수를 밝힌다', async () => {
  const { edgeStorageSnapshots } = await import('../src/central/storageEdge.js');
  const r = await post('/storage-data', { agent: 'e1', devices: [null, 'x', 1, { deviceId: '__proto__' }, { deviceId: 'constructor' },
    { deviceId: 'st-1', name: { a: 1 }, model: ['m'], capacity: { totalBytes: '100', usedBytes: null, freeBytes: 'n/a' } }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.saved, 1);
  assert.equal(r.body.rejected, 5);
  const rows = edgeStorageSnapshots().filter((d) => d.agent === 'e1');
  assert.deepEqual(rows.map((d) => d.deviceId), ['st-1'], '유령 행이 없어야 한다');
  assert.equal(rows[0].name, null); assert.equal(rows[0].model, null);
  assert.equal(rows[0].capacity.totalBytes, 100);
  assert.equal(rows[0].capacity.usedBytes, null, '못 읽은 값은 0 이 아니라 null');
  assert.equal(rows[0].capacity.freeBytes, null);
});

test('CEN-2599-03 — pdu-data·sanswitch-data 도 같은 정리를 한다', async () => {
  const { edgePduSnapshots } = await import('../src/central/pduEdge.js');
  const { edgeSanSwitchSnapshots } = await import('../src/central/sanSwitchEdge.js');
  const p = await post('/pdu-data', { agent: 'e2', snapshots: [null, { id: 'pdu-1', name: { a: 1 } }] });
  assert.equal(p.status, 200); assert.equal(p.body.rejected, 1);
  assert.equal(edgePduSnapshots().find((s) => s.id === 'pdu-1').name, null);
  const w = await post('/sanswitch-data', { agent: 'e2', devices: [7, { deviceId: 'sw-1', name: { a: 1 }, model: { m: 1 }, ports: { total: '48', online: 'x' } }] });
  assert.equal(w.status, 200); assert.equal(w.body.rejected, 1);
  const sw = edgeSanSwitchSnapshots().find((d) => d.deviceId === 'sw-1');
  assert.equal(sw.name, null); assert.equal(sw.model, null);
  assert.equal(sw.ports.total, 48); assert.equal(sw.ports.online, null);
});

// ── CEN-2599-04: 크기·엣지 수 상한 + 비동기 쓰기 ─────────────────────────────
test('CEN-2599-04 — 장비 하나 크기 상한·엣지 합계 상한을 넘는 원소를 빼고 사유별로 센다', async () => {
  const { sanitizeEdgeDevices } = await import('../src/central/edgeRecord.js');
  const big = { deviceId: 'd-big', blob: 'x'.repeat(200_000) };
  const r = sanitizeEdgeDevices([big, { deviceId: 'd1', blob: 'y'.repeat(60_000) }, { deviceId: 'd2', blob: 'z'.repeat(60_000) }],
    { deviceMaxBytes: 100_000, agentMaxBytes: 100_000 });
  assert.deepEqual(r.devices.map((d) => d.deviceId), ['d1']);
  assert.equal(r.dropped.tooLarge, 1);
  assert.equal(r.dropped.overAgentBytes, 1);
});

test('CEN-2599-04 — 엣지 수 상한: 모두 최근이면 새 이름을 거절하고, 오래 조용한 엣지만 밀어낸다', async () => {
  const { admitAgent } = await import('../src/central/edgeRecord.js');
  const m = new Map([['a', { at: NOW - HOUR }], ['b', { at: NOW - 2 * HOUR }]]);
  assert.deepEqual(admitAgent(m, 'a', { now: NOW, maxAgents: 2, evictMs: 24 * HOUR }), { ok: true }, '기존 이름은 언제나 받는다');
  assert.deepEqual(admitAgent(m, 'spam', { now: NOW, maxAgents: 2, evictMs: 24 * HOUR }), { ok: false });
  assert.equal(m.size, 2, '최근 보고한 엣지를 밀어내지 않는다');
  m.set('b', { at: NOW - 48 * HOUR });
  assert.deepEqual(admitAgent(m, 'new', { now: NOW, maxAgents: 2, evictMs: 24 * HOUR }), { ok: true, evicted: 'b' });
  assert.ok(!m.has('b'));
});

test('CEN-2599-04 — 보관 파일은 push 마다 동기로 쓰지 않고, 종료 flush 때 원자적으로 쓴다', async () => {
  const { createDebouncedWriter } = await import('../src/central/edgeRecord.js');
  const f = path.join(CFG, 'writer-probe.json');
  let v = 1;
  const w = createDebouncedWriter(f, () => JSON.stringify({ v }), { delayMs: 60_000, name: 'probe2599b' });
  w.save();
  assert.equal(fs.existsSync(f), false, 'save() 가 동기로 쓰면 안 된다');
  v = 2; w.flushSync();
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { v: 2 });
  const src = fs.readFileSync(new URL('../src/central/storageEdge.js', import.meta.url), 'utf8');
  assert.ok(!/atomicWriteFileSync\(FILE/.test(src), 'storageEdge 가 push 마다 전체 맵을 동기로 쓴다');
});

test('CEN-2599-04 — agent-config 는 엣지당 합계 상한을 넘는 파일을 저장하지 않고 개수를 밝힌다', async () => {
  const { setAgentConfig, AGENT_CONFIG_MAX_BYTES, getAllAgentConfigs } = await import('../src/central/agentConfig.js');
  const chunk = 'a'.repeat(Math.ceil(AGENT_CONFIG_MAX_BYTES / 2) + 10);
  const r = setAgentConfig('edge-cfg', { 'a.json': chunk, 'b.json': chunk, 'c.json': '{}' });
  assert.equal(r.ok, true); assert.equal(r.omitted, 1);
  assert.deepEqual(Object.keys(getAllAgentConfigs()['edge-cfg'].files).sort(), ['a.json', 'c.json']);
});

// ── EDGE2599-03: 소유권 — 자동 인계 기본 꺼짐 + 관리자 명시 해제/지정 ────────
test('EDGE2599-03 — 자동 인계는 기본 꺼짐(8일 조용해도 403)이고, 관리자 해제 뒤 다음 개별 토큰 push 가 새 소유가 된다', async () => {
  const express = (await import('express')).default;
  const { registerCentralIpam } = await import('../src/routes/admin/centralIpam.js');
  const { issueAgentToken } = await import('../src/central/agentTokens.js');
  const { getInventory } = await import('../src/central/inventory.js');
  const A = issueAgentToken('edgeA').token; const B = issueAgentToken('edgeB').token;
  const body = (hn) => ({ vcenterId: 'vc-other', vcenter: { id: 'vc-other', name: 'Other' }, hosts: [{ id: hn, vcenterId: 'vc-other' }] });
  assert.equal((await post('/inventory', body('ha'), { token: A })).status, 200);
  getInventory('vc-other').at -= 8 * 24 * HOUR; // 옛 소유 엣지가 8일 조용했다
  const deny = await post('/inventory', body('hb'), { token: B });
  assert.equal(deny.status, 403, '자동 인계는 opt-in — 기본값에서 다른 엣지가 가로챌 수 없다');
  assert.match(deny.body.reason, /\/api\/admin\/central\/inventory\/owner/, '거부 사유가 관리자 해제 경로를 안내한다');
  // 관리자 API — 실제 라우터를 띄운다(role 은 앞단 인증 미들웨어가 채우는 req.user 를 흉내낸다)
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: req.get('X-Test-User'), role: req.get('X-Test-Role') }; next(); });
  const r = express.Router(); registerCentralIpam(r); app.use('/api/admin', r);
  const asrv = await new Promise((ok) => { const s2 = app.listen(0, '127.0.0.1', () => ok(s2)); });
  const call = (role, b) => fetch(`http://127.0.0.1:${asrv.address().port}/api/admin/central/inventory/owner`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Test-Role': role, 'X-Test-User': 'u1' }, body: JSON.stringify(b),
  }).then(async (x) => ({ status: x.status, body: await x.json() }));
  try {
    assert.equal((await call('operator', { vcenterId: 'vc-other', agent: '' })).status, 403, 'admin 전용');
    assert.equal((await call('admin', { vcenterId: 'nope', agent: '' })).status, 404);
    assert.equal((await call('admin', { vcenterId: 'vc-other', agent: 'bad name!' })).status, 400);
    const rel = await call('admin', { vcenterId: 'vc-other', agent: '' });
    assert.equal(rel.status, 200); assert.equal(rel.body.from, 'edgeA'); assert.equal(rel.body.released, true);
  } finally { asrv.close(); }
  const ok = await post('/inventory', body('hb'), { token: B });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(getInventory('vc-other').agent, 'edgeB', '해제 뒤 다음 개별 토큰 push 가 새 소유');
  assert.equal((await post('/inventory', body('ha2'), { token: A })).status, 403, '옛 엣지는 다시 덮어쓸 수 없다');
  const audit = fs.readFileSync(path.join(CFG, 'audit.ndjson'), 'utf8');
  assert.match(audit, /위임 인벤토리 소유 엣지 해제/, '해제는 감사 로그에 남는다');
});

// ── WEB2599-01·04: 거부 기록의 이름·경로 ────────────────────────────────────
test('WEB2599-01 — 무토큰 거부 POST 의 주장 이름은 기록되지 않고 한 칸으로 접힌다(데이터 흐름 지도에 가짜 엣지 없음)', async () => {
  const { rejectStats, resetRejects } = await import('../src/central/ingestReject.js');
  const { PULL_UNAUTH_KEY } = await import('../src/central/pullStats.js');
  const { buildDataFlow } = await import('../src/dataflow/build.js');
  resetRejects();
  for (let i = 0; i < 5; i++) await post('/storage-data', { agent: `fake-${i}` }, { token: '', headers: { 'X-Agent-Name': `fake-${i}` } });
  const names = rejectStats().rows.map((r) => r.agent);
  assert.deepEqual(names, [PULL_UNAUTH_KEY], `주장한 이름이 기록됐다: ${names}`);
  const flow = buildDataFlow({ routes: [{ side: 'central', method: 'POST', path: '/storage-data' }], collectors: [], rejects: rejectStats(), now: Date.now() });
  // v2.600 WEB2600-04: 인증 실패 칸은 엣지로 그리지 않고 unauth 로만 밝힌다.
  assert.equal(flow.edges.length, 0, `가짜 엣지가 생겼다: ${flow.edges.map((e) => e.name)}`);
  assert.ok(flow.unauth && flow.unauth.count >= 1, `인증 실패가 unauth 로 드러나야 한다: ${JSON.stringify(flow.unauth)}`);
});

test('WEB2599-04 — 라우터에 없는 경로의 404 는 수신 꺼짐(disabled)이 아니라 unknown-route 이고 경로는 한 칸이다', async () => {
  const { rejectStats, resetRejects, REJECT_KIND } = await import('../src/central/ingestReject.js');
  const { UNKNOWN_ROUTE_KEY } = await import('../src/routes/central.js');
  const { buildDataFlow } = await import('../src/dataflow/build.js');
  resetRejects();
  await post('/storage', { agent: 'edge-t1' });
  await post('/no-such-path-2', { agent: 'edge-t1' });
  const row = rejectStats().rows.find((r) => r.agent === 'edge-t1');
  assert.equal(row.lastKind, REJECT_KIND.UNKNOWN_ROUTE);
  assert.deepEqual(Object.keys(row.byEndpoint), [UNKNOWN_ROUTE_KEY], '요청자가 고른 경로 문자열을 키로 쓰지 않는다');
  const flow = buildDataFlow({ routes: [{ side: 'central', method: 'POST', path: '/storage-data' }], collectors: [], rejects: rejectStats(), now: Date.now() });
  assert.deepEqual(flow.undeclared, [`central:POST ${UNKNOWN_ROUTE_KEY}`], '없는 경로는 경로마다가 아니라 한 칸으로 그려진다');
});
