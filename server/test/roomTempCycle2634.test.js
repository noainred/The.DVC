// v2.634 — 법인 전산실 운영 온도가 '측정 서버 0/980 · 미갱신 975' 로 통째로 빈 결함(2026-09-28 사용자 신고).
// 원인 두 겹: ① iDRAC 폴러가 표본 시각을 **주기 시작 시각** 하나로 찍었다 ② 신선도 경계(15분)가 한 주기가
// 얼마나 걸리는지를 몰랐다. 주기가 15분을 넘는 현장(대상이 많거나 불통 iDRAC 이 많다)에서는 정상 서버가
// 전부 '미갱신' 으로 빠졌다. 이 테스트가 두 수정과 '주기 정보가 없으면 예전 경계' 를 함께 고정한다.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  roomTempReport, effectiveMaxAgeMs, sampleMaxAgeMs, cycleOfSample, DEFAULT_MAX_AGE_MS, STALE_CYCLE_CAP_MS,
} from '../src/idrac/roomTemp.js';
import {
  sensorPollCycle, setSensorPollCycle, markSensorPollStart, _resetSensorPollCycleForTest,
} from '../src/idrac/sensorStore.js';
import { sampleStaleReason, buildServerTempRows } from '../src/idrac/serverTempSeries.js';
import { buildServerTempReport } from '../src/tools/serverTemp.js';
import { sanitizeRemoteSensors } from '../src/collector/remoteInventory.js';
import { stripComments } from './_stripComments.js';

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const temps = { 'System Board Inlet Temp': 22, 'System Board Exhaust Temp': 35, 'CPU1 Temp': 55 };
const remote = (id, ageMin, extra = {}) => ({
  id, name: id, datacenterId: 'dc1', remote: true, sensors: { t: NOW - ageMin * MIN, temps, ...extra },
});

beforeEach(() => _resetSensorPollCycleForTest());

test('① effectiveMaxAgeMs: 2D + I 로 넓히되 기본값 아래로 줄이지 않고 상한을 넘기지 않는다', () => {
  const base = 15 * MIN;
  assert.equal(effectiveMaxAgeMs(base, null), base, '주기 정보가 없으면 기본 경계(추측으로 넓히지 않는다)');
  assert.equal(effectiveMaxAgeMs(base, { durationMs: 1 * MIN, intervalMs: MIN }), base, '짧은 주기는 기본 경계 그대로');
  assert.equal(effectiveMaxAgeMs(base, { durationMs: 20 * MIN, intervalMs: MIN }), 41 * MIN);
  assert.equal(effectiveMaxAgeMs(base, { durationMs: 10 * 3600_000, intervalMs: MIN }), STALE_CYCLE_CAP_MS, '상한');
  assert.equal(effectiveMaxAgeMs(0, { durationMs: 20 * MIN, intervalMs: MIN }), 0, '0 = 호출부가 검사를 끈 것');
  assert.equal(effectiveMaxAgeMs(base, { durationMs: null, intervalMs: null }), base);
  assert.equal(effectiveMaxAgeMs(base, { durationMs: 'x', intervalMs: -5 }), base, '숫자가 아닌 값은 무시');
});

test('② cycleOfSample: 원격 표본에는 중앙 폴러 주기를 쓰지 않는다 — 엣지가 보낸 주기만', () => {
  const local = { durationMs: 30 * MIN, intervalMs: MIN };
  assert.equal(cycleOfSample({ t: 1 }, { remote: true, localCycle: local }), null, '구버전 엣지(필드 없음)는 null');
  assert.deepEqual(cycleOfSample({ t: 1, cycleMs: 20 * MIN, intervalMs: MIN }, { remote: true, localCycle: local }), { durationMs: 20 * MIN, intervalMs: MIN });
  assert.equal(cycleOfSample({ t: 1 }, { remote: false, localCycle: local }), local);
  assert.equal(sampleMaxAgeMs(DEFAULT_MAX_AGE_MS, { t: 1 }, { remote: true, localCycle: local }), DEFAULT_MAX_AGE_MS);
});

