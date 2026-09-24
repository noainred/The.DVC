/**
 * v2.605 감사 그룹 d — 엣지 push·업그레이드·중계 점검 회귀.
 *
 * RECENT2605-01 fleet push 보류에 시한(넘으면 못 읽은 vCenter 귀속·무귀속만 빼고 보낸다) ·
 * EDGE2605-01 PDU push 가 첫 주기 전 부분 목록을 보내지 않는다 · EDGE2605-02 GPU 게스트 push 가 첫 폴 전 빈 목록을 보내지 않는다 ·
 * EDGE2605-04 설정 push 진행 중 요청을 버리지 않고 끝난 뒤 한 번 더 · LEFT2605-01 relaycheck·tokenProbe·collectorsDc 응답 상한 ·
 * LEFT2605-04(= SEC2605-02) 엣지 번들 push 결과를 엣지 본문이 덮지 못하고, 결과를 요약·기록한다.
 * 엣지 push 는 목 HTTP 중앙으로 **실제 호출**해 본문 도착까지 본다. 기준 시각에 Date.now() 를 쓰는 판정은 순수 함수에 now 를 주입한다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2605d-'));
Object.assign(process.env, {
  CONFIG_DIR: CFG, CENTRAL_TOKEN: 'shared-2605d', AGENT_NAME: 'e1', DATA_SOURCE: 'live',
  IPAM_WRITE_WORKER: '0', SSRF_ALLOW_LOOPBACK: 'true',
});
fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: [] }));

// ── 목 중앙: 경로별로 받은 본문을 모은다(gzip 해제) ──
const got = [];
let delayMs = 0;
const central = http.createServer((q, r) => {
  const ch = []; q.on('data', (c) => ch.push(c));
  q.on('end', () => {
    let b = Buffer.concat(ch);
    try { if (q.headers['content-encoding'] === 'gzip') b = zlib.gunzipSync(b); } catch { /* */ }
    let body = null; try { body = JSON.parse(b.toString('utf8') || 'null'); } catch { body = null; }
    got.push({ path: q.url.split('?')[0], body });
    setTimeout(() => { r.writeHead(200, { 'content-type': 'application/json' }); r.end('{"ok":true}'); }, delayMs);
  });
});
await new Promise((r) => central.listen(0, '127.0.0.1', r));
const CENTRAL = `http://127.0.0.1:${central.address().port}`;
const closedPort = await new Promise((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
test.after(() => central.close());

const { config } = await import('../src/config.js');
config.agent.centralUrl = CENTRAL;
config.agent.centralToken = 'shared-2605d';
config.agent.name = 'e1';
const quiet = async (fn) => { const w = console.warn; const l = console.log; console.warn = () => {}; console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; } };
const bodiesAt = (p) => got.filter((g) => g.path === p).map((g) => g.body);

// ─────────────────────────────────────────────────────────────────────────────
test('RECENT2605-01: fleet push 보류는 시한까지만 — 넘으면 못 읽은 vCenter 귀속·무귀속만 빼고 보낸다(중앙 TTL 30분보다 짧게)', async () => {
  const fp = await import('../src/agent/fleetPush.js');
  assert.ok(fp.FLEET_WITHHOLD_MAX_MS < 30 * 60_000, '중앙 CENTRAL_FLEET_TTL_MS 기본 30분보다 짧아야 중앙이 이 엣지 항목을 지우기 전에 보낸다');
  const T = 1_700_000_000_000;
  assert.deepEqual(fp.fleetWithholdDecision([], null, T), { mode: 'send', since: null });
  assert.deepEqual(fp.fleetWithholdDecision(['vcD'], null, T), { mode: 'withhold', since: T });
  assert.equal(fp.fleetWithholdDecision(['vcD'], T, T + fp.FLEET_WITHHOLD_MAX_MS).mode, 'withhold');
  assert.equal(fp.fleetWithholdDecision(['vcD'], T, T + fp.FLEET_WITHHOLD_MAX_MS + 1).mode, 'partial');
  const pb = fp.partialBareMetal([{ fleetId: 'a', vcenterId: 'vcA' }, { fleetId: 'b' }, { fleetId: 'c', vcenterId: 'vcD' }, null], ['vcD']);
  assert.deepEqual(pb.keep.map((b) => b.fleetId), ['a']);
  assert.equal(pb.dropped, 3);

  // 실제 push — 등록부에 vcA 가 있는데 스냅샷에 호스트가 없다(못 읽음)
  fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'vcA', name: 'vcA', host: 'https://10.0.0.1', username: 'u', password: 'p' }] }));
  try {
    fp._setFleetWithholdSinceForTest(null);
    const n0 = bodiesAt('/api/central/fleet').length;
    const r1 = await quiet(() => fp.pushFleetNow());
    assert.equal(r1.skipped, true);
    assert.equal(bodiesAt('/api/central/fleet').length, n0, '시한 안에서는 보내지 않는다');
    // 시한을 넘긴 보류 — 수정 전에는 영원히 skipped 였고 중앙은 30분 뒤 이 엣지의 베어메탈 전체를 지웠다
    fp._setFleetWithholdSinceForTest(Date.now() - fp.FLEET_WITHHOLD_MAX_MS - 60_000);
    const r2 = await quiet(() => fp.pushFleetNow());
    assert.equal(r2.ok, true, `시한 초과 뒤에는 부분 목록을 보내야 한다: ${JSON.stringify(r2)}`);
    assert.equal(r2.partial, true);
    const b = bodiesAt('/api/central/fleet').at(-1);
    assert.ok(b, '목 중앙에 본문이 도착해야 한다');
    assert.equal(b.agent, 'e1');
    assert.equal(b.partial, true);
    assert.deepEqual(b.unreadVcenters, ['vcA']);
    assert.ok(Array.isArray(b.baremetal));
    const st = fp.fleetPushStatus().last;
    assert.equal(st.partial, true);
    assert.deepEqual(st.unreadVcenters, ['vcA']);
  } finally {
    fp._setFleetWithholdSinceForTest(null);
    fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: [] }));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
