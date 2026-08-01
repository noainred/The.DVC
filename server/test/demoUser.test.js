import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// auth.js 는 import 시점의 CONFIG_DIR 을 사용 → 격리된 임시 디렉터리로 지정 후 로드.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-user-test-'));
process.env.CONFIG_DIR = TMP;

const auth = await import('../src/auth/auth.js');

test('데모 계정(thedvcdemp): 시드 시 자동 생성 · viewer · 비번 없음(로그인 불가)', () => {
  const users = auth.loadUsers();
  const demo = users.find((u) => u.username === auth.DEMO_USERNAME);
  assert.ok(demo, '데모 계정이 시드되어야 함');
  assert.equal(demo.role, 'viewer');
  assert.ok(demo.demo);
  assert.ok(!demo.passwordHash);
  // 비번 미설정 → 어떤 비밀번호로도 로그인 불가.
  assert.equal(auth.authenticateLocal(auth.DEMO_USERNAME, 'anything'), null);
  assert.equal(auth.authenticateLocal(auth.DEMO_USERNAME, ''), null);
});

test('데모 계정: 비번 설정 → 로그인 가능(viewer), 로그인 차단 → 다시 불가', () => {
  const r = auth.setLocalPassword(auth.DEMO_USERNAME, 'demo-pass-123');
  assert.ok(r.ok, r.reason);
  const who = auth.authenticateLocal(auth.DEMO_USERNAME, 'demo-pass-123');
  assert.ok(who, '비번 설정 후 로그인 가능해야 함');
  assert.equal(who.role, 'viewer');
  // 로그인 차단(자격증명 제거) → 방금 그 비번도 거부.
  const c = auth.clearLoginCredentials(auth.DEMO_USERNAME);
  assert.ok(c.ok, c.reason);
  assert.equal(auth.authenticateLocal(auth.DEMO_USERNAME, 'demo-pass-123'), null);
});

test('데모 계정 보호: 역할 변경(승격) 거부 · 삭제 거부, 이름 변경은 허용', () => {
  assert.equal(auth.updateUser(auth.DEMO_USERNAME, { role: 'admin' }).ok, false);
  assert.equal(auth.updateUser(auth.DEMO_USERNAME, { role: 'operator' }).ok, false);
  assert.equal(auth.updateUser(auth.DEMO_USERNAME, { role: 'viewer' }).ok, true); // 동일 역할은 무해
  assert.equal(auth.deleteUser(auth.DEMO_USERNAME).ok, false);
  assert.equal(auth.updateUser(auth.DEMO_USERNAME, { name: '데모 계정' }).ok, true);
});

test('수퍼관리자(noainred): 자동 시드 · admin 고정 · 강등/삭제/로그인차단 거부', () => {
  const su = auth.loadUsers().find((u) => u.username === auth.SUPER_USERNAME);
  assert.ok(su, '수퍼관리자 계정이 시드되어야 함');
  assert.equal(su.role, 'admin');
  assert.ok(su.superuser);
  assert.equal(auth.updateUser(auth.SUPER_USERNAME, { role: 'viewer' }).ok, false);
  assert.equal(auth.updateUser(auth.SUPER_USERNAME, { role: 'operator' }).ok, false);
  assert.equal(auth.updateUser(auth.SUPER_USERNAME, { role: 'admin' }).ok, true); // 동일 역할은 무해
  assert.equal(auth.deleteUser(auth.SUPER_USERNAME).ok, false);
  assert.equal(auth.clearLoginCredentials(auth.SUPER_USERNAME).ok, false);
});

test('수퍼관리자: users.json 에 강등 상태로 저장돼 있어도 로드 시 admin 으로 복구', async () => {
  // 강등된 noainred 가 담긴 users.json 을 만들어 두고, 모듈을 새로 로드해 시드 경로를 재실행.
  // (ESM 은 쿼리스트링이 다르면 별도 모듈 인스턴스로 평가된다 — 메모이즈 우회용.)
  const file = path.join(TMP, 'users.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const su = data.users.find((u) => u.username === auth.SUPER_USERNAME);
  su.role = 'viewer';
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  const fresh = await import('../src/auth/auth.js?fresh-super');
  const reloaded = fresh.loadUsers().find((u) => u.username === fresh.SUPER_USERNAME);
  assert.equal(reloaded.role, 'admin', '로드 시 admin 으로 복구되어야 함');
});
