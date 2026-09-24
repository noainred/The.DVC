/**
 * test/audit2603f.test.js — v2.603 감사 그룹 f(엣지 push) 회귀.
 *
 *  · EDGE2603-01 파트 장애 즉시 트리거 push 가 주기 push 와 겹치면 조용히 버려졌다 → 끝난 뒤 한 번 더
 *  · EDGE2603-02 SAN 포트 사용량 push 'DB 비활성' 분기가 상태 보고 실패를 statusSent:true 로 기록했다
 *  · EDGE2603-03 SAN 포트 사용량 '지금 수집' 대행 뒤 push 가 busy 로 거절되면 무음이었다
 *  · EDGE2603-04 현재 사용자 — 대상이 0이 된 vCenter 의 latest 가 엣지·중앙에 무기한 남았다
 *  · EDGE2603-05 중앙이 엣지에 파트 장애 '꺼짐' 을 내려보내는데 화면은 'silent(보고 없음)' 로 추측했다
 *
 * 전부 실제 함수를 호출하고 목 중앙(HTTP)에 도착한 본문을 센다. 기준 시각에 Date.now() 를 쓰지 않는다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2603f-'));
process.env.CONFIG_DIR = DIR;
process.env.PARTFAULT_ENABLED = 'true';
// 수집 서버 등록부(EDGE2603-05) — 모듈 로드 전에 써 둔다(registry 가 로드 시 경로를 굳힌다).
fs.writeFileSync(path.join(DIR, 'collectors.json'), JSON.stringify({ collectors: [
  { id: 'edge-off', name: 'edge-off', url: 'http://127.0.0.1:9/', token: 't1' },
  { id: 'edge-on', name: 'edge-on', url: 'http://127.0.0.1:9/', token: 't2' },
] }));

const { config } = await import('../src/config.js');

/** 목 중앙 — 경로별 응답 코드·지연을 준다. 도착한 본문(gzip 해제)을 모은다. */
async function mockCentral({ delayFirstMs = 0, status = 200, handler = null } = {}) {
  const got = [];
  let n = 0;
  const srv = http.createServer((req, res) => {
    const bufs = [];
    req.on('data', (c) => bufs.push(c));
    req.on('end', () => {
      let raw = Buffer.concat(bufs);
      if (req.headers['content-encoding'] === 'gzip') { try { raw = zlib.gunzipSync(raw); } catch { /* */ } }
      let body = null; try { body = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { body = null; }
      got.push({ method: req.method, url: req.url, body });
      const i = n++;
      const reply = () => {
        if (handler) { const h = handler(req, body); if (h) { res.writeHead(h.status || 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(h.body || {})); return; } }
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status < 400 ? { ok: true } : { ok: false, reason: 'denied' }));
      };
      if (i === 0 && delayFirstMs) setTimeout(reply, delayFirstMs); else reply();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  return { srv, got, url, close: () => new Promise((r) => srv.close(r)) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── EDGE2603-01 ─────────────────────────────────────────────────────────────────
test('EDGE2603-01 파트 장애 push — 진행 중에 들어온 즉시 트리거는 버려지지 않고 끝난 뒤 한 번 더 보낸다', async () => {
  const c = await mockCentral({ delayFirstMs: 400 });
  try {
    config.agent.centralUrl = c.url; config.agent.centralToken = 'tok'; config.agent.name = 'edge-pf';
    const { pushPartFaultsNow } = await import('../src/partfault/push.js');
    const a = pushPartFaultsNow({ reason: 'timer' });
    const b = pushPartFaultsNow({ reason: 'hook:idrac' });   // 주기 push 가 도는 중의 즉시 트리거
    const [ra, rb] = await Promise.all([a, b]);
    const posts = c.got.filter((g) => g.url === '/api/central/part-faults');
    // 수정 전: rb = {ok:false, reason:'이전 push 진행 중'} · posts 1
    assert.equal(rb.ok, true, `즉시 트리거가 거절됐다: ${rb.reason}`);
    assert.equal(ra.ok, true);
    assert.equal(posts.length, 2, '진행 중이던 push 가 끝난 뒤 한 번 더 스캔·전송해야 한다');
    // 겹치지 않으면 한 번만 보낸다(불필요한 재전송 없음)
    const r3 = await pushPartFaultsNow({ reason: 'timer' });
    assert.equal(r3.ok, true);
    assert.equal(c.got.filter((g) => g.url === '/api/central/part-faults').length, 3);
  } finally { await c.close(); }
});

// ── EDGE2603-02·03 — 포트 사용량 DB 를 못 여는 상태로 만든다(이 파일에서만 — 파일 하나를 디렉터리 자리에 둔다) ──
async function perfDbUnavailable() {
  const blocker = path.join(DIR, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  const prev = config.dbDir;
  config.dbDir = path.join(blocker, 'sub');     // 파일 아래 경로 → DatabaseSync 가 실패 → 'unavailable'
  const db = await import('../src/sanswitch/perfDb.js');
  db._resetForTest();
  const r = await db.samplesAfter(0, 10);
  config.dbDir = prev;   // 'unavailable' 은 이 프로세스에서 래치된다 — 다른 DB(현재 사용자 등)는 정상 경로로
  return { unavailable: !!r.unavailable };
}

test('EDGE2603-02 perfPush DB 비활성 분기 — 상태 보고가 거부되면 statusSent:false + 사유를 남긴다', async () => {
  const u = await perfDbUnavailable();
  assert.equal(u.unavailable, true, '전제: 포트 사용량 DB 를 못 연다');
  const c = await mockCentral({ status: 403 });
  const warns = []; const orig = console.warn; console.warn = (...a) => { warns.push(a.join(' ')); };
  try {
    config.agent.centralUrl = c.url; config.agent.centralToken = 'tok'; config.agent.name = 'edge-perf';
    const { pushPerfNow, sanSwitchPerfPushStatus } = await import('../src/sanswitch/perfPush.js');
    const r = await pushPerfNow();
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'DB 비활성');
    const st = sanSwitchPerfPushStatus();
    // 수정 전: statusSent === true (중앙은 403 이었다)
    assert.equal(st.statusSent, false, '중앙이 거부한 상태 보고를 보냈다고 기록하면 안 된다');
    assert.match(String(st.statusError), /403/);
    assert.ok(warns.some((w) => /상태 보고 실패/.test(w)), '실패를 콘솔에도 남겨야 한다');
  } finally { console.warn = orig; await c.close(); }
});

test('EDGE2603-03 perfPush — 진행 중 push 와 겹친 요청은 거절 대신 끝난 뒤 한 번 더 보낸다', async () => {
  const c = await mockCentral({ delayFirstMs: 400 });
  try {
    config.agent.centralUrl = c.url; config.agent.centralToken = 'tok'; config.agent.name = 'edge-perf';
    const { pushPerfNow } = await import('../src/sanswitch/perfPush.js');
    const a = pushPerfNow();                // 주기 push(느린 중앙)
    const b = pushPerfNow();                // '지금 수집' 대행 직후의 push
    const [, rb] = await Promise.all([a, b]);
    // 수정 전: rb = {ok:false, reason:'이전 push 진행 중'} · POST 1회
    assert.notEqual(rb.reason, '이전 push 진행 중');
    assert.equal(c.got.filter((g) => g.url === '/api/central/sanswitch-perf').length, 2);
  } finally { await c.close(); }
});

test('EDGE2603-03 SAN 설정 pull — 포트 사용량 수집 대행 뒤 push 결과를 상태에 남긴다(무음 금지)', async () => {
  const c = await mockCentral({
    handler: (req) => {
      if (req.method === 'GET' && req.url.startsWith('/api/central/sanswitch-config')) return { body: { ok: true, devices: [], perfCollectNow: true } };
      if (req.url === '/api/central/sanswitch-perf') return { status: 403, body: { ok: false, reason: 'denied' } };
      return null;
    },
  });
  try {
    config.agent.centralUrl = c.url; config.agent.centralToken = 'tok'; config.agent.name = 'edge-perf';
    const { pullSanSwitchConfigNow, sanSwitchConfigPullStatus } = await import('../src/agent/sanSwitchConfigPull.js');
    const r = await pullSanSwitchConfigNow();
    assert.equal(r.ok, true);
    assert.equal(r.perfCollect, true);
    let st = null;
    for (let i = 0; i < 100 && !st?.perfCollectPush; i++) { await sleep(50); st = sanSwitchConfigPullStatus(); }
    // 수정 전: perfCollectPush 가 없다(반환값을 버렸다)
    assert.ok(st?.perfCollectPush, '대행 뒤 push 결과가 상태에 있어야 한다');
    assert.equal(st.perfCollectPush.ok, false);   // DB 비활성 + 403 — 성공이라 말하지 않는다
    assert.ok(st.perfCollectPush.reason);
  } finally { await c.close(); }
});

// ── EDGE2603-04 ─────────────────────────────────────────────────────────────────
const winVm = (id, vcenterId, folder) => ({ id, vcenterId, name: id, folder, guestOS: 'Microsoft Windows Server 2019', powerState: 'poweredOn', toolsRunningStatus: 'guestToolsRunning' });

test('EDGE2603-04 현재 사용자 — 대상이 0이 된 vCenter 의 latest 를 비운다(다른 법인은 건드리지 않는다)', async () => {
  const cudb = await import('../src/curuser/db.js');
  assert.equal((await cudb.curUserDbStatus()).available, true, '현재 사용자 DB 를 열 수 있어야 한다');
  const { store } = await import('../src/store.js');
  const settings = await import('../src/curuser/settings.js');
  const { runCurUserNow } = await import('../src/curuser/poller.js');
  const prev = store.snapshot;
  try {
    store.snapshot = { source: 'mock', vcenters: [{ id: 'vc-a', name: 'A' }, { id: 'vc-b', name: 'B' }],
      vms: [winVm('vm-a1', 'vc-a', '/DC/W'), winVm('vm-a2', 'vc-a', '/DC/W'), winVm('vm-b1', 'vc-b', '/DC/W')], hosts: [] };
    settings.save({ enabled: true, vcenters: { 'vc-a': { enabled: true, folders: ['/DC/W'] }, 'vc-b': { enabled: true, folders: ['/DC/W'] } } });
    const r1 = await runCurUserNow('manual');
    assert.equal(r1.targets, 3);
    const byVc = async () => { const m = {}; for (const x of await cudb.latestRecords()) m[x.vcenterId] = (m[x.vcenterId] || 0) + 1; return m; };
    assert.deepEqual(await byVc(), { 'vc-a': 2, 'vc-b': 1 });

    // vc-a 를 범위에서 뺀다(중앙 설정에서 빠진 것과 같다) — vc-b 는 그대로 수집
    settings.save({ enabled: true, vcenters: { 'vc-b': { enabled: true, folders: ['/DC/W'] } } });
    const r2 = await runCurUserNow('manual');
    // 수정 전: vc-a 2행이 무기한 남는다
    assert.deepEqual(await byVc(), { 'vc-b': 1 }, '대상이 빠진 법인의 옛 latest 가 남으면 안 된다');
    assert.deepEqual(r2.clearedVcenters, ['vc-a']);

    // 대상이 **전부** 빠진 경우(조기 반환 경로)도 비운다
    settings.save({ enabled: true, vcenters: {} });
    const r3 = await runCurUserNow('manual');
    assert.equal(r3.targets, 0);
    assert.deepEqual(await byVc(), {}, '대상 0 조기 반환 경로도 latest 를 비워야 한다');

    // 인벤토리를 못 읽어 VM 이 0으로 보인 법인은 지우지 않는다(모르는 것을 지우지 않는다)
    settings.save({ enabled: true, vcenters: { 'vc-a': { enabled: true, folders: ['/DC/W'] } } });
    await runCurUserNow('manual');
    assert.deepEqual(await byVc(), { 'vc-a': 2 });
    store.snapshot = { ...store.snapshot, vms: [winVm('vm-b1', 'vc-b', '/DC/W')] };   // vc-a VM 이 스냅샷에서 사라짐
    await runCurUserNow('manual');
    assert.deepEqual(await byVc(), { 'vc-a': 2 }, '스냅샷에 그 법인 VM 이 없으면 대상 0 으로 단정하지 않는다');
  } finally { store.snapshot = prev; }
});

test('EDGE2603-04 엣지 — 대상이 0이 된 법인은 레코드 없이도 중앙에 vcenterIds 로 알려 중앙 latest 를 비우게 한다', async () => {
  const cudb = await import('../src/curuser/db.js');
  assert.equal((await cudb.curUserDbStatus()).available, true);
  const { store } = await import('../src/store.js');
  const settings = await import('../src/curuser/settings.js');
  const { runCurUserNow } = await import('../src/curuser/poller.js');
  // 이 엣지가 직접 수집하는(site 아님) 실제 vCenter 등록
  fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'corp:vc01', name: 'corp-vc01', host: 'https://10.9.9.9', username: 'u', password: 'p' }] }));
  // 직전 주기에 수집해 둔 latest(엣지 로컬)
  await cudb.commitCurUser({ ts: 1_700_000_000_000, records: [{ vmId: 'corp:vc01:vm-1', vcenterId: 'corp:vc01', name: 'w1', at: 1_700_000_000_000, kind: 'ok', ok: true, users: [] }], series: [], replaceVcenters: [] });
  const c = await mockCentral({ status: 500 });   // 첫 push 는 실패 — 다음 주기에 다시 보내야 한다
  let c2 = null;
  const prev = store.snapshot;
  const prevPush = config.agent.pushCurUser;
  try {
    config.agent.centralUrl = c.url; config.agent.centralToken = 'tok'; config.agent.name = 'edge-cu'; config.agent.pushCurUser = true;
    store.snapshot = { source: 'live', vcenters: [{ id: 'corp:vc01', name: 'corp-vc01' }], vms: [winVm('corp:vc01:vm-1', 'corp:vc01', '/Other')], hosts: [] };
    settings.save({ enabled: true, vcenters: {} });   // 중앙이 이 법인 범위를 뺐다
    const r = await runCurUserNow('manual');
    assert.equal(r.targets, 0);
    const local = (await cudb.latestRecords()).filter((x) => x.vcenterId === 'corp:vc01');
    assert.equal(local.length, 0, '엣지 로컬 latest 도 비운다');
    const posts1 = c.got.filter((g) => g.url === '/api/central/curuser');
    // 수정 전: posts 0(레코드가 없으면 push 하지 않았다)
    assert.ok(posts1.length >= 1, '레코드가 0이어도 비운 법인을 중앙에 알려야 한다');
    assert.deepEqual(posts1[0].body.vcenterIds, ['corp:vc01']);
    assert.deepEqual(posts1[0].body.records, []);
    assert.equal(posts1[0].body.chunk, 0);

    // 다음 주기 — 로컬에는 이미 행이 없지만, 중앙에 못 알렸으므로 다시 보낸다
    c2 = await mockCentral({ status: 200 });
    config.agent.centralUrl = c2.url;
    await runCurUserNow('manual');
    const p2 = c2.got.filter((g) => g.url === '/api/central/curuser');
    assert.equal(p2.length, 1);
    assert.deepEqual(p2[0].body.vcenterIds, ['corp:vc01']);
    // 성공 뒤에는 더 보내지 않는다
    await runCurUserNow('manual');
    assert.equal(c2.got.filter((g) => g.url === '/api/central/curuser').length, 1);
  } finally {
    store.snapshot = prev; config.agent.pushCurUser = prevPush;
    await c.close(); if (c2) await c2.close();   // 단언이 실패해도 서버를 닫는다(열어 두면 테스트 프로세스가 끝나지 않는다)
  }
});

