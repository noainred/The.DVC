/**
 * securityFullAudit19.test.js — 전체 점검 19회차(보안·인증 ① 인증 · 세션 · 로그인) 확정분.
 *  A-1 진행 중 로그인 인증은 계정당 1건(AD bind 대기 중 동시 요청이 잠금 검사를 모두 통과하던 것)
 *  A-2 이미 OTP 를 등록한 계정의 본인 재등록은 현재 OTP 코드가 있어야 한다(세션 탈취 → 영구 계정 탈취)
 *  A-3 권한 파일을 못 읽으면 최소 권한(기본 매트릭스로 넓어지던 것) — 재시작 뒤 보존본만 있어도
 *  A-4 users.json 읽기 오류는 원본을 옮기지 않고 계정을 만들지 않는다(fail-closed) · 형태가 다른 파일도 보존
 *  A-5 로그인 성공은 그 계정이 낸 실패만큼만 출발지 카운터에서 뺀다 · A-11 RDP 티켓은 발급자만 · A-12 IPv6 정규식 길이 먼저
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secfa19-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_DIR = tmp;
process.env.AUTH_ENABLED = 'true';
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const HERE = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.join(HERE, '../src');

test('A-1 — AD bind 를 기다리는 동안 같은 계정 동시 로그인은 DC 에 한 번만 간다', async () => {
  let conns = 0;
  const dc = net.createServer((s) => { conns += 1; s.on('error', () => {}); });   // 연결만 받고 답하지 않는 DC
  await new Promise((r) => dc.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(tmp, 'auth.json'), JSON.stringify({ ad: { enabled: true, url: `ldap://127.0.0.1:${dc.address().port}`, timeoutMs: 1500, upnSuffix: 'corp.local' } }));
  const express = (await import('express')).default;
  const { authRouter } = await import('../src/routes/auth.js');
  const app = express(); app.use(express.json()); app.use('/api/auth', authRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const url = `http://127.0.0.1:${srv.address().port}/api/auth/login`;
    const rs = await Promise.all(Array.from({ length: 20 }, () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'kim', password: 'Guess!1' }) }).then((r) => r.status)));
    assert.ok(conns <= 1, `DC 도달 ${conns}회(수정 전: 20회)`);
    assert.ok(rs.filter((x) => x === 429).length >= 19, `동시 요청은 429: ${rs.join(',')}`);
  } finally { srv.close(); dc.close(); fs.rmSync(path.join(tmp, 'auth.json'), { force: true }); }
});

test('A-2 — 등록된 계정의 본인 재등록: 현재 코드 없으면 403 · 맞으면 begin → confirm · confirm 만 단독 거부', async () => {
  const src = fs.readFileSync(path.join(SRC, 'routes/auth.js'), 'utf8');
  assert.match(src, /if \(otpEnrolled\(req\.user\.username\)\) \{\n    const cur = String\(\(req\.body \|\| \{\}\)\.currentCode \?\? ''\)\.trim\(\);\n    const v = cur \? verifyUserOtp\(req\.user\.username, cur\)/);
  assert.match(src, /if \(!\(Date\.now\(\) - at < SELF_REBIND_MS\)\) \{/);
  assert.match(src, /needCurrentOtp: true/);
  // 등록 전 세션(mustEnrollOtp — 처음 등록)은 코드 없이: otpEnrolled 가 false 면 분기를 건너뛴다
  assert.match(src, /const otpEnrolled = \(name\) => \{ const u = getUser\(name\); return !!\(u && u\.totpEnabled && u\.totpSecret\); \};/);
});

test('A-3 — 권한 파일 손상 · 재시작 뒤 보존본만 · 읽기 오류: 최소 권한(넓어지지 않음) · 저장이 푼다', () => {
  const run = (setup) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'perm19-'));
    try {
      setup(d);
      const code = `const m = await import(${JSON.stringify(path.join(SRC, 'auth/permissions.js'))});
        const x = m.loadMatrix(); console.log(JSON.stringify({ op: x.operator, ad: x.adminDenied, err: !!m.permissionsLoadError() }));`;
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, CONFIG_DIR: d, DATA_DIR: d }, encoding: 'utf8' });
      const line = r.stdout.trim().split('\n').pop();
      return { out: JSON.parse(line), files: fs.readdirSync(d) };
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  };
  const corrupt = run((d) => fs.writeFileSync(path.join(d, 'permissions.json'), '{"schemaVersion":4,"matrix":{"operator":["dashboard"'));
  assert.deepEqual(corrupt.out.op, ['dashboard']); assert.deepEqual(corrupt.out.ad, ['data.csv']); assert.equal(corrupt.out.err, true);
  assert.ok(corrupt.files.some((f) => f.startsWith('permissions.json.corrupt.')));
  const restarted = run((d) => fs.writeFileSync(path.join(d, 'permissions.json.corrupt.1700000000000'), '{'));
  assert.deepEqual(restarted.out.op, ['dashboard'], '재시작 뒤 보존본만 있어도 최소 권한'); assert.equal(restarted.out.err, true);
  const dirErr = run((d) => fs.mkdirSync(path.join(d, 'permissions.json')));
  assert.deepEqual(dirErr.out.op, ['dashboard'], '읽기 오류(EISDIR)도 최소 권한');
  assert.ok(dirErr.files.includes('permissions.json') && !dirErr.files.some((f) => f.includes('.corrupt.')), '읽기 오류는 원본을 옮기지 않는다');
  const fresh = run(() => {});
  assert.ok(fresh.out.op.length > 1, '처음 설치(파일 · 보존본 없음)는 기본 매트릭스'); assert.equal(fresh.out.err, false);
});

test('A-4 — users.json 이 디렉터리(읽기 오류): 원본 유지 · 계정 생성 없음 · 로그인 불가 · 형태 불일치는 보존', () => {
  const run = (setup) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'users19-'));
    try {
      setup(d);
      const code = `const a = await import(${JSON.stringify(path.join(SRC, 'auth/auth.js'))});
        const u = a.loadUsers(); console.log(JSON.stringify({ n: u.length, err: a.usersReadError(), setup: a.setupState() }));`;
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, CONFIG_DIR: d, DATA_DIR: d, AUTH_ENABLED: 'true' }, encoding: 'utf8' });
      return { out: JSON.parse(r.stdout.trim().split('\n').pop()), files: fs.readdirSync(d) };
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  };
  const dir = run((d) => fs.mkdirSync(path.join(d, 'users.json')));
  assert.equal(dir.out.n, 0, '계정을 만들지 않는다'); assert.equal(dir.out.err.code, 'EISDIR');
  assert.equal(dir.out.setup.setupPending, false, '초기 비밀번호 파일을 안내하지 않는다');
  assert.ok(!dir.files.some((f) => f.includes('.corrupt.')), '원본을 옮기지 않는다');
  assert.ok(!dir.files.includes('initial-admin-password.txt'));
  const shape = run((d) => fs.writeFileSync(path.join(d, 'users.json'), JSON.stringify({ users: {} })));
  assert.ok(shape.out.n >= 1, '형태 불일치는 예전처럼 시드'); assert.ok(shape.files.some((f) => f.startsWith('users.json.corrupt.')), '그 전에 원본을 보존');
});

test('A-5 — 성공은 그 계정의 실패만큼만 출발지 카운터에서 뺀다(자기 계정 성공을 끼워 출발지 한도를 비우지 못한다)', async () => {
  const L = await import('../src/security/loginRateLimit.js');
  const ip = '198.51.100.77';
  let blocked = 0;
  for (let i = 0; i < 300; i++) {
    if (i % 40 === 39) L.recordLoginSuccess(ip, 'attacker');
    if (L.checkLoginAllowed(ip, `u${i}`).blocked) { blocked += 1; continue; }
    L.recordLoginFailure(ip, `u${i}`);
  }
  assert.ok(blocked > 200, `차단 ${blocked}회(수정 전 0회)`);
  // 본인 오타는 예전처럼 풀린다
  const ip2 = '198.51.100.78';
  for (let i = 0; i < 3; i++) L.recordLoginFailure(ip2, 'kim');
  L.recordLoginSuccess(ip2, 'kim');
  assert.equal(L.checkLoginAllowed(ip2, 'lee').blocked, false);
});

test('A-11 · A-12 — RDP 티켓은 발급자만 · IPv6 정규식은 길이를 먼저 본다', async () => {
  const t = await import('../src/proxy/rdpTicket.js');
  t._resetRdpTickets();
  const id = t.issueRdpTicket({ username: 'u', password: 'p' }, { owner: 'alice' });
  assert.equal(t.consumeRdpTicket(id, { user: 'mallory' }), null, '다른 사용자는 쓰지 못한다');
  assert.ok(t.consumeRdpTicket(id, { user: 'alice' }), '다른 사람의 시도가 티켓을 지우지 않는다 — 주인은 쓴다');
  const { addressMatcher } = await import('../src/auth/addressMask.js');
  const m = addressMatcher([]);
  const big = `${':'.repeat(16_000)}x`;
  const t0 = performance.now(); m(big); const ms = performance.now() - t0;
  assert.ok(ms < 20, `콜론 16k 입력 ${ms.toFixed(1)}ms(수정 전 약 130ms)`);
  assert.equal(m('fe80::1'), true); assert.equal(m('[2001:db8::1]'), true);
});

test('A-2 — 동작: 현재 코드 없이 재등록 시작 403 · 코드로 시작 → 확정 200 · 시작 없이 확정 403', async () => {
  const A = await import('../src/auth/auth.js');
  const T = await import('../src/auth/totp.js');
  const express = (await import('express')).default;
  const { authRouter } = await import('../src/routes/auth.js');
  assert.equal(A.createUser({ username: 'otpu', role: 'viewer', password: 'Passw0rd!Passw0rd!x' }, { trusted: true }).ok, true);
  const b0 = A.beginTotpEnroll('otpu', '', { trusted: true });
  assert.equal(A.confirmTotpEnroll('otpu', T.generateToken(b0.secret), { trusted: true }).ok, true);
  const u = A.getUser('otpu');
  const tok = A.signToken({ sub: 'otpu', role: 'viewer', src: 'local', tv: u.tokenVersion || 0, sid: 'sid-otpu-1' });
  A.noteIssuedSession({ sub: 'otpu', sid: 'sid-otpu-1', exp: Math.floor(Date.now() / 1000) + 3600 });
  const app = express(); app.use(express.json()); app.use('/api/auth', authRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const post = async (p, body) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/auth${p}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  try {
    const noCode = await post('/totp/begin', {});
    assert.equal(noCode.status, 403, JSON.stringify(noCode.body)); assert.equal(noCode.body.needCurrentOtp, true);
    const conf0 = await post('/totp/confirm', { code: '000000' });
    assert.equal(conf0.status, 403, '시작(현재 코드 확인) 없이 확정 거부');
    // 다음 30초 창 코드(로그인 · 등록 확정이 같은 창 코드를 이미 썼다 — 재사용 방지 카운터)
    const now = Math.floor(Date.now() / 1000 / 30);
    const cur = T.generateToken(u.totpSecret, { counter: now + 1 });
    const ok = await post('/totp/begin', { currentCode: cur });
    assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.ok(ok.body.secret);
    const conf = await post('/totp/confirm', { code: T.generateToken(ok.body.secret) });
    assert.equal(conf.status, 200, JSON.stringify(conf.body));
  } finally { srv.close(); }
});
