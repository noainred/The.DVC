/**
 * v2.607 감사 그룹 e — 엣지 워커 회귀.
 *
 * EDGE2607-01 엣지 로그 폴백 회신이 공유 토큰 엣지에서 항상 400 이었다(본문·쿼리에 agent 없음) — **실제 centralRouter** 에 대고
 *             runEdgeLogWorkerOnce() 를 호출해 저장·ack 까지 본다(v2.605 테스트는 라우트를 워커가 보내지 않는 모양으로 직접 불렀다).
 * EDGE2607-02 ip-scan-result 의 capped·dropped 와 part-faults 의 rejected 를 엣지가 상태·콘솔에 남긴다.
 * EDGE2607-03 GPU 게스트 push 보류 문구의 vCenter 개수·이름 + 보류 로그 조절.
 * LEFT2607-09 curuser push 청크 실패 시 한 번 전체 재전송 + '중앙 목록 부분 상태' 명시.
 * RECENT2607-02 curuser slimRecord 가 truncated(하한) 표지를 싣는다.
 * RECENT2607-04 원격 전력 키의 persisted 는 키 선택에만 — hostConflicts·경고는 현재 실제 충돌일 때만.
 * RECENT2607-05 RMA 인스턴스 상한 거절(403 refused)은 '연결됨' — 연락 시각을 갱신한다(무연결 명령 오발 방지).
 * 엣지 쪽 워커는 전부 목 HTTP 중앙으로 **실제 호출**한다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2607e-'));
Object.assign(process.env, {
  CONFIG_DIR: CFG, CENTRAL_TOKEN: 'shared-2607e', AGENT_NAME: 'site-b', DATA_SOURCE: 'live', AUTH_ENABLED: 'true',
  IPAM_WRITE_WORKER: '0', SSRF_ALLOW_LOOPBACK: 'true', IPSCAN_WORKER: 'false', IPSCAN_USE_WORKER: 'false',
  PARTFAULT_ENABLED: 'true', AGENT_CURUSER_CHUNK_BYTES: '100000',
});
fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: [] }));
fs.writeFileSync(path.join(CFG, 'collectors.json'), JSON.stringify({ collectors: [{ id: 'site-b', name: 'site-b', url: 'http://127.0.0.1:1', token: 'x', enabled: true }] }));

// ── 목 중앙: 경로별 응답을 바꿀 수 있다 ──
const got = [];
const replies = new Map(); // path -> (body, n) => { status, json }
const central = http.createServer((q, r) => {
  const ch = []; q.on('data', (c) => ch.push(c));
  q.on('end', () => {
    let b = Buffer.concat(ch);
    try { if (q.headers['content-encoding'] === 'gzip') b = zlib.gunzipSync(b); } catch { /* */ }
    let body = null; try { body = JSON.parse(b.toString('utf8') || 'null'); } catch { body = null; }
    const p = q.url.split('?')[0];
    got.push({ path: p, url: q.url, body });
    const fn = replies.get(p);
    const out = fn ? fn(body, got.filter((x) => x.path === p).length) : { status: 200, json: { ok: true } };
    r.writeHead(out.status, { 'content-type': 'application/json' }); r.end(JSON.stringify(out.json));
  });
});
await new Promise((r) => central.listen(0, '127.0.0.1', r));
const MOCK = `http://127.0.0.1:${central.address().port}`;
test.after(() => central.close());

const { config } = await import('../src/config.js');
config.agent.centralUrl = MOCK;
config.agent.centralToken = 'shared-2607e';
config.agent.name = 'site-b';
config.agent.pushCurUser = true;
const quiet = async (fn, sink) => {
  const w = console.warn; const l = console.log;
  console.warn = (...a) => sink?.push(['warn', a.join(' ')]); console.log = (...a) => sink?.push(['log', a.join(' ')]);
  try { return await fn(); } finally { console.warn = w; console.log = l; }
};

