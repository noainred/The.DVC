import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// auth.js / securitySettings.js 는 import 시점의 CONFIG_DIR 을 쓴다 → 격리 임시 디렉터리 지정 후 로드.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'login-policy-users-test-'));
process.env.CONFIG_DIR = TMP;
delete process.env.OTP_ROLE_ENFORCE;
delete process.env.LOGIN_POLICY_USERS;

const auth = await import('../src/auth/auth.js');
const sec = await import('../src/security/securitySettings.js');
const totp = await import('../src/auth/totp.js');

const POLICY_FILE = path.join(TMP, 'login-policy-users.txt');
const setGlobal = (p) => sec.saveSessionSecurity({ loginPolicy: p });
const setUserFile = (content) => { fs.writeFileSync(POLICY_FILE, content); sec.invalidateLoginPolicyCache(); };
const enroll = (username) => {
  const b = auth.beginTotpEnroll(username);
  assert.ok(b.ok, b.reason);
  const c = auth.confirmTotpEnroll(username, totp.generateToken(b.secret));
  assert.ok(c.ok, c.reason);
  return b.secret;
};

test('파일 재정의 파싱 — 별칭·구분자·주석·형식오류 무시', () => {
  setUserFile([
    '# 사용자별 로그인 방식',
    'u-pass=password',
    'u-pw = pw          # 별칭',
    'u-otp: otp',
    'u-both both',
    'u-formal=otp_or_password',
    'u-plus=otp+password',
    '잘못된한글이름=otp',      // 사용자명 형식 위반 → 무시
    'u-bad=nosuchpolicy',      // 알 수 없는 방식 → 무시
    'brokenline',              // 구분자 없음 → 무시
  ].join('\n'));
  assert.equal(sec.userLoginPolicy('u-pass'), 'password_only');
  assert.equal(sec.userLoginPolicy('u-pw'), 'password_only');
  assert.equal(sec.userLoginPolicy('u-otp'), 'otp_only');
  assert.equal(sec.userLoginPolicy('u-both'), 'otp_or_password');
  assert.equal(sec.userLoginPolicy('u-formal'), 'otp_or_password');
  assert.equal(sec.userLoginPolicy('u-plus'), 'otp_or_password');
  assert.equal(sec.userLoginPolicy('잘못된한글이름'), null);
  assert.equal(sec.userLoginPolicy('u-bad'), null);
  assert.equal(sec.userLoginPolicy('없는사용자'), null);
});

test('ENV(LOGIN_POLICY_USERS) 파싱 + 파일 우선', () => {
  process.env.LOGIN_POLICY_USERS = 'e-one=password, e-two = otp';
  setUserFile('e-one=otp\n'); // 같은 사용자 → 파일이 이긴다
  assert.equal(sec.userLoginPolicy('e-one'), 'otp_only', '파일이 env 를 덮어써야 함');
  assert.equal(sec.userLoginPolicy('e-two'), 'otp_only');
  delete process.env.LOGIN_POLICY_USERS;
  sec.invalidateLoginPolicyCache();
  assert.equal(sec.userLoginPolicy('e-two'), null, 'env 제거 후 재정의 소멸');
});

test('재정의=password 가 레거시 고권한 OTP 강제를 이긴다(admin 비번 로그인·등록강제 없음)', () => {
  // 전역 미설정 → 레거시(고권한 OTP 전용). saveSessionSecurity 는 null 을 무시하므로 파일을 직접 초기화.
  fs.writeFileSync(path.join(TMP, 'security-session.json'), JSON.stringify({ idleLogoutEnabled: true, idleLogoutMin: 30, settingsOwners: ['noainred'] }));
  sec.invalidateLoginPolicyCache();
  auth.createUser({ username: 'fadm', name: 'f adm', role: 'admin', password: 'pw-fadm-123' });
  auth.createUser({ username: 'fadm2', name: 'f adm2', role: 'admin', password: 'pw-fadm2-123' });
  setUserFile('fadm=password\n');
  // 재정의된 admin — 강제 해제.
  assert.equal(auth.isOtpOnlyUser('fadm', 'admin'), false);
  const a = auth.authenticateLocal('fadm', 'pw-fadm-123');
  assert.ok(a); assert.equal(a.mustEnrollOtp, false);
  // 재정의 없는 admin — 레거시 강제 유지.
  assert.equal(auth.isOtpOnlyUser('fadm2', 'admin'), true);
  const b = auth.authenticateLocal('fadm2', 'pw-fadm2-123');
  assert.ok(b); assert.equal(b.mustEnrollOtp, true);
});

