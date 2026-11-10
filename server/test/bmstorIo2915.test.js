// v2.915 베어메탈 ↔ SAN 비교 · 디스크 I/O 표본 · I/O 시계열 DB · 법인 축(설계 docs/design/bm-san-compare).
// 순수 모듈은 정적 import, 설정(CONFIG_DIR)을 읽는 모듈은 env 를 정한 뒤 동적 import. 기준 시각은 정시 경계로 떨어뜨려 고정(docs/rules/common.md).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmio2915-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
process.env.BMSTOR_IO_DB_PATH = path.join(tmp, 'bmstor-io.db');
process.env.BMSTOR_HISTORY_DB_PATH = path.join(tmp, 'bmstor-history.db');
delete process.env.BMSTOR_IO_SAMPLE_SEC;
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
// ⚠ src 모듈은 전부 before() 에서 동적 import — 정적 import 는 호이스팅되어 위 env(CONFIG_DIR) 보다 먼저 config.js 를 평가한다(실측: 개발 config 에 테스트 서버가 쌓였다).
let WHOLE_DISK_RE, IO_SEP, ioSampleSec, ioSampleCommand, parseDiskstats, parseIoSample, ioRate, ioResultFromExec, intervalAvg;
let datacenterOfBmServer, parseDcQuery, datacenterInputIssue, NONE_DC;
let bucketsOf, sourceFor, seriesFromRaw, seriesFromRollup, sumSeries, summarize, parseSeriesIds, rangeKeyOf, metricOf;
let parseTypes, latestSnapshotMap, sanArrayRows, attachThroughput, compareSummary, datacenterChips, stripHost;
let aggregate;
let bmServersToCsv, parseBmServersCsv, analyzeBmServersImport, CSV_COLUMNS;








const HOUR = 3600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;   // 정시 경계 고정

const DS = (up, sda, nvme, dm) => [
  `${up}.00 ${up * 3}.00`,
  `   8       0 sda ${sda[0]} 0 ${sda[1]} 0 ${sda[2]} 0 ${sda[3]} 0 0 ${sda[4]} 0`,
  '   8       1 sda1 10 0 999999 0 10 0 999999 0 0 100 0',                       // 파티션 — 중복
  ` 259       0 nvme0n1 ${nvme[0]} 0 ${nvme[1]} 0 ${nvme[2]} 0 ${nvme[3]} 0 0 ${nvme[4]} 0`,
  `ۢ253       0 dm-0 1 0 ${dm} 0 1 0 ${dm} 0 0 5 0`,                              // dm — 중복(앞 글자 깨짐도 무시)
  '   7       0 loop0 0 0 0 0 0 0 0 0 0 0 0',
].join('\n');

test('diskstats: 통짜 디스크만 센다 — 파티션 · dm · loop 는 뺀다, uptime 을 읽는다', () => {
  const p = parseDiskstats(DS(1000, [1, 2048, 1, 1024, 500], [1, 4096, 1, 2048, 900], 77777));
  assert.equal(p.uptimeSec, 1000);
  assert.deepEqual([...p.devices.keys()].sort(), ['nvme0n1', 'sda']);
  // v2.962: 완료 횟수 · 소요 ms(rd_ticks + wr_ticks)도 읽는다(비교 세트 IOPS · 응답 시간 — bmCompareSet2962)
  assert.deepEqual(p.devices.get('sda'), { rdSectors: 2048, wrSectors: 1024, ioMs: 500, rdIos: 1, wrIos: 1, rwTicks: 0 });
  for (const bad of ['sda1', 'dm-0', 'md0', 'loop0', 'nvme0n1p1', 'ram0']) assert.ok(!WHOLE_DISK_RE.test(bad), bad);
  for (const ok of ['sda', 'sdab', 'vdb', 'xvda', 'nvme1n2', 'mmcblk0', 'hdc']) assert.ok(WHOLE_DISK_RE.test(ok), ok);
});

