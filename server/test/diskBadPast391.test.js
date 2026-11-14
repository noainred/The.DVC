/**
 * v3.9.1 디스크 배드 섹터 — 과거 기록 읽기 1단계(README §22): 디스크 값(텔레메트리 · DriveMetrics) · 시스템 이벤트 로그(SEL).
 * 고정하는 것: 정해 둔 이름만 읽음 · 못 읽은 값은 0 이 아님 · 장비가 알려 준 링크만 따라감 · 401 은 멈춤 · 엣지 정제 · 저장 병합 ·
 * 판정(흔적 있음 · 날짜 모름 / SEL 빠짐은 교체 판정의 근거로만) · 집계 · 데모 경로 끝까지.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'diskbadpast391-'));
process.env.CONFIG_DIR = TMP;
process.env.DISKBAD_DB_PATH = path.join(TMP, 'disk-bad.db');
process.env.AUTH_ENABLED = 'false';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const code = (p) => stripComments(fs.readFileSync(path.join(ROOT, 'src', p), 'utf8'));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

const V = await import('../src/diskbad/diskvals.js');
const SEL = await import('../src/diskbad/sel.js');
const I = await import('../src/diskbad/ingest.js');
const D = await import('../src/diskbad/db.js');
const S = await import('../src/diskbad/summary.js');
const VD = await import('../src/diskbad/verdict.js');
const SC = await import('../src/diskbad/scan.js');

after(() => { try { D._resetDiskBadDbForTest(); } catch { /* */ } fs.rmSync(TMP, { recursive: true, force: true }); });

const ID0 = 'Disk.Bay.0:Enclosure.Internal.0-1:RAID.Integrated.1-1';
const ID2 = 'Disk.Bay.2:Enclosure.Internal.0-1:RAID.Integrated.1-1';
const mv = (id, metric, value, ts = NOW) => ({ MetricId: metric, MetricValue: value, Timestamp: new Date(ts).toISOString(), Oem: { Dell: { FQDD: id } } });
const err = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

test('① 텔레메트리 보고서 — 정해 둔 이름만 · 장치는 FQDD · 같은 값은 큰 쪽 · 못 읽은 값은 0 이 아니다', () => {
  const p = V.parseSmartReport({ MetricValues: [
    mv(ID0, 'ReallocatedBlockCount', '12'), mv(ID0, 'ReallocatedBlockCount', 15, NOW + HOUR), mv(ID0, 'CurrentPendingSectorCount', ''),
    mv(ID0, 'UncorrectableLBACount', null), mv(ID0, 'PowerOnHours', '30123.5'),
    mv(ID2, 'UncorrectableLBACount', '-1'), mv(ID2, 'ReallocatedEventCount', 9), mv(ID2, 'constructor', 5), mv(ID2, 'CurrentPendingSectorCount', 0),
  ] });
  const d0 = p.drives.get(ID0);
  assert.equal(d0.realloc, 15);
  assert.equal(d0.pending, undefined, '빈 문자열은 0 이 아니다');
  assert.equal(d0.uncorrectable, undefined, 'null 은 0 이 아니다');
  assert.equal(d0.powerOnHours, 30123.5);
  const d2 = p.drives.get(ID2);
  assert.equal(d2.uncorrectable, undefined, '음수는 모르는 값');
  assert.equal(d2.realloc, undefined, '비슷한 이름(ReallocatedEventCount)은 읽지 않는다');
  assert.equal(d2.pending, 0, '읽은 0 은 0');
  assert.ok(p.seen.includes('ReallocatedEventCount'), '장비가 준 이름은 그대로 싣는다');
  assert.equal(p.at, NOW + HOUR);
  assert.equal(V.hasAnyVal({ realloc: null }), false);
});

