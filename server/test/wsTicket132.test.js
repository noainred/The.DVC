/**
 * test/wsTicket132.test.js — 전체 점검 132회차: 원격 콘솔 WebSocket 이 세션 토큰을 주소 쿼리에 싣던 것(129회차 결정 D2).
 *
 * 고치기 전: 화면이 `/api/remote/ssh?token=<JWT>` · RDP 연결 쿼리 `token=<JWT>` 를 보냈다 — 쿼리스트링은 상위 리버스 프록시 액세스 로그 ·
 *   브라우저 기록에 남는다(RDP 자격증명을 티켓으로 바꾼 이유와 같다). 세션 토큰은 만료 전까지 포탈 API 전체를 연다.
 * 고친 뒤: 인증된 POST 가 1회용 단명 티켓(proxy/wsTicket.js)에 그 요청의 토큰을 묶고, 주소에는 티켓 ID(`wst=`)만 싣는다.
 *   게이트웨이는 upgrade 에서 티켓을 소비해 꺼낸 토큰으로 **예전과 같은 판정**(resolveTokenUser → remoteUserIssue → 매핑 재검사 → trackRemoteSession)을 태운다.
 *
 * 이 파일은 실제 라우터(authMiddleware · requireEnrolled · 감사 미들웨어)와 실제 게이트웨이를 한 http 서버에 올리고 **실제 upgrade** 로 본다:
 *   A 티켓 모듈(형식 · 1회용 · 만료 · 상한) · B 발급 라우트(게이트) · C upgrade(없음 · 만료 · 재사용 · 폐기된 토큰 · 권한 없음 · OTP 미등록 · 발급자 불일치 · 옛 ?token=) ·
 *   D 열린 연결이 티켓의 토큰으로 추적된다(폐기 · 만료 타이머 · 토큰 교체 · RDP 자격증명 티켓의 발급자 대조) · E 로그 · 설정 폴더에 토큰/티켓이 남지 않는다 ·
 *   F 소스 스윕(web/src 전체에서 세션 토큰을 주소에 싣는 코드 0건) · G 인증이 꺼진 포탈.
 * ⚠ 기준 시각: 티켓 만료는 주입 시계(정시 −30분 기준)로만 판정한다. 토큰 만료는 '지금 + N초' 로만 쓴다(경계를 판정하지 않는다).
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { stripComments } from './_stripComments.js';

// 이 파일이 만든 임시 폴더는 시험이 끝나면 지운다(tmpCleanup3188 규약).
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const WEB = path.resolve(HERE, '../../web/src');

const DIR = tmpDir('wsticket132-');
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.OTP_ROLE_ENFORCE = 'false'; // operator 계정을 비밀번호 세션으로 쓰려고(OTP 등록 강제는 가짜 판정으로 따로 본다)
process.env.DATA_SOURCE = 'live';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
fs.writeFileSync(path.join(DIR, 'security-session.json'), JSON.stringify({ singleSession: true })); // sid 교체를 실제 경로로

// 콘솔 출력 전부를 모아 끝에서 토큰 · 티켓이 섞이지 않았는지 본다(E).
const LOGGED = [];
for (const k of ['log', 'warn', 'error', 'info', 'debug']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => { LOGGED.push(a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' ')); orig(...a); };
}
const SECRETS = new Set(); // 이 파일이 만든 세션 토큰 · 티켓 ID

const express = (await import('express')).default;
const auth = await import('../src/auth/auth.js');
const sessions = await import('../src/auth/sessions.js');
const rev = await import('../src/auth/sessionRevocation.js');
const gw = await import('../src/proxy/sshGateway.js');
const gd = await import('../src/proxy/guacdTunnel.js');
const reg = await import('../src/proxy/registry.js');
const wt = await import('../src/proxy/wsTicket.js');
const rt = await import('../src/proxy/rdpTicket.js');
const { store } = await import('../src/store.js');
const { auditMiddleware } = await import('../src/audit.js');
const { remoteRouter } = await import('../src/routes/remote.js');
const webTicket = await import('../../web/src/remote/wsTicket.js');

const HOUR = 3_600_000;
const T0 = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000; // 정시 −30분(경계에서 떨어뜨린 고정 기준 — 주입 시계 전용)
const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };

let server; let port;
const openSockets = [];
before(async () => {
  store.snapshot = { ...store.get(), vcenters: [{ id: 'vc-a' }], vms: [{ id: 'vm1', vcenterId: 'vc-a', name: 'vm1', ipAddresses: ['127.0.0.1'] }], hosts: [] };
  const app = express();
  app.use(express.json());
  app.use('/api/remote', auth.authMiddleware, auth.requireEnrolled, auditMiddleware, remoteRouter); // index.js 와 같은 순서
  server = http.createServer(app);
  gw.attachSshGateway(server);
  gd.attachRdpGateway(server);
  server.on('upgrade', (req, socket) => { // index.js 의 catch-all 과 같다
    let p = ''; try { p = new URL(req.url, 'http://localhost').pathname; } catch { /* */ }
    if (p !== '/api/remote/ssh' && p !== '/api/remote/rdp') { try { socket.destroy(); } catch { /* */ } }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(async () => {
  for (const w of openSockets) { try { w.terminate(); } catch { /* */ } }
  await new Promise((r) => setTimeout(r, 200));
  gw._setRemoteDepsForTest(null); gd._setRdpDepsForTest(null); wt._setWsTicketNowForTest(null);
  await new Promise((r) => server.close(() => r()));
  server.closeAllConnections?.();
});

