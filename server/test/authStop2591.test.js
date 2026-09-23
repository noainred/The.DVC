/**
 * test/authStop2591.test.js — 인증 실패 정지 가드의 **남은 경로**가 실제로 로그인을 멈추는가(v2.591).
 *
 * ── 왜 이 테스트가 있나 ────────────────────────────────────────────────────────
 * v2.590 은 주 폴러(vCenter·iDRAC·NSX·SSH 5종)에 정지를 붙였다. v2.591 감사(authguard-rest)가 확인한 것:
 *  F1 같은 vCenter 계정으로 로그인하는 **보조 수집기**(현재 사용자·실시간 스파이크·게스트 디스크·OS 판별 스캐너·
 *     게스트 조사·VM 복제 스케줄)는 주 폴러가 멈춰도 **주기마다 같은 계정으로 계속 로그인**했다.
 *  F2 게스트 계정(InvalidGuestLogin)은 한 실행에서 **VM 수만큼** 실패 로그온이 났다(도메인 계정이면 첫 실행에 잠긴다).
 *  F3 iDRAC 대역 스캔은 주기마다 대역의 모든 IP 에 스캔 계정으로 3~4회씩 인증했다.
 *  F4 메일(SMTP)·F5 네트워크 모니터(SSH)·F6 성능 모달(20초 자동 갱신)에 정지가 없었다.
 * ⚠ 문자열이 아니라 **실제 로그인 시도 횟수**를 센다 — 가짜 vCenter(SOAP InvalidLogin·InvalidGuestLogin)·가짜
 *   Redfish(401)·가짜 NSX·가짜 SMTP(535)·모든 인증을 거부하는 ssh2 서버. 방향 셋을 함께 고정한다 —
 *   ① 1주기 뒤 다음 주기 0회 ② 수동 실행은 시도(고친 뒤 확인할 길) ③ 자격증명을 바꾸면 재개 ④ 연결 실패는 멈추지 않는다.
 * ⚠ 기준 시각에 `Date.now()` 를 쓰지 않는다(CLAUDE.md v2.517) — 시각 경계를 판정하는 곳은 모듈이 찍은 값에서 떨어뜨린다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import ssh2 from 'ssh2';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'authstop2591-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';   // 이 테스트의 가짜 서버가 127.0.0.1 에 산다 — 이 테스트 전용
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

const closers = [];
after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

const listen = (srv, host = '127.0.0.1') => new Promise((resolve) => srv.listen(0, host, () => resolve(srv.address().port)));
async function closedPort() {
  const s = net.createServer();
  const p = await listen(s);
  await new Promise((r) => s.close(r));
  return p;
}
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => resolve(b)); });
const writeJson = (name, obj) => fs.writeFileSync(path.join(DIR, name), JSON.stringify(obj, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────────── 가짜 vCenter — Login 은 goodPw 만 통과 · 게스트 작업은 전부 InvalidGuestLogin ───────────── */
const ENV = (inner) => '<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body>'
  + inner + '</soapenv:Body></soapenv:Envelope>';
const SC_XML = ENV('<RetrieveServiceContentResponse xmlns="urn:vim25"><returnval>'
  + '<rootFolder type="Folder">group-d1</rootFolder><propertyCollector type="PropertyCollector">propertyCollector</propertyCollector>'
  + '<viewManager type="ViewManager">ViewManager</viewManager><sessionManager type="SessionManager">SessionManager</sessionManager>'
  + '<perfManager type="PerformanceManager">PerfMgr</perfManager>'
  + '<guestOperationsManager type="GuestOperationsManager">guestOperationsManager</guestOperationsManager>'
  + '<about><version>8.0.2</version><build>1</build><fullName>VMware vCenter Server 8.0.2</fullName><apiVersion>8.0.2.0</apiVersion></about>'
  + '</returnval></RetrieveServiceContentResponse>');
const FAULT = (type, msg) => ENV(`<soapenv:Fault><faultcode>ServerFaultCode</faultcode><faultstring>${msg}</faultstring>`
  + `<detail><${type}Fault xmlns="urn:vim25" xsi:type="${type}"></${type}Fault></detail></soapenv:Fault>`);
const GOM_PROPS = ENV('<RetrievePropertiesResponse xmlns="urn:vim25"><returnval><obj type="GuestOperationsManager">guestOperationsManager</obj>'
  + '<propSet><name>processManager</name><val type="GuestProcessManager" xsi:type="ManagedObjectReference">gProc</val></propSet>'
  + '<propSet><name>fileManager</name><val type="GuestFileManager" xsi:type="ManagedObjectReference">gFile</val></propSet>'
  + '<propSet><name>authManager</name><val type="GuestAuthManager" xsi:type="ManagedObjectReference">gAuth</val></propSet>'
  + '</returnval></RetrievePropertiesResponse>');

async function fakeVcenter({ goodPw = 'good', nonAuthVms = new Set() } = {}) {
  const st = { soapLogins: 0, goodLogins: 0, restLogins: 0, guestOps: 0, guestByUser: new Map() };
  const srv = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const send = (code, xml) => { res.writeHead(code, { 'content-type': 'text/xml' }); res.end(xml); };
    if (req.url === '/sdk') {
      if (body.includes('<RetrieveServiceContent')) return send(200, SC_XML);
      if (body.includes('<Login ')) {
        st.soapLogins += 1;
        if (body.includes(`<password>${goodPw}</password>`)) { st.goodLogins += 1; return send(200, ENV('<LoginResponse xmlns="urn:vim25"><returnval><key>s1</key><userName>u</userName></returnval></LoginResponse>')); }
        return send(500, FAULT('InvalidLogin', 'Cannot complete login due to an incorrect user name or password.'));
      }
      if (body.includes('<Logout ')) return send(200, ENV('<LogoutResponse xmlns="urn:vim25"></LogoutResponse>'));
      if (/InGuest|ToGuest|FromGuest/.test(body)) {   // InitiateFileTransferToGuest 는 'InGuest' 를 포함하지 않는다
        st.guestOps += 1;
        const u = /<username>([^<]*)<\/username>/.exec(body)?.[1] || '';
        st.guestByUser.set(u, (st.guestByUser.get(u) || 0) + 1);
        // 인증과 무관한 게스트 실패(도구 미동작) — 차단기가 이것을 '성공' 으로 세지 않는지 보는 데 쓴다
        const vmRef = /<vm type="VirtualMachine">([^<]*)<\/vm>/.exec(body)?.[1] || '';
        if (nonAuthVms.has(vmRef)) return send(500, FAULT('GuestOperationsUnavailable', 'The guest operations agent could not be contacted.'));
        return send(500, FAULT('InvalidGuestLogin', 'Failed to authenticate with the guest operating system using the supplied credentials.'));
      }
      if (body.includes('GuestOperationsManager')) return send(200, GOM_PROPS);
      if (body.includes('<RetrieveProperties')) return send(200, ENV('<RetrievePropertiesResponse xmlns="urn:vim25"></RetrievePropertiesResponse>'));
      return send(500, FAULT('NotSupported', 'unexpected'));
    }
    if (req.url === '/api/session' && req.method === 'POST') { st.restLogins += 1; res.writeHead(401); res.end('{}'); return; }
    res.writeHead(404); res.end();
  });
  const port = await listen(srv);
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  return { st, host: `http://127.0.0.1:${port}` };
}

