// v2.731 점검 1회차 G5b — 요청 경로의 '행 수에 비례하는 동기 SQL' 두 곳.
//   A6-03 iDRAC 통합 추이 서버 표의 전력 요약: power_hourly `WHERE hb>=? GROUP BY server_id` 는 PK 로 보존기간 전부를 훑었다
//         (1,000대 × 90일 합성 30일 창 1.2초 동기). 서버마다 PK 범위 seek + 양보(statsSinceAsync)로 — 결과는 예전과 같아야 한다.
//   A6-04 진단 화면 메모리 추세: metrics.meta('mem_rss')(MIN·MAX·COUNT 한 문장 — 파티션 전체 스캔) 대신 metaRange(단독 MIN·MAX).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2731g5b-'));
process.env.CONFIG_DIR = DIR;
process.env.TEMP_DB_PATH = path.join(DIR, 'host-temp.db');
process.env.IDRAC_DB_PATH = path.join(DIR, 'idrac-power.db');
process.env.AUTH_ENABLED = 'false';
process.env.DATA_SOURCE = 'mock';

const { getDb: getPowerDb } = await import('../src/idrac/db.js');
const { getMetricsDb } = await import('../src/metrics/db.js');
const { memtrackReport } = await import('../src/system/memtrack.js');
const { store } = await import('../src/store.js');