/** 실제 로그인과 같은 토큰(단일 세션 sid 포함). */
function login(username, { exp = null } = {}) {
  const u = auth.getUser(username);
  const s = sessions.newSessionId();
  sessions.setActiveSession(username, s);
  const t = auth.signToken({ sub: username, role: u.role, name: username, src: 'local', tv: u.tokenVersion || 0, sid: s }, exp ? { exp } : {});
  SECRETS.add(t);
  return t;
}
function mkUser(username, role = 'operator') {
  const r = auth.createUser({ username, role, password: 'Passw0rd!x', scope: { vcenters: ['vc-a'] } }, { trusted: true });
  assert.equal(r.ok, true, r.reason);
}
async function post(pathname, token, body = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  if (json?.wst) SECRETS.add(json.wst);
  if (json?.ticket) SECRETS.add(json.ticket);
  return { status: res.status, body: json, text };
}
/** 화면과 같은 흐름 — 머리말로 인증한 POST 로 WS 티켓을 받는다. */
async function ticketFor(token) {
  const r = await post('/api/remote/ws-ticket', token);
  assert.equal(r.status, 200, r.text);
  return r.body.wst;
}
/** 직접 발급(가짜 판정 · 경계 사례용). */
function rawTicket(token, owner) { const id = wt.issueWsTicket({ token, owner }); SECRETS.add(id); return id; }

/** 실제 upgrade 요청 — 응답 첫 줄('HTTP/1.1 101 …')을 돌려준다. */
function upgrade(url) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(`GET ${url} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    let buf = '';
    const done = () => resolve(buf.split('\r\n')[0]);
    sock.on('data', (d) => { buf += d; if (buf.includes('\r\n\r\n')) { sock.destroy(); done(); } });
    sock.on('close', done); sock.on('error', done);
  });
}
const PATHS = ['/api/remote/ssh', '/api/remote/rdp'];
const P = webTicket.WS_TICKET_PARAM;

/** 실제 WS 클라이언트. */
function openWs(url) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${url}`);
  openSockets.push(ws);
  const st = { ws, status: null, close: null, reason: '', frames: [] };
  st.opened = new Promise((resolve) => {
    ws.on('unexpected-response', (_q, r) => { st.status = r.statusCode; resolve(false); });
    ws.on('open', () => { st.status = 101; resolve(true); });
    ws.on('error', () => resolve(false));
  });
  ws.on('message', (d) => st.frames.push(String(d)));
  ws.on('close', (code, reason) => { st.close = code; st.reason = String(reason); });
  return st;
}

/* ═══════════ A. 티켓 모듈 ═══════════ */

test('A1 티켓 ID 는 192비트 hex 이고 1회만 소비된다 · 형식이 아닌 값은 조회하지 않는다', () => {
  wt._resetWsTickets();
  const ids = new Set();
  for (let i = 0; i < 5; i++) ids.add(wt.issueWsTicket({ token: `t${i}`, owner: `u${i}` }));
  assert.equal(ids.size, 5, '티켓 ID 가 겹쳤다');
  for (const id of ids) assert.match(id, /^[0-9a-f]{48}$/, 'randomBytes(24) hex 여야 한다');
  const id = [...ids][0];
  assert.deepEqual(wt.consumeWsTicket(id), { token: 't0', owner: 'u0' });
  assert.equal(wt.consumeWsTicket(id), null, '같은 티켓을 두 번 쓸 수 있다');
  for (const bad of [null, undefined, '', 'x', 123, {}, [], id.toUpperCase(), `${[...ids][1]}0`, [...ids][1].slice(0, 47)]) {
    assert.equal(wt.consumeWsTicket(bad), null, `형식이 아닌 값: ${String(bad).slice(0, 20)}`);
  }
  assert.deepEqual(wt.consumeWsTicket([...ids][1]), { token: 't1', owner: 'u1' }, '틀린 시도가 남의 티켓을 지우면 안 된다');
  wt._resetWsTickets();
});

test('A2 만료 — TTL 안에서는 쓰이고, 지나면 거부하고 지운다(주입 시계)', () => {
  wt._resetWsTickets();
  let now = T0;
  wt._setWsTicketNowForTest(() => now);
  try {
    assert.ok(wt.WS_TICKET_TTL_MS > 0 && wt.WS_TICKET_TTL_MS <= 60_000, 'TTL 은 짧아야 한다(1분 이하)');
    const a = wt.issueWsTicket({ token: 'ta', owner: 'a' });
    const b = wt.issueWsTicket({ token: 'tb', owner: 'b' });
    now = T0 + wt.WS_TICKET_TTL_MS - 1;
    assert.deepEqual(wt.consumeWsTicket(a), { token: 'ta', owner: 'a' }, 'TTL 직전에는 유효');
    now = T0 + wt.WS_TICKET_TTL_MS;
    assert.equal(wt.consumeWsTicket(b), null, '만료된 티켓이 쓰였다');
    assert.equal(wt.wsTicketStatus().live, 0, '만료된 티켓이 남았다');
    // 쓰이지 않고 만료된 티켓은 다음 발급 때 청소된다
    wt.issueWsTicket({ token: 'tc', owner: 'c' });
    now += wt.WS_TICKET_TTL_MS + 1;
    wt.issueWsTicket({ token: 'td', owner: 'd' });
    assert.equal(wt.wsTicketStatus().live, 1);
  } finally { wt._setWsTicketNowForTest(null); wt._resetWsTickets(); }
});

