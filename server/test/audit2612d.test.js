// v2.612 감사 그룹 D — 엣지↔중앙 계약 확정분의 회귀 고정.
//   EDGE2612-01 중앙→엣지 PUSH 재시도 금지 + 엣지 단일 비행(409 busy) · EDGE2612-02 재수집 push 실패 기록 ·
//   EDGE2612-03 svcmon 413 축소 한도 소진은 실패 · CEN2612-01 위임 0건 엣지의 CVP 상태 미보관 ·
//   LEFT2612-01 중앙 등록부 손상 시 설정 pull 503.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2612d-'));
process.env.CONFIG_DIR = tmp;
process.env.CENTRAL_TOKEN = 'ctok-2612d';
process.env.COLLECTOR_TOKEN = 'coltok-2612d';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.SVCMON_PUSH_CHUNK = '1000000000'; // EDGE2612-03: 상한 없는 시작 청크
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// LEFT2612-01: 중앙 등록부 5종을 **손상된 채로** 둔다(모듈을 불러오기 전에 — agentUsers 는 모듈 로드 시 읽는다).
for (const f of ['storage-devices.json', 'sanswitch-devices.json', 'pdu-devices.json', 'cvp-servers.json', 'central-agent-users.json']) {
  fs.writeFileSync(path.join(tmp, f), '{ 손상된 JSON');
}

const servers = [];
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
let centralPort; let collectorPort;
before(async () => {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const { collectorRouter } = await import('../src/routes/collector.js');
  const app = express();
  app.use('/api/central', express.json({ limit: '16mb' }), centralRouter);
  app.use('/api/collector', collectorRouter);
  const srv = http.createServer(app);
  servers.push(srv);
  centralPort = await listen(srv);
  collectorPort = centralPort;
});
after(() => { for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch { /* */ } } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const cget = (p) => fetch(`http://127.0.0.1:${centralPort}/api/central${p}`, { headers: { 'X-Central-Token': 'ctok-2612d', 'X-Agent-Name': 'edge-a' } });

// ── LEFT2612-01 ───────────────────────────────────────────────────────────
test('LEFT2612-01: 중앙 등록부가 손상됐으면 설정 pull 5종이 503(빈 목록 ok:true 금지) — 재수집 큐는 꺼내지 않는다', async () => {
  const cr = await import('../src/storage/collectRequests.js');
  cr.requestCollect('st-1', 'edge-a');
  for (const p of ['/storage-config', '/sanswitch-config', '/pdu-config', '/cvp-config', '/users-config']) {
    const r = await cget(`${p}?agent=edge-a`);
    const j = await r.json();
    assert.equal(r.status, 503, `${p} 는 503 이어야 한다 — ${JSON.stringify(j)}`);
    assert.equal(j.ok, false);
    assert.equal(j.reason, 'registryUnreadable');
    assert.ok(!('devices' in j) && !('servers' in j) && !('users' in j), '빈 목록을 싣지 않는다');
  }
  // 503 앞에서 큐를 꺼내지 않았다 — 요청이 그대로 남아 있다(다음 정상 pull 이 가져간다)
  assert.ok(cr.hasPendingRequest('st-1'), '503 응답이 재수집 요청을 소비하면 안 된다');
  assert.equal(cr.takeRequestsForAgent('edge-a').length, 1);
});

test('LEFT2612-01: 재시작 뒤(파일 없음 + 손상 보존본만)에도 503 — 유효한 파일이 생기면 200', async () => {
  const reg = await import('../src/storage/registry.js');
  reg._resetForTest(); // 재시작 흉내 — 첫 로드가 손상본을 .corrupt.* 로 옮겨 파일이 없다
  assert.ok(!fs.existsSync(path.join(tmp, 'storage-devices.json')));
  assert.ok(fs.readdirSync(tmp).some((n) => n.startsWith('storage-devices.json.corrupt.')));
  let r = await cget('/storage-config?agent=edge-a');
  assert.equal(r.status, 503, '보존본만 있으면 여전히 못 읽은 것이다');
  fs.writeFileSync(path.join(tmp, 'storage-devices.json'), JSON.stringify({ version: 1, devices: [] }));
  reg._resetForTest();
  r = await cget('/storage-config?agent=edge-a');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  assert.equal(reg.registryLoadError(), null);
});

test('LEFT2612-01: 엣지 pull 은 비-2xx 를 실패로 본다(직전 목록 유지) — 소스 확인', () => {
  for (const f of ['agent/storageConfigPull.js', 'agent/pduConfigPull.js', 'agent/sanSwitchConfigPull.js', 'agent/cvpConfigPull.js', 'agent/usersConfigPull.js']) {
    assert.match(stripComments(read(f)), /if \(!res\.ok\)[^\n]*throw new Error/, `${f}: 비-2xx 는 throw`);
  }
});

// ── CEN2612-01 ────────────────────────────────────────────────────────────
test('CEN2612-01: 위임된 CVP 가 없는 엣지의 cvp-data 는 보관하지 않는다(noDelegation) · 예전 보관분은 지운다', async () => {
  fs.writeFileSync(path.join(tmp, 'cvp-servers.json'), JSON.stringify({ version: 1, servers: [] }));
  const reg = await import('../src/cvp/registry.js');
  reg._resetForTest();
  const edge = await import('../src/central/cvpEdge.js');
  // 예전(위임 해제 전) 보관분이 있다고 치자
  edge.saveEdgeCvpStatus('edge-z', [], {});
  assert.ok(edge.edgeCvpSummary().some((e) => e.agent === 'edge-z'));
  const r = await fetch(`http://127.0.0.1:${centralPort}/api/central/cvp-data`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': 'ctok-2612d', 'X-Agent-Name': 'EDGE-Z' },
    body: JSON.stringify({ agent: 'EDGE-Z', chunk: 0, chunks: 1, servers: [], devices: [], rows: [] }),
  });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.ok, true);
  assert.equal(j.noDelegation, true);
  assert.equal(j.statusRemoved, 1, '대소문자만 다른 옛 보관분도 지운다');
  assert.ok(!edge.edgeCvpSummary().some((e) => e.agent.toLowerCase() === 'edge-z'), '위임 0건 엣지가 보관 칸을 차지하지 않는다');
  // 다시 보내도 새로 생기지 않는다
  await fetch(`http://127.0.0.1:${centralPort}/api/central/cvp-data`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': 'ctok-2612d', 'X-Agent-Name': 'edge-y' },
    body: JSON.stringify({ agent: 'edge-y', chunk: 0, chunks: 1, servers: [] }),
  });
  assert.ok(!edge.edgeCvpSummary().some((e) => e.agent === 'edge-y'));
});

