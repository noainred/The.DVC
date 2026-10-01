/**
 * v2.681 감사 2라운드 축 D(집계기 데이터 정확성 — 오류 없이 틀린 값) 회귀.
 *
 *  R2D-01 storage sumCapacityBuckets — 퇴역 장비가 그 뒤 모든 버킷을 부분 합으로 만들지 않는다
 *  R2D-02 storage growth totalsOf    — 사용률·남은 용량은 사용량을 읽은 장비끼리만
 *  R2D-03 storage growth             — 퇴역·장기 미관측 장비는 함대 합계에서 빼고 센다
 *  R2D-04 curuser aggregate          — 일시 실패 VM 이 섞인 주기는 부분 합(추이 적재 안 함), 발행기 없음은 대상 아님
 *  R2D-05 metrics sampler            — 호스트 gpu_util 게스트 대체값은 신선한 것만
 *  R2D-06 metrics sampler            — 호스트 gpu_mem_mb 게스트 합이 부분 합이면 적재하지 않는다
 *  R2D-07 corpusage build            — 베어메탈 같은 key 를 다른 vCenter 에서 만나면 조용히 버리지 않는다(keyConflict)
 *  R2D-09 sanswitch trafficTotal     — 사라진 시리즈가 그 뒤 합계를 전부 null 로 만들지 않는다
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2681c-'));
process.env.CONFIG_DIR = DIR;
process.env.TEMP_DB_PATH = path.join(DIR, 'host-temp.db');

const H = 3_600_000;

const { sumCapacityBuckets, RETIRE_GRACE_CARRIES, RETIRE_GRACE_MIN_MS } = await import('../src/storage/db.js');
const { storageTrend } = await import('../src/overview/trend.js');
const { growthMatrix, DEFAULT_PERIODS, GROWTH_STALE_DAYS } = await import('../src/storage/growth.js');
const { aggregate, aggregateAll, seriesRow } = await import('../src/curuser/aggregate.js');
const { buildCorpUsage } = await import('../src/corpusage/build.js');
const { sumArrayTraffic, SERIES_RETIRE_CARRIES } = await import('../src/sanswitch/trafficTotal.js');

/* ── R2D-01 ─────────────────────────────────────────────────────────────── */

// 기준 시각은 경계에서 떨어뜨려 고정한다(CLAUDE.md v2.517 규약).
const B = 36 * H;
const NOW = Math.floor(Date.UTC(2026, 9, 1) / B) * B + H;
const SINCE = NOW - 90 * 24 * H;
function retiredRows() {
  const rows = [];
  for (let t = Math.floor((SINCE - 6 * H) / B) * B; t <= NOW; t += B) {
    rows.push({ device_id: 'A', ts: t, total_bytes: 100, used_bytes: 50 });
    if (t < SINCE + 10 * 24 * H) rows.push({ device_id: 'OLD', ts: t, total_bytes: 10, used_bytes: 5 });
  }
  return rows;
}

test('R2D-01 퇴역 장비는 마지막 행 + 한계 × (1+유예) 뒤로는 기대하지 않는다 — 스파크라인이 통째로 사라지지 않는다', () => {
  const staleMs = 48 * H;
  const r = sumCapacityBuckets(retiredRows(), { sinceMs: SINCE, nowMs: NOW, bucketMs: B, staleMs });
  const s = storageTrend(r.points, 90, NOW);
  const valid = s.filter((p) => p.v != null).length;
  const partial = s.filter((p) => p.partial).length;
  // 예전: 60점 중 유효 7 · partial 53. 퇴역 직후 유예 구간(한계 × RETIRE_GRACE_CARRIES)만 partial 이어야 한다.
  assert.ok(valid >= 45, `유효 점 ${valid}`);
  assert.ok(partial > 0, '퇴역 직후 구간도 partial 이 없다(유예가 사라졌다)');
  assert.ok(partial <= Math.ceil((staleMs + Math.max(staleMs * RETIRE_GRACE_CARRIES, RETIRE_GRACE_MIN_MS)) / B) + 1, `partial ${partial}`);
  const last = r.points[r.points.length - 1];
  assert.equal(last.missing, 0);
  assert.equal(last.used_bytes, 50);
  assert.equal(r.retiredDevices, 1);
  assert.equal(r.expectedDevices, 2, '예전 필드 뜻(조회에 나온 장비 수)은 그대로');
});

