/**
 * partFault2547.test.js — 물리 파트 장애 기록·알림(v2.547).
 *
 * 사용자 요청(2026-09-17): "서버 스토리지 등의 모든 장비에 있는 물리 파트 장애가 발생하면
 * 노티를 발생하고 체계적으로 파트 장애를 기록하는 DB 와 화면을 만들고 싶어" +
 * "엣지에서 수집해서 로컬에서 처리하고 장애만 중앙으로 보내게 해줘".
 *
 * ⚠ 이 파일이 고정하는 것은 **수치가 아니라 정직성 규칙**이다. 이 기능이 만들 수 있는 가장
 * 위험한 거짓 두 가지가 전부 '판정' 에 있다 —
 *   ① **확인하지 못한 것(unknown)·빈 슬롯(absent)을 정상이나 장애로 세는 것**
 *      (v2.526 실측: Unity SPA 의 DIMM 24칸 중 12칸이 `REMOVED`(빈 슬롯)인데 그걸 고장으로
 *       세면 **정상 장비에 장애 12건**이 찍힌다)
 *   ② **수집이 실패한 주기에 열린 장애를 '해소' 로 닫는 것**(진행 중인 장애가 이력에서 사라진다)
 *
 * 기준 시각은 **고정 상수**다(CLAUDE.md: 테스트에서 `Date.now()` 를 기준 시각으로 쓰지 말 것 —
 * v2.517 에 실제로 CI 가 깨졌다).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'partfault-'));
process.env.CONFIG_DIR = dir;

const { PART_STATE, summarize, makePart, partKeyOf, isBad, isUncounted, KEY_KIND_NOTE } = await import('../src/partfault/types.js');
const { redfishPartState, fruPartState, healthStringState, sanPartState } = await import('../src/partfault/classify.js');
const { extractIdracParts } = await import('../src/partfault/extract/idrac.js');
const { extractStorageParts } = await import('../src/partfault/extract/storage.js');
const { transition } = await import('../src/partfault/transition.js');
const { alertOf, notifyTransition, countDropped } = await import('../src/partfault/notify.js');
const { scanFrom } = await import('../src/partfault/scan.js');
const { TOOL_PATH_KEYS, toolCoverage } = await import('../src/auth/toolAccess.js');

/*
 * 기준 시각 — **정시 -30분**(CLAUDE.md v2.517 규약). 항상 과거이고 경계에서 30분 떨어져 있다.
 * ⚠ 절대 상수(예: 2023년)를 쓰면 안 된다 — `recentEvents` 의 조회 창(`Date.now() - sinceMs`)과
 *   `applyTransition` 의 보존 정리가 **지금 시각 기준**이라 그 이벤트가 조회되지 않는다
 *   (초판이 실제로 그래서 깨졌다). 버킷 경계가 없는 모듈이라 시(hour) 정렬만으로 충분하다.
 */
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;

/* ────────────────────────────── ① 분류(5상태) ────────────────────────────── */

test('redfish: Absent 는 Health 보다 우선 — 빈 슬롯에 장애는 없다', () => {
  // 실제로 이런 응답이 온다: 빈 DIMM 슬롯에 Health 가 남아 있는 경우.
  assert.equal(redfishPartState({ health: 'Critical', state: 'Absent' }).state, PART_STATE.absent);
  assert.equal(redfishPartState({ state: 'Absent' }).state, PART_STATE.absent);
});

test('redfish: Health 를 읽지 못하면 unknown 이다 — ok 로 접지 않는다', () => {
  assert.equal(redfishPartState({ health: '', state: 'Enabled' }).state, PART_STATE.unknown);
  assert.equal(redfishPartState({}).state, PART_STATE.unknown);
  assert.equal(redfishPartState({ health: 'Bogus' }).state, PART_STATE.unknown);
});

