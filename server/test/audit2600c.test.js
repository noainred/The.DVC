/**
 * test/audit2600c.test.js — v2.600 감사 그룹 c(중앙 결과 저장소 + 엣지 워커/푸시) 회귀.
 *
 * 전부 실제 함수를 호출해 동작으로 본다. push·pull 은 목 HTTP 중앙에 실제로 보내 본문 도착까지 확인한다
 * (v2.566 규약 — 순수 헬퍼만 고정하는 테스트는 push 함수가 통째로 죽는 종류를 못 잡는다).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2600c-'));
// EDGE2600-05·LO2600-04: 잘못된 주기 env 가 1ms 루프가 되지 않는지 — 모듈 로드 전에 넣는다.
process.env.AGENT_CONFIG_PUSH_MS = '-1';
process.env.AGENT_CURUSER_CONFIG_PULL_MS = '3000000000';
process.env.AGENT_VMSERIES_CONFIG_PULL_MS = '-5';
process.env.AGENT_PARTFAULT_CONFIG_PULL_MS = '3000000000';
process.env.PARTFAULT_PUSH_MS = '3000000000';
process.env.SANSW_CONFIG_PULL_MS = '3000000000';
process.env.SVCMON_CONFIG_PULL_MS = '3000000000';
process.env.AGENT_PUSH_GZIP = 'true';

const T0 = 1_700_000_000_000; // 기준 시각(Date.now 를 쓰지 않는다)

function mockCentral(handler) {
  const got = [];
  const srv = http.createServer((req, res) => {
    const bufs = [];
    req.on('data', (c) => bufs.push(c));
    req.on('end', () => {
      let raw = Buffer.concat(bufs);
      if (req.headers['content-encoding'] === 'gzip') { try { raw = zlib.gunzipSync(raw); } catch { /* 그대로 */ } }
      let body = null; try { body = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { body = null; }
      got.push({ method: req.method, url: req.url, body, bytes: raw.length });
      const out = handler ? handler(req, body) : null;
      const { status = 200, json = { ok: true }, html } = out || {};
      if (html != null) { res.writeHead(status, { 'Content-Type': 'text/html' }); res.end(html); return; }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  return { srv, got };
}
const listen = async (srv) => { await new Promise((r) => srv.listen(0, '127.0.0.1', r)); return srv.address().port; };

// ── CEN2600-04 ────────────────────────────────────────────────────────────────
test('CEN2600-04: ping 결과 바깥 Map 은 상한·키 길이·빈 보고를 지킨다', async () => {
  const pj = await import('../src/central/pingJobs.js');
  const before = pj._pingResultVcCount();
  pj.setPingResults('x'.repeat(2000), [{ ip: '10.0.0.1', alive: true }]);
  assert.equal(pj._pingResultVcCount(), before, '128자를 넘는 vcenterId 는 받지 않는다');
  pj.setPingResults({ toString: () => 'vc' }, [{ ip: '10.0.0.1', alive: true }]);
  assert.equal(pj._pingResultVcCount(), before, '문자열이 아닌 vcenterId 는 받지 않는다');
  pj.setPingResults('vc-empty', []);
  assert.equal(pj._pingResultVcCount(), before, '빈 보고는 바깥 키를 만들지 않는다');
  for (let i = 0; i < 400; i++) pj.setPingResults(`vc-${i}`, [{ ip: '10.0.0.1', alive: true }]);
  assert.ok(pj._pingResultVcCount() <= 256, `바깥 Map 상한 — 실제 ${pj._pingResultVcCount()}`);
  // 가장 최근 보고한 vCenter 는 남는다(오래된 것부터 밀린다).
  assert.equal(pj.getPingResults('vc-399', ['10.0.0.1'])['10.0.0.1'].state, 'up');
  // rttMs 원문 객체는 싣지 않는다.
  pj.setPingResults('vc-rtt', [{ ip: '10.0.0.9', alive: true, rttMs: { evil: 1 } }]);
  assert.equal(pj.getPingResults('vc-rtt', ['10.0.0.9'])['10.0.0.9'].rttMs, null);
});

