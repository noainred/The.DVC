/**
 * bareosFullAudit1.test.js — 전체 소스 점검 1회차(백업 · Bareos 서버) 확정분.
 *  ① B-1: 엣지가 시한 안에 '결과 모름'(필수 값 없음 · unknown:true)으로 회신한 작업은 늦은 회신 대기(_late)에 올리지 않는다
 *     — 그 회신이 마지막이라 15분 동안 자동 업그레이드(inflight.runningBareosWork)만 붙잡았다. 시한(abort)으로 닫은 작업은 그대로 올린다.
 *  ② B-2: 끝난 실행 목록(finishedRuns)에 덜 자세한 행(바이트 빈 칸)으로 먼저 들어간 실행은 뒤에 온 자세한 행으로 빈 칸만 채운다
 *     — 아는 값은 바꾸지 않는다 · 같은 행을 다시 받으면 쓰지 않는다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bareosfullaudit1-'));
process.env.DATA_SOURCE = 'mock';
const E = await import('../src/bareos/edgeOps.js');
const R = await import('../src/bareos/registry.js');
const { runningBareosWork } = await import('../src/bareos/inflight.js');
const { prevSameLevel } = await import('../src/routes/api/bareosLive.js');

const lateCount = () => runningBareosWork().filter((w) => w.key.startsWith('late:')).length;

test('① B-1 — 시한 안의 결과 모름 회신은 늦은 회신 대기에 남지 않는다 · 시한으로 닫은 작업은 남는다', async () => {
  E._resetForTest();
  const got = [];
  // (가) 엣지가 시한 안에 jobid 없이 성공을 회신 → 정제가 unknown 으로 바꾼다
  const p1 = E.enqueueEdgeOp({ id: 'dir_pl', agent: 'edge-pl', connSig: 's' }, 'runJob', { job: 'pv-pl-vm-1', level: 'Full' }, { onLate: (lr) => got.push(lr) });
  const t1 = E.takeEdgeOps('edge-pl', 5);
  assert.equal(t1.length, 1);
  assert.deepEqual(E.completeEdgeOp(t1[0].id, 'edge-pl', { ok: true, value: null }), { ok: true });
  const r1 = await p1;
  assert.equal(r1.unknown, true, '정제 결과는 결과 모름');
  assert.equal(E.lateView().length, 0, '회신을 받은 작업은 늦은 회신을 기다리지 않는다');
  assert.equal(lateCount(), 0, '자동 업그레이드를 붙잡지 않는다');
  // (나) 엣지가 시한 안에 unknown:true 로 직접 회신
  const p2 = E.enqueueEdgeOp({ id: 'dir_pl', agent: 'edge-pl', connSig: 's' }, 'restore', { jobid: 5, name: 'pv-pl-vm-1' }, { onLate: (lr) => got.push(lr) });
  const t2 = E.takeEdgeOps('edge-pl', 5);
  E.completeEdgeOp(t2[0].id, 'edge-pl', { ok: false, code: 'unknown', unknown: true, reason: 'Director 응답이 끊겼습니다' });
  assert.equal((await p2).unknown, true);
  assert.equal(E.lateView().length, 0);
  // 같은 id 로 다시 와도 늦은 회신으로 처리하지 않는다(모르는 id)
  assert.deepEqual(E.completeEdgeOp(t2[0].id, 'edge-pl', { ok: true, value: 9 }), { ok: true, stale: true });
  assert.equal(got.length, 0, 'onLate 는 불리지 않는다');
  // (다) 대조 — 부른 쪽 시한(abort)으로 닫은 가져간 작업은 늦은 회신을 기다린다(v2.824 P1 · v2.938 그대로)
  const ac = new AbortController();
  const p3 = E.enqueueEdgeOp({ id: 'dir_pl', agent: 'edge-pl', connSig: 's' }, 'runJob', { job: 'pv-pl-vm-2', level: 'Full' }, { signal: ac.signal, onLate: (lr) => got.push(lr) });
  E.takeEdgeOps('edge-pl', 5);
  ac.abort();
  assert.equal((await p3).unknown, true);
  assert.equal(E.lateView().length, 1, '시한으로 닫은 작업만 늦은 회신 대기');
  assert.equal(lateCount(), 1);
  E._resetForTest();
});

test('② B-2 — finishedRuns 의 빈 칸은 뒤에 온 자세한 행으로 채운다 · 아는 값은 그대로', () => {
  const id = R.addJob({ vcenterId: 'vc-pl', vmId: 'vc-pl:vm-9', vmName: 'web-9', directorId: 'dir_pl', bareosJob: 'pv-pl-vm-9', client: 'pl-fd', storage: 'File', pool: 'Full', dc: 'DC-PL', folder: '/web', createdBy: 't' }).id;
  const t0 = Date.parse('2026-11-01T01:00:00');
  // 대조용 list jobs 행 — 바이트 · 파일 수가 비어 온다(Bareos 스케줄이 돌린 실행)
  R.applyRunRow(id, { jobid: 100, status: 'T', level: 'I', startedAt: t0, endedAt: t0 + 600_000, bytes: null, files: null, errors: 0 });
  // 다음 실행이 시작돼 lastRun 이 그 실행으로 바뀐다
  R.applyRunRow(id, { jobid: 101, status: 'R', level: 'I', startedAt: t0 + 86_400_000, endedAt: null, bytes: null, files: null, errors: null });
  // 사람이 지난 실행(100)의 로그를 열어 자세한 행이 들어온다
  R.applyRunRow(id, { jobid: 100, status: 'T', level: 'I', startedAt: t0, endedAt: t0 + 600_000, bytes: 5_000_000, files: 12, errors: 0 });
  const j = R.getJob(id);
  const f = j.finishedRuns.find((x) => x.jobid === 100);
  assert.equal(f.bytes, 5_000_000, '빈 바이트를 채운다');
  assert.equal(j.lastRun.jobid, 101, 'lastRun 은 더 새 실행 그대로');
  const prev = prevSameLevel({ lastRun: j.lastRun, recentRuns: j.finishedRuns }, 'Incremental', 101);
  assert.ok(prev, '지난 같은 레벨 기준이 생긴다');
  assert.equal(prev.jobid, 100); assert.equal(prev.bytes, 5_000_000);
  // 아는 값은 덜 자세한 행 · 다른 값으로 바꾸지 않는다
  R.applyRunRow(id, { jobid: 100, status: 'T', level: 'I', startedAt: t0, endedAt: t0 + 600_000, bytes: null, files: null, errors: null });
  R.applyRunRow(id, { jobid: 100, status: 'T', level: 'I', startedAt: t0, endedAt: t0 + 600_000, bytes: 7, files: 1, errors: 3 });
  const f2 = R.getJob(id).finishedRuns.find((x) => x.jobid === 100);
  assert.equal(f2.bytes, 5_000_000); assert.equal(f2.errors, 0);
  assert.equal(R.getJob(id).finishedRuns.filter((x) => x.jobid === 100).length, 1, '중복 행을 만들지 않는다');
});
