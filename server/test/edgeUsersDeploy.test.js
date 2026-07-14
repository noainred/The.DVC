import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-users-'));
process.env.CONFIG_DIR = tmp;
process.env.AUTH_SECRET = 'test-secret';

let central, auth;
before(async () => {
  auth = await import('../src/auth/auth.js');
  central = await import('../src/central/agentUsers.js');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('agentUsers: upsert(해시 저장)·목록(해시 가림)·pull용 해시 포함·제거', () => {
  let r = central.upsertAgentUser('GM1', { username: 'edgeop', name: '엣지운영', role: 'operator', password: 'secret123' });
  assert.ok(r.ok, r.reason);
  // 관리 UI용 목록 — 해시 미노출
  const list = central.listAgentUsers('GM1');
  const u = list.find((x) => x.username === 'edgeop');
  assert.equal(u.role, 'operator');
  assert.equal(u.hasPassword, true);
  assert.equal(u.passwordHash, undefined);
  // pull용 — 해시 포함
  const forEdge = central.getAgentUsers('GM1');
  assert.match(forEdge.find((x) => x.username === 'edgeop').passwordHash, /^scrypt\$/);
  // 잘못된 입력 거부
  assert.equal(central.upsertAgentUser('GM1', { username: 'a b', role: 'viewer' }).ok, false);
  assert.equal(central.upsertAgentUser('GM1', { username: 'ok', role: 'root' }).ok, false);
  assert.equal(central.upsertAgentUser('GM1', { username: 'ok', role: 'viewer', password: 'short' }).ok, false);
  // 제거
  assert.ok(central.removeAgentUser('GM1', 'edgeop').ok);
  assert.equal(central.listAgentUsers('GM1').length, 0);
});

test('applyManagedUsers: 생성/갱신/삭제 + 로컬 충돌 skip + 마지막 admin 보호', () => {
  // 로컬 계정 하나(비managed) 시드 — 기본 admin은 loadUsers가 시드.
  auth.createUser({ username: 'localuser', role: 'operator', password: 'localpass1' });
  const hash = auth.hashPassword('pw12345678');

  // 1) 중앙 배포: managed 사용자 2명 생성
  let r = auth.applyManagedUsers([
    { username: 'c-admin', name: '중앙관리자', role: 'admin', passwordHash: hash },
    { username: 'c-view', role: 'viewer', passwordHash: hash },
    { username: 'localuser', role: 'admin', passwordHash: hash }, // 로컬 계정과 충돌 → skip
  ]);
  assert.equal(r.created, 2);
  assert.ok(r.skipped.some((s) => s.includes('localuser')), '로컬 계정 충돌 skip');
  const managed = auth.listManagedUsers().map((u) => u.username).sort();
  assert.deepEqual(managed, ['c-admin', 'c-view']);
  // 로컬 계정은 그대로 operator
  assert.equal(auth.getUser('localuser').role, 'operator');

  // 2) 목록에서 c-view 제거 → 엣지에서도 삭제, c-admin은 갱신
  r = auth.applyManagedUsers([{ username: 'c-admin', role: 'operator', passwordHash: hash }]);
  assert.equal(r.removed, 1);
  assert.equal(r.updated, 1);
  assert.equal(auth.getUser('c-view'), null);
  assert.equal(auth.getUser('c-admin').role, 'operator');

  // 3) 로그인 검증 — 배포된 해시로 인증 가능
  assert.ok(auth.authenticateLocal('c-admin', 'pw12345678'), '배포 해시로 로그인');
});
