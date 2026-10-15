/**
 * test/isiduSuper2740.test.js — v2.740 아이실론 디렉터리 사용량 '수집 대상 설정' 은 슈퍼 관리자 전용이다.
 *   사용자 요청(2026-10-15): "수집 대상 설정은 설정 메뉴로 이동해서 일반 사용자, 관리자는 못 보게".
 *   화면 메뉴 숨김(웹 Settings.jsx superOnly)은 표시 게이팅일 뿐이다 — 서버 설정 API 가 집행해야 한다(CLAUDE.md '서버가 진실의 원천').
 *   ① 역할 admin(슈퍼 관리자 아님)은 설정 6경로에서 403 super-admin-only + requiredRole ['super_admin'](화면 권한 안내가 배열만 읽는다)
 *   ② 슈퍼 관리자는 같은 경로가 403 이 아니다
 *   ③ 결과 화면·'지금 수집' 은 관리자에게 그대로 열려 있다(옮긴 것은 설정뿐)
 *   ④ 운영자·범위 관리자는 예전처럼 막힌다(게이트 순서 — adminOnly·fullScopeOnly 가 먼저)
 *   ⑤ 게이트 표지(아키텍처 점검이 읽는다)와 판정 함수가 하나다(userMenu 의 사본을 지웠다)
 * 실제 api 라우터를 express 에 마운트해 상태코드로 본다(소스 grep 이 아니다 — v2.506 규약).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'isiduSuper2740-'));
// 인증을 켠다 — 꺼져 있으면 requireRole 이 익명 역할(admin)로 통과시켜 운영자 검사가 무의미하다(v2.633 기록).
Object.assign(process.env, { CONFIG_DIR: TMP, DATA_SOURCE: 'live', AUTH_ENABLED: 'true' });
delete process.env.CENTRAL_URL;
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const { api } = await import('../src/routes/api.js');
const roles = await import('../src/auth/roles.js');

const ADMIN = { username: 'adm', role: 'admin', scope: {} };
const SUPER = { username: 'noainred', role: 'admin', superAdmin: true, scope: {} };
const OPERATOR = { username: 'op', role: 'operator', scope: {} };
const SCOPED_ADMIN = { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-1'] } };

async function call(user, method, url, body) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api', api);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err?.message || err) }));
  const srv = http.createServer(app); const port = await listen(srv);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api${url}`, {
      method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally { srv.closeAllConnections?.(); srv.close(); }
}

// 설정으로 옮긴 경로 전부 — 하나라도 빠지면 관리자가 주소로 직접 설정을 바꾼다.
const SETTINGS_ROUTES = [
  ['GET', '/tools/isilon-dirusage/settings'],
  ['PUT', '/tools/isilon-dirusage/settings', { targets: [] }],
  ['POST', '/tools/isilon-dirusage/bulk', { ids: [], dryRun: true }],
  ['POST', '/tools/isilon-dirusage/test', {}],
  ['POST', '/tools/isilon-dirusage/mail-now', {}],
  ['POST', '/tools/isilon-dirusage/key', {}],
];

test('① 역할 admin 은 설정 6경로에서 403 super-admin-only · requiredRole 은 배열', async () => {
  for (const [m, u, b] of SETTINGS_ROUTES) {
    const r = await call(ADMIN, m, u, b);
    assert.equal(r.status, 403, `${m} ${u} 는 슈퍼 관리자 전용이어야 한다`);
    assert.equal(r.body?.reason, 'super-admin-only', `${m} ${u} 거부 사유`);
    assert.deepEqual(r.body?.requiredRole, ['super_admin'], `${m} ${u} — 화면 권한 안내(api.js HttpError)는 배열만 읽는다`);
  }
});

test('② 슈퍼 관리자는 설정 경로가 403 이 아니다 · 조회는 200', async () => {
  for (const [m, u, b] of SETTINGS_ROUTES) {
    const r = await call(SUPER, m, u, b);
    assert.notEqual(r.status, 403, `${m} ${u} — 슈퍼 관리자가 막혔다: ${JSON.stringify(r.body)}`);
  }
  const g = await call(SUPER, 'GET', '/tools/isilon-dirusage/settings');
  assert.equal(g.status, 200);
  assert.ok(Array.isArray(g.body?.settings?.targets), '설정 조회는 대상 목록을 준다');
});

test('③ 결과 화면·지금 수집은 역할 admin 에게 그대로 열려 있다', async () => {
  for (const [m, u, b] of [
    ['GET', '/tools/isilon-dirusage'],
    ['GET', '/tools/isilon-dirusage/overview'],
    ['POST', '/tools/isilon-dirusage/run', { ids: [] }],
  ]) {
    const r = await call(ADMIN, m, u, b);
    assert.notEqual(r.status, 403, `${m} ${u} 는 관리자에게 열려 있어야 한다: ${JSON.stringify(r.body)}`);
  }
  const main = await call(ADMIN, 'GET', '/tools/isilon-dirusage');
  assert.equal(main.status, 200);
  assert.ok(Array.isArray(main.body?.targets), '결과 화면은 대상 목록을 받는다');
});

test('④ 운영자·범위 관리자는 슈퍼 관리자 판정에 닿기 전에 예전 게이트에서 막힌다', async () => {
  const op = await call(OPERATOR, 'GET', '/tools/isilon-dirusage/settings');
  assert.equal(op.status, 403);
  assert.deepEqual(op.body?.requiredRole, ['admin'], '운영자는 역할 게이트(admin)에서 막힌다');
  const opMain = await call(OPERATOR, 'GET', '/tools/isilon-dirusage');
  assert.equal(opMain.status, 403, '결과 화면도 예전처럼 관리자 전용');
  const sc = await call(SCOPED_ADMIN, 'GET', '/tools/isilon-dirusage/settings');
  assert.equal(sc.status, 403);
  assert.notEqual(sc.body?.reason, 'super-admin-only', '범위 관리자는 전체 범위 게이트가 먼저 막는다');
  // 범위 관리자가 슈퍼 관리자 표지를 가져도 전체 범위 게이트가 먼저다.
  const scSuper = await call({ ...SCOPED_ADMIN, superAdmin: true }, 'GET', '/tools/isilon-dirusage/settings');
  assert.equal(scSuper.status, 403);
});

test('⑤ requireSuperAdmin 은 auth/roles.js 하나 — 게이트 표지가 있고 userMenu 는 사본을 두지 않는다', () => {
  assert.equal(typeof roles.requireSuperAdmin, 'function');
  assert.equal(roles.requireSuperAdmin.gate?.kind, 'superAdmin', '아키텍처 점검이 게이트 종류를 읽는다');
  const strip = stripComments;   // 2줄 정규식 사본 금지(TESTDOC2613-08 — 줄 주석 안의 슬래시+별이 코드를 지운다)
  const um = strip(fs.readFileSync(new URL('../src/routes/api/userMenu.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(um, /function\s+requireSuperAdmin\s*\(/, 'userMenu.js 에 판정 사본이 남아 있다');
  assert.match(um, /import\s*\{[^}]*\brequireSuperAdmin\b[^}]*\}\s*from\s*'\.\.\/\.\.\/auth\/roles\.js'/);
  const iu = strip(fs.readFileSync(new URL('../src/routes/api/isilonDirUsage.js', import.meta.url), 'utf8'));
  assert.match(iu, /import\s*\{[^}]*\brequireSuperAdmin\b[^}]*\}\s*from\s*'\.\.\/\.\.\/auth\/roles\.js'/);
  // 익명(인증 끔)·표지 없는 사용자는 슈퍼 관리자가 아니다.
  let sent = null;
  const res = { status(c) { sent = { c }; return this; }, json(b) { sent.b = b; return this; } };
  roles.requireSuperAdmin({ user: undefined }, res, () => { sent = 'next'; });
  assert.equal(sent?.c, 403, '사용자 없음은 슈퍼 관리자가 아니다');
  roles.requireSuperAdmin({ user: SUPER }, res, () => { sent = 'next'; });
  assert.equal(sent, 'next');
});