const HOUR = 3_600_000;
const sorted = (m) => [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

test('A6-03 ① statsSinceAsync — 예전 statsSince(GROUP BY)와 결과가 같다(창 경계·창 밖 서버·한 시간 여러 표본)', async () => {
  const pdb = await getPowerDb();
  assert.equal(pdb.kind, 'sqlite', 'node:sqlite 로 시험한다(폴백이면 이 시험의 뜻이 없다)');
  const now = Date.now();
  const hb0 = Math.floor(now / HOUR) - 48;
  const samples = [];
  // 서버 20대 × 48시간 × 시간당 2표본(값은 서버·시간에 따라 다르다)
  for (let s = 0; s < 20; s++) {
    for (let h = 0; h < 48; h++) {
      const t = (hb0 + h) * HOUR;
      samples.push({ serverId: `srv-${String(s).padStart(2, '0')}`, watts: 200 + s * 7 + (h % 9) * 3, ts: t + 60_000 });
      samples.push({ serverId: `srv-${String(s).padStart(2, '0')}`, watts: 210 + s * 5 + (h % 4) * 11, ts: t + 1_800_000 });
    }
  }
  // 창보다 오래된 표본만 있는 서버 — 결과에 없어야 한다(0 으로 채우지 않는다)
  samples.push({ serverId: 'old-only', watts: 999, ts: (hb0 - 30) * HOUR + 5_000 });
  // 이름 순서가 서버 id 정렬 경계를 시험하게(대문자·숫자·밑줄)
  samples.push({ serverId: 'A_upper', watts: 333, ts: (hb0 + 40) * HOUR + 10_000 });
  samples.push({ serverId: 'rmt:edge-1:10.0.0.9', watts: 444, ts: (hb0 + 47) * HOUR + 20_000 });
  pdb.insertMany(samples);

  for (const hours of [1, 6, 24, 30, 47, 72]) {
    const since = Math.floor((now - hours * HOUR) / HOUR) * HOUR;
    const oldM = pdb.statsSince(since);
    const newM = await pdb.statsSinceAsync(since);
    assert.deepStrictEqual(sorted(newM), sorted(oldM), `창 ${hours}시간 결과가 예전과 같다`);
    assert.equal(newM.has('old-only'), false, '창 안에 표본이 없는 서버는 결과에 없다');
  }
});

test('A6-03 ② statsSinceAsync — 서버마다 양보 지점이 있다(서버 수만큼 maybeYield 호출)', async () => {
  const pdb = await getPowerDb();
  let calls = 0;
  const m = await pdb.statsSinceAsync(Date.now() - 6 * HOUR, { maybeYield: async () => { calls++; return false; } });
  // power_hourly 의 서버 id 전부(창 밖 서버 포함 — 양보는 서버 사이마다)
  assert.equal(calls, 23, '서버 23대 사이마다 양보 기회');
  assert.ok(m.size >= 20 && m.size <= 22, `창 안 서버만 결과에 있다(${m.size})`);
});

test('A6-03 ③ 라우트 — 서버 표 전력 요약은 동기 statsSince 를 부르지 않는다(statsSinceAsync)', async () => {
  await store.refresh({ force: true });
  const { addServer } = await import('../src/idrac/registry.js');
  addServer({ id: 'srv-pw31', name: 'pw31.g5b.example', host: '10.0.31.5', username: 'root', password: 'x' });
  const pdb = await getPowerDb();
  const now = Date.now();
  const h0 = Math.floor(now / HOUR) * HOUR - 2 * HOUR;
  pdb.insertMany([{ serverId: 'srv-pw31', watts: 400, ts: h0 + 60_000 }, { serverId: 'srv-pw31', watts: 700, ts: h0 + HOUR + 60_000 }]);
  const realSync = pdb.statsSince;
  let syncCalls = 0;
  pdb.statsSince = (...a) => { syncCalls++; return realSync(...a); };
  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express(); app.use(express.json()); app.use('/api/admin', adminRouter);
  const srv = app.listen(0); await new Promise((ok) => srv.once('listening', ok));
  try {
    const r = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/admin/idrac/trend/table?hours=6`)).json();
    assert.equal(r.ok, true);
    assert.equal(r.errors?.powerW, undefined, '전력 요약 오류 없음');
    assert.equal(syncCalls, 0, '요청 경로가 동기 GROUP BY 를 부르지 않는다');
    const row = r.rows.find((x) => x.id === 'srv-pw31');
    assert.ok(row, '등록 서버 행');
    assert.deepEqual([row.powerW?.min, row.powerW?.max, row.powerW?.avg, row.powerW?.n], [400, 700, 550, 2], '전력 최소·최대·평균·표본 수');
  } finally { srv.close(); pdb.statsSince = realSync; }
});

test('A6-04 ① memtrackReport — meta() 를 부르지 않고 metaRange 의 시각을 싣는다(count 는 세지 않음 = null)', () => {
  let metaCalls = 0;
  const db = {
    history: () => [],
    meta: () => { metaCalls++; return { firstTs: 1, lastTs: 2, count: 5 }; },
    metaRange: (m) => (m === 'mem_rss' ? { firstTs: 1000, lastTs: 9000 } : { firstTs: null, lastTs: null }),
  };
  const rep = memtrackReport(db, '24h');
  assert.equal(metaCalls, 0, 'MIN·MAX·COUNT 한 문장(meta)을 화면 경로에서 부르지 않는다');
  assert.deepEqual(rep.meta, { firstTs: 1000, lastTs: 9000, count: null });
  const empty = memtrackReport({ ...db, metaRange: () => ({ firstTs: null, lastTs: null }) }, '24h');
  assert.deepEqual(empty.meta, { firstTs: null, lastTs: null, count: null }, '표본이 없으면 null(0 아님)');
});

test('A6-04 ② 실제 metrics DB — metaRange 시각이 meta() 와 같다', async () => {
  const db = await getMetricsDb();
  const t0 = Math.floor(Date.now() / HOUR) * HOUR - 5 * HOUR;
  for (let i = 0; i < 30; i++) db.insertMany([{ metric: 'mem_rss', k: 'portal', v: 500 + i }], t0 + i * 60_000);
  const full = db.meta('mem_rss');
  let metaCalls = 0;
  const wrapped = Object.create(db);
  wrapped.meta = (...a) => { metaCalls++; return db.meta(...a); };
  const rep = memtrackReport(wrapped, '6h');
  assert.equal(metaCalls, 0);
  assert.equal(rep.meta.firstTs, full.firstTs);
  assert.equal(rep.meta.lastTs, full.lastTs);
  assert.equal(rep.meta.count, null, '세지 않은 개수는 0 이 아니라 null');
  assert.ok(rep.series.rss.length > 0, '시계열은 그대로');
});
