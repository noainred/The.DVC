/**
 * test/rvH_remoteSession.test.js — 열린 SSH/RDP WebSocket 의 세션 폐기·권한 변경 반영(2026-10-09 검토 S-04, 그룹 H).
 *
 * 재현(고치기 전): proxy/sshGateway.js·guacdTunnel.js 는 업그레이드 때 한 번만 resolveTokenUser 를 불렀다. 그 뒤 계정 삭제·
 * 강등·비밀번호 변경(tokenVersion)·단일 세션 교체(sid)·토큰 만료·범위 축소가 일어나도 열린 연결은 그대로 명령을 전달했다.
 * 이 파일은 **실제 연결 처리기**(sshGateway handleConnection · guacdTunnel handle)를 가짜 WS 로 돌리고, 실제 ssh2 서버(루프백)와
 * **실제 auth 저장소**(createUser·updateUser·deleteUser·setLocalPassword·setActiveSession·signToken·resolveTokenUser)로
 *   ① 업그레이드 판정(OTP 등록 전·데모·remote.access 없음·무효 토큰)이 SSH·RDP 공용 함수로 거부된다
 *   ② 폐기 이벤트(로그아웃 등)는 그 계정의 연결만 즉시 닫고 다른 계정은 그대로다 — 닫힌 뒤 입력은 대상 서버에 닿지 않는다
 *   ③ 삭제·강등·비밀번호 변경·sid 교체·범위 축소·매핑 삭제는 주기 재검증이 닫는다
 *   ④ 토큰 만료는 만료 시각 타이머가 닫는다(재검증을 부르지 않아도)
 *   ⑤ auth 프레임을 늦게 보내면 그 시점의 권한으로 판정한다(강등 뒤라면 SSH 접속 자체를 하지 않는다)
 *   ⑥ 세션 연장 토큰 교체는 같은 계정·같은 sid 일 때만
 *   ⑦ RDP: 폐기 시 guacd 소켓을 먼저 끊고 이후 입력을 보내지 않는다 · 연장 토큰 명령은 guacd 로 넘기지 않는다
 *   ⑧ 연결이 모두 닫히면 재검증 타이머·폐기 구독이 남지 않는다(누수 없음)
 * 를 고정한다. ⚠ 기준 시각에 Date.now() 를 쓰지 않는다 — 만료 시각은 '지금 + N초' 로만 쓰고 경계를 판정하지 않는다.
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import ssh2 from 'ssh2';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rvh-remote-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.OTP_ROLE_ENFORCE = 'false'; // operator 계정을 비밀번호 세션으로 쓰려고(OTP 등록 강제는 이 테스트의 대상이 아니다)
process.env.DATA_SOURCE = 'live';
delete process.env.SSH_HOSTKEY_POLICY;
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
fs.writeFileSync(path.join(DIR, 'security-session.json'), JSON.stringify({ singleSession: true })); // sid 교체를 실제 경로로

const closers = [];
const allWs = [];
after(async () => {
  for (const w of allWs) { try { w.close(1000, 'test end'); } catch { /* */ } }
  await new Promise((r) => setTimeout(r, 300));
  for (const c of closers) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

const auth = await import('../src/auth/auth.js');
const sessions = await import('../src/auth/sessions.js');
const rev = await import('../src/auth/sessionRevocation.js');
const gw = await import('../src/proxy/sshGateway.js');
const gd = await import('../src/proxy/guacdTunnel.js');
const reg = await import('../src/proxy/registry.js');
const { issueRdpTicket } = await import('../src/proxy/rdpTicket.js');
const { store } = await import('../src/store.js');
const pt = await import('../src/security/peerTrust.js');

const newKey = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' });
const fpOf = (pem) => `SHA256:${crypto.createHash('sha256').update(ssh2.utils.parseKey(pem).getPublicSSH()).digest('base64').replace(/=+$/, '')}`;