// ─────────────────────────────────────────────────────────────────────────────
test('EDGE2607-01: 공유 토큰 엣지의 로그 폴백 회신이 실제 중앙 라우트에 저장되고 작업이 ack 된다', async () => {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express(); app.use(express.json({ limit: '8mb' })); app.use('/api/central', centralRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    config.agent.centralUrl = `http://127.0.0.1:${srv.address().port}`;
    const { enqueueEdgeLogJob, edgeLogJobState } = await import('../src/central/edgeLogJobs.js');
    enqueueEdgeLogJob('site-b', {});
    const w = await import('../src/agent/edgeLogWorker.js');
    const run = await quiet(() => w.runEdgeLogWorkerOnce());
    // 수정 전: { ok:false, reason:'edge-log-result <- HTTP 400' } · 작업은 claimed 로 남음 · 보관분 없음
    assert.equal(run.ok, true, JSON.stringify(run));
    assert.equal(run.job, true);
    assert.equal(w.edgeLogWorkerStatus().last.ok, true);
    const js = edgeLogJobState('site-b');
    assert.notEqual(js?.state, 'claimed', `작업이 claimed 로 남으면 안 된다: ${JSON.stringify(js)}`);
    const { latestEdgeLog } = await import('../src/central/edgeLogStore.js');
    assert.ok(latestEdgeLog('site-b'), '중앙 보관분이 생겨야 한다');
  } finally {
    srv.close();
    config.agent.centralUrl = MOCK;
  }
});

test('EDGE2607-01: 워커 회신은 ?agent= 와 본문 최상위 agent 를 함께 싣는다(목 중앙)', async () => {
  replies.set('/api/central/edge-log-jobs', () => ({ status: 200, json: { ok: true, job: { id: 'j1', limit: 5 } } }));
  const w = await import('../src/agent/edgeLogWorker.js');
  got.length = 0;
  const r = await quiet(() => w.runEdgeLogWorkerOnce());
  assert.equal(r.ok, true);
  const post = got.find((x) => x.path === '/api/central/edge-log-result');
  assert.ok(post);
  assert.match(post.url, /[?&]agent=site-b(&|$)/);
  assert.equal(post.body?.agent, 'site-b');
  replies.delete('/api/central/edge-log-jobs');
});

// ─────────────────────────────────────────────────────────────────────────────
test('EDGE2607-02: ip-scan-result 의 capped·dropped 를 엣지 상태·콘솔에 남긴다', async () => {
  const target = http.createServer((_q, s) => s.end('x'));
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  try {
    const tport = target.address().port;
    replies.set('/api/central/ip-scan-assignment', () => ({ status: 200, json: { ok: true, assigned: true, ranges: ['127.0.0.1'], ports: [tport], concurrency: 2, timeoutMs: 1000 } }));
    replies.set('/api/central/ip-scan-result', () => ({ status: 200, json: { ok: true, merged: 0, capped: 5, dropped: 2 } }));
    const w = await import('../src/agent/ipScanWorker.js');
    const sink = [];
    const last = await quiet(() => w.runIpScanAgentOnce(), sink);
    assert.equal(last.assigned, true, JSON.stringify(last));
    // 수정 전: last = { assigned, scanned, alive } — 중앙이 받지 않은 흔적이 없다
    assert.ok(last.centralDropped, JSON.stringify(last));
    assert.equal(last.centralDropped.omitted, 5);
    assert.equal(last.centralDropped.rejected, 2);
    assert.ok(sink.some(([k, m]) => k === 'warn' && /ipscan-agent/.test(m) && /일부를 받지 않았습니다/.test(m)));
    // 정상 응답이면 요약 없음
    assert.equal(w.ipScanDropOf({ ok: true, merged: 3 }), null);
    assert.equal(w.ipScanDropOf({ ok: true, capped: '7' }), null, '숫자가 아닌 값은 세지 않는다');
  } finally {
    target.close();
    replies.delete('/api/central/ip-scan-assignment'); replies.delete('/api/central/ip-scan-result');
  }
});