test('R2D-01 knownIds — 등록 장비는 계속 기대(수집이 멈추면 끝까지 missing), 등록부 밖 장비는 한계 뒤 퇴역', () => {
  const staleMs = 48 * H;
  // 등록 장비 A 가 10일째부터 수집이 멈춘 경우 — 계속 missing 이어야 한다.
  const rows = [];
  for (let t = Math.floor((SINCE - 6 * H) / B) * B; t <= NOW; t += B) {
    rows.push({ device_id: 'KEEP', ts: t, total_bytes: 100, used_bytes: 50 });
    if (t < SINCE + 10 * 24 * H) { rows.push({ device_id: 'A', ts: t, total_bytes: 10, used_bytes: 5 }); rows.push({ device_id: 'OLD', ts: t, total_bytes: 10, used_bytes: 5 }); }
  }
  const r = sumCapacityBuckets(rows, { sinceMs: SINCE, nowMs: NOW, bucketMs: B, staleMs, knownIds: ['KEEP', 'A'] });
  const last = r.points[r.points.length - 1];
  assert.equal(last.missing, 1, '수집이 멈춘 등록 장비를 조용히 빼면 안 된다');
  assert.equal(r.retiredDevices, 1, 'OLD 만 퇴역');
  // 신규 장비는 첫 행 이전 구간을 partial 로 만들지 않는다.
  const rows2 = [];
  for (let t = Math.floor((SINCE - 6 * H) / B) * B; t <= NOW; t += B) {
    rows2.push({ device_id: 'KEEP', ts: t, total_bytes: 100, used_bytes: 50 });
    if (t >= NOW - 5 * 24 * H) rows2.push({ device_id: 'NEW', ts: t, total_bytes: 10, used_bytes: 5 });
  }
  const r2 = sumCapacityBuckets(rows2, { sinceMs: SINCE, nowMs: NOW, bucketMs: B, staleMs, knownIds: ['KEEP', 'NEW'] });
  assert.equal(r2.points.filter((p) => p.missing > 0).length, 0);
});

/* ── R2D-02 · R2D-03 ────────────────────────────────────────────────────── */

const growthRows = [
  { device_id: 'A', day: 1000, used_bytes: 50, total_bytes: 100, last_ts: 1 },
  { device_id: 'A', day: 999, used_bytes: 40, total_bytes: 100, last_ts: 1 },
  { device_id: 'B', day: 1000, used_bytes: null, total_bytes: 100, last_ts: 1 },
  { device_id: 'GONE', day: 700, used_bytes: 80, total_bytes: 100, last_ts: 1 },
  { device_id: 'GONE', day: 699, used_bytes: 70, total_bytes: 100, last_ts: 1 },
];

test('R2D-02 사용률·남은 용량은 사용량을 읽은 장비의 용량만 분모로 쓴다', () => {
  const m = growthMatrix(growthRows.filter((r) => r.device_id !== 'GONE'), { periods: DEFAULT_PERIODS, asOfDay: 1000 });
  assert.equal(m.totals.usedBytes, 50);
  assert.equal(m.totals.totalBytes, 200, '표시 총용량은 그대로');
  assert.equal(m.totals.totalBytesMeasured, 100);
  assert.equal(m.totals.pct, 50, '예전엔 25%');
  assert.equal(m.totals.freeBytes, 50, '예전엔 150');
  assert.equal(m.totals.unknownUsed, 1);
});

test('R2D-03 장기 미관측 장비는 합계·증가량 합에서 빠지고 staleDevices 로 센다(행은 남는다)', () => {
  const m = growthMatrix(growthRows, { periods: DEFAULT_PERIODS, asOfDay: 1000 });
  const gone = m.devices.find((d) => d.deviceId === 'GONE');
  assert.ok(gone, '행은 남긴다');
  assert.equal(gone.stale, true);
  assert.equal(m.totals.usedBytes, 50, '예전엔 130(300일 전 값이 지금 합계에 섞였다)');
  assert.equal(m.totals.staleDevices, 1);
  assert.equal(m.totals.growth['1d'].bytes, 10, '오늘 기준 1일 증가량에 300일 전 증가량이 섞이지 않는다');
  assert.equal(m.totals.staleDaysLimit, GROWTH_STALE_DAYS);
});

test('R2D-03 knownIds 밖 장비는 퇴역 — 합계에서 빠지고 retiredDevices 로 센다', () => {
  const rows = [
    { device_id: 'A', day: 1000, used_bytes: 50, total_bytes: 100, last_ts: 1 },
    { device_id: 'X', day: 1000, used_bytes: 30, total_bytes: 100, last_ts: 1 },
  ];
  const m = growthMatrix(rows, { periods: DEFAULT_PERIODS, asOfDay: 1000, knownIds: ['A'] });
  assert.equal(m.totals.usedBytes, 50);
  assert.equal(m.totals.retiredDevices, 1);
  assert.equal(m.devices.find((d) => d.deviceId === 'X').retired, true);
  // knownIds 를 안 주면 예전과 같다.
  assert.equal(growthMatrix(rows, { periods: DEFAULT_PERIODS, asOfDay: 1000 }).totals.usedBytes, 80);
});