test('② 디스크 값 읽기 — 404 는 장비에 없음 · 장비가 알려 준 링크만 · 꼴이 다른 링크는 묻지 않음 · 401 은 던진다', async () => {
  const asked = [];
  const metricsOk = `/redfish/v1/Systems/System.Embedded.1/Storage/RAID.Integrated.1-1/Drives/${ID2}/Metrics`;
  const get = async (_e, p) => {
    asked.push(p);
    if (p === V.REPORT_PATH) throw err(404);
    if (p === metricsOk) return { BadBlockCount: 7, UncorrectableIOReadErrorCount: 1, UncorrectableIOWriteErrorCount: '2', PowerOnHours: 100 };
    throw err(500);
  };
  const drives = [
    { id: ID0, metricsPath: '' },
    { id: ID2, metricsPath: metricsOk },
    { id: 'Disk.Bay.3:Enclosure.Internal.0-1:RAID.Integrated.1-1', metricsPath: `/redfish/v1/Systems/System.Embedded.1/Storage/x/Drives/${ID0}/Metrics` },   // 다른 디스크의 링크
    { id: 'Disk.Bay.4:x', metricsPath: '/redfish/v1/../../etc/Disk.Bay.4:x/Metrics' },
    { id: 'Disk.Bay.5:x', metricsPath: 'https://evil.example/Disk.Bay.5:x/Metrics' },
  ];
  const r = await V.readDiskVals({}, { getJson: get, drives, now: () => NOW });
  assert.equal(r.telemetry, 'absent');
  assert.equal(r.metrics, 'ok');
  assert.equal(r.status, 'ok');
  assert.deepEqual(asked, [V.REPORT_PATH, metricsOk], '꼴이 맞는 자기 링크만 물었다');
  const d = r.drives[0];
  assert.equal(d.src, 'metrics');
  assert.equal(d.realloc, 7);
  assert.equal(d.uncorrectable, 3, '읽기 + 쓰기');
  assert.equal(d.pending, null, 'DriveMetrics 에는 보류에 해당하는 이름이 없다 — 모름');

  const none = await V.readDiskVals({}, { getJson: async () => { throw err(404); }, drives: [{ id: ID0, metricsPath: '' }], now: () => NOW });
  assert.equal(none.status, 'absent');
  assert.equal(none.drives.length, 0);
  const forb = await V.readDiskVals({}, { getJson: async () => { throw err(403); }, now: () => NOW });
  assert.equal(forb.status, 'forbidden');
  await assert.rejects(V.readDiskVals({}, { getJson: async () => { throw err(401); }, now: () => NOW }), (e) => e.status === 401);
  const tele = await V.readDiskVals({}, { getJson: async () => ({ MetricValues: [mv(ID0, 'ReallocatedBlockCount', 3)] }), drives: [{ id: ID0, metricsPath: metricsOk.replace(ID2, ID0) }], now: () => NOW });
  assert.equal(tele.drives.length, 1);
  assert.equal(tele.drives[0].src, 'telemetry', '텔레메트리에서 읽은 디스크는 링크를 다시 묻지 않는다');
  assert.equal(tele.metrics, '');
});

test('③ SEL 항목 — 디스크 항목만 · 종류 · 위치 · 긴 문장도 선형', () => {
  const e = (Message, extra = {}) => ({ Id: '1', Created: new Date(NOW).toISOString(), Message, ...extra });
  const rm = SEL.selDriveEvent(e('Drive 2 is removed from disk drive bay 1.', { SensorType: 'Drive Slot / Bay', MessageId: 'PDR1016' }));
  assert.equal(rm.kind, 'removed');
  assert.equal(rm.slotKey, 'bp1:d2');
  assert.equal(SEL.selDriveEvent(e('Drive 2 is installed in disk drive bay 1.')).kind, 'installed');
  assert.equal(SEL.selDriveEvent(e('Fault detected on drive 5 in disk drive bay 1.')).slotKey, 'bp1:d5');
  assert.equal(SEL.selDriveEvent(e('Predictive failure reported for drive 1 in disk drive bay 1.')).kind, 'predictive');
  assert.equal(SEL.selDriveEvent(e('The system inlet temperature is greater than the upper warning threshold.')), null);
  assert.equal(SEL.selDriveEvent(e('Disk drive bay 1 cable error', { SensorType: 'Cable' })).slotKey, '', '위치를 못 읽으면 빈 키(추측하지 않는다)');
  // 선형 — 'drive 1 ' 을 많이 되풀이해도 문장 상한(300자) 안에서 끝난다.
  const long = 'drive 1 '.repeat(5_000);
  const t0 = performance.now(); for (let i = 0; i < 200; i += 1) SEL.selDriveEvent(e(long, { SensorType: 'Drive Slot / Bay' })); const dt = performance.now() - t0;
  const short = 'drive 1 '.repeat(5);
  const t1 = performance.now(); for (let i = 0; i < 200; i += 1) SEL.selDriveEvent(e(short, { SensorType: 'Drive Slot / Bay' })); const ds = performance.now() - t1;
  assert.ok(dt < Math.max(50, ds * 40), `긴 입력 ${dt.toFixed(1)}ms · 짧은 입력 ${ds.toFixed(1)}ms`);
});

