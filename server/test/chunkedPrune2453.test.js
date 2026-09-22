// 대량 prune 이 이벤트 루프를 막지 않는지 회귀 고정 — v2.453 (운영 장애 재발 방지).
//
// 무슨 일이 있었나: v2.451 이 온도 원본 보존을 기본 90일로 켰다. 5년치가 쌓인 34.3GB DB 에서
// **수억 행이 한 번에 삭제 대상**이 됐고, metrics 샘플러의 prune 스로틀이 `% 20 === 1` 이라
// **기동 후 첫 샘플에서 즉시** 그 DELETE 가 돌았다. node:sqlite 는 동기 API 뿐이라 프로세스
// 전체가 멈췄다 — 서비스는 `active (running)`, 포트는 LISTEN 인데 accept 큐가 백로그(511)를
// 넘겨 가득 차고(`ss` Recv-Q 512) 웹은 ERR_CONNECTION_TIMED_OUT, 로그도 그 시점에서 끊겼다.
//
// 세 겹으로 막는다. 아래 테스트가 그 세 가지를 각각 고정한다:
//   ① 삭제를 청크로 끊고 청크 사이에 이벤트 루프를 양보한다(util/chunkedPrune.js)
//   ② prune 스로틀이 기동 직후에 걸리지 않는다(`% N === 0`)
//   ③ 과거 데이터를 대량 삭제하는 동작은 기본으로 켜지 않는다(rawRetentionDays 기본 0)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkedDelete, shouldContinuePrune, PRUNE_CHUNK_ROWS, PRUNE_MAX_ROWS } from '../src/util/chunkedPrune.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

/** 남은 행 수를 흉내내는 가짜 준비문. run(...args, limit) 로 호출된다. */
function fakeStmt(remaining) {
  let left = remaining;
  const calls = [];
  return {
    calls,
    run: (...args) => {
      const limit = args[args.length - 1];
      calls.push(limit);
      const n = Math.min(left, limit);
      left -= n;
      return { changes: n };
    },
    get left() { return left; },
  };
}

test('청크로 끊어 지운다 — 한 방 DELETE 가 아니다', async () => {
  const st = fakeStmt(50_000);
  const r = await chunkedDelete(st, [123], { chunk: 10_000, maxRows: 0 });
  assert.equal(r.deleted, 50_000);
  assert.equal(r.chunks, 6, '10,000씩 5회 + 0건 1회');
  assert.deepEqual(st.calls.slice(0, 2), [10_000, 10_000], 'LIMIT 이 청크 크기로 들어간다');
});

test('청크 사이에 이벤트 루프를 양보한다(다른 작업이 끼어들 수 있다)', async () => {
  const st = fakeStmt(30_000);
  // ⚠ v2.581 — 이 테스트의 플래키 원인(CLAUDE.md '원인 미확정' 이던 것)을 실측으로 확정했다.
  //   예전 프로브는 `setInterval(fn, 0)` 이었는데 그 간격의 하한은 **1ms** 다. 30청크 루프는 setImmediate
  //   양보 30회라 워밍업된 프로세스에서는 **0.06ms(p50)** 에 끝난다 — 즉 타이머가 한 번도 만기되지 않아
  //   interleaved=0 으로 **실패**한다(단독 300회 실측: 269회 실패). 하니스 안에서는 콜드 실행이라 ~2ms 가
  //   걸려 2회 발화했고 그래서 '가끔' 만 깨졌다. 판정이 벽시계에 매달려 있던 것이 결함이다(제품은 정상).
  //   지금은 setImmediate 로 자기를 다시 거는 프로브를 쓴다 — 양보가 setImmediate 이므로 청크마다
  //   **반드시** 한 번씩 끼어든다(결정적). 양보가 사라지면 프로브는 루프가 끝난 뒤에야 처음 돌아 0 이다.
  let interleaved = 0;
  let stop = false;
  const probe = () => { if (stop) return; interleaved++; setImmediate(probe); };
  setImmediate(probe);
  await chunkedDelete(st, [1], { chunk: 1_000, maxRows: 0 });
  stop = true;
  // 양보가 없으면 루프가 끝날 때까지 프로브가 한 번도 못 돈다 — 이 값이 0 이면 회귀다.
  assert.ok(interleaved > 0, `삭제 도중 다른 작업이 실행되지 못했다(interleaved=${interleaved})`);
  assert.ok(interleaved >= 25, `청크 30개 사이에 최소 25회는 끼어들어야 한다(interleaved=${interleaved})`);
});

test('상한에서 멈추고 남은 것을 알린다 — 다음 주기가 이어서 지운다', async () => {
  const st = fakeStmt(1_000_000);
  const r = await chunkedDelete(st, [1], { chunk: 10_000, maxRows: 50_000 });
  assert.equal(r.deleted, 50_000, '상한을 넘겨 지우지 않는다');
  assert.equal(r.done, false, '남은 것이 있음을 알린다');
  assert.equal(st.left, 950_000);
  // 다음 주기가 이어서 지운다.
  const r2 = await chunkedDelete(st, [1], { chunk: 10_000, maxRows: 50_000 });
  assert.equal(r2.deleted, 50_000);
  assert.equal(st.left, 900_000);
});

