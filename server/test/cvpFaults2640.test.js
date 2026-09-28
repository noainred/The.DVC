/**
 * test/cvpFaults2640.test.js — CVP 장애 전이 기록 + 알림(v2.640).
 *
 * 순수(faults.js): partfault 6규칙을 **하나씩** 고정한다 — 규칙 하나를 빼면 그 테스트가 실패해야 한다(변이 검증용). + C1 최악 상태 ·
 *   포트 nolink/admin down 은 판정 대상 아님 · BGP MIB 숫자 · not-streaming 보류.
 * DB(db.js + faultScan.js + faultNotify.js): saveDevices 로 장비를 넣고 runCvpFaultScan 을 **실제로** 돌려 state/event 가 쌓이고,
 *   다음 스캔에서 ok 로 바뀌면 close 이벤트 · 장비 ts 가 낡으면 held(device-stale) · 알림은 send 목으로 순서·건수 · closeFaultManual ·
 *   prune 이 fault_event 를 지움 · applyFaultTransition 트랜잭션 실패 시 ROLLBACK.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvpfaults2640-'));

const F = await import('../src/cvp/faults.js');
const { observeDevice, transition, HOLD_REASON, devIdOf } = F;

const NOW = 1_800_000_000_000; // 고정 기준 시각(경계와 무관 — v2.517 규약)
const IV = 300_000;
const dev = (o = {}) => ({
  agent: '', cvpId: 'cvp-1', key: 'SN1', hostname: 'leaf1', collectedAt: NOW - 1000, telemetry: 'ok', streaming: true,
  partsList: [], bgpPeers: [], portsRead: true, ports: [], ...o,
});
const obs = (d, extra = {}) => ({ ...observeDevice(d, { intervalMs: IV, now: NOW }), agent: d.agent, cvpId: d.cvpId, deviceKey: d.key, deviceName: d.hostname, ...extra });
const openRow = (o = {}) => ({ agent: '', cvpId: 'cvp-1', deviceKey: 'SN1', faultKey: 'psu:PowerSupply1', kind: 'psu', label: 'PowerSupply1', state: 'fault', detail: 'powerLoss', firstSeen: NOW - 86_400_000, ...o });
const runTr = (open, devs) => transition({ open, observedByDevice: new Map(devs.map((d) => [devIdOf(d), d])), now: NOW });

/* ── 순수 ─────────────────────────────────────────────────────────────── */

test('observeDevice — 부품·포트·BGP 관측과 kindsFailed', () => {
  const o = observeDevice(dev({
    partsList: [{ kind: 'psu', name: 'PowerSupply1', state: 'fault', detail: 'powerLoss' }, { kind: 'fan', name: 'Fan1', state: 'ok' }, { kind: 'xcvr', name: 'Ethernet3', state: 'absent' }, { kind: 'temp', name: 'Cpu', state: 'unknown' }],
    ports: [{ name: 'Ethernet1', oper: 'down', admin: 'up' }, { name: 'Ethernet2', oper: 'up', admin: 'up' }, { name: 'Ethernet3', oper: 'nolink', admin: 'up' }, { name: 'Ethernet4', oper: 'down', admin: 'down' }],
    bgpPeers: [{ peer: '10.0.0.1', vrf: '', state: 'Established', prefixes: 12 }, { peer: '10.0.0.2', vrf: 'MGMT', state: 'Active' }],
  }), { intervalMs: IV, now: NOW });
  assert.equal(o.deviceOk, true);
  assert.deepEqual(o.kindsFailed, []);
  const by = Object.fromEntries(o.observed.map((x) => [x.faultKey, x.state]));
  assert.equal(by['psu:PowerSupply1'], 'fault');
  assert.equal(by['fan:Fan1'], 'ok');
  assert.equal(by['xcvr:Ethernet3'], 'absent');
  assert.equal(by['temp:Cpu'], 'unknown');
  assert.equal(by['port:Ethernet1'], 'fault', 'admin up · oper down 만 장애');
  assert.equal(by['port:Ethernet2'], 'ok');
  assert.equal(by['port:Ethernet3'], 'unknown', 'nolink 는 판정 대상이 아니다');
  assert.equal(by['port:Ethernet4'], 'unknown', 'admin down 은 판정 대상이 아니다');
  assert.equal(by['bgp:default|10.0.0.1'], 'ok');
  assert.equal(by['bgp:MGMT|10.0.0.2'], 'fault');
  // 못 읽은 종류
  const k = observeDevice(dev({ partsList: null, ports: null, portsRead: false, bgpPeers: null }), { intervalMs: IV, now: NOW });
  assert.deepEqual(k.kindsFailed, ['psu', 'fan', 'temp', 'xcvr', 'port', 'bgp']);
  // listDeviceRows 의 ports 는 요약 객체 — 배열이 아니면 못 읽은 것으로 본다
  assert.ok(observeDevice(dev({ ports: { total: 3, up: 2, down: 1 } }), { intervalMs: IV, now: NOW }).kindsFailed.includes('port'));
});

