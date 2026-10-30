/**
 * test/bareosBugs2825_1b.test.js — v2.825.1 Bareos 버그 점검 확정분 중 **엣지 쪽**(가짜 중앙 HTTP 서버).
 *  G9  강제 배정 받기(pullBareosConfigForce)가 진행 중인 받기와 겹치면, 기다린 호출들은 뒤따르는 받기 **하나**를 같이 쓴다(동시 요청 1개)
 *  G18 대행 워커의 마지막 실패는 빈 인출 틱이 ok 로 덮어도 상태(lastError)에 남는다(엣지 로그에 5초만 보이던 것)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareosbugs28251b-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.SSRF_ALLOW_LOOPBACK = 'true';

const { config } = await import('../src/config.js');
const pull = await import('../src/agent/bareosConfigPull.js');
const worker = await import('../src/agent/bareosOpWorker.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = { cfgActive: 0, cfgMax: 0, cfgCount: 0, cfgHold: null, opsStatus: 200 };
let srv; let keep;
before(async () => {
  srv = http.createServer(async (req, res) => {
    if (req.url.startsWith('/api/central/bareos-config')) {
      C.cfgCount += 1; C.cfgActive += 1; C.cfgMax = Math.max(C.cfgMax, C.cfgActive);
      try { if (C.cfgHold) await C.cfgHold; else await sleep(30); } finally { C.cfgActive -= 1; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ directors: [] })); return;
    }
    if (req.url.startsWith('/api/central/bareos-ops')) {
      if (C.opsStatus !== 200) { res.writeHead(C.opsStatus, { 'content-type': 'application/json' }); res.end(JSON.stringify({ reason: '중앙 점검 중' })); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ops: [] })); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  keep = { ...config.agent };
  Object.assign(config.agent, { centralUrl: `http://127.0.0.1:${srv.address().port}`, centralToken: 'agent-token-pl-warsaw-1234567890', name: 'PL-Warsaw' });
});
after(async () => { Object.assign(config.agent, keep); srv?.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('G9 강제 받기: 진행 중인 받기를 기다린 강제 호출 셋은 뒤따르는 받기 하나를 같이 쓴다(동시 요청 1개)', async () => {
  pull._resetForTest();
  C.cfgCount = 0; C.cfgMax = 0;
  let release; C.cfgHold = new Promise((r) => { release = r; });
  const first = pull.pullBareosConfigNow();
  for (let i = 0; i < 200 && C.cfgActive < 1; i++) await sleep(5);
  const forced = [pull.pullBareosConfigForce(), pull.pullBareosConfigForce(), pull.pullBareosConfigForce()];
  await sleep(20);
  C.cfgHold = null; release();
  const [a, ...rest] = await Promise.all([first, ...forced]);
  assert.equal(a.ok, true);
  for (const r of rest) assert.equal(r.ok, true);
  assert.equal(C.cfgMax, 1, '중앙에 동시에 나간 받기 요청은 하나');
  assert.equal(C.cfgCount, 2, '진행 중이던 받기 + 뒤따르는 강제 받기 하나');
  // 뒤따르는 받기가 끝난 뒤의 강제 호출은 새로 받는다(기다린 호출만 묶는다)
  assert.equal((await pull.pullBareosConfigForce()).ok, true);
  assert.equal(C.cfgCount, 3);
});

test('G18 대행 워커: 인출 실패는 다음 빈 인출 틱(ok)이 덮어도 lastError 로 남는다', async () => {
  worker._resetBareosOpWorkerForTest();
  C.opsStatus = 503;
  const bad = await worker.runBareosOpWorkerOnce();
  assert.equal(bad, null);
  assert.equal(worker.bareosOpWorkerStatus().ok, false);
  C.opsStatus = 200;
  const good = await worker.runBareosOpWorkerOnce();
  assert.equal(good.ok, true, '빈 인출 틱은 ok');
  const st = worker.bareosOpWorkerStatus();
  assert.equal(st.ok, true);
  assert.match(st.lastError?.error || '', /인출 HTTP 503/, '앞선 실패가 남아 있다');
  assert.ok(!JSON.stringify(st).includes('agent-token-pl-warsaw'), '상태에 토큰 없음');
});
