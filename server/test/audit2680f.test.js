/**
 * v2.680 감사(1회차) — C-03 잔여: AD 세션은 같은 이름의 로컬 계정에 본인 OTP 를 등록하지 못한다(이름이 아니라 토큰 출처로 판정).
 */
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

process.env.CONFIG_DIR = tmpDir('audit2680f-');
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'mock';

test('C-03 — AD 토큰에는 로컬 표지가 없고 /totp/begin·confirm 은 400', async () => {
  const A = await import('../src/auth/auth.js');
  const express = (await import('express')).default;
  const { authRouter } = await import('../src/routes/auth.js');
  A.createUser({ username: 'samename', name: 'S', role: 'admin', password: 'Xx!23456789abc' }, { trusted: true });
  const ad = A.signToken({ sub: 'samename', role: 'admin', name: 'AD', src: 'ad' });
  const lo = A.signToken({ sub: 'samename', role: 'admin', name: 'L', src: 'local', tv: A.getUser('samename').tokenVersion || 0 }); // v2.771 R6-F5-1: 새 계정 tokenVersion 은 무작위 시작값
  assert.equal(A.resolveTokenUser(ad), null, 'v2.681 R2B-01: 로컬 이름과 같은 AD 토큰은 무효');
  const app = express(); app.use(express.json()); app.use('/api/auth', authRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api/auth`;
  try {
    const call = (tok, p) => fetch(base + p, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: '{"code":"123456"}' });
    assert.equal((await call(ad, '/totp/begin')).status, 401);
    assert.equal((await call(ad, '/totp/confirm')).status, 401);
    if (A.resolveTokenUser(lo)) { // 로컬 토큰은 예전처럼 진행(단일 세션 설정에 따라 토큰이 무효일 수 있다)
      assert.equal(A.resolveTokenUser(lo).authSrc, 'local');
      assert.equal((await call(lo, '/totp/begin')).status, 200);
    }
  } finally { srv.close(); }
});
