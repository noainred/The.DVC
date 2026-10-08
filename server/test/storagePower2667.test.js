// v2.667 — 스토리지 소비 전력 수집(전 타입) + 합산의 '못 읽음' 사유. 사용자 요청 "모든 스토리지의 수집하는 파싱값에서
//   소비전력 추가로 수집해서 처리하는 로직 추가해줘". ⚠ Unity SSH 외 필드 이름은 실장비 미확인 — 판정 규칙만 고정한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wattsOf, powerKeyKind, scanPower, pickPower, applyScannedPower, powerPathOf, methodOf, PROBE_REASONS } from '../src/storage/power.js';
import { applyUnityPower } from '../src/storage/collectors/unity.js';
import { applyUnitySshPower } from '../src/storage/collectors/unitySsh.js';
import { applyPowerstorePower } from '../src/storage/collectors/powerstore.js';
import { applyXtremioPower } from '../src/storage/collectors/xtremio.js';
import { applyPowermaxPower } from '../src/storage/collectors/powermax.js';
import { pickIsiPowerKey, isiPowerFromStats, keyNamesOfText } from '../src/storage/collectors/isilonPower.js';
import { readIsiPowerSsh } from '../src/storage/collectors/isilonSsh.js';
import { _resetIsiPowerCache } from '../src/storage/collectors/isilonPower.js';
import { buildPowerTotal } from '../src/power/total.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * 60_000;

test('① 값 해석 — 숫자·W·kW 는 전력, 퍼센트·kWh·전압·음수는 아니다', () => {
  assert.equal(wattsOf(330), 330);
  assert.equal(wattsOf('330 Watts'), 330);
  assert.equal(wattsOf('0.5 kW'), 500);
  for (const v of ['45%', '12 kWh', '230 V', -5, '', null, 'OK', 2e6]) assert.equal(wattsOf(v), null, String(v));
});

test('② 이름 판정 — 현재 전력만 · 평균·최대·정격·상태는 제외', () => {
  assert.equal(powerKeyKind('currentPower'), 'system');
  assert.equal(powerKeyKind('power_consumption'), 'system');
  assert.equal(powerKeyKind('input_power'), 'part');
  assert.equal(powerKeyKind('output-watts'), 'output');
  for (const k of ['avgPower', 'maxPower', 'power_state', 'power_supply_type', 'rated_power', 'power_percent', 'powerSupplies']) assert.equal(powerKeyKind(k), null, k);
});

test('③ 합산 — 시스템 합계가 있으면 부품을 더하지 않는다(이중 계수 금지) · 없으면 부품 입력 합', () => {
  const both = scanPower({ currentPower: 800, psus: [{ inputPower: 400 }, { inputPower: 390 }] });
  assert.deepEqual(pickPower(both.hits), { watts: 800, basis: 'system', parts: 1, keys: ['currentPower'] });
  const parts = scanPower([{ extra: { input_power: '410 W' } }, { extra: { input_power: 405 } }]);
  assert.equal(pickPower(parts.hits).watts, 815);
  assert.equal(pickPower(parts.hits).basis, 'input');
  assert.equal(pickPower(scanPower({ a: 1 }).hits), null);
});

test('④ 못 읽으면 0 W 가 아니라 사유 + 응답에 있던 키', () => {
  const ex = {};
  assert.equal(applyScannedPower(ex, [{ name: 'PSU-A', state: 'Healthy' }], { source: 's' }), false);
  assert.equal(ex.power, undefined);
  assert.equal(ex.powerProbe.reason, 'no-field');
  assert.deepEqual(ex.powerProbe.seenKeys, ['name', 'state']);
  assert.ok(PROBE_REASONS.includes('skipped'));
});

test('⑤ Unity REST — currentPower · 필드 없음 · 요청 실패를 가른다', () => {
  const a = {}; applyUnityPower(a, { power: { entries: [{ content: { currentPower: 612 } }] } });
  assert.equal(a.power.watts, 612); assert.equal(a.power.scope, 'system');
  const b = {}; applyUnityPower(b, { power: { entries: [{ content: { id: '0' } }] } });
  assert.equal(b.powerProbe.reason, 'no-field');
  const c = {}; applyUnityPower(c, { powerErr: 'HTTP 422' });
  assert.equal(c.powerProbe.reason, 'request-failed');
  const d = {}; applyUnityPower(d, {}); assert.deepEqual(d, {}, '조회 전 중단은 시도하지 않은 것');
});