test('diskstats: 2초 표본 → 속도(512B 섹터 · uptime 차) · 바쁨 = 가장 바쁜 디스크 · 카운터 역행 장치는 뺀다', () => {
  const out = `${DS(1000, [1, 2048, 1, 1024, 500], [1, 4096, 1, 2048, 900], 1)}\n${IO_SEP}\n${DS(1002, [2, 2048 + 4096, 2, 1024 + 2048, 500 + 400], [2, 4096 + 8192, 2, 2048, 900 + 1800], 2)}`;
  const s = parseIoSample(out);
  assert.ok(!s.error, s.error);
  const r = ioRate(s.before, s.after);
  assert.ok(r.ok);
  // sda 읽기 4096섹터 × 512 / 2초 = 1,048,576 B/s · nvme 읽기 8192 × 512 / 2 = 2,097,152 → 합 3,145,728
  assert.equal(r.io.readBps, 3_145_728);
  assert.equal(r.io.writeBps, 2048 * 512 / 2);
  assert.equal(r.io.totalBps, r.io.readBps + r.io.writeBps);
  assert.equal(r.io.busyPct, 90);               // nvme: 1800ms / 2000ms
  assert.equal(r.io.busiestDev, 'nvme0n1');
  assert.equal(r.io.disks, 2);
  assert.equal(r.io.sampleMs, 2000);
  assert.deepEqual(r.io.counters, { rdSectors: 2048 + 4096 + 4096 + 8192, wrSectors: 1024 + 2048 + 2048, ioMs: 900 + 2700, uptimeSec: 1002, rdIos: 4, wrIos: 4, rwTicks: 0 });
  // 역행: nvme 카운터가 줄면 그 장치만 뺀다(0 으로 세지 않는다)
  const back = parseIoSample(`${DS(1000, [1, 2048, 1, 1024, 500], [1, 4096, 1, 2048, 900], 1)}\n${IO_SEP}\n${DS(1002, [2, 4096, 2, 1024, 600], [0, 10, 0, 10, 10], 2)}`);
  const r2 = ioRate(back.before, back.after);
  assert.equal(r2.io.disks, 1); assert.equal(r2.io.skipped, 1); assert.equal(r2.io.readBps, 2048 * 512 / 2);
  // uptime 역행(재부팅) → 오류
  const reboot = parseIoSample(`${DS(1000, [1, 1, 1, 1, 1], [1, 1, 1, 1, 1], 1)}\n${IO_SEP}\n${DS(5, [1, 1, 1, 1, 1], [1, 1, 1, 1, 1], 1)}`);
  assert.equal(ioRate(reboot.before, reboot.after).ok, false);
});

test('diskstats: exec 결과 → io | ioError — Linux 가 아니면 사유, 구분자 없으면 사유, 표본 간격 env 는 0(끔) · 1~10 클램프 · 명령은 상수', () => {
  assert.equal(ioResultFromExec({ code: 1, stdout: '', stderr: 'cat: /proc/diskstats: No such file or directory' }).ioError.includes('Linux'), true);
  assert.equal(ioResultFromExec({ code: 0, stdout: 'garbage', stderr: '' }).io, null);
  const good = ioResultFromExec({ code: 0, stdout: `${DS(1000, [1, 0, 1, 0, 0], [1, 0, 1, 0, 0], 0)}\n${IO_SEP}\n${DS(1002, [1, 2048, 1, 0, 0], [1, 0, 1, 0, 0], 0)}`, stderr: '' });
  assert.equal(good.ioError, null); assert.equal(good.io.readBps, 2048 * 512 / 2);
  assert.equal(ioSampleSec({}), 2);
  assert.equal(ioSampleSec({ BMSTOR_IO_SAMPLE_SEC: '0' }), 0);
  assert.equal(ioSampleSec({ BMSTOR_IO_SAMPLE_SEC: '99' }), 10);
  assert.equal(ioSampleSec({ BMSTOR_IO_SAMPLE_SEC: 'abc' }), 2);
  assert.equal(ioSampleCommand(2), `cat /proc/uptime; cat /proc/diskstats; sleep 2; echo ${IO_SEP}; cat /proc/uptime; cat /proc/diskstats`);
  assert.equal(ioSampleCommand('3; rm -rf /'), ioSampleCommand(2));   // 숫자가 아니면 기본 2 — 문자열은 절대 끼우지 않는다
  assert.ok(!ioSampleCommand('3; rm -rf /').includes('rm'));
});

test('diskstats.intervalAvg: 카운터 차분 ÷ uptime 차 = 구간 평균 · 재부팅(uptime 역행) · 공백 > 상한 · 첫 행은 null', () => {
  const prev = { ts: NOW - 600_000, counters: { rdSectors: 1000, wrSectors: 500, ioMs: 10_000, uptimeSec: 100_000 } };
  const cur = { ts: NOW, counters: { rdSectors: 1000 + 11_718_750, wrSectors: 500 + 2_343_750, ioMs: 10_000 + 60_000, uptimeSec: 100_600 } };
  const a = intervalAvg(prev, cur, { maxGapMs: 1_200_000 });
  assert.equal(a.avgReadBps, 10_000_000);     // 11,718,750 × 512 / 600s = 10 MB/s
  assert.equal(a.avgWriteBps, 2_000_000);
  assert.equal(a.avgBusyPct, 10);              // 60,000ms / 600,000ms
  assert.equal(intervalAvg(prev, { ...cur, counters: { ...cur.counters, uptimeSec: 50 } }), null, '재부팅');
  assert.equal(intervalAvg(prev, { ...cur, ts: NOW + 3 * HOUR }, { maxGapMs: 1_200_000 }), null, '공백');
  assert.equal(intervalAvg(null, cur), null, '첫 행');
  assert.equal(intervalAvg(prev, { ...cur, counters: { ...cur.counters, rdSectors: 10 } }), null, '카운터 역행');
});