// ── EDGE2612-01 ───────────────────────────────────────────────────────────
test('EDGE2612-01: 엣지 /idrac-scan 은 다른 스캔(주기·폴링 위임)이 진행 중이면 409 busy — 같은 잠금을 쓴다', async () => {
  const sp = await import('../src/idrac/scanPoller.js');
  const lock = sp.tryAcquireScan('periodic');
  assert.equal(lock.ok, true);
  try {
    const r = await fetch(`http://127.0.0.1:${collectorPort}/api/collector/idrac-scan`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Collector-Token': 'coltok-2612d' },
      body: JSON.stringify({ ips: '127.0.0.1', username: 'root', password: 'pw' }),
    });
    const j = await r.json();
    assert.equal(r.status, 409);
    assert.equal(j.busy, true);
    assert.match(j.reason, /주기 스캔/);
    assert.ok(sp.scanLockBusy(), '409 로 끝나도 남의 잠금을 풀지 않는다');
  } finally { sp.releaseScan(); }
  assert.equal(sp.scanLockBusy(), null);
});

test('EDGE2612-01: 폴링 워커는 잠금이 잡혀 있으면 중앙 잡을 인출하지 않는다', async () => {
  const { config } = await import('../src/config.js');
  const sp = await import('../src/idrac/scanPoller.js');
  const w = await import('../src/agent/idracScanWorker.js');
  let polls = 0;
  const srv = http.createServer((req, res) => { polls++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jobs: [] })); });
  servers.push(srv);
  const port = await listen(srv);
  const prev = config.agent.centralUrl;
  config.agent.centralUrl = `http://127.0.0.1:${port}`;
  try {
    sp.tryAcquireScan('push');
    await w.runIdracScanWorkerOnce();
    assert.equal(polls, 0, '스캔 중에는 인출하지 않는다(잡은 중앙 대기열에 남는다)');
    assert.ok(w.getIdracScanWorkerStatus().lastSkipBusy);
    sp.releaseScan();
    await w.runIdracScanWorkerOnce();
    assert.equal(polls, 1);
  } finally { sp.releaseScan(); config.agent.centralUrl = prev; }
});

