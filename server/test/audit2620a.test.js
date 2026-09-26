// v2.620 감사 — 엣지 ↔ 중앙 계약(EDGE2620-01·02·03·05). 실제 centralRouter 를 express 에 띄워 상태코드로 본다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2620a-'));
process.env.CONFIG_DIR = DIR;
process.env.CENTRAL_TOKEN = 'ctok';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.COLLECTOR_TIMEOUT_MS = '1000';

const express = (await import('express')).default;
const { centralRouter } = await import('../src/routes/central.js');
const { config } = await import('../src/config.js');

const app = express();
app.use(express.json({ limit: '16mb' }));
app.use('/api/central', centralRouter);
const srv = app.listen(0);
const port = srv.address().port;
const servers = [srv];
after(() => { for (const s of servers) try { s.close(); } catch { /* */ } });

async function post(route, body, agent = 'edge-a') {
  const r = await fetch(`http://127.0.0.1:${port}/api/central/${route}?agent=${agent}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': 'ctok', 'X-Agent-Name': agent }, body: JSON.stringify(body),
  });
  return [r.status, await r.json()];
}
function corrupt(file) { fs.writeFileSync(path.join(DIR, file), '{bad json'); }
function restore(file) { fs.rmSync(path.join(DIR, file), { force: true }); }

// ── EDGE2620-01 ────────────────────────────────────────────────────────────
test('EDGE2620-01 cvp-data: 중앙 등록부 손상이면 503 registryUnreadable — 상태·장비 행을 지우지 않는다', async () => {
  const reg = await import('../src/cvp/registry.js');
  const cdb = await import('../src/cvp/db.js');
  reg.saveServer({ name: 'cvp1', host: '10.1.1.1', authMode: 'token', token: 'T', agent: 'edge-a' });
  const id = reg.listServers()[0].id;
  const now = Date.now();
  const [s0] = await post('cvp-data', { agent: 'edge-a', chunk: 0, chunks: 1, servers: [{ cvpId: id, ok: true, collectedAt: now }], deviceKeys: { [id]: ['SN1'] }, devices: [{ cvpId: id, key: 'SN1', ts: now, hostname: 'leaf1', ports: [] }], rows: [] });
  assert.equal(s0, 200);
  const before = (await cdb.listDeviceRows({})).rows.length;
  assert.equal(before, 1);
  corrupt('cvp-servers.json'); reg._resetForTest();
  assert.ok(reg.registryLoadError());
  const [st, body] = await post('cvp-data', { agent: 'edge-a', chunk: 0, chunks: 1, servers: [{ cvpId: id, ok: true, collectedAt: now }], deviceKeys: { [id]: ['SN1'] }, devices: [], rows: [] });
  assert.equal(st, 503);
  assert.equal(body.reason, 'registryUnreadable');
  assert.equal(body.noDelegation, undefined);
  assert.equal((await cdb.listDeviceRows({})).rows.length, 1, '장비 행을 지우면 안 된다');
  restore('cvp-servers.json'); reg._resetForTest();
});

test('EDGE2620-01 sanswitch-perf / sanswitch-data: 등록부 손상이면 503(표본을 "미위임" 으로 버리고 200 을 주지 않는다)', async () => {
  const reg = await import('../src/sanswitch/registry.js');
  const sv = reg.saveDevice({ name: 'sw1', host: '10.2.2.2', type: 'brocade', username: 'u', password: 'p', agent: 'edge-a' });
  assert.ok(sv.ok !== false);
  const id = reg.listDevices()[0].id;
  const now = Date.now();
  const [ok0] = await post('sanswitch-perf', { agent: 'edge-a', rows: [[id, now - 60_000, 1, 1000]], meta: [] });
  assert.equal(ok0, 200);
  const [d0] = await post('sanswitch-data', { agent: 'edge-a', chunk: 0, chunks: 1, devices: [{ deviceId: id, ok: true, collectedAt: now }] });
  assert.equal(d0, 200);
  const { edgeSanSwitchSnapshots } = await import('../src/central/sanSwitchEdge.js');
  const n0 = edgeSanSwitchSnapshots().length;
  corrupt('sanswitch-devices.json'); reg._resetForTest();
  const [st, b] = await post('sanswitch-perf', { agent: 'edge-a', rows: [[id, now - 30_000, 1, 2000]], meta: [] });
  assert.equal(st, 503); assert.equal(b.reason, 'registryUnreadable');
  const [st2, b2] = await post('sanswitch-data', { agent: 'edge-a', chunk: 0, chunks: 1, devices: [] });
  assert.equal(st2, 503); assert.equal(b2.reason, 'registryUnreadable');
  assert.equal(edgeSanSwitchSnapshots().length, n0, '빈 목록으로 교체하면 안 된다');
  // 상태 전용 보고는 등록부를 쓰지 않는다 — 그대로 받는다
  const [st3] = await post('sanswitch-data', { agent: 'edge-a', statusOnly: true, status: { reason: 'no-snapshots', registered: 1 } });
  assert.equal(st3, 200);
  restore('sanswitch-devices.json'); reg._resetForTest();
});

test('EDGE2620-01 storage-data / pdu-data: 등록부 손상이면 503 — 그 엣지 목록을 빈 목록으로 교체하지 않는다', async () => {
  const sreg = await import('../src/storage/registry.js');
  const preg = await import('../src/pdu/registry.js');
  const { edgeStorageSnapshots } = await import('../src/central/storageEdge.js');
  const now = Date.now();
  const [a] = await post('storage-data', { agent: 'edge-s', devices: [{ deviceId: 'u1', ok: true, collectedAt: now }] }, 'edge-s');
  assert.equal(a, 200);
  const n0 = edgeStorageSnapshots().length;
  assert.ok(n0 >= 1);
  corrupt('storage-devices.json'); sreg._resetForTest();
  const [st, b] = await post('storage-data', { agent: 'edge-s', devices: [] }, 'edge-s');
  assert.equal(st, 503); assert.equal(b.reason, 'registryUnreadable');
  assert.equal(edgeStorageSnapshots().length, n0);
  const [so] = await post('storage-data', { agent: 'edge-s', statusOnly: true, status: { reason: 'registry-unreadable', registered: null } }, 'edge-s');
  assert.equal(so, 200);
  restore('storage-devices.json'); sreg._resetForTest();

  corrupt('pdu-devices.json'); preg._resetForTest();
  const [pst, pb] = await post('pdu-data', { agent: 'edge-p', snapshots: [] }, 'edge-p');
  assert.equal(pst, 503); assert.equal(pb.reason, 'registryUnreadable');
  restore('pdu-devices.json'); preg._resetForTest();
});

// ── EDGE2620-03 ────────────────────────────────────────────────────────────
test('EDGE2620-03 storageEdge: 대소문자만 다른 이름은 한 행 — 위임 0대 비우기가 옛 표기 행에도 적용된다', async () => {
  const se = await import('../src/central/storageEdge.js');
  se.saveEdgeStorage('Edge-X', [{ deviceId: 'x1', ok: true, collectedAt: Date.now() }]);
  se.saveEdgeStorage('edge-x', []);
  const rows = se.edgeStorageReports().filter((r) => r.agent.toLowerCase() === 'edge-x');
  assert.equal(rows.length, 1);
  assert.equal(se.edgeStorageSnapshots().filter((d) => d.deviceId === 'x1').length, 0, '옛 표기 행 스냅샷이 남으면 안 된다');
  // 상태 보고도 같은 행에 붙는다
  se.saveEdgeStorageStatus('EDGE-X', { reason: 'no-snapshots', registered: 1 });
  assert.equal(se.edgeStorageReports().filter((r) => r.agent.toLowerCase() === 'edge-x').length, 1);
});

test('EDGE2620-03 sanSwitchEdge: 교체(청크 0) 때 대소문자 변형 행을 지운다 · 청크 병합도 같은 행', async () => {
  const sw = await import('../src/central/sanSwitchEdge.js');
  sw.saveEdgeSanSwitch('Edge-Y', [{ deviceId: 'y1', ok: true, collectedAt: Date.now() }]);
  sw.saveEdgeSanSwitch('edge-y', [{ deviceId: 'y2', ok: true, collectedAt: Date.now() }], { chunk: 0, chunks: 2 });
  sw.saveEdgeSanSwitch('EDGE-Y', [{ deviceId: 'y3', ok: true, collectedAt: Date.now() }], { chunk: 1, chunks: 2 });
  const rows = sw.edgeSanSwitchReports().filter((r) => r.agent.toLowerCase() === 'edge-y');
  assert.equal(rows.length, 1);
  const ids = sw.edgeSanSwitchSnapshots().filter((d) => String(d.agent).toLowerCase() === 'edge-y').map((d) => d.deviceId).sort();
  assert.deepEqual(ids, ['y2', 'y3']);
});

// ── EDGE2620-02 ────────────────────────────────────────────────────────────
test('EDGE2620-02 puller 순수: 직전 실패 엣지는 뒤로 · 재시도 0 · 경고가 원인을 말한다', async () => {
  const p = await import('../src/collector/puller.js');
  const order = p.orderForPull([{ id: 'a' }, { id: 'b' }, { id: 'c' }], (id) => (id === 'a' ? 2 : 0)).map((c) => c.id);
  assert.deepEqual(order, ['b', 'c', 'a']);
  assert.equal(p.pullOptionsFor(0).retries, 2);
  assert.equal(p.pullOptionsFor(1).retries, 0);
  const t = p.slowCycleText({ took: 40_000, count: 5, concurrency: 4, intervalMs: 60_000, failedCount: 4, failedMs: 160_000, suspectCount: 4 });
  assert.match(t, /응답하지 않은 엣지 4곳/);
  assert.doesNotMatch(t, /CONCURRENCY 를 늘리거나/);
  const t2 = p.slowCycleText({ took: 40_000, count: 5, concurrency: 4, intervalMs: 60_000 });
  assert.match(t2, /COLLECTOR_PULL_CONCURRENCY/);
});

test('EDGE2620-02 puller 실제: 두 번째 주기에는 불통 엣지를 재시도 없이 1회 · 정상 엣지를 먼저 당긴다', async () => {
  let hangHits = 0;
  const hang = http.createServer(() => { hangHits++; }); hang.listen(0); servers.push(hang);
  let liveAt = null; let tCycle = 0;
  const live = http.createServer((q, r) => { liveAt = Date.now() - tCycle; r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ ok: true, power: { byHost: [] }, servers: [], version: '2.620.0' })); });
  live.listen(0); servers.push(live);
  const reg = await import('../src/collector/registry.js');
  for (let i = 0; i < 4; i++) reg.addCollector({ id: 'dead' + i, name: 'dead' + i, url: `http://127.0.0.1:${hang.address().port}`, token: 'x' });
  reg.addCollector({ id: 'live', name: 'live', url: `http://127.0.0.1:${live.address().port}`, token: 'x' });
  const { pullNow } = await import('../src/collector/puller.js');
  tCycle = Date.now(); await pullNow();
  const firstHits = hangHits;
  assert.ok(firstHits >= 8, `첫 주기는 재시도 포함(${firstHits})`);
  hangHits = 0; liveAt = null;
  tCycle = Date.now(); await pullNow();
  assert.equal(hangHits, 4, '두 번째 주기: 불통 엣지당 1회');
  assert.ok(liveAt != null && liveAt < 500, `정상 엣지가 먼저(${liveAt}ms)`);
  for (let i = 0; i < 4; i++) reg.removeCollector?.('dead' + i);
});

