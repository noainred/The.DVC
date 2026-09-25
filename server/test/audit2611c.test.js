/**
 * test/audit2611c.test.js — v2.611 감사 그룹 C(CVP·SAN 사용량 push·SQLite 파일 권한·CVP 화면 서버 쪽) 회귀.
 *
 * 고정하는 것(발견 ID):
 *  · CEN2611-03 = EDGE2611-04 = DB2611-03 — 중앙 DB 불가면 cvp-data·sanswitch-perf 가 503(상태만 온 요청은 200), 엣지는 커서·보낸 해시를
 *    전진하지 않는다(구버전 중앙의 200 + saved.unavailable 도 실패로) · touch 가 중앙에 없는 행이면 레코드를 다시 보낸다.
 *  · CEN2611-02 — CVP 수신 저장 키 대소문자 정규화(상태·DB 행 한 벌) · 변형 행 모으기.
 *  · EDGE2611-05 = DB2611-07 — 꽉 찬 페이지는 같은 push 안에서 이어 보낸다 · backlogRows · 미전송분 prune 계수(lostUnsent).
 *  · EDGE2611-06 — 비-2xx 본문 reason · 404 판정.
 *  · DB2611-01 — 본체·-wal·-shm 0600 · DB2611-02 samplesAfter 가 rowid 로 탄다 · DB2611-04 importSamples 분할(동시 적재 성공 · 이중 계수 없음)
 *  · DB2611-05 — 꺼져 있어도 보존 정리 · DB2611-06 일 롤업 오류 표본 수(inErrN · 구버전 표 ALTER)
 *  · COL2611-04·05·07·08 · WEB2611-05(서버) · TIM2611-01·02·05
 * 실제 centralRouter(express) 와 목 CVP·목 중앙 HTTP 서버로 진입 함수를 호출한다(순수 헬퍼만 보면 v2.566 TDZ 류를 놓친다).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2611c-'));
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.CENTRAL_TOKEN = 'ctok-2611';
process.env.CVP_PUSH_ROWS = '1000';
process.env.CVP_PUSH_GZIP = 'true';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function mods() {
  return {
    reg: await import('../src/cvp/registry.js'),
    settings: await import('../src/cvp/settings.js'),
    poller: await import('../src/cvp/poller.js'),
    db: await import('../src/cvp/db.js'),
    store: await import('../src/cvp/store.js'),
    push: await import('../src/cvp/push.js'),
    edge: await import('../src/central/cvpEdge.js'),
    config: (await import('../src/config.js')).config,
  };
}

/** 본문을 모으고 응답을 고를 수 있는 목 중앙. */
function mockCentral(respond) {
  const got = [];
  const srv = http.createServer((req, res) => {
    const bufs = [];
    req.on('data', (c) => bufs.push(c));
    req.on('end', () => {
      let raw = Buffer.concat(bufs);
      if (req.headers['content-encoding'] === 'gzip') { try { raw = zlib.gunzipSync(raw); } catch { /* */ } }
      let body = null; try { body = JSON.parse(raw.toString('utf8')); } catch { /* */ }
      got.push({ url: req.url, body });
      const r = respond(body, got.length);
      res.writeHead(r.status, { 'Content-Type': r.html ? 'text/html' : 'application/json' });
      res.end(r.html ? r.html : JSON.stringify(r.body));
    });
  });
  return { srv, got };
}

/** 목 CVP — devices 는 매 요청 읽는 배열(바꿔 끼울 수 있다). 텔레메트리는 counters 만 준다(부품·BGP·인터페이스는 404). */
function mockCvp(state) {
  const srv = http.createServer((req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (req.headers.authorization !== 'Bearer TOK') return send(401, {});
    if (p === '/api/resources/inventory/v1/Device/all') {
      if (state.emptyInventory) return send(200, '');
      return send(200, state.devices.map((d) => JSON.stringify({ result: { value: { key: { deviceId: d }, hostname: d.toLowerCase(), streamingStatus: 'STREAMING_STATUS_ACTIVE' } } })).join('\n'));
    }
    const m = /^\/api\/v1\/rest\/([^/]+)\/(.*)$/.exec(p);
    if (m && m[2] === 'Smash/counters/ethIntf/FastCounters/current') {
      state.octets = (state.octets || 1000) + 1000;
      return send(200, { notifications: [{ path: '/x/Ethernet1', updates: { inOctets: { key: 'inOctets', value: state.octets }, outOctets: { key: 'outOctets', value: state.octets } } }] });
    }
    return send(404, {});
  });
  return srv;
}

async function withUnavailableDb(file, fn, reset) {
  const { config } = await import('../src/config.js');
  const orig = config.dbDir;
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2611c-bad-'));
  fs.mkdirSync(path.join(bad, file)); // 디렉터리라 SQLite 가 열 수 없다(잠금이 아닌 오류 → unavailable 래치)
  config.dbDir = bad; reset();
  try { return await fn(); } finally { config.dbDir = orig; reset(); }
}

