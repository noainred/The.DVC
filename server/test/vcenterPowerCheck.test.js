import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vcenterPowerCheck } from '../src/idrac/service.js';
import { parsePowerSensorWatts } from '../src/vcenter/soapClient.js';

const sensor = (name, reading, type = 'power', base = 'Watts', mod = 0) =>
  `<HostNumericSensorInfo><name>${name}</name><currentReading>${reading}</currentReading>` +
  `<unitModifier>${mod}</unitModifier><baseUnits>${base}</baseUnits><sensorType>${type}</sensorType></HostNumericSensorInfo>`;

test('parsePowerSensorWatts: 하드웨어 상태 Pwr Consumption 센서에서 와트 파싱', () => {
  // 사용자 화면: "System Board 1 Pwr Consumption = 624 와트"
  const xml = sensor('System Board 1 Inlet Temp', 21, 'temperature', 'Degrees C') +
    sensor('Power Supply 1 Voltage', 216, 'voltage', 'Volts') +
    sensor('System Board 1 Pwr Consumption', 624, 'power', 'Watts');
  assert.equal(parsePowerSensorWatts(xml), 624);
});

test('parsePowerSensorWatts: 전압 센서는 제외, 전력 센서 없으면 null', () => {
  assert.equal(parsePowerSensorWatts(sensor('PS1 Voltage', 220, 'voltage', 'Volts')), null);
  assert.equal(parsePowerSensorWatts(''), null);
  assert.equal(parsePowerSensorWatts(null), null);
});

test('parsePowerSensorWatts: consumption 없으면 PSU input 합', () => {
  const xml = sensor('PS1 Input Power', 300, 'power', 'Watts') + sensor('PS2 Input Power', 280, 'power', 'Watts');
  assert.equal(parsePowerSensorWatts(xml), 580);
});

test('vcenterPowerCheck: vCenter별 수집/0W/미수집 집계', () => {
  const snap = {
    vcenters: [{ id: 'OC2', name: 'OC2' }, { id: 'WA', name: 'WA' }, { id: 'SB', name: 'Sandbox' }],
    hosts: [
      { vcenterId: 'OC2', vcPowerWatts: 624 },  // 수집됨
      { vcenterId: 'OC2', vcPowerWatts: 500 },  // 수집됨
      { vcenterId: 'WA', vcPowerWatts: 0 },     // 센서 0W
      { vcenterId: 'SB' },                      // vcPowerWatts undefined → 미수집
    ],
  };
  const r = vcenterPowerCheck(snap);
  const oc2 = r.rows.find((x) => x.vcenterId === 'OC2');
  const wa = r.rows.find((x) => x.vcenterId === 'WA');
  const sb = r.rows.find((x) => x.vcenterId === 'SB');
  assert.equal(oc2.state, 'collecting');
  assert.equal(oc2.reporting, 2);
  assert.equal(oc2.watts, 1124);
  assert.equal(wa.state, 'zero');
  assert.equal(sb.state, 'nodata');
  assert.equal(r.totals.reporting, 2);
  assert.equal(r.totals.watts, 1124);
});
