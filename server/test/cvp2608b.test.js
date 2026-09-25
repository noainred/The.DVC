/**
 * test/cvp2608b.test.js — Arista CloudVision(CVP) 수집을 **목 CVP HTTP 서버**와 **실제 centralRouter** 로 끝까지 돌린다(v2.608).
 *
 * 순수 헬퍼만 고정하는 테스트는 v2.566 TDZ 같은 결함(push 함수가 첫 줄에서 죽는다)을 통과시킨다 — 그래서 여기서는
 * poller.pollCvpOnce 를 실제로 부르고 → 엣지 DB 적재 → push.pushCvpNow 가 실제 centralRouter(express 마운트)로 올라가
 * → 중앙 DB(agent = 엣지 이름) 적재까지 본다. 그리고:
 *   · 토큰(Bearer)·세션 로그인(access_token 쿠키) 두 방식 · 로그인 401 → authGuard 주기 정지 · 수동 실행은 허용 · 자격증명 변경 시 재개
 *   · 후보 첫 경로 404 → 둘째 성공 → usedPaths · NDJSON 인벤토리
 *   · 남의 cvp_id·비객체 원소 거절(rejected) · 위임 0대 엣지도 상태를 push(v2.517 sendStatusOnly)
 * ⚠ 목 CVP 의 응답 모양은 합성이다(실장비 CVP 를 본 적이 없다 — docs/CVP.md).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvp2608b-'));
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.CENTRAL_TOKEN = 'ctok-2608';
process.env.CVP_PUSH_GZIP = 'true';

/** 목 CVP. mode: 'token' | 'password'. resourceApi=false 면 Resource API 경로가 404(옛 API 로 폴백). */
function mockCvp({ token = 'TOK', user = 'svc', pass = 'PW', resourceApi = true } = {}) {
  const hits = { login: 0, inventory: 0, total: 0, logout: 0, unauthorized: 0 };
  let octets = 1_000_000;
  const devices = [
    { serial: 'SN-LEAF1', hostname: 'leaf1', model: 'DCS-7050SX3', ver: '4.30.1F', streaming: true },
    { serial: 'SN-OLD', hostname: 'oldsw', model: 'DCS-7010', ver: '4.20.0F', streaming: false },
  ];
  const srv = http.createServer((req, res) => {
    hits.total++;
    const send = (code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    if (req.method === 'POST' && p === '/cvpservice/login/authenticate.do') {
      hits.login++;
      const bufs = []; req.on('data', (c) => bufs.push(c));
      req.on('end', () => {
        let b = {}; try { b = JSON.parse(Buffer.concat(bufs).toString()); } catch { /* */ }
        if (b.userId === user && b.password === pass) return send(200, { sessionId: 'SESS-1', username: user }, { 'Set-Cookie': 'access_token=SESS-1; Path=/; HttpOnly' });
        hits.unauthorized++;
        return send(401, { errorCode: '112498', errorMessage: 'Unauthorized User' });
      });
      return;
    }
    if (req.method === 'POST' && p === '/cvpservice/login/logout.do') { hits.logout++; return send(200, { data: 'success' }); }
    const authed = req.headers.authorization === `Bearer ${token}` || /access_token=SESS-1/.test(String(req.headers.cookie || ''));
    if (!authed) { hits.unauthorized++; return send(401, { errorMessage: 'unauthorized' }); }
    if (p === '/api/resources/inventory/v1/Device/all') {
      hits.inventory++;
      if (!resourceApi) return send(404, { error: 'not found' });
      return send(200, devices.map((d) => JSON.stringify({ result: { value: { key: { deviceId: d.serial }, hostname: d.hostname, modelName: d.model, softwareVersion: d.ver,
        streamingStatus: d.streaming ? 'STREAMING_STATUS_ACTIVE' : 'STREAMING_STATUS_INACTIVE' } } })).join('\n'));
    }
    if (p === '/cvpservice/inventory/devices') {
      hits.inventory++;
      return send(200, devices.map((d) => ({ hostname: d.hostname, serialNumber: d.serial, modelName: d.model, version: d.ver, ipAddress: '10.9.9.9', streamingStatus: d.streaming ? 'active' : 'inactive' })));
    }
    if (p === '/cvpservice/cvpInfo/getCvpInfo.do') return send(200, { version: '2024.2.0' });
    const m = /^\/api\/v1\/rest\/([^/]+)\/(.*)$/.exec(p);
    if (m) {
      const [, serial, rest] = m;
      if (serial !== 'SN-LEAF1') return send(404, {});
      if (rest === 'Sysdb/interface/status/eth/phy/slice/1/intfStatus/all') {
        return send(200, { notifications: [{ timestamp: 1, path: '/Sysdb/interface/status/eth/phy/slice/1/intfStatus/all', updates: {
          Ethernet1: { key: 'Ethernet1', value: { operStatus: { Name: 'intfOperUp' }, adminEnabled: true, speed: { value: 10_000_000_000 }, description: 'uplink' } },
          Ethernet2: { key: 'Ethernet2', value: { operStatus: { Name: 'intfOperDown' }, adminEnabled: true } },
          Ethernet3: { key: 'Ethernet3', value: { operStatus: { Name: 'intfOperDown' }, adminEnabled: false } },
        } }] });
      }
      if (rest === 'Smash/counters/ethIntf/FastCounters/current') {
        octets += 5_000;
        return send(200, { notifications: [
          { path: '/Smash/counters/ethIntf/FastCounters/current/Ethernet1', updates: { inOctets: { key: 'inOctets', value: octets }, outOctets: { key: 'outOctets', value: octets * 2 }, inErrors: { key: 'inErrors', value: 0 } } },
        ] });
      }
      if (rest === 'Sysdb/routing/bgp/export/vrfBgpPeerInfoStatusEntryTable') {
        return send(200, { notifications: [{ path: '/bgp/all', updates: {
          '10.0.0.1': { value: { bgpPeerState: 'Established', bgpPeerAs: 65001, bgpPeerPrefixesReceived: 42 } },
          '10.0.0.2': { value: { bgpPeerState: 'Idle', bgpPeerAs: 65002 } } } }] });
      }
      if (rest === 'Sysdb/environment/power/status') {
        return send(200, { notifications: [{ path: '/power/all', updates: { PowerSupply1: { value: { state: 'ok' } }, PowerSupply2: { value: { state: 'powerSupplyFailed' } } } }] });
      }
      if (rest === 'Sysdb/environment/cooling/status') return send(403, { errorMessage: 'RBAC denied' });   // 텔레메트리 403 은 인증 정지 대상이 아니다
      return send(404, {});
    }
    return send(404, {});
  });
  return { srv, hits };
}
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

let central; let centralPort;
before(async () => {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use('/api/central', centralRouter);
  central = http.createServer(app);
  centralPort = await listen(central);
});
after(() => { central?.close(); });

async function freshModules() {
  const reg = await import('../src/cvp/registry.js');
  const settings = await import('../src/cvp/settings.js');
  const poller = await import('../src/cvp/poller.js');
  const db = await import('../src/cvp/db.js');
  const store = await import('../src/cvp/store.js');
  const push = await import('../src/cvp/push.js');
  const { config } = await import('../src/config.js');
  return { reg, settings, poller, db, store, push, config };
}

test('중앙 직접 — 토큰 방식 · NDJSON 인벤토리 · 두 번째 주기에 처리량 · DB 적재 · 스트리밍 아닌 장비는 텔레메트리 건너뜀', async () => {
  const { reg, settings, poller, db, store, config } = await freshModules();
  if (!(await db.available())) return; // node:sqlite 미지원 런타임
  config.agent.centralUrl = '';
  const { srv, hits } = mockCvp({ token: 'TOK-A' });
  const port = await listen(srv);
  try {
    settings.saveSettings({ enabled: true, intervalMs: 300_000 });
    const s = reg.saveServer({ name: 'CVP-direct', host: `http://127.0.0.1:${port}`, authMode: 'token', token: 'TOK-A' });
    const r1 = await poller.pollCvpOnce({ manual: true });
    assert.equal(r1.ok, true); assert.equal(r1.collected, 1, JSON.stringify(store.getStatus(s.id)));
    const st = store.getStatus(s.id);
    assert.equal(st.ok, true); assert.equal(st.deviceCount, 2); assert.equal(st.cvpVersion, '2024.2.0');
    assert.equal(st.usedPaths.inventory, '/api/resources/inventory/v1/Device/all');
    assert.match(st.missing.cooling || '', /403/, '텔레메트리 403 은 사유로만 남는다');
    let rows = (await db.listDeviceRows({ agent: db.LOCAL_AGENT, cvpId: s.id })).rows;
    const leaf = rows.find((d) => d.key === 'SN-LEAF1');
    assert.equal(leaf.eosVersion, '4.30.1F'); assert.equal(leaf.streaming, true);
    assert.deepEqual(leaf.ports, { total: 3, up: 1, down: 1 });
    assert.equal(leaf.bgpPeers.length, 2);
    assert.ok(Array.isArray(leaf.partsList), '전원은 읽었으니 부품 목록이 있다(냉각은 403 — partsMissingKinds)');
    assert.deepEqual(leaf.extra.partsMissingKinds.sort(), ['cooling', 'temperature', 'xcvr'].sort());
    const old = rows.find((d) => d.key === 'SN-OLD');
    assert.equal(old.telemetry, 'not-streaming'); assert.equal(old.ports, null, '스트리밍 아닌 장비의 포트는 null(0개가 아니다)');
    let det = await db.deviceDetail(db.LOCAL_AGENT, s.id, 'SN-LEAF1');
    assert.equal(det.ports.find((p) => p.name === 'Ethernet1').inBps, null, '첫 주기는 처리량 null');
    assert.equal((await db.dbStats()).rows.sample, 0, '첫 주기(처리량 null)는 원시 표본을 만들지 않는다');
    await new Promise((r) => setTimeout(r, 120));
    await poller.pollCvpOnce({ manual: true });
    det = await db.deviceDetail(db.LOCAL_AGENT, s.id, 'SN-LEAF1');
    const e1 = det.ports.find((p) => p.name === 'Ethernet1');
    assert.ok(e1.inBps > 0, `두 번째 주기에는 처리량이 있다(${e1.inBps})`);
    assert.ok(e1.outBps > e1.inBps);
    assert.equal(det.ports.find((p) => p.name === 'Ethernet2').inBps, null, '카운터 없는 포트는 null');
    const stats = await db.dbStats();
    assert.equal(stats.rows.sample, 1, '링크가 올라온 포트(Ethernet1)만 원시 표본');
    assert.equal(stats.rows.daily, 1);
    assert.ok(hits.logout === 0, '토큰 방식은 로그아웃하지 않는다');
    reg.deleteServer(s.id);
  } finally { srv.close(); }
});

test('세션 로그인 · 후보 첫 경로 404 → 둘째(옛 API) 성공 → usedPaths · logout', async () => {
  const { reg, poller, store, db, config } = await freshModules();
  if (!(await db.available())) return;
  config.agent.centralUrl = '';
  const { srv, hits } = mockCvp({ resourceApi: false });
  const port = await listen(srv);
  try {
    const s = reg.saveServer({ name: 'CVP-pw', host: `http://127.0.0.1:${port}`, authMode: 'password', username: 'svc', password: 'PW' });
    await poller.pollCvpOnce({ manual: true, only: [s.id] });
    const st = store.getStatus(s.id);
    assert.equal(st.ok, true, st.error);
    assert.equal(st.usedPaths.inventory, '/cvpservice/inventory/devices');
    assert.ok(hits.login >= 1 && hits.logout >= 1, '세션을 열고 반납한다');
    const leaf = (await db.listDeviceRows({ agent: db.LOCAL_AGENT, cvpId: s.id })).rows.find((d) => d.key === 'SN-LEAF1');
    assert.equal(leaf.mgmtIp, '10.9.9.9');
    reg.deleteServer(s.id);
  } finally { srv.close(); }
});

test('401 → 주기 수집 정지(로그인 시도 0) · 수동 실행은 시도 · 자격증명을 바꾸면 자동 재개', async () => {
  const { reg, poller, store, config } = await freshModules();
  config.agent.centralUrl = '';
  const { srv, hits } = mockCvp({ user: 'svc', pass: 'RIGHT' });
  const port = await listen(srv);
  try {
    poller.cvpAuthGuard._resetForTest();
    const s = reg.saveServer({ name: 'CVP-bad', host: `http://127.0.0.1:${port}`, authMode: 'password', username: 'svc', password: 'WRONG' });
    await poller.pollCvpOnce({ only: [s.id] });                // 주기(타이머와 같은 경로)
    assert.equal(hits.login, 1);
    const st = store.getStatus(s.id);
    assert.equal(st.ok, false); assert.ok(st.authStopped, '정지 사실을 상태가 말한다'); assert.match(st.error, /인증 실패/);
    await poller.pollCvpOnce({ only: [s.id] });
    assert.equal(hits.login, 1, '정지 중 주기 수집은 로그인하지 않는다(계정 잠금 방지)');
    assert.ok(store.getStatus(s.id).authStopped);
    await poller.pollCvpOnce({ manual: true, only: [s.id] });
    assert.equal(hits.login, 2, '수동 실행은 시도한다(고쳤는지 확인할 길)');
    reg.saveServer({ id: s.id, name: 'CVP-bad', host: `http://127.0.0.1:${port}`, authMode: 'password', username: 'svc', password: 'RIGHT' });
    await poller.pollCvpOnce({ only: [s.id] });
    assert.equal(hits.login, 3, '자격증명이 바뀌면 주기 수집이 재개된다');
    assert.equal(store.getStatus(s.id).ok, true);
    assert.equal(store.getStatus(s.id).authStopped, null);
    reg.deleteServer(s.id);
  } finally { srv.close(); }
});

test('토큰 방식 401(첫 조회) 도 자격증명 거부로 멈춘다 · 연결 테스트는 {ok,deviceCount}/{ok:false,reason}', async () => {
  const { reg, poller, store, config } = await freshModules();
  config.agent.centralUrl = '';
  const { srv, hits } = mockCvp({ token: 'GOOD' });
  const port = await listen(srv);
  try {
    poller.cvpAuthGuard._resetForTest();
    const s = reg.saveServer({ name: 'CVP-tok', host: `http://127.0.0.1:${port}`, authMode: 'token', token: 'BAD' });
    await poller.pollCvpOnce({ only: [s.id] });
    assert.ok(store.getStatus(s.id).authStopped);
    const n = hits.total;
    await poller.pollCvpOnce({ only: [s.id] });
    assert.equal(hits.total, n, '정지 중에는 요청 0');
    const bad = await poller.testServerConnection(reg.getServerWithSecret(s.id));
    assert.equal(bad.ok, false); assert.match(bad.reason, /인증 실패/);
    const good = await poller.testServerConnection({ ...reg.getServerWithSecret(s.id), token: 'GOOD', id: undefined });
    assert.equal(good.ok, true); assert.equal(good.deviceCount, 2);
    reg.deleteServer(s.id);
  } finally { srv.close(); }
});

test('엣지 → 실제 centralRouter push — 중앙 DB 에 엣지 이름으로 적재 · 남의 cvp_id·비객체 거절 · 0대 엣지도 상태 push', async () => {
  const { reg, settings, poller, db, push, config } = await freshModules();
  if (!(await db.available())) return;
  const { srv } = mockCvp({ token: 'TOK-E' });
  const port = await listen(srv);
  try {
    settings.saveSettings({ enabled: true });
    const mine = reg.saveServer({ name: 'CVP-edge', host: `http://127.0.0.1:${port}`, authMode: 'token', token: 'TOK-E', agent: 'edge-a' });
    const other = reg.saveServer({ name: 'CVP-other', host: `http://127.0.0.1:${port}`, authMode: 'token', token: 'TOK-E', agent: 'edge-b' });
    config.agent.centralUrl = `http://127.0.0.1:${centralPort}`;
    config.agent.centralToken = 'ctok-2608';
    config.agent.name = 'edge-a';
    push._resetForTest();
    await poller.pollCvpOnce({ manual: true });
    await new Promise((r) => setTimeout(r, 120));
    await poller.pollCvpOnce({ manual: true });
    const pr = await push.pushCvpNow();
    assert.equal(pr.ok, true, pr.reason);
    // 폴러도 수집 뒤 push 를 한다(비동기) — 원시 표본은 둘 중 먼저 끝난 쪽이 올렸다. 도착은 아래 중앙 DB·추이로 확인한다.
    const central = (await db.listDeviceRows({ agent: 'edge-a', cvpId: mine.id })).rows;
    assert.equal(central.length, 2, '중앙 DB 에 엣지 이름으로 장비 2대');
    assert.ok((await db.deviceDetail('edge-a', mine.id, 'SN-LEAF1')).ports.find((p) => p.name === 'Ethernet1').inBps > 0);
    const { edgeCvpStatuses } = await import('../src/central/cvpEdge.js');
    assert.equal(edgeCvpStatuses().find((x) => x.cvpId === mine.id && x.agent === 'edge-a').ok, true);
    const series = await db.portSeries({ agent: 'edge-a', cvpId: mine.id, key: 'SN-LEAF1', port: 'Ethernet1', hours: 24 });
    assert.equal(series.source, 'raw'); assert.ok(series.points.length >= 1);
    // 커서가 전진했다 — 다시 보내면 표본 0(상태·장비는 다시 간다)
    const pr2 = await push.pushCvpNow();
    assert.equal(pr2.ok, true); assert.equal(pr2.sent, 0);
    assert.equal(pr2.devices, 0, '구성이 그대로면 장비 레코드를 다시 보내지 않는다');
    assert.equal(pr2.touched, 2, '대신 수집 시각만(touch)');
    // 세 번째 주기 — 레코드는 안 가도 표본이 중앙의 마지막 처리량을 갱신한다
    await new Promise((r) => setTimeout(r, 120));
    await poller.pollCvpOnce({ manual: true });
    await push.pushCvpNow();
    const edgeE1 = (await db.deviceDetail(db.LOCAL_AGENT, mine.id, 'SN-LEAF1')).ports.find((p) => p.name === 'Ethernet1');
    const centE1 = (await db.deviceDetail('edge-a', mine.id, 'SN-LEAF1')).ports.find((p) => p.name === 'Ethernet1');
    assert.equal(centE1.inBps, edgeE1.inBps, '중앙 port_latest 처리량 = 엣지 최신(표본으로 갱신)');
    const cDev = (await db.listDeviceRows({ agent: 'edge-a', cvpId: mine.id })).rows.find((d) => d.key === 'SN-LEAF1');
    const eDev = (await db.listDeviceRows({ agent: db.LOCAL_AGENT, cvpId: mine.id })).rows.find((d) => d.key === 'SN-LEAF1');
    assert.equal(cDev.collectedAt, eDev.collectedAt, 'touch 로 수집 시각이 따라온다');

    // 위조: 남의 cvp_id·비객체 원소·짧은 행
    const res = await fetch(`http://127.0.0.1:${centralPort}/api/central/cvp-data`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': 'ctok-2608', 'X-Agent-Name': 'edge-a' },
      body: JSON.stringify({ agent: 'edge-a', chunk: 1, chunks: 2,
        devices: [{ cvpId: other.id, key: 'EVIL', ts: Date.now() }, null, 'x', { cvpId: mine.id, key: 'SN-NEW', ts: Date.now(), hostname: 'new' }],
        rows: [[other.id, 'EVIL', 'Et1', Date.now(), 1, 1, 1, 1, 0, 0], ['bad']] }),
    });
    const j = await res.json();
    assert.equal(res.status, 200);
    assert.ok(j.rejected >= 4, JSON.stringify(j));
    assert.ok(j.dropped.notOwned >= 2);
    assert.equal((await db.listDeviceRows({ agent: 'edge-a', cvpId: other.id })).rows.length, 0, '남의 cvp_id 는 적재되지 않는다');
    assert.ok((await db.listDeviceRows({ agent: 'edge-a', cvpId: mine.id })).rows.some((d) => d.key === 'SN-NEW'), '내 것은 적재된다');

    // 위임 0대 엣지 — 상태만이라도 올린다(빈 목록으로 그 엣지 보관분을 비운다).
    // v2.612 CEN2612-01: 중앙은 위임 0건 엣지의 상태를 **보관하지 않는다**(상태 슬롯을 차지해 실제 위임 엣지를 429 로 밀어내던 결함).
    config.agent.name = 'edge-zero';
    push._resetForTest();
    const z = await push.pushCvpNow();
    assert.equal(z.ok, true, z.reason); assert.equal(z.servers, 0);
    assert.equal(push.cvpPushStatus().cleared, true);
    const { edgeCvpSummary } = await import('../src/central/cvpEdge.js');
    assert.ok(!edgeCvpSummary().some((e) => e.agent === 'edge-zero'), '위임 0건 엣지는 상태 슬롯을 차지하지 않는다(noDelegation)');
  } finally {
    srv.close();
    config.agent.centralUrl = '';
  }
});

test('push 실패는 조용하지 않다 — 상태와 콘솔에 남는다', async () => {
  const { push, config } = await freshModules();
  config.agent.centralUrl = 'http://127.0.0.1:1';
  config.agent.centralToken = 'x';
  config.agent.name = 'edge-a';
  push._resetForTest();
  const warns = []; const orig = console.warn; console.warn = (...a) => warns.push(a.join(' '));
  try {
    const r = await push.pushCvpNow();
    assert.equal(r.ok, false);
    assert.equal(push.cvpPushStatus().ok, false);
    assert.ok(warns.some((w) => /cvp-push/.test(w)));
  } finally { console.warn = orig; config.agent.centralUrl = ''; }
});

test('설정 pull 진입 함수 — 중앙 미설정이면 즉시 반환(던지지 않는다)', async () => {
  const { config } = await import('../src/config.js');
  config.agent.centralUrl = '';
  const { pullCvpConfigNow, cvpConfigPullStatus } = await import('../src/agent/cvpConfigPull.js');
  const r = await pullCvpConfigNow();
  assert.equal(r.ok, false);
  assert.equal(typeof cvpConfigPullStatus().intervalMs, 'number');
});