test('A3 상한 — 계정당 · 전체. 넘치면 그 계정의 가장 오래된 것부터(남의 티켓은 그대로) · 상태에는 개수만', () => {
  wt._resetWsTickets();
  const other = wt.issueWsTicket({ token: 'other-token', owner: 'other' });
  const mine = [];
  for (let i = 0; i < wt.WS_TICKET_MAX_PER_OWNER + 3; i++) mine.push(wt.issueWsTicket({ token: `m${i}`, owner: 'flood' }));
  assert.equal(wt.wsTicketStatus().live, wt.WS_TICKET_MAX_PER_OWNER + 1, '계정당 상한이 지켜지지 않았다');
  assert.equal(wt.consumeWsTicket(mine[0]), null, '가장 오래된 것이 밀려나야 한다');
  assert.deepEqual(wt.consumeWsTicket(mine[mine.length - 1]), { token: `m${mine.length - 1}`, owner: 'flood' });
  assert.deepEqual(wt.consumeWsTicket(other), { token: 'other-token', owner: 'other' }, '남의 티켓을 밀어냈다');
  wt._resetWsTickets();
  for (let i = 0; i < wt.WS_TICKET_MAX + 50; i++) wt.issueWsTicket({ token: 'x', owner: `u${i}` });
  assert.equal(wt.wsTicketStatus().live, wt.WS_TICKET_MAX, '전체 상한이 지켜지지 않았다');
  const st = JSON.stringify(wt.wsTicketStatus());
  assert.ok(!/token|owner|"x"/.test(st), `상태에 토큰 · 계정이 실렸다: ${st}`);
  // 문자열이 아닌 토큰은 보관하지 않는다(null) — 인증이 꺼진 포탈의 티켓
  wt._resetWsTickets();
  assert.deepEqual(wt.consumeWsTicket(wt.issueWsTicket({ token: { a: 1 }, owner: 'anonymous' })), { token: null, owner: 'anonymous' });
  wt._resetWsTickets();
});

/* ═══════════ B. 발급 라우트 ═══════════ */

test('B1 발급은 인증 · remote.access 를 거친다 — 토큰 없음 401 · viewer 403 · operator 200. 응답에 토큰을 싣지 않는다', async () => {
  mkUser('b-op'); mkUser('b-view', 'viewer');
  const op = login('b-op'); const vw = login('b-view');
  for (const p of ['/api/remote/ws-ticket', '/api/remote/rdp-ticket']) {
    assert.equal((await post(p, null, { username: 'u' })).status, 401, `${p} 토큰 없이`);
    assert.equal((await post(p, 'not-a-token', { username: 'u' })).status, 401, `${p} 무효 토큰`);
    assert.equal((await post(p, vw, { username: 'u' })).status, 403, `${p} remote.access 없는 계정`);
  }
  const r = await post('/api/remote/ws-ticket', op);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['ok', 'wst']);
  assert.match(r.body.wst, /^[0-9a-f]{48}$/);
  assert.ok(!r.text.includes(op), '응답에 세션 토큰이 실렸다');
  // RDP 는 같은 응답에 자격증명 티켓과 WS 티켓을 함께 준다(요청 한 번)
  const d = await post('/api/remote/rdp-ticket', op, { username: 'Administrator', password: 'pw' });
  assert.equal(d.status, 200);
  assert.match(d.body.wst, /^[0-9a-f]{48}$/);
  assert.match(d.body.ticket, /^[0-9a-f]{48}$/);
  assert.notEqual(d.body.wst, d.body.ticket);
  assert.ok(!d.text.includes(op) && !d.text.includes('"pw"'));
  // 발급된 티켓에는 **그 요청의 토큰**이 묶여 있다
  assert.deepEqual(wt.consumeWsTicket(r.body.wst), { token: op, owner: 'b-op' });
  assert.deepEqual(wt.consumeWsTicket(d.body.wst), { token: op, owner: 'b-op' });
});

/* ═══════════ C. 실제 upgrade ═══════════ */