/* ───────────── 가짜 Redfish(401 · 선택적으로 응답 지연) ───────────── */
async function fakeRedfish({ delayMs = 0, mode = 'deny' } = {}) {
  const st = { basicSystems: 0, credAttempts: 0, requests: 0 };
  const srv = http.createServer(async (req, res) => {
    st.requests += 1;
    await readBody(req);
    if (delayMs) await sleep(delayMs);
    const u = req.url.split('?')[0];
    const J = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (mode === 'forbidden') return J(403, { error: { message: 'Insufficient privileges' } });
    if (u === '/redfish/v1' && !req.headers.authorization) return J(200, { Vendor: 'Dell', Oem: { Dell: {} }, Product: 'Integrated Dell Remote Access Controller' });
    if (req.headers.authorization || (req.method === 'POST' && /SessionService\/Sessions/.test(u))) st.credAttempts += 1;
    if (u === '/redfish/v1/Systems' && /^Basic /.test(req.headers.authorization || '')) st.basicSystems += 1;
    return J(401, { error: { '@Message.ExtendedInfo': [{ Message: 'Unable to complete the operation because an invalid username and/or password is entered, and therefore authentication failed.' }] } });
  });
  const port = await listen(srv);
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  return { st, host: `http://127.0.0.1:${port}` };
}

/* ───────────── 모든 인증을 거부하는 SSH 서버 ───────────── */
async function sshRejectServer() {
  const { Server } = ssh2;
  // 호스트 키는 Node crypto 의 EC SEC1 PEM — ssh2 의 ed25519 생성기는 자기 파서가 거부하는 키를 0.52% 만든다(v2.590 CI).
  const hostKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' });
  const tries = new Map();
  const srv = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method !== 'none') tries.set(ctx.username, (tries.get(ctx.username) || 0) + 1);
      ctx.reject(['password']);
    });
    client.on('error', () => {});
  });
  const port = await new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
  closers.push(() => new Promise((r) => srv.close(() => r())));
  return { port, tries: (u) => tries.get(u) || 0 };
}

/* ───────────── 가짜 SMTP(AUTH 는 authOk() 가 참일 때만 235, 아니면 535) ───────────── */
async function fakeSmtp({ authOk = () => false, mailFromCode = 250 } = {}) {
  const st = { auths: 0, mails: 0 };
  const srv = net.createServer((sock) => {
    let buf = ''; let inData = false;
    sock.write('220 fake ESMTP\r\n');
    const handle = (line) => {
      if (inData) { if (line === '.') { inData = false; st.mails += 1; sock.write('250 2.0.0 queued\r\n'); } return; }
      const u = line.toUpperCase();
      if (u.startsWith('EHLO')) sock.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n');
      else if (u.startsWith('AUTH')) { st.auths += 1; sock.write(authOk() ? '235 2.7.0 ok\r\n' : '535 5.7.8 Authentication credentials invalid\r\n'); }
      else if (u.startsWith('MAIL FROM')) sock.write(`${mailFromCode} ${mailFromCode === 250 ? 'ok' : 'relay denied'}\r\n`);
      else if (u.startsWith('RCPT TO')) sock.write('250 ok\r\n');
      else if (u === 'DATA') { inData = true; sock.write('354 go\r\n'); }
      else if (u === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
      else sock.write('502 no\r\n');
    };
    sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\r\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); handle(l); } });
    sock.on('error', () => {});
  });
  const port = await listen(srv);
  closers.push(() => new Promise((r) => srv.close(() => r())));
  return { st, port };
}

/* 스냅샷 — 이 테스트들은 수집 폴러를 돌리지 않고 store 에 직접 심는다(각 테스트가 자기 vCenter id 를 쓴다). */
async function seedSnapshot({ vcenters = [], vms = [], hosts = [] }) {
  const { store } = await import('../src/store.js');
  const cur = store.get() || {};
  const keep = (arr, ids) => (arr || []).filter((x) => !ids.has(x.vcenterId ?? x.id));
  const ids = new Set(vcenters.map((v) => v.id));
  store.snapshot = {
    ...cur, source: 'live',
    vcenters: [...keep(cur.vcenters, ids), ...vcenters],
    vms: [...keep(cur.vms, ids), ...vms],
    hosts: [...keep(cur.hosts, ids), ...hosts],
  };
  return store;
}
const vmRow = (vcId, n, extra = {}) => ({ id: `${vcId}:vm-${n}`, vcenterId: vcId, name: `${vcId}-g${n}`, powerState: 'POWERED_ON', toolsStatus: 'RUNNING', guestOS: 'Red Hat Enterprise Linux 9', host: 'h1', folder: '/DC/vm/Win', ...extra });

/** 등록부 vCenter 목록을 유지하며 항목을 덮어쓴다(테스트끼리 서로의 vCenter 를 지우지 않게). */
function upsertVcenters(list) {
  const f = path.join(DIR, 'vcenters.json');
  let cur = [];
  try { cur = JSON.parse(fs.readFileSync(f, 'utf8')).vcenters || []; } catch { /* 없음 */ }
  const ids = new Set(list.map((v) => v.id));
  writeJson('vcenters.json', { vcenters: [...cur.filter((v) => !ids.has(v.id)), ...list] });
}

/* ════════════════════ F1 — vCenter 보조 수집기 ════════════════════ */

test('F1 게스트 디스크: 주 폴러가 멈춘 vCenter 는 주기 수집이 로그인 0회 · 사유를 싣는다 · 수동은 시도하고 시도 수를 올린다 · 비밀번호 변경 재개', async () => {
  const vc = await fakeVcenter();
  const reg = (pw) => upsertVcenters([{ id: 'vc-gd', name: 'VC-GD', host: vc.host, username: 'administrator@vsphere.local', password: pw, enabled: true, timeoutMs: 5000 }]);
  reg('bad');
  await seedSnapshot({ vcenters: [{ id: 'vc-gd', name: 'VC-GD' }], vms: [vmRow('vc-gd', 1)] });
  const { vcAuthGuard } = await import('../src/vcenter/restClient.js');
  const { loadVcenterConfig } = await import('../src/config.js');
  const cfg = () => loadVcenterConfig().vcenters.find((v) => v.id === 'vc-gd');
  vcAuthGuard.markAuthStopped('vc-gd', cfg(), '주 폴러 거부(테스트)');
  const { runGuestDiskNow } = await import('../src/guestdisk/poller.js');

  const auto = await runGuestDiskNow('auto');
  assert.equal(vc.st.soapLogins, 0, '멈춘 vCenter 에 보조 수집기가 로그인하면 주 폴러의 정지가 무의미해진다');
  assert.equal(auto.authStopped?.[0]?.vcenterId, 'vc-gd', `결과가 사유를 말해야 한다: ${JSON.stringify(auto)}`);
  assert.match(auto.note || '', /인증 실패/);

  const manual = await runGuestDiskNow('manual');
  assert.equal(vc.st.soapLogins, 1, '수동 실행은 막지 않는다');
  const err = (manual.errors || []).find((e) => e.vcenterId === 'vc-gd');
  assert.ok(err?.authStopped, `수동 실패도 같은 기록에 시도를 올린다: ${JSON.stringify(manual.errors)}`);
  assert.equal(vcAuthGuard.peekAuthStop(cfg())?.attempts, 2, '주 폴러와 같은 기록(시도 2회)');

  reg('changed-password');
  const resumed = await runGuestDiskNow('auto');
  assert.equal(vc.st.soapLogins, 2, '자격증명이 바뀌면 보조 수집기도 다시 시도한다');
  assert.ok(!resumed.authStopped, '재개된 주기는 건너뜀이 아니다');
});

