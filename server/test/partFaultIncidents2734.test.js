/**
 * partFaultIncidents2734.test.js — 파트 장애 '장애별'(장애 1건 = 1행)·'종류별' 보기(v2.734).
 *
 * 사용자 요청: "장애별로 볼 수 있는 기능 추가, 지금까지 발생한 장애 종류(디스크, CPU, memory, NIC, GPU 등)를 종류별로" +
 * 선택 "발생 1건 = 1행". 이 파일이 고정하는 것:
 *  ① 묶기(순수): 열림→변화→해소가 한 건 · 기간 이전 시작은 인덱스 조회로 시작을 붙이고 못 찾으면 '시작 모름' ·
 *     해소 없이 다시 열림은 앞 건 '종료 기록 없음' · 지금 열린 장애는 part_state 가 진실(이벤트가 없어도 진행 중) ·
 *     식별 키 변경은 한 건으로 합친다 · 수동 닫음·부품 제거는 정상 복귀와 다른 종료 · 같은 부품 반복 횟수.
 *  ② 종류별 집계: 기록 있는 종류만 · 기간 중 새로 발생 / 기간 이전부터 이어짐 · 평균 지속은 정상 복귀·제거만.
 *  ③ DB 조각 읽기: 최신부터 조각 + 상한(오래된 쪽이 빠지고 coveredSince 로 밝힌다) · 정렬 단계 없는 인덱스 탐색.
 *  ④ 실제 api 라우터: 200 · 종류 필터는 목록만 · 비-admin 은 IP 가림 · 범위 계정 403 · days=0 = 전체.
 *
 * 기준 시각은 **정시 -30분**(CLAUDE.md v2.517 규약).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pfinc2734-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
process.env.PARTFAULT_DB_PATH = path.join(tmp, 'part-faults.db');
delete process.env.CENTRAL_URL;

const { buildIncidents, summarizeKinds, INCIDENT_END, INCIDENT_EVENT_MAX } = await import('../src/partfault/incidents.js');
const db = await import('../src/partfault/db.js');
const { makePart } = await import('../src/partfault/types.js');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;

let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch { /* 없으면 DB 테스트 skip */ }

const ev = (at, event, o = {}) => ({
  at, event, agent: '', partKey: 'idrac:SVC1:disk:Disk.1', scope: 'idrac', deviceId: '10.0.0.5', deviceKey: 'SVC1',
  deviceName: 'srv-a', kind: 'disk', label: 'Physical Disk 0:1', keyKind: 'slot', state: null, prevState: null,
  rawState: '', closeReason: null, ...o,
});

/* ─────────────────────────── ① 묶기 ─────────────────────────── */

test('① 열림→변화→해소는 한 건 — 시작·종료·지속·최악 상태·타임라인', () => {
  const since = NOW - 7 * DAY;
  const { incidents } = buildIncidents({
    since, now: NOW,
    events: [
      ev(NOW - 5 * HOUR, 'open', { state: 'warn', rawState: 'Warning' }),
      ev(NOW - 4 * HOUR, 'change', { state: 'fault', prevState: 'warn', rawState: 'Critical' }),
      ev(NOW - 2 * HOUR, 'close', { prevState: 'fault', closeReason: 'ok', rawState: 'OK' }),
    ],
  });
  assert.equal(incidents.length, 1);
  const i = incidents[0];
  assert.equal(i.openedAt, NOW - 5 * HOUR);
  assert.equal(i.closedAt, NOW - 2 * HOUR);
  assert.equal(i.durationMs, 3 * HOUR);
  assert.equal(i.peak, 'fault', '최악 상태는 변화 중 가장 나빴던 것');
  assert.equal(i.endReason, INCIDENT_END.ok);
  assert.equal(i.ongoing, false);
  assert.equal(i.events.length, 3);
  assert.equal(i.occurrences, 1);
  assert.equal(i.startedBefore, false);
});