test('C1 티켓으로 열린다 · 재사용 · 없는 티켓 · 깨진 값 · 아무것도 없음은 401(SSH · RDP)', async () => {
  mkUser('c1'); const tok = login('c1');
  for (const p of PATHS) {
    const wst = await ticketFor(tok);
    assert.match(await upgrade(`${p}?${P}=${wst}`), / 101 /, `${p} 티켓`);
    assert.match(await upgrade(`${p}?${P}=${wst}`), / 401 /, `${p} 같은 티켓 재사용`);
    assert.match(await upgrade(`${p}?${P}=${'0'.repeat(48)}`), / 401 /, `${p} 없는 티켓`);
    assert.match(await upgrade(`${p}?${P}=`), / 401 /, `${p} 빈 티켓`);
    assert.match(await upgrade(`${p}?${P}=${encodeURIComponent('../x')}`), / 401 /, `${p} 깨진 값`);
    assert.match(await upgrade(p), / 401 /, `${p} 아무것도 없음`);
  }
  // SSH 로 쓴 티켓을 RDP 에서 다시 쓸 수도 없다(1회용은 경로와 무관)
  const one = await ticketFor(tok);
  assert.match(await upgrade(`/api/remote/ssh?${P}=${one}`), / 101 /);
  assert.match(await upgrade(`/api/remote/rdp?${P}=${one}`), / 401 /);
});

test('C2 만료된 티켓은 401(주입 시계)', async () => {
  mkUser('c2'); const tok = login('c2');
  let now = T0;
  wt._setWsTicketNowForTest(() => now);
  try {
    for (const p of PATHS) {
      now = T0;
      const wst = await ticketFor(tok);
      now = T0 + wt.WS_TICKET_TTL_MS + 1;
      assert.match(await upgrade(`${p}?${P}=${wst}`), / 401 /, `${p} 만료 티켓`);
      now = T0;
      assert.match(await upgrade(`${p}?${P}=${wst}`), / 401 /, `${p} 만료로 거부된 티켓은 시계가 돌아가도 다시 쓸 수 없다`);
    }
  } finally { wt._setWsTicketNowForTest(null); }
});

test('C3 wst 가 있으면 그것만 본다 — 무효 티켓 + 유효한 token= 은 401(옛 길로 넘어가지 않는다)', async () => {
  mkUser('c3'); const tok = login('c3');
  for (const p of PATHS) {
    assert.match(await upgrade(`${p}?${P}=${'f'.repeat(48)}&token=${encodeURIComponent(tok)}`), / 401 /, p);
    assert.match(await upgrade(`${p}?token=${encodeURIComponent(tok)}&${P}=`), / 401 /, p);
  }
});

test('C4 티켓은 권한을 보관하지 않는다 — 발급 뒤 삭제 · 비밀번호 변경 · sid 교체 · 강등이면 거부', async () => {
  const cases = [
    ['c4-del', (u) => auth.deleteUser(u, { trusted: true })],
    ['c4-pw', (u) => auth.setLocalPassword(u, 'N3w-Passw0rd!', { trusted: true })],
    ['c4-sid', (u) => sessions.setActiveSession(u, sessions.newSessionId())],
    ['c4-demote', (u) => auth.updateUser(u, { role: 'viewer' }, { trusted: true })],
  ];
  for (const p of PATHS) {
    for (const [name, change] of cases) {
      const u = `${name}-${p.endsWith('ssh') ? 's' : 'r'}`;
      mkUser(u);
      const wst = await ticketFor(login(u));
      const r = change(u); if (r && r.ok === false) assert.fail(`${u}: ${r.reason}`);
      assert.match(await upgrade(`${p}?${P}=${wst}`), / 40[13] /, `${p} ${name} — 발급 뒤 바뀐 권한이 반영되지 않았다`);
    }
  }
});

test('C5 권한 없는 계정 · OTP 등록 전 · 데모의 티켓은 403(티켓이 판정을 건너뛰지 않는다)', async () => {
  // 실제 viewer 토큰을 직접 묶은 티켓(라우트는 403 이라 발급되지 않는다 — 게이트웨이도 스스로 막아야 한다)
  mkUser('c5-view', 'viewer'); const vw = login('c5-view');
  for (const p of PATHS) assert.match(await upgrade(`${p}?${P}=${rawTicket(vw, 'c5-view')}`), / 403 /, `${p} viewer`);
  const users = {
    enroll: { username: 'e', role: 'operator', mustEnrollOtp: true, scope: {} },
    demo: { username: 'd', role: 'admin', demoGuest: true, scope: {} },
    adm: { username: 'a', role: 'admin', scope: {} },
  };
  const fake = { resolveTokenUser: (t) => users[t] || null };
  gw._setRemoteDepsForTest(fake); gd._setRdpDepsForTest(fake);
  try {
    for (const p of PATHS) {
      assert.match(await upgrade(`${p}?${P}=${rawTicket('enroll', 'e')}`), / 403 /, `${p} OTP 등록 전`);
      assert.match(await upgrade(`${p}?${P}=${rawTicket('demo', 'd')}`), / 403 /, `${p} 데모`);
      assert.match(await upgrade(`${p}?${P}=${rawTicket('gone', 'x')}`), / 401 /, `${p} 무효 토큰의 티켓`);
      assert.match(await upgrade(`${p}?${P}=${rawTicket(null, 'a')}`), / 401 /, `${p} 토큰 없는 티켓(인증이 켜진 포탈)`);
      assert.match(await upgrade(`${p}?${P}=${rawTicket('adm', 'a')}`), / 101 /, `${p} 정상`);
    }
  } finally { gw._setRemoteDepsForTest(null); gd._setRdpDepsForTest(null); }
});