test('R2D-03 최신 관측이 어제보다 오래됐지만 한계 안인 장비 — 지금 합계에는 들지만 오늘 기준 증가량 합에는 lagging 으로 빠진다', () => {
  const rows = [
    { device_id: 'A', day: 1000, used_bytes: 50, total_bytes: 100, last_ts: 1 },
    { device_id: 'A', day: 999, used_bytes: 40, total_bytes: 100, last_ts: 1 },
    { device_id: 'L', day: 996, used_bytes: 20, total_bytes: 100, last_ts: 1 },
    { device_id: 'L', day: 995, used_bytes: 10, total_bytes: 100, last_ts: 1 },
  ];
  const m = growthMatrix(rows, { periods: DEFAULT_PERIODS, asOfDay: 1000 });
  assert.equal(m.totals.usedBytes, 70);
  assert.equal(m.totals.growth['1d'].bytes, 10);
  assert.equal(m.totals.growth['1d'].lagging, 1);
  assert.equal(m.totals.growth['1d'].partial, true);
});

/* ── R2D-04 ─────────────────────────────────────────────────────────────── */

test('R2D-04 일시 실패 VM 이 섞인 주기는 partial(적재 안 함), 발행기 없음은 대상 아님', () => {
  const ok = (id, u) => ({ vmId: id, vcenterId: 'v', ok: true, users: [{ name: u, kind: 'active' }] });
  const base = [ok('a', 'u1'), ok('b', 'u2')];
  for (const kind of ['stale', 'guest-error', 'incomplete', 'unparsed', 'clock-skew', 'weird-new-kind']) {
    const row = seriesRow(aggregate([...base, { vmId: 'c', vcenterId: 'v', ok: false, kind }]));
    assert.equal(row.partial, true, kind);
    assert.equal(row.users, null, kind);
  }
  for (const kind of ['no-agent', 'not-found']) {
    const a = aggregate([...base, { vmId: 'c', vcenterId: 'v', ok: false, kind }]);
    const row = seriesRow(a);
    assert.equal(row.partial, false, kind);
    assert.equal(row.users, 2);
    assert.equal(a.vmsNotTarget, 1);
    assert.equal(a.vmsFailed, 1, 'vmsFailed 뜻은 그대로(일시 + 대상 아님)');
  }
  const all = aggregateAll([...base, { vmId: 'c', vcenterId: 'v', ok: false, kind: 'stale' }]);
  assert.equal(seriesRow(all.total).partial, true);
  assert.equal(all.total.vmsTransient, 1);
});

/* ── R2D-05 · R2D-06 ────────────────────────────────────────────────────── */

test('R2D-05·06 샘플러 — 낡은 게스트 호스트 사용률은 적재하지 않고, 부분 합 GPU 메모리는 게스트 합 대신 ESXi 카운터', async () => {
  const { store } = await import('../src/store.js');
  const sampler = await import('../src/metrics/sampler.js');
  const gpu = await import('../src/gpu/store.js');
  const { getMetricsDb } = await import('../src/metrics/db.js');
  gpu._resetGuestGpuForTest();
  store.snapshot = {
    vcenters: [{ id: 'g', status: 'connected' }],
    hosts: [
      { id: 'h-fresh', vcenterId: 'g', name: 'esx-f', cluster: 'c', gpus: [{}] },
      { id: 'h-stale', vcenterId: 'g', name: 'esx-s', cluster: 'c', gpus: [{}] },
      { id: 'h-part', vcenterId: 'g', name: 'esx-p', cluster: 'c', gpus: [{}], gpuMemUsedMB: 7777 },
      { id: 'h-full', vcenterId: 'g', name: 'esx-full', cluster: 'c', gpus: [{}], gpuMemUsedMB: 1111 },
    ],
    vms: [
      { id: 'vp1', vcenterId: 'g', host: 'esx-p', powerState: 'POWERED_ON', gpu: { type: 'vgpu' } },
      { id: 'vp2', vcenterId: 'g', host: 'esx-p', powerState: 'POWERED_ON', gpu: { type: 'vgpu' } },
      { id: 'vf1', vcenterId: 'g', host: 'esx-full', powerState: 'POWERED_ON', gpu: { type: 'vgpu' } },
    ],
    datastores: [], alarms: [],
  };
  gpu.setGuestGpu({
    hosts: [{ hostId: 'h-fresh', utilPct: 33 }, { hostId: 'h-stale', utilPct: 44 }],
    vms: [
      { vmId: 'vp1', utilPct: 10, memUsedMB: 1000, memTotalMB: 4000 },
      { vmId: 'vf1', utilPct: 10, memUsedMB: 2222, memTotalMB: 4000 },
    ],
  });
  gpu.getGuestGpuHost('h-stale').at = Date.now() - 2 * H;   // 게스트 수집이 2시간 전에 멈췄다
  await sampler._sampleOnceForTest();
  const db = await getMetricsDb();
  const util = db.latestAll('gpu_util');
  assert.equal(util.get('h-fresh')?.v, 33);
  assert.equal(util.has('h-stale'), false, '낡은 게스트 사용률을 지금 값으로 적재했다');
  const mb = db.latestAll('gpu_mem_mb');
  assert.equal(mb.get('h-part')?.v, 7777, '부분 합(1000)이 아니라 ESXi 카운터');
  assert.equal(mb.get('h-full')?.v, 2222, '켜진 GPU VM 전부가 준 합은 게스트 값');
  assert.equal(sampler.metricsSamplerStatus().lastRun?.gpuMemPartialHosts, 1);
});