test('corp.datacenterOfBmServer: 폼 값 → 엣지의 법인(수집 서버 vcenterId → DataCenter) → 미지정 · 자유 문자열 datacenter 는 쓰지 않는다', () => {
  // 엣지 조회는 등록부 코어(findCollectorByName)를 주입한다 — 여기서는 그 계약(이름 · id 대소문자 무시)을 흉내 내는 함수.
  const collectors = [{ id: 'fra-edge', name: 'FRA Edge', vcenterId: 'vc-eu', datacenter: 'Frankfurt' }, { id: 'noname', vcenterId: '' }];
  const findCollector = (q) => collectors.find((c) => [c.id, c.name].map((x) => String(x || '').trim().toLowerCase()).includes(String(q).trim().toLowerCase())) || null;
  const dcOf = (vc) => (vc === 'vc-eu' ? 'dc-fra' : '');
  assert.deepEqual(datacenterOfBmServer({ datacenterId: 'dc-seoul', agent: 'fra-edge' }, { findCollector, datacenterOfVcenter: dcOf }), { datacenterId: 'dc-seoul', datacenterSource: 'server' });
  assert.deepEqual(datacenterOfBmServer({ agent: 'FRA-EDGE' }, { findCollector, datacenterOfVcenter: dcOf }), { datacenterId: 'dc-fra', datacenterSource: 'edge' });
  assert.deepEqual(datacenterOfBmServer({ agent: 'fra edge' }, { findCollector, datacenterOfVcenter: dcOf }), { datacenterId: 'dc-fra', datacenterSource: 'edge' }, '이름으로도 찾는다');
  assert.deepEqual(datacenterOfBmServer({ agent: 'noname' }, { findCollector, datacenterOfVcenter: dcOf }), { datacenterId: '', datacenterSource: '' }, 'vcenterId 없는 엣지 → 미지정(이름 대조 금지)');
  assert.deepEqual(datacenterOfBmServer({ agent: 'x' }, { findCollector: () => { throw new Error('boom'); }, datacenterOfVcenter: dcOf }), { datacenterId: '', datacenterSource: '' }, '조회가 던져도 미지정');
  assert.deepEqual(datacenterOfBmServer({}, { findCollector, datacenterOfVcenter: dcOf }), { datacenterId: '', datacenterSource: '' });
  assert.equal(parseDcQuery(''), null);
  assert.deepEqual([...parseDcQuery(`a, b,${NONE_DC}`)], ['a', 'b', '']);
  assert.equal(datacenterInputIssue(''), null); assert.equal(datacenterInputIssue(undefined), null);
  assert.ok(datacenterInputIssue('x'.repeat(65))); assert.ok(datacenterInputIssue('a\u0001b'));
});

test('ioSeries: 격자 · 표 선택 · 원시/집계 → 평균(표본 수 가중) · 피크(최댓값) · 합은 전부 있을 때만 · 요약 · ids 상한', () => {
  const buckets = bucketsOf(NOW - HOUR, NOW, 900_000);
  assert.equal(buckets.length, 4); assert.equal(buckets[0], NOW - HOUR);
  assert.equal(sourceFor(30_000), 'raw'); assert.equal(sourceFor(900_000), 'r15'); assert.equal(sourceFor(1_800_000), 'r15'); assert.equal(sourceFor(3_600_000), 'r1h'); assert.equal(sourceFor(6 * HOUR), 'r1h');
  const raw = seriesFromRaw([
    { ts: NOW - HOUR + 60_000, avgTotal: 100, instTotal: 500, busy: 10 },
    { ts: NOW - HOUR + 120_000, avgTotal: 300, instTotal: 200, busy: 40 },
    { ts: NOW - HOUR + 120_000 + 900_000, avgTotal: null, instTotal: 900, busy: null },   // 첫 행(차분 없음) — 평균 분모에 안 들어간다
    { ts: NOW + 5, avgTotal: 1, instTotal: 1, busy: 1 },                                    // 범위 밖
  ], buckets, 900_000);
  assert.deepEqual(raw.avg, [200, null, null, null]);
  assert.deepEqual(raw.peak, [500, 900, null, null]);
  assert.deepEqual(raw.busy, [40, null, null, null]);
  const roll = seriesFromRollup([
    { b: NOW - HOUR, nAvg: 2, sumAvg: 400, maxInst: 700, maxBusy: 20 },
    { b: NOW - HOUR + 900_000, nAvg: 1, sumAvg: 100, maxInst: 100, maxBusy: 5 },
  ], bucketsOf(NOW - HOUR, NOW, 1_800_000), 1_800_000);   // 30분 칸에 15분 행 둘
  assert.deepEqual(roll.avg, [Math.round(500 / 3), null]);
  assert.deepEqual(roll.peak, [700, null]);
  const sum = sumSeries([{ avg: [1, null, 3, 4], peak: [10, null, 30, 40] }, { avg: [5, 6, null, 8], peak: [50, 60, null, 80] }, { avg: [null, null, null, null], peak: [null, null, null, null] }], 4);
  assert.deepEqual(sum.avg, [6, null, null, 12]); assert.deepEqual(sum.peak, [60, null, null, 120]);
  assert.equal(sum.measured, 2); assert.equal(sum.total, 3); assert.deepEqual(sum.partial, [1, 2]);
  assert.deepEqual(summarize({ avg: [10, null, 30], peak: [1, 99, null] }), { avgTotal: 20, maxAvg: 30, peakTotal: 99, points: 2 });
  assert.deepEqual(summarize(null), { avgTotal: null, maxAvg: null, peakTotal: null, points: 0 });
  const ids = parseSeriesIds('bm:a, san:X1 ,bm:a,foo:1,bm:all,' + Array.from({ length: 20 }, (_, i) => `bm:s${i}`).join(','), { maxIds: 5 });
  assert.equal(ids.length, 5); assert.deepEqual(ids.slice(0, 3), [{ kind: 'bm', key: 'a' }, { kind: 'san', key: 'X1' }, { kind: 'bm', key: 'all' }]);
  assert.equal(rangeKeyOf('7d'), '7d'); assert.equal(rangeKeyOf('x'), '1h'); assert.equal(metricOf('read'), 'read'); assert.equal(metricOf('zzz'), 'total');
});