test('F1 현재 사용자: 주기 수집은 멈춘 vCenter 를 auth-stopped 로 건너뛰고(로그인 0) · 수동 로그인 거부는 같은 기록에 올린다', async () => {
  const vc = await fakeVcenter();
  upsertVcenters([{ id: 'vc-cu', name: 'VC-CU', host: vc.host, username: 'administrator@vsphere.local', password: 'bad', enabled: true, timeoutMs: 5000 }]);
  await seedSnapshot({ vcenters: [{ id: 'vc-cu', name: 'VC-CU' }], vms: [vmRow('vc-cu', 1, { guestOS: 'Microsoft Windows Server 2022', toolsRunningStatus: 'guestToolsRunning' })] });
  const { save } = await import('../src/curuser/settings.js');
  save({ enabled: true, vcenters: { 'vc-cu': { enabled: true, folders: ['/DC/vm/Win'] } } });
  const { vcAuthGuard } = await import('../src/vcenter/restClient.js');
  const { loadVcenterConfig } = await import('../src/config.js');
  const cfg = () => loadVcenterConfig().vcenters.find((v) => v.id === 'vc-cu');
  vcAuthGuard.markAuthStopped('vc-cu', cfg(), '주 폴러 거부(테스트)');
  const { runCurUserNow } = await import('../src/curuser/poller.js');

  const auto = await runCurUserNow('auto');
  assert.equal(vc.st.soapLogins, 0);
  const sk = (auto.skippedVcenters || []).find((x) => x.vcenterId === 'vc-cu');
  assert.equal(sk?.why, 'auth-stopped', `건너뛴 사유를 말해야 한다: ${JSON.stringify(auto)}`);
  assert.ok(sk.authStopped?.attempts >= 1);

  const manual = await runCurUserNow('manual');
  assert.equal(vc.st.soapLogins, 1, '수동 실행은 막지 않는다');
  assert.ok((manual.errors || []).find((e) => e.vcenterId === 'vc-cu')?.authStopped, `거부를 기록에 올린다: ${JSON.stringify(manual.errors)}`);
  assert.equal(vcAuthGuard.peekAuthStop(cfg())?.attempts, 2);
});

test('F1 실시간 스파이크: 주기 수집은 멈춘 vCenter 를 skipped(auth-stopped)로 싣고 로그인하지 않는다', async () => {
  const vc = await fakeVcenter();
  upsertVcenters([{ id: 'vc-vs', name: 'VC-VS', host: vc.host, username: 'administrator@vsphere.local', password: 'bad', enabled: true, timeoutMs: 5000 }]);
  await seedSnapshot({ vcenters: [{ id: 'vc-vs', name: 'VC-VS' }], vms: [vmRow('vc-vs', 1)] });
  const { saveVmSeriesSettings } = await import('../src/vmseries/settings.js');
  saveVmSeriesSettings({ enabled: true });
  const { vcAuthGuard } = await import('../src/vcenter/restClient.js');
  const { loadVcenterConfig } = await import('../src/config.js');
  vcAuthGuard.markAuthStopped('vc-vs', loadVcenterConfig().vcenters.find((v) => v.id === 'vc-vs'), '주 폴러 거부(테스트)');
  const { runVmSeriesNow } = await import('../src/vmseries/poller.js');
  const r = await runVmSeriesNow('auto');
  assert.equal(vc.st.soapLogins, 0);
  const sk = (r.skipped || []).find((x) => x.vcenterId === 'vc-vs');
  assert.equal(sk?.why, 'auth-stopped', `사유: ${JSON.stringify(r)}`);
});

test('F1 VM 복제: 스케줄 실행은 멈춘 vCenter 에 로그인하지 않고 건너뜀을 기록 · 수동 실행은 시도하고 기록에 올린다', async () => {
  const vc = await fakeVcenter();
  upsertVcenters([{ id: 'vc-cl', name: 'VC-CL', host: vc.host, username: 'administrator@vsphere.local', password: 'bad', enabled: true, timeoutMs: 5000 }]);
  writeJson('vm-clone.json', { version: 1, jobs: [{ id: 'job-cl', enabled: true, vcenterId: 'vc-cl', vmId: 'vc-cl:vm-5', vmName: 'db01', dest: { type: 'datastore', datastoreName: 'ds1' }, keep: 3, clones: [], schedule: { mode: 'manual' } }] });
  const { _resetForTest, getJob } = await import('../src/vmclone/store.js');
  _resetForTest();
  const { vcAuthGuard } = await import('../src/vcenter/restClient.js');
  const { loadVcenterConfig } = await import('../src/config.js');
  const cfg = () => loadVcenterConfig().vcenters.find((v) => v.id === 'vc-cl');
  vcAuthGuard.markAuthStopped('vc-cl', cfg(), '주 폴러 거부(테스트)');
  const { enqueueRun, runnerStatus } = await import('../src/vmclone/runner.js');
  const settle = async () => { for (let i = 0; i < 200; i++) { const s = runnerStatus(); if (!s.running && !s.queued.length) return; await sleep(20); } };

  enqueueRun('job-cl', 'schedule'); await settle();
  assert.equal(vc.st.soapLogins, 0, '스케줄 실행이 멈춘 계정으로 로그인하면 안 된다');
  assert.equal(getJob('job-cl').lastRun?.skipped, 'auth-stopped', `기록: ${JSON.stringify(getJob('job-cl').lastRun)}`);
  assert.equal(getJob('job-cl').lastRun?.ok, false, '건너뜀을 성공으로 말하지 않는다');

  enqueueRun('job-cl', 'manual'); await settle();
  assert.equal(vc.st.soapLogins, 1, "'지금 실행' 은 막지 않는다");
  assert.equal(vcAuthGuard.peekAuthStop(cfg())?.attempts, 2);
});

/* ════════════════════ F2 — 게스트 계정 ════════════════════ */

