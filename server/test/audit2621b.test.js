/**
 * v2.621 감사 그룹 B — 회귀 테스트(엣지 ↔ 중앙 위임·수신 계약).
 *  - EDGE-01: 위임 iDRAC 스캔 잡을 전량 인출해 뒤 잡이 거짓 재대기·gc 로 지워지고 결과가 200 과 함께 버려지던 결함.
 *  - EDGE-07: iDRAC 스캔 결과 수신이 멱등이 아니라 재전송 때 '완료' 이벤트·스캔 로그 결과 줄이 두 번 남던 결함.
 *  - EDGE-03: 스토리지·SAN·PDU 엣지 push 가 손상 등록부를 '위임 0대' 로 읽어 빈 목록으로 중앙 목록을 비우던 결함.
 *  - EDGE-04: part-faults 수신이 중앙 등록부 손상을 보지 않고 스토리지·SAN 보고를 전부 '미소유' 로 버리고 200 이던 결함.
 *  - EDGE-06: 위임 '지금 수집' 큐의 seen 맵이 지워지지 않아 push 원소마다 상주가 늘던 결함.
 *  - RECENT-09: 설정 push 413 재전송이 부분 목록으로 중앙 사본을 교체해 큰 설정의 직전 사본이 사라지던 결함.
 *  - LIFE-01: 엣지 할당 스캐너가 iDRAC 스캔 공용 잠금을 공유하지 않던 결함.
 * 기준 시각은 Date.now() 가 아니라 고정값이다(CLAUDE.md — 시각에 따라 깨지는 테스트 금지).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2621b-'));
process.env.CONFIG_DIR = DIR;
process.env.CENTRAL_TOKEN = 'ctok';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.COLLECTOR_TIMEOUT_MS = '1000';

const express = (await import('express')).default;
const { centralRouter } = await import('../src/routes/central.js');
const { config } = await import('../src/config.js');

const app = express();
app.use(express.json({ limit: '16mb' }));
app.use('/api/central', centralRouter);
const srv = app.listen(0);
const port = srv.address().port;
const servers = [srv];
after(() => { for (const s of servers) try { s.close(); } catch { /* */ } });

