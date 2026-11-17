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

// CONFIG_DIR을 격리된 임시 폴더로 지정한 뒤 모듈을 동적 import(설정 캐시 전에).
process.env.CONFIG_DIR = tmpDir('loginstore-');
const { recordLoginFails, recordPortalLoginFail, getStoredFails } = await import('../src/security/loginStore.js');

test('recordLoginFails: 게스트 실패 기록 + 신규 건수 반환', () => {
  const n = recordLoginFails([
    { ts: 1000, user: 'root', ip: '1.2.3.4', vm: 'vm-a', kind: 'guest' },
    { ts: 2000, user: 'admin', ip: '5.6.7.8', vm: 'vm-b', kind: 'guest' },
  ]);
  assert.equal(n, 2);
  assert.equal(getStoredFails(0).length, 2);
});

test('recordLoginFails: 동일 키 중복은 제거(dedup)', () => {
  const before = getStoredFails(0).length;
  const n = recordLoginFails([
    { ts: 1000, user: 'root', ip: '1.2.3.4', vm: 'vm-a', kind: 'guest' }, // 위와 동일 → 무시
  ]);
  assert.equal(n, 0);
  assert.equal(getStoredFails(0).length, before);
});

test('recordPortalLoginFail: 포탈 실패 kind=portal 기록', () => {
  recordPortalLoginFail({ username: 'operator', ip: '9.9.9.9', reason: 'invalid credentials' });
  const portal = getStoredFails(0).filter((r) => r.kind === 'portal');
  assert.equal(portal.length, 1);
  assert.equal(portal[0].user, 'operator');
});

test('getStoredFails: sinceTs 이후만 반환', () => {
  // ts=1000,2000 기록됨 + 포탈(현재시각). since=1500 이면 ts=1000은 제외.
  const recent = getStoredFails(1500);
  assert.ok(recent.every((r) => r.ts >= 1500));
  assert.ok(!recent.some((r) => r.ts === 1000));
});