test('BGP MIB 숫자 상태 — 6=established, 1~5=down, 그 밖은 unknown', () => {
  const o = observeDevice(dev({ bgpPeers: [{ peer: 'a', state: 6 }, { peer: 'b', state: '3' }, { peer: 'c', state: 0 }, { peer: 'd', state: '' }] }), { intervalMs: IV, now: NOW });
  const by = Object.fromEntries(o.observed.map((x) => [x.faultKey, x.state]));
  assert.equal(by['bgp:default|a'], 'ok');
  assert.equal(by['bgp:default|b'], 'fault');
  assert.equal(by['bgp:default|c'], 'unknown');
  assert.equal(by['bgp:default|d'], 'unknown');
});

test('deviceOk — stale/not-streaming/failed 는 false 이고 사유가 다르다; budget-partial·빈 값은 true', () => {
  assert.equal(observeDevice(dev({ collectedAt: NOW - IV * 3 - 1 }), { intervalMs: IV, now: NOW }).deviceReason, HOLD_REASON.deviceStale);
  assert.equal(observeDevice(dev({ collectedAt: NOW - IV * 3 + 1 }), { intervalMs: IV, now: NOW }).deviceOk, true);
  assert.equal(observeDevice(dev({ telemetry: 'not-streaming' }), { intervalMs: IV, now: NOW }).deviceReason, HOLD_REASON.notStreaming);
  for (const tm of ['failed', 'aborted', 'budget', 'pending']) assert.equal(observeDevice(dev({ telemetry: tm }), { intervalMs: IV, now: NOW }).deviceReason, HOLD_REASON.deviceFailed, tm);
  for (const tm of ['ok', 'budget-partial', '']) assert.equal(observeDevice(dev({ telemetry: tm }), { intervalMs: IV, now: NOW }).deviceOk, true, tm);
  // 낡음이 not-streaming 보다 먼저
  assert.equal(observeDevice(dev({ telemetry: 'not-streaming', collectedAt: NOW - IV * 10 }), { intervalMs: IV, now: NOW }).deviceReason, HOLD_REASON.deviceStale);
});

test('C1 — 같은 faultKey 가 두 번 관측되면 가장 나쁜 상태 하나(fault > warn > unknown > ok > absent)', () => {
  const o = observeDevice(dev({ partsList: [{ kind: 'psu', name: 'P1', state: 'ok' }, { kind: 'psu', name: 'P1', state: 'fault' }, { kind: 'psu', name: 'P1', state: 'unknown' }] }), { intervalMs: IV, now: NOW });
  assert.equal(o.observed.length, 1);
  assert.equal(o.observed[0].state, 'fault');
  assert.equal(o.duplicateObserved, 2);
  const u = observeDevice(dev({ partsList: [{ kind: 'psu', name: 'P1', state: 'ok' }, { kind: 'psu', name: 'P1', state: 'unknown' }] }), { intervalMs: IV, now: NOW });
  assert.equal(u.observed[0].state, 'unknown', 'unknown 이 ok 를 이긴다(못 읽은 것을 닫지 않는 방향)');
});