test('전역 otp_only 를 재정의=both 가 이긴다(그 사용자만 비번 허용)', () => {
  setGlobal('otp_only');
  auth.createUser({ username: 'fboth', name: 'f both', role: 'viewer', password: 'pw-fboth-123' });
  auth.createUser({ username: 'fplain', name: 'f plain', role: 'viewer', password: 'pw-fplain-123' });
  setUserFile('fboth=both\n');
  const a = auth.authenticateLocal('fboth', 'pw-fboth-123');
  assert.ok(a); assert.equal(a.mustEnrollOtp, false);
  const b = auth.authenticateLocal('fplain', 'pw-fplain-123'); // 재정의 없음 → 전역 otp_only
  assert.ok(b); assert.equal(b.mustEnrollOtp, true);
});

test('재정의=otp: 전역이 혼용이어도 그 사용자만 강제 등록 + 등록 시 비번 폐기', () => {
  setGlobal('otp_or_password');
  auth.createUser({ username: 'fotp', name: 'f otp', role: 'viewer', password: 'pw-fotp-123' });
  setUserFile('fotp=otp\n');
  const a = auth.authenticateLocal('fotp', 'pw-fotp-123'); // 부트스트랩 비번
  assert.ok(a); assert.equal(a.mustEnrollOtp, true);
  const secret = enroll('fotp');
  const u = auth.loadUsers().find((x) => x.username === 'fotp');
  assert.ok(!u.passwordHash, 'otp 재정의 사용자는 등록 즉시 비밀번호 폐기');
  assert.equal(auth.authenticateLocal('fotp', 'pw-fotp-123'), null);
  assert.ok(auth.authenticateLocal('fotp', totp.generateToken(secret)));
});

test('재정의=both: 등록 후에도 비번 유지 → 비번·OTP 둘 다 로그인', () => {
  setGlobal('otp_only'); // 전역은 가장 엄격하게 두고 재정의가 이기는지 본다
  auth.createUser({ username: 'fkeep', name: 'f keep', role: 'viewer', password: 'pw-fkeep-123' });
  setUserFile('fkeep=both\n');
  const secret = enroll('fkeep');
  const u = auth.loadUsers().find((x) => x.username === 'fkeep');
  assert.ok(u.passwordHash, 'both 재정의는 등록 후에도 비밀번호 유지');
  assert.ok(auth.authenticateLocal('fkeep', 'pw-fkeep-123'));
  assert.ok(auth.authenticateLocal('fkeep', totp.generateToken(secret)));
});

test('재정의=password: 비번 보유자는 OTP 거부, 비번 없는 계정은 OTP 폴백(잠금 방지)', () => {
  setGlobal('otp_or_password');
  // (1) 비번+OTP 둘 다 보유 — password 재정의면 비번만.
  auth.createUser({ username: 'fpw', name: 'f pw', role: 'viewer', password: 'pw-fpw-123' });
  const s1 = enroll('fpw'); // 혼용에서 등록 → 비번 유지
  setUserFile('fpw=password\nfnopw=password\n');
  assert.ok(auth.authenticateLocal('fpw', 'pw-fpw-123'));
  assert.equal(auth.authenticateLocal('fpw', totp.generateToken(s1)), null, 'password 재정의는 OTP 거부');
  // (2) 비번 없는(OTP 전용으로 폐기된) 계정 — password 재정의여도 OTP 폴백으로 잠기지 않는다.
  setUserFile('fnopw=otp\n');
  auth.createUser({ username: 'fnopw', name: 'f nopw', role: 'viewer', password: 'pw-fnopw-123' });
  const s2 = enroll('fnopw'); // otp 재정의에서 등록 → 비번 폐기
  assert.ok(!auth.loadUsers().find((x) => x.username === 'fnopw').passwordHash);
  setUserFile('fnopw=password\n');
  assert.ok(auth.authenticateLocal('fnopw', totp.generateToken(s2)), 'OTP 폴백으로 로그인(잠금 방지)');
});

test('resolveTokenUser 의 mustEnrollOtp 도 사용자별 재정의를 즉시 반영', () => {
  fs.writeFileSync(path.join(TMP, 'security-session.json'), JSON.stringify({ idleLogoutEnabled: true, idleLogoutMin: 30, settingsOwners: ['noainred'] })); // 레거시
  sec.invalidateLoginPolicyCache();
  auth.createUser({ username: 'ftok', name: 'f tok', role: 'admin', password: 'pw-ftok-123' });
  setUserFile('ftok=password\n');
  const rec = auth.getUser('ftok');
  const token = auth.signToken({ sub: 'ftok', role: 'admin', name: 'f tok', src: 'local', tv: rec.tokenVersion || 0 });
  assert.equal(auth.resolveTokenUser(token).mustEnrollOtp, false, '재정의 중에는 등록 강제 없음');
  setUserFile('# 재정의 제거\n'); // 파일에서 빼면 레거시 강제로 복귀
  assert.equal(auth.resolveTokenUser(token).mustEnrollOtp, true, '재정의 제거 즉시 레거시 강제 복귀');
});
