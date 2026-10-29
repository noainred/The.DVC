// v2.771 — 6회차 점검 G1(인증) 회귀 고정.
//  R6-F5-1: 새로 만드는 계정(createUser·applyManagedUsers 신규·기본 시드)의 tokenVersion 을 무작위 큰 값에서 시작 —
//           삭제 후 같은 이름 재생성에 옛 토큰이 새 계정으로 부활하지 않게. 기존 계정 값은 그대로(전원 로그아웃 없음).
//  R6-F5-5: 본인 OTP 등록(/auth/totp/begin·confirm) 성공·실패를 감사 로그에 남긴다(시크릿·코드 미기재, ip = clientIp).
//  R6-F5-6: '마지막 관리자' 보호가 로그인 수단(비밀번호·등록된 OTP)이 있는 관리자 계열만 센다 — 로그인 불가 noainred 시드를 세지 않게.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2771a-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
delete process.env.DEFAULT_ADMIN_PASSWORD;

const A = await import('../src/auth/auth.js');
const { newSessionId } = await import('../src/auth/sessions.js');
const totp = await import('../src/auth/totp.js');

const USERS_FILE = path.join(DIR, 'users.json');
const exp = () => Math.floor(Date.now() / 1000) + 3600;
const localToken = (username, tv) => A.signToken({ sub: username, role: 'viewer', name: username, src: 'local', tv, sid: newSessionId() }, { exp: exp() });
const tvOf = (username) => A.getUser(username)?.tokenVersion;
const isFreshTv = (v) => Number.isSafeInteger(v) && v >= 1 && v < 2 ** 31;
/** users.json 을 이 레코드들로 바꾸고 다시 읽는다(콘솔 도구용 reload 경로 — 파일이 있으면 메모리를 비우고 파싱). */
function resetUsers(list) {
  fs.writeFileSync(USERS_FILE, JSON.stringify({ users: list }, null, 2));
  return A.reloadUsersFromDisk();
}

test('R6-F5-6 · R6-F5-1 — 첫 설치 시드: 유일한 실관리자는 자기 강등·로그인 차단·삭제 불가, 시드 레코드는 무작위 tokenVersion', () => {
  A.loadUsers(); // users.json 없음 → admin(임의 비번) + 데모 + noainred 시드
  const seeded = Object.fromEntries(A.listUsers().map((u) => [u.username, u]));
  assert.ok(seeded.admin?.hasPassword && seeded.noainred && !seeded.noainred.hasPassword && !seeded.noainred.totpEnabled, JSON.stringify(seeded));
  for (const name of ['admin', 'noainred', 'thedvcdemp']) assert.ok(isFreshTv(tvOf(name)), `${name} 시드 tokenVersion=${tvOf(name)}`);
  // 재현(lastadmin.mjs) 그대로 — 예전에는 { ok:true } 였고, 남은 관리자 계열은 로그인 불가 noainred 뿐이었다.
  const demote = A.updateUser('admin', { role: 'viewer' }, { actor: 'admin' });
  assert.equal(demote.ok, false, JSON.stringify(demote));
  assert.match(demote.reason, /마지막 관리자/);
  assert.equal(A.clearLoginCredentials('admin', { trusted: true }).ok, false, '로그인 차단도 같은 계수');
  assert.equal(A.deleteUser('admin', { trusted: true }).ok, false, '삭제도 같은 계수');
  assert.equal(A.getUser('admin').role, 'admin');
  assert.ok(A.getUser('admin').passwordHash, '비밀번호 그대로');
  // 로그인 가능한 다른 관리자가 생기면 강등이 풀린다(가드가 과하게 막지 않는다).
  assert.equal(A.createUser({ username: 'admin2', role: 'admin', password: 'Admin2#Pass1234' }, { trusted: true }).ok, true);
  assert.equal(A.updateUser('admin', { role: 'viewer' }, { trusted: true }).ok, true);
  assert.equal(A.updateUser('admin2', { role: 'operator' }, { trusted: true }).ok, false, '이제 admin2 가 마지막 실관리자');
});

