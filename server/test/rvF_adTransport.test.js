/**
 * 2026-10-09 검토 S-03 — AD 인증 연결은 검증된 LDAPS 또는 성공 확인된 StartTLS 로만. 합성 LDAP 서버(ldapjs)로 고정한다.
 *   · 새로 저장하는 평문 ldap://(StartTLS 없음)는 400(사용자 선택 '새 저장만 거부') — 이미 저장된 평문 설정은 동작 유지 + 경고.
 *   · StartTLS 가 실패하면 bind 를 한 번도 하지 않는다(ldapjs 는 TLS 협상 실패 시 '평문 모드로 되돌아간다').
 *   · 사설 CA: 맞는 CA 면 성공, 다른 CA·잘못된 이름이면 bind 전에 실패. 잘못된 PEM 은 저장 거부.
 *   · 로그인 응답은 예전 그대로('invalid credentials') — 단계별 사유는 내부 진단(lastAdAuthFailure·연결 테스트)만.
 * 인증서는 테스트 안에서 임시로 만든다(openssl, 1일 · 임시 디렉터리 · 끝나면 지운다). openssl 이 없으면 TLS 항목만 건너뛴다.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rvF-adtls-'));
Object.assign(process.env, { CONFIG_DIR: tmp, AUTH_ENABLED: 'true', AUTH_SECRET: 'rvF-adtls-secret-0123456789abcdefghij', DATA_SOURCE: 'mock' });
const require = createRequire(new URL('../package.json', import.meta.url));
const ldap = require('ldapjs');

const USER = 'cn=kim,dc=corp,dc=local';   // ldapjs 서버는 UPN 형식 bind 를 DN 문법 오류로 거절한다 — 합성 서버에는 DN 으로 바인드한다
const PW = 'Ad#Pass12345';
let ad; let A;
let pki = null;
const servers = [];

function genPki() {
  const dir = path.join(tmp, 'pki');
  fs.mkdirSync(dir);
  const o = (args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  for (const ca of ['ca1', 'ca2']) {
    o(['req', '-x509', ...ec, '-days', '1', '-subj', `/CN=rvF-${ca}`, '-keyout', `${ca}.key`, '-out', `${ca}.crt`,
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  }
  o(['req', ...ec, '-subj', '/CN=localhost', '-keyout', 'srv.key', '-out', 'srv.csr']);
  fs.writeFileSync(path.join(dir, 'ext.cnf'), 'subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n');
  o(['x509', '-req', '-in', 'srv.csr', '-CA', 'ca1.crt', '-CAkey', 'ca1.key', '-CAcreateserial', '-days', '1', '-out', 'srv.crt', '-extfile', 'ext.cnf']);
  const rd = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  return { ca1: rd('ca1.crt'), ca2: rd('ca2.crt'), cert: rd('srv.crt'), key: rd('srv.key') };
}

/** 합성 LDAP 서버 — bind 시도 수를 센다. starttls: 'none'(확장 미지원) | 'accept-no-tls'(성공 응답 후 TLS 를 하지 않는다). */
async function ldapServer({ tls = false, starttls = 'none' } = {}) {
  const s = tls ? ldap.createServer({ certificate: pki.cert, key: pki.key }) : ldap.createServer();
  const stat = { binds: 0, exops: 0 };
  s.bind('dc=corp,dc=local', (req, res, next) => {
    stat.binds++;
    if (String(req.dn).toLowerCase() === USER && req.credentials === PW) { res.end(); return next(); }
    return next(new ldap.InvalidCredentialsError());
  });
  s.search('dc=corp,dc=local', (req, res, next) => {
    // ldapjs 서버는 요청 속성 목록(대소문자 그대로)과 소문자로 바꾼 응답 속성 이름을 비교해 'memberOf' 를 지운다 — 합성 서버의 버릇을 맞춘다.
    res.attributes = res.attributes.map((a) => String(a).toLowerCase());
    res.send({ dn: USER, attributes: { sAMAccountName: USER, memberOf: ['CN=Portal-Admins,OU=Groups,DC=corp,DC=local'], displayName: 'Kim AD' } });
    res.end(); return next();
  });
  s.on('error', () => { /* 'accept-no-tls' 에서 TLS ClientHello 를 LDAP 로 읽은 파서 오류 — 의도된 실패 */ });
  s.on('clientError', () => { /* */ });
  if (starttls === 'accept-no-tls') s.exop('1.3.6.1.4.1.1466.20037', (req, res, next) => { stat.exops++; res.end(); return next(); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return { port: s.address().port, stat, scheme: tls ? 'ldaps' : 'ldap' };
}

/** 저장 경로를 거치지 않고 '이미 저장돼 있던' 설정을 쓴다(기존 현장 흉내). */
function writeExisting(cfg) {
  fs.writeFileSync(path.join(tmp, 'auth.json'), JSON.stringify({ ad: { enabled: true, domain: '', baseDN: 'dc=corp,dc=local', adminGroup: 'Portal-Admins', defaultRole: 'viewer', timeoutMs: 3000, ...cfg } }));
  ad.invalidateAdPolicyCache();
}

before(async () => {
  ad = await import('../src/auth/ad.js');
  A = await import('../src/auth/auth.js');
  try { pki = genPki(); } catch { pki = null; }
});
after(() => {
  for (const s of servers) { try { s.close(); } catch { /* */ } }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
});

// ── 저장 규칙 ────────────────────────────────────────────────────────────────
test('S-03 ① 새로 저장하는 평문 ldap://(StartTLS 없음)는 거부한다 — 저장하지 않는다', () => {
  fs.rmSync(path.join(tmp, 'auth.json'), { force: true });
  assert.throws(() => ad.saveAdConfig({ enabled: true, url: 'ldap://dc01.corp.local:389' }), (e) => e.status === 400 && e.code === 'ldap-plain');
  assert.equal(fs.existsSync(path.join(tmp, 'auth.json')), false, '거부한 설정은 파일에 남지 않는다');
  const ok = ad.saveAdConfig({ enabled: true, url: 'ldap://dc01.corp.local:389', startTls: true });
  assert.equal(ad.adTransportMode(ok), 'starttls');
  const s = ad.saveAdConfig({ url: 'ldaps://dc01.corp.local:636' });
  assert.equal(ad.adTransportMode(s), 'ldaps');
  assert.throws(() => ad.saveAdConfig({ url: 'dc01.corp.local' }), (e) => e.code === 'url-invalid');
});

test('S-03 ② 이미 저장된 평문 설정 — 그룹명 수정은 받고(경고), URL 변경·다시 켜기는 거부', () => {
  writeExisting({ url: 'ldap://dc01.corp.local:389' });
  const r = ad.saveAdConfig({ adminGroup: 'Portal-Admins-2' });
  assert.equal(r.adminGroup, 'Portal-Admins-2');
  assert.deepEqual(ad.adTransportStatus(r).warnings, ['plain-ldap']);
  assert.throws(() => ad.saveAdConfig({ url: 'ldap://dc02.corp.local:389' }), (e) => e.code === 'ldap-plain');
  ad.saveAdConfig({ enabled: false });
  assert.throws(() => ad.saveAdConfig({ enabled: true }), (e) => e.code === 'ldap-plain', '끈 평문 설정을 다시 켜는 것도 새 저장이다');
});

test('S-03 ③ CA·인증서 이름 검증 — 잘못된 PEM 과 IP 이름은 저장 거부', (t) => {
  if (!pki) { t.skip('openssl 없음'); return; }
  assert.throws(() => ad.saveAdConfig({ url: 'ldaps://dc01.corp.local:636', caCert: 'not a cert' }), (e) => e.code === 'ca-invalid');
  assert.throws(() => ad.saveAdConfig({ url: 'ldaps://dc01.corp.local:636', caCert: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----' }), (e) => e.code === 'ca-invalid');
  assert.throws(() => ad.saveAdConfig({ url: 'ldaps://dc01.corp.local:636', tlsServerName: '10.0.0.1' }), (e) => e.code === 'servername-invalid');
  const r = ad.saveAdConfig({ url: 'ldaps://dc01.corp.local:636', caCert: pki.ca1, tlsServerName: 'dc01.corp.local' });
  assert.equal(ad.adTransportStatus(r).ca, true);
});

test('S-03 ④ PUT /api/auth/ad-config — 평문 새 저장은 400 + 사유(코드)', async () => {
  const express = (await import('express')).default;
  const { authRouter } = await import('../src/routes/auth.js');
  const sec = await import('../src/security/securitySettings.js');
  A.createUser({ username: 'rvf.owner', role: 'admin', password: 'Owner#Pass12345' }, { trusted: true });
  const u = A.getUser('rvf.owner'); u.totpEnabled = true; u.totpSecret = 'JBSWY3DPEHPK3PXP'; // 등록 완료 상태(requireEnrolled 통과)
  sec.saveSessionSecurity({ settingsOwners: ['rvf.owner'] });
  const tok = A.signToken({ sub: 'rvf.owner', role: 'admin', name: 'o', src: 'local', tv: u.tokenVersion || 0, sid: 'rvf-owner-sid' });
  const app = express(); app.use(express.json()); app.use('/api/auth', authRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    fs.rmSync(path.join(tmp, 'auth.json'), { force: true }); ad.invalidateAdPolicyCache();
    const put = (body) => fetch(`http://127.0.0.1:${srv.address().port}/api/auth/ad-config`, { method: 'PUT', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const bad = await put({ enabled: true, url: 'ldap://dc01.corp.local:389' });
    const bb = await bad.json();
    assert.equal(bad.status, 400, JSON.stringify(bb));
    assert.equal(bb.code, 'ldap-plain');
    assert.match(bb.reason, /ldaps:\/\/|StartTLS/);
    const good = await put({ enabled: true, url: 'ldap://dc01.corp.local:389', startTls: true });
    const gb = await good.json();
    assert.equal(good.status, 200, JSON.stringify(gb));
    assert.equal(gb.transport.mode, 'starttls');
    const got = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/auth/ad-config`, { headers: { authorization: `Bearer ${tok}` } })).json();
    assert.equal(got.transport.mode, 'starttls');
  } finally { srv.close(); }
});

// ── 연결 ─────────────────────────────────────────────────────────────────────
test('S-03 ⑤ StartTLS 를 서버가 거부하면 bind 를 하지 않는다(평문으로 내려가지 않는다)', async () => {
  const s = await ldapServer({ starttls: 'none' });
  writeExisting({ url: `ldap://127.0.0.1:${s.port}`, startTls: true });
  assert.equal(await ad.authenticateAD(USER, PW), null);
  assert.equal(s.stat.binds, 0, 'bind 호출 0');
  assert.equal(ad.lastAdAuthFailure()?.stage, 'starttls');
});

test('S-03 ⑥ StartTLS 성공 응답 뒤 TLS 협상이 실패해도 bind 를 하지 않는다', async () => {
  const s = await ldapServer({ starttls: 'accept-no-tls' });
  writeExisting({ url: `ldap://127.0.0.1:${s.port}`, startTls: true, timeoutMs: 2000 });
  assert.equal(await ad.authenticateAD(USER, PW), null);
  assert.equal(s.stat.exops, 1, 'StartTLS 요청은 갔다');
  assert.equal(s.stat.binds, 0, 'TLS 가 서지 않았으므로 bind 0');
});

test('S-03 ⑦ LDAPS — 맞는 사설 CA 면 성공(역할 매핑까지), 다른 CA·다른 이름이면 bind 전에 실패', async (t) => {
  if (!pki) { t.skip('openssl 없음'); return; }
  const s = await ldapServer({ tls: true });
  writeExisting({ url: `ldaps://127.0.0.1:${s.port}`, caCert: pki.ca2, tlsRejectUnauthorized: true });
  assert.equal(await ad.authenticateAD(USER, PW), null, '신뢰하지 않는 CA');
  assert.equal(s.stat.binds, 0);
  // 검증 표지가 null·빈 값으로 저장돼 있어도 검증은 켜진 것이다(화면·상태가 '검증 켬' 이라 말하는 것과 실제가 같아야 한다).
  writeExisting({ url: `ldaps://127.0.0.1:${s.port}`, caCert: pki.ca2, tlsRejectUnauthorized: null });
  assert.equal(ad.adTransportStatus().verify, true);
  assert.equal(await ad.authenticateAD(USER, PW), null, 'null 표지 — 여전히 신뢰하지 않는 CA 를 거부');
  assert.equal(s.stat.binds, 0);
  writeExisting({ url: `ldaps://127.0.0.1:${s.port}`, caCert: pki.ca1, tlsRejectUnauthorized: true, tlsServerName: 'wrong.example' });
  assert.equal(await ad.authenticateAD(USER, PW), null, '인증서 이름 불일치');
  assert.equal(s.stat.binds, 0);
  writeExisting({ url: `ldaps://127.0.0.1:${s.port}`, caCert: pki.ca1, tlsRejectUnauthorized: true });
  const u = await ad.authenticateAD(USER, PW);
  assert.equal(u?.role, 'admin', JSON.stringify(ad.lastAdAuthFailure()));
  assert.equal(u?.source, 'ad');
  assert.ok(u?.adEpoch, '판정에 쓴 정책 epoch 를 함께 돌려준다(S-08)');
  assert.equal(s.stat.binds, 1);
});

test('S-03 ⑧ 연결 테스트 — 평문이면 테스트 비밀번호도 보내지 않고(연결만), LDAPS 는 단계·방식을 밝힌다', async (t) => {
  const plain = await ldapServer({});
  writeExisting({ url: `ldap://127.0.0.1:${plain.port}` });
  const r1 = await ad.testAd(null, USER, PW);
  assert.equal(r1.ok, false);
  assert.equal(r1.stage, 'policy');
  assert.equal(plain.stat.binds, 0);
  const r2 = await ad.testAd(null);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.mode, 'plain');
  if (!pki) { t.skip('openssl 없음'); return; }
  const s = await ldapServer({ tls: true });
  const r3 = await ad.testAd({ url: `ldaps://127.0.0.1:${s.port}`, caCert: pki.ca1 }, USER, PW);
  assert.equal(r3.ok, true, JSON.stringify(r3));
  assert.equal(r3.mode, 'ldaps');
  assert.equal(r3.role, 'admin');
  const r4 = await ad.testAd({ url: `ldaps://127.0.0.1:${s.port}`, caCert: pki.ca2 }, USER, PW);
  assert.equal(r4.ok, false);
  assert.equal(r4.stage, 'connect');
});

test('S-03 ⑨ 이미 저장된 평문 설정은 동작을 유지한다(경고만) · 로그인 실패 응답 문구는 그대로', async () => {
  const s = await ldapServer({});
  writeExisting({ url: `ldap://127.0.0.1:${s.port}` });
  const u = await ad.authenticateAD(USER, PW);
  assert.equal(u?.role, 'admin');
  assert.equal(s.stat.binds, 1);
  const express = (await import('express')).default;
  const { authRouter } = await import('../src/routes/auth.js');
  const app = express(); app.use(express.json()); app.use('/api/auth', authRouter);
  const srv = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  try {
    writeExisting({ url: 'ldap://127.0.0.1:1', startTls: true, timeoutMs: 1000 });
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'nobody.ad', password: 'x' }) });
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: 'invalid credentials' }, '계정 열거를 막는 기존 문구 그대로');
  } finally { srv.close(); }
});