test('F2 출처 표시: InvalidGuestLogin 은 게스트 거부(authFailed+guestAuth)이고 vCenter 계정 거부가 아니다', async () => {
  const { runGuestScript, isGuestLoginFault } = await import('../src/gpu/guestops.js');
  const { isVcAuthError } = await import('../src/vcenter/restClient.js');
  const { isGpuAuthError } = await import('../src/gpu/sshCollect.js');
  const { VimSoapClient } = await import('../src/vcenter/soapClient.js');
  const vc = await fakeVcenter();
  const c = new VimSoapClient({ id: 'vc-tag', host: vc.host, username: 'u', password: 'good', timeoutMs: 5000 });
  await c.login();
  const err = await runGuestScript(c, 'vm-1', { username: 'guser', password: 'x' }, 'echo 1', { isWindows: false }).then(() => null, (e) => e);
  assert.ok(err, '실패해야 한다');
  assert.equal(err.authFailed, true, err.message);
  assert.equal(err.guestAuth, true);
  assert.equal(isGpuAuthError(err), true);
  assert.equal(isVcAuthError(err), false, '게스트 거부가 vCenter 주기 수집을 멈추면 멀쩡한 계정이 죽는다');
  assert.equal(isGuestLoginFault({ fault: 'InvalidGuestLogin' }), true);
  assert.equal(isGuestLoginFault({ fault: 'GuestOperationsUnavailable', message: 'x' }), false);
  await c.logout();
});

test('F2 회로 차단기: 같은 계정 거부 연속 3회면 남은 대상을 시작하지 않는다(동시 4 에서도 정확히 3회) · 무관한 실패는 성공이 아니다', async () => {
  const { createAuthBreaker, runWithBreakerWarmup } = await import('../src/util/authGuard.js');
  const dev = { id: 'x', username: 'dom\\svc', password: 'bad' };
  // ① 전부 거부 — 첫 성공 전에는 하나씩이라 동시 4 여도 시도는 3회
  let b = createAuthBreaker({ threshold: 3 });
  let tried = 0;
  await runWithBreakerWarmup(Array.from({ length: 10 }, (_, i) => i), 4, b, async () => {
    if (!b.allow(dev)) return;
    tried += 1; await sleep(5); b.fail(dev);
  });
  assert.equal(tried, 3);
  assert.equal(b.summary().skipped, 7);
  assert.equal(b.summary().tripped.length, 1);
  // ② 성공이 한 번 끼면 '연속' 이 끊긴다(VM 마다 로컬 계정이 따로인 정상 구성)
  b = createAuthBreaker({ threshold: 3 });
  const seq = ['fail', 'fail', 'ok', 'fail', 'fail', 'ok'];
  for (const s of seq) { if (s === 'ok') b.ok(dev); else b.fail(dev); }
  assert.equal(b.isTripped(dev), false);
  // ③ 인증과 무관한 실패(도구 미동작·시한)는 카운터를 리셋하지 않는다
  b = createAuthBreaker({ threshold: 3 });
  b.fail(dev); b.neutral(); b.fail(dev); b.neutral(); b.fail(dev);
  assert.equal(b.isTripped(dev), true, '무관한 실패를 ok 로 세면 차단기가 무력해진다');
  // ④ 무관한 실패가 임계만큼 쌓이면 워밍업을 끝낸다(하나씩이 실행 시간을 N배로 늘리지 않게)
  b = createAuthBreaker({ threshold: 3 });
  assert.equal(b.warmupSequential(), true);
  b.neutral(); b.neutral(); b.neutral();
  assert.equal(b.warmupSequential(), false);
});

test('F2 게스트 조사(작업 계정): 10대 중 3회만 시도 · 작업 정지 기록 · 다음 주기는 vCenter·게스트 로그인 0 · 수동은 다시 3회 · 계정 변경 재개', async () => {
  const vc = await fakeVcenter();
  upsertVcenters([{ id: 'vc-gs', name: 'VC-GS', host: vc.host, username: 'administrator@vsphere.local', password: 'good', enabled: true, timeoutMs: 5000 }]);
  await seedSnapshot({ vcenters: [{ id: 'vc-gs', name: 'VC-GS' }], vms: Array.from({ length: 10 }, (_, i) => vmRow('vc-gs', i + 1)) });
  const gs = await import('../src/security/guestScanScheduler.js');
  const saved = gs.saveGuestScan({ name: 'LF', type: 'login-fails', vcenterId: 'vc-gs', os: 'all', intervalMin: 1, maxVms: 100, guestUser: 'dom\\scan', guestPass: 'bad' });

  let r = await gs.runGuestScanNow(saved.id, { trigger: 'manual' });
  assert.equal(vc.st.guestByUser.get('dom\\scan'), 3, `차단기가 3회에서 끊어야 한다(시도 ${vc.st.guestByUser.get('dom\\scan')})`);
  assert.equal(r.lastAuth?.breaker?.skipped, 7, JSON.stringify(r.lastAuth));
  assert.ok(r.lastAuth?.jobStopped, '작업 단위 정지를 남겨야 다음 주기가 첫 VM 부터 다시 3회를 쓰지 않는다');
  const loginsAfterManual = vc.st.soapLogins;

  // 다음 주기(스케줄) — 작업 정지라 vCenter 로그인조차 하지 않는다
  r = await gs.runGuestScanNow(saved.id, { trigger: 'schedule' });
  assert.equal(vc.st.guestByUser.get('dom\\scan'), 3, '정지된 작업 계정으로 다시 로그온하면 AD 계정이 잠긴다');
  assert.equal(vc.st.soapLogins, loginsAfterManual, '작업 정지면 vCenter 에도 로그인하지 않는다');
  assert.ok(r.lastAuth?.jobStopped);

  // 수동은 막지 않는다 — 단 차단기는 수동에도 적용(3회)
  await gs.runGuestScanNow(saved.id, { trigger: 'manual' });
  assert.equal(vc.st.guestByUser.get('dom\\scan'), 6);

  // 계정을 고치면(비밀번호 변경) 주기 실행이 스스로 재개된다
  gs.saveGuestScan({ id: saved.id, name: 'LF', type: 'login-fails', vcenterId: 'vc-gs', os: 'all', intervalMin: 1, maxVms: 100, guestUser: 'dom\\scan', guestPass: 'changed' });
  await gs.runGuestScanNow(saved.id, { trigger: 'schedule' });
  assert.equal(vc.st.guestByUser.get('dom\\scan'), 9, '자격증명이 바뀌면 자동 재개(차단기 3회)');
});

