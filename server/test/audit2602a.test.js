// v2.602 감사 수정 — 그룹 a(중앙 수신·pull 정제). 실제 함수·실제 central 라우터·가짜 엣지 HTTP 로 본다.
//   CEN2602-01(high) · CEN2602-02 · CEN2602-06 · WEB2602-02(서버 절반) · SEC2602-01 · EDGE2602-03
// 각 테스트는 **수정을 되돌리면 실패하도록** 입력을 골랐다(변이 검증은 감사 기준 커밋 9c1b4c1 판본으로 했다).
// 기준 시각에 Date.now() 를 쓰지 않는다(CLAUDE.md v2.517).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TOKEN = 'tok-2602a-shared';
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2602a-'));
process.env.CONFIG_DIR = CFG;
process.env.CENTRAL_TOKEN = TOKEN;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true'; // 로컬 가짜 엣지(127.0.0.1)로 실제 pull 을 돌린다

let srv; let base;
before(async () => {
  const { addCollector } = await import('../src/collector/registry.js');
  addCollector({ id: 'edge-known', name: 'edge-known', url: 'http://10.9.9.9:4000', token: 'ct', enabled: false });
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
  body: typeof body === 'string' ? body : JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

// ── CEN2602-01 ────────────────────────────────────────────────────────────────
test('CEN2602-01 — 오염된 serviceTag 가 담긴 export 를 pull 해도 원격 서버 집계(dedup)가 던지지 않는다', async () => {
  // JSON 으로 만들 수 있는 '자기 toString 이 함수가 아닌 객체' — String() 이 TypeError 를 낸다.
  const exportBody = JSON.stringify({
    version: { toString: 1 }, agent: 'edge-p', hostname: ['x'], datacenter: 'DC1',
    power: { byHost: [null, 'x', { host: { toString: 1 }, watts: 10 }, { host: 'h1', watts: '150', serviceTag: { a: 1 }, serverName: 's1' }] },
    authDeny: { count: 2, recent: [{ at: 1, why: { toString: 1 }, ip: '1.2.3.4' }, null], bySrc: 'x', evil: 1 },
    servers: [
      { id: '10.0.0.1', name: 'srv1', serviceTag: { toString: 1 }, model: 'R760', inv: { system: { model: { toString: 1 }, serviceTag: 'ABC' }, gpus: [{ model: 'A100' }, null], evil: { x: 1 } }, sensors: { t: 5, temps: { Inlet: 22, Bad: { x: 1 }, Str: '31' } } },
      null, 'str', { id: { x: 1 }, name: 'bad-id' },
      { id: '10.0.0.2', name: 'srv2', serviceTag: 'TAG2' },
    ],
  });
  const edge = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(exportBody); });
  await new Promise((r) => edge.listen(0, '127.0.0.1', r));
  try {
    const { addCollector } = await import('../src/collector/registry.js');
    const { pullNow } = await import('../src/collector/puller.js');
    const { getCollectorStatus } = await import('../src/collector/state.js');
    addCollector({ id: 'edge-p', name: 'edge-p', url: `http://127.0.0.1:${edge.address().port}`, token: 't', enabled: true });
    await pullNow();
    const st = getCollectorStatus('edge-p');
    assert.equal(st.ok, true, `pull 은 성공해야 한다: ${st.error}`);
    assert.equal(st.version, '', 'version 객체는 글자로 받지 않는다');
    assert.equal(st.hostname, '');
    assert.deepEqual(st.serversDropped, { notObject: 2, badId: 1, overCount: 0 }, '버린 원소는 사유별 개수로 밝힌다');
    assert.equal(st.authDeny.recent.length, 1);
    assert.equal(st.authDeny.recent[0].why, null);
    assert.deepEqual(st.authDeny.bySrc, []);
    assert.ok(!('evil' in st.authDeny));
    const { remoteServersResolved } = await import('../src/insights/analysisServers.js');
    let list;
    assert.doesNotThrow(() => { list = remoteServersResolved(); }, '함대 공용 집계 경로가 던지면 로컬 iDRAC 까지 사라진다');
    const s1 = list.find((x) => x.id === '10.0.0.1');
    assert.equal(s1.serviceTag, null, '객체는 null(지어낸 글자를 넣지 않는다)');
    assert.equal(s1.inv.system.model, null);
    assert.equal(s1.inv.system.serviceTag, 'ABC');
    assert.equal(s1.inv.gpus.length, 1);
    assert.ok(!('evil' in s1.inv));
    assert.deepEqual(s1.sensors.temps, { Inlet: 22, Str: 31 }, '숫자가 아닌 온도는 0 이 아니라 뺀다');
    assert.equal(list.length, 2);
    const { getRemoteHost } = await import('../src/collector/state.js').catch(() => ({}));
    if (typeof getRemoteHost === 'function') assert.equal(getRemoteHost('h1')?.serviceTag ?? '', '');
  } finally { edge.close(); }
});

