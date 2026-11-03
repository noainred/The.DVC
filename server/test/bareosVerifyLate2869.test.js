/**
 * test/bareosVerifyLate2869.test.js — v2.869 감사 A2-03: 시한으로 닫힌 복원 검증 작업의 늦은 회신을 원장에 반영한다.
 *   예전(추론 · 코드): reapOps 가 실패로 닫으면 훅이 { nic:'failed', verify:'failed' } 를 쓰고, 엣지의 늦은 회신(ackOp → finishOp late)은
 *   sameOp 가 cur.nic !== 'pending' 이라 버렸다 — 엣지가 실제로 성공한 검증이 '실패' 로 남았다(안전 방향이지만 거짓).
 *   재시도(다른 opId)가 나간 뒤에 온 옛 작업의 늦은 회신은 여전히 버린다(새 시도를 덮지 않게).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareos2869late-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
const registry = await import('../src/bareos/registry.js');
await import('../src/bareos/restoreFinish.js');   // 훅 등록
const { finishOp } = await import('../src/vmclone/dispatch.js');
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const NOW = Date.now();
const op = (id, rid) => ({ id, kind: 'bareos-verify', where: 'edge', agent: 'edge-kr', by: 'bareos-rehearsal', vcenterId: 'vc-a', vmName: 'web-01-verify', createdAt: NOW - 60_000, spec: { bareosJobId: 'j1', rid, name: 'web-01-verify' } });
function seed(finishByRid) {
  fs.writeFileSync(path.join(tmp, registry.FILE_NAME), JSON.stringify({ version: 1, jobs: [
    { id: 'j1', vcenterId: 'vc-a', vmId: 'vc-a:vm-1', vmName: 'web-01', bareosJob: 'pv-a', restores: Object.entries(finishByRid).map(([rid, finish]) => (
      { jobid: Number(rid), status: 'T', state: 'ok', nic: 'disconnect', verify: true, deleteOnOk: true, mode: 'newVm', target: { name: 'web-01-verify' }, at: NOW, finish })) },
  ], retired: [] }));
  registry._resetForTest();
}
const fin = (rid) => registry.getJob('j1').restores.find((r) => r.jobid === rid).finish;

test('시한으로 닫힌 같은 작업의 늦은 성공 회신 → verify ok · late 표지', () => {
  seed({ 901: { nic: 'pending', opId: 'A', tries: 1, at: NOW - 60_000 } });
  const a = op('A', 901);
  finishOp(a, { ok: false, detail: '담당 엣지가 진행을 알리지 않았습니다' }, NOW);   // reapOps 와 같은 닫기
  assert.deepEqual([fin(901).nic, fin(901).verify], ['failed', 'failed']);
  finishOp(a, { ok: true, detail: 'Tools 응답 12초', toolsMs: 12_000, deleted: true }, NOW + 1000, { late: true });   // ackOp 의 늦은 회신
  const f = fin(901);
  assert.deepEqual([f.nic, f.verify, f.late, f.toolsMs, f.deleted, f.opId], ['ok', 'ok', true, 12_000, true, 'A']);
});

test('재시도(opId B)가 나간 뒤 옛 작업 A 의 늦은 회신은 버린다', () => {
  seed({ 902: { nic: 'pending', opId: 'B', tries: 2, at: NOW } });
  const a = op('A', 902); a.result = { ok: false, expired: true };
  finishOp(a, { ok: true, detail: 'late ok' }, NOW + 1000, { late: true });
  assert.deepEqual([fin(902).nic, fin(902).opId], ['pending', 'B']);
  // 다른 작업이 이미 닫은 기록(opId B 실패)도 A 의 늦은 회신이 덮지 않는다
  seed({ 903: { nic: 'failed', verify: 'failed', opId: 'B', at: NOW } });
  finishOp(op('A', 903), { ok: true, detail: 'late ok' }, NOW + 1000, { late: true });
  assert.deepEqual([fin(903).verify, fin(903).opId], ['failed', 'B']);
  // 늦은 회신이 아닌 두 번째 결과(같은 opId)는 끝난 기록을 덮지 않는다
  seed({ 904: { nic: 'ok', verify: 'ok', opId: 'C', at: NOW } });
  finishOp(op('C', 904), { ok: false, detail: 'dup' }, NOW + 1000);
  assert.equal(fin(904).verify, 'ok');
});