test('F2 게스트 조사: 인증과 무관한 실패(도구 미동작)가 끼어도 거부는 연속으로 센다 — 성공으로 세면 10대 전부 로그온한다', async () => {
  // 짝수 VM 은 게스트 계정 거부, 홀수 VM 은 'Tools 미동작' — 무관한 실패를 ok 로 세면 거부 사이마다 카운터가 리셋된다.
  const vc = await fakeVcenter({ nonAuthVms: new Set(['vm-2', 'vm-4', 'vm-6', 'vm-8', 'vm-10']) });
  upsertVcenters([{ id: 'vc-gs3', name: 'VC-GS3', host: vc.host, username: 'administrator@vsphere.local', password: 'good', enabled: true, timeoutMs: 5000 }]);
  await seedSnapshot({ vcenters: [{ id: 'vc-gs3', name: 'VC-GS3' }], vms: Array.from({ length: 10 }, (_, i) => vmRow('vc-gs3', i + 1)) });
  const gs = await import('../src/security/guestScanScheduler.js');
  const saved = gs.saveGuestScan({ name: 'LF3', type: 'login-fails', vcenterId: 'vc-gs3', os: 'all', intervalMin: 1, maxVms: 100, guestUser: 'dom\\mix', guestPass: 'bad' });
  const r = await gs.runGuestScanNow(saved.id, { trigger: 'manual' });
  const tried = vc.st.guestByUser.get('dom\\mix');
  // 순서: vm-1 거부(1) · vm-2 무관 · vm-3 거부(2) · vm-4 무관 · vm-5 거부(3) → 끊김. 무관 3회로 워밍업이 끝나도 상한은 임계+동시수−1
  assert.ok(tried < 10, `무관한 실패가 연속 카운터를 리셋하면 전 VM 에 로그온한다(시도 ${tried})`);
  assert.ok(r.lastAuth?.breaker?.tripped?.length === 1, JSON.stringify(r.lastAuth));
  assert.ok(r.lastAuth?.jobStopped, '끊겼으면 작업 단위 정지를 남긴다');
});

test('F2 게스트 조사: 주 폴러가 멈춘 vCenter 는 스케줄 실행이 로그인하지 않는다', async () => {
  const vc = await fakeVcenter();
  upsertVcenters([{ id: 'vc-gs2', name: 'VC-GS2', host: vc.host, username: 'administrator@vsphere.local', password: 'bad', enabled: true, timeoutMs: 5000 }]);
  await seedSnapshot({ vcenters: [{ id: 'vc-gs2', name: 'VC-GS2' }], vms: [vmRow('vc-gs2', 1)] });
  const { vcAuthGuard } = await import('../src/vcenter/restClient.js');
  const { loadVcenterConfig } = await import('../src/config.js');
  vcAuthGuard.markAuthStopped('vc-gs2', loadVcenterConfig().vcenters.find((v) => v.id === 'vc-gs2'), '주 폴러 거부(테스트)');
  const gs = await import('../src/security/guestScanScheduler.js');
  const saved = gs.saveGuestScan({ name: 'NET', type: 'net-issues', vcenterId: 'vc-gs2', os: 'all', intervalMin: 1, guestUser: 'u', guestPass: 'p' });
  const r = await gs.runGuestScanNow(saved.id, { trigger: 'schedule' });
  assert.equal(vc.st.soapLogins, 0);
  assert.ok(r.lastAuth?.vcStopped, JSON.stringify(r.lastAuth));
});

test('F2 OS 판별 스캐너(공용 계정): 주기 실행 3회에서 끊고 계정 단위 정지 · 다음 주기 게스트 로그온 0 · 수동은 시도 · 게스트 거부가 vCenter 를 멈추지 않는다', async () => {
  const vc = await fakeVcenter();
  upsertVcenters([{ id: 'vc-os', name: 'VC-OS', host: vc.host, username: 'administrator@vsphere.local', password: 'good', enabled: true, timeoutMs: 5000 }]);
  await seedSnapshot({ vcenters: [{ id: 'vc-os', name: 'VC-OS' }], vms: Array.from({ length: 10 }, (_, i) => vmRow('vc-os', i + 1)) });
  writeJson('gpu-guest.json', { vcenters: { 'vc-os': { username: 'dom\\osuser', password: 'bad' } } });
  writeJson('os-scan.json', { enabled: true, intervalMin: 5, scope: 'vc-os', maxVms: 50, concurrency: 4, rescanDays: 0 });
  const os2 = await import('../src/inventory/osScanner.js');

  let r = await os2.runOsScanNow('vc-os', { trigger: 'auto' });
  assert.equal(vc.st.guestByUser.get('dom\\osuser'), 3, `주기 실행도 차단기가 3회에서 끊는다(시도 ${vc.st.guestByUser.get('dom\\osuser')})`);
  assert.equal(r.auth?.breakerSkipped, 7, JSON.stringify(r.auth));
  const { vcAuthGuard } = await import('../src/vcenter/restClient.js');
  const { loadVcenterConfig } = await import('../src/config.js');
  assert.equal(vcAuthGuard.peekAuthStop(loadVcenterConfig().vcenters.find((v) => v.id === 'vc-os')), null, '게스트 거부로 vCenter 가 멈추면 안 된다');

  // 다음 주기 — 계정 단위 정지라 아직 안 건드린 7대도 고르지 않는다(주기마다 3회씩 쌓이면 AD 잠금 임계를 넘는다)
  r = await os2.runOsScanNow('vc-os', { trigger: 'auto' });
  assert.equal(vc.st.guestByUser.get('dom\\osuser'), 3, '다음 주기는 0회');
  assert.equal(r.auth?.vmSkipped, 10, `제외 개수를 밝힌다: ${JSON.stringify(r.auth)}`);

  // 수동 '지금 스캔' 은 막지 않는다(차단기 3회)
  await os2.runOsScanNow('vc-os', { trigger: 'manual' });
  assert.equal(vc.st.guestByUser.get('dom\\osuser'), 6);

  // 공용 계정 비밀번호를 고치면 주기 실행이 재개된다
  writeJson('gpu-guest.json', { vcenters: { 'vc-os': { username: 'dom\\osuser', password: 'changed' } } });
  await os2.runOsScanNow('vc-os', { trigger: 'auto' });
  assert.equal(vc.st.guestByUser.get('dom\\osuser'), 9, '자격증명이 바뀌면 자동 재개');
});

test('F2 OS 판별 스캐너: 인증과 무관한 실패가 끼어도 거부는 연속으로 센다(성공으로 세지 않는다)', async () => {
  const vc = await fakeVcenter({ nonAuthVms: new Set(['vm-2', 'vm-4', 'vm-6', 'vm-8', 'vm-10']) });
  upsertVcenters([{ id: 'vc-os3', name: 'VC-OS3', host: vc.host, username: 'administrator@vsphere.local', password: 'good', enabled: true, timeoutMs: 5000 }]);
  await seedSnapshot({ vcenters: [{ id: 'vc-os3', name: 'VC-OS3' }], vms: Array.from({ length: 10 }, (_, i) => vmRow('vc-os3', i + 1)) });
  writeJson('gpu-guest.json', { vcenters: { 'vc-os3': { username: 'dom\\osmix', password: 'bad' } } });
  writeJson('os-scan.json', { enabled: true, intervalMin: 5, scope: 'vc-os3', maxVms: 50, concurrency: 4, rescanDays: 0 });
  const os3 = await import('../src/inventory/osScanner.js');
  const r = await os3.runOsScanNow('vc-os3', { trigger: 'auto' });
  const tried = vc.st.guestByUser.get('dom\\osmix');
  assert.ok(tried < 10, `무관한 실패가 연속 카운터를 리셋하면 전 VM 에 로그온한다(시도 ${tried})`);
  assert.equal(r.auth?.breakerTripped?.length, 1, JSON.stringify(r.auth));
});

