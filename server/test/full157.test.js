/**
 * 전체 점검 157회차 — 1축(인증 · 권한 · 라우트 틀 · 원격 실행 · 자격증명) 반증 + 이어 읽기 확정분 회귀.
 *  B1 단일 세션 강제(ID 공유 금지): AD 로그인은 입력한 이름 그대로 세션 이름이 된다 — 같은 AD 계정을 표기만 바꿔(대소문자 · `DOMAIN\이름` · `이름@도메인`) 로그인하면
 *     등록 키가 달라 서로를 끊지 못했다. AD 세션은 표기 변형을 접은 키(auth/ad.js adAccountKey)로 등록한다(로컬 계정은 이름 그대로).
 *  B2 계정명 `__proto__`(152 추정 E1): 만들 수 있었고, 그 계정의 사용자별 도구 재정의는 ‘저장됨’ 이라 답하고 저장되지 않았다(판정은 역할 기본값) → 만들지 않는다 · 저장을 거절한다.
 *  B3 SSH 게이트웨이 auth 프레임: username 이 글자가 아니거나 빠지면 ssh2 connect 가 곧바로 던져 처리기 밖으로 나갔다(‘[fatal] uncaughtException’ · WS 는 열린 채 세션 수 점유).
 *  B4 청크마다 toString(152 결정 D3): `execAnswered`(스토리지 CLI — LUN · 파일시스템 이름 · 설명) · RMA `tcpSend`(TCP 응답)도 여러 바이트 글자가 조각 경계에서 깨졌다.
 * 실제 authRouter + 합성 LDAP 서버 · 실제 게이트웨이 처리기 · 가짜 sshd(조각을 나눠 쓴다) · 실제 TCP 서버.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'full157-'));
Object.assign(process.env, { CONFIG_DIR: DIR, AUTH_ENABLED: 'true', AUTH_SECRET: 'full157-secret-0123456789abcdefghijklmnop', AUTH_TOKEN_TTL: '8h', DATA_SOURCE: 'live', OTP_ROLE_ENFORCE: 'false', SSRF_ALLOW_LOOPBACK: 'true', SSH_HOSTKEY_POLICY: 'observe' });
delete process.env.CENTRAL_URL;
const closers = [];
test.after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  fs.rmSync(DIR, { recursive: true, force: true });
});

const require = createRequire(new URL('../package.json', import.meta.url));
const ldap = require('ldapjs');
const ssh2 = (await import('ssh2')).default;
const A = await import('../src/auth/auth.js');
const AD = await import('../src/auth/ad.js');
const PM = await import('../src/auth/permissions.js');
const SESS = await import('../src/auth/sessions.js');
const SEC = await import('../src/security/securitySettings.js');

/* ── 합성 LDAP(AD 흉내 — bind 이름은 대소문자를 가리지 않는다) + 실제 authRouter ── */
const USER_DN = 'cn=kim,dc=corp,dc=local';
const PW = 'Ad#Pass12345';
const ldapSrv = ldap.createServer();
ldapSrv.bind('dc=corp,dc=local', (req, res, next) => {
  if (String(req.dn).toLowerCase().replace(/\s+/g, '') === USER_DN && req.credentials === PW) { res.end(); return next(); }
  return next(new ldap.InvalidCredentialsError());
});
ldapSrv.search('dc=corp,dc=local', (req, res, next) => {
  res.attributes = res.attributes.map((a) => String(a).toLowerCase());
  res.send({ dn: USER_DN, attributes: { sAMAccountName: 'kim', memberOf: ['CN=Portal-Admins,OU=Groups,DC=corp,DC=local'], displayName: 'Kim AD' } });
  res.end(); return next();
});
await new Promise((r) => ldapSrv.listen(0, '127.0.0.1', r));
closers.push(() => new Promise((r) => ldapSrv.close(() => r())));
// ‘이미 저장돼 있던’ 평문 설정(기존 현장 — 저장 경로는 새 평문을 거부하지만 기존 설정은 동작을 유지한다)
fs.writeFileSync(path.join(DIR, 'auth.json'), JSON.stringify({ ad: { enabled: true, url: `ldap://127.0.0.1:${ldapSrv.address().port}`, domain: '', baseDN: 'dc=corp,dc=local', adminGroup: 'Portal-Admins', defaultRole: 'viewer', timeoutMs: 3000 } }));
SEC.saveSessionSecurity({ idleLogoutEnabled: false, singleSession: true, sessionMaxHours: 0 });
const express = (await import('express')).default;
const { authRouter } = await import('../src/routes/auth.js');
const app = express(); app.use(express.json()); app.use('/api/auth', authRouter);
const web = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
closers.push(() => new Promise((r) => web.close(() => r())));
const base = `http://127.0.0.1:${web.address().port}/api/auth`;
async function login(username, password) {
  const r = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const body = await r.json();
  assert.equal(r.status, 200, `${username}: ${JSON.stringify(body)}`);
  return body.token;
}
const meStatus = async (tok) => (await fetch(`${base}/me`, { headers: { authorization: `Bearer ${tok}` } })).status;
const logout = async (tok) => (await fetch(`${base}/logout`, { method: 'POST', headers: { authorization: `Bearer ${tok}` } })).status;
const decode = (t) => JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString());

