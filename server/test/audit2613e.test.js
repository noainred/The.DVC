// v2.613 감사 그룹 G4b(e) — 엣지 push 규약 통일·중앙 게이트 미들웨어 회귀 고정.
//   DEPS2613-09  routes/central.js 의 2줄 게이트 51회 → `requireCentral()` 미들웨어 1벌(응답 본문 동일) + 중복 agent 재대조 4곳 제거
//   EDGE2613-03  sanswitch/push.js 단일비행을 `_busy(프라미스)+_again` 으로(형제 5개와 같다) · sanSwitchConfigPull 의 문자열 대조 재시도 루프 제거
//   EDGE2613-04  sanswitch·pdu push 도 '위임은 있는데 스냅샷 0' 이면 상태 전용 push · 중앙 수신(목록은 건드리지 않는다) · 프로브를 agent/centralStatusOnly.js 로
//   EDGE2613-05  readDropSummary 사본 3벌 → util/centralReply.js dropSummaryOf(coerced·zoningTrimmed·evicted·dropped 포함) · agent/centralReply.js 는 재수출
//   CONTRACT2613-03  /guest-disk 응답 `dropped:{vms,parts}` + guestDiskPush 가 읽는다 · vmSeriesPush 가 받아들인 행 수를 대조한다
//   RUNTIME2613-04  sanswitch push·perfPush 주기 env 를 clampIntervalMs 로(상한)
// 실제 centralRouter 를 express 에 띄워 상태코드·본문으로 보고(중앙 쪽), 목 중앙 HTTP 서버로 엣지 push 본문 도착까지 본다(엣지 쪽).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TOKEN = 'tok-2613e-shared';
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2613e-'));
process.env.CONFIG_DIR = CFG;
process.env.CENTRAL_TOKEN = TOKEN;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'true';
process.env.GUESTDISK_DB_PATH = path.join(CFG, 'guest-disk.db');
fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: 'vc-site1', name: 'Site1', host: 'https://10.0.0.1', collectMode: 'site' },
] }));

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
const code = (p) => stripComments(read(p));
const quiet = async (fn) => { const w = console.warn; const l = console.log; console.warn = () => {}; console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; } };

