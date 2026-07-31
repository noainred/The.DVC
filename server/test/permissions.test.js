import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// permissions.js 는 config.configDir(=CONFIG_DIR)에 permissions.json 을 저장한다.
// 테스트 격리를 위해 import 전에 임시 디렉터리를 CONFIG_DIR 로 지정한다.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-test-'));
process.env.CONFIG_DIR = TMP;

const perm = await import('../src/auth/permissions.js');

test('기본 매트릭스: admin 은 전체, operator 는 쓰기 포함, viewer 는 읽기 전용', () => {
  const all = perm.ALL_PERMISSION_KEYS;
  assert.equal(perm.rolePermissions('admin').length, all.length);
  // operator 는 원격/작업 권한 보유, viewer 는 미보유(기존 role 동작과 동일해야 함).
  assert.ok(perm.userHasPermission({ role: 'operator' }, 'remote.access'));
  assert.ok(!perm.userHasPermission({ role: 'viewer' }, 'remote.access'));
  // 조회는 둘 다 가능.
  assert.ok(perm.userHasPermission({ role: 'viewer' }, 'inv.vms'));
  // admin 은 무엇이든 통과.
  assert.ok(perm.userHasPermission({ role: 'admin' }, 'upgrade'));
  // 관리 권한(설정/업그레이드/사용자)은 operator/viewer 기본 미보유.
  for (const k of ['settings', 'upgrade', 'users.manage']) {
    assert.ok(!perm.userHasPermission({ role: 'operator' }, k), `operator should not have ${k}`);
    assert.ok(!perm.userHasPermission({ role: 'viewer' }, k), `viewer should not have ${k}`);
  }
});

test('saveMatrix: operator 에서 remote.access 제거 → 즉시 반영 + 영속', () => {
  const cur = perm.loadMatrix();
  const nextOp = cur.operator.filter((k) => k !== 'remote.access');
  perm.saveMatrix({ operator: nextOp });
  assert.ok(!perm.userHasPermission({ role: 'operator' }, 'remote.access'));
  // 파일로 저장됐는지 확인.
  const saved = JSON.parse(fs.readFileSync(path.join(TMP, 'permissions.json'), 'utf8'));
  assert.ok(!saved.matrix.operator.includes('remote.access'));
});

test('saveMatrix: 카탈로그에 없는 키는 버려진다(방어)', () => {
  perm.saveMatrix({ viewer: ['inv.vms', 'bogus.key', 'settings'] });
  const set = perm.rolePermissionSet('viewer');
  assert.ok(set.has('inv.vms'));
  assert.ok(set.has('settings'));
  assert.ok(!set.has('bogus.key'));
});

test('resetMatrix: 기본값 복원', () => {
  perm.resetMatrix();
  assert.ok(perm.userHasPermission({ role: 'operator' }, 'remote.access'));
  assert.ok(!perm.userHasPermission({ role: 'viewer' }, 'settings'));
});

test('userHasPermission: 사용자 없음/역할 불명 → false, admin → true', () => {
  assert.ok(!perm.userHasPermission(null, 'inv.vms'));
  assert.ok(!perm.userHasPermission({ role: 'ghost' }, 'inv.vms'));
  assert.ok(perm.userHasPermission({ role: 'admin' }, 'anything'));
});
