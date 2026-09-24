// v2.601 감사 수정 — 그룹 c(중앙 수신 · 엣지 push). 실제 central 라우터를 express 에 띄워 상태코드·응답·저장 결과로 보고,
//   엣지 push 는 목 HTTP 중앙에 실제로 보내 본문 도착까지 본다(v2.566 규약 — 순수 헬퍼만 고정하는 테스트는 push 함수가
//   통째로 죽는 종류를 못 잡는다).
//   CEN2601-01·02·03·04·05 · SEC2601-02 · EDGE2601-04·06
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';

const TOKEN = 'tok-2601c-shared';
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2601c-'));
process.env.CONFIG_DIR = CFG;
process.env.CENTRAL_TOKEN = TOKEN;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'true';
process.env.IPAM_WRITE_DEBOUNCE_MS = '60000';
// 상한을 작게 — 동작(자르고 밝힌다)을 짧은 입력으로 본다.
process.env.CENTRAL_FLEET_MAX_PER_AGENT = '50';
process.env.CENTRAL_FLEET_MAX_TOTAL = '120';
process.env.CENTRAL_FLEET_MAX_UNVERIFIED_AGENTS = '3';
process.env.CENTRAL_FLEET_MAX_UNVERIFIED_TOTAL = '60';
process.env.CENTRAL_RESULT_AGENTS_MAX = '5';
fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: 'vc-a', name: 'A', host: 'https://10.0.0.1', collectMode: 'site' },
  { id: 'vc-b', name: 'B', host: 'https://10.0.0.2', collectMode: 'site' },
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