test('B1 단일 세션 강제 — 같은 AD 계정을 표기만 바꿔 로그인해도 한 자리다(뒤 로그인이 앞 세션을 끊는다) · 로컬 계정은 이름 그대로', async () => {
  const t1 = await login(USER_DN, PW);
  assert.equal(decode(t1).src, 'ad');
  assert.equal(await meStatus(t1), 200);
  // 같은 계정 · 대문자 표기(AD bind 는 대소문자를 가리지 않는다) — 세션 이름은 입력한 그대로다
  const t2 = await login('cn=KIM,dc=corp,dc=local', PW);
  assert.equal(decode(t2).sub, 'cn=KIM,dc=corp,dc=local');
  assert.equal(await meStatus(t2), 200);
  assert.equal(await meStatus(t1), 401, '앞 표기의 세션은 끊겨야 한다(수정 전: 200 — 두 세션이 함께 살았다)');
  // 세 번째 표기도 같은 자리
  const t3 = await login('cn=Kim,dc=corp,dc=local', PW);
  assert.equal(await meStatus(t2), 401);
  assert.equal(await meStatus(t3), 200);
  // 등록부에는 이 계정의 기록이 하나(접은 키) · 표시 이름은 실제 세션 이름
  const mine = SESS.listActiveSessions().filter((s) => s.username.toLowerCase().replace(/\s+/g, '') === USER_DN);
  assert.equal(mine.length, 1, JSON.stringify(SESS.listActiveSessions()));
  assert.equal(mine[0].username, 'cn=Kim,dc=corp,dc=local');
  // 로그아웃은 그 자리를 비운다 — 끊긴 앞 세션이 되살아나지 않는다
  assert.equal(await logout(t3), 200);
  assert.equal(await meStatus(t3), 401);
  assert.equal(await meStatus(t1), 401);
  assert.equal(await meStatus(t2), 401);
  assert.equal(SESS.listActiveSessions().filter((s) => s.username.toLowerCase().replace(/\s+/g, '') === USER_DN).length, 0);

  // 업그레이드 전에 이름 키로 등록된 AD 세션은 접은 키의 기록이 없는 동안 그대로 유효하다(전원 재로그인 없음) · 새 로그인이 오면 끊긴다
  const legacySid = SESS.newSessionId();
  SESS.setActiveSession(USER_DN, legacySid);   // 예전 판의 등록(이름 = 키)
  const legacyTok = A.signToken({ sub: USER_DN, role: 'admin', name: 'Kim AD', src: 'ad', ep: AD.adEpochOf(AD.loadAdConfig()), sid: legacySid });
  assert.equal(await meStatus(legacyTok), 200, '업그레이드 전 세션은 유지');
  const t4 = await login('cn=KIM,dc=corp,dc=local', PW);
  assert.equal(await meStatus(legacyTok), 401, '새 로그인 뒤에는 예전 세션도 끊긴다');
  assert.equal(await meStatus(t4), 200);
  // 새 세션이 로그아웃해도 예전(이름 키) 세션은 되살아나지 않는다 — 대소문자만 다른 표기 · 같은 표기 둘 다
  assert.equal(await logout(t4), 200);
  assert.equal(await meStatus(legacyTok), 401, '끊긴 예전 세션이 로그아웃 뒤 되살아나면 안 된다');
  SESS.setActiveSession(USER_DN, legacySid);   // 다시 예전 판의 등록
  assert.equal(await meStatus(legacyTok), 200);
  const t5 = await login(USER_DN, PW);          // 같은 표기로 새 로그인
  assert.equal(await meStatus(legacyTok), 401);
  assert.equal(await logout(t5), 200);
  assert.equal(await meStatus(legacyTok), 401);

  // 로컬 계정은 대소문자가 다른 별개 계정이다 — 서로를 끊지 않는다(키를 접지 않는다)
  assert.equal(A.createUser({ username: 'lee157', role: 'viewer', password: 'Local#Pass12345' }, { trusted: true }).ok, true);
  assert.equal(A.createUser({ username: 'LEE157', role: 'viewer', password: 'Local#Pass12345' }, { trusted: true }).ok, true);
  const l1 = await login('lee157', 'Local#Pass12345');
  const l2 = await login('LEE157', 'Local#Pass12345');
  assert.equal(await meStatus(l1), 200); assert.equal(await meStatus(l2), 200);
  const l3 = await login('lee157', 'Local#Pass12345');   // 같은 로컬 계정의 새 로그인만 앞 세션을 끊는다
  assert.equal(await meStatus(l1), 401); assert.equal(await meStatus(l3), 200); assert.equal(await meStatus(l2), 200);
  assert.equal(await logout(l2), 200);
  assert.equal(await meStatus(l3), 200, '다른 계정의 로그아웃이 내 자리를 지우지 않는다');
});

