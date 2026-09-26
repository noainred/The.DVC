/**
 * v2.622 감사 그룹 C — 회귀 테스트(위임 잡 큐 · 엣지 워커 회신 계약).
 *  - RECENT-03·EDGE-02: 엣지가 스캔 잠금 중이면 폴을 건너뛰어 중앙 폴 시각이 멈추고, 대기 잡이 10분 뒤 gc 로 **조용히** 지워지던 결함.
 *  - LEFT-03: capture-result 가 모르는 reqId 에도 200 + 이력 기록, 재전송마다 이력 행 중복.
 *  - EDGE-01: RMA 롱폴이 대기 명령을 전량 인출해 뒤 명령이 '미회신' 으로 종결되고, 늦은 실제 결과(stale)를 엣지가 기록하지 않던 결함.
 *  - EDGE-03: bmstor 만료 잡에 늦게 온 결과가 200 stale 로 버려지고 엣지가 성공으로 기록하던 결함.
 *  - EDGE-04: 엣지 로그 폴백 회신이 stored:false/acked:false 여도 엣지가 성공으로 기록하던 결함.
 * 기준 시각은 Date.now() 가 아니라 정시에서 떨어진 고정값이다(CLAUDE.md — 시각에 따라 깨지는 테스트 금지).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2622c-'));
process.env.CONFIG_DIR = DIR;
process.env.CENTRAL_TOKEN = 'ctok';
process.env.SSRF_ALLOW_LOOPBACK = 'true';

// ── 목 중앙(엣지 워커 대상) — rma/agent.js 는 CENTRAL_URL 을 로드 시점에 읽으므로 import 전에 띄운다 ──
const mock = { reqs: [], statuses: {}, replies: {}, version: '2.622.0' };
const mockSrv = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let raw = Buffer.concat(chunks);
    if (/gzip/i.test(String(req.headers['content-encoding'] || ''))) raw = zlib.gunzipSync(raw);
    const u = new URL(req.url, 'http://x');
    let body = null; try { body = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { body = null; }
    mock.reqs.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
    res.setHeader('Content-Type', 'application/json');
    if (u.pathname === '/api/central/health-probe') { res.end(JSON.stringify({ ok: true, version: mock.version })); return; }
    const q = mock.statuses[u.pathname];
    const st = (Array.isArray(q) && q.length) ? q.shift() : 200;
    const rq = mock.replies[u.pathname];
    const reply = (Array.isArray(rq) && rq.length) ? rq.shift() : { ok: st === 200 };
    res.statusCode = st;
    res.end(JSON.stringify(reply));
  });
});
await new Promise((r) => mockSrv.listen(0, '127.0.0.1', r));
const MOCK_URL = `http://127.0.0.1:${mockSrv.address().port}`;
process.env.CENTRAL_URL = MOCK_URL;
process.env.AGENT_NAME = 'edge-c';
const reqsTo = (p) => mock.reqs.filter((r) => r.path === p);

const express = (await import('express')).default;
const { centralRouter } = await import('../src/routes/central.js');
const { config } = await import('../src/config.js');

const app = express();
app.use(express.json({ limit: '16mb' }));
app.use('/api/central', centralRouter);
const srv = app.listen(0);
const port = srv.address().port;
after(() => { for (const s of [srv, mockSrv]) try { s.close(); } catch { /* */ } });