test('C6 티켓의 발급 계정과 토큰의 계정이 다르면 401', async () => {
  mkUser('c6-a'); mkUser('c6-b');
  const ta = login('c6-a');
  for (const p of PATHS) {
    assert.match(await upgrade(`${p}?${P}=${rawTicket(ta, 'c6-b')}`), / 401 /, `${p} 발급자 불일치`);
    assert.match(await upgrade(`${p}?${P}=${rawTicket(ta, '')}`), / 401 /, `${p} 발급자 없음`);
    assert.match(await upgrade(`${p}?${P}=${rawTicket(ta, 'C6-A')}`), / 101 /, `${p} 계정 대소문자는 같은 계정`);
  }
});

test('C7 옛 화면 호환 — ?token= 은 이번 판에서 계속 받는다(무효 · 권한 없음은 예전처럼 거부)', async () => {
  mkUser('c7'); mkUser('c7-view', 'viewer');
  const tok = login('c7'); const vw = login('c7-view');
  const before = gw.remoteSessionStatus().upgradeVia['legacy-query'];
  for (const p of PATHS) {
    assert.match(await upgrade(`${p}?token=${encodeURIComponent(tok)}`), / 101 /, `${p} 옛 방식`);
    assert.match(await upgrade(`${p}?token=bad`), / 401 /, `${p} 옛 방식 무효`);
    assert.match(await upgrade(`${p}?token=${encodeURIComponent(vw)}`), / 403 /, `${p} 옛 방식 권한 없음`);
  }
  assert.equal(gw.remoteSessionStatus().upgradeVia['legacy-query'], before + 6, '옛 방식 사용 횟수를 센다(0 이면 호환을 지워도 된다)');
});

/* ═══════════ D. 열린 연결은 티켓의 토큰으로 추적된다 ═══════════ */

test('D1 SSH — 티켓으로 연 연결이 그 토큰의 세션으로 등록된다: 폐기 이벤트로 닫히고, 토큰 교체는 같은 계정만', async () => {
  mkUser('d1'); mkUser('d1-other');
  const tok = login('d1');
  const live0 = gw.remoteSessionStatus().live;
  const c = openWs(`/api/remote/ssh?${P}=${await ticketFor(tok)}`);
  assert.equal(await c.opened, true);
  assert.ok(await waitFor(() => gw.remoteSessionStatus().live === live0 + 1), '열린 연결이 레지스트리에 없다');
  assert.equal(gw.revalidateRemoteSessions(), 0, '주기 재검증이 방금 연 연결을 닫았다(티켓의 토큰이 연결에 전달되지 않았다)');
  assert.equal(c.close, null);
  // 토큰 교체 — 다른 계정의 토큰은 거부, 같은 계정 · 같은 sid 는 수락
  c.ws.send(JSON.stringify({ type: 'token', token: login('d1-other') }));
  assert.ok(await waitFor(() => c.frames.some((f) => f.includes('"token-ack"'))));
  assert.equal(JSON.parse(c.frames.find((f) => f.includes('"token-ack"'))).ok, false);
  const u = auth.getUser('d1');
  const t2 = auth.signToken({ sub: 'd1', role: u.role, name: 'd1', src: 'local', tv: u.tokenVersion || 0, sid: auth.verifyToken(tok).sid }, { exp: Math.floor(Date.now() / 1000) + 3600 });
  SECRETS.add(t2);
  c.frames.length = 0;
  c.ws.send(JSON.stringify({ type: 'token', token: t2 }));
  assert.ok(await waitFor(() => c.frames.some((f) => f.includes('"token-ack"'))));
  assert.equal(JSON.parse(c.frames.find((f) => f.includes('"token-ack"'))).ok, true, '같은 계정 · 같은 세션의 새 토큰은 받아야 한다');
  // 폐기 — 재검증 주기를 기다리지 않고 닫힌다
  assert.ok(rev.notifySessionRevoked({ username: 'd1', reason: 'logout' }) >= 1);
  assert.ok(await waitFor(() => c.close != null), '폐기 뒤에도 연결이 열려 있다');
  assert.equal(c.close, 4401);
  assert.ok(await waitFor(() => gw.remoteSessionStatus().live === live0));
});

test('D2 토큰 만료 시각에 닫힌다 — 티켓에 묶인 토큰의 exp 를 따른다', async () => {
  mkUser('d2');
  const tok = login('d2', { exp: Math.floor(Date.now() / 1000) + 2 });
  const c = openWs(`/api/remote/ssh?${P}=${await ticketFor(tok)}`);
  assert.equal(await c.opened, true);
  assert.equal(c.close, null);
  assert.ok(await waitFor(() => c.close != null, 6000), '토큰 만료 뒤에도 연결이 열려 있다(티켓의 토큰이 세션 추적에 전달되지 않았다)');
  assert.equal(c.close, 4401);
});