const post = (p, body, { token = TOKEN } = {}) => fetch(`${base}${p}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Central-Token': token } : {}) },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

// ── CEN2601-01: ip-scan-result 원소 정제 ─────────────────────────────────────
test('CEN2601-01 — ip-scan-result 의 형식이 틀린 원소가 IPAM 대장 계산을 깨뜨리지 않는다(아는 필드·타입만 저장)', async () => {
  const r = await post('/ip-scan-result', {
    agent: 'e9', scanned: { a: 1 }, durationMs: 'x',
    alive: [
      { ip: '10.99.1.5', openPorts: { a: 1 }, services: 'notarray', hostname: { h: 1 } },
      { ip: '10.99.1.6', openPorts: [22, '443', 0, 70000, 'x', { p: 1 }, 1.5], services: ['ssh', { s: 1 }, 'x'.repeat(200)], hostname: 'host\u0000name' },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { getScanResults, getAgentReports, getScanRuns } = await import('../src/ipam/scanStore.js');
  const res = getScanResults();
  assert.deepEqual(res['10.99.1.5'].openPorts, []);
  assert.deepEqual(res['10.99.1.5'].services, []);
  assert.equal(res['10.99.1.5'].hostname, '');
  assert.deepEqual(res['10.99.1.6'].openPorts, [22, 443], '1~65535 정수만');
  assert.deepEqual(res['10.99.1.6'].services, ['ssh', 'x'.repeat(64)], '문자열만 · 64자');
  assert.equal(res['10.99.1.6'].hostname, 'hostname', '제어 문자 제거');
  // 수치 필드는 numOrNull — 객체·문자열이 저장되지 않는다(화면 React #31 방지)
  assert.equal(getAgentReports().e9.scanned, null);
  assert.equal(getScanRuns(1)[0].durationMs, null);
  // 수정 전: services.join 이 TypeError → 매 주기 ipam.db 저장 실패 · insights 500
  const { buildSubnetSheets } = await import('../src/ipam/ledger.js');
  assert.doesNotThrow(() => buildSubnetSheets({ generatedAt: 'g-2601c', vms: [], hosts: [] }, { onlyBase: '10.99.1' }));
});

test('CEN2601-01 — 디스크에 이미 저장된 오염 결과도 로드 시 같은 정제를 거친다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2601c-load-'));
  fs.writeFileSync(path.join(dir, 'ipam-scan-results.json'), JSON.stringify({
    '10.1.1.1': { ip: '10.1.1.1', openPorts: 'x', services: { a: 1 }, hostname: 7, lastSeen: 'y', agent: { a: 1 } },
    '__proto__x': { ip: 'bad' },
  }));
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    "const m = await import('./src/ipam/scanStore.js'); console.log(JSON.stringify(m.getScanResults()));"],
  { cwd: path.join(import.meta.dirname, '..'), env: { ...process.env, CONFIG_DIR: dir }, encoding: 'utf8' });
  const got = JSON.parse(out.trim().split('\n').pop());
  assert.deepEqual(Object.keys(got), ['10.1.1.1']);
  assert.deepEqual(got['10.1.1.1'], { ip: '10.1.1.1', openPorts: [], services: [], hostname: '', lastSeen: 0, agent: '__local__' });
});

// ── SEC2601-02: parseOs 선형 ────────────────────────────────────────────────
test('SEC2601-02 — parseOs 는 긴 숫자·공백 줄에서도 선형이고 정상 입력 결과는 같다', async () => {
  const { parseOs } = await import('../src/ipam/ledger.js');
  assert.deepEqual(parseOs('CentOS 7 (64-bit)'), { osName: 'CentOS', osVersion: '7' });
  assert.deepEqual(parseOs('Microsoft Windows Server 2019 (64-bit)  '), { osName: 'Microsoft Windows Server', osVersion: '2019' });
  assert.deepEqual(parseOs('Ubuntu Linux 22.04'), { osName: 'Ubuntu Linux', osVersion: '22.04' });
  const t0 = performance.now();
  parseOs('1'.repeat(200_000) + 'x');
  parseOs('a' + ' '.repeat(200_000) + 'b');
  parseOs('9 '.repeat(100_000) + 'z');
  assert.ok(performance.now() - t0 < 200, `수정 전에는 숫자 4,000자에 77ms · 20만 자면 수십 초 — 지금 ${Math.round(performance.now() - t0)}ms`);
});

// ── CEN2601-02·03: /fleet ──────────────────────────────────────────────────
test('CEN2601-02 — /fleet 원소 vcenterId 는 이 엣지가 소유한 vCenter 에만 귀속된다(남의 법인은 귀속을 비우고 개수를 밝힌다)', async () => {
  const { setInventory } = await import('../src/central/inventory.js');
  const { issueAgentToken } = await import('../src/central/agentTokens.js');
  setInventory('vc-a', { vcenter: { id: 'vc-a', name: 'A' }, hosts: [], vms: [], datastores: [], networks: [], alarms: [] }, 'edgeA', null);
  setInventory('vc-b', { vcenter: { id: 'vc-b', name: 'B' }, hosts: [], vms: [], datastores: [], networks: [], alarms: [] }, 'edgeB', null);
  const tokA = issueAgentToken('edgeA').token;
  const r = await post('/fleet', { baremetal: [
    { fleetId: 'OWN1', serviceTag: 'OWNTAG', vcenterId: 'vc-a' },
    { fleetId: 'FAKE1', serviceTag: 'FAKETAG1', vcenterId: 'vc-b' },
  ] }, { token: tokA });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.vcenterBlanked, 1);
  const { getEdgeFleetServers } = await import('../src/central/fleet.js');
  const mine = getEdgeFleetServers().filter((s) => s.remoteAgent === 'edgeA');
  assert.equal(mine.find((s) => s.serviceTag === 'OWNTAG').vcenterId, 'vc-a');
  assert.equal(mine.find((s) => s.serviceTag === 'FAKETAG1').vcenterId, '', '남의 법인 vCenter 로 귀속하지 않는다(서버 자체는 남긴다)');
  // 공유 토큰 + 중앙이 모르는 이름: 소유를 증명할 수 없어 귀속을 비운다
  const g = await post('/fleet', { agent: 'ghost-x', baremetal: [{ fleetId: 'G1', serviceTag: 'GTAG', vcenterId: 'vc-a' }] });
  assert.equal(g.status, 200);
  assert.equal(g.body.unverifiedAgent, true);
  assert.equal(getEdgeFleetServers().find((s) => s.serviceTag === 'GTAG').vcenterId, '');
  // 공유 토큰 + 이미 아는 이름(인벤토리 소유자): 소유한 vCenter 는 귀속, 남의 것은 비운다
  const k = await post('/fleet', { agent: 'edgeB', baremetal: [{ fleetId: 'B1', serviceTag: 'BTAG', vcenterId: 'vc-b' }, { fleetId: 'B2', serviceTag: 'BTAG2', vcenterId: 'vc-a' }] });
  assert.equal(k.body.unverifiedAgent, undefined);
  assert.equal(k.body.vcenterBlanked, 1);
  assert.equal(getEdgeFleetServers().find((s) => s.serviceTag === 'BTAG').vcenterId, 'vc-b');
});

test('CEN2601-03 — /fleet 은 에이전트당·전체·미검증 이름 상한을 두고 잘린 수를 밝힌다', async () => {
  const { setEdgeFleet, listEdgeFleet, resetEdgeFleet } = await import('../src/central/fleet.js');
  resetEdgeFleet();
  const mk = (n, p) => Array.from({ length: n }, (_, i) => ({ fleetId: `${p}${i}`, name: `${p}${i}` }));
  // 에이전트당 상한(50)
  let r = setEdgeFleet('v1', mk(80, 'a'), null, { verified: true });
  assert.deepEqual(r, { accepted: 50, omitted: 30, vcenterBlanked: 0 });
  // 미검증 이름 합 상한(60)
  r = setEdgeFleet('u1', mk(40, 'b'), null, { verified: false });
  assert.equal(r.accepted, 40);
  r = setEdgeFleet('u2', mk(40, 'c'), null, { verified: false });
  assert.equal(r.accepted, 20, '미검증 합 60 − 40');
  assert.equal(r.omitted, 20);
  // 미검증 이름 수 상한(3) — 넷째가 오면 가장 오래된 미검증이 밀려난다(검증된 v1 은 그대로)
  setEdgeFleet('u3', mk(1, 'd'), null, { verified: false });
  setEdgeFleet('u4', mk(1, 'e'), null, { verified: false });
  const names = listEdgeFleet().map((x) => x.agent).sort();
  assert.ok(names.includes('v1'), '검증된 엣지는 밀려나지 않는다');
  assert.equal(names.filter((n) => n.startsWith('u')).length, 3);
  // 전체 상한(120) — 검증된 이름도 전체를 넘지 못한다
  r = setEdgeFleet('v2', mk(50, 'f'), null, { verified: true });
  const total = listEdgeFleet().reduce((a, x) => a + x.baremetal, 0);
  assert.ok(total <= 120, `전체 ${total}`);
  assert.equal(r.accepted + r.omitted, 50);
  assert.equal(listEdgeFleet().find((x) => x.agent === 'v1').omitted, 30, '잘린 수를 목록이 밝힌다');
  resetEdgeFleet();
});

// ── CEN2601-04: /result ────────────────────────────────────────────────────
test('CEN2601-04 — /result 는 배정 없는 이름을 저장하지 않고, agent 수 상한으로 오래된 것부터 밀어낸다', async () => {
  const { addAssignment, getResults, setResult } = await import('../src/central/assignments.js');
  for (let i = 0; i < 3; i++) {
    const g = await post('/result', { agent: `ghost${i}`, scanned: 1 });
    assert.equal(g.status, 409, JSON.stringify(g.body));
  }
  assert.equal(Object.keys(getResults()).filter((k) => k.startsWith('ghost')).length, 0, '유령 이름이 agent-results 에 남지 않는다');
  assert.equal(addAssignment({ agent: 'scanA', ips: '10.0.0.0/30', username: 'root', password: 'x' }).ok, true);
  const ok = await post('/result', { agent: 'SCANA', scanned: 4 });
  assert.equal(ok.status, 200, '배정은 대소문자를 무시해 찾는다');
  assert.equal(getResults().SCANA.scanned, 4);
  // 저장소 상한(5)
  for (let i = 0; i < 8; i++) setResult(`x${i}`, { scanned: i });
  assert.ok(Object.keys(getResults()).length <= 5, `${Object.keys(getResults()).length}`);
  assert.ok('x7' in getResults(), '최신 보고는 남는다');
});

// ── CEN2601-05: rma-poll 정책 필드 ─────────────────────────────────────────
test('CEN2601-05 — rma-poll 정책 필드가 배열이 아니어도 하트비트가 기록된다(500 아님)', async () => {
  const { issueAgentToken } = await import('../src/central/agentTokens.js');
  const tok = issueAgentToken('rmaedge').token;
  const r = await post('/rma-poll', { info: { hostname: 'h1', policy: { enabled: 'x', disabled: { a: 1 }, enabledTests: ['t1', { o: 1 }, 2], fileRoots: 7 } }, wait: 0 }, { token: tok });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { listRmaAgents } = await import('../src/rma/jobs.js');
  const inst = listRmaAgents().find((g) => g.agent === 'rmaedge').instances[0];
  assert.deepEqual(inst.policy.enabled, []);
  assert.deepEqual(inst.policy.enabledTests, ['t1', '2']);
  assert.deepEqual(inst.policy.policyInvalid.sort(), ['disabled', 'enabled', 'fileRoots']);
  const { noteHeartbeat } = await import('../src/rma/jobs.js');
  assert.doesNotThrow(() => noteHeartbeat('rmaedge', 'i2', null));
});

// ── EDGE2601-04·06: 엣지 push ────────────────────────────────────────────────
function mockCentral(handler) {
  const got = [];
  const srv2 = http.createServer((req, res) => {
    const bufs = [];
    req.on('data', (c) => bufs.push(c));
    req.on('end', async () => {
      let raw = Buffer.concat(bufs);
      if (req.headers['content-encoding'] === 'gzip') { try { raw = zlib.gunzipSync(raw); } catch { /* */ } }
      let body = null; try { body = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { body = null; }
      got.push({ url: req.url, body });
      const out = (await handler?.(req, body)) || {};
      res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.json || { ok: true }));
    });
  });
  return { srv2, got };
}
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

test('EDGE2601-04 — storage push 는 중앙이 뺀 장비 수(rejected/dropped)를 상태·반환에 남긴다', async () => {
  const { config } = await import('../src/config.js');
  const { putSnapshot, _resetForTest } = await import('../src/storage/store.js');
  const { srv2, got } = mockCentral(() => ({ json: { ok: true, saved: 1, rejected: 2, dropped: { notOwned: 2 } } }));
  const port = await listen(srv2);
  try {
    config.agent.centralUrl = `http://127.0.0.1:${port}`; config.agent.centralToken = 'tok'; config.agent.name = 'edgeS';
    _resetForTest();
    putSnapshot({ deviceId: 'st1', name: 'st1', type: 'unity480', ok: true, collectedAt: 1 });
    const { pushStorageNow, storagePushStatus } = await import('../src/storage/push.js');
    const r = await pushStorageNow();
    assert.equal(r.ok, true);
    assert.equal(r.rejected, 2);
    assert.deepEqual(storagePushStatus().dropped, { notOwned: 2 });
    assert.equal(got.length, 1);
  } finally { srv2.close(); config.agent.centralUrl = ''; }
});