test('redfish: 예측 실패는 ok→warn 만, unknown 은 올리지 않는다', () => {
  assert.equal(redfishPartState({ health: 'OK', predictiveFailure: true }).state, PART_STATE.warn);
  assert.equal(redfishPartState({ health: 'Critical', predictiveFailure: true }).state, PART_STATE.fault);
  // ⚠ 상태를 못 읽은 부품에 '주의' 를 붙이면 '확인 불가' 가 화면에서 사라진다.
  assert.equal(redfishPartState({ health: '', predictiveFailure: true }).state, PART_STATE.unknown);
  // null(미확인)은 아무 일도 하지 않는다 — false 로 굳히지 않는다.
  assert.equal(redfishPartState({ health: 'OK', predictiveFailure: null }).state, PART_STATE.ok);
});

test('FRU: REMOVED=빈 슬롯 · UNKNOWN=확인 불가 · 모르는 값=장애', () => {
  assert.equal(fruPartState('REMOVED').state, PART_STATE.absent);
  assert.equal(fruPartState('UNKNOWN').state, PART_STATE.unknown);
  assert.equal(fruPartState('OK').state, PART_STATE.ok);
  assert.equal(fruPartState('FAULTED').state, PART_STATE.fault);   // 닫힌 열거형이 아니다
  assert.equal(fruPartState('').state, PART_STATE.unknown);
});

test('health 문자열: unknown 을 정상으로도 이상으로도 세지 않는다', () => {
  assert.equal(healthStringState('unknown').state, PART_STATE.unknown);
  assert.equal(healthStringState('').state, PART_STATE.unknown);
  assert.equal(healthStringState('OK').state, PART_STATE.ok);
  assert.equal(healthStringState('degraded').state, PART_STATE.warn);
  assert.equal(healthStringState('down').state, PART_STATE.fault);
  // SAN 4상태는 **번역만** 한다(판정을 다시 하지 않는다 — v2.513 규약).
  assert.equal(sanPartState('bad').state, PART_STATE.fault);
  assert.equal(sanPartState('nope').state, PART_STATE.unknown);
});

test('summarize: unknown·absent 는 ok 에도 fault 에도 들어가지 않는다', () => {
  const s = summarize([
    makePart({ scope: 'idrac', deviceId: 'a', kind: 'dimm', partId: '1', state: 'ok' }),
    makePart({ scope: 'idrac', deviceId: 'a', kind: 'dimm', partId: '2', state: 'absent' }),
    makePart({ scope: 'idrac', deviceId: 'a', kind: 'dimm', partId: '3', state: 'unknown' }),
    makePart({ scope: 'idrac', deviceId: 'a', kind: 'dimm', partId: '4', state: 'fault' }),
  ]);
  assert.deepEqual(s, { total: 4, ok: 1, warn: 0, fault: 1, unknown: 1, absent: 1 });
  assert.equal(isBad('unknown'), false);
  assert.equal(isBad('absent'), false);
  assert.equal(isUncounted('unknown') && isUncounted('absent'), true);
});

test('partKey 는 네 축 전부를 쓴다 — 서버가 달라도 Fan 1 이 겹치지 않는다', () => {
  assert.notEqual(partKeyOf({ scope: 'idrac', deviceId: 'a', kind: 'fan', partId: '1' }),
    partKeyOf({ scope: 'idrac', deviceId: 'b', kind: 'fan', partId: '1' }));
  assert.notEqual(partKeyOf({ scope: 'idrac', deviceId: 'a', kind: 'fan', partId: '1' }),
    partKeyOf({ scope: 'idrac', deviceId: 'a', kind: 'psu', partId: '1' }));
});

/* ─────────────────────────── ② 추출(iDRAC·스토리지) ─────────────────────────── */

