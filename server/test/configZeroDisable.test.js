import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// "0=비활성" 계약: 주기 env를 0으로 두면 실제로 0이 되어야 한다(`Number(x)||d`는 0을 기본값으로
// 되살려 끄기를 불가능하게 만들던 버그). config는 import 시 env를 읽으므로 미리 세팅.
process.env.COLLECTOR_PULL_INTERVAL_MS = '0';
process.env.IDRAC_SCAN_INTERVAL_MS = '0';
delete process.env.EDGE_MODE; // 통합모드 아님(엣지 기본 override 배제)

let config;
before(async () => { ({ config } = await import('../src/config.js')); });

test('COLLECTOR_PULL_INTERVAL_MS=0 → 0(수집 puller 비활성 가능)', () => {
  assert.equal(config.collector.pullIntervalMs, 0);
});
test('IDRAC_SCAN_INTERVAL_MS=0 → 0(주기 스캔 비활성 가능)', () => {
  assert.equal(config.idrac.scanIntervalMs, 0);
});
test('미설정 env는 기본값(0 아님)', () => {
  assert.ok(config.collector.timeoutMs > 0); // COLLECTOR_TIMEOUT_MS 미설정 → 기본 20000
});
