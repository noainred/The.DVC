/**
 * 릴리스 전 Chromium 검증(132~135회차 묶음) — 사용 기록 집계(`GET /api/admin/usage/report`)의 503 본문.
 *
 * 사용 기록 설정 파일을 못 읽는 동안 이 라우트는 503 으로 답한다(꺼짐 구간을 지어내지 않는다). 예전 본문은 ① 읽기 오류에도 '손상본은 .corrupt 로 보존 · 다시 저장하면
 * 기본값' 이라고 했고(읽기 오류에는 보존본이 없고 저장도 거절된다) ② code 가 없어 화면이 '서비스에 일시적으로 연결할 수 없습니다 · 5분 후 재시도' 로 바꿔 원인을 가렸다.
 * 실제 라우터를 마운트해 본다(게이트 = 관리자 ∧ 설정 소유자 — 시험 계정을 소유자로 둔다).
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

const CFG = tmpDir('mainfix135b-');
process.env.CONFIG_DIR = CFG;
process.env.DATA_SOURCE = 'mock';
fs.writeFileSync(path.join(CFG, 'users.json'), JSON.stringify({ users: [{ username: 'adm', role: 'admin' }] }));
fs.writeFileSync(path.join(CFG, 'security-session.json'), JSON.stringify({ settingsOwners: ['adm'] }));

const ADMIN = { username: 'adm', role: 'admin', scope: {} };

async function report(prepare) {
  prepare();
  const { registerUsageAdmin } = await import('../src/routes/admin/usage.js');
  const router = express.Router();
  registerUsageAdmin(router);
  const app = express();
  app.use((req, _res, next) => { req.user = ADMIN; next(); });
  app.use('/api/admin', router);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/admin/usage/report?days=7`);
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally { srv.close(); }
}

test('읽기 오류(파일 자리에 폴더) — 503 · code settingsUnreadable · 손상본 보존이라고 말하지 않는다', async () => {
  const r = await report(() => fs.mkdirSync(path.join(CFG, 'usage-settings.json')));
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(r.body.code, 'settingsUnreadable', '화면(serviceDownText)이 사유를 그대로 보이게 하는 표지');
  assert.equal(r.body.error, 'settingsUnreadable', '예전 소비처를 위해 error 도 그대로');
  assert.match(r.body.reason, /사용 기록 설정\(usage-settings\.json\)을 읽지 못해 집계를 내지 않았습니다/);
  assert.match(r.body.reason, /30초마다 다시 읽고, 읽히면 풀립니다/);
  assert.ok(!/\.corrupt/.test(r.body.reason), '읽기 오류에는 손상 보존본이 없다');
  assert.ok(!/다시 저장하면 기본값/.test(r.body.reason), '읽기 오류 동안 저장은 거절된다');
  assert.ok(!/`/.test(r.body.reason));
});
