// v2.719 감사 그룹 E — VM 가용성 정직성(B1-01·02·03·08) · 스냅샷 정책 알림 요약 상한(B1-05) · 경합 측정 시각(B1-06) ·
// 이전 준비도 Tools 판정(B1-07) · 운영 이벤트 조각 읽기(S1-04) · VM 변경 이력 entity 인덱스(S1-05) · VM DNS 메모리 기준 정리(S1-06).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2719e-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'live';   // VM DNS 데모 이력 채우기가 끼어들지 않게
delete process.env.VMDNS_HISTORY_RETENTION_DAYS;

const { analyzeAvailability } = await import('../src/availability/analyze.js');
const { analyzeVmHygiene, snapshotPolicySummary, ROWS_MAX } = await import('../src/vmhygiene/analyze.js');
const cp = await import('../src/contention/parse.js');
const { analyzeContention } = await import('../src/contention/analyze.js');
const mig = await import('../src/migration/analyze.js');
const { OPS_TYPES, TRACKED_SQL } = await import('../src/vmchanges/eventDetail.js');

const H = 3_600_000;
const DAY = 24 * H;
const NOW = Math.floor(1_800_000_000_000 / H) * H - 30 * 60_000;   // 정시 -30분(경계에서 떨어뜨린 고정 시각)
const ev = (vm, ts, type, user = '') => ({ vcenterId: 'vc1', entity: vm, ts, type, user });
const vm = (name, powerState = 'POWERED_ON', extra = {}) => ({ id: `vc1:${name}`, name, vcenterId: 'vc1', cluster: 'C1', powerState, ...extra });
const FULL = () => ({ firstTs: NOW - 400 * DAY, lastTs: NOW });

test('B1-01 읽기 상한으로 앞이 잘렸으면 그 경계부터만 잰다(잘린 끔 때문에 거짓 정지를 만들지 않는다)', () => {
  // 실제 이력: 끔(−20일) → 켬(−20일+2h). 상한으로 '끔' 이 잘리고 '켬' 이 남은 가장 오래된 행이다.
  const kept = [ev('a', NOW - 20 * DAY + 2 * H, 'VmPoweredOnEvent'), ev('b', NOW - 5 * DAY, 'VmPoweredOffEvent'), ev('b', NOW - 5 * DAY + H, 'VmPoweredOnEvent')];
  const readFrom = NOW - 20 * DAY + 2 * H;
  const r = analyzeAvailability(kept, [vm('a'), vm('b')], { days: 30, now: NOW, coverageOf: FULL, readFrom, onlyBelow: false });
  const all = analyzeAvailability(kept, [vm('a'), vm('b')], { days: 30, now: NOW, coverageOf: FULL, readFrom });
  assert.equal(all.coverage.readCut, 2, '잘린 경계부터 잰 VM 수를 밝힌다');
  assert.equal(all.readFrom, readFrom);
  const a = analyzeAvailability(kept, [vm('a')], { days: 30, now: NOW, coverageOf: FULL, readFrom, onlyBelow: true });
  assert.equal(a.vms.length, 0, 'a 는 경계 이후 정지가 없다 — 기간 시작부터 켬까지(약 10일)를 정지로 세지 않는다');
  const b = r.vms.find((x) => x.name === 'b');
  assert.equal(b.downMs, H, '경계 뒤의 정지는 그대로 센다');
  assert.equal(b.readCut, true); assert.equal(b.windowFrom, readFrom);
  // 상한이 없으면 예전과 같다
  const noCut = analyzeAvailability([ev('a', NOW - 20 * DAY, 'VmPoweredOffEvent'), ...kept], [vm('a')], { days: 30, now: NOW, coverageOf: FULL, onlyBelow: true });
  assert.equal(noCut.vms[0].downMs, 2 * H);
});

test('B1-02 마지막 이벤트가 켬인데 지금 꺼져 있으면 판정 보류(끔 이벤트 누락)', () => {
  const r = analyzeAvailability([ev('m', NOW - 20 * DAY, 'VmPoweredOnEvent')], [vm('m', 'POWERED_OFF')], { days: 30, now: NOW, coverageOf: FULL });
  assert.equal(r.coverage.missedOff, 1);
  assert.equal(r.coverage.measured, 0, '꺼진 시간을 0 으로 세어 가동률을 높이지 않는다');
  assert.equal(r.totals.availability, null);
});

test('B1-03 기간 중 생긴 VM 은 첫 켬부터 잰다(생성~첫 켬은 서비스 시작 전)', () => {
  const rows = [ev('n', NOW - 10 * DAY, 'VmClonedEvent'), ev('n', NOW - 7 * DAY, 'VmPoweredOnEvent')];
  const r = analyzeAvailability(rows, [vm('n')], { days: 30, now: NOW, coverageOf: FULL });
  assert.equal(r.coverage.belowTarget, 0, '새 VM 이 목표 미달로 올라오지 않는다');
  assert.equal(r.coverage.measured, 1);
  assert.equal(r.vcenters[0].windowFrom, NOW - 7 * DAY);
  assert.equal(r.vcenters[0].availability, 100);
  // 생성 뒤 켰다가 끈 정지는 그대로 센다
  const r2 = analyzeAvailability([...rows, ev('n', NOW - 2 * DAY, 'VmPoweredOffEvent'), ev('n', NOW - 2 * DAY + H, 'VmPoweredOnEvent')], [vm('n')], { days: 30, now: NOW, coverageOf: FULL, onlyBelow: true });
  assert.equal(r2.vms[0].downMs, H);
  assert.equal(r2.vms[0].windowFrom, NOW - 7 * DAY);
});

