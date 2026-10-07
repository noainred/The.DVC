/**
 * v2.719 감사 그룹 C 회귀 — R2-01(조회 감시 재시작이 진행 중인 prune 의 핸들을 닫지 않는다) ·
 * R2-04(vmperf 데모 백필 래치는 vCenter 단위).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2719c-'));
process.env.DATA_SOURCE = 'mock';
process.env.SANSW_PERF_QUERY_MAX_MS = '10000';
process.env.PRUNE_CHUNK_ROWS = '500';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 기준 시각은 정시에서 30분 떨어뜨려 고정한다(Date.now() 경계 플래키 방지).
const BASE = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;

test('R2-01 감시가 조회 엔진을 재시작해도 진행 중인 prune 은 끝까지 지우고 정확한 수를 보고한다', { timeout: 120_000 }, async () => {
  const perf = await import('../src/sanswitch/perfDb.js');
  const h = await perf._dbForTest();
  const conn = h.conn;
  const ins = conn.prepare('INSERT INTO port_perf (device_id, ts, port, bps) VALUES (?,?,?,?)');
  const OLD = 100_000;
  conn.exec('BEGIN');
  for (let i = 0; i < OLD; i++) ins.run('old-sw', BASE - 200 * DAY - i, i % 4, 10);
  for (let i = 0; i < 400; i++) for (let p = 0; p < 4; p++) ins.run('real-sw', BASE - i * 60_000, p, 1000 + p);
  conn.exec('COMMIT');
  // 조회는 조각마다 0.4초, prune 은 청크마다 80ms 를 끌어 둘이 감시 시한(10초) 너머까지 겹치게 한다.
  const origPrepare = conn.prepare.bind(conn);
  let slowQuery = true;
  conn.prepare = (sql) => {
    const st = origPrepare(sql);
    if (/FROM port_perf WHERE device_id = \? AND ts >= \?/.test(sql)) {
      return { all: (...a) => { if (slowQuery) { const end = Date.now() + 400; while (Date.now() < end) { /* */ } } return st.all(...a); } };
    }
    if (/^DELETE FROM port_perf WHERE rowid IN/.test(sql)) {
      return { run: (...a) => { const end = Date.now() + 80; while (Date.now() < end) { /* */ } return st.run(...a); } };
    }
    return st;
  };
  const before = perf.perfQueryStats().restarts.count;
  const pPrune = perf.pruneNow(90);
  const pQuery = perf.storageSeriesMulti(['real-sw'], { hours: 24 * 30 });
  await assert.rejects(pQuery, (e) => e.code === 'query-restarted');
  slowQuery = false;
  const r = await pPrune;
  assert.equal(perf.perfQueryStats().restarts.count, before + 1, '감시가 실제로 재시작했다');
  assert.equal(r.error, undefined, `prune 이 실패하면 안 된다: ${r.error}`);
  assert.equal(r.deleted, OLD, '지운 행 수를 그대로 보고한다');
  // 옛 핸들은 prune 이 끝난 뒤에 닫혔고, 새 핸들로 계속 쓸 수 있다.
  assert.equal(h.closed, true, '사용자가 끝나면 옛 핸들을 닫는다');
  const h2 = await perf._dbForTest();
  assert.notEqual(h2, h);
  const left = h2.conn.prepare("SELECT COUNT(*) AS n FROM port_perf WHERE device_id = 'old-sw'").get().n;
  assert.equal(left, 0);
});

test('R2-04 vmperf 데모 백필 — 빈 첫 호출이 래치를 세우지 않고, 나중에 생긴 vCenter 도 채운다', async () => {
  const { demoVmperfBackfill, _resetVmperfDemoForTest } = await import('../src/mock/demo/vmperf.js');
  const { insertVmperf, vmperfMeta } = await import('../src/metrics/vmperfDb.js');
  _resetVmperfDemoForTest();
  const ts = BASE;
  const empty = await demoVmperfBackfill(new Map(), ts, { days: 5 });
  assert.equal(empty.filled ?? 0, 0);
  const rowsA = [{ metric: 'vm_cpu_used_mhz', k: 'vc-a', v: 400 }];
  await insertVmperf('vc-a', rowsA, ts);
  const a = await demoVmperfBackfill(new Map([['vc-a', rowsA]]), ts, { days: 5 });
  assert.equal(a.vcenters, 1, '빈 첫 호출 뒤에도 실제 행이 오면 채운다');
  assert.ok((await vmperfMeta('vc-a', 'vm_cpu_used_mhz')).firstTs <= ts - 4 * DAY);
  // 나중에 생긴 vCenter — vc-a 는 다시 채우지 않고 vc-b 만 채운다.
  const rowsB = [{ metric: 'vm_cpu_used_mhz', k: 'vc-b', v: 300 }];
  await insertVmperf('vc-b', rowsB, ts);
  const b = await demoVmperfBackfill(new Map([['vc-a', rowsA], ['vc-b', rowsB]]), ts, { days: 5 });
  assert.equal(b.vcenters, 1);
  assert.ok((await vmperfMeta('vc-b', 'vm_cpu_used_mhz')).firstTs <= ts - 4 * DAY);
  const again = await demoVmperfBackfill(new Map([['vc-a', rowsA], ['vc-b', rowsB]]), ts, { days: 5 });
  assert.deepEqual(again, { skipped: 'done' });
});