/* ════════════════════ F3 — iDRAC 대역 스캔 ════════════════════ */

test('F3 스캔 정책: 주기면 직전 인증 실패 IP·주 폴러 정지 서버를 건너뛰고, 수동은 전부 · 계정 변경 재개', async () => {
  const rf = await fakeRedfish();
  writeJson('idrac.json', { servers: [{ id: 'idr-scan', name: 'IDR-SCAN', type: 'idrac', host: rf.host, username: 'root', password: 'bad', enabled: true }] });
  const { pollNow } = await import('../src/idrac/poller.js');
  await pollNow();   // 주 폴러가 이 서버를 멈춘다(401)
  const { makeScanAuthPolicy, scanAuthGuard, scanStopId } = await import('../src/idrac/scanAuth.js');

  const periodic = makeScanAuthPolicy({ rangeId: 'r1', username: 'root', password: 'bad', periodic: true });
  assert.equal(periodic.skip('127.0.0.1'), 'registered', '등록부 host(스킴·포트 포함)와 IP 를 맞춰 주 폴러 정지를 따른다');
  periodic.noteAuthFailed('192.0.2.7', '자격증명 거부');
  periodic.flush();
  const next = makeScanAuthPolicy({ rangeId: 'r1', username: 'root', password: 'bad', periodic: true });
  assert.equal(next.skip('192.0.2.7'), 'scan');
  assert.equal(next.skip('192.0.2.8'), null);
  const otherRange = makeScanAuthPolicy({ rangeId: 'r2', username: 'root', password: 'bad', periodic: true });
  assert.equal(otherRange.skip('192.0.2.7'), null, '대역마다 따로 — 다른 대역(다른 계정일 수 있다)의 기록을 쓰지 않는다');
  const manual = makeScanAuthPolicy({ rangeId: 'r1', username: 'root', password: 'bad', periodic: false });
  assert.equal(manual.skip('192.0.2.7'), null, '수동은 전부 시도한다');
  const changed = makeScanAuthPolicy({ rangeId: 'r1', username: 'root', password: 'changed', periodic: true });
  assert.equal(changed.skip('192.0.2.7'), null, '계정을 고치면 자동 재개');
  assert.equal(changed.skip('127.0.0.1'), null);
  // 성공(발견·비 iDRAC)은 기록을 지운다
  next.noteOk('192.0.2.7'); next.flush();
  assert.equal(scanAuthGuard.peekAuthStop({ id: scanStopId('r1', '192.0.2.7'), username: 'root', password: 'bad' }), null);
});

test('F3 scanForIdracs: 정책이 건너뛴 IP 는 시도하지 않고 개수·목록을 밝힌다', async () => {
  const { scanForIdracs } = await import('../src/idrac/scan.js');
  const policy = { periodic: true, skip: (ip) => (ip === '192.0.2.21' ? 'scan' : ip === '192.0.2.22' ? 'registered' : null), noteAuthFailed() {}, noteOk() {}, flush() {} };
  const r = await scanForIdracs({ ips: '192.0.2.21\n192.0.2.22\n192.0.2.23', username: 'root', password: 'x', perHostTimeout: 300, authPolicy: policy });
  assert.equal(r.authSkipped, 2);
  assert.equal(r.authSkippedRegistered, 1);
  assert.deepEqual(r.authSkippedIps, ['192.0.2.21', '192.0.2.22']);
  assert.equal(r.unreachable, 1, '건너뛰지 않은 IP 는 그대로 시도한다');
});

test('F3 probeIdrac: 인증 실패 원인을 읽으려고 한 번 더 인증하지 않는다(Basic 401 본문 재사용)', async () => {
  const rf = await fakeRedfish();
  const { probeIdrac } = await import('../src/idrac/redfish.js');
  const r = await probeIdrac(rf.host, 'root', 'bad', 3000);
  assert.equal(r.authFailed, true);
  assert.match(r.authHint || '', /invalid username/i, `iDRAC 메시지를 읽었다: ${r.authHint}`);
  assert.equal(rf.st.basicSystems, 1, `Systems 에 Basic 인증은 1회만(예전 2회): ${rf.st.basicSystems}`);
});

test('C5·C3 중앙 스캔: 무응답·인증실패·인증정지 건너뜀·소요를 싣고 lastRun 에 vcenters(=datacenters) 키도 싣는다 · 인증 정지로 건너뛰면 replace 를 merge 로 강등', async () => {
  const { scanAuthGuard, scanStopId } = await import('../src/idrac/scanAuth.js');
  writeJson('idrac-scan-ranges.json', { entries: {
    rng1: { datacenterId: 'DC-A', service: 'svc', ranges: ['192.0.2.31', '192.0.2.32'], username: 'root', password: 'scanpw', enabled: true, mode: 'replace-datacenter' },
  } });
  const id = scanStopId('rng1', '192.0.2.31');
  scanAuthGuard.markAuthStopped(id, { id, username: 'root', password: 'scanpw' }, '직전 스캔 거부(테스트)');
  const { runIdracScanOnce, idracScanStatus } = await import('../src/idrac/scanPoller.js');
  const r = await runIdracScanOnce({});
  assert.equal(r.ok, true, JSON.stringify(r));
  const one = r.results[0];
  assert.equal(one.authSkipped, 1, JSON.stringify(one));
  assert.equal(one.unreachable, 1, '건너뛰지 않은 IP 는 시도했다');
  assert.equal(one.authFailed, 0);
  assert.equal(typeof one.durationMs, 'number');
  assert.equal(one.modeDowngraded, true, '건너뛴 등록 서버가 replace 로 지워지면 안 된다');
  assert.equal(r.vcenters, r.datacenters, '구버전 화면 호환 키');
  assert.equal(r.authSkipped, 1);
  const lr = idracScanStatus().lastRun;
  assert.equal(lr.vcenters, 1);
  const { listScanRanges } = await import('../src/idrac/scanRanges.js');
  const rec = listScanRanges().find((e) => e.id === 'rng1').lastRun;
  assert.equal(rec.unreachable, 1, `'최근 결과' 가 무응답을 말해야 한다: ${JSON.stringify(rec)}`);
  assert.equal(rec.authSkipped, 1);
  assert.equal(typeof rec.durationMs, 'number');
});

/* ════════════════════ P1 — 수동 1회 수집 ════════════════════ */

test('P1 수동 1회 수집: 진행 중이면 busy(직전 결과를 이번 것인 척하지 않는다) · 긴급중단이면 stopped', async () => {
  const rf = await fakeRedfish({ delayMs: 400 });
  writeJson('idrac.json', { servers: [{ id: 'idr-slow', name: 'IDR-SLOW', type: 'idrac', host: rf.host, username: 'root', password: 'slowpw', enabled: true }] });
  const { pollNow, pollNowManual } = await import('../src/idrac/poller.js');
  const running = pollNow();
  await sleep(50);
  const busy = await pollNowManual();
  assert.equal(busy.busy, true);
  assert.equal(busy.ran, false);
  await running;
  const { setEmergencyStop } = await import('../src/security/emergencyStop.js');
  setEmergencyStop(true, ['t1', 't2']);
  try {
    const st = await pollNowManual();
    assert.equal(st.stopped, true, JSON.stringify(st));
    assert.equal(st.ran, false);
  } finally { setEmergencyStop(false); }
});

