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

test('부트스트랩 유예: 아무 admin 도 OTP 미등록이면 admin 비밀번호 로그인 허용', () => {
  const who = auth.authenticateLocal('admin', 'bootstrap-pass-1');
  assert.ok(who && !who.policyBlocked, 'OTP 온보딩 전에는 admin 비번 로그인이 되어야 함(전체 잠김 방지)');
  assert.equal(who.role, 'admin');
});

test('operator 는 부트스트랩 유예 없이 비밀번호 로그인 차단(policyBlocked)', () => {
  assert.ok(auth.createUser({ username: 'op1', role: 'operator', password: 'operator-pass-1' }).ok);
  const r = auth.authenticateLocal('op1', 'operator-pass-1');
  assert.ok(r && r.policyBlocked, 'operator 비번 로그인은 정책 차단되어야 함');
  // 비번이 틀리면 policyBlocked 가 아니라 그냥 실패(null) — 자격증명 오류와 정책 차단을 구분.
  assert.equal(auth.authenticateLocal('op1', 'wrong-password'), null);
});

test('admin 하나가 OTP 를 등록하면 유예 종료 — 비번만 있는 다른 admin 도 차단', () => {
  // admin2(비번만) 추가 후, 기본 admin 에 OTP 를 등록해 유예를 끝낸다.
  assert.ok(auth.createUser({ username: 'admin2', role: 'admin', password: 'admin2-pass-12' }).ok);
  const u = auth.getUser('admin');
  u.totpEnabled = true;
  u.totpSecret = totp.generateSecret();
  // 유예 종료 후: 비밀번호 로그인은 admin/admin2 모두 차단.
  const r1 = auth.authenticateLocal('admin2', 'admin2-pass-12');
  assert.ok(r1 && r1.policyBlocked, '유예 종료 후 admin 비번 로그인 차단');
  // OTP 등록 admin 은 6자리 코드로 로그인 가능.
  const code = totp.generateToken(u.totpSecret);
  const who = auth.authenticateLocal('admin', code);
  assert.ok(who && !who.policyBlocked && who.role === 'admin', 'OTP 코드 로그인은 성공해야 함');
});

test('viewer(데모 포함)는 비밀번호 로그인 계속 허용', () => {
  assert.ok(auth.setLocalPassword(auth.DEMO_USERNAME, 'demo-pass-1234').ok);
  const who = auth.authenticateLocal(auth.DEMO_USERNAME, 'demo-pass-1234');
  assert.ok(who && !who.policyBlocked, '데모(viewer) 비번 로그인은 허용');
  assert.equal(who.role, 'viewer');
});