// ── CEN2600-05 · CEN2600-09 ──────────────────────────────────────────────────
test('CEN2600-05: 캡처 이력은 아는 필드만 담고(객체 hostB·90만 자 issue 차단) 옛 파일도 정제해 읽는다', async () => {
  const file = path.join(process.env.CONFIG_DIR, 'capture-history.json');
  // 정제 이전에 저장된 레코드(객체 hostB)가 이미 파일에 있다.
  fs.writeFileSync(file, JSON.stringify([{ id: 'cap_old', at: T0, mode: 'single', hostA: '', hostB: { evil: 1 }, issues: [{ sev: 'x', title: { o: 1 } }], detail: { stat: { packets: { o: 1 } } } }]));
  const ch = await import('../src/net/captureHistory.js');
  const old = ch.listCaptures().find((r) => r.id === 'cap_old');
  assert.equal(typeof old.hostB, 'string', '옛 파일의 객체 hostB 도 문자열로 읽힌다');
  assert.equal(typeof old.issues[0].title, 'string');
  assert.equal(ch.getCapture('cap_old').detail.stat.packets, null);

  const rec = ch.recordCapture({ ok: true, peer: { evil: 1 }, analysis: { stat: { packets: { o: 1 }, rst: '3' }, issues: [{ sev: 'error', msg: 'i'.repeat(900_000) }] } }, { source: 'manual', via: 'agent' });
  assert.equal(rec.hostB, '');
  assert.equal(rec.detail.stat.packets, null, '객체 수치는 null(0 이 아니다)');
  assert.equal(rec.detail.stat.rst, 3);
  assert.ok(rec.issues[0].detail.length <= 500);
  assert.ok(fs.statSync(file).size < 20_000, `파일 크기 ${fs.statSync(file).size}B`);
  const many = ch.sanitizeCaptureResult({ ok: true, analysis: { issues: Array.from({ length: 200 }, () => ({ sev: 'ok', title: 't' })) } });
  assert.equal(many.analysis.issues.length, 50);
});

test('CEN2600-09: 위임 단일 캡처 이력의 hostA 를 엣지 결과(hostA)로 채운다', async () => {
  const ch = await import('../src/net/captureHistory.js');
  const rec = ch.recordCapture({ ok: true, hostA: '10.1.1.1', peer: '10.2.2.2', analysis: { stat: { packets: 5 }, issues: [] } }, { source: 'manual', via: 'agent' });
  assert.equal(rec.hostA, '10.1.1.1');
  assert.equal(rec.hostB, '10.2.2.2');
  // 중앙 직접 경로(meta.hostA)가 있으면 그것이 먼저다.
  const rec2 = ch.recordCapture({ ok: true, hostA: 'x', peer: 'p', analysis: {} }, { hostA: '10.9.9.9' });
  assert.equal(rec2.hostA, '10.9.9.9');
});

// ── CEN2600-06 ────────────────────────────────────────────────────────────────
test('CEN2600-06: iDRAC 스캔 결과의 error·수치·found 원문을 정제해 저장한다', async () => {
  const sj = await import('../src/central/idracScanJobs.js');
  const reqId = sj.enqueueIdracScan('edgeA', { ips: '10.0.0.1-10.0.0.3', username: 'u', password: 'p' });
  sj.takeIdracScanJobs('edgeA');
  sj.setIdracScanResult(reqId, { error: { a: 1 }, foundCount: { x: 1 }, registered: ['r'], authFailReason: { o: 1 }, found: [{ ip: '10.0.0.1', model: { o: 1 }, junk: 'x'.repeat(10_000) }, null, 'str'] });
  const row = sj.listIdracScanJobs().find((j) => j.reqId === reqId);
  assert.equal(row.result.error, null, '객체 error 는 저장하지 않는다(화면 .slice TypeError·React #31 차단)');
  assert.equal(typeof row.result.foundCount, 'number');
  assert.equal(typeof row.result.registered, 'number');
  const full = sj.getIdracScanResult(reqId);
  assert.equal(full.authFailReason, null);
  assert.deepEqual(Object.keys(full.found[0]).sort(), ['hostName', 'ip', 'manufacturer', 'model', 'serviceTag']);
  assert.equal(full.found[0].model, '');
  assert.equal(full.found.length, 1, 'null·문자열 원소는 버린다');
  const s = sj.sanitizeIdracScanData({ error: 'x'.repeat(9000), scanned: '12', blocked: -3 });
  assert.equal(s.error.length, 500);
  assert.equal(s.scanned, 12);
  assert.equal(s.blocked, null);
});

