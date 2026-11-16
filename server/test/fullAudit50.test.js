/**
 * 전체 점검 50회차(중앙↔엣지 통신 2차) 회귀.
 *  R1 엣지 결과 대기열 — 일괄 설치 · 준비 결과(20건)를 버리지 않는다(개수 상한 · 바이트 상한 · 버리면 콘솔) · 동기화당 실을 수 = 중앙 받는 수
 *  R2 credReport 는 등록부 · 계정 사본을 한 번만 만든다
 *  R3 자동 업그레이드는 실행 중인 집중 모니터링 root 작업을 기다린다
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fa50-'));
process.env.CONFIG_DIR = DIR;
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test('50회차 R1: 일괄 결과 20건을 버리지 않고 · 동기화당 실을 수가 중앙 받는 수와 같다', async () => {
  const W = await import('../src/agent/focusMonWorker.js');
  const S = await import('../src/focusmon/audit/service.js');
  for (let i = 0; i < 20; i++) W.queueAuditResult(`run-${i}`, { mode: 'run', ok: false, kind: 'key-stopped', ready: [], out: [] });
  const first = W.auditResultsToSend();
  assert.equal(first.length, W.AUDIT_RESULTS_PER_SYNC);
  assert.equal(W.AUDIT_RESULTS_PER_SYNC, S.RESULTS_PER_SYNC, '엣지가 싣는 수와 중앙이 받는 수가 같다(넘는 것은 다음 동기화)');
  assert.equal(first[0].runId, 'run-0', '가장 오래된 결과부터 — 버리지 않았다');
});

test('50회차 R2: credReport 는 사본(servers · accounts)을 대상마다 넘긴다 — 대상마다 등록부를 다시 복사하지 않는다', async () => {
  const W = await import('../src/agent/focusMonWorker.js');
  const seen = [];
  W._setKnownForTest([{ id: 'a', host: '10.0.0.1' }, { id: 'b', host: '10.0.0.2' }]);
  W.credReport(Date.now(), (t, o) => { seen.push(o); return { state: 'noentry' }; });
  assert.equal(seen.length, 4);
  assert.ok(seen.every((o) => Array.isArray(o.servers) && Array.isArray(o.accounts)), JSON.stringify(seen[0]));
  assert.ok(seen.every((o) => o.servers === seen[0].servers), '같은 사본 하나');
  W._setKnownForTest([]);
});

test('50회차 R3: 실행 중인 집중 모니터링 작업을 업그레이드 대기 목록에 싣는다', async () => {
  const { createAuditRunner } = await import('../src/focusmon/audit/runner.js');
  const { runningAuditWork } = await import('../src/focusmon/audit/inflight.js');
  let release;
  const r = createAuditRunner({ keys: {}, onResult: () => {}, exec: () => new Promise((res) => { release = res; }) });
  r.submit({ runId: 'r1', mode: 'run', target: { id: 't1', host: '10.0.0.9' } });
  const w = runningAuditWork().filter((x) => x.key === 'focusmon:r1');
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'focusmon');
  assert.match(w[0].label, /디스크 점검/);
  release({ mode: 'run', ok: true, ready: [], out: [] });
  await new Promise((r2) => setImmediate(r2));
  assert.equal(runningAuditWork().filter((x) => x.key === 'focusmon:r1').length, 0, '끝나면 빠진다');
  const mg = fs.readFileSync(new URL('../src/upgrade/manager.js', import.meta.url), 'utf8');
  assert.match(mg, /\.\.\.focusMonWork\(\)\]/);
  assert.match(mg, /NON_SCAN_KINDS = new Set\(\[[^\]]*'focusmon'/);
});
