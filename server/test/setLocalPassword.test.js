import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 격리된 CONFIG_DIR — users.json이 이 디렉터리에 시드/저장된다.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'setpw-'));
process.env.CONFIG_DIR = tmp;

let auth;
before(async () => { auth = await import('../src/auth/auth.js'); });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('setLocalPassword: 8자 미만/128자 초과/없는 사용자 거부', () => {
  assert.equal(auth.setLocalPassword('admin', 'short').ok, false);
  assert.equal(auth.setLocalPassword('admin', 'x'.repeat(129)).ok, false);
  assert.equal(auth.setLocalPassword('no-such-user', 'longenough1').ok, false);
});

test('setLocalPassword: 변경 후 새 비번으로 로그인, 이전 비번은 거부', () => {
  const r = auth.setLocalPassword('admin', 'newPassword123');
  assert.equal(r.ok, true);
  assert.ok(auth.authenticateLocal('admin', 'newPassword123'));
  assert.equal(auth.authenticateLocal('admin', 'admin123'), null);
});

test('setLocalPassword: users.json에 영속화(해시만, 평문 없음)', () => {
  auth.setLocalPassword('admin', 'persistedPw456');
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'users.json'), 'utf8'));
  const u = saved.users.find((x) => x.username === 'admin');
  assert.ok(u.passwordHash);
  assert.ok(!JSON.stringify(saved).includes('persistedPw456'));
});

test('setLocalPassword: 비문자열(객체/배열/숫자) 거부 — "[object Object]" 비번 사고 방지', () => {
  assert.equal(auth.setLocalPassword('admin', { a: 1 }).ok, false);
  assert.equal(auth.setLocalPassword('admin', ['longenough1']).ok, false);
  assert.equal(auth.setLocalPassword('admin', 12345678).ok, false);
});

test('setLocalPassword: 특수문자·유니코드·공백 비번 그대로 저장/검증', () => {
  const pw = ' p@ss,w0rd"\'\\<>&%$#! 비밀🔑 ';
  assert.equal(auth.setLocalPassword('admin', pw).ok, true);
  assert.ok(auth.authenticateLocal('admin', pw));
  assert.equal(auth.authenticateLocal('admin', pw.trim()), null); // 앞뒤 공백도 비번의 일부
});
