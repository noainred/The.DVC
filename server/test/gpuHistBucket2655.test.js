// v2.655 — GPU 추이 집계 단위(1분·10분·1시간·6시간). 실제 api 라우터를 띄워 본다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpuhist2655-'));
process.env.CONFIG_DIR = tmp;
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const MIN = 60_000;

test('① 단위를 고르면 그 단위로 집계하고, 안 고르면 예전처럼 기간으로 정한다', async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { store } = await import('../src/store.js');
  const { getMetricsDb } = await import('../src/metrics/db.js');
  const { GPU_HIST_BUCKETS, GPU_HIST_MAX_POINTS } = await import('../src/routes/api/toolsAnalytics.js');
  assert.deepEqual(Object.keys(GPU_HIST_BUCKETS), ['1m', '10m', '1h', '6h']);
  const db = await getMetricsDb();
  // 정시 −30분 기준(경계에서 떨어뜨린다 — v2.517 규약) 20분 동안 1분마다
  const base = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * MIN;
  for (let i = 0; i < 20; i++) db.insertMany([{ metric: 'gpu_util', k: 'hx', v: i }], base - (19 - i) * MIN);
  const prev = store.snapshot;
  store.snapshot = { ...(prev || {}), source: 'vcenter', vcenters: [{ id: 'vc-a' }], hosts: [{ id: 'hx', vcenterId: 'vc-a' }], vms: [] };
  const app = express(); app.use((req, _r, n) => { req.user = { username: 'u', role: 'admin' }; n(); }); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const get = async (p) => (await fetch(`http://127.0.0.1:${srv.address().port}${p}`)).json();
  try {
    const m1 = await get('/api/tools/gpu/history?level=host&key=hx&days=1&bucket=1m');
    assert.equal(m1.bucket, '1m'); assert.equal(m1.bucketMs, MIN); assert.equal(m1.limit, GPU_HIST_MAX_POINTS);
    assert.equal(m1.points.length, 20, '1분 단위면 1분 표본이 점마다 하나');
    assert.equal(m1.truncated, false);
    const m10 = await get('/api/tools/gpu/history?level=host&key=hx&days=1&bucket=10m');
    assert.equal(m10.bucketMs, 10 * MIN); assert.ok(m10.points.length >= 2 && m10.points.length <= 3);
    const h1 = await get('/api/tools/gpu/history?level=host&key=hx&days=1&bucket=1h');
    assert.equal(h1.bucketMs, 3_600_000);
    const h6 = await get('/api/tools/gpu/history?level=host&key=hx&days=7&bucket=6h');
    assert.equal(h6.bucketMs, 21_600_000);
    const auto = await get('/api/tools/gpu/history?level=host&key=hx&days=1&bucket=bogus');
    assert.equal(auto.bucket, 'auto'); assert.equal(auto.bucketMs, 3_600_000, '모르는 단위는 예전 규칙');
    assert.ok('sampleSec' in auto);
  } finally { srv.close(); store.snapshot = prev; }
});

test('② 점 상한을 넘는 조합은 최근 쪽만 주고 잘렸다고 밝힌다(데모 합성)', async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { store } = await import('../src/store.js');
  const prev = store.snapshot;
  store.snapshot = { ...(prev || {}), source: 'mock', vcenters: [{ id: 'vc-a' }], hosts: [{ id: 'hy', vcenterId: 'vc-a' }], vms: [] };
  const app = express(); app.use((req, _r, n) => { req.user = { username: 'u', role: 'admin' }; n(); }); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const r = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/tools/gpu/history?level=host&key=hy&days=7&bucket=1m`)).json();
    assert.equal(r.synthesized, true);
    assert.ok(r.points.length <= r.limit, '상한 이내');
    assert.equal(r.truncated, true); assert.ok(r.coveredSince > Date.now() - 7 * 86_400_000);
    const ok = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/tools/gpu/history?level=host&key=hy&days=1&bucket=1m`)).json();
    assert.equal(ok.truncated, false);
  } finally { srv.close(); store.snapshot = prev; }
});
