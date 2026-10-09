/**
 * 2026-10-09 검토 S-08 — AD 토큰도 정책을 따른다. 실제 로그인(합성 LDAP 서버) → 실제 authRouter → resolveTokenUser(HTTP·WS 공통).
 *   · AD 토큰은 src:'ad' + 정책 epoch(ep) + sid 를 싣는다.
 *   · AD 를 끄거나 역할 결정 필드(그룹·기본 역할·URL·도메인…)를 바꾸면 그 전에 발급된 AD 토큰은 무효 + 출처 폐기 이벤트.
 *     다시 켜도(되돌려도) 예전 토큰은 살아나지 않는다(카운터).
 *   · 도메인 쪽 변경(계정 비활성화·그룹 제거)은 매 요청 LDAP 없이 'AD 세션 상한'(기본 12h) 안에 반영 — 연장으로도 넘지 못한다.
 *   · 로컬 토큰은 영향이 없다 · 구버전 무표지 토큰은 업그레이드 뒤 AD 정책이 한 번도 바뀌지 않았을 때만 호환.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rvF-adsess-'));
Object.assign(process.env, { CONFIG_DIR: tmp, AUTH_ENABLED: 'true', AUTH_SECRET: 'rvF-adsess-secret-0123456789abcdefghij', AUTH_TOKEN_TTL: '8h', DATA_SOURCE: 'mock' });
const require = createRequire(new URL('../package.json', import.meta.url));
const ldap = require('ldapjs');

const USER = 'cn=kim,dc=corp,dc=local';
const PW = 'Ad#Pass12345';
const H = 3600;
const T0 = 1_900_000_000;
const realNow = Date.now;
const at = (s) => { Date.now = () => s * 1000; };
const decode = (t) => JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString());

let A; let ad; let sec; let rev; let ldapSrv; let srv; let base;
const events = [];

before(async () => {
  A = await import('../src/auth/auth.js');
  ad = await import('../src/auth/ad.js');
  sec = await import('../src/security/securitySettings.js');
  rev = await import('../src/auth/sessionRevocation.js');
  rev.onSessionRevoked((e) => events.push(e));
  ldapSrv = ldap.createServer();
  ldapSrv.bind('dc=corp,dc=local', (req, res, next) => {
    if (String(req.dn).toLowerCase() === USER && req.credentials === PW) { res.end(); return next(); }
    return next(new ldap.InvalidCredentialsError());
  });
  ldapSrv.search('dc=corp,dc=local', (req, res, next) => {
    res.attributes = res.attributes.map((a) => String(a).toLowerCase()); // ldapjs 서버 속성 대소문자 버릇
    res.send({ dn: USER, attributes: { sAMAccountName: USER, memberOf: ['CN=Portal-Admins,OU=Groups,DC=corp,DC=local'], displayName: 'Kim AD' } });
    res.end(); return next();
  });
  await new Promise((r) => ldapSrv.listen(0, '127.0.0.1', r));
  // '이미 저장돼 있던' 평문 설정(기존 현장 흉내 — 저장 경로는 새 평문을 거부하지만 기존 설정은 동작을 유지한다).
  fs.writeFileSync(path.join(tmp, 'auth.json'), JSON.stringify({ ad: { enabled: true, url: `ldap://127.0.0.1:${ldapSrv.address().port}`, domain: '', baseDN: 'dc=corp,dc=local', adminGroup: 'Portal-Admins', defaultRole: 'viewer', timeoutMs: 3000 } }));
  A.createUser({ username: 'rvf.local', role: 'viewer', password: 'Local#Pass12345' }, { trusted: true });
  sec.saveSessionSecurity({ idleLogoutEnabled: false, singleSession: false, sessionMaxHours: 0 });
  const express = (await import('express')).default;
  const { authRouter } = await import('../src/routes/auth.js');
  const app = express(); app.use(express.json()); app.use('/api/auth', authRouter);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api/auth`;
});
after(() => {
  Date.now = realNow;
  try { srv?.close(); } catch { /* */ }
  try { ldapSrv?.close(); } catch { /* */ }
  import('../src/auth/sessionState.js').then((s) => s._resetSessionStateForTest()).catch(() => {});
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
});