test('규칙 ① — 장비 수집 실패면 ok 관측이 있어도 닫지 않는다(held device-failed)', () => {
  const d = dev({ telemetry: 'failed', partsList: [{ kind: 'psu', name: 'PowerSupply1', state: 'ok' }] });
  const tr = runTr([openRow()], [obs(d)]);
  assert.equal(tr.closed.length, 0);
  assert.equal(tr.held.length, 1);
  assert.equal(tr.held[0].holdReason, HOLD_REASON.deviceFailed);
  // 실패한 장비의 fault 관측으로 새로 열지도 않는다(옛 값이다)
  const d2 = dev({ telemetry: 'failed', partsList: [{ kind: 'fan', name: 'Fan9', state: 'fault' }] });
  assert.equal(runTr([], [obs(d2)]).opened.length, 0);
  // 낡은 장비 → device-stale
  const d3 = dev({ collectedAt: NOW - IV * 5, partsList: [{ kind: 'psu', name: 'PowerSupply1', state: 'ok' }] });
  assert.equal(runTr([openRow()], [obs(d3)]).held[0].holdReason, HOLD_REASON.deviceStale);
  // not-streaming → not-streaming
  const d4 = dev({ telemetry: 'not-streaming', partsList: [{ kind: 'psu', name: 'PowerSupply1', state: 'ok' }] });
  assert.equal(runTr([openRow()], [obs(d4)]).held[0].holdReason, HOLD_REASON.notStreaming);
});

test('규칙 ② — unknown 은 열지도 닫지도 않는다', () => {
  const d = dev({ partsList: [{ kind: 'psu', name: 'PowerSupply1', state: 'unknown' }, { kind: 'fan', name: 'Fan1', state: 'unknown' }] });
  const tr = runTr([openRow()], [obs(d)]);
  assert.equal(tr.opened.length, 0, 'unknown 으로 새 장애를 열지 않는다');
  assert.equal(tr.closed.length, 0, 'unknown 으로 닫지 않는다');
  assert.equal(tr.held.length, 1);
  assert.equal(tr.held[0].holdReason, HOLD_REASON.unknown);
});

test('규칙 ③ — absent 는 removed 로, ok 는 ok 로 닫는다', () => {
  const d = dev({ partsList: [{ kind: 'psu', name: 'PowerSupply1', state: 'absent' }, { kind: 'fan', name: 'Fan1', state: 'ok' }] });
  const tr = runTr([openRow(), openRow({ faultKey: 'fan:Fan1', kind: 'fan', label: 'Fan1' })], [obs(d)]);
  assert.equal(tr.closed.length, 2);
  const by = Object.fromEntries(tr.closed.map((c) => [c.faultKey, c.closeReason]));
  assert.equal(by['psu:PowerSupply1'], 'removed');
  assert.equal(by['fan:Fan1'], 'ok');
  assert.equal(tr.held.length, 0);
});

test('규칙 ④ — 관측 목록에 없는 열린 장애는 held missing(닫지 않는다)', () => {
  const d = dev({ partsList: [{ kind: 'fan', name: 'Fan1', state: 'ok' }] }); // PSU 목록은 읽었지만 PowerSupply1 이 없다
  const tr = runTr([openRow()], [obs(d)]);
  assert.equal(tr.closed.length, 0);
  assert.equal(tr.held[0].holdReason, HOLD_REASON.missing);
});

test('규칙 ⑤ — 장비 단위: A 는 닫고 B 는 보류', () => {
  const a = dev({ key: 'SN-A', partsList: [{ kind: 'psu', name: 'PowerSupply1', state: 'ok' }] });
  const b = dev({ key: 'SN-B', telemetry: 'aborted', partsList: [{ kind: 'psu', name: 'PowerSupply1', state: 'ok' }] });
  const tr = runTr([openRow({ deviceKey: 'SN-A' }), openRow({ deviceKey: 'SN-B' })], [obs(a), obs(b)]);
  assert.deepEqual(tr.closed.map((c) => c.deviceKey), ['SN-A']);
  assert.deepEqual(tr.held.map((h) => [h.deviceKey, h.holdReason]), [['SN-B', HOLD_REASON.deviceFailed]]);
  // 이번 판정에 아예 없는 장비의 열린 장애도 닫지 않는다
  const tr2 = runTr([openRow({ deviceKey: 'SN-GONE' })], [obs(a)]);
  assert.equal(tr2.closed.length, 0);
  assert.equal(tr2.held[0].holdReason, HOLD_REASON.deviceFailed);
});

