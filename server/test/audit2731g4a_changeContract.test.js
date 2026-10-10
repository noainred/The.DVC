/**
 * v2.731 점검 1회차 G4a · A5-01 — 서버의 실제 거부 본문을 화면 판정(web/src/views/changeResult.js)이 실패로 읽는가.
 *
 * 화면은 api.js putJson·delJson 의 반환 본문을 changeResult.requireChanged 로 판정한다(400·409 를 던지지 않는 규약 — 바꾸지 않았다).
 * 판정이 서버 계약과 어긋나면(서버가 다른 모양으로 거부하면) 화면이 다시 '저장됨' 을 말한다 — 그래서 **실제 라우터를 마운트해**
 * 화면이 부르는 경로의 400 본문과 성공 본문을 받아 판정을 대조한다(소스 grep 이 아니다):
 *   svcmon 대상 수정(엣지 이름 형식 위반)·로그 설정(경로 검사) · RMA 비밀번호(256자 초과)·원격 관리(롱폴 범위 밖)·분배 방식 ·
 *   vCenter 로그 보관 설정(저장 경로 검사).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'a2731g4a-'));
process.env.CONFIG_DIR = CFG;
process.env.DATA_SOURCE = 'mock';

const ADMIN = { username: 'adm', role: 'admin', scope: {} };
const { changeFailText, requireChanged } = await import('../../web/src/views/changeResult.js');

async function call(mount, router, method, url, body) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = ADMIN; next(); });
  app.use(mount, router);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}${mount}${url}`, {
      method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally { srv.close(); }
}

test('svcmon — 대상 수정 400({error})은 실패, 정상 수정({target})은 성공', async () => {
  const { svcmonRouter } = await import('../src/routes/svcmon.js');
  const add = await call('/api/svcmon', svcmonRouter, 'POST', '/targets', { kind: 'infra', path: 'G4A', name: 'g4a-t1', host: '10.1.2.3' });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  const id = add.body.target?.id || add.body.id;
  assert.ok(id, JSON.stringify(add.body));

  const bad = await call('/api/svcmon', svcmonRouter, 'PUT', `/targets/${id}`, { agent: 'bad agent;x' }); // 엣지 이름 형식 위반 → 400 {error}
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.ok(changeFailText(bad.body), `400 본문이 실패로 읽혀야 한다: ${JSON.stringify(bad.body)}`);
  assert.throws(() => requireChanged(bad.body), (e) => e.message === changeFailText(bad.body));

  const ok = await call('/api/svcmon', svcmonRouter, 'PUT', `/targets/${id}`, { name: 'g4a-t1-renamed' });
  assert.equal(ok.status, 200);
  assert.equal(changeFailText(ok.body), null, '정상 수정 본문은 실패가 아니다');
  assert.equal(requireChanged(ok.body), ok.body);
});

test('svcmon — 로그 설정 경로 거부 400({error})은 실패, 정상 저장(logStatus)은 성공', async () => {
  const { svcmonRouter } = await import('../src/routes/svcmon.js');
  const bad = await call('/api/svcmon', svcmonRouter, 'PUT', '/log', { dirPath: '/etc' });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.match(changeFailText(bad.body) || '', /로그 경로/);
  const ok = await call('/api/svcmon', svcmonRouter, 'PUT', '/log', { enabled: false });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(changeFailText(ok.body), null);
});

test('RMA — 비밀번호·원격 관리 400({ok:false,reason})은 실패, 정상 응답({ok:true})은 성공', async () => {
  const { api } = await import('../src/routes/api.js');
  const pw = await call('/api', api, 'PUT', '/tools/rma/agents/g4a-edge/password', { password: 'a'.repeat(300) });
  assert.equal(pw.status, 400, JSON.stringify(pw.body));
  assert.equal(pw.body.hasPassword, undefined, '실패 본문에는 hasPassword 가 없다 — 예전 화면은 이것을 \'해제했습니다\' 로 읽었다');
  assert.equal(changeFailText(pw.body), pw.body.reason);

  const clear = await call('/api', api, 'PUT', '/tools/rma/agents/g4a-edge/password', { password: '' });
  assert.equal(clear.status, 200, JSON.stringify(clear.body));
  assert.equal(changeFailText(clear.body), null);

  const remote = await call('/api', api, 'PUT', '/tools/rma/agents/g4a-edge/remote', { longpollMs: 1000 });
  assert.equal(remote.status, 400, JSON.stringify(remote.body));
  assert.match(changeFailText(remote.body) || '', /롱폴/);

  const mode = await call('/api', api, 'PUT', '/tools/rma/agents/g4a-edge/mode', { mode: 'no-such-mode' });
  if (mode.status === 400) assert.ok(changeFailText(mode.body), JSON.stringify(mode.body));
  else assert.equal(changeFailText(mode.body), null, JSON.stringify(mode.body));
});

test('vCenter 로그 보관 설정 — 저장 경로 거부 400({ok:false,reason})은 실패, 정상 저장(설정 객체)은 성공', async () => {
  const { adminRouter } = await import('../src/routes/admin.js');
  const bad = await call('/api/admin', adminRouter, 'PUT', '/vclogs/settings', { storagePath: '/etc' });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.match(changeFailText(bad.body) || '', /로그 저장 경로/);
  const ok = await call('/api/admin', adminRouter, 'PUT', '/vclogs/settings', { enabled: false });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(changeFailText(ok.body), null, `설정 객체는 실패가 아니다: ${JSON.stringify(ok.body)}`);
});
