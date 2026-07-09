import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpFailHint, netFailReason } from '../src/collector/upgradePush.js';

test('httpFailHint: 상태코드별 점검 힌트 분류', () => {
  assert.match(httpFailHint(403), /토큰\(COLLECTOR_TOKEN\) 불일치/);
  assert.match(httpFailHint(401), /토큰\(COLLECTOR_TOKEN\) 불일치/);
  assert.match(httpFailHint(404), /구버전|collector 비활성/);
  assert.match(httpFailHint(413), /번들이 너무 큽/);
  assert.equal(httpFailHint(500), ''); // 특정 힌트 없음
});

test('netFailReason: 네트워크 예외 메시지를 도달 실패 원인으로 분류', () => {
  assert.match(netFailReason('The operation was aborted due to timeout'), /시간초과|포트포워딩/);
  assert.match(netFailReason('connect ECONNREFUSED 10.0.0.9:4000'), /연결 거부/);
  assert.match(netFailReason('getaddrinfo ENOTFOUND edge.local'), /호스트 조회 실패/);
  assert.match(netFailReason('fetch failed'), /네트워크 도달 불가|NAT\/포트포워딩/);
  assert.match(netFailReason('self signed certificate'), /TLS 인증서/);
  // 미분류 메시지는 원문 유지.
  assert.equal(netFailReason('weird error xyz'), 'weird error xyz');
});