test('규칙 ⑥ — 종류 단위: 부품 목록만 못 읽었으면 PSU 장애는 collection-failed, 포트 장애는 정상 판정', () => {
  const d = dev({ partsList: null, ports: [{ name: 'Ethernet1', oper: 'up', admin: 'up' }] });
  const tr = runTr([openRow(), openRow({ faultKey: 'port:Ethernet1', kind: 'port', label: 'Ethernet1' })], [obs(d)]);
  assert.deepEqual(tr.closed.map((c) => c.faultKey), ['port:Ethernet1']);
  assert.deepEqual(tr.held.map((h) => [h.faultKey, h.holdReason]), [['psu:PowerSupply1', HOLD_REASON.collectionFailed]]);
  // BGP 만 못 읽은 경우
  const d2 = dev({ bgpPeers: null, partsList: [{ kind: 'psu', name: 'PowerSupply1', state: 'ok' }] });
  const tr2 = runTr([openRow(), openRow({ faultKey: 'bgp:default|10.0.0.9', kind: 'bgp', label: '10.0.0.9' })], [obs(d2)]);
  assert.deepEqual(tr2.closed.map((c) => c.faultKey), ['psu:PowerSupply1']);
  assert.deepEqual(tr2.held.map((h) => h.holdReason), [HOLD_REASON.collectionFailed]);
});

test('열기·변화·지속 — warn↔fault 는 change, 같은 상태는 sameState', () => {
  const d = dev({ partsList: [{ kind: 'psu', name: 'PowerSupply1', state: 'warn' }, { kind: 'fan', name: 'Fan1', state: 'fault' }, { kind: 'fan', name: 'Fan2', state: 'fault' }] });
  const tr = runTr([openRow(), openRow({ faultKey: 'fan:Fan1', kind: 'fan', label: 'Fan1', state: 'fault' })], [obs(d)]);
  assert.deepEqual(tr.opened.map((o) => o.faultKey), ['fan:Fan2']);
  const ch = tr.updated.find((u) => u.faultKey === 'psu:PowerSupply1');
  assert.equal(ch.sameState, false); assert.equal(ch.prevState, 'fault'); assert.equal(ch.state, 'warn');
  assert.equal(tr.updated.find((u) => u.faultKey === 'fan:Fan1').sameState, true);
  assert.equal(tr.stats.changed, 1); assert.equal(tr.stats.sustained, 1); assert.equal(tr.stats.opened, 1);
});

test('법인 축 — 다른 agent 의 같은 장비 키는 다른 장애다', () => {
  const a = dev({ agent: 'edge-a', partsList: [{ kind: 'psu', name: 'PowerSupply1', state: 'ok' }] });
  const tr = runTr([openRow({ agent: 'edge-b' })], [obs(a)]);
  assert.equal(tr.closed.length, 0, 'edge-a 의 ok 가 edge-b 의 장애를 닫지 않는다');
  assert.equal(tr.held[0].holdReason, HOLD_REASON.deviceFailed);
});

/* ── 알림 문구 ─────────────────────────────────────────────────────────── */

test('alertOf — 별표 0 · 종류 한글 · 심각도', async () => {
  const { alertOf } = await import('../src/cvp/faultNotify.js');
  const f = { agent: 'edge-a', cvpId: 'cvp-1', deviceKey: 'SN1', deviceName: 'leaf1', faultKey: 'psu:PowerSupply1', kind: 'psu', label: 'PowerSupply1', state: 'fault', detail: '**powerLoss**', cvpName: 'CVP-A' };
  const a = alertOf(f);
  assert.equal(a.key, 'cvpfault:edge-a|cvp-1|SN1|psu:PowerSupply1');
  assert.equal(a.severity, 'critical');
  assert.ok(!/\*\*/.test(a.title + a.detail));
  assert.ok(/leaf1/.test(a.title) && /PSU PowerSupply1/.test(a.title));
  assert.ok(/CVP: CVP-A/.test(a.detail) && /수집: edge-a/.test(a.detail));
  assert.equal(alertOf({ ...f, state: 'warn' }).severity, 'warning');
  const c = alertOf({ ...f, closeReason: 'removed' }, { closed: true });
  assert.equal(c.severity, 'info'); assert.ok(/:close$/.test(c.key)); assert.ok(/제거/.test(c.detail));
  assert.ok(/BGP 피어 10\.0\.0\.1/.test(alertOf({ ...f, kind: 'bgp', label: '10.0.0.1' }).title));
});