test('지울 게 없으면 즉시 끝난다(빈 DB 에서 낭비하지 않는다)', async () => {
  const st = fakeStmt(0);
  const r = await chunkedDelete(st, [1], { chunk: 10_000 });
  assert.equal(r.deleted, 0);
  assert.equal(r.chunks, 1);
  assert.equal(r.done, true);
});

test('shouldContinuePrune — 순수 판정', () => {
  assert.equal(shouldContinuePrune(0, 0, 1000), false, '0건 삭제면 끝');
  assert.equal(shouldContinuePrune(100, 100, 1000), true);
  assert.equal(shouldContinuePrune(100, 1000, 1000), false, '상한 도달');
  assert.equal(shouldContinuePrune(100, 10_000, 0), true, '상한 0 = 무제한');
  assert.ok(PRUNE_CHUNK_ROWS >= 500 && PRUNE_MAX_ROWS >= 0);
});

test('SQL 은 rowid 서브쿼리 + LIMIT 이다(DELETE ... LIMIT 컴파일 옵션에 의존하지 않게)', () => {
  for (const [file, table] of [['metrics/db.js', 'samples'], ['idrac/db.js', 'power_samples']]) {
    const t = read(file);
    const re = new RegExp(`DELETE FROM ${table} WHERE rowid IN \\(SELECT rowid FROM ${table} WHERE [a-z_]+ < \\? LIMIT \\?\\)`);
    assert.match(t, re, `${file} 의 ${table} prune 이 청크 형태가 아니다`);
    // 한 방 DELETE 가 되살아나지 않게 고정한다.
    assert.ok(!new RegExp(`DELETE FROM ${table} WHERE [a-z_]+ < \\?'`).test(t),
      `${file} 에 한 방 DELETE 가 남아 있다`);
  }
});

test('prune 호출부는 await 한다(부동 프로미스 금지)', () => {
  // async 로 바뀐 prune 을 await 없이 부르면 실패가 unhandledRejection 으로 새고
  // 다음 주기와 겹쳐 돈다(같은 DB 에 두 삭제 루프).
  for (const f of ['metrics/sampler.js', 'idrac/poller.js', 'store.js']) {
    const t = read(f);
    for (const line of t.split('\n')) {
      if (/\bdb\.prune\(/.test(line)) {
        assert.match(line, /await db\.prune\(/, `${f}: await 없이 db.prune 호출 — ${line.trim()}`);
      }
    }
  }
});

test('prune 스로틀이 기동 직후에 걸리지 않는다', () => {
  // `% N === 1` 이면 카운터가 1 인 **첫 틱**에서 실행된다 — 기동 직후 대량 삭제의 직접 원인이었다.
  const t = read('metrics/sampler.js');
  const m = /_pruneTicks % (\d+) === (\d+)/.exec(t);
  assert.ok(m, 'metrics 샘플러의 prune 스로틀을 찾지 못했다');
  assert.equal(m[2], '0', `첫 틱에서 prune 이 돌면 안 된다(% ${m[1]} === ${m[2]})`);
  const ti = /pruneTick % (\d+) === (\d+)/.exec(read('idrac/poller.js'));
  assert.ok(ti && ti[2] === '0', 'idrac 폴러도 첫 틱을 피해야 한다');
});

test('과거 원본 대량 삭제는 기본으로 켜지 않는다(업그레이드가 조용히 시작하면 안 된다)', async () => {
  const { config } = await import('../src/config.js');
  assert.equal(config.temp.rawRetentionDays, 0,
    '기본 0(끔)이어야 한다 — v2.451 의 기본 90 이 34.3GB DB 에서 운영 장애를 냈다');
  assert.equal(config.idrac.rawRetentionDays, 0);
  // 롤업 보존은 그대로여야 한다(장기 추이는 유지).
  assert.equal(config.temp.retentionDays, 1830);
  assert.equal(config.idrac.retentionDays, 90);
});

test('dead-band(변화분만 저장)는 기본으로 계속 동작한다 — 파일이 더 커지지 않게', async () => {
  // 대량 삭제는 opt-in 으로 돌렸지만, '더 늘지 않게' 하는 쪽은 껐으면 안 된다.
  const { DEFAULT_POLICY, policyFromEnv } = await import('../src/metrics/deadband.js');
  assert.ok(DEFAULT_POLICY.temp.eps > 0 && DEFAULT_POLICY.power.eps > 0);
  assert.equal(policyFromEnv({}).temp.eps, DEFAULT_POLICY.temp.eps);
});