async function login(username, password) {
  const r = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  return body;
}
const me = async (tok) => {
  const r = await fetch(`${base}/me`, { headers: { authorization: `Bearer ${tok}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('S-08 ⓪ 구버전 무표지 AD 토큰 — 정책이 바뀐 적 없으면 호환(통과)', () => {
  at(T0);
  const legacy = A.signToken({ sub: 'legacy.ad', role: 'admin', name: 'legacy' });
  assert.equal(A.resolveTokenUser(legacy)?.role, 'admin');
  assert.equal(ad.adPolicyState().counter, 0, '전제: 아직 AD 정책이 바뀐 적 없다');
  assert.equal(A.resolveTokenUser(A.signToken({ sub: 'x.y', role: 'admin', name: 'x', src: 'saml' })), null, '모르는 출처 표지는 구버전 호환 경로로도 통과하지 않는다');
});

test('S-08 ① 실제 AD 로그인 — 토큰에 src·ep·sid, 응답에는 epoch 를 싣지 않는다', async () => {
  at(T0);
  const body = await login(USER, PW);
  const p = decode(body.token);
  assert.equal(p.src, 'ad');
  assert.match(String(p.ep), /^\d+\.[0-9a-f]{12}$/);
  assert.ok(p.sid);
  assert.equal(body.user.adEpoch, undefined);
  const m = await me(body.token);
  assert.equal(m.status, 200);
  assert.equal(m.body.user.role, 'admin');
  assert.equal(m.body.user.authSrc, 'ad');
  assert.deepEqual(m.body.user.scope, { vcenters: [], regions: [], writeVcenters: [] }, "AD 사용자의 '빈 scope = 전체' 규칙은 그대로");
});

test('S-08 ② 관련 없는 저장(타임아웃)은 기존 AD 토큰을 끊지 않는다', async () => {
  at(T0);
  const tok = (await login(USER, PW)).token;
  ad.saveAdConfig({ timeoutMs: 4000 });
  assert.equal((await me(tok)).status, 200);
});

test('S-08 ③ AD 비활성화 → 기존 AD 토큰 거부(HTTP·resolveTokenUser) + 출처 폐기 이벤트 · 로컬 토큰은 무영향', async () => {
  at(T0);
  const adTok = (await login(USER, PW)).token;
  const localTok = (await login('rvf.local', 'Local#Pass12345')).token;
  events.length = 0;
  ad.saveAdConfig({ enabled: false });
  assert.equal((await me(adTok)).status, 401, '예전(v2.729)에는 AD 를 꺼도 기존 AD 토큰이 admin 으로 통과했다');
  assert.equal(A.resolveTokenUser(adTok), null);
  assert.ok(events.some((e) => e.scope === 'source' && e.source === 'ad' && e.reason === 'ad-disabled'), JSON.stringify(events));
  assert.equal((await me(localTok)).status, 200, '로컬 토큰은 AD 정책과 무관');
  // 다시 켜도(파일을 직접 되돌려도) 예전 토큰은 살아나지 않는다 — 카운터가 올라 있다.
  const f = path.join(tmp, 'auth.json');
  const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
  cfg.ad.enabled = true;
  fs.writeFileSync(f, JSON.stringify(cfg));
  ad.invalidateAdPolicyCache();
  assert.equal((await me(adTok)).status, 401);
  assert.equal((await me((await login(USER, PW)).token)).status, 200, '다시 켠 뒤의 새 로그인은 정상');
});

test('S-08 ④ 역할 매핑 변경 → 기존 AD 토큰 거부, 새 로그인은 새 매핑 역할', async () => {
  at(T0);
  const tok = (await login(USER, PW)).token;
  events.length = 0;
  ad.saveAdConfig({ adminGroup: 'Other-Admins' });
  assert.equal((await me(tok)).status, 401);
  assert.ok(events.some((e) => e.scope === 'source' && e.source === 'ad' && e.reason === 'ad-policy-changed'));
  const fresh = await login(USER, PW);
  assert.equal((await me(fresh.token)).body.user.role, 'viewer', '그룹이 더는 맞지 않아 기본 역할');
  ad.saveAdConfig({ adminGroup: 'Portal-Admins' });
  assert.equal((await me(fresh.token)).status, 401, 'A→B→A 로 되돌려도 B 시절 토큰은 무효(카운터)');
});

test('S-08 ⑤ 구버전 무표지 토큰은 AD 정책이 한 번이라도 바뀐 뒤에는 무효', () => {
  at(T0);
  assert.ok(ad.adPolicyState().counter > 0, '전제: 위 테스트에서 정책이 바뀌었다');
  assert.equal(A.resolveTokenUser(A.signToken({ sub: 'legacy.ad', role: 'admin', name: 'legacy' })), null);
});

test('S-08 ⑥ AD 세션 상한 — 최초 만료·검사·연장 모두 같은 상한(도메인 변경의 최대 반영 지연)', async () => {
  ad.saveAdConfig({ maxSessionHours: 2 });
  at(T0);
  const tok = (await login(USER, PW)).token;
  const p = decode(tok);
  assert.equal(p.exp - p.lt, 2 * H, 'TTL 8h 보다 AD 상한 2h 가 짧다');
  at(T0 + 2 * H - 1);
  assert.equal((await me(tok)).status, 200);
  at(T0 + 2 * H);
  assert.equal((await me(tok)).status, 401);
  assert.equal(A.resolveTokenUser(tok), null);
  // 연장으로도 넘지 못한다.
  sec.saveSessionSecurity({ sessionWarnEnabled: true, sessionWarnMin: 120, sessionExtendMin: 720 });
  at(T0 + 10 * H);
  const t2 = (await login(USER, PW)).token;
  at(T0 + 10 * H + 60);
  const r = await fetch(`${base}/extend`, { method: 'POST', headers: { authorization: `Bearer ${t2}` } });
  const rb = await r.json();
  assert.equal(r.status, 200, JSON.stringify(rb));
  assert.equal(rb.capped, true);
  assert.equal(decode(rb.token).exp, T0 + 10 * H + 2 * H);
  assert.equal(decode(rb.token).src, 'ad');
  assert.equal(decode(rb.token).ep, decode(t2).ep, '연장 토큰도 epoch·sid 를 승계');
  assert.equal(decode(rb.token).sid, decode(t2).sid);
  ad.saveAdConfig({ maxSessionHours: 12 });
});

test('S-08 ⑦ 모르는 출처 표지는 무효(fail-closed) · 같은 이름 로컬 계정 보호(R2B-01) 유지', async () => {
  at(T0);
  assert.equal(A.resolveTokenUser(A.signToken({ sub: 'x.y', role: 'admin', name: 'x', src: 'saml' })), null);
  const ep = ad.adPolicyState().epoch;
  assert.equal(A.resolveTokenUser(A.signToken({ sub: 'rvf.local', role: 'admin', name: 'x', src: 'ad', ep, sid: 's1' })), null, '로컬 계정과 같은 이름의 AD 토큰');
  assert.ok(A.resolveTokenUser(A.signToken({ sub: 'other.ad', role: 'operator', name: 'x', src: 'ad', ep, sid: 's2' })));
});

test('S-08 ⑧ 파일을 직접 고쳐 AD 를 끈 경우(저장 경로를 거치지 않아 epoch 가 그대로)도 AD 토큰은 거부된다', async () => {
  at(T0);
  const tok = (await login(USER, PW)).token;
  const f = path.join(tmp, 'auth.json');
  const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
  const epBefore = ad.adPolicyState().epoch;
  fs.writeFileSync(f, JSON.stringify({ ad: { ...cfg.ad, enabled: false } }));
  ad.invalidateAdPolicyCache();
  assert.equal(ad.adPolicyState().epoch, epBefore, '전제: 직접 편집은 epoch 를 올리지 않는다');
  assert.equal(A.resolveTokenUser(tok), null, 'epoch 가 같아도 AD 가 꺼져 있으면 무효');
  assert.equal((await me(tok)).status, 401);
  fs.writeFileSync(f, JSON.stringify(cfg));
  ad.invalidateAdPolicyCache();
});