// ── EDGE2620-05 ────────────────────────────────────────────────────────────
test('EDGE2620-05 cvp push: 엣지 등록부 손상이면 보내지 않고 사유를 남긴다(위임 0대 아님)', async () => {
  let hits = 0;
  const central = http.createServer((q, r) => { hits++; r.writeHead(200, { 'Content-Type': 'application/json' }); r.end('{"ok":true}'); });
  central.listen(0); servers.push(central);
  const reg = await import('../src/cvp/registry.js');
  const push = await import('../src/cvp/push.js');
  const prev = { url: config.agent.centralUrl, token: config.agent.centralToken };
  config.agent.centralUrl = `http://127.0.0.1:${central.address().port}`; config.agent.centralToken = 'ctok';
  try {
    corrupt('cvp-servers.json'); reg._resetForTest();
    const r = await push.pushCvpNow();
    assert.equal(r.ok, false);
    assert.match(r.reason, /엣지 CVP 등록부를 읽지 못해/);
    assert.equal(hits, 0, '중앙으로 빈 servers 를 보내면 안 된다');
    const st = push.cvpPushStatus();
    assert.equal(st.kind, 'edge-registry-unreadable');
    assert.equal(st.cleared, undefined);
  } finally {
    config.agent.centralUrl = prev.url; config.agent.centralToken = prev.token;
    restore('cvp-servers.json'); reg._resetForTest(); push._resetForTest();
  }
});

test('EDGE2620-01 cvp push: 중앙 503 registryUnreadable 사유 문구', async () => {
  const { centralFailText } = await import('../src/cvp/push.js');
  const t = centralFailText(503, { ok: false, reason: 'registryUnreadable', detail: '중앙 CVP 등록부를 읽지 못했습니다(x)' });
  assert.match(t, /등록부를 읽지 못해 받지 않았습니다\(503\)/);
  assert.match(t, /커서를 전진하지 않고/);
});
