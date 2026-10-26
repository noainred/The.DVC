/**
 * test/veeam2763b.test.js — v2.763 Veeam 수집·엣지 계약 점검 확정분 회귀(수정 그룹 B).
 *
 *  · V2-2(=V3-2=V5-6) 엣지 시계: push 본문 sentAt → 중앙이 offset(수신 − sentAt)으로 ts·authStop.since·poller.at 을 옮긴다(원본 edgeTs) ·
 *       보정 뒤 미래 자르기 · |offset|>30일·sentAt 없음(옛 엣지)은 예전 그대로 · 재전송(옛 결과 반복)은 계속 오래됨.
 *  · V2-3 공유 토큰 403 의 거부 사유는 '개별 토큰 필요'(토큰 불일치 아님) · 데이터 흐름 지도에서 veeam 은 'inv' 가 아닌 'backup' 칸.
 *  · V3-1 대기열 차례에 등록부·enabled·이 노드 몫을 다시 본다(삭제·끄기·담당 변경된 서버는 로그인하지 않는다).
 *  · V1-6 '판 미지원' 은 늦게 오는 성공을 기다린 뒤 · V1-7 taskSessions 도 total 까지(잘리면 작업 단위) · V1-I2 total 없으면 jobs null.
 *  · V1-I1 비밀번호 없는 서버는 접속하지 않는다(kind 'no-password' · 정지 기록 없음).
 *  · V2-I1 pull 의 손상 등록부 복구 기록(pullRecoveryNote) · push 는 등록부를 못 읽으면 보내지 않는다.
 *  · V3-I1 성공 기록의 lastOk 는 파일에 싣지 않는다(로드 때 result 에서 다시 만든다 · 승계 갈래 그대로).
 *
 * 시각: 순수 함수는 NOW(정시 경계)로 고정한다. 라우트(배지 '오래됨')는 실제 Date.now() 로 판정하므로 그 경로만 실제 시각 기준 상대값을 쓴다.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'veeam2763b-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.CENTRAL_TOKEN = 'ctok-2763b';
delete process.env.CENTRAL_URL;
const closers = [];

// Veeam(https://vbr…) 요청만 가짜로 받는다.
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
const { config } = await import('../src/config.js');
const { store } = await import('../src/store.js');
const KEEP_AGENT = { ...config.agent };
const resetAgent = () => { Object.assign(config.agent, KEEP_AGENT); config.agent.centralUrl = ''; config.agent.centralToken = ''; config.agent.name = ''; };
const clearRegistry = () => { for (const d of R.listServers()) R.deleteServer(d.id); };
const quiet = async (fn) => { const w = console.warn; const l = console.log; console.warn = () => {}; console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; } };

const HOUR = 3_600_000; const MIN = 60_000; const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;
const VC = 'pl:vc01';
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ═══════════════ 실제 라우터(중앙 수신 + 배지) ═══════════════ */
let base = '';
const seenBodies = [];
before(async () => {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const { registerVeeamBadges } = await import('../src/routes/api/veeam.js');
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  // 엣지 push 본문을 엿본다(gzip 은 express.json 이 푼다) — sentAt 이 실제로 실리는지.
  app.use('/api/central/veeam-data', (req, _res, next) => { seenBodies.push(req.body); next(); });
  app.use('/api/central', centralRouter);
  const api = express.Router();
  app.use('/api', (req, _res, next) => { req.user = { username: 'adm', role: 'admin' }; next(); }, api);
  registerVeeamBadges(api);
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  closers.push(() => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(() => ok()); }));
  base = `http://127.0.0.1:${srv.address().port}`;
});
const badges = async () => (await realFetch(`${base}/api/veeam/badges?vcenterId=${encodeURIComponent(VC)}`)).json();

