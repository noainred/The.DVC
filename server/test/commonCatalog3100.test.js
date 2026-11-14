/**
 * v3.10 — 특수 기능 › 포탈 점검 › **공통 기능**(서버) 회귀. 설계 docs/design/common-catalog.
 *
 * 고정하는 것:
 *  ① 읽기 — 파일이 없으면 `missing`, 형식이 틀리거나 모듈이 하나도 남지 않으면 `unreadable`(빈 목록 = '모듈 0개' 로 만들지 않는다).
 *  ② 다듬기 — 숫자는 0 이상의 정수 또는 null(`''`·null 이 0 이 되지 않는다) · 모르는 구분의 모듈은 버린다 · 배열 · 문자열은 상한.
 *  ③ 실제 `api` 라우터를 express 에 마운트해 `GET /api/tools/portal-check/common` 을 **상태코드로** 본다 — 전체 범위 admin 200,
 *     범위 admin · operator · **데모 계정(admin 문맥)** 403. 응답에 절대 경로가 없다.
 *  ④ 실려 있는 생성물(`commonCatalog.json`)이 그대로 읽히고, 생성기가 지금 소스로 만든 것과 모듈 수가 같다.
 *
 * ⚠ CONFIG_DIR 은 import 전에 임시 디렉터리로 고정한다(config.js 싱글턴).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'commoncat3100-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';

let srv; let base; let C;
const USERS = {
  full: { username: 'full', role: 'admin', scope: null },
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-us-east'] } },
  op: { username: 'op', role: 'operator', scope: null },
  demo: { username: 'demo', role: 'admin', scope: null, demoGuest: true },
};
before(async () => {
  const express = (await import('express')).default;
  C = await import('../src/portalcheck/commonCatalog.js');
  const { api } = await import('../src/routes/api.js');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
});
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

async function call(u) {
  const r = await fetch(`${base}/tools/portal-check/common`, { headers: { 'x-u': u } });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, j, t };
}

const MOD = { file: 'server/src/util/x.js', scope: 'server-util', summary: '설명', exports: ['a'], users: 3, areas: 2, areaCounts: [['server:storage', 2], ['server:cvp', 1]], tests: 1, testFiles: ['server/test/x.test.js'], twin: null };

test('① 읽기 — 없는 파일은 missing, 깨진 JSON · 모양이 아닌 것 · 모듈 0개는 unreadable', () => {
  const p = (name, body) => { const f = path.join(tmp, name); if (body !== undefined) fs.writeFileSync(f, body); return f; };
  assert.deepEqual(C.readCommonCatalog(p('none.json')), { status: 'missing' });
  assert.deepEqual(C.readCommonCatalog(p('broken.json', '{"modules": [')), { status: 'unreadable' });
  assert.deepEqual(C.readCommonCatalog(p('array.json', '[]')), { status: 'unreadable' });
  assert.deepEqual(C.readCommonCatalog(p('nomods.json', '{"v":1}')), { status: 'unreadable' });
  // 모듈이 하나도 남지 않으면 '공용 모듈 0개' 가 아니라 못 읽은 것이다.
  assert.deepEqual(C.readCommonCatalog(p('empty.json', '{"modules": []}')), { status: 'unreadable' });
  assert.deepEqual(C.readCommonCatalog(p('junk.json', '{"modules": [{"file":"a.js","scope":"nope"}, 3, null]}')), { status: 'unreadable' });
  // 폴더는 파일이 아니다 — 던지지 않고 unreadable.
  assert.deepEqual(C.readCommonCatalog(tmp), { status: 'unreadable' });
  const ok = C.readCommonCatalog(p('ok.json', JSON.stringify({ v: 1, fileCount: 10, modules: [MOD] })));
  assert.equal(ok.status, 'ok');
  assert.equal(ok.catalog.modules.length, 1);
  // 상태 값에 읽기 오류 원문(파일 조각 · 경로)을 싣지 않는다 — 키는 status 하나뿐.
  assert.deepEqual(Object.keys(C.readCommonCatalog(p('broken.json'))), ['status']);
});

test('② 다듬기 — 못 읽은 숫자는 0 이 아니라 null · 모르는 구분은 버린다 · 아는 필드만 · 상한', () => {
  const n = C.normalizeModule({ ...MOD, users: '', areas: null, tests: '7', extra: 'x', secret: 'y' });
  assert.equal(n.users, null, "'' 는 0 이 아니다");
  assert.equal(n.areas, null, 'null 은 0 이 아니다');
  assert.equal(n.tests, 7, '숫자 문자열은 수로');
  assert.deepEqual(Object.keys(n).sort(), ['areaCounts', 'areas', 'exports', 'file', 'scope', 'summary', 'testFiles', 'tests', 'twin', 'users']);
  assert.equal(C.normalizeModule({ ...MOD, users: -1 }).users, null, '음수는 개수가 아니다');
  assert.equal(C.normalizeModule({ ...MOD, users: 1.5 }).users, null, '소수는 개수가 아니다');
  assert.equal(C.normalizeModule({ ...MOD, scope: 'elsewhere' }), null);
  assert.equal(C.normalizeModule({ ...MOD, file: '' }), null);
  assert.equal(C.normalizeModule(null), null);
  assert.equal(C.normalizeModule([MOD]), null);
  // 영역 쌍은 [이름, 개수] 모양만 — 개수를 못 읽은 쌍은 0 으로 채우지 않고 뺀다.
  assert.deepEqual(C.normalizeModule({ ...MOD, areaCounts: [['a', 2], ['b', ''], 'c', ['', 1], ['d', '3']] }).areaCounts, [['a', 2], ['d', 3]]);
  const many = C.normalizeModule({ ...MOD, testFiles: Array.from({ length: 80 }, (_, i) => `t${i}.test.js`), exports: Array.from({ length: 500 }, (_, i) => `e${i}`), summary: '가'.repeat(900) });
  assert.equal(many.testFiles.length, 30);
  assert.equal(many.exports.length, 200);
  assert.equal(many.summary.length, 400);
  const cat = C.normalizeCatalog({ fileCount: '', dynamicUnknown: { count: 2, files: ['a.js', 5] }, scopes: [{ id: 'server-util', title: 't', dir: 'd' }, { id: 'x' }], modules: [MOD, { file: 'q', scope: 'bad' }] });
  assert.equal(cat.fileCount, null);
  assert.deepEqual(cat.dynamicUnknown, { count: 2, files: ['a.js'] });
  assert.deepEqual(cat.scopes, [{ id: 'server-util', title: 't', dir: 'd' }]);
  assert.equal(cat.modules.length, 1);
});

test('③ GET /api/tools/portal-check/common — 전체 범위 admin 200 · 범위 admin · operator · 데모 계정 403', async () => {
  const full = await call('full');
  assert.equal(full.s, 200, full.t.slice(0, 300));
  assert.equal(full.j.ok, true);
  assert.equal(full.j.status, 'ok');
  assert.ok(Array.isArray(full.j.modules) && full.j.modules.length > 100, `모듈 ${full.j.modules?.length}개`);
  assert.ok(full.j.modules.some((m) => m.file === 'server/src/util/numOrNull.js' && m.scope === 'server-util' && m.users > 100 && m.twin === 'web/src/numOrNull.js'));
  assert.ok(full.j.modules.some((m) => m.scope === 'outside'));
  assert.equal(typeof full.j.version, 'string');
  // 경로는 저장소 기준 상대 경로뿐 — 설치 위치(절대 경로)가 실리지 않는다.
  assert.equal(full.t.includes(process.cwd()), false);
  assert.equal(/"(?:file|twin)":"\//.test(full.t), false);
  for (const u of ['sadm', 'op', 'demo']) {
    const r = await call(u);
    assert.equal(r.s, 403, `${u} 는 403 이어야 한다(${r.s})`);
    assert.equal(r.j?.modules, undefined, `${u} 응답에 목록이 실리면 안 된다`);
  }
  assert.match((await call('demo')).j.reason, /관리자 계정만/);
});

test('④ 실린 생성물이 그대로 읽히고 지금 소스와 모듈 수가 같다', async () => {
  const shipped = C.readCommonCatalog();
  assert.equal(shipped.status, 'ok');
  const { buildCatalog, buildJson } = await import('../../scripts/common-doc.mjs');
  const fresh = buildJson(buildCatalog());
  assert.equal(shipped.catalog.modules.length, fresh.modules.length, 'node scripts/common-doc.mjs 로 다시 만들 것');
  // 다듬기가 생성물의 값을 바꾸지 않는다(상한 · 구분 목록이 생성기와 어긋나면 여기서 드러난다).
  const byFile = new Map(fresh.modules.map((m) => [`${m.scope}|${m.file}`, m]));
  for (const m of shipped.catalog.modules) {
    const f = byFile.get(`${m.scope}|${m.file}`);
    assert.ok(f, `${m.file} 가 생성기 결과에 없다`);
    assert.deepEqual(m, f, `${m.file}: 다듬은 값이 생성물과 다르다`);
  }
  assert.deepEqual(shipped.catalog.scopes.map((s) => s.id), [...C.COMMON_SCOPES]);
});
