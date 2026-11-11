// v2.962 비교 세트 — diskstats IOPS · 응답 시간 · I/O DB 열 덧붙이기(v2.956 DB) · 조립(compareSet.js) · 라우트 · 격자(결함 수정).
// src 모듈은 전부 before() 에서 동적 import — 정적 import 는 호이스팅되어 아래 env(CONFIG_DIR) 보다 먼저 config.js 를 평가한다(bmstorIo2915 머리말).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmset2962-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
process.env.BMSTOR_IO_DB_PATH = path.join(tmp, 'bmstor-io.db');
process.env.BMSTOR_HISTORY_DB_PATH = path.join(tmp, 'bmstor-history.db');
delete process.env.BMSTOR_IO_SAMPLE_SEC;

const HOUR = 3600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;   // 정시 경계 고정

let ds, poller, ioDb, cs, registry, srv, base;
const USERS = {
  full: { username: 'full', role: 'admin', scope: null },
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-us-east'] } },
};

/** v2.956 모양의 I/O DB 를 미리 만든다(열 덧붙이기 검증용 — 새 열이 없는 옛 표 + 옛 행 하나). */
async function makeV2956Db(file) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  const rollup = (t) => `CREATE TABLE ${t} (server_id TEXT NOT NULL, b INTEGER NOT NULL, n INTEGER NOT NULL, n_avg INTEGER NOT NULL, sum_avg REAL NOT NULL, sum_rd REAL NOT NULL,
    sum_wr REAL NOT NULL, max_inst INTEGER, max_rd INTEGER, max_wr INTEGER, max_busy REAL, last_ts INTEGER NOT NULL, PRIMARY KEY (server_id, b));`;
  db.exec(`CREATE TABLE io_raw (server_id TEXT NOT NULL, ts INTEGER NOT NULL, name TEXT NOT NULL DEFAULT '', avg_rd INTEGER, avg_wr INTEGER, avg_busy REAL,
      inst_rd INTEGER, inst_wr INTEGER, busy REAL, rd_sectors INTEGER, wr_sectors INTEGER, io_ms INTEGER, uptime REAL, disks INTEGER, PRIMARY KEY (server_id, ts));
    CREATE TABLE io_last (server_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, rd_sectors INTEGER, wr_sectors INTEGER, io_ms INTEGER, uptime REAL);
    ${rollup('io_r15')} ${rollup('io_r1h')}`);
  db.prepare('INSERT INTO io_raw (server_id, ts, name, avg_rd, avg_wr, avg_busy, inst_rd, inst_wr, busy, rd_sectors, wr_sectors, io_ms, uptime, disks) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('old-srv', NOW - 5 * HOUR, 'old', 1000, 500, 10, 2000, 1000, 20, 1, 1, 1, 100, 2);
  db.prepare('INSERT INTO io_r1h (server_id, b, n, n_avg, sum_avg, sum_rd, sum_wr, max_inst, max_rd, max_wr, max_busy, last_ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('old-srv', NOW - 5 * HOUR, 1, 1, 1500, 1000, 500, 3000, 2000, 1000, 20, NOW - 5 * HOUR);
  db.close();
}

before(async () => {
  await makeV2956Db(process.env.BMSTOR_IO_DB_PATH);
  ds = await import('../src/bmstor/diskstats.js');
  poller = await import('../src/bmstor/poller.js');
  ioDb = await import('../src/bmstor/ioDb.js');
  cs = await import('../src/bmstor/compareSet.js');
  registry = await import('../src/bmstor/registry.js');
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
});
after(() => { try { srv?.close(); } catch { /* */ } try { ioDb?._resetBmIoDbForTest(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
async function call(u, p) {
  const r = await fetch(base + p, { headers: { 'x-u': u } });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, t, j };
}

// diskstats 한 구간 — [rd_ios, rd_sectors, rd_ticks, wr_ios, wr_sectors, wr_ticks, io_ticks]
const line = (name, a) => `   8 0 ${name} ${a[0]} 0 ${a[1]} ${a[2]} ${a[3]} 0 ${a[4]} ${a[5]} 0 ${a[6]} 0`;
const block = (up, sda, nvme) => [`${up}.00 ${up}.00`, line('sda', sda), line('nvme0n1', nvme)].join('\n');

test('diskstats: IOPS = Δ완료 횟수 ÷ 경과 · 응답 시간 = Δ소요 ms ÷ Δ횟수(I/O 가중 — 디스크별 평균의 평균이 아니다) · 카운터에 횟수 · 소요 ms', () => {
  // sda: 2초에 읽기 100 · 쓰기 100 회, 소요 400 + 400 ms → 4 ms · nvme: 읽기 1000 회, 소요 200 ms → 0.2 ms
  const out = `${block(1000, [0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0])}\n${ds.IO_SEP}\n${block(1002, [100, 800, 400, 100, 800, 400, 1000], [1000, 8000, 200, 0, 0, 0, 500])}`;
  const p = ds.parseIoSample(out);
  const r = ds.ioRate(p.before, p.after);
  assert.ok(r.ok);
  assert.equal(r.io.iops, 600);               // (200 + 1000) / 2
  assert.equal(r.io.readIops, 550); assert.equal(r.io.writeIops, 50);
  assert.equal(r.io.latMs, 0.83);            // (800 + 200) / 1200 — I/O 가중(평균의 평균이면 2.1)
  assert.deepEqual([r.io.counters.rdIos, r.io.counters.wrIos, r.io.counters.rwTicks], [1100, 100, 1000]);
  // I/O 0 → 응답 시간 null(0 ms 아님)
  const idle = ds.parseIoSample(`${block(1000, [5, 0, 7, 5, 0, 7, 0], [1, 0, 1, 1, 0, 1, 0])}\n${ds.IO_SEP}\n${block(1002, [5, 0, 7, 5, 0, 7, 0], [1, 0, 1, 1, 0, 1, 0])}`);
  const ri = ds.ioRate(idle.before, idle.after);
  assert.equal(ri.io.iops, 0); assert.equal(ri.io.latMs, null);
  // 횟수 열을 못 읽으면(수가 아닌 값) IOPS · 응답 시간 null — 처리량은 그대로
  const bad = `1000.00 1000.00\n   8 0 sda x 0 2 3 4 0 5 6 0 7 0\n${ds.IO_SEP}\n1002.00 1002.00\n   8 0 sda x 0 1026 3 4 0 5 6 0 7 0`;
  const ps = ds.parseIoSample(bad);
  const rs = ds.ioRate(ps.before, ps.after);
  assert.ok(rs.ok, rs.error);
  assert.equal(rs.io.readBps, 1024 * 512 / 2);
  assert.equal(rs.io.iops, null); assert.equal(rs.io.latMs, null); assert.equal(rs.io.counters.rdIos, undefined);
});

test('diskstats.intervalAvg: 두 쪽 모두 횟수 · 소요 카운터가 있으면 avgIops · dIos · dTicks · 없거나 역행이면 null(처리량 평균은 그대로)', () => {
  const prev = { ts: NOW - 600_000, counters: { rdSectors: 0, wrSectors: 0, ioMs: 0, uptimeSec: 1000, rdIos: 1000, wrIos: 500, rwTicks: 3000 } };
  const cur = { ts: NOW, counters: { rdSectors: 1_200_000, wrSectors: 0, ioMs: 60_000, uptimeSec: 1600, rdIos: 61_000, wrIos: 30_500, rwTicks: 183_000 } };
  const a = ds.intervalAvg(prev, cur, { maxGapMs: 1_200_000 });
  assert.equal(a.avgIops, 150);   // 90,000 / 600 s
  assert.equal(a.dIos, 90_000); assert.equal(a.dTicks, 180_000);
  assert.equal(a.avgReadBps, 1_024_000);   // 1,200,000 섹터 × 512 / 600 s
  const old = { ...prev, counters: { ...prev.counters, rdIos: undefined, wrIos: undefined, rwTicks: undefined } };
  const b = ds.intervalAvg(old, cur, { maxGapMs: 1_200_000 });
  assert.equal(b.avgIops, null); assert.equal(b.dIos, null); assert.equal(b.avgReadBps, 1_024_000, 'v2.956 카운터와 섞이면 처리량만');
  const back = ds.intervalAvg(prev, { ...cur, counters: { ...cur.counters, rdIos: 10 } }, { maxGapMs: 1_200_000 });
  assert.equal(back.avgIops, null, '횟수 역행');
});

test('poller.sanitizeBmIo: IOPS · 응답 시간 · 횟수 카운터는 수일 때만 · 음수는 null · 카운터 셋이 다 있어야 싣는다', () => {
  const io = poller.sanitizeBmIo({ readBps: 1, writeBps: 2, iops: '600', readIops: 550, writeIops: 50, latMs: -1, counters: { rdSectors: 1, wrSectors: 2, ioMs: 3, uptimeSec: 4, rdIos: '5', wrIos: 6, rwTicks: 7 } });
  assert.equal(io.iops, 600); assert.equal(io.latMs, null, '음수 → null');
  assert.deepEqual([io.counters.rdIos, io.counters.wrIos, io.counters.rwTicks], [5, 6, 7]);
  const part = poller.sanitizeBmIo({ readBps: 1, writeBps: 2, counters: { rdSectors: 1, wrSectors: 2, ioMs: 3, rdIos: 5 } });
  assert.equal(part.counters.rdIos, undefined, '셋 중 하나라도 없으면 싣지 않는다');
  assert.equal(part.iops, null, 'v2.956 엣지 회신 — IOPS 없음');
});

test('ioDb: v2.956 DB 에 열을 덧붙인다(옛 행 보존 · 새 열은 빔) · 둘째 표본부터 IOPS · I/O 가중 응답 시간 · 집계 합', async () => {
  const t0 = NOW - 3 * HOUR;
  const io = (rdIos, wrIos, ticks, up, extra = {}) => ({ readBps: 1e6, writeBps: 5e5, totalBps: 1.5e6, busyPct: 30, iops: 900, latMs: 7.5, disks: 2,
    counters: { rdSectors: up * 10, wrSectors: up * 5, ioMs: up * 100, uptimeSec: up, rdIos, wrIos, rwTicks: ticks }, ...extra });
  const r1 = await ioDb.recordIoSamples([{ serverId: 'srvA', name: 'A', ts: t0, io: io(1000, 1000, 10_000, 100_000) }], { intervalMs: 600_000 });
  assert.ok(r1.ok, r1.reason);
  await ioDb.recordIoSamples([{ serverId: 'srvA', ts: t0 + 600_000, io: io(1000 + 30_000, 1000 + 30_000, 10_000 + 120_000, 100_600) }], { intervalMs: 600_000 });
  const raw = await ioDb.ioRawRows('srvA', t0 - 1, t0 + 600_001);
  assert.equal(raw[0].avgIops, null, '첫 행은 차분 없음');
  assert.equal(raw[1].avgIops, 100);           // 60,000 / 600 s
  assert.equal(raw[1].dIos, 60_000); assert.equal(raw[1].dTicks, 120_000);
  assert.equal(raw[1].instIops, 900); assert.equal(raw[1].instLat, 7.5);
  const roll = await ioDb.ioRollupRows('r1h', 'srvA', t0, t0 + HOUR);
  assert.equal(roll[0].nIops, 1); assert.equal(roll[0].sumIops, 100); assert.equal(roll[0].sumDios, 60_000); assert.equal(roll[0].sumDticks, 120_000);
  assert.equal(roll[0].maxIops, 900); assert.equal(roll[0].maxLat, 7.5);
  assert.equal(roll[0].nAbusy, 0, 'v2.970: 합계 카운터(디스크별 맵 없음 — 구버전 엣지) 구간은 바쁨 평균을 모른다(합계 io_ms 로는 가장 바쁜 디스크를 알 수 없다)');
  // 옛 행(v2.956 DB)은 그대로 읽히고 새 열은 비어 있다
  const old = await ioDb.ioRawRows('old-srv', NOW - 6 * HOUR, NOW);
  assert.equal(old.length, 1); assert.equal(old[0].avgTotal, 1500); assert.equal(old[0].avgIops, null); assert.equal(old[0].dIos, null);
  const oldRoll = await ioDb.ioRollupRows('r1h', 'old-srv', NOW - 6 * HOUR, NOW);
  assert.equal(oldRoll[0].sumAvg, 1500); assert.equal(oldRoll[0].nIops, 0); assert.equal(oldRoll[0].maxLat, null);
  // 열 덧붙이기는 멱등(이미 있으면 0개)
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(process.env.BMSTOR_IO_DB_PATH);
  try { assert.equal(ioDb.ensureColumns(db), 0); } finally { db.close(); }
});

test('compareSet: 대상 파싱 · 격자 넓히기 · 칸 묶기(평균 · 최댓값) · 원시/집계 → 지표 넷 · 응답 시간은 I/O 가중', () => {
  const ids = cs.parseSetIds('bm:a, san:000197900001 ,bmg:HPC,bm:a,zz:1,bmc:__none__,bm:b');
  assert.deepEqual(ids.map((x) => x.id), ['bm:a', 'san:000197900001', 'bmg:HPC', 'bmc:__none__'], '상한 4 · 중복 · 모르는 종류 제외');
  assert.equal(cs.gridMs(60_000, 600_000), 600_000, '수집 주기 10분이면 1분 격자를 10분으로');
  assert.equal(cs.gridMs(900_000, 600_000), 900_000, '집계 격자가 더 넓으면 그대로');
  assert.equal(cs.gridMs(60_000, 0), 60_000); assert.equal(cs.gridMs(60_000, 90_000), 120_000, '분 단위 올림');
  const buckets = [0, 600_000, 1_200_000];
  const b = cs.bucketize([{ t: 0, v: 10, p: 30 }, { t: 100_000, v: 20, p: 25 }, { t: 1_250_000, v: null, p: 7 }, { t: 9e9, v: 1 }], buckets, 600_000);
  assert.deepEqual(b.avg, [15, null, null]); assert.deepEqual(b.peak, [30, null, 7]);
  const raw = cs.bmMetricsFromRaw([
    { ts: 0, avgTotal: 100, instTotal: 400, avgIops: 10, instIops: 50, dIos: 100, dTicks: 100, instLat: 3, avgBusy: 10, busy: 40 },
    { ts: 300_000, avgTotal: 300, instTotal: 200, avgIops: 30, instIops: 60, dIos: 900, dTicks: 9000, instLat: 20, avgBusy: 20, busy: 30 },
  ], buckets, 600_000);
  assert.equal(raw.tput.avg[0], 200); assert.equal(raw.tput.peak[0], 400);
  assert.equal(raw.iops.avg[0], 20); assert.equal(raw.iops.peak[0], 60);
  assert.equal(raw.lat.avg[0], 9.1, '(100 + 9000) / (100 + 900) — 평균의 평균(5.5)이 아니다');
  assert.equal(raw.lat.peak[0], 20); assert.equal(raw.busy.avg[0], 15); assert.equal(raw.busy.peak[0], 40);
  assert.equal(raw.lat.avg[1], null, '값 없는 칸은 null');
  const roll = cs.bmMetricsFromRollup([
    { b: 0, nAvg: 2, sumAvg: 400, maxInst: 500, nIops: 2, sumIops: 40, maxIops: 70, sumDios: 1000, sumDticks: 5000, maxLat: 12, nAbusy: 2, sumAbusy: 50, maxBusy: 60 },
    { b: 600_000, nAvg: 0, sumAvg: 0, maxInst: null, nIops: 0, sumIops: 0, maxIops: null, sumDios: 0, sumDticks: 0, maxLat: null, nAbusy: 0, sumAbusy: 0, maxBusy: null },
  ], buckets, 600_000);
  assert.deepEqual([roll.tput.avg[0], roll.iops.avg[0], roll.lat.avg[0], roll.busy.avg[0]], [200, 20, 5, 25]);
  assert.deepEqual([roll.tput.avg[1], roll.iops.avg[1], roll.lat.avg[1], roll.busy.avg[1]], [null, null, null, null], 'v2.956 행(n_* = 0)은 0 이 아니라 null');
});

test('compareSet.combineBm: 합은 측정된 구성원 전부에 값이 있는 칸만 · 응답 시간 Σ/Σ · 바쁨은 가장 바쁜 서버 · 부분 칸 수', () => {
  const m = (tput, iops, dios, dticks, busy) => ({
    tput: { avg: tput, peak: tput.map((v) => (v == null ? null : v * 2)) }, iops: { avg: iops, peak: iops },
    lat: { avg: dios.map((d, i) => (d ? dticks[i] / d : null)), peak: dios.map(() => 1), sDios: dios, sDticks: dticks },
    busy: { avg: busy, peak: busy },
  });
  const a = m([100, 100], [10, 10], [100, 100], [100, 100], [10, 90]);
  const b = m([50, null], [5, null], [900, null], [9000, null], [40, null]);
  const never = m([null, null], [null, null], [null, null], [null, null], [null, null]);   // 측정 안 된 서버 — 판정에서 빠진다
  const c = cs.combineBm([a, b, never], 2);
  assert.deepEqual(c.metrics.tput.avg, [150, null]); assert.deepEqual(c.metrics.tput.peak, [300, null]);
  assert.deepEqual(c.metrics.iops.avg, [15, null]);
  assert.deepEqual(c.metrics.lat.avg, [9.1, null]);
  assert.deepEqual(c.metrics.busy.avg, [40, null]);
  assert.deepEqual(c.measured, { tput: 2, iops: 2, lat: 2, busy: 2 }); assert.deepEqual(c.partial, { tput: 1, iops: 1, lat: 1, busy: 1 });
});

test('compareSet.feMetrics: 창에 나온 부모 단위만 · IOPS 합(하나라도 없으면 null) · 응답 시간 최댓값 · 바쁨은 FA busy 또는 CPU · 집계 행은 mx 로 피크', () => {
  const units = [{ id: 1, kind: 'fa' }, { id: 2, kind: 'fa' }, { id: 3, kind: 'port' }, { id: 9, kind: 'fa' }];   // 9 = 오래전에 빠진 디렉터(창에 없음)
  const rows = [
    { node: 1, ts: 0, v: { iops: 100, lat: 1, busy: 30, hbps: 1e6 } }, { node: 2, ts: 0, v: { iops: 300, lat: 4, busy: 50, hbps: 3e6 } },
    { node: 3, ts: 0, v: { iops: 9999, lat: 99, busy: 99, hbps: 9e9 } },   // 포트 — 중복이라 뺀다
    { node: 1, ts: 300_000, v: { iops: 200, lat: 2, busy: 20, hbps: 2e6 } },   // 2 가 없다 → IOPS · 처리량 합 null
  ];
  const f = cs.feMetrics(rows, units, [0, 600_000], 600_000);
  assert.equal(f.units, 2, '9 는 창에 없어 합의 조건에서 빠진다'); assert.equal(f.busyBasis, 'fa-busy');
  assert.equal(f.iops.avg[0], 400, '두 시각 중 합이 되는 것만(0 시각 400)');
  assert.equal(f.lat.avg[0], 3, '(4 + 2) / 2 — 시각마다 최댓값의 평균'); assert.equal(f.lat.peak[0], 4);
  assert.equal(f.busy.avg[0], 35, '시각마다 최댓값(50 · 20)의 평균'); assert.equal(f.busy.peak[0], 50); assert.equal(f.hbps.avg[0], 4e6, '합이 되는 시각만');
  const g = cs.feMetrics([{ node: 5, ts: 0, v: { iops: 10, lat: 1, cpu: 70 }, mx: { iops: 30, lat: 5, cpu: 95 } }], [{ id: 5, kind: 'node' }], [0], 600_000);
  assert.equal(g.busyBasis, 'cpu'); assert.equal(g.busy.avg[0], 70); assert.equal(g.busy.peak[0], 95); assert.equal(g.iops.peak[0], 30); assert.equal(g.lat.peak[0], 5);
  const sw = cs.switchTput([0, 60_000, 120_000, 700_000], [10, 20, null, 40], [15, 25, null, 45], [0, 600_000], 600_000);
  assert.deepEqual(sw.avg, [15, 40], '스위치 칸이 촘촘하면 합이 아니라 평균'); assert.deepEqual(sw.peak, [25, 45]);
  const fm = cs.finishMetric({ avg: [null, null], peak: [null, null] }, { source: 'array-fe', reason: 'fe-ssh' });
  assert.equal(fm.reason, 'fe-ssh'); assert.equal(fm.avgTotal, null);
  assert.equal(cs.finishMetric({ avg: [1, 3], peak: [2, 9] }, { reason: 'x' }).reason, null, '값이 있으면 사유 없음');
  // 화면 확인에서 발견: 평균을 정수로 반올림해 응답 시간 평균(2.6 → 3)이 피크(2.6)보다 커 보였다 — ms · % 는 소수 그대로.
  const lat = cs.finishMetric({ avg: [2.6, null], peak: [2.6, null] });
  assert.equal(lat.avgTotal, 2.6); assert.ok(lat.avgTotal <= lat.peakTotal, '평균 ≤ 피크');
  assert.equal(cs.finishMetric({ avg: [1, 2, 2], peak: [3, 3, 3] }).avgTotal, 1.667);
});

test('라우트: /tools/bm-storage/compare-set — 범위 계정 403 · 섞인 대상 · 모르는 대상은 missing · 주소 없음 · 1시간 격자는 수집 주기 이상', async () => {
  const s1 = registry.saveBmServer({ name: 'cmp-a', host: '10.7.7.1', mounts: '/', groups: 'G1', datacenterId: 'dc-x' });
  const s2 = registry.saveBmServer({ name: 'cmp-b', host: '10.7.7.2', mounts: '/', groups: 'G1' });
  assert.ok(s1.ok && s2.ok);
  assert.equal((await call('sadm', '/tools/bm-storage/compare-set?ids=bm:x')).s, 403);
  const r = await call('full', `/tools/bm-storage/compare-set?range=1h&ids=bm:${s1.server.id},bmg:G1,bmc:dc-x,san:NOPE123456`);
  assert.equal(r.s, 200, r.t.slice(0, 300));
  assert.ok(!/"host"|10\.7\.7\./.test(r.t), '관리 주소를 싣지 않는다');
  assert.ok(r.j.bucketMs >= 600_000, `격자 ${r.j.bucketMs} — 기본 수집 주기 10분보다 촘촘하면 안 된다`);
  const byId = Object.fromEntries(r.j.targets.map((t) => [t.id, t]));
  assert.equal(byId[`bm:${s1.server.id}`].name, 'cmp-a'); assert.equal(byId[`bm:${s1.server.id}`].datacenterId, 'dc-x');
  assert.equal(byId['bmg:G1'].members.total, 2);
  assert.equal(byId['bmc:dc-x'].members.total, 1);
  assert.equal(byId['san:NOPE123456'].missing, true); assert.equal(byId['san:NOPE123456'].reason, 'unknown-target');
  for (const t of r.j.targets) for (const k of ['tput', 'iops', 'lat', 'busy']) assert.equal(t.metrics[k].avg.length, r.j.buckets.length, `${t.id} ${k} 격자 길이`);
  assert.equal(byId[`bm:${s1.server.id}`].metrics.iops.reason, 'no-iops-data', '표본이 없으면 사유 코드(0 이 아니다)');
  const none = await call('full', '/tools/bm-storage/compare-set?ids=');
  assert.equal(none.s, 200); assert.deepEqual(none.j.targets, []);
});

test('결함 수정: /tools/bm-storage/io/series 의 1시간 격자도 수집 주기 이상(예전 1분 격자 — 실데이터에서 베어메탈 선이 끊긴 점들만 남았다)', async () => {
  const r = await call('full', '/tools/bm-storage/io/series?range=1h&ids=bm:all');
  assert.equal(r.s, 200);
  assert.ok(r.j.bucketMs >= 600_000, `격자 ${r.j.bucketMs}`);
  assert.ok(r.j.buckets.length >= 6 && r.j.buckets.length <= 8, `칸 ${r.j.buckets.length}`);
});