/* ── R2D-07 ─────────────────────────────────────────────────────────────── */

test('R2D-07 베어메탈 — 다른 vCenter 의 같은 이름 키는 keyConflict 로 세고 법인 행을 지우지 않는다', () => {
  const r = buildCorpUsage({
    vcenters: [{ id: 'vcA', name: 'A' }, { id: 'vcB', name: 'B' }],
    bareMetal: [
      { serverId: 'host:vcA:esxi-01', fleetId: 'esxi-01', name: 'esxi-01', vcenterId: 'vcA' },
      { serverId: 'host:vcB:esxi-01', fleetId: 'esxi-01', name: 'esxi-01', vcenterId: 'vcB' },
      // 같은 vCenter 의 같은 key 는 한 번만
      { serverId: 'host:vcA:esxi-01', fleetId: 'esxi-01', name: 'esxi-01', vcenterId: 'vcA' },
      // 서비스태그가 같으면 다른 vCenter 여도 같은 박스(v2.629) — 한 번만, dupSameBox
      { serverId: 's1', serviceTag: 'TAG1', name: 'p1', vcenterId: 'vcA' },
      { serverId: 's2', serviceTag: 'TAG1', name: 'p1', vcenterId: 'vcB' },
    ],
    rowsByKey: new Map([['esxi-01', { cpu_pct: 50, mem_pct: 50, ts: Date.now(), src: 'idrac' }]]),
  });
  const b = r.corps.find((c) => c.vcenterId === 'vcB');
  assert.ok(b, 'B 법인 행이 사라졌다');
  assert.equal(b.bm.servers, 1);
  assert.equal(b.bm.keyConflict, 1);
  assert.equal(b.bm.dupSameBox, 1);
  assert.equal(r.totals.all.bm.servers, 3);
});

/* ── R2D-09 ─────────────────────────────────────────────────────────────── */

test('R2D-09 사라진 시리즈는 한계 × (1+유예) 뒤로는 합계를 깨지 않는다 — 다시 나오면 되살아난다', () => {
  const bucketMs = 60_000; const lim = 2 * bucketMs; const n = 40;
  const buckets = Array.from({ length: n }, (_, i) => 1_000_000 + i * bucketMs);
  const a = { key: 'a', sum: buckets.map(() => 100) };
  const gone = { key: 'g', sum: buckets.map((_, i) => (i < 10 ? 5 : null)) };
  const r = sumArrayTraffic({ buckets, bucketMs, series: [a, gone] }, { carryMs: lim });
  const retireAt = 9 + Math.floor((lim * (1 + SERIES_RETIRE_CARRIES)) / bucketMs) + 1;
  assert.equal(r.total[n - 1], 100, '예전엔 끝까지 null');
  assert.equal(r.total[11], 105, '한계 안은 이월');
  assert.equal(r.total[13], null, '한계 ~ 유예 구간은 모른다');
  assert.equal(r.total[retireAt], 100);
  assert.equal(r.retiredSeries, 1);
  const back = { key: 'g', sum: buckets.map((_, i) => (i < 10 || i === n - 1 ? 5 : null)) };
  const r2 = sumArrayTraffic({ buckets, bucketMs, series: [a, back] }, { carryMs: lim });
  assert.equal(r2.total[n - 1], 105);
  assert.equal(r2.retiredSeries, 0);
  // carryMs 없음(0)이면 예전 판정(유예 없음 — 퇴역도 없다)
  assert.equal(sumArrayTraffic({ buckets, bucketMs, series: [a, gone] }, {}).retiredSeries, 0);
});
