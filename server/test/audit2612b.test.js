/**
 * test/audit2612b.test.js — v2.612 감사 그룹 B(CVP 파서·클라이언트·폴러·DB) 회귀.
 *
 *  SEC2612-01  entitiesOf 가 같은 개체 update 를 put 마다 전체 복사(O(n²)) → 제자리 병합 + 개체당 필드 상한
 *  SEC2612-02  CVP 요청이 리다이렉트를 따라가 로그인 본문을 다른 주소로 다시 POST → redirect:'manual' + 실패 사유
 *  COL2612-02  linkWord('disconnected') → up
 *  COL2612-03  partState(hwStatusOk) → fault · 모르는 단어 → fault
 *  COL2612-04  bgpSummary 가 prefix 수 모르는 피어를 밝히지 않음
 *  COL2612-05  speedBps('100Gbps') null · 첫 속도 후보가 안 읽히면 다음 후보를 보지 않음
 *  RECENT2612-01 파트 경로가 전부 404 인 CVP 에 매 주기 파트 헛조회 · 원인을 단정한 배너 표시
 *  RECENT2612-04 adoptAgentVariants 가 같은 날 일 롤업 충돌 행을 버림
 *  PERF2612-01 adoptAgentVariants 가 표마다 한 문장(수백만 행 동기) → 행 청크 + COMMIT 뒤 양보 + 요청을 붙잡지 않음
 *  PERF2612-02 saveDevices 가 CVP 한 대분을 한 트랜잭션으로 → 장비 청크 + 양보
 *  DB2612-01   늦게 온 옛 장비 레코드가 upPort INSERT 로 지워진 포트를 되살림
 * 기준 시각은 고정값이다(Date.now() 를 경계로 쓰지 않는다 — CLAUDE.md).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2612b-'));
process.env.SSRF_ALLOW_LOOPBACK = 'true';

const P = await import('../src/cvp/parse.js');
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const servers = [];
after(() => { for (const s of servers) try { s.close(); } catch { /* */ } });

/** setImmediate 로 도는 틱 카운터 — 작업 중 이벤트 루프가 몇 번 풀려났는지(양보 횟수의 하한) 센다. */
async function ticksDuring(fn) {
  let ticks = 0; let run = true;
  const tick = () => { if (!run) return; ticks++; setImmediate(tick); };
  setImmediate(tick);
  const out = await fn();
  run = false;
  return { ticks, out };
}

/* ── SEC2612-01 ─────────────────────────────────────────────────────── */
const notifText = (n, name = 'Ethernet1') => JSON.stringify({ notifications: Array.from({ length: n }, (_, i) => ({ path: `/x/${name}`, updates: { [`f${i}`]: { key: `f${i}`, value: i } } })) });

test('SEC2612-01 같은 개체의 update 는 제자리에서 합치고 개체당 필드를 상한으로 자른다(버린 개수 밝힘)', () => {
  const r = P.entitiesOf(JSON.stringify({ notifications: [
    { path: '/a/Ethernet1', updates: { operStatus: { key: 'operStatus', value: 'intfOperUp' } } },
    { path: '/a/Ethernet1', updates: { speed: { key: 'speed', value: 1000 } } },
    { path: '/a/Ethernet1', updates: { speed: { key: 'speed', value: 2000 }, ['__proto__']: { key: '__proto__', value: { polluted: 1 } } } },
  ] }));
  const e = r.entities.get('Ethernet1');
  assert.equal(e.operStatus, 'intfOperUp');
  assert.equal(e.speed, 2000, '뒤 update 가 이긴다');
  assert.equal(Object.getPrototypeOf(e), Object.prototype, '__proto__ 키가 프로토타입을 바꾸지 않는다');
  assert.equal(({}).polluted, undefined);
  assert.equal(r.droppedFields, 0);
  const big = P.entitiesOf(notifText(P.ENTITY_FIELD_MAX + 50));
  assert.equal(Object.keys(big.entities.get('Ethernet1')).length, P.ENTITY_FIELD_MAX);
  assert.equal(big.droppedFields, 50);
  const withOper = JSON.parse(notifText(P.ENTITY_FIELD_MAX + 5));
  withOper.notifications.unshift({ path: '/x/Ethernet1', updates: { operStatus: { key: 'operStatus', value: 'intfOperUp' } } });
  assert.equal(P.parseInterfaces(JSON.stringify(withOper)).droppedFields, 6, '파서 결과에도 실린다(operStatus 가 한 칸을 먼저 쓴다)');
});

