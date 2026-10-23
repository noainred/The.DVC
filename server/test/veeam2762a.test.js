/**
 * test/veeam2762a.test.js — v2.762 Veeam 수집·등록·엣지 계약 점검 확정분 회귀(그룹 A).
 *
 *  · G1 결과에 접속처 지문(target — host:port:username 해시)을 싣고, 중앙 수신·putResult 는 등록부의 지금 지문과 다르면 버린다.
 *       lastOk 는 지문이 같을 때만 이어받는다 · 지문 없는 결과(옛 엣지)는 수용 · 정제 화이트리스트에 target.
 *  · G2 수집 도중 접속처가 바뀌면(단건 저장·엣지 pull) 그 수집의 결과·인증 정지 기록을 버린다(로그는 옛 접속처).
 *  · G3 관리 GET 응답의 readsHere — 엣지 화면이 받은 자기 몫의 '연결 시험'·'지금 읽기' 를 연다.
 *  · F4b 등록부를 못 읽으면 주기 수집이 저장된 결과를 지우지 않는다.  · F-I2 엣지 주기는 [2분, MAX_TIMER_MS] 만.
 *  · G-I1 판 올림 키는 경로 틀(id 마디 '{id}') · G-I2 실행 중 세션 task 는 4병렬 · G-I3 파일 목록 404·400 밖 실패도 notes 1줄.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'veeam2762a-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.CENTRAL_TOKEN = 'ctok-2762';
delete process.env.CENTRAL_URL;
const closers = [];

// Veeam(https://vbr…) 요청만 가짜로 받는다 — 폴러·라우트는 전역 fetch 를 쓴다(테스트 서버 요청은 진짜 fetch 로).
const realFetch = globalThis.fetch;
let vbrHandler = null;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://vbr')) {
    if (!vbrHandler) throw new TypeError('fetch failed');
    return vbrHandler(url, init || {});
  }
  return realFetch(url, init);
};
after(async () => {
  globalThis.fetch = realFetch;
  for (const c of closers.reverse()) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

const P = await import('../src/veeam/parse.js');
const R = await import('../src/veeam/registry.js');
const ST = await import('../src/veeam/store.js');
const C = await import('../src/veeam/client.js');
const poller = await import('../src/veeam/poller.js');
const E = await import('../src/central/veeamEdge.js');
const { config, MAX_TIMER_MS } = await import('../src/config.js');
const { stripComments } = await import('./_stripComments.js');
const KEEP_AGENT = { ...config.agent };
const resetAgent = () => { Object.assign(config.agent, KEEP_AGENT); config.agent.centralUrl = ''; config.agent.centralToken = ''; config.agent.name = ''; };
const clearRegistry = () => { for (const d of R.listServers()) R.deleteServer(d.id); };

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;
const VC = 'apac:vc01';
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const SRV = { id: 'vbr-t', name: 'T', host: 'vbr-t.corp.local', port: 9419, username: 'svc', password: 'Pw-2762', apiVersion: '1.1-rev0' };
const BASIC_JOBS = { data: [{ id: 'j1', name: 'BJ', type: 'Backup', virtualMachines: { includes: [{ type: 'VirtualMachine', hostName: 'vc01.corp.local', name: 'web01', objectId: 'vm-101' }] } }] };
const okResult = (extra = {}) => ({ ok: true, ts: NOW, jobs: [{ id: 'j', name: 'J' }], vms: [{ n: 'old-vm', m: 'vm-777', h: '', j: [0], rp: 3, run: 0, pg: null, by: '' }], counts: {}, notes: [], ...extra });
const failResult = (extra = {}) => ({ ok: false, ts: NOW, error: '인증 실패(401)', kind: 'auth', jobs: [], vms: [], counts: {}, notes: [], ...extra });

/** 가짜 Veeam REST — 경로별 응답. override(u, init) 가 Response 를 주면 그것을 쓴다. log 에 요청을 남긴다. */
function veeamFake({ jobs = BASIC_JOBS, sessions = { data: [] }, tasks = () => ({ data: [] }), backups = { data: [] }, files = () => ({ data: [] }), override = null, log = [] } = {}) {
  return async (url, init = {}) => {
    const u = new URL(url);
    log.push({ host: u.hostname, path: u.pathname, search: u.search, ver: init.headers?.['x-api-version'] });
    if (override) { const r = await override(u, init); if (r) return r; }
    const p = u.pathname;
    if (p === '/api/oauth2/token') return json({ access_token: 'TKN', token_type: 'bearer' });
    if (p === '/api/oauth2/logout') return json({});
    if (p === '/api/v1/jobs') return json(jobs);
    if (p === '/api/v1/jobs/states' || p === '/api/v1/backupObjects' || p === '/api/v1/restorePoints') return json({ data: [] });
    if (p === '/api/v1/sessions') return json(sessions);
    let m = /^\/api\/v1\/sessions\/([^/]+)\/taskSessions$/.exec(p);
    if (m) { const t = await tasks(decodeURIComponent(m[1]), init); return t instanceof Response ? t : json(t); }
    if (p === '/api/v1/backups') return json(backups);
    m = /^\/api\/v1\/backups\/([^/]+)\/backupFiles$/.exec(p);
    if (m) { const f = await files(decodeURIComponent(m[1]), init); return f instanceof Response ? f : json(f); }
    return json({ message: 'not found' }, 404);
  };
}

