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

/* ── 51회차(50회차 수정 반증) ── */
test('51회차 #1 · #7: 중앙은 엣지가 이미 든 작업(대기 · 실행 · 보내는 중)만큼 새 배달을 줄인다(배압) · ACTIVE_MAX 는 엣지 대기열 + 결과보다 크다', async () => {
  const S = await import('../src/focusmon/audit/service.js');
  const W = await import('../src/agent/focusMonWorker.js');
  assert.ok(S.EDGE_INFLIGHT_MAX < 64, '엣지 결과 대기열(64)보다 작게');
  const src = fs.readFileSync(new URL('../src/focusmon/audit/service.js', import.meta.url), 'utf8');
  assert.match(src, /const deliverMax = Math\.min\(20, Math\.max\(0, EDGE_INFLIGHT_MAX - /);
  assert.match(src, /if \(jobs\.length >= deliverMax\) break;/);
  assert.ok(Number(/const ACTIVE_MAX = (\d+)/.exec(src)[1]) >= 200 + 64, 'ACTIVE_MAX ≥ 대기열 200 + 결과 64');
  assert.equal(W.AUDIT_RESULTS_PER_SYNC, S.RESULTS_PER_SYNC);
});

test('51회차 #8 · #9: 설치 · 준비 실행기는 이름대로 · 상한 넘김 문구에 집중 모니터링 작업', async () => {
  const { createAuditRunner } = await import('../src/focusmon/audit/runner.js');
  const { runningAuditWork } = await import('../src/focusmon/audit/inflight.js');
  let release;
  const r = createAuditRunner({ keys: {}, onResult: () => {}, kind: 'prep', exec: () => new Promise((res) => { release = res; }) });
  r.submit({ runId: 'p1', mode: 'run', target: { id: 't9', host: '10.0.0.9' } });
  assert.match(runningAuditWork().find((x) => x.key === 'focusmon:p1').label, /접속 준비/);
  release({ mode: 'run', ok: true, ready: [], out: [] });
  const mg = fs.readFileSync(new URL('../src/upgrade/manager.js', import.meta.url), 'utf8');
  assert.match(mg, /const fm = list\.filter\(\(x\) => x\.kind === 'focusmon'\)\.length;/);
  for (const f of ['agent/focusMonWorker.js', 'focusmon/audit/service.js']) {
    const s = fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    assert.match(s, /installExec\([^\n]*kind: 'install'/, f);
    assert.match(s, /prepExec\([^\n]*kind: 'prep'/, f);
  }
});

test('51회차 #6: 바이트 상한을 넘으면 가장 큰 결과부터 버린다(작은 결과를 지키려고)', async () => {
  const W = await import('../src/agent/focusMonWorker.js');
  const A = W._auditForTest(); A.reset();
  for (let i = 0; i < 10; i++) W.queueAuditResult(`s-${i}`, { mode: 'run', ok: false, kind: 'key-stopped', ready: [], out: [] });
  const big = { mode: 'run', ok: true, kind: 'done', ready: [], out: Array.from({ length: 900 }, () => 'z'.repeat(9000)) };   // ~8MB
  for (let i = 0; i < 4; i++) W.queueAuditResult(`b-${i}`, big);
  const ids = W._auditForTest().results.map((r) => r.runId);
  assert.equal(ids.filter((x) => x.startsWith('s-')).length, 10, `작은 결과 10건은 남는다: ${ids}`);
  A.reset();
});