test('① 같은 부품이 두 번 나면 두 건 — 반복 횟수 2', () => {
  const { incidents } = buildIncidents({
    since: NOW - DAY, now: NOW,
    events: [
      ev(NOW - 10 * HOUR, 'open', { state: 'fault' }), ev(NOW - 9 * HOUR, 'close', { prevState: 'fault', closeReason: 'ok' }),
      ev(NOW - 3 * HOUR, 'open', { state: 'fault' }), ev(NOW - 2 * HOUR, 'close', { prevState: 'fault', closeReason: 'ok' }),
    ],
  });
  assert.equal(incidents.length, 2);
  assert.ok(incidents.every((i) => i.occurrences === 2));
  assert.equal(incidents[0].openedAt, NOW - 3 * HOUR, '최근 것이 먼저');
});

test('① 기간 이전에 열린 장애 — 인덱스 조회로 시작을 붙이고, 못 찾으면 시작 모름', () => {
  const since = NOW - DAY;
  const calls = [];
  const lookup = (agent, partKey, before) => { calls.push([agent, partKey, before]); return partKey.endsWith('Disk.1') ? { at: NOW - 3 * DAY, state: 'warn' } : null; };
  const { incidents, stats } = buildIncidents({
    since, now: NOW, startLookup: lookup,
    events: [
      ev(NOW - 5 * HOUR, 'close', { prevState: 'fault', closeReason: 'ok' }),
      ev(NOW - 4 * HOUR, 'close', { partKey: 'idrac:SVC1:disk:Disk.2', label: 'Disk 2', prevState: 'warn', closeReason: 'ok' }),
    ],
  });
  const d1 = incidents.find((i) => i.partKey.endsWith('Disk.1'));
  const d2 = incidents.find((i) => i.partKey.endsWith('Disk.2'));
  assert.equal(d1.openedAt, NOW - 3 * DAY);
  assert.equal(d1.startedBefore, true);
  assert.equal(d1.durationMs, 3 * DAY - 5 * HOUR);
  assert.equal(d1.peak, 'fault', '조회한 열림 상태(warn)보다 나쁜 직전 상태(fault)');
  assert.equal(d2.openedAt, null);
  assert.equal(d2.startUnknown, true, '보존 기간 밖 — 지어내지 않는다');
  assert.equal(d2.durationMs, null, '시작을 모르면 길이도 모른다');
  assert.equal(stats.lookups, 2);
  assert.ok(calls.every((c) => c[2] < NOW), '조회 기준은 그 키의 첫 이벤트 시각');
});

test('① 조회 상한을 넘으면 시작 모름으로 두고 개수를 센다', () => {
  const events = [];
  for (let n = 0; n < 5; n++) events.push(ev(NOW - HOUR + n, 'close', { partKey: `idrac:S:disk:${n}`, prevState: 'fault', closeReason: 'ok' }));
  const { incidents, stats } = buildIncidents({ since: NOW - DAY, now: NOW, events, startLookup: () => ({ at: NOW - 2 * DAY }), lookupMax: 2 });
  assert.equal(stats.lookups, 2);
  assert.equal(stats.lookupCapped, 3);
  assert.equal(incidents.filter((i) => i.startUnknown).length, 3);
});

test('① 지금 열린 장애 — part_state 가 진실, 이벤트가 없어도 진행 중으로 넣는다', () => {
  const since = NOW - DAY;
  const openRows = [
    { agent: '', partKey: 'idrac:SVC1:disk:Disk.1', scope: 'idrac', deviceId: '10.0.0.5', deviceName: 'srv-a', kind: 'disk', label: 'Physical Disk 0:1',
      state: 'fault', rawState: 'Critical', firstSeenAt: NOW - 3 * HOUR, lastSeenAt: NOW - 60_000, holdReason: null },
    { agent: 'edge-a', partKey: 'storage:st-1:psu:PSU1', scope: 'storage', deviceId: 'st-1', deviceName: 'unity-01', kind: 'psu', label: 'PSU 1',
      state: 'warn', rawState: 'Degraded', firstSeenAt: NOW - 9 * DAY, lastSeenAt: NOW - 120_000, holdReason: 'unknown' },
  ];
  const { incidents } = buildIncidents({ since, now: NOW, openRows, events: [ev(NOW - 3 * HOUR, 'open', { state: 'warn' }), ev(NOW - 2 * HOUR, 'change', { state: 'fault', prevState: 'warn' })] });
  assert.equal(incidents.length, 2);
  assert.ok(incidents.every((i) => i.ongoing && i.endReason === null));
  const psu = incidents.find((i) => i.kind === 'psu');
  assert.equal(psu.openedAt, NOW - 9 * DAY);
  assert.equal(psu.startedBefore, true, '기간 이전부터 이어진 진행 중 장애');
  assert.equal(psu.holdReason, 'unknown');
  assert.equal(psu.durationMs, 9 * DAY);
  const disk = incidents.find((i) => i.kind === 'disk');
  assert.equal(disk.state, 'fault');
  assert.equal(incidents[0].state, 'fault', '진행 중 이상이 진행 중 주의보다 먼저');
});