test('④ SEL 읽기 — 쪽 넘김 · $skip 무시 · 404 · 가장 새 것부터', async () => {
  const MGR = '/redfish/v1/Managers/iDRAC.Embedded.1';
  const base = `${MGR}/LogServices/Sel/Entries`;
  const row = (i, msg) => ({ Id: String(i), Created: new Date(NOW - i * DAY).toISOString(), Message: msg });
  const p1 = [row(1, 'Drive 3 is removed from disk drive bay 1.'), row(2, 'Power supply redundancy is lost.')];
  const p2 = [row(3, 'Drive 3 is installed in disk drive bay 1.'), row(40, 'The chassis is closed.')];
  const get = async (_e, p) => (p === base ? { Members: p1, 'Members@odata.count': 4, 'Members@odata.nextLink': `${base}?$skip=2` } : { Members: p2, 'Members@odata.count': 4 });
  const r = await SEL.readSel({}, { mgr: MGR, getJson: get, now: () => NOW });
  assert.equal(r.status, 'ok');
  assert.equal(r.read, 4);
  assert.equal(r.pages, 2);
  assert.equal(r.events.length, 2);
  assert.equal(r.events[0].kind, 'removed', '가장 새 것부터');
  assert.deepEqual(r.kinds, { removed: 1, installed: 1 });
  assert.equal(r.oldest, NOW - 40 * DAY);
  const same = await SEL.readSel({}, { mgr: MGR, getJson: async () => ({ Members: p1, 'Members@odata.count': 40, 'Members@odata.nextLink': 'x' }), now: () => NOW });
  assert.equal(same.stopped, 'skip');
  assert.equal(same.read, 2, '같은 쪽을 두 번 세지 않는다');
  const abs = await SEL.readSel({}, { mgr: MGR, getJson: async () => { throw err(404); }, now: () => NOW });
  assert.equal(abs.status, 'absent');
  await assert.rejects(SEL.readSel({}, { mgr: MGR, getJson: async () => { throw err(401); }, now: () => NOW }), (e) => e.status === 401);
});

test('⑤ 엣지 정제 — 아는 필드만 · 글자 수치는 수로 · 빈 값은 null · 위치 키는 번호와 맞을 때만 · 상한', () => {
  const x = I.cleanServer({
    id: 's1', ok: true, log: { order: 'desc' }, records: [],
    vals: { at: NOW, status: 'ok', telemetry: 'ok', evil: 1, seen: ['ReallocatedBlockCount', { x: 1 }],
      drives: [{ id: ID0, realloc: '12', pending: '', uncorrectable: -3, powerOnHours: '10.5', src: 'telemetry', password: 'x' }, { id: '', realloc: 1 }, { id: ID2 }] },
    sel: { at: NOW, status: 'ok', read: '10', kinds: { removed: '2', __proto__: { polluted: 1 } },
      events: [{ created: NOW, kind: 'removed', disk: 2, bp: 1, slotKey: 'bp1:d2', message: 'm' }, { created: NOW, kind: 'zzz', disk: 2, bp: 1, slotKey: 'bp9:d9' }] },
  }, NOW);
  assert.deepEqual(Object.keys(x.vals).sort(), ['at', 'drives', 'metrics', 'reportAt', 'seen', 'status', 'telemetry']);
  assert.equal(x.vals.drives.length, 1, '값이 하나도 없는 디스크 · 이름 없는 디스크는 버린다');
  assert.deepEqual(x.vals.drives[0], { id: ID0, realloc: 12, pending: null, uncorrectable: null, powerOnHours: 10.5, src: 'telemetry' });
  assert.deepEqual(x.vals.seen, ['ReallocatedBlockCount']);
  assert.equal(x.sel.read, 10);
  assert.deepEqual(x.sel.kinds, { removed: 2 });
  assert.equal(({}).polluted, undefined);
  assert.equal(x.sel.events[0].slotKey, 'bp1:d2');
  assert.equal(x.sel.events[1].kind, 'other');
  assert.equal(x.sel.events[1].slotKey, '', '번호와 맞지 않는 위치 키는 버린다');
  const big = I.cleanServer({ id: 's2', ok: false, reason: 'error', vals: { status: 'weird', drives: Array.from({ length: 200 }, (_, i) => ({ id: `d${i}`, realloc: 1 })) },
    sel: { status: 'ok', events: Array.from({ length: 500 }, () => ({ created: NOW, kind: 'removed' })) } }, NOW);
  assert.equal(big.vals.status, 'error', '모르는 상태는 오류로');
  assert.equal(big.vals.drives.length, I.VALS_DRIVES_MAX);
  assert.equal(big.sel.events.length, I.SEL_EVENTS_MAX);
  assert.equal(I.cleanServer({ id: 's3', ok: true }, NOW).vals, null, '옛 판 엣지 — 보내지 않았으면 null(중앙은 지난 값을 둔다)');
  const ok0 = I.cleanVals({ status: 'ok', drives: [] }, NOW);
  assert.equal(ok0.status, 'empty', '디스크 없는 ok 는 항목 없음');
});