/* ── DB + 실제 스캔 ───────────────────────────────────────────────────── */

const db = await import('../src/cvp/db.js');
const reg = await import('../src/cvp/registry.js');
const S = await import('../src/cvp/settings.js');
const scan = await import('../src/cvp/faultScan.js');
let cvpId = null;
let sqlite = false;
before(async () => {
  db._resetForTest(); reg._resetForTest(); S._resetForTest(); scan._resetForTest();
  sqlite = await db.available();
  S.saveSettings({ enabled: true, intervalMs: 300_000 });
  cvpId = reg.saveServer({ name: 'CVP-A', host: 'cvp-a.example', authMode: 'token', token: 'TOK' }).id;
});

const sent = [];
const send = async (a) => { sent.push(a); return ['slack:200']; };
const parts = (psu) => [{ kind: 'psu', name: 'PowerSupply1', state: psu, detail: psu === 'fault' ? 'powerLoss' : 'ok' }, { kind: 'fan', name: 'Fan1', state: 'ok' }];
const record = (ts, { psu = 'fault', e1 = 'down', bgp = 'Established' } = {}) => ({
  key: 'SN-LEAF1', ts, hostname: 'leaf1', telemetry: 'ok', streaming: true, parts: parts(psu), partsAt: ts,
  bgp: [{ peer: '10.0.0.1', vrf: '', state: bgp, prefixes: 5 }],
  ports: [{ name: 'Ethernet1', oper: e1, admin: 'up' }, { name: 'Ethernet2', oper: 'up', admin: 'up' }, { name: 'Ethernet3', oper: 'nolink', admin: 'up' }],
});

test('★ 스캔 1 — 장비 적재 → 장애 2건(PSU·포트) 열림 · 이벤트 open · 알림 순차 2건 · notified_at', async () => {
  if (!sqlite) return;
  const t1 = Date.now() - 10_000;
  await db.saveDevices({ cvpId, devices: [record(t1)] });
  const r = await scan.runCvpFaultScan({ reason: 'test1', notify: true, send });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.devices, 1);
  assert.equal(r.opened, 2);
  const open = (await db.listOpenFaults()).rows;
  assert.deepEqual(open.map((f) => f.faultKey).sort(), ['port:Ethernet1', 'psu:PowerSupply1']);
  assert.ok(open.every((f) => f.notifiedAt != null), '알림 뒤 notified_at 이 찍힌다');
  assert.equal(open[0].deviceName, 'leaf1');
  assert.equal(sent.length, 2);
  assert.ok(sent.every((a) => a.severity === 'critical' && /CVP 장애 — leaf1/.test(a.title)));
  const ev = (await db.recentFaultEvents()).rows;
  assert.deepEqual(ev.map((e) => e.event), ['open', 'open']);
  const c = await db.faultCounts();
  assert.equal(c.open, 2); assert.equal(c.byState.fault, 2); assert.equal(c.held, 0);
  // 재실행(같은 상태) — 이벤트·알림이 늘지 않는다
  sent.length = 0;
  const r2 = await scan.runCvpFaultScan({ reason: 'test1b', notify: true, send });
  assert.equal(r2.opened + r2.updated + r2.closed, 0);
  assert.equal(sent.length, 0);
  assert.equal((await db.recentFaultEvents()).rows.length, 2);
});