test('compare: 어레이 행(최신 스냅샷 · 시리얼 후보) · 전송 속도 대조(법인 분리 · 사유 코드) · 요약(차이 · 배율) · 법인 칩 · 주소 제거', () => {
  assert.deepEqual(parseTypes(''), ['vmax', 'powermax']); assert.deepEqual(parseTypes('unity480,zzz'), ['unity480']); assert.ok(parseTypes('all').includes('xtremio'));
  const devices = [
    { id: 'st1', name: 'PMAX-KR', type: 'powermax', datacenterId: 'kr', enabled: true },
    { id: 'st2', name: 'VMAX-PL', type: 'vmax', datacenterId: 'pl', enabled: true },
    { id: 'st3', name: 'PMAX-US', type: 'powermax', datacenterId: 'us', enabled: true },
  ];
  const snaps = latestSnapshotMap([
    [{ deviceId: 'st1', ok: true, collectedAt: NOW - 1000, serial: '000120001234', capacity: { totalBytes: 180e12, usedBytes: 124e12, pct: 68.9 }, extra: { capacityBasis: 'usable_used_tb' } }],
    [{ deviceId: 'st1', ok: true, collectedAt: NOW - 5000, serial: '000120001234', capacity: { totalBytes: 1, usedBytes: 1, pct: 100 } },   // 더 오래된 엣지 사본 — 무시
      { deviceId: 'st2', ok: true, collectedAt: NOW, serial: '000296800331', capacity: { totalBytes: 64e12, usedBytes: 52e12, pct: 81.3 } },
      { deviceId: 'st3', ok: false, collectedAt: NOW, error: 'x' }],
  ]);
  const rows = sanArrayRows(devices, snaps);
  assert.equal(rows[0].capacity.pct, 68.9); assert.deepEqual(rows[0].serialKeys, ['000120001234']);
  assert.equal(rows[2].capacity, null); assert.equal(rows[2].capacityReason, 'collect-failed');
  const agg = { series: [
    { key: 'SYMMETRIX::000120001234', group: 'kr', avgTotal: 1.03e9, maxTotal: 2e9, peakAvg: 1.5e9, peakTotal: 2.4e9, ports: [1, 2, 3, 4, 5, 6, 7, 8], deviceIds: ['sw1', 'sw2'], partial: [] },
    { key: 'SYMMETRIX::000296800331', group: 'other-dc', avgTotal: 5e8, maxTotal: 6e8, peakAvg: 5e8, peakTotal: 7e8, ports: [1], deviceIds: ['sw9'] },   // 다른 법인에서 잡힌 같은 시리얼 — 붙이지 않는다
    { key: 'Emulex PPN-10:00', group: 'kr', avgTotal: 9e9 },
  ] };
  const withT = attachThroughput(rows, agg, { perfEnabled: true, perfAvailable: true, switches: 3, split: true });
  assert.equal(withT[0].throughput.avgBps, 1_030_000_000); assert.equal(withT[0].throughput.ports, 8); assert.equal(withT[0].throughput.switches, 2);
  assert.equal(withT[1].throughput, null); assert.equal(withT[1].throughputReason, 'serial-unmatched');
  assert.equal(attachThroughput(rows, agg, { perfEnabled: false })[0].throughputReason, 'perf-disabled');
  assert.equal(attachThroughput(rows, agg, { perfEnabled: true, perfAvailable: false })[0].throughputReason, 'perf-unavailable');
  assert.equal(attachThroughput(rows, agg, { perfEnabled: true, perfAvailable: true, switches: 0 })[0].throughputReason, 'no-switches');
  const noSplit = attachThroughput(rows, agg, { perfEnabled: true, perfAvailable: true, switches: 3, split: false });
  assert.equal(noSplit[1].throughput.avgBps, 500_000_000, '법인 분리 없이 보면 붙는다');
  const bmTotal = { usedBytes: 463.3e12, totalBytes: 687.2e12, usedPct: 67.4, ok: 10, io: { readBps: 217e6, writeBps: 195e6, totalBps: 412e6, measured: 9, total: 10, partial: true } };
  const sum = compareSummary({ bmTotal, sanRows: withT });
  assert.equal(sum.capacity.sanMeasured, 2); assert.equal(sum.capacity.sanTotal, 3);
  assert.equal(sum.capacity.sanPct, Math.round(((124e12 + 52e12) / (180e12 + 64e12)) * 1000) / 10);
  assert.equal(sum.capacity.deltaPp, Math.round((67.4 - sum.capacity.sanPct) * 10) / 10);
  assert.equal(sum.throughput.sanBps, 1_030_000_000); assert.equal(sum.throughput.sanMeasured, 1); assert.equal(sum.throughput.ratio, 2.5);
  assert.equal(compareSummary({ bmTotal: { ...bmTotal, io: null }, sanRows: [] }).throughput.ratio, null);
  const chips = datacenterChips({
    servers: [{ datacenterId: 'kr', enabled: true, ok: true, usedPct: 60 }, { datacenterId: '', enabled: true, ok: true, usedPct: 91 }, { datacenterId: 'kr', enabled: false, ok: true, usedPct: 99 }],
    sanRows: rows, dcNameOf: (id) => ({ kr: '서울', pl: '폴란드', us: '미국 동부' })[id] || id,
  });
  assert.deepEqual(chips.map((c) => [c.id, c.name, c.servers, c.arrays, c.maxPct]), [['us', '미국 동부', 0, 1, null], ['kr', '서울', 1, 1, 68.9], ['pl', '폴란드', 0, 1, 81.3], ['', '(법인 미지정)', 1, 0, 91]]);
  assert.deepEqual(stripHost({ id: 'a', host: '10.0.0.1', name: 'n' }), { id: 'a', name: 'n' });
});

