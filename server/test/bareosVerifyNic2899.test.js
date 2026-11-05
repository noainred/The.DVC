/**
 * test/bareosVerifyNic2899.test.js — v2.899(점검 B2 — 재현): 복원 검증이 네트워크를 끊은 **뒤에** 실패(Tools 시한 · 켜기 · 끄기)하면
 *   원장 finish.nic 은 'ok'(끊김 확인)여야 한다. 예전에는 검증 실패면 늘 nic 'failed' 라 '네트워크 끊기 실패' 로 적고 세었다(재해 복구 사유 · 요약 메일).
 *   nicOff 를 모르는 옛 엣지 회신(필드 없음)은 예전 판정 그대로 — 끊었다고 지어내지 않는다.
 *   엣지 회신 경로(vmCloneWorker ack → 중앙 sanitizeReport → finishOp)가 nicOff 를 버리지 않는지도 본다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareos2899nic-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
const registry = await import('../src/bareos/registry.js');
await import('../src/bareos/restoreFinish.js');   // 훅 등록
const { finishOp, sanitizeReport } = await import('../src/vmclone/dispatch.js');
const { verifyRestoredVm } = await import('../src/vmclone/vsOps.js');
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const NOW = Date.now();
const op = (id, rid) => ({ id, kind: 'bareos-verify', where: 'edge', agent: 'edge-kr', by: 'bareos-rehearsal', vcenterId: 'vc-a', vmName: 'web-01-verify', createdAt: NOW - 60_000, spec: { bareosJobId: 'j1', rid, name: 'web-01-verify' } });
function seed(rids) {
  fs.writeFileSync(path.join(tmp, registry.FILE_NAME), JSON.stringify({ version: 1, jobs: [
    { id: 'j1', vcenterId: 'vc-a', vmId: 'vc-a:vm-1', vmName: 'web-01', bareosJob: 'pv-a', restores: rids.map((rid) => (
      { jobid: rid, status: 'T', state: 'ok', nic: 'disconnect', verify: true, deleteOnOk: true, mode: 'newVm', target: { name: 'web-01-verify' }, at: NOW, finish: { nic: 'pending', opId: `op-${rid}`, tries: 1, at: NOW } })) },
  ], retired: [] }));
  registry._resetForTest();
}
const fin = (rid) => registry.getJob('j1').restores.find((r) => r.jobid === rid).finish;

test('B2: 끊기를 확인한 뒤의 검증 실패 → nic ok · verify failed', () => {
  seed([911, 912, 913]);
  finishOp(op('op-911', 911), { ok: false, detail: 'Tools 응답 없음(시한)', nicOff: true }, NOW);
  assert.deepEqual([fin(911).nic, fin(911).verify], ['ok', 'failed']);
  // 끊기 전 실패(nicOff false) · 옛 엣지(필드 없음)는 예전 판정 — 끊었다고 지어내지 않는다
  finishOp(op('op-912', 912), { ok: false, detail: 'VM 을 찾지 못했습니다', nicOff: false }, NOW);
  finishOp(op('op-913', 913), { ok: false, detail: '옛 엣지' }, NOW);
  assert.deepEqual([fin(912).nic, fin(913).nic], ['failed', 'failed']);
  // 문자열 'true' 는 참이 아니다(엣지가 보낸 값은 불리언만)
  seed([914]);
  finishOp(op('op-914', 914), { ok: false, detail: 'x', nicOff: 'true' }, NOW);
  assert.equal(fin(914).nic, 'failed');
});

test('B2: 엣지 회신 정제(sanitizeReport)가 nicOff 불리언을 싣고 그 밖은 버린다', () => {
  const r = sanitizeReport({ acks: [{ id: 'a1', ok: false, detail: 'd', nicOff: true }, { id: 'a2', ok: false, detail: 'd', nicOff: 'yes' }, { id: 'a3', ok: false, detail: 'd' }] });
  const by = Object.fromEntries((r.acks || []).map((a) => [a.id, a]));
  assert.equal(by.a1.nicOff, true);
  assert.equal('nicOff' in by.a2, false);
  assert.equal('nicOff' in by.a3, false);
});

test('B2: verifyRestoredVm 결과에 nicOff 가 실린다(데모 — 끊기 단계를 지나면 true, 이름이 없으면 false)', async () => {
  const none = await verifyRestoredVm('vc-a', '');
  assert.equal(none.nicOff, false);
  const r = await verifyRestoredVm('vc-a', 'web-01-verify', { deleteOnOk: false });
  assert.equal(r.nicOff, true);
});

test('B2: 실행 · 회신 경로 소스가 nicOff 를 버리지 않는다(execOp · vmCloneWorker)', () => {
  const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.match(src('../src/vmclone/execOp.js'), /nicOff: r\.nicOff === true/);
  assert.match(src('../src/agent/vmCloneWorker.js'), /typeof r\?\.nicOff === 'boolean' \? \{ nicOff: r\.nicOff \}/);
});