test('③ roomTempReport: 주기가 20분 걸리는 현장에서 25분 된 로컬 표본은 집계된다(예전엔 전부 미갱신)', () => {
  const servers = [{ id: 'a', name: 'a', datacenterId: 'dc1' }];
  // 로컬 표본은 sensorStore 에서 온다 — 여기서는 원격 모양으로 같은 판정을 본다(주기 정보를 엣지가 싣는 경우).
  const edge20 = remote('e1', 25, { cycleMs: 20 * MIN, intervalMs: MIN });
  const edgeOld = remote('e2', 25);                // 구버전 엣지 — 기본 경계 15분 → 빠진다
  const r = roomTempReport([edge20, edgeOld, ...servers], { now: NOW, localCycle: null });
  assert.equal(r.totals.withData, 1, '주기를 보낸 엣지 표본은 집계');
  assert.equal(r.totals.stale, 1, '구버전 엣지 표본은 기본 경계로 빠진다');
  assert.equal(r.staleMsMax, 41 * MIN, '실제로 쓴 가장 넓은 경계를 밝힌다');
  assert.equal(r.staleWidened, 1);
  assert.equal(r.totals.staleNewestAgeMs, 25 * MIN);
  assert.equal(r.totals.staleOldestAgeMs, 25 * MIN);
});

test('④ roomTempReport: 경계를 넓혀도 죽은 서버(상한 넘음)는 여전히 빠진다 + 나이 분포', () => {
  const r = roomTempReport([
    remote('dead', 5 * 60, { cycleMs: 20 * MIN, intervalMs: MIN }),
    remote('late', 50, { cycleMs: 20 * MIN, intervalMs: MIN }),
    { id: 'nots', name: 'nots', datacenterId: 'dc1', remote: true, sensors: { t: null, temps } },
  ], { now: NOW, localCycle: null });
  assert.equal(r.totals.withData, 0);
  assert.equal(r.totals.stale, 3);
  assert.equal(r.totals.staleNewestAgeMs, 50 * MIN);
  assert.equal(r.totals.staleOldestAgeMs, 5 * 60 * MIN);
  assert.equal(r.totals.staleNoTimestamp, 1, '시각 없는 표본은 나이 분포에 넣지 않고 따로 센다(0 = 1970 이 되지 않게)');
});

test('⑤ roomTempReport: 로컬 서버는 중앙 폴러 주기를 쓴다(localCycle 기본값 = sensorPollCycle)', () => {
  setSensorPollCycle({ durationMs: 20 * MIN, intervalMs: MIN, at: NOW });
  const r = roomTempReport([], { now: NOW });
  assert.equal(r.pollCycle.durationMs, 20 * MIN);
  assert.equal(r.pollCycle.intervalMs, MIN);
  _resetSensorPollCycleForTest();
  assert.equal(roomTempReport([], { now: NOW }).pollCycle, null, '폴러가 돌지 않았으면 null');
});

test('⑥ sensorPollCycle: 지금 도는 주기가 더 오래 걸리면 그 경과를 소요로 본다', () => {
  setSensorPollCycle({ durationMs: 5 * MIN, intervalMs: MIN, at: NOW - 40 * MIN });
  markSensorPollStart(NOW - 30 * MIN);
  const c = sensorPollCycle(NOW);
  assert.equal(c.durationMs, 30 * MIN);
  assert.equal(c.lastDurationMs, 5 * MIN);
  assert.equal(c.runningForMs, 30 * MIN);
  setSensorPollCycle({ durationMs: 31 * MIN, intervalMs: MIN, at: NOW });
  assert.equal(sensorPollCycle(NOW).runningForMs, null, '끝났으면 진행 중이 아니다');
});