test('agg: 디스크 I/O 합은 측정된 서버만 · 개수 · 부분 합 · 구버전 엣지 회신은 ioError edge-legacy · 법인 필드 전달', () => {
  const servers = [
    { id: 'a', name: 'a', host: '1', groups: ['G'], mounts: ['/'], enabled: true, datacenterId: 'kr', datacenterSource: 'server' },
    { id: 'b', name: 'b', host: '2', groups: ['G'], mounts: ['/'], enabled: true },
    { id: 'c', name: 'c', host: '3', groups: ['H'], mounts: ['/'], enabled: true },
  ];
  const m = { mount: '/', totalBytes: 100, usedBytes: 50, availBytes: 50 };
  const latest = new Map([
    ['a', { ok: true, mounts: [m], io: { readBps: 10, writeBps: 5, totalBps: 15, busyPct: 30 } }],
    ['b', { ok: true, mounts: [m] }],                                   // io 없음(구버전 엣지)
    ['c', { ok: true, mounts: [m], io: null, ioError: '/proc/diskstats 없음' }],
  ]);
  const { total, groups, perServer } = aggregate(servers, latest);
  assert.deepEqual(total.io, { readBps: 10, writeBps: 5, totalBps: 15, busyMax: 30, measured: 1, total: 3, partial: true });
  const g = groups.find((x) => x.name === 'G'); const h = groups.find((x) => x.name === 'H');
  assert.deepEqual(g.io, { readBps: 10, writeBps: 5, totalBps: 15, busyMax: 30, measured: 1, total: 2, partial: true });
  assert.deepEqual(h.io, { readBps: null, writeBps: null, totalBps: null, busyMax: null, measured: 0, total: 1, partial: false });
  assert.deepEqual(g.members, ['a', 'b']);
  assert.equal(perServer.find((s) => s.id === 'b').ioError, 'edge-legacy');
  assert.equal(perServer.find((s) => s.id === 'c').ioError, '/proc/diskstats 없음');
  assert.equal(perServer.find((s) => s.id === 'a').datacenterId, 'kr'); assert.equal(perServer.find((s) => s.id === 'a').datacenterSource, 'server');
  assert.equal(perServer.find((s) => s.id === 'b').datacenterId, '');
});

test('csv: datacenter 열 왕복 · 가져오기는 등록된 법인 id/이름만(미등록은 오류 사유)', () => {
  assert.ok(CSV_COLUMNS.includes('datacenter'));
  const csv = bmServersToCsv([{ name: 's1', host: '10.0.0.1', port: 22, username: 'root', groups: ['G'], datacenterId: 'dc-kr', agent: '', mounts: ['/'], enabled: true }]);
  const { rows } = parseBmServersCsv(csv);
  assert.equal(rows[0].datacenter, 'dc-kr');
  const resolve = (t) => (['dc-kr', '서울'].includes(String(t).trim().toLowerCase() === '서울' ? '서울' : String(t)) ? 'dc-kr' : null);
  const { report } = analyzeBmServersImport([{ ...rows[0], datacenter: 'nowhere' }, { ...rows[0], host: '10.0.0.2', datacenter: '서울' }], { existingId: () => null, validate: () => null, validAgent: () => true, resolveDatacenter: resolve });
  assert.equal(report[0].action, 'error'); assert.match(report[0].reason, /미등록 법인/);
  assert.equal(report[1].action, 'add'); assert.equal(report[1].datacenter, '서울');
});

