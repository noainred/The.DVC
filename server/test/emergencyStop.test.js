import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'estop-'));
const { isStopped, getEmergencyStatus, setEmergencyStop } = await import('../src/security/emergencyStop.js');

test('긴급중단: 기본은 비활성', () => {
  assert.equal(isStopped(), false);
  assert.equal(getEmergencyStatus().active, false);
});

test('긴급중단: 켜면 isStopped=true + 승인자 기록', () => {
  const s = setEmergencyStop(true, ['admin1', 'admin2']);
  assert.equal(s.active, true);
  assert.deepEqual(s.by, ['admin1', 'admin2']);
  assert.equal(isStopped(), true);
});

test('긴급중단: 해제하면 비활성 + 승인자 비움', () => {
  const s = setEmergencyStop(false, ['admin1', 'admin2']);
  assert.equal(s.active, false);
  assert.deepEqual(s.by, []);
  assert.equal(isStopped(), false);
});

test('긴급중단: 상태가 파일에 영속화된다', () => {
  setEmergencyStop(true, ['a', 'b']);
  const file = path.join(process.env.CONFIG_DIR, 'emergency-stop.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.active, true);
});