test('⑥ Unity SSH — 요약 구획 · FRU 상태줄 대체 · 예산 건너뜀', () => {
  const full = fs.readFileSync(path.join(here, 'fixtures/spinfo-sample.txt'), 'utf8');
  const a = {}; applyUnitySshPower(a, { out: { power: full } });
  assert.equal(a.power.scope, 'dpe'); assert.ok(a.power.watts > 0);
  const cut = full.slice(0, full.indexOf('Summary of power supply info:'));
  const b = {}; applyUnitySshPower(b, { out: { power: cut } });
  assert.equal(b.power.watts, 330 + 325, 'ps0: OK 330 · ps0: OK 325 합');
  assert.match(b.power.source, /FRU 상태줄/);
  const c = {}; applyUnitySshPower(c, { out: {}, skipped: ['power'] });
  assert.equal(c.powerProbe.reason, 'skipped');
  const d = {}; applyUnitySshPower(d, { out: {}, errors: { power: '시한 초과' } });
  assert.equal(d.powerProbe.reason, 'request-failed');
});

test('⑦ PowerStore·XtremIO·PowerMax — 부품 합 · 0개 · 응답 키', () => {
  const p = {}; applyPowerstorePower(p, { psus: [{ extra_details: { input_power: 350 } }, { extra_details: { input_power: 340 } }] });
  assert.equal(p.power.watts, 690); assert.equal(p.power.scope, 'psu');
  const p0 = {}; applyPowerstorePower(p0, { psus: [] }); assert.equal(p0.powerProbe.reason, 'no-field');
  const x = {}; applyXtremioPower(x, { psus: { 'storage-controller-psus': [{ name: 'X1-SC1-PSU-L', 'input-power': 210 }] } });
  assert.equal(x.power.watts, 210);
  const m = {}; applyPowermaxPower(m, { arrays: [{ symmetrixId: '1' }], powerHits: [], powerSeen: ['symmetrixId', 'model'] });
  assert.equal(m.powerProbe.reason, 'no-field'); assert.deepEqual(m.powerProbe.seenKeys, ['symmetrixId', 'model']);
  const m2 = {}; applyPowermaxPower(m2, { arrays: [] }); assert.deepEqual(m2, {}, '어레이를 못 읽으면 전원 사유를 만들지 않는다(수집 실패가 말한다)');
});

test('⑧ Isilon — 키 탐색은 셸 안전 문자만 · 노드 합(클러스터 행과 더하지 않음) · items 배열', () => {
  const k = pickIsiPowerKey(['node.sensor.power.items', 'node.power.consumption', 'node.power.status', 'x;rm -rf /.power', 'node.power.max']);
  assert.equal(k.key, 'node.power.consumption');
  assert.ok(!k.seen.some((s) => /[;\s/]/.test(s)), '셸 문자가 있는 키는 버린다');
  assert.equal(pickIsiPowerKey(['ifs.bytes.total']).key, null);
  const st = { stats: [
    { key: 'node.power.consumption', devid: 0, value: 9999 },
    { key: 'node.power.consumption', devid: 1, value: 400 },
    { key: 'node.power.consumption', devid: 2, value: [{ desc: 'PS1', value: 210 }, { desc: 'PS2', value: 200 }] },
  ] };
  assert.deepEqual(isiPowerFromStats(st, 'node.power.consumption'), { watts: 810, nodes: 2, parts: 3 });
  assert.equal(isiPowerFromStats({ stats: [{ key: 'node.power.consumption', devid: 0, value: 700 }] }, 'node.power.consumption').watts, 700);
  assert.deepEqual(keyNamesOfText('node.power.consumption   Power consumed\nnode.sensor.power.items  x\n'), ['node.power.consumption', 'node.sensor.power.items']);
});

