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

test('admin 은 OTP 미등록 상태에서도 비밀번호 로그인 불가(유예 없음 — v2.205)', () => {
  // OTP 를 등록한 admin 이 하나도 없는 초기 상태에서도 예외 없이 차단된다.
  const r = auth.authenticateLocal('admin', 'bootstrap-pass-1');
  assert.ok(r && r.policyBlocked, 'admin 비번 로그인은 무조건 차단되어야 함');
  // 첫 관리자는 콘솔 도구(server/src/tools/otp-enroll.js)로 등록한다.
});

test('operator 도 비밀번호 로그인 차단(policyBlocked)', () => {
  assert.ok(auth.createUser({ username: 'op1', role: 'operator', password: 'operator-pass-1' }).ok);
  const r = auth.authenticateLocal('op1', 'operator-pass-1');
  assert.ok(r && r.policyBlocked, 'operator 비번 로그인은 정책 차단되어야 함');
});

test('고권한 계정은 비번이 틀려도 동일하게 차단 — 비밀번호 오라클 없음', () => {
  // 맞는 비번/틀린 비번 모두 policyBlocked 로 동일 응답이어야 유효성 탐지가 불가능하다.
  const ok = auth.authenticateLocal('op1', 'operator-pass-1');
  const bad = auth.authenticateLocal('op1', 'definitely-wrong');
  assert.ok(ok && ok.policyBlocked);
  assert.ok(bad && bad.policyBlocked);
  assert.equal(ok.reason, bad.reason);
});

test('OTP 등록 계정은 6자리 코드로 로그인 성공', () => {
  const u = auth.getUser('admin');
  u.totpEnabled = true;
  u.totpSecret = totp.generateSecret();
  const code = totp.generateToken(u.totpSecret);
  const who = auth.authenticateLocal('admin', code);
  assert.ok(who && !who.policyBlocked && who.role === 'admin', 'OTP 코드 로그인은 성공해야 함');
  // OTP 등록 후에도 비밀번호로는 여전히 불가(해시가 남아 있어도).
  const u2 = auth.getUser('op1');
  assert.ok(u2.passwordHash, 'operator 는 비번 해시가 남아 있는 상태');
  assert.ok(auth.authenticateLocal('op1', 'operator-pass-1').policyBlocked);
});

test('isOtpOnlyRole: admin·operator 만 대상, viewer 는 제외', () => {
  assert.equal(auth.isOtpOnlyRole('admin'), true);
  assert.equal(auth.isOtpOnlyRole('operator'), true);
  assert.equal(auth.isOtpOnlyRole('viewer'), false);
});

test('viewer(데모 포함)는 비밀번호 로그인 계속 허용', () => {
  assert.ok(auth.setLocalPassword(auth.DEMO_USERNAME, 'demo-pass-1234').ok);
  const who = auth.authenticateLocal(auth.DEMO_USERNAME, 'demo-pass-1234');
  assert.ok(who && !who.policyBlocked, '데모(viewer) 비번 로그인은 허용');
  assert.equal(who.role, 'viewer');
});
