/**
 * v2.715 — ① 목업 모드 SAN 사용량은 DB 를 조회하지 않고 수식으로 만든다(사용자 지시 "랜덤 숫자로 채우기").
 *           실제 집계와 같은 응답 모양이어야 화면·trafficTotal 이 그대로 동작한다.
 *          ② 사용량 조회가 감시 시한(SANSW_PERF_QUERY_MAX_MS)을 넘으면 조회 엔진만 재시작하고, 뒤에 줄 선 조회는 이어서 돈다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sandemo2715-'));
process.env.SANSW_PERF_QUERY_TTL_MS = '0';
process.env.SANSW_PERF_QUERY_MAX_MS = '10000';   // 하한 10초

const HOUR = 3600_000;

test('① 합성: isDemoPerfQuery 는 mock + 전부 데모 장비일 때만', async () => {
  const m = await import('../src/sanswitch/demoPerfSynth.js');
  assert.equal(m.isDemoPerfQuery(true, ['mock-san-a', 'mock-san-b']), true);
  assert.equal(m.isDemoPerfQuery(true, ['mock-san-a', 'real-1']), false, '사람이 등록한 장비가 섞이면 DB');
  assert.equal(m.isDemoPerfQuery(false, ['mock-san-a']), false, 'mock 이 아니면 DB');
  assert.equal(m.isDemoPerfQuery(true, []), false);
});

test('① 합성: storageSeriesMulti 모양 · 같은 시각이면 같은 값 · 버킷 경계', async () => {
  const m = await import('../src/sanswitch/demoPerfSynth.js');
  const { storageKey } = await import('../src/sanswitch/perfDb.js');
  const meta = [];
  for (let d = 0; d < 4; d++) for (let p = 0; p < 8; p++) meta.push({ device_id: `mock-san-x-${d}`, port: p, attached_name: p < 4 ? `SYMMETRIX::00019793083${p}::SA-${d}` : `host-${d}-${p}` });
  const until = 1_790_000_000_000; const since = until - 24 * HOUR; const bucketMs = 12 * 60_000;
  const a = m.demoStorageMulti(meta, { since, until, bucketMs, storageKey, carryMs: 600_000 });
  const b = m.demoStorageMulti(meta, { since, until, bucketMs, storageKey, carryMs: 600_000 });
  assert.deepEqual(a, b, '결정적');
  assert.ok(a.buckets.length >= 120 && a.buckets.length <= 122);
  for (const t of a.buckets) assert.equal(t % bucketMs, 0);
  const s0 = a.series[0];
  for (const k of ['key', 'ports', 'deviceIds', 'sum', 'peak', 'avgTotal', 'maxTotal', 'peakAvg', 'peakTotal', 'partial', 'partialBuckets']) assert.ok(k in s0, k);
  assert.equal(s0.sum.length, a.buckets.length);
  assert.ok(s0.sum.every((v) => Number.isFinite(v) && v >= 0));
  assert.ok(s0.peak.every((v, i) => v >= s0.sum[i]), '피크 ≥ 평균');
  // 팹 A/B 처럼 같은 어레이 키는 장비가 달라도 한 시리즈로 합쳐진다
  const arr = a.series.find((s) => s.key === 'SYMMETRIX::000197930830');
  assert.equal(arr.deviceIds.length, 4);
  // 법인 구분
  const g = new Map(meta.map((r) => [r.device_id, r.device_id.endsWith('0') ? 'A' : 'B']));
  const c = m.demoStorageMulti(meta, { since, until, bucketMs, storageKey, groupOf: g });
  assert.ok(c.series.length > a.series.length);
});

test('① perfDb 연결: mock 모드 데모 장비는 표본 0행이어도 시리즈가 나온다(DB 집계를 타지 않는다)', async () => {
  const flags = await import('../src/mock/demo/flags.js');
  if (!flags.isMockMode()) { process.env.DATA_SOURCE = 'mock'; }
  const db = await import('../src/sanswitch/perfDb.js');
  if (!flags.isMockMode()) return;   // 런타임 설정이 mock 이 아니면 건너뛴다(기본 DATA_SOURCE 는 mock)
  await db.importSamples([], [{ d: 'mock-san-t-A1', p: 0, ts: Date.now(), name: 'UNITY::APM001::SPA', wwn: '', speed: '16G', type: 'F-Port' },
    { d: 'mock-san-t-A1', p: 1, ts: Date.now(), name: 'UNITY::APM001::SPB', wwn: '', speed: '16G', type: 'F-Port' }], 90);
  const r = await db.storageSeriesMulti(['mock-san-t-A1'], { hours: 24 });
  assert.equal(r.demo, true);
  assert.equal(r.series.length, 1);
  assert.equal(r.series[0].ports.length, 2);
  const one = await db.storageSeries('mock-san-t-A1', { hours: 1 });
  assert.equal(one.demo, true);
  const ps = await db.portSeries('mock-san-t-A1', { hours: 1 });
  assert.equal(ps.series.length, 2);
  const last = await db.latestSampleTs(['mock-san-t-A1']);
  assert.ok(Date.now() - last.get('mock-san-t-A1') < 5000, '데모 장비의 마지막 표본은 지금');
});

test('② 감시: 시한을 넘긴 조회는 엔진 재시작 + 사유, 다음 조회는 이어서 돈다', async () => {
  const db = await import('../src/sanswitch/perfDb.js');
  const conn = (await db._dbForTest()).conn;
  // 실제 장비 표본을 넣고(데모가 아니므로 DB 집계를 탄다) 조회를 일부러 느리게 만든다 — 양보 지점에서 시간을 끈다.
  const ins = conn.prepare('INSERT INTO port_perf (device_id, ts, port, bps) VALUES (?,?,?,?)');
  conn.exec('BEGIN');
  const base = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
  for (let i = 0; i < 400; i++) for (let p = 0; p < 4; p++) ins.run('real-sw', base - i * 60_000, p, 1000 + p);
  conn.exec('COMMIT');
  const origPrepare = conn.prepare.bind(conn);
  let slow = true;
  conn.prepare = (sql) => {
    const st = origPrepare(sql);
    if (!/FROM port_perf WHERE device_id = \? AND ts >= \?/.test(sql)) return st;
    return { all: (...a) => { if (slow) { const end = Date.now() + 400; while (Date.now() < end) { /* 조각마다 0.4초 */ } } return st.all(...a); } };
  };
  const before = db.perfQueryStats().restarts.count;
  const p1 = db.storageSeriesMulti(['real-sw'], { hours: 24 * 30 });   // 조각이 많다 → 10초를 넘긴다
  const p2 = db.storageSeriesMulti(['real-sw'], { hours: 1 });          // 뒤에 줄 선 조회
  await assert.rejects(p1, (e) => e.code === 'query-restarted' && /재시작/.test(e.message));
  slow = false;
  const r2 = await p2;
  assert.ok(Array.isArray(r2.series), '뒤에 줄 선 조회는 이어서 돈다');
  assert.equal(db.perfQueryStats().restarts.count, before + 1);
  assert.equal(db.perfQueryStats().maxQueryMs, 10000);
});