// v2.616: 2천 대비 8천으로 재던 판본이 CI 에서 8.4배(2k=8.4ms 8k=70.5ms)로 실패했다 — 제품은 선형이다(8천→3만2천 로컬 15회
//   3.2~4.7배). 2천 구간은 절대 시간이 수 ms 라 GC 잡음으로 4.3~6.4배까지 흔들린다. 선형이면 4배 · 2차면 16배이므로
//   입력을 키워(8천→3만2천) 잡음 비중을 줄이고 최선값 5회로 잰다. 상한 8배는 둘을 확실히 가른다.
test('SEC2612-01 같은 개체 update 수에 거의 선형이다(비율 — 8천 대비 3만2천이 8배 미만)', () => {
  const time = (n) => {
    const t = notifText(n);
    let best = Infinity;
    for (let k = 0; k < 5; k++) { const t0 = process.hrtime.bigint(); P.entitiesOf(t); best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6); }
    return best;
  };
  time(2000); // 워밍업
  const a = time(8000); const b = time(32000);
  assert.ok(b / Math.max(a, 0.5) < 8, `8k=${a.toFixed(1)}ms 32k=${b.toFixed(1)}ms`);
});

/* ── SEC2612-02 ─────────────────────────────────────────────────────── */
test('SEC2612-02 로그인 307 을 따라가 계정·비밀번호를 다른 서버로 다시 보내지 않는다', async () => {
  const C = await import('../src/cvp/client.js');
  const got = [];
  const other = http.createServer((req, res) => { const b = []; req.on('data', (c) => b.push(c)); req.on('end', () => { got.push({ url: req.url, body: Buffer.concat(b).toString() }); res.end('{}'); }); });
  servers.push(other);
  const op = await listen(other);
  const cvp = http.createServer((req, res) => {
    if (req.url.startsWith('/cvpservice/login/authenticate.do')) { res.writeHead(307, { Location: `http://127.0.0.1:${op}/steal?tok=secret` }); return res.end(); }
    if (req.url.startsWith('/api/resources/inventory')) { res.writeHead(302, { Location: `http://127.0.0.1:${op}/inv` }); return res.end(); }
    res.writeHead(404); res.end();
  });
  servers.push(cvp);
  const cp = await listen(cvp);
  await assert.rejects(C.openSession({ host: `http://127.0.0.1:${cp}`, authMode: 'password', username: 'svc', password: 'PW-SECRET' }),
    (e) => /리다이렉트/.test(e.message) && /307/.test(e.message) && !/steal|tok=secret/.test(e.message));
  const t = await C.testCvp({ host: `http://127.0.0.1:${cp}`, authMode: 'token', token: 'TOK' });
  assert.equal(t.ok, false);
  assert.match(t.reason, /리다이렉트/);
  assert.equal(got.length, 0, `다른 서버가 요청을 받았다: ${JSON.stringify(got)}`);
});

/* ── COL2612-02~05 ──────────────────────────────────────────────────── */
test('COL2612-02 disconnected 는 down, connected·up 은 up', () => {
  assert.equal(P.linkWord('disconnected'), 'down');
  assert.equal(P.linkWord('linkDisconnected'), 'down');
  assert.equal(P.linkWord('connected'), 'up');
  assert.equal(P.linkWord('intfOperUp'), 'up');
  assert.equal(P.linkWord('notconnect'), 'down');
});

test('COL2612-03 hwStatus 접두를 떼고 판정 · 모르는 단어는 fault 가 아니라 unknown', () => {
  assert.equal(P.partState({ hwStatus: 'hwStatusOk' }), 'ok');
  assert.equal(P.partState({ hwStatus: 'hwStatusFailed' }), 'fault');
  assert.equal(P.partState({ state: 'somethingNew' }), 'unknown');
  assert.equal(P.partState({ powerSupplyState: 'powerSupplyFailed' }), 'fault');
  assert.equal(P.partState({ state: 'powerLoss' }), 'fault');
  assert.equal(P.partState({ state: 'ok' }), 'ok');
});

test('COL2612-04 prefix 수를 모르는 피어 수를 요약에 싣는다', () => {
  const s = P.bgpSummary([{ state: 'Established', prefixes: 42 }, { state: 'Idle', prefixes: null }, { state: 'Established', prefixes: 8 }]);
  assert.equal(s.prefixes, 50);
  assert.equal(s.prefixesUnknown, 1);
  assert.equal(P.bgpSummary([{ state: 'Idle', prefixes: null }]).prefixes, null);
  assert.equal(P.bgpSummary([{ state: 'Established', prefixes: 3 }]).prefixesUnknown, 0);
});