test('EDGE2607-02: part-faults 응답의 rejected 를 콘솔에 남기고 partsOmitted 를 상태에 싣는다', async () => {
  replies.set('/api/central/part-faults', () => ({ status: 200, json: { ok: true, agent: 'site-b', protocol: 2, devices: 0, rejected: 3, partsOmitted: 4, open: 0, centralEnabled: true } }));
  const pf = await import('../src/partfault/push.js');
  const sink = [];
  const r = await quiet(() => pf.pushPartFaultsNow({ reason: 'test' }), sink);
  assert.equal(r.ok, true, JSON.stringify(r));
  const st = pf.partFaultPushStatus();
  const last = st.last || st;
  assert.equal(last.rejected, 3);
  assert.equal(last.partsOmitted, 4);
  // 수정 전: rejected 는 _last 에만 있고 콘솔 줄은 성공만 말했다
  assert.ok(sink.some(([k, m]) => k === 'warn' && /partfault-push/.test(m) && /거부 3/.test(m)), JSON.stringify(sink));
  replies.delete('/api/central/part-faults');
});

// ─────────────────────────────────────────────────────────────────────────────
test('EDGE2607-03: GPU 게스트 보류 문구가 vCenter 개수·이름을 말하고 같은 보류는 반복 로그하지 않는다', async () => {
  const g = await import('../src/agent/gpuGuestPush.js');
  const wh = g.gpuGuestPushWithhold({ unreadVcenters: ['vc-a', 'vc-b'] }, null, 1_000);
  assert.equal(wh.unread, 2);
  assert.deepEqual(wh.unreadIds, ['vc-a', 'vc-b']);
  g._setGuestPollerStatusForTest(() => ({ lastRun: { unreadVcenters: ['vc-a', 'vc-b'] } }));
  const sink = [];
  try {
    const r = await quiet(() => g.pushGpuGuestNow(), sink);
    assert.equal(r.skipped, true);
    // 수정 전: '게스트 GPU 대상 vCenter 곳을 아직 읽지 못해…'
    assert.match(r.reason, /vCenter 2곳\(vc-a, vc-b\)/);
    assert.doesNotMatch(r.reason, /vCenter 곳/);
    const r2 = await quiet(() => g.pushGpuGuestNow(), sink);
    assert.equal(r2.skipped, true);
    const lines = sink.filter(([, m]) => /gpu-guest-push/.test(m));
    assert.equal(lines.length, 1, `같은 보류 사유는 한 줄: ${JSON.stringify(lines)}`);
  } finally { g._setGuestPollerStatusForTest(null); }
  // 10개 넘는 목록은 앞 10개 + 나머지 개수
  const many = g.gpuGuestPushWithhold({ unreadVcenters: Array.from({ length: 13 }, (_, i) => `vc${i}`) }, null, 1_000);
  assert.equal(many.unread, 13); assert.equal(many.unreadIds.length, 10);
});

// ─────────────────────────────────────────────────────────────────────────────
test('RECENT2607-02: slimRecord 가 truncated 표지를 싣고 집계가 하한(usersLowerBound)을 말한다', async () => {
  const cu = await import('../src/agent/curUserPush.js');
  const { aggregate } = await import('../src/curuser/aggregate.js');
  const raw = { vmId: 'vm-1', vcenterId: 'vc-1', kind: 'ok', ok: true, users: [{ name: 'a', kind: 'active' }], truncated: true, usersLowerBound: true };
  const slim = cu.slimRecord(raw);
  assert.equal(slim.truncated, true, '수정 전: 키 없음');
  assert.equal(aggregate([slim]).usersLowerBound, true);
  assert.equal(cu.slimRecord({ ...raw, truncated: false, usersLowerBound: false }).truncated, false);
  // 실제 push 본문에도 실린다
  got.length = 0;
  await quiet(() => cu.pushCurUserRecords([raw]));
  const post = got.find((x) => x.path === '/api/central/curuser');
  assert.equal(post.body.records[0].truncated, true);
});