test('CEN2602-01 — sanitizeEdgeExport 는 순수하고 servers 필드가 없으면 null(구버전 엣지)', async () => {
  const { sanitizeEdgeExport, sanitizeRemoteServers } = await import('../src/collector/remoteInventory.js');
  const d = sanitizeEdgeExport({ version: '2.601.0', agent: 'a'.repeat(200) });
  assert.equal(d.servers, null);
  assert.equal(d.agent.length, 64);
  const many = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}` }));
  const r = sanitizeRemoteServers(many, { max: 3 });
  assert.equal(r.servers.length, 3);
  assert.equal(r.dropped.overCount, 2);
});

// ── CEN2602-02 ────────────────────────────────────────────────────────────────
test('CEN2602-02 — putEdgeLog 는 줄 길이·상태·노드를 좁힌다', async () => {
  const { putEdgeLog, _resetForTest } = await import('../src/central/edgeLogStore.js');
  _resetForTest();
  const rec = putEdgeLog('edge-x', {
    at: { toString: 1 },
    node: { agent: 'edge-x', huge: 'y'.repeat(100_000), pid: { x: 1 } },
    logs: { lastId: 9, items: [{ id: 1, time: 't', level: 'info', msg: 'm'.repeat(50_000) }, null, 'x'] },
    status: [{ key: 'k', label: 'l', group: 'g', ok: true, value: { big: 'z'.repeat(2 * 1024 * 1024) } }, 'x', ...Array.from({ length: 300 }, (_, i) => ({ key: `k${i}` }))],
  });
  assert.ok(rec);
  assert.equal(rec.logs.items.length, 1);
  assert.equal(rec.logs.items[0].msg.length, 2_000, '줄 길이 상한');
  assert.ok(!('huge' in rec.node), '노드는 아는 키만');
  assert.equal(rec.node.pid, null);
  assert.equal(rec.reportedAt, null);
  assert.equal(rec.status.length, 200, '상태 항목 수 상한');
  assert.equal(rec.status[0].value, null, '크기 상한을 넘는 값은 싣지 않는다');
  assert.equal(rec.status[0].valueDropped, true);
  assert.ok(rec.statusCapped.dropped >= 101);
  assert.ok(JSON.stringify(rec).length < 1024 * 1024, `보관분 크기: ${JSON.stringify(rec).length}`);
});

test('CEN2602-02 — 공유 토큰 회신은 모르는 이름이면 403, 요청 없는 회신이면 저장하지 않는다(남의 보관분을 덮지 못한다)', async () => {
  const { putEdgeLog, latestEdgeLog, _resetForTest } = await import('../src/central/edgeLogStore.js');
  const jobs = await import('../src/central/edgeLogJobs.js');
  _resetForTest(); jobs._resetForTest();
  putEdgeLog('edge-known', { via: 'pull', ok: true, logs: { items: [{ id: 1, msg: 'real' }] } });
  let r = await post('/edge-log-result', { agent: 'edge-known', logs: { items: [{ id: 2, msg: 'forged' }] } });
  assert.equal(r.status, 200);
  assert.equal(r.body.stored, false, '요청하지 않은 공유 토큰 회신');
  assert.equal(latestEdgeLog('edge-known').logs.items[0].msg, 'real', '실제 보관분이 남아 있어야 한다');
  r = await post('/edge-log-result', { agent: 'nobody-knows', logs: { items: [] } });
  assert.equal(r.status, 403);
  // 중앙이 요청해 둔 작업이면 저장한다
  jobs.enqueueEdgeLogJob('edge-known'); jobs.takeEdgeLogJob('edge-known');
  r = await post('/edge-log-result', { agent: 'edge-known', logs: { items: [{ id: 3, msg: 'answer' }] } });
  assert.equal(r.status, 200);
  assert.equal(r.body.stored, true);
  assert.equal(r.body.acked, true);
  assert.equal(latestEdgeLog('edge-known').logs.items[0].msg, 'answer');
});

// ── CEN2602-06 ────────────────────────────────────────────────────────────────
test('CEN2602-06 — ack errors 는 배열만, 원소는 글자 300자', async () => {
  const assign = await import('../src/central/svcmonAssign.js');
  assign.setAssignment('edge-s', {}, []);
  const cur = assign.getAssignmentForAgent('edge-s');
  let r = assign.ackAssignment('edge-s', { sig: cur.sig, applied: { added: 0, newTests: 0 }, errors: 'this is not an array of 37 ch' });
  let a = assign.listAssignments().find((x) => x.agent === 'edge-s') || {};
  assert.deepEqual(a.ack?.errors ?? [], [], '글자 수를 오류 수로 세지 않는다');
  assert.equal(a.ack?.errorsInvalid, true);
  assert.notEqual(r.state, 'active', '형식을 못 읽은 회신을 정상으로 두지 않는다');
  assert.doesNotThrow(() => { r = assign.ackAssignment('edge-s', { sig: cur.sig, applied: null, errors: { length: 3 } }); });
  r = assign.ackAssignment('edge-s', { sig: cur.sig, applied: { added: 0, newTests: 0 }, errors: ['e'.repeat(1000), { x: 1 }] });
  a = assign.listAssignments().find((x) => x.agent === 'edge-s');
  assert.equal(r.state, 'error');
  assert.equal(a.ack.errors[0].length, 300);
  assert.equal(a.ack.errors[1], '(형식 오류)');
});

// ── WEB2602-02 (서버 절반) ────────────────────────────────────────────────────
test('WEB2602-02 — invScan 은 인증 전 거부 칸을 종류별로 넘긴다', async () => {
  const { scanInventory } = await import('../src/portalcheck/invScan.js');
  const { PULL_UNAUTH_KEY } = await import('../src/central/pullStats.js');
  const scan = scanInventory({ now: 1_800_000_000_000, rejects: { rows: [{ agent: PULL_UNAUTH_KEY, total: 6, byKind: { auth: 1, disabled: 3, 'unknown-route': 2 } }] } });
  assert.equal(scan.unauthRejects, 6);
  assert.deepEqual(scan.unauthRejectsByKind, { auth: 1, disabled: 3, 'unknown-route': 2 });
});

// ── SEC2602-01 ────────────────────────────────────────────────────────────────
test('SEC2602-01 — register-collector 의 긴 urlHint 는 정규식 전에 400(이벤트 루프를 멈추지 않는다)', async () => {
  const t0 = performance.now();
  const r = await post('/register-collector', { name: 'edgeZ', collectorToken: 'tok', urlHint: `http://10.1.2.3/${'/'.repeat(60_000)}x` });
  const ms = performance.now() - t0;
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.ok(ms < 1500, `응답 ${Math.round(ms)}ms — 정규식 O(n²) 로 들어갔다`);
  const r2 = await post('/register-collector', { name: 'edgeZ', collectorToken: { toString: 1 }, urlHint: 'http://10.1.2.3' });
  assert.equal(r2.status, 400);
  const { trimTrailingSlashes } = await import('../src/routes/central.js');
  assert.equal(trimTrailingSlashes('/a/b///'), '/a/b');
  assert.equal(trimTrailingSlashes('///'), '');
  const t1 = performance.now();
  trimTrailingSlashes(`${'/'.repeat(200_000)}x`);
  assert.ok(performance.now() - t1 < 50);
  const src = fs.readFileSync(new URL('../src/routes/central.js', import.meta.url), 'utf8');
  assert.equal(src.includes(String.raw`.replace(/\/+$/`), false, 'central.js 에 끝 슬래시 정규식을 되살리지 않는다');
});