// ── CEN2600-07 ────────────────────────────────────────────────────────────────
test('CEN2600-07: 로그 연합 조회 결과는 로그 DB 행 모양으로 투사하고 모르는 reqId 는 받지 않는다', async () => {
  const lq = await import('../src/central/logQueries.js');
  const reqId = lq.enqueueLogQuery('vc-a', { limit: 10 }, 'alice');
  lq.takeLogQueries(['vc-a']);
  assert.equal(lq.setLogQueryResult(reqId, { total: { n: 1 }, dbKind: { o: 1 }, rows: [{ message: { evil: true }, vcenterId: { x: 1 }, ts: '1700000000000', extra: 'x' }, null] }), true);
  const r = lq.getLogQueryResult(reqId);
  assert.equal(r.state, 'done');
  assert.equal(r.total, null, '객체 total 은 null');
  assert.equal(r.dbKind, '');
  assert.equal(r.rows.length, 1);
  assert.deepEqual(Object.keys(r.rows[0]).sort(), ['entity', 'message', 'severity', 'ts', 'type', 'user', 'vcenterId']);
  assert.equal(r.rows[0].message, '');
  assert.equal(r.rows[0].ts, 1_700_000_000_000);
  assert.equal(lq.setLogQueryResult('lq_forged_0', { rows: [] }), false, '발급하지 않은 reqId 결과는 저장하지 않는다');
  assert.equal(lq.getLogQueryResult('lq_forged_0').state, 'pending');
});

// ── CEN2600-08 ────────────────────────────────────────────────────────────────
test('CEN2600-08: bmstor 회신의 mounts·missing 은 상한·아는 필드만', async () => {
  const bp = await import('../src/bmstor/poller.js');
  const mounts = Array.from({ length: 3000 }, (_, i) => ({ mount: `/m${i}`, usedPct: { x: 1 }, totalBytes: '100', evil: 'z' }));
  bp.applyBmstorResults('edgeA', [{ id: 's1', ok: true, mounts, missing: [{ o: 1 }, '/gone'], error: { o: 1 } }]);
  const row = bp.getBmLatest().get('s1');
  assert.equal(row.mounts.length, 64);
  assert.equal(row.mounts[0].usedPct, null);
  assert.equal(row.mounts[0].totalBytes, 100);
  assert.equal('evil' in row.mounts[0], false);
  assert.deepEqual(row.missing, ['/gone']);
  assert.equal(typeof row.error, 'string');
});

