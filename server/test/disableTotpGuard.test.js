import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v2.277 확정 버그 회귀 방지 — disableTotp 잠금 가드.
// 배경: OTP 전용 계정은 등록 시 passwordHash 가 삭제된다. 그 상태에서 임시 비밀번호 없이
// OTP 를 해제하면 비번도 OTP 도 없는 '웹 로그인 완전 불가' 계정이 됐고(콘솔 도구로만 복구),
// 수퍼관리자에게도 가드가 없어 '로그인차단 거부' 경계를 우회할 수 있었다.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'disable-totp-test-'));
process.env.CONFIG_DIR = TMP;
delete process.env.OTP_ROLE_ENFORCE;

const auth = await import('../src/auth/auth.js');
const totp = await import('../src/auth/totp.js');

// OTP 전용(레거시 기본 정책의 admin) 계정을 만들어 등록까지 완료 — 등록 시 비번이 폐기된다.
const enroll = (username) => {
  const b = auth.beginTotpEnroll(username);
  assert.ok(b.ok, b.reason);
  const c = auth.confirmTotpEnroll(username, totp.generateToken(b.secret));
  assert.ok(c.ok, c.reason);
  return b.secret;
};

test('수퍼관리자 OTP 해제 거부(로그인차단 거부 경계와 동일)', () => {
  const r = auth.disableTotp(auth.SUPER_USERNAME, {});
  assert.equal(r.ok, false);
  assert.match(r.reason, /수퍼관리자/);
});

test('비밀번호 없는 OTP 전용 계정: 임시 비밀번호 없이 해제 거부, 8자 이상 제공 시 허용+로그인 가능', () => {
  auth.createUser({ username: 'dtg-adm', name: 'dtg adm', role: 'admin', password: 'pw-dtg-12345' });
  enroll('dtg-adm'); // 레거시 기본에서 admin 은 OTP 전용 → 등록 즉시 passwordHash 폐기
  assert.ok(!auth.getUser('dtg-adm').passwordHash, '등록 후 비번이 폐기된 전제');

  // (1) 임시 비밀번호 없이 → 거부(해제되면 로그인 수단 0개).
  const deny = auth.disableTotp('dtg-adm', {});
  assert.equal(deny.ok, false);
  assert.match(deny.reason, /임시 비밀번호/);
  assert.equal(auth.getUser('dtg-adm').totpEnabled, true, '거부 시 OTP 등록 상태 불변');

  // (2) 8자 미만/비문자열 임시 비밀번호 → 거부(setLocalPassword 와 같은 규칙).
  assert.equal(auth.disableTotp('dtg-adm', { password: 'short' }).ok, false);
  assert.equal(auth.disableTotp('dtg-adm', { password: { evil: 1 } }).ok, false);

  // (3) 정상 임시 비밀번호 → 해제 성공 + 그 비밀번호로 부트스트랩 로그인 가능(mustEnrollOtp).
  const ok = auth.disableTotp('dtg-adm', { password: 'temp-pw-123456' });
  assert.ok(ok.ok, ok.reason);
  const who = auth.authenticateLocal('dtg-adm', 'temp-pw-123456');
  assert.ok(who, '임시 비밀번호로 로그인돼야 함(벽돌 아님)');
  assert.equal(who.mustEnrollOtp, true, 'OTP 전용 admin 은 재등록 강제 세션');
});

test('비밀번호가 있는 계정(혼용 등)은 종전처럼 임시 비밀번호 없이 해제 가능', async () => {
  const sec = await import('../src/security/securitySettings.js');
  sec.saveSessionSecurity({ loginPolicy: 'otp_or_password' }); // 혼용 — 등록해도 비번 유지
  auth.createUser({ username: 'dtg-mix', name: 'dtg mix', role: 'viewer', password: 'pw-mix-12345' });
  enroll('dtg-mix');
  assert.ok(auth.getUser('dtg-mix').passwordHash, '혼용 정책은 등록 후에도 비번 유지 전제');
  const r = auth.disableTotp('dtg-mix', {});
  assert.ok(r.ok, r.reason); // 비번이 남아 있어 잠금 위험 없음 → 가드 미발동
  assert.ok(auth.authenticateLocal('dtg-mix', 'pw-mix-12345'), '해제 후 기존 비번 로그인 유지');
});