test('iDRAC: 빈 DIMM 슬롯 12칸이 장애로 세어지지 않는다(v2.526 실측 재현)', () => {
  const inv = {
    memoryDimms: [
      ...Array.from({ length: 12 }, (_, i) => ({ locator: `DIMM.Socket.A${i + 1}`, health: 'OK', state: 'Enabled', sizeGB: 8 })),
      ...Array.from({ length: 12 }, (_, i) => ({ locator: `DIMM.Socket.B${i + 1}`, state: 'Absent' })),
    ],
  };
  const r = extractIdracParts({ id: 'srv1', name: 'ESX-01' }, inv);
  const s = summarize(r.parts);
  assert.equal(s.ok, 12);
  assert.equal(s.absent, 12);
  assert.equal(s.fault, 0);          // ← 되돌리면 정상 장비에 장애 12건이 찍힌다
  assert.equal(r.parts[0].keyKind, 'slot');
});

test('iDRAC: 같은 식별자가 둘이면 덮어쓰지 않고 순번 + 등급 index 로 낮춘다', () => {
  const inv = { storageControllers: [{ name: 'PERC H730', health: 'OK' }, { name: 'PERC H730', health: 'Critical' }] };
  const r = extractIdracParts({ id: 'srv1' }, inv);
  assert.equal(r.parts.length, 2);
  assert.equal(r.parts[1].partId, 'PERC H730#2');
  assert.equal(r.parts[1].keyKind, 'index');
  assert.match(KEY_KIND_NOTE.index, /순번/);
});

test('iDRAC: NIC 링크는 일부러 파트로 세지 않는다(대량 오탐 방지)', () => {
  const r = extractIdracParts({ id: 'srv1' }, { nics: [{ name: 'NIC.1', ports: [{ link: 'Down' }] }] });
  assert.equal(r.parts.length, 0);
  assert.equal(r.kinds.includes('nics'), false);
});

test('iDRAC: 식별자가 없는 부품은 파트로 기록하지 않는다(엉뚱한 키 생성 금지)', () => {
  const r = extractIdracParts({ id: 'srv1' }, { psus: [{ health: 'Critical' }] });
  assert.equal(r.parts.length, 0);
});

test('스토리지: 노드 목록이 있으면 판정, 미수집이면 notCollected 로 밝힌다', () => {
  const a = extractStorageParts({ id: 'd1', name: 'unity-01' },
    { name: 'OC2-unity-01', nodes: { count: 2, list: [{ name: 'SPA', health: 'OK' }, { name: 'SPB', health: 'unknown' }] } });
  assert.equal(a.parts.length, 2);
  assert.equal(summarize(a.parts).unknown, 1);   // 'SPB' 는 정상이 아니라 확인 불가
  assert.equal(a.parts[0].deviceName, 'OC2-unity-01');

  const b = extractStorageParts({ id: 'd2' }, { sections: { nodes: '미수집(이 수집 방식에서는 조회하지 않습니다)' } });
  assert.deepEqual(b.notCollected, ['node']);
  assert.equal(b.parts.length, 0);               // ← 0 을 지어내지 않는다
});

/* ─────────────────────────── ③ 전이(가장 위험한 판정) ─────────────────────────── */

const part = (o) => makePart({ scope: 'idrac', deviceId: 'srv1', kind: 'psu', ...o });

test('전이 ①: 그 장비의 수집이 실패하면 아무것도 닫지 않는다', () => {
  const open = [{ ...part({ partId: 'PSU1', state: 'fault' }), firstSeenAt: NOW - 1000 }];
  const tr = transition({ open, observed: [], scan: { deviceOk: { srv1: false } }, now: NOW });
  assert.equal(tr.closed.length, 0);
  assert.equal(tr.held[0].holdReason, 'device-failed');
});