test('EDGE2605-01: PDU push 는 첫 주기 전 부분 목록을 보내지 않는다(중앙이 나머지를 지운다) — 첫 주기 뒤엔 전량', async () => {
  const push = await import('../src/pdu/push.js');
  const T = 1_700_000_000_000;
  // 순수 판정
  assert.equal(push.pduPushWithhold({ assignedIds: [], snapshotIds: [] , now: T }).withhold, false, '위임 0대 — 빈 목록으로 중앙을 비운다(v2.583 #13)');
  assert.equal(push.pduPushWithhold({ assignedIds: ['p1'], snapshotIds: [], firstPollDone: true, now: T }).withhold, true, '스냅샷 0건은 언제나 보류');
  assert.equal(push.pduPushWithhold({ assignedIds: null, snapshotIds: [], now: T }).withhold, true);
  const w = push.pduPushWithhold({ assignedIds: ['p1', 'p2', 'p3'], snapshotIds: ['p1'], firstPollDone: false, now: T });
  assert.equal(w.withhold, true);
  assert.equal(w.missing, 2);
  assert.equal(push.pduPushWithhold({ assignedIds: ['p1', 'p2', 'p3'], snapshotIds: ['p1'], firstPollDone: false, since: T, now: T + push.PDU_PUSH_WITHHOLD_MAX_MS + 1 }).withhold, false, '보류에는 시한');
  const after = push.pduPushWithhold({ assignedIds: ['p1', 'p2'], snapshotIds: ['p1'], firstPollDone: true, now: T });
  assert.equal(after.withhold, false);
  assert.equal(after.missing, 1, '첫 주기 뒤의 누락은 보내되 개수를 밝힌다');
  assert.equal(push.pduPushWithhold({ assignedIds: ['p1'], snapshotIds: ['p1', 'gone'], now: T }).withhold, false, '삭제된 장비는 누락으로 세지 않는다');

  // 실제 — 위임 PDU 3대, 1대만 수집한 재시작 직후
  const reg = await import('../src/pdu/registry.js');
  const ids = [];
  for (let i = 1; i <= 3; i++) {
    const r = reg.saveDevice({ name: `pdu${i}`, host: `127.0.0.${i}`, port: closedPort, username: 'u', password: 'p', agent: 'e1' });
    assert.ok(r.ok, JSON.stringify(r));
  }
  for (const d of reg.devicesForThisNode()) ids.push(String(d.id));
  assert.equal(ids.length, 3);
  const poller = await import('../src/pdu/poller.js');
  await quiet(() => poller.collectDeviceNow(ids[0]));
  const n0 = bodiesAt('/api/central/pdu-data').length;
  const r1 = await quiet(() => push.pushPduNow());
  assert.equal(r1.withheld, true, `수정 전에는 1대만 담아 보냈다: ${JSON.stringify(r1)}`);
  assert.equal(bodiesAt('/api/central/pdu-data').length, n0, '보류 중에는 중앙에 아무것도 가지 않는다');
  assert.match(push.pduPushStatus().reason, /3대 중 2대/);
  // 첫 주기 완료 → 3대 전부
  await quiet(() => poller.pollOnce({ manual: true }));
  const r2 = await quiet(() => push.pushPduNow());
  assert.equal(r2.ok, true, JSON.stringify(r2));
  const b = bodiesAt('/api/central/pdu-data').at(-1);
  assert.ok(b, '목 중앙에 본문이 도착해야 한다');
  assert.deepEqual(b.snapshots.map((s) => String(s.id)).sort(), [...ids].sort());
});

