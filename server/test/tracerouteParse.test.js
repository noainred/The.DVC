import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTraceroute } from '../src/svcmon/checker.js';

// 확정 버그 회귀 방지(2026-08-30) — trace 점검의 '거짓 정상'.
//
// 배경: 이전 판정은 마지막 홉이 `* * *`(별표 3연속)일 때만 미도달로 봤다. 그런데 Linux 인자는
// `-q 1`(홉당 프로브 1개)이라 무응답 홉 출력이 `" 15  *"`(별표 1개)뿐이어서 별표 3연속이
// **구조적으로 나올 수 없었다** → 목적지까지 전 홉이 무응답이어도 reached=true 가 되어 죽은
// 경로가 'ok'(정상)로 표시됐다. Windows tracert 는 기본 3프로브라 `* * *` 가 나와 개발
// 환경에서는 드러나지 않고 운영(Rocky Linux 9)에서만 발현하는 유형이었다.

test('Linux -q 1: 마지막 홉 무응답(별표 1개)이면 미도달 — 과거 거짓 정상의 핵심 케이스', () => {
  const out = [
    'traceroute to 10.9.9.9 (10.9.9.9), 15 hops max, 60 byte packets',
    ' 1  10.0.0.1  0.512 ms',
    ' 2  *',
    ' 3  *',
    ' 4  *',
  ].join('\n');
  const r = parseTraceroute(out);
  assert.equal(r.hops, 4);
  assert.equal(r.reached, false, '전 홉 무응답인데 도달로 보면 죽은 경로가 정상으로 표시된다');
});

test('Linux -q 1: 마지막 홉이 응답하면 도달', () => {
  const out = [
    ' 1  10.0.0.1  0.512 ms',
    ' 2  10.1.0.1  1.204 ms',
    ' 3  10.2.0.5  2.881 ms',
  ].join('\n');
  const r = parseTraceroute(out);
  assert.equal(r.hops, 3);
  assert.equal(r.reached, true);
});

test('Windows tracert(3프로브): 별표 3연속은 여전히 미도달', () => {
  const out = [
    '  1     1 ms     1 ms     1 ms  10.0.0.1',
    '  2     *        *        *     Request timed out.',
  ].join('\n');
  assert.equal(parseTraceroute(out).reached, false);
});

test('Windows tracert(3프로브): 마지막 홉 응답이면 도달', () => {
  const out = [
    '  1     1 ms     1 ms     1 ms  10.0.0.1',
    '  2     3 ms     2 ms     2 ms  10.2.0.5',
  ].join('\n');
  assert.equal(parseTraceroute(out).reached, true);
});

test('ICMP 도달불가 표식(!H)은 응답이 와도 미도달로 본다', () => {
  // 라우터가 '호스트 도달불가' 를 회신한 경우 — 응답은 있지만 목적지에 닿지 못했다.
  const out = [
    ' 1  10.0.0.1  0.512 ms',
    ' 2  10.1.0.1  1.204 ms !H',
  ].join('\n');
  assert.equal(parseTraceroute(out).reached, false);
});

test('부분 무응답 후 마지막 홉이 응답하면 도달(중간 홉 침묵은 정상)', () => {
  const out = [
    ' 1  10.0.0.1  0.512 ms',
    ' 2  *',
    ' 3  10.2.0.5  2.881 ms',
  ].join('\n');
  assert.equal(parseTraceroute(out).reached, true);
});

test('홉 줄이 전혀 없으면 미도달(hops 0)', () => {
  assert.deepEqual(parseTraceroute('traceroute: unknown host foo'), { hops: 0, reached: false });
  assert.deepEqual(parseTraceroute(''), { hops: 0, reached: false });
});
