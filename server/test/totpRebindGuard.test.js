import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 확정 버그 회귀 방지(2026-08-30) — OTP '대리 등록'을 통한 권한 상승.
//
// 배경: beginTotpEnroll 은 QR 발급을 위해 평문 시크릿을 반환한다. adminOnly 만 걸린 관리자
// 라우트에서 이를 호출하면, 일반 admin 이 수퍼관리자/설정소유자의 OTP 시크릿을 손에 넣고
// confirmTotpEnroll 로 활성 시크릿을 교체할 수 있었다. 대상이 OTP 전용 계정이면 confirm 이
// passwordHash 까지 지우므로 기존 소유자는 로그인 수단을 잃고, 호출자만 그 계정으로 로그인할 수
// 있게 된다(= 계정 탈취 → admin→설정소유자 권한 상승). disableTotp 는 u.superuser 를 이미
// 막고 있었는데 '등록' 경로만 열려 있어 그 보호가 우회됐다.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'totp-rebind-test-'));
process.env.CONFIG_DIR = TMP;
delete process.env.OTP_ROLE_ENFORCE;

const auth = await import('../src/auth/auth.js');
const totp = await import('../src/auth/totp.js');
const sec = await import('../src/security/securitySettings.js');

test('수퍼관리자 OTP: 다른 admin 의 대리 등록은 begin·confirm 모두 거부', () => {
  auth.createUser({ username: 'rb-admin', name: 'rb admin', role: 'admin', password: 'pw-rb-123456' });

  const b = auth.beginTotpEnroll(auth.SUPER_USERNAME, '', { actor: 'rb-admin' });
  assert.equal(b.ok, false, '대리 등록 시작이 거부돼야 함');
  assert.match(b.reason, /본인만/);
  assert.equal(b.secret, undefined, '거부 시 평문 시크릿이 절대 반환되지 않아야 함');

  // confirm 도 같은 경계를 다시 검사해야 한다 — begin 만 막으면 이전에 남은 pending
  // 시크릿으로 confirm 만 호출해 우회할 수 있다.
  const self = auth.beginTotpEnroll(auth.SUPER_USERNAME, '', { actor: auth.SUPER_USERNAME });
  assert.ok(self.ok, self.reason); // 본인 등록으로 pending 을 만들어 둔 상태
  const hijack = auth.confirmTotpEnroll(auth.SUPER_USERNAME, totp.generateToken(self.secret), { actor: 'rb-admin' });
  assert.equal(hijack.ok, false, 'pending 이 있어도 타인 confirm 은 거부');
  assert.match(hijack.reason, /본인만/);
});

test('수퍼관리자 본인은 재등록 가능(폰 교체 경로가 막히면 안 됨)', () => {
  const b = auth.beginTotpEnroll(auth.SUPER_USERNAME, '', { actor: auth.SUPER_USERNAME });
  assert.ok(b.ok, b.reason);
  assert.ok(b.secret, '본인 등록은 시크릿을 받아야 함');
  const c = auth.confirmTotpEnroll(auth.SUPER_USERNAME, totp.generateToken(b.secret), { actor: auth.SUPER_USERNAME });
  assert.ok(c.ok, c.reason);
  assert.equal(auth.getUser(auth.SUPER_USERNAME).totpEnabled, true);
});

test('설정소유자 계정도 대리 등록 거부(설정 소유 경계 = admin 보다 상위)', () => {
  auth.createUser({ username: 'rb-owner', name: 'rb owner', role: 'admin', password: 'pw-own-123456' });
  sec.saveSessionSecurity({ settingsOwners: [auth.SUPER_USERNAME, 'rb-owner'] });

  const b = auth.beginTotpEnroll('rb-owner', '', { actor: 'rb-admin' });
  assert.equal(b.ok, false);
  assert.match(b.reason, /본인만/);
  assert.equal(b.secret, undefined);

  // 본인은 가능.
  assert.ok(auth.beginTotpEnroll('rb-owner', '', { actor: 'rb-owner' }).ok);
});

test('일반 계정의 대리 등록은 계속 허용(OTP 전용 계정은 자력 등록이 불가하므로 설계된 기능)', () => {
  auth.createUser({ username: 'rb-plain', name: 'rb plain', role: 'viewer', password: 'pw-pln-123456' });
  const b = auth.beginTotpEnroll('rb-plain', '', { actor: 'rb-admin' });
  assert.ok(b.ok, b.reason);
  assert.ok(b.secret, '일반 계정은 관리자가 QR 을 대신 발급할 수 있어야 함');
  const c = auth.confirmTotpEnroll('rb-plain', totp.generateToken(b.secret), { actor: 'rb-admin' });
  assert.ok(c.ok, c.reason);
});

test('actor 미지정(콘솔 복구 도구 tools/otp-enroll.js)은 신뢰 경로로 통과', () => {
  // 수퍼관리자 폰 분실 시 유일한 복구 수단이므로 이 경로가 막히면 안 된다.
  const b = auth.beginTotpEnroll(auth.SUPER_USERNAME, '');
  assert.ok(b.ok, b.reason);
  assert.ok(b.secret);
  const c = auth.confirmTotpEnroll(auth.SUPER_USERNAME, totp.generateToken(b.secret));
  assert.ok(c.ok, c.reason);
});