test('⑥ 저장 병합 — 처음 읽은 때 · 늘어난 때 · 못 읽으면 지난 값 · SEL 합집합', () => {
  const a = D.mergeVals(null, { status: 'ok', telemetry: 'ok', drives: [{ id: ID0, realloc: 3, pending: 0, uncorrectable: 0 }] }, NOW - DAY);
  assert.equal(a.drives[0].firstAt, NOW - DAY);
  assert.equal(a.drives[0].changedAt, null);
  const b = D.mergeVals(a, { status: 'ok', telemetry: 'ok', drives: [{ id: ID0, realloc: 5, pending: 0, uncorrectable: 0 }, { id: ID2, realloc: 0 }] }, NOW);
  assert.equal(b.drives[0].firstAt, NOW - DAY);
  assert.equal(b.drives[0].changedAt, NOW);
  assert.deepEqual(b.drives[0].before, { realloc: 3, pending: 0, uncorrectable: 0 });
  assert.equal(b.drives[1].firstAt, NOW, '새 Id 는 새로 시작');
  const c = D.mergeVals(b, { status: 'absent', telemetry: 'absent', drives: [] }, NOW + HOUR);
  assert.equal(c.status, 'absent');
  assert.equal(c.tryAt, NOW + HOUR);
  assert.equal(c.at, NOW, '마지막으로 읽은 때는 그대로');
  assert.equal(c.drives.length, 2, '못 읽었다고 지난 값을 지우지 않는다');
  const n = D.mergeVals(null, { status: 'error', drives: [] }, NOW);
  assert.equal(n.drives.length, 0);
  assert.equal(n.at, null);

  const ev = (created, kind, msg) => ({ created, kind, slotKey: 'bp1:d2', message: msg });
  const s1 = D.mergeSel(null, { status: 'ok', read: 10, oldest: NOW - 9 * DAY, newest: NOW, events: [ev(NOW - 5 * DAY, 'removed', 'a')] }, NOW);
  const s2 = D.mergeSel(s1, { status: 'ok', read: 3, oldest: NOW - DAY, newest: NOW, events: [ev(NOW - HOUR, 'installed', 'b'), ev(NOW - 5 * DAY, 'removed', 'a')] }, NOW + HOUR);
  assert.equal(s2.events.length, 2, 'SEL 이 지워져도 포탈이 본 항목은 남고 같은 항목은 한 번');
  assert.equal(s2.keptFrom, NOW - 5 * DAY);
  assert.deepEqual(s2.range, { oldest: NOW - DAY, newest: NOW });
  const s3 = D.mergeSel(s2, { status: 'error' }, NOW + 2 * HOUR);
  assert.equal(s3.events.length, 2);
  assert.equal(s3.status, 'error');
  const many = D.mergeSel(null, { status: 'ok', events: Array.from({ length: 400 }, (_, i) => ev(NOW - i * HOUR, 'removed', `m${i}`)) }, NOW);
  assert.equal(many.events.length, D.SEL_KEEP_MAX);
});

