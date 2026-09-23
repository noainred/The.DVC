/**
 * test/authStop2590.test.js — 주기 수집의 **인증 실패 정지**가 실제로 로그인을 멈추는가(v2.590).
 *
 * ── 왜 이 테스트가 있나 ────────────────────────────────────────────────────────
 * v2.590 감사(F1·F2)가 확인한 것: vCenter·iDRAC·NSX 와 SAN 스위치·PDU·베어메탈 스토리지·GPU 의 주기
 * 수집은 자격증명이 거부돼도 **다음 주기에 같은 계정으로 다시 로그인**했다(v2.528 스토리지·v2.535
 * Horizon 이 막은 계정 잠금 경로가 나머지 도구에서 그대로 열려 있었다). 특히 vCenter 는 SOAP
 * `InvalidLogin` 을 '능력 부재' 로 읽어 **REST 로 한 번 더 로그인**했다(주기당 실패 2회).
 *
 * ⚠ 이 파일은 문자열이 아니라 **실제 로그인 시도 횟수**를 센다 — 가짜 vCenter(SOAP·REST)·가짜
 *   Redfish·가짜 NSX HTTP 서버와, 모든 인증을 거부하는 ssh2 `Server` 를 띄워 한 주기 뒤 **다음 주기의
 *   시도가 0** 인지 본다. 그리고 반대 방향 셋을 함께 고정한다 — ① 자격증명을 바꾸면 재개 ② 수동 실행은
 *   막지 않는다 ③ 연결 실패·타임아웃은 멈추지 않는다(authGuard 규칙 4 — 멈추면 일시 장애가 수집을 영구
 *   정지시킨다).
 * ⚠ 기준 시각에 `Date.now()` 를 쓰지 않는다(CLAUDE.md v2.517) — 이 파일은 시각 경계를 판정하지 않는다.
 *   정지 기록의 시각은 모듈이 찍은 값을 그대로 읽는다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import ssh2 from 'ssh2';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'authstop2590-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';   // 등록부 저장 검증(베어메탈)이 127.0.0.1 을 받게 — 이 테스트 전용
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

const closers = [];
after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

const listen = (srv, host = '127.0.0.1') => new Promise((resolve) => srv.listen(0, host, () => resolve(srv.address().port)));
/** 닫힌 포트 하나(연결 거부) — 연결 실패로는 멈추지 않는지 볼 때 쓴다. */
async function closedPort() {
  const s = net.createServer();
  const p = await listen(s);
  await new Promise((r) => s.close(r));
  return p;
}
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => resolve(b)); });

/* ───────────── 가짜 vCenter(SOAP InvalidLogin + REST 401) ───────────── */
const SC_XML = '<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>'
  + '<RetrieveServiceContentResponse xmlns="urn:vim25"><returnval>'
  + '<rootFolder type="Folder">group-d1</rootFolder><propertyCollector type="PropertyCollector">propertyCollector</propertyCollector>'
  + '<viewManager type="ViewManager">ViewManager</viewManager><sessionManager type="SessionManager">SessionManager</sessionManager>'
  + '<about><version>8.0.2</version><build>1</build><fullName>VMware vCenter Server 8.0.2</fullName><apiVersion>8.0.2.0</apiVersion></about>'
  + '</returnval></RetrieveServiceContentResponse></soapenv:Body></soapenv:Envelope>';
const INVALID_LOGIN = '<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body>'
  + '<soapenv:Fault><faultcode>ServerFaultCode</faultcode><faultstring>Cannot complete login due to an incorrect user name or password.</faultstring>'
  + '<detail><InvalidLoginFault xmlns="urn:vim25" xsi:type="InvalidLogin"></InvalidLoginFault></detail></soapenv:Fault></soapenv:Body></soapenv:Envelope>';