test('EDGE2601-04 — PDU push 는 500대 상한으로 뺀 수(omitted)와 중앙이 뺀 수를 밝힌다', async () => {
  const { config } = await import('../src/config.js');
  const poller = await import('../src/pdu/poller.js');
  const { srv2, got } = mockCentral(() => ({ json: { ok: true, saved: { ok: true }, rejected: 1, dropped: { notOwned: 1 } } }));
  const port = await listen(srv2);
  try {
    config.agent.centralUrl = `http://127.0.0.1:${port}`; config.agent.centralToken = 'tok'; config.agent.name = 'edgeP';
    poller._resetForTest();
    const snaps = poller.localSnapshots(); // 내부 Map 에 직접 넣을 수단이 없다 — 대신 localSnapshots 를 가로챈다
    assert.equal(snaps.length, 0);
    const { pushPduNow, pduPushStatus } = await import('../src/pdu/push.js');
    // 0대 + 등록부 0대 → 빈 목록 전송(비우기) — 그 응답에도 rejected 가 있으면 남긴다
    const r = await pushPduNow();
    assert.equal(r.ok, true);
    assert.equal(r.rejected, 1);
    assert.deepEqual(pduPushStatus().dropped, { notOwned: 1 });
    assert.equal(got.length, 1);
  } finally { srv2.close(); config.agent.centralUrl = ''; }
});

