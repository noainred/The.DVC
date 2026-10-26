import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// v2.760(점검 B-01 — 재현): RMA 잡 큐의 미완료 잡 수명.
//   엣지는 명령을 하나씩 돌고 그동안 폴하지 않는다(TAKE_MAX=1). 예전 prune 은 대기 잡을 '등록 + 15분' 에 지워
//   앞 잡 둘이 8분씩 걸리면 세 번째 잡이 인출되기 전에 사라졌고, 실행 중 잡도 '인출 + 15분' 에 지워
//   timeoutMs 900초(du-top) 잡의 실제 결과가 '모르는 잡' 으로 버려졌다.
process.env.CONFIG_DIR = process.env.CONFIG_DIR || fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'rma2760-'));
const J = await import('../src/rma/jobs.js');

// 기준 시각: 실제 시각을 정시 경계로 떨어뜨려 고정(docs/rules/common.md).
function withClock(fn) {
  const real = Date.now;
  const clock = { t: Math.floor(real() / 3_600_000) * 3_600_000 };
  Date.now = () => clock.t;
  try { return fn(clock); } finally { Date.now = real; J._resetRma(); }
}
const MIN = 60_000;

test('순서대로 도는 엣지 — 앞 잡이 오래 걸려도 뒤에 줄 선 잡은 지워지지 않는다', () => withClock((c) => {
  J._resetRma();
  J.noteHeartbeat('corpA', 'i1', {});
  const ids = ['/a', '/b', '/c'].map((p) => J.enqueueJob('corpA', { cmd: 'du-top', args: { path: p } }, { timeoutMs: 900_000, now: c.t }).reqId);
  for (let k = 0; k < 3; k++) {
    const got = J.takeJobs('corpA', 'i1', c.t);
    assert.equal(got.length, 1, `${k + 1}번째 잡이 인출돼야 한다(+${(c.t % 3_600_000) / MIN}분)`);
    assert.equal(got[0].reqId, ids[k]);
    c.t += 8 * MIN;   // 실행 8분 — 그동안 엣지는 폴(하트비트)하지 않는다
    assert.equal(J.setJobResult(got[0].reqId, { ok: true, stdout: 'ok' }), true);
  }
  assert.deepEqual(ids.map((id) => J.getJob(id).state), ['done', 'done', 'done']);
}));

test('timeoutMs ≥ 15분인 실행 중 잡 — 기한 전에는 지우지 않고 결과를 받는다', () => withClock((c) => {
  J._resetRma();
  J.noteHeartbeat('corpA', 'i1', {});
  const { reqId } = J.enqueueJob('corpA', { cmd: 'du-top', args: { path: '/a' } }, { timeoutMs: 900_000, now: c.t });
  J.takeJobs('corpA', 'i1', c.t);
  c.t += 15 * MIN + 5_000;   // 엣지 기한(900초) 직후 회신 — 중앙 기한(+유예 30초) 안
  assert.equal(J.getJob(reqId).state, 'running');
  assert.equal(J.setJobResult(reqId, { ok: false, timedOut: true, reason: 'timeout' }), true);
  assert.equal(J.getJob(reqId).state, 'done');
}));

test('법인이 영영 오지 않으면 대기 잡은 여전히 정리된다(유령 잡 방지)', () => withClock((c) => {
  J._resetRma();
  J.noteHeartbeat('corpB', 'i1', {});
  const { reqId } = J.enqueueJob('corpB', { cmd: 'du-top', args: { path: '/a' } }, { timeoutMs: 900_000, now: c.t });
  c.t += 14 * MIN;
  assert.equal(J.getJob(reqId).state, 'pending');
  c.t += 2 * MIN;
  assert.equal(J.getJob(reqId).state, 'unknown', '마지막 움직임에서 15분이 지나면 정리');
}));

test('계속 폴하는데 인출되지 않는 대기 잡도 절대 상한(PENDING_MAX_AGE)에서 정리된다', () => withClock((c) => {
  J._resetRma();
  J.noteHeartbeat('corpC', 'i1', {});
  // 온라인인 다른 인스턴스(i2) 전용 잡 — i1 은 가져가지 않고, i2 는 하트비트만 보내고 인출하지 않는다.
  J.noteHeartbeat('corpC', 'i2', {});
  const { reqId } = J.enqueueJob('corpC', { cmd: 'du-top', args: { path: '/a' } }, { timeoutMs: 60_000, instance: 'i2', now: c.t });
  for (let m = 0; m <= J.PENDING_MAX_AGE / MIN; m += 1) {
    c.t += MIN; J.noteHeartbeat('corpC', 'i1', {}); J.noteHeartbeat('corpC', 'i2', {});
    J.takeJobs('corpC', 'i1', c.t);
  }
  assert.equal(J.getJob(reqId).state, 'unknown');
}));