// ── EDGE2603-05 ─────────────────────────────────────────────────────────────────
test('EDGE2603-05 classifyEdges — 중앙이 꺼짐을 내려보내는 엣지는 off(보고 없음 추측이 아님)', async () => {
  const { classifyEdges } = await import('../src/routes/api/partFaults.js');
  const collectors = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
  const status = { a: { version: '2.603.0' }, b: { version: '2.603.0' }, c: { version: '2.603.0' } };
  const sw = (n) => (n === 'A' || n === 'C' ? { enabled: false, source: 'edge' } : { enabled: true, source: 'global' });
  const reports = [{ agent: 'C', protocol: 2, at: 1, stale: false }];   // C 는 env 강제 켜짐 — 신선한 보고가 이긴다
  const r = classifyEdges({ collectors, status, reports, edgeSwitch: sw });
  const kind = Object.fromEntries(r.rows.map((x) => [x.agent, x.kind]));
  assert.deepEqual(kind, { A: 'off', B: 'silent', C: 'fresh' });
  assert.equal(r.rows.find((x) => x.agent === 'A').offSource, 'edge');
  // 스위치 정보가 없으면 예전 그대로(호환)
  assert.equal(classifyEdges({ collectors, status, reports: [] }).rows[0].kind, 'silent');
});

test('EDGE2603-05 edgesNow — 중앙 설정의 엣지별 off 가 분류에 반영된다(설정 파일 → 분류)', async () => {
  const { savePartFaultSettings } = await import('../src/partfault/settings.js');
  const { edgesNow } = await import('../src/routes/api/partFaults.js');
  savePartFaultSettings({ enabled: true, edges: { 'edge-off': { enabled: false } } });
  const rows = Object.fromEntries(edgesNow().rows.map((x) => [x.agent, x]));
  // 수정 전: edge-off 도 버전 미상/보고 없음으로 분류(꺼짐을 말하지 못했다)
  assert.equal(rows['edge-off'].kind, 'off');
  assert.equal(rows['edge-off'].offSource, 'edge');
  assert.notEqual(rows['edge-on'].kind, 'off');
  savePartFaultSettings({ enabled: false, edges: {} });
  const rows2 = Object.fromEntries(edgesNow().rows.map((x) => [x.agent, x]));
  assert.equal(rows2['edge-on'].kind, 'off');
  assert.equal(rows2['edge-on'].offSource, 'global');
});
