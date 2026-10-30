/**
 * test/bareosFix2822.test.js — v2.822 검토에서 확정한 결함 중 라우트 시험(bareosRoutes ⑩)에 넣기 어려운 것.
 *  I6: Bareos 원장의 실행 상태(pending·복원·Director 대조)는 '설정 변경 시 자동 백업' 지문을 바꾸지 않는다(대상 정의는 바꾼다).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bareos2822f-'));
const backup = await import('../src/backup/service.js');

test('I6: 실행 상태가 바뀌어도 설정 백업 지문은 같다 · 대상 정의가 바뀌면 달라진다', () => {
  const job = (over = {}) => ({ id: 'bj_1', vcenterId: 'vc-a', vmId: 'vc-a:vm-1', vmName: 'web', bareosJob: 'pv-1-vm-1', client: 'kr-fd', enabled: true, pending: null, lastRun: null, lastError: null, missingInDirector: false, restores: [], ...over });
  const fp = (j) => backup.settingsFingerprint({ 'bareos-jobs.json': JSON.stringify({ version: 1, jobs: [j], retired: [] }) });
  const base = fp(job());
  assert.equal(fp(job({ pending: { jobid: 9, since: 1, status: 'R', misses: 2 } })), base, 'markPending·상태 전이');
  assert.equal(fp(job({ restores: [{ jobid: 10, status: 'C', at: 1 }] })), base, 'addRestore');
  assert.equal(fp(job({ missingInDirector: true })), base, '대조');
  assert.equal(fp(job({ lastRun: { jobid: 9, status: 'T' }, lastError: { at: 1, message: 'x' } })), base, 'last* 는 원래 빠진다');
  assert.notEqual(fp(job({ enabled: false })), base, '활성 여부는 설정');
  assert.notEqual(fp(job({ bareosJob: 'pv-1-vm-1-r2' })), base, '잡 이름은 설정');
});

test('C2-2(v2.822.3): 포탈 실행이 끝날 때 더 큰 jobid 가 이미 lastRun 이어도 그 결과가 원장(finishedRuns)에 남는다 · 실행 상태라 설정 지문은 그대로', async () => {
  const registry = await import('../src/bareos/registry.js');
  registry._resetForTest();
  const j = registry.addJob({ vcenterId: 'vc-a', vmId: 'vc-a:vm-1', vmName: 'web', dc: 'DC', folder: '/', bareosJob: 'pv-1-vm-1', client: 'kr-fd', storage: 's', pool: 'p' });
  registry.markPending(j.id, { jobid: 590, level: 'I', by: 't' });
  const row = (jobid, status) => ({ jobid, status, type: 'B', level: 'I', startedAt: null, endedAt: null, bytes: null, files: null, errors: status === 'f' ? 1 : 0 });
  registry.applyRunRow(j.id, row(600, 'C'));   // 대조가 대기 중인 스케줄 실행을 lastRun 으로
  registry.applyRunRow(j.id, row(590, 'f'));   // 포탈 실행이 실패로 끝남
  const g = registry.getJob(j.id);
  assert.equal(g.lastRun.jobid, 600, 'lastRun 은 더 큰 jobid 그대로');
  assert.equal(g.pending, null);
  assert.deepEqual(g.finishedRuns.map((x) => [x.jobid, x.state]), [[590, 'error']], '끝난 포탈 실행이 남는다');
  for (let i = 0; i < 15; i++) registry.applyRunRow(j.id, row(700 + i, 'T'));
  assert.equal(registry.getJob(j.id).finishedRuns.length, registry.FINISHED_KEEP, '최근 몇 건만');
  const fp = (x) => backup.settingsFingerprint({ 'bareos-jobs.json': JSON.stringify({ version: 1, jobs: [x], retired: [] }) });
  assert.equal(fp({ ...g, finishedRuns: [] }), fp(g), 'finishedRuns 는 설정 백업 지문에서 뺀다');
});
