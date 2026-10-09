/**
 * 2026-10-09 검토 S-01·S-02(리드 통합) — 장비 신원 거부(SSH 호스트키·TLS 인증서)를 '인증 실패' 로 읽지 않는다.
 *
 * 거부 문구에는 장비 주소·제시된 지문이 들어간다. 주소가 'array-403' 이면 isAuthFailureText 의 \b403\b 에 걸려
 * 주기 수집이 '인증 정지' 되고(자격증명을 바꿔야 풀린다 — 지문을 승인해도 다시 붙지 않는다), describeError 는 '인증 실패 —
 * 계정/비밀번호를 확인하세요' 라고 말해 사용자가 멀쩡한 비밀번호를 고친다. 실제 오류 생성 함수로 만든 문구로 확인한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAuthFailureText, isPeerRejectText, PEER_REJECT_MARKERS } from '../src/util/authGuard.js';
import { describeError } from '../src/util/errors.js';
import { sshHostKeyError, SSH_HOSTKEY_ERROR_CODE } from '../src/proxy/sshExec.js';
import { TlsPeerError, TLS_PEER_ERROR_CODE, judgeTlsSocket } from '../src/security/tlsTrust.js';

test('표지 문자열은 실제 오류 생성 코드의 값과 같다(한쪽만 바뀌면 선판정이 죽는다)', () => {
  assert.ok(PEER_REJECT_MARKERS.includes(`[${SSH_HOSTKEY_ERROR_CODE}]`));
  assert.ok(PEER_REJECT_MARKERS.includes(TLS_PEER_ERROR_CODE));
  // TLS 거부 문구는 코드 문자열을 담지 않는다 — 문구 표지로 잡는다(실제 판정 함수가 만든 문구로 확인)
  const fakeSock = { getPeerCertificate: () => ({}), authorized: false, authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT', isSessionReused: () => false };
  const v = judgeTlsSocket(fakeSock, { subsystem: 'storage', mode: 'strict', host: 'array-403.example', port: 443 });
  assert.equal(v.ok, false);
  assert.ok(isPeerRejectText(v.error.message), v.error.message);
});

test('SSH 호스트키 거부 — 지문·주소에 401/403 이 있어도 인증 실패가 아니다', () => {
  const e = sshHostKeyError({ fp: 'SHA256:abc/403/def+401+x', algo: 'ssh-ed25519', reason: 'changed' });
  assert.equal(isAuthFailureText(e.message), false);
  assert.equal(isAuthFailureText(`array-403: ${e.message}`), false);
  const d = describeError(e);
  assert.doesNotMatch(d.hint, /계정\/비밀번호/);
  assert.match(d.hint, /장비 신뢰/);
});

test('TLS 거부 — fetch failed 로 감싸져도(cause 사슬) 인증 실패라 말하지 않는다', () => {
  const inner = new TlsPeerError('vCenter vc-403.corp:443 장비 인증서를 신뢰할 수 없어 연결을 끊었습니다(요청·자격증명은 보내지 않았습니다) — 지문: 승인된 지문이 없습니다', { host: 'vc-403.corp' });
  const outer = new TypeError('fetch failed', { cause: inner });
  const d = describeError(outer);
  assert.equal(d.code, TLS_PEER_ERROR_CODE);
  assert.equal(d.hint, null, '거부 문구가 조치를 담는다 — 인증 실패 힌트로 덮지 않는다');
  assert.match(d.message, /장비 인증서를 신뢰할 수 없어/);
  assert.equal(isAuthFailureText(inner.message), false);
});

test('진짜 인증 실패는 그대로 인증 실패다(선판정이 넓어지지 않았다)', () => {
  assert.equal(isAuthFailureText('All configured authentication methods failed'), true);
  assert.equal(isAuthFailureText('HTTP 401'), true);
  assert.equal(isAuthFailureText('인증서 오류 self signed certificate'), false);
  assert.match(describeError(new Error('HTTP 401 Unauthorized')).hint, /인증 실패/);
});
