// v2.668 — iDRAC 통합 추이: 매칭된 ESXi 호스트의 GPU 사용률·GPU 메모리 점유(특수 기능 GPU 모니터링 적재값 gpu_util·gpu_mem)를
// 별도 계열(hostGpuPct·hostGpuMemPct)로 싣는다. iDRAC 계열(cpuPct·gpuTemp)에는 섞지 않는다. 새 수집은 없다(읽기만).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'idractrend2668-'));
process.env.CONFIG_DIR = DIR;
process.env.TEMP_DB_PATH = path.join(DIR, 'host-temp.db');
process.env.IDRAC_DB_PATH = path.join(DIR, 'idrac-power.db');
process.env.AUTH_ENABLED = 'false';
process.env.DATA_SOURCE = 'mock';

const { HOST_GPU_METRICS, hostHasGpu } = await import('../src/routes/admin/idracTrend.js');
const { store } = await import('../src/store.js');
const { getMetricsDb } = await import('../src/metrics/db.js');

const MIN = 60_000;

test('① 계열 이름 — GPU 모니터링이 적재하는 호스트 계열 그대로', () => {
  assert.deepEqual({ ...HOST_GPU_METRICS }, { hostGpuPct: 'gpu_util', hostGpuMemPct: 'gpu_mem' });
  const src = fs.readFileSync(new URL('../src/metrics/sampler.js', import.meta.url), 'utf8');
  for (const m of Object.values(HOST_GPU_METRICS)) assert.ok(src.includes(`metric: '${m}', k: h`) || src.includes(`metric: '${m}', k,`) || src.includes(`metric: '${m}', k: h.id`), `샘플러가 ${m} 을 호스트 id 로 적재한다`);
});

test('② hostHasGpu — 모르면 null(단정하지 않는다)', () => {
  const hosts = [{ id: 'a', gpus: [{}] }, { id: 'b', gpus: [] }, { id: 'c' }];
  assert.equal(hostHasGpu({ id: 'a' }, hosts), true);
  assert.equal(hostHasGpu({ id: 'b' }, hosts), false);
  assert.equal(hostHasGpu({ id: 'c' }, hosts), null);
  assert.equal(hostHasGpu({ id: 'zz' }, hosts), null);
  assert.equal(hostHasGpu(null, hosts), null);
});

test('③ 라우트 — 매칭 호스트의 GPU 값이 별도 계열로 실리고 iDRAC 계열에는 섞이지 않는다 · CSV 열', async () => {
  await store.refresh({ force: true });
  const h = (store.get().hosts || []).find((x) => x.connectionState !== 'DISCONNECTED');
  assert.ok(h, '목 호스트');
  const db = await getMetricsDb();
  const now = Date.now();
  db.insertMany([{ metric: 'gpu_util', k: h.id, v: 63 }, { metric: 'gpu_mem', k: h.id, v: 41.5 }], now - 5 * MIN);

  const { addServer } = await import('../src/idrac/registry.js');
  addServer({ id: 'esx-gpu', name: `${String(h.name).split('.')[0]}.idrac.example`, host: '10.0.0.78', username: 'root', password: 'x' });
  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express(); app.use(express.json()); app.use('/api/admin', adminRouter);
  const srv = app.listen(0); await new Promise((ok) => srv.once('listening', ok));
  const base = `http://127.0.0.1:${srv.address().port}/api/admin`;
  try {
    const t = await (await fetch(`${base}/idrac/esx-gpu/trend?range=1h`)).json();
    assert.equal(t.ok, true);
    assert.equal(t.kind, 'esxi');
    assert.equal(t.hostGpu.hostId, h.id);
    assert.ok(Number.isFinite(t.hostGpu.firstTs.hostGpuPct), '첫 적재 시각');
    assert.ok(t.points.some((p) => p.hostGpuPct === 63), 'GPU 사용률 계열');
    assert.ok(t.points.some((p) => p.hostGpuMemPct === 41.5), 'GPU 메모리 계열');
    assert.ok(t.points.every((p) => p.cpuPct === null && p.gpuTemp === null), 'iDRAC 계열에는 섞이지 않는다');
    const csv = await (await fetch(`${base}/idrac/trend/export.csv?scope=server&id=esx-gpu&range=1h`)).text();
    assert.ok(csv.includes('ESXi 호스트 GPU 사용률(%)') && csv.includes('ESXi 호스트 GPU 메모리(%)'), 'CSV 열');
    // 매칭 없는 베어메탈에는 hostGpu 가 없다
    addServer({ id: 'bm-nogpu', name: 'no-such-host-zz', host: '10.0.0.79', username: 'root', password: 'x' });
    const b = await (await fetch(`${base}/idrac/bm-nogpu/trend?range=1h`)).json();
    assert.equal(b.hostGpu, null);
    assert.ok(b.points.every((p) => p.hostGpuPct === null));
  } finally { srv.close(); }
});