test('R6-F5-6 — OTP 만 있는 관리자도 로그인 가능으로 센다 · 데모 계정은 세지 않는다 · 중앙 배포 제거 보호도 같은 계수', () => {
  const secret = totp.generateSecret();
  resetUsers([
    { username: 'noainred', name: 'noainred', role: 'super_admin', superuser: true },                 // 로그인 불가 시드
    { username: 'thedvcdemp', name: 'Demo', role: 'viewer', demo: true, passwordHash: A.hashPassword('Demo#Pass12345') },
    { username: 'otpadm', role: 'admin', totpEnabled: true, totpSecret: secret },                        // OTP 전용 관리자
    { username: 'pwadm', role: 'admin', passwordHash: A.hashPassword('PwAdm#Pass1234') },
    { username: 'pending', role: 'admin', totpEnabled: false, totpPendingSecret: secret },               // 등록 미확정 — 로그인 수단 없음
  ]);
  assert.equal(A.updateUser('pwadm', { role: 'viewer' }, { trusted: true }).ok, true, 'OTP 전용 관리자가 남아 있으면 강등 가능');
  assert.equal(A.clearLoginCredentials('otpadm', { trusted: true }).ok, false, '남은 실관리자(OTP 전용)의 로그인 차단 거부');
  assert.equal(A.deleteUser('otpadm', { trusted: true }).ok, false);
  // 로그인 수단이 없는 관리자 계열(등록 미확정)은 지울 수 있다 — 실관리자가 남아 있으므로.
  assert.equal(A.deleteUser('pending', { trusted: true }).ok, true);
  // 로그인 수단 없는 관리자 계열끼리의 정리는 예전처럼 된다(로그인 가능한 관리자 수를 줄이지 않는다).
  resetUsers([
    { username: 'noainred', name: 'noainred', role: 'super_admin', superuser: true },
    { username: 'thedvcdemp', name: 'Demo', role: 'viewer', demo: true },
    { username: 'sa2', role: 'super_admin' },
  ]);
  assert.equal(A.deleteUser('sa2', { trusted: true }).ok, true, '자격증명 없는 super_admin 정리');
  resetUsers([{ username: 'solo', role: 'admin' }, { username: 'noainred', name: 'noainred', role: 'viewer' }, { username: 'thedvcdemp', role: 'viewer', demo: true }]);
  // noainred 는 로드 시 super_admin 으로 올라가므로 관리자 계열은 solo + noainred(둘 다 로그인 불가) — 정리 가능.
  assert.equal(A.updateUser('solo', { role: 'viewer' }, { trusted: true }).ok, true);
  assert.equal(A.updateUser('noainred', { role: 'viewer' }, { trusted: true }).ok, false, '수퍼관리자 고정(기존 규칙)');

  // 중앙 배포 계정: 배포 목록에서 빠져도 로그인 가능한 유일한 관리자면 제거 보류(예전에는 noainred 를 세어 제거됐다).
  resetUsers([
    { username: 'noainred', name: 'noainred', role: 'super_admin', superuser: true },
    { username: 'thedvcdemp', name: 'Demo', role: 'viewer', demo: true },
    { username: 'cadm', role: 'admin', managedBy: 'central', passwordHash: A.hashPassword('Cadm#Pass12345') },
  ]);
  const r = A.applyManagedUsers([]);
  assert.equal(r.removed, 0, JSON.stringify(r));
  assert.ok(r.skipped.some((s) => s.startsWith('cadm(')), JSON.stringify(r));
  assert.ok(A.getUser('cadm'));
});

