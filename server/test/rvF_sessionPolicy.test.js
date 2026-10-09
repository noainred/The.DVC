/**
 * 2026-10-09 검토 S-05·S-06·S-08 — 세션 수명 정책(순수 함수) 경계 고정.
 * 시각은 고정값이다(CLAUDE.md — 테스트에서 Date.now() 를 기준 시각으로 쓰지 말 것).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialExpSec, extendedExpSec, hardLimitSec, sessionVerdict, effectiveMaxHours, loginAtOf, revokeRetentionSec,
  IDLE_GRACE_SEC, MAX_WARN_PLUS_EXTEND_MIN,
} from '../src/auth/sessionPolicy.js';

const T0 = 1_900_000_000;
const H = 3600;

test('S-06 최초 만료 = min(지금 + TTL, 로그인 + 상한) — TTL 8h / 상한 2h 이면 2h', () => {
  assert.equal(initialExpSec({ nowSec: T0, ttlSec: 8 * H, maxHours: 2 }), T0 + 2 * H);
});

test('S-06 상한 0(무제한)이면 예전처럼 지금 + TTL', () => {
  assert.equal(initialExpSec({ nowSec: T0, ttlSec: 8 * H, maxHours: 0 }), T0 + 8 * H);
});

test('S-06 TTL 이 상한보다 짧으면 TTL 이 이긴다', () => {
  assert.equal(initialExpSec({ nowSec: T0, ttlSec: 8 * H, maxHours: 12 }), T0 + 8 * H);
});

test('S-08 AD 토큰은 AD 세션 상한까지 — 세션 보안 상한과 짧은 쪽', () => {
  assert.equal(effectiveMaxHours({ maxHours: 0, adMaxHours: 12, isAd: true }), 12);
  assert.equal(effectiveMaxHours({ maxHours: 3, adMaxHours: 12, isAd: true }), 3);
  assert.equal(effectiveMaxHours({ maxHours: 0, adMaxHours: 12, isAd: false }), 0, '로컬 토큰에는 AD 상한이 없다');
  assert.equal(initialExpSec({ nowSec: T0, ttlSec: 24 * H, adMaxHours: 12, isAd: true }), T0 + 12 * H);
});

test('S-06 연장 3회 — 총 상한은 원래 로그인 시각 기준에서 밀리지 않는다', () => {
  let exp = initialExpSec({ nowSec: T0, ttlSec: 1 * H, maxHours: 3 });
  assert.equal(exp, T0 + H);
  const steps = [];
  for (let i = 0; i < 3; i++) {
    const r = extendedExpSec({ curExp: exp, extendSec: H, loginAt: T0, maxHours: 3 });
    steps.push(r);
    exp = r.exp;
  }
  assert.deepEqual(steps.map((s) => s.exp - T0), [2 * H, 3 * H, 3 * H]);
  assert.equal(steps[2].capped, true);
  assert.equal(steps[2].hardLimit, T0 + 3 * H);
});

test('검사: 총 상한 경계(직전 통과 · 도달 거부) — 상한을 줄이면 기존 토큰에도 적용된다', () => {
  const p = { lt: T0, iat: T0 + 50 * 60, exp: T0 + 8 * H };
  assert.equal(sessionVerdict(p, { nowSec: T0 + 2 * H - 1, maxHours: 2 }).ok, true);
  assert.deepEqual(sessionVerdict(p, { nowSec: T0 + 2 * H, maxHours: 2 }), { ok: false, reason: 'max-age' });
  assert.equal(sessionVerdict(p, { nowSec: T0 + 7 * H, maxHours: 0 }).ok, true, '0 = 무제한');
});

test('검사: lt 없는 구버전 토큰은 iat 로 폴백', () => {
  const legacy = { iat: T0, exp: T0 + 8 * H };
  assert.equal(loginAtOf(legacy, 0), T0);
  assert.equal(sessionVerdict(legacy, { nowSec: T0 + H, maxHours: 2 }).ok, true);
  assert.equal(sessionVerdict(legacy, { nowSec: T0 + 2 * H + 1, maxHours: 2 }).ok, false);
});

test('검사: 서버측 유휴 — 마지막 활동 + 유휴 + 여유 경계', () => {
  const p = { lt: T0, sid: 'S1', exp: T0 + 8 * H };
  const ctx = (now) => ({ nowSec: now, idleEnabled: true, idleMin: 1, lastActivitySec: T0 });
  assert.equal(sessionVerdict(p, ctx(T0 + 60 + IDLE_GRACE_SEC)).ok, true, '경계 직전(같음)은 통과');
  assert.deepEqual(sessionVerdict(p, ctx(T0 + 60 + IDLE_GRACE_SEC + 1)), { ok: false, reason: 'idle' });
  assert.equal(sessionVerdict(p, { ...ctx(T0 + 10 * H), idleEnabled: false }).ok, true, '유휴 로그아웃을 끄면 판정하지 않는다');
  assert.equal(sessionVerdict({ lt: T0, exp: T0 + 8 * H }, ctx(T0 + 10 * 60)).ok, true, 'sid 없는 구버전 토큰은 유휴 판정 대상이 아니다');
});

test('검사: 개별 폐기·일괄 무효 시각이 먼저', () => {
  const p = { lt: T0, sid: 'S1', exp: T0 + 8 * H };
  assert.deepEqual(sessionVerdict(p, { nowSec: T0 + 10, revoked: true }), { ok: false, reason: 'revoked' });
  assert.deepEqual(sessionVerdict(p, { nowSec: T0 + 10, notBeforeSec: T0 + 1 }), { ok: false, reason: 'not-before' });
  assert.equal(sessionVerdict({ ...p, lt: T0 + 5 }, { nowSec: T0 + 10, notBeforeSec: T0 + 1 }).ok, true, '무효 시각 뒤 로그인은 살아 있다');
});

test('폐기 기록 보관 기간 — 연장으로 생겼을 수 있는 가장 늦은 사본까지, 총 상한이 있으면 거기까지', () => {
  const span = MAX_WARN_PLUS_EXTEND_MIN * 60;
  assert.equal(revokeRetentionSec({ nowSec: T0, exp: T0 + 600, ttlSec: 8 * H }), T0 + Math.max(8 * H, span));
  assert.equal(revokeRetentionSec({ nowSec: T0, exp: T0 + 600, ttlSec: 8 * H, hardLimit: T0 + 2 * H }), T0 + 2 * H);
  assert.equal(hardLimitSec({ loginAt: T0, maxHours: 0 }), null);
});
