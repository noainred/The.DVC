import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v3.18.8: 이 파일이 만든 임시 폴더는 시험이 끝나면 지운다(지우지 않아 전량 실행마다 /tmp 에 쌓였다 — tmpCleanup3188 이 고정).
//   exit 에서 한 번 더 지운다 — 모듈의 종료 flush(util/exitFlush.js)가 뒤늦게 다시 만든 폴더(수 MB 실측)까지.
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다(늦게 flush 되는 기록기와의 경합 — exit 에서 한 번 더) */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

process.env.CONFIG_DIR = tmpDir('estop-');
const { isStopped, getEmergencyStatus, setEmergencyStop } = await import('../src/security/emergencyStop.js');

test('긴급중단: 기본은 비활성', () => {
  assert.equal(isStopped(), false);
  assert.equal(getEmergencyStatus().active, false);
});

test('긴급중단: 켜면 isStopped=true + 승인자 기록', () => {
  const s = setEmergencyStop(true, ['admin1', 'admin2']);
  assert.equal(s.active, true);
  assert.deepEqual(s.by, ['admin1', 'admin2']);
  assert.equal(isStopped(), true);
});

test('긴급중단: 해제하면 비활성 + 승인자 비움', () => {
  const s = setEmergencyStop(false, ['admin1', 'admin2']);
  assert.equal(s.active, false);
  assert.deepEqual(s.by, []);
  assert.equal(isStopped(), false);
});

test('긴급중단: 상태가 파일에 영속화된다', () => {
  setEmergencyStop(true, ['a', 'b']);
  const file = path.join(process.env.CONFIG_DIR, 'emergency-stop.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.active, true);
});

test('긴급중단(v2.674): 승인자 역할은 저장 역할 기준 — super_admin 도 관리자 등급(예전엔 거부)', async () => {
  const { approverRoleIssue } = await import('../src/security/emergencyStop.js');
  assert.equal(approverRoleIssue({ username: 'noainred', role: 'super_admin' }), null, 'super_admin 은 승인할 수 있다');
  assert.equal(approverRoleIssue({ username: 'a', role: 'admin' }), null);
  assert.equal(approverRoleIssue({ username: 'o', role: 'operator' }), 'not-admin');
  assert.equal(approverRoleIssue({ username: 'v', role: 'viewer' }), 'not-admin');
  assert.equal(approverRoleIssue({ username: 'x' }), 'not-admin');
  assert.equal(approverRoleIssue(null), 'missing');
  // 라우트가 이 판정을 쓰고, 저장 역할을 'admin' 문자열과 직접 비교하지 않는다
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fs.readFileSync(new URL('../src/routes/admin/statusTools.js', import.meta.url), 'utf8'));
  const route = src.slice(src.indexOf("'/emergency-stop', adminOnly, fleetOnly"), src.indexOf('setEmergencyStop(action'));
  assert.match(route, /approverRoleIssue\(u\)/);
  assert.doesNotMatch(route, /role[^\n]{0,12}!==\s*'admin'/);
  // 범위 판정에는 접은 역할(admin)을 넘긴다 — super_admin 문자열을 넘기면 범위 판정이 역할을 모른다
  assert.match(route, /role:\s*authzRole\(u\.role\)/);
});
