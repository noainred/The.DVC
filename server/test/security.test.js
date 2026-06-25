import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timingSafeEqualStr, tokenMatches } from '../src/util/secureCompare.js';
import { checkLoginAllowed, recordLoginFailure, recordLoginSuccess } from '../src/security/loginRateLimit.js';

test('timingSafeEqualStr: 동일 문자열 일치, 불일치/길이차 거부', () => {
  assert.equal(timingSafeEqualStr('s3cret-token', 's3cret-token'), true);
  assert.equal(timingSafeEqualStr('s3cret-token', 's3cret-toketX'), false);
  assert.equal(timingSafeEqualStr('short', 'a-much-longer-value'), false);
  assert.equal(timingSafeEqualStr('', ''), true);
});

test('tokenMatches: 빈 기대값은 항상 거부(토큰 미설정 보호)', () => {
  assert.equal(tokenMatches('anything', ''), false);
  assert.equal(tokenMatches('', ''), false);
  assert.equal(tokenMatches('abc', 'abc'), true);
});

test('loginRateLimit: 임계 도달 시 잠금, 성공 시 해제', () => {
  const ip = '10.0.0.99'; const user = `u-${'lock'}`;
  // 기본 임계 8회: 7회 실패까지는 잠기지 않음
  let lastLocked = false;
  for (let i = 0; i < 7; i++) lastLocked = recordLoginFailure(ip, user).locked;
  assert.equal(lastLocked, false);
  assert.equal(checkLoginAllowed(ip, user).blocked, false);
  // 8회째 실패에서 잠금
  const r = recordLoginFailure(ip, user);
  assert.equal(r.locked, true);
  assert.ok(r.retryAfterSec > 0);
  assert.equal(checkLoginAllowed(ip, user).blocked, true);
});

test('loginRateLimit: 성공하면 카운터 초기화되어 차단 없음', () => {
  const ip = '10.0.0.100'; const user = 'u-reset';
  recordLoginFailure(ip, user);
  recordLoginFailure(ip, user);
  recordLoginSuccess(ip, user);
  assert.equal(checkLoginAllowed(ip, user).blocked, false);
});

test('loginRateLimit: IP/계정 키가 다르면 독립적으로 집계', () => {
  for (let i = 0; i < 8; i++) recordLoginFailure('1.1.1.1', 'victim');
  assert.equal(checkLoginAllowed('1.1.1.1', 'victim').blocked, true);
  // 다른 계정/다른 IP는 영향 없음
  assert.equal(checkLoginAllowed('2.2.2.2', 'victim').blocked, false);
  assert.equal(checkLoginAllowed('1.1.1.1', 'other').blocked, false);
});
