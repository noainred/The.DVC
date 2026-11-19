// v2.971 — 베어메탈 디스크 I/O 구간 평균을 디스크별로 · 바쁨 평균 = 가장 바쁜 디스크 · 피크 ≥ 구간 평균 · 묶음 피크 부분 합 금지.
// 사용자 질문(2026-11-11): "여기서 수집되는 전송속도 피크/평균이 그룹에 속한 모든 서버의 IO 를 합친거야?" — 화면은 피크 633 KB/s < 평균 1.18 GB/s,
// IOPS 피크 72 < 평균 3,510, 응답 시간 피크 0.00 < 평균 0.20 ms 였다. 코드에서 찾은 원인 넷을 여기서 고정한다(수정 전 판본으로 되돌리면 깨진다).
// src 모듈은 before() 에서 동적 import(정적 import 는 CONFIG_DIR 보다 먼저 config.js 를 평가한다 — bmstorIo2915 머리말).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmio2971-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
process.env.BMSTOR_IO_DB_PATH = path.join(tmp, 'bmstor-io.db');
process.env.BMSTOR_HISTORY_DB_PATH = path.join(tmp, 'bmstor-history.db');
delete process.env.BMSTOR_IO_SAMPLE_SEC;

const MIN = 60_000;
let ds, dm, poller, ioDb, cs, ser, agg, registry, srv, base;
const USERS = { full: { username: 'full', role: 'admin', scope: null } };