test('EDGE2612-01: 엣지 /bmstor-collect 는 앞 요청이 진행 중이면 409 busy', async () => {
  // 배너를 보내지 않는 SSH 흉내 — 첫 요청이 접속 대기에 머문다.
  const socks = [];
  const hang = net.createServer((s) => { socks.push(s); s.on('error', () => {}); });
  servers.push(hang);
  const hp = await listen(hang);
  const body = JSON.stringify({ servers: [{ id: 'b1', host: '127.0.0.1', port: hp, username: 'u', password: 'p', mounts: ['/'] }] });
  const post = () => fetch(`http://127.0.0.1:${collectorPort}/api/collector/bmstor-collect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Collector-Token': 'coltok-2612d' }, body,
  });
  const first = post();
  for (let i = 0; i < 100 && !socks.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(socks.length, '첫 요청이 SSH 접속을 시작했다');
  const r2 = await post();
  const j2 = await r2.json();
  assert.equal(r2.status, 409);
  assert.equal(j2.busy, true);
  for (const s of socks) s.destroy();
  const r1 = await first;
  assert.equal(r1.status, 200, '첫 요청은 결과(실패 사유)를 돌려준다');
  await r1.json();
  // 잠금이 풀렸다 — 다음 요청은 409 가 아니다
  hang.close();
  const r3 = await post();
  assert.notEqual(r3.status, 409);
  await r3.json();
});

test('EDGE2612-01: 중앙 PUSH 는 재시도하지 않고(retries 0) 409 를 \'이미 수행 중\' 으로 남긴다', async () => {
  let hits = 0;
  const edge = http.createServer((req, res) => {
    hits++;
    res.statusCode = req.headers['x-mode'] === '500' ? 500 : 409;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, busy: true, reason: '주기 스캔이 진행 중입니다' }));
  });
  servers.push(edge);
  const port = await listen(edge);
  fs.writeFileSync(path.join(tmp, 'collectors.json'), JSON.stringify({ collectors: [{ id: 'edge-p', name: 'edge-p', url: `http://127.0.0.1:${port}`, token: 't' }] }));
  const push = await import('../src/central/idracScanPush.js');
  const jobs = await import('../src/central/idracScanJobs.js');
  const r = push.pushIdracScan('edge-p', { ips: '10.0.0.1', username: 'root', password: 'pw' });
  assert.equal(r.ok, true, JSON.stringify(r));
  let res = null;
  for (let i = 0; i < 100; i++) { res = jobs.getIdracScanResult(r.reqId); if (res?.state === 'done' || res?.error || res?.result?.error) break; await new Promise((x) => setTimeout(x, 20)); }
  const err = JSON.stringify(res);
  assert.match(err, /이미 수행 중/, err);
  assert.equal(hits, 1, '한 번만 보낸다');
  // bmstor 쪽은 소스로 — 재시도 0 과 409 분기
  const bm = stripComments(read('bmstor/poller.js'));
  assert.match(bm, /bmstor-collect[\s\S]{0,600}retries: 0/);
  assert.match(bm, /r\.status === 409\)[^\n]*이미 수행 중/);
  assert.match(stripComments(read('central/idracScanPush.js')), /idrac-scan[\s\S]{0,1500}retries: 0/);
});

