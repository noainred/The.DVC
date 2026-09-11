// v2.483 — 전원 꺼진 VM 의 '꺼진 지 N일' 판정(순수) + vmtrack/logs DB 조회 왕복.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poweroff-'));
process.env.CONFIG_DIR = tmp;
process.env.VMTRACK_DB_PATH = path.join(tmp, 'vm-track.db');
const sqliteOk = await import('node:sqlite').then(() => true).catch(() => false);
const { resolveOffSince, poweredOffSinceFor, _resetPowerOffCache } = await import('../src/tools/powerOff.js');
const vt = await import('../src/vmtrack/db.js');
const logs = await import('../src/logs/db.js');

const H = 3_600_000; const D = 24 * H;
const NOW = Date.parse('2026-09-12T00:00:00Z');

test('resolveOffSince — 이벤트(정확)가 있으면 이벤트, 추적 전환이 이벤트 직후 슬롯이면 여전히 이벤트', () => {
  const r = resolveOffSince({ event: { offTs: NOW - 10 * D - 5 * H, onTs: NOW - 30 * D }, track: { offTs: NOW - 10 * D, onTs: 0 }, now: NOW });
  assert.equal(r.source, 'event'); assert.equal(r.exact, true); assert.equal(r.offDays, 10);
});
test('resolveOffSince — 추적 전환이 이벤트보다 훨씬 늦으면(그 사이 기록 누락) 더 늦은 추적을 하한으로', () => {
  const r = resolveOffSince({ event: { offTs: NOW - 40 * D, onTs: 0 }, track: { offTs: NOW - 3 * D, onTs: NOW - 20 * D }, now: NOW });
  assert.equal(r.source, 'track'); assert.equal(r.exact, false); assert.equal(r.offDays, 3);
});
test('resolveOffSince — 이벤트상 나중에 켜졌으면(onTs>offTs) 이벤트 후보 제외 → 추적/first_seen 폴백', () => {
  const r = resolveOffSince({ event: { offTs: NOW - 9 * D, onTs: NOW - 8 * D }, track: null, roster: { firstSeen: NOW - 100 * D, powerState: 'POWERED_OFF' }, now: NOW });
  assert.equal(r.source, 'first_seen'); assert.equal(r.offDays, 100); assert.equal(r.exact, false);
});
test('resolveOffSince — 출처가 전혀 없거나 로스터가 켜짐이면 null(추정 금지)', () => {
  assert.equal(resolveOffSince({ now: NOW }), null);
  assert.equal(resolveOffSince({ roster: { firstSeen: NOW - D, powerState: 'POWERED_ON' }, now: NOW }), null);
});

test('DB 왕복 — vmtrack 전환/first_seen + logs 전원 이벤트로 꺼진 시각 판정', { skip: !sqliteOk ? 'node:sqlite 미지원' : false }, async () => {
  assert.ok(await vt.getDb());
  const mk = (vmId, name, powerState) => ({ vmId, name, cluster: 'C', host: 'h', datastore: 'ds', powerState, cpu: 1, memMB: 1024, storageGB: 10, guestOS: 'x' });
  // 1차(기준선, 100일 전): a 켜짐 · b 꺼짐(계속 꺼짐 → first_seen 하한)
  await vt.commitSnapshot({ slot: 'S1', ts: NOW - 100 * D, perVc: [{ vcenterId: 'vc1', total: 2, onCount: 1, added: [], removed: [], live: [mk('vc1:a', 'A', 'POWERED_ON'), mk('vc1:b', 'B', 'POWERED_OFF')], baseline: true }], totalRow: { total: 2, onCount: 1, added: 0, removed: 0, baseline: true } });
  // 2차(20일 전): a 가 꺼짐(전환 관측)
  await vt.commitSnapshot({ slot: 'S2', ts: NOW - 20 * D, perVc: [{ vcenterId: 'vc1', total: 2, onCount: 0, added: [], removed: [], poweredOff: [mk('vc1:a', 'A', 'POWERED_OFF')], live: [mk('vc1:a', 'A', 'POWERED_OFF'), mk('vc1:b', 'B', 'POWERED_OFF')] }], totalRow: { total: 2, onCount: 0, added: 0, removed: 0, poweredOff: 1 } });
  const pc = await vt.loadPowerChanges('vc1');
  assert.equal(pc.get('vc1:a').offTs, NOW - 20 * D);
  const fs1 = await vt.loadRosterFirstSeen('vc1');
  assert.equal(fs1.get('vc1:b').firstSeen, NOW - 100 * D, 'first_seen 은 upsert 로 갱신되지 않는다');
  // logs: A 의 정확한 전원 이벤트(전환 슬롯 6시간 전에 꺼짐) — 추적 전환이 직후 슬롯이므로 이벤트가 채택돼야 한다
  const db = await logs.getLogsDb();
  db.insertMany([
    { vcenterId: 'vc1', key: 'e1', ts: NOW - 20 * D - 6 * H, severity: 'info', type: 'VmPoweredOffEvent', user: 'u', entity: 'A', message: 'A is powered off' },
    { vcenterId: 'vc1', key: 'e0', ts: NOW - 50 * D, severity: 'info', type: 'VmPoweredOnEvent', user: 'u', entity: 'A', message: 'A is powered on' },
    { vcenterId: 'vc1', key: 'e2', ts: NOW - 1 * D, severity: 'info', type: 'UserLoginSessionEvent', user: 'u', entity: 'A', message: 'noise' },
  ]);
  const ev = db.lastPowerEvents('vc1');
  assert.equal(ev.find((r) => r.entity === 'A' && r.type === 'VmPoweredOffEvent').ts, NOW - 20 * D - 6 * H);
  _resetPowerOffCache();
  const r = await poweredOffSinceFor([{ id: 'vc1:a', name: 'A', vcenterId: 'vc1' }, { id: 'vc1:b', name: 'B', vcenterId: 'vc1' }, { id: 'vc1:zz', name: 'ZZ', vcenterId: 'vc1' }], { now: NOW });
  const a = r.rows.find((x) => x.id === 'vc1:a'); const b = r.rows.find((x) => x.id === 'vc1:b'); const z = r.rows.find((x) => x.id === 'vc1:zz');
  assert.equal(a.source, 'event'); assert.equal(a.exact, true); assert.equal(a.offDays, 20);
  assert.equal(b.source, 'first_seen'); assert.equal(b.offDays, 100);
  assert.equal(z.offDays, undefined, '출처 없는 VM 은 값을 만들지 않는다');
  assert.equal(r.sources.events, true); assert.equal(r.sources.track, true);
});