/* ═══════════════ 실제 라우터(중앙 수신 · 관리 화면) ═══════════════ */
let centralBase = ''; let adminBase = '';
before(async () => {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const { registerVeeam } = await import('../src/routes/admin/veeam.js');
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use('/api/central', centralRouter);
  const admin = express.Router();
  app.use('/api/admin', (req, _res, next) => { req.user = { username: 'adm', role: 'admin' }; next(); }, admin);
  registerVeeam(admin);
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  closers.push(() => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(() => ok()); }));
  centralBase = `http://127.0.0.1:${srv.address().port}/api/central`;
  adminBase = `http://127.0.0.1:${srv.address().port}/api/admin/veeam/servers`;
});
const adminPost = async (p, body = {}) => { const res = await realFetch(`${adminBase}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
const adminGet = async () => { const res = await realFetch(adminBase); return { status: res.status, body: await res.json() }; };

/* ═══════════════ G1 ═══════════════ */
test('G1: 접속처 지문 — host·port·계정(대소문자 무시)으로만 바뀌고 계정 평문이 없다 · 수집 결과에 실린다 · 정제 화이트리스트', async () => {
  const f = R.accessFingerprint(SRV);
  assert.match(f, /^[0-9a-f]{16}$/);
  assert.ok(!f.includes('svc'));
  assert.equal(R.accessFingerprint({ ...SRV, host: 'VBR-T.corp.local', username: 'SVC', password: 'other' }), f, '대소문자·비밀번호는 지문을 바꾸지 않는다');
  assert.equal(R.accessFingerprint({ ...SRV, port: undefined }), f, '빈 포트 = 기본 포트');
  for (const ch of [{ host: 'vbr-u.corp.local' }, { port: 9420 }, { username: 'svc2' }]) assert.notEqual(R.accessFingerprint({ ...SRV, ...ch }), f, JSON.stringify(ch));
  const r = await C.collectVeeamServer(SRV, { fetchImpl: veeamFake() });
  assert.equal(r.ok, true); assert.equal(r.target, f, '성공 결과에 읽은 접속처 지문');
  assert.equal(P.sanitizeServerResult({ ...r }).target, f, '정제가 target 을 남긴다(엣지 export 필드 — 중앙 화이트리스트)');
  for (const bad of ['svc@vbr-t', 'ABCDEF0123456789', 'abc', 12345, { x: 1 }]) assert.equal(P.sanitizeServerResult({ ...r, target: bad }).target, undefined, `형식 밖 target(${JSON.stringify(bad)})은 버린다`);
});

test('G1: putResult — 등록부 지문과 다른 결과는 버리고, lastOk 는 지문이 같을 때만 이어받는다(지문 없는 결과·기록은 예전처럼)', () => {
  ST._resetForTest();
  const A = 'a'.repeat(16); const B = 'b'.repeat(16);
  assert.equal(ST.putResult('g1-s', okResult({ target: A }), { expectTarget: B }), false, '지문이 다르면 기록하지 않는다');
  assert.equal(ST.getRecord('g1-s'), null);
  assert.equal(ST.putResult('g1-s', okResult({ target: A }), { expectTarget: A }), true);
  ST.putResult('g1-s', failResult({ target: B }));
  assert.equal(ST.getRecord('g1-s').lastOk, undefined, '다른 접속처의 실패는 옛 VM 표를 이어받지 않는다');
  assert.equal(ST.usableResult(ST.getRecord('g1-s')), null);
  ST.putResult('g1-s', okResult({ target: A })); ST.putResult('g1-s', failResult({ target: A }));
  assert.deepEqual(ST.usableResult(ST.getRecord('g1-s')).vms.map((v) => v.n), ['old-vm'], '같은 접속처 실패는 마지막 성공을 이어받는다');
  ST.putResult('g1-s', failResult());
  assert.ok(ST.getRecord('g1-s').lastOk, '지문 없는 결과(옛 엣지)는 예전처럼 이어받는다');
  ST.putResult('g1-t', okResult()); ST.putResult('g1-t', failResult({ target: B }));
  assert.ok(ST.getRecord('g1-t').lastOk, '지문 없는 옛 기록은 예전처럼 이어받는다(업그레이드 직후)');
  assert.equal(ST.putResult('g1-u', okResult(), { expectTarget: A }), true, '지문 없는 결과는 등록부 지문이 있어도 수용(옛 엣지)');
  ST._resetForTest();
});

test('G1: 실제 중앙 veeam-data — 접속처를 바꾼 뒤 엣지가 pull 전에 보낸 옛 접속처 결과는 stale 로 버리고, 새 접속처 실패가 옛 VM 표를 이어받지 않는다', async () => {
  clearRegistry(); resetAgent(); ST._resetForTest();
  const { store } = await import('../src/store.js');
  const prevSnap = store.snapshot;
  store.snapshot = { source: 'live', vcenters: [{ id: VC, name: 'vc01' }], vms: [], hosts: [] };
  const warn = console.warn; console.warn = () => {};
  try {
    const { issueAgentToken } = await import('../src/central/agentTokens.js');
    const tok = issueAgentToken('edge-g1').token;
    const push = async (results) => {
      const res = await realFetch(`${centralBase}/veeam-data?agent=edge-g1`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': tok, 'X-Agent-Name': 'edge-g1' }, body: JSON.stringify({ agent: 'edge-g1', status: { servers: 1 }, results }) });
      return { status: res.status, body: await res.json() };
    };
    const d = R.saveServer({ name: 'G1', host: 'vbr-g1-old.corp', username: 'svc', password: 'pw-g1', vcenterIds: [VC], agent: 'edge-g1' });
    const fOld = R.accessFingerprint(R.getServerWithSecret(d.id));
    const a = await push([{ serverId: d.id, ...okResult({ target: fOld }) }]);
    assert.equal(a.body.saved, 1, JSON.stringify(a.body));
    // 관리자가 host 를 바꿔 저장(비밀번호 재입력 안 함 → 폐기) — B4 가 옛 결과를 지운다
    const mv = await adminPost('', { id: d.id, name: 'G1', host: 'vbr-g1-new.corp', username: 'svc', vcenterIds: [VC], agent: 'edge-g1' });
    assert.equal(mv.status, 201, JSON.stringify(mv.body));
    assert.equal(ST.getRecord(d.id), null);
    const fNew = R.accessFingerprint(R.getServerWithSecret(d.id));
    assert.notEqual(fNew, fOld);
    // 엣지가 아직 pull 하지 않아 옛 접속처 결과(ok:true)를 다시 보낸다 → 버린다
    const b = await push([{ serverId: d.id, ...okResult({ target: fOld }) }]);
    assert.equal(b.status, 200);
    assert.equal(b.body.saved, 0, JSON.stringify(b.body)); assert.equal(b.body.dropped.stale, 1); assert.equal(b.body.rejected, 1);
    assert.equal(ST.getRecord(d.id), null, '옛 접속처 결과가 되살아나지 않는다');
    // pull 뒤 새 접속처 첫 수집 실패 → 옛 VM 표를 '마지막 성공' 으로 쓰지 않는다
    const c = await push([{ serverId: d.id, ...failResult({ target: fNew }) }]);
    assert.equal(c.body.saved, 1, JSON.stringify(c.body));
    assert.equal(ST.usableResult(ST.getRecord(d.id)), null);
    // 옛 엣지(지문 없음)는 지금처럼 받는다(호환)
    const o = await push([{ serverId: d.id, ...okResult() }]);
    assert.equal(o.body.saved, 1, JSON.stringify(o.body));
    assert.equal(ST.getRecord(d.id).result.ok, true);
  } finally { console.warn = warn; store.snapshot = prevSnap; clearRegistry(); ST._resetForTest(); }
});

/* ═══════════════ G2 ═══════════════ */
/** 문 하나 — open() 할 때까지 wait() 가 멈춘다. */
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { wait: () => p, open }; };

test('G2(a): 수집이 도는 중 접속처를 바꾸면 그 수집의 성공 결과를 새 서버 것으로 기록하지 않는다', async () => {
  clearRegistry(); resetAgent(); ST._resetForTest(); poller._resetForTest();
  const warns = []; const warn = console.warn; console.warn = (...a) => warns.push(a.join(' '));
  try {
    const d = R.saveServer({ name: 'G2A', host: 'vbr-g2a-old.corp', username: 'svc', password: 'pw-a', vcenterIds: [VC] });
    const g = gate(); const reached = gate();
    vbrHandler = veeamFake({ override: async (u) => { if (u.pathname === '/api/v1/jobs' && u.hostname === 'vbr-g2a-old.corp') { reached.open(); await g.wait(); } return null; } });
    const run = poller.pollVeeamOnce({ manual: true, ids: [d.id] });
    await reached.wait();
    const mv = await adminPost('', { id: d.id, name: 'G2A', host: 'vbr-g2a-new.corp', username: 'svc', password: 'pw-a', vcenterIds: [VC] });
    assert.equal(mv.status, 201, JSON.stringify(mv.body));
    assert.equal(ST.getRecord(d.id), null, '저장 직후 기록 없음');
    g.open();
    const r = await run;
    assert.equal(ST.getRecord(d.id), null, '수집이 끝나도 옛 접속처 결과가 새 서버 기록으로 남지 않는다');
    assert.equal(r.discarded, 1, JSON.stringify(r)); assert.equal(r.ok, 0);
    assert.ok(warns.some((w) => w.includes('vbr-g2a-old.corp')) && !warns.some((w) => w.includes('vbr-g2a-new.corp')), `로그는 옛 접속처 기준: ${warns.join(' | ')}`);
    // 접속처가 그대로면 예전처럼 기록한다
    vbrHandler = veeamFake();
    const r2 = await poller.pollVeeamOnce({ manual: true, ids: [d.id] });
    assert.equal(r2.ok, 1, JSON.stringify(r2)); assert.equal(ST.getRecord(d.id).result.target, R.accessFingerprint(R.getServerWithSecret(d.id)));
  } finally { console.warn = warn; vbrHandler = null; clearRegistry(); ST._resetForTest(); }
});

test('G2(b): 로그인 401 이 도는 중 같은 계정·비밀번호로 접속처를 옮기면 정지를 기록하지 않는다 → 다음 주기는 새 host 로 읽는다', async () => {
  clearRegistry(); resetAgent(); ST._resetForTest(); poller._resetForTest();
  const warn = console.warn; console.warn = () => {};
  try {
    const d = R.saveServer({ name: 'G2B', host: 'vbr-g2b-old.corp', username: 'svc', password: 'pw-shared', vcenterIds: [VC] });
    const g = gate(); const reached = gate(); const log = [];
    vbrHandler = veeamFake({ log, override: async (u) => {
      if (u.hostname === 'vbr-g2b-old.corp' && u.pathname === '/api/oauth2/token') { reached.open(); await g.wait(); return new Response('', { status: 401 }); }
      return null;
    } });
    const run = poller.pollVeeamOnce({ ids: [d.id] });
    await reached.wait();
    const mv = await adminPost('', { id: d.id, name: 'G2B', host: 'vbr-g2b-new.corp', username: 'svc', password: 'pw-shared', vcenterIds: [VC] });
    assert.equal(mv.status, 201, JSON.stringify(mv.body));
    g.open();
    const r = await run;
    const now = R.getServerWithSecret(d.id);
    assert.equal(poller.authGuard.peekAuthStop(now), null, '옛 host 의 401 이 새 host 의 주기 수집을 멈추지 않는다');
    assert.equal(r.discarded, 1, JSON.stringify(r));
    const r2 = await poller.pollVeeamOnce({ ids: [d.id] });
    assert.equal(r2.ok, 1, JSON.stringify(r2));
    assert.ok(log.some((x) => x.host === 'vbr-g2b-new.corp' && x.path === '/api/v1/jobs'), '다음 주기는 새 접속처로 요청한다');
    assert.notEqual(ST.getRecord(d.id).result.kind, 'auth-stopped');
  } finally { console.warn = warn; vbrHandler = null; clearRegistry(); ST._resetForTest(); }
});

test('G2(c): 엣지 pull 이 수집 도중 접속처를 바꿔도(등록부 원소 교체) 옛 접속처 결과를 버린다', async () => {
  clearRegistry(); resetAgent(); ST._resetForTest(); poller._resetForTest();
  const warn = console.warn; console.warn = () => {};
  try {
    config.agent.centralUrl = 'http://127.0.0.1:9'; config.agent.name = 'edge-c';
    const item = { id: 'vbr-g2c', name: 'G2C', host: 'vbr-g2c-old.corp', port: 9419, username: 'svc', password: 'pw-c', agent: 'edge-c', vcenterIds: [VC] };
    R.applyPulledServers([item]);
    const g = gate(); const reached = gate();
    vbrHandler = veeamFake({ override: async (u) => { if (u.pathname === '/api/v1/jobs' && u.hostname === 'vbr-g2c-old.corp') { reached.open(); await g.wait(); } return null; } });
    const run = poller.pollVeeamOnce({ manual: true, ids: ['vbr-g2c'] });
    await reached.wait();
    R.applyPulledServers([{ ...item, host: 'vbr-g2c-new.corp' }]);
    g.open();
    const r = await run;
    assert.equal(ST.getRecord('vbr-g2c'), null, '옛 접속처 결과를 기록하지 않는다'); assert.equal(r.discarded, 1);
  } finally { console.warn = warn; vbrHandler = null; resetAgent(); clearRegistry(); ST._resetForTest(); }
});

/* ═══════════════ F4b ═══════════════ */
test('F4b: 등록부를 못 읽으면 중앙 주기 수집이 저장된 Veeam 결과를 지우지 않는다', async () => {
  clearRegistry(); resetAgent(); ST._resetForTest(); poller._resetForTest();
  const warn = console.warn; console.warn = () => {}; const err = console.error; console.error = () => {};
  try {
    const d = R.saveServer({ name: 'F4', host: 'vbr-f4.corp', username: 'svc', password: 'pw', vcenterIds: [VC] });
    ST.putResult(d.id, okResult());
    fs.writeFileSync(path.join(DIR, 'veeam-servers.json'), '{"version":1,"servers":[{"id":');
    R._resetForTest();
    assert.ok(R.registryLoadError(), '등록부 읽기 오류 상태');
    const r = await poller.pollVeeamOnce();
    assert.equal(r.servers, 0);
    assert.ok(ST.getRecord(d.id), '못 읽은 등록부(빈 목록)로 결과를 지우지 않는다');
    // 정상 등록부에서는 등록부에 없는 서버의 결과를 지운다(유령 배지 방지 — 그대로)
    for (const f of fs.readdirSync(DIR)) if (f.startsWith('veeam-servers.json')) fs.rmSync(path.join(DIR, f));
    R._resetForTest();
    await poller.pollVeeamOnce();
    assert.equal(ST.getRecord(d.id), null);
  } finally { console.warn = warn; console.error = err; R._resetForTest(); ST._resetForTest(); }
});

/* ═══════════════ F-I2 ═══════════════ */
test('F-I2: 엣지가 보낸 수집 주기는 [2분, MAX_TIMER_MS] 만 받는다(밖이면 null — 중앙 주기로 판정)', () => {
  E._resetForTest();
  const iv = (v) => { E.saveVeeamEdgeStatus('edge-iv', { poller: { intervalMs: v } }); return E.veeamEdgeStatus('edge-iv').status.poller.intervalMs; };
  assert.equal(iv(1), null); assert.equal(iv(119_999), null); assert.equal(iv(1e15), null); assert.equal(iv(MAX_TIMER_MS + 1), null); assert.equal(iv('600000'), null);
  assert.equal(iv(120_000), 120_000); assert.equal(iv(600_000), 600_000); assert.equal(iv(MAX_TIMER_MS), MAX_TIMER_MS);
  E._resetForTest();
});

/* ═══════════════ G3 ═══════════════ */
test('G3: 관리 GET 의 readsHere — 엣지는 받은 자기 몫(꺼진 것 포함)이 true · 중앙의 엣지 담당은 false · 화면은 그것으로 버튼을 연다', async () => {
  clearRegistry(); resetAgent();
  const { store } = await import('../src/store.js');
  const prevSnap = store.snapshot;
  store.snapshot = { source: 'live', vcenters: [{ id: VC, name: 'vc01' }], vms: [], hosts: [] };
  try {
    const c1 = R.saveServer({ name: 'Direct', host: 'vbr-g3d.corp', username: 'svc', password: 'pw', vcenterIds: [VC] });
    const c2 = R.saveServer({ name: 'EdgeOwned', host: 'vbr-g3e.corp', username: 'svc', password: 'pw', vcenterIds: [VC], agent: 'edge-g3' });
    const a = await adminGet();
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const by = new Map(a.body.servers.map((s) => [s.id, s]));
    assert.equal(by.get(c1.id).readsHere, true); assert.equal(by.get(c2.id).readsHere, false);
    clearRegistry();
    config.agent.centralUrl = 'http://127.0.0.1:9'; config.agent.name = 'edge-g3';
    R.applyPulledServers([
      { id: 'vbr-g3a', name: 'Mine', host: 'vbr-g3a.corp', port: 9419, username: 'svc', password: 'pw', agent: 'edge-g3', vcenterIds: [VC] },
      { id: 'vbr-g3b', name: 'MineOff', host: 'vbr-g3b.corp', port: 9419, username: 'svc', password: 'pw', agent: 'edge-g3', vcenterIds: [VC], enabled: false },
    ]);
    const b = await adminGet();
    const byE = new Map(b.body.servers.map((s) => [s.id, s]));
    assert.equal(byE.get('vbr-g3a').readsHere, true, '엣지가 받은 자기 몫(agent = 엣지 이름)');
    assert.equal(byE.get('vbr-g3b').readsHere, true, '꺼진 자기 몫도 이 노드가 읽는 서버');
    // 꺼진 자기 몫의 지금 읽기는 엣지 거절이 아니라 disabled 로 답한다
    const col = await adminPost('/vbr-g3b/collect');
    assert.equal(col.body.edge, undefined, JSON.stringify(col.body)); assert.equal(col.body.disabled, true);
  } finally { resetAgent(); clearRegistry(); store.snapshot = prevSnap; }
  // 화면: 버튼 조건이 readsHere 를 본다 · 각주·거절 문구가 엣지 포탈의 같은 화면을 가리킨다
  const web = stripComments(fs.readFileSync(new URL('../../web/src/views/VeeamSettings.jsx', import.meta.url), 'utf8'));
  // v2.763(V5-1): 행 버튼은 rowActions(순수 — 웹 테스트가 동작을 본다)로 옮겼다 — 두 버튼이 같은 readsHere 조건 블록 안에 있다.
  assert.match(web, /if \(!s\.agent \|\| s\.readsHere\) \{\s*out\.push\(\{ kind: 'test'[\s\S]{0,400}?out\.push\(\{ kind: 'collect'/, '연결 시험·지금 읽기 둘 다');
  assert.ok(!/\{!s\.agent && <><button/.test(web), '옛 조건(!s.agent 만)이 남지 않는다');
  assert.match(web, /그 엣지 포탈의 이 화면\(설정 › Veeam 백업 서버\)/);
  const route = fs.readFileSync(new URL('../src/routes/admin/veeam.js', import.meta.url), 'utf8');
  assert.match(route, /엣지 포탈의 설정 › Veeam 백업 서버에서/);
});

/* ═══════════════ G-I1 ═══════════════ */
test('G-I1: 판 올림 키는 경로 틀 — 백업마다 400→재요청·판 올림 notes 가 쌓이지 않는다', async () => {
  assert.equal(C.pathTemplate('/api/v1/backups/abc-1/backupFiles'), '/api/v1/backups/{id}/backupFiles');
  assert.equal(C.pathTemplate('/api/v1/sessions/x/taskSessions'), '/api/v1/sessions/{id}/taskSessions');
  assert.equal(C.pathTemplate('/api/v1/jobs/states'), '/api/v1/jobs/states');
  assert.equal(C.pathTemplate('/api/v1/restorePoints'), '/api/v1/restorePoints');
  const backups = { data: Array.from({ length: 30 }, (_, i) => ({ id: `b${i}`, name: `B${i}`, jobId: 'j1' })) };
  const good = { data: [{ backupSize: 100, dataSize: 200, creationTime: '2026-10-22T00:00:00Z' }] };
  const log = [];
  const files = (_id, init) => (init.headers?.['x-api-version'] === '1.1-rev0'
    ? json({ message: 'Unsupported RESTAPI version. The following versions are supported: v1.0-rev1, v1.1-rev0, v1.2-rev0' }, 400) : good);
  const r = await C.collectVeeamServer(SRV, { fetchImpl: veeamFake({ backups, files, log }) });
  const req = log.filter((x) => x.path.endsWith('/backupFiles')).length;
  assert.ok(req <= 30 + 4, `backupFiles 요청 ${req}회(백업 30 + 병렬 첫 묶음 4 이하)`);
  const bump = r.notes.filter((n) => /지원 판/.test(n));
  assert.equal(bump.length, 1, r.notes.join(' | ')); assert.match(bump[0], /\/api\/v1\/backups\/\{id\}\/backupFiles/);
  assert.equal(r.backups.filter((b) => b.bs != null).length, 30, '병렬 첫 묶음도 올린 판으로 다시 읽어 용량을 채운다');
});

/* ═══════════════ G-I2 ═══════════════ */
test('G-I2: 실행 중 세션의 task 조회는 4병렬(상한 20 · 넘는 것은 skipped) · 401 은 전체 실패', async () => {
  const sessions = { data: Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, jobId: 'j1', state: 'Working', sessionType: 'BackupJob' })) };
  let inFlight = 0; let peak = 0; const seen = [];
  const tasks = async (id) => { inFlight++; peak = Math.max(peak, inFlight); seen.push(id); await new Promise((r) => setTimeout(r, 20)); inFlight--; return { data: [] }; };
  const r = await C.collectVeeamServer(SRV, { fetchImpl: veeamFake({ sessions, tasks }) });
  assert.equal(r.ok, true);
  assert.equal(peak, 4, `동시 ${peak}`);
  assert.equal(seen.length, 20, '상한 20건만 묻는다');
  assert.ok(r.notes.some((n) => /실행 중 세션 25개 중 20개만/.test(n)));
  await assert.rejects(C.collectVeeamServer(SRV, { fetchImpl: veeamFake({ sessions, tasks: (id) => (id === 's3' ? new Response('', { status: 401 }) : { data: [] }) }) }), (e) => e.kind === 'token');
});

/* ═══════════════ G-I3 ═══════════════ */
test('G-I3: 백업 파일 목록의 404·400 밖 실패(500·전송 오류)도 건수·상태 코드만 notes 1줄(원문·주소 없음)', async () => {
  const backups = { data: Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, name: `B${i}`, jobId: 'j1' })) };
  const files = (id) => { if (id === 'b4') throw new TypeError('fetch failed'); return json({ message: 'internal at vbr-t.corp.local:9419' }, 500); };
  const r = await C.collectVeeamServer(SRV, { fetchImpl: veeamFake({ backups, files }) });
  assert.equal(r.ok, true);
  const n = r.notes.filter((x) => /파일 목록 조회가 실패해/.test(x));
  assert.equal(n.length, 1, r.notes.join(' | '));
  assert.match(n[0], /백업 5개는 파일 목록 조회가 실패해\(HTTP 500 4건 · 전송 오류·시한 1건\)/);
  assert.ok(!/vbr-t|9419|internal/.test(n[0]), '원문·주소를 싣지 않는다');
});