test('B1-08 측정 구간이 0 이하(수집 시작이 지금보다 뒤)면 측정·미달로 세지 않는다', () => {
  const r = analyzeAvailability([], [vm('c')], { days: 30, now: NOW, coverageOf: () => ({ firstTs: NOW + DAY, lastTs: NOW + DAY }) });
  assert.equal(r.coverage.clockSkew, 1);
  assert.equal(r.coverage.measured, 0);
  assert.equal(r.coverage.belowTarget, 0);
  assert.equal(r.vcenters[0].min, null);
});

test('B1-05 스냅샷 정책 알림 요약은 화면 상한 전 전체로 센다(응답에는 실리지 않는다)', () => {
  const s = { snapAgeDays: 7, snapCount: 3, snapSizeGB: 100, uptimeDays: 365, exceptions: [] };
  const vms = [];
  const n = ROWS_MAX + 500;
  for (let i = 0; i < n; i += 1) vms.push({ id: `v${i}`, name: `vm${i}`, vcenterId: 'vc1', powerState: 'POWERED_ON', snapshotCount: 5 });
  const r = analyzeVmHygiene(vms, s, { now: NOW });
  assert.equal(r.rows.length, ROWS_MAX);
  const first = snapshotPolicySummary(r).split('\n')[0];
  assert.match(first, new RegExp(`스냅샷 정책 위반 ${n}대`), first);
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(r)), 'allRows'), false, '응답 JSON 에 전체 행을 싣지 않는다');
});

test('B1-06 엣지 perfc.at 미래 시각은 수신 시각으로 자르고, 판정도 미래 at 을 신선하다고 보지 않는다', () => {
  const v = cp.sanitizeVmPerfc({ at: NOW + 30 * DAY, samples: 15, readyPct: { avg: 30, max: 40 } }, NOW);
  assert.equal(v.at, NOW); assert.equal(v.edgeAt, NOW + 30 * DAY);
  const h = cp.sanitizeHostPerfc({ at: NOW + DAY, diskMaxMs: { avg: 1, max: 2 }, ds: [] }, NOW);
  assert.equal(h.at, NOW); assert.equal(h.edgeAt, NOW + DAY);
  assert.equal(Object.hasOwn(cp.sanitizeVmPerfc({ at: NOW - 60_000 }, NOW), 'edgeAt'), false, '정상 시각은 그대로');
  const snap = { vms: [{ id: 'v1', name: 'x', vcenterId: 'vc1', host: 'esx', powerState: 'POWERED_ON', perfc: { at: NOW + 30 * DAY, readyPct: { avg: 30, max: 40 } } }], hosts: [] };
  const r = analyzeContention(snap, { now: NOW });
  assert.equal(r.coverage.measured, 0); assert.equal(r.coverage.stale, 1); assert.equal(r.kpi.readyCrit, 0);
});

test('B1-07 이전 준비도 tools-old 는 규정 준수 리포트와 같은 집합(TooOld·Blacklisted 포함)', () => {
  for (const st of ['guestToolsTooOld', 'guestToolsBlacklisted', 'guestToolsNeedUpgrade']) {
    const codes = mig.migrationOf({ name: 'x', powerState: 'POWERED_ON', toolsStatus: 'RUNNING', toolsVersionStatus: st }).findings.map((f) => f.code);
    assert.ok(codes.includes('tools-old'), `${st} → ${JSON.stringify(codes)}`);
  }
});