test('D3 RDP — 연결 쿼리에 토큰 없이 붙는다 · 자격증명 티켓은 예전처럼 발급자만 1회 소비한다', async () => {
  mkUser('d3-a'); mkUser('d3-b');
  const ta = login('d3-a'); const tb = login('d3-b');
  reg.saveConfig({ guacd: { host: '127.0.0.1', port: 4822 } });
  const ma = reg.addMapping({ protocol: 'rdp', targetHost: '127.0.0.1', targetPort: 3389, owner: 'd3-a', vcenterId: 'vc-a' });
  const mb = reg.addMapping({ protocol: 'rdp', targetHost: '127.0.0.1', targetPort: 3389, owner: 'd3-b', vcenterId: 'vc-a' });
  assert.equal(ma.ok, true, ma.reason); assert.equal(mb.ok, true, mb.reason);
  const socks = [];
  const mkSock = () => {
    const s = Object.assign(new EventEmitter(), {
      writes: [], destroyed: false,
      write(x) { if (this.destroyed) return false; this.writes.push(String(x)); return true; },
      destroy() { if (this.destroyed) return; this.destroyed = true; setImmediate(() => this.emit('close')); },
      end() { this.destroy(); }, setTimeout() {},
    });
    socks.push(s); return s;
  };
  gd._setRdpDepsForTest({ connect: () => mkSock() });
  try {
    // 화면과 같은 흐름: rdp-ticket 한 번으로 자격증명 티켓 + WS 티켓
    const ra = await post('/api/remote/rdp-ticket', ta, { username: 'adminA', password: 'secretA' });
    assert.equal(ra.status, 200);
    // ① 남(B)이 A 의 자격증명 티켓을 자기 WS 티켓으로 쓰려 한다 → 거부, A 의 티켓은 지워지지 않는다
    const wb = await ticketFor(tb);
    const cb = openWs(`/api/remote/rdp?${new URLSearchParams({ [P]: wb, mappingId: mb.mapping.id, width: '1024', height: '768', ticket: ra.body.ticket })}`);
    assert.equal(await cb.opened, true);
    assert.ok(await waitFor(() => cb.close != null), 'B 의 연결이 닫혀야 한다');
    assert.equal(cb.close, 1011);
    assert.match(cb.reason, /티켓/);
    assert.equal(socks.length, 0, '남의 자격증명 티켓으로 guacd 에 접속했다');
    // ② A 는 주소에 토큰 없이(wst + ticket) 붙는다 — 자격증명이 guacd connect 에 실린다
    const q = new URLSearchParams({ [P]: ra.body.wst, mappingId: ma.mapping.id, width: '1024', height: '768', ticket: ra.body.ticket });
    assert.ok(!q.has('token'));
    const ca = openWs(`/api/remote/rdp?${q}`);
    assert.equal(await ca.opened, true);
    assert.ok(await waitFor(() => socks.length === 1), 'guacd 에 접속해야 한다');
    socks[0].emit('connect');
    socks[0].emit('data', Buffer.from('4.args,13.VERSION_1_5_0,8.username,8.password;'));
    assert.ok(await waitFor(() => socks[0].writes.some((w) => w.startsWith('7.connect'))));
    const conn = socks[0].writes.find((w) => w.startsWith('7.connect'));
    assert.ok(conn.includes('adminA') && conn.includes('secretA'), `자격증명 티켓이 소비되지 않았다: ${conn}`);
    // ③ 열린 RDP 연결도 그 토큰의 세션으로 추적된다 — 주기 재검증은 유효한 토큰의 연결을 닫지 않고(토큰이 전달됐다), 폐기는 guacd 를 먼저 끊고 4401
    assert.equal(gw.revalidateRemoteSessions(), 0, '주기 재검증이 방금 연 RDP 연결을 닫았다(티켓의 토큰이 연결에 전달되지 않았다)');
    assert.equal(ca.close, null);
    assert.equal(socks[0].destroyed, false);
    rev.notifySessionRevoked({ username: 'd3-a', reason: 'logout' });
    assert.ok(await waitFor(() => ca.close != null), '폐기 뒤 RDP 연결이 열려 있다');
    assert.equal(ca.close, 4401);
    assert.equal(socks[0].destroyed, true);
    // ④ 같은 자격증명 티켓은 다시 쓸 수 없다(새 WS 티켓으로도)
    const ta2 = login('d3-a');
    const again = openWs(`/api/remote/rdp?${new URLSearchParams({ [P]: await ticketFor(ta2), mappingId: ma.mapping.id, ticket: ra.body.ticket })}`);
    assert.equal(await again.opened, true);
    assert.ok(await waitFor(() => again.close != null));
    assert.equal(again.close, 1011);
    assert.equal(socks.length, 1, '소비된 자격증명 티켓으로 다시 접속했다');
  } finally { gd._setRdpDepsForTest(null); rt._resetRdpTickets(); }
});

/* ═══════════ E. 남는 흔적 ═══════════ */

