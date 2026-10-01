/**
 * v2.680 감사(1회차) — C-03 잔여: AD 세션은 같은 이름의 로컬 계정에 본인 OTP 를 등록하지 못한다(이름이 아니라 토큰 출처로 판정).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2680f-'));
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'mock';

test('C-03 — AD 토큰에는 로컬 표지가 없고 /totp/begin·confirm 은 400', async () => {
  const A = await import('../src/auth/auth.js');
  const express = (await import('express')).default;
  const { authRouter } = await import('../src/routes/auth.js');
  A.createUser({ username: 'samename', name: 'S', role: 'admin', password: 'Xx!23456789abc' }, { trusted: true });
  const ad = A.signToken({ sub: 'samename', role: 'admin', name: 'AD', src: 'ad' });
  const lo = A.signToken({ sub: 'samename', role: 'admin', name: 'L', src: 'local', tv: 0 });
  assert.equal(A.resolveTokenUser(ad)?.authSrc, undefined);
  const app = express(); app.use(express.json()); app.use('/api/auth', authRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api/auth`;
  try {
    const call = (tok, p) => fetch(base + p, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: '{"code":"123456"}' });
    assert.equal((await call(ad, '/totp/begin')).status, 400);
    assert.equal((await call(ad, '/totp/confirm')).status, 400);
    if (A.resolveTokenUser(lo)) { // 로컬 토큰은 예전처럼 진행(단일 세션 설정에 따라 토큰이 무효일 수 있다)
      assert.equal(A.resolveTokenUser(lo).authSrc, 'local');
      assert.equal((await call(lo, '/totp/begin')).status, 200);
    }
  } finally { srv.close(); }
});