/* ═══════════════ V2-2 엣지 시계 ═══════════════ */
test('V2-2 순수 — edgeClockOffset: sentAt 없음·수 아님·30일 초과는 0 · 정제는 ts·authStop.since 를 옮기고 원본 edgeTs · 보정 뒤 미래는 now', () => {
  assert.equal(typeof E.edgeClockOffset, 'function', 'edgeClockOffset export');
  assert.equal(E.edgeClockOffset({}, NOW), 0, '옛 엣지(sentAt 없음)');
  assert.equal(E.edgeClockOffset({ sentAt: null }, NOW), 0);
  assert.equal(E.edgeClockOffset({ sentAt: '' }, NOW), 0, "'' 는 0 시각이 아니다(Number('')===0 함정)");
  assert.equal(E.edgeClockOffset({ sentAt: 'abc' }, NOW), 0);
  assert.equal(E.edgeClockOffset({ sentAt: [NOW] }, NOW), 0);
  assert.equal(E.edgeClockOffset({ sentAt: NOW - 40 * MIN }, NOW), 40 * MIN, '엣지 40분 늦음');
  assert.equal(E.edgeClockOffset({ sentAt: NOW + 2 * HOUR }, NOW), -2 * HOUR, '엣지 2시간 앞섬');
  assert.equal(E.edgeClockOffset({ sentAt: NOW - 31 * DAY }, NOW), 0, '30일 초과는 보정하지 않는다');
  assert.equal(E.edgeClockOffset({ sentAt: NOW + 31 * DAY }, NOW), 0);
  // 정제
  const r = P.sanitizeServerResult({ ok: false, ts: NOW - 41 * MIN, authStop: { since: NOW - 50 * MIN, attempts: 1, reason: 'x' } }, NOW, { clockOffsetMs: 40 * MIN });
  assert.equal(r.ts, NOW - MIN, 'ts 를 중앙 시계로');
  assert.equal(r.edgeTs, NOW - 41 * MIN, '원본은 edgeTs');
  assert.equal(r.authStop.since, NOW - 10 * MIN, 'authStop.since 도 같은 시계');
  // 보정 뒤에도 미래(수집 시각이 송신 시각보다 뒤 — 엣지 시계가 그 사이 뒤로 감)면 now
  const f = P.sanitizeServerResult({ ok: true, ts: NOW + 3 * MIN }, NOW, { clockOffsetMs: 1 * MIN });
  assert.equal(f.ts, NOW, '보정 뒤 미래는 now 로 자른다(5분 여유 없이)');
  // 보정 없음(옛 엣지) — 예전 그대로: 과거는 그대로 · 5분 넘는 미래만 자른다
  const o = P.sanitizeServerResult({ ok: true, ts: NOW - 40 * MIN }, NOW);
  assert.equal(o.ts, NOW - 40 * MIN); assert.equal(o.edgeTs, undefined);
  const o2 = P.sanitizeServerResult({ ok: true, ts: NOW + 3 * MIN }, NOW);
  assert.equal(o2.ts, NOW + 3 * MIN, '보정 없음이면 5분 안의 미래는 그대로(예전 동작)');
});

