/**
 * audit2743a.test.js — v2.743(2회차) 수정 그룹 GA: 권한·데모 계정·NFS 마운트·hostAccess·Windows 토큰.
 *
 *  AUTHZ-01  mock 모드 데모 계정(요청 문맥 admin + demoGuest)이 관리자 판본(사람이 등록한 장비의 관리 IP·계정명,
 *            장비 등록부 CSV/TXT 내보내기, 서버 절대 경로)을 받던 것 — 가림 판정 하나(demoGuest.isAdminDetailUser)와
 *            data.csv 제외(permissions)로 operator 와 같은 판본을 준다. 조회 자체는 막지 않는다(v2.716).
 *  AUTHZ-02  범위 관리자가 GET /tools/vm-clone 으로 NFS 서버 주소·export 경로·마운트 절대 경로를 받던 것.
 *  LEFT-09   hostAccess 변경 라우트에 전체 범위 게이트가 없던 것 · uagmon Electron 범위 지정.
 *  INJPKG-01 Windows 에서 화면이 저장한 CENTRAL_TOKEN 이 시작 스크립트가 읽지 않는 파일에 쓰이던 것.
 *
 * ②는 실제 authMiddleware·requireEnrolled 와 실제 api·admin·auth 라우터를 띄워 상태코드·응답 본문으로 본다(소스 grep 아님).
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
const REPO = path.resolve(HERE, '../..');
const J = (p) => JSON.stringify(path.join(SRC, p));

// 순수 모듈들도 config.js 를 거친다 — 저장소의 server/config 를 건드리지 않게 먼저 임시 CONFIG_DIR 을 잡는다.
process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2743a-pure-'));

test('① AUTHZ-01 가림 판정 하나 — 데모 계정은 관리자 판본이 아니다', async () => {
  const { isAdminDetailUser, demoGuestDenial } = await import('../src/auth/demoGuest.js');
  const { isAdminReq } = await import('../src/auth/addressMask.js');
  const { scopeDbStatus, scopeFilePaths, redactPushStatus } = await import('../src/auth/scopeStatus.js');
  const demo = { username: 'thedvcdemp', role: 'admin', demoGuest: true };
  const adm = { username: 'a', role: 'admin' };
  assert.equal(isAdminDetailUser(demo), false);
  assert.equal(isAdminDetailUser(adm), true);
  assert.equal(isAdminDetailUser({ role: 'operator' }), false);
  assert.equal(isAdminDetailUser(null), false);
  assert.equal(isAdminReq({ user: demo }), false);
  assert.equal(isAdminReq({ user: adm }), true);
  // DB·파일 경로 — 데모 계정은 operator 와 같은 판본(경로 없음 / 파일 이름만 + 가린 표지)
  assert.deepEqual(scopeDbStatus({ path: '/x/y.db', rows: 3 }, demo), { rows: 3 });
  assert.deepEqual(scopeDbStatus({ path: '/x/y.db', rows: 3 }, adm), { path: '/x/y.db', rows: 3 });
  assert.deepEqual(scopeFilePaths({ file: '/etc/vmware-portal/a.json' }, demo), { file: 'a.json', pathHidden: true });
  assert.equal(scopeFilePaths({ file: '/etc/vmware-portal/a.json' }, adm).file, '/etc/vmware-portal/a.json');
  const pushed = redactPushStatus({ centralUrl: 'https://central.corp:4000', last: { error: 'connect 10.0.0.1' } }, demo);
  assert.equal(pushed.centralUrl, null);
  assert.equal(pushed.addressHidden, true);
  // 새 READ_DENY — 설정·등록부 조회(관리자 판본만 있는 응답)는 거부, 도구 조회는 그대로
  for (const p of ['/api/tools/cvp/servers', '/api/admin/ipam/db-info', '/api/tools/edge-log-local', '/api/tools/sanswitch/perf/settings', '/api/admin/vclogs/status'])
    assert.ok(demoGuestDenial('GET', p), p);
  for (const p of ['/api/tools/sanswitch', '/api/tools/storage', '/api/tools/cvp', '/api/tools/cvp/devices', '/api/tools/vm-clone', '/api/admin/idrac'])
    assert.equal(demoGuestDenial('GET', p), null, p);
});

test('① AUTHZ-01 data.csv — 데모 계정에는 관리자 전용 키를 주지 않는다(그 밖의 권한은 그대로)', async () => {
  const { userHasPermission, userPermissions, ADMIN_ONLY_KEYS } = await import('../src/auth/permissions.js');
  const demo = { username: 'thedvcdemp', role: 'admin', demoGuest: true };
  const adm = { username: 'a', role: 'admin' };
  assert.ok(ADMIN_ONLY_KEYS.includes('data.csv'));
  assert.equal(userHasPermission(demo, 'data.csv'), false);
  assert.equal(userHasPermission(adm, 'data.csv'), true);
  for (const k of ['tools', 'inv.vms', 'dashboard']) assert.equal(userHasPermission(demo, k), true, k);
  assert.equal(userPermissions(demo).includes('data.csv'), false);
  assert.equal(userPermissions(adm).includes('data.csv'), true);
  assert.ok(userPermissions(demo).includes('tools'));
});

test('③ INJPKG-01 Windows 토큰 값 — cmd 메타문자 거부, 리눅스 판정은 예전 그대로', async () => {
  const { tokenValueIssue, envLineFor, renderEnvFile, startScriptEnvFile, envFilePath, centralTokenInfo } = await import('../src/central/token.js');
  for (const bad of ['a&b', 'a|b', 'a<b', 'a>b', 'a^b', 'a%PATH%b', 'a!b', 'a"b', 'a\nb', 'a\rb'])
    assert.ok(tokenValueIssue(bad, true), JSON.stringify(bad));
  assert.equal(tokenValueIssue('f00dBEEF-_.:=+/', true), null);
  assert.equal(tokenValueIssue('a b', false), '토큰에 공백을 사용할 수 없습니다.');
  for (const v of ['a&b', 'a%b', 'a"b']) assert.equal(tokenValueIssue(v, false), null, v); // 리눅스 portal.env 는 실행되지 않는다 — 동작 불변
  assert.equal(envLineFor('CENTRAL_TOKEN', 'abc', true), 'set "CENTRAL_TOKEN=abc"');
  assert.equal(envLineFor('CENTRAL_TOKEN', 'abc', false), 'CENTRAL_TOKEN=abc');
  assert.equal(path.basename(envFilePath('/c', true)), 'portal.env.bat');
  assert.equal(path.basename(envFilePath('/c', false)), 'portal.env');

  // Windows: 예제 파일 그대로(주석의 rem set CENTRAL_TOKEN 은 다른 줄) → 끝에 추가 · CRLF · 기존 줄 보존
  const example = fs.readFileSync(path.join(REPO, 'packaging/windows/portal.env.example.bat'), 'latin1');
  const out = renderEnvFile(example, 'CENTRAL_TOKEN', 'abc123', true);
  assert.ok(out.endsWith('set "CENTRAL_TOKEN=abc123"\r\n'), out.slice(-60));
  assert.ok(out.includes('rem set CENTRAL_TOKEN=change-me-strong-token\r\n'));
  assert.equal(out.split(/\r?\n/).filter((l) => /^\s*set\s+"?CENTRAL_TOKEN=/i.test(l)).length, 1);
  assert.equal(out.replace(/\r\n/g, '').includes('\n'), false, '모든 줄이 CRLF');
  // 같은 키(따옴표 있음/없음)는 교체 — 두 줄이 되지 않는다
  for (const prev of ['set CENTRAL_TOKEN=old', 'set "CENTRAL_TOKEN=old"', '  SET central_token=old']) {
    const o = renderEnvFile(`@echo off\r\n${prev}\r\nset PORT=4000\r\n`, 'CENTRAL_TOKEN', 'new', true);
    assert.equal(o, '@echo off\r\nset "CENTRAL_TOKEN=new"\r\nset PORT=4000\r\n', prev);
  }
  // 리눅스: 예전 알고리즘과 같은 결과
  const oldLinux = (text, key, val) => {
    const lines = text ? text.split(/\r?\n/) : [];
    const re = new RegExp(`^\\s*(export\\s+)?${key}=`);
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0) lines[i] = `${key}=${val}`; else { if (lines.length && lines[lines.length - 1].trim() !== '') lines.push(''); lines.push(`${key}=${val}`); }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');
  };
  for (const t of ['', 'PORT=4000\n', 'A=1\nCENTRAL_TOKEN=x\nB=2\n', 'export CENTRAL_TOKEN=y\n\n\n\nC=3'])
    assert.equal(renderEnvFile(t, 'CENTRAL_TOKEN', 'zz', false), oldLinux(t, 'CENTRAL_TOKEN', 'zz'), JSON.stringify(t));

  // 시작 스크립트가 넘기는 경로 — 절대 경로 + 파일 이름 portal.env.bat 만
  assert.equal(startScriptEnvFile('C:\\vmware-portal\\portal.env.bat', true), 'C:\\vmware-portal\\portal.env.bat');
  assert.equal(startScriptEnvFile('"C:\\vmware-portal\\PORTAL.ENV.BAT"', true), 'C:\\vmware-portal\\PORTAL.ENV.BAT');
  for (const bad of ['portal.env.bat', 'C:\\x\\evil.bat', 'C:\\x\\portal.env.bat.cmd', '', null]) assert.equal(startScriptEnvFile(bad, true), null, String(bad));
  assert.equal(startScriptEnvFile('C:\\vmware-portal\\portal.env.bat', false), null);
  // 이 테스트는 리눅스에서 돈다 — 기록 파일은 systemd EnvironmentFile 이라 다음 기동이 읽는다
  if (process.platform !== 'win32') assert.equal(centralTokenInfo().envFileLoaded, true);
});

test('③ INJPKG-01 start-portal.bat 이 자기가 call 하는 파일을 PORTAL_ENV_FILE 로 넘긴다(CONFIG_DIR 쪽 배치 파일은 실행하지 않는다)', () => {
  const bat = fs.readFileSync(path.join(REPO, 'packaging/windows/start-portal.bat'), 'latin1');
  assert.equal(bat.replace(/\r\n/g, '').includes('\n'), false, 'CRLF');
  assert.ok(/^[\x00-\x7f]*$/.test(bat), 'ASCII');
  const lines = bat.split(/\r\n/).filter((l) => l && !/^\s*rem\b/i.test(l));
  const callLine = lines.find((l) => /\bcall\s+"/i.test(l));
  const called = callLine && callLine.match(/call\s+"([^"]+)"/i)[1];
  const setLine = lines.findIndex((l) => /set\s+"PORTAL_ENV_FILE=/i.test(l));
  const nodeLine = lines.findIndex((l) => /node\.exe"/i.test(l));
  assert.ok(setLine >= 0 && nodeLine > setLine, 'PORTAL_ENV_FILE 은 node 실행 전에');
  assert.equal(lines[setLine].match(/PORTAL_ENV_FILE=([^"]+)"/i)[1], called, '시작 스크립트가 call 하는 바로 그 파일');
  // C:\ProgramData 아래 새 폴더는 일반 사용자가 파일을 만들 수 있다 — 그 폴더의 배치 파일을 SYSTEM 이 실행하지 않는다
  assert.equal(lines.filter((l) => /\bcall\b/i.test(l)).length, 1);
  assert.equal(/call\s+"%CONFIG_DIR%/i.test(bat), false);
});

test('④ LEFT-09 Electron 은 정확한 33.x 버전으로 고정', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'uagmon/desktop/package.json'), 'utf8'));
  const v = pkg.devDependencies?.electron;
  assert.match(String(v), /^33\.\d+\.\d+$/);
});

function runHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2743a-'));
  const script = `
    const fs = await import('node:fs');
    const express = (await import('express')).default;
    const auth = await import(${J('auth/auth.js')});
    const { store } = await import(${J('store.js')});
    await store.refresh();
    (await import(${J('storage/registry.js')})).saveDevice({ type: 'unity480', name: 'ST-REAL-01', host: '10.77.1.11', username: 'stuserZ', password: 'pw-ST-zz', collectMethod: 'ssh' });
    (await import(${J('sanswitch/registry.js')})).saveDevice({ type: 'brocade', name: 'SAN-REAL-01', host: '10.77.2.22', username: 'sanuserZ', password: 'pw-SAN-zz' });
    (await import(${J('cvp/registry.js')})).saveServer({ name: 'CVP-REAL-01', host: '10.77.4.44', username: 'cvpuserZ', password: 'pw-CVP-zz', authMode: 'password' });
    (await import(${J('system/nfsMounts.js')})).addMount({ server: '10.77.8.88', exportPath: '/export/corp-backup', options: '' });
    const mk = (u) => auth.createUser(u, { trusted: true });
    mk({ username: 'sadm', role: 'admin', password: 'Passw0rd!long1', scope: { vcenters: ['vc-us-east'] } });
    mk({ username: 'fadm', role: 'admin', password: 'Passw0rd!long1' });
    const tok = (name) => { const u = auth.getUser(name); const sid = 'sid-' + name; const exp = Math.floor(Date.now() / 1000) + 3600;
      const t = auth.signToken({ sub: name, role: u.role, name: u.name || name, src: 'local', tv: u.tokenVersion || 0, sid }, { exp });
      auth.noteIssuedSession({ sub: name, sid, exp }); return t; };
    const TOK = { demo: tok(auth.DEMO_USERNAME), sadm: tok('sadm'), fadm: tok('fadm') };
    const { adminRouter } = await import(${J('routes/admin.js')});
    const { api } = await import(${J('routes/api.js')});
    const app = express(); app.use(express.json({ limit: '2mb' }));
    app.use('/api/auth', (await import(${J('routes/auth.js')})).authRouter);
    app.use('/api/admin', auth.authMiddleware, auth.requireEnrolled, adminRouter);
    app.use('/api', auth.authMiddleware, auth.requireEnrolled, api);
    app.use((err, req, res, _n) => res.status(500).json({ err: String(err?.message || err) }));
    const srv = app.listen(0, '127.0.0.1'); await new Promise((r) => srv.once('listening', r));
    const base = 'http://127.0.0.1:' + srv.address().port;
    const call = async (who, method, p, body) => {
      const r = await fetch(base + p, { method, headers: { authorization: 'Bearer ' + TOK[who], 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { st: r.status, txt: await r.text() };
    };
    const out = {};
    for (const who of ['demo', 'fadm']) {
      const o = out[who] = {};
      for (const p of ['/api/tools/storage/devices/export.csv', '/api/tools/sanswitch/devices/export.csv', '/api/tools/cvp/bulk/servers/export.csv',
        '/api/tools/sanswitch', '/api/tools/storage', '/api/admin/ipam/db-info', '/api/auth/me', '/api/tools/vm-clone', '/api/tools/cvp/servers'])
        o[p] = await call(who, 'GET', p);
    }
    out.sadm = { vmclone: await call('sadm', 'GET', '/api/tools/vm-clone'), draft: await call('sadm', 'PUT', '/api/admin/host-access/draft', { settings: {} }) };
    // 라우터 스택에서 hostAccess 변경 라우트의 게이트 표지(fullScope — shared.fullScopeOnlyWith)를 직접 읽는다
    const gates = {};
    for (const l of adminRouter.stack) {
      const r = l.route; if (!r || !String(r.path).startsWith('/host-access')) continue;
      for (const m of Object.keys(r.methods)) gates[m.toUpperCase() + ' ' + r.path] = r.stack.map((s) => s.handle?.gate?.kind || null).filter(Boolean);
    }
    out.gates = gates;
    out.configDir = process.env.CONFIG_DIR;
    srv.close();
    console.log('@@' + JSON.stringify(out));
    process.exit(0);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true', AUTH_SECRET: 'x'.repeat(40), OTP_ROLE_ENFORCE: 'false',
      SETTINGS_OWNERS: 'sadm,fadm', NFS_MOUNT_BASE: path.join(dir, 'nfs') },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 240_000, maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, r.stdout.slice(-600) + r.stderr.slice(-600));
  return JSON.parse(line.slice(2));
}

let H;
const harness = () => (H ||= runHarness());

test('② AUTHZ-01 데모 계정 — 등록부 CSV 내보내기 403(관리자는 200), 장비 목록에 사람이 등록한 관리 IP·계정명 0', () => {
  const { demo, fadm } = harness();
  for (const p of ['/api/tools/storage/devices/export.csv', '/api/tools/sanswitch/devices/export.csv', '/api/tools/cvp/bulk/servers/export.csv']) {
    assert.equal(demo[p].st, 403, `${p} ${demo[p].txt.slice(0, 120)}`);
    assert.equal(fadm[p].st, 200, `${p} 관리자 대조`);
  }
  assert.ok(fadm['/api/tools/storage/devices/export.csv'].txt.includes('10.77.1.11'), '대조: 관리자 내보내기는 주소를 싣는다');
  for (const [p, host, user] of [['/api/tools/sanswitch', '10.77.2.22', 'sanuserZ'], ['/api/tools/storage', '10.77.1.11', 'stuserZ']]) {
    assert.equal(demo[p].st, 200, p);  // 조회 자체는 막지 않는다(v2.716 '조회 전부')
    assert.equal(demo[p].txt.includes(host), false, `${p} host`);
    assert.equal(demo[p].txt.includes(user), false, `${p} username`);
    assert.ok(fadm[p].txt.includes(host), `${p} 관리자 대조`);
  }
  // CVP 서버 등록부(설정 탭) — 데모 계정은 거부(demoGuest 표지)
  assert.equal(demo['/api/tools/cvp/servers'].st, 403);
  assert.ok(JSON.parse(demo['/api/tools/cvp/servers'].txt).demoGuest);
  assert.ok(fadm['/api/tools/cvp/servers'].txt.includes('10.77.4.44'));
});

test('② AUTHZ-01 데모 계정 — IP 원장 DB 위치에 절대 경로 0 · /auth/me permissions 에 data.csv 없음 · 비밀번호 0', () => {
  const H2 = harness();
  const { demo, fadm, configDir } = H2;
  assert.equal(demo['/api/admin/ipam/db-info'].txt.includes(configDir), false, demo['/api/admin/ipam/db-info'].txt.slice(0, 200));
  assert.ok(fadm['/api/admin/ipam/db-info'].txt.includes(configDir), '대조: 관리자는 경로를 본다');
  const me = JSON.parse(demo['/api/auth/me'].txt).user;
  assert.equal(me.demoGuest, true);
  assert.equal(me.permissions.includes('data.csv'), false);
  assert.ok(me.permissions.includes('tools'));
  assert.ok(JSON.parse(fadm['/api/auth/me'].txt).user.permissions.includes('data.csv'));
  for (const [p, r] of Object.entries(demo)) assert.equal(/pw-(ST|SAN|CVP)-zz/.test(r.txt), false, `${p} 비밀번호`);
});

test('② AUTHZ-02 범위 관리자·데모 계정의 /tools/vm-clone — NFS 서버 주소·export 경로·마운트 절대 경로 0, 가린 사실은 mountsMasked', () => {
  const { sadm, demo, fadm } = harness();
  for (const [who, r] of [['sadm', sadm.vmclone], ['demo', demo['/api/tools/vm-clone']]]) {
    assert.equal(r.st, 200, who);
    const b = JSON.parse(r.txt);
    assert.equal(b.mountsMasked, true, who);
    assert.equal(r.txt.includes('10.77.8.88'), false, `${who} server`);
    assert.equal(r.txt.includes('/export/corp-backup'), false, `${who} exportPath`);
    assert.equal(r.txt.includes('nfs'), true);
    assert.equal(b.mounts.length, 1);
    const m = b.mounts[0];
    assert.deepEqual(Object.keys(m).sort(), ['id', 'label', 'mounted']);
    assert.ok(m.label && m.label.includes(m.id), '빈 문자열이 아니라 표식');
  }
  const f = JSON.parse(fadm['/api/tools/vm-clone'].txt);
  assert.equal(f.mountsMasked, undefined);
  assert.equal(f.mounts[0].server, '10.77.8.88');
  assert.equal(f.mounts[0].label, '10.77.8.88:/export/corp-backup');
});

test('② LEFT-09 hostAccess 변경 라우트 전부 전체 범위 게이트 — 설정 소유자인 범위 관리자도 403', () => {
  const { sadm, gates } = harness();
  assert.equal(sadm.draft.st, 403, sadm.draft.txt.slice(0, 200));
  assert.match(JSON.parse(sadm.draft.txt).reason, /전체 범위/);
  const changes = Object.keys(gates).filter((k) => !k.startsWith('GET '));
  assert.deepEqual(changes.sort(), ['POST /host-access/apply', 'POST /host-access/confirm', 'POST /host-access/plan', 'POST /host-access/revert', 'PUT /host-access/draft']);
  for (const k of Object.keys(gates)) assert.ok(gates[k].includes('fullScope'), `${k}: ${gates[k].join(',')}`);
});