test('B1 adAccountKey — 소문자 · DOMAIN\\ 앞을 뗀다 · @도메인은 설정한 도메인과 같을 때만 뗀다 · 로컬 이름과 겹치지 않는다', () => {
  // 도메인 미설정(위 auth.json)
  assert.equal(AD.adAccountKey('Kim'), 'ad:kim');
  assert.equal(AD.adAccountKey(' KIM '), 'ad:kim');
  assert.equal(AD.adAccountKey('CORP\\Kim'), 'ad:kim');
  assert.equal(AD.adAccountKey('kim@corp.local'), 'ad:kim@corp.local', '도메인을 모르면 UPN 은 그대로(다른 도메인의 같은 이름일 수 있다)');
  assert.equal(AD.adAccountKey('KIM@Corp.Local'), 'ad:kim@corp.local');
  assert.notEqual(AD.adAccountKey('kim'), 'kim');
  assert.equal(A.activeSessionKeyOf('Kim', true), '', '로컬은 이름 그대로(키 없음)');
  assert.equal(A.activeSessionKeyOf('Kim', false), 'ad:kim');
  // 도메인 설정 — 같은 도메인의 UPN 만 접는다
  const cur = JSON.parse(fs.readFileSync(path.join(DIR, 'auth.json'), 'utf8'));
  fs.writeFileSync(path.join(DIR, 'auth.json'), JSON.stringify({ ad: { ...cur.ad, domain: 'Corp.Local' } }));
  AD._resetAdConfigReadForTest(); AD.invalidateAdPolicyCache();
  try {
    assert.equal(AD.adAccountKey('kim@corp.local'), 'ad:kim');
    assert.equal(AD.adAccountKey('KIM@CORP.LOCAL'), 'ad:kim');
    assert.equal(AD.adAccountKey('CORP\\kim'), 'ad:kim');
    assert.equal(AD.adAccountKey('kim@other.example'), 'ad:kim@other.example');
    assert.equal(AD.adAccountKey('@corp.local'), 'ad:@corp.local', '이름이 빈 값은 접지 않는다');
  } finally {
    fs.writeFileSync(path.join(DIR, 'auth.json'), JSON.stringify(cur));
    AD._resetAdConfigReadForTest(); AD.invalidateAdPolicyCache();
  }
  // 길고 이상한 입력도 선형(역슬래시 2만 개)
  const t0 = Date.now(); AD.adAccountKey('\\'.repeat(20000) + 'x'); assert.ok(Date.now() - t0 < 500);
});