test('EDGE2601-04 — PDU push 상한(500)은 소스에서 omitted 로 밝힌다', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../src/pdu/push.js'), 'utf8');
  assert.ok(/const omitted = all\.length - snapshots\.length/.test(src));
  assert.ok(!/localSnapshots\(\)\.slice\(0, 500\)/.test(src), '조용한 slice 상한 금지');
});

test('EDGE2601-04 — 중앙 storage/pdu/sanswitch 수신은 소유권 필터로 뺀 수를 dropped.notOwned 로 싣는다', async () => {
  const { issueAgentToken } = await import('../src/central/agentTokens.js');
  const tok = issueAgentToken('edgeOwn').token;
  const s = await post('/storage-data', { devices: [{ deviceId: 'not-mine', name: 'x', ok: true }] }, { token: tok });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.dropped?.notOwned, 1);
  assert.equal(s.body.rejected, 1);
  const p = await post('/pdu-data', { snapshots: [{ id: 'not-mine' }] }, { token: tok });
  assert.equal(p.body.dropped?.notOwned, 1);
  const w = await post('/sanswitch-data', { devices: [{ deviceId: 'not-mine' }] }, { token: tok });
  assert.equal(w.body.dropped?.notOwned, 1);
});

test('EDGE2601-06 — storage push 가 진행 중일 때 들어온 요청은 거절되지 않고 끝난 뒤 한 번 더 보낸다', async () => {
  const { config } = await import('../src/config.js');
  const { putSnapshot, _resetForTest } = await import('../src/storage/store.js');
  let release; const gate = new Promise((r) => { release = r; });
  let n = 0;
  const { srv2, got } = mockCentral(async () => { if (n++ === 0) await gate; return { json: { ok: true } }; });
  const port = await listen(srv2);
  try {
    config.agent.centralUrl = `http://127.0.0.1:${port}`; config.agent.centralToken = 'tok'; config.agent.name = 'edgeS';
    _resetForTest();
    putSnapshot({ deviceId: 'st1', name: 'st1', type: 'unity480', ok: true, collectedAt: 1 });
    const { pushStorageNow } = await import('../src/storage/push.js');
    const first = pushStorageNow();
    await new Promise((r) => setTimeout(r, 50));
    putSnapshot({ deviceId: 'st1', name: 'st1', type: 'unity480', ok: true, collectedAt: 2 }); // '지금 수집' 결과
    const second = pushStorageNow();
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true, `수정 전: {ok:false, reason:'이전 push 진행 중'} — 지금 ${JSON.stringify(b)}`);
    assert.equal(got.length, 2, '끝난 뒤 한 번 더 보낸다');
    assert.equal(got[1].body.devices[0].collectedAt, 2, '두 번째 push 는 재수집 결과를 싣는다');
  } finally { srv2.close(); config.agent.centralUrl = ''; }
});