let SSH; // 공용 대상 서버
async function sshServer() {
  const hostKey = newKey();
  const auths = []; const inputs = []; let ended = 0;
  const srv = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      auths.push(ctx.method);
      if (ctx.method === 'password' && ctx.password === 'pw') ctx.accept(); else ctx.reject(['password']);
    });
    client.on('ready', () => client.on('session', (accept) => {
      const s = accept();
      s.on('pty', (a) => a && a());
      s.on('window-change', (a) => a && a());
      s.on('exec', (a) => { const st = a(); st.write('labhost\n'); st.exit(0); st.end(); });
      s.on('shell', (a) => { const st = a(); st.write('welcome\r\n'); st.on('data', (d) => inputs.push(String(d))); });
    }));
    client.on('end', () => { ended++; });
    client.on('error', () => {});
  });
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  closers.push(() => new Promise((r) => srv.close(() => r())));
  pt.approvePeer('ssh', '127.0.0.1', port, fpOf(hostKey), { by: 'test' }); // S-01 enforce — 이 테스트는 S-04 가 대상이다
  return { port, auths, inputs, ended: () => ended, passwords: () => auths.filter((m) => m === 'password').length };
}

class FakeWs extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.readyState = 1; this.frames = []; this.closed = null; this.bufferedAmount = 0; allWs.push(this); }
  send(d, cb) { this.frames.push(String(d)); if (cb) setImmediate(() => cb()); }
  close(code, reason) { if (this.readyState !== 1) return; this.readyState = 3; this.closed = { code, reason }; setImmediate(() => this.emit('close')); }
  terminate() { this.close(1006, ''); }
  input(o) { this.emit('message', Buffer.from(typeof o === 'string' ? o : JSON.stringify(o))); }
  json() { return this.frames.filter((f) => f.startsWith('{')).map((f) => JSON.parse(f)); }
  statuses() { return this.json().filter((o) => o.type === 'status').map((o) => o.text); }
}
const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };

/** 실제 로그인과 같은 토큰(단일 세션 sid 포함) — resolveTokenUser 가 저장소 기준으로 판정한다. */
function login(username, { exp = null, sid = null } = {}) {
  const u = auth.getUser(username);
  const s = sid || sessions.newSessionId();
  sessions.setActiveSession(username, s);
  return auth.signToken({ sub: username, role: u.role, name: username, src: 'local', tv: u.tokenVersion || 0, sid: s }, exp ? { exp } : {});
}
function mkUser(username, scope = { vcenters: ['vc-a'] }) {
  const r = auth.createUser({ username, role: 'operator', password: 'Passw0rd!x', scope }, { trusted: true });
  assert.equal(r.ok, true, r.reason);
}
function mapping(owner) {
  const r = reg.addMapping({ protocol: 'ssh', targetHost: '127.0.0.1', targetPort: SSH.port, owner, vcenterId: 'vc-a' });
  assert.equal(r.ok, true, r.reason);
  return r.mapping;
}
/** 업그레이드와 같은 순서: 토큰 → resolveTokenUser → 연결 처리기. 셸이 열릴 때까지 기다린다. */
async function openSsh(username, token, m) {
  const user = auth.resolveTokenUser(token);
  assert.ok(user, `${username} 토큰이 유효해야 한다`);
  const ws = new FakeWs();
  gw._handleConnectionForTest(ws, user, { token });
  ws.input({ type: 'auth', mappingId: m.id, username: 'root', password: 'pw' });
  assert.ok(await waitFor(() => ws.frames.some((f) => f.includes('welcome'))), `셸이 열려야 한다: ${ws.statuses().join(' | ')}`);
  return ws;
}
async function typeAndSee(ws, text) {
  const n = SSH.inputs.join('').length;
  ws.input({ type: 'data', data: text });
  return waitFor(() => SSH.inputs.join('').length > n, 3000);
}

before(async () => {
  SSH = await sshServer();
  store.snapshot = { ...store.get(), vcenters: [{ id: 'vc-a' }, { id: 'vc-b' }], vms: [{ id: 'vm1', vcenterId: 'vc-a', name: 'vm1', ipAddresses: ['127.0.0.1'] }], hosts: [] };
});

