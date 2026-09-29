/**
 * superAdmin2643.test.js — super_admin 역할 · CSV 권한(data.csv) · CVP 이벤트 호스트명(v2.643) 회귀.
 *
 * 사용자 지시(2026-09-29): "super_admin 이라는 role 을 만들고, csv import/export 기능은 관리자 이상만 …
 * noainred 는 super_admin … csv 설정을 권한 설정 메뉴에 추가 … super_admin 은 super_admin 사용자만 추가/삭제".
 * 선택: CSV 는 **가져오기+내보내기 전부** · 권한 행 1개(admin 은 끌 수 있음 — super_admin 만) · 전체 검증.
 *
 * ⚠ 게이트는 소스 grep 이 아니라 **실제 라우터 스택**(api · adminRouter · svcmonRouter)에서 본다 —
 *   요청 문맥 사용자를 주입해 상태코드로 확인한다(v2.536 규약). 자식 프로세스인 이유: config 싱글턴.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const J = (p) => JSON.stringify(path.join(SRC, p));

function run(script, { matrix = null, users = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superadmin2643-'));
  if (matrix) fs.writeFileSync(path.join(dir, 'permissions.json'), JSON.stringify(matrix));
  if (users) fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify({ users }));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true', AUTH_SECRET: 'x'.repeat(40) },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr.slice(-1500)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력에 결과가 없습니다: ${r.stdout.slice(-600)} ${r.stderr.slice(-600)}`);
  return JSON.parse(line.slice(2));
}

/** CSV·파일 가져오기/내보내기 경로 판정(테스트 소유 — 새 경로가 생기면 게이트가 붙었는지 여기서 걸린다). */
const CSV_RE = /(\.csv|\.txt|\.xlsx|csv-schema|\/import|export|sample|\/tools\/cvp\/bulk\/)/i;
/** 이름은 걸리지만 CSV 파일 입출력이 아닌 것 — 사유와 함께. */
const NOT_CSV = {
  '/tools/link-check/samples': '통신 점검 원시 표본 조회(화면 표) — 파일 입출력이 아니다',
  '/tools/cvp/samples': 'CVP 원문 표본(관리자 진단)',
  '/targets/csv-schema': '성능점검 템플릿 편집 폼의 필드 목록 — 파일 입출력이 아니다(v2.643 에이전트 보고)',
  '/tools/vm-export': 'VM 내보내기 **미리보기**(100행 JSON) — CSV 다운로드는 .csv 경로가 게이트된다',
};

const ENUM = `
  const express = (await import('express')).default;
  const { api } = await import(${J('routes/api.js')});
  const { adminRouter } = await import(${J('routes/admin.js')});
  const { svcmonRouter } = await import(${J('routes/svcmon.js')});
  function walk(router, prefix, out) {
    for (const l of router.stack || []) {
      if (l.route) {
        const gates = [];
        for (const h of l.route.stack) if (h.handle && h.handle.gate) gates.push(h.handle.gate);
        for (const m of Object.keys(l.route.methods)) out.push({ method: m.toUpperCase(), path: prefix + l.route.path, gates });
      } else if (l.handle && l.handle.stack && l.regexp) {
        // 하위 라우터 — 마운트 경로를 정확히 복원하기 어렵다(정규식). 이 저장소의 대상 라우터는 평평하다.
        walk(l.handle, prefix, out);
      }
    }
  }
`;

test('★ CSV·파일 가져오기/내보내기 라우트는 전부 data.csv 권한 게이트를 갖는다(실제 라우터 스택)', () => {
  const out = run(`${ENUM}
    const all = [];
    walk(api, '/api', all); walk(adminRouter, '/api/admin', all); walk(svcmonRouter, '/api/svcmon', all);
    console.log('@@' + JSON.stringify(all));
  `);
  const csv = out.filter((r) => CSV_RE.test(r.path) && !Object.keys(NOT_CSV).some((k) => r.path.endsWith(k))
    // 대량 등록 **실행**(파일이 아닌 화면 선택·배포)은 대상이 아니다.
    && !/agent-deploy\/bulk|\/tools\/ipam\/bulk$|\/idrac\/bulk-add|assign-bulk|targets\/bulk$|edge-users-bulk|bulk-auto-register/.test(r.path));
  assert.ok(csv.length >= 80, `대상 경로가 너무 적습니다(${csv.length}) — 판정식이 깨졌나?`);
  const missing = csv.filter((r) => !r.gates.some((g) => g.kind === 'perm' && g.arg.includes('data.csv')));
  assert.deepEqual(missing.map((r) => `${r.method} ${r.path}`), [], 'data.csv 게이트가 없는 CSV 경로');
});

