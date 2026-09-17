/**
 * test/sshAuthStop2541.test.js — SSH 인증 실패가 주기 수집을 멈추는가(v2.541).
 *
 * ── 왜 이 테스트가 있나 ────────────────────────────────────────────────────────
 * 사용자 신고(2026-09-17, Unity `OC2-unity-03`): 장비 상세에
 *   `SSH 수집 실패: All configured authentication methods failed`
 * 가 떠 있는데 **정지 안내(`authStopped`)가 없었다**. 원인은 `util/authGuard.js` 의
 * 판정 패턴이 `authentication fail` **연속 일치**만 봤다는 것이다 — ssh2 의 실제 문구는
 * 사이에 `methods` 가 끼어 있어(`node_modules/ssh2/lib/client.js:863`) 매치하지 않았다.
 * 결과로 v2.528 이 막으려던 **계정 잠금 경로**(매 주기 같은 계정으로 재로그인)가 SSH
 * 수집기 전체에서 그대로 열려 있었고, 화면은 정지 사실도 지문 대조 안내도 말하지 않았다.
 *
 * ⚠ 이 파일은 **문구 목록이 아니라 경계**를 고정한다 — 양성(멈춰야 함)과 음성(멈추면 안 됨)을
 * 함께 둔다. 음성이 깨지면 일시적 네트워크 장애가 수집을 영구 정지시킨다(authGuard 규칙 4).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAuthFailureText } from '../src/util/authGuard.js';
import { isAuthFailure } from '../src/storage/authGuard.js';
import { isSshAuthError } from '../src/proxy/sshExec.js';
import { sshFailureSnapshot } from '../src/storage/collectors/cliSsh.js';

/** 자격증명 거부 — 재시도해도 결과가 같고 계정만 잠근다. 반드시 멈춰야 한다. */
const MUST_STOP = [
  'All configured authentication methods failed',            // ← 사용자 화면의 그 문구(ssh2)
  'SSH 수집 실패: All configured authentication methods failed',
  'SSH 인증 실패: All configured authentication methods failed — 계정·비밀번호(또는 개인키)를 확인하세요.',
  'Authentication failed',
  'Authentication failure',
  'Keyboard-interactive authentication failed',
  'Permission denied (publickey,password)',
  'HTTP 401',
  '403 Forbidden',
  'invalid username or password',
  '인증 실패',
  'SSH 오류: ... (level=client-authentication)',
];

/** 일시 장애·설정 오류 — 멈추면 네트워크 장애 한 번이 수집을 영구 정지시킨다. */
const MUST_NOT_STOP = [
  'connect ETIMEDOUT',
  'connect ECONNREFUSED 10.94.41.237:22',
  'SSH 접속 취소(타임아웃)',
  'getaddrinfo ENOTFOUND unity.example',
  'Cannot parse privateKey: Unsupported key format',
  // 'failed' 이 들어 있지만 자격증명 문제가 아니다 — 구형 알고리즘 폴백이 처리할 일이다.
  'Handshake failed: no matching key exchange algorithm',
  'SSH 연결이 준비 전에 닫혔습니다(서버가 세션을 끊음 — 접속 제한/알고리즘/배너 확인)',
  'uemcli 출력 파싱 실패 — 출력 형식이 예상과 다릅니다',
  '수집 시간 예산 초과',
  'socket hang up',
  '명령 출력이 끊겼습니다(시한 초과 · 자동응답 3회)',
];

test('isAuthFailureText: ssh2 의 "All configured authentication methods failed" 를 잡는다(v2.541 결함)', () => {
  for (const s of MUST_STOP) assert.equal(isAuthFailureText(s), true, `멈춰야 함: ${s}`);
});

test('isAuthFailureText: 일시 장애·설정 오류는 잡지 않는다(규칙 4 — 영구 정지 방지)', () => {
  for (const s of MUST_NOT_STOP) assert.equal(isAuthFailureText(s), false, `멈추면 안 됨: ${s}`);
});

test('ssh2 의 실제 문구가 라이브러리에 그대로 있다(전제 고정)', () => {
  // 문구가 바뀌면 이 테스트가 먼저 깨져 알려 준다 — 판정이 조용히 약해지지 않게.
  const src = readFileSync(new URL('../node_modules/ssh2/lib/client.js', import.meta.url), 'utf8');
  assert.ok(src.includes("new Error('All configured authentication methods failed')"),
    'ssh2 의 인증 실패 문구가 바뀌었다 — isAuthFailureText 재검토 필요');
  assert.ok(src.includes("err.level = 'client-authentication'"),
    'ssh2 의 level 값이 바뀌었다 — isSshAuthError 재검토 필요');
});

test('isSshAuthError: level 을 문구보다 먼저 본다(영문 문구가 바뀌어도 살아남는다)', () => {
  const e = new Error('완전히 다른 문구');
  e.level = 'client-authentication';
  assert.equal(isSshAuthError(e), true);
  assert.equal(isSshAuthError(new Error('All configured authentication methods failed')), true);
  assert.equal(isSshAuthError(new Error('connect ETIMEDOUT')), false);
  assert.equal(isSshAuthError(new Error('Handshake failed: no matching key exchange algorithm')), false);
  assert.equal(isSshAuthError(null), false);
});

test('sshFailureSnapshot → isAuthFailure(snap): 인증 거부는 정지 대상, 타임아웃은 아니다', () => {
  const dev = { id: 'u1', type: 'unity', name: 'OC2-unity-03' };
  const authErr = new Error('All configured authentication methods failed');
  authErr.level = 'client-authentication';

  const bad = sshFailureSnapshot(dev, authErr);
  assert.match(bad.error, /SSH 인증 실패/);
  // 원문을 지우지 않는다 — 어느 단계에서 거부됐는지가 진단이다.
  assert.match(bad.error, /All configured authentication methods failed/);
  assert.equal(isAuthFailure(bad), true);

  const tmo = sshFailureSnapshot(dev, new Error('connect ETIMEDOUT'));
  assert.match(tmo.error, /SSH 수집 실패/);
  assert.equal(isAuthFailure(tmo), false);
});

test('Isilon 도 같은 코어를 쓴다 — 실패 문구를 복제하지 않는다', () => {
  const src = readFileSync(new URL('../src/storage/collectors/isilonSsh.js', import.meta.url), 'utf8');
  assert.ok(src.includes('sshFailureSnapshot'), 'isilonSsh 가 공용 실패 스냅샷을 써야 한다');
  assert.ok(!/snap\.error = `SSH 수집 실패/.test(src),
    'isilonSsh 가 실패 문구를 자체 조립하면 인증 분류가 한쪽에만 들어간다');
});

test('정규식이 긴 비매치 입력에서 백트래킹하지 않는다(낱말 반복 상한)', () => {
  const long = `authentication ${'x'.repeat(200000)}`;
  const t0 = Date.now();
  isAuthFailureText(long);
  assert.ok(Date.now() - t0 < 500, '판정이 500ms 를 넘으면 반복 상한이 풀린 것이다');
});
