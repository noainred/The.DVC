import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTrafficCapture } from '../src/net/tcpdump.js';

// 감사 L1 회귀 방지 — peer/iface의 선행 '-'(tcpdump 플래그 주입)가 SSH 실행 전에 거부되는지.
test('tcpdump: peer 선행 - (플래그 주입) 거부', async () => {
  await assert.rejects(() => runTrafficCapture({ hostA: { host: 'x', username: 'root' }, peer: '-w/tmp/x' }), /형식이 올바르지 않습니다/);
  await assert.rejects(() => runTrafficCapture({ hostA: { host: 'x', username: 'root' }, peer: '-c5' }), /형식이 올바르지 않습니다/);
});

test('tcpdump: iface 선행 - 거부', async () => {
  await assert.rejects(() => runTrafficCapture({ hostA: { host: 'x', username: 'root' }, peer: '10.0.0.1', iface: '-i' }), /인터페이스명/);
});
