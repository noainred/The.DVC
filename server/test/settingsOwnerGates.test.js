import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 확정 버그 회귀 방지(2026-08-30, 4~5차 재감사) — 설정 소유 경계.
//
// 이 파일은 두 종류의 검증을 한다:
//  (A) **동작 검증**: requireSettingsOwner 미들웨어를 직접 호출해 판정을 고정한다. 소스 정규식이
//      아니라 실제 동작을 보므로, 리팩터(미들웨어 순서·변수명·포맷)에 오탐하지 않고 회귀는 잡는다.
//  (B) **부착 검증(정적)**: '소유자를 만드는 권능' 라우트에 게이트가 붙어 있는지 소스로 확인한다.
//      라우터 미들웨어 부착은 서버 기동 없이 동작 검증이 어려워 저장소 관례(정적 검사)를 따른다.
//      ⚠ 정규식 검사는 정상 리팩터에도 실패할 수 있다(5차 재감사가 5/5 오탐을 실측). 실패하면
//      '보안 회귀'가 아니라 '검사식을 코드에 맞춰 갱신'이 필요한지 먼저 판단할 것. 반대로 음성
//      단정(doesNotMatch)은 변수명만 바꿔도 무력화돼 방어력이 없으므로 쓰지 않는다 — 그 역할은
//      (A) 동작 검증이 담당한다.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-gates-'));
process.env.CONFIG_DIR = tmp;

const { requireSettingsOwner } = await import('../src/routes/admin/shared.js');
const sec = await import('../src/security/securitySettings.js');

// --- (A) 동작 검증 ---

/** 미들웨어를 1회 실행해 { passed, status, body } 로 결과를 요약한다. */
function runGate(user) {
  let passed = false; let status = 0; let body = null;
  const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
  requireSettingsOwner({ user }, res, () => { passed = true; });
  return { passed, status, body };
}

test('소유자 판정은 로그인 ID(username)만 본다 — 표시이름으로는 통과하지 않는다', () => {
  // 4차 재감사 재현: 표시이름은 PATCH /admin/users/:u 로 아무 admin 이나 바꿀 수 있는 값이라,
  // 권한 판정에 쓰면 그 축으로 소유자 승계가 성립했다. username 은 변경 API 가 없다.
  sec.saveSessionSecurity({ settingsOwners: ['noainred', 'realowner'] });

  assert.equal(runGate({ username: 'realowner', name: 'whatever' }).passed, true, '소유자 ID 는 통과');

  const spoof = runGate({ username: 'atk', name: 'realowner' }); // 표시이름만 소유자와 동일
  assert.equal(spoof.passed, false, '표시이름으로 통과하면 소유자 경계가 무의미해진다');
  assert.equal(spoof.status, 403);
  assert.equal(spoof.body?.requiredOwner, true);
});

test('대소문자가 다른 ID 는 통과하지 않는다(정확일치)', () => {
  sec.saveSessionSecurity({ settingsOwners: ['noainred', 'realowner'] });
  assert.equal(runGate({ username: 'REALOWNER' }).passed, false);
  assert.equal(runGate({ username: ' realowner ' }).passed, false, '공백 포함도 별개 값');
});

test('수퍼관리자는 목록에 없어도 항상 소유자(loadSessionSecurity 가 항상 합산)', () => {
  sec.saveSessionSecurity({ settingsOwners: ['realowner'] });
  assert.equal(runGate({ username: 'noainred' }).passed, true);
});

test('user 가 비어 있어도 통과하지 않는다(방어적)', () => {
  sec.saveSessionSecurity({ settingsOwners: ['realowner'] });
  assert.equal(runGate(undefined).passed, false);
  assert.equal(runGate({}).passed, false);
});

// --- (B) 부착 검증(정적) ---

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (...p) => fs.readFileSync(path.join(here, '..', 'src', ...p), 'utf8');

test('엣지 사용자 배포의 변경 라우트 3개에 requireSettingsOwner 가 붙어 있다', () => {
  // 중앙 배포 admin 은 엣지에서 managedAdminOwners() 로 자동 소유자가 된다 → 이 라우트는 사실상
  // '엣지의 소유자를 만드는 권능'이다. adminOnly 로 열려 있으면 비소유자 중앙 admin 이
  // targets:['*'] 로 전 엣지 소유자가 된다(4차 재감사 실행 재현).
  const s = src('routes', 'admin', 'gpuGuest.js');
  for (const re of [
    /post\('\/edge-users\/:agent',[^)]*requireSettingsOwner/,
    /post\('\/edge-users-bulk',[^)]*requireSettingsOwner/,
    /delete\('\/edge-users\/:agent\/:username',[^)]*requireSettingsOwner/,
  ]) assert.match(s, re, `게이트 누락(또는 검사식 갱신 필요): ${re}`);
  // 조회는 소유자 전용으로 올리지 않는다(운영 화면이 막힌다).
  assert.match(s, /get\('\/edge-users\/:agent',\s*adminOnly,\s*\(/, '조회는 adminOnly 유지');
});

test('AD 설정 변경(PUT)에 requireSettingsOwner 가 붙어 있다(조회는 admin 유지)', () => {
  const s = src('routes', 'auth.js');
  assert.match(s, /put\('\/ad-config',[^)]*requireSettingsOwner/);
  assert.match(s, /get\('\/ad-config',\s*\.\.\.adminOnly,\s*\(/);
});
