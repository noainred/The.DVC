import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { parseDigestChallenge, buildDigestHeader } from '../src/idrac/digestAuth.js';

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

test('parseDigestChallenge: Digest 챌린지 파싱(따옴표 값·콤마 포함)', () => {
  const c = parseDigestChallenge('Digest realm="iDRAC", nonce="abc,123", qop="auth", opaque="xyz", algorithm=MD5');
  assert.equal(c.realm, 'iDRAC');
  assert.equal(c.nonce, 'abc,123');
  assert.equal(c.qop, 'auth');
  assert.equal(c.opaque, 'xyz');
});

test('parseDigestChallenge: Basic 챌린지는 null', () => {
  assert.equal(parseDigestChallenge('Basic realm="iDRAC"'), null);
  assert.equal(parseDigestChallenge(''), null);
  assert.equal(parseDigestChallenge(null), null);
});

test('buildDigestHeader: RFC2617 qop=auth 응답 해시가 서버 계산과 일치', () => {
  const username = 'root', password = 'p@ss:w0rd!#$', realm = 'iDRAC', nonce = 'NONCE123', uri = '/redfish/v1/Systems';
  const challenge = { realm, nonce, qop: 'auth', algorithm: 'MD5', opaque: 'OP' };
  const header = buildDigestHeader({ username, password, method: 'GET', uri, challenge, cnonce: 'CNONCE', nc: '00000001' });
  // 헤더에서 response/cnonce/nc 추출
  const get = (k) => new RegExp(`${k}="?([^",]+)"?`).exec(header)?.[1];
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`GET:${uri}`);
  const expected = md5(`${ha1}:${nonce}:00000001:CNONCE:auth:${ha2}`);
  assert.equal(get('response'), expected);
  assert.equal(get('qop'), 'auth');
  assert.match(header, /opaque="OP"/);
});

test('buildDigestHeader: qop 없는(RFC2069) 응답 해시', () => {
  const username = 'root', password = 'pw', realm = 'r', nonce = 'N', uri = '/x';
  const header = buildDigestHeader({ username, password, method: 'GET', uri, challenge: { realm, nonce } });
  const resp = /response="([^"]+)"/.exec(header)[1];
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`GET:${uri}`);
  assert.equal(resp, md5(`${ha1}:${nonce}:${ha2}`));
});