// ─────────────────────────────────────────────────────────────────────────────
test('EDGE2605-02: GPU 게스트 push 는 첫 게스트 폴 전에는 빈 목록을 보내지 않는다 — 폴 뒤에는 보낸다', async () => {
  const gp = await import('../src/agent/gpuGuestPush.js');
  const T = 1_700_000_000_000;
  assert.deepEqual(gp.gpuGuestPushWithhold(null, null, T), { withhold: true, since: T });
  assert.equal(gp.gpuGuestPushWithhold(null, T, T + gp.GPU_GUEST_PUSH_WITHHOLD_MAX_MS + 1).withhold, false, '보류에는 시한');
  assert.equal(gp.gpuGuestPushWithhold({ at: T }, T, T).withhold, false);
  try {
    gp._setGuestPollerStatusForTest(() => ({ lastRun: null }));
    const n0 = bodiesAt('/api/central/gpu-guest-data').length;
    const r1 = await quiet(() => gp.pushGpuGuestNow());
    assert.equal(r1.skipped, true, `수정 전에는 {hosts:[],vms:[],diag:null} 을 보냈다: ${JSON.stringify(r1)}`);
    assert.equal(bodiesAt('/api/central/gpu-guest-data').length, n0);
    assert.equal(gp.gpuGuestPushStatus().last.skipped, true);
    gp._setGuestPollerStatusForTest(() => ({ lastRun: { at: Date.now(), vcenters: 0 } }));
    const r2 = await quiet(() => gp.pushGpuGuestNow());
    assert.equal(r2.ok, true, JSON.stringify(r2));
    const b = bodiesAt('/api/central/gpu-guest-data').at(-1);
    assert.ok(b && b.agent === 'e1' && Array.isArray(b.vms), '폴 뒤에는 목 중앙에 본문이 도착한다');
  } finally { gp._setGuestPollerStatusForTest(null); }
});

