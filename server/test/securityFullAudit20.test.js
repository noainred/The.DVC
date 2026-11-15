/**
 * securityFullAudit20.test.js — 전체 점검 20회차(19회차 보안 수정 반증) 확정분.
 *  F1 관리자 라우트를 자기 자신에게 쓰는 OTP 재등록 · 해제 · 비밀번호 설정 · 로그인 차단도 현재 OTP(판정 하나 auth/otpRebind.js)
 *  F2 등록 강제가 아닌 미등록 세션은 본인 OTP 를 더하지 못한다 · F3 users.json 읽기 오류 중 AD 로그인 금지(로컬 이름 방패)
 *  F4 읽기 오류는 확정 불가 · 사유 정확 · F5 권한 파일 오류 중 부분 저장 거절 · F6 진행 중 묶음 키는 AD 표기 변형을 하나로
 *  F7 로그인 429 는 서버 문구 · F8 확정 게이트 ≥ 쓰기 게이트(소유자 · super_admin) · F9 읽기 오류 중 계정 생성 · 중앙 배포 적용 금지
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secfa20-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_DIR = tmp;
process.env.AUTH_ENABLED = 'true';
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const HERE = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.join(HERE, '../src');
const sub = (setup, code) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sec20sub-'));
  try {
    setup(d);
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, CONFIG_DIR: d, DATA_DIR: d, AUTH_ENABLED: 'true' }, encoding: 'utf8' });
    const line = r.stdout.trim().split('\n').pop();
    try { return JSON.parse(line); } catch { throw new Error(`${r.stdout}\n${r.stderr}`); }
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
};

let A, T, srv, base;
const U = {};
test.before(async () => {
  A = await import('../src/auth/auth.js');
  T = await import('../src/auth/totp.js');
  assert.equal(A.createUser({ username: 'adm2', role: 'admin', password: 'Passw0rd!Passw0rd!x' }, { trusted: true }).ok, true);
  const b = A.beginTotpEnroll('adm2', '', { trusted: true });
  assert.equal(A.confirmTotpEnroll('adm2', T.generateToken(b.secret), { trusted: true }).ok, true);
  assert.equal(A.createUser({ username: 'vw1', role: 'viewer', password: 'Passw0rd!Passw0rd!y' }, { trusted: true }).ok, true);
  U.adm2 = { username: 'adm2', role: 'admin', scope: null, authSrc: 'local' };
  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express(); app.use(express.json());
  app.use((req, _r, next) => { req.user = U[req.headers['x-u']] || null; next(); });
  app.use('/api/admin', adminRouter);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}`;
});
test.after(() => srv?.close());
const call = async (who, method, p, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', 'x-u': who }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('F1 — 자기 자신 대상 관리자 라우트 5종은 현재 OTP 없이 403 needCurrentOtp · 타인 대상은 그대로', async () => {
  const sec0 = A.getUser('adm2').totpSecret; const pw0 = A.getUser('adm2').passwordHash;
  for (const [m, p, body] of [['POST', '/api/admin/users/adm2/totp/begin', {}], ['POST', '/api/admin/users/adm2/totp/disable', {}],
    ['POST', '/api/admin/users/adm2/password', { password: 'NewPassw0rd!x' }], ['DELETE', '/api/admin/users/adm2/password', {}], ['POST', '/api/admin/users/adm2/totp/confirm', { code: '000000' }]]) {
    const r = await call('adm2', m, p, body);
    assert.equal(r.status, 403, `${m} ${p} ${JSON.stringify(r.body)}`); assert.equal(r.body.needCurrentOtp, true);
  }
  assert.equal(A.getUser('adm2').totpSecret, sec0, '거절이 OTP 를 바꾸지 않았다'); assert.equal(A.getUser('adm2').passwordHash, pw0, '비밀번호도 그대로');
  const other = await call('adm2', 'POST', '/api/admin/users/vw1/totp/begin', {});
  assert.equal(other.status, 200, `타인 대상 대리 등록은 그대로 ${JSON.stringify(other.body)}`);
  // 현재 코드로 시작 → 10분 안 확정
  const now = Math.floor(Date.now() / 1000 / 30);
  const ok = await call('adm2', 'POST', '/api/admin/users/adm2/totp/begin', { currentCode: T.generateToken(A.getUser('adm2').totpSecret, { counter: now + 1 }) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const conf = await call('adm2', 'POST', '/api/admin/users/adm2/totp/confirm', { code: T.generateToken(ok.body.secret) });
  assert.equal(conf.status, 200, JSON.stringify(conf.body));
  const web = fs.readFileSync(path.join(HERE, '../../web/src/views/UserAdmin.jsx'), 'utf8');
  assert.match(web, /async function withCurrentOtp\(call\)/); assert.equal((web.match(/withCurrentOtp\(/g) || []).length, 5, '화면 4곳 + 정의');
});

test('F2 — 등록 강제가 아닌 미등록 세션은 본인 OTP 등록을 못 한다', async () => {
  const express = (await import('express')).default;
  const { authRouter } = await import('../src/routes/auth.js');
  const app = express(); app.use(express.json()); app.use('/api/auth', authRouter);
  const s2 = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const u = A.getUser('vw1');
    const tok = A.signToken({ sub: 'vw1', role: 'viewer', src: 'local', tv: u.tokenVersion || 0, sid: 'sid-vw1' });
    A.noteIssuedSession({ sub: 'vw1', sid: 'sid-vw1', exp: Math.floor(Date.now() / 1000) + 3600 });
    const me = await (await fetch(`http://127.0.0.1:${s2.address().port}/api/auth/me`, { headers: { authorization: `Bearer ${tok}` } })).json();
    assert.notEqual(me?.user?.mustEnrollOtp ?? me?.mustEnrollOtp, true, '이 계정은 등록 강제가 아니다(전제)');
    for (const p of ['/totp/begin', '/totp/confirm']) {
      const r = await fetch(`http://127.0.0.1:${s2.address().port}/api/auth${p}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: '{"code":"000000"}' });
      assert.equal(r.status, 403, p);
    }
  } finally { s2.close(); }
});

test('F3 · F9 — users.json 읽기 오류 중: 어떤 이름도 AD 로 받지 않고 · 계정 생성 · 중앙 배포 적용 거절', () => {
  const out = sub((d) => fs.mkdirSync(path.join(d, 'users.json')), `const a = await import(${JSON.stringify(path.join(SRC, 'auth/auth.js'))});
    a.loadUsers(); let applied = 'none'; try { a.applyManagedUsers([{ username: 'cadmin', role: 'admin', passwordHash: 'x' }]); applied = 'applied'; } catch (e) { applied = 'refused'; }
    console.log(JSON.stringify({ taken: a.localNameTaken('noainred'), anyTaken: a.localNameTaken('whoever'), create: a.createUser({ username: 'x1', role: 'viewer', password: 'Passw0rd!Passw0rd!' }, { trusted: true }).ok, applied, n: a.loadUsers().length }));`);
  assert.equal(out.taken, true); assert.equal(out.anyTaken, true, 'AD 를 시도하지 않는다');
  assert.equal(out.create, false); assert.equal(out.applied, 'refused'); assert.equal(out.n, 0);
});

test('F4 · F5 — 권한 파일: 읽기 오류는 확정 불가 · 사유 정확 · 손상 중 부분 저장 거절 · 초기화는 손상일 때만', () => {
  const code = `const m = await import(${JSON.stringify(path.join(SRC, 'auth/permissions.js'))});
    const u = await import(${JSON.stringify(path.join(SRC, 'util/settingsLoadError.js'))});
    m.loadMatrix(); const row = u.listSettingsLoadErrors().find((x) => x.file === 'permissions.json');
    const conf = u.confirmSettingsDefault('permissions.json', { by: 't' });
    const tools = m.setUserTools('kim', { mode: 'allow', tools: ['ipam'] });
    let save = 'ok'; try { m.saveMatrix({ operator: ['dashboard', 'tools'] }); } catch (e) { save = e.code; }
    let reset = 'ok'; try { m.resetMatrix(); } catch (e) { reset = e.code; }
    console.log(JSON.stringify({ row, conf, tools, save, reset, stillErr: !!m.permissionsLoadError() }));`;
  const rd = sub((d) => fs.mkdirSync(path.join(d, 'permissions.json')), code);
  assert.equal(rd.row.confirmable, false); assert.equal(rd.row.readError, true); assert.doesNotMatch(rd.row.reason, /옮겼습니다/);
  assert.equal(rd.conf.code, 'not-confirmable');
  assert.equal(rd.tools.ok, false); assert.equal(rd.save, 'permissions-unreadable'); assert.equal(rd.reset, 'permissions-unreadable', '읽기 오류는 초기화도 거절');
  const bad = sub((d) => fs.writeFileSync(path.join(d, 'permissions.json'), '{"matrix":{'), code.replace("const conf = u.confirmSettingsDefault('permissions.json', { by: 't' });", 'const conf = null;'));
  assert.equal(bad.row.confirmable, true); assert.equal(bad.tools.ok, false); assert.equal(bad.save, 'permissions-unreadable');
  assert.equal(bad.reset, 'ok', '손상은 초기화(명시적 전체 결정)로 풀 수 있다'); assert.equal(bad.stillErr, false);
});

test('F6 — 진행 중 묶음 키: kim · KIM · kim@corp · CORP\\kim 동시 로그인은 DC 에 한 번', async () => {
  let conns = 0;
  const dc = net.createServer((s) => { conns += 1; s.on('error', () => {}); });
  await new Promise((r) => dc.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(tmp, 'auth.json'), JSON.stringify({ ad: { enabled: true, url: `ldap://127.0.0.1:${dc.address().port}`, timeoutMs: 1500 } }));
  const express = (await import('express')).default;
  const { authRouter } = await import('../src/routes/auth.js');
  const app = express(); app.use(express.json()); app.use('/api/auth', authRouter);
  const s3 = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const url = `http://127.0.0.1:${s3.address().port}/api/auth/login`;
    await Promise.all(['kimx', 'KIMX', 'kimx@corp.local', 'CORP\\kimx'].map((username) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'Guess!1' }) })));
    assert.ok(conns <= 1, `DC 도달 ${conns}회(수정 전 4회)`);
  } finally { s3.close(); dc.close(); fs.rmSync(path.join(tmp, 'auth.json'), { force: true }); }
});

test('F7 · F8 — 로그인 429 문구 · 확정 게이트(소유자 · super_admin)', async () => {
  const web = fs.readFileSync(path.join(HERE, '../../web/src/api.js'), 'utf8');
  assert.match(web, /if \(res\.status === 429\) \{ try \{ srv = String\(\(await res\.json\(\)\)\?\.error \|\| ''\)\.slice\(0, 200\); \}/);
  await import('../src/bmusage/slo.js'); await import('../src/bmusage/perfRules.js'); await import('../src/bmusage/tuning/overrides.js'); await import('../src/isidu/settings.js');
  const { settingsFileOwnerOnly, settingsFileSuperOnly } = await import('../src/util/settingsLoadError.js');
  for (const f of ['bm-perf-slo.json', 'bm-perf-rules.json', 'bmusage-tuning.json']) assert.equal(settingsFileOwnerOnly(f), true, f);
  assert.equal(settingsFileSuperOnly('isidu-settings.json'), true);
  const src = fs.readFileSync(path.join(SRC, 'routes/api/checksLogs.js'), 'utf8');
  assert.match(src, /if \(settingsFileSuperOnly\(file\) && !isSuperAdmin\(req\.user\)\) return res\.status\(403\)/);
});