test('E1 콘솔 출력 · 설정 폴더(감사 로그 포함)에 세션 토큰 · 티켓 ID 가 남지 않는다', async () => {
  assert.ok(SECRETS.size >= 20, '앞 시험이 만든 토큰 · 티켓이 있어야 한다');
  const logged = LOGGED.join('\n');
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else files.push(f); } };
  await new Promise((r) => setTimeout(r, 300)); // 감사 줄이 파일에 내려가기를 잠깐 기다린다
  walk(DIR);
  const audit = files.find((f) => f.endsWith('audit.ndjson'));
  assert.ok(audit, '감사 로그가 쓰였어야 한다(발급은 감사 대상이다)');
  assert.match(fs.readFileSync(audit, 'utf8'), /\/api\/remote\/ws-ticket/, '티켓 발급이 감사 로그에 남아야 한다');
  for (const s of SECRETS) {
    assert.ok(!logged.includes(s), `콘솔 출력에 토큰/티켓이 찍혔다: ${s.slice(0, 12)}…`);
    for (const f of files) assert.ok(!fs.readFileSync(f, 'utf8').includes(s), `${path.basename(f)} 에 토큰/티켓이 남았다: ${s.slice(0, 12)}…`);
  }
});

/* ═══════════ F. 소스 스윕 ═══════════ */

const walkSrc = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walkSrc(f, out); } else if (/\.(js|jsx|mjs|cjs)$/.test(e.name) && !/\.test\.(js|jsx)$/.test(e.name)) out.push(f);
  }
  return out;
};