before(async () => {
  ds = await import('../src/bmstor/diskstats.js');
  dm = await import('../src/bmstor/diskMap.js');
  poller = await import('../src/bmstor/poller.js');
  ioDb = await import('../src/bmstor/ioDb.js');
  cs = await import('../src/bmstor/compareSet.js');
  ser = await import('../src/bmstor/ioSeries.js');
  agg = await import('../src/bmstor/agg.js');
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

// 장치 한 개의 누적 카운터 — diskstats.parseDiskstats 의 모양
const dev = (rdS, wrS, io, rdI = 0, wrI = 0, t = 0) => ({ rdSectors: rdS, wrSectors: wrS, ioMs: io, rdIos: rdI, wrIos: wrI, rwTicks: t });
const snap = (up, list) => ({ uptimeSec: up, devices: new Map(list) });

test('결함 ②(재현): 수집 사이에 디스크가 한 번 빠졌다 돌아와도 구간 평균이 그 디스크의 평생 누적만큼 튀지 않는다 — 두 수집 모두에 있는 디스크끼리만 뺀다', () => {
  const BIG = 400e12 / 512;   // sdb: 평생 400TB 읽음
  // 수집 1: 둘 다 · 수집 2: 2초 표본 'before' 에 sdb 가 없었다(경로 재스캔 · 순간 누락) · 수집 3: 다시 둘 다
  const c1 = ds.ioRate(snap(1000, [['sda', dev(1e6, 1e6, 1e5)], ['sdb', dev(BIG, 1e6, 5e9)]]), snap(1002, [['sda', dev(1e6 + 200, 1e6 + 200, 1e5 + 20)], ['sdb', dev(BIG + 100, 1e6, 5e9 + 10)]]));
  const c2 = ds.ioRate(snap(1600, [['sda', dev(1.1e6, 1.1e6, 1.1e5)]]), snap(1602, [['sda', dev(1.1e6 + 200, 1.1e6 + 200, 1.1e5 + 20)], ['sdb', dev(BIG + 2e5, 1e6, 5e9 + 2e4)]]));
  const c3 = ds.ioRate(snap(2200, [['sda', dev(1.2e6, 1.2e6, 1.2e5)], ['sdb', dev(BIG + 3e5, 1e6, 5e9 + 3e4)]]), snap(2202, [['sda', dev(1.2e6 + 200, 1.2e6 + 200, 1.2e5 + 20)], ['sdb', dev(BIG + 3e5 + 100, 1e6, 5e9 + 3e4 + 10)]]));
  assert.ok(c2.io.counters.disks.sdb, '2초 표본에서 뺀 디스크도 디스크별 누적 맵에는 실린다(after 시점의 누적 상태)');
  const a12 = ds.intervalAvg({ ts: 0, counters: c1.io.counters }, { ts: 600_000, counters: c2.io.counters });
  const a23 = ds.intervalAvg({ ts: 600_000, counters: c2.io.counters }, { ts: 1_200_000, counters: c3.io.counters });
  for (const a of [a12, a23]) {
    assert.equal(a.basis, 'disk');
    const tot = a.avgReadBps + a.avgWriteBps;
    assert.ok(tot < 1_000_000, `구간 평균 ${tot} B/s — 예전(합계 카운터)에는 667 GB/s 로 튀었다`);
    assert.ok(a.avgBusyPct < 10, `바쁨 ${a.avgBusyPct}% — 예전에는 100%`);
  }
  // 합계 기준(디스크별 맵이 없는 구버전 엣지)에서는 같은 일이 튄다 — 그래서 합계 기준 구간은 바쁨 평균을 내지 않는다
  const strip = (c) => { const { disks, ...rest } = c; return rest; };
  const legacy = ds.intervalAvg({ ts: 600_000, counters: strip(c2.io.counters) }, { ts: 1_200_000, counters: strip(c3.io.counters) });
  assert.equal(legacy.basis, 'total'); assert.equal(legacy.avgBusyPct, null);
});

test('결함 ③(재현): 구간 평균 바쁨 = 가장 바쁜 디스크(2초 표본과 같은 뜻) — 예전에는 모든 디스크 io_ms 합 ÷ 경과(20개 × 3% → 60%)', () => {
  const many = (k, hot = 0) => Array.from({ length: 20 }, (_, i) => [`sd${String.fromCharCode(97 + i)}`, dev(0, 0, i === 0 ? hot : k)]);
  const m1 = ds.ioRate(snap(0, many(0)), snap(2, many(60)));
  const m2 = ds.ioRate(snap(600, many(18_000)), snap(602, many(18_060)));
  assert.equal(m1.io.busyPct, 3);
  assert.equal(ds.intervalAvg({ ts: 0, counters: m1.io.counters }, { ts: 600_000, counters: m2.io.counters }).avgBusyPct, 3);
  // 한 디스크만 40% 바쁘면 40
  const h1 = ds.ioRate(snap(0, many(0, 0)), snap(2, many(60, 60)));
  const h2 = ds.ioRate(snap(600, many(18_000, 240_000)), snap(602, many(18_060, 240_060)));
  assert.equal(ds.intervalAvg({ ts: 0, counters: h1.io.counters }, { ts: 600_000, counters: h2.io.counters }).avgBusyPct, 40);
});

test('intervalAvg(디스크별): 새로 보인 디스크 · 카운터가 준 디스크(교체)는 그 구간에서 뺀다 · IOPS 는 비교한 디스크 전부에 열이 있어야 · 한쪽만 맵이면 null', () => {
  const p = { ts: 0, counters: { uptimeSec: 1000, rdSectors: 0, wrSectors: 0, ioMs: 0, disks: { sda: [1000, 0, 0, 10, 0, 50], sdb: [9e9, 0, 9e6, 9e6, 0, 9e7] } } };
  const c = { ts: 600_000, counters: { uptimeSec: 1600, rdSectors: 0, wrSectors: 0, ioMs: 0, disks: { sda: [1000 + 1_171_875, 0, 60_000, 10 + 60_000, 0, 50 + 120_000], sdb: [5, 0, 5, 5, 0, 5], sdc: [8e9, 0, 8e6, 8e6, 0, 8e7] } } };
  const a = ds.intervalAvg(p, c);
  assert.equal(a.disks, 1, 'sdb(카운터가 줄었다 — 교체) · sdc(앞 수집에 없었다)는 뺀다');
  assert.equal(a.avgReadBps, 1_000_000); assert.equal(a.avgBusyPct, 10); assert.equal(a.avgIops, 100); assert.equal(a.dIos, 60_000); assert.equal(a.dTicks, 120_000);
  const noCols = { ...c, counters: { ...c.counters, disks: { ...c.counters.disks, sda: [1000 + 1_171_875, 0, 60_000, null, null, null] } } };
  const b = ds.intervalAvg(p, noCols);
  assert.equal(b.avgIops, null, 'I/O 횟수 열이 없는 디스크가 있으면 IOPS · 응답 시간 재료는 null(부분 합 금지)'); assert.equal(b.avgReadBps, 1_000_000);
  const legacyPrev = { ts: 0, counters: { uptimeSec: 1000, rdSectors: 1, wrSectors: 1, ioMs: 1 } };
  assert.equal(ds.intervalAvg(legacyPrev, c), null, '합계 ↔ 디스크별 전환 구간(업그레이드 직후)은 섞어 빼지 않는다');
  assert.equal(ds.intervalAvg(p, { ...c, counters: { ...c.counters, disks: { sdz: [1, 1, 1, 1, 1, 1] } } }), null, '비교할 디스크가 없으면 모름');
});

test('반증 F4 · F5 · F1: 시간 열 32비트 넘침은 보정(처리량을 버리지 않는다) · 연속 재부팅(가동 시간 차 < 수집 간격)은 모름 · 합계 기준은 디스크 수가 다르면 모름', () => {
  const U32 = 2 ** 32;
  const p = { ts: 0, counters: { uptimeSec: 1000, disks: { sda: [1000, 0, U32 - 1000, 10, 0, U32 - 500] } } };
  const c = { ts: 600_000, counters: { uptimeSec: 1600, disks: { sda: [1000 + 1_171_875, 0, 59_000, 10 + 60_000, 0, 119_500] } } };
  const a = ds.intervalAvg(p, c);
  assert.equal(a.avgReadBps, 1_000_000, 'io_ms 가 돌아도 처리량은 그대로(예전: 디스크째 빼서 1024 B/s)');
  assert.equal(a.avgBusyPct, 10, '(59,000 + 1,000) ÷ 600,000');
  assert.equal(a.dTicks, 120_000, 'rw_ticks 넘침 보정');
  assert.equal(ds.tickDelta(5, U32 - 5), 10); assert.equal(ds.tickDelta(5, 2 * U32 + 9, 2), null, '두 번 보정해도 음수면 모름');
  // 2초 표본도 같은 규칙
  const r = ds.ioRate(snap(1000, [['sda', dev(100, 0, U32 - 100)]]), snap(1002, [['sda', dev(100 + 4096, 0, 900)]]));
  assert.equal(r.io.readBps, 4096 * 512 / 2); assert.equal(r.io.busyPct, 50); assert.equal(r.io.skipped, 0);
  // F5: 앞 수집 가동 100초 → 재부팅 → 이번 가동 400초(cu > pu 지만 600초가 지났다)
  const rb = ds.intervalAvg({ ts: 0, counters: { uptimeSec: 100, disks: { sda: [0, 0, 0, 0, 0, 0] } } }, { ts: 600_000, counters: { uptimeSec: 400, disks: { sda: [9e6, 0, 1, 1, 0, 1] } } });
  assert.equal(rb, null, '연속 재부팅');
  // 엣지 지연 정도(수집 시각 차가 가동 시간 차보다 60초 큼)는 재부팅으로 보지 않는다
  assert.ok(ds.intervalAvg({ ts: 0, counters: { uptimeSec: 1000, disks: { sda: [0, 0, 0, 0, 0, 0] } } }, { ts: 660_000, counters: { uptimeSec: 1600, disks: { sda: [1, 0, 1, 1, 0, 1] } } }));
  // F1: 합계 기준 — 디스크 수가 바뀐 구간은 모름(같으면 낸다)
  const tp = { ts: 0, counters: { uptimeSec: 1000, rdSectors: 1, wrSectors: 1, ioMs: 1, nDisks: 1 } };
  const tc = { ts: 600_000, counters: { uptimeSec: 1600, rdSectors: 9e12, wrSectors: 1, ioMs: 1, nDisks: 2 } };
  assert.equal(ds.intervalAvg(tp, tc), null);
  assert.equal(ds.intervalAvg(tp, { ...tc, counters: { ...tc.counters, nDisks: 1, rdSectors: 1_171_876 } }).avgReadBps, 1_000_000);
});

test('반증 F6 · F3: 묶음 합이 모두 0 이면 피크도 0(모름이 아니다) · 바쁨 평균이 없는 구성원의 2초 바쁨도 묶음 피크에 들어간다', () => {
  assert.deepEqual(ser.sumSeries([{ avg: [0], peak: [0] }, { avg: [0], peak: [null] }], 1).peak, [0]);
  const comb = cs.combineBm([{ busy: { avg: [10], peak: [12] } }, { busy: { avg: [null], peak: [35] } }], 1);
  assert.equal(comb.metrics.busy.avg[0], 10, '평균은 평균이 있는 구성원(측정된 구성원)으로');
  assert.equal(comb.metrics.busy.peak[0], 35, '피크는 최댓값이라 일부만 있어도 하한 — 빠졌던 구성원(35)을 넣는다');
});

test('엣지 정제(sanitizeDiskMap · sanitizeBmIo): 이름은 32자 이하 통짜 디스크만 · 값 6개 · 음수 · 비수치 디스크는 뺀다 · 문자열 수치는 수로 · 상한 넘으면 맵째 버린다', () => {
  // JSON.parse 로 만든 입력 — 객체 리터럴의 `__proto__:` 는 자기 키가 아니라 프로토타입을 바꿔 검사가 비어 버린다(반증 지적). 엣지 본문은 JSON 이다.
  const input = JSON.parse(`{"sda":["1",2,3,"4",5,6],"dm_0":[1,1,1,1,1,1],"sdb":[1,-2,3,4,5,6],"sdc":[1,2,3,4,null,6],"nvme0n1":[1,2],"${'sd' + 'a'.repeat(40)}":[1,1,1,1,1,1],`
    + '"__proto__":[1,1,1,1,1,1],"constructor":[1,1,1,1,1,1],"sdd":[1e300,1,1,1,1,1]}');
  assert.ok(Object.prototype.hasOwnProperty.call(input, '__proto__'), '입력에 자기 키 __proto__ 가 실제로 있다');
  const m = dm.sanitizeDiskMap(input);
  assert.deepEqual(m, { sda: [1, 2, 3, 4, 5, 6], sdc: [1, 2, 3, null, null, null] }, '__proto__ · constructor · 너무 긴 이름 · 안전 정수 초과(1e300)는 뺀다');
  assert.equal(Object.getPrototypeOf(m), Object.prototype); assert.equal({}.polluted, undefined);
  const huge = Object.fromEntries(Array.from({ length: ds.DISK_MAP_MAX + 1 }, (_, i) => [`sd${i.toString(26).replace(/[0-9]/g, (d) => 'qrstuvwxyz'[d])}x`, [1, 1, 1, 1, 1, 1]]));
  assert.equal(dm.sanitizeDiskMap(huge), null, `상한(${ds.DISK_MAP_MAX}) 초과면 맵째 버린다 — 일부만 남기면 다음 구간과 비교할 디스크 집합이 흔들린다`);
  assert.equal(dm.sanitizeDiskMap([1]), null); assert.equal(dm.sanitizeDiskMap('x'), null);
  const io = poller.sanitizeBmIo({ readBps: 1, writeBps: 2, counters: { rdSectors: 1, wrSectors: 2, ioMs: 3, uptimeSec: 4, disks: { sda: [1, 2, 3, 4, 5, 6], 'x;rm': [1, 1, 1, 1, 1, 1] } } });
  assert.deepEqual(io.counters.disks, { sda: [1, 2, 3, 4, 5, 6] }, '엣지 export 새 필드 = 중앙 화이트리스트');
});

test('현황 응답(agg.aggregate)에는 누적 카운터(디스크별 맵 포함)를 싣지 않는다 — 시계열 DB 재료일 뿐 화면은 쓰지 않는다', () => {
  const latest = new Map([['s1', { ok: true, mounts: [], io: { readBps: 1, writeBps: 2, totalBps: 3, busyPct: 4, counters: { rdSectors: 1, wrSectors: 1, ioMs: 1, disks: { sda: [1, 1, 1, 1, 1, 1] } } } }]]);
  const out = agg.aggregate([{ id: 's1', host: 'h', name: 'n', mounts: ['/'] }], latest);
  const row = (out.servers || out.perServer || []).find((x) => x.id === 's1');
  assert.ok(row && row.io, '행과 io 는 있다');
  assert.equal(row.io.counters, undefined); assert.equal(row.io.totalBps, 3);
  assert.equal(latest.get('s1').io.counters.disks.sda[0], 1, '원본(latest)은 그대로 — DB 적재가 쓴다');
});

test('결함 ①: 피크 ≥ 구간 평균 — 2초 표본이 한가한 순간에 걸려도(원시 · 예전 집계 행 · v2.956 시계열 모두) · 결함 ④: 묶음 피크는 구성원 전부로', () => {
  const buckets = [0, 600_000]; const bucketMs = 600_000;
  // 원시: 2초 표본 633 KB/s · 72 IOPS · 0 ms 인데 구간 평균은 1.18 GB/s · 3,510 IOPS · 0.2 ms(사용자 화면의 숫자)
  const raw = [{ ts: 1000, avgTotal: 1.18e9, instTotal: 633e3, avgIops: 3510, instIops: 72, instLat: 0, dIos: 3510 * 600, dTicks: 3510 * 600 * 0.2, avgBusy: 48, busy: 60.7 }];
  const m = cs.bmMetricsFromRaw(raw, buckets, bucketMs);
  assert.equal(m.tput.peak[0], 1.18e9); assert.equal(m.iops.peak[0], 3510); assert.equal(m.lat.peak[0], 0.2); assert.equal(m.busy.peak[0], 60.7);
  for (const k of ['tput', 'iops', 'lat', 'busy']) {
    const f = cs.finishMetric(m[k]);
    assert.ok(f.peakTotal >= f.avgTotal, `${k}: 피크 ${f.peakTotal} ≥ 평균 ${f.avgTotal}`);
  }
  // 한 칸에 행이 여럿이면 피크 하한은 칸 평균(55)이 아니라 **가장 큰 행 평균(100)** — 행마다 올린 뒤 칸 최댓값
  const two = cs.bmMetricsFromRaw([{ ts: 1000, avgTotal: 100, instTotal: 10, avgIops: 100, instIops: 1, avgBusy: 50, busy: 5 }, { ts: 2000, avgTotal: 10, instTotal: 5, avgIops: 10, instIops: 1, avgBusy: 5, busy: 1 }], buckets, bucketMs);
  assert.equal(two.tput.avg[0], 55); assert.equal(two.tput.peak[0], 100); assert.equal(two.iops.peak[0], 100); assert.equal(two.busy.peak[0], 50);
  // 예전 집계 행(max_* = 2초 표본뿐)도 읽을 때 칸 평균 위로
  const roll = cs.bmMetricsFromRollup([{ b: 0, nAvg: 1, sumAvg: 1.18e9, maxInst: 633e3, nIops: 1, sumIops: 3510, maxIops: 72, sumDios: 1000, sumDticks: 200, maxLat: 0, nAbusy: 1, sumAbusy: 48, maxBusy: 30 }], buckets, bucketMs);
  assert.equal(roll.tput.peak[0], 1.18e9); assert.equal(roll.iops.peak[0], 3510); assert.equal(roll.lat.peak[0], 0.2); assert.equal(roll.busy.peak[0], 48);
  // v2.956 시계열(SAN 비교 탭)도 같은 규칙
  const sr = ser.seriesFromRaw([{ ts: 1000, avgTotal: 1.18e9, instTotal: 633e3, busy: 10, avgBusy: 48 }], buckets, bucketMs);
  assert.equal(sr.peak[0], 1.18e9); assert.equal(sr.busy[0], 48);
  const so = ser.seriesFromRollup([{ b: 0, nAvg: 1, sumAvg: 1.18e9, maxInst: 633e3, maxBusy: 5 }], buckets, bucketMs);
  assert.equal(so.peak[0], 1.18e9);
  // 묶음: 구성원 B 의 피크가 비어도(평균만) 피크 합에 B 를 넣는다 — 예전에는 A 의 피크만 더해 합 피크 < 합 평균이었다
  const sum = ser.sumSeries([{ avg: [100, null], peak: [120, null] }, { avg: [1000, null], peak: [null, null] }], 2);
  assert.equal(sum.avg[0], 1100); assert.equal(sum.peak[0], 1120);
  const comb = cs.combineBm([{ tput: { avg: [100, null], peak: [120, null] } }, { tput: { avg: [1000, null], peak: [null, null] } }], 2);
  assert.ok(comb.metrics.tput.peak[0] >= comb.metrics.tput.avg[0]);
});

test('적재 · 라우트: io_last 에 디스크별 카운터가 남아 재시작 뒤에도 디스크별로 뺀다 · 바쁨 평균은 가장 바쁜 디스크 · 비교 세트 응답의 피크 ≥ 평균(서버 · 그룹)', async () => {
  const a = registry.saveBmServer({ name: 'pd-a', host: '10.69.0.1', mounts: '/', groups: 'PD' });
  const b = registry.saveBmServer({ name: 'pd-b', host: '10.69.0.2', mounts: '/', groups: 'PD' });
  assert.ok(a.ok && b.ok);
  const now = Date.now();
  // 디스크 둘 — sda 는 10분에 600 MB 읽기(1 MB/s) · io 10% · 6만 I/O(100 IOPS) · 소요 12만 ms(2 ms) / sdb 는 같은 처리량에 io 40%
  const ioAt = (k) => ({
    readBps: 1000, writeBps: 0, totalBps: 1000, busyPct: 5, iops: 1, latMs: 0.1, disks: 2, sampleMs: 2000,   // 2초 표본은 한가한 순간
    counters: { rdSectors: 0, wrSectors: 0, ioMs: 0, uptimeSec: 100_000 + k * 600, rdIos: 0, wrIos: 0, rwTicks: 0,
      disks: { sda: [1e6 + k * 1_171_875, 0, k * 60_000, k * 60_000, 0, k * 120_000], sdb: [2e6 + k * 1_171_875, 0, k * 240_000, k * 60_000, 0, k * 120_000] } },
  });
  const ts = (k) => now - 25 * MIN + k * 10 * MIN;
  for (const id of [a.server.id, b.server.id]) {
    const r = await ioDb.recordIoSamples([{ serverId: id, name: id, ts: ts(0), io: ioAt(0) }], { intervalMs: 600_000 });
    assert.ok(r.ok, r.reason);
    await ioDb.recordIoSamples([{ serverId: id, ts: ts(1), io: ioAt(1) }], { intervalMs: 600_000 });
  }
  ioDb._resetBmIoDbForTest();   // 재시작 — 메모리 캐시를 비우고 io_last(disks_json)에서 되살린다
  for (const id of [a.server.id, b.server.id]) await ioDb.recordIoSamples([{ serverId: id, ts: ts(2), io: ioAt(2) }], { intervalMs: 600_000 });
  const raw = await ioDb.ioRawRows(a.server.id, now - HOURISH, now);
  assert.equal(raw.length, 3);
  assert.equal(raw[1].avgTotal, 2_000_000, '두 디스크 × 1 MB/s'); assert.equal(raw[1].avgBusy, 40, '가장 바쁜 디스크(sdb) — 합(50%)이 아니다');
  assert.equal(raw[2].avgTotal, 2_000_000, '재시작 뒤에도 io_last 의 디스크별 카운터로 뺀다'); assert.equal(raw[2].avgIops, 200);
  const roll = await ioDb.ioRollupRows('r15', a.server.id, now - HOURISH, now);
  assert.ok(roll.some((r) => r.nAbusy > 0 && r.sumAbusy / r.nAbusy === 40), '집계 표의 바쁨 평균도 가장 바쁜 디스크');
  assert.ok(roll.every((r) => r.maxInst == null || r.maxInst >= (r.nAvg ? r.sumAvg / r.nAvg : 0)), '집계 피크 ≥ 칸 평균(적재 때 올린다)');
  const res = await call('full', `/tools/bm-storage/compare-set?range=1h&ids=bm:${a.server.id},bmg:PD`);
  assert.equal(res.s, 200, res.t.slice(0, 300));
  for (const t of res.j.targets) {
    for (const k of ['tput', 'iops', 'lat', 'busy']) {
      const mm = t.metrics[k];
      if (mm.avgTotal == null) continue;
      assert.ok(mm.peakTotal >= mm.avgTotal, `${t.id} ${k}: 피크 ${mm.peakTotal} ≥ 평균 ${mm.avgTotal}`);
    }
  }
  const grp = res.j.targets.find((t) => t.id === 'bmg:PD');
  assert.equal(grp.metrics.tput.avgTotal, 4_000_000, '그룹 = 구성원 서버 합(2대 × 2 MB/s)');
  assert.equal(grp.metrics.busy.avgTotal, 40, '그룹 바쁨 = 가장 바쁜 서버');
  // 반증 F7: 1시간(원시) 순위 피크도 행마다 max(2초 표본, 구간 평균) — 선 차트 피크와 같다
  const rank = await ioDb.ioRank('raw', now - HOURISH, now);
  assert.equal(rank.get(a.server.id).peakBps, 2_000_000);
  // 구간 평균이 1 MB/s → 3 MB/s 로 달라지면 순위 피크는 평균의 평균(2)이 아니라 가장 큰 행 평균(3)
  const rk = registry.saveBmServer({ name: 'pd-rank', host: '10.69.0.4', mounts: '/' });
  const rkIo = (sect, k) => ({ readBps: 1000, writeBps: 0, totalBps: 1000, busyPct: 1, disks: 1, counters: { rdSectors: 0, wrSectors: 0, ioMs: 0, uptimeSec: 70_000 + k * 600, disks: { sda: [sect, 0, 0, 0, 0, 0] } } });
  await ioDb.recordIoSamples([{ serverId: rk.server.id, ts: ts(0), io: rkIo(0, 0) }], { intervalMs: 600_000 });
  await ioDb.recordIoSamples([{ serverId: rk.server.id, ts: ts(1), io: rkIo(1_171_875, 1) }], { intervalMs: 600_000 });
  await ioDb.recordIoSamples([{ serverId: rk.server.id, ts: ts(2), io: rkIo(1_171_875 * 4, 2) }], { intervalMs: 600_000 });
  const rk2 = (await ioDb.ioRank('raw', now - HOURISH, now)).get(rk.server.id);
  assert.equal(rk2.avgBps, 2_000_000); assert.equal(rk2.peakBps, 3_000_000);

  // 반증 F2: 구판(v2.970)으로 내렸다 올리면 구판이 io_last 의 ts · 합계만 바꾸고 디스크 맵은 옛것으로 남는다 — 그 맵으로 빼지 않는다(그 구간은 모름).
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(process.env.BMSTOR_IO_DB_PATH);
  try { db.prepare('UPDATE io_last SET ts = ?, uptime = ? WHERE server_id = ?').run(ts(3), 100_000 + 3 * 600, a.server.id); } finally { db.close(); }
  ioDb._resetBmIoDbForTest();
  const stale = ioAt(4);
  stale.counters.disks.sda[0] += 9e9;   // 옛 맵(수집 2) 기준이면 크게 튀었을 값
  await ioDb.recordIoSamples([{ serverId: a.server.id, ts: ts(4), io: stale }], { intervalMs: 600_000 });
  const after = await ioDb.ioRawRows(a.server.id, ts(4) - 1, ts(4) + 1);
  assert.equal(after[0].avgTotal, null, '낡은 맵(disks_ts ≠ ts)은 버리고 그 구간은 모름 — 예전 같으면 수백 배로 튀었다');

  // 반증 F3: 구버전 엣지(디스크별 맵 없음) 서버 — 처리량 평균은 있지만 바쁨 평균은 모름 → 사유는 ‘표본 없음’ 이 아니고 피크(2초 표본)는 보인다
  const l = registry.saveBmServer({ name: 'pd-legacy', host: '10.69.0.3', mounts: '/' });
  const legacy = (k) => ({ readBps: 1000, writeBps: 0, totalBps: 1000, busyPct: 35, disks: 1, counters: { rdSectors: 1e6 + k * 1_171_875, wrSectors: 0, ioMs: k * 60_000, uptimeSec: 50_000 + k * 600 } });
  await ioDb.recordIoSamples([{ serverId: l.server.id, ts: ts(0), io: legacy(0) }], { intervalMs: 600_000 });
  await ioDb.recordIoSamples([{ serverId: l.server.id, ts: ts(1), io: legacy(1) }], { intervalMs: 600_000 });
  const lr = await call('full', `/tools/bm-storage/compare-set?range=1h&ids=bm:${l.server.id}`);
  const lb = lr.j.targets[0].metrics.busy;
  assert.equal(lb.avgTotal, null); assert.equal(lb.reason, 'busy-avg-unknown'); assert.equal(lb.peakTotal, 35);
  assert.equal(lr.j.targets[0].metrics.tput.avgTotal, 1_000_000);
});
const HOURISH = 3_600_000;
