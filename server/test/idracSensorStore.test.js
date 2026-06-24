import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushSensorSample, getSensorSeries, clearSensorSeries } from '../src/idrac/sensorStore.js';

test('센서 시계열: 샘플 적재 + 최신/센서 목록', () => {
  clearSensorSeries('srv1');
  pushSensorSample('srv1', { t: 1000, cpuUsagePct: 30, temps: [{ name: 'CPU1 Temp', celsius: 45 }, { name: 'Inlet Temp', celsius: 22 }] });
  pushSensorSample('srv1', { t: 2000, cpuUsagePct: 55, temps: [{ name: 'CPU1 Temp', celsius: 50 }, { name: 'Inlet Temp', celsius: 23 }] });
  const s = getSensorSeries('srv1');
  assert.equal(s.samples.length, 2);
  assert.equal(s.latest.cpu, 55);
  assert.equal(s.latest.temps['CPU1 Temp'], 50);
  assert.deepEqual(s.sensors, ['CPU1 Temp', 'Inlet Temp']);
});

test('센서 시계열: minutes로 최근 구간만 필터', () => {
  clearSensorSeries('srv2');
  const now = Date.now();
  pushSensorSample('srv2', { t: now - 200 * 60_000, cpuUsagePct: 10, temps: [] }); // 200분 전
  pushSensorSample('srv2', { t: now - 1 * 60_000, cpuUsagePct: 20, temps: [] });    // 1분 전
  const recent = getSensorSeries('srv2', { minutes: 60 });
  assert.equal(recent.samples.length, 1);
  assert.equal(recent.samples[0].cpu, 20);
});

test('센서 시계열: 비숫자 CPU는 null로 저장', () => {
  clearSensorSeries('srv3');
  pushSensorSample('srv3', { t: 1, cpuUsagePct: null, temps: [{ name: 'Inlet', celsius: 20 }] });
  assert.equal(getSensorSeries('srv3').latest.cpu, null);
});