test('F1 web/src 전체 — 세션 토큰을 주소(WebSocket · EventSource · 쿼리 · 새 창)에 싣는 코드가 없다', () => {
  const files = walkSrc(WEB);
  assert.ok(files.length > 300, `web/src 를 훑지 못했다(${files.length})`);
  // getToken() 을 부를 수 있는 파일 — 머리말(Authorization)로 보내거나 화면 표시 · 만료 계산에만 쓴다. 새 파일이 생기면 여기에 넣기 전에 주소에 싣지 않는지 볼 것.
  const MAY_READ_TOKEN = new Set(['api.js', 'App.jsx', 'components/SessionExpiryGuard.jsx', 'components/ServiceDown.jsx', 'views/Login.jsx']);
  const bad = [];
  let wsSites = 0;
  for (const f of files) {
    const rel = path.relative(WEB, f).split(path.sep).join('/');
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    // ① 쿼리 이름으로 토큰을 싣는 글자(문자열 · 템플릿)
    for (const m of src.matchAll(/[?&](?:token|access_token|jwt|auth_token|bearer)=/gi)) bad.push(`${rel}: 쿼리에 토큰 이름 '${m[0]}'`);
    // ② URLSearchParams · 쿼리 객체에 token 키
    for (const m of src.matchAll(/URLSearchParams\(\s*\{[^}]*\btoken\b\s*[:,}]/g)) bad.push(`${rel}: URLSearchParams 에 token — ${m[0].slice(0, 60)}`);
    for (const m of src.matchAll(/searchParams\.(?:set|append)\(\s*['"`](?:token|access_token|jwt)['"`]/g)) bad.push(`${rel}: ${m[0]}`);
    // ③ WebSocket · EventSource · Guacamole 터널 · 새 창 · 그림 주소 줄에 토큰
    for (const line of src.split('\n')) {
      const ws = /new\s+WebSocket\s*\(|new\s+EventSource\s*\(|WebSocketTunnel\s*\(/.test(line);
      if (ws) wsSites += 1;
      if ((ws || /window\.open\s*\(|\.src\s*=|\bhref\s*=/.test(line)) && /getToken\s*\(|\btoken\b/i.test(line)) bad.push(`${rel}: 주소 줄에 토큰 — ${line.trim().slice(0, 90)}`);
    }
    // ④ getToken() 은 허용 목록의 파일만
    if (/\bgetToken\s*\(/.test(src) && !MAY_READ_TOKEN.has(rel)) bad.push(`${rel}: getToken() 을 부른다(허용 목록 밖 — 주소에 싣는 용도가 아닌지 확인)`);
  }
  assert.deepEqual(bad, [], `세션 토큰을 주소에 싣는 코드:\n${bad.join('\n')}`);
  assert.ok(wsSites >= 2, `WebSocket 생성 지점을 찾지 못했다(${wsSites}) — 스윕 정규식이 낡았다`);
  // 원격 콘솔은 토큰을 읽지도 않는다 — 티켓만 쓴다
  const con = stripComments(fs.readFileSync(path.join(WEB, 'remote/RemoteConsole.jsx'), 'utf8'));
  assert.doesNotMatch(con, /getToken/);
  assert.match(con, /wst = await requestWsTicket\(postJson\)[\s\S]{0,700}new WebSocket\(sshWsUrl\(location, wst\)\)/, 'SSH 는 티켓을 받은 뒤에 WS 를 연다');
  assert.match(con, /new URLSearchParams\(\{ \[WS_TICKET_PARAM\]: wst, mappingId: mapping\.id,/, 'RDP 연결 쿼리는 wst 를 싣는다');
  assert.match(con, /if \(!wst\) \{ setStatus\(/, 'WS 티켓이 없으면 접속하지 않는다(토큰 폴백 없음)');
});

test('F2 서버 — 쿼리에서 세션 토큰을 읽는 곳은 remoteUpgradeAuth 한 곳(옛 화면 호환)뿐이고 두 게이트웨이가 그 함수를 쓴다', () => {
  const hits = [];
  for (const f of walkSrc(SRC)) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/searchParams\.get\(\s*['"`](?:token|access_token|jwt)['"`]\s*\)|req\.query\.(?:token|access_token|jwt)\b/g)) hits.push(`${path.relative(SRC, f).split(path.sep).join('/')}: ${m[0]}`);
  }
  // metricsExport 는 세션 토큰이 아니라 메트릭 전용 토큰이고 METRICS_ALLOW_QUERY_TOKEN=true 일 때만이다(기본은 머리말만).
  assert.deepEqual(hits.sort(), ["proxy/sshGateway.js: searchParams.get('token')", 'routes/metricsExport.js: req.query.token'], hits.join('\n'));
  const ssh = fs.readFileSync(path.join(SRC, 'proxy/sshGateway.js'), 'utf8');
  const rdp = fs.readFileSync(path.join(SRC, 'proxy/guacdTunnel.js'), 'utf8');
  assert.match(ssh, /searchParams\.get\('token'\);\s*\/\/ 옛 화면 호환 — 다음 판에서 제거/, '옛 방식 수신 줄에 제거 예정 표시가 있어야 한다');
  assert.match(stripComments(ssh), /\(\{ token, user \} = remoteUpgradeAuth\(url\.searchParams\)\);/);
  assert.match(stripComments(rdp), /\(\{ token, user \} = remoteUpgradeAuth\(url\.searchParams, \{ resolveTokenUser: rdpDeps\.resolveTokenUser \}\)\);/);
  // 쿼리 이름 · 발급 경로는 화면과 서버가 같다
  assert.equal(webTicket.WS_TICKET_PARAM, wt.WS_TICKET_PARAM);
  assert.match(fs.readFileSync(path.join(WEB, 'remote/wsTicket.js'), 'utf8'), /post\('\/remote\/ws-ticket'/);
  assert.ok(webTicket.WS_TICKET_TIMEOUT_MS < wt.WS_TICKET_TTL_MS, '화면의 발급 시한이 티켓 수명보다 길면 받은 티켓이 이미 만료일 수 있다');
  assert.equal(webTicket.sshWsUrl({ protocol: 'https:', host: 'portal:8443' }, 'ab'.repeat(24)), `wss://portal:8443/api/remote/ssh?wst=${'ab'.repeat(24)}`);
});

/* ═══════════ G. 인증이 꺼진 포탈 ═══════════ */

function runChild(body, env = {}) {
  const dir = tmpDir('wsticket132c-');
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
  const script = `
    const SRC = ${JSON.stringify(`${SRC}/`)};
    const express = (await import('express')).default;
    const http = await import('node:http');
    const { WebSocket } = await import('ws');
    const out = {};
    try {
      const auth = await import(SRC + 'auth/auth.js');
      const gw = await import(SRC + 'proxy/sshGateway.js');
      const rdp = await import(SRC + 'proxy/guacdTunnel.js');
      const { remoteRouter } = await import(SRC + 'routes/remote.js');
      const app = express(); app.use(express.json());
      app.use('/api/remote', auth.authMiddleware, auth.requireEnrolled, remoteRouter);
      const server = http.createServer(app);
      gw.attachSshGateway(server); rdp.attachRdpGateway(server);
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const port = server.address().port;
      const open = (p) => new Promise((resolve) => {
        const ws = new WebSocket('ws://127.0.0.1:' + port + p);
        ws.on('unexpected-response', (_q, r) => resolve(r.statusCode));
        ws.on('open', () => { resolve(101); ws.terminate(); });
        ws.on('error', () => resolve(0));
      });
      ${body}
      server.close();
    } catch (e) { out.__error = String(e && e.stack || e); }
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'live', ...env },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${(r.stderr || '').slice(-2000)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력 없음: ${r.stdout.slice(-1000)} ${r.stderr.slice(-1000)}`);
  const o = JSON.parse(line.slice(2));
  assert.equal(o.__error, undefined, o.__error);
  return o;
}
const CHILD_FLOW = `
  const res = await fetch('http://127.0.0.1:' + port + '/api/remote/ws-ticket', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  out.issue = res.status;
  const j = await res.json().catch(() => ({}));
  out.wstOk = /^[0-9a-f]{48}$/.test(j.wst || '');
  out.sshTicket = await open('/api/remote/ssh?wst=' + (j.wst || ''));
  out.sshBare = await open('/api/remote/ssh');
  out.rdpTicket = await open('/api/remote/rdp?wst=' + (j.wst || '') + '&mappingId=none');
`;

test('G1 인증이 꺼진 포탈(operator) — 티켓 발급 · 티켓을 실은 접속 · 예전 방식 접속이 모두 된다', () => {
  const o = runChild(CHILD_FLOW, { AUTH_ENABLED: 'false', AUTH_DISABLED_ROLE: 'operator' });
  assert.deepEqual(o, { issue: 200, wstOk: true, sshTicket: 101, sshBare: 101, rdpTicket: 101 });
});

test('G2 인증이 꺼져 있어도 익명 역할이 viewer 면 발급 · 접속 모두 403(HTTP requirePerm 과 같다)', () => {
  const o = runChild(CHILD_FLOW, { AUTH_ENABLED: 'false', AUTH_DISABLED_ROLE: 'viewer' });
  assert.deepEqual(o, { issue: 403, wstOk: false, sshTicket: 403, sshBare: 403, rdpTicket: 403 });
});