test('원천 스윕: 엣지 회신 두 경로(폴링 · PUSH)가 같은 정제(sanitizeBmResult)를 쓰고, 엣지 워커 회신에 io · ioError 가 있다', () => {
  const poller = read('bmstor/poller.js');
  assert.ok(poller.includes('sanitizeBmResult(byId.get(s.id)'), 'PUSH 회신 정제');
  assert.ok(poller.includes('const row = sanitizeBmResult(r, { at, agent })'), '폴링 회신 정제');
  assert.ok(poller.includes('recordIoFromResults(ioEntries, at)'), '적재 호출');
  const worker = read('agent/bmstorWorker.js');
  assert.ok(/io: x\.io \?\? null, ioError: x\.ioError \?\? null/.test(worker), '워커 회신 화이트리스트');
  assert.ok(read('insights/dbLocation.js').includes("'bmstor-io.db'"), 'DB 파일 등재');
});

/* ── 설정 · DB · 라우트(동적 import) ── */
let poller, registry, ioDb, srv, base;
const USERS = {
  full: { username: 'full', role: 'admin', scope: null },
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-us-east'] } },
};
before(async () => {
  ({ WHOLE_DISK_RE, IO_SEP, ioSampleSec, ioSampleCommand, parseDiskstats, parseIoSample, ioRate, ioResultFromExec, intervalAvg } = await import('../src/bmstor/diskstats.js'));
  ({ datacenterOfBmServer, parseDcQuery, datacenterInputIssue, NONE_DC } = await import('../src/bmstor/corp.js'));
  ({ bucketsOf, sourceFor, seriesFromRaw, seriesFromRollup, sumSeries, summarize, parseSeriesIds, rangeKeyOf, metricOf } = await import('../src/bmstor/ioSeries.js'));
  ({ parseTypes, latestSnapshotMap, sanArrayRows, attachThroughput, compareSummary, datacenterChips, stripHost } = await import('../src/bmstor/compare.js'));
  ({ aggregate } = await import('../src/bmstor/agg.js'));
  ({ bmServersToCsv, parseBmServersCsv, analyzeBmServersImport, CSV_COLUMNS } = await import('../src/bmstor/csv.js'));
  poller = await import('../src/bmstor/poller.js');
  registry = await import('../src/bmstor/registry.js');
  ioDb = await import('../src/bmstor/ioDb.js');
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
async function call(u, method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, t, j };
}

test('poller.sanitizeBmIo / sanitizeBmResult: 아는 필드만 · 수는 수로 · 문자열 상한 · 카운터 불완전은 null · io 없으면 edge-legacy', () => {
  const io = poller.sanitizeBmIo({ readBps: '12', writeBps: 3, busyPct: '55.5', busiestDev: 'x'.repeat(100), disks: '4', counters: { rdSectors: '5', wrSectors: 6, ioMs: 7, uptimeSec: 8 }, extra: { evil: 1 } });
  assert.equal(io.readBps, 12); assert.equal(io.totalBps, 15); assert.equal(io.busyPct, 55.5); assert.equal(io.busiestDev.length, 64); assert.equal(io.disks, 4);
  assert.deepEqual(io.counters, { rdSectors: 5, wrSectors: 6, ioMs: 7, uptimeSec: 8 });
  assert.ok(!('extra' in io));
  assert.equal(poller.sanitizeBmIo({ readBps: 'abc', writeBps: 1 }), null);
  assert.equal(poller.sanitizeBmIo({ readBps: 1, writeBps: 1, counters: { rdSectors: 1 } }).counters, null, '카운터가 불완전하면 적재하지 않는다');
  assert.equal(poller.sanitizeBmIo([1, 2]), null);
  const legacy = poller.sanitizeBmResult({ ok: true, mounts: [{ mount: '/', totalBytes: 1, usedBytes: 1, availBytes: 0, usedPct: 100 }] }, { at: NOW, agent: 'e' });
  assert.equal(legacy.io, null); assert.equal(legacy.ioError, 'edge-legacy'); assert.equal(legacy.agent, 'e'); assert.equal(legacy.at, NOW);
  const bad = poller.sanitizeBmResult({ ok: true, mounts: 'x', io: 'str', ioError: { a: 1 } }, {});
  assert.equal(bad.io, null); assert.equal(bad.ioError, '(형식 오류)'); assert.deepEqual(bad.mounts, []);
  const explicit = poller.sanitizeBmResult({ ok: true, mounts: [], io: null, ioError: 'y'.repeat(400) }, {});
  assert.equal(explicit.ioError.length, 300);
  assert.equal(poller.bmPollerStatus().ioSampleSec, 2);
});

test('registry: 법인(datacenterId) 저장 · 미전달 유지 · 빈 값 삭제 · 형식 검증', () => {
  const r = registry.saveBmServer({ name: 'srv', host: '10.9.9.9', mounts: '/', datacenterId: 'dc-kr', groups: 'G' });
  assert.ok(r.ok, r.reason);
  const id = r.server.id;
  assert.equal(registry.listBmServers().find((s) => s.id === id).datacenterId, 'dc-kr');
  registry.saveBmServer({ id, host: '10.9.9.9', mounts: '/', name: 'srv2' });
  assert.equal(registry.listBmServers().find((s) => s.id === id).datacenterId, 'dc-kr', '미전달이면 유지');
  registry.saveBmServer({ id, host: '10.9.9.9', mounts: '/', datacenterId: '' });
  assert.equal(registry.listBmServers().find((s) => s.id === id).datacenterId, '', '빈 값이면 지운다');
  assert.ok(!registry.saveBmServer({ host: '10.9.9.8', mounts: '/', datacenterId: 'z'.repeat(70) }).ok);
  registry.saveBmServer({ id, host: '10.9.9.9', mounts: '/', datacenterId: 'dc-kr' });
});

test('ioDb: 적재(트랜잭션) → 둘째 표본부터 카운터 차분 평균 · 집계 표 upsert · 순위 · 재부팅 null · 공백 null · prune 첫 호출 건너뜀', async () => {
  const id = registry.listBmServers()[0].id;
  const ioAt = (rd, wr, ioMs, up, inst) => ({ readBps: inst, writeBps: inst / 2, totalBps: inst * 1.5, busyPct: 20, busiestDev: 'sda', disks: 2, sampleMs: 2000, counters: { rdSectors: rd, wrSectors: wr, ioMs, uptimeSec: up } });
  const t0 = NOW - 3 * HOUR;
  const r1 = await ioDb.recordIoSamples([{ serverId: id, name: 'srv', ts: t0, io: ioAt(1000, 500, 10_000, 100_000, 1e6) }], { intervalMs: 600_000 });
  assert.ok(r1.ok, r1.reason); assert.equal(r1.written, 1);
  const r2 = await ioDb.recordIoSamples([{ serverId: id, name: 'srv', ts: t0 + 600_000, io: ioAt(1000 + 11_718_750, 500 + 2_343_750, 70_000, 100_600, 3e6) }], { intervalMs: 600_000 });
  assert.equal(r2.written, 1);
  // 재적재(같은 ts) 는 무시
  assert.equal((await ioDb.recordIoSamples([{ serverId: id, ts: t0 + 600_000, io: ioAt(1, 1, 1, 1, 1) }])).skipped, 1);
  const raw = await ioDb.ioRawRows(id, t0 - 1, t0 + 600_001);
  assert.equal(raw.length, 2);
  assert.equal(raw[0].avgTotal, null, '첫 행은 차분 없음');
  assert.equal(raw[1].avgRead, 10_000_000); assert.equal(raw[1].avgWrite, 2_000_000); assert.equal(raw[1].avgTotal, 12_000_000);
  assert.equal(raw[1].instTotal, 4_500_000); assert.equal(raw[1].avgBusy, 10);
  const roll = await ioDb.ioRollupRows('r1h', id, t0, t0 + HOUR);
  assert.equal(roll.length, 1);
  assert.equal(roll[0].n, 2); assert.equal(roll[0].nAvg, 1); assert.equal(roll[0].sumAvg, 12_000_000); assert.equal(roll[0].maxInst, 4_500_000); assert.equal(roll[0].sumRd, 10_000_000);
  const r15 = await ioDb.ioRollupRows('r15', id, t0, t0 + HOUR);
  assert.equal(r15.length, 1, '0분 · 10분 표본은 같은 15분 칸'); assert.equal(r15[0].n, 2); assert.equal(r15[0].nAvg, 1);
  const rank = await ioDb.ioRank('r1h', t0, t0 + HOUR, { metric: 'total' });
  assert.deepEqual(rank.get(id), { avgBps: 12_000_000, peakBps: 4_500_000, n: 1 });
  assert.equal((await ioDb.ioRank('r1h', t0, t0 + HOUR, { metric: 'read' })).get(id).avgBps, 10_000_000);
  assert.deepEqual(await ioDb.ioMeasuredServerIds('r1h', t0, t0 + HOUR), [id]);
  // 재부팅(uptime 역행) → 평균 null · 공백(> 주기×2) → null
  await ioDb.recordIoSamples([{ serverId: id, ts: t0 + 1_200_000, io: ioAt(5, 5, 5, 50, 1e6) }], { intervalMs: 600_000 });
  await ioDb.recordIoSamples([{ serverId: id, ts: t0 + 1_200_000 + 2 * HOUR, io: ioAt(5e9, 5e9, 5e6, 50 + 7200, 1e6) }], { intervalMs: 600_000 });
  const raw2 = await ioDb.ioRawRows(id, t0 + 1_199_999, t0 + 3 * HOUR);
  assert.equal(raw2[0].avgTotal, null, '재부팅'); assert.equal(raw2[1].avgTotal, null, '공백');
  const st = await ioDb.bmIoDbStatus();
  assert.equal(st.available, true); assert.equal(st.retention.rawDays, 3); assert.equal(st.span.first, t0);
  assert.deepEqual(await ioDb.pruneBmIo({ every: 20 }), { skipped: true }, '첫 호출은 건너뛴다(스로틀)');
});

test('poller.applyBmstorResults: 엣지 폴링 회신을 정제해 latest 에 넣고 I/O 표본을 적재한다(구버전 회신은 edge-legacy)', async () => {
  const id = registry.listBmServers()[0].id;
  const n = poller.applyBmstorResults('edge-1', [
    { id, ok: true, mounts: [{ mount: '/', totalBytes: 100, usedBytes: 50, availBytes: 50, usedPct: 50 }], io: { readBps: '7', writeBps: 1, totalBps: 8, counters: { rdSectors: 1e9, wrSectors: 1e9, ioMs: 1e6, uptimeSec: 999_999 } }, junk: 1 },
    { id: 'ghost', ok: true, mounts: [] },
  ]);
  assert.equal(n, 2);
  const row = poller.getBmLatest().get(id);
  assert.equal(row.io.readBps, 7); assert.equal(row.agent, 'edge-1'); assert.ok(!('junk' in row));
  assert.equal(poller.getBmLatest().get('ghost').ioError, 'edge-legacy');
  await new Promise((r) => setTimeout(r, 150));   // 적재는 비동기
  const rows = await ioDb.ioRawRows(id, NOW - 10 * 60_000, Date.now() + 60_000);
  assert.ok(rows.length >= 1, '회신의 표본이 DB 에 들어간다');
});

test('라우트: /tools/bm-storage/compare 는 전체 범위 admin 200 · 범위 admin 403 · 응답에 host 없음 · 법인 칩 · 요약', async () => {
  assert.equal((await call('sadm', 'GET', '/tools/bm-storage/compare')).s, 403);
  const r = await call('full', 'GET', '/tools/bm-storage/compare?hours=1');
  assert.equal(r.s, 200, r.t.slice(0, 200));
  assert.ok(!/"host"/.test(r.t), '관리 주소를 싣지 않는다');
  assert.ok(Array.isArray(r.j.bm.servers) && r.j.bm.servers.length >= 1);
  assert.equal(r.j.bm.servers[0].datacenterId, 'dc-kr');
  assert.ok(r.j.datacenters.some((c) => c.id === 'dc-kr' && c.servers === 1), JSON.stringify(r.j.datacenters) + ' / ' + JSON.stringify(registry.listBmServers().map((x) => [x.id, x.name, x.host, x.datacenterId])));
  assert.deepEqual(r.j.types, ['vmax', 'powermax']);
  assert.ok('capacity' in r.j.summary && 'throughput' in r.j.summary);
  assert.equal(r.j.io.available, true);
  const f = await call('full', 'GET', `/tools/bm-storage/compare?datacenterId=${NONE_DC}`);
  assert.equal(f.j.bm.servers.length, 0, '미지정 필터면 dc-kr 서버는 빠진다');
  assert.ok(f.j.datacenters.length >= 1, '칩은 필터 전 전체');
  const g = await call('full', 'GET', '/tools/bm-storage');
  assert.ok(Array.isArray(g.j.datacenters), '폼 법인 목록');
  assert.equal(g.j.servers[0].datacenterSource, 'server');
});

test('라우트: /tools/bm-storage/io/series — 격자 · 계열(bm:all · bm:<id> · san:all 사유) · rank · 상한', async () => {
  const id = registry.listBmServers()[0].id;
  assert.equal((await call('sadm', 'GET', '/tools/bm-storage/io/series')).s, 403);
  const r = await call('full', 'GET', `/tools/bm-storage/io/series?range=1h&ids=bm:all,bm:${id},san:all,san:nope&rank=1`);
  assert.equal(r.s, 200, r.t.slice(0, 300));
  // v2.962(결함 수정): 1시간 격자는 수집 주기(기본 10분) 이상 — 예전 1분 격자는 실데이터에서 선이 끊긴 점들만 남겼다(bmCompareSet2962 마지막 테스트).
  assert.equal(r.j.range, '1h'); assert.equal(r.j.gran, 'raw'); assert.ok(r.j.bucketMs >= 600_000 && r.j.buckets.length >= 6, `격자 ${r.j.bucketMs} · 칸 ${r.j.buckets.length}`);
  const byId = Object.fromEntries(r.j.series.map((s) => [s.id, s]));
  assert.equal(byId[`bm:${id}`].avg.length, r.j.buckets.length);
  assert.deepEqual(byId[`bm:${id}`].basis, { avg: 'counter', peak: 'sample2s' });
  assert.equal(byId['san:all'].reason, 'no-switches');
  assert.equal(byId['san:nope'].reason, 'no-switches');
  assert.ok(Array.isArray(r.j.rank) && r.j.rank.some((x) => x.id === `bm:${id}`), JSON.stringify(r.j.rank));
  assert.equal(r.j.retention.rawDays, 3);
  const many = await call('full', 'GET', `/tools/bm-storage/io/series?range=7d&ids=${Array.from({ length: 30 }, (_, i) => `bm:x${i}`).join(',')}`);
  assert.equal(many.j.series.length, 10, 'ids 상한 10'); assert.equal(many.j.gran, 'r1h');
  assert.equal(many.j.series[0].reason, 'unknown-server');
});