test('LEFT2607-09: curuser 뒤 청크가 실패하면 한 번 전체 재전송하고, 그래도 실패하면 부분 상태를 밝힌다', async () => {
  const cu = await import('../src/agent/curUserPush.js');
  const recs = Array.from({ length: 700 }, (_, i) => ({ vmId: `vm-${i}`, vcenterId: 'vc-1', kind: 'ok', ok: true, users: [] }));
  // ① 첫 시도의 청크 1 만 실패 → 재전송이 성공
  let fails = 1;
  replies.set('/api/central/curuser', (body) => {
    if (body?.chunk === 1 && fails > 0) { fails--; return { status: 400, json: { ok: false } }; }
    return { status: 200, json: { ok: true } };
  });
  got.length = 0;
  const r = await quiet(() => cu.pushCurUserRecords(recs));
  assert.equal(r.ok, true);
  assert.equal(r.resent, true, '수정 전: 재전송 없이 throw');
  const posts = got.filter((x) => x.path === '/api/central/curuser');
  const chunk0 = posts.filter((x) => x.body.chunk === 0).length;
  assert.equal(chunk0, 2, '청크 0 부터 다시 보냈다');
  const lastChunks = posts.slice(-3).map((x) => x.body.chunk);
  assert.deepEqual(lastChunks, [0, 1, 2]);

  // ② 계속 실패 → throw + 부분 상태 명시
  replies.set('/api/central/curuser', (body) => (body?.chunk === 2 ? { status: 400, json: { ok: false } } : { status: 200, json: { ok: true } }));
  const sink = [];
  await assert.rejects(quiet(() => cu.pushCurUserRecords(recs), sink));
  const last = cu.curUserPushStatus().last;
  assert.equal(last.resent, true);
  assert.ok(last.centralPartial, JSON.stringify(last));
  assert.equal(last.centralPartial.receivedChunks, 2);
  assert.equal(last.centralPartial.receivedRecords, 600);
  assert.match(last.error, /부분 상태/);
  assert.match(last.error, /전체 재전송도 실패/);

  // ③ 재전송의 청크 0 이 실패해도 중앙에는 첫 시도의 부분 목록이 남아 있다 — '직전 push 그대로' 라고 말하지 않는다
  let n = 0;
  replies.set('/api/central/curuser', (body) => { n++; if (n === 2 || n === 3) return { status: 400, json: { ok: false } }; return { status: 200, json: { ok: true } }; });
  await assert.rejects(quiet(() => cu.pushCurUserRecords(recs)));
  const l3 = cu.curUserPushStatus().last;
  assert.equal(l3.centralPartial?.receivedChunks, 1, JSON.stringify(l3));
  assert.doesNotMatch(l3.error, /직전 push 그대로/);

  // ④ 첫 청크부터 실패하면 재전송하지 않는다(중앙 목록은 그대로)
  replies.set('/api/central/curuser', () => ({ status: 400, json: { ok: false } }));
  got.length = 0;
  await assert.rejects(quiet(() => cu.pushCurUserRecords(recs)));
  assert.equal(got.filter((x) => x.path === '/api/central/curuser').length, 1);
  assert.match(cu.curUserPushStatus().last.error, /직전 push 그대로/);
  replies.delete('/api/central/curuser');
});

// ─────────────────────────────────────────────────────────────────────────────
test('RECENT2607-04: 전용 계열이 DB 에 남아 있어도 현재 충돌이 없으면 conflict=false(키는 유지)', async () => {
  const st = await import('../src/collector/state.js');
  const r = st.remoteSeriesKey('cA', 'esx01', new Set(), (k) => k === 'rmt:cA:esx01');
  assert.equal(r.key, 'rmt:cA:esx01', '이력 연속: 키는 전용 계열');
  assert.equal(r.persisted, true);
  assert.equal(r.conflict, false, '수정 전: persisted 만으로 conflict:true');
  const r2 = st.remoteSeriesKey('cA', 'esx01', new Set(['esx01']), () => false);
  assert.equal(r2.key, 'rmt:cA:esx01'); assert.equal(r2.conflict, true);
  const r3 = st.remoteSeriesKey('cA', 'esx02', new Set(), () => false);
  assert.equal(r3.key, 'rmt:esx02'); assert.equal(r3.conflict, false);
});

