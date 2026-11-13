// v2.977 전체 점검(엣지 축 — 재현 · audits.md '별건'): Veeam 실행 대행 워커의 결과 회신 실패가 5초 뒤 빈 인출 틱의 `_last={ok:true,ops:0}` 에
//   덮여 엣지 로그에서 사라졌다(무음 실패). bareosOpWorker(G18)처럼 마지막 실패를 10분 lastError 로 남긴다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'veeam-run-err-2977-'));
let pulls = 0; const posts = [];
const srv = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/api/central/veeam-run-ops')) {
      pulls += 1;
      return res.end(JSON.stringify({ ok: true, ops: pulls === 1 ? [{ id: 'op1', kind: 'start', serverId: 'nope', ttlMs: 60_000 }] : [] }));
    }
    if (req.url.startsWith('/api/central/veeam-run-result')) { posts.push(body); res.statusCode = 503; return res.end(JSON.stringify({ ok: false, reason: 'busy' })); }
    res.statusCode = 404; res.end();
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.CONFIG_DIR = DIR;
process.env.CENTRAL_URL = `http://127.0.0.1:${srv.address().port}`;
process.env.AGENT_NAME = 'edge-a';
process.env.AGENT_CENTRAL_TOKEN = 'tok-2977';
const w = await import('../src/agent/veeamRunWorker.js');
after(() => { srv.close(); fs.rmSync(DIR, { recursive: true, force: true }); });

test('회신 실패는 다음 빈 틱이 지우지 않는다(lastError 10분)', async () => {
  await w.runVeeamRunWorkerOnce();
  const s1 = w.veeamRunWorkerStatus();
  assert.equal(s1.ok, false);
  assert.match(s1.error, /회신 HTTP 503/);
  await w.runVeeamRunWorkerOnce();
  const s2 = w.veeamRunWorkerStatus();
  assert.equal(s2.ops, 0, '두 번째 틱은 작업 0건');
  assert.ok(s2.lastError && /회신 HTTP 503/.test(s2.lastError.error), '직전 회신 실패가 남는다(예전: 사라졌다)');
  assert.ok(posts.length >= 1);
});