test('★ 상태코드 — operator·viewer 403 · admin 통과 · admin 권한 끄면 403 · super_admin 은 항상 통과', () => {
  const script = (users) => `
    const express = (await import('express')).default;
    const { api } = await import(${J('routes/api.js')});
    const out = {};
    for (const [label, user] of ${JSON.stringify(users)}) {
      const app = express();
      app.use((req, _res, next) => { req.user = { ...user, scope: { vcenters: [], regions: [], writeVcenters: [] } }; next(); });
      app.use('/api', api);
      const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
      const base = 'http://127.0.0.1:' + srv.address().port;
      const r1 = await fetch(base + '/api/tools/storage/devices/sample.csv');
      const b1 = r1.status === 403 ? await r1.json() : null;
      const r2 = await fetch(base + '/api/tools/gpu.csv');
      out[label] = { sample: r1.status, gpu: r2.status, perm: b1 && b1.requiredPerm };
      srv.close();
    }
    console.log('@@' + JSON.stringify(out));
  `;
  const U = [
    ['viewer', { username: 'v', role: 'viewer' }],
    ['operator', { username: 'o', role: 'operator' }],
    ['admin', { username: 'a', role: 'admin' }],
    ['super', { username: 's', role: 'admin', superAdmin: true }],
  ];
  const on = run(script(U), { matrix: { schemaVersion: 3, matrix: { operator: ['dashboard', 'tools', 'data.csv'], viewer: ['dashboard', 'tools'] } } });
  assert.equal(on.viewer.gpu, 403); assert.equal(on.operator.gpu, 403);
  assert.deepEqual(on.operator.perm, ['data.csv'], 'operator 행에 data.csv 를 적어 넣어도 관리자 전용이라 버려져야 한다');
  assert.equal(on.operator.sample, 403);
  assert.notEqual(on.admin.sample, 403); assert.notEqual(on.admin.gpu, 403);
  assert.notEqual(on.super.gpu, 403);
  const off = run(script(U), { matrix: { schemaVersion: 3, matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard'], adminDenied: ['data.csv'] } } });
  assert.equal(off.admin.sample, 403, 'super_admin 이 끈 뒤에도 admin 이 CSV 를 쓸 수 있다');
  assert.equal(off.admin.gpu, 403);
  assert.notEqual(off.super.sample, 403, 'super_admin 은 끌 수 없다(잠김 방지)');
});

test('★ 권한 매트릭스 — admin 행(CSV)은 super_admin 만 바꾼다 · 값이 그대로면 admin 저장도 통과', () => {
  const users = [
    { username: 'noainred', name: 'n', role: 'admin', superuser: true },
    { username: 'adm', name: 'a', role: 'admin' },
    { username: 'sup2', name: 's', role: 'super_admin' },
  ];
  const out = run(`
    const express = (await import('express')).default;
    const { adminRouter } = await import(${J('routes/admin.js')});
    const auth = await import(${J('auth/auth.js')});
    const res = {};
    async function call(user, method, url, body) {
      const app = express(); app.use(express.json());
      app.use((req, _r, n) => { req.user = { ...user, scope: { vcenters: [], regions: [], writeVcenters: [] } }; n(); });
      app.use('/api/admin', adminRouter);
      const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
      const r = await fetch('http://127.0.0.1:' + srv.address().port + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const j = await r.json().catch(() => null); srv.close(); return { s: r.status, j };
    }
    const A = { username: 'adm', role: 'admin' };
    const S = { username: 'noainred', role: 'admin', superAdmin: true };
    res.noainredRole = auth.getUser('noainred').role;
    res.getAdmin = (await call(A, 'GET', '/api/admin/permissions')).j.canEditAdminRow;
    res.getSuper = (await call(S, 'GET', '/api/admin/permissions')).j.canEditAdminRow;
    res.adminOff = (await call(A, 'PUT', '/api/admin/permissions', { adminDenied: ['data.csv'] })).s;
    res.adminSame = (await call(A, 'PUT', '/api/admin/permissions', { operator: ['dashboard'], adminDenied: [] })).s;
    res.superOff = (await call(S, 'PUT', '/api/admin/permissions', { adminDenied: ['data.csv'] })).s;
    res.adminReset = (await call(A, 'POST', '/api/admin/permissions/reset')).s;
    res.adminPermsAfter = (await import(${J('auth/permissions.js')})).userPermissions({ role: 'admin' }).includes('data.csv');
    // 계정 경계
    res.adminCreatesSuper = auth.createUser({ username: 'x-super', role: 'super_admin' }, { actor: 'adm' });
    res.superCreatesSuper = auth.createUser({ username: 'y-super', role: 'super_admin' }, { actor: 'noainred' }).ok;
    res.adminDeletesSuper = auth.deleteUser('sup2', { actor: 'adm' });
    res.adminPwSuper = auth.setLocalPassword('sup2', 'abcdefgh123', { actor: 'adm' });
    res.adminDemotesSuper = auth.updateUser('sup2', { role: 'viewer' }, { actor: 'adm' });
    res.adminPromotes = auth.updateUser('adm', { role: 'super_admin' }, { actor: 'adm' });
    res.superDeletesSuper = auth.deleteUser('y-super', { actor: 'sup2' }).ok;
    res.adminBeginOtp = auth.beginTotpEnroll('sup2', '', { actor: 'adm' }).ok;
    // 중앙 배포로 super_admin 을 만들 수 없다
    res.managed = auth.applyManagedUsers([{ username: 'm-super', role: 'super_admin' }]).skipped;
    console.log('@@' + JSON.stringify(res));
  `, { users });
  assert.equal(out.noainredRole, 'super_admin', 'noainred 가 super_admin 으로 올라가야 한다');
  assert.equal(out.getAdmin, false); assert.equal(out.getSuper, true);
  assert.equal(out.adminOff, 403, 'admin 이 admin 행을 바꿀 수 있다');
  assert.equal(out.adminSame, 200, '값이 그대로인 adminDenied 때문에 admin 의 저장이 막혔다');
  assert.equal(out.superOff, 200);
  assert.equal(out.adminReset, 403, 'admin 이 초기화로 super_admin 의 결정을 되돌렸다');
  assert.equal(out.adminPermsAfter, false);
  assert.equal(out.adminCreatesSuper.ok, false); assert.equal(out.adminCreatesSuper.code, 'super-admin-only');
  assert.equal(out.superCreatesSuper, true);
  assert.equal(out.adminDeletesSuper.ok, false);
  assert.equal(out.adminPwSuper.ok, false);
  assert.equal(out.adminDemotesSuper.ok, false);
  assert.equal(out.adminPromotes.ok, false, 'admin 이 자기 자신을 super_admin 으로 올렸다');
  assert.equal(out.superDeletesSuper, true);
  assert.equal(out.adminBeginOtp, false, 'admin 이 super_admin 의 OTP 를 대리 등록했다(계정 탈취)');
  assert.ok(out.managed.some((x) => x.startsWith('m-super')));
});

test('★ 요청 문맥 — super_admin 토큰은 role:admin + superAdmin:true, 권한은 전체(CSV 끔과 무관)', () => {
  const out = run(`
    const auth = await import(${J('auth/auth.js')});
    const perms = await import(${J('auth/permissions.js')});
    const u = auth.getUser('sup2');
    const tok = auth.signToken({ sub: 'sup2', role: 'admin', name: 's', src: 'local', tv: u.tokenVersion || 0 });
    const me = auth.resolveTokenUser(tok);
    console.log('@@' + JSON.stringify({ me, csv: perms.userHasPermission(me, 'data.csv'), adminCsv: perms.userHasPermission({ role: 'admin' }, 'data.csv') }));
  `, { users: [{ username: 'sup2', name: 's', role: 'super_admin' }, { username: 'adm', role: 'admin' }], matrix: { schemaVersion: 3, matrix: { adminDenied: ['data.csv'] } } });
  assert.equal(out.me.role, 'admin'); assert.equal(out.me.superAdmin, true);
  assert.equal(out.csv, true); assert.equal(out.adminCsv, false);
});

test('CVP 이벤트 — 장비 식별자(시리얼)를 호스트명·장비 키로 풀어 싣는다 · 못 찾으면 원문', () => {
  const out = run(`
    const cdb = await import(${J('cvp/db.js')});
    await cdb.saveDevices({ cvpId: 'c1', devices: [{ key: 'SN1', ts: Date.now(), hostname: 'SW-A', serial: 'SN1', model: 'm' }] });
    const idx = await cdb.deviceNameIndex({ cvpId: 'c1' });
    console.log('@@' + JSON.stringify(idx));
  `);
  assert.ok(out.rows.some((r) => r.serial === 'SN1' && r.hostname === 'SW-A' && r.key === 'SN1'), JSON.stringify(out));
});
