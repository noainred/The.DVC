/**
 * 130회차 결정 D-c(메인 구현 — 권장안): 서비스 점검(`GET /api/tools/service-check`)의 범위 계정 응답에서 `files` 배열을 뺀다.
 *
 * 예전: 범위 제한 계정에는 행의 문구(detail)만 비우고 `files`(중앙 설정 파일 · 인증 정지 기록 파일의 기본 이름 · 오류 코드 · 자격 지문 수)는 그대로 실었다.
 * 실제 라우터를 마운트해 본다 — 인증 정지 기록 파일 자리에 폴더를 둬(EISDIR) 'auth-stops' 행에 files 가 실리게 한 뒤, 전체 범위 · 범위 계정 응답을 대조한다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다(늦게 flush 되는 기록기와의 경합 — exit 에서 한 번 더) */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const CFG = tmpDir('mainfix130-');
process.env.CONFIG_DIR = CFG;
process.env.DATA_SOURCE = 'mock';

const ADMIN = { username: 'adm', role: 'admin', scope: {} };
const ADMIN_SCOPED = { username: 'adm2', role: 'admin', scope: { vcenters: ['vc-a'] } };

async function get(router, user, url) {
  const app = express();
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api', router);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api${url}`);
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally { srv.close(); }
}

test('서비스 점검 — 범위 계정 응답에는 files 배열이 없다(전체 범위 계정에는 있다)', async () => {
  const FILE = 't130-auth-stops.json';
  fs.mkdirSync(path.join(CFG, FILE));   // 파일 자리에 폴더 — 읽기 오류(EISDIR)
  const { createAuthGuard } = await import('../src/util/authGuard.js');
  const guard = createAuthGuard({ file: FILE });
  guard.authStopFor({ id: 'dev-1', username: 'svc', password: 'pw' });   // 한 번 읽게 한다(못 읽는 창이 열린다)
  assert.ok(guard.unreadable(), '전제: 정지 기록 파일을 못 읽는 상태');

  const { api } = await import('../src/routes/api.js');
  const full = await get(api, ADMIN, '/tools/service-check');
  assert.equal(full.status, 200, JSON.stringify(full.body).slice(0, 300));
  const withFiles = (full.body.checks || []).filter((c) => Array.isArray(c.files) && c.files.length > 0);
  assert.ok(withFiles.length >= 1, '전제: 전체 범위 응답에는 files 가 실린 행이 있다');
  assert.ok(JSON.stringify(full.body).includes(FILE), '전제: 전체 범위 응답에는 파일 기본 이름이 있다');

  const scoped = await get(api, ADMIN_SCOPED, '/tools/service-check');
  assert.equal(scoped.status, 200);
  assert.equal(scoped.body.scoped, true);
  assert.ok((scoped.body.checks || []).length >= withFiles.length, '행 자체는 그대로(상태만 본다)');
  for (const c of scoped.body.checks) assert.equal('files' in c, false, `${c.key}: 범위 계정 응답에 files 가 없어야 한다`);
  assert.ok(!JSON.stringify(scoped.body).includes(FILE), '범위 계정 응답에 파일 기본 이름이 없다');
  // 상태(주의)는 그대로 보인다 — 무음이 되지 않는다.
  const row = scoped.body.checks.find((c) => c.key === withFiles[0].key);
  assert.equal(row.status, withFiles[0].status);
});