/* ════════════════════ R-BM1·R-BM2·R-N1 ════════════════════ */

test('R-BM1 releaseIdracAuthStop: 같은 자격증명일 때만 주 폴러 정지를 푼다', async () => {
  const rf = await fakeRedfish();
  writeJson('idrac.json', { servers: [{ id: 'idr-rel', name: 'IDR-REL', type: 'idrac', host: rf.host, username: 'root', password: 'relpw', enabled: true }] });
  const { pollNow, idracAuthStopFor, releaseIdracAuthStop } = await import('../src/idrac/poller.js');
  await pollNow();
  assert.ok(idracAuthStopFor({ id: 'idr-rel', username: 'root', password: 'relpw' }));
  assert.equal(releaseIdracAuthStop({ id: 'idr-rel', username: 'root', password: 'other' }), false, '다른 계정의 성공은 저장값이 맞다는 증거가 아니다');
  assert.ok(idracAuthStopFor({ id: 'idr-rel', username: 'root', password: 'relpw' }));
  assert.equal(releaseIdracAuthStop({ id: 'idr-rel', username: 'root', password: 'relpw' }), true);
  assert.equal(idracAuthStopFor({ id: 'idr-rel', username: 'root', password: 'relpw' }), null);
});

test('R-BM2 텔레메트리 403 은 자격증명 거부(auth)가 아니다 — forbidden · 401 은 auth', async () => {
  const { fetchUsage } = await import('../src/idrac/redfish.js');
  const f = await fakeRedfish({ mode: 'forbidden' });
  const r403 = await fetchUsage({ host: f.host, username: 'root', password: 'x' });
  assert.equal(r403.ok, false);
  assert.equal(r403.kind, 'forbidden', JSON.stringify(r403));
  const d = await fakeRedfish();
  const r401 = await fetchUsage({ host: d.host, username: 'root', password: 'bad' });
  assert.equal(r401.kind, 'auth', JSON.stringify(r401));
});