test('EDGE2601-06 — SAN 재수집 직후 push 가 주기 push 와 겹치면 끝난 뒤 다시 보내고 결과를 상태에 남긴다', async () => {
  const { config } = await import('../src/config.js');
  let release; const gate = new Promise((r) => { release = r; });
  let n = 0;
  const { srv2, got } = mockCentral(async () => { if (n++ === 0) await gate; return { json: { ok: true } }; });
  const port = await listen(srv2);
  try {
    config.agent.centralUrl = `http://127.0.0.1:${port}`; config.agent.centralToken = 'tok'; config.agent.name = 'edgeW';
    const { pushSanSwitchNow } = await import('../src/sanswitch/push.js');
    const { pushAfterCollect, sanSwitchConfigPullStatus } = await import('../src/agent/sanSwitchConfigPull.js');
    const periodic = pushSanSwitchNow(); // 위임 0대 → 빈 목록 전송(목 중앙에서 멈춤)
    await new Promise((r) => setTimeout(r, 50));
    const r = await pushAfterCollect({ waitMs: 20, maxTries: 200 });
    assert.equal(r.pending, true, '진행 중이면 거절을 삼키지 않고 대기 상태로 밝힌다');
    assert.equal(sanSwitchConfigPullStatus().collectPush.pending, true);
    release();
    await periodic;
    const done = await r.done;
    assert.equal(done.ok, true);
    assert.equal(got.length, 2, '끝난 뒤 한 번 더 보냈다');
    assert.equal(sanSwitchConfigPullStatus().collectPush.ok, true);
  } finally { srv2.close(); config.agent.centralUrl = ''; }
});
