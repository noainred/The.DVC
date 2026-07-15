import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nicPortSpeedMbps } from '../src/idrac/redfish.js';

test('nicPortSpeedMbps: 다운 포트(current=0)도 정격(SupportedLinkCapabilities)으로 10G 식별', () => {
  // 과거 버그 재현 방지 — current=0이 정격 폴백을 단락시키던 케이스.
  assert.equal(nicPortSpeedMbps({ CurrentLinkSpeedMbps: 0, SupportedLinkCapabilities: [{ LinkSpeedMbps: 10000 }] }), 10000);
  assert.equal(nicPortSpeedMbps({ LinkStatus: 'Down', SupportedLinkCapabilities: [{ LinkSpeedMbps: 25000 }] }), 25000);
});

test('nicPortSpeedMbps: 정격 배열 중 최고값 사용', () => {
  assert.equal(nicPortSpeedMbps({ SupportedLinkCapabilities: [{ LinkSpeedMbps: 1000 }, { LinkSpeedMbps: 10000 }] }), 10000);
});

test('nicPortSpeedMbps: 신형 Ports 스키마(Gbps) 지원', () => {
  assert.equal(nicPortSpeedMbps({ MaxSpeedGbps: 100 }), 100000);
  assert.equal(nicPortSpeedMbps({ CurrentSpeedGbps: 25 }), 25000);
});

test('nicPortSpeedMbps: 정격 없으면 현재 링크속도(Mbps)', () => {
  assert.equal(nicPortSpeedMbps({ CurrentLinkSpeedMbps: 1000 }), 1000);
});

test('nicPortSpeedMbps: 속도 정보 전무면 null', () => {
  assert.equal(nicPortSpeedMbps({ CurrentLinkSpeedMbps: 0 }), null);
  assert.equal(nicPortSpeedMbps({}), null);
});