test('★ 스캔 2 — 장비 ts 가 낡으면 held(device-stale) 로 닫히지 않는다', async () => {
  if (!sqlite) return;
  const r = await scan.runCvpFaultScan({ reason: 'stale', now: Date.now() + 2 * 3600_000, notify: true, send });
  assert.equal(r.closed, 0);
  assert.equal(r.held, 2);
  const open = (await db.listOpenFaults()).rows;
  assert.ok(open.every((f) => f.holdReason === 'device-stale'), JSON.stringify(open));
  assert.equal((await db.faultCounts()).held, 2);
});

test('★ 스캔 3 — PSU ok · 포트 up 으로 오면 close 이벤트 + 해소 알림(info)', async () => {
  if (!sqlite) return;
  sent.length = 0;
  await db.saveDevices({ cvpId, devices: [record(Date.now() - 5_000, { psu: 'ok', e1: 'up' })] });
  const r = await scan.runCvpFaultScan({ reason: 'test3', notify: true, send });
  assert.equal(r.closed, 2, JSON.stringify(r));
  assert.equal((await db.listOpenFaults()).rows.length, 0);
  const ev = (await db.recentFaultEvents()).rows;
  assert.deepEqual(ev.slice(0, 2).map((e) => [e.event, e.closeReason, e.prevState]), [['close', 'ok', 'fault'], ['close', 'ok', 'fault']]);
  assert.equal(sent.length, 2);
  assert.ok(sent.every((a) => a.severity === 'info' && /해소/.test(a.title) && /:close$/.test(a.key)));
});

test('★ 스캔 4 — BGP down 열림 → 스트리밍 중단(not-streaming)이면 보류 · notify 꺼짐이면 알림 0', async () => {
  if (!sqlite) return;
  sent.length = 0;
  await db.saveDevices({ cvpId, devices: [record(Date.now() - 4_000, { psu: 'ok', e1: 'up', bgp: 'Active' })] });
  const r = await scan.runCvpFaultScan({ reason: 'bgp', notify: false, send });
  assert.equal(r.opened, 1);
  assert.equal(sent.length, 0);
  assert.equal(r.notified, null);
  assert.equal((await db.listOpenFaults()).rows[0].notifiedAt, null);
  const rec = record(Date.now() - 3_000, { psu: 'ok', e1: 'up', bgp: 'Established' });
  rec.telemetry = 'not-streaming';
  await db.saveDevices({ cvpId, devices: [rec] });
  const r2 = await scan.runCvpFaultScan({ reason: 'ns', notify: true, send });
  assert.equal(r2.closed, 0);
  assert.equal((await db.listOpenFaults()).rows[0].holdReason, 'not-streaming');
});

test('★ 등록부 밖 행(다른 엣지·미등록 cvp)은 판정하지 않는다 — 그 장애는 보류', async () => {
  if (!sqlite) return;
  await db.saveDevices({ agent: 'edge-x', cvpId, devices: [record(Date.now() - 2_000, { psu: 'ok', e1: 'up' })] });
  await db.saveDevices({ cvpId: 'cvp-unregistered', devices: [record(Date.now() - 2_000, { psu: 'ok', e1: 'up' })] });
  const r = await scan.runCvpFaultScan({ reason: 'own', notify: false });
  assert.equal(r.devices, 1);
  assert.equal(r.skippedUnregistered, 2);
  // 담당 엣지를 바꾸면 그 엣지 행만 판정한다
  reg.saveServer({ id: cvpId, name: 'CVP-A', host: 'cvp-a.example', authMode: 'token', token: '********', agent: 'Edge-X' });
  const r2 = await scan.runCvpFaultScan({ reason: 'own2', notify: false });
  assert.equal(r2.devices, 1);
  const bgpOpen = (await db.listOpenFaults()).rows.find((f) => f.kind === 'bgp');
  assert.equal(bgpOpen.agent, '');
  assert.equal(bgpOpen.holdReason, 'device-failed', '중앙 직접 행은 이제 판정 대상이 아니라 보류(닫지 않는다)');
  reg.saveServer({ id: cvpId, name: 'CVP-A', host: 'cvp-a.example', authMode: 'token', token: '********', agent: '' });
});

