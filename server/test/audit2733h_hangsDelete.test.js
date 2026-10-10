/**
 * v2.733 점검 3회차 그룹 h — C4-05: `DELETE /api/admin/perf/hangs` 가 파일 삭제에 실패(clearHangs {ok:false})해도
 *   200 을 주고 감사 로그에 '삭제' 를 남기던 결함.
 *
 * hang 로그 파일에는 사용자명·IP·User-Agent 가 담긴다. 감사자는 '서버 성능 hang 로그 삭제' 기록을 보고 개인정보가 지워졌다고
 * 판단하는데 파일은 그대로였다(재현: EBUSY 주입 → HTTP 200 {ok:false} · 파일 잔존 · 감사 '삭제'). 이제 실패면 500 + 감사 '삭제 실패'(사유).
 *
 * 실제 `registerPerfMonitor` 라우터 + authMiddleware(인증 꺼짐 = 익명 관리자·전체 범위)를 띄워 상태코드와 감사 로그 파일로 본다.
 * 삭제 실패는 fs.rmSync 를 hang 로그 파일에 한해 던지게 해 만든다(hangLog.js 는 `import fs from 'node:fs'` 의 속성을 호출 시점에 읽는다).
 * ⚠ perf/hangLog.js 의 v2.560 세 부분 수정(clearPending 미룸 등)은 이 테스트가 건드리지 않는다 — 라우트의 응답·감사만 본다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2733h-hang-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'false';
process.env.DATA_SOURCE = 'mock';

const require = createRequire(path.join(SRC, '..', 'package.json'));
const express = require('express');
const mod = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);

test('C4-05 hang 로그 비우기 — 삭제 실패면 500 + 감사 "삭제 실패", 성공이면 200 + 감사 "삭제"', async () => {
  const { registerPerfMonitor } = await mod('routes/admin/perfMonitor.js');
  const { authMiddleware } = await mod('auth/auth.js');
  const hang = await mod('perf/hangLog.js');
  const { listAudit } = await mod('audit.js');

  const file = hang.hangLogStatus().file;
  assert.ok(file.startsWith(DIR), 'hang 로그 파일은 임시 CONFIG_DIR 안이어야 한다');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"kind":"loop","user":"alice","ip":"10.1.2.3","ua":"Mozilla"}\n');

  const app = express();
  app.use(express.json());
  const r = express.Router();
  app.use('/api/admin', authMiddleware, r);
  registerPerfMonitor(r);
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((ok) => srv.on('listening', ok));
  const url = `http://127.0.0.1:${srv.address().port}/api/admin/perf/hangs`;
  const hangAudits = () => (listAudit({ limit: 50 }).items || []).filter((e) => /hang 로그/.test(e.action));

  const realRm = fs.rmSync;
  try {
    // ① 삭제 실패
    fs.rmSync = function (p, ...a) {
      if (String(p) === file) { const e = new Error(`EBUSY: resource busy or locked, unlink '${p}'`); e.code = 'EBUSY'; throw e; }
      return realRm.call(this, p, ...a);
    };
    const res1 = await fetch(url, { method: 'DELETE' });
    const body1 = await res1.json();
    fs.rmSync = realRm;
    assert.equal(fs.existsSync(file), true, '재현 전제: 파일이 남아 있다');
    assert.equal(res1.status, 500, `삭제 실패는 오류 상태코드여야 한다(받은 것: ${res1.status} ${JSON.stringify(body1)})`);
    assert.equal(body1.ok, false);
    assert.match(body1.reason, /EBUSY/);
    const a1 = hangAudits();
    assert.equal(a1.some((e) => e.action === '서버 성능 hang 로그 삭제'), false, "실패했는데 감사에 '삭제' 를 남기면 감사 기록이 거짓이 된다");
    const fail = a1.find((e) => e.action === '서버 성능 hang 로그 삭제 실패');
    assert.ok(fail, `감사에 '삭제 실패' 가 남아야 한다(${JSON.stringify(a1)})`);
    assert.match(fail.detail, /EBUSY/, '감사 detail 에 실패 사유가 있다');

    // ② 정상 삭제(회귀 없음)
    const res2 = await fetch(url, { method: 'DELETE' });
    const body2 = await res2.json();
    assert.equal(res2.status, 200);
    assert.equal(body2.ok, true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(hangAudits().filter((e) => e.action === '서버 성능 hang 로그 삭제').length, 1);
  } finally {
    fs.rmSync = realRm;
    srv.close();
  }
});