test('⑦ 서버 온도 시계열·서버 온도 화면도 같은 경계를 쓴다(판정이 갈라지지 않게)', () => {
  const lat = { t: NOW - 25 * MIN, temps, cycleMs: 20 * MIN, intervalMs: MIN };
  assert.equal(sampleStaleReason(lat, { now: NOW, remote: true }), null);
  assert.equal(sampleStaleReason({ t: NOW - 25 * MIN, temps }, { now: NOW, remote: true }), 'stale');
  assert.equal(sampleStaleReason({ t: null, temps }, { now: NOW }), 'no-timestamp', 't=null 은 0(1970) 이 아니라 시각 없음');
  const rows = buildServerTempRows([{ id: 'x', remote: true, sensors: lat }], { now: NOW, localCycle: null });
  assert.equal(rows.servers, 1);
  const rep = buildServerTempReport({
    idracServers: [{ id: 'x', remote: true, sensors: lat }], latestOf: (s) => s.sensors, now: NOW, maxAgeMs: DEFAULT_MAX_AGE_MS,
  });
  assert.equal(rep.rows[0].stale, false);
  const rep2 = buildServerTempReport({
    idracServers: [{ id: 'y', sensors: { t: NOW - 25 * MIN, temps } }], latestOf: (s) => s.sensors, now: NOW,
    maxAgeMs: DEFAULT_MAX_AGE_MS, localCycle: { durationMs: 20 * MIN, intervalMs: MIN },
  });
  assert.equal(rep2.rows[0].stale, false, '로컬 서버는 localCycle 로 넓힌다');
});

test('⑧ 중앙 수신 정제: 엣지 주기는 숫자·범위 안일 때만 싣는다', () => {
  assert.deepEqual(sanitizeRemoteSensors({ t: 5, temps: { a: 1 }, cycleMs: 1200000, intervalMs: 60000 }), { t: 5, temps: { a: 1 }, cycleMs: 1200000, intervalMs: 60000 });
  const bad = sanitizeRemoteSensors({ t: 5, temps: { a: 1 }, cycleMs: -1, intervalMs: 'abc' });
  assert.equal(bad.cycleMs, undefined);
  assert.equal(bad.intervalMs, undefined);
  assert.equal(sanitizeRemoteSensors({ t: 5, temps: { a: 1 }, cycleMs: 1e15 }).cycleMs, undefined, '상한(7일) 밖');
  assert.equal(sanitizeRemoteSensors({ t: 5, temps: { a: 1 }, cycleMs: {} }).cycleMs, undefined);
});

test('⑨ 폴러: 표본 시각은 주기 시작 시각(ts)이 아니라 그 서버를 실제로 읽은 시각이다', () => {
  const src = stripComments(fs.readFileSync(new URL('../src/idrac/poller.js', import.meta.url), 'utf8'));
  assert.match(src, /pushSensorSample\(s\.id,\s*\{\s*t:\s*sensorAt/, '센서 표본은 sensorAt');
  assert.doesNotMatch(src, /pushSensorSample\([^)]*\bt:\s*ts\b/, '주기 시작 시각으로 찍지 않는다');
  assert.doesNotMatch(src, /samples\.push\(\{[^}]*,\s*ts\s*\}\)/, '전력 표본도 주기 시작 시각 단축표기 금지');
  assert.match(src, /const sensorAt = Date\.now\(\);/);
  assert.match(src, /const powerAt = Date\.now\(\);/);
  assert.match(src, /setSensorPollCycle\(\{ durationMs, intervalMs/, '주기 소요를 판정 쪽에 알린다');
  assert.match(src, /markSensorPollStart\(ts\)/);
});

test('⑩ 엣지 export 가 주기 정보를 싣는다', () => {
  const src = stripComments(fs.readFileSync(new URL('../src/collector/agent.js', import.meta.url), 'utf8'));
  assert.match(src, /cycleMs:\s*Math\.round\(cyc\.durationMs\)/);
});

test('⑪ 다빈치 서비스 점검에 iDRAC 폴 주기 행이 있다(배너가 가리키는 행)', async () => {
  const { getServiceCheck } = await import('../src/health/services.js');
  const r = await getServiceCheck({ isAdmin: true });
  const rows = Array.isArray(r) ? r : (r.checks || r.items || []);
  const row = rows.find((x) => x.key === 'idrac-cycle' || x.id === 'idrac-cycle');
  assert.ok(row, 'idrac-cycle 행');
  assert.match(String(row.label || row.name), /iDRAC 폴 주기/);
});