/* ─────────── ① 업그레이드 판정(SSH·RDP 공용 함수) ─────────── */
async function upgrade(attach, url) {
  const server = http.createServer((_q, r) => r.end('ok'));
  attach(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const reply = await new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(`GET ${url} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    let buf = ''; sock.on('data', (d) => { buf += d; if (buf.includes('\r\n\r\n')) { sock.destroy(); resolve(buf); } });
    sock.on('close', () => resolve(buf)); sock.on('error', () => resolve(buf));
  });
  await new Promise((r) => server.close(r));
  return reply.split('\r\n')[0];
}

test('① 업그레이드: OTP 등록 전·데모·remote.access 없음·무효 토큰은 SSH·RDP 모두 같은 판정으로 거부', async () => {
  const users = {
    enroll: { username: 'e', role: 'operator', mustEnrollOtp: true, scope: {} },
    demo: { username: 'd', role: 'admin', demoGuest: true, scope: {} },
    view: { username: 'v', role: 'viewer', scope: {} },
    adm: { username: 'a', role: 'admin', scope: {} },
  };
  const fake = { resolveTokenUser: (t) => users[t] || null };
  gw._setRemoteDepsForTest(fake); gd._setRdpDepsForTest(fake);
  try {
    for (const [attach, p] of [[gw.attachSshGateway, '/api/remote/ssh'], [gd.attachRdpGateway, '/api/remote/rdp']]) {
      assert.match(await upgrade(attach, `${p}?token=bad`), / 401 /, `${p} 무효 토큰`);
      assert.match(await upgrade(attach, `${p}?token=enroll`), / 403 /, `${p} OTP 등록 전`);
      assert.match(await upgrade(attach, `${p}?token=demo`), / 403 /, `${p} 데모`);
      assert.match(await upgrade(attach, `${p}?token=view`), / 403 /, `${p} remote.access 없음`);
      assert.match(await upgrade(attach, `${p}?token=adm`), / 101 /, `${p} 정상`);
    }
  } finally { gw._setRemoteDepsForTest(null); gd._setRdpDepsForTest(null); }
  assert.equal(gw.remoteUserIssue(null).status, 401);
  assert.equal(gw.remoteUserIssue(users.enroll).code, 'otp-enroll');
  assert.equal(gw.remoteUserIssue(users.demo).code, 'demo-guest');
  assert.equal(gw.remoteUserIssue(users.view).code, 'no-remote-access');
  assert.equal(gw.remoteUserIssue(users.adm), null);
});

test('② 폐기 이벤트는 그 계정의 연결만 즉시 닫는다 · 닫힌 뒤 입력은 대상에 닿지 않는다 · 다른 계정은 그대로', async () => {
  mkUser('ev1'); mkUser('ev2');
  const w1 = await openSsh('ev1', login('ev1'), mapping('ev1'));
  const w2 = await openSsh('ev2', login('ev2'), mapping('ev2'));
  assert.ok(await typeAndSee(w1, 'echo before\n'), '폐기 전 입력은 전달된다');
  const endedBefore = SSH.ended();
  const n = rev.notifySessionRevoked({ username: 'EV1', reason: 'logout' }); // 대소문자 무시
  assert.ok(n >= 1, '게이트웨이가 폐기 이벤트를 구독하고 있어야 한다');
  assert.equal(w1.closed?.code, 4401, '즉시 닫는다(재검증 주기를 기다리지 않는다)');
  assert.match(w1.statuses().join('\n'), /로그인 세션이 폐기되었습니다\(logout\)/);
  const len = SSH.inputs.join('').length;
  w1.input({ type: 'data', data: 'rm -rf /tmp/x\n' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(SSH.inputs.join('').length, len, '폐기된 연결의 입력이 대상 서버에 전달됐다');
  assert.ok(await waitFor(() => SSH.ended() > endedBefore), 'SSH 연결도 끊어야 한다');
  assert.equal(w2.closed, null, '다른 계정의 연결은 그대로');
  assert.ok(await typeAndSee(w2, 'echo still\n'));
  // sid 단위 이벤트 — 다른 sid 는 닫지 않는다.
  rev.notifySessionRevoked({ username: 'ev2', sid: 'not-this-one', reason: 'x' });
  assert.equal(w2.closed, null);
  w2.close(1000, 'bye');
});

test('③ 삭제·강등·비밀번호 변경·sid 교체·범위 축소·매핑 삭제는 주기 재검증이 닫는다', async () => {
  const cases = [
    ['rv-del', (u) => auth.deleteUser(u, { trusted: true }), 4401],
    ['rv-demote', (u) => auth.updateUser(u, { role: 'viewer' }, { trusted: true }), null],
    ['rv-pw', (u) => auth.setLocalPassword(u, 'N3w-Passw0rd!', { trusted: true }), 4401],
    ['rv-sid', (u) => sessions.setActiveSession(u, sessions.newSessionId()), 4401],
    ['rv-scope', (u) => auth.updateUser(u, { scope: { vcenters: ['vc-b'] } }, { trusted: true }), 4403],
  ];
  const open = [];
  for (const [u] of cases) { mkUser(u); open.push(await openSsh(u, login(u), mapping(u))); }
  mkUser('rv-map'); const mm = mapping('rv-map'); const wMap = await openSsh('rv-map', login('rv-map'), mm);
  mkUser('rv-keep'); const wKeep = await openSsh('rv-keep', login('rv-keep'), mapping('rv-keep'));
  assert.equal(gw.revalidateRemoteSessions(), 0, '변경 전에는 아무것도 닫지 않는다');
  for (const [u, change] of cases) { const r = change(u); if (r && r.ok === false) assert.fail(`${u}: ${r.reason}`); }
  reg.removeMapping(mm.id);
  // 일부는 auth 쪽 폐기 이벤트(그룹 F — bumpTokenVersion·세션 교체)가 이미 닫았을 수 있다. 어느 경로든 **전부 닫혀야** 한다.
  gw.revalidateRemoteSessions();
  cases.forEach(([u, , code], i) => {
    assert.ok(open[i].closed, `${u} 연결이 닫혀야 한다`);
    if (code) assert.equal(open[i].closed.code, code, u);
  });
  assert.match(open[4].statuses().join('\n'), /범위/, '범위 축소는 범위 사유를 말한다');
  assert.equal(wMap.closed?.code, 4403);
  assert.match(wMap.statuses().join('\n'), /매핑이 삭제/);
  assert.equal(wKeep.closed, null, '변경 없는 계정은 그대로');
  const len = SSH.inputs.join('').length;
  for (const w of open) w.input({ type: 'data', data: 'whoami\n' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(SSH.inputs.join('').length, len, '닫힌 연결의 입력이 전달됐다');
  wKeep.close(1000, 'bye');
});

test('③-b 이벤트가 오지 않는 변경(다른 프로세스 — 콘솔 계정 도구 등)도 주기 재검증 하나로 닫힌다', async () => {
  // 폐기 이벤트는 같은 프로세스 안의 변경만 알린다. 콘솔 도구(user-admin.js)는 users.json 을 직접 쓴다 — 그 변경은
  // 재검증(resolveTokenUser 재호출)만 잡는다. 가짜 resolver 로 '이벤트 없이 바뀐 상태' 를 만든다.
  const state = { ok: true, role: 'operator', scope: { vcenters: ['vc-a'] } };
  const fakeUser = () => (state.ok ? { username: 'cli1', role: state.role, scope: state.scope } : null);
  gw._setRemoteDepsForTest({ resolveTokenUser: (t) => (t === 'cli-tok' ? fakeUser() : null), sessionInfoOf: () => ({ username: 'cli1', source: 'local', sid: 's1', exp: Math.floor(Date.now() / 1000) + 3600 }) });
  try {
    const mk = () => { const ws = new FakeWs(); gw._handleConnectionForTest(ws, fakeUser(), { token: 'cli-tok' }); return ws; };
    for (const [label, change, code] of [
      ['삭제·tokenVersion', () => { state.ok = false; }, 4401],
      ['강등', () => { state.role = 'viewer'; }, 4403],
    ]) {
      Object.assign(state, { ok: true, role: 'operator' });
      const ws = mk();
      gw.revalidateRemoteSessions();
      assert.equal(ws.closed, null, `${label}: 변경 전에는 닫지 않는다`);
      change();
      assert.ok(gw.revalidateRemoteSessions() >= 1, label);
      assert.equal(ws.closed?.code, code, label);
    }
  } finally { gw._setRemoteDepsForTest(null); }
});

test('④ 토큰 만료는 만료 시각 타이머가 닫는다(재검증을 부르지 않아도)', async () => {
  mkUser('exp1');
  const tok = login('exp1', { exp: Math.floor(Date.now() / 1000) + 2 });
  const w = await openSsh('exp1', tok, mapping('exp1'));
  assert.equal(w.closed, null);
  assert.ok(await waitFor(() => w.closed, 5000), '만료 뒤 닫혀야 한다');
  assert.equal(w.closed.code, 4401);
});

test('⑤ auth 프레임을 늦게 보내면 그 시점 권한으로 — 강등 뒤면 SSH 접속 자체를 하지 않는다', async () => {
  mkUser('late1');
  const tok = login('late1');
  const m = mapping('late1');
  const user = auth.resolveTokenUser(tok);
  const ws = new FakeWs();
  gw._handleConnectionForTest(ws, user, { token: tok });
  auth.updateUser('late1', { role: 'viewer' }, { trusted: true });
  const pw = SSH.passwords();
  ws.input({ type: 'auth', mappingId: m.id, username: 'root', password: 'pw' });
  assert.ok(await waitFor(() => ws.closed));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(SSH.passwords(), pw, '강등된 사용자의 auth 프레임으로 대상에 로그인했다');
  assert.equal(gw.activeSshSessionCount(), 0);
});

test('⑤-b 업그레이드 뒤 세션이 무효가 되면(이벤트 없이) auth 프레임은 옛 사용자로 진행하지 않는다', async () => {
  let valid = true;
  const U = { username: 'lat2', role: 'admin', scope: { vcenters: [], regions: [] } };
  gw._setRemoteDepsForTest({
    resolveTokenUser: (t) => (t === 'lat2-tok' && valid ? U : null),
    sessionInfoOf: () => ({ username: 'lat2', source: 'local', sid: 'sx', exp: Math.floor(Date.now() / 1000) + 3600 }),
  });
  try {
    const m = reg.addMapping({ protocol: 'ssh', targetHost: '127.0.0.1', targetPort: SSH.port, owner: 'lat2', vcenterId: 'vc-a' }).mapping;
    const ws = new FakeWs();
    gw._handleConnectionForTest(ws, U, { token: 'lat2-tok' });
    valid = false; // 다른 프로세스(콘솔 도구)가 계정을 지웠다 — 이 프로세스에는 폐기 이벤트가 오지 않는다
    const pw = SSH.passwords();
    ws.input({ type: 'auth', mappingId: m.id, username: 'root', password: 'pw' });
    assert.ok(await waitFor(() => ws.closed));
    assert.equal(ws.closed.code, 4401);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(SSH.passwords(), pw, '무효가 된 세션의 auth 프레임으로 대상에 로그인했다');
  } finally { gw._setRemoteDepsForTest(null); }
});

test('⑥-b 연장 토큰이 같은 계정이어도 다른 로그인 세션(sid)이면 바꾸지 않는다 — 그 세션의 로그아웃이 이 콘솔을 닫아야 한다', async () => {
  const U = { username: 'sid1', role: 'admin', scope: { vcenters: [], regions: [] } };
  const SID = { 'sid-a': 'A', 'sid-b': 'B' };
  gw._setRemoteDepsForTest({
    resolveTokenUser: (t) => (SID[t] ? U : null),
    sessionInfoOf: (t) => (SID[t] ? { username: 'sid1', source: 'local', sid: SID[t], exp: Math.floor(Date.now() / 1000) + 3600 } : null),
  });
  try {
    const ws = new FakeWs();
    gw._handleConnectionForTest(ws, U, { token: 'sid-a' });
    ws.input({ type: 'token', token: 'sid-b' });
    ws.input({ type: 'token', token: 'sid-a' });
    await waitFor(() => ws.json().filter((o) => o.type === 'token-ack').length >= 2);
    assert.deepEqual(ws.json().filter((o) => o.type === 'token-ack').map((a) => [a.ok, a.code]), [[false, 'sid-mismatch'], [true, undefined]]);
    rev.notifySessionRevoked({ scope: 'session', username: 'sid1', sid: 'A', source: 'local', reason: 'logout' });
    assert.equal(ws.closed?.code, 4401, '원래 세션(A)의 로그아웃이 콘솔을 닫아야 한다');
  } finally { gw._setRemoteDepsForTest(null); }
});

test('⑥ 세션 연장 토큰 교체는 같은 계정·같은 sid 일 때만', async () => {
  mkUser('ref1'); mkUser('ref2');
  const sid = sessions.newSessionId();
  const t1 = login('ref1', { sid, exp: Math.floor(Date.now() / 1000) + 2 });
  const w = await openSsh('ref1', t1, mapping('ref1'));
  const acks = () => w.json().filter((o) => o.type === 'token-ack');
  w.input({ type: 'token', token: login('ref2') });
  w.input({ type: 'token', token: 'garbage' });
  await waitFor(() => acks().length >= 2);
  assert.deepEqual(acks().map((a) => [a.ok, a.code]), [[false, 'user-mismatch'], [false, 'session-invalid']]);
  // 같은 sid 로 만료만 늘린 토큰(= /auth/extend 가 만드는 것)
  const u = auth.getUser('ref1');
  const t2 = auth.signToken({ sub: 'ref1', role: u.role, name: 'ref1', src: 'local', tv: u.tokenVersion || 0, sid }, { exp: Math.floor(Date.now() / 1000) + 3600 });
  w.input({ type: 'token', token: t2 });
  await waitFor(() => acks().length >= 3);
  assert.equal(acks()[2].ok, true);
  await new Promise((r) => setTimeout(r, 2600));
  assert.equal(w.closed, null, '연장된 토큰이면 옛 만료 시각에 닫지 않는다');
  w.close(1000, 'bye');
});

test('⑦ RDP: 폐기 시 guacd 소켓을 먼저 끊고 이후 입력을 보내지 않는다 · 연장 토큰 명령은 guacd 로 넘기지 않는다', async () => {
  mkUser('rdp1');
  reg.saveConfig({ guacd: { host: '127.0.0.1', port: 4822 } });
  const tok = login('rdp1');
  const r = reg.addMapping({ protocol: 'rdp', targetHost: '127.0.0.1', targetPort: 3389, owner: 'rdp1', vcenterId: 'vc-a' });
  assert.equal(r.ok, true, r.reason);
  const ticket = issueRdpTicket({ username: 'u', password: 'p' }, { owner: 'rdp1' });
  const sock = Object.assign(new EventEmitter(), {
    writes: [], destroyed: false,
    write(s) { if (this.destroyed) throw new Error('destroyed'); this.writes.push(String(s)); return true; },
    destroy() { this.destroyed = true; setImmediate(() => this.emit('close')); },
    end() { this.destroy(); }, setTimeout() {},
  });
  gd._setRdpDepsForTest({ connect: () => sock });
  try {
    const ws = new FakeWs();
    const params = new URLSearchParams({ mappingId: r.mapping.id, ticket });
    gd._rdpHandleForTest(ws, params, auth.resolveTokenUser(tok), tok);
    sock.emit('connect');
    sock.emit('data', Buffer.from('4.args,13.VERSION_1_5_0,8.hostname,4.port;'));
    sock.emit('data', Buffer.from('5.ready,5.$abcd;'));
    ws.input('5.mouse,1.1,1.1,1.0;');
    assert.ok(sock.writes.some((s) => s.startsWith('5.mouse')), '연결 중 입력은 guacd 로 간다');
    const u = auth.getUser('rdp1');
    const t2 = auth.signToken({ sub: 'rdp1', role: u.role, name: 'rdp1', src: 'local', tv: u.tokenVersion || 0, sid: auth.verifyToken(tok).sid }, { exp: Math.floor(Date.now() / 1000) + 3600 });
    ws.input(`${gd.RDP_TOKEN_OPCODE.length}.${gd.RDP_TOKEN_OPCODE},${t2.length}.${t2};`);
    assert.ok(!sock.writes.some((s) => s.includes(gd.RDP_TOKEN_OPCODE)), '연장 토큰 명령을 guacd(대상)로 넘기면 안 된다');
    rev.notifySessionRevoked({ username: 'rdp1', reason: 'account-disabled' });
    assert.equal(sock.destroyed, true, 'guacd 소켓을 즉시 끊어야 한다');
    assert.equal(ws.closed?.code, 4401);
    const nW = sock.writes.length;
    ws.input('3.key,5.65307,1.1;');
    assert.equal(sock.writes.length, nW, '폐기 뒤 입력이 전달됐다');
  } finally { gd._setRdpDepsForTest(null); }
});

test('⑦-b RDP: 재검증도 같은 판정 — 범위 축소면 닫는다 · WS 닫기 사유가 길어도 던지지 않는다', async () => {
  mkUser('rdp2');
  const tok = login('rdp2');
  const r = reg.addMapping({ protocol: 'rdp', targetHost: '127.0.0.1', targetPort: 3390, owner: 'rdp2', vcenterId: 'vc-a' });
  const sock = Object.assign(new EventEmitter(), { writes: [], destroyed: false, write(s) { this.writes.push(String(s)); return true; }, destroy() { this.destroyed = true; }, end() { this.destroyed = true; }, setTimeout() {} });
  gd._setRdpDepsForTest({ connect: () => sock });
  try {
    // 티켓 없이 열면 예전에는 한글 사유(123바이트 초과)로 ws.close 가 RangeError 를 던졌다 — 실제 ws 와 같은 상한을 흉내 낸다.
    const strict = new FakeWs();
    strict.close = function close(code, reason) { if (Buffer.byteLength(String(reason || '')) > 123) throw new RangeError('The message must not be greater than 123 bytes'); FakeWs.prototype.close.call(this, code, reason); };
    gd._rdpHandleForTest(strict, new URLSearchParams({ mappingId: r.mapping.id }), auth.resolveTokenUser(tok), tok);
    assert.equal(strict.closed?.code, 1011, '티켓 없는 연결이 닫히지 않았다');
    const ws = new FakeWs();
    const ticket = issueRdpTicket({ username: 'u', password: 'p' }, { owner: 'rdp2' });
    gd._rdpHandleForTest(ws, new URLSearchParams({ mappingId: r.mapping.id, ticket }), auth.resolveTokenUser(tok), tok);
    auth.updateUser('rdp2', { scope: { vcenters: ['vc-b'] } }, { trusted: true });
    gw.revalidateRemoteSessions();
    assert.equal(ws.closed?.code, 4403);
    assert.equal(sock.destroyed, true);
  } finally { gd._setRdpDepsForTest(null); }
});

test('⑦-c 콘솔 입력은 서버측 유휴 활동이다(그룹 F touchSessionActivity) — 연결마다 1분 1회 · 입력이 아닌 명령은 세지 않는다', async () => {
  let T = Date.now();
  const calls = [];
  const spy = (token, opts) => { const r = auth.touchSessionActivity(token, opts); calls.push({ token, opts, r }); return r; };
  gw._setRemoteDepsForTest({ touchSessionActivity: spy, now: () => T });
  try {
    // SSH — 실제 셸을 열고 키 입력(data 프레임)
    mkUser('tch1');
    const tok = login('tch1');
    const ws = await openSsh('tch1', tok, mapping('tch1'));
    const n0 = calls.length;
    ws.input({ type: 'resize', rows: 30, cols: 100 });
    assert.equal(calls.length, n0, '창 크기 변경은 사용자 입력이 아니다');
    assert.ok(await typeAndSee(ws, 'a'));
    assert.equal(calls.length, n0 + 1, '첫 키 입력이 활동으로 기록돼야 한다');
    assert.equal(calls.at(-1).token, tok);
    assert.equal(calls.at(-1).opts.minIntervalMs, 60_000);
    assert.equal(calls.at(-1).r, true, '유효한 세션이면 F 가 활동을 기록한다(되살리기 아님)');
    T += 30_000; assert.ok(await typeAndSee(ws, 'b'));
    assert.equal(calls.length, n0 + 1, '1분 안의 입력은 다시 부르지 않는다(키마다 HMAC 검증 금지)');
    T += 31_000; assert.ok(await typeAndSee(ws, 'c'));
    assert.equal(calls.length, n0 + 2, '1분이 지나면 다시 기록한다');
    ws.close(1000, 'bye');

    // RDP — key·mouse·touch 명령만 활동이다
    mkUser('tch2');
    const tok2 = login('tch2');
    reg.saveConfig({ guacd: { host: '127.0.0.1', port: 4822 } });
    const r = reg.addMapping({ protocol: 'rdp', targetHost: '127.0.0.1', targetPort: 3391, owner: 'tch2', vcenterId: 'vc-a' });
    const sock = Object.assign(new EventEmitter(), { writes: [], destroyed: false, write(x) { this.writes.push(String(x)); return true; }, destroy() { this.destroyed = true; }, end() { this.destroyed = true; }, setTimeout() {} });
    gd._setRdpDepsForTest({ connect: () => sock });
    try {
      const rws = new FakeWs();
      const ticket = issueRdpTicket({ username: 'u', password: 'p' }, { owner: 'tch2' });
      gd._rdpHandleForTest(rws, new URLSearchParams({ mappingId: r.mapping.id, ticket }), auth.resolveTokenUser(tok2), tok2);
      sock.emit('connect');
      sock.emit('data', Buffer.from('4.args,13.VERSION_1_5_0,8.hostname,4.port;'));
      const m0 = calls.length;
      rws.input('4.sync,8.12345678;');
      rws.input('4.size,4.1024,3.768,2.96;');
      assert.equal(calls.length, m0, 'sync·size 는 사용자 입력이 아니다');
      rws.input('4.sync,1.1;5.mouse,1.1,1.1,1.0;');
      assert.equal(calls.length, m0 + 1, '한 메시지 안의 두 번째 명령이 mouse 여도 활동이다');
      rws.input('3.key,5.65307,1.1;');
      assert.equal(calls.length, m0 + 1, '1분 안에는 다시 부르지 않는다');
      T += 61_000; rws.input('5.touch,1.0,1.5,1.5,1.1,1.1,1.0,1.1;');
      assert.equal(calls.length, m0 + 2);
      assert.equal(calls.at(-1).token, tok2);
      rws.close(1000, 'bye');
    } finally { gd._setRdpDepsForTest(null); }
  } finally { gw._setRemoteDepsForTest(null); }
});

test('⑧ 연결이 모두 닫히면 재검증 타이머·폐기 구독이 남지 않는다', async () => {
  assert.ok(await waitFor(() => gw.remoteSessionStatus().live === 0, 5000), JSON.stringify(gw.remoteSessionStatus()));
  const st = gw.remoteSessionStatus();
  assert.deepEqual(st.watching, { revalidateTimer: false, revocationSubscribed: false });
  assert.equal(rev._subscriberCount(), 0);
  assert.equal(gw.activeSshSessionCount(), 0);
  assert.equal(gw.sshOutputStats().perUserOpen, 0);
  assert.ok(st.closedBy.revoked >= 2 && st.closedBy['session-invalid'] >= 1, JSON.stringify(st.closedBy));
});
