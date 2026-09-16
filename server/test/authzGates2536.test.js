/**
 * authzGates2536.test.js — 인증·인가 게이트 전수 감사(v2.536) 회귀 고정.
 *
 * 왜 '소스 grep' 이 아니라 **실제 앱을 띄워** 보는가: v2.506 이 같은 실수를 했다. 라우터 파일을
 * 문자열로 검사하면 미들웨어 순서가 바뀌거나 등록이 빠져도 통과한다("규칙이 문서에만 있는"
 * v2.480 실패와 같은 종류). 그래서 여기서는 **진짜 `api` 라우터를 express 에 마운트하고
 * 실제 `permissions.json` 을 읽혀 상태코드를 본다**.
 *
 * ── 이 테스트가 고정하는 결함(v2.535 까지 실재) ────────────────────────────────
 * `auth/permissions.js` 의 '인벤토리' 권한 6종(`inv.hosts`·`inv.vms`·`inv.datastores`·
 * `inv.networks`·`inv.nsx`·`inv.alarms`)은 설정 › 사용자 관리에서 켜고 끌 수 있는데
 * **서버가 한 번도 집행하지 않았다** — 쓰이던 자리는 `web/src/App.jsx` 의 탭 표시 조건뿐이었다
 * (클라이언트 전용 접근제어). 관리자가 `inv.vms` 를 빼도 `GET /api/vms` 는 200 이었다.
 *
 * 자식 프로세스인 이유: `config.js` 는 싱글턴이라 이 프로세스에서 CONFIG_DIR 을 다시 못 가리킨다.
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

/** viewer 의 권한을 주고 각 경로의 상태코드를 돌려받는다. */
function statusesFor(viewerPerms) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'authz2536-'));
  fs.writeFileSync(path.join(dir, 'permissions.json'), JSON.stringify({
    schemaVersion: 2,
    matrix: { operator: viewerPerms, viewer: viewerPerms, toolsDenied: { operator: [], viewer: [] } },
  }));
  const script = `
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const app = express();
    app.use((req, _res, next) => { req.user = { username: 'v', role: 'viewer', scope: null }; next(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const paths = ['/api/vms', '/api/hosts', '/api/datastores', '/api/networks', '/api/nsx',
                   '/api/alarms', '/api/alarm-mutes', '/api/vms/lookup', '/api/nsx/group-members',
                   '/api/summary', '/api/overview', '/api/tools/storage'];
    const out = {};
    for (const p of paths) {
      const r = await fetch(base + p);
      let b = null; try { b = await r.json(); } catch {}
      out[p] = { status: r.status, perm: b && b.requiredPerm };
    }
    srv.close();
    console.log('@@' + JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true' },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력에 결과가 없습니다: ${r.stdout.slice(-400)}`);
  return JSON.parse(line.slice(2));
}

test('★ inv.* 를 뺀 역할은 인벤토리 조회 API 가 403 이어야 한다(클라이언트 전용 접근제어 금지)', () => {
  const out = statusesFor(['dashboard', 'tools']);
  const expect = {
    '/api/vms': 'inv.vms',
    '/api/vms/lookup': 'inv.vms',
    '/api/hosts': 'inv.hosts',
    '/api/datastores': 'inv.datastores',
    '/api/networks': 'inv.networks',
    '/api/nsx': 'inv.nsx',
    '/api/nsx/group-members': 'inv.nsx',
    '/api/alarms': 'inv.alarms',
    '/api/alarm-mutes': 'inv.alarms',
  };
  for (const [p, perm] of Object.entries(expect)) {
    assert.equal(out[p].status, 403, `${p} 가 막히지 않았습니다(${out[p].status}) — v2.535 결함 재발`);
    // 403 응답은 `requiredPerm` 을 실어야 한다 — 없으면 화면이 AccessDenied 대신 범용
    // 오류 문구로 퇴화한다(web/src/components/accessDeniedText.js 규약).
    assert.deepEqual(out[p].perm, [perm], `${p} 의 requiredPerm 이 ${perm} 이 아닙니다`);
  }
  // 대조군 — 집계는 dashboard 수준으로 **의도적으로** 열어 뒀다(개수만, 이름·IP 없음).
  assert.equal(out['/api/summary'].status, 200, '집계는 dashboard 수준으로 열려 있어야 한다');
  assert.equal(out['/api/overview'].status, 200, '집계는 dashboard 수준으로 열려 있어야 한다');
});

test('★ 기본 권한(inv.* 전부 보유)에서는 막히지 않는다 — 기본 설치 무회귀', () => {
  const out = statusesFor(['dashboard', 'inv.hosts', 'inv.vms', 'inv.datastores', 'inv.networks',
                           'inv.nsx', 'inv.alarms', 'insights', 'vm.console']);
  for (const p of ['/api/vms', '/api/hosts', '/api/datastores', '/api/networks', '/api/nsx',
                   '/api/alarms', '/api/alarm-mutes', '/api/vms/lookup']) {
    assert.notEqual(out[p].status, 403, `${p} 가 기본 권한에서 막혔습니다 — 과차단`);
  }
  // tools 를 안 준 역할은 여전히 /tools/* 가 403 이어야 한다(게이트가 살아 있다는 증거).
  assert.equal(out['/api/tools/storage'].status, 403);
});

test('★ 서버 게이트 키는 프론트 탭의 perm 키와 글자 그대로 같아야 한다', () => {
  // 다르면 '메뉴는 보이는데 API 는 403' 이 되어 사용자가 장애로 오해한다(v2.506 실제 경험).
  const appJsx = fs.readFileSync(path.resolve(SRC, '../../web/src/App.jsx'), 'utf8');
  const tabPerms = new Map();
  for (const m of appJsx.matchAll(/id:\s*'([a-z]+)'\s*,\s*label:\s*'[^']*'\s*,\s*perm:\s*'(inv\.[a-z]+)'/g)) {
    tabPerms.set(m[1], m[2]);
  }
  assert.ok(tabPerms.size >= 5, `App.jsx 에서 인벤토리 탭 perm 을 찾지 못했습니다(${tabPerms.size}건)`);

  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const inv = strip(fs.readFileSync(path.join(SRC, 'routes/api/inventory.js'), 'utf8'));
  const nsx = strip(fs.readFileSync(path.join(SRC, 'routes/api/overviewNsx.js'), 'utf8'));
  const serverKeys = new Set([...`${inv}\n${nsx}`.matchAll(/requirePerm\('(inv\.[a-z]+)'\)/g)].map((m) => m[1]));
  for (const [tab, perm] of tabPerms) {
    assert.ok(serverKeys.has(perm), `프론트 탭 '${tab}' 은 ${perm} 를 요구하는데 서버에 그 게이트가 없습니다`);
  }
});

test('원격접속 대상 목록은 remote.access 권한자에게만(형제 /proxies 와 같은 기준)', () => {
  // v2.480 이 `/remote/proxies` 에만 붙이고 `/remote/targets` 는 빠뜨렸다 — VM 이름·guestOS·
  // 전체 IP 목록을 주는 경로라 기준이 같아야 한다(게이팅 비대칭 금지).
  const src = fs.readFileSync(path.join(SRC, 'routes/remote.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(src, /remoteRouter\.get\('\/targets',\s*requirePerm\('remote\.access'\)/);
});
