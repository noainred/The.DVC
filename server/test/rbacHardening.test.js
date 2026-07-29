import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 보안 하드닝 회귀 테스트(감사 C2/H13/M1/M5) — CONFIG_DIR을 임시 디렉터리로 돌려
// 리포지토리의 server/config에 users.json/초기비번 파일이 생기지 않게 한다.
process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-auth-test-'));
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-pw-123';

let auth; let totp;
before(async () => {
  auth = await import('../src/auth/auth.js');
  totp = await import('../src/auth/totp.js');
});

const fakeRes = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
};

test('requireRole: viewer 거부·operator/admin 허용(admin,operator 라우트)', () => {
  const mw = auth.requireRole('admin', 'operator');
  for (const [role, allowed] of [['viewer', false], ['operator', true], ['admin', true]]) {
    const res = fakeRes(); let passed = false;
    mw({ user: { role } }, res, () => { passed = true; });
    assert.equal(passed, allowed, `role=${role}`);
    if (!allowed) assert.equal(res.statusCode, 403);
  }
});

test('M5: 비밀번호 변경(tokenVersion 인상) 시 기존 로컬 토큰 즉시 폐기', () => {
  assert.equal(auth.createUser({ username: 'revoke.test', role: 'viewer', password: 'password-1' }).ok, true);
  const u = auth.getUser('revoke.test');
  const token = auth.signToken({ sub: 'revoke.test', role: 'viewer', name: 'r', src: 'local', tv: u.tokenVersion || 0 });
  const call = (tk) => {
    const req = { headers: { authorization: `Bearer ${tk}` } };
    const res = fakeRes(); let passed = false;
    auth.authMiddleware(req, res, () => { passed = true; });
    return { passed, status: res.statusCode, req };
  };
  assert.equal(call(token).passed, true, '변경 전에는 유효');
  assert.equal(auth.setLocalPassword('revoke.test', 'password-2').ok, true);
  const after = call(token);
  assert.equal(after.passed, false, '비번 변경 후 기존 토큰은 거부돼야 함');
  assert.equal(after.status, 401);
});

test('M5: 역할 강등 즉시 반영 + 삭제 계정 토큰 거부', () => {
  assert.equal(auth.createUser({ username: 'role.test', role: 'operator', password: 'password-1' }).ok, true);
  const u = auth.getUser('role.test');
  const token = auth.signToken({ sub: 'role.test', role: 'operator', name: 'r', src: 'local', tv: u.tokenVersion || 0 });
  // 역할 변경은 tokenVersion 인상으로 기존 토큰 자체를 폐기한다(더 강한 보증).
  assert.equal(auth.updateUser('role.test', { role: 'viewer' }).ok, true);
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = fakeRes(); let passed = false;
  auth.authMiddleware(req, res, () => { passed = true; });
  assert.equal(passed, false);
  // 삭제 계정: 새 토큰을 발급받아도(구버전 클라이언트 가정) 사용자 없음 → 401.
  const u2 = auth.getUser('role.test');
  const tk2 = auth.signToken({ sub: 'role.test', role: 'viewer', name: 'r', src: 'local', tv: u2.tokenVersion || 0 });
  assert.equal(auth.deleteUser('role.test').ok, true);
  const res2 = fakeRes(); let passed2 = false;
  auth.authMiddleware({ headers: { authorization: `Bearer ${tk2}` } }, res2, () => { passed2 = true; });
  assert.equal(passed2, false);
  assert.equal(res2.statusCode, 401);
});

test('레거시 토큰(src 없음)은 통과(하위호환) — 만료로 자연 회전', () => {
  const token = auth.signToken({ sub: 'ad.user', role: 'viewer', name: 'ad' });
  const res = fakeRes(); let passed = false;
  auth.authMiddleware({ headers: { authorization: `Bearer ${token}` } }, res, () => { passed = true; });
  assert.equal(passed, true);
});

test('M5(WS 게이트웨이): resolveTokenUser가 폐기 토큰 거부 + 최신 역할 반환', () => {
  // SSH/RDP WebSocket 게이트웨이 우회 회귀 방지 — payload.role 신뢰가 아니라 사용자 레코드 기준.
  assert.equal(auth.createUser({ username: 'ws.test', role: 'operator', password: 'password-1' }).ok, true);
  const u = auth.getUser('ws.test');
  const token = auth.signToken({ sub: 'ws.test', role: 'operator', name: 'w', src: 'local', tv: u.tokenVersion || 0 });
  assert.equal(auth.resolveTokenUser(token)?.role, 'operator');
  // 강등: tokenVersion 인상으로 구토큰 자체가 무효(터널 개통 불가).
  assert.equal(auth.updateUser('ws.test', { role: 'viewer' }).ok, true);
  assert.equal(auth.resolveTokenUser(token), null, '강등 후 구토큰은 WS 경로에서도 거부');
  // 새 토큰은 최신 역할(viewer)로 해석 — admin/operator 게이트에서 차단됨.
  const u2 = auth.getUser('ws.test');
  const tk2 = auth.signToken({ sub: 'ws.test', role: 'operator', name: 'w', src: 'local', tv: u2.tokenVersion || 0 });
  assert.equal(auth.resolveTokenUser(tk2)?.role, 'viewer', '역할은 토큰이 아니라 사용자 레코드 기준');
});

test('M1/M2: 민감작업 재인증(verifyUserOtp)도 같은 OTP 코드 재사용(replay) 거부', () => {
  assert.equal(auth.createUser({ username: 'otp.test', role: 'admin', password: 'password-1' }).ok, true);
  const u = auth.getUser('otp.test');
  u.totpEnabled = true;
  u.totpSecret = totp.generateSecret();
  const code = totp.generateToken(u.totpSecret);
  assert.equal(auth.verifyUserOtp('otp.test', code).ok, true, '첫 사용은 성공');
  const replay = auth.verifyUserOtp('otp.test', code);
  assert.equal(replay.ok, false, '동일 코드 재사용은 거부');
  assert.match(replay.reason, /이미 사용|일치하지/);
});
