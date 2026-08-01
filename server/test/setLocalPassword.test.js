import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 격리된 CONFIG_DIR — users.json이 이 디렉터리에 시드/저장된다.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'setpw-'));
process.env.CONFIG_DIR = tmp;

let auth;
// 비밀번호 저장/검증 의미를 확인하는 테스트이므로 **비번 로그인이 허용되는 viewer** 계정을 쓴다.
// (admin/operator 는 v2.205 부터 OTP 전용이라 비번으로는 로그인되지 않는다 — otpPolicy.test.js 참조)
const PWUSER = 'pwtest-viewer';
before(async () => {
  auth = await import('../src/auth/auth.js');
  assert.equal(auth.createUser({ username: PWUSER, role: 'viewer' }).ok, true);
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('setLocalPassword: 8자 미만/128자 초과/없는 사용자 거부', () => {
  assert.equal(auth.setLocalPassword(PWUSER, 'short').ok, false);
  assert.equal(auth.setLocalPassword(PWUSER, 'x'.repeat(129)).ok, false);
  assert.equal(auth.setLocalPassword('no-such-user', 'longenough1').ok, false);
});

test('setLocalPassword: 변경 후 새 비번으로 로그인, 이전 비번은 거부', () => {
  const r = auth.setLocalPassword(PWUSER, 'newPassword123');
  assert.equal(r.ok, true);
  assert.ok(auth.authenticateLocal(PWUSER, 'newPassword123'));
  assert.equal(auth.authenticateLocal(PWUSER, 'admin123'), null);
});

test('setLocalPassword: users.json에 영속화(해시만, 평문 없음)', () => {
  auth.setLocalPassword(PWUSER, 'persistedPw456');
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'users.json'), 'utf8'));
  const u = saved.users.find((x) => x.username === PWUSER);
  assert.ok(u.passwordHash);
  assert.ok(!JSON.stringify(saved).includes('persistedPw456'));
});

test('setLocalPassword: 비문자열(객체/배열/숫자) 거부 — "[object Object]" 비번 사고 방지', () => {
  assert.equal(auth.setLocalPassword(PWUSER, { a: 1 }).ok, false);
  assert.equal(auth.setLocalPassword(PWUSER, ['longenough1']).ok, false);
  assert.equal(auth.setLocalPassword(PWUSER, 12345678).ok, false);
});

test('setLocalPassword: 특수문자·유니코드·공백 비번 그대로 저장/검증', () => {
  const pw = ' p@ss,w0rd"\'\\<>&%$#! 비밀🔑 ';
  assert.equal(auth.setLocalPassword(PWUSER, pw).ok, true);
  assert.ok(auth.authenticateLocal(PWUSER, pw));
  assert.equal(auth.authenticateLocal(PWUSER, pw.trim()), null); // 앞뒤 공백도 비번의 일부
});
