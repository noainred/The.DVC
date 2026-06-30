import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapMemo, snapCacheClear, weakEtag } from '../src/util/snapCache.js';

test('snapMemo: 같은 key는 캐시, 동시 호출은 single-flight(계산 1회)', async () => {
  snapCacheClear('t1');
  let calls = 0;
  const compute = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return { n: calls }; };
  // 동시 5회 호출 → 계산은 1회만.
  const [a, b, c, d, e] = await Promise.all([
    snapMemo('t1', 'k1', 60_000, compute), snapMemo('t1', 'k1', 60_000, compute),
    snapMemo('t1', 'k1', 60_000, compute), snapMemo('t1', 'k1', 60_000, compute),
    snapMemo('t1', 'k1', 60_000, compute),
  ]);
  assert.equal(calls, 1, '동시 동일 key는 계산 1회');
  assert.deepEqual(a, b); assert.deepEqual(c, d); assert.deepEqual(d, e);
  // 같은 key 재호출 → 캐시 히트(계산 안 늘어남).
  await snapMemo('t1', 'k1', 60_000, compute);
  assert.equal(calls, 1);
  // key 변경 → 재계산.
  await snapMemo('t1', 'k2', 60_000, compute);
  assert.equal(calls, 2);
});

test('snapMemo: ttl 만료 후 재계산', async () => {
  snapCacheClear('t2');
  let calls = 0;
  const compute = async () => { calls++; return calls; };
  await snapMemo('t2', 'k', 10, compute);
  await new Promise((r) => setTimeout(r, 25));
  await snapMemo('t2', 'k', 10, compute); // ttl(10ms) 지남 → 재계산
  assert.equal(calls, 2);
});

test('snapMemo: 계산 실패는 캐시에 남기지 않음', async () => {
  snapCacheClear('t3');
  await assert.rejects(() => snapMemo('t3', 'k', 60_000, async () => { throw new Error('boom'); }));
  let ok = 0;
  const v = await snapMemo('t3', 'k', 60_000, async () => { ok++; return 'ok'; });
  assert.equal(v, 'ok');
  assert.equal(ok, 1, '실패 후 재호출 시 다시 계산');
});

test('weakEtag: 같은 key 같은 ETag, 다른 key 다른 ETag', () => {
  assert.equal(weakEtag('abc|1'), weakEtag('abc|1'));
  assert.notEqual(weakEtag('abc|1'), weakEtag('abc|2'));
  assert.match(weakEtag('x'), /^W\/".+"$/);
});