// ── EDGE2600-01 · EDGE2600-02 ─────────────────────────────────────────────────
test('EDGE2600-01/02: vmseries push 는 base64 길이로 청크를 나누고 mxcpu·mxmem 을 싣는다(목 중앙 실측)', async () => {
  const { srv, got } = mockCentral();
  const port = await listen(srv);
  try {
    const { config } = await import('../src/config.js');
    config.agent.centralUrl = `http://127.0.0.1:${port}`;
    config.agent.centralToken = 'tok';
    config.agent.name = 'edgeA';
    const vp = await import('../src/agent/vmSeriesPush.js');
    // 400KB BLOB 4행 = 1.6MB — 청크 한도 700KB 면 최소 3청크여야 한다(예전: 1청크).
    const spikes = Array.from({ length: 4 }, (_, i) => ({ kind: 'vm', ref: `vm-${i}`, t0: T0, t1: T0 + 60_000, n: 3, cols: ['cpuUsagePct'], buf: Buffer.alloc(300_000, i), mxcpu: 5000 + i, mxmem: 4000 }));
    const r = await vp.pushVmSeriesSlice({ id: 'vc-edge', name: 'vc-edge' }, { spikes, cover: [], cursors: [] });
    const posts = got.filter((g) => g.url === '/api/central/vmseries');
    assert.ok(posts.length >= 3, `청크 수 ${posts.length}`);
    assert.equal(r.chunks, posts.length);
    assert.ok(posts.every((p) => p.bytes < 1_000_000), '각 요청 본문이 1MB 미만');
    const rows = posts.flatMap((p) => p.body.spikes);
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map((x) => x.mxcpu), [5000, 5001, 5002, 5003]);
    assert.ok(rows.every((x) => x.mxmem === 4000));
    // 행 수 상한도 지킨다(중앙이 청크당 20,000행에서 자른다).
    const small = Array.from({ length: 45_000 }, () => ({ data: 'AA', cols: [] }));
    assert.ok(vp.chunkSpikeRows(small).every((c) => c.length <= vp.CHUNK_MAX_ROWS));
  } finally { srv.close(); }
});

// ── EDGE2600-04 ───────────────────────────────────────────────────────────────
test('EDGE2600-04: 읽지 못한(unreachable·pending) 빈 vCenter 슬라이스는 중앙에 보내지 않는다', async () => {
  const ip = await import('../src/agent/inventoryPush.js');
  const snap = { hosts: [{ vcenterId: 'vc-ok' }], vms: [], datastores: [], networks: [], alarms: [] };
  assert.equal(ip.isUnreadEmpty(snap, { id: 'vc-down', status: 'unreachable' }), true);
  assert.equal(ip.isUnreadEmpty(snap, { id: 'vc-down', status: 'pending' }), true);
  assert.equal(ip.isUnreadEmpty(snap, { id: 'vc-ok', status: 'unreachable' }), false, 'lastGood 이월로 목록이 있으면 보낸다');
  assert.equal(ip.isUnreadEmpty(snap, { id: 'vc-empty', status: 'connected' }), false, '정상 수집된 빈 vCenter 는 보낸다');

  const { srv, got } = mockCentral();
  const port = await listen(srv);
  try {
    const { config } = await import('../src/config.js');
    config.agent.centralUrl = `http://127.0.0.1:${port}`;
    const { store } = await import('../src/store.js');
    const orig = store.get;
    store.get = () => ({ generatedAt: T0, vcenters: [{ id: 'vc-down', status: 'unreachable' }, { id: 'vc-live', status: 'connected' }], hosts: [{ id: 'h1', vcenterId: 'vc-live' }], vms: [], datastores: [], networks: [], alarms: [] });
    try {
      const r = await ip.pushInventoryNow();
      assert.deepEqual(r.withheld, ['vc-down']);
      const sent = got.filter((g) => g.url === '/api/central/inventory').map((g) => g.body.vcenterId);
      assert.deepEqual(sent, ['vc-live'], '불통 vCenter 의 빈 목록은 중앙에 가지 않는다');
    } finally { store.get = orig; }
  } finally { srv.close(); }
});

