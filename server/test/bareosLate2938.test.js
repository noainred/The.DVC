/**
 * bareosLate2938.test.js — 엣지 대행 '결과 모름' 뒤 늦은 실행·복원 회신을 원장에 넣는다(v2.938 · 제안 6번 — v2.824 '남긴 것').
 *  ① 단건·그룹 실행: 늦은 jobid → pending · 이미 다른 실행이 있으면 덮지 않는다 · 실패·모름 회신은 아무것도 바꾸지 않는다 · 더 새 결과가 있으면 하지 않는다
 *  ② 복원: 같은 묶음의 '결과 모름' 행만 열린 복원(queued · jobid)으로 · 다른 묶음·이미 채운 행·같은 rid 는 하지 않는다
 *  ③ edgeOps 경로: 가져간 작업이 시한으로 '결과 모름' 이 된 뒤 같은 엣지의 회신이 오면 onLate 가 정제된 결과로 불린다 · 다른 엣지의 회신은 무시
 *  ④ 소스 스윕: 여섯 호출 지점(단건 실행 · 그룹 실행 · 단건 복원 · 묶음 복원 · 재해 복구 · 복원 검증)이 onLate 를 준다
 *  ⑤ 반증 반영: 여러 건은 원장을 한 번만 쓴다(B-1) · 보낸 뒤 다시 묶였거나 Director 가 바뀌면 반영하지 않는다(B-5) · 단건 복원 lateKey(B-2) · 리허설 deleteOnOk(B-3)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bareoslate2938-'));
process.env.DATA_SOURCE = 'mock';
const R = await import('../src/bareos/registry.js');
const L = await import('../src/bareos/lateReplies.js');

const mkJob = (n) => R.addJob({ vcenterId: 'vc-pl', vmId: `vc-pl:vm-${n}`, vmName: `web-${n}`, directorId: 'dir_pl', bareosJob: `pv-pl-vm-${n}`, client: 'pl-fd', storage: 'File', pool: 'Full', dc: 'DC-PL', folder: '/web', createdBy: 't' }).id;

test('① 실행 — 늦은 jobid 를 pending 으로 · 다른 실행·실패·모름·더 새 결과는 건드리지 않는다', () => {
  const a = mkJob(1); const b = mkJob(2); const c = mkJob(3);
  L.lateRunJob(a, { level: 'Full', by: 'kim', trigger: 'manual' })({ ok: true, value: 501 });
  const ja = R.getJob(a);
  assert.equal(ja.pending.jobid, 501); assert.equal(ja.pending.by, 'kim'); assert.equal(ja.pending.trigger, 'manual'); assert.equal(ja.pending.late, true, '반증 B-4: trigger 는 그대로 · late 표지');
  // 이미 다른 실행이 있으면 덮지 않는다
  R.markPending(b, { jobid: 600, level: 'Incremental', by: 'lee' });
  L.lateRunJob(b, {})({ ok: true, value: 590 });
  assert.equal(R.getJob(b).pending.jobid, 600);
  // 실패·모름 회신
  L.lateRunJob(c, {})({ ok: false, code: 'unknown' });
  L.lateRunJob(c, {})({ ok: true, value: null });
  assert.equal(R.getJob(c).pending ?? null, null);
  // 그룹 덩어리 — key 로 대상을 찾는다 · 성공 항목만
  const d = mkJob(4); const e = mkJob(5);
  L.lateRunJobs([d, e], { level: 'Full', by: '예약', trigger: 'group' })({ ok: true, value: [{ key: 0, ok: true, jobid: 701 }, { key: 1, ok: false, code: 'unknown' }, { key: 9, ok: true, jobid: 999 }] });
  assert.equal(R.getJob(d).pending.jobid, 701); assert.equal(R.getJob(d).pending.trigger, 'group'); assert.equal(R.getJob(d).pending.late, true);
  assert.equal(R.getJob(e).pending ?? null, null);
  assert.equal(L.applyLateRun('nope', 5), false);
});

test('② 복원 — 같은 묶음의 결과 모름 행만 열린 복원으로', () => {
  const a = mkJob(11); const b = mkJob(12);
  R.addRestore(a, { unknown: true, mode: 'newVm', target: { name: 'web-11-r' }, by: 'kim', client: 'pl-fd', batchId: 'B1' });
  R.addRestore(b, { unknown: true, mode: 'newVm', target: { name: 'web-12-r' }, by: 'kim', client: 'pl-fd', batchId: 'B2' });
  L.lateRestores([{ jobId: a, batchId: 'B1' }, { jobId: b, batchId: 'B1' }])({ ok: true, value: [{ key: 0, ok: true, rid: 881, chain: [10, 11] }, { key: 1, ok: true, rid: 882, chain: [] }] });
  const ra = R.getJob(a).restores[0];
  assert.equal(ra.jobid, 881); assert.equal(ra.state, 'queued'); assert.equal(ra.status, 'C'); assert.deepEqual(ra.fromJobids, [10, 11]); assert.equal(ra.unknown, undefined);
  assert.ok(R.restoreOpen(ra), '열린 복원 — 폴러가 추적한다'); assert.ok(ra.lateAt > 0);
  const rb = R.getJob(b).restores[0];
  assert.equal(rb.jobid, null, '다른 묶음(B2)의 결과 모름 행은 건드리지 않는다'); assert.equal(rb.state, 'unknown');
  // 다시 오면(같은 rid) 하지 않는다 · 실패 회신은 무시
  assert.equal(R.lateResolveRestore(a, 'B1', { rid: 881 }), null);
  L.lateRestores([{ jobId: b, batchId: 'B2' }])({ ok: true, value: [{ key: 0, ok: false, code: 'failed' }] });
  assert.equal(R.getJob(b).restores[0].state, 'unknown');
  assert.equal(R.lateResolveRestore(b, 'B2', { rid: 0 }), null);
});

test('③ edgeOps — 시한으로 결과 모름이 된 작업에 같은 엣지의 늦은 회신이 오면 onLate 가 정제된 결과로 불린다', async () => {
  const E = await import('../src/bareos/edgeOps.js');
  const got = [];
  const ac = new AbortController();
  const p = E.enqueueEdgeOp({ id: 'dir_pl', agent: 'edge-pl', connSig: 's' }, 'runJob', { job: 'pv-pl-vm-1', level: 'Full' }, { signal: ac.signal, onLate: (lr) => got.push(lr) });
  const taken = E.takeEdgeOps('edge-pl', 5);
  assert.equal(taken.length, 1);
  ac.abort();   // 부른 쪽 시한 — 가져간 상태 변경이라 '결과 모름'
  const r = await p;
  assert.equal(r.code, 'unknown'); assert.equal(r.unknown, true);
  assert.deepEqual(E.completeEdgeOp(taken[0].id, 'edge-other', { ok: true, value: 777 }), { ok: true, stale: true }, '다른 엣지의 회신은 무시');
  assert.equal(got.length, 0);
  const done = E.completeEdgeOp(taken[0].id, 'edge-pl', { ok: true, value: 777 });
  assert.equal(done.late, true);
  assert.equal(got.length, 1); assert.equal(got[0].ok, true); assert.equal(got[0].value, 777);
});

test('④ 소스 스윕 — 여섯 호출 지점이 onLate 를 준다', () => {
  const rd = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
  assert.match(rd('routes/api/bareosBackup.js'), /'runJob', \{ job: job\.bareosJob, level \}, \{ onLate: lateRunJob\(job\.id/);
  assert.match(rd('routes/api/bareosBackup.js'), /'restores', \{ items: sendItems \}, \{ signal: AbortSignal\.timeout\(RESTORES_DEADLINE_MS\), onLate: lateRestores\(/);
  assert.match(rd('bareos/groupRunner.js'), /onLate: lateRunJobs\(chunk\.map/);
  assert.match(rd('bareos/drRunner.js'), /onLate: lateRestores\(ready\.map/);
  assert.match(rd('bareos/rehearsal.js'), /onLate: lateRestores\(ready\.map/);
  // 반증 B-2: 단건 복원 — onLate 와 결과 모름 행의 lateKey
  const bb = rd('routes/api/bareosBackup.js');
  assert.match(bb, /'restore', \{ jobid, name: job\.bareosJob[^\n]*\{ onLate: lateRestoreOne\(job\.id, lateKey\) \}/);
  assert.match(bb, /addRestore\(job\.id, \{ unknown: true, fromJobids: \[jobid\][^\n]*lateKey \}\)/);
  // 반증 B-3: 리허설 결과 모름 행 두 곳 모두 deleteOnOk
  const rh = rd('bareos/rehearsal.js');
  const unk = rh.split('\n').filter((l) => /addRestore\([^\n]*unknown: true/.test(l));
  assert.equal(unk.length, 2); for (const l of unk) assert.match(l, /deleteOnOk: policy\.deleteOnOk/);
});

test('⑤ 반증 B-1 · B-5 · B-2 — 묶어 한 번 쓰기 · 다시 묶인 대상 · 단건 복원 lateKey', async () => {
  // B-1: 그룹 회신 여러 건은 inBatch 로 묶어 원장을 한 번만 쓴다(쓰기 횟수는 ESM 이라 가로채지 않고 소스로 고정 — 실측은 반증 보고 411ms → 8ms)
  const ids = [mkJob(21), mkJob(22), mkJob(23), mkJob(24)];
  L.lateRunJobs(ids, { level: 'Full', trigger: 'group' })({ ok: true, value: ids.map((_, k) => ({ key: k, ok: true, jobid: 900 + k })) });
  for (const [k, id] of ids.entries()) assert.equal(R.getJob(id).pending.jobid, 900 + k);
  assert.equal(R._dirtyForTest(), false, '묶음 끝에서 디스크까지 썼다');
  const src = fs.readFileSync(path.join(SRC, 'bareos/lateReplies.js'), 'utf8');
  assert.equal((src.match(/inBatch\(\(\) => \{/g) || []).length, 2, '그룹 실행 · 묶음 복원 둘 다 inBatch');

  // B-5: 보낸 뒤 다시 묶이면(runsEpoch) 옛 번호를 넣지 않는다 — 실행 · 복원 둘 다
  const a = mkJob(31);
  const late = L.lateRunJob(a, { trigger: 'manual' });
  await new Promise((r) => setTimeout(r, 5));
  R.rebindJobs([{ id: a, bareosJob: `pv-new-${a}`, client: 'pl-fd', storage: 'File', pool: 'Full' }], { restart: true });   // 재설치 — 새 카탈로그
  late({ ok: true, value: 1234 });
  assert.equal(R.getJob(a).pending ?? null, null, '다시 묶인 뒤의 늦은 회신은 반영하지 않는다');
  // 카탈로그가 그대로인 다시 묶기(restart 아님)는 같은 번호 체계라 반영한다
  const b = mkJob(32);
  const lateB = L.lateRunJob(b, {});
  R.rebindJobs([{ id: b, bareosJob: `pv-same-${b}`, client: 'pl-fd', storage: 'File', pool: 'Full' }], { restart: false });
  lateB({ ok: true, value: 1235 });
  assert.equal(R.getJob(b).pending.jobid, 1235);
  // 복원
  const c = mkJob(33);
  R.addRestore(c, { unknown: true, mode: 'newVm', target: { name: 'c-r' }, by: 't', client: 'pl-fd', batchId: 'B9' });
  const lateC = L.lateRestores([{ jobId: c, batchId: 'B9' }]);
  await new Promise((r) => setTimeout(r, 5));
  R.rebindJobs([{ id: c, bareosJob: `pv-new-${c}`, client: 'pl-fd', storage: 'File', pool: 'Full' }], { restart: true });
  lateC({ ok: true, value: [{ key: 0, ok: true, rid: 4321, chain: [] }] });
  assert.equal(R.getJob(c).restores[0].state, 'unknown');

  // B-2: 단건 복원 — lateKey 로 그 행만 연다 · batchId 는 달지 않는다
  const d = mkJob(34);
  R.addRestore(d, { unknown: true, mode: 'newVm', target: { name: 'd-r' }, by: 't', client: 'pl-fd', lateKey: 'rs-1' });
  R.addRestore(d, { unknown: true, mode: 'newVm', target: { name: 'd-r2' }, by: 't', client: 'pl-fd', lateKey: 'rs-2' });
  L.lateRestoreOne(d, 'rs-1')({ ok: true, value: { rid: 5555, chain: [3] } });
  const rs = R.getJob(d).restores;
  const r1 = rs.find((x) => x.lateKey === 'rs-1'); const r2 = rs.find((x) => x.lateKey === 'rs-2');
  assert.equal(r1.jobid, 5555); assert.equal(r1.state, 'queued'); assert.equal(r1.batchId, undefined);
  assert.equal(r2.state, 'unknown');
  L.lateRestoreOne(d, 'rs-2')({ ok: true, value: { rid: 0 } });
  assert.equal(R.getJob(d).restores.find((x) => x.lateKey === 'rs-2').state, 'unknown');
});
