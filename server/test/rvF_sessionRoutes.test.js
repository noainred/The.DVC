/**
 * 2026-10-09 검토 S-05·S-06 — 실제 authRouter(express 에 마운트)·실제 resolveTokenUser·실제 상태 파일로 고정한다.
 *   S-06: 최초 로그인 토큰에도 총 상한(sessionMaxHours)이 적용된다(예전에는 연장에서만).
 *   S-05: POST /auth/logout 이 그 세션을 서버에서 폐기하고(복사한 토큰도 거부 · 재시작 후에도 유지 · 다른 세션은 유지),
 *         서버가 유휴 만료를 강제한다(자동 폴링은 활동이 아니다 — 활동은 로그인·연장·POST /auth/activity).
 * 기준 시각은 고정값이다(Date.now 를 그 시각으로 고정 — CLAUDE.md 규약).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rvF-sess-'));
const SECRET = 'rvF-session-routes-secret-0123456789abcdef';
Object.assign(process.env, {
  CONFIG_DIR: tmp, AUTH_ENABLED: 'true', AUTH_SECRET: SECRET, AUTH_TOKEN_TTL: '8h', DATA_SOURCE: 'mock',
});

const SRC = path.resolve(new URL('../src', import.meta.url).pathname);
const H = 3600;
const T0 = 1_900_000_000; // 고정 로그인 시각(초)
const realNow = Date.now;
const at = (sec) => { Date.now = () => sec * 1000; };
const decode = (t) => JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString());

let A; let sec; let st; let rev; let srv; let base;
const events = [];

before(async () => {
  A = await import('../src/auth/auth.js');
  sec = await import('../src/security/securitySettings.js');
  st = await import('../src/auth/sessionState.js');
  rev = await import('../src/auth/sessionRevocation.js');
  rev.onSessionRevoked((e) => events.push(e));
  const express = (await import('express')).default;
  const { authRouter } = await import('../src/routes/auth.js');
  for (const u of ['rvf.viewer', 'rvf.multi', 'rvf.idle', 'rvf.restart']) {
    const r = A.createUser({ username: u, name: u, role: 'viewer', password: 'Viewer#Pass123' }, { trusted: true });
    assert.notEqual(r.ok, false, JSON.stringify(r));
  }
  A.createUser({ username: 'rvf.admin', name: 'adm', role: 'admin', password: 'Admin#Pass12345' }, { trusted: true });
  assert.equal(A.setLocalPassword(A.DEMO_USERNAME, 'Demo#Pass12345', { trusted: true }).ok, true);
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api/auth`;
});

after(() => {
  Date.now = realNow;
  try { srv?.close(); } catch { /* */ }
  try { st._resetSessionStateForTest(); } catch { /* 종료 flush 가 지운 디렉터리를 다시 만들지 않게 */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
});