async function fakeVcenter({ hang = false } = {}) {
  const st = { soapLogins: 0, restLogins: 0, requests: 0, aborted: 0, abortedAt: 0 };
  const srv = http.createServer(async (req, res) => {
    st.requests += 1;
    if (hang) {
      // 데드라인 시험: 응답하지 않고 매달린다 — 클라이언트가 **실제로 끊으면** close 가 온다.
      res.on('close', () => { if (!res.writableEnded) { st.aborted += 1; st.abortedAt = Date.now(); } });
      return;
    }
    const body = await readBody(req);
    if (req.url === '/sdk') {
      if (body.includes('<RetrieveServiceContent')) { res.writeHead(200, { 'content-type': 'text/xml' }); res.end(SC_XML); return; }
      if (body.includes('<Login ')) { st.soapLogins += 1; res.writeHead(500, { 'content-type': 'text/xml' }); res.end(INVALID_LOGIN); return; }
      res.writeHead(500, { 'content-type': 'text/xml' }); res.end('<faultstring>unexpected</faultstring>'); return;
    }
    if (req.url === '/api/session' && req.method === 'POST') { st.restLogins += 1; res.writeHead(401); res.end('{"error_type":"UNAUTHENTICATED"}'); return; }
    res.writeHead(404); res.end();
  });
  const port = await listen(srv);
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  return { st, port, host: `http://127.0.0.1:${port}` };
}

/* ───────────── 가짜 Redfish(전부 401 · 또는 Thermal 만 500) ───────────── */
async function fakeRedfish({ mode = 'deny' } = {}) {
  const st = { credAttempts: 0, requests: 0 };
  const srv = http.createServer(async (req, res) => {
    st.requests += 1;
    await readBody(req);
    const u = req.url.split('?')[0];
    if (mode === 'deny') {
      if (req.headers.authorization || (req.method === 'POST' && /SessionService\/Sessions/.test(u))) st.credAttempts += 1;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"Unable to complete the operation because an invalid username and/or password is entered"}}');
      return;
    }
    // mode 'thermal-fail': 전력·정체는 읽히고 Thermal 만 500
    const J = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (u === '/redfish/v1/Chassis') return J(200, { Members: [{ '@odata.id': '/redfish/v1/Chassis/System.Embedded.1' }] });
    if (u === '/redfish/v1/Chassis/System.Embedded.1/Power') return J(200, { PowerControl: [{ PowerConsumedWatts: 312 }] });
    if (u === '/redfish/v1/Chassis/System.Embedded.1/Thermal') return J(500, { error: { message: 'internal' } });
    if (u === '/redfish/v1/Systems') return J(200, { Members: [{ '@odata.id': '/redfish/v1/Systems/System.Embedded.1' }] });
    if (u === '/redfish/v1/Systems/System.Embedded.1') return J(200, { Manufacturer: 'Dell Inc.', Model: 'PowerEdge R750', SKU: 'SYNTH01', PowerState: 'On' });
    return J(404, { error: { message: 'not found' } });
  });
  const port = await listen(srv);
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  return { st, host: `http://127.0.0.1:${port}` };
}

/* ───────────── 가짜 NSX(신원 확인 403 — NSX 의 틀린 자격증명 응답) ───────────── */
async function fakeNsx() {
  const st = { nodeCalls: 0 };
  const srv = http.createServer(async (req, res) => {
    await readBody(req);
    if (req.url === '/api/v1/node') st.nodeCalls += 1;
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end('{"error_code":403,"error_message":"The credentials were incorrect or the account specified has been locked."}');
  });
  const port = await listen(srv);
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  return { st, host: `http://127.0.0.1:${port}` };
}

/* ───────────── 모든 인증을 거부하는 SSH 서버(계정별 비밀번호 시도 수를 센다) ───────────── */
async function sshRejectServer(host = '127.0.0.1') {
  const { Server, utils } = ssh2;
  const kp = utils.generateKeyPairSync('ed25519');
  const tries = new Map(); // username → 비밀번호 시도 수
  const conns = new Map(); // username → 연결 수(첫 인증 요청 기준)
  const srv = new Server({ hostKeys: [kp.private] }, (client) => {
    let seen = false;
    client.on('authentication', (ctx) => {
      if (!seen) { seen = true; conns.set(ctx.username, (conns.get(ctx.username) || 0) + 1); }
      if (ctx.method !== 'none') tries.set(ctx.username, (tries.get(ctx.username) || 0) + 1);
      ctx.reject(['password']);
    });
    client.on('error', () => {});
  });
  const port = await new Promise((resolve) => srv.listen(0, host, () => resolve(srv.address().port)));
  closers.push(() => new Promise((r) => srv.close(() => r())));
  return { port, tries: (u) => tries.get(u) || 0, conns: (u) => conns.get(u) || 0 };
}