test('① 해소 없이 다시 열림 → 앞 건은 종료 기록 없음 · 열려 있지 않은데 해소가 없는 건도 종료 기록 없음', () => {
  const { incidents, stats } = buildIncidents({
    since: NOW - DAY, now: NOW, openRows: [],
    events: [ev(NOW - 6 * HOUR, 'open', { state: 'fault' }), ev(NOW - 3 * HOUR, 'open', { state: 'warn' })],
  });
  assert.equal(incidents.length, 2);
  assert.ok(incidents.every((i) => i.endReason === INCIDENT_END.unknown && !i.ongoing));
  assert.equal(stats.endUnknown, 2);
  assert.ok(incidents.every((i) => i.closedAt === null), '끝난 시각을 지어내지 않는다');
});

test('① 식별 키 변경은 한 건으로 합친다 — 시작·타임라인을 이어받고 옛 키 건은 목록에서 빠진다', () => {
  const T = NOW - 2 * HOUR;
  const oldKey = 'idrac:SKU123:psu:PSU.Slot.1';
  const newKey = 'idrac:SERIAL9:psu:PSU.Slot.1';
  const base = { scope: 'idrac', deviceId: '10.9.9.9', kind: 'psu', label: 'PSU 1' };
  const { incidents, stats } = buildIncidents({
    since: NOW - DAY, now: NOW,
    openRows: [{ agent: '', partKey: newKey, ...base, deviceName: 'hpe-1', state: 'fault', firstSeenAt: NOW - 6 * HOUR, lastSeenAt: NOW }],
    events: [
      ev(NOW - 6 * HOUR, 'open', { partKey: oldKey, ...base, state: 'fault' }),
      ev(T, 'close', { partKey: oldKey, ...base, prevState: 'fault', closeReason: 'key-migrated' }),
      ev(T, 'open', { partKey: newKey, ...base, state: 'fault' }),
    ],
  });
  assert.equal(incidents.length, 1, '두 번 세지 않는다');
  assert.equal(stats.merged, 1);
  const i = incidents[0];
  assert.equal(i.partKey, newKey);
  assert.equal(i.migratedFrom, oldKey);
  assert.equal(i.openedAt, NOW - 6 * HOUR);
  assert.equal(i.events.length, 3);
  assert.equal(i.ongoing, true);
});

test('① 수동 닫음·부품 제거는 정상 복귀와 다른 종료', () => {
  const { incidents } = buildIncidents({
    since: NOW - DAY, now: NOW,
    events: [
      ev(NOW - 5 * HOUR, 'open', { state: 'fault' }), ev(NOW - 4 * HOUR, 'close', { prevState: 'fault', closeReason: 'manual' }),
      ev(NOW - 3 * HOUR, 'open', { partKey: 'k2', state: 'fault' }), ev(NOW - 2 * HOUR, 'close', { partKey: 'k2', prevState: 'fault', closeReason: 'removed' }),
    ],
  });
  const ends = incidents.map((i) => i.endReason).sort();
  assert.deepEqual(ends, [INCIDENT_END.manual, INCIDENT_END.removed]);
});

