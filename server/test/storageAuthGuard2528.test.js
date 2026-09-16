/**
 * storageAuthGuard2528.test.js — 인증 실패(401) 주기 수집 정지 + 자격증명 지문 회귀(v2.528).
 *
 * 사용자 신고(2026-09-16): PowerStore `PS-HG-2`(엣지 HG 위임) `인증 실패(401)`.
 * 사용자 선택: "401 이면 수집 중단 + 화면에 표시", "자격증명 지문 표시".
 *
 * 여기서 고정하는 것:
 *  · 401/403 **만** 멈춘다 — 타임아웃·연결 실패로 멈추면 일시 장애가 수집을 영구 정지시킨다.
 *  · 자격증명이 바뀌면 **자동 재개** — 비밀번호를 고치는 것이 곧 조치다.
 *  · 지문에 **평문이 없다** — 이 기능의 보안 전제.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { credFingerprint, credFingerprintParts } from '../src/util/credFingerprint.js';
import {
  isAuthFailure, credHashOf, markAuthStopped, clearAuthStop, authStopFor,
  _resetForTest, _fileForTest,
} from '../src/storage/authGuard.js';

const DEV = { id: 'st-1', username: 'admin', password: 'P@ss#word#123' };

test('401/403 만 인증 실패로 본다 — 타임아웃·연결 실패는 아니다', () => {
  assert.equal(isAuthFailure({ ok: false, error: '인증 실패(401) — 계정/비밀번호 확인' }), true);
  assert.equal(isAuthFailure({ ok: false, error: 'HTTP 403 — forbidden' }), true);
  assert.equal(isAuthFailure({ ok: false, sections: { config: '오류: 인증 실패(401) — 계정/비밀번호 확인' } }), true);
  assert.equal(isAuthFailure({ ok: false, error: 'Permission denied (publickey,password)' }), true);
  // ★ 아래는 멈추면 안 된다 — 재시도로 풀리는 것들이다
  assert.equal(isAuthFailure({ ok: false, error: '수집 타임아웃' }), false);
  assert.equal(isAuthFailure({ ok: false, error: 'fetch failed (ECONNREFUSED)' }), false);
  assert.equal(isAuthFailure({ ok: false, error: 'HTTP 500 — internal error' }), false);
  assert.equal(isAuthFailure({ ok: false, error: 'uemcli 출력 파싱 실패' }), false);
  // 성공 스냅샷은 어떤 문구가 있어도 인증 실패가 아니다
  assert.equal(isAuthFailure({ ok: true, error: '' }), false);
  assert.equal(isAuthFailure(null), false);
});

test('정지 기록 — since 는 처음 시각을 유지하고 attempts 만 늘어난다', () => {
  _resetForTest();
  const a = markAuthStopped('st-1', DEV, '인증 실패(401)');
  const b = markAuthStopped('st-1', DEV, '인증 실패(401)');
  assert.equal(a.since, b.since, '같은 자격증명으로 반복 실패해도 since 는 그대로');
  assert.equal(b.attempts, 2);
  assert.ok(authStopFor(DEV), '주기 수집이 건너뛰어야 한다');
  _resetForTest();
});

test('★ 자격증명이 바뀌면 자동 재개한다 — 비밀번호를 고치는 것이 곧 조치다', () => {
  _resetForTest();
  markAuthStopped('st-1', DEV, '인증 실패(401)');
  assert.ok(authStopFor(DEV), '고치기 전에는 정지');
  const fixed = { ...DEV, password: 'NewPassword!' };
  assert.equal(authStopFor(fixed), null, '비밀번호를 바꾸면 버튼을 누르지 않아도 재개');
  // 재개 판정은 기록을 실제로 지운다(다음 조회에서도 정지가 아니다)
  assert.equal(authStopFor(fixed), null);
  _resetForTest();
});

test('계정명만 바뀌어도 재개한다(같은 비밀번호로 계정을 고친 경우)', () => {
  _resetForTest();
  markAuthStopped('st-1', DEV, '401');
  assert.equal(authStopFor({ ...DEV, username: 'service' }), null);
  _resetForTest();
});

test('성공하면 해제된다', () => {
  _resetForTest();
  markAuthStopped('st-1', DEV, '401');
  assert.equal(clearAuthStop('st-1'), true);
  assert.equal(authStopFor(DEV), null);
  assert.equal(clearAuthStop('st-1'), false, '없는 기록 해제는 false');
  _resetForTest();
});

test('정지 파일이 손상돼도 던지지 않는다(캐시 성격 — 새로 시작)', () => {
  _resetForTest();
  markAuthStopped('st-1', DEV, '401');
  fs.writeFileSync(_fileForTest(), '{ 깨진 json');
  _resetForTest.call(null);               // 메모리 캐시만 비우고 파일은 손상 상태로 둔다
  // 위 _resetForTest 는 파일도 지우므로, 손상 파일을 다시 만들어 로드 경로를 태운다
  fs.writeFileSync(_fileForTest(), '{ 깨진 json');
  assert.doesNotThrow(() => authStopFor(DEV));
  assert.equal(authStopFor(DEV), null);
  _resetForTest();
});

/* ── 자격증명 지문 ────────────────────────────────────────────────────────────── */