test('RECENT2607-04: 실제 pull — 충돌 해소 뒤 전용 계열 키는 쓰지만 hostConflicts·경고는 없다', async () => {
  const express = (await import('express')).default;
  const now = Date.now();
  const ea = express();
  ea.get('/api/collector/export', (_q, s) => s.json({ version: '2.607.0', agent: 'pq', datacenter: 'Q', power: { byHost: [{ host: 'esx-old', watts: 250, ts: now - 5000, serverId: 1 }] } }));
  const srv = await new Promise((r) => { const x = ea.listen(0, '127.0.0.1', () => r(x)); });
  try {
    const { getDb } = await import('../src/idrac/db.js');
    const db = await getDb();
    db.insert('rmt:pq:esx-old', 200, now - 3_600_000); // 한때 충돌해 만들어진 전용 계열(영속)
    const { addCollector } = await import('../src/collector/registry.js');
    addCollector({ id: 'pq', name: 'pq', url: `http://127.0.0.1:${srv.address().port}`, token: 't', enabled: true });
    const puller = await import('../src/collector/puller.js');
    const st = await import('../src/collector/state.js');
    const sink = [];
    assert.equal(await quiet(() => puller.pullCollectorByAgent('pq'), sink), true);
    const e = st.remotePowerEntries().find((x) => x.host === 'esx-old' && x.collectorId === 'pq');
    assert.equal(e.dbKey, 'rmt:pq:esx-old', '키는 영속 판정대로');
    assert.notEqual(e.hostConflict, true, '수정 전: hostConflict:true');
    assert.equal(st.getCollectorStatus('pq').hostConflicts, null, '수정 전: [esx-old]');
    assert.ok(!sink.some(([, m]) => /같은 호스트명/.test(m)), JSON.stringify(sink));
  } finally { srv.close(); }
});

// ─────────────────────────────────────────────────────────────────────────────
test('RECENT2607-05: RMA 403 refused 는 연락으로 센다(무연결 명령 오발 방지)', async () => {
  replies.set('/api/central/rma-poll', () => ({ status: 403, json: { ok: false, refused: true, reason: 'RMA 인스턴스 수 상한', jobs: [] } }));
  process.env.CENTRAL_URL = MOCK;
  const rma = await import('../src/rma/agent.js');
  const before = rma.rmaContactState().lastContact;
  await new Promise((r) => setTimeout(r, 15));
  const sink = [];
  const err = await quiet(async () => { try { await rma.pollOnce(); return null; } catch (e) { return e; } }, sink);
  assert.ok(err, '백오프를 위해 오류로 던진다');
  assert.equal(err.refused, true);
  const st = rma.rmaContactState();
  assert.ok(st.lastContact > before, '수정 전: lastContact 가 갱신되지 않아 N분 뒤 RMA_OFFLINE_CMD 실행');
  assert.match(st.lastRefused?.reason || '', /상한/);
  // refused 가 없는 403 은 예전대로 연락이 아니다
  replies.set('/api/central/rma-poll', () => ({ status: 403, json: { ok: false, reason: '토큰 불일치' } }));
  const c0 = rma.rmaContactState().lastContact;
  await new Promise((r) => setTimeout(r, 15));
  const e2 = await quiet(async () => { try { await rma.pollOnce(); return null; } catch (e) { return e; } });
  assert.ok(e2); assert.notEqual(e2.refused, true);
  assert.equal(rma.rmaContactState().lastContact, c0);
  replies.delete('/api/central/rma-poll');
});
