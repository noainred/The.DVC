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
  assert.equal(parseTraceroute('traceroute: unknown host foo').reached, false);
  assert.equal(parseTraceroute('').hops, 0);
  assert.equal(parseTraceroute('').reached, false);
});

// --- 재감사(2026-08-30)에서 재현된 잔여 '거짓 정상' — 홉 임계 초과 / 문구형 도달불가 ---

test('홉 임계 초과: 마지막 홉이 응답해도 미도달(중간 라우터를 목적지로 오판 금지)', () => {
  // traceroute 는 목적지가 응답하면 그 자리에서 멈춘다. 임계보다 많은 줄이 찍혔다면 닿지 못한 것.
  // 한국↔폴란드·미국동부처럼 홉이 긴 경로에서 실제로 발현하는 오판이었다.
  // 명령은 임계보다 1 크게(-m maxHops+1) 실행하므로, 임계 초과 = hops > maxHops 다.
  const out = [
    ' 1  10.0.0.1  0.512 ms',
    ' 2  10.1.0.1  12.4 ms',
    ' 3  213.155.130.1  260.1 ms',
  ].join('\n');
  const over = parseTraceroute(out, { maxHops: 2 });
  assert.equal(over.overLimit, true, '임계 2 인데 3줄 → 초과');
  assert.equal(over.reached, false, '임계 초과는 미도달로 보고해야 함');
  assert.equal(parseTraceroute(out, { maxHops: 15 }).reached, true, '임계 미달이면 종전대로 도달');
  assert.equal(parseTraceroute(out).reached, true, 'maxHops 미지정 시 이 검사는 생략(하위호환)');
});

test('목적지가 정확히 임계 홉에 있는 정상 경로를 미도달로 오판하지 않는다', () => {
  // 3차 재감사 지적: 명령 상한과 임계를 같은 값으로 쓰고 hops >= maxHops 로 판정하면,
  // 폴란드까지 실제 15홉인 정상 경로(임계 15)가 항상 warn 으로 오보됐다(호스트명 대상은
  // target 대조도 못 쓴다 — 명령이 -n 이라 출력은 IP 뿐이므로).
  const lines = [];
  for (let i = 1; i <= 15; i++) lines.push(` ${i}  10.0.${i}.1  ${i * 12}.4 ms`);
  const r = parseTraceroute(lines.join('\n'), { maxHops: 15, target: 'vc-poland.example.com' });
  assert.equal(r.hops, 15);
  assert.equal(r.overLimit, false, '임계와 같은 홉 수는 초과가 아니다');
  assert.equal(r.reached, true, '정상 도달이 warn 으로 오보되면 안 된다');
});

test('임계 초과라도 목적지 주소가 마지막 홉에 있으면 도달(오탐 방지, 대소문자 무시)', () => {
  const out = [
    ' 1  10.0.0.1  0.512 ms',
    ' 2  10.2.0.5  2.881 ms',
  ].join('\n');
  assert.equal(parseTraceroute(out, { maxHops: 1, target: '10.2.0.5' }).reached, true);
  assert.equal(parseTraceroute(out, { maxHops: 1, target: '10.9.9.9' }).reached, false);
  // IPv6 대문자 표기 대상도 매칭돼야 한다(정규식 i 플래그).
  const v6 = ' 2  2001:db8::5  3.1 ms';
  assert.equal(parseTraceroute(v6, { maxHops: 1, target: '2001:DB8::5' }).reached, true);
});

test('문구형 도달불가(Destination net unreachable)는 주소가 있어도 미도달', () => {
  const out = '  2  10.0.0.1  reports: Destination net unreachable.';
  assert.equal(parseTraceroute(out).reached, false);
});

test('IPv6 주소 응답도 도달로 인식(주소 정규식 오작동 방지)', () => {
  assert.equal(parseTraceroute(' 3  2001:db8::1  4.2 ms').reached, true);
});