test('★ 지문에 평문이 없다 — 이 기능의 보안 전제', () => {
  const pw = 'Sup3rSecret!#value';
  const text = credFingerprint('admin', pw);
  assert.equal(text.includes(pw), false, '평문이 그대로 들어가면 안 된다');
  const p = credFingerprintParts('admin', pw);
  assert.equal(JSON.stringify(p).includes(pw), false);
  assert.equal(p.len, pw.length);
  assert.match(p.hash, /^[0-9a-f]{4}$/);
});

test('★ 끝 글자만 다른 비밀번호가 같은 지문이 되면 안 된다(v2.287 결함 — v2.528 수정)', () => {
  // 예전 구현은 djb2 의 **상위** 니블을 잘라 `abc` 와 `abd` 가 둘 다 `#b873` 이었다.
  // 지문의 존재 이유가 '바뀌었는지 대조' 인데 그 목적을 정면으로 깨는 결함이다.
  const h = (pw) => credFingerprintParts('admin', pw).hash;
  assert.notEqual(h('abc'), h('abd'), '끝 글자가 다르면 지문도 달라야 한다');
  assert.notEqual(h('P@ss#word#123'), h('P@ss#word#124'));
  assert.notEqual(h('Password1'), h('Password2'));
  // 형식은 그대로 4자리 16진수(앞자리 0 도 유지)
  for (const pw of ['', 'a', 'abc', 'P@ss#word#123']) assert.match(h(pw), /^[0-9a-f]{4}$/);
});

test('지문은 같은 입력에 같은 값 · 다른 입력에 (대개) 다른 값', () => {
  assert.equal(credFingerprint('admin', 'abc'), credFingerprint('admin', 'abc'));
  assert.notEqual(credFingerprint('admin', 'abc'), credFingerprint('admin', 'abd'));
  assert.notEqual(credFingerprint('admin', 'abc'), credFingerprint('root', 'abc'));
  // 길이가 다르면 해시가 충돌해도 지문은 다르다(길이를 함께 싣는 이유)
  assert.notEqual(credFingerprint('admin', 'abc'), credFingerprint('admin', 'abcd'));
});

test('앞뒤 공백을 드러낸다 — 화면에서는 보이지 않는 사고 원인', () => {
  assert.match(credFingerprint('admin', ' pw '), /앞뒤공백/);
  assert.match(credFingerprint(' admin', 'pw'), /공백/);
  assert.equal(credFingerprintParts('admin', ' pw ').space, true);
  assert.equal(credFingerprintParts('admin', 'pw').space, false);
});

test('빈 비밀번호는 숨기지 않는다 — 그 자체가 진단이다', () => {
  const p = credFingerprintParts('admin', '');
  assert.equal(p.empty, true);
  assert.equal(p.len, 0);
  assert.match(credFingerprint('admin', ''), /비번 0자/);
});

test('credHashOf 는 계정·길이·해시를 모두 반영한다', () => {
  assert.equal(credHashOf(DEV), credHashOf({ ...DEV }));
  assert.notEqual(credHashOf(DEV), credHashOf({ ...DEV, password: 'x' }));
  assert.notEqual(credHashOf(DEV), credHashOf({ ...DEV, username: 'x' }));
  assert.equal(credHashOf({}).includes('undefined'), false, '빈 장비도 던지지 않고 안전한 값');
});

test('#(샵)이 들어간 비밀번호도 지문이 정상 계산된다(사용자 신고 맥락)', () => {
  const p = credFingerprintParts('admin', 'P@ss#word#123');
  assert.equal(p.len, 13);
  assert.equal(p.empty, false);
  assert.equal(p.space, false);
});