test('① 타임라인은 상한까지만 싣고 뺀 개수를 밝힌다', () => {
  const events = [ev(NOW - 10 * DAY, 'open', { state: 'warn' })];
  for (let n = 0; n < INCIDENT_EVENT_MAX + 5; n++) events.push(ev(NOW - 9 * DAY + n * 60_000, 'change', { state: n % 2 ? 'warn' : 'fault', prevState: n % 2 ? 'fault' : 'warn' }));
  const { incidents } = buildIncidents({ since: 0, now: NOW, events });
  assert.equal(incidents[0].events.length, INCIDENT_EVENT_MAX);
  assert.equal(incidents[0].eventsOmitted, 6);
});

test('① 오염된 입력은 건너뛴다(던지지 않는다)', () => {
  const { incidents } = buildIncidents({ since: 0, now: NOW, events: [null, 'x', { event: 'open' }, ev(NaN, 'open'), ev(NOW - HOUR, 'open', { state: 'fault' })], openRows: [null, {}] });
  assert.equal(incidents.length, 1);
});

/* ─────────────────────────── ② 종류별 ─────────────────────────── */

test('② 종류별 집계 — 기록 있는 종류만 · 새로 발생/이어짐 · 평균 지속은 정상 복귀·제거만', () => {
  const since = NOW - 7 * DAY;
  const { incidents } = buildIncidents({
    since, now: NOW,
    openRows: [{ agent: '', partKey: 'idrac:S2:dimm:A1', scope: 'idrac', deviceId: 'srv-b', kind: 'dimm', label: 'DIMM A1', state: 'fault', firstSeenAt: NOW - 20 * DAY, lastSeenAt: NOW }],
    events: [
      ev(NOW - 10 * HOUR, 'open', { state: 'fault' }), ev(NOW - 8 * HOUR, 'close', { prevState: 'fault', closeReason: 'ok' }),          // 2h
      ev(NOW - 6 * HOUR, 'open', { state: 'warn' }), ev(NOW - 2 * HOUR, 'close', { prevState: 'warn', closeReason: 'removed' }),        // 4h
      ev(NOW - 5 * HOUR, 'open', { partKey: 'idrac:S1:disk:D3', deviceId: '10.0.0.6', state: 'fault' }),
      ev(NOW - 1 * HOUR, 'close', { partKey: 'idrac:S1:disk:D3', deviceId: '10.0.0.6', prevState: 'fault', closeReason: 'manual' }),  // 수동 — 평균 제외
      ev(NOW - 3 * HOUR, 'open', { partKey: 'idrac:S1:nic:NIC.1', kind: 'nic', label: 'NIC 1', state: 'warn' }),
      ev(NOW - 1 * HOUR, 'close', { partKey: 'idrac:S1:nic:NIC.1', kind: 'nic', label: 'NIC 1', prevState: 'warn', closeReason: 'ok' }),
    ],
  });
  const { kinds, totals } = summarizeKinds(incidents, { since });
  assert.deepEqual(kinds.map((k) => k.kind), ['disk', 'dimm', 'nic']);
  const disk = kinds[0];
  assert.equal(disk.incidents, 3);
  assert.equal(disk.started, 3);
  assert.equal(disk.devices, 2);
  assert.equal(disk.repeatParts, 1, 'Disk.1 이 두 번');
  assert.equal(disk.avgDurationMs, 3 * HOUR, '(2h + 4h) / 2 — 수동 닫음은 평균에서 뺀다');
  assert.equal(disk.durationSamples, 2);
  assert.equal(disk.peakFault, 2);
  assert.equal(disk.lastStartedAt, NOW - 5 * HOUR);
  const dimm = kinds.find((k) => k.kind === 'dimm');
  assert.equal(dimm.carried, 1, '기간 이전부터 이어진 진행 중');
  assert.equal(dimm.started, 0);
  assert.equal(dimm.ongoingFault, 1);
  assert.equal(dimm.avgDurationMs, null, '해소된 장애가 없으면 평균은 null(0 아님)');
  assert.equal(totals.incidents, 5);
  assert.equal(totals.kinds, 3);
  assert.equal(totals.ongoing, 1);
  assert.ok(!kinds.some((k) => k.incidents === 0), '기록 없는 종류를 0건으로 싣지 않는다');
});

/* ─────────────────────────── ③ DB 조각 읽기 ─────────────────────────── */