test('COL2612-05 100Gbps·1000Mbps·10 Gbps · 첫 후보가 안 읽히면 bandwidth', () => {
  assert.equal(P.speedBps('100Gbps'), 100e9);
  assert.equal(P.speedBps('1000Mbps'), 1e9);
  assert.equal(P.speedBps('10 Gbps'), 10e9);
  assert.equal(P.speedBps('speed2p5Gbps'), 2.5e9);
  assert.equal(P.speedBps('100G'), 100e9);
  assert.equal(P.speedBps('speedUnknown'), null);
  const r = P.parseInterfaces(JSON.stringify({ notifications: [{ path: '/x/all', updates: {
    Ethernet1: { value: { operStatus: 'intfOperUp', speed: { Name: 'speedUnknown' }, bandwidth: 25_000_000_000 } },
    Ethernet2: { value: { operStatus: 'intfOperUp', speed: '100Gbps' } } } }] }));
  const by = Object.fromEntries(r.ports.map((p) => [p.name, p.speedBps]));
  assert.equal(by.Ethernet1, 25e9);
  assert.equal(by.Ethernet2, 100e9);
});

/* ── RECENT2612-01 ──────────────────────────────────────────────────── */
test('RECENT2612-01 파트 경로가 전부 404 면 다음 주기에 파트를 다시 조회하지 않고 원인 단정 표시도 없다', async () => {
  const reg = await import('../src/cvp/registry.js');
  const settings = await import('../src/cvp/settings.js');
  const poller = await import('../src/cvp/poller.js');
  const store = await import('../src/cvp/store.js');
  const { config } = await import('../src/config.js');
  config.agent.centralUrl = '';
  const hits = { parts: 0 };
  const srv = http.createServer((req, res) => {
    const send = (c, b) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (req.method === 'POST') return send(200, {});
    if (p === '/api/resources/inventory/v1/Device/all') return send(200, [{ result: { value: { key: { deviceId: 'SN1' }, hostname: 'sw1', streamingStatus: 'STREAMING_STATUS_ACTIVE' } } }]);
    if (/\/Sysdb\/environment\/|xcvr|transceiver/i.test(p)) { hits.parts++; return send(404, {}); }
    if (/intfStatus/.test(p)) return send(200, { notifications: [{ path: '/x/all', updates: { Ethernet1: { value: { operStatus: 'intfOperUp', adminEnabled: true } } } }] });
    return send(404, {});
  });
  servers.push(srv);
  const port = await listen(srv);
  poller._resetForTest();
  settings.saveSettings({ enabled: true, intervalMs: 300_000 });
  const s = reg.saveServer({ name: 'CVP-404', host: `http://127.0.0.1:${port}`, authMode: 'token', token: 'T' });
  await poller.pollCvpOnce({ manual: false, only: [s.id] });
  const first = hits.parts;
  assert.ok(first > 0, '첫 주기에는 파트를 시도한다');
  const st = store.getStatus(s.id);
  assert.equal(st.partsDueUnread, undefined, `시도는 했으므로 '예산 때문에 못 읽음' 이 아니다: ${JSON.stringify(st)}`);
  await poller.pollCvpOnce({ manual: false, only: [s.id] });
  assert.equal(hits.parts, first, '두 번째 주기에는 파트를 다시 조회하지 않는다(조회 시각이 올라갔다)');
  reg.deleteServer?.(s.id);
});

/* ── DB ─────────────────────────────────────────────────────────────── */
const T0 = 1_750_000_000_000; // 고정 기준 시각
const dev = (key, ts, ports) => ({ key, ts, hostname: key, ports: ports.map((n) => ({ name: n, oper: 'up', admin: 'up', inBps: 10, outBps: 20 })) });

test('DB2612-01 늦게 온 옛 레코드가 지워진 포트를 되살리지 않는다', async () => {
  const db = await import('../src/cvp/db.js');
  if (!(await db.available())) return;
  const cvpId = 'cvp-db2612';
  await db.saveDevices({ agent: 'e1', cvpId, devices: [dev('D1', T0 + 1000, ['p1', 'p2'])] });
  await db.saveDevices({ agent: 'e1', cvpId, devices: [dev('D1', T0 + 3000, ['p2'])] }); // p1 사라짐
  const r = await db.saveDevices({ agent: 'e1', cvpId, devices: [dev('D1', T0 + 2000, ['p1', 'p2'])] }); // 늦게 온 옛 레코드
  assert.equal(r.stalePorts, 1);
  const rows = (await db.listDeviceRows({ agent: 'e1', cvpId })).rows;
  assert.equal(rows[0].ports.total, 1, 'p1 이 되살아나면 안 된다');
});

