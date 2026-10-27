/**
 * v2.762 그룹 C — v2.760 후속(RMA 대기 잡 서명·법인 움직임, 라이트사이징 KPI 합).
 *
 *  - H1(재현): 대기 잡 수명은 v2.760 부터 최대 6시간인데 서명은 등록 시각(issuedAt)에 고정이라, 서명 법인에서 10분 넘게 줄 선 잡이
 *    엣지 ±10분 창에 걸려 전부 거부됐다. 인출 때 issuedAt=인출 시각으로 다시 서명한다(비밀번호는 그때 조회 — 잡에 붙잡지 않는다).
 *    등록 서명이 지금 비밀번호로 재현될 때만 다시 서명하고(비밀번호가 바뀌었으면 원래 서명 그대로), 서명 잡의 절대 상한은 1시간.
 *  - H2(재현): '법인 움직임' 은 실제 인출 시도(takeJobs 까지 간 폴)·인출·엣지가 회신한 완료만. 하트비트(503 으로 돌려보낸 폴)·
 *    reaper 종결은 제외. takeJobs 는 인출 전에 정리한다(오래 멈춘 법인의 첫 폴이 수 시간 전 비멱등 잡을 가져가지 않게).
 *  - H4(재현): 회수 가능 RAM 은 더한 뒤 한 번 반올림(0.1 + 0.2 = 0.30000000000000004 금지).
 *
 * 기준 시각은 실제 시각을 정시로 내린 값(Date.now() 직접·고정 epoch 금지 — docs/rules/common.md). setJobResult 가 Date.now() 를
 * 쓰므로 각 테스트는 시계를 그 기준에 고정했다가 되돌린다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2762c-'));
process.env.DATA_SOURCE = 'live';
process.env.AGENT_NAME = 'corpA';

const J = await import('../src/rma/jobs.js');
const { signJob, verifyJob } = await import('../src/rma/signing.js');
const { setRmaPassword } = await import('../src/rma/agentSecrets.js');
const A = await import('../src/rma/agent.js');
const { computeRightsizing } = await import('../src/reports/rightsizing.js');

const HOUR = 3600_000; const MIN = 60_000;
const BASE = Math.floor(Date.now() / HOUR) * HOUR;

function withClock(fn) {
  const real = Date.now; const c = { t: BASE };
  Date.now = () => c.t;
  return Promise.resolve().then(() => fn(c)).finally(() => { Date.now = real; });
}

// routes/api/rma.js 와 같은 방식의 등록(issuedAt = 등록 시각, reqId 포함 서명).
function enqueueSigned(agent, secret, args, { timeoutMs = 900_000, now, cmd = 'du-top' } = {}) {
  const issuedAt = now;
  const spec = { cmd, args, timeoutMs, label: cmd, issuedAt };
  return J.enqueueJob(agent, spec, { timeoutMs, now, sign: secret ? (reqId) => signJob(secret, { reqId, agent, cmd: spec.cmd, args: spec.args, timeoutMs: spec.timeoutMs, issuedAt }) : null }).reqId;
}

test('H1 — 서명 법인: 8분짜리 du-top 3건이 줄을 서도 세 번째가 엣지에서 거부되지 않는다(인출 때 재서명)', () => withClock(async (c) => {
  J._resetRma(); setRmaPassword('corpA', 'pw-123');
  for (let k = 0; k < 3; k++) enqueueSigned('corpA', 'pw-123', { path: '/var/log' }, { now: c.t });
  const seen = [];
  for (let k = 0; k < 3; k++) {
    const [job] = J.takeJobs('corpA', 'i1', c.t);
    assert.ok(job, `job${k + 1} 인출`);
    assert.equal(job.issuedAt, c.t, '서명 시각은 인출 시각');
    const r = await A.handleJob(job, { password: 'pw-123', now: c.t, exec: async () => ({ ok: true, stdout: 'x', exitCode: 0 }) });
    seen.push(`${k + 1}:${r.ok}:${r.reason || ''}`);
    assert.equal(r.ok, true, `job${k + 1} (+${(c.t - BASE) / MIN}분) 거부: ${r.reason}`);
    J.setJobResult(job.reqId, r); c.t += 8 * MIN;
  }
  assert.equal(seen.length, 3);
}));

test('H1 — 재서명해도 재전송 창은 넓어지지 않는다(인출 시각 ±10분)', () => withClock((c) => {
  J._resetRma(); setRmaPassword('corpA', 'pw-123');
  enqueueSigned('corpA', 'pw-123', { path: '/a' }, { now: c.t });
  enqueueSigned('corpA', 'pw-123', { path: '/b' }, { now: c.t });
  const [first] = J.takeJobs('corpA', 'i1', c.t);
  J.setJobResult(first.reqId, { ok: true });
  c.t += 14 * MIN;
  const [job] = J.takeJobs('corpA', 'i1', c.t);
  assert.equal(verifyJob('pw-123', { ...job, agent: 'corpA' }, c.t).ok, true);
  assert.equal(verifyJob('pw-123', { ...job, agent: 'corpA' }, c.t + 11 * MIN).ok, false, '같은 서명을 11분 뒤 재전송하면 거부');
}));

test('H1 — 비밀번호가 바뀌었거나 등록 때 무서명이었으면 인출 때 새로 서명해 주지 않는다', () => withClock((c) => {
  J._resetRma(); setRmaPassword('corpB', 'old-pw');
  const signedId = enqueueSigned('corpB', 'old-pw', { path: '/a' }, { now: c.t, timeoutMs: 1000 });
  setRmaPassword('corpB', 'new-pw');
  const [j1] = J.takeJobs('corpB', 'i1', c.t + MIN);
  assert.equal(j1.reqId, signedId);
  assert.equal(j1.issuedAt, c.t, '원래 서명·발급 시각 그대로');
  assert.equal(verifyJob('new-pw', { ...j1, agent: 'corpB' }, c.t + MIN).ok, false, '새 비밀번호로 서명되지 않는다');
  J.setJobResult(j1.reqId, { ok: true });
  // 등록 때 무서명(비밀번호 없음)이던 잡은 나중에 비밀번호가 생겨도 서명하지 않는다.
  setRmaPassword('corpC', '');
  enqueueSigned('corpC', '', { path: '/a' }, { now: c.t });
  setRmaPassword('corpC', 'later-pw');
  const [j2] = J.takeJobs('corpC', 'i1', c.t + MIN);
  assert.equal(j2.sig, undefined);
}));

test('H1 — 서명 잡의 대기 절대 상한은 1시간(무서명은 6시간 그대로)', () => withClock((c) => {
  J._resetRma(); setRmaPassword('corpD', 'pw');
  J.enqueueJob('corpD', { cmd: 'du-top', args: { path: '/long' }, timeoutMs: 3 * HOUR }, { timeoutMs: 3 * HOUR, now: c.t });
  J.takeJobs('corpD', 'i1', c.t);                // 3시간짜리 실행 중 → 법인이 바쁘다(대기 잡을 지우지 않는다)
  const signed = enqueueSigned('corpD', 'pw', { path: '/s' }, { now: c.t });
  const plain = J.enqueueJob('corpD', { cmd: 'du-top', args: { path: '/p' }, timeoutMs: 900_000 }, { timeoutMs: 900_000, now: c.t }).reqId;
  c.t += 59 * MIN;
  assert.equal(J.getJob(signed).state, 'pending');
  c.t += 2 * MIN;
  assert.equal(J.getJob(signed).state, 'unknown', '서명 잡은 1시간 뒤 정리');
  assert.equal(J.getJob(plain).state, 'pending', '무서명 잡은 기존 상한(6시간)');
  assert.equal(J.PENDING_MAX_AGE_SIGNED, HOUR);
}));

test('H2 — 하트비트만 오는 법인(rma-poll 503)의 대기 잡은 15분 뒤 정리된다', () => withClock((c) => {
  J._resetRma();
  J.noteHeartbeat('corpE', 'i1', {});
  const id = J.enqueueJob('corpE', { cmd: 'svc-restart', args: {} }, { timeoutMs: 30_000, now: c.t }).reqId;
  for (let m = 0; m < 16; m++) { c.t += MIN; J.noteHeartbeat('corpE', 'i1', {}); }
  assert.equal(J.getJob(id).state, 'unknown', '하트비트는 줄이 움직였다는 증거가 아니다');
}));

test('H2 — 정리할 사람이 없었어도 오래 멈춘 법인의 첫 인출은 묵은 비멱등 잡을 가져가지 않는다', () => withClock((c) => {
  J._resetRma();
  J.noteHeartbeat('corpF', 'i1', {});
  J.takeJobs('corpF', 'i1', c.t);   // 손상 전 정상 폴
  const id = J.enqueueJob('corpF', { cmd: 'svc-restart', args: {} }, { timeoutMs: 30_000, now: c.t }).reqId;
  for (let m = 0; m < 300; m++) { c.t += MIN; J.noteHeartbeat('corpF', 'i1', {}); }   // 5시간 503(하트비트만)
  assert.deepEqual(J.takeJobs('corpF', 'i1', c.t).map((x) => x.reqId), [], `5시간 전 잡 ${id} 를 인출하면 안 된다`);
}));

test('H2 — 엣지가 인출 직후 죽으면 reaper 종결은 움직임이 아니다(뒤 잡은 기한 직후 정리)', () => withClock((c) => {
  J._resetRma();
  J.noteHeartbeat('corpG', 'i1', {});
  J.enqueueJob('corpG', { cmd: 'du-top', args: {} }, { timeoutMs: 900_000, now: c.t });
  const b = J.enqueueJob('corpG', { cmd: 'du-top', args: {} }, { timeoutMs: 900_000, now: c.t }).reqId;
  J.takeJobs('corpG', 'i1', c.t);
  let last = 0;
  for (let m = 1; m <= 40; m++) { c.t += MIN; if (J.getJob(b).state === 'pending') last = m; }
  assert.ok(last <= 16, `뒤 잡이 +${last}분까지 남았다(예전 +31분)`);
  assert.ok(last >= 15, '앞 잡 기한(15.5분) 동안은 줄이 움직이는 중이라 남는다');
}));

test('H2 — 엣지가 실제로 회신한 완료는 움직임이다(뒤 잡 유지)', () => withClock((c) => {
  J._resetRma();
  J.noteHeartbeat('corpH', 'i1', {});
  const a = J.enqueueJob('corpH', { cmd: 'du-top', args: {} }, { timeoutMs: 900_000, now: c.t }).reqId;
  const b = J.enqueueJob('corpH', { cmd: 'du-top', args: {} }, { timeoutMs: 900_000, now: c.t }).reqId;
  J.takeJobs('corpH', 'i1', c.t);
  c.t += 14 * MIN; assert.equal(J.setJobResult(a, { ok: true }), true);
  c.t += 10 * MIN;
  assert.equal(J.getJob(b).state, 'pending', '회신(+14분) 뒤 10분 — 아직 줄이 움직이는 중');
  const [job] = J.takeJobs('corpH', 'i1', c.t);
  assert.equal(job.reqId, b);
}));

test('H2 — takeJobs 까지 간 폴(빈 결과여도)은 움직임이다', () => withClock((c) => {
  J._resetRma();
  J.noteHeartbeat('corpI', 'i1', {}); J.noteHeartbeat('corpI', 'i2', {});
  const id = J.enqueueJob('corpI', { cmd: 'uptime', args: {} }, { timeoutMs: 30_000, instance: 'i2', now: c.t }).reqId;
  for (let m = 1; m <= 20; m++) {
    c.t += MIN; J.noteHeartbeat('corpI', 'i2', {});
    assert.deepEqual(J.takeJobs('corpI', 'i1', c.t), [], 'i2 전용 잡은 i1 이 가져가지 않는다');
  }
  assert.equal(J.getJob(id).state, 'pending', '법인이 계속 인출을 시도하는 중 — 15분 비활동 정리 대상이 아니다');
}));

test('H4 — 회수 가능 RAM 합은 더한 뒤 한 번 반올림한다', () => {
  const on = (id, memMB, cpu, cpuU, memU) => ({ id, name: id, vcenterId: 'vc', powerState: 'POWERED_ON', memMB, cpuCount: cpu, cpuUsagePct: cpuU, memUsagePct: memU });
  const r = computeRightsizing([on('idle1', 102.4, 1, 1, 5), on('ov1', 1228.8, 4, 10, 10)], () => null);
  assert.deepEqual([r.idle[0].reclaimRamGB, r.oversized[0].reclaimRamGB], [0.1, 0.2]);
  assert.equal(r.reclaimableRamGB, 0.3);
  assert.equal(String(r.reclaimableRamGB), '0.3');
});