test('⑦ 판정 — 로그 기록이 없는 디스크의 흔적 · 기록 있는 자리에 값 근거 · SEL 빠짐은 교체 판정의 근거 · 장착은 넣지 않는다', () => {
  const drives = [
    { id: ID0, name: 'Physical Disk 0:1:0', model: 'M', serial: 'S0', inVolume: true },
    { id: ID2, name: 'Physical Disk 0:1:2', model: 'M', serial: 'S2', inVolume: true },
    { id: 'Disk.Bay.4:Enclosure.Internal.0-1:RAID.Integrated.1-1', name: 'Physical Disk 0:1:4', model: 'M', serial: 'S4', inVolume: true },
    { id: 'Disk.Bay.5:Enclosure.Internal.0-1:RAID.Integrated.1-1', name: 'Physical Disk 0:1:5', model: 'M', serial: 'S5', inVolume: true },
  ];
  const vals = { status: 'ok', drives: [
    { id: ID0, realloc: 96, pending: 8, uncorrectable: 3, src: 'telemetry' },
    { id: ID2, realloc: 12, pending: 0, uncorrectable: 0, src: 'telemetry' },
    { id: 'Disk.Bay.4:Enclosure.Internal.0-1:RAID.Integrated.1-1', realloc: 0, pending: 0, uncorrectable: 0, src: 'telemetry' },
  ] };
  const rec = (created, code, cls) => ({ created, code, cls, slotKey: 'bp1:d0' });
  const coverage = { continuousSince: NOW - 60 * DAY, lastOkAt: NOW, complete: true };
  const base = { records: [rec(NOW - 30 * DAY, 'PDR46', 'unrecoverable')], drives, serialRows: [], coverage, vals };
  const j = VD.judgeServer(base);
  const byId = Object.fromEntries(j.diskVals.map((d) => [d.id, d]));
  assert.equal(byId[ID0].trace, VD.TRACE.records, '기록이 있는 자리는 그 판정을 따른다');
  assert.equal(byId[ID2].trace, VD.TRACE.trace);
  assert.equal(byId[ID2].traceLabel, '흔적 있음 · 날짜 모름');
  assert.equal(byId['Disk.Bay.4:Enclosure.Internal.0-1:RAID.Integrated.1-1'].trace, VD.TRACE.none);
  assert.equal(byId['Disk.Bay.5:Enclosure.Internal.0-1:RAID.Integrated.1-1'].trace, VD.TRACE.unknown, '값이 없는 디스크는 모름 — 0 이 아니다');
  assert.equal(j.counts.traces, 1);
  assert.equal(j.counts.valsDisks, 3);
  assert.equal(j.counts.valsUnknown, 1);
  const slot = j.slots[0];
  assert.equal(slot.verdict, VD.VERDICT.inUse);
  assert.equal(slot.vals.uncorrectable, 3);
  assert.ok(slot.evidence.some((e) => /누적 값 — 재할당 96 · 보류 8 · 복구 불가 3/.test(e.text) && /텔레메트리/.test(e.src)));
  assert.equal(VD.traceOf({ uncorrectable: 1, realloc: 0 }), VD.TRACE.unrecoverable);
  assert.equal(VD.traceOf({ realloc: null, pending: null }), VD.TRACE.unknown);

  // SEL 빠짐(기록 뒤) — 다시 꽂았는지 바꿨는지 모른다: 판단 불가 · 근거에 SEL 과 '추정' 을 밝힌다.
  const sel = { events: [{ created: NOW - 10 * DAY, kind: 'removed', slotKey: 'bp1:d0', message: 'Drive 0 is removed from disk drive bay 1.' }] };
  const k = VD.judgeServer({ ...base, sel });
  assert.equal(k.slots[0].verdict, VD.VERDICT.unknown);
  assert.ok(k.slots[0].evidence.some((e) => /SEL/.test(e.src) && /추정/.test(e.text)));
  assert.equal(k.counts.records, 1, 'SEL 항목은 세지 않는다');
  // 장착만 있으면 판정을 흔들지 않는다.
  const m = VD.judgeServer({ ...base, sel: { events: [{ created: NOW - 10 * DAY, kind: 'installed', slotKey: 'bp1:d0' }] } });
  assert.equal(m.slots[0].verdict, VD.VERDICT.inUse);
  // 디스크 목록을 못 읽었으면 값이 온 디스크만, 둘 다 없으면 null(모름).
  assert.equal(VD.judgeServer({ ...base, drives: null, vals: null }).diskVals, null);
  assert.equal(VD.judgeServer({ ...base, drives: null }).diskVals.length, 3);
});