test('PERF2612-02 saveDevices 는 장비 청크마다 커밋하고 양보한다', async () => {
  const db = await import('../src/cvp/db.js');
  if (!(await db.available())) return;
  const devices = Array.from({ length: 100 }, (_, i) => dev(`S${i}`, T0 + 10_000, ['e1', 'e2']));
  const { ticks, out } = await ticksDuring(() => db.saveDevices({ agent: 'e2', cvpId: 'cvp-perf2', devices, samples: true, txnDevices: 10 }));
  assert.equal(out.devices, 100);
  assert.ok(ticks >= 8, `청크 10개 사이 양보가 있어야 한다(틱 ${ticks})`);
});

test('RECENT2612-04 · PERF2612-01 대소문자 변형 행을 청크로 옮기고 같은 날 일 롤업은 합친다', async () => {
  const db = await import('../src/cvp/db.js');
  if (!(await db.available())) return;
  const { DatabaseSync } = await import('node:sqlite');
  const cvpId = 'cvp-adopt';
  // 변형 이름 'Edge-A' 에 장비·표본(같은 날 여러 행) · 저장 키 'edge-a' 에도 같은 날 표본
  await db.saveDevices({ agent: 'Edge-A', cvpId, devices: [dev('D1', T0 + 500, ['p1'])] });
  const rowsV = Array.from({ length: 300 }, (_, i) => [cvpId, 'D1', 'p1', T0 + i * 1000, 100, 200, 10, 20, 0, 0]);
  rowsV.push([cvpId, 'D1', 'p1', T0 + 400_000, 9_999, 200, 90, 20, 0, 0]);
  await db.importSamples('Edge-A', rowsV);
  await db.importSamples('edge-a', [[cvpId, 'D1', 'p1', T0 + 900_000, 300, 400, 30, 40, 0, 0]]);
  const file = (await db.dbStats()).file;
  const q = (sql, ...a) => { const c = new DatabaseSync(file, { readOnly: true }); try { return c.prepare(sql).all(...a); } finally { c.close(); } };
  const before = q("SELECT agent, SUM(samples) n, MAX(in_bps_max) mx FROM port_daily WHERE cvp_id=? GROUP BY agent", cvpId);
  const totalBefore = before.reduce((s, r) => s + Number(r.n), 0);
  assert.equal(totalBefore, 302);
  const quick = await db.adoptAgentVariants('edge-a', { chunkRows: 20 });
  assert.equal(quick.background, true, '요청을 붙잡지 않는다(백그라운드)');
  const { ticks, out } = await ticksDuring(() => db.adoptAgentVariants('edge-a', { wait: true }));
  assert.ok(out && out.variants.includes('Edge-A'));
  assert.ok(ticks >= 10, `청크(20행) 사이 양보(틱 ${ticks})`);
  const after = q("SELECT agent, SUM(samples) n, MAX(in_bps_max) mx, SUM(in_bps_n) bn FROM port_daily WHERE cvp_id=? GROUP BY agent", cvpId);
  assert.equal(after.length, 1); assert.equal(after[0].agent, 'edge-a');
  assert.equal(Number(after[0].n), 302, '같은 날 일 롤업 표본 수를 잃지 않는다');
  assert.equal(Number(after[0].mx), 9_999, '최대는 MAX');
  assert.equal(Number(q('SELECT COUNT(*) n FROM port_sample WHERE agent=? AND cvp_id=?', 'edge-a', cvpId)[0].n), 302);
  assert.equal(Number(q("SELECT COUNT(*) n FROM port_sample WHERE agent='Edge-A'")[0].n), 0);
  assert.equal(Number(q("SELECT COUNT(*) n FROM device_latest WHERE agent='edge-a' AND cvp_id=?", cvpId)[0].n), 1);
});

test('RECENT2612-04 최신 표는 두 이름 중 ts 가 더 큰 행을 남긴다', async () => {
  const db = await import('../src/cvp/db.js');
  if (!(await db.available())) return;
  const cvpId = 'cvp-adopt-latest';
  const d = (key, ts, hostname) => ({ key, ts, hostname, ports: [{ name: 'p1', oper: 'up', admin: 'up' }] });
  await db.saveDevices({ agent: 'Edge-B', cvpId, devices: [d('NEWER', T0 + 5000, 'variant-new'), d('OLDER', T0 + 1000, 'variant-old')] });
  await db.saveDevices({ agent: 'edge-b', cvpId, devices: [d('NEWER', T0 + 1000, 'key-old'), d('OLDER', T0 + 5000, 'key-new')] });
  await db.adoptAgentVariants('edge-b', { wait: true, chunkRows: 1 });
  const rows = (await db.listDeviceRows({ cvpId })).rows;
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(rows.every((r) => r.agent === 'edge-b'), true);
  assert.equal(by.NEWER.hostname, 'variant-new');
  assert.equal(by.OLDER.hostname, 'key-new');
});
