import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { recordToolUse, getTopTools, resetToolUsage } from '../src/tool-usage.js';

beforeEach(() => resetToolUsage());

test('getTopTools: 사용 횟수 내림차순 상위 N개', () => {
  for (let i = 0; i < 5; i++) recordToolUse('gpu');
  for (let i = 0; i < 3; i++) recordToolUse('ipam');
  recordToolUse('waste');

  const top = getTopTools(2);
  assert.equal(top.length, 2);
  assert.equal(top[0].k, 'gpu');
  assert.equal(top[0].count, 5);
  assert.equal(top[1].k, 'ipam');
  assert.equal(top[1].count, 3);
});

test('동률은 최근 사용이 우선', () => {
  recordToolUse('pdu');
  recordToolUse('ipam');
  recordToolUse('pdu'); // pdu=2(나중), ipam=1 — v2.598: 서버가 아는 도구 키만 받는다
  recordToolUse('ipam'); // b=2(가장 나중)
  // a=2, b=2 동률 → 마지막으로 기록된 b가 앞.
  const top = getTopTools(2);
  assert.equal(top[0].k, 'ipam');
  assert.equal(top[1].k, 'pdu');
});

test('잘못된 키는 무시', () => {
  assert.equal(recordToolUse('bad key!').ok, false);
  assert.equal(recordToolUse('').ok, false);
  assert.equal(recordToolUse(null).ok, false);
  assert.equal(getTopTools(3).length, 0);
});

test('resetToolUsage: 초기화', () => {
  recordToolUse('gpu');
  assert.equal(getTopTools(3).length, 1);
  resetToolUsage();
  assert.equal(getTopTools(3).length, 0);
});