test('전이 ②: unknown 은 열지도 닫지도 않는다(열려 있으면 유지)', () => {
  const opened = transition({ open: [], observed: [part({ partId: 'PSU1', state: 'unknown' })], scan: { deviceOk: { srv1: true } }, now: NOW });
  assert.equal(opened.opened.length, 0);

  const open = [{ ...part({ partId: 'PSU1', state: 'fault' }), firstSeenAt: NOW - 1000 }];
  const tr = transition({ open, observed: [part({ partId: 'PSU1', state: 'unknown', rawState: 'N/A' })], scan: { deviceOk: { srv1: true } }, now: NOW });
  assert.equal(tr.closed.length, 0);
  assert.equal(tr.held[0].holdReason, 'unknown');
  assert.equal(tr.stats.heldUnknown, 1);
});

test('전이 ③: absent 로 닫을 때 사유를 removed 로 구분한다(교체 이력이 사라지지 않게)', () => {
  const open = [{ ...part({ partId: 'PSU1', state: 'fault' }), firstSeenAt: NOW - 1000 }];
  const removed = transition({ open, observed: [part({ partId: 'PSU1', state: 'absent' })], scan: { deviceOk: { srv1: true } }, now: NOW });
  assert.equal(removed.closed[0].closeReason, 'removed');
  const fixed = transition({ open, observed: [part({ partId: 'PSU1', state: 'ok' })], scan: { deviceOk: { srv1: true } }, now: NOW });
  assert.equal(fixed.closed[0].closeReason, 'ok');
});

test('전이 ④: 관측 목록에서 사라진 파트는 닫지 않는다(missing)', () => {
  const open = [{ ...part({ partId: 'PSU1', state: 'fault' }), firstSeenAt: NOW - 1000 }];
  const tr = transition({ open, observed: [part({ partId: 'PSU2', state: 'ok' })], scan: { deviceOk: { srv1: true } }, now: NOW });
  assert.equal(tr.closed.length, 0);
  assert.equal(tr.held[0].holdReason, 'missing');
});

test('전이 ⑤: 장비 단위 판정 — A 의 성공이 B 의 이력을 건드리지 않는다', () => {
  const open = [
    { ...makePart({ scope: 'idrac', deviceId: 'A', kind: 'psu', partId: '1', state: 'fault' }), firstSeenAt: NOW - 1 },
    { ...makePart({ scope: 'idrac', deviceId: 'B', kind: 'psu', partId: '1', state: 'fault' }), firstSeenAt: NOW - 1 },
  ];
  const tr = transition({
    open,
    observed: [makePart({ scope: 'idrac', deviceId: 'A', kind: 'psu', partId: '1', state: 'ok' })],
    scan: { deviceOk: { A: true, B: false } }, now: NOW,
  });
  assert.equal(tr.closed.length, 1);
  assert.equal(tr.closed[0].deviceId, 'A');
  assert.equal(tr.held.find((h) => h.deviceId === 'B').holdReason, 'device-failed');
});

test('전이: 같은 상태가 이어지면 이벤트가 아니다(전이 테이블이 전량 적재가 되지 않게)', () => {
  const open = [{ ...part({ partId: 'PSU1', state: 'fault' }), firstSeenAt: NOW - 1000 }];
  const same = transition({ open, observed: [part({ partId: 'PSU1', state: 'fault' })], scan: { deviceOk: { srv1: true } }, now: NOW });
  assert.equal(same.updated[0].sameState, true);
  assert.equal(same.stats.changed, 0);
  const worse = transition({ open: [{ ...part({ partId: 'PSU1', state: 'warn' }), firstSeenAt: NOW - 1000 }],
    observed: [part({ partId: 'PSU1', state: 'fault' })], scan: { deviceOk: { srv1: true } }, now: NOW });
  assert.equal(worse.stats.changed, 1);
  assert.equal(worse.updated[0].prevState, 'warn');
  assert.equal(worse.updated[0].firstSeenAt, NOW - 1000);   // 처음 감지 시각은 보존된다
});

/* ─────────────────────────── ④ 스캔(엣지=중앙 공통) ─────────────────────────── */