test('S1-04 opsEventsAsync 는 한 문장 opsEvents 와 같은 결과를 조각으로 읽는다 · S1-05 entity 조회는 전용 인덱스', async () => {
  const { getLogsDb, resetLogsDb } = await import('../src/logs/db.js');
  const db = await getLogsDb();
  assert.equal(typeof db.opsEventsAsync, 'function');
  const recs = [];
  const types = OPS_TYPES.filter((t) => /^Vm/.test(t));
  let k = 0;
  for (let d = 0; d < 12; d += 1) {
    for (const vc of ['vc1', 'vc2', 'vc3']) {
      for (let j = 0; j < 7; j += 1) {
        const ts = NOW - d * DAY - j * 3 * H;
        recs.push({ vcenterId: vc, key: `k${k++}`, ts, severity: 'info', type: types[(d + j) % types.length], user: 'u', entity: `vm${j}`, message: 'm' });
        if (j === 0) recs.push({ vcenterId: vc, key: `t${k++}`, ts, severity: 'info', type: types[0], user: 'u', entity: `vm${j}`, message: 'tie' });   // ts 동률
      }
    }
  }
  recs.push({ vcenterId: 'vc1', key: 'future', ts: NOW + 2 * DAY, severity: 'info', type: types[0], user: 'u', entity: 'f', message: 'clock ahead' });
  db.insertMany(recs);
  const f = { vcenterIds: ['vc1', 'vc2', 'vc3'], since: NOW - 10 * DAY, types };
  for (const lim of [1, 7, 50, 200, 5000]) {
    const sync = db.opsEvents(f, lim);
    const async = await db.opsEventsAsync(f, lim, { now: NOW, sliceMs: 6 * H });
    assert.deepEqual(async, sync, `limit ${lim}`);
  }
  assert.equal((await db.opsEventsAsync(f, 5000, { now: NOW, sliceMs: 6 * H }))[0].message, 'clock ahead', '맨 위 조각은 위가 열려 있다');
  const fu = { ...f, until: NOW - 2 * DAY };
  assert.deepEqual(await db.opsEventsAsync(fu, 300, { now: NOW, sliceMs: DAY }), db.opsEvents(fu, 300));
  assert.deepEqual(await db.opsEventsAsync({ vcenterIds: [] , since: 0 }, 10), []);
  resetLogsDb();
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path.join(TMP, 'vcenter-logs.db'));
  const idx = raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_tracked_entity'").get();
  assert.ok(idx, 'entity 부분 인덱스가 있다');
  const plan = raw.prepare(`EXPLAIN QUERY PLAN SELECT * FROM events INDEXED BY idx_events_tracked_entity WHERE type IN ${TRACKED_SQL} AND vcenterId IN (?) AND ts>=? AND entity=? ORDER BY ts DESC, rowid DESC LIMIT 10`).all('vc1', 0, 'x').map((r) => r.detail).join(' | ');
  assert.match(plan, /idx_events_tracked_entity/, plan);
  raw.close();
  const db2 = await getLogsDb();
  db2.insertMany([
    { vcenterId: 'vc1', key: 'mv1', ts: NOW - H, severity: 'info', type: 'VmMigratedEvent', user: 'u', entity: 'web', message: 'mv' },
    { vcenterId: 'vc1', key: 'mv2', ts: NOW - 2 * H, severity: 'info', type: 'VmMigratedEvent', user: 'u', entity: 'db', message: 'mv' },
  ]);
  const got = db2.trackedEvents({ vcenterIds: ['vc1'], since: 0, entity: 'web' }, 10);
  assert.deepEqual(got.map((r) => r.entity), ['web']);
  resetLogsDb();
});

test('S1-06 VM DNS 이력 — prune 이 최신 행을 지우면 메모리 기준도 다시 읽는다', async () => {
  const DB = await import('../src/vmdns/db.js');
  const PO = await import('../src/vmdns/poller.js');
  DB._resetVmDnsDbForTest(); PO._resetVmDnsHistoryForTest();
  const T0 = Math.floor(1_700_000_000_000 / H) * H - 30 * 60_000;   // 보존 기본 365일보다 훨씬 이전(고정)
  const dns = (servers) => ({ servers, stack: { servers, domain: 'a.corp', search: ['a.corp'], dhcp: false, hostName: 'h' },
    nics: [{ network: 'VM Network', mac: '00:50:56:00:00:01', servers, domain: 'a.corp', search: [], dhcp: false }] });
  const one = { initial: false, vcenters: [{ id: 'vc1', name: 'VC' }], vms: [{ id: 'vc1:a', name: 'a', vcenterId: 'vc1', powerState: 'POWERED_ON', dns: dns(['10.0.0.53']) }] };
  const none = { initial: false, vcenters: one.vcenters, vms: [] };
  const r1 = await PO.runVmDnsHistoryOnce({ snap: one, now: T0 });
  assert.equal(r1.first, 1);
  for (let i = 1; i < 36; i += 1) { const r = await PO.runVmDnsHistoryOnce({ snap: none, now: T0 + i * 60_000 }); assert.equal(r.ok, true); }
  const st = PO.vmDnsHistoryStatus();
  assert.ok(st.lastPrune && st.lastPrune.latest >= 1, JSON.stringify(st.lastPrune));
  const back = await PO.runVmDnsHistoryOnce({ snap: one, now: T0 + 40 * 60_000 });
  assert.equal(back.first, 1, '지워진 VM 이 돌아오면 첫 관측으로 다시 기록한다(메모리에 남은 기준을 쓰지 않는다)');
});

test('라우트 — 가용성·생명주기·재부팅은 조각 읽기를 쓰고 가용성은 잘림 경계를 넘긴다 · CSV 는 계산을 공유한다', () => {
  const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  const av = src('../src/routes/api/vmAvailability.js');
  assert.match(av, /opsEventsAsync\(/); assert.match(av, /readFrom/);
  assert.match(av, /const r = await runShared\(req, store\.get\(\)\)/);
  assert.match(src('../src/routes/api/vmLifecycle.js'), /await db\.opsEventsAsync\(/);
  assert.match(src('../src/routes/api/hostHygiene.js'), /await db\.opsEventsAsync\(/);
});