// ── EDGE2600-05 · LO2600-04 ───────────────────────────────────────────────────
test('EDGE2600-05/LO2600-04: 주기 env 는 [하한, MAX_TIMER_MS] 로 갇힌다(음수·2^31 초과 → 1ms 루프 없음)', async () => {
  const { MAX_TIMER_MS } = await import('../src/config.js');
  const checks = [
    [(await import('../src/agent/configPush.js')).configPushStatus().intervalMs, 1_800_000],
    [(await import('../src/agent/curUserConfigPull.js')).curUserConfigPullStatus().intervalMs, MAX_TIMER_MS],
    [(await import('../src/agent/vmSeriesConfigPull.js')).vmSeriesConfigPullStatus().intervalMs, 600_000],
    [(await import('../src/agent/partFaultConfigPull.js')).partFaultConfigPullStatus().intervalMs, MAX_TIMER_MS],
    [(await import('../src/partfault/push.js')).partFaultPushStatus().intervalMs, MAX_TIMER_MS],
    [(await import('../src/agent/sanSwitchConfigPull.js')).configPullMs(), MAX_TIMER_MS],
  ];
  for (const [got, want] of checks) assert.equal(got, want);
  const svc = fs.readFileSync(new URL('../src/agent/svcmonConfigPull.js', import.meta.url), 'utf8');
  assert.match(svc, /INTERVAL_MS = clampIntervalMs\(/);
});

// ── EDGE2600-06 ───────────────────────────────────────────────────────────────
test('EDGE2600-06: 설정 pull 의 404 는 central 꺼짐과 엔드포인트 없음을 가르고 상태에 남긴다', async () => {
  const { classifyCentral404 } = await import('../src/agent/central404.js');
  const j = (o) => new Response(JSON.stringify(o), { status: 404, headers: { 'Content-Type': 'application/json' } });
  assert.equal((await classifyCentral404(j({ ok: false, reason: 'central 비활성화' }))).kind, 'disabled');
  assert.equal((await classifyCentral404(new Response('<pre>Cannot GET /x</pre>', { status: 404 }))).kind, 'no-endpoint');
  assert.equal((await classifyCentral404(j({ ok: false, reason: '다른 사유' }))).kind, 'refused');

  let mode = 'disabled';
  const { srv } = mockCentral(() => (mode === 'disabled' ? { status: 404, json: { ok: false, reason: 'central 비활성화' } } : { status: 404, html: 'Cannot GET' }));
  const port = await listen(srv);
  try {
    const { config } = await import('../src/config.js');
    config.agent.centralUrl = `http://127.0.0.1:${port}`;
    config.agent.centralToken = 'tok';
    const vm = await import('../src/agent/vmSeriesConfigPull.js');
    const a = await vm.pullVmSeriesConfigNow();
    assert.equal(a.ok, false, 'central 이 꺼진 중앙을 ok 로 보고하지 않는다');
    assert.equal(a.kind, 'disabled');
    mode = 'html';
    const b = await vm.pullVmSeriesConfigNow();
    assert.equal(b.kind, 'no-endpoint');
    mode = 'disabled';
    const sv = await import('../src/agent/svcmonConfigPull.js');
    const c = await sv.pullSvcmonConfigNow();
    assert.equal(c.kind, 'disabled');
    assert.equal(sv.svcmonConfigPullStatus().last.kind, 'disabled', '404 도 last 에 남는다');
  } finally { srv.close(); }
});

// ── EDGE2600-07 ───────────────────────────────────────────────────────────────
test('EDGE2600-07: 위임 워커는 성공 인출(잡 0건)이면 이전 실패 상태를 지운다', async () => {
  let fail = true;
  const { srv } = mockCentral(() => (fail ? { status: 403, json: { ok: false, reason: '토큰 불일치' } } : { status: 200, json: { ok: true, jobs: [] } }));
  const port = await listen(srv);
  try {
    const { config } = await import('../src/config.js');
    config.agent.centralUrl = `http://127.0.0.1:${port}`;
    config.agent.centralToken = 'tok';
    for (const [mod, run, status] of [['captureWorker', 'runCaptureWorkerOnce', 'captureWorkerStatus'], ['bmstorWorker', 'runBmstorWorkerOnce', 'bmstorWorkerStatus']]) {
      const m = await import(`../src/agent/${mod}.js`);
      fail = true; await m[run]();
      assert.equal(m[status]().ok, false, `${mod}: 403 은 실패로 남는다`);
      fail = false; await m[run]();
      assert.equal(m[status]().ok, true, `${mod}: 이후 정상 인출이면 실패 상태가 지워진다`);
    }
    // pingWorker: 잴 vCenter 가 0개여도 상태를 남긴다(예전엔 조기 return 으로 상태가 비었다).
    const pw = await import('../src/agent/pingWorker.js');
    await pw.runPingWorkerOnce();
    assert.equal(pw.pingWorkerStatus().ok, true);
    assert.equal(pw.pingWorkerStatus().jobs, 0);
  } finally { srv.close(); }
});