async function seed(sequences) {
  // sequences: [{agent, part, steps:[[at, state|'close', reason]]}] — applyTransition 으로 실제 이벤트를 쌓는다.
  for (const s of sequences) {
    let prev = null;
    for (const [at, st, reason] of s.steps) {
      if (st === 'close') {
        await db.applyTransition({ closed: [{ ...prev, closeReason: reason || 'ok' }] }, { now: at });
        prev = null;
      } else if (!prev) {
        prev = { ...s.part, state: st, firstSeenAt: at, lastSeenAt: at };
        await db.applyTransition({ opened: [prev] }, { now: at });
      } else {
        const p = { ...prev, state: st, prevState: prev.state, lastSeenAt: at };
        await db.applyTransition({ updated: [p] }, { now: at });
        prev = { ...p };
      }
    }
  }
}

const part = (o = {}) => makePart({ scope: 'idrac', deviceId: '10.0.0.5', deviceName: 'srv', kind: 'disk', partId: 'Disk.1', keyKind: 'slot', state: 'fault', ...o });

test('③ 최신부터 조각으로 읽고 상한을 넘으면 오래된 쪽이 빠진다(coveredSince 로 밝힌다)', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  db._resetForTest();
  process.env.PARTFAULT_DB_PATH = path.join(tmp, 'chunk', 'part-faults.db');
  const seqs = [];
  for (let n = 0; n < 130; n++) {
    seqs.push({ part: part({ partId: `Disk.${n}` }), steps: [[NOW - 200 * 60_000 + n * 60_000, 'fault'], [NOW - 200 * 60_000 + n * 60_000 + 30_000, 'close']] });
  }
  await seed(seqs);
  let yields = 0;
  const full = await db.incidentInputs({ sinceAbs: 0, maxEvents: 100_000, chunk: 100, yielder: async () => { yields++; } });
  assert.equal(full.available, true);
  assert.equal(full.read, 260);
  assert.equal(full.truncated, false);
  assert.ok(yields >= 2, `조각 사이 양보 — ${yields}`);
  for (let i = 1; i < full.events.length; i++) assert.ok(full.events[i - 1].at <= full.events[i].at, '오름차순');
  const cut = await db.incidentInputs({ sinceAbs: 0, maxEvents: 150, chunk: 100 });
  assert.equal(cut.read, 150);
  assert.equal(cut.truncated, true);
  assert.equal(cut.coveredSince, cut.events[0].at);
  assert.equal(cut.events[cut.events.length - 1].at, full.events[full.events.length - 1].at, '최신은 남는다');
  const since = await db.incidentInputs({ sinceAbs: NOW - 100 * 60_000, chunk: 100 });
  assert.ok(since.events.every((e) => e.at >= NOW - 100 * 60_000));
  const sl = full.startLookup('', full.events[1].partKey, NOW);
  assert.equal(sl.state, 'fault');
  const marks = await db.incidentMarks();
  assert.ok(marks.max >= 260 && marks.min >= 1);

  // 조각 다음 문장은 정렬 단계 없이 ix_event_at 범위 탐색이다(행 수에 비례하는 임시 정렬 금지).
  const { DatabaseSync } = sqlite;
  const raw = new DatabaseSync(process.env.PARTFAULT_DB_PATH);
  const plan = raw.prepare('EXPLAIN QUERY PLAN SELECT * FROM part_event WHERE at>=? AND (at, id) < (?, ?) ORDER BY at DESC, id DESC LIMIT ?').all(0, NOW, 1, 10).map((r) => r.detail).join(' | ');
  raw.close();
  assert.match(plan, /ix_event_at/);
  assert.doesNotMatch(plan, /TEMP B-TREE/);
});

/* ─────────────────────────── ④ 실제 api 라우터 ─────────────────────────── */

let srv, base;
const USERS = {
  full: { username: 'full', role: 'admin', scope: null },
  op: { username: 'op', role: 'operator', scope: null },
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-us-east'] } },
};