test('⑨ Isilon SSH — 키 탐색 1회(캐시) · 값 없음이면 사유', async () => {
  _resetIsiPowerCache();
  const calls = [];
  const sh = { exec: async (cmd) => { calls.push(cmd); if (/list keys/.test(cmd)) return { stdout: 'node.power.consumption  W\n' }; return { stdout: JSON.stringify([{ node: 1, 'node.power.consumption': 350 }, { node: 2, 'node.power.consumption': 360 }]) }; } };
  const r1 = await readIsiPowerSsh(sh, 'h1');
  assert.equal(r1.power.watts, 710); assert.equal(r1.power.scope, 'node');
  await readIsiPowerSsh(sh, 'h1');
  assert.equal(calls.filter((c) => /list keys/.test(c)).length, 1, '키 목록은 캐시');
  const sh2 = { exec: async () => ({ stdout: '' }) };
  _resetIsiPowerCache();
  assert.equal((await readIsiPowerSsh(sh2, 'h2')).probe.reason, 'no-field');
});

test('⑩ 합산 — 경로 표 · 못 읽음 사유별 · 경로 없음 사유별 · 세부 목록', () => {
  assert.equal(methodOf({ type: 'isilon' }), 'ssh', 'Isilon 기본은 SSH');
  assert.ok(powerPathOf({ type: 'isilon' }));
  assert.equal(powerPathOf({ type: 'vplex' }), null);
  assert.equal(powerPathOf({ type: 'powerstore', collectMethod: 'ssh' }), null);
  const r = buildPowerTotal({
    now: NOW,
    storage: [
      { id: 'a', type: 'powerstore', snap: { ok: true, extra: { power: { watts: 700, at: NOW, source: 'PowerStore', scope: 'psu' } } } },
      { id: 'b', type: 'powermax', snap: { ok: true, extra: { powerProbe: { tried: true, reason: 'no-field', source: 's', seenKeys: ['model'] } } } },
      { id: 'c', type: 'isilon', snap: { ok: false } },
      { id: 'd', type: 'unity480', collectMethod: 'ssh', snap: { ok: true, extra: {} } },
      { id: 'e', type: 'xtremio' },
      { id: 'f', type: 'vplex', snap: { ok: true } },
      { id: 'g', type: 'xtremio', collectMethod: 'ssh', snap: { ok: true } },
    ],
  });
  const s = r.storage;
  assert.equal(s.watts, 700); assert.equal(s.measured, 1); assert.equal(s.unread, 4); assert.equal(s.unsupported, 2);
  assert.deepEqual(s.unreadBy, { 'no-field': 1, 'collect-failed': 1, 'not-reported': 1, 'no-snapshot': 1 });
  assert.equal(Object.values(s.unsupportedBy).reduce((a, b) => a + b, 0), 2);
  assert.equal(s.items[0].source, 'PowerStore');
  const b = s.issues.find((x) => x.id === 'b'); assert.deepEqual(b.seenKeys, ['model']);
  assert.equal(s.issues.length, 4, '경로 없는 장비는 목록이 아니라 개수로만');
});

// v2.727(감사 C-06): 시각이 둘 다 없는 장비는 '오래됨' 이 아니라 '시각 없음' 이다 — 합계 제외는 같고 사유만 다르다.
test('⑪ 합산 — 시각 없음(no-time)은 stale 과 다른 사유로 센다', () => {
  const r = buildPowerTotal({ now: NOW, storage: [
    { id: 'a', type: 'powerstore', snap: { ok: true, extra: { power: { watts: 700, source: 'PowerStore' } } } },                     // at·collectedAt 없음
    { id: 'b', type: 'powerstore', snap: { ok: true, collectedAt: NOW - 7 * 3_600_000, extra: { power: { watts: 700 } } } },     // 오래됨
  ] });
  assert.equal(r.storage.noTime, 1); assert.equal(r.storage.stale, 1); assert.equal(r.storage.measured, 0); assert.equal(r.storage.watts, 0);
  assert.deepEqual(r.storage.issues.map((x) => [x.id, x.reason]).sort(), [['a', 'no-time'], ['b', 'stale']]);
});