// ── EDGE2612-02 ───────────────────────────────────────────────────────────
test('EDGE2612-02: 재수집 push 의 {ok:false} 반환도 pushError 로 남긴다(pdu·storage)', () => {
  const pdu = stripComments(read('agent/pduConfigPull.js'));
  assert.match(pdu, /const pr = await pushPduNow\(\);\s*if \(pr && pr\.ok === false\) \{ pushError =/);
  const st = stripComments(read('agent/storageConfigPull.js'));
  assert.match(st, /const pr = await pushStorageNow\(\);\s*if \(pr && pr\.ok === false\) pushError =/);
  assert.match(st, /_last = \{[^\n]*pushError/);
});

test('EDGE2612-02: 실제 호출 — 중앙이 push 를 거절하면 pdu pull 상태에 pushError', async () => {
  const { config } = await import('../src/config.js');
  const pull = await import('../src/agent/pduConfigPull.js');
  const central = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/api/central/pdu-config')) return res.end(JSON.stringify({ ok: true, devices: [], collectNow: ['nope'], intervals: {} }));
    res.statusCode = 403; res.end(JSON.stringify({ ok: false, reason: '거부' }));
  });
  servers.push(central);
  const port = await listen(central);
  const prev = { u: config.agent.centralUrl, t: config.agent.centralToken };
  config.agent.centralUrl = `http://127.0.0.1:${port}`; config.agent.centralToken = 'x';
  try {
    const r = await pull.pullPduConfigNow();
    assert.equal(r.ok, true, JSON.stringify(r));
    // 위임 0대 → 빈 목록 push 를 중앙이 403 으로 거절한다 — pushPduNow 는 던지지 않고 {ok:false} 를 돌려준다.
    const st = pull.pduConfigPullStatus();
    assert.ok(st.pushError, `재수집 push 가 거절됐는데 pushError 가 비었다 — ${JSON.stringify(st)}`);
    assert.match(st.pushError, /403/);
  } finally { config.agent.centralUrl = prev.u; config.agent.centralToken = prev.t; }
});

// ── EDGE2612-03 ───────────────────────────────────────────────────────────
test('EDGE2612-03: svcmon 413 축소 한도를 다 쓰면 errors 에 남기고(ok:false) 시작 청크는 상한 안', () => {
  const s = stripComments(read('agent/svcmonPush.js'));
  assert.match(s, /const CHUNK_START = Math\.min\(CHUNK_MAX,/);
  const max = Number(/const CHUNK_MAX = ([\d_]+);/.exec(s)[1].replace(/_/g, ''));
  const min = Number(/const CHUNK_MIN = (\d+);/.exec(s)[1]);
  // 8회(매번 절반) 안에 하한에 닿아야 한다 — 닿지 못하면 한도 소진이 곧 부분 전송이다.
  let n = max; let steps = 0; while (n > min && steps < 8) { n = Math.max(min, Math.floor(n / 2)); steps++; }
  assert.equal(n, min, `상한 ${max} 에서 8회 안에 하한 ${min} 에 닿아야 한다`);
  assert.match(s, /if \(shrink\) errors\.push\(/);
  assert.match(s, /let shrink = false;\s*for \(let attempt = 0;/);
});

test('EDGE2612-03: 실제 호출 — 중앙이 계속 413 이면 pushSvcmonNow 는 ok:false 와 사유를 남긴다', async () => {
  const { config } = await import('../src/config.js');
  const sv = await import('../src/agent/svcmonPush.js');
  let hits = 0;
  const central = http.createServer((req, res) => { hits++; req.resume(); req.on('end', () => { res.statusCode = 413; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: false, reason: 'too large' })); }); });
  servers.push(central);
  const port = await listen(central);
  const prev = { u: config.agent.centralUrl, t: config.agent.centralToken };
  config.agent.centralUrl = `http://127.0.0.1:${port}`; config.agent.centralToken = 'x';
  try {
    const r = await sv.pushSvcmonNow();
    assert.equal(r.ok, false, `계속 413 인데 성공으로 보고했다 — ${JSON.stringify(r)}`);
    assert.ok(r.errors.length >= 1);
    assert.ok(r.chunkRows <= 20_000, '시작 청크가 상한 안이다');
    assert.ok(hits >= 2);
  } finally { config.agent.centralUrl = prev.u; config.agent.centralToken = prev.t; }
});