before(async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
});
after(() => {
  try { srv?.close(); } catch { /* */ }
  try { db._resetForTest(); } catch { /* */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
});

async function call(u, p) {
  const r = await fetch(base + p, { headers: { 'x-u': u } });
  const tx = await r.text();
  let j = null; try { j = JSON.parse(tx); } catch { /* */ }
  return { s: r.status, t: tx, j };
}

test('④ GET /tools/part-faults/incidents — 장애 1건 = 1행 · 종류 필터는 목록만 · 비-admin 가림 · 범위 계정 403', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  db._resetForTest();
  process.env.PARTFAULT_DB_PATH = path.join(tmp, 'route', 'part-faults.db');
  const { _resetIncidentMemoForTest } = await import('../src/routes/api/partFaults.js');
  _resetIncidentMemoForTest();
  await seed([
    { part: part({ deviceId: '10.77.1.5', deviceName: '10.77.1.5', partId: 'Disk.1', label: 'Physical Disk 0:1' }), steps: [[NOW - 5 * HOUR, 'warn'], [NOW - 4 * HOUR, 'fault'], [NOW - 2 * HOUR, 'close']] },
    { part: part({ deviceId: 'srv-b', kind: 'dimm', partId: 'DIMM.A1', label: 'DIMM A1' }), steps: [[NOW - 3 * HOUR, 'fault']] },
    { part: part({ deviceId: 'srv-c', kind: 'nic', partId: 'NIC.1', label: 'NIC 1' }), steps: [[NOW - 40 * DAY, 'warn'], [NOW - 39 * DAY, 'close']] },
  ]);

  const a = await call('full', '/tools/part-faults/incidents?days=7');
  assert.equal(a.s, 200, a.t.slice(0, 300));
  assert.equal(a.j.available, true);
  assert.equal(a.j.total, 2, '7일 안: 디스크 1건(해소) + DIMM 1건(진행 중) — 40일 전 NIC 는 빠진다');
  assert.equal(a.j.incidents[0].kind, 'dimm', '진행 중이 먼저');
  const disk = a.j.incidents.find((i) => i.kind === 'disk');
  assert.equal(disk.durationMs, 3 * HOUR);
  assert.equal(disk.peak, 'fault');
  assert.equal(disk.events.length, 3);
  assert.deepEqual(a.j.kinds.map((k) => k.kind).sort(), ['dimm', 'disk']);
  assert.match(a.t, /10\.77\.1\.5/, 'admin 은 원문');

  const all = await call('full', '/tools/part-faults/incidents?days=0');
  assert.equal(all.j.days, 0);
  assert.equal(all.j.total, 3, '전체 = 보존 기간 전부');
  assert.ok(all.j.kinds.some((k) => k.kind === 'nic'));

  const f = await call('full', '/tools/part-faults/incidents?days=0&kind=nic');
  assert.equal(f.j.total, 1);
  assert.ok(f.j.incidents.every((i) => i.kind === 'nic'));
  assert.equal(f.j.kinds.length, 3, '종류별 집계는 필터와 무관하게 전체 — 다른 종류로 돌아갈 칩이 남는다');

  const o = await call('op', '/tools/part-faults/incidents?days=7');
  assert.equal(o.s, 200);
  assert.equal(o.j.addressHidden, true);
  assert.doesNotMatch(o.t, /10\.77\.1\.5/, '비-admin 응답에 IP 가 없다(행·타임라인·id)');

  const s = await call('sadm', '/tools/part-faults/incidents?days=7');
  assert.equal(s.s, 403, '범위 계정은 형제 라우트처럼 403');

  const ev7 = await call('full', '/tools/part-faults/events?days=0');
  assert.equal(ev7.j.days, 0, 'events 도 days=0 = 전체');
  assert.ok(ev7.j.events.length >= 6);
});

test('④ parseDays — 0 은 전체, 빈 값은 기본, 상한 3650', async () => {
  const { parseDays } = await import('../src/routes/api/partFaults.js');
  assert.equal(parseDays('0'), 0);
  assert.equal(parseDays(''), 30);
  assert.equal(parseDays(undefined), 30);
  assert.equal(parseDays('abc'), 30);
  assert.equal(parseDays('-5'), 30);
  assert.equal(parseDays('99999'), 3650);
  assert.equal(parseDays('7.9'), 7);
});
