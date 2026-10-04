// v2.689 G3 I2 — 이상 탐지·예측 캐시 키는 '계산이 읽는 인자를 클램프한 값' 이고, 계산은 전역 동시 1건이다.
//   ① 같은 인자 + 서로 다른 쓰레기 쿼리(`&_=난수`) 5개 동시 요청 → 캐시 키 1개(= 계산 1회 — 같은 키는 snapMemo 가 합류시킨다).
//      예전 키는 `req.originalUrl` 전체라 5개가 각자 계산했다.
//   ② 서로 다른 인자 3개 동시 요청 → 계산이 겹치지 않는다(peak 1).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g3ins2689-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';

let srv, base, snapCache, ins;
before(async () => {
  const express = (await import('express')).default;
  ins = await import('../src/routes/insights.js');
  snapCache = await import('../src/util/snapCache.js');
  const app = express();
  app.use((req, _res, next) => { req.user = { username: 'ins-g3', role: 'admin', scope: { vcenters: [], regions: [], writeVcenters: [] } }; next(); });
  app.use('/api/insights', ins.insightsRouter);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api/insights`;
});
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const get = async (p) => { const r = await fetch(base + p); await r.text(); return r.status; };

test('I2: /anomalies — 같은 인자 + 쓰레기 쿼리 5개 동시 → 캐시 키 1개(계산 1회)', async () => {
  snapCache.snapCacheClear('anomalies');
  const st = await Promise.all([1, 2, 3, 4, 5].map((i) => get(`/anomalies?windowHours=24&z=3.5&_=${i}&junk${i}=x`)));
  assert.deepEqual(st, [200, 200, 200, 200, 200]);
  assert.equal(snapCache._snapCacheStats('anomalies').entries, 1, '쓰레기 쿼리가 캐시 키를 나누면 안 된다');
  // 클램프 밖 값도 같은 키(168 초과 → 168)
  await get('/anomalies?windowHours=168&z=3.5');
  await get('/anomalies?windowHours=99999&z=3.5&_=9');
  assert.equal(snapCache._snapCacheStats('anomalies').entries, 2, '168 과 99999(→168) 는 같은 키');
});

test('I2: /forecast — 같은 인자 + 쓰레기 쿼리 5개 동시 → 캐시 키 1개', async () => {
  snapCache.snapCacheClear('forecast');
  const st = await Promise.all([1, 2, 3, 4, 5].map((i) => get(`/forecast?days=14&_=${i}&x${i}=1`)));
  assert.deepEqual(st, [200, 200, 200, 200, 200]);
  assert.equal(snapCache._snapCacheStats('forecast').entries, 1);
});

test('I2: 서로 다른 인자의 무거운 계산은 겹치지 않는다(전역 동시 1건)', async () => {
  snapCache.snapCacheClear('anomalies'); snapCache.snapCacheClear('forecast');
  ins._insightsHeavyStats({ reset: true });
  const st = await Promise.all([
    get('/anomalies?windowHours=10'), get('/anomalies?windowHours=11'), get('/anomalies?windowHours=12'),
    get('/forecast?days=20'), get('/forecast?days=21'),
  ]);
  assert.deepEqual(st, [200, 200, 200, 200, 200]);
  assert.equal(ins._insightsHeavyStats().peak, 1, '동시에 둘 이상 돌았다');
  assert.equal(ins._insightsHeavyStats().active, 0);
});

test('I2: runHeavyExclusive — 느린 계산 3개를 동시에 넣어도 한 번에 하나씩, 들어온 순서대로(실패해도 줄이 끊기지 않는다)', async () => {
  ins._insightsHeavyStats({ reset: true });
  const order = [];
  const slow = (id, fail = false) => () => new Promise((res, rej) => setTimeout(() => { order.push(id); if (fail) rej(new Error('x')); else res(id); }, 25));
  const ps = [ins.runHeavyExclusive(slow('a')), ins.runHeavyExclusive(slow('b', true)), ins.runHeavyExclusive(slow('c'))];
  const out = await Promise.allSettled(ps);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(out[0].value, 'a'); assert.equal(out[1].status, 'rejected'); assert.equal(out[2].value, 'c');
  assert.equal(ins._insightsHeavyStats().peak, 1);
});