test('스캔: 인벤토리가 낡으면 deviceOk=false — 그 장비를 판정하지 않는다', () => {
  const r = scanFrom({
    idracServers: [{ id: 'fresh' }, { id: 'stale' }],
    invOf: () => ({ psus: [{ name: 'PSU1', health: 'Critical', state: 'Enabled' }] }),
    invFresh: (id) => id === 'fresh',
  });
  assert.equal(r.deviceOk.fresh, true);
  assert.equal(r.deviceOk.stale, false);
  assert.equal(r.scanned.idrac.failed, 1);
  assert.equal(r.open.length, 1);                 // 낡은 쪽은 판정 자체를 하지 않는다
  assert.equal(r.open[0].deviceId, 'fresh');
});

test('스캔: 중앙에 보내는 open 은 장애만 — 요약이 나머지를 말한다', () => {
  const r = scanFrom({
    idracServers: [{ id: 'a' }],
    invOf: () => ({
      psus: [{ name: 'PSU1', health: 'OK', state: 'Enabled' }, { name: 'PSU2', health: 'Critical', state: 'Enabled' }],
      memoryDimms: [{ locator: 'A1', state: 'Absent' }, { locator: 'A2' }],
    }),
  });
  assert.equal(r.open.length, 1);
  assert.equal(r.scanned.summary.total, 4);
  assert.equal(r.scanned.summary.unknown, 1);     // A2 — health 없음
  assert.equal(r.scanned.summary.absent, 1);
  // ⚠ '장애 0건' 과 '수집 안 됨' 을 중앙이 구분할 수 있어야 한다(v2.517 sendStatusOnly 규약).
  const none = scanFrom({ idracServers: [], storageDevices: [] });
  assert.equal(none.open.length, 0);
  assert.ok(none.scanned.summary, '장애가 0건이어도 요약은 반드시 있다');
});

test("스캔: 'unknown' 파트의 키를 따로 낸다 — 엣지 위임에서 거짓 '복구' 를 막는 유일한 수단", () => {
  const r = scanFrom({
    idracServers: [{ id: 'a' }],
    invOf: () => ({ psus: [{ name: 'PSU1' }, { name: 'PSU2', health: 'Critical', state: 'Enabled' }] }),
  });
  assert.deepEqual(r.unknownKeys, ['idrac:a:psu:PSU1']);
  // ⚠ 엣지는 `open` 만 보내므로 unknown 이 된 파트는 목록에서 **사라진다**. 키가 없으면
  //   중앙은 그것을 '해소' 로 읽어 전이 규칙 ② 가 위임 장비에서만 깨진다.
  assert.equal(r.open.length, 1);
  assert.equal(r.scanned.unknownOmitted, 0);
});

const _edgeMod = await import('../src/central/partFaultEdge.js');

test('엣지 보고 병합: 오래된 보고의 unknownKeys 는 쓰지 않는다(장비 자체가 deviceOk=false)', async () => {
  const edge = _edgeMod;
  edge._resetForTest();
  edge.putEdgeReport('AGT', { open: [], unknownKeys: ['idrac:x:psu:1'], deviceOk: { x: true }, scanned: {} });
  const fresh = edge.mergeEdgeReports({ staleMs: 3_600_000 });
  assert.equal(fresh.unknownKeys.has('idrac:x:psu:1'), true);
  assert.equal(fresh.deviceOk.x, true);
  const stale = edge.mergeEdgeReports({ staleMs: 1, now: Date.now() + 10_000 });
  assert.equal(stale.unknownKeys.size, 0);
  assert.equal(stale.deviceOk.x, false);   // 오래된 보고는 아무것도 닫지 못하게 한다
  edge._resetForTest();
});

