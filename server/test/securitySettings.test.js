import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v3.18.8: 이 파일이 만든 임시 폴더는 시험이 끝나면 지운다(지우지 않아 전량 실행마다 /tmp 에 쌓였다 — tmpCleanup3188 이 고정).
//   exit 에서 한 번 더 지운다 — 모듈의 종료 flush(util/exitFlush.js)가 뒤늦게 다시 만든 폴더(수 MB 실측)까지.
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

process.env.CONFIG_DIR = tmpDir('secsess-');
const { loadSessionSecurity, saveSessionSecurity } = await import('../src/security/securitySettings.js');

test('기본값: 유휴 로그아웃 30분 사용', () => {
  const s = loadSessionSecurity();
  assert.equal(s.idleLogoutEnabled, true);
  assert.equal(s.idleLogoutMin, 30);
});

test('저장 + 재로딩 반영', () => {
  const s = saveSessionSecurity({ idleLogoutMin: 15 });
  assert.equal(s.idleLogoutMin, 15);
  assert.equal(loadSessionSecurity().idleLogoutMin, 15);
});

test('범위 클램프(1~1440) + 반올림', () => {
  assert.equal(saveSessionSecurity({ idleLogoutMin: 0 }).idleLogoutMin, 1);
  assert.equal(saveSessionSecurity({ idleLogoutMin: 99999 }).idleLogoutMin, 1440);
  assert.equal(saveSessionSecurity({ idleLogoutMin: 20.7 }).idleLogoutMin, 21);
});

test('설정 소유 계정 기본값 noainred', () => {
  assert.deepEqual(loadSessionSecurity().settingsOwners, ['noainred']);
});

test('설정 소유 계정 변경 + 정규화(중복/형식 제거)', () => {
  const s = saveSessionSecurity({ settingsOwners: ['noainred', 'admin', 'noainred', '!bad name'] });
  assert.deepEqual(s.settingsOwners, ['noainred', 'admin']);
});

test('설정 소유 계정 빈 목록은 거부', () => {
  assert.throws(() => saveSessionSecurity({ settingsOwners: [] }), /최소 1개/);
  assert.throws(() => saveSessionSecurity({ settingsOwners: ['  '] }), /최소 1개/);
});

test('비활성 토글 유지', () => {
  const s = saveSessionSecurity({ idleLogoutEnabled: false });
  assert.equal(s.idleLogoutEnabled, false);
  // 부분 저장(min만 변경)해도 enabled 유지
  assert.equal(saveSessionSecurity({ idleLogoutMin: 45 }).idleLogoutEnabled, false);
});