// ─────────────────────────────────────────────────────────────────────────────
test('EDGE2605-04: 설정 push 진행 중에 들어온 변경 push 는 버려지지 않고 끝난 뒤 한 번 더 간다', async () => {
  const cp = await import('../src/agent/configPush.js');
  cp._resetConfigPush();
  fs.writeFileSync(path.join(CFG, 'alerts-2605d.json'), JSON.stringify({ v: 1 }));
  const n0 = bodiesAt('/api/central/agent-config').length;
  delayMs = 300;
  try {
    const p1 = quiet(() => cp.pushConfigNow());
    await new Promise((r) => setTimeout(r, 50));          // 첫 push 가 파일을 읽고 POST 중
    fs.writeFileSync(path.join(CFG, 'alerts-2605d.json'), JSON.stringify({ v: 2 }));
    const p2 = quiet(() => cp.pushConfigNow({ onlyIfChanged: true }));
    const [a, b] = await Promise.all([p1, p2]);
    assert.notEqual(b, false, '수정 전에는 진행 중이면 false 로 버려졌다');
    assert.equal(a, true);
    const sent = bodiesAt('/api/central/agent-config').slice(n0);
    assert.equal(sent.length, 2, `끝난 뒤 한 번 더 보내야 한다(보낸 수 ${sent.length})`);
    assert.match(sent[1].files['alerts-2605d.json'], /"v":2/);
    assert.ok(cp.configPushStatus().lastDeferredAt > 0);
    // 내용이 같으면 추가 push 는 지문으로 생략(v2.602 EDGE2602-01 과 충돌하지 않음)
    const p3 = quiet(() => cp.pushConfigNow());
    await new Promise((r) => setTimeout(r, 50));
    const p4 = quiet(() => cp.pushConfigNow({ onlyIfChanged: true }));
    await Promise.all([p3, p4]);
    assert.equal(bodiesAt('/api/central/agent-config').slice(n0).length, 3, '변경이 없으면 주기 push 1회만');
  } finally { delayMs = 0; fs.rmSync(path.join(CFG, 'alerts-2605d.json'), { force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
function bigJsonServer(totalBytes) {
  let written = 0;
  const s = http.createServer((q, r) => {
    r.writeHead(200, { 'content-type': 'application/json' });
    const pad = Buffer.alloc(64 * 1024, 0x20);
    r.write('{"ok":true,"agent":"e1","pad":"'); written += 31;
    const pump = () => {
      while (written < totalBytes) {
        written += pad.length;
        if (!r.write(pad)) { r.once('drain', pump); return; }
      }
      r.end('"}');
    };
    r.on('close', () => {});
    pump();
  });
  return { s, written: () => written };
}

test('LEFT2605-01: 중계 점검(주기 폴러)·토큰 점검·연결 테스트는 엣지 응답을 상한까지만 읽는다', async () => {
  const { runCheck, RELAY_PING_MAX_BYTES } = await import('../src/relaycheck/checks.js');
  assert.ok(RELAY_PING_MAX_BYTES <= 1024 * 1024);
  const big = bigJsonServer(40 * 1048576);
  await new Promise((r) => big.s.listen(0, '127.0.0.1', r));
  try {
    const r = await runCheck({ host: '127.0.0.1', port: big.s.address().port, kind: 'edge-portal', token: 't' }, { timeoutMs: 20_000 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(big.written() < 12 * 1048576, `상한에서 멈춰야 한다(서버가 쓴 바이트 ${big.written()} — 수정 전에는 40MB 전량)`);
  } finally { big.s.close(); }
  // tokenProbe — fetchImpl 주입(40MB 스트림)
  const tp = await import('../src/portalcheck/tokenProbe.js');
  let sent = 0;
  const stream = () => {
    const chunk = new TextEncoder().encode(' '.repeat(16_384)); sent = 0;
    return new Response(new ReadableStream({ pull(c) { if (sent >= 40 * 1048576) { c.close(); return; } c.enqueue(chunk); sent += chunk.byteLength; } }), { status: 200 });
  };
  const pr = await tp.probeCollectorPing({ id: 'e1', agent: 'e1', url: 'http://edge.example:4000', collector: { set: true } }, { token: 't', fetchImpl: async () => stream() });
  assert.equal(pr.httpStatus, 200);
  assert.ok(sent < 2 * 1048576, `ping 응답 상한(${sent})`);
  await tp.probeCentralRole({ url: 'http://edge.example:4000' }, { fetchImpl: async () => stream() });
  assert.ok(sent < 2 * 1048576, `health-probe 응답 상한(${sent})`);
  // collectorsDc — 소스 스윕(audit2604a JSON_UNCAPPED_ALLOW 가 비었다)에 더해 export·오류 본문이 readJsonCapped 인지
  const { stripComments } = await import('./_stripComments.js');
  const dc = stripComments(fs.readFileSync(path.resolve(import.meta.dirname, '../src/routes/admin/collectorsDc.js'), 'utf8'));
  assert.ok(!/\.json\(\)/.test(dc.replace(/readJsonCapped/g, '')), 'collectorsDc 에 무상한 .json() 이 없다');
  assert.match(dc, /readJsonCapped\(r, EDGE_EXPORT_MAX_BYTES/);
  const t2604 = fs.readFileSync(path.resolve(import.meta.dirname, 'audit2604a.test.js'), 'utf8');
  assert.ok(!/'relaycheck\/checks\.js': '중계 토폴로지 점검\(관리자 수동 실행\)/.test(t2604), '사실이 아닌 허용 사유(수동 실행)는 지웠다');
});

// ─────────────────────────────────────────────────────────────────────────────
test('LEFT2605-04 / SEC2605-02: 엣지 번들 push — 본문이 ok·status 를 덮지 못하고, 결과는 요약·기록된다', async () => {
  const up = await import('../src/upgrade/upgrade.js');
  const arch = path.join(CFG, 'b.tgz'); fs.writeFileSync(arch, Buffer.from('bundle'));
  const s = http.createServer((q, r) => { q.resume(); q.on('end', () => { r.writeHead(500, { 'content-type': 'application/json' }); r.end('{"ok":true,"status":200,"edge":"spoof","reason":{"x":1}}'); }); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}`;
  try {
    const res = await up.pushBundleToEdge({ url, token: 't' }, arch);
    assert.equal(res.ok, false, `수정 전에는 {ok:true,status:200}: ${JSON.stringify(res)}`);
    assert.equal(res.status, 500);
    assert.equal(res.edge, url);
    assert.equal(typeof (res.reason ?? ''), 'string', '객체 사유는 글자가 아니면 버린다');
  } finally { s.close(); }
  // 큰 본문은 상한까지만
  const big = bigJsonServer(40 * 1048576);
  await new Promise((r) => big.s.listen(0, '127.0.0.1', r));
  try {
    const res = await up.pushBundleToEdge({ url: `http://127.0.0.1:${big.s.address().port}` }, arch);
    assert.equal(res.ok, true);
    assert.ok(big.written() < 12 * 1048576, `응답 상한(${big.written()})`);
  } finally { big.s.close(); }
  // 요약 — 실패 목록은 origin·사유(글자)만
  const { summarizeEdgePush } = await import('../src/upgrade/manager.js');
  const sum = summarizeEdgePush([{ edge: 'http://a:4000/x?token=s', ok: false, status: 500, reason: 'HTTP 500' }, { edge: 'http://b:4000', ok: true, status: 200 }, null]);
  assert.equal(sum.total, 2);
  assert.equal(sum.ok, 1);
  assert.deepEqual(sum.failed, [{ edge: 'http://a:4000', status: 500, reason: 'HTTP 500' }]);
  const { stripComments } = await import('./_stripComments.js');
  const mgr = stripComments(fs.readFileSync(path.resolve(import.meta.dirname, '../src/upgrade/manager.js'), 'utf8'));
  assert.ok(!/pushToEdges\([^)]*\)\.catch\(\(\) => \{\}\)/.test(mgr), '엣지 push 결과를 조용히 버리지 않는다');
  assert.match(mgr, /lastResult\.edgePush = summarizeEdgePush/);
});