test('closeFaultManual — 이벤트 close(manual:user) · 없는 키는 closed 0', async () => {
  if (!sqlite) return;
  const f = (await db.listOpenFaults()).rows.find((x) => x.kind === 'bgp');
  const r = await db.closeFaultManual({ ...f, reason: '장비 재배정', user: 'admin' });
  assert.deepEqual(r, { ok: true, closed: 1 });
  assert.equal((await db.listOpenFaults()).rows.length, 0);
  const ev = (await db.recentFaultEvents()).rows[0];
  assert.equal(ev.event, 'close'); assert.equal(ev.closeReason, 'manual:admin'); assert.equal(ev.detail, '장비 재배정'); assert.equal(ev.prevState, 'fault');
  assert.deepEqual(await db.closeFaultManual({ ...f, user: 'admin' }), { ok: true, closed: 0 });
});

test('applyFaultTransition — 트랜잭션 실패 시 ROLLBACK(앞 항목도 남지 않는다)', async () => {
  if (!sqlite) return;
  const before = (await db.recentFaultEvents()).rows.length;
  const good = { agent: '', cvpId, deviceKey: 'SN-RB', faultKey: 'fan:Fan1', kind: 'fan', label: 'Fan1', state: 'fault', detail: '' };
  const bad = { agent: '', cvpId, deviceKey: 'SN-RB', faultKey: 'fan:Fan2', kind: 'fan', label: 'Fan2', state: null, detail: '' }; // state NOT NULL 위반
  await assert.rejects(db.applyFaultTransition({ opened: [good, bad] }));
  assert.equal((await db.listOpenFaults()).rows.length, 0, 'good 도 남지 않는다');
  assert.equal((await db.recentFaultEvents()).rows.length, before);
  // 정상 반영 + deleteFaultsFor
  await db.applyFaultTransition({ opened: [good] });
  assert.equal((await db.listOpenFaults({ cvpId })).rows.length, 1);
  assert.deepEqual(await db.deleteFaultsFor(null, cvpId), { removed: 1 });
});

test('prune — fault_event 를 dailyRetentionDays 로 지운다', async () => {
  if (!sqlite) return;
  assert.ok((await db.recentFaultEvents()).rows.length >= 5);
  const r = await db.prune({ rawRetentionDays: 7, dailyRetentionDays: 30, now: Date.now() + 40 * 86_400_000 });
  assert.ok(r.faultEvents >= 5, JSON.stringify(r));
  assert.equal((await db.recentFaultEvents({ sinceMs: 365 * 86_400_000 })).rows.length, 0);
});

test('markFaultNotified 는 실제 갱신 행 수 · portStateRows 모양', async () => {
  if (!sqlite) return;
  assert.equal(await db.markFaultNotified([{ agent: '', cvpId, deviceKey: 'nope', faultKey: 'x:y' }]), 0);
  const p = (await db.portStateRows({ cvpId })).rows.find((x) => x.port === 'Ethernet3');
  assert.deepEqual(Object.keys(p).sort(), ['admin', 'agent', 'cvpId', 'desc', 'key', 'oper', 'port']);
  assert.equal(p.oper, 'nolink');
});

test('cvpFaultScanStatus — enabled/intervalMs/at/last · 디바운스 한 번만', async () => {
  const st = scan.cvpFaultScanStatus();
  assert.equal(st.enabled, true);
  assert.equal(st.intervalMs, 300_000);
  assert.equal(typeof st.debounceMs, 'number');
  assert.equal(st.at, st.last?.at ?? null);
  scan.scheduleCvpFaultScan('ingest'); scan.scheduleCvpFaultScan('ingest'); scan.scheduleCvpFaultScan('ingest');
  assert.equal(scan.cvpFaultScanStatus().pending, 3);
  scan._resetForTest();
  assert.equal(scan.cvpFaultScanStatus().pending, 0);
  // 수집 꺼짐·등록 0대면 enabled false
  S.saveSettings({ enabled: false });
  assert.equal(scan.cvpFaultScanStatus().enabled, false);
  S.saveSettings({ enabled: true });
  reg.deleteServer(cvpId);
  assert.equal(scan.cvpFaultScanStatus().enabled, false);
  assert.equal(scan.cvpFaultScanStatus().servers, 0);
});