// ── CEN2611-03 / DB2611-03 ────────────────────────────────────────────────────

test('CEN2611-03 — 중앙 CVP DB 불가면 cvp-data 는 503 dbUnavailable(상태는 저장) · 상태만 온 요청은 200', async () => {
  const { reg, db, edge } = await mods();
  if (!(await db.available())) return;
  const s = reg.saveServer({ name: 'CVP-u', host: 'http://127.0.0.1:1', authMode: 'token', token: 'x', agent: 'edge-u' });
  const post = (body) => fetch(`http://127.0.0.1:${centralPort}/api/central/cvp-data`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': 'ctok-2611', 'X-Agent-Name': 'edge-u' }, body: JSON.stringify(body) });
  try {
    await withUnavailableDb('cvp.db', async () => {
      assert.equal(await db.available(), false);
      const r = await post({ agent: 'edge-u', chunk: 0, chunks: 1, servers: [{ cvpId: s.id, ok: true, collectedAt: Date.now() }], devices: [],
        rows: [[s.id, 'SN1', 'Et1', Date.now(), 1, 1, 1, 1, 0, 0]] });
      const j = await r.json();
      assert.equal(r.status, 503, JSON.stringify(j));
      assert.equal(j.dbUnavailable, true); assert.equal(j.ok, false); assert.match(j.reason, /다시 보냅니다/);
      assert.ok(edge.edgeCvpStatuses().some((x) => x.cvpId === s.id && x.ok === true), '상태(청크 0)는 503 이어도 저장된다');
      const r2 = await post({ agent: 'edge-u', chunk: 0, chunks: 1, servers: [{ cvpId: s.id, ok: true, collectedAt: Date.now() }] });
      assert.equal(r2.status, 200, '상태만 온 요청(적재할 것 없음)은 200');
    }, () => db._resetForTest());
  } finally { reg.deleteServer(s.id); }
});

test('CEN2611-03 — sanswitch-perf 도 표본이 있는데 DB 불가면 503 · 하트비트(표본 0)는 200', async () => {
  const sreg = await import('../src/sanswitch/registry.js');
  const pdb = await import('../src/sanswitch/perfDb.js');
  if (!(await pdb.available())) return;
  const d = sreg.saveDevice({ type: 'brocade', name: 'SW-u', host: '10.9.8.7', username: 'admin', password: 'pw', agent: 'edge-s' });
  const post = (body) => fetch(`http://127.0.0.1:${centralPort}/api/central/sanswitch-perf`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': 'ctok-2611', 'X-Agent-Name': 'edge-s' }, body: JSON.stringify(body) });
  await withUnavailableDb('sanswitch-perf.db', async () => {
    const r = await post({ agent: 'edge-s', chunk: 0, chunks: 1, rows: [[d.id, Date.now(), 0, 100]], meta: [], status: { enabled: true, devices: [] } });
    const j = await r.json();
    assert.equal(r.status, 503, JSON.stringify(j)); assert.equal(j.dbUnavailable, true);
    const hb = await post({ agent: 'edge-s', chunk: 0, chunks: 1, rows: [], meta: [], status: { enabled: true, devices: [] } });
    assert.equal(hb.status, 200, '하트비트는 DB 와 무관하게 받는다');
  }, () => pdb._resetForTest());
});

test('EDGE2611-04 — sanswitch perfPush 는 503 dbUnavailable·구버전 200 unavailable 이면 커서를 전진하지 않고 사유를 남긴다', async () => {
  const pdb = await import('../src/sanswitch/perfDb.js');
  if (!(await pdb.available())) return;
  pdb._resetForTest();
  const now = Date.now();
  await pdb.savePerfSample('sw-e', now - 60_000, { 0: 1000 }, [], 3650);
  const { config } = await import('../src/config.js');
  let mode = '503';
  const { srv } = mockCentral(() => (mode === '503' ? { status: 503, body: { ok: false, dbUnavailable: true, reason: 'DB 불가' } }
    : mode === 'old' ? { status: 200, body: { ok: true, inserted: 0, unavailable: true } } : { status: 200, body: { ok: true, inserted: 1 } }));
  const port = await listen(srv);
  const pp = await import('../src/sanswitch/perfPush.js');
  const warns = []; const orig = console.warn; console.warn = (...a) => warns.push(a.join(' '));
  try {
    config.agent.centralUrl = `http://127.0.0.1:${port}`; config.agent.centralToken = 't'; config.agent.name = 'edge-s';
    const r1 = await pp.pushPerfNow();
    assert.equal(r1.ok, false); assert.match(r1.reason, /DB 를 쓸 수 없습니다/);
    assert.equal(pp.sanSwitchPerfPushStatus().cursor, 0, '503 이면 커서 그대로');
    assert.equal(pp.sanSwitchPerfPushStatus().kind, 'central-db-unavailable');
    await pp.pushPerfNow();
    assert.equal(warns.filter((w) => /중계 실패/.test(w)).length, 1, '같은 사유는 한 번만 콘솔에(스로틀)');
    mode = 'old';
    const r2 = await pp.pushPerfNow();
    assert.equal(r2.ok, false); assert.equal(pp.sanSwitchPerfPushStatus().cursor, 0, '구버전 중앙의 200 + unavailable 도 전진하지 않는다');
    mode = 'ok';
    const r3 = await pp.pushPerfNow();
    assert.equal(r3.ok, true); assert.ok(pp.sanSwitchPerfPushStatus().cursor > 0);
  } finally { console.warn = orig; srv.close(); config.agent.centralUrl = ''; pdb._resetForTest(); }
});

// ── CVP push(엣지) ────────────────────────────────────────────────────────────

async function seedLocal(db, cvpId, { rows = 3, ports = 1, t0 = Date.now() - 3_600_000 } = {}) {
  for (let i = 0; i < rows; i++) {
    await db.saveDevices({ agent: db.LOCAL_AGENT, cvpId, samples: true, devices: [{ key: 'SN1', ts: t0 + i * 1000, hostname: 'sn1',
      ports: Array.from({ length: ports }, (_, k) => ({ name: `Et${k}`, oper: 'up', admin: 'up', inBps: 10 + i, outBps: 1, inUtil: 1, outUtil: 1, inErr: 0, outErr: 0 })) }] });
  }
}

test('EDGE2611-04·06 — CVP push: 503 dbUnavailable·200 saved.unavailable 은 커서·해시를 전진하지 않는다 · 사유를 본문에서 읽는다', async () => {
  const { reg, db, push, config } = await mods();
  if (!(await db.available())) return;
  let mode = '503';
  const { srv, got } = mockCentral((body) => {
    if (mode === '503') return { status: 503, body: { ok: false, dbUnavailable: true, reason: '중앙 CVP DB 불가' } };
    if (mode === 'old') return { status: 200, body: { ok: true, saved: { unavailable: true } } };
    if (mode === '429') return { status: 429, body: { ok: false, reason: '엣지 수 상한' } };
    if (mode === '404') return { status: 404, html: '<html>Cannot POST</html>' };
    if (mode === 'notouch') return { status: 200, body: { ok: true, saved: { touched: 0 } } };
    return { status: 200, body: { ok: true, saved: { touched: (body?.touch || []).length } } };
  });
  const port = await listen(srv);
  const s = reg.saveServer({ name: 'CVP-p', host: 'http://127.0.0.1:1', authMode: 'token', token: 'x', agent: 'edge-p' });
  try {
    config.agent.centralUrl = `http://127.0.0.1:${port}`; config.agent.centralToken = 't'; config.agent.name = 'edge-p';
    push._resetForTest();
    await seedLocal(db, s.id, { rows: 3 });
    const r1 = await push.pushCvpNow();
    assert.equal(r1.ok, false); assert.match(r1.reason, /중앙 CVP DB 를 쓸 수 없습니다\(503\)/);
    assert.equal(push.cvpPushStatus().kind, 'central-db-unavailable');
    assert.equal(push.cvpPushStatus().cursor, 0, '503 → 커서 그대로');
    mode = 'old';
    assert.equal((await push.pushCvpNow()).ok, false);
    assert.equal(push.cvpPushStatus().cursor, 0, '200 + saved.unavailable(구버전 중앙) → 커서 그대로');
    mode = '429';
    assert.match((await push.pushCvpNow()).reason, /엣지 수 상한/, '비-2xx 본문의 reason 을 싣는다');
    mode = '404';
    assert.match((await push.pushCvpNow()).reason, /엔드포인트가 없습니다/, '404 HTML 은 구버전·주소 오류로 판정');
    mode = 'ok';
    const before = got.length;
    const r2 = await push.pushCvpNow();
    assert.equal(r2.ok, true, r2.reason);
    assert.ok(push.cvpPushStatus().cursor > 0);
    assert.equal(got.slice(before).flatMap((g) => g.body?.devices || []).length, 1, '실패 동안 해시를 기록하지 않았으니 레코드가 간다');
    // 이제 해시가 기록됐다 — 다음은 touch 만. 중앙이 그 행이 없다고(touched 0) 답하면 해시를 버려 다음에 레코드를 다시 보낸다.
    mode = 'notouch';
    const r3 = await push.pushCvpNow();
    assert.equal(r3.devices, 0); assert.equal(r3.touched, 1);
    assert.equal(push.cvpPushStatus().touchMissing, 1);
    mode = 'ok';
    assert.equal((await push.pushCvpNow()).devices, 1, 'touch 가 빗나간 장비는 레코드 전체를 다시 보낸다');
  } finally { srv.close(); config.agent.centralUrl = ''; reg.deleteServer(s.id); push._resetForTest(); }
});

test('EDGE2611-05 — 꽉 찬 페이지(CVP_PUSH_ROWS)는 같은 push 호출 안에서 이어 보낸다 · backlogRows', async () => {
  const { reg, db, push, config } = await mods();
  if (!(await db.available())) return;
  const { srv, got } = mockCentral((body) => ({ status: 200, body: { ok: true, saved: { touched: (body?.touch || []).length } } }));
  const port = await listen(srv);
  const s = reg.saveServer({ name: 'CVP-m', host: 'http://127.0.0.1:1', authMode: 'token', token: 'x', agent: 'edge-m' });
  try {
    config.agent.centralUrl = `http://127.0.0.1:${port}`; config.agent.centralToken = 't'; config.agent.name = 'edge-m';
    push._resetForTest();
    const mx0 = await db.maxRowid();
    await seedLocal(db, s.id, { rows: 5, ports: 500 }); // 2,500행 > 1,000(페이지)
    const r = await push.pushCvpNow();
    assert.equal(r.ok, true, r.reason);
    const sent = got.flatMap((g) => g.body?.rows || []).filter((x) => x[0] === s.id).length;
    assert.equal(sent, 2500, '한 번의 pushCvpNow 로 백로그를 다 보냈다(예전엔 1,000행)');
    assert.equal(push.cvpPushStatus().backlogRows, 0);
    assert.ok(push.cvpPushStatus().cursor >= mx0 + 2500);
  } finally { srv.close(); config.agent.centralUrl = ''; reg.deleteServer(s.id); push._resetForTest(); }
});

test('EDGE2611-05 — 엣지 prune 이 아직 안 보낸 표본을 지우면 lostUnsent 로 센다', async () => {
  const { db, push, config } = await mods();
  if (!(await db.available())) return;
  push._resetForTest(); // 커서 파일 삭제 → 커서 0
  config.agent.centralUrl = 'http://127.0.0.1:1'; config.agent.centralToken = 't';
  try {
    await db.saveDevices({ agent: db.LOCAL_AGENT, cvpId: 'cvp-lost', samples: true, devices: [{ key: 'OLD', ts: Date.now() - 30 * 86_400_000,
      ports: [{ name: 'Et1', oper: 'up', inBps: 1, outBps: 1 }] }] });
    const r = await db.prune({ rawRetentionDays: 7 });
    assert.ok(r.lostUnsent >= 1, JSON.stringify(r));
    assert.ok(db.lostUnsentStats().total >= 1);
  } finally { config.agent.centralUrl = ''; }
});

// ── CEN2611-02 ────────────────────────────────────────────────────────────────

test('CEN2611-02 — 대소문자만 다른 엣지 이름은 저장 키 하나(상태 한 행 · 현재 오류가 옛 정상에 가려지지 않음 · DB 변형 행 모음)', async () => {
  const { reg, db, edge } = await mods();
  if (!(await db.available())) return;
  const s = reg.saveServer({ name: 'CVP-case', host: 'http://127.0.0.1:1', authMode: 'token', token: 'x', agent: 'Edge-A' });
  // 구버전 중앙이 남긴 변형 행
  await db.saveDevices({ agent: 'EDGE-A', cvpId: s.id, devices: [{ key: 'SN-OLD', ts: Date.now() - 5000, hostname: 'old' }] });
  const post = (name, body) => fetch(`http://127.0.0.1:${centralPort}/api/central/cvp-data`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': 'ctok-2611', 'X-Agent-Name': name }, body: JSON.stringify({ agent: name, ...body }) });
  try {
    let r = await post('Edge-A', { chunk: 0, chunks: 1, servers: [{ cvpId: s.id, ok: true, collectedAt: Date.now() }], devices: [{ cvpId: s.id, key: 'SN1', ts: Date.now(), hostname: 'sn1' }] });
    assert.equal(r.status, 200);
    await sleep(5);
    r = await post('edge-a', { chunk: 0, chunks: 1, servers: [{ cvpId: s.id, ok: false, error: 'new err', collectedAt: Date.now() }], devices: [{ cvpId: s.id, key: 'SN1', ts: Date.now(), hostname: 'sn1' }] });
    assert.equal(r.status, 200);
    const sts = edge.edgeCvpStatuses().filter((x) => x.cvpId === s.id);
    assert.equal(sts.length, 1, JSON.stringify(sts));
    assert.equal(sts[0].ok, false); assert.equal(sts[0].error, 'new err');
    assert.equal(sts[0].agent, 'Edge-A', '저장 키는 등록부 표기');
    const agents = new Set((await db.listDeviceRows({ cvpId: s.id })).rows.map((x) => x.agent));
    assert.deepEqual([...agents], ['Edge-A'], 'DB 행도 한 벌(변형 EDGE-A 행은 저장 키로 모였다)');
  } finally { reg.deleteServer(s.id); }
});

// ── DB ────────────────────────────────────────────────────────────────────────

test('DB2611-02 — samplesAfter 는 rowid 범위로 탄다(임시 정렬 B-트리 없음)', async () => {
  const { db, config } = await mods();
  if (!(await db.available())) return;
  const src = fs.readFileSync(path.join(SRC, 'cvp/db.js'), 'utf8');
  const m = /SELECT rowid AS rowid, cvp_id[\s\S]*?LIMIT \?/.exec(src);
  assert.ok(m, 'samplesAfter SQL 을 찾지 못했다');
  assert.match(m[0], /\+agent = ''/);
  const { DatabaseSync } = await import('node:sqlite');
  const conn = new DatabaseSync(path.join(config.dbDir || config.configDir, 'cvp.db'));
  try {
    const plan = conn.prepare(`EXPLAIN QUERY PLAN ${m[0]}`).all(0, 10).map((r) => r.detail).join(' | ');
    assert.doesNotMatch(plan, /TEMP B-TREE/, plan);
    assert.match(plan, /INTEGER PRIMARY KEY \(rowid>\?\)/, plan);
  } finally { conn.close(); }
});

test('DB2611-04 — importSamples 는 분할 트랜잭션이고 동시 적재가 모두 성공한다 · 재전송은 롤업을 두 번 세지 않는다', async () => {
  const { db } = await mods();
  if (!(await db.available())) return;
  const t0 = Date.now() - 3_600_000;
  const mk = (n, key) => Array.from({ length: n }, (_, i) => ['cvp-imp', key, `Et${i % 50}`, t0 + Math.floor(i / 50) * 1000, 10, 10, 1, 1, 1, 0]);
  const [a, b] = await Promise.all([db.importSamples('edge-x', mk(5000, 'K1')), db.importSamples('edge-y', mk(4100, 'K2'))]);
  assert.equal(a.inserted, 5000); assert.equal(b.inserted, 4100);
  const s1 = await db.portSeries({ agent: 'edge-x', cvpId: 'cvp-imp', key: 'K1', port: 'Et0', hours: 24 * 30, rawRetentionDays: 7 });
  const again = await db.importSamples('edge-x', mk(5000, 'K1'));
  assert.equal(again.inserted, 0); assert.equal(again.duplicates, 5000);
  const s2 = await db.portSeries({ agent: 'edge-x', cvpId: 'cvp-imp', key: 'K1', port: 'Et0', hours: 24 * 30, rawRetentionDays: 7 });
  assert.deepEqual(s2.points.map((p) => p.samples), s1.points.map((p) => p.samples), '재전송이 일 롤업 표본 수를 늘리지 않는다');
  assert.ok(db.IMPORT_TXN_ROWS <= 2000);
  const src = fs.readFileSync(path.join(SRC, 'cvp/db.js'), 'utf8');
  const body = src.slice(src.indexOf('export async function importSamples'), src.indexOf('export async function touchDevices'));
  assert.ok(body.indexOf("setImmediate") < body.indexOf("exec('BEGIN')"), '양보는 BEGIN 전(= 앞 청크 COMMIT 뒤)');
});

test('DB2611-06 — 일 롤업 오류 합에 표본 수(inErrN) · 구버전 표는 ALTER 로 열을 더한다', async () => {
  const { db, config } = await mods();
  if (!(await db.available())) return;
  const orig = config.dbDir;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2611c-legacy-'));
  const { DatabaseSync } = await import('node:sqlite');
  const old = new DatabaseSync(path.join(dir, 'cvp.db'));
  old.exec(`CREATE TABLE port_daily (agent TEXT NOT NULL, cvp_id TEXT NOT NULL, device_key TEXT NOT NULL, port TEXT NOT NULL, day INTEGER NOT NULL,
    samples INTEGER NOT NULL DEFAULT 0, in_bps_sum REAL NOT NULL DEFAULT 0, in_bps_n INTEGER NOT NULL DEFAULT 0, in_bps_max REAL,
    out_bps_sum REAL NOT NULL DEFAULT 0, out_bps_n INTEGER NOT NULL DEFAULT 0, out_bps_max REAL, in_util_sum REAL NOT NULL DEFAULT 0, in_util_n INTEGER NOT NULL DEFAULT 0, in_util_max REAL,
    out_util_sum REAL NOT NULL DEFAULT 0, out_util_n INTEGER NOT NULL DEFAULT 0, out_util_max REAL, in_err_sum INTEGER, out_err_sum INTEGER,
    PRIMARY KEY (agent, cvp_id, device_key, port, day))`);
  const { dayIndex } = await import('../src/util/dayKey.js');
  const legacyDay = dayIndex(Date.now() - 20 * 86_400_000);
  old.prepare("INSERT INTO port_daily (agent,cvp_id,device_key,port,day,samples,in_err_sum,out_err_sum) VALUES ('a','c','k','p',?,5,7,0)").run(legacyDay);
  old.close();
  config.dbDir = dir; db._resetForTest();
  try {
    assert.equal(await db.available(), true);
    const t = Date.now() - 3_600_000;
    await db.importSamples('a', [['c', 'k', 'p', t, 1, 1, 1, 1, 3, null], ['c', 'k', 'p', t + 1000, 1, 1, 1, 1, null, null]]);
    const pts = (await db.portSeries({ agent: 'a', cvpId: 'c', key: 'k', port: 'p', hours: 24 * 60, rawRetentionDays: 7 })).points;
    const legacy = pts.find((p) => p.samples === 5);
    assert.equal(legacy.inErrN, null, '열 추가 전 행은 표본 수를 모른다(null)');
    const today = pts[pts.length - 1];
    assert.equal(today.samples, 2); assert.equal(today.inErr, 3); assert.equal(today.inErrN, 1, '오류 합은 표본 1개의 합'); assert.equal(today.outErrN, 0);
  } finally { config.dbDir = orig; db._resetForTest(); }
});

test('DB2611-05 — 수집이 꺼져 있어도 보존 정리는 돈다', async () => {
  const { settings, poller, db, config } = await mods();
  if (!(await db.available())) return;
  config.agent.centralUrl = '';
  settings.saveSettings({ enabled: false });
  await db.importSamples('edge-z', [['cvp-z', 'K', 'Et1', Date.now() - 40 * 86_400_000, 1, 1, 1, 1, 0, 0]]);
  const count = async () => (await db.portSeries({ agent: 'edge-z', cvpId: 'cvp-z', key: 'K', port: 'Et1', hours: 24 * 6, rawRetentionDays: 7 })).points.length
    + (await db.portSeries({ agent: 'edge-z', cvpId: 'cvp-z', key: 'K', port: 'Et1', hours: 24 * 60, rawRetentionDays: 7 })).points.length;
  const pre = await db.portSeries({ agent: 'edge-z', cvpId: 'cvp-z', key: 'K', port: 'Et1', hours: 24 * 60, rawRetentionDays: 90 });
  assert.equal(pre.points.length, 1, '원시 표본이 있다');
  for (let i = 0; i < db.PRUNE_EVERY; i++) {
    const r = await poller.pollCvpOnce({ trigger: 'timer' });
    assert.equal(r.skipped, true);
  }
  let left = 1;
  for (let i = 0; i < 40 && left; i++) { await sleep(25); left = (await db.portSeries({ agent: 'edge-z', cvpId: 'cvp-z', key: 'K', port: 'Et1', hours: 24 * 60, rawRetentionDays: 90 })).points.length; }
  assert.equal(left, 0, '꺼진 상태의 타이머 틱이 보존 정리를 돌렸다');
  assert.ok((await count()) >= 1, '일 롤업은 남는다(730일)');
});

test('DB2611-01 — 본체·-wal·-shm 은 0600(기존 0644 잔재도) · DB 디렉터리 0700 · openSqlite 를 안 쓰는 모듈도 PRAGMA 전에 chmod', async () => {
  if (process.platform === 'win32') return;
  const { openSqlite, chmodDbFiles } = await import('../src/util/sqliteOpen.js');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2611c-perm-'));
  const f = path.join(dir, 'x.db');
  const prevMask = process.umask(0o022);
  try {
    const raw = new DatabaseSync(f);
    raw.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(a); INSERT INTO t VALUES (1);');
    for (const x of [f, `${f}-wal`, `${f}-shm`]) fs.chmodSync(x, 0o644); // 옛 판본이 남긴 잔재(닫지 않고 종료한 경우)
    const c = openSqlite(new DatabaseSync(f));
    c.exec('INSERT INTO t VALUES (2)');
    for (const x of [f, `${f}-wal`, `${f}-shm`]) assert.equal(fs.statSync(x).mode & 0o077, 0, `${path.basename(x)} 가 그룹·기타에 열려 있다`);
    c.close(); raw.close();
    const g = path.join(dir, 'new.db');
    const n = openSqlite(new DatabaseSync(g));
    n.exec('CREATE TABLE t(a); INSERT INTO t VALUES (1);');
    for (const x of [g, `${g}-wal`, `${g}-shm`]) if (fs.existsSync(x)) assert.equal(fs.statSync(x).mode & 0o077, 0, `${path.basename(x)} 0600 아님`);
    n.close();
    chmodDbFiles(':memory:'); chmodDbFiles(''); // 던지지 않는다
  } finally { process.umask(prevMask); }
  // ipam(wal:false)은 건드리지 않는다 — 외부 리더 권한 계약
  const src = fs.readFileSync(path.join(SRC, 'util/sqliteOpen.js'), 'utf8');
  assert.match(src, /if \(opts\.wal !== false\)/);
  for (const [file, ctor] of [['horizon/sessionDb.js', 'new DatabaseSync(p)'], ['metrics/db.js', 'new DatabaseSync(DB_PATH)'], ['storage/db.js', 'new DatabaseSync(FILE())']]) {
    const s = fs.readFileSync(path.join(SRC, file), 'utf8');
    const at = s.indexOf(ctor);
    assert.ok(at > 0, file);
    const chmodAt = s.indexOf('chmodDbFiles(', at);
    const pragmaAt = s.indexOf('PRAGMA', at);
    assert.ok(chmodAt > 0 && chmodAt < pragmaAt, `${file}: chmodDbFiles 가 PRAGMA 보다 먼저여야 한다`);
  }
  assert.match(fs.readFileSync(path.join(SRC, 'insights/dbLocation.js'), 'utf8'), /mkdirSync\(target, \{ recursive: true, mode: 0o700 \}\)/);
});

test('WEB2611-05(서버) — 파트를 읽지 않은 주기가 partsMissingKinds 를 지우지 않는다', async () => {
  const { db } = await mods();
  if (!(await db.available())) return;
  const t = Date.now() - 10_000;
  await db.saveDevices({ agent: 'edge-w', cvpId: 'cvp-w', devices: [{ key: 'K', ts: t, parts: [{ kind: 'psu', name: 'P1', state: 'ok' }], partsAt: t, partsMissingKinds: ['cooling', 'temperature'] }] });
  await db.saveDevices({ agent: 'edge-w', cvpId: 'cvp-w', devices: [{ key: 'K', ts: t + 1000 }] }); // parts undefined = 이번에 안 읽음
  let d = (await db.deviceDetail('edge-w', 'cvp-w', 'K')).device;
  assert.deepEqual(d.extra.partsMissingKinds, ['cooling', 'temperature']);
  assert.equal(d.partsList.length, 1);
  await db.saveDevices({ agent: 'edge-w', cvpId: 'cvp-w', devices: [{ key: 'K', ts: t + 2000, parts: [{ kind: 'psu', name: 'P1', state: 'ok' }], partsAt: t + 2000 }] });
  d = (await db.deviceDetail('edge-w', 'cvp-w', 'K')).device;
  assert.equal(d.extra.partsMissingKinds, undefined, '다시 전부 읽은 주기는 표식을 지운다');
});

test('EDGE2611-04(중앙) — touchDevices 는 같은 ts 재전송도 "행 있음" 으로 센다 · 없는 행은 0', async () => {
  const { db } = await mods();
  if (!(await db.available())) return;
  const t = Date.now() - 5000;
  await db.saveDevices({ agent: 'edge-t', cvpId: 'cvp-t', devices: [{ key: 'K', ts: t }] });
  assert.equal((await db.touchDevices('edge-t', [['cvp-t', 'K', t]])).touched, 1);
  assert.equal((await db.touchDevices('edge-t', [['cvp-t', 'K', t - 100]])).touched, 1);
  assert.equal((await db.listDeviceRows({ agent: 'edge-t', cvpId: 'cvp-t' })).rows[0].collectedAt, t, 'ts 는 내려가지 않는다');
  assert.equal((await db.touchDevices('edge-t', [['cvp-t', 'NOPE', t]])).touched, 0);
});

// ── 파서 ──────────────────────────────────────────────────────────────────────

test('COL2611-04·07·08 — 장착 여부는 건강 상태가 아니다 · speed2p5Gbps · 간격 한계에 실행 소요', async () => {
  const P = await import('../src/cvp/parse.js');
  assert.equal(P.partState({ xcvrPresence: 'xcvrPresent' }), 'unknown', '꽂혀 있다 ≠ 장애');
  assert.equal(P.partState({ presence: 'present' }), 'unknown');
  assert.equal(P.partState({ xcvrPresence: { Name: 'xcvrPresent' } }), 'unknown');
  assert.equal(P.partState({ xcvrPresence: 'xcvrNotPresent' }), 'absent');
  assert.equal(P.partState({ xcvrPresence: 'xcvrPresent', alertRaised: true }), 'fault');
  assert.equal(P.partState({ xcvrPresence: 'xcvrPresent', status: 'ok' }), 'ok');
  assert.equal(P.speedBps('speed2p5Gbps'), 2.5e9);
  assert.equal(P.speedBps('speed100Gbps'), 1e11);
  assert.equal(P.speedBps('10000'), 10000, '단위 없는 수는 bps');
  const I = 60_000; const T = 1e12;
  const prev = { at: T, c: { inOctets: 0, outOctets: 0, inErrors: 0, outErrors: 0 } };
  const cur = { at: T + 260_000, c: { inOctets: 1000, outOctets: 1000, inErrors: 0, outErrors: 0 } };
  assert.equal(P.portDelta(prev, cur, 1e10, I).reason, 'gap');
  assert.equal(P.portDelta(prev, cur, 1e10, I, 120_000).reason, null, '직전 실행 소요만큼 한계를 넓힌다');
  assert.ok(P.portDelta(prev, cur, 1e10, I, 120_000).inBps > 0);
});

// ── 폴러(목 CVP) ──────────────────────────────────────────────────────────────

test('COL2611-05·TIM2611-01·05 — 0대 보고는 prune 을 보류 · 부품을 못 읽은 주기는 partsRead 가 아니다 · 빠진 장비의 이전 카운터 정리', async () => {
  const { reg, settings, poller, db, store, config } = await mods();
  if (!(await db.available())) return;
  config.agent.centralUrl = '';
  settings.saveSettings({ enabled: true, intervalMs: 300_000 });
  const state = { devices: ['SN-A', 'SN-B'] };
  const srv = mockCvp(state);
  const port = await listen(srv);
  const s = reg.saveServer({ name: 'CVP-z', host: `http://127.0.0.1:${port}`, authMode: 'token', token: 'TOK' });
  try {
    poller._resetForTest();
    await poller.pollCvpOnce({ manual: true, only: [s.id] });
    let st = store.getStatus(s.id);
    assert.equal(st.ok, true, st.error);
    assert.equal(st.partsRead, false, '부품 경로가 전부 404 — 읽은 장비가 없으니 partsRead 가 아니다');
    assert.equal(st.partsDueUnread, true);
    assert.ok([...poller._prevCountersForTest.keys()].some((k) => k.startsWith(`${s.id}|SN-B|`)));
    state.devices = ['SN-A'];
    await poller.pollCvpOnce({ manual: true, only: [s.id] });
    assert.equal([...poller._prevCountersForTest.keys()].filter((k) => k.startsWith(`${s.id}|SN-B|`)).length, 0, '빠진 장비의 이전 카운터는 지운다');
    assert.equal((await db.listDeviceRows({ agent: db.LOCAL_AGENT, cvpId: s.id })).rows.length, 1, '온전한 인벤토리의 빠진 장비는 정리');
    state.emptyInventory = true;
    await poller.pollCvpOnce({ manual: true, only: [s.id] });
    st = store.getStatus(s.id);
    assert.equal(st.ok, true); assert.equal(st.deviceCount, 0);
    assert.ok(st.pruneHeld && st.pruneHeld.had === 1, JSON.stringify(st.pruneHeld));
    assert.equal((await db.listDeviceRows({ agent: db.LOCAL_AGENT, cvpId: s.id })).rows.length, 1, '0대 보고 한 번으로 장비 목록을 지우지 않는다');
  } finally { srv.close(); reg.deleteServer(s.id); settings.saveSettings({ enabled: false }); }
});

test('TIM2611-01 — 요청 시한은 남은 예산을 넘지 않고, 시한에 걸린 장비는 aborted + missing.deadline', async () => {
  const client = await import('../src/cvp/client.js');
  assert.equal(client.reqMsFor(() => 5_000), 5_000);
  assert.equal(client.reqMsFor(() => 10), 1_000, '하한 1초');
  assert.ok(client.reqMsFor(() => 1e9) <= 30_000 * 10);
  assert.equal(client.reqMsFor(null) > 0, true);
  const srv = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/api/resources/inventory/v1/Device/all') { res.writeHead(200); res.end(JSON.stringify({ result: { value: { key: { deviceId: 'SN-S' }, hostname: 's', streamingStatus: 'STREAMING_STATUS_ACTIVE' } } })); return; }
    setTimeout(() => { try { res.writeHead(404); res.end('{}'); } catch { /* */ } }, 3000); // 느린 텔레메트리
  });
  const port = await listen(srv);
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('시한')), 400);
    const r = await client.collectCvp({ host: `http://127.0.0.1:${port}`, authMode: 'token', token: 'T' }, { signal: ac.signal, budgetMs: 60_000, partsDue: false });
    assert.equal(r.ok, true);
    assert.equal(r.devices[0].telemetry, 'aborted');
    assert.equal(r.truncated.aborted, 1);
    assert.match(r.missing.deadline, /시한/);
  } finally { srv.closeAllConnections?.(); srv.close(); }
});

test('TIM2611-02 — 위임 요청 시한은 인출 시점의 설정 deviceTimeoutMs · 코어는 함수·숫자 둘 다', async () => {
  const { createCollectRequestQueue } = await import('../src/util/collectRequestQueue.js');
  let per = 1000;
  const q = createCollectRequestQueue({ ackMs: 0, perItemMs: () => per });
  q.request('a', 'e'); q.request('b', 'e');
  const t = 1_000_000;
  q.take('e', t, 10);
  per = 999_999;
  // 시한 = t + 0 + 2 × 1000 — 인출 시점 값. 그 뒤 설정이 바뀌어도 이미 인출한 요청의 시한은 그대로다.
  assert.ok(q.has('a'));
  const n = createCollectRequestQueue({ ackMs: 0, perItemMs: 500 });
  n.request('x', 'e'); n.take('e', t, 10);
  assert.ok(n.has('x'), '숫자 perItemMs 호환');
  const { settings } = await mods();
  const cr = await import('../src/cvp/collectRequests.js');
  settings.saveSettings({ deviceTimeoutMs: 20 * 60_000 });
  assert.equal(cr.perItemMs(), settings.loadSettings().deviceTimeoutMs);
});