test('R6-F5-1 — createUser: 삭제 후 같은 이름 재생성에 옛 토큰이 부활하지 않는다(새 계정 토큰은 정상)', () => {
  resetUsers([
    { username: 'noainred', name: 'noainred', role: 'super_admin', superuser: true },
    { username: 'thedvcdemp', name: 'Demo', role: 'viewer', demo: true },
    { username: 'admin', role: 'admin', passwordHash: A.hashPassword('Admin#Pass12345') },
  ]);
  // 재현(recreate.mjs) 그대로: 새 코드로 만든 계정.
  assert.equal(A.createUser({ username: 'kim', role: 'viewer', password: 'password-1' }, { actor: 'admin' }).ok, true);
  assert.ok(isFreshTv(tvOf('kim')), `tokenVersion=${tvOf('kim')}`);
  const tok = localToken('kim', tvOf('kim'));
  assert.equal(A.resolveTokenUser(tok)?.role, 'viewer');
  assert.equal(A.deleteUser('kim', { actor: 'admin' }).ok, true);
  assert.equal(A.resolveTokenUser(tok), null);
  assert.equal(A.createUser({ username: 'kim', role: 'operator', password: 'other-pass-2' }, { actor: 'admin' }).ok, true);
  assert.equal(A.resolveTokenUser(tok), null, '옛 토큰이 새 operator 계정(mustEnrollOtp)으로 부활하면 안 된다');
  const fresh = A.resolveTokenUser(localToken('kim', tvOf('kim')));
  assert.equal(fresh?.role, 'operator', '새 계정의 자기 토큰은 통과');
  assert.equal(fresh?.mustEnrollOtp, true);
});

test('R6-F5-1 — 업그레이드 전 계정(tokenVersion 없음 = tv 0)은 값을 바꾸지 않고, 지운 뒤 다시 만들면 tv 0 토큰이 죽는다', () => {
  resetUsers([
    { username: 'noainred', name: 'noainred', role: 'super_admin', superuser: true },
    { username: 'thedvcdemp', name: 'Demo', role: 'viewer', demo: true },
    { username: 'admin', role: 'admin', passwordHash: A.hashPassword('Admin#Pass12345') },
    { username: 'legacy', role: 'viewer', passwordHash: A.hashPassword('Legacy#Pass123') },
  ]);
  for (const name of ['noainred', 'thedvcdemp', 'admin', 'legacy']) assert.equal(tvOf(name), undefined, `기존 계정 ${name} 의 tokenVersion 은 그대로(전원 로그아웃 없음)`);
  const old = localToken('legacy', 0);
  assert.equal(A.resolveTokenUser(old)?.username, 'legacy', '기존 세션은 업그레이드 후에도 유지');
  assert.equal(A.deleteUser('legacy', { trusted: true }).ok, true);
  assert.equal(A.createUser({ username: 'legacy', role: 'viewer', password: 'Legacy#Pass456' }, { trusted: true }).ok, true);
  assert.equal(A.resolveTokenUser(old), null, '예전에는 새 계정도 tv 0 이라 옛 토큰이 통과했다');
  // 증가(+1)는 무작위 시작값 위에서 그대로 동작한다.
  const before = tvOf('legacy');
  assert.equal(A.setLocalPassword('legacy', 'Legacy#Pass789', { trusted: true }).ok, true);
  assert.equal(tvOf('legacy'), before + 1);
  // 시드가 '없어서 새로 만드는' 경우만 무작위 값 — noainred 가 파일에 없으면 새 레코드로 시드된다.
  resetUsers([{ username: 'admin', role: 'admin', passwordHash: A.hashPassword('Admin#Pass12345') }]);
  assert.ok(isFreshTv(tvOf('noainred')) && isFreshTv(tvOf('thedvcdemp')), `${tvOf('noainred')} ${tvOf('thedvcdemp')}`);
  assert.equal(tvOf('admin'), undefined);
});

test('R6-F5-1 — applyManagedUsers: 배포에서 제거 → 재배포된 같은 이름 계정에 옛 토큰이 부활하지 않는다', () => {
  resetUsers([
    { username: 'noainred', name: 'noainred', role: 'super_admin', superuser: true },
    { username: 'thedvcdemp', name: 'Demo', role: 'viewer', demo: true },
    { username: 'admin', role: 'admin', passwordHash: A.hashPassword('Admin#Pass12345') },
    { username: 'mgd', role: 'viewer', managedBy: 'central' },  // 업그레이드 전 배포 계정(tv 0)
  ]);
  const old = localToken('mgd', 0);
  assert.equal(A.resolveTokenUser(old)?.username, 'mgd');
  const keep = [{ username: 'mgd', role: 'viewer', passwordHash: A.hashPassword('Mgd#Pass123456') }];
  assert.equal(A.applyManagedUsers(keep).created, 0);
  assert.equal(A.applyManagedUsers([]).removed, 1);
  assert.equal(A.resolveTokenUser(old), null);
  const r = A.applyManagedUsers([{ username: 'mgd', role: 'operator' }]);
  assert.equal(r.created, 1, JSON.stringify(r));
  assert.ok(isFreshTv(tvOf('mgd')));
  assert.equal(A.resolveTokenUser(old), null, '재배포 계정(operator)으로 옛 토큰이 부활하면 안 된다');
  // 같은 해시 재전송은 세션을 끊지 않는다(기존 계약 — tokenVersion 불변).
  const tv = tvOf('mgd');
  A.applyManagedUsers([{ username: 'mgd', role: 'operator' }]);
  assert.equal(tvOf('mgd'), tv);
});