test('⑧ 데모 경로 끝까지 — 점검 → 정제 → 저장 → 서버 화면 · 전 법인 집계', async () => {
  const drives = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ id: `Disk.Bay.${i}:Enclosure.Internal.0-1:RAID.Integrated.1-1`, name: `Physical Disk 0:1:${i}`, model: 'MODEL-A', serial: `SN${i}`, health: 'OK', state: 'Enabled', inVolume: true }));
  const servers = Array.from({ length: 12 }, (_, i) => ({ id: `srv-${i}`, name: `srv-${i}`, host: `10.0.0.${i}` }));
  const chunks = [];
  await SC.scanServers(servers, { deps: { mock: true, invOf: () => ({ disks: drives, collections: { disks: 'ok' }, collectedAt: NOW }), authStoppedByPoller: () => false },
    onChunk: async (batch) => { chunks.push(...batch); return true; } });
  assert.equal(chunks.length, 12);
  assert.ok(chunks.every((c) => c.vals && c.sel), '데모 점검도 디스크 값 · SEL 을 싣는다');
  const clean = I.cleanPush({ v: I.PUSH_PROTOCOL, jobId: 'j', servers: chunks }, { now: NOW });
  const r = await D.ingestServers('', clean.servers, { now: NOW });
  assert.equal(r.ok, true);
  const all = await D.loadAll();
  assert.ok(all.servers.every((s) => s.vals && s.sel), 'DB 에서 다시 읽힌다');
  const one = await D.loadServer('', 'srv-1');
  const view = S.serverView(one.server, one.records, one.serials);
  assert.ok(['ok', 'absent'].includes(view.coverage.vals.status));
  assert.equal(view.coverage.sel.status, 'ok');
  assert.ok(Array.isArray(view.diskVals));
  const fleet = S.buildFleet({ servers: servers.map((s) => ({ agent: '', id: s.id, name: s.name, corp: { id: 'c1', name: '법인1' } })), db: all, now: NOW });
  const T = fleet.totals;
  assert.equal((T.valsBy.ok || 0) + (T.valsBy.absent || 0), 12);
  assert.equal(T.selBy.ok, 12);
  assert.ok(T.valsDisks > 0);
  assert.equal(fleet.traces.length, T.traceDisks);
  assert.ok(fleet.traces.every((d) => d.trace === 'trace' || d.trace === 'unrecoverable'));
  // 출처를 아직 읽지 않은 서버(옛 판 엣지)는 '아직 읽지 않음' 으로 따로 센다 — 0 이 아니다.
  const old = { ...all, servers: all.servers.map((s) => ({ ...s, vals: null, sel: null })) };
  const f2 = S.buildFleet({ servers: servers.map((s) => ({ agent: '', id: s.id, name: s.name, corp: null })), db: old, now: NOW });
  assert.equal(f2.totals.valsBy.never, 12);
  assert.equal(f2.totals.valsDisks, 0);
  assert.equal(f2.totals.valsUnknownDisks, 96);
});

test('⑨ 소스 계약 — 인벤토리가 같은 응답에서 링크를 받음 · 점검이 두 갈래 모두에서 읽음 · 401 은 멈춤 · 시한 산수', () => {
  const inv = code('idrac/redfish.js');
  assert.match(inv, /metricsPath: typeof drive\.Metrics\?\.\['@odata\.id'\] === 'string'/);
  const sc = code('diskbad/scan.js');
  assert.equal((sc.match(/await readPast\(s, \{/g) || []).length, 2, '로그를 읽은 점검 · 권한 없음/오류 점검 둘 다');
  assert.match(sc, /authGuard\.markAuthStopped\(s\.id, s/);
  assert.match(sc, /reason === REASON\.forbidden \|\| reason === REASON\.error/);
  assert.ok(SC.VALS_TIMEOUT_MS + SC.SEL_TIMEOUT_MS < SC.SERVER_TIMEOUT_MS(), '덧붙인 두 시한의 합은 로그 읽기 시한보다 짧다');
  // 장비 설정을 바꾸는 요청을 보내지 않는다(GET 만).
  for (const f of ['diskbad/diskvals.js', 'diskbad/sel.js']) assert.doesNotMatch(code(f), /method:\s*['"](POST|PATCH|PUT|DELETE)/i, f);
});