test('구버전 엣지·상한 절단은 "닫지 않는 쪽" 으로 실패한다(거짓 복구 금지)', () => {
  const edge = _edgeMod;
  edge._resetForTest();
  edge.putEdgeReport('OLD', { open: [], deviceOk: { x: true }, scanned: {} });              // unknownKeys 없음(구버전)
  edge.putEdgeReport('CUT', { open: [], unknownKeys: ['k'], deviceOk: { y: true }, scanned: { unknownOmitted: 7 } });
  edge.putEdgeReport('NEW', { open: [], unknownKeys: [], deviceOk: { z: true }, scanned: { unknownOmitted: 0 } });
  const m = edge.mergeEdgeReports({ staleMs: 3_600_000 });
  assert.equal(m.unknownTruncated.has('OLD'), true);
  assert.equal(m.unknownTruncated.has('CUT'), true);
  assert.equal(m.unknownTruncated.has('NEW'), false);
  edge._resetForTest();
});

/* ─────────────────────────────── ⑤ 알림 문구 ─────────────────────────────── */

test('알림 문구: `**` 가 새지 않는다(Slack·메일에는 BoldText 가 없다)', () => {
  const a = alertOf(part({ partId: 'PSU1', state: 'fault', label: 'PSU 1', rawState: 'Critical / Enabled', keyKind: 'index' }));
  assert.equal(/\*\*/.test(a.title + a.detail), false);
  assert.equal(a.severity, 'critical');
});

test('알림 문구: 종류를 되풀이하지 않는다(PSU PSU 1 금지)', () => {
  const a = alertOf(part({ partId: 'PSU1', state: 'fault', label: 'PSU 1' }));
  assert.equal(/PSU\s+PSU/.test(a.title), false);
  const b = alertOf(makePart({ scope: 'idrac', deviceId: 'srv1', kind: 'dimm', partId: 'A1', state: 'fault', label: 'DIMM.Socket.A1' }));
  assert.match(b.title, /메모리\(DIMM\) DIMM\.Socket\.A1/);   // 종류가 라벨에 없으면 붙인다
});

test('알림 문구: 해소 알림은 제거(removed)와 복구(ok)를 구분한다', () => {
  const removed = alertOf({ ...part({ partId: 'PSU1', state: 'fault' }), closeReason: 'removed' }, { closed: true });
  assert.match(removed.detail, /제거되어/);
  assert.equal(removed.severity, 'info');
  const ok = alertOf({ ...part({ partId: 'PSU1', state: 'fault' }), closeReason: 'ok' }, { closed: true });
  assert.equal(/제거되어/.test(ok.detail), false);
});

test('알림 상한은 버리는 것이 아니라 밝히는 것이다', async () => {
  const opened = Array.from({ length: 5 }, (_, i) => part({ partId: `PSU${i}`, state: 'fault' }));
  const r = await notifyTransition({ opened, updated: [], closed: [] }, { max: 2 });
  assert.equal(r.total, 5);
  assert.equal(r.capped, 3);                      // ← 조용히 버리면 이 값이 0 이 된다
  assert.equal(r.results.length, 2);
  assert.equal(countDropped([{ result: 'email:skip(rate)' }, { result: 'slack:ok' }]), 1);
});

/* ─────────────────────────────── ⑥ DB 왕복 ─────────────────────────────── */

