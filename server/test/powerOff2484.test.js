// v2.484 — 전원 꺼짐 점검: 설정(범위·영속) + 관측 적재(구간 시작 유지·해제) + 판정에 '점검' 출처 반영.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poweroff2-'));
process.env.CONFIG_DIR = tmp;
process.env.VMTRACK_DB_PATH = path.join(tmp, 'vm-track.db');
const sqliteOk = await import('node:sqlite').then(() => true).catch(() => false);
const S = await import('../src/tools/powerOffSettings.js');
const { resolveOffSince } = await import('../src/tools/powerOff.js');
const vt = await import('../src/vmtrack/db.js');

const H = 3_600_000; const D = 24 * H;
const NOW = Date.parse('2026-09-12T00:00:00Z');

test('설정 — 기본 켜짐 6시간, 범위 1~168 로 제한, 파일에 영속', () => {
  const d = S.loadPowerOffSettings();
  assert.deepEqual(d, { enabled: true, intervalHours: 6 });
  const r = S.savePowerOffSettings({ enabled: false, intervalHours: 1000 });
  assert.equal(r.intervalHours, 168); assert.equal(r.enabled, false);
  assert.equal(S.savePowerOffSettings({ intervalHours: 0.4 }).intervalHours, 1);
  assert.equal(S.savePowerOffSettings({ intervalHours: 'x' }).intervalHours, 1, '숫자 아니면 유지');
  S._resetPowerOffSettingsCache();
  assert.deepEqual(S.loadPowerOffSettings(), { enabled: false, intervalHours: 1 });
  assert.ok(fs.existsSync(path.join(tmp, 'power-off-check.json')));
});

test('판정 — 점검(6h) 관측이 추적(12h)보다 촘촘하면 점검을, 이벤트가 있고 한 간격 안이면 이벤트를', () => {
  const r1 = resolveOffSince({ observed: { offSince: NOW - 5 * D }, observedGranMs: 6 * H, track: { offTs: NOW - 5 * D + 8 * H, onTs: 0 }, now: NOW });
  assert.equal(r1.source, 'observed'); assert.equal(r1.granHours, 6); assert.equal(r1.offDays, 5);
  const r2 = resolveOffSince({ event: { offTs: NOW - 5 * D - 2 * H, onTs: 0 }, observed: { offSince: NOW - 5 * D }, observedGranMs: 6 * H, now: NOW });
  assert.equal(r2.source, 'event'); assert.equal(r2.exact, true);
  // 점검이 이벤트보다 한 간격(6h+1h) 넘게 늦으면 이벤트가 낡음 → 점검
  const r3 = resolveOffSince({ event: { offTs: NOW - 30 * D, onTs: 0 }, observed: { offSince: NOW - 2 * D }, observedGranMs: 6 * H, now: NOW });
  assert.equal(r3.source, 'observed'); assert.equal(r3.offDays, 2);
  // 점검 주기가 24h 면 추적(12h)이 더 촘촘 → 추적
  const r4 = resolveOffSince({ observed: { offSince: NOW - 3 * D }, observedGranMs: 24 * H, track: { offTs: NOW - 3 * D + 6 * H, onTs: 0 }, now: NOW });
  assert.equal(r4.source, 'track');
});

test('DB — 관측 적재: 구간 시작 유지, 계속 꺼짐은 last_seen 만, 켜지면 해제 후 다시 꺼지면 새 구간', { skip: !sqliteOk ? 'node:sqlite 미지원' : false }, async () => {
  assert.ok(await vt.getDb());
  let r = await vt.commitPowerOffObservation({ ts: NOW - 3 * D, perVc: [{ vcenterId: 'vc1', offVms: [{ vmId: 'vc1:a', name: 'A' }, { vmId: 'vc1:b', name: 'B' }] }] });
  assert.deepEqual([r.offVms, r.inserted, r.deleted], [2, 2, 0]);
  r = await vt.commitPowerOffObservation({ ts: NOW - 2 * D, perVc: [{ vcenterId: 'vc1', offVms: [{ vmId: 'vc1:a', name: 'A' }] }] }); // b 켜짐
  assert.deepEqual([r.offVms, r.inserted, r.deleted], [1, 0, 1]);
  let m = await vt.loadOffSeen('vc1');
  assert.equal(m.get('vc1:a').offSince, NOW - 3 * D, 'off_since 유지'); assert.equal(m.get('vc1:a').lastSeen, NOW - 2 * D);
  assert.equal(m.has('vc1:b'), false);
  r = await vt.commitPowerOffObservation({ ts: NOW - 1 * D, perVc: [{ vcenterId: 'vc1', offVms: [{ vmId: 'vc1:a', name: 'A' }, { vmId: 'vc1:b', name: 'B' }] }] }); // b 다시 꺼짐
  m = await vt.loadOffSeen('vc1');
  assert.equal(m.get('vc1:b').offSince, NOW - 1 * D, '새 구간');
  assert.equal(await vt.lastPowerOffObservationTs(), NOW - 1 * D);
});
