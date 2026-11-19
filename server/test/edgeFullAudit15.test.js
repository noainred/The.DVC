/**
 * edgeFullAudit15.test.js — 전체 소스 점검 15회차(엣지 워커) 확정분.
 *  ① A-1: 대량 배포 취소는 같은 host · 다른 SSH 포트 행의 세션을 모두 끊는다(예전 Map 키가 host 라 둘째 행이 첫 행 컨트롤러를 덮고, 먼저 끝난 행이 남은 행 컨트롤러를 지웠다)
 *  ② A-2: 집중 모니터링 동기화 성공 뒤 '보낸 것만' 지운다(개수 splice 는 기다리는 동안 trim 이 앞을 지웠으면 보내지 않은 새 표본까지 지웠다)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'edgefa15-'));
process.env.DATA_SOURCE = 'mock';
test.after(() => { try { fs.rmSync(process.env.CONFIG_DIR, { recursive: true, force: true }); } catch { /* */ } });

test('① A-1 — 같은 host 의 두 포트 행: 취소가 둘 다 끊는다 · 먼저 끝난 행이 남은 행 컨트롤러를 지우지 않는다', async () => {
  const BD = await import('../src/agent/bulkDeploy.js');
  BD._resetForTest();
  const signals = {};
  const deploy = (row) => new Promise((resolve) => {
    signals[row.port] = row.signal;
    if (row.port === 2222) { setTimeout(() => resolve({ ok: false, reason: 'fast fail' }), 5); return; }   // 먼저 끝나는 행
    row.signal.addEventListener('abort', () => resolve({ ok: false, reason: 'aborted' }), { once: true });
  });
  const rows = [
    { host: '10.0.0.5', port: 22, username: 'root', password: 'p', _line: 1 },
    { host: '10.0.0.5', port: 4067, username: 'root', password: 'p', _line: 2 },
    { host: '10.0.0.5', port: 2222, username: 'root', password: 'p', _line: 3 },
  ];
  const r = BD.startBulkDeploy(rows, { deploy, concurrency: 3, saveTargets: false, registerCollector: false, timeoutMs: 600_000 });
  assert.equal(r.ok, true);
  await new Promise((res) => setTimeout(res, 30));   // 2222 행은 끝났다(지도에서 자기 것만 지운다)
  assert.equal(BD.cancelRun(r.runId).ok, true);
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(signals[22]?.aborted, true, '22 포트 행도 끊긴다(예전: 4067 행이 덮어 끊기지 않았다)');
  assert.equal(signals[4067]?.aborted, true);
  const v = BD.getRun(r.runId);
  assert.deepEqual(v.items.map((x) => x.status).sort(), ['cancelled', 'cancelled', 'fail']);
});

test('② A-2 — 동기화 성공 뒤 보낸 원소만 지운다(그 사이 앞이 잘렸어도 새 표본은 남는다)', async () => {
  const { _dropSentForTest: dropSent } = await import('../src/agent/focusMonWorker.js');
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ t: i }));
  const buf = mk(5); const sent = buf.slice();
  // 보내는 동안: trim 이 앞 2개를 지우고(상한) 새 표본 3개가 들어왔다
  buf.splice(0, 2); const fresh = mk(3); buf.push(...fresh);
  dropSent(buf, sent);
  assert.deepEqual(buf, fresh, '새 표본 3개는 남는다(예전 splice(0, 5) 는 새 표본 2개를 지웠다)');
  const b2 = mk(4); dropSent(b2, []);
  assert.equal(b2.length, 4);
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../src/agent/focusMonWorker.js'), 'utf8');
  assert.match(src, /dropSent\(samples, sendS\); dropSent\(procs, sendP\);/);
  assert.doesNotMatch(src, /samples\.splice\(0, sendS\.length\)/);
});