async function post(route, body, agent = 'edge-b') {
  const r = await fetch(`http://127.0.0.1:${port}/api/central/${route}?agent=${agent}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': 'ctok', 'X-Agent-Name': agent }, body: JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch { /* */ }
  return [r.status, j];
}

/** 손상 등록부를 만들고, 끝나면 손상 보존본까지 지워 원상태로 돌린다(보존본만 남으면 '못 읽음' 이 이어진다). */
function corrupt(file) { fs.writeFileSync(path.join(DIR, file), '{bad json'); }
function restore(file) {
  for (const n of fs.readdirSync(DIR)) if (n === file || n.startsWith(`${file}.corrupt.`)) fs.rmSync(path.join(DIR, n), { force: true });
}

// ── 목 중앙(엣지 push 대상) ──────────────────────────────────────────────────
const mock = { reqs: [], statuses: {}, replies: {} };
const mockSrv = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let raw = Buffer.concat(chunks);
    if (/gzip/i.test(String(req.headers['content-encoding'] || ''))) raw = zlib.gunzipSync(raw);
    const p = req.url.split('?')[0];
    let body = null; try { body = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { body = null; }
    mock.reqs.push({ method: req.method, path: p, body });
    res.setHeader('Content-Type', 'application/json');
    if (p === '/api/central/health-probe') { res.end(JSON.stringify({ ok: true, version: '2.621.0' })); return; }
    if (p === '/api/central/assignment') { res.end(JSON.stringify({ ok: true, assigned: true, agent: 'edge-b', ips: '169.254.10.1', username: 'root', password: 'pw' })); return; }
    const q = mock.statuses[p];
    const st = (Array.isArray(q) && q.length) ? q.shift() : 200;
    const rq = mock.replies[p];
    const reply = (Array.isArray(rq) && rq.length) ? rq.shift() : { ok: st === 200 };
    res.statusCode = st;
    res.end(JSON.stringify(reply));
  });
});
await new Promise((r) => mockSrv.listen(0, '127.0.0.1', r));
servers.push(mockSrv);
const MOCK_URL = `http://127.0.0.1:${mockSrv.address().port}`;
const reqsTo = (p) => mock.reqs.filter((r) => r.path === p);

function asEdge(fn) {
  const prev = config.agent;
  config.agent = { ...(config.agent || {}), name: 'edge-b', centralUrl: MOCK_URL, centralToken: 'ctok', autoRegister: false };
  return Promise.resolve().then(fn).finally(() => { config.agent = prev; });
}

/** 고정 시계 — Date.now 를 잠시 바꾼다(끝나면 되돌린다). T0 는 정시에서 떨어진 고정값. */
const T0 = 1_900_000_000_000 - 30 * 60_000;
function withClock(fn) {
  const real = Date.now;
  const clock = { t: T0 };
  Date.now = () => clock.t;
  try { return fn(clock); } finally { Date.now = real; }
}

// ── EDGE-01 ───────────────────────────────────────────────────────────────
test('EDGE-01 — 폴 한 번에 한 잡만 인출하고, 앞 잡이 도는 동안(진행 보고) 뒤 잡은 gc 로 지워지지 않는다', async () => {
  const jobs = await import('../src/central/idracScanJobs.js');
  assert.equal(jobs.TAKE_MAX, 1);
  withClock((clock) => {
    const j1 = jobs.enqueueIdracScan('q-edge', { ips: '10.61.0.0/28', username: 'root', password: 'pw', datacenterId: 'DQ1' });
    const j2 = jobs.enqueueIdracScan('q-edge', { ips: '10.61.1.0/28', username: 'root', password: 'pw', datacenterId: 'DQ2' });
    const j3 = jobs.enqueueIdracScan('q-edge', { ips: '10.61.2.0/28', username: 'root', password: 'pw', datacenterId: 'DQ3' });
    const out = jobs.takeIdracScanJobs('q-edge');
    assert.deepEqual(out.map((x) => x.reqId), [j1], '엣지가 처리하는 만큼(1건)만 인출한다');
    assert.equal(jobs.getIdracScanResult(j2).state, 'pending');
    // 엣지는 j1 을 15분 동안 돌며 진행만 보고하고 그동안 폴하지 않는다.
    for (let m = 1; m <= 15; m++) { clock.t = T0 + m * 60_000; assert.equal(jobs.setIdracScanProgress(j1, { scanned: m, total: 16 }), true); }
    assert.equal(jobs.getIdracScanResult(j2).state, 'pending', '앞 잡이 진행 중인 동안 뒤 잡이 gc 로 지워지면 그 결과가 버려진다');
    assert.equal(jobs.getIdracScanResult(j3).state, 'pending');
    // 로그창: '폴링하지 않습니다' 가 아니라 '앞선 잡 처리 중' 이라고 말한다.
    const log = jobs.getIdracScanJobLog(j2);
    assert.ok(log.hints.some((h) => /앞선 잡/.test(h.msg) && h.level === 'info'), JSON.stringify(log.hints));
    assert.ok(!log.hints.some((h) => /폴링하지 않습니다|폴링 기록이 없습니다/.test(h.msg)), JSON.stringify(log.hints));
    // j1 완료 → 다음 폴에서 j2 를 인출하고 그 진행·결과가 반영된다.
    assert.equal(jobs.applyIdracScanResult(j1, { scanned: 16, foundCount: 0, found: [] }).ok, true);
    clock.t += 5_000;
    assert.deepEqual(jobs.takeIdracScanJobs('q-edge').map((x) => x.reqId), [j2]);
    assert.equal(jobs.setIdracScanProgress(j2, { scanned: 1, total: 16 }), true);
    assert.equal(jobs.applyIdracScanResult(j2, { scanned: 16, foundCount: 0, found: [] }).ok, true);
    assert.equal(jobs.getIdracScanResult(j2).state, 'done');
    clock.t += 5_000;
    assert.deepEqual(jobs.takeIdracScanJobs('q-edge').map((x) => x.reqId), [j3]);
  });
});

test('EDGE-01 — 폴도 진행도 없는 오프라인 에이전트의 대기 잡은 예전처럼 10분 뒤 정리된다', async () => {
  const jobs = await import('../src/central/idracScanJobs.js');
  withClock((clock) => {
    const j = jobs.enqueueIdracScan('offline-edge-2621', { ips: '10.62.0.0/29', username: 'root', password: 'pw' });
    clock.t = T0 + 11 * 60_000;
    assert.equal(jobs.getIdracScanResult(j).state, 'unknown');
  });
});

test('EDGE-01 — 중앙에 없는 잡의 진행·결과는 410(예전: 반환값을 보지 않고 200 — 조용한 소실)', async () => {
  const [s1, b1] = await post('idrac-scan-progress', { reqId: 'idscan_gone_2621', scanned: 1, total: 2 });
  assert.equal(s1, 410); assert.equal(b1.reason, 'unknown-job');
  const [s2, b2] = await post('idrac-scan-result', { reqId: 'idscan_gone_2621', scanned: 2, found: [] });
  assert.equal(s2, 410); assert.equal(b2.reason, 'unknown-job');
});

test('EDGE-01 — 엣지 워커는 410 을 "중앙에 잡이 없음(만료·재시작)" 으로 상태에 남긴다', async () => {
  const w = await import('../src/agent/idracScanWorker.js');
  mock.replies['/api/central/idrac-scan-jobs'] = [{ ok: true, jobs: [{ reqId: 'idscan_w_2621', action: 'register', found: [], username: 'u', password: 'p' }] }];
  mock.statuses['/api/central/idrac-scan-result'] = [410];
  await asEdge(async () => {
    await w.runIdracScanWorkerOnce();
    const last = w.getIdracScanWorkerStatus().last;
    assert.ok(last && /410/.test(last.postError || '') && /만료/.test(last.postError || ''), JSON.stringify(last));
  });
});

// ── EDGE-07 ───────────────────────────────────────────────────────────────
test('EDGE-07 — 같은 결과의 재전송은 ack 만 한다(완료 이벤트·스캔 로그 결과 줄이 한 번), 다른 결과는 반영한다', async () => {
  const jobs = await import('../src/central/idracScanJobs.js');
  const { listIdracScanLog } = await import('../src/idrac/scanLog.js');
  const reqId = jobs.enqueueIdracScan('dup-edge', { ips: '10.63.0.0/29', username: 'root', password: 'pw', datacenterId: 'DUP1' });
  jobs.takeIdracScanJobs('dup-edge');
  const body = { reqId, scanned: 6, foundCount: 1, found: [{ ip: '10.63.0.2', serviceTag: 'SYNTH1' }], unreachable: 5 };
  const [s1, r1] = await post('idrac-scan-result', body, 'dup-edge');
  const [s2, r2] = await post('idrac-scan-result', body, 'dup-edge');
  assert.equal(s1, 200); assert.equal(r1.duplicate, undefined);
  assert.equal(s2, 200); assert.equal(r2.duplicate, true);
  const rows = () => listIdracScanLog({ limit: 1000 }).filter((e) => e.reqId === reqId && e.phase === 'result');
  const doneEvents = () => jobs.getIdracScanJobLog(reqId).events.filter((e) => /^완료/.test(e.msg));
  assert.equal(rows().length, 1, '재전송이 스캔 로그 결과 줄을 두 번 남겼다');
  assert.equal(doneEvents().length, 1, "재전송이 '완료' 이벤트를 두 번 남겼다");
  // 늦게 온 진행 보고는 종료 잡을 되돌리지 않는다.
  assert.equal(jobs.setIdracScanProgress(reqId, { scanned: 1, total: 6 }), true);
  assert.equal(jobs.getIdracScanResult(reqId).state, 'done');
  assert.equal(jobs.getIdracScanResult(reqId).progress.scanned, 0, '종료 잡의 진행률이 결과보다 뒤로 갔다');
  // 다른 결과(재인출돼 다시 스캔)는 새 결과로 반영한다.
  const [s3, r3] = await post('idrac-scan-result', { ...body, foundCount: 2, found: [...body.found, { ip: '10.63.0.3' }] }, 'dup-edge');
  assert.equal(s3, 200); assert.equal(r3.duplicate, undefined);
  assert.equal(jobs.getIdracScanResult(reqId).foundCount, 2);
  assert.equal(rows().length, 2);
});

// ── EDGE-03 ───────────────────────────────────────────────────────────────
test('EDGE-03 — 스토리지 push: 등록부 손상이면 빈 목록으로 중앙을 비우지 않고 registry-unreadable 상태만 올린다', async () => {
  const reg = await import('../src/storage/registry.js');
  const st = await import('../src/storage/store.js');
  const push = await import('../src/storage/push.js');
  corrupt('storage-devices.json'); reg._resetForTest(); st._resetForTest();
  try {
    assert.ok(reg.registryLoadError(), '손상 등록부는 registryLoadError 로 알린다');
    assert.equal(reg.devicesForThisNode().length, 0, '(전제) 손상 등록부는 던지지 않고 빈 목록이다');
    mock.reqs.length = 0;
    const r = await asEdge(() => push.pushStorageNow());
    const sent = reqsTo('/api/central/storage-data');
    assert.ok(sent.length >= 1, JSON.stringify(mock.reqs));
    assert.ok(sent.every((x) => x.body?.statusOnly === true), `빈 목록(비우기)을 보냈다: ${JSON.stringify(sent.map((x) => x.body))}`);
    assert.equal(sent[0].body.status.reason, 'registry-unreadable');
    assert.equal(sent[0].body.status.registered, null);
    assert.equal(r.cleared, undefined);
    assert.match(push.storagePushStatus().reason || '', /등록부를 읽지 못해/);
  } finally { restore('storage-devices.json'); reg._resetForTest(); }
});

test('EDGE-03 — SAN 스위치 push: 등록부 손상이면 빈 청크 0 을 보내지 않는다', async () => {
  const reg = await import('../src/sanswitch/registry.js');
  const st = await import('../src/sanswitch/store.js');
  const push = await import('../src/sanswitch/push.js');
  corrupt('sanswitch-devices.json'); reg._resetForTest(); st._resetForTest();
  try {
    assert.ok(reg.registryLoadError());
    mock.reqs.length = 0;
    const r = await asEdge(() => push.pushSanSwitchNow());
    const sent = reqsTo('/api/central/sanswitch-data');
    assert.ok(sent.length >= 1, JSON.stringify(mock.reqs));
    assert.ok(sent.every((x) => x.body?.statusOnly === true), `빈 목록(비우기)을 보냈다: ${JSON.stringify(sent.map((x) => x.body))}`);
    assert.equal(sent[0].body.status.reason, 'registry-unreadable');
    assert.equal(r.cleared, undefined);
    assert.ok(!/중앙 목록을 비웠습니다/.test(push.sanSwitchPushStatus().reason || '') && /등록부를 읽지 못해/.test(push.sanSwitchPushStatus().reason || ''), push.sanSwitchPushStatus().reason);
  } finally { restore('sanswitch-devices.json'); reg._resetForTest(); }
});

test('EDGE-03 — PDU push: 등록부 손상이면 빈 snapshots 로 중앙 목록을 비우지 않는다', async () => {
  const reg = await import('../src/pdu/registry.js');
  const poller = await import('../src/pdu/poller.js');
  const push = await import('../src/pdu/push.js');
  corrupt('pdu-devices.json'); reg._resetForTest(); poller._resetForTest();
  try {
    assert.ok(reg.registryLoadError());
    mock.reqs.length = 0;
    const r = await asEdge(() => push.pushPduNow());
    const sent = reqsTo('/api/central/pdu-data');
    assert.ok(sent.every((x) => x.body?.statusOnly === true), `빈 snapshots(비우기)를 보냈다: ${JSON.stringify(sent.map((x) => x.body))}`);
    assert.ok(sent.length >= 1 && sent[0].body.status.reason === 'registry-unreadable', JSON.stringify(sent));
    assert.equal(r.withheld, true);
    const s = push.pduPushStatus();
    assert.ok(!/중앙 목록을 비웠습니다/.test(s.reason || '') && s.registryError, JSON.stringify(s));
  } finally { restore('pdu-devices.json'); reg._resetForTest(); }
});

// ── EDGE-04 ───────────────────────────────────────────────────────────────
test('EDGE-04 — part-faults: 중앙 스토리지 등록부 손상이면 스토리지 보고는 503, iDRAC 만 있는 보고는 받는다', async () => {
  const reg = await import('../src/storage/registry.js');
  const pfe = await import('../src/central/partFaultEdge.js');
  const idracOnly = { agent: 'edge-pf', v: 2, devices: [{ scope: 'idrac', deviceId: 'srv1', deviceKey: 'SYNTAG1', ok: true, open: [], states: { ok: ['psu:PSU.Slot.1'] } }] };
  const withStorage = { agent: 'edge-pf', v: 2, devices: [{ scope: 'storage', deviceId: 'st1', ok: true, open: [{ kind: 'disk', partId: 'DAE0_0', state: 'fault', keyKind: 'slot' }], states: {} }] };
  corrupt('storage-devices.json'); reg._resetForTest();
  try {
    assert.ok(reg.registryLoadError());
    const [s0] = await post('part-faults', idracOnly, 'edge-pf');
    assert.equal(s0, 200, 'iDRAC 만 있는 보고는 등록부를 쓰지 않으므로 받는다');
    const [s1, b1] = await post('part-faults', withStorage, 'edge-pf');
    assert.equal(s1, 503, '손상 등록부로 전부 미소유 처리하고 200 을 주면 안 된다');
    assert.equal(b1.reason, 'registryUnreadable');
    const rep = pfe.edgeReport('edge-pf');
    assert.equal(rep.devices[0].scope, 'idrac', '503 이면 직전 보고가 남는다(교체되지 않는다)');
    assert.equal(rep.rejected, 0);
    // 순수 함수도 같은 판정
    const r = await pfe.putEdgeReport('edge-pf', withStorage);
    assert.equal(r.ok, false); assert.equal(r.registryUnreadable.scope, 'storage');
  } finally { restore('storage-devices.json'); reg._resetForTest(); }
  // 복구 뒤에는 예전 규칙(소유 확인)으로 받는다 — 등록되지 않은 장비는 rejected
  const [s2, b2] = await post('part-faults', withStorage, 'edge-pf');
  assert.equal(s2, 200); assert.equal(b2.rejected, 1);
});

// ── EDGE-06 ───────────────────────────────────────────────────────────────
test('EDGE-06 — collectRequestQueue seen 은 상한이 있고, 대기 중인 요청의 기준선은 버리지 않는다', async () => {
  const { createCollectRequestQueue, SEEN_MAX } = await import('../src/util/collectRequestQueue.js');
  const q = createCollectRequestQueue({ ackMs: 60_000, seenMax: 100 });
  const EDGE_T = 5_000_000;
  q.ack('keep', EDGE_T);
  q.request('keep', 'edge-a', T0);
  for (let i = 0; i < 5_000; i++) q.ack(`bogus-${i}-${'x'.repeat(40)}`, EDGE_T + i);
  const st = q.seenStats();
  assert.ok(st.size <= 101, `seen 이 상한 없이 쌓였다: ${st.size}`);
  assert.ok(st.evicted >= 4_800);
  // 대기 중인 요청(keep)의 기준선은 남아 있다 — 인출 뒤 같은 수집은 완료가 아니다.
  assert.deepEqual(q.take('edge-a', T0 + 1, 20), ['keep']);
  assert.equal(q.ack('keep', EDGE_T), false, '기준선이 밀려나 요청 이전 수집을 완료로 받았다');
  assert.equal(q.ack('keep', EDGE_T + 1), true);
  // 기본 상한도 있다
  const d = createCollectRequestQueue();
  for (let i = 0; i < SEEN_MAX + 3_000; i++) d.ack(`id-${i}`, i + 1);
  assert.ok(d.seenStats().size <= SEEN_MAX);
});

// ── RECENT-09 ─────────────────────────────────────────────────────────────
test('RECENT-09 — dropLargestFiles 는 목표 크기를 주면 초과분을 덮을 만큼만 뺀다(최소 1개)', async () => {
  const { dropLargestFiles } = await import('../src/agent/configPush.js');
  const files = { 'a.json': 'x'.repeat(10_000), 'b.json': 'x'.repeat(1_000), 'c.json': 'x'.repeat(100) };
  assert.deepEqual(dropLargestFiles(files, 8, { targetBytes: 5_000 }).dropped.map((f) => f.name), ['a.json']);
  assert.deepEqual(dropLargestFiles(files, 8, { targetBytes: 500 }).dropped.map((f) => f.name), ['a.json', 'b.json']);
  assert.deepEqual(dropLargestFiles(files, 8, { targetBytes: 1e9 }).dropped.map((f) => f.name), ['a.json'], '413 이 났으면 최소 1개는 뺀다');
  assert.deepEqual(Object.keys(dropLargestFiles({ 'only.json': '{}' }, 8, { targetBytes: 1 }).files), ['only.json']);
});

test('RECENT-09 — 엣지: 413 재전송은 뺀 파일 이름(retainFiles)을 싣고, 구버전 중앙(retained 없음)이면 그 사실을 상태에 남긴다', async () => {
  const m = await import('../src/agent/configPush.js');
  fs.writeFileSync(path.join(DIR, 'big-2621.json'), JSON.stringify({ blob: 'y'.repeat(500_000) }));
  fs.writeFileSync(path.join(DIR, 'small-2621.json'), '{"a":1}');
  try {
    await asEdge(async () => {
      m._resetConfigPush();
      mock.reqs.length = 0;
      mock.statuses['/api/central/agent-config'] = [413, 200];
      mock.replies['/api/central/agent-config'] = [{ ok: false }, { ok: true, retained: 1, retainMissing: 0 }];
      assert.equal(await m.pushConfigNow(), true);
      const posts = reqsTo('/api/central/agent-config');
      assert.equal(posts.length, 2);
      assert.equal(posts[1].body.partial, true);
      assert.deepEqual(posts[1].body.retainFiles, ['big-2621.json'], '초과분을 덮을 만큼만(가장 큰 1개) 빼고 그 이름을 싣는다');
      assert.ok(posts[1].body.files['small-2621.json'], '한도와 무관한 작은 파일은 빼지 않는다');
      assert.equal(m.configPushStatus().last.centralRetained, 1);

      m._resetConfigPush();
      mock.reqs.length = 0;
      mock.statuses['/api/central/agent-config'] = [413, 200];
      mock.replies['/api/central/agent-config'] = [{ ok: false }, { ok: true }];
      assert.equal(await m.pushConfigNow(), true);
      assert.equal(m.configPushStatus().last.centralRetainUnsupported, true, '구버전 중앙이 사본을 교체한 사실을 밝혀야 한다');
    });
  } finally {
    fs.rmSync(path.join(DIR, 'big-2621.json'), { force: true });
    fs.rmSync(path.join(DIR, 'small-2621.json'), { force: true });
  }
});

test('RECENT-09 — 중앙: retainFiles 로 받은 이름은 직전 사본을 유지하고(낡음 표시), retainFiles 없는 push 는 예전처럼 교체한다', async () => {
  const ac = await import('../src/central/agentConfig.js');
  const [s0] = await post('agent-config', { agent: 'edge-cfg', files: { 'a.json': '{"v":1}', 'big.json': '{"blob":"OLD"}' } }, 'edge-cfg');
  assert.equal(s0, 200);
  const firstAt = ac.getAllAgentConfigs()['edge-cfg'].at;
  const [s1, b1] = await post('agent-config', { agent: 'edge-cfg', partial: true, retainFiles: ['big.json', 'never.json'], files: { 'a.json': '{"v":2}' } }, 'edge-cfg');
  assert.equal(s1, 200);
  assert.equal(b1.retained, 1); assert.equal(b1.retainMissing, 1);
  const e = ac.getAllAgentConfigs()['edge-cfg'];
  assert.equal(e.files['big.json'], '{"blob":"OLD"}', '413 으로 뺀 파일의 직전 사본이 지워졌다');
  assert.equal(e.files['a.json'], '{"v":2}');
  assert.deepEqual(e.retained, [{ name: 'big.json', since: firstAt }]);
  assert.equal(ac.listAgentConfigs().find((x) => x.agent === 'edge-cfg').retained, 1);
  // retainFiles 없는 push(전체 목록)는 교체 — 엣지에서 지운 파일은 사라진다
  const [s2, b2] = await post('agent-config', { agent: 'edge-cfg', files: { 'a.json': '{"v":3}' } }, 'edge-cfg');
  assert.equal(s2, 200); assert.equal(b2.retained, undefined);
  assert.equal(ac.getAllAgentConfigs()['edge-cfg'].files['big.json'], undefined);
  assert.equal(ac.getAllAgentConfigs()['edge-cfg'].retained, undefined);
});

// ── LIFE-01 ───────────────────────────────────────────────────────────────
test('LIFE-01 — 할당 스캐너는 iDRAC 스캔 공용 잠금을 공유한다(잡혀 있으면 이번 주기를 건너뛰고 사유를 남긴다)', async () => {
  const sp = await import('../src/idrac/scanPoller.js');
  const sc = await import('../src/agent/scanner.js');
  await asEdge(async () => {
    const lock = sp.tryAcquireScan('adhoc');
    assert.equal(lock.ok, true);
    mock.reqs.length = 0;
    let last;
    try { last = await sc.runAgentScan(); } finally { sp.releaseScan(); }
    assert.ok(last?.skippedBusy, `잠금이 잡혀 있는데 스캔했다: ${JSON.stringify(last)}`);
    assert.equal(reqsTo('/api/central/result').length, 0, '잠금 중에 스캔 결과를 보냈다(= 스캔이 돌았다)');
    // 잠금이 풀리면 돈다 — 그리고 끝나면 잠금을 푼다.
    mock.reqs.length = 0;
    const last2 = await sc.runAgentScan();
    assert.equal(last2.skippedBusy, undefined, JSON.stringify(last2));
    assert.equal(reqsTo('/api/central/result').length, 1);
    assert.equal(sp.scanLockBusy(), null, '할당 스캔이 잠금을 풀지 않았다');
  });
});
