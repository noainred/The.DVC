/**
 * v2.628 — 감사 LEFT2628-01·05 회귀(문서에 '남은 일' 로 적혀 있던 것).
 *  · 01: 샘플러 lastRun 의 적재 제외·부분 합(vmperfStale·staleSkipped·vmStatsSkipped)을 /tools/waste/history 가 싣는다 —
 *        전 함대 개수이므로 **전체 범위 계정에만**(범위 계정은 null).
 *  · 05: 법인 전산실 온도 '1d'(30분 버킷)는 dead-band 계열이라 db.historyStep 으로 빈 버킷을 채운다(1시간 이상은 롤업 그대로).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

test('LEFT2628-01 samplerWithheldOf — 적재 제외가 없으면 null, 있으면 개수만', async () => {
  const { samplerWithheldOf } = await import('../src/metrics/sampler.js');
  assert.equal(samplerWithheldOf(null), null);
  assert.equal(samplerWithheldOf({ at: 1, rows: 3, hostsWithTemp: 2 }), null, '제외가 없으면 0 칸을 늘어놓지 않는다');
  const r = samplerWithheldOf({
    at: 5, staleSkipped: { vcenters: 2, hosts: 4, datastores: 1, byReason: { maintenance: 1, stale: 1 } },
    vmperfStale: { vcenters: 1, totalWithheld: false, maintenanceExcluded: 1, totalPartial: true }, vmStatsSkipped: 7,
  });
  assert.deepEqual(r, { at: 5, staleVcenters: 2, byReason: { maintenance: 1, stale: 1 }, totalWithheld: false, totalPartial: true, maintenanceExcluded: 1, vmStatsSkipped: 7 });
  assert.equal(samplerWithheldOf({ vmperfStale: { vcenters: 1, totalWithheld: true } }).totalWithheld, true);
});

test('LEFT2628-01 /tools/waste/history — sampler 는 전체 범위 계정에만, 범위 계정은 null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2628d-'));
  const script = `
    const express = (await import('express')).default;
    const { store } = await import(${JSON.stringify(path.join(SRC, 'store.js'))});
    const sampler = await import(${JSON.stringify(path.join(SRC, 'metrics/sampler.js'))});
    const vcs = [{ id: 'r-maint', name: 'M', status: 'maintenance', maintenance: true }, { id: 'r-ok', name: 'O', status: 'connected' }];
    store.snapshot = {
      vcenters: vcs,
      hosts: vcs.map((vc) => ({ id: 'h-' + vc.id, vcenterId: vc.id, name: 'esx-' + vc.id, cluster: 'c1', cpuCores: 10, cpuTotalMhz: 20000, tempC: 31 })),
      vms: [], datastores: [], alarms: [],
    };
    await sampler._sampleOnceForTest();
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const mk = (scope) => { const app = express(); app.use((req, _r, n) => { req.user = { username: 'u', role: 'admin', scope }; n(); }); app.use('/api', api); return app; };
    const run = async (scope, p) => {
      const srv = await new Promise((r) => { const s = mk(scope).listen(0, '127.0.0.1', () => r(s)); });
      const res = await fetch('http://127.0.0.1:' + srv.address().port + p);
      const b = await res.json(); srv.close(); return { status: res.status, body: b };
    };
    const out = {
      fullAll: await run(null, '/api/tools/waste/history?days=1'),
      fullOne: await run(null, '/api/tools/waste/history?days=1&vcenterId=r-ok'),
      scopedOne: await run({ vcenters: ['r-ok'] }, '/api/tools/waste/history?days=1&vcenterId=r-ok'),
    };
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr.slice(-2000)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  const out = JSON.parse(line.slice(2));
  assert.equal(out.fullAll.status, 200);
  assert.equal(out.fullAll.body.sampler?.staleVcenters, 1, '전체 범위 계정은 적재 제외 개수를 받는다');
  assert.deepEqual(out.fullAll.body.sampler?.byReason, { maintenance: 1 });
  assert.equal(out.fullOne.body.sampler?.staleVcenters, 1);
  assert.equal(out.scopedOne.status, 200);
  assert.equal(out.scopedOne.body.sampler, null, '범위 계정은 전 함대 개수를 받지 않는다');
});

function fakeDb() {
  const calls = { history: [], historyStep: [] };
  const pts = (metric, bucketMs) => [{ ts: 0, avg: metric.endsWith('_max') ? 30 : 25, max: metric.endsWith('_max') ? 31 : 26 }, { ts: bucketMs, avg: 24, max: 27, carried: true }];
  return {
    calls,
    history(metric, k, since, bucketMs) { calls.history.push({ metric, bucketMs }); return pts(metric, bucketMs); },
    historyStep(metric, k, since, bucketMs, limit, opts) {
      calls.historyStep.push({ metric, bucketMs, nowTs: opts?.nowTs });
      return { points: pts(metric, bucketMs), carried: 1, stepped: true, maxGapMs: 1_800_000, truncated: false, coveredSince: null };
    },
    metaKey() { return { firstTs: 123, lastTs: 456 }; },
  };
}

test('LEFT2628-05 roomTempHistory 1d(30분 버킷)는 historyStep 을 쓰고 stepFilled 를 밝힌다', async () => {
  const { roomTempHistory } = await import('../src/idrac/roomTempSeries.js');
  const db = fakeDb();
  const r = await roomTempHistory(db, { kind: 'inlet', group: 'X', range: '1d' });
  assert.equal(db.calls.history.length, 0, '1시간 미만 버킷을 원본 history 로 조회했다(dead-band 빈 버킷)');
  assert.deepEqual(db.calls.historyStep.map((c) => c.metric).sort(), ['roomtemp_inlet_avg', 'roomtemp_inlet_max']);
  assert.ok(Number.isFinite(db.calls.historyStep[0].nowTs), 'nowTs 를 넘긴다');
  assert.equal(r.stepFilled, 1);
  assert.equal(r.points.length, 2);
  assert.equal(r.points[0].max, 31, 'max 계열의 버킷 최댓값을 쓴다');
  assert.equal(r.collectedSince, 123);
});

test('LEFT2628-05 roomTempHistory 7d 이상(롤업 버킷)은 history 그대로', async () => {
  const { roomTempHistory } = await import('../src/idrac/roomTempSeries.js');
  const db = fakeDb();
  const r = await roomTempHistory(db, { kind: 'cpu', group: '', range: '7d' });
  assert.equal(db.calls.historyStep.length, 0);
  assert.equal(db.calls.history.length, 2);
  assert.equal(r.stepFilled, 0);
});

test('LEFT2628-05 historyStep 이 없는 db(구 인터페이스)도 1d 를 조회한다', async () => {
  const { roomTempHistory } = await import('../src/idrac/roomTempSeries.js');
  const db = fakeDb(); delete db.historyStep;
  const r = await roomTempHistory(db, { kind: 'inlet', group: 'X', range: '1d' });
  assert.equal(db.calls.history.length, 2);
  assert.equal(r.points.length, 2);
});