async function call(method, route, body, agent = 'edge-c') {
  const r = await fetch(`http://127.0.0.1:${port}/api/central/${route}${route.includes('?') ? '&' : '?'}agent=${agent}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Central-Token': 'ctok', 'X-Agent-Name': agent }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let j = null; try { j = await r.json(); } catch { /* */ }
  return [r.status, j];
}

function asEdge(fn) {
  const prev = config.agent;
  config.agent = { ...(config.agent || {}), name: 'edge-c', centralUrl: MOCK_URL, centralToken: 'ctok', autoRegister: false };
  return Promise.resolve().then(fn).finally(() => { config.agent = prev; });
}

const T0 = 1_900_000_000_000 - 30 * 60_000;
function withClock(fn) {
  const real = Date.now;
  const clock = { t: T0 };
  Date.now = () => clock.t;
  try { return fn(clock); } finally { Date.now = real; }
}
/** 콘솔 출력을 모은다(끝나면 되돌린다). */
async function captureConsole(fn) {
  const out = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => out.push(a.join(' '));
  try { await fn(); } finally { Object.assign(console, orig); }
  return out.join('\n');
}

// ── RECENT-03 · EDGE-02 ─────────────────────────────────────────────────────
test('RECENT-03·EDGE-02 — 잠금 중 생존 폴(?busy=1)은 잡을 주지 않고 폴 시각만 갱신해, 15분 잠금에도 대기 잡이 살아 있다', async () => {
  const jobs = await import('../src/central/idracScanJobs.js');
  const reqId = jobs.enqueueIdracScan('edge-c', { ips: '10.71.0.0/29', username: 'root', password: 'pw', datacenterId: 'C1' });
  const [st, body] = await call('GET', 'idrac-scan-jobs?busy=1');
  assert.equal(st, 200);
  assert.equal(body.busyAck, true);
  assert.deepEqual(body.jobs, [], '잠금 중인 엣지에 잡을 주지 않는다(받아도 실행할 수 없다)');
  assert.equal(jobs.getIdracScanResult(reqId).state, 'pending');
  const [, b2] = await call('GET', 'idrac-scan-jobs');
  assert.deepEqual(b2.jobs.map((x) => x.reqId), [reqId], 'busy 없는 폴은 예전처럼 인출한다');
  jobs.applyIdracScanResult(reqId, { scanned: 6, foundCount: 0, found: [] });
  // 시간 경과: 15분 동안 1분마다 생존 폴만 온다 → 대기 잡이 지워지지 않는다(생존 폴이 없으면 11분에 만료된다 — 다음 테스트).
  withClock((clock) => {
    const j2 = jobs.enqueueIdracScan('busy-edge-2622', { ips: '10.71.1.0/29', username: 'root', password: 'pw' });
    for (let m = 1; m <= 15; m++) { clock.t = T0 + m * 60_000; assert.equal(jobs.noteIdracScanBusyPoll('busy-edge-2622'), true); jobs._gcForTest(clock.t); }
    assert.equal(jobs.getIdracScanResult(j2).state, 'pending', '생존 폴이 있는 동안 대기 잡은 지워지지 않는다');
    jobs.cancelIdracScanJob(j2);
  });
});

test('RECENT-03·EDGE-02 — 활동 없이 TTL 을 넘긴 대기 잡은 조용히 지우지 않고 오류 + 사유로 종결한다(늦은 결과는 계속 받는다)', async () => {
  const jobs = await import('../src/central/idracScanJobs.js');
  withClock((clock) => {
    const before = jobs.idracScanGcExpiredCount();
    const j = jobs.enqueueIdracScan('offline-edge-2622', { ips: '10.72.0.0/29', username: 'root', password: 'pw' });
    clock.t = T0 + 11 * 60_000;
    jobs._gcForTest(clock.t);
    const r = jobs.getIdracScanResult(j);
    assert.equal(r.state, 'error', '예전: jobs.delete — 사용자는 state unknown 만 봤다');
    assert.equal(r.expired, true);
    assert.match(r.error, /인출하지 않아 만료/);
    const log = jobs.getIdracScanJobLog(j);
    assert.ok(log.events.some((e) => e.level === 'error' && /만료/.test(e.msg)), JSON.stringify(log.events));
    assert.equal(jobs.idracScanGcExpiredCount(), before + 1);
    // 늦게 온 실제 결과는 반영된다(예전: 잡이 없어 410).
    assert.equal(jobs.applyIdracScanResult(j, { scanned: 6, foundCount: 0, found: [] }).ok, true);
    assert.equal(jobs.getIdracScanResult(j).state, 'done');
    // 완료 보존(TTL)이 지나면 그때 지운다.
    clock.t += 11 * 60_000;
    jobs._gcForTest(clock.t);
    assert.equal(jobs.getIdracScanResult(j).state, 'unknown');
  });
});

test('RECENT-03·EDGE-02 — 엣지 워커: 잠금 중이고 중앙이 busy 를 안다면 생존 폴을 보내고, 모르면(구버전) 폴하지 않는다', async () => {
  const w = await import('../src/agent/idracScanWorker.js');
  const { tryAcquireScan, releaseScan } = await import('../src/idrac/scanPoller.js');
  const lock = tryAcquireScan('assign');
  assert.ok(lock.ok);
  try {
    await asEdge(async () => {
      // ① 중앙이 2.622 이상(busy 이해) → ?busy=1 폴 1회, busyAck 를 상태에 남긴다.
      w._setBusyPollSupportForTest(() => ({ ok: true }));
      mock.replies['/api/central/idrac-scan-jobs'] = [{ ok: true, jobs: [], busyAck: true }];
      const n0 = reqsTo('/api/central/idrac-scan-jobs').length;
      await w.runIdracScanWorkerOnce();
      const polls = reqsTo('/api/central/idrac-scan-jobs').slice(n0);
      assert.equal(polls.length, 1);
      assert.equal(polls[0].query.busy, '1');
      assert.equal(w.getIdracScanWorkerStatus().lastSkipBusy.heartbeat, true);
      // ② 구버전 중앙(버전 미상·미만) → 폴하지 않는다(받은 잡을 되돌릴 수 없으므로). 사유를 상태에 남긴다.
      w._setBusyPollSupportForTest(() => ({ ok: false, reason: 'central-too-old', version: '2.621.0' }));
      const n1 = reqsTo('/api/central/idrac-scan-jobs').length;
      await w.runIdracScanWorkerOnce();
      assert.equal(reqsTo('/api/central/idrac-scan-jobs').length, n1, '구버전 중앙에는 잠금 중 폴을 보내지 않는다');
      const sk = w.getIdracScanWorkerStatus().lastSkipBusy;
      assert.equal(sk.heartbeat, false); assert.match(sk.reason, /central-too-old/);
      // ③ 실제 health-probe 경로: 목 중앙이 2.621.0 이면 지원하지 않는다고 판정한다.
      w._setBusyPollSupportForTest(null);
      mock.version = '2.621.0';
      const n2 = reqsTo('/api/central/idrac-scan-jobs').length;
      await w.runIdracScanWorkerOnce();
      assert.equal(reqsTo('/api/central/idrac-scan-jobs').length, n2);
      assert.equal(w.IDRAC_BUSY_POLL_MIN_CENTRAL, '2.622.0');
    });
  } finally { releaseScan(); w._setBusyPollSupportForTest(null); mock.version = '2.622.0'; }
});

// ── LEFT-03 ────────────────────────────────────────────────────────────────
test('LEFT-03 — capture-result: 모르는 reqId 는 410 + 이력 미기록, 같은 결과의 재전송은 이력을 다시 적지 않는다', async () => {
  const cj = await import('../src/central/captureJobs.js');
  const hist = await import('../src/net/captureHistory.js');
  const count = () => hist.listCaptures({ limit: 1000 }).length;
  const c0 = count();
  const [s1, b1] = await call('POST', 'capture-result', { reqId: 'cap_gone_2622', result: { ok: true, packets: 3 } });
  assert.equal(s1, 410); assert.equal(b1.error, 'unknown-job');
  assert.equal(count(), c0, '모르는 reqId 의 결과를 이력에 주입하지 않는다');

  const reqId = cj.enqueueCapture('edge-c', { host: '10.73.0.5', seconds: 1 });
  assert.equal(cj.takeCaptureJobs('edge-c').length, 1);
  const res = { ok: true, packets: 3, hostA: '10.73.0.5' };
  const [s2, b2] = await call('POST', 'capture-result', { reqId, result: res });
  assert.equal(s2, 200); assert.equal(b2.ok, true);
  assert.equal(count(), c0 + 1);
  const [s3, b3] = await call('POST', 'capture-result', { reqId, result: res });
  assert.equal(s3, 200); assert.equal(b3.duplicate, true);
  assert.equal(count(), c0 + 1, '재전송마다 이력 행이 늘면 안 된다');
  assert.equal(cj.getCaptureResult(reqId).state, 'done');
});

test('LEFT-03 — reap 이 미회신으로 닫은 캡처에 늦게 온 실제 결과는 반영하고(late), 그 뒤 재전송은 중복이다', async () => {
  const cj = await import('../src/central/captureJobs.js');
  const reqId = cj.enqueueCapture('edge-late', { host: '10.73.1.5', seconds: 1 });
  const now = Date.now();
  cj.takeCaptureJobs('edge-late', now);
  cj.reapCaptureClaims(now + 10 * 60_000); // 1회차 → 대기
  cj.takeCaptureJobs('edge-late', now + 10 * 60_000);
  cj.reapCaptureClaims(now + 20 * 60_000); // 한도 → 미회신 종결
  assert.match(cj.getCaptureResult(reqId).result.reason, /회신하지 않았습니다/);
  assert.deepEqual(cj.applyCaptureResult(reqId, { ok: true, packets: 1 }), { ok: true, late: true });
  assert.equal(cj.getCaptureResult(reqId).result.ok, true);
  assert.deepEqual(cj.applyCaptureResult(reqId, { ok: true, packets: 1 }), { ok: true, duplicate: true });
  assert.deepEqual(cj.applyCaptureResult('cap_none', { ok: true }), { ok: false, unknown: true });
});

test('LEFT-03 — 엣지 captureWorker 는 410 을 실패로 상태에 남긴다', async () => {
  const w = await import('../src/agent/captureWorker.js');
  mock.replies['/api/central/capture-jobs'] = [{ ok: true, jobs: [{ reqId: 'cap_w_2622', spec: { host: '127.0.0.1', port: 1, username: 'u', password: 'p', seconds: 1 } }] }];
  mock.statuses['/api/central/capture-result'] = [410];
  mock.replies['/api/central/capture-result'] = [{ ok: false, error: 'unknown-job', reason: '중앙에 이 캡처 잡이 없습니다' }];
  await asEdge(async () => {
    const out = await captureConsole(() => w.runCaptureWorkerOnce());
    const st = w.captureWorkerStatus();
    assert.equal(st.ok, false); assert.match(st.error, /410/);
    assert.match(out, /중앙에 이 잡이 없어/);
  });
});

// ── EDGE-01 ────────────────────────────────────────────────────────────────
test('EDGE-01 — RMA: 한 폴에 한 명령만 인출하고, 뒤 명령은 앞 명령이 끝난 뒤 인출 시각 기준으로 기한을 받는다', async () => {
  const jobs = await import('../src/rma/jobs.js');
  jobs._resetRma?.();
  assert.equal(jobs.TAKE_MAX, 1);
  const a = jobs.enqueueJob('rma-c', { cmd: 'uptime', args: {} }, { timeoutMs: 60_000 });
  const b = jobs.enqueueJob('rma-c', { cmd: 'uptime', args: {} }, { timeoutMs: 60_000 });
  const t = T0;
  const first = jobs.takeJobs('rma-c', 'i1', t);
  assert.deepEqual(first.map((x) => x.reqId), [a.reqId], '대기 전량을 인출하면 뒤 명령이 기한을 넘겨 미회신으로 종결된다');
  assert.equal(jobs.getJob(b.reqId).state, 'pending');
  // a 가 59초 뒤 끝난다 → 다음 폴에 b 를 그 시각 기준 기한으로 인출한다 → 117초에 온 b 결과는 반영된다.
  assert.equal(jobs.setJobResult(a.reqId, { ok: true }), true);
  const second = jobs.takeJobs('rma-c', 'i1', t + 59_000);
  assert.deepEqual(second.map((x) => x.reqId), [b.reqId]);
  jobs.reapClaims(t + 117_000);
  assert.equal(jobs.getJob(b.reqId).state, 'running', '예전: 인출 후 90초에 미회신 종결');
});

test('EDGE-01 — RMA 에이전트는 200 stale:true 회신을 로그에 남긴다', async () => {
  const agent = await import('../src/rma/agent.js');
  mock.replies['/api/central/rma-result'] = [{ ok: true, stale: true }];
  const out = await captureConsole(() => agent._postResultForTest('rmareq_2622', { ok: true, stdout: 'x' }));
  assert.match(out, /반영하지 않음\(stale\)/);
  mock.replies['/api/central/rma-result'] = [{ ok: true, stale: false }];
  const out2 = await captureConsole(() => agent._postResultForTest('rmareq_2622b', { ok: true }));
  assert.doesNotMatch(out2, /stale/);
});

// ── EDGE-03 ────────────────────────────────────────────────────────────────
test('EDGE-03 — bmstor: 만료 종결 잡에 늦게 온 결과는 반영되고(late), 재전송·더 새 잡 뒤에는 stale, 없는 잡은 410', async () => {
  const bj = await import('../src/bmstor/jobs.js');
  const poller = await import('../src/bmstor/poller.js');
  const reqId = bj.enqueueBmstorJob('edge-c', [{ id: 'bm-2622', host: '10.74.0.5' }]);
  const now = Date.now();
  bj.takeBmstorJobs('edge-c', now);
  bj.reapBmstorClaims(now + 20 * 60_000);
  bj.takeBmstorJobs('edge-c', now + 20 * 60_000);
  bj.reapBmstorClaims(now + 40 * 60_000); // 재시도 소진 → 만료 종결(onExpire 가 '회신하지 않았습니다' 를 남김)
  assert.equal(bj._bmstorJobForTest(reqId).expired, true);
  const results = [{ id: 'bm-2622', ok: true, mounts: [{ mount: '/', totalBytes: 100, usedBytes: 40, availBytes: 60 }] }];
  const [s1, b1] = await call('POST', 'bmstor-result', { reqId, results });
  assert.equal(s1, 200); assert.equal(b1.late, true, '예전: 200 {stale:true} 로 버려졌다');
  const latest = poller.getBmLatest().get('bm-2622');
  assert.equal(latest?.ok, true, '만료 때 남긴 \'회신하지 않았다\' 를 실제 결과가 덮는다');
  const [s2, b2] = await call('POST', 'bmstor-result', { reqId, results });
  assert.equal(s2, 200); assert.equal(b2.stale, true); assert.equal(b2.duplicate, true);
  const [s3, b3] = await call('POST', 'bmstor-result', { reqId: 'bms_gone_2622', results });
  assert.equal(s3, 410); assert.equal(b3.error, 'unknown-job');

  // 더 새 잡이 먼저 정상 회신됐으면 옛 늦은 결과는 쓰지 않는다(새 값을 되돌리지 않게).
  const old = bj.enqueueBmstorJob('edge-d', [{ id: 'bm-2622d', host: '10.74.0.6' }]);
  bj.takeBmstorJobs('edge-d', now); bj.reapBmstorClaims(now + 20 * 60_000);
  bj.takeBmstorJobs('edge-d', now + 20 * 60_000); bj.reapBmstorClaims(now + 40 * 60_000);
  await new Promise((r) => setTimeout(r, 2));
  const fresh = bj.enqueueBmstorJob('edge-d', [{ id: 'bm-2622d', host: '10.74.0.6' }]);
  bj.takeBmstorJobs('edge-d');
  assert.ok(bj.ackBmstorJob(fresh));
  assert.deepEqual(bj.lateBmstorResult(old), { superseded: true });
});

test('EDGE-03 — bmstorWorker 는 200 stale(미반영)을 실패로 상태·콘솔에 남기고, 재전송 중복은 실패로 보지 않는다', async () => {
  const w = await import('../src/agent/bmstorWorker.js');
  await asEdge(async () => {
    mock.replies['/api/central/bmstor-jobs'] = [{ ok: true, jobs: [{ reqId: 'bms_w_2622', servers: [] }] }];
    mock.replies['/api/central/bmstor-result'] = [{ ok: true, stale: true, superseded: true, reason: '더 새 결과' }];
    const out = await captureConsole(() => w.runBmstorWorkerOnce());
    const st = w.bmstorWorkerStatus();
    assert.equal(st.ok, false, '예전: r.ok 만 봐서 ok:true');
    assert.match(st.error, /반영하지 않음\(stale/);
    assert.match(out, /stale/);
    mock.replies['/api/central/bmstor-jobs'] = [{ ok: true, jobs: [{ reqId: 'bms_w_2622b', servers: [] }] }];
    mock.replies['/api/central/bmstor-result'] = [{ ok: true, stale: true, duplicate: true }];
    await captureConsole(() => w.runBmstorWorkerOnce());
    assert.equal(w.bmstorWorkerStatus().ok, true);
  });
});

// ── EDGE-04 ────────────────────────────────────────────────────────────────
test('EDGE-04 — 엣지 로그 큐: 기한을 넘겨 대기로 되돌아간 요청에 늦게 온 회신은 그 요청의 결과로 ack 하고 대기에서 지운다', async () => {
  const q = await import('../src/central/edgeLogJobs.js');
  q._resetForTest();
  withClock((clock) => {
    q.enqueueEdgeLogJob('edge-late-log', { limit: 10 });
    assert.ok(q.takeEdgeLogJob('edge-late-log', clock.t));
    clock.t = T0 + 61_000;
    q.reapEdgeLogClaims(clock.t); // 기한 초과 → 대기(tries 1)
    assert.equal(q.edgeLogJobState('edge-late-log', clock.t).state, 'pending');
    assert.deepEqual(q.ackEdgeLogJob('edge-late-log'), { acked: true, late: true }, '예전: acked:false — 공유 토큰은 보관 안 함, 개별 토큰은 한 번 더 수집');
    assert.equal(q.edgeLogJobState('edge-late-log', clock.t).state, 'none');
    // 새로 등록된 요청(tries 0)은 늦은 회신이 채울 수 없다.
    q.enqueueEdgeLogJob('edge-new-log', { limit: 10 });
    assert.deepEqual(q.ackEdgeLogJob('edge-new-log'), { acked: false });
    assert.equal(q.edgeLogJobState('edge-new-log', clock.t).state, 'pending');
  });
  q._resetForTest();
});

test('EDGE-04 — edgeLogWorker 는 stored:false 를 실패로, acked:false 를 경고로 기록한다', async () => {
  const w = await import('../src/agent/edgeLogWorker.js');
  await asEdge(async () => {
    mock.replies['/api/central/edge-log-jobs'] = [{ ok: true, job: { since: 0, limit: 5 } }];
    mock.replies['/api/central/edge-log-result'] = [{ ok: true, stored: false, acked: false, reason: '요청한 적 없는 공유 토큰 회신은 보관하지 않습니다' }];
    const out = await captureConsole(() => w.runEdgeLogWorkerOnce());
    const last = w.edgeLogWorkerStatus().last;
    assert.equal(last.ok, false, '예전: post.ok 만 보고 ok:true · 중앙 요청 회신');
    assert.equal(last.kind, 'not-stored');
    assert.match(last.error, /보관하지 않음/);
    assert.doesNotMatch(out, /중앙 요청 회신 —/);

    mock.replies['/api/central/edge-log-jobs'] = [{ ok: true, job: { since: 0, limit: 5 } }];
    mock.replies['/api/central/edge-log-result'] = [{ ok: true, stored: true, acked: false }];
    const out2 = await captureConsole(() => w.runEdgeLogWorkerOnce());
    const last2 = w.edgeLogWorkerStatus().last;
    assert.equal(last2.ok, true); assert.equal(last2.acked, false);
    assert.match(out2, /acked:false/);
  });
});
