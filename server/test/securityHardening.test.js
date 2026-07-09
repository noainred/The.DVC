import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ssrfBlockReason } from '../src/collector/registry.js';
import * as totp from '../src/auth/totp.js';

test('ssrfBlockReason: 링크로컬/클라우드 메타데이터 차단, 사설·공인은 허용', () => {
  // 차단 대상
  assert.ok(ssrfBlockReason('http://169.254.169.254/latest/meta-data'), 'AWS/GCP/Azure 메타데이터 차단');
  assert.ok(ssrfBlockReason('http://169.254.0.1:4000'), '링크로컬 차단');
  assert.ok(ssrfBlockReason('http://[fe80::1]:4000'), 'IPv6 링크로컬 차단');
  assert.ok(ssrfBlockReason('http://[fd00::1]:4000'), 'IPv6 ULA 차단');
  assert.ok(ssrfBlockReason('ftp://10.0.0.1'), 'http/https 외 스킴 차단');
  assert.ok(ssrfBlockReason('not a url'), '형식 오류 차단');
  // 허용(수집 서버는 사설망에 있음)
  assert.equal(ssrfBlockReason('http://192.168.40.221:4000'), null, '사설 RFC1918 허용');
  assert.equal(ssrfBlockReason('http://10.9.1.5:4000'), null, '사설 10.x 허용');
  assert.equal(ssrfBlockReason('https://collector.corp.example:4000'), null, '공인 호스트 허용');
});

test('totp.verifyToken: 일치 시 카운터(정수) 반환, 불일치는 null', () => {
  const secret = totp.generateSecret ? totp.generateSecret() : 'JBSWY3DPEHPK3PXP';
  const now = Math.floor(Date.now() / 1000 / 30);
  const code = totp.generateToken(secret, { counter: now });
  const ctr = totp.verifyToken(code, secret);
  assert.equal(ctr, now, '일치한 카운터 반환');
  assert.equal(totp.verifyToken('000000', secret, { window: 0 }) === now, false, '틀린 코드는 카운터 미반환');
  assert.equal(totp.verifyToken('abc', secret), null, '형식 오류는 null');
});

test('totp.verifyToken: minCounter 이하 코드는 재사용(replay) 거부', () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  const now = Math.floor(Date.now() / 1000 / 30);
  const code = totp.generateToken(secret, { counter: now });
  // 이미 now를 사용했다고 가정 → minCounter=now면 같은 코드 거부
  assert.equal(totp.verifyToken(code, secret, { minCounter: now }), null, '이미 쓴 카운터의 코드 거부');
  // minCounter 미만이면 정상 수락
  assert.equal(totp.verifyToken(code, secret, { minCounter: now - 1 }), now, '아직 안 쓴 카운터는 수락');
});
