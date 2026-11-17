// 전체 점검 107회차 — 메인 반영(에이전트가 범위 밖으로 남긴 D2).
//  D2 RMA 접속 허용 설정 파일을 못 읽는 동안(읽기 오류) 중앙의 출처 판정(rmaSourceDenied)이 빈 목록 = '전부 허용' 으로 답했다 —
//     목록으로 막아 둔 법인의 rma-poll · rma-credential(평문 계정) · rma-result 가 목록 밖 출처에서도 통했다. 이제 판정하지 않고 503.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const CFG = tmpDir('main-fix-107-');
process.env.CONFIG_DIR = CFG;
process.env.PORT = '4000';
process.env.CENTRAL_TOKEN = 'shared-token-for-main-fix-107-0000000';

let server; let base; let tokens; let settings;
const FILE = path.join(CFG, 'rma-settings.json');
before(async () => {
  tokens = await import('../src/central/agentTokens.js');
  settings = await import('../src/rma/settings.js');
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use(express.json());
  app.use('/api/central', centralRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/central`;
});
after(() => { try { server?.close(); } catch { /* */ } });
const post = (p, body, token) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': token }, body: JSON.stringify(body) });

test('D2: 접속 허용 설정을 못 읽는 동안 rma-credential · rma-result · rma-poll 은 503 — 다시 읽히면 목록 판정으로 돌아온다', async () => {
  const t = tokens.issueAgentToken('RMA-107A');
  settings.setAgentAccess('RMA-107A', { allowedIps: ['10.9.9.9'] });   // 이 시험의 출처(127.0.0.1)는 목록 밖
  const cred = { agent: 'RMA-107A', credentialId: 'cred_x107', host: '10.0.0.5' };
  let r = await post('/rma-credential', cred, t.token);
  assert.equal(r.status, 403, '준비: 목록 밖 출처는 403 이어야 한다');
  assert.match((await r.json()).reason, /허용 IP/);

  // 읽기 오류 주입 — 설정 파일 자리를 폴더로(EISDIR). 원본은 옆에 둔다.
  const keep = `${FILE}.keep`;
  fs.renameSync(FILE, keep);
  fs.mkdirSync(FILE);
  settings._resetRmaSettings();
  try {
    assert.ok(settings.rmaSettingsWriteRefusal(), '준비: 읽기 오류 상태가 아니다');
    assert.deepEqual(settings.accessFor('RMA-107A').allowedIps, [], '준비: 못 읽는 동안 목록은 비어 보인다(그래서 판정을 맡기면 전부 허용)');
    for (const [p, body] of [['/rma-credential', cred], ['/rma-result', { reqId: 'x', result: {} }], ['/rma-poll', { instance: 'n1' }]]) {
      r = await post(p, body, t.token);
      assert.equal(r.status, 503, `${p}: 설정을 못 읽는데 ${r.status} — 목록 밖 출처가 통과했다`);
      const j = await r.json();
      assert.equal(j.reason, 'settingsUnreadable', `${p}: 엣지 계약 사유 코드가 아니다`);
      assert.ok(!JSON.stringify(j).includes(CFG), `${p}: 응답에 서버 경로가 실렸다`);
    }
  } finally {
    fs.rmdirSync(FILE);
    fs.renameSync(keep, FILE);
    settings._resetRmaSettings();
  }
  // 다시 읽히면 저장된 목록으로 판정한다(원본이 그대로다)
  r = await post('/rma-credential', cred, t.token);
  assert.equal(r.status, 403);
  assert.match((await r.json()).reason, /허용 IP/, '다시 읽힌 뒤 목록 판정으로 돌아오지 않았다');
  settings.setAgentAccess('RMA-107A', {});
});

test('D2: 설정 파일이 없는 것은 읽기 오류가 아니다 — 제한 없음으로 통과한다(브로커 판정까지 간다)', async () => {
  const t = tokens.issueAgentToken('RMA-107B');
  fs.rmSync(FILE, { force: true });
  settings._resetRmaSettings();
  assert.equal(settings.rmaSettingsWriteRefusal(), null);
  const r = await post('/rma-credential', { agent: 'RMA-107B', credentialId: 'cred_x107', host: '10.0.0.5' }, t.token);
  assert.equal(r.status, 403);
  assert.doesNotMatch((await r.json()).reason, /허용 IP|settingsUnreadable/, '파일 없음인데 출처 판정에서 막혔다');
});
