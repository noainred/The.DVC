import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as totp from '../src/auth/totp.js';

// auth.js 는 import 시점의 CONFIG_DIR/DEFAULT_ADMIN_PASSWORD 를 사용 → 격리 후 로드.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'otp-policy-test-'));
process.env.CONFIG_DIR = TMP;
process.env.DEFAULT_ADMIN_PASSWORD = 'bootstrap-pass-1';

const auth = await import('../src/auth/auth.js?otp-policy');

test('부트스트랩: OTP 미등록 admin 은 비밀번호로 로그인되지만 mustEnrollOtp 세션', () => {
  const who = auth.authenticateLocal('admin', 'bootstrap-pass-1');
  assert.ok(who, 'OTP 등록 전에는 비번 로그인이 되어야 함(최초 설치 경로)');
  assert.equal(who.role, 'admin');
  assert.equal(who.mustEnrollOtp, true, '등록 전용 세션으로 표시되어야 함');
  // 틀린 비번은 그대로 실패.
  assert.equal(auth.authenticateLocal('admin', 'wrong-password'), null);
});

test('operator 도 동일 — 비번 로그인 시 mustEnrollOtp', () => {
  assert.ok(auth.createUser({ username: 'op1', role: 'operator', password: 'operator-pass-1' }).ok);
  const r = auth.authenticateLocal('op1', 'operator-pass-1');
  assert.ok(r && r.mustEnrollOtp, 'operator 도 등록 전용 세션');
});

test('viewer·데모는 강제 등록 대상이 아님(mustEnrollOtp 없음)', () => {
  assert.ok(auth.setLocalPassword(auth.DEMO_USERNAME, 'demo-pass-1234').ok);
  const who = auth.authenticateLocal(auth.DEMO_USERNAME, 'demo-pass-1234');
  assert.ok(who && !who.mustEnrollOtp, '데모(viewer)는 비번 로그인 그대로');
  assert.equal(who.role, 'viewer');
});

test('requireEnrolled: 등록 전용 세션은 API 차단, 등록 완료 세션은 통과', () => {
  const calls = [];
  const res = { status(c) { calls.push(c); return this; }, json(b) { calls.push(b); return this; } };
  let nexted = false;
  auth.requireEnrolled({ user: { mustEnrollOtp: true } }, res, () => { nexted = true; });
  assert.equal(nexted, false, '등록 전에는 next() 로 통과하면 안 됨');
  assert.equal(calls[0], 403);
  assert.equal(calls[1].error, 'otp_enrollment_required');

  nexted = false;
  auth.requireEnrolled({ user: { mustEnrollOtp: false } }, res, () => { nexted = true; });
  assert.equal(nexted, true);
});

test('OTP 등록 확정 → 비밀번호 삭제 + 이후 비번 로그인 불가, 코드 로그인 성공', () => {
  const begun = auth.beginTotpEnroll('op1');
  assert.ok(begun.ok, begun.reason);
  const code = totp.generateToken(begun.secret);
  const done = auth.confirmTotpEnroll('op1', code);
  assert.ok(done.ok, done.reason);

  // 비밀번호 해시가 실제로 지워졌는지(파일 기준으로도) 확인.
  const saved = JSON.parse(fs.readFileSync(path.join(TMP, 'users.json'), 'utf8'));
  const op = saved.users.find((u) => u.username === 'op1');
  assert.ok(!op.passwordHash, '등록 확정 시 비밀번호가 삭제되어야 함');
  assert.equal(op.totpEnabled, true);

  // 예전 비밀번호로는 더 이상 로그인 불가(해시가 없으므로 실패).
  assert.equal(auth.authenticateLocal('op1', 'operator-pass-1'), null);
  // 새 OTP 코드로는 로그인되고, 더 이상 등록 강제 대상이 아님.
  const who = auth.authenticateLocal('op1', totp.generateToken(op.totpSecret));
  assert.ok(who && !who.mustEnrollOtp, 'OTP 로그인 성공 + 등록 강제 해제');
});

test('setupState: OTP admin 이 없으면 비번 파일 경로 노출, 등록되면 감춤', () => {
  const file = path.join(TMP, 'initial-admin-password.txt');
  fs.writeFileSync(file, 'x\n');
  const before = auth.setupState();
  assert.equal(before.setupPending, true);
  assert.equal(before.initialPasswordFile, file);

  // admin 이 OTP 를 등록하면 setupPending 해제 + 비번 파일 자동 삭제.
  const b = auth.beginTotpEnroll('admin');
  assert.ok(auth.confirmTotpEnroll('admin', totp.generateToken(b.secret)).ok);
  const after = auth.setupState();
  assert.equal(after.setupPending, false);
  assert.equal(after.initialPasswordFile, null);
  assert.equal(fs.existsSync(file), false, '등록 완료 시 최초 비밀번호 파일이 삭제되어야 함');
});

test('isOtpOnlyRole: admin·operator 만 대상, viewer 는 제외', () => {
  assert.equal(auth.isOtpOnlyRole('admin'), true);
  assert.equal(auth.isOtpOnlyRole('operator'), true);
  assert.equal(auth.isOtpOnlyRole('viewer'), false);
});
