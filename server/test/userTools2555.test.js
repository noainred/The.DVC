/**
 * userTools2555.test.js — **사용자별 특수기능 접근**(v2.555) 회귀 고정.
 *
 * 사용자 요청(2026-09-18): "특정 사용자는 특수기능의 특정 기능만 사용할 수 있고, 나머지 기능은
 * 보여주지 않고 싶다 — 예: 스토리지 엔지니어에게 스토리지 메뉴만". 선택: 허용 목록 모드 추가 ·
 * 사용자 단위 · 아예 숨긴다 · 사용자 관리 화면 안에 확장.
 *
 * ⚠⚠ **왜 소스 grep 이 아니라 실제 앱을 띄우는가**: v2.536 이 기록한 사고가 정확히 이것이다 —
 *   프론트 탭 조건만 있고 서버 집행이 없으면 그것은 접근제어가 아니라 '메뉴 숨김' 이다.
 *   그래서 아래 게이트 테스트는 **진짜 `api` 라우터를 express 에 마운트하고 실제 permissions.json
 *   을 읽혀 상태코드를 본다**(authzGates2536 과 같은 하니스).
 *
 * 자식 프로세스인 이유: `config.js` 는 싱글턴이라 한 프로세스에서 CONFIG_DIR 을 다시 못 가리킨다.
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

/** permissions.json 을 그대로 쓰는 임시 CONFIG_DIR 을 만들고 자식 프로세스에서 스크립트를 돈다. */
function runWith(matrixFile, script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usertools2555-'));
  fs.writeFileSync(path.join(dir, 'permissions.json'), JSON.stringify(matrixFile));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true' },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력에 결과가 없습니다: ${r.stdout.slice(-600)}`);
  return JSON.parse(line.slice(2));
}

const BASE_MATRIX = {
  schemaVersion: 2,
  matrix: {
    operator: ['dashboard', 'tools'],
    viewer: ['dashboard', 'tools'],
    toolsDenied: { operator: [], viewer: [] },
  },
};

const withUsers = (users) => ({ ...BASE_MATRIX, matrix: { ...BASE_MATRIX.matrix, users } });

/** 순수 판정만 — 파일을 읽고 effectiveToolAccess/userToolAllowed 를 돌린다. */
function judge(users, cases) {
  const script = `
    const m = await import(${JSON.stringify(path.join(SRC, 'auth/permissions.js'))});
    const out = {};
    for (const [label, u, key] of ${JSON.stringify(cases)}) {
      out[label] = { allowed: m.userToolAllowed(u, key), eff: m.effectiveToolAccess(u) };
    }
    console.log('@@' + JSON.stringify(out));
  `;
  return runWith(withUsers(users), script);
}

test('★ 허용 목록 모드 — 고른 도구만 허용하고 나머지는 전부 차단(새 도구도 차단)', () => {
  const out = judge(
    { sto: { mode: 'allow', tools: ['storage-mon', 'storage-growth'], at: 1, by: 'admin' } },
    [
      ['pick', { username: 'sto', role: 'operator' }, 'storage-mon'],
      ['other', { username: 'sto', role: 'operator' }, 'ipam'],
      ['future', { username: 'sto', role: 'operator' }, 'brand-new-tool'],
      ['untouched', { username: 'bob', role: 'operator' }, 'ipam'],
      ['admin', { username: 'sto', role: 'admin' }, 'ipam'],
    ],
  );
  assert.equal(out.pick.allowed, true);
  assert.equal(out.other.allowed, false, '허용 목록 밖이 열려 있습니다');
  assert.equal(out.future.allowed, false, '허용 목록은 앞으로 추가되는 도구도 막아야 한다(거부 기본값)');
  assert.equal(out.untouched.allowed, true, '재정의가 없는 사용자의 동작이 바뀌었습니다(회귀)');
  assert.equal(out.admin.allowed, true, 'admin 은 재정의 대상이 아니다(관리자 잠김 방지)');
  assert.equal(out.pick.eff.mode, 'allow');
  assert.deepEqual(out.pick.eff.allowed, ['storage-mon', 'storage-growth']);
  assert.equal(out.untouched.eff.mode, 'role');
  assert.equal(out.untouched.eff.allowed, null);
});

