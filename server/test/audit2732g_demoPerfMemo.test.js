/**
 * v2.732 그룹 g — B6-07: (데모) SAN 트래픽 합계 수식도 live 와 같은 조회 기억·합류(heavyQuery)를 탄다.
 *
 * v2.715 의 데모 분기는 heavyQuery 앞에서 수식을 바로 돌려 기억·합류·양보가 없었다 — 웹 60초 폴링마다 다시 계산(데모 260대 1회 약 430ms).
 * 수식은 버킷 시각·키의 결정적 함수라 같은 조건을 기억해도 결과가 같다(verify-B6). 고정하는 것:
 *   ① 같은 조건 두 번째 호출은 기억 적중(perfQueryStats().cached 증가)이고 결과는 같은 범위의 직접 계산(demoStorageMulti)과 같다
 *   ② 다른 조건(기간)은 다른 키 ③ 장비 하나 조회(portSeries·storageSeries)도 기억 ④ mock→live 전환 뒤 같은 조건은 데모 기억을 쓰지 않는다
 *   ⑤ 양보판(demoStorageMultiAsync)은 동기판과 결과가 같고, 멈출 때마다 onYield 를 부르며 onYield 가 던지면 멈춘다(취소 확인).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'a2732g-demomemo-'));
process.env.CONFIG_DIR = TMP;
process.env.DB_DIR = TMP;
process.env.DATA_SOURCE = 'mock';
process.env.SANSW_PERF_QUERY_TTL_MS = '600000';

const { setDataSource } = await import('../src/runtime-settings.js');
setDataSource('mock');
const db = await import('../src/sanswitch/perfDb.js');
const synth = await import('../src/sanswitch/demoPerfSynth.js');

const IDS = ['mock-san-g1-A1', 'mock-san-g1-B1', 'mock-san-g2-A1'];
const now = Date.now();
const meta = [];
for (const d of IDS) for (let p = 0; p < 12; p++) {
  meta.push({ d, p, ts: now, name: p < 6 ? `SYMMETRIX::00019793083${p % 3}::SA-${p}` : `esx-${d}-${p}`, wwn: '', speed: '16G', type: 'F-Port' });
}
await db.importSamples([], meta, 90);
const metaRows = async (ids) => {
  const conn = (await db._dbForTest()).conn;
  const q = conn.prepare('SELECT device_id, port, attached_name, speed, port_type FROM port_meta WHERE device_id = ?');
  return ids.flatMap((id) => q.all(id));
};

test.after(() => { setDataSource('mock'); fs.rmSync(TMP, { recursive: true, force: true }); });

test('① 같은 조건 두 번째 호출은 기억 적중 — 결과는 같은 범위의 직접 계산과 같다', async () => {
  const groupOf = new Map([[IDS[0], 'corp-a'], [IDS[1], 'corp-a'], [IDS[2], 'corp-b']]);
  const c0 = db.perfQueryStats().cached;
  const r1 = await db.storageSeriesMulti(IDS, { hours: 24, groupOf });
  assert.equal(r1.demo, true);
  assert.ok(r1.series.length > 0);
  const r2 = await db.storageSeriesMulti(IDS, { hours: 24, groupOf });
  assert.equal(db.perfQueryStats().cached, c0 + 1, '두 번째는 기억에서 나온다(예전: 매번 다시 계산)');
  assert.deepEqual(r2, r1);
  const direct = synth.demoStorageMulti(await metaRows(IDS),
    { since: r1.since, until: r1.until, bucketMs: r1.bucketMs, groupOf, storageKey: db.storageKey, carryMs: r1.carryMs });
  assert.deepEqual(JSON.parse(JSON.stringify(r1)), JSON.parse(JSON.stringify(direct)), '양보판 결과 == 동기판 직접 계산');
});

test('② 다른 기간은 다른 키다(기억을 섞지 않는다)', async () => {
  const runs0 = db.perfQueryStats().runs;
  const a = await db.storageSeriesMulti(IDS, { hours: 6 });
  const b = await db.storageSeriesMulti(IDS, { hours: 48 });
  assert.equal(db.perfQueryStats().runs, runs0 + 2);
  assert.notDeepEqual(a.buckets, b.buckets, '기간이 다르면 버킷 구성이 다르다');
});

test('③ 장비 하나 조회(portSeries·storageSeries)도 기억한다', async () => {
  const c0 = db.perfQueryStats().cached;
  const p1 = await db.portSeries(IDS[0], { hours: 3 });
  const p2 = await db.portSeries(IDS[0], { hours: 3 });
  const s1 = await db.storageSeries(IDS[0], { hours: 3 });
  const s2 = await db.storageSeries(IDS[0], { hours: 3 });
  assert.equal(db.perfQueryStats().cached, c0 + 2);
  assert.equal(p1.demo, true); assert.deepEqual(p2, p1);
  assert.equal(s1.demo, true); assert.deepEqual(s2, s1);
  assert.equal(p1.series.length, 12);
});

test('④ mock→live 전환 뒤 같은 조건은 데모 기억을 쓰지 않는다(키가 나뉜다)', async () => {
  const demoR = await db.storageSeriesMulti(IDS, { hours: 12 });
  const demoP = await db.portSeries(IDS[1], { hours: 12 });
  const demoS = await db.storageSeries(IDS[1], { hours: 12 });
  assert.ok(demoR.demo && demoP.demo && demoS.demo);
  setDataSource('live');
  try {
    const liveR = await db.storageSeriesMulti(IDS, { hours: 12 });
    assert.notEqual(liveR.demo, true, 'live 는 DB 집계(데모 수식 결과가 나가면 안 된다)');
    assert.notEqual((await db.portSeries(IDS[1], { hours: 12 })).demo, true, 'portSeries 도 키가 나뉜다');
    assert.notEqual((await db.storageSeries(IDS[1], { hours: 12 })).demo, true, 'storageSeries 도 키가 나뉜다');
  } finally { setDataSource('mock'); }
});

test('⑤ 양보판 — 동기판과 같은 결과 · 멈출 때마다 onYield · onYield 가 던지면 멈춘다', async () => {
  const big = [];
  for (let d = 0; d < 20; d++) for (let p = 0; p < 40; p++) big.push({ device_id: `mock-san-z-${d}`, port: p, attached_name: p % 5 ? `UNITY::APM00${d % 7}::SP${p % 2}` : `host-${d}-${p}` });
  const until = 1_790_000_000_000; const opts = { since: until - 24 * 3600_000, until, bucketMs: 12 * 60_000, storageKey: db.storageKey, carryMs: 600_000 };
  let calls = 0;
  const a = await synth.demoStorageMultiAsync(big, opts, async () => { calls++; });
  const s = synth.demoStorageMulti(big, opts);
  assert.deepEqual(a, s);
  assert.ok(calls >= a.series.length, `시리즈마다 멈춘다(${calls} ≥ ${a.series.length})`);
  let n = 0;
  await assert.rejects(synth.demoStorageMultiAsync(big, opts, async () => { if (++n === 3) throw new Error('취소'); }), /취소/);
});