const writeJson = (name, obj) => fs.writeFileSync(path.join(DIR, name), JSON.stringify(obj, null, 2));

/* ════════════════════════════ vCenter ════════════════════════════ */

test('vCenter: SOAP InvalidLogin 은 authFailed 이고 REST 로 폴백하지 않는다(같은 계정 두 번째 로그인 금지)', async () => {
  const { collectFromVCenter, isVcAuthError } = await import('../src/vcenter/restClient.js');
  const vc = await fakeVcenter();
  const err = await collectFromVCenter({ id: 'vc-x', name: 'x', host: vc.host, username: 'u', password: 'bad', timeoutMs: 5000 }).then(() => null, (e) => e);
  assert.ok(err, '실패해야 한다');
  assert.equal(isVcAuthError(err), true, `자격증명 거부로 분류돼야 한다: ${err?.message}`);
  assert.match(err.message, /인증 실패\(InvalidLogin\)/);
  assert.equal(vc.st.soapLogins, 1);
  assert.equal(vc.st.restLogins, 0, 'SOAP 가 거부했는데 REST 로 다시 로그인하면 실패 로그인이 두 배가 된다');
});

test('vCenter(store): 1주기 뒤 주기 수집은 로그인 0회 · 화면에 authStopped · 재시작 뒤에도 pending 이 아니다 · 비밀번호 변경 재개 · 수동 실행은 시도', async () => {
  const vc = await fakeVcenter();
  const refused = await closedPort();
  const reg = (pw) => writeJson('vcenters.json', { vcenters: [
    { id: 'vc-auth', name: 'VC-AUTH', host: vc.host, username: 'administrator@vsphere.local', password: pw, enabled: true, timeoutMs: 5000 },
    { id: 'vc-down', name: 'VC-DOWN', host: `http://127.0.0.1:${refused}`, username: 'administrator@vsphere.local', password: 'ok', enabled: true, timeoutMs: 3000 },
  ] });
  reg('bad');
  const { store } = await import('../src/store.js');
  const { vcAuthGuard } = await import('../src/vcenter/restClient.js');
  const { loadVcenterConfig } = await import('../src/config.js');
  const vcOf = (id) => loadVcenterConfig().vcenters.find((v) => v.id === id);

  await store.refresh();
  assert.equal(vc.st.soapLogins, 1, '첫 주기 1회');
  assert.equal(vc.st.restLogins, 0);
  let snap = store.get();
  let row = snap.vcenters.find((v) => v.id === 'vc-auth');
  assert.equal(row.status, 'unreachable');
  assert.ok(row.authStopped && row.authStopped.attempts === 1, `vCenter 항목이 정지를 말해야 한다: ${JSON.stringify(row)}`);
  assert.ok((snap.collectionErrors || []).find((e) => e.vcenterId === 'vc-auth')?.authStopped, 'collectionErrors 에도 싣는다');
  // 연결 거부(일시 장애)는 멈추지 않는다(규칙 4)
  assert.equal(vcAuthGuard.authStopFor(vcOf('vc-down')), null, '연결 실패로 멈추면 일시 장애가 수집을 영구 정지시킨다');
  assert.equal(snap.vcenters.find((v) => v.id === 'vc-down')?.authStopped, undefined);

  // 두 번째 주기(주기 간격은 비운다 — 정지가 아니라 간격 때문에 건너뛴 것으로 통과하지 않게)
  store.vcLast.clear();
  await store.refresh();
  assert.equal(vc.st.soapLogins, 1, '정지된 vCenter 에 다시 로그인하면 계정이 잠긴다');
  assert.equal(vcAuthGuard.authStopFor(vcOf('vc-down')), null, '연결 실패 vCenter 는 두 번째 주기에도 정지되지 않는다');

  // 재시작 직후(캐시 없음) — 파일에 남은 정지를 '첫 수집 중(pending)' 으로 말하면 영원히 안 채워지는 거짓이다.
  store.vcCache.clear(); store.vcLast.clear();
  await store.refresh();
  assert.equal(vc.st.soapLogins, 1);
  row = store.get().vcenters.find((v) => v.id === 'vc-auth');
  assert.equal(row.status, 'unreachable', `pending 이면 거짓 안내다: ${row.status}`);
  assert.ok(row.authStopped);

  // 수동 '지금 수집'(collectAll)은 막지 않는다 — 1회 시도
  await store.refresh({ collectAll: true });
  assert.equal(vc.st.soapLogins, 2, '수동 실행은 정지와 무관하게 1회 시도한다');

  // 비밀번호를 고치면(credHash 변경) 주기 수집이 스스로 재개된다
  reg('changed-password');
  store.vcLast.clear();
  await store.refresh();
  assert.equal(vc.st.soapLogins, 3, '자격증명이 바뀌면 자동 재개');
});