test('V2-2 실제 중앙 veeam-data + 배지 — 엣지 시계 40분 늦음: 방금 결과는 오래됨이 아니다 · 재전송은 오래됨 · 앞선 시계 재전송도 오래됨 · 옛 엣지·30일 초과는 예전 그대로', async () => {
  clearRegistry(); resetAgent(); ST._resetForTest(); E._resetForTest();
  const prevSnap = store.snapshot;
  store.snapshot = { source: 'live', generatedAt: Date.now(), vcenters: [{ id: VC, name: 'vc01' }], vms: [{ id: `${VC}:vm-1`, vcenterId: VC, name: 'web01' }], hosts: [] };
  try {
    const { issueAgentToken } = await import('../src/central/agentTokens.js');
    const tok = issueAgentToken('edge-clk').token;
    const d = R.saveServer({ name: 'VBR-PL', host: 'vbr-pl.corp.local', username: 'svc', password: 'pw', vcenterIds: [VC], agent: 'edge-clk' });
    const target = R.accessFingerprint(R.getServerWithSecret(d.id));
    const res = (ts, extra = {}) => ({ serverId: d.id, ok: true, ts, target, jobs: [{ id: 'j1', name: 'BJ', type: 'Backup', running: true }],
      vms: [{ n: 'web01', m: 'vm-1', h: 'vc01.corp.local', j: [0], rp: 3, run: 1, pg: 40, by: 'task' }], counts: {}, notes: [], ...extra });
    const push = async (body) => {
      const r = await realFetch(`${base}/api/central/veeam-data?agent=edge-clk`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': tok, 'X-Agent-Name': 'edge-clk' }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    const status = (at) => ({ servers: 1, poller: { at, ok: 1, fail: 0, intervalMs: 600_000, running: false } });

    // ① 엣지 시계 40분 늦음 — 방금 수집·송신
    const lag = 40 * MIN;
    let edgeNow = Date.now() - lag;
    let p = await push({ agent: 'edge-clk', sentAt: edgeNow, status: status(edgeNow), results: [res(edgeNow - 1000)] });
    assert.equal(p.status, 200, JSON.stringify(p.body)); assert.equal(p.body.saved, 1);
    let rec = ST.getRecord(d.id);
    assert.ok(Math.abs(rec.result.ts - (Date.now() - 1000)) < 10_000, `ts 를 중앙 시계로 옮긴다(차 ${Math.round((Date.now() - rec.result.ts) / MIN)}분)`);
    assert.equal(rec.result.edgeTs, edgeNow - 1000, '원본 엣지 시각은 edgeTs');
    assert.ok(rec.lastOk.ts === rec.result.ts, 'lastOk.ts 도 같은 시계(putResult 가 result.ts 에서)');
    const st = E.veeamEdgeStatus('edge-clk');
    assert.ok(Math.abs(st.status.poller.at - Date.now()) < 10_000, 'poller.at 도 중앙 시계로');
    assert.ok(Math.abs(st.clockOffsetMs - lag) < 10_000, `clockOffsetMs 를 싣는다(${st.clockOffsetMs})`);
    let b = await badges();
    assert.equal(b.servers[0].stale, false, '방금 받은 결과는 오래됨이 아니다');
    assert.equal(b.runningStale, false);
    assert.equal(b.byVm[`${VC}:vm-1`]?.run, 1, '백업 중 표시가 남는다');

    // ② 재전송 — 엣지 폴러가 멈추고 push 만 30분 뒤(엣지 시계) 같은 옛 결과를 보낸다 → 엣지 시계로 잰 나이(30분)가 남아 오래됨
    edgeNow = Date.now() - lag + 30 * MIN;
    p = await push({ agent: 'edge-clk', sentAt: edgeNow, status: status(edgeNow - 30 * MIN), results: [res(edgeNow - 30 * MIN)] });
    assert.equal(p.body.saved, 1);
    rec = ST.getRecord(d.id);
    assert.ok(Math.abs((Date.now() - rec.result.ts) - 30 * MIN) < 10_000, '재전송 결과의 나이는 30분');
    b = await badges();
    assert.equal(b.servers[0].stale, true, '재전송(옛 결과 반복)은 계속 오래됨');
    assert.equal(b.runningStale, true);

    // ③ 엣지 시계 2시간 앞섬 + 30분 된 결과 재전송 — 예전에는 미래 자르기로 ts=now 가 되어 오래됨이 가려졌다(보정 → 그 뒤 자르기)
    edgeNow = Date.now() + 2 * HOUR;
    p = await push({ agent: 'edge-clk', sentAt: edgeNow, status: status(edgeNow - 30 * MIN), results: [res(edgeNow - 30 * MIN)] });
    rec = ST.getRecord(d.id);
    assert.ok(Math.abs((Date.now() - rec.result.ts) - 30 * MIN) < 10_000, `앞선 시계에서도 나이 30분(${Math.round((Date.now() - rec.result.ts) / MIN)}분)`);
    assert.equal(rec.result.edgeTs, edgeNow - 30 * MIN);
    assert.equal((await badges()).servers[0].stale, true);
    // 같은 엣지가 방금 수집한 결과(앞선 시계)는 오래됨이 아니고 미래도 아니다
    edgeNow = Date.now() + 2 * HOUR;
    await push({ agent: 'edge-clk', sentAt: edgeNow, status: status(edgeNow), results: [res(edgeNow - 1000)] });
    rec = ST.getRecord(d.id);
    assert.ok(rec.result.ts <= Date.now() && Date.now() - rec.result.ts < 10_000);
    assert.equal((await badges()).servers[0].stale, false);

    // ④ 옛 엣지(sentAt 없음) — 예전 그대로(엣지 시각을 그대로 쓴다)
    const old = Date.now() - lag;
    await push({ agent: 'edge-clk', status: status(old), results: [res(old)] });
    rec = ST.getRecord(d.id);
    assert.equal(rec.result.ts, old, '옛 엣지는 보정하지 않는다'); assert.equal(rec.result.edgeTs, undefined);
    assert.equal(E.veeamEdgeStatus('edge-clk').status.poller.at, old);
    assert.equal(E.veeamEdgeStatus('edge-clk').clockOffsetMs, undefined);
    // ⑤ |offset| 30일 초과 — 시계가 아니라 값이 틀린 것: 보정하지 않는다
    const far = Date.now() - 40 * DAY;
    await push({ agent: 'edge-clk', sentAt: far, status: status(far), results: [res(far)] });
    assert.equal(ST.getRecord(d.id).result.ts, far, '30일 넘는 차이는 보정하지 않는다');
    // ⑥ 결과 0건 갈래도 poller.at 을 옮긴다
    edgeNow = Date.now() - lag;
    p = await push({ agent: 'edge-clk', sentAt: edgeNow, status: { servers: 0, poller: { at: edgeNow, intervalMs: 600_000 } }, results: [] });
    assert.equal(p.status, 200);
    assert.ok(Math.abs(E.veeamEdgeStatus('edge-clk').status.poller.at - Date.now()) < 10_000, '결과 0건 push 의 poller.at 도 중앙 시계로');
  } finally { store.snapshot = prevSnap; clearRegistry(); ST._resetForTest(); E._resetForTest(); }
});

test('V2-2 실제 pushVeeamNow — 본문 최상위에 sentAt 을 싣는다 · 멈춘 엣지의 옛 결과 재전송은 중앙에서 오래됨으로 남는다', async () => {
  clearRegistry(); resetAgent(); ST._resetForTest(); E._resetForTest();
  const prevSnap = store.snapshot;
  store.snapshot = { source: 'live', generatedAt: Date.now(), vcenters: [{ id: VC, name: 'vc01' }], vms: [{ id: `${VC}:vm-1`, vcenterId: VC, name: 'web01' }], hosts: [] };
  try {
    await quiet(async () => {
      const { issueAgentToken } = await import('../src/central/agentTokens.js');
      const tok = issueAgentToken('edge-pv').token;
      const d = R.saveServer({ name: 'VBR-PV', host: 'vbr-pv.corp.local', username: 'svc', password: 'pw', vcenterIds: [VC], agent: 'edge-pv' });
      config.agent.centralUrl = base; config.agent.centralToken = tok; config.agent.name = 'edge-pv';
      // 엣지 폴러가 30분 전에 마지막으로 읽은 결과(그 뒤 멈춤)
      const t0 = Date.now() - 30 * MIN;
      ST.putResult(d.id, { ok: true, ts: t0, target: R.accessFingerprint(R.getServerWithSecret(d.id)), jobs: [{ id: 'j1', name: 'BJ', type: 'Backup', running: true }], vms: [{ n: 'web01', m: 'vm-1', h: '', j: [0], rp: 1, run: 1, pg: 5, by: 'task' }], counts: {}, notes: [] });
      const push = await import('../src/veeam/push.js');
      push._resetForTest();
      seenBodies.length = 0;
      const before = Date.now();
      const r = await push.pushVeeamNow();
      assert.equal(r.ok, true, r.reason);
      const sent = seenBodies.at(-1);
      assert.ok(Number.isFinite(sent?.sentAt) && sent.sentAt >= before && sent.sentAt <= Date.now(), `sentAt 을 싣는다(${sent?.sentAt})`);
      const rec = ST.getRecord(d.id);
      assert.equal(rec.via, 'edge');
      assert.ok(Math.abs((Date.now() - rec.result.ts) - 30 * MIN) < 10_000, '재전송된 옛 결과의 나이가 그대로 남는다');
    });
  } finally { store.snapshot = prevSnap; resetAgent(); clearRegistry(); ST._resetForTest(); E._resetForTest(); }
});

/* ═══════════════ V2-3 ═══════════════ */
test('V2-3 — 공유 토큰 403 은 그대로(agentTokenRequired) · 거부 사유는 개별 토큰 필요 · 데이터 흐름 지도에서 veeam 은 인벤토리 칸이 아니다', async () => {
  const { rejectStats } = await import('../src/central/ingestReject.js');
  const r = await realFetch(`${base}/api/central/veeam-data?agent=edge-shared`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': 'ctok-2763b', 'X-Agent-Name': 'edge-shared' }, body: JSON.stringify({ agent: 'edge-shared', results: [] }) });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).agentTokenRequired, true, 'v2.751 검토 #5 의도 유지');
  const g = await realFetch(`${base}/api/central/veeam-config?agent=edge-shared`, { headers: { 'X-Central-Token': 'ctok-2763b', 'X-Agent-Name': 'edge-shared' } });
  assert.equal(g.status, 403);
  await sleep(20); // finish 이벤트
  const row = rejectStats().recent.find((x) => x.endpoint === '/veeam-data' && x.agent === 'edge-shared');
  assert.ok(row, JSON.stringify(rejectStats().recent.slice(0, 3)));
  assert.match(row.reason, /개별 토큰 필요/, '토큰 불일치가 아니라 개별 토큰 필요');
  assert.doesNotMatch(row.reason, /토큰 불일치/);
  assert.equal(row.kind, 'auth');
  const { catOf, CATS } = await import('../src/dataflow/build.js');
  for (const [m, p] of [['GET', '/veeam-config'], ['POST', '/veeam-data']]) {
    const c = catOf('central', p);
    assert.notEqual(c, 'inv', `${m} ${p} 는 인벤토리(vCenter) 칸이 아니다`);
    assert.equal(c, 'backup');
  }
  assert.equal(catOf('central', '/inventory'), 'inv', '인벤토리는 그대로');
  assert.ok(CATS.find((x) => x.id === 'backup')?.label.includes('Veeam'));
});

/* ═══════════════ V3-1 ═══════════════ */
test('V3-1 — 대기열에서 차례가 왔을 때 삭제·수집 끄기·담당 변경된 서버는 로그인하지 않고 결과·정지 기록을 남기지 않는다', async () => {
  clearRegistry(); resetAgent(); ST._resetForTest(); poller._resetForTest();
  const prevC = process.env.VEEAM_CONCURRENCY; process.env.VEEAM_CONCURRENCY = '1';
  try {
    await quiet(async () => {
      let releaseA; const gateA = new Promise((r) => { releaseA = r; });
      let reachedA; const atA = new Promise((r) => { reachedA = r; });
      const logins = [];
      vbrHandler = async (url, init) => {
        const u = new URL(url);
        if (u.pathname === '/api/oauth2/token') {
          logins.push(u.hostname);
          if (u.hostname === 'vbr-qa.corp') { reachedA(); await gateA; return json({ access_token: 'T' }); }
          return json({ error: 'invalid_grant' }, 401);
        }
        if (u.pathname === '/api/oauth2/logout') return json({});
        return json({ data: [] });
      };
      const a = R.saveServer({ name: 'QA', host: 'vbr-qa.corp', username: 'svc', password: 'pw-a', vcenterIds: [VC] });
      const b = R.saveServer({ name: 'QB', host: 'vbr-qb.corp', username: 'svc', password: 'pw-b', vcenterIds: [VC] });
      const c = R.saveServer({ name: 'QC', host: 'vbr-qc.corp', username: 'svc', password: 'pw-c', vcenterIds: [VC] });
      const e = R.saveServer({ name: 'QE', host: 'vbr-qe.corp', username: 'svc', password: 'pw-e', vcenterIds: [VC] });
      const run = poller.pollVeeamOnce();
      await atA;
      // A 가 도는 동안: B 삭제(관리 라우트 순서) · C 수집 끄기 · E 를 엣지 담당으로
      R.deleteServer(b.id); ST.dropResult(b.id); poller.authGuard.clearAuthStop(b.id);
      R.saveServer({ id: c.id, name: 'QC', host: 'vbr-qc.corp', username: 'svc', vcenterIds: [VC], enabled: false });
      R.saveServer({ id: e.id, name: 'QE', host: 'vbr-qe.corp', username: 'svc', vcenterIds: [VC], agent: 'edge-x' });
      releaseA();
      const r = await run;
      assert.deepEqual(logins, ['vbr-qa.corp'], `A 만 로그인한다: ${logins.join(',')}`);
      assert.equal(r.ok, 1); assert.equal(r.fail, 0); assert.equal(r.gone, 3, JSON.stringify(r));
      for (const x of [b, c, e]) {
        assert.equal(ST.getRecord(x.id), null, `${x.name} 결과가 생기지 않는다`);
        assert.equal(poller.authGuard.peekAuthStop({ ...x, password: 'pw' }), null, `${x.name} 정지 기록 없음`);
      }
      const stopsFile = path.join(DIR, 'veeam-auth-stops.json');
      const stops = fs.existsSync(stopsFile) ? JSON.parse(fs.readFileSync(stopsFile, 'utf8')) : {};
      assert.ok(![b.id, c.id, e.id].some((id) => JSON.stringify(stops).includes(id)), '정지 파일에 유령 기록이 없다');
      assert.ok(ST.getRecord(a.id)?.result?.ok, 'A 는 그대로 기록');
    });
  } finally {
    if (prevC == null) delete process.env.VEEAM_CONCURRENCY; else process.env.VEEAM_CONCURRENCY = prevC;
    vbrHandler = null; clearRegistry(); ST._resetForTest();
  }
});

/* ═══════════════ V1-I1 ═══════════════ */
test('V1-I1 — 비밀번호가 없는 서버(접속처 변경으로 폐기 · 배정에 없음)는 접속하지 않는다: kind no-password · 정지 기록 없음(주기·수동·엣지 pull)', async () => {
  clearRegistry(); resetAgent(); ST._resetForTest(); poller._resetForTest();
  try {
    await quiet(async () => {
      const logins = [];
      vbrHandler = async (url, init) => {
        const u = new URL(url);
        if (u.pathname === '/api/oauth2/token') { logins.push({ host: u.hostname, pwLen: (new URLSearchParams(String(init.body || '')).get('password') || '').length }); return json({ error: 'invalid_grant', error_description: 'The user name or password is incorrect' }, 400); }
        return json({});
      };
      const d = R.saveServer({ name: 'NP', host: 'vbr-np.corp', username: 'CORP\\old', password: 'pw', vcenterIds: [VC] });
      const s = R.saveServer({ id: d.id, name: 'NP', host: 'vbr-np.corp', username: 'CORP\\new', vcenterIds: [VC] });
      assert.deepEqual(s.droppedSecrets, ['password'], '전제: 비밀번호 폐기');
      const r1 = await poller.pollVeeamOnce();
      assert.equal(r1.fail, 1);
      let rec = ST.getRecord(d.id);
      assert.equal(rec.result.kind, 'no-password', JSON.stringify(rec.result));
      assert.match(rec.result.error, /비밀번호/);
      assert.equal(rec.result.authStop ?? null, null);
      assert.equal(poller.authGuard.peekAuthStop(R.getServerWithSecret(d.id)), null, '정지 기록 없음');
      // 수동 '지금 읽기' 도 같다
      await poller.pollVeeamOnce({ manual: true, ids: [d.id] });
      assert.equal(ST.getRecord(d.id).result.kind, 'no-password');
      // 엣지: 중앙이 비밀번호 없이 배정을 내려보낸 경우(applyPulledServers 는 '' 로 받는다)
      config.agent.centralUrl = 'http://127.0.0.1:9'; config.agent.name = 'edge-np';
      R.applyPulledServers([{ id: 'vbr-np-edge', name: 'NPE', host: 'vbr-npe.corp', port: 9419, username: 'svc', agent: 'edge-np', vcenterIds: [VC] }]);
      await poller.pollVeeamOnce();
      rec = ST.getRecord('vbr-np-edge');
      assert.equal(rec?.result?.kind, 'no-password');
      assert.deepEqual(logins, [], `로그인 시도 자체가 없다: ${JSON.stringify(logins)}`);
      // 정제 화이트리스트가 kind 를 그대로 싣는다(엣지 → 중앙)
      assert.equal(P.sanitizeServerResult({ ...rec.result }, Date.now()).kind, 'no-password');
      // 비밀번호를 다시 넣으면 예전처럼 로그인한다
      resetAgent();
      R.saveServer({ id: d.id, name: 'NP', host: 'vbr-np.corp', username: 'CORP\\new', password: 'pw2', vcenterIds: [VC] });
      await poller.pollVeeamOnce({ ids: [d.id] });
      assert.equal(logins.length, 1); assert.equal(logins[0].pwLen, 3);
    });
  } finally { vbrHandler = null; resetAgent(); clearRegistry(); ST._resetForTest(); poller.authGuard.clearAuthStop('vbr-np-edge'); }
});

/* ═══════════════ client.js — V1-6 · V1-7 · V1-I2 ═══════════════ */
const SRV = { id: 'vbr-c', name: 'CL', host: 'vbr-c.corp.local', port: 9419, username: 'svc', password: 'Pw-2763', apiVersion: '1.2-rev0' };

test('V1-6 — 404 3건이 먼저 와도 늦게 오는 성공이 있으면 판 미지원으로 단정하지 않고 나머지를 묻는다 · 진짜 미지원은 30건을 다 묻지 않는다', async () => {
  let filesCalls = 0;
  const mk = (failAll) => async (url) => {
    const u = new URL(url);
    if (u.pathname === '/api/oauth2/token') return json({ access_token: 'T' });
    if (u.pathname === '/api/oauth2/logout') return json({});
    if (u.pathname === '/api/v1/jobs') return json({ data: [{ id: 'j1', name: 'J', type: 'Backup' }], pagination: { total: 1 } });
    if (u.pathname === '/api/v1/backups') return json({ data: Array.from({ length: 30 }, (_, i) => ({ id: `b${i}`, name: `B${i}`, jobId: 'j1' })), pagination: { total: 30 } });
    const m = /^\/api\/v1\/backups\/(b\d+)\/backupFiles$/.exec(u.pathname);
    if (m) {
      filesCalls++; const i = Number(m[1].slice(1));
      if (failAll || i < 3) { await sleep(5); return json({ message: 'Backup not found' }, 404); }
      await sleep(i === 3 ? 60 : 1); return json({ data: [{ backupSize: 1000, creationTime: new Date(NOW).toISOString() }] });
    }
    return json({ data: [], pagination: { total: 0 } });
  };
  const r = await C.collectVeeamServer(SRV, { fetchImpl: mk(false) });
  assert.equal(filesCalls, 30, '나머지 백업도 묻는다');
  assert.equal(r.backups.filter((b) => b.bs != null).length, 27);
  assert.ok(!r.notes.some((x) => /판은 백업 파일 목록/.test(x)), `판 미지원으로 단정하지 않는다: ${r.notes.join(' | ')}`);
  assert.ok(r.notes.some((x) => /백업 3개는 파일 목록을 받지 못해/.test(x)));
  filesCalls = 0;
  const u = await C.collectVeeamServer(SRV, { fetchImpl: mk(true) });
  assert.ok(filesCalls <= 7, `진짜 미지원은 첫 묶음 근처에서 멈춘다(4병렬 + 판정 전 시작분 ≤ 3 — 예전과 같다: ${filesCalls}건 / 30)`);
  assert.ok(u.notes.some((x) => /판은 백업 파일 목록/.test(x)));
});

test('V1-7 — 실행 중·끝난 세션의 task 를 total 까지 읽는다(VM 800대 작업) · 상한에서 잘리면 작업 단위 표시 + notes(running 을 확정 0 으로 내지 않는다)', async () => {
  const mk = (N, inc) => async (url) => {
    const u = new URL(url);
    if (u.pathname === '/api/oauth2/token') return json({ access_token: 'T' });
    if (u.pathname === '/api/oauth2/logout') return json({});
    if (u.pathname === '/api/v1/jobs') return json({ data: [{ id: 'j1', name: 'BIG', type: 'Backup', virtualMachines: { includes: inc } }], pagination: { total: 1 } });
    if (u.pathname === '/api/v1/jobs/states') return json({ data: [{ id: 'j1', status: 'Running' }], pagination: { total: 1 } });
    if (u.pathname === '/api/v1/sessions') {
      const working = u.searchParams.get('stateFilter') === 'Working';
      return json({ data: [working ? { id: 'run1', jobId: 'j1', state: 'Working', sessionType: 'BackupJob' } : { id: 'end1', jobId: 'j1', state: 'Stopped', sessionType: 'BackupJob', endTime: new Date(NOW - HOUR).toISOString() }], pagination: { total: 1 } });
    }
    const m = /^\/api\/v1\/sessions\/(\w+)\/taskSessions$/.exec(u.pathname);
    if (m) {
      const lim = Math.min(500, Number(u.searchParams.get('limit') || 500)); const skip = Number(u.searchParams.get('skip') || 0);
      const data = [];
      for (let i = skip; i < Math.min(N, skip + lim); i++) data.push(m[1] === 'run1' ? { name: `vm${i}`, objectId: `vm-${i}`, state: i < 790 ? 'Pending' : 'Working' } : { name: `vm${i}`, objectId: `vm-${i}`, state: 'Stopped', result: { result: 'Success' }, endTime: new Date(NOW - HOUR).toISOString() });
      return json({ data, pagination: { total: N, count: data.length, skip, limit: lim } });
    }
    return json({ data: [], pagination: { total: 0 } });
  };
  const N = 800;
  const inc = Array.from({ length: N }, (_, i) => ({ inventoryObject: { type: 'VirtualMachine', hostName: 'vc01.corp', name: `vm${i}`, objectId: `vm-${i}` } }));
  const r = await C.collectVeeamServer(SRV, { fetchImpl: mk(N, inc) });
  const vm = (i) => r.vms.find((v) => v.m === `vm-${i}`);
  assert.equal(vm(795).run, 1, '501번째 이후의 실제 Working VM 도 백업 중');
  assert.equal(r.counts.running, 10); assert.equal(r.counts.pending, 790);
  assert.equal(r.vms.filter((v) => v.lt).length, N, '끝난 세션 결과도 800대 전부');
  // 상한(10쪽 = 5,000)에서 잘림 — 작업에 포함된 VM 3대
  const big = 6000;
  const inc3 = [0, 1, 2].map((i) => ({ inventoryObject: { type: 'VirtualMachine', hostName: 'vc01.corp', name: `vm${i}`, objectId: `vm-${i}` } }));
  const t = await C.collectVeeamServer(SRV, { fetchImpl: mk(big, inc3) });
  assert.ok(t.notes.some((x) => /실행 중 세션의 task 가 5000개를 넘어/.test(x)), t.notes.join(' | '));
  assert.ok(t.notes.some((x) => /끝난 세션 1개는 task 가 5000개를 넘어/.test(x)), t.notes.join(' | '));
  assert.ok(t.counts.running >= 1, `잘린 세션의 작업 VM 은 작업 단위 '백업 중'(running ${t.counts.running})`);
  assert.equal(t.vms.find((v) => v.m === 'vm-0')?.by, 'job');
});

test('V1-I2 — 연결 시험: pagination.total 이 없으면 작업 수 모름(null) — 0 이 아니다 · 문자열 수는 수로', async () => {
  const mk = (pagination) => async (url) => {
    const u = new URL(url);
    if (u.pathname === '/api/oauth2/token') return json({ access_token: 'T' });
    if (u.pathname === '/api/oauth2/logout') return json({});
    if (u.pathname === '/api/v1/jobs') return json({ data: [{ id: 'j1' }], ...(pagination !== undefined ? { pagination } : {}) });
    return json({});
  };
  assert.equal((await C.testVeeamServer(SRV, { fetchImpl: mk(undefined) })).jobs, null, 'pagination 없음');
  assert.equal((await C.testVeeamServer(SRV, { fetchImpl: mk({ total: null }) })).jobs, null, 'total null 은 0 이 아니다');
  assert.equal((await C.testVeeamServer(SRV, { fetchImpl: mk({ total: '' }) })).jobs, null);
  assert.equal((await C.testVeeamServer(SRV, { fetchImpl: mk({ total: 7 }) })).jobs, 7);
  assert.equal((await C.testVeeamServer(SRV, { fetchImpl: mk({ total: '12' }) })).jobs, 12);
  assert.equal((await C.testVeeamServer(SRV, { fetchImpl: mk({ total: 0 }) })).jobs, 0, '진짜 0 은 0');
});

/* ═══════════════ V2-I1 ═══════════════ */
test('V2-I1 — 엣지 등록부 손상: push 는 보내지 않는다(0대 보고 없음) · pull 이 배포분으로 다시 쓰며 복구 기록(요약 — 원문 없음) · 그 뒤 push 재개', async () => {
  clearRegistry(); resetAgent(); ST._resetForTest(); poller._resetForTest();
  let pushes = 0;
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST') { pushes++; req.resume(); req.on('end', () => res.end(JSON.stringify({ ok: true, saved: 0 }))); return; }
    // 비밀번호 없이 배정 — pull 직후 백그라운드 수집이 네트워크로 나가지 않는다(V1-I1)
    res.end(JSON.stringify({ ok: true, servers: [{ id: 'vbr-ri', name: 'RI', host: 'vbr-ri.corp', port: 9419, username: 'svc', agent: 'edge-ri', vcenterIds: [VC] }] }));
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  closers.push(() => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(() => ok()); }));
  const secretish = 'SECRET-FRAGMENT-2763';
  try {
    await quiet(async () => {
      config.agent.centralUrl = `http://127.0.0.1:${srv.address().port}`; config.agent.centralToken = 'tok-ri'; config.agent.name = 'edge-ri';
      fs.writeFileSync(path.join(DIR, 'veeam-servers.json'), `{"version":1,"servers":[{"id":"x","password":"${secretish}"`);
      R._resetForTest();
      assert.ok(R.registryLoadError(), '전제: 등록부 손상');
      const push = await import('../src/veeam/push.js');
      push._resetForTest();
      const p1 = await push.pushVeeamNow();
      assert.equal(p1.ok, false);
      assert.match(p1.reason, /등록부를 읽지 못해 보내지 않았습니다/);
      assert.ok(!p1.reason.includes(secretish), '사유에 파일 원문 조각이 없다');
      assert.equal(pushes, 0, "'0대' 를 보고하지 않는다");
      const pull = await import('../src/agent/veeamConfigPull.js');
      pull._resetForTest?.();
      const pr = await pull.pullVeeamConfigNow();
      assert.equal(pr.ok, true, pr.reason);
      await (poller._runningForTest() || Promise.resolve());
      const st = pull.veeamConfigPullStatus();
      assert.ok(st.registryRecovered, JSON.stringify(st));
      assert.match(st.registryRecovered.note, /Veeam 서버 등록부/);
      assert.equal(st.registryRecovered.restored, 1);
      assert.ok(!JSON.stringify(st).includes(secretish), '상태에 원문 조각이 없다');
      assert.equal(R.registryLoadError(), null);
      const p2 = await push.pushVeeamNow();
      assert.equal(p2.ok, true, p2.reason); assert.equal(pushes, 1, '복구 뒤에는 보낸다');
    });
  } finally {
    resetAgent();
    for (const f of fs.readdirSync(DIR)) if (f.startsWith('veeam-servers.json')) fs.rmSync(path.join(DIR, f));
    R._resetForTest(); ST._resetForTest();
  }
});

/* ═══════════════ V3-I1 ═══════════════ */
test('V3-I1 — 성공 기록의 lastOk 는 파일에 싣지 않는다 · 다시 읽으면 메모리 모양은 같고 실패가 와도 승계 · 실패 기록은 lastOk 를 싣는다 · 옛 파일 호환', () => {
  ST._resetForTest();
  const ok = { ok: true, ts: NOW - HOUR, target: '0123456789abcdef', jobs: [{ id: 'j', name: 'J' }], vms: [{ n: 'web01', m: 'vm-1', h: '', j: [0], rp: 2, run: 0, pg: null, by: '' }], counts: { jobs: 1 }, notes: ['n1'], backups: [] };
  ST.putResult('s-ok', ok);
  ST.putResult('s-fail', ok); ST.putResult('s-fail', { ok: false, ts: NOW, target: '0123456789abcdef', error: 'x', kind: '', jobs: [], vms: [], counts: {}, notes: [] });
  assert.equal(typeof ST._flushForTest, 'function', '테스트 훅');
  ST._flushForTest();
  const file = JSON.parse(fs.readFileSync(path.join(DIR, 'veeam-latest.json'), 'utf8'));
  assert.equal(file.servers['s-ok'].lastOk, undefined, '성공 기록은 lastOk 를 두 번 쓰지 않는다');
  assert.equal(file.servers['s-ok'].result.vms.length, 1);
  assert.equal(file.servers['s-fail'].lastOk.vms[0].n, 'web01', '실패 기록은 마지막 성공분을 싣는다');
  // 재시작 모사
  ST._reloadForTest();
  const rec = ST.getRecord('s-ok');
  assert.deepEqual(rec.lastOk, { ts: ok.ts, jobs: ok.jobs, vms: ok.vms, counts: ok.counts, notes: ok.notes, backups: ok.backups, target: ok.target }, '메모리 모양은 예전과 같다');
  assert.equal(rec.lastOk.vms, rec.result.vms, '같은 배열을 가리킨다(두 사본 아님)');
  assert.equal(ST.usableResult(ST.getRecord('s-fail')).vms[0].n, 'web01');
  ST.putResult('s-ok', { ok: false, ts: NOW, target: '0123456789abcdef', error: 'y', kind: '', jobs: [], vms: [], counts: {}, notes: [] });
  assert.equal(ST.usableResult(ST.getRecord('s-ok')).vms[0].n, 'web01', '다시 읽은 뒤 실패가 와도 마지막 성공을 잇는다');
  // 다운그레이드·옛 판 로드 모사: lastOk 없는 성공 기록(새 파일 모양)을 옛 load 처럼 그대로 들고 실패가 오면 prev.result.ok 갈래가 잇는다
  ST._resetForTest();
  ST.putResult('s-dn', ok); delete ST.getRecord('s-dn').lastOk;
  ST.putResult('s-dn', { ok: false, ts: NOW, target: '0123456789abcdef', error: 'z', kind: '', jobs: [], vms: [], counts: {}, notes: [] });
  assert.equal(ST.getRecord('s-dn').lastOk?.vms?.[0]?.n, 'web01', '승계 갈래(v2.751 부터 같은 코드)');
  // 옛 파일(성공 기록에도 lastOk 가 있음)도 그대로 읽는다
  fs.writeFileSync(path.join(DIR, 'veeam-latest.json'), JSON.stringify({ v: 1, servers: { 's-old': { result: ok, lastOk: { ts: ok.ts, jobs: ok.jobs, vms: ok.vms, counts: ok.counts, notes: ok.notes }, via: 'local', agent: '', at: NOW } } }));
  ST._reloadForTest();
  assert.equal(ST.getRecord('s-old').lastOk.vms[0].n, 'web01');
  ST._resetForTest();
});