test('B2 계정명 __proto__ — 만들지 않는다(화면 · 중앙 배포) · 그 이름의 사용자별 도구 재정의 저장은 거절(‘저장됨’ 이라 답하지 않는다) · 다른 이름은 그대로', () => {
  const c = A.createUser({ username: '__proto__', role: 'viewer', password: 'Passw0rd-123' }, { trusted: true });
  assert.equal(c.ok, false); assert.match(c.reason, /__proto__/);
  assert.equal(A.getUser('__proto__'), null);
  const m = A.applyManagedUsers([{ username: '__proto__', role: 'viewer', name: 'x' }, { username: 'edge157', role: 'viewer', name: 'e' }]);
  assert.equal(m.created, 1); assert.equal(m.skipped.length, 1); assert.match(m.skipped[0], /__proto__/);
  assert.equal(A.getUser('__proto__'), null); assert.ok(A.getUser('edge157'));
  // 이미 그 이름의 계정이 있는 현장(업그레이드 전에 만든 것) — 재정의 저장을 거절한다(예전: ok:true + entry · 파일에는 없음 · 판정은 역할 기본값)
  const s = PM.setUserTools('__proto__', { mode: 'allow', tools: ['storage'], by: 'adm' });
  assert.equal(s.ok, false, JSON.stringify(s)); assert.match(s.reason, /__proto__/);
  assert.equal(PM.effectiveToolAccess({ username: '__proto__', role: 'viewer' }).mode, 'role');
  // 프로토타입에 있는 다른 이름들은 자기 칸으로 저장되고 판정에 쓰인다
  for (const name of ['constructor', 'toString', 'hasOwnProperty']) {
    assert.equal(A.createUser({ username: name, role: 'viewer', password: 'Passw0rd-123' }, { trusted: true }).ok, true, name);
    const r = PM.setUserTools(name, { mode: 'allow', tools: ['storage'], by: 'adm' });
    assert.equal(r.ok, true, name);
    assert.equal(PM.effectiveToolAccess({ username: name, role: 'viewer' }).mode, 'allow', name);
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(DIR, 'permissions.json'), 'utf8')).matrix.users, name), true, name);
  }
  // 재정의가 없는 계정은 프로토타입 값을 재정의로 읽지 않는다
  assert.equal(PM.effectiveToolAccess({ username: 'valueOf', role: 'viewer' }).mode, 'role');
});

/* ── B3 SSH 게이트웨이 ── */
class FakeWs extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.readyState = 1; this.frames = []; this.closed = null; this.bufferedAmount = 0; }
  send(d, cb) { this.frames.push(String(d)); if (cb) setImmediate(() => cb()); }
  close(code, reason) { if (this.readyState !== 1) return; this.readyState = 3; this.closed = { code, reason }; setImmediate(() => this.emit('close')); }
  terminate() { this.close(1006, ''); }
  input(o) { this.emit('message', Buffer.from(JSON.stringify(o))); }
  statuses() { return this.frames.filter((f) => f.startsWith('{')).map((f) => JSON.parse(f)).filter((o) => o.type === 'status').map((o) => o.text); }
}
test('B3 SSH 게이트웨이 — auth 프레임의 username 이 글자가 아니거나 빠져도 처리기 밖으로 던지지 않는다: 사유를 말하고 닫고 세션 수를 돌려준다', async () => {
  const gw = await import('../src/proxy/sshGateway.js');
  const reg = await import('../src/proxy/registry.js');
  const { store } = await import('../src/store.js');
  store.snapshot = { ...store.get(), vcenters: [{ id: 'vc-a' }], vms: [], hosts: [] };
  const r = reg.addMapping({ protocol: 'ssh', targetHost: '127.0.0.1', targetPort: 9, owner: 'adm157', vcenterId: 'vc-a' });
  assert.equal(r.ok, true, r.reason);
  const user = { username: 'adm157', role: 'admin', scope: { vcenters: [], regions: [], writeVcenters: [] } };
  gw._setRemoteDepsForTest({ resolveTokenUser: () => user, sessionInfoOf: () => ({ username: 'adm157', sid: 's157', source: 'local', exp: Math.floor(Date.now() / 1000) + 3600 }), touchSessionActivity: () => true });
  try {
    for (const bad of [5, { a: 1 }, null, undefined, ['root']]) {
      const ws = new FakeWs();
      gw._handleConnectionForTest(ws, user, { token: 'tok157' });
      assert.doesNotThrow(() => ws.input({ type: 'auth', mappingId: r.mapping.id, username: bad, password: 'pw' }), `username=${JSON.stringify(bad)}`);
      assert.deepEqual(ws.closed, { code: 1011, reason: 'connect failed' }, `username=${JSON.stringify(bad)} ${ws.statuses().join(' | ')}`);
      assert.ok(ws.statuses().some((t) => t.startsWith('연결 실패:')), ws.statuses().join(' | '));
      assert.equal(gw.activeSshSessionCount(), 0, '세션 수를 돌려준다');
    }
    // 글자 이름은 예전 그대로 접속을 시도한다(닫힌 포트 — 연결 실패로 닫힌다 · 던지지 않는다)
    const ws = new FakeWs();
    gw._handleConnectionForTest(ws, user, { token: 'tok157' });
    ws.input({ type: 'auth', mappingId: r.mapping.id, username: 'root', password: 'pw' });
    assert.equal(ws.closed, null, '접속 시도 중');
    assert.equal(gw.activeSshSessionCount(), 1);
    for (let i = 0; i < 200 && !ws.closed; i += 1) await new Promise((res) => setTimeout(res, 20));
    assert.deepEqual(ws.closed, { code: 1011, reason: 'connect failed' });
    assert.equal(gw.activeSshSessionCount(), 0);
  } finally { gw._setRemoteDepsForTest(null); }
});