test('★ 허용 목록이 빈 배열이면 전부 차단 — "제한 없음" 으로 되돌리지 않는다', () => {
  const out = judge(
    { none: { mode: 'allow', tools: [], at: 1, by: 'admin' } },
    [['a', { username: 'none', role: 'operator' }, 'ipam'], ['b', { username: 'none', role: 'operator' }, 'ping']],
  );
  assert.equal(out.a.allowed, false);
  assert.equal(out.b.allowed, false);
  assert.deepEqual(out.a.eff.allowed, [], '빈 허용 목록이 사라지면 그 사용자의 제한이 조용히 풀린다');
});

test('허용 목록은 역할 거부와 합치지 않는다 — 관리자가 준 것이 사라지면 안 된다', () => {
  const m = {
    schemaVersion: 2,
    matrix: {
      operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'],
      toolsDenied: { operator: ['storage-mon'], viewer: [] },
      users: { sto: { mode: 'allow', tools: ['storage-mon'], at: 1, by: 'admin' } },
    },
  };
  const script = `
    const mod = await import(${JSON.stringify(path.join(SRC, 'auth/permissions.js'))});
    console.log('@@' + JSON.stringify({
      allowed: mod.userToolAllowed({ username: 'sto', role: 'operator' }, 'storage-mon'),
      other: mod.userToolAllowed({ username: 'x', role: 'operator' }, 'storage-mon'),
    }));
  `;
  const out = runWith(m, script);
  assert.equal(out.allowed, true, '역할 거부와 교집합을 내면 관리자가 명시한 허용이 조용히 사라진다');
  assert.equal(out.other, false, '재정의 없는 operator 는 역할 거부를 그대로 받아야 한다');
});

test('추가 차단 모드는 역할 거부와 합집합이다', () => {
  const m = {
    schemaVersion: 2,
    matrix: {
      operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'],
      toolsDenied: { operator: ['rma'], viewer: [] },
      users: { bob: { mode: 'deny', tools: ['ipam'], at: 1, by: 'admin' } },
    },
  };
  const script = `
    const mod = await import(${JSON.stringify(path.join(SRC, 'auth/permissions.js'))});
    const eff = mod.effectiveToolAccess({ username: 'bob', role: 'operator' });
    console.log('@@' + JSON.stringify({ eff, ipam: mod.userToolAllowed({ username: 'bob', role: 'operator' }, 'ipam'), rma: mod.userToolAllowed({ username: 'bob', role: 'operator' }, 'rma'), ping: mod.userToolAllowed({ username: 'bob', role: 'operator' }, 'ping') }));
  `;
  const out = runWith(m, script);
  assert.equal(out.eff.mode, 'deny');
  assert.equal(out.eff.allowed, null, '추가 차단 모드에서 allowed 는 null 이어야 한다(거부 목록 판정)');
  assert.deepEqual([...out.eff.denied].sort(), ['ipam', 'rma']);
  assert.equal(out.ipam, false);
  assert.equal(out.rma, false);
  assert.equal(out.ping, true);
});

test('저장 규약 — off 는 항목을 지우고, deny+빈 목록도 지운다(false 를 쌓지 않는다)', () => {
  const script = `
    const mod = await import(${JSON.stringify(path.join(SRC, 'auth/permissions.js'))});
    const steps = [];
    steps.push(mod.setUserTools('bob', { mode: 'allow', tools: ['ipam'], by: 'admin' }));
    steps.push(Object.keys(mod.userToolOverrides()));
    steps.push(mod.setUserTools('bob', { mode: 'off' }));
    steps.push(Object.keys(mod.userToolOverrides()));
    steps.push(mod.setUserTools('bob', { mode: 'deny', tools: [], by: 'admin' }));
    steps.push(Object.keys(mod.userToolOverrides()));
    steps.push(mod.setUserTools('bad name!', { mode: 'allow', tools: [] }));
    console.log('@@' + JSON.stringify(steps));
  `;
  const out = runWith(withUsers({}), script);
  assert.equal(out[0].ok, true);
  assert.deepEqual(out[1], ['bob']);
  assert.deepEqual(out[3], [], 'off 가 항목을 지우지 않았습니다');
  assert.deepEqual(out[5], [], 'deny + 빈 목록은 재정의가 아니므로 저장하지 않아야 한다');
  assert.equal(out[6].ok, false, '사용자명 형식 검사가 없으면 임의 키가 파일에 쌓인다');
});

