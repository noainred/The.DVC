import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTcpdumpLine, analyzeCapture, compareDual } from '../src/net/tcpdump.js';

test('parseTcpdumpLine: SYN-ACK 라인 파싱', () => {
  const p = parseTcpdumpLine('1700000000.123456 IP 10.0.0.1.443 > 10.0.0.2.51234: Flags [S.], seq 1, ack 1, length 0');
  assert.equal(p.src, '10.0.0.1');
  assert.equal(p.sport, '443');
  assert.equal(p.dst, '10.0.0.2');
  assert.equal(p.dport, '51234');
  assert.equal(p.flags, 'S.');
  assert.equal(p.len, 0);
});

test('parseTcpdumpLine: 비매칭 라인은 null', () => {
  assert.equal(parseTcpdumpLine('listening on any, link-type LINUX_SLL2'), null);
  assert.equal(parseTcpdumpLine(''), null);
});

test('analyzeCapture: SYN만 있고 SYN-ACK 없으면 핸드셰이크 미완료 에러', () => {
  const pkts = [
    { ts: 1, src: '10.0.0.9', sport: '50000', dst: '10.0.0.5', dport: '443', flags: 'S', len: 0 },
    { ts: 2, src: '10.0.0.9', sport: '50000', dst: '10.0.0.5', dport: '443', flags: 'S', len: 0 },
  ];
  const { stat, issues } = analyzeCapture(pkts, '10.0.0.5');
  assert.equal(stat.syn, 2);
  assert.equal(stat.synAck, 0);
  assert.ok(issues.some((i) => i.sev === 'error' && /SYN-ACK 없음/.test(i.title)));
});

test('analyzeCapture: 정상 핸드셰이크 → RTT 계산 + 특이사항 없음', () => {
  const peer = '10.0.0.5';
  const pkts = [
    { ts: 1.000, src: '10.0.0.9', sport: '5', dst: peer, dport: '443', flags: 'S', len: 0 },   // out SYN
    { ts: 1.050, src: peer, sport: '443', dst: '10.0.0.9', dport: '5', flags: 'S.', len: 0 },   // in SYN-ACK (50ms)
    { ts: 1.060, src: '10.0.0.9', sport: '5', dst: peer, dport: '443', flags: '.', len: 100 },
  ];
  const { stat, issues } = analyzeCapture(pkts, peer);
  assert.equal(stat.rttMs, 50);
  assert.equal(stat.toPeer.packets, 2);
  assert.equal(stat.fromPeer.packets, 1);
  assert.ok(issues.some((i) => i.sev === 'ok'));
});

test('analyzeCapture: 트래픽 0 → 에러', () => {
  const { issues } = analyzeCapture([], '10.0.0.5');
  assert.ok(issues.some((i) => i.sev === 'error' && /트래픽 없음/.test(i.title)));
});

test('compareDual: A→B 전송했으나 B 수신 0 → 경로 차단 에러', () => {
  const a = { analysis: { stat: { toPeer: { packets: 100 }, fromPeer: { packets: 80 } } } };
  const b = { analysis: { stat: { toPeer: { packets: 80 }, fromPeer: { packets: 0 } } } };
  const r = compareDual(a, b);
  assert.equal(r.ok, true);
  assert.equal(r.lossAB, 100);
  assert.ok(r.issues.some((i) => i.sev === 'error' && /A→B/.test(i.title)));
});

test('compareDual: 한쪽 캡처 실패 시 비교 불가', () => {
  const r = compareDual({ analysis: { stat: {} } }, null);
  assert.equal(r.ok, false);
});