test('vCenter 데드라인(collectWithDeadline)은 진행 중인 요청을 실제로 끊고 REST 로 폴백하지 않는다(v2.417 규약)', async () => {
  const { collectWithDeadline } = await import('../src/store.js');
  const vc = await fakeVcenter({ hang: true });
  const t0 = Date.now();
  const err = await collectWithDeadline({ id: 'vc-hang', name: 'hang', host: vc.host, username: 'u', password: 'p', timeoutMs: 60_000 }, 300).then(() => null, (e) => e);
  assert.ok(err && /데드라인 초과/.test(err.message), `데드라인 오류여야 한다: ${err?.message}`);
  // 서버가 끊김을 보기까지 잠깐 기다린다(소켓 파기는 비동기)
  for (let i = 0; i < 40 && !vc.st.aborted; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(vc.st.aborted, 1, '결과만 포기하면 버려진 수집이 60초 시한까지 세션을 붙잡는다');
  assert.ok(vc.st.abortedAt - t0 < 2000, `데드라인 직후 끊겨야 한다(${vc.st.abortedAt - t0}ms)`);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(vc.st.requests, 1, '끊긴 뒤 REST 폴백으로 새 요청을 만들면 안 된다');
});

/* ════════════════════════════ iDRAC ════════════════════════════ */

test('iDRAC: 전부 401 인 서버는 1주기 뒤 로그인 0회 · 상태가 말한다 · 수동 실행·비밀번호 변경은 다시 시도 · 연결 거부는 멈추지 않는다', async () => {
  const rf = await fakeRedfish({ mode: 'deny' });
  const refused = await closedPort();
  const reg = (pw) => writeJson('idrac.json', { servers: [
    { id: 'idr-auth', name: 'IDR-AUTH', type: 'idrac', host: rf.host, username: 'root', password: pw, enabled: true },
    { id: 'idr-down', name: 'IDR-DOWN', type: 'idrac', host: `http://127.0.0.1:${refused}`, username: 'root', password: 'calvin', enabled: true },
  ] });
  reg('bad');
  const { pollNow, getPollerStatus } = await import('../src/idrac/poller.js');

  let last = await pollNow();
  const first = rf.st.credAttempts;
  assert.ok(first > 0, '첫 주기는 시도한다');
  let r = last.results.find((x) => x.id === 'idr-auth');
  assert.ok(r?.authStopped, `결과가 정지를 말해야 한다: ${JSON.stringify(r)}`);
  assert.ok(!last.results.find((x) => x.id === 'idr-down')?.authStopped, '연결 거부는 멈추지 않는다');
  assert.equal(getPollerStatus().authStops.map((s) => s.id).join(','), 'idr-auth');

  last = await pollNow();
  assert.equal(rf.st.credAttempts, first, '정지된 iDRAC 에 다시 인증하면 IP 차단·계정 잠금에 걸린다');
  assert.equal(last.authSkipped, 1);
  assert.equal(last.ok, 0, '정지로 건너뛴 서버를 성공으로 세지 않는다');
  assert.ok(last.results.find((x) => x.id === 'idr-down')?.error, '연결 거부 서버는 두 번째 주기에도 시도한다');

  await pollNow({ manual: true });
  assert.ok(rf.st.credAttempts > first, '수동 실행은 막지 않는다');
  const afterManual = rf.st.credAttempts;

  reg('changed-password');
  await pollNow();
  assert.ok(rf.st.credAttempts > afterManual, '자격증명이 바뀌면 자동 재개');
});

test('iDRAC(C): Thermal 을 못 읽으면 "읽었고 0개" 가 아니다 — thermalOk:false · 팬 컬렉션 failed · sensorError', async () => {
  const rf = await fakeRedfish({ mode: 'thermal-fail' });
  const { fetchSensors } = await import('../src/idrac/redfish.js');
  const sn = await fetchSensors({ host: rf.host, username: 'root', password: 'calvin' });
  assert.equal(sn.thermalOk, false);
  assert.match(sn.error, /Thermal 조회 실패/);
  assert.deepEqual(sn.fans, []);

  writeJson('idrac.json', { servers: [{ id: 'idr-thermal', name: 'IDR-T', type: 'idrac', host: rf.host, username: 'root', password: 'calvin', enabled: true }] });
  const { pollNow } = await import('../src/idrac/poller.js');
  const { getInventory } = await import('../src/idrac/invCache.js');
  const last = await pollNow({ manual: true });
  const r = last.results.find((x) => x.id === 'idr-thermal');
  assert.equal(r.watts, 312, '전력은 읽혔다');
  assert.match(String(r.sensorError || ''), /Thermal/, `센서 실패 사유를 남긴다: ${JSON.stringify(r)}`);
  const inv = getInventory('idr-thermal');
  assert.equal(inv?.collections?.fans, 'failed', '못 읽은 팬을 ok 로 두면 파트 장애가 열린 팬 장애를 닫는다(v2.548 F1)');
});

/* ════════════════════════════ NSX ════════════════════════════ */

test('NSX: 신원 확인 403(틀린 자격증명)은 1주기 뒤 로그인 0회 · 매니저가 정지를 말한다 · 비밀번호 변경 재개', async () => {
  const nx = await fakeNsx();
  const reg = (pw) => writeJson('nsx.json', { managers: [{ id: 'nsx-auth', name: 'NSX-AUTH', host: nx.host, username: 'admin', password: pw, enabled: true }] });
  reg('bad');
  const { nsxStore } = await import('../src/nsx/store.js');

  await nsxStore.refresh();
  assert.equal(nx.st.nodeCalls, 1);
  const mgr = (nsxStore.get().managers || []).find((m) => m.id === 'nsx-auth');
  assert.equal(mgr?.status, 'unreachable');
  assert.ok(mgr?.authStopped, `매니저가 정지를 말해야 한다: ${JSON.stringify(mgr)}`);

  nsxStore.last.clear();
  await nsxStore.refresh();
  assert.equal(nx.st.nodeCalls, 1, '정지된 매니저에 다시 로그인하면 NSX API 잠금에 걸린다');

  reg('changed-password');
  nsxStore.last.clear();
  await nsxStore.refresh();
  assert.equal(nx.st.nodeCalls, 2, '자격증명이 바뀌면 자동 재개');
});

/* ════════════════════════════ SSH 수집기(SAN·PDU·베어메탈) ════════════════════════════ */

test('SAN 스위치(SSH): 1주기 뒤 비밀번호 시도 0회 · 스냅샷이 정지를 말한다 · 수동·자격증명 변경은 시도 · 연결 거부는 멈추지 않는다', async () => {
  const ssh = await sshRejectServer();
  const refused = await closedPort();
  const { _resetForTest: resetReg } = await import('../src/sanswitch/registry.js');
  const reg = (pw) => {
    writeJson('sanswitch-devices.json', { version: 1, devices: [
      { id: 'sw-auth', name: 'SW-AUTH', type: 'brocade', host: '127.0.0.1', sshPort: ssh.port, username: 'sanuser', password: pw, collectMethod: 'ssh', agent: '' },
      { id: 'sw-down', name: 'SW-DOWN', type: 'brocade', host: '127.0.0.2', sshPort: refused, username: 'sandown', password: 'x', collectMethod: 'ssh', agent: '' },
    ] });
    resetReg();
  };
  reg('bad');
  const { pollSanSwitchOnce, sanAuthGuard } = await import('../src/sanswitch/poller.js');
  const { getSnapshot } = await import('../src/sanswitch/store.js');
  const { getDeviceWithSecret } = await import('../src/sanswitch/registry.js');

  let r = await pollSanSwitchOnce();
  const first = ssh.tries('sanuser');
  assert.ok(first > 0);
  assert.ok(getSnapshot('sw-auth')?.extra?.authStopped, '스냅샷이 정지를 말해야 한다');
  assert.equal(sanAuthGuard.authStopFor(getDeviceWithSecret('sw-down')), null, '연결 거부로는 멈추지 않는다');

  r = await pollSanSwitchOnce();
  assert.equal(ssh.tries('sanuser'), first, '정지된 스위치에 다시 로그인하면 계정이 잠긴다');
  assert.equal(r.authStopped, 1);
  assert.equal(r.failed, 1, '연결 거부 스위치는 두 번째 주기에도 시도(실패)한다');

  await pollSanSwitchOnce({ manual: true });
  assert.ok(ssh.tries('sanuser') > first, '수동 전체 수집은 막지 않는다');
  const afterManual = ssh.tries('sanuser');

  reg('changed-password');
  await pollSanSwitchOnce();
  assert.ok(ssh.tries('sanuser') > afterManual, '자격증명이 바뀌면 자동 재개');
});

test('PDU(SSH): 1주기 뒤 비밀번호 시도 0회 · 스냅샷 authStopped · 개별 수집(수동)·자격증명 변경은 시도', async () => {
  const ssh = await sshRejectServer();
  const { _resetForTest: resetReg } = await import('../src/pdu/registry.js');
  const reg = (pw) => {
    writeJson('pdu-devices.json', { devices: [{ id: 'pdu-auth', name: 'PDU-AUTH', host: '127.0.0.1', sshPort: ssh.port, username: 'pduuser', password: pw, enabled: true, agent: '' }] });
    resetReg();
  };
  reg('bad');
  const pdu = await import('../src/pdu/poller.js');
  pdu._resetForTest();

  await pdu.pollOnce();
  const first = ssh.tries('pduuser');
  assert.ok(first > 0);
  assert.ok(pdu.getLocalSnapshot('pdu-auth')?.authStopped, '스냅샷이 정지를 말해야 한다');

  const r = await pdu.pollOnce();
  assert.equal(ssh.tries('pduuser'), first, '정지된 PDU 에 다시 로그인하면 NMC 계정이 잠긴다');
  assert.equal(r.authStopped, 1);
  assert.equal(r.failed, 0, '정지로 건너뛴 장비를 실패로 세지 않는다');

  await pdu.collectDeviceNow('pdu-auth');   // 행의 '수집' 버튼(수동)
  assert.ok(ssh.tries('pduuser') > first, '수동 수집은 막지 않는다');
  const afterManual = ssh.tries('pduuser');

  reg('changed-password');
  await pdu.pollOnce();
  assert.ok(ssh.tries('pduuser') > afterManual, '자격증명이 바뀌면 자동 재개');
});

test('베어메탈 스토리지(SSH): 주기(interval) 수집은 1회 뒤 0회 · 정지 사실을 남긴다 · 지금 수집(manual)·자격증명 변경은 시도', async () => {
  const ssh = await sshRejectServer();
  const { saveBmServer } = await import('../src/bmstor/registry.js');
  const saved = saveBmServer({ name: 'BM-AUTH', host: '127.0.0.1', port: ssh.port, username: 'bmuser', password: 'bad', mounts: ['/'], agent: '' });
  assert.equal(saved.ok, true, saved.reason);
  const id = saved.server.id;
  const { bmCollectNow, getBmLatest } = await import('../src/bmstor/poller.js');

  await bmCollectNow('interval');
  const first = ssh.tries('bmuser');
  assert.ok(first > 0);
  assert.ok(getBmLatest().get(id)?.authStopped, '결과가 정지를 말해야 한다');

  const r = await bmCollectNow('interval');
  assert.equal(ssh.tries('bmuser'), first, '정지된 서버에 다시 로그인하면 OS 계정이 잠긴다');
  assert.equal(r.authStopped, 1);
  assert.ok(getBmLatest().get(id)?.authStopped, '건너뛴 주기에도 정지 사실을 유지한다');

  await bmCollectNow('manual');
  assert.ok(ssh.tries('bmuser') > first, '지금 수집은 막지 않는다');
  const afterManual = ssh.tries('bmuser');

  saveBmServer({ id, name: 'BM-AUTH', host: '127.0.0.1', port: ssh.port, username: 'bmuser', password: 'changed-password', mounts: ['/'], agent: '' });
  await bmCollectNow('interval');
  assert.ok(ssh.tries('bmuser') > afterManual, '자격증명이 바뀌면 자동 재개');
});

test('GPU 게스트 SSH: 자격증명 거부면 다른 IP 를 더 시도하지 않고 authFailed 로 던진다(IP 수만큼 실패 로그인 금지)', async (t) => {
  // guestIps 는 루프백을 거르므로(127.*) 이 호스트의 비루프백 IPv4 가 있어야 한다.
  const own = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
  if (!own) { t.skip('비루프백 IPv4 가 없는 환경 — 생략'); return; }
  const ssh = await sshRejectServer('0.0.0.0');
  const { collectVmGpuSsh, isGpuAuthError } = await import('../src/gpu/sshCollect.js');
  // 두 번째 IP 는 문서용 주소(TEST-NET-1) — 시도하면 시한까지 매달린다. 시도하지 않아야 빨리 끝난다.
  const t0 = Date.now();
  const err = await collectVmGpuSsh({ name: 'gpu-vm', ipAddresses: [own, '192.0.2.1'] }, { username: 'gpuuser', password: 'bad' }, { timeoutMs: 5000, port: ssh.port }).then(() => null, (e) => e);
  assert.ok(err, '실패해야 한다');
  assert.equal(err.authFailed, true, `자격증명 거부 플래그: ${err.message}`);
  assert.equal(isGpuAuthError(err), true);
  assert.equal(ssh.conns('gpuuser'), 1);
  assert.ok(Date.now() - t0 < 4000, `두 번째 IP 를 시도하지 않아야 한다(${Date.now() - t0}ms)`);
});

test('판정 경계: 연결 실패·타임아웃은 어느 수집기에서도 자격증명 거부가 아니다(규칙 4)', async () => {
  const { isSanAuthError } = await import('../src/sanswitch/poller.js');
  const { isIdracAuthError } = await import('../src/idrac/poller.js');
  const { isGpuAuthError } = await import('../src/gpu/sshCollect.js');
  const { isVcAuthError } = await import('../src/vcenter/restClient.js');
  const { isNsxAuthError } = await import('../src/nsx/client.js');
  const transient = [
    Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:22'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
    new Error('SSH 접속 취소(타임아웃)'),
    Object.assign(new Error('Redfish /redfish/v1/Chassis -> 503 Service Unavailable'), { status: 503 }),
    new Error('SOAP 500: A general system error occurred'),
  ];
  for (const e of transient) {
    assert.equal(isSanAuthError(e), false, `SAN: ${e.message}`);
    assert.equal(isIdracAuthError(e), false, `iDRAC: ${e.message}`);
    assert.equal(isGpuAuthError(e), false, `GPU: ${e.message}`);
    assert.equal(isVcAuthError(e), false, `vCenter: ${e.message}`);
    assert.equal(isNsxAuthError(e), false, `NSX: ${e.message}`);
  }
  // vCenter 는 출처가 붙인 플래그만 본다 — 로그인 뒤 조회의 401(세션 만료)은 authFailed 가 아니다.
  assert.equal(isVcAuthError(Object.assign(new Error('GET /api/vcenter/vm -> 401'), { status: 401 })), false);
});

/* ════════════════════════════ E — SAN 헬스 경보 ════════════════════════════ */

test('SAN(E): 스위치 상태를 못 읽으면 health.alerts 는 0 이 아니라 null(확인 불가)', async () => {
  const fosSsh = await import('../src/sanswitch/collectors/fosSsh.js');
  const fosRest = await import('../src/sanswitch/collectors/fosRest.js');
  const { emptySnapshot } = await import('../src/sanswitch/types.js');
  const dev = { id: 'sw-e', name: 'sw-e', type: 'brocade', host: '10.0.0.1' };
  assert.equal(fosSsh.buildSnapshot(dev, {}, {}).health.alerts, null, 'switchstatusshow 가 없으면 확인 불가');
  const txt = 'Switch Health Report\nSwitch State:   MARGINAL\nPower supplies monitor   MARGINAL\nFans monitor   HEALTHY\n';
  assert.equal(fosSsh.buildSnapshot(dev, { switchstatusshow: txt }, {}).health.alerts, 1, '읽었으면 숫자');
  assert.equal(fosRest.buildSnapshot(dev, {}).health.alerts, null, 'REST 는 상태 모니터를 조회하지 않는다');
  assert.equal(emptySnapshot(dev).health.alerts, null);
});