test('★★ 서버가 실제로 403 을 만든다 — 허용 목록 밖 도구의 API 직접 호출(v2.536 교훈)', () => {
  const script = `
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const app = express();
    app.use((req, _res, next) => { req.user = { username: 'sto', role: 'operator', scope: null }; next(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const paths = ['/api/tools/storage', '/api/tools/ipam', '/api/tools/hardware', '/api/search/nl'];
    const out = {};
    for (const p of paths) {
      const r = await fetch(base + p, p === '/api/search/nl' ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' } : undefined);
      let b = null; try { b = await r.json(); } catch {}
      out[p] = { status: r.status, tool: b && b.tool, mode: b && b.toolMode };
    }
    srv.close();
    console.log('@@' + JSON.stringify(out));
  `;
  const out = runWith(withUsers({ sto: { mode: 'allow', tools: ['storage-mon'], at: 1, by: 'admin' } }), script);
  // 허용한 도구는 게이트를 지나간다(뒤 미들웨어의 scope·데이터 사정으로 200 이 아닐 수는 있으나 403 이면 안 된다).
  assert.notEqual(out['/api/tools/storage'].status, 403, '허용 목록에 넣은 도구가 막혔습니다');
  for (const p of ['/api/tools/ipam', '/api/tools/hardware', '/api/search/nl']) {
    assert.equal(out[p].status, 403, `${p} 가 막히지 않았습니다(${out[p].status}) — 허용 목록이 서버에서 집행되지 않는다`);
    assert.equal(out[p].mode, 'allow', '403 응답이 어떤 모드로 막혔는지 밝혀야 한다(화면이 사유를 구분해 말한다)');
  }
});

test('재정의가 없으면 기존 동작 그대로 — users 키가 없는 파일에서 회귀가 없어야 한다', () => {
  const script = `
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const app = express();
    app.use((req, _res, next) => { req.user = { username: 'bob', role: 'operator', scope: null }; next(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const out = {};
    for (const p of ['/api/tools/ipam', '/api/tools/storage']) {
      const r = await fetch(base + p);
      out[p] = r.status;
    }
    srv.close();
    console.log('@@' + JSON.stringify(out));
  `;
  const out = runWith(BASE_MATRIX, script);
  assert.notEqual(out['/api/tools/ipam'], 403, 'users 가 없는 파일에서 도구가 막혔습니다(회귀)');
});

test('로그인·/auth/me 응답 계약 — toolsAllowed·toolMode 를 같은 판정으로 싣는다', () => {
  // 두 응답이 각자 판정하면 '화면은 숨겼는데 API 는 열린' 상태가 생긴다 → routes/auth.js 는
  // 반드시 하나의 헬퍼(toolFields)를 써야 한다. 소스에서 그 사실을 고정한다.
  const src = fs.readFileSync(path.join(SRC, 'routes/auth.js'), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  const uses = src.match(/\.\.\.toolFields\(/g) || [];
  assert.ok(uses.length >= 2, `routes/auth.js 가 toolFields 를 두 응답(로그인·/auth/me)에 쓰지 않습니다(${uses.length}곳)`);
  assert.ok(/function toolFields\(/.test(src), 'toolFields 헬퍼가 없습니다 — 판정이 복제되면 두 응답이 갈라진다');
});

test('웹 표시 게이팅이 allow 분기를 갖는다 — toolsDenied 만 보던 판정으로 되돌리면 안 된다', () => {
  const web = fs.readFileSync(path.resolve(SRC, '../../web/src/api.js'), 'utf8');
  assert.ok(/Array\.isArray\(u\.toolsAllowed\)/.test(web), 'web/src/api.js toolAllowed 에 허용 목록 분기가 없습니다');
});
