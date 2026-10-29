/**
 * v2.760(점검 B-06 — 재현) — UAG 통계의 '못 읽은 값' 은 0 이 아니다.
 *  예전 `num = Number(v)` 는 null·''(XML 빈 요소)를 0 으로 만들어, 전체 세션 칸이 비면 서비스 합계로 대체하지 않고 '0' 을,
 *  메모리 칸이 비면 '0%' 를 냈다.
 *
 * 실행: node --test uagmon/test/uag2760.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStats, num } from '../lib/uag.js';

test('num — 숫자·숫자 문자열만 값, null·빈 문자열·배열·객체는 null', () => {
  assert.equal(num(0), 0);
  assert.equal(num('0'), 0, '보고된 0 은 값이다');
  assert.equal(num(' 12 '), 12);
  for (const v of [null, undefined, '', '   ', [], [3], {}, 'abc', NaN, Infinity, true]) assert.equal(num(v), null, JSON.stringify(v));
});

test('JSON null·빈 문자열 — 전체 세션은 서비스 합계로, 메모리는 모름(null)', () => {
  const r = parseStats(JSON.stringify({
    totalSessionCount: null,
    edgeServiceSessionStats: [{ identifier: 'VIEW', totalSessionCount: 5, highWaterMark: null }],
    systemStats: { memoryUtilPercent: '' },
  }));
  assert.equal(r.totalSessions, 5);
  assert.equal(r.services[0].high, null);
  assert.equal(r.memPercent, null);
});

test('XML 빈 요소 — 0 으로 읽지 않는다', () => {
  const r = parseStats('<accessPointStatusAndStats><totalSessionCount></totalSessionCount>'
    + '<edgeServiceSessionStats><identifier>VIEW</identifier><totalSessionCount>7</totalSessionCount><highWaterMark></highWaterMark></edgeServiceSessionStats>'
    + '</accessPointStatusAndStats>');
  assert.equal(r.totalSessions, 7);
  assert.equal(r.services[0].high, null);
});

test('보고된 0 은 그대로 0 이다(세션이 정말 없는 UAG)', () => {
  const r = parseStats(JSON.stringify({ totalSessionCount: 0, edgeServiceSessionStats: [{ identifier: 'VIEW', totalSessionCount: 3 }] }));
  assert.equal(r.totalSessions, 0);
});