// ── EDGE2602-03 ───────────────────────────────────────────────────────────────
test('EDGE2602-03 — 중앙 버전이 statusOnly 를 모르면(v2.580) 상태 전용 push 를 보내지 않는다', async () => {
  const { config } = await import('../src/config.js');
  let version = '2.580.0';
  const hits = [];
  const central = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      hits.push({ url: req.url, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/api/central/health-probe')) { res.end(JSON.stringify({ ok: true, version })); return; }
      res.end(JSON.stringify({ ok: true, saved: 0 }));
    });
  });
  await new Promise((r) => central.listen(0, '127.0.0.1', r));
  const prev = { url: config.agent.centralUrl, token: config.agent.centralToken };
  // 위임 장비 1대(스냅샷 없음) — 목록 비우기가 아니라 상태 전용 경로를 탄다.
  fs.writeFileSync(path.join(CFG, 'storage-devices.json'), JSON.stringify({ devices: [{ id: 'st-1', name: 'u1', type: 'unity480', host: '10.0.0.5', username: 'a', password: 'b', agent: '' }] }));
  try {
    config.agent.centralUrl = `http://127.0.0.1:${central.address().port}`;
    config.agent.centralToken = 'tok';
    const push = await import('../src/storage/push.js');
    push._resetStatusOnlyCapForTest();
    const r = await push.pushStorageNow();
    assert.equal(r.statusSent, false);
    assert.equal(r.statusSkipped, 'central-too-old');
    assert.equal(hits.filter((h) => h.url.startsWith('/api/central/storage-data')).length, 0, '구버전 중앙에 devices:[] 를 보내면 목록이 비워진다');
    assert.equal(push.storagePushStatus().statusSkipped, 'central-too-old');
    // 신버전 중앙이면 보낸다
    version = '2.602.0';
    push._resetStatusOnlyCapForTest();
    const r2 = await push.pushStorageNow();
    const sent = hits.filter((h) => h.url.startsWith('/api/central/storage-data'));
    if (r2.cleared === undefined) {
      assert.equal(r2.statusSent, true);
      assert.equal(sent.length, 1);
      assert.equal(JSON.parse(sent[0].body).statusOnly, true);
    }
    // 버전을 모르면 보내지 않는다
    version = 'dev';
    push._resetStatusOnlyCapForTest();
    const cap = await push.centralStatusOnlySupport();
    assert.equal(cap.ok, false);
    assert.equal(cap.reason, 'central-version-unknown');
  } finally {
    config.agent.centralUrl = prev.url; config.agent.centralToken = prev.token;
    central.close();
  }
});