test('R6-F5-5 — 본인 OTP 등록 시작·확정의 성공·실패가 감사 로그에 남고 시크릿·코드는 싣지 않는다', async () => {
  resetUsers([
    { username: 'noainred', name: 'noainred', role: 'super_admin', superuser: true },
    { username: 'thedvcdemp', name: 'Demo', role: 'viewer', demo: true },
    { username: 'admin', role: 'admin', passwordHash: A.hashPassword('Admin#Pass12345') },
  ]);
  assert.equal(A.createUser({ username: 'otpself', role: 'operator', password: 'OtpSelf#Pass12' }, { trusted: true }).ok, true);
  const express = (await import('express')).default;
  const { authRouter } = await import('../src/routes/auth.js');
  const { listAudit } = await import('../src/audit.js');
  const app = express(); app.use(express.json()); app.use('/api/auth', authRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api/auth`;
  const auditOf = (action) => listAudit({ limit: 1000 }).items.filter((e) => e.action === action && e.user === 'otpself');
  try {
    const call = (tok, p, body = {}) => fetch(base + p, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const tok = localToken('otpself', tvOf('otpself'));
    assert.equal(A.resolveTokenUser(tok)?.mustEnrollOtp, true);
    const b = await call(tok, '/totp/begin');
    assert.equal(b.status, 200);
    const { secret } = await b.json();
    assert.ok(secret);
    assert.equal(auditOf('OTP 등록 시작(본인)').length, 1, JSON.stringify(listAudit({ limit: 20 }).items));
    const wrong = String((Number(totp.generateToken(secret)) + 500000) % 1000000).padStart(6, '0');
    const bad = await call(tok, '/totp/confirm', { code: wrong });
    assert.equal(bad.status, 400);
    const fail = auditOf('OTP 등록 확정 실패(본인)');
    assert.equal(fail.length, 1);
    assert.match(fail[0].detail, /일치하지 않습니다/);
    assert.equal(fail[0].ip, '127.0.0.1', 'ip = clientIp(req)');
    const good = totp.generateToken(secret);
    const ok = await call(tok, '/totp/confirm', { code: good });
    assert.equal(ok.status, 200);
    const done = auditOf('OTP 등록 확정(본인)');
    assert.equal(done.length, 1);
    assert.equal(done[0].target, 'otpself');
    const raw = fs.readFileSync(path.join(DIR, 'audit.ndjson'), 'utf8');
    assert.ok(!raw.includes(secret), '감사 로그에 OTP 시크릿이 없어야 한다');
    assert.ok(!raw.includes(`otpauth`), 'otpauth URL 미기재');
    assert.ok(!new RegExp(`\\b${good}\\b`).test(raw) && !new RegExp(`\\b${wrong}\\b`).test(raw), '입력 코드 미기재');
    // AD 토큰(로컬 표지 없음)의 시도도 거부 사실이 남는다.
    const ad = A.signToken({ sub: 'adonly', role: 'viewer', name: 'AD' }, { exp: exp() });
    assert.ok(A.resolveTokenUser(ad), '구버전 무표지 토큰(AD 정책 변경 이력 없음)은 유효 — 로컬 표지 없음');
    assert.equal((await call(ad, '/totp/begin')).status, 400);
    assert.equal(listAudit({ limit: 1000 }).items.filter((e) => e.user === 'adonly' && e.action === 'OTP 등록 시작 거부(본인)').length, 1);
  } finally { srv.close(); }
});
