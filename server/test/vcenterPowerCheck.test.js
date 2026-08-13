import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePowerSensorWatts } from '../src/vcenter/soapClient.js';

// (v2.292) vcenterPowerCheck 테스트 제거 — 그 함수가 죽은 코드(라우트/화면 소비자 0, 화면
// 단순화 v2.69.1 이후 잔존)로 확인되어 idrac/service.js 에서 삭제됐다(2차 모듈화 감사).
// 이 파일은 살아있는 수집 경로인 parsePowerSensorWatts(하드웨어 상태 IPMI 'Pwr Consumption'
// 센서 → host.vcPowerWatts, vcenter/soapClient.js) 검증만 남긴다 — 파일명은 이력 유지를 위해
// 그대로 둔다(git log 추적성).

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