/* ── B4 조각 경계의 여러 바이트 글자 ── */
const KO = '가나다라마바사 한글 LUN 설명';
const KO_BUF = Buffer.from(`${KO}\n`, 'utf8');
test('B4 execAnswered — 여러 바이트 글자가 조각 경계에 걸려도 깨지지 않는다(stdout · stderr) · 프롬프트 응답은 그대로 · 시한으로 끊긴 결과에는 끊긴 조각을 붙이지 않는다', async () => {
  const { withSsh } = await import('../src/proxy/sshExec.js');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const st = { mode: 'split', answered: '' };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const srv = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => (ctx.method === 'password' ? ctx.accept() : ctx.reject(['password'])));
    client.on('ready', () => client.on('session', (accept) => {
      const s = accept();
      s.on('exec', async (acc) => {
        const stream = acc();
        stream.on('data', (d) => { st.answered += String(d); });
        if (st.mode === 'hang') { stream.write(KO_BUF.subarray(0, 7)); return; }   // 글자 가운데에서 멈춘다(시한까지)
        if (st.mode === 'cut') { stream.write(KO_BUF.subarray(0, 7)); stream.stderr.write(KO_BUF.subarray(0, 4)); await wait(20); stream.exit(0); stream.end(); return; }   // 글자 가운데에서 끝난다
        // 한글 한 글자(3바이트)의 가운데에서 끊어 두 번에 쓴다 — 그 사이에 페이저 프롬프트
        stream.write(KO_BUF.subarray(0, 4)); stream.stderr.write(KO_BUF.subarray(0, 5));
        await wait(60);
        stream.write(Buffer.concat([KO_BUF.subarray(4), Buffer.from('--More--')])); stream.stderr.write(KO_BUF.subarray(5));
        for (let i = 0; i < 100 && !st.answered; i += 1) await wait(10);
        stream.write(Buffer.from('\ntail\n'));
        await wait(20);
        stream.exit(0); stream.end();
      });
    }));
    client.on('error', () => {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const conn = { host: '127.0.0.1', port: srv.address().port, username: 'root', password: 'x', readyTimeout: 10_000 };
  const r = await withSsh(conn, async ({ execAnswered }) => ({ out: await execAnswered('show', { timeoutMs: 5000, pty: false, rules: ['pager'] }) }));
  assert.equal(r.out.stdout.includes('�'), false, JSON.stringify(r.out.stdout));
  assert.ok(r.out.stdout.startsWith(`${KO}\n`), JSON.stringify(r.out.stdout));
  assert.ok(r.out.stdout.endsWith('tail\n'));
  assert.equal(r.out.stderr, `${KO}\n`, JSON.stringify(r.out.stderr));
  assert.equal(r.out.pages, 1, '페이저 프롬프트에 한 번 답했다');
  assert.equal(st.answered, '\n');
  assert.equal(r.out.code, 0);
  // 시한 — 받은 만큼(글자 가운데의 조각은 붙이지 않는다: U+FFFD 없음)
  st.mode = 'hang';
  const h = await withSsh(conn, async ({ execAnswered }) => ({ out: await execAnswered('show', { timeoutMs: 1000, pty: false, rules: ['pager'] }) }));
  assert.equal(h.out.timedOut, true);
  assert.equal(h.out.stdout, '가나', JSON.stringify(h.out.stdout));
  // 채널이 글자 가운데에서 닫히면 남은 조각을 낸다(exec 와 같다 — 받은 바이트를 조용히 버리지 않는다)
  st.mode = 'cut';
  const c = await withSsh(conn, async ({ execAnswered }) => ({ out: await execAnswered('show', { timeoutMs: 5000, pty: false, rules: ['pager'] }) }));
  assert.equal(c.out.stdout, '가나\uFFFD', JSON.stringify(c.out.stdout));
  assert.equal(c.out.stderr, '가\uFFFD', JSON.stringify(c.out.stderr));
});

test('B4 RMA tcpSend — TCP 조각 경계에 걸린 여러 바이트 글자가 깨지지 않는다 · 4KB 상한은 그대로', async () => {
  const { tcpSend } = await import('../src/rma/exec.js');
  const st = { big: false };
  const srv = net.createServer((sock) => {
    sock.setNoDelay(true);
    sock.on('error', () => {});
    if (st.big) { sock.end(Buffer.from('가'.repeat(5000))); return; }
    sock.write(KO_BUF.subarray(0, 4));
    setTimeout(() => { sock.end(KO_BUF.subarray(4)); }, 80);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const r = await tcpSend('127.0.0.1', srv.address().port, '', 5000);
  assert.equal(r.ok, true);
  assert.equal(r.stdout, `${KO}\n`, JSON.stringify(r.stdout));
  st.big = true;
  const b = await tcpSend('127.0.0.1', srv.address().port, '', 5000);
  assert.equal(b.stdout.length, 4096);
  assert.equal(b.stdout.includes('�'), false);
});

/* ── B5 중계 서버 SSH 배포 시험 — 설정 파일 경로 ── */
test('B5 /remote/deploy/test — 요청의 haproxyConfigPath 가 저장된 SSH 비밀로 도는 셸 명령에 그대로 끼지 않는다(범위 관리자 · 기본 중계 서버) · 저장 · 배포도 같은 판정', async () => {
  const reg = await import('../src/proxy/registry.js');
  const dep = await import('../src/proxy/deploy.js');
  const { store } = await import('../src/store.js');
  const { remoteRouter } = await import('../src/routes/remote.js');
  store.snapshot = { ...store.get(), vcenters: [{ id: 'vc-a' }, { id: 'vc-b' }], vms: [], hosts: [] };
  // 가짜 중계 서버(sshd) — 받은 exec 명령을 적는다
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const cmds = []; let conns = 0;
  const sshd = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    conns += 1;
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === 'Stored-Root-Pw' ? ctx.accept() : ctx.reject(['password'])));
    client.on('ready', () => client.on('session', (accept) => { const s = accept(); s.on('exec', (acc, _rej, info) => { cmds.push(info.command); const st = acc(); st.write('OK\n'); st.exit(0); st.end(); }); }));
    client.on('error', () => {});
  });
  await new Promise((r) => sshd.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => sshd.close(() => r())));
  // 전체 범위 관리자가 저장해 둔 기본 중계 서버의 SSH 배포 설정(비밀번호는 저장값)
  reg.saveConfig({ deploy: { enabled: true, host: '127.0.0.1', port: sshd.address().port, username: 'root', password: 'Stored-Root-Pw' } });
  // 범위 관리자(vc-a 만) — 기본 중계 서버 설정을 바꿀 수 없는 계정이다(PUT /config 403)
  assert.equal(A.createUser({ username: 'sadm157', role: 'admin', password: 'Scoped#Pass12345', scope: { vcenters: ['vc-a'] } }, { trusted: true }).ok, true);
  const tok = await login('sadm157', 'Scoped#Pass12345');
  const app2 = express(); app2.use(express.json()); app2.use('/api/remote', A.authMiddleware, A.requireEnrolled, remoteRouter);
  const web2 = await new Promise((r) => { const s = app2.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => web2.close(() => r())));
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${web2.address().port}/api/remote${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  assert.equal((await call('PUT', '/config', { deploy: { reloadCmd: 'id' } })).status, 403, '범위 관리자는 기본 중계 서버 설정을 바꿀 수 없다');
  // 끼워 넣기 시도 — 저장된 비밀번호를 그대로 쓰게 두고(비밀번호 칸 없음) 경로 칸에 셸 문장을 넣는다
  for (const bad of ['/etc/hosts; touch /tmp/pwn157 #', '/etc/haproxy/haproxy.cfg && id', '$(id)', '/a b', '/a`id`', '/a\nid', 'relative/path', '/a|b', "/a'b", '/a>b', '/a\tb', { toString: 1 }, 5]) {
    const n0 = cmds.length; const c0 = conns;
    const r = await call('POST', '/deploy/test', { proxyId: 'default', deploy: { haproxyConfigPath: bad } });
    assert.equal(r.status, 200, JSON.stringify(bad));
    assert.equal(r.body.ok, false, `${JSON.stringify(bad)} → ${JSON.stringify(r.body)}`);
    assert.match(String(r.body.reason), /경로/);
    assert.equal(cmds.length, n0, `명령이 나가면 안 된다: ${JSON.stringify(cmds.slice(n0))}`);
    assert.equal(conns, c0, '접속도 하지 않는다');
  }
  // 정상 경로 · 빈 칸(= 기본 경로)은 예전 그대로(저장된 비밀로 시험)
  const ok = await call('POST', '/deploy/test', { proxyId: 'default', deploy: { haproxyConfigPath: '/etc/haproxy/conf.d/portal_1.cfg' } });
  assert.equal(ok.body.ok, true, JSON.stringify(ok.body)); assert.equal(ok.body.configReadable, true);
  assert.equal(cmds[cmds.length - 1], 'test -r /etc/haproxy/conf.d/portal_1.cfg && echo OK || echo MISSING');
  const empty = await call('POST', '/deploy/test', { proxyId: 'default', deploy: { haproxyConfigPath: '' } });
  assert.equal(empty.body.ok, true, JSON.stringify(empty.body));
  assert.equal(cmds[cmds.length - 1], 'test -r /etc/haproxy/haproxy.cfg && echo OK || echo MISSING');
  // 배포(deployToProxy)도 같은 판정 — 저장본에 이상한 경로가 있어도 셸에 닿지 않는다(접속 전에 거절)
  const n1 = conns;
  const d = await dep.deployToProxy({ host: '127.0.0.1', port: sshd.address().port, username: 'root', password: 'Stored-Root-Pw', haproxyConfigPath: '/etc/haproxy/haproxy.cfg; id' }, []);
  assert.equal(d.ok, false); assert.match(d.reason, /경로/); assert.equal(conns, n1);
  // 저장도 거절한다(기본 중계 서버 · 중계 서버 항목)
  assert.throws(() => reg.saveConfig({ deploy: { haproxyConfigPath: '/etc/haproxy/haproxy.cfg; id' } }), /경로/);
  const sp = reg.saveProxy({ name: 'p157', proxyHost: '10.9.9.9', deploy: { haproxyConfigPath: '$(id)' } });
  assert.equal(sp.ok, false); assert.match(String(sp.reason), /경로/);
  assert.equal(reg.haproxyCfgPathIssue('/etc/haproxy/haproxy.cfg'), null);
  assert.equal(reg.haproxyCfgPathIssue(undefined), null, '주지 않은 칸 · 빈 칸은 기본 경로를 쓴다(검사하지 않는다)');
  assert.equal(reg.haproxyCfgPathIssue(''), null);
  assert.ok(reg.haproxyCfgPathIssue(`/${'a'.repeat(300)}`));
});
