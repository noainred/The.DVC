import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// auth.js / securitySettings.js 는 import 시점의 CONFIG_DIR 을 쓴다 → 격리 임시 디렉터리 지정 후 로드.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'login-policy-test-'));
process.env.CONFIG_DIR = TMP;
// 긴급 해제 env 가 켜져 있으면 정책 테스트가 무의미 → 명시적으로 강제 활성 상태로 고정.
delete process.env.OTP_ROLE_ENFORCE;

const auth = await import('../src/auth/auth.js');
const sec = await import('../src/security/securitySettings.js');
const totp = await import('../src/auth/totp.js');

// 전역 로그인 정책을 세팅(저장 경로가 effectiveLoginPolicy 캐시를 즉시 무효화한다).
const setPolicy = (p) => sec.saveSessionSecurity({ loginPolicy: p });
const enroll = (username) => {
  const b = auth.beginTotpEnroll(username);
  assert.ok(b.ok, b.reason);
  const code = totp.generateToken(b.secret);
  const c = auth.confirmTotpEnroll(username, code);
  assert.ok(c.ok, c.reason);
  return b.secret;
};

// 테스트 계정 — 비밀번호 보유(OTP 미등록).
auth.createUser({ username: 'poladm', name: 'pol adm', role: 'admin', password: 'pw-adm-123' });
auth.createUser({ username: 'polop', name: 'pol op', role: 'operator', password: 'pw-op-123' });
auth.createUser({ username: 'polview', name: 'pol view', role: 'viewer', password: 'pw-vw-123' });

test('기본(미설정) 정책 = 레거시: 고권한만 OTP 전용 강제, viewer 는 아님', () => {
  // security-session.json 이 아직 없음 → loginPolicy null → 레거시.
  assert.equal(auth.isOtpOnlyRole('admin'), true);
  assert.equal(auth.isOtpOnlyRole('operator'), true);
  assert.equal(auth.isOtpOnlyRole('viewer'), false);
  // 고권한(비번, OTP 미등록)은 부트스트랩 비번 로그인은 되지만 mustEnrollOtp 로 등록 전용.
  const a = auth.authenticateLocal('poladm', 'pw-adm-123');
  assert.ok(a); assert.equal(a.mustEnrollOtp, true);
  // viewer 는 강제 대상 아님 → 비번 로그인, 등록 강제 없음.
  const v = auth.authenticateLocal('polview', 'pw-vw-123');
  assert.ok(v); assert.equal(v.mustEnrollOtp, false);
});

test("'otp_only' 정책: 전 계정 OTP 전용 강제(viewer 도 등록 강제)", () => {
  setPolicy('otp_only');
  assert.equal(auth.isOtpOnlyRole('viewer'), true);
  assert.equal(auth.isOtpOnlyRole('admin'), true);
  const v = auth.authenticateLocal('polview', 'pw-vw-123'); // 부트스트랩 비번
  assert.ok(v); assert.equal(v.mustEnrollOtp, true);
});

test("'otp_or_password'(혼용): 고권한도 강제 해제 · 비번 로그인 허용", () => {
  setPolicy('otp_or_password');
  assert.equal(auth.isOtpOnlyRole('admin'), false);
  assert.equal(auth.isOtpOnlyRole('operator'), false);
  const a = auth.authenticateLocal('poladm', 'pw-adm-123');
  assert.ok(a); assert.equal(a.mustEnrollOtp, false);
  const o = auth.authenticateLocal('polop', 'pw-op-123');
  assert.ok(o); assert.equal(o.mustEnrollOtp, false);
});

test("'password_only': 고권한 강제 해제 · 비번 로그인 허용", () => {
  setPolicy('password_only');
  assert.equal(auth.isOtpOnlyRole('admin'), false);
  const a = auth.authenticateLocal('poladm', 'pw-adm-123');
  assert.ok(a); assert.equal(a.mustEnrollOtp, false);
});

test('혼용 정책에서 OTP 등록: 비밀번호 유지 → 비번·OTP 둘 다 로그인', () => {
  setPolicy('otp_or_password');
  auth.createUser({ username: 'polenr', name: 'pol enr', role: 'viewer', password: 'pw-enr-123' });
  const secret = enroll('polenr');
  const u = auth.loadUsers().find((x) => x.username === 'polenr');
  assert.equal(u.totpEnabled, true);
  assert.ok(u.passwordHash, '혼용 정책에서는 등록 후에도 비밀번호가 유지되어야 함');
  // 비번으로 로그인 가능.
  assert.ok(auth.authenticateLocal('polenr', 'pw-enr-123'));
  // OTP 로도 로그인 가능(둘 중 하나 허용).
  assert.ok(auth.authenticateLocal('polenr', totp.generateToken(secret)));
});

test("'otp_only' 정책에서 OTP 등록: 비밀번호 폐기 → 비번 로그인 소멸", () => {
  setPolicy('otp_only');
  auth.createUser({ username: 'polenr2', name: 'pol enr2', role: 'viewer', password: 'pw-enr2-123' });
  const secret = enroll('polenr2');
  const u = auth.loadUsers().find((x) => x.username === 'polenr2');
  assert.equal(u.totpEnabled, true);
  assert.ok(!u.passwordHash, 'OTP 전용 정책에서는 등록 즉시 비밀번호가 삭제되어야 함');
  assert.equal(auth.authenticateLocal('polenr2', 'pw-enr2-123'), null); // 비번 거부
  assert.ok(auth.authenticateLocal('polenr2', totp.generateToken(secret))); // OTP 만
});

test("'password_only': 비번 보유 계정은 OTP 거부(전용) · 비번 없는 계정은 OTP 폴백(잠금 방지)", () => {
  // (1) 비번+OTP 둘 다 있는 계정 — password_only 에서는 비번만 통과, OTP 거부.
  setPolicy('otp_or_password');
  auth.createUser({ username: 'polboth', name: 'pol both', role: 'viewer', password: 'pw-both-123' });
  const s1 = enroll('polboth'); // 혼용에서 등록 → 비번 유지
  setPolicy('password_only');
  assert.ok(auth.authenticateLocal('polboth', 'pw-both-123'), '비번은 통과');
  assert.equal(auth.authenticateLocal('polboth', totp.generateToken(s1)), null, 'OTP 는 거부(비밀번호 전용)');

  // (2) 비번 없는(레거시 OTP 전용) 계정 — password_only 로 바뀌어도 OTP 로 로그인돼 잠기지 않음.
  setPolicy('otp_only');
  auth.createUser({ username: 'polonly', name: 'pol only', role: 'viewer', password: 'pw-only-123' });
  const s2 = enroll('polonly'); // otp_only 에서 등록 → 비번 폐기
  assert.ok(!auth.loadUsers().find((x) => x.username === 'polonly').passwordHash);
  setPolicy('password_only');
  assert.ok(auth.authenticateLocal('polonly', totp.generateToken(s2)), 'OTP 폴백으로 로그인 가능(잠금 방지)');
});
