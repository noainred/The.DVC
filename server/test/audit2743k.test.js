/**
 * test/audit2743k.test.js — v2.743 점검 그룹 GK 회귀(CVP·SAN push 503 · CVP 텔레메트리 표시 · SAN 센서 판정 · CVP '지금 수집' 응답).
 *
 *  ① LEFT-03  cvp-data push 는 지속형 503(Retry-After)을 받으면 **한 번만** 보낸다 — 예전 retries:2 는 같은 gzip 청크를 두 번 더 올렸다.
 *             그 밖의 일시 상태(500)는 예전처럼 호출 안에서 다시 보낸다.
 *  ② LEFT-03  sanswitch-perf push(표본·하트비트)도 같다 — 503 이면 POST 1번 · 커서는 전진하지 않는다 · 200 이 되면 전진한다.
 *  ③ DEV-04   CVP 장비 조회 도중 예산이 떨어졌을 때 인터페이스를 **못 읽었으면** 'budget'(못 읽음)이다 — 예전에는 'budget-partial'
 *             (= TELEMETRY_OK '읽음')이라 Overview·장애 판정이 그 장비를 '읽은 장비' 로 통과시켰다. 실제 collectCvp 를 가짜 CVP·가짜 시계로 부른다.
 *  ④ DEV-02   sensorshow 의 Warning·Above·Below 류 상태는 '이상' 이다(v2.742 회귀 — '확인 불가' 로 내려가 점검이 warn 이 됐다).
 *             정말 모르는 단어는 여전히 null · 빈 슬롯(Absent)은 여전히 absent.
 *  ⑤ WEB-03   POST /tools/cvp/collect 가 폴러 진행 중이면 busy + directBusy(시작하지 않은 중앙 직접 대수)를 싣는다(실제 api 라우터).
 *
 * 기준 시각은 Date.now() 를 쓰지 않는다(v2.517 규약 — 시각 경계에 따라 깨지지 않게). 가짜 중앙의 Retry-After 는 1초로 둔다
 * (운영 중앙의 지속형 503 은 60초 — 예전 코드면 그만큼 기다렸다가 다시 보낸다. 1초로 줄여도 '몇 번 보냈는가' 는 같다).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2743k-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'live';           // mock 이면 CVP 데모 시드가 등록부를 채운다 — 이 테스트는 등록부를 직접 만든다
process.env.AUTH_ENABLED = 'true';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.CVP_PUSH_GZIP = 'true';
process.env.SANSW_PUSH_GZIP = 'true';

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

/** 가짜 중앙 — mode 에 따라 503(지속형) · 'flaky'(첫 요청 500 → 그 뒤 200) · 200. 받은 POST 를 센다. */
function fakeCentral() {
  const st = { mode: '503', posts: [], n: 0 };
  const srv = http.createServer((req, res) => {
    const bufs = [];
    req.on('data', (c) => bufs.push(c));
    req.on('end', () => {
      let raw = Buffer.concat(bufs);
      if (req.headers['content-encoding'] === 'gzip') { try { raw = zlib.gunzipSync(raw); } catch { /* 그대로 */ } }
      let body = null; try { body = JSON.parse(raw.toString('utf8')); } catch { /* */ }
      st.posts.push({ url: req.url, body });
      st.n += 1;
      const send = (code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
      if (st.mode === '503') return send(503, { ok: false, dbUnavailable: true, reason: '중앙 DB 를 쓸 수 없습니다' }, { 'Retry-After': '1', 'Cache-Control': 'no-store' });
      if (st.mode === 'flaky' && st.n === 1) return send(500, { ok: false, reason: '일시 오류' });
      return send(200, { ok: true, saved: { touched: 0 }, inserted: 0, skipped: 0 });
    });
  });
  return { srv, st };
}

// ── ① LEFT-03 cvp-data ─────────────────────────────────────────────────────
test('LEFT-03 ① cvp-data push: 지속형 503(Retry-After) 이면 POST 는 1번 · 실패로 끝난다(central-db-unavailable) · 500 은 예전처럼 재시도', async () => {
  const { srv, st } = fakeCentral();
  const port = await listen(srv);
  const { config } = await import('../src/config.js');
  const push = await import('../src/cvp/push.js');
  try {
    config.agent.centralUrl = `http://127.0.0.1:${port}`;
    config.agent.centralToken = 'ctok-2743';
    config.agent.name = 'edge-2743';
    push._resetForTest();
    st.mode = '503'; st.posts = []; st.n = 0;
    const t0 = process.hrtime.bigint();
    const r = await push.pushCvpNow();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(st.posts.length, 1, `수정 전: retries:2 → 같은 청크를 ${st.posts.length}번 보냈다(Retry-After 만큼 기다렸다가)`);
    assert.ok(st.posts[0].url.startsWith('/api/central/cvp-data'), st.posts[0].url);
    assert.equal(push.cvpPushStatus().kind, 'central-db-unavailable', '사유 분류는 그대로(다음 주기 재전송 · 커서 전진 안 함)');
    assert.match(push.cvpPushStatus().error, /503/);
    assert.ok(ms < 900, `Retry-After 를 기다리지 않는다(${Math.round(ms)}ms)`);
    // 일시 상태(500)는 호출 안에서 다시 보낸다 — 503 만 다음 주기로 넘긴다
    push._resetForTest();
    st.mode = 'flaky'; st.posts = []; st.n = 0;
    const r2 = await push.pushCvpNow();
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(st.posts.length, 2, '500 뒤 재시도 1번 → 200');
  } finally {
    srv.close();
    config.agent.centralUrl = ''; config.agent.centralToken = '';
  }
});

// ── ② LEFT-03 sanswitch-perf ───────────────────────────────────────────────
test('LEFT-03 ② sanswitch-perf push: 하트비트·표본 둘 다 503 이면 POST 1번 · 커서 그대로 · 200 이 되면 커서 전진', async () => {
  const pdb = await import('../src/sanswitch/perfDb.js');
  if (!(await pdb.available())) return; // 이 런타임이 node:sqlite 를 못 쓰면 건너뛴다
  pdb._resetForTest();
  const { srv, st } = fakeCentral();
  const port = await listen(srv);
  const { config } = await import('../src/config.js');
  const pp = await import('../src/sanswitch/perfPush.js');
  try {
    config.agent.centralUrl = `http://127.0.0.1:${port}`;
    config.agent.centralToken = 'ctok-2743';
    config.agent.name = 'edge-2743';
    // (a) 표본 0건 → 상태 전용 하트비트
    st.mode = '503'; st.posts = []; st.n = 0;
    const h = await pp.pushPerfNow();
    assert.equal(h.statusSent, false, JSON.stringify(h));
    assert.equal(st.posts.length, 1, `수정 전: retries:1 → 하트비트를 ${st.posts.length}번 보냈다`);
    // (b) 표본 있음 → 메타·표본 청크
    const base = Date.UTC(2026, 9, 16, 3, 30, 0); // 고정 기준 시각(정시에서 30분 떨어짐)
    await pdb.savePerfSample('sw-2743', base - 60_000, { 0: 1000, 1: 2000 }, [{ port: 0, attachedName: 'ARR::1', speed: '16G' }], 3650);
    await pdb.savePerfSample('sw-2743', base, { 0: 1100, 1: 2100 }, [], 3650);
    const cur0 = pp.sanSwitchPerfPushStatus().cursor;
    st.posts = []; st.n = 0;
    const r = await pp.pushPerfNow();
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(st.posts.length, 1, `수정 전: retries:2 → 첫 청크를 ${st.posts.length}번 보냈다`);
    assert.equal(pp.sanSwitchPerfPushStatus().kind, 'central-db-unavailable');
    assert.equal(pp.sanSwitchPerfPushStatus().cursor, cur0, '503 이면 커서를 전진하지 않는다(다음 주기에 다시 보낸다)');
    // (c) 중앙이 회복하면 같은 표본이 간다
    st.mode = '200'; st.posts = []; st.n = 0;
    const r2 = await pp.pushPerfNow();
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.ok(r2.sent >= 4, JSON.stringify(r2));
    assert.ok(pp.sanSwitchPerfPushStatus().cursor > cur0, '200 이면 커서 전진');
  } finally {
    srv.close();
    config.agent.centralUrl = ''; config.agent.centralToken = '';
  }
});

// ── ③ DEV-04 CVP telemetry 'budget' ────────────────────────────────────────
const notif = (p, updates) => ({ notifications: [{ timestamp: 1, path: p, updates }] });
const ptr = (b, k) => ({ key: k, value: { _ptr: `${b}/${k}` } });
const IS = '/Sysdb/interface/status/eth/phy/slice/1/intfStatus';

/** 가짜 CVP 1대 — 인터페이스 조회를 실패(500) 또는 성공시키고, 그 시점에 가짜 시계를 예산 너머로 민다. */
function fakeCvp(clock, { intfOk }) {
  const srv = http.createServer((req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    if (req.headers.authorization !== 'Bearer TOK') return send(401, {});
    const raw = new URL(req.url, 'http://x').pathname;
    const p = decodeURIComponent(raw);
    if (p === '/api/resources/inventory/v1/Device/all') {
      return send(200, JSON.stringify({ result: { value: { key: { deviceId: 'SN-K' }, hostname: 'leaf-k', modelName: 'DCS-7050', softwareVersion: '4.30.1F', streamingStatus: 'STREAMING_STATUS_ACTIVE' } } }));
    }
    const m = /^\/api\/v1\/rest\/([^/]+)(\/.*)?$/.exec(raw);
    if (!m) return send(404, {});
    const rest = (m[2] || '').split('/').map((x) => decodeURIComponent(x)).join('/');
    if (rest === IS || rest === `${IS}/all`) {
      if (!intfOk) { clock.t += 200_000; return send(500, { error: 'boom' }); } // 시한까지 걸려 실패한 것처럼 — 예산이 바닥난다
      return send(200, notif(IS, { Ethernet1: ptr(IS, 'Ethernet1') }));
    }
    if (rest === `${IS}/Ethernet1`) {
      clock.t += 200_000; // 인터페이스를 읽은 뒤 예산이 바닥난다
      return send(200, notif(`${IS}/Ethernet1`, { operStatus: { key: 'operStatus', value: { Name: 'intfOperUp' } }, adminEnabled: { key: 'adminEnabled', value: true } }));
    }
    return send(404, {});
  });
  return srv;
}

test('DEV-04 ③ CVP: 인터페이스 조회 실패 + 예산 소진이면 telemetry 는 budget(못 읽음) · 읽었으면 budget-partial — TELEMETRY_OK 와 맞물린다', async () => {
  const C = await import('../src/cvp/client.js');
  const F = await import('../src/cvp/faults.js');
  for (const [intfOk, want] of [[false, 'budget'], [true, 'budget-partial']]) {
    const clock = { t: 1_000_000 };
    const srv = fakeCvp(clock, { intfOk });
    const port = await listen(srv);
    try {
      const r = await C.collectCvp({ host: `http://127.0.0.1:${port}`, authMode: 'token', token: 'TOK', verifyTls: false },
        { budgetMs: 60_000, partsDue: false, prefer: new Map(), now: () => clock.t });
      assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
      const d = r.devices.find((x) => x.key === 'SN-K' || x.serial === 'SN-K');
      assert.ok(d, '장비 행');
      assert.equal(d.telemetry, want, `intfOk=${intfOk}: 수정 전에는 인터페이스를 못 읽어도 'budget-partial'(읽음)이었다 — ${d.telemetry}`);
      assert.equal(F.TELEMETRY_OK.has(d.telemetry), intfOk, '읽음 판정은 실제로 읽었는지와 같아야 한다');
      if (!intfOk) assert.equal(d.ports, null, '포트는 못 읽음(null)');
      else assert.ok(Array.isArray(d.ports) && d.ports.length === 1);
    } finally { srv.close(); }
  }
  // 두 분기가 쓰는 판정 한 벌
  assert.equal(C.budgetTelemetry(null), 'budget');
  assert.equal(C.budgetTelemetry(undefined), 'budget');
  assert.equal(C.budgetTelemetry([{ name: 'Ethernet1' }]), 'budget-partial');
  assert.ok(!F.TELEMETRY_OK.has('budget') && F.TELEMETRY_OK.has('budget-partial'));
});

// ── ④ DEV-02 sensorshow 상태어 ─────────────────────────────────────────────
test('DEV-02 ④ sensorshow: Warning·Above·Below 류는 이상(bad) · 점검 항목 bad · 모르는 단어는 여전히 판정 불가 · Absent 는 빈 슬롯', async () => {
  const P = await import('../src/sanswitch/collectors/fosParse.js');
  const { checkDevice } = await import('../src/sanswitch/healthCheck.js');
  const st = (w) => P.parseSensorShow(`sensor  1: (Temperature) Temp 1 is ${w}, value is 61 C`).list[0];
  for (const w of ['Warning', 'Above', 'Below', 'High', 'Low', 'Over', 'Overtemp', 'Under-voltage', 'Alarm', 'Exceeded']) {
    assert.equal(st(w).ok, false, `'is ${w}' 는 센서 이상어다(수정 전: null — '확인 불가' 로 내려갔다)`);
  }
  assert.equal(st('Below minimum').state, 'Below', '상태 정규식은 첫 단어만 잡는다 — 단어 단위로 본다');
  assert.equal(st('Below minimum').ok, false);
  // 바뀌지 않아야 하는 것(v2.742 의 판단)
  assert.equal(st('Ok').ok, true);
  assert.equal(st('Present').ok, true);
  assert.equal(st('Unknown').ok, null, "'is Unknown' 은 모름");
  assert.equal(st('Weird').ok, null, '정말 모르는 단어는 모름(audit2742j 와 같은 판단)');
  assert.equal(st('Faulty').ok, false);
  const ab = P.parseSensorShow('sensor  9: (Power Supply) PS 2 is Absent').list[0];
  assert.equal(ab.absent, true); assert.equal(ab.ok, null);

  // 점검 판정 — 합성 sensorshow(실장비 식별자 없음)
  const SENSOR = [
    'sensor  1: (Temperature) is Ok, value is 31 C',
    'sensor  2: (Temperature) is Warning, value is 71 C',
    'sensor  3: (Voltage    ) is Above, value is 13 V',
    'sensor  4: (Voltage    ) is Below, value is 10 V',
    'sensor  5: (Fan        ) is Absent',
  ].join('\n');
  const s = P.parseSensorShow(SENSOR);
  assert.deepEqual(s.counts, { total: 5, ok: 1, bad: 3, unknown: 0, absent: 1 });
  const snap = (sensors) => ({ id: 'sw-k', name: 'SW-K', ok: true, collectedAt: 1_790_000_000_000,
    sections: { ports: 'ok', chassis: 'ok', counters: 'ok', sfp: 'ok', health: 'ok', sensors: 'ok', raslog: 'ok', bottleneck: 'ok', fabric: 'ok' },
    ports: { list: [] }, health: {}, extra: { sensors } });
  const it = checkDevice(snap(s)).items.find((i) => i.key === 'sensors');
  assert.equal(it.status, 'bad', `수정 전: warn('상태를 읽지 못한 센서 3개') — ${it.detail}`);
  assert.match(it.detail, /이상 3개/);
  assert.equal(it.evidence.length, 3);
  // 모르는 단어만 남으면 warn — '읽지 못했다' 가 아니라 '판정하지 못했다'
  const w = checkDevice(snap(P.parseSensorShow('sensor  1: (Fan        ) is Weird'))).items.find((i) => i.key === 'sensors');
  assert.equal(w.status, 'warn');
  assert.match(w.detail, /판정하지 못한 센서 1개/);
  assert.ok(!/읽지 못한 센서/.test(w.detail), '읽은 상태어를 "읽지 못했다" 고 말하지 않는다');
});

// ── ⑤ WEB-03 /tools/cvp/collect busy ───────────────────────────────────────
test('WEB-03 ⑤ POST /tools/cvp/collect: 폴러가 수집 중이면 busy + directBusy(시작하지 않은 중앙 직접 대수) · direct 는 0(구버전 호환)', async () => {
  // 인벤토리 요청을 붙잡아 두는 가짜 CVP — 그 동안 폴러는 진행 중(_busy)이다
  let release; const held = new Promise((r) => { release = r; });
  const cvp = http.createServer(async (req, res) => { await held; res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{}'); });
  const cvpPort = await listen(cvp);
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const reg = await import('../src/cvp/registry.js');
  const settings = await import('../src/cvp/settings.js');
  const poller = await import('../src/cvp/poller.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
  app.use('/api', api);
  const web = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  let poll = null;
  try {
    settings.saveSettings({ enabled: true });
    reg.saveServer({ name: 'cvp-k', host: `http://127.0.0.1:${cvpPort}`, authMode: 'token', token: 'TOK', verifyTls: false, agent: '' });
    poll = poller.pollCvpOnce({ manual: true });
    assert.equal(poller.isPollerBusy(), true, '폴러가 진행 중이어야 이 경로를 본다');
    const r = await fetch(`http://127.0.0.1:${web.address().port}/api/tools/cvp/collect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.busy, true, JSON.stringify(j));
    assert.equal(j.direct, 0, '구버전 화면 호환');
    assert.equal(j.directBusy, 1, `시작하지 않은 중앙 직접 대수를 밝힌다(수정 전: 없음) — ${JSON.stringify(j)}`);
    assert.match(j.reason, /진행 중/);
  } finally {
    release();
    try { await poll; } catch { /* */ }
    web.close(); cvp.close();
  }
});
