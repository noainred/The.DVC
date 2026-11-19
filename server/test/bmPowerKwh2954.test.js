/**
 * v2.954(점검 B-4) — 전력 '24h 전력량' 은 끝난 정시 24칸만 더한다.
 *   idrac/db.js hourlyStats(now − 24h, now) 는 hb ∈ [floor(from/1h), ceil(to/1h)) 라 정시가 아니면 25행(앞 · 뒤 부분 시간)을 돌려준다 —
 *   예전 hourSummary 는 그 25행을 다 더해 1,000 W 일정이 25 kWh 였다(24 이어야 함).
 *   기준 시각: 실제 시각을 정시로 떨어뜨린 뒤 −30분(정시가 아닌 시각 · common.md).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmpowkwh-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HOUR = 3_600_000; const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
const A = await import('../src/bmusage/powerAgg.js');

// idrac/db.js hourlyStats 와 같은 창 규칙(hb ∈ [floor(from/1h), ceil(to/1h)) · ts = hb × 1h)
const dbLike = (w) => ({ hourlyStats: (key, from, to) => {
  const out = [];
  for (let hb = Math.floor(from / HOUR); hb < Math.ceil(to / HOUR); hb += 1) out.push({ ts: hb * HOUR, avg: w, min: w, max: w });
  return out;
} });

test('B-4 gatherPower → 서버 h24.kwh = 24 · 집계 kwh24 = 24(25 아님)', async () => {
  A._resetPowerAggForTest();
  const idb = dbLike(1000);
  assert.equal(idb.hourlyStats('r1', NOW - DAY, NOW).length, 25, '전제: 정시가 아니면 25행');
  const deps = { measured: async () => [{ serverId: 'r1', watts: 1000, vcenterId: 'vcA', serviceTag: 'T1', source: 'idrac' }], analysisServers: async () => [{ id: 'r1', serviceTag: 'T1' }],
    powerDb: async () => idb, fanFaults: async () => [], inventoryOf: () => null, sensorLatest: () => null, temps: { classify: () => 'other', maxAgeOf: () => 15 * 60_000 }, yielder: async () => {} };
  const [s] = await A.gatherPower({ targets: [{ key: 'K1', name: 'bm-1', vcenterId: 'vcA', serviceTag: 'T1', idrac: { regId: 'r1' }, paths: ['idrac'] }], deps, now: NOW, withMonth: false });
  assert.equal(s.h24.kwh, 24);
  assert.equal(s.h24.avgW, 1000); assert.equal(s.h24.peakW, 1000);
  assert.equal(A.aggregatePower([s]).fleet.kwh24, 24);
});

test('B-4 hourSummary — 칸 지정 시 그 칸에 행이 없으면 kwh = null(0 아님) · 지정 없으면 예전과 같다', () => {
  const h0 = Math.floor(NOW / HOUR) * HOUR;
  const onlyNow = [{ ts: h0, avg: 500, max: 500 }];
  assert.equal(A.hourSummary(onlyNow, { kwhFrom: h0 - DAY, kwhTo: h0 }).kwh, null);
  assert.equal(A.hourSummary(onlyNow).kwh, 0.5);
  const agg = A.aggregatePower([{ key: 'X', name: 'X', vcenterId: 'v', node: '', via: 'local', w: 500, unmeasured: null, h24: A.hourSummary(onlyNow, { kwhFrom: h0 - DAY, kwhTo: h0 }), kwhMonth: null }]);
  assert.equal(agg.fleet.kwh24, null, '끝난 시간이 하나도 없으면 — 0 kWh 가 아니다');
});