async function login(username, password = 'Viewer#Pass123') {
  const r = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  return body;
}
const me = async (tok) => (await fetch(`${base}/me`, { headers: { authorization: `Bearer ${tok}` } })).status;
const post = async (p, tok) => {
  const r = await fetch(`${base}${p}`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: '{}' });
  let body = null; try { body = await r.json(); } catch { /* */ }
  return { status: r.status, body };
};
/** lt 없는 구버전 토큰을 직접 서명(signToken 은 언제나 lt 를 싣는다). */
function legacyToken(payload) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${b({ alg: 'HS256', typ: 'JWT' })}.${b(payload)}`;
  return `${data}.${crypto.createHmac('sha256', SECRET).update(data).digest('base64url')}`;
}
const policy = (p) => sec.saveSessionSecurity({ idleLogoutEnabled: false, singleSession: false, sessionMaxHours: 0, ...p });

// ── S-06 ─────────────────────────────────────────────────────────────────────
test('S-06 ① TTL 8h · 상한 2h — 최초 로그인 토큰의 만료가 로그인 + 2h 를 넘지 않고, 2h 뒤 API 가 거부된다', async () => {
  policy({ sessionMaxHours: 2 });
  at(T0);
  const { token } = await login('rvf.viewer');
  const p = decode(token);
  assert.equal(p.lt, T0);
  assert.ok(p.exp <= T0 + 2 * H, `exp-lt = ${(p.exp - p.lt) / H}h (상한 2h 를 넘으면 안 된다)`);
  at(T0 + 2 * H - 1);
  assert.equal(await me(token), 200, '상한 직전은 통과');
  at(T0 + 2 * H);
  assert.equal(await me(token), 401, '상한 도달 — 거부');
  assert.equal(A.resolveTokenUser(token), null, 'WS 게이트웨이와 같은 판정 함수도 거부');
  at(T0 + 3 * H);
  assert.equal(await me(token), 401, '예전(v2.729)에는 3h 뒤에도 200 이었다');
});

test('S-06 ② 상한 0(무제한)과 TTL < 상한은 예전 그대로 지금 + TTL', async () => {
  policy({ sessionMaxHours: 0 });
  at(T0);
  let p = decode((await login('rvf.viewer')).token);
  assert.equal(p.exp - p.lt, 8 * H);
  policy({ sessionMaxHours: 12 });
  p = decode((await login('rvf.viewer')).token);
  assert.equal(p.exp - p.lt, 8 * H, 'TTL 8h 가 상한 12h 보다 짧다');
});

test('S-06 ③ lt 없는 구버전 토큰은 iat 기준으로 상한을 본다', async () => {
  policy({ sessionMaxHours: 2 });
  const u = A.getUser('rvf.viewer');
  const tok = legacyToken({ sub: 'rvf.viewer', role: 'viewer', name: 'x', src: 'local', tv: u.tokenVersion || 0, iat: T0, exp: T0 + 8 * H });
  at(T0 + H);
  assert.equal(await me(tok), 200);
  at(T0 + 2 * H + 1);
  assert.equal(await me(tok), 401);
});

test('S-06 ④ 실제 로그인 토큰을 3회 연장해도 총 상한은 원래 로그인 시각 + 상한', async () => {
  policy({ sessionMaxHours: 10, sessionWarnEnabled: true, sessionWarnMin: 120, sessionExtendMin: 60 });
  at(T0);
  let tok = (await login('rvf.viewer')).token;
  assert.equal(decode(tok).exp, T0 + 8 * H);
  const marks = [];
  for (const t of [T0 + 6 * H + 60, T0 + 7 * H + 60, T0 + 8 * H + 60]) {
    at(t);
    const r = await post('/extend', tok);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    tok = r.body.token;
    marks.push([decode(tok).exp - T0, r.body.capped]);
    assert.equal(decode(tok).lt, T0);
    assert.ok(decode(tok).sid, '연장 토큰도 같은 sid 를 승계');
  }
  assert.deepEqual(marks, [[9 * H, false], [10 * H, false], [10 * H, true]]);
  at(T0 + 10 * H);
  assert.equal(await me(tok), 401, '상한(로그인 + 10h)에서 끝난다');
});

test('S-06 ⑤ 운영 중 상한을 줄이면 기존 세션에도 다음 요청부터 적용된다(늘리면 다시 통과 — exp 안에서)', async () => {
  policy({ sessionMaxHours: 0 });
  at(T0);
  const tok = (await login('rvf.viewer')).token;
  policy({ sessionMaxHours: 1 });
  at(T0 + H + 1);
  assert.equal(await me(tok), 401);
  policy({ sessionMaxHours: 0 });
  assert.equal(await me(tok), 200);
});

// ── S-05 로그아웃 ─────────────────────────────────────────────────────────────
test('S-05 ① 로그아웃하면 복사해 둔 토큰도 거부된다(HTTP·resolveTokenUser) + 세션 폐기 이벤트', async () => {
  policy({});
  at(T0);
  const { token } = await login('rvf.viewer');
  const copy = String(token);
  assert.equal(await me(copy), 200);
  events.length = 0;
  const r = await post('/logout', token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.revoked, 'session');
  assert.equal(await me(copy), 401, '예전(v2.729)에는 /logout 이 없어 404 였고 복사 토큰이 계속 200 이었다');
  assert.equal(A.resolveTokenUser(copy), null);
  const e = events.find((x) => x.scope === 'session' && x.reason === 'logout');
  assert.ok(e, JSON.stringify(events));
  assert.equal(e.sid, decode(token).sid);
  assert.equal(e.username, 'rvf.viewer');
  assert.equal((await post('/logout', copy)).status, 401, '이미 폐기된 토큰은 401');
});

test('S-05 ② 다중 세션 허용(singleSession=false) — 그 세션만 폐기하고 다른 기기 세션은 유지', async () => {
  policy({ singleSession: false });
  at(T0);
  const a = (await login('rvf.multi')).token;
  const b = (await login('rvf.multi')).token;
  assert.notEqual(decode(a).sid, decode(b).sid, '로그인마다 sid 를 발급한다(다중 세션에서도)');
  assert.equal((await post('/logout', a)).status, 200);
  assert.equal(await me(a), 401);
  assert.equal(await me(b), 200, '같은 계정의 다른 세션은 살아 있다');
});

test('S-05 ③ 재시작(새 프로세스) 후에도 폐기가 유지되고, 다른 세션은 유지된다', async () => {
  policy({ singleSession: false });
  at(T0);
  const a = (await login('rvf.restart')).token;
  const b = (await login('rvf.restart')).token;
  assert.equal((await post('/logout', a)).status, 200);
  const script = `
    const now = Number(process.env.FAKE_NOW); if (now) Date.now = () => now;
    const A = await import(${JSON.stringify(pathToFileURL(path.join(SRC, 'auth/auth.js')).href)});
    const toks = JSON.parse(process.env.TOKS);
    process.stdout.write(JSON.stringify(toks.map((t) => !!A.resolveTokenUser(t))));
    process.exit(0);`;
  const r = spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', '--input-type=module', '-e', script], {
    env: { ...process.env, FAKE_NOW: String((T0 + 60) * 1000), TOKS: JSON.stringify([a, b]) }, encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), [false, true], `새 프로세스 판정: ${r.stdout} ${r.stderr}`);
});

test('S-05 ④ 활동 기록은 종료 flush 로 파일에 남는다(디바운스 창을 잃지 않는다)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvF-flush-'));
  try {
    const script = `
      Date.now = () => ${(T0 + 5) * 1000};
      const S = await import(${JSON.stringify(pathToFileURL(path.join(SRC, 'auth/sessionState.js')).href)});
      S.noteActivity('flush-sid-1', { username: 'u1', atSec: ${T0 + 5}, expSec: ${T0 + 8 * H} });
      process.exit(0);`;
    const r = spawnSync(process.execPath, ['--input-type=module', '--no-warnings', '-e', script], { env: { ...process.env, CONFIG_DIR: dir }, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'session-state.json'), 'utf8'));
    assert.equal(saved.activity['flush-sid-1']?.at, T0 + 5);
    assert.equal(fs.statSync(path.join(dir, 'session-state.json')).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('S-05 ⑤ 구버전 토큰(sid 없음)의 로그아웃은 토큰 지문으로 폐기한다', async () => {
  policy({});
  const u = A.getUser('rvf.viewer');
  at(T0);
  const tok = A.signToken({ sub: 'rvf.viewer', role: 'viewer', name: 'x', src: 'local', tv: u.tokenVersion || 0 });
  assert.equal(await me(tok), 200);
  const r = await post('/logout', tok);
  assert.equal(r.body?.revoked, 'token');
  assert.equal(await me(tok), 401);
});

// ── S-05 서버측 유휴 ──────────────────────────────────────────────────────────
test('S-05 ⑥ 유휴 1분 — 자동 폴링은 활동이 아니다(경계: 로그인 + 60s + 여유 120s)', async () => {
  policy({ idleLogoutEnabled: true, idleLogoutMin: 1 });
  at(T0);
  const tok = (await login('rvf.idle')).token;
  at(T0 + 100); assert.equal(await me(tok), 200);
  at(T0 + 170); assert.equal(await me(tok), 200);
  at(T0 + 180); assert.equal(await me(tok), 200, '경계(같음)는 통과');
  at(T0 + 181); assert.equal(await me(tok), 401, '폴링(/me)을 계속 했어도 사용자 활동이 없으면 만료');
  assert.equal((await post('/activity', tok)).status, 401, '만료된 세션은 활동 신호로 되살리지 않는다');
});

test('S-05 ⑦ 활동 신호(POST /auth/activity)는 유휴 기준을 뒤로 민다', async () => {
  policy({ idleLogoutEnabled: true, idleLogoutMin: 1 });
  at(T0 + 1000);
  const tok = (await login('rvf.idle')).token;
  at(T0 + 1150);
  const r = await post('/activity', tok);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.noted, true);
  at(T0 + 1150 + 180); assert.equal(await me(tok), 200);
  at(T0 + 1150 + 181); assert.equal(await me(tok), 401);
});

test('S-05 ⑧ 유휴 로그아웃을 끄면 서버도 판정하지 않는다', async () => {
  policy({ idleLogoutEnabled: false });
  at(T0);
  const tok = (await login('rvf.idle')).token;
  at(T0 + 7 * H);
  assert.equal(await me(tok), 200);
});

// ── 데모 계정·OTP 등록 전 세션 ────────────────────────────────────────────────
test('S-05 ⑨ 데모 계정(mock) — 중복 접속 허용 모드에서 로그아웃은 그 세션만, 활동 신호는 막히지 않는다', async () => {
  policy({ singleSession: true, idleLogoutEnabled: true, idleLogoutMin: 1 });
  sec.saveSessionSecurity({ demoSession: 'allow' });
  at(T0);
  const a = (await login(A.DEMO_USERNAME, 'Demo#Pass12345')).token;
  const b = (await login(A.DEMO_USERNAME, 'Demo#Pass12345')).token;
  at(T0 + 150);
  assert.equal((await post('/activity', a)).status, 200, '데모 계정의 활동 신호(데이터를 바꾸지 않는다)는 막히지 않는다');
  assert.equal((await post('/logout', a)).status, 200);
  assert.equal(await me(a), 401);
  assert.equal(await me(b), 200, '다른 데모 세션은 유지');
  at(T0 + 150 + 181);
  assert.equal(await me(b), 401, '데모 세션도 서버 유휴 판정을 받는다(b 는 활동 신호가 없었다)');
  sec.saveSessionSecurity({ demoSession: null, singleSession: false });
});

test('S-05 ⑩ OTP 등록 전용 세션도 활동 신호·로그아웃을 쓸 수 있다', async () => {
  policy({ idleLogoutEnabled: true, idleLogoutMin: 30 });
  at(T0);
  const body = await login('rvf.admin', 'Admin#Pass12345');
  assert.equal(body.user.mustEnrollOtp, true, '이 테스트의 전제: 고권한 OTP 미등록 = 등록 전용 세션');
  assert.equal((await post('/activity', body.token)).status, 200);
  assert.equal((await post('/logout', body.token)).status, 200);
  assert.equal(await me(body.token), 401);
});

test('S-05 ⑪ 단일 세션 교체도 이전 세션 폐기 이벤트를 낸다(열린 WS 를 닫게)', async () => {
  policy({ singleSession: true });
  at(T0);
  const first = (await login('rvf.viewer')).token;
  events.length = 0;
  await login('rvf.viewer');
  const e = events.find((x) => x.reason === 'single-session-replaced');
  assert.ok(e, JSON.stringify(events));
  assert.equal(e.sid, decode(first).sid);
  assert.equal(await me(first), 401);
  policy({ singleSession: false });
});

test('계정 단위 폐기 이벤트 — 비밀번호 변경·역할 변경·삭제(로컬은 다음 요청부터 이미 거부)', async () => {
  policy({});
  at(T0);
  A.createUser({ username: 'rvf.evt', role: 'operator', password: 'Evt#Pass123456' }, { trusted: true });
  const tok = A.signToken({ sub: 'rvf.evt', role: 'operator', name: 'e', src: 'local', tv: 0, sid: 'evt-sid' });
  assert.ok(A.resolveTokenUser(tok));
  events.length = 0;
  assert.equal(A.setLocalPassword('rvf.evt', 'Evt#Pass654321', { trusted: true }).ok, true);
  assert.equal(A.resolveTokenUser(tok), null, '로컬 계정은 tokenVersion 으로 이미 거부');
  assert.ok(events.some((x) => x.scope === 'user' && x.username === 'rvf.evt' && x.reason === 'password-changed'), JSON.stringify(events));
  events.length = 0;
  assert.equal(A.updateUser('rvf.evt', { role: 'viewer' }, { trusted: true }).ok, true);
  assert.ok(events.some((x) => x.scope === 'user' && x.reason === 'role-changed'));
  events.length = 0;
  assert.equal(A.deleteUser('rvf.evt', { trusted: true }).ok, true);
  assert.ok(events.some((x) => x.scope === 'user' && x.reason === 'account-deleted'));
});

test('상태 파일 손상 — 폐기 목록을 잃으면 그 전 로그인 세션을 전부 무효로 한다(되살리지 않는다)', async () => {
  policy({});
  at(T0);
  const tok = (await login('rvf.viewer')).token;
  st.persistNow();
  fs.writeFileSync(path.join(tmp, 'session-state.json'), '{ broken');
  st._resetSessionStateForTest();
  at(T0 + 10);
  assert.equal(await me(tok), 401, '손상 감지 시각 이전 로그인 세션은 무효');
  assert.ok(fs.readdirSync(tmp).some((f) => f.startsWith('session-state.json.corrupt.')), '손상본 보존');
  const fresh = JSON.parse(fs.readFileSync(path.join(tmp, 'session-state.json'), 'utf8'));
  assert.equal(fresh.notBefore, T0 + 10, '판정이 재시작 뒤에도 남게 새 파일을 바로 쓴다');
  at(T0 + 20);
  const tok2 = (await login('rvf.viewer')).token;
  assert.equal(await me(tok2), 200, '그 뒤 로그인은 정상');
});