let srv; let base; let config;
before(async () => {
  const express = (await import('express')).default;
  ({ config } = await import('../src/config.js'));
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use('/api/central', centralRouter);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api/central`;
});
after(() => { srv?.close(); try { fs.rmSync(CFG, { recursive: true, force: true }); } catch { /* */ } });

const call = (method, p, body, { token = TOKEN } = {}) => fetch(`${base}${p}`, {
  method, headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Central-Token': token } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

/** 목 중앙 — 경로별 응답기. gzip 본문을 풀어 `got` 에 남긴다(엣지 push 본문 도착 확인). */
function mockCentral(routes = {}) {
  const got = [];
  const srv2 = http.createServer((req, res) => {
    const bufs = [];
    req.on('data', (c) => bufs.push(c));
    req.on('end', async () => {
      let raw = Buffer.concat(bufs);
      if (req.headers['content-encoding'] === 'gzip') { try { raw = zlib.gunzipSync(raw); } catch { /* */ } }
      let body = null; try { body = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { body = null; }
      const p = req.url.split('?')[0];
      got.push({ path: p, body, headers: req.headers });
      const h = routes[p] || routes['*'];
      const out = (await h?.(body, req)) || {};
      res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.json || { ok: true }));
    });
  });
  return { srv2, got };
}
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
async function withEdge(routes, fn) {
  const { srv2, got } = mockCentral(routes);
  const port = await listen(srv2);
  const prev = { url: config.agent.centralUrl, token: config.agent.centralToken, name: config.agent.name };
  config.agent.centralUrl = `http://127.0.0.1:${port}`; config.agent.centralToken = 'tok'; config.agent.name = 'edge-e';
  try { return await fn(got); }
  finally { srv2.close(); config.agent.centralUrl = prev.url; config.agent.centralToken = prev.token; config.agent.name = prev.name; }
}

// ─────────────────────────────────────────────────────────────────────────────
test('DEPS2613-09: central 라우트 51개 전부 requireCentral() 미들웨어를 쓰고 인라인 2줄 게이트·중복 agent 재대조는 0건이다(소스 열거)', () => {
  const s = code('routes/central.js');
  const decls = [...s.matchAll(/^centralRouter\.(get|post|put|delete)\('([^']+)',\s*([^\n]+)$/gm)];
  assert.ok(decls.length >= 51, `라우트 선언 ${decls.length}개(51 이상이어야 한다)`);
  const bad = decls.filter((m) => !m[3].startsWith('requireCentral(')).map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(bad, [], `requireCentral() 없이 선언된 라우트: ${bad.join(', ')}`);
  // 인라인 게이트는 미들웨어 본체의 1회뿐이다(수정 전 51+51)
  assert.equal((s.match(/if \(!centralEnabled\(\)\) return/g) || []).length, 1);
  assert.equal((s.match(/if \(!authed\(req\)\) return/g) || []).length, 1);
  // 미들웨어(centralRouter.use)가 requestedAgent 로 이미 하는 토큰↔agent 대조를 다시 하던 4곳은 사라졌다
  assert.equal(s.includes('토큰의 agent 와 요청 agent 불일치'), false);
  // 404 본문 변형 두 종류는 notFound 옵션으로 보존한다
  assert.ok(s.includes("requireCentral({ notFound: { ok: false, reason: 'central 비활성화 (CENTRAL_TOKEN 미설정)' } })"));
  assert.ok(s.includes('requireCentral({ notFound: { ok: false } })'));
});

test('DEPS2613-09: 런타임 — 비활성이면 라우트별 예전 404 본문 그대로, 토큰이 틀리면 403 {ok:false, reason}, 맞으면 통과', async () => {
  const savedTok = config.central.token;
  try {
    config.central.token = ''; // 개별 토큰 파일도 없다(빈 CONFIG_DIR) → centralEnabled() === false
    const a = await call('GET', '/assignment?agent=x');
    assert.equal(a.status, 404); assert.deepEqual(a.body, { ok: false, reason: 'central 비활성화 (CENTRAL_TOKEN 미설정)' });
    const r = await call('POST', '/result', { agent: 'x' });
    assert.equal(r.status, 404); assert.deepEqual(r.body, { ok: false });
    const i = await call('POST', '/inventory', { agent: 'x' });
    assert.equal(i.status, 404); assert.deepEqual(i.body, { ok: false, reason: 'central 비활성화' });
    const h = await call('GET', '/health-probe');
    assert.equal(h.status, 404, '비활성은 토큰 검사보다 먼저다(예전 순서)');
  } finally { config.central.token = savedTok; }
  const bad = await call('GET', '/storage-config?agent=edge-e', null, { token: 'wrong' });
  assert.equal(bad.status, 403); assert.deepEqual(bad.body, { ok: false, reason: '토큰 불일치' });
  const none = await call('POST', '/inventory', { agent: 'x' }, { token: '' });
  assert.equal(none.status, 403);
  const ok = await call('GET', '/storage-config?agent=edge-e');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body?.ok, true);
});

// ─────────────────────────────────────────────────────────────────────────────
test('EDGE2613-03: sanswitch push 단일비행은 프라미스+_again 이다 — 진행 중에 들어온 요청은 끝난 뒤 한 번 더 보내고 그 결과를 받는다', async () => {
  for (const f of ['storage/push.js', 'pdu/push.js', 'sanswitch/push.js', 'sanswitch/perfPush.js', 'cvp/push.js', 'partfault/push.js']) {
    const s = code(f);
    assert.equal(/let _busy = false/.test(s), false, `${f}: 불리언 거절 단일비행이 남아 있다`);
    assert.ok(/_again = true/.test(s), `${f}: _again 합류가 없다`);
  }
  const pull = code('agent/sanSwitchConfigPull.js');
  assert.equal(pull.includes('BUSY_REASON'), false, '사유 문자열 대조가 남아 있다');
  assert.equal(/maxTries|sleep\(/.test(pull), false, '2초×90회 재시도 루프가 남아 있다');
  assert.ok(/await pushSanSwitchNow\(\)/.test(pull), 'storageConfigPull 과 같은 표준 경로(await pushXNow)');
  const push = await import('../src/sanswitch/push.js');
  const { applyPulledDevices } = await import('../src/sanswitch/registry.js');
  let release; const gate = new Promise((r) => { release = r; });
  let n = 0;
  await withEdge({ '/api/central/sanswitch-data': async () => { if (n++ === 0) await gate; return { json: { ok: true, saved: 0 } }; } }, async (got) => {
    applyPulledDevices([]); // 위임 0대 → 빈 청크 0 으로 중앙 목록 비우기(POST 1회)
    const first = push.pushSanSwitchNow();
    await new Promise((r) => setTimeout(r, 30));
    let settled = false;
    const second = push.pushSanSwitchNow().then((x) => { settled = true; return x; });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(settled, false, '합류 — 진행 중인 push 가 끝나기 전에는 결과가 없다(수정 전: 즉시 {ok:false, reason:"이전 push 진행 중"})');
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.ok, true); assert.equal(b.ok, true);
    assert.notEqual(b.reason, '이전 push 진행 중');
    assert.equal(got.filter((g) => g.path === '/api/central/sanswitch-data').length, 2, '끝난 뒤 한 번 더 보냈다');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test('EDGE2613-04: sanswitch·pdu push 는 위임은 있는데 스냅샷이 없으면 상태 전용 보고를 올린다(중앙 v2.613 미만이면 보내지 않고 사유를 남긴다)', async () => {
  assert.equal((code('storage/push.js').match(/function centralStatusOnlySupport/g) || []).length, 0, '프로브 본체는 storage 에 없다');
  assert.ok(/export async function centralStatusOnlySupport/.test(code('agent/centralStatusOnly.js')));
  for (const f of ['storage/push.js', 'sanswitch/push.js', 'pdu/push.js']) assert.ok(code(f).includes("from '../agent/centralStatusOnly.js'"), `${f}: 공용 프로브를 쓰지 않는다`);
  const cap = await import('../src/agent/centralStatusOnly.js');
  assert.equal(cap.DEVICE_STATUS_ONLY_MIN_CENTRAL, '2.613.0');
  const push = await import('../src/sanswitch/push.js');
  const sanReg = await import('../src/sanswitch/registry.js');
  const pduPush = await import('../src/pdu/push.js');
  const pduReg = await import('../src/pdu/registry.js');
  const pduPoller = await import('../src/pdu/poller.js');
  let version = '2.612.0';
  await withEdge({ '/api/central/health-probe': () => ({ json: { ok: true, version } }) }, async (got) => {
    sanReg.applyPulledDevices([{ id: 'sw-e1', name: 'sw-e1', host: '10.9.9.9', agent: 'edge-e', method: 'ssh', username: 'u', password: 'p' }]);
    pduReg.applyPulledDevices([{ id: 'pdu-e1', name: 'pdu-e1', host: '10.9.9.8', agent: 'edge-e', username: 'u', password: 'p' }]);
    pduPoller._resetForTest();
    // ① 구버전 중앙 → 보내지 않는다(빈 목록 = 교체 → 중앙 목록이 비워진다)
    cap._resetStatusOnlyCapForTest();
    const r1 = await quiet(() => push.pushSanSwitchNow());
    assert.equal(r1.sent, 0); assert.equal(r1.statusSent, false); assert.equal(r1.statusSkipped, 'central-too-old');
    assert.equal(got.filter((g) => g.path === '/api/central/sanswitch-data').length, 0, '구버전 중앙에 빈 청크를 보내면 목록이 비워진다');
    assert.equal(push.sanSwitchPushStatus().statusSkipped, 'central-too-old');
    const p1 = await quiet(() => pduPush.pushPduNow());
    assert.equal(p1.withheld, true); assert.equal(p1.statusSent, false); assert.equal(p1.statusSkipped, 'central-too-old');
    assert.equal(got.filter((g) => g.path === '/api/central/pdu-data').length, 0);
    // ② v2.613 중앙 → statusOnly 본문(목록 필드는 비어 있고 statusOnly:true)
    version = '2.613.0'; cap._resetStatusOnlyCapForTest();
    const r2 = await quiet(() => push.pushSanSwitchNow());
    assert.equal(r2.statusSent, true, JSON.stringify(r2));
    const sd = got.filter((g) => g.path === '/api/central/sanswitch-data');
    assert.equal(sd.length, 1);
    assert.equal(sd[0].body.statusOnly, true); assert.deepEqual(sd[0].body.devices, []); assert.equal(sd[0].body.chunk, 0);
    assert.equal(sd[0].body.status.reason, 'no-snapshots'); assert.equal(sd[0].body.status.registered, 1);
    assert.equal(sd[0].headers['x-agent-name'], 'edge-e');
    const p2 = await quiet(() => pduPush.pushPduNow());
    assert.equal(p2.withheld, true); assert.equal(p2.statusSent, true, JSON.stringify(p2));
    const pd = got.filter((g) => g.path === '/api/central/pdu-data');
    assert.equal(pd.length, 1);
    assert.equal(pd[0].body.statusOnly, true); assert.deepEqual(pd[0].body.snapshots, []);
    assert.equal(pd[0].body.status.reason, 'no-snapshots'); assert.equal(pd[0].body.status.registered, 1);
    assert.equal(pduPush.pduPushStatus().statusSent, true);
    // ③ 프로브는 필요 버전별로 캐시한다 — storage(2.581.0)는 통과, 장비 목록 경로(2.613.0)는 버전에 따라 갈린다
    version = '2.600.0'; cap._resetStatusOnlyCapForTest();
    assert.equal((await cap.centralStatusOnlySupport({ minVersion: cap.STATUS_ONLY_MIN_CENTRAL })).ok, true);
    assert.equal((await cap.centralStatusOnlySupport({ minVersion: cap.DEVICE_STATUS_ONLY_MIN_CENTRAL })).reason, 'central-too-old');
    sanReg.applyPulledDevices([]); pduReg.applyPulledDevices([]);
  });
});

test('EDGE2613-04: 중앙 /sanswitch-data·/pdu-data 는 statusOnly 보고를 목록 교체 없이 상태로만 기록한다(/storage-data 와 같다)', async () => {
  const sanEdge = await import('../src/central/sanSwitchEdge.js');
  const pduEdge = await import('../src/central/pduEdge.js');
  sanEdge._resetForTest(); pduEdge._resetForTest();
  const T = 1_800_000_000_000; // 고정 시각(경계와 무관)
  const a = await quiet(() => call('POST', '/sanswitch-data', { agent: 'edge-c', chunk: 0, chunks: 1, devices: [{ deviceId: 'sw-c1', name: 'sw-c1', host: '10.1.1.1', ok: true, collectedAt: T, ports: { total: 1, list: [] } }] }));
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(sanEdge.edgeSanSwitchSnapshots().filter((d) => d.agent === 'edge-c').length, 1);
  const s = await call('POST', '/sanswitch-data', { agent: 'edge-c', chunk: 0, chunks: 1, devices: [], statusOnly: true, status: { reason: 'no-snapshots', registered: 3, at: T } });
  assert.equal(s.status, 200); assert.deepEqual(s.body, { ok: true, saved: 0, statusOnly: true, recorded: true });
  assert.equal(sanEdge.edgeSanSwitchSnapshots().filter((d) => d.agent === 'edge-c').length, 1, '수정 전: 빈 청크 0 이 목록을 교체해 스위치가 사라졌다');
  const rep = sanEdge.edgeSanSwitchReports().find((r) => r.agent === 'edge-c');
  assert.equal(rep.deviceCount, 1); assert.equal(rep.status.reason, 'no-snapshots'); assert.equal(rep.status.registered, 3);
  // 장비 보고가 다시 오면 status 는 보존된다(storageEdge 규약)
  await quiet(() => call('POST', '/sanswitch-data', { agent: 'edge-c', chunk: 0, chunks: 1, devices: [{ deviceId: 'sw-c1', name: 'sw-c1', host: '10.1.1.1', ok: true, collectedAt: T + 1, ports: { total: 1, list: [] } }] }));
  assert.equal(sanEdge.edgeSanSwitchReports().find((r) => r.agent === 'edge-c').status.reason, 'no-snapshots');
  // PDU
  const b = await quiet(() => call('POST', '/pdu-data', { agent: 'edge-c', snapshots: [{ id: 'pdu-c1', name: 'pdu-c1', ok: true, collectedAt: T, units: [] }] }));
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(pduEdge.edgePduSnapshots().length, 1);
  const ps = await call('POST', '/pdu-data', { agent: 'edge-c', snapshots: [], statusOnly: true, status: { reason: 'no-snapshots', registered: 2, missing: 2 } });
  assert.equal(ps.status, 200); assert.deepEqual(ps.body, { ok: true, saved: 0, statusOnly: true, recorded: true });
  assert.equal(pduEdge.edgePduSnapshots().length, 1, '수정 전: 빈 snapshots 가 목록을 교체했다');
  const st = pduEdge.edgePduStatus().find((e) => e.agent === 'edge-c');
  assert.equal(st.devices, 1); assert.equal(st.status.reason, 'no-snapshots'); assert.equal(st.status.registered, 2); assert.equal(st.status.missing, 2);
  // 아는 키만 · 길이 제한
  const junk = await call('POST', '/pdu-data', { agent: 'edge-c', snapshots: [], statusOnly: true, status: { reason: 'x'.repeat(500), registered: 'many', evil: 1 } });
  assert.equal(junk.status, 200);
  const st2 = pduEdge.edgePduStatus().find((e) => e.agent === 'edge-c').status;
  assert.equal(st2.reason.length <= 64, true); assert.equal(st2.registered, null); assert.equal('evil' in st2, false);
  sanEdge._resetForTest(); pduEdge._resetForTest();
});

// ─────────────────────────────────────────────────────────────────────────────
test('EDGE2613-05: readDropSummary 사본은 0벌 — util/centralReply.dropSummaryOf 가 dropped·coerced·zoningTrimmed·evicted 까지 읽고 세 push 가 그것을 쓴다', async () => {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) files.push(p); } };
  walk(SRC);
  const copies = files.filter((f) => /function readDropSummary\(/.test(stripComments(fs.readFileSync(f, 'utf8')))).map((f) => path.relative(SRC, f));
  assert.deepEqual(copies, [], `readDropSummary 사본: ${copies.join(', ')}`);
  for (const f of ['storage/push.js', 'sanswitch/push.js', 'pdu/push.js']) {
    const s = code(f);
    assert.ok(s.includes("from '../util/centralReply.js'"), `${f}: 공용 판독기를 import 하지 않는다`);
    assert.ok(/dropSummaryOf\(await readCentralReply\(res\)\)/.test(s), `${f}: readCentralReply+dropSummaryOf 로 읽지 않는다`);
  }
  // 옛 경로는 재수출(import + export — `export … from` 금지, v2.575)
  const shim = code('agent/centralReply.js');
  assert.ok(/import \{[^}]*dropSummaryOf[^}]*\} from '\.\.\/util\/centralReply\.js'/.test(shim));
  assert.ok(/^export \{[^}]*dropSummaryOf[^}]*\};/m.test(shim));
  assert.equal(/export \{[^}]*\} from/.test(shim), false);
  const cr = await import('../src/util/centralReply.js');
  const old = await import('../src/agent/centralReply.js');
  assert.equal(old.dropSummaryOf, cr.dropSummaryOf, '재수출은 같은 함수다');
  const d = cr.dropSummaryOf({ ok: true, rejected: 1, dropped: { notOwned: 1 }, coerced: 2, zoningTrimmed: 3, evicted: 'old-edge' });
  assert.equal(d.rejected, 1); assert.deepEqual(d.dropped, { notOwned: 1 }); assert.equal(d.coerced, 2); assert.equal(d.zoningTrimmed, 3); assert.equal(d.evicted, 'old-edge');
  assert.match(d.text, /거부 1\(notOwned 1\)/); assert.match(d.text, /조닝 일부만 저장 3/); assert.match(d.text, /old-edge/);
  assert.equal(cr.dropSummaryOf({ ok: true, coerced: 0, zoningTrimmed: 0 }), null);
  assert.equal(cr.dropSummaryOf({ ok: true, zoningTrimmed: 2 }).zoningTrimmed, 2, '조닝 축약만 있어도 요약이 있다(sanswitch 판본과 같다)');
  const m = cr.mergeDrop(d, cr.dropSummaryOf({ rejected: 2, dropped: { notOwned: 1, notObject: 1 }, zoningTrimmed: 1 }));
  assert.equal(m.rejected, 3); assert.deepEqual(m.dropped, { notOwned: 2, notObject: 1 }); assert.equal(m.zoningTrimmed, 4);
  assert.equal(cr.dropText({ a: 0, b: 2 }), 'b 2'); assert.equal(cr.dropText(null), '사유 미상');
  // 런타임: sanswitch push 가 공용 판독기로 중앙 응답을 상태에 남긴다
  const push = await import('../src/sanswitch/push.js');
  const store = await import('../src/sanswitch/store.js');
  const sanReg = await import('../src/sanswitch/registry.js');
  await withEdge({ '/api/central/sanswitch-data': () => ({ json: { ok: true, saved: 1, rejected: 1, dropped: { notOwned: 1 }, zoningTrimmed: 1 } }) }, async (got) => {
    sanReg.applyPulledDevices([{ id: 'sw-e2', name: 'sw-e2', host: '10.9.9.7', agent: 'edge-e', method: 'ssh', username: 'u', password: 'p' }]);
    store.putSnapshot({ deviceId: 'sw-e2', name: 'sw-e2', ok: true, collectedAt: 1_800_000_000_000, ports: { total: 0, list: [] } });
    try {
      const r = await quiet(() => push.pushSanSwitchNow());
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(got.filter((g) => g.path === '/api/central/sanswitch-data').length, 1);
      const st = push.sanSwitchPushStatus();
      assert.equal(st.rejected, 1); assert.deepEqual(st.dropped, { notOwned: 1 }); assert.equal(st.centralZoningTrimmed, 1);
    } finally { store.dropSnapshot('sw-e2'); sanReg.applyPulledDevices([]); }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test('CONTRACT2613-03: /guest-disk 응답은 적재하지 않은 행을 dropped:{vms,parts} 로 싣고, guestDiskPush·vmSeriesPush 가 중앙 응답을 읽는다', async () => {
  const c = code('routes/central.js');
  assert.ok(/dropped: \{ vms: Number\(commit\.skippedVms\) \|\| 0, parts: Number\(commit\.skippedParts\) \|\| 0 \}/.test(c), '/guest-disk 응답에 dropped 가 없다');
  // 정상 push 에는 필드가 없다(구버전 엣지 호환 — 뺀 것이 없으면 필드 자체가 없다)
  const ok = await quiet(() => call('POST', '/guest-disk', { agent: 'edge-c', vcenterId: 'vc-site1', vcenterName: 'Site1', total: 1, withGuest: 1,
    vms: [{ vmId: 'vm-1', vmName: 'a', allocGB: 10, usedGB: 2, partCount: 1, parts: [{ path: '/', capGB: 10, usedGB: 2 }] }] }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal('dropped' in (ok.body || {}), false);
  // ⚠ 정직 기록: v2.601+ 엣지는 push 전에 같은 sanitizeGuestDiskVms 를 거치므로 HTTP 로는 skipped 를 만들 수 없다(2중 방어) — 응답 조립은 소스로 고정.
  const gd = code('agent/guestDiskPush.js');
  assert.ok(gd.includes("from '../util/centralReply.js'"));
  assert.ok(/dropSummaryOf\(await readCentralReply\(res\)\)/.test(gd), 'guestDiskPush 가 응답을 읽지 않는다');
  assert.ok(/warnDrop\('gd-push'/.test(gd));
  assert.ok(/\.\.\.\(drop \? \{ drop \} : \{\}\)/.test(gd), '상태(last)에 drop 을 싣지 않는다');
  const cr = await import('../src/util/centralReply.js');
  const s = cr.dropSummaryOf({ ok: true, vcenterId: 'vc', vms: 3, dropped: { vms: 1, parts: 2 } });
  assert.equal(s.rejected, 3); assert.match(s.text, /vms 1 · parts 2/);
  // vmSeriesPush — 중앙이 받아들인 행 수(spikes)가 보낸 행 수보다 적으면 상태·콘솔에 남긴다
  const vs = await import('../src/agent/vmSeriesPush.js');
  await withEdge({ '/api/central/vmseries': (b) => ({ json: { ok: true, vcenterId: 'vc-site1', spikes: Math.max(0, (b.spikes || []).length - 1), cover: 0, cursors: 0 } }) }, async (got) => {
    const spikes = [1, 2].map((i) => ({ kind: 'vm', ref: `vm-${i}`, t0: 1_800_000_000_000, t1: 1_800_000_060_000, n: 3, cols: ['cpu'], buf: Buffer.from([1, 2, 3]), mxcpu: 10, mxmem: 5 }));
    const r = await quiet(() => vs.pushVmSeriesSlice({ id: 'vc-site1', name: 'Site1' }, { spikes, cover: [], cursors: [], stats: null }));
    assert.equal(r.ok, true);
    assert.equal(got.filter((g) => g.path === '/api/central/vmseries').length, 1);
    assert.equal(r.dropped.rows, 1); assert.equal(r.dropped.sentRows, 2);
    assert.equal(vs.vmSeriesPushStatus().last.dropped.rows, 1);
    assert.match(vs.vmSeriesPushStatus().last.dropped.text, /1\/2/);
  });
  await withEdge({ '/api/central/vmseries': (b) => ({ json: { ok: true, spikes: (b.spikes || []).length } }) }, async () => {
    const r = await quiet(() => vs.pushVmSeriesSlice({ id: 'vc-site1' }, { spikes: [{ kind: 'vm', ref: 'vm-1', t0: 1, t1: 2, n: 1, cols: ['cpu'], buf: Buffer.from([1]) }], cover: [], cursors: [] }));
    assert.equal(r.dropped, undefined, '전부 받아들이면 필드가 없다');
    assert.equal(vs.vmSeriesPushStatus().last.dropped, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test('RUNTIME2613-04: sanswitch push·perfPush 주기 env 는 clampIntervalMs 로 상·하한에 가둔다(sanSwitchConfigPull 과 같다)', async () => {
  for (const f of ['sanswitch/push.js', 'sanswitch/perfPush.js']) {
    const s = code(f);
    assert.equal(/Math\.max\(\d[\d_]*,\s*Number\(process\.env\.\w+_MS\)/.test(s), false, `${f}: 상한 없는 주기 env`);
    assert.ok(/clampIntervalMs\(/.test(s), `${f}: clampIntervalMs 를 쓰지 않는다`);
  }
  const { MAX_TIMER_MS } = await import('../src/config.js');
  const { pushMs } = await import('../src/sanswitch/push.js');
  const { perfPushMs } = await import('../src/sanswitch/perfPush.js');
  const prev = { a: process.env.SANSW_PUSH_MS, b: process.env.SANSW_PERF_PUSH_MS };
  try {
    process.env.SANSW_PUSH_MS = '1e12'; assert.equal(pushMs(), MAX_TIMER_MS, '수정 전: 1e12(상한 없음)');
    process.env.SANSW_PUSH_MS = '10'; assert.equal(pushMs(), 60_000, '하한 60초');
    process.env.SANSW_PUSH_MS = 'abc'; assert.equal(pushMs(), 5 * 60_000, '비숫자는 기본값');
    process.env.SANSW_PERF_PUSH_MS = '1e12'; assert.equal(perfPushMs(), MAX_TIMER_MS);
    process.env.SANSW_PERF_PUSH_MS = '10'; assert.equal(perfPushMs(), 60_000);
  } finally {
    if (prev.a == null) delete process.env.SANSW_PUSH_MS; else process.env.SANSW_PUSH_MS = prev.a;
    if (prev.b == null) delete process.env.SANSW_PERF_PUSH_MS; else process.env.SANSW_PERF_PUSH_MS = prev.b;
  }
});