test('R-N1 NSX 연결 테스트: 저장 비밀번호로 성공하면 정지를 푼다 · 입력한 다른 비밀번호의 성공은 풀지 않는다', async () => {
  const srv = http.createServer(async (req, res) => { await readBody(req); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"node_version":"4.1"}'); });
  const port = await listen(srv);
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  writeJson('nsx.json', { managers: [{ id: 'nsx-t', name: 'NSX-T', host: `http://127.0.0.1:${port}`, username: 'admin', password: 'saved', enabled: true }] });
  const { nsxAuthGuard } = await import('../src/nsx/client.js');
  const { testConnection } = await import('../src/nsx/registry.js');
  const dev = { id: 'nsx-t', username: 'admin', password: 'saved' };
  nsxAuthGuard.markAuthStopped('nsx-t', dev, '거부(테스트)');
  const typed = await testConnection({ id: 'nsx-t', host: `http://127.0.0.1:${port}`, username: 'admin', password: 'typed-new' });
  assert.equal(typed.ok, true);
  assert.ok(!typed.authStopCleared, '입력한 새 비밀번호의 성공은 저장값이 맞다는 증거가 아니다');
  assert.ok(nsxAuthGuard.peekAuthStop(dev));
  const r = await testConnection({ id: 'nsx-t' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.authStopCleared, true);
  assert.equal(nsxAuthGuard.peekAuthStop(dev), null);
});

/* ════════════════════ F4 — SMTP ════════════════════ */

test('F4 SMTP: 535 는 출처에서 authFailed · 530(STARTTLS 요구)은 아니다', async () => {
  const { isSmtpAuthRejection, sniFor } = await import('../src/util/smtp.js');
  assert.equal(isSmtpAuthRejection({ code: 535, lines: ['5.7.8 Authentication credentials invalid'] }), true);
  assert.equal(isSmtpAuthRejection({ code: 534, lines: ['5.7.9 Please log in with your web browser'] }), true);
  assert.equal(isSmtpAuthRejection({ code: 530, lines: ['5.7.0 Authentication required'] }), true);
  assert.equal(isSmtpAuthRejection({ code: 530, lines: ['5.7.0 Must issue a STARTTLS command first'] }), false, 'TLS 요구를 계정 문제로 세면 멀쩡한 메일이 영구 정지된다');
  assert.equal(isSmtpAuthRejection({ code: 454, lines: ['4.7.0 Temporary authentication failure'] }), false, '일시 실패는 멈추지 않는다');
  assert.equal(sniFor('10.0.0.5'), undefined, 'IP 는 SNI 에 넣지 않는다(RFC 6066 · DEP0123)');
  assert.equal(sniFor('relay.corp.local'), 'relay.corp.local');
});

test('F4 메일: 자동 발송은 인증 실패 뒤 AUTH 0회(이력에 사유) · 테스트 발송은 시도 · 성공하면 풀림 · 계정 변경 재개', async () => {
  let accept = false;
  const smtp = await fakeSmtp({ authOk: () => accept });
  const cfg = (pw) => {
    writeJson('mail.json', { enabled: true, smtp: { host: '127.0.0.1', port: smtp.port, startTls: false, user: 'relay', password: pw, from: 'portal@corp.local', timeoutMs: 5000 }, defaultTo: ['ops@corp.local'], kinds: {}, rateLimitPerHour: 0 });
  };
  cfg('bad');
  const { invalidate } = await import('../src/mail/settings.js');
  invalidate();
  const mail = await import('../src/mail/service.js');
  mail._resetMail();

  let r = await mail.sendPortalMail({ kind: 'alert', subject: 's1', text: 't' });
  assert.equal(r.ok, false);
  assert.equal(smtp.st.auths, 1);
  assert.ok(r.authStopped, `거부를 정지로 기록: ${JSON.stringify(r)}`);

  r = await mail.sendPortalMail({ kind: 'alert', subject: 's2', text: 't' });
  assert.equal(smtp.st.auths, 1, '멈춘 뒤 자동 발송이 같은 계정으로 로그인하면 릴레이 계정이 잠긴다');
  assert.equal(r.skipped, true);
  assert.ok(r.authStopped);
  assert.equal(mail.mailStatus().history[0].state, 'skipped', '조용히 버리지 않는다 — 이력에 남긴다');
  assert.ok(mail.mailStatus().authStopped, '상태가 정지를 말한다');

  // 사람이 누른 테스트 발송은 막지 않는다
  await mail.sendPortalMail({ kind: 'test', subject: 't', text: 't', by: 'admin' });
  assert.equal(smtp.st.auths, 2);

  // 서버 쪽에서 풀렸다 — 테스트 발송이 성공하면 정지가 풀리고 자동 발송이 다시 나간다
  accept = true;
  r = await mail.sendPortalMail({ kind: 'test', subject: 't', text: 't', by: 'admin' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(mail.mailStatus().authStopped, null);
  r = await mail.sendPortalMail({ kind: 'alert', subject: 's3', text: 't' });
  assert.equal(r.ok, true);

  // 다시 거부 → 정지 → 비밀번호를 고치면(credHash 변경) 자동 발송이 스스로 재개된다
  accept = false;
  await mail.sendPortalMail({ kind: 'alert', subject: 's4', text: 't' });
  const before = smtp.st.auths;
  await mail.sendPortalMail({ kind: 'alert', subject: 's5', text: 't' });
  assert.equal(smtp.st.auths, before, '정지 중');
  cfg('changed'); invalidate();
  await mail.sendPortalMail({ kind: 'alert', subject: 's6', text: 't' });
  assert.equal(smtp.st.auths, before + 1, '자격증명이 바뀌면 자동 재개');
});

test('F4 메일: 속도 제한은 실패한 시도도 센다(실패가 한도를 우회하지 않게)', async () => {
  const smtp = await fakeSmtp({ mailFromCode: 550 });
  writeJson('mail.json', { enabled: true, smtp: { host: '127.0.0.1', port: smtp.port, startTls: false, user: '', password: '', from: 'portal@corp.local', timeoutMs: 5000 }, defaultTo: ['ops@corp.local'], kinds: {}, rateLimitPerHour: 2 });
  const { invalidate } = await import('../src/mail/settings.js');
  invalidate();
  const mail = await import('../src/mail/service.js');
  mail._resetMail();
  await mail.sendPortalMail({ kind: 'alert', subject: 'a', text: 't' });
  await mail.sendPortalMail({ kind: 'alert', subject: 'b', text: 't' });
  const r = await mail.sendPortalMail({ kind: 'alert', subject: 'c', text: 't' });
  assert.equal(r.skipped, true, `실패 2회로 한도(2)에 닿는다: ${JSON.stringify(r)}`);
  assert.match(r.reason, /한도/);
  assert.equal(mail.mailStatus().attemptsLastHour, 2);
  assert.equal(mail.mailStatus().sentLastHour, 0);
});

/* ════════════════════ F5 — 네트워크 연속 모니터 ════════════════════ */

test('F5 네트워크 모니터: SSH 거부 뒤 주기 실행은 로그인 0회 · 목록이 정지를 말한다 · 지금 실행은 시도 · 비밀번호 변경 재개 · 연결 거부는 멈추지 않는다', async () => {
  const ssh = await sshRejectServer();
  const refused = await closedPort();
  writeJson('capture-monitors.json', [
    { id: 'mon-a', name: 'MON-A', enabled: true, mode: 'single', intervalMin: 1, iface: 'any', seconds: 1, maxPackets: 10, useSudo: false, hostA: { host: '127.0.0.1', port: ssh.port, username: 'netuser', password: 'bad' }, peer: '10.0.0.9' },
    { id: 'mon-d', name: 'MON-D', enabled: true, mode: 'single', intervalMin: 1, iface: 'any', seconds: 1, maxPackets: 10, useSudo: false, hostA: { host: '127.0.0.1', port: refused, username: 'downuser', password: 'x' }, peer: '10.0.0.9' },
  ]);
  const mon = await import('../src/net/monitor.js');
  mon._resetNetMonitorForTest();
  const T0 = 1_900_000_000_000;   // 고정 기준 시각(주기 판정만 한다 — Date.now() 를 쓰지 않는다)

  await mon.captureMonitorTick(T0);
  const first = ssh.tries('netuser');
  assert.ok(first > 0, '첫 주기는 시도한다');
  let row = mon.listMonitors().find((m) => m.id === 'mon-a');
  assert.ok(row.authStopped?.A, `목록이 정지를 말해야 한다: ${JSON.stringify(row)}`);
  assert.equal(mon.listMonitors().find((m) => m.id === 'mon-d').authStopped, null, '연결 거부는 멈추지 않는다');

  const res = await mon.captureMonitorTick(T0 + 10 * 60_000);   // 주기(1분)를 넉넉히 넘긴 다음 틱
  assert.equal(ssh.tries('netuser'), first, '정지된 쪽에 다시 로그인하면 서버 계정이 잠긴다');
  assert.equal(res.find((x) => x.id === 'mon-a')?.skipped, 'auth-stopped');
  assert.equal(res.find((x) => x.id === 'mon-d')?.skipped, '', '연결 거부 모니터는 두 번째 주기에도 시도한다');

  await mon.runMonitorNow('mon-a');
  assert.ok(ssh.tries('netuser') > first, "'지금 실행' 은 막지 않는다");
  const afterManual = ssh.tries('netuser');

  mon.saveMonitor({ id: 'mon-a', name: 'MON-A', mode: 'single', intervalMin: 1, seconds: 1, maxPackets: 10, useSudo: false, hostA: { host: '127.0.0.1', port: ssh.port, username: 'netuser', password: 'changed' }, peer: '10.0.0.9' });
  await mon.captureMonitorTick(T0 + 10 * 60_000 + 3_600_000 * 24 * 365);   // lastRun 은 모듈이 찍은 실제 시각 — 그보다 한참 뒤
  assert.ok(ssh.tries('netuser') > afterManual, '자격증명이 바뀌면 자동 재개');
});

/* ════════════════════ F6 — 성능 모달 자동 갱신 ════════════════════ */

test('F6 성능 조회: 멈춘 vCenter 는 409 authStopped(로그인 0) · manual=1 은 시도 · 첫 거부도 409 로 알리고 기록한다', async () => {
  const vc = await fakeVcenter();
  upsertVcenters([{ id: 'vc-m', name: 'VC-M', host: vc.host, username: 'administrator@vsphere.local', password: 'bad', enabled: true, timeoutMs: 5000 }]);
  await seedSnapshot({ vcenters: [{ id: 'vc-m', name: 'VC-M' }], vms: [vmRow('vc-m', 1)] });
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express();
  app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  const base = `http://127.0.0.1:${srv.address().port}/api/vms/${encodeURIComponent('vc-m:vm-1')}/metrics?type=cpu`;

  let r = await fetch(base);
  let b = await r.json();
  assert.equal(r.status, 409, `첫 로그인 거부도 409 — 502 면 화면이 3회 재시도해 실패 로그인이 3배가 된다: ${JSON.stringify(b)}`);
  assert.equal(b.authStopped, true);
  assert.equal(vc.st.soapLogins, 1);

  r = await fetch(base);
  b = await r.json();
  assert.equal(r.status, 409);
  assert.equal(vc.st.soapLogins, 1, '20초 자동 갱신이 멈춘 계정으로 다시 로그인하면 안 된다');

  r = await fetch(`${base}&manual=1`);
  assert.equal(r.status, 409);
  assert.equal(vc.st.soapLogins, 2, "사람이 누른 '다시 조회' 는 막지 않는다");
});