test('DB: 전이만 적재하고(open/change/close) 같은 상태는 이벤트를 만들지 않는다', async (t) => {
  const db = await import('../src/partfault/db.js');
  const st = await db.partFaultDbStatus();
  if (!st.available) return t.skip(`node:sqlite 없음 — ${st.error}`);

  const p = part({ partId: 'PSU1', state: 'fault', rawState: 'Critical' });
  await db.applyTransition({ opened: [{ ...p, firstSeenAt: NOW, lastSeenAt: NOW }], updated: [], closed: [], held: [] }, { now: NOW });
  let open = await db.openFaults();
  assert.equal(open.length, 1);
  assert.equal(open[0].state, 'fault');
  assert.equal(open[0].firstSeenAt, NOW);

  // 같은 상태 유지 — 이벤트가 늘면 안 된다
  await db.applyTransition({ opened: [], updated: [{ ...p, firstSeenAt: NOW, lastSeenAt: NOW + 1000, prevState: 'fault', sameState: true }], closed: [], held: [] }, { now: NOW + 1000 });
  let ev = await db.recentEvents({ sinceMs: 10 * 86_400_000, limit: 100 });
  assert.equal(ev.filter((e) => e.event === 'open').length, 1);
  assert.equal(ev.filter((e) => e.event === 'change').length, 0);

  // 해소 — 열린 목록에서 사라지고 close 이벤트가 남는다
  await db.applyTransition({ opened: [], updated: [], closed: [{ ...p, closeReason: 'ok' }], held: [] }, { now: NOW + 2000 });
  open = await db.openFaults();
  assert.equal(open.length, 0);
  ev = await db.recentEvents({ sinceMs: 10 * 86_400_000, limit: 100 });
  assert.equal(ev.filter((e) => e.event === 'close')[0].closeReason, 'ok');
});

test('DB 파일 권한은 0600(v2.503 규약)', async (t) => {
  const f = path.join(dir, 'part-faults.db');
  if (!fs.existsSync(f)) return t.skip('DB 미생성(node:sqlite 없음)');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});

/* ─────────────────────────── ⑦ 배선(라우트·도구 키) ─────────────────────────── */

test('도구 키가 선언되고 매핑돼 있다 — 미선언 0(v2.506 규약)', () => {
  assert.equal(TOOL_PATH_KEYS['part-faults'], 'part-faults');
  assert.equal(toolCoverage().undeclared.length, 0);
});

test('조회 라우트는 DB 파일 경로를 admin 에게만 준다(operator 는 tools 기본 보유)', () => {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '../src/routes/api/partFaults.js'), 'utf8');
  // 세 조회 라우트 전부 dbView 를 거쳐야 한다 — 한 곳만 빠뜨리면 그 경로로 그대로 나간다.
  assert.equal((src.match(/db: dbView\(/g) || []).length, 3);
  assert.match(src, /redacted: \['path'\]/);   // 조용히 빼지 않고 가린 사실을 밝힌다
  // 전체 범위 계정만 — 부분집합을 주면 '장애 없음' 이라는 거짓이 된다(v2.525 Horizon 규약).
  assert.equal((src.match(/fullScopeOnly/g) || []).length >= 5, true);
  // 상태변경(지금 점검)은 역할 게이트도 함께 — requirePerm 만으로는 viewer 를 막지 못한다.
  assert.match(src, /api\.post\('\/tools\/part-faults\/scan', writeRole, toolsPerm, fullScopeOnly/);
});

test('라우트가 실제로 등록되고 BIG_JSON 에 올라가 있다', () => {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const api = fs.readFileSync(path.join(here, '../src/routes/api.js'), 'utf8');
  assert.match(api, /registerPartFaults\(api\)/);
  const idx = fs.readFileSync(path.join(here, '../src/index.js'), 'utf8');
  // ⚠ 중앙 push 경로는 gzip + BIG_JSON 등록 + 413 로그 셋이 계약이다(v2.503).
  assert.match(idx, /app\.use\('\/api\/central\/part-faults', BIG_JSON\)/);
  assert.match(idx, /startPartFaultPoller/);
  const push = fs.readFileSync(path.join(here, '../src/partfault/push.js'), 'utf8');
  assert.match(push, /Content-Encoding.*gzip|gzipAsync/s);
  assert.match(push, /413/);
  // ⚠ 장애 0건이어도 push 한다 — `storage/push.js:30` 의 '0대면 POST 안 함' 결함을 반복하지 않는다.
  assert.equal(/if \(!open\.length\)[^\n]*return/.test(push), false);
  const central = fs.readFileSync(path.join(here, '../src/routes/central.js'), 'utf8');
  assert.match(central, /part-faults/);
});
