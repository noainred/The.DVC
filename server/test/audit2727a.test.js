/**
 * audit2727a.test.js — v2.727 감사 그룹 1(좌측 사이드바·계정별 메뉴) 서버 회귀.
 *
 * 실제 `api` 라우터를 express 에 마운트하고 사용자 헤더를 바꿔 가며 **상태코드·응답 키**로 본다(userMenu2726 하니스 재사용).
 * 고정하는 것:
 *  ① A-03·B-03 사용자 키 — trim·소문자, AD 형식(`CORP\jdoe`·`john doe`)은 거부하지 않고 해시 키, 대소문자 변형은 같은 메뉴
 *  ② A-03 옛 파일의 대소문자만 다른 키는 로드 때 가장 최근 쪽으로 합친다(console.warn 1줄)
 *  ③ A-07 라벨 41자 400(`field:'groups'`) · B-02 `{toString:1}` 객체는 500 이 아니라 400 `field`
 *  ④ A-01 저장은 직전 메뉴를 prev(mode:'save')로 보관하고 restore-prev 로 되돌린다 · 같은 내용 재저장은 prev 를 건드리지 않는다
 *  ⑤ A-10·B-04 viewer·operator·데모 계정 응답에는 `by` 가 없고 admin 에게는 있다
 *  ⑥ A-09 저장소의 400 오류(빈 사용자 이름)가 GET 에서도 400 으로 나간다(500 금지) — 두 GET 핸들러가 fail() 로 감싸여 있는지 소스도 본다
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2727a-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

const USERS = {
  view: { username: 'view1', role: 'viewer', scope: null },
  op: { username: 'op1', role: 'operator', scope: null },
  adm: { username: 'adm', role: 'admin', scope: null },
  sup: { username: 'noainred', role: 'admin', superAdmin: true, scope: null },
  demo: { username: 'thedvcdemp', role: 'admin', demoGuest: true, scope: null },
  ad1: { username: 'CORP\\jdoe', role: 'viewer', scope: null },
  ad1b: { username: 'corp\\JDOE', role: 'viewer', scope: null },
  sp: { username: 'john doe', role: 'operator', scope: null },
  mixed: { username: 'JDoe', role: 'viewer', scope: null },
  lower: { username: ' jdoe ', role: 'viewer', scope: null },
  blank: { username: '   ', role: 'viewer', scope: null },
};
let srv, base, store;
before(async () => {
  const express = (await import('express')).default;
  store = await import('../src/usermenu/store.js');
  const { api } = await import('../src/routes/api.js');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  // 전역 처리기 — 라우트가 못 잡은 오류는 500(실서버 index.js 와 같은 결과).
  app.use((err, _req, res, _next) => { res.status(500).json({ error: 'internal', msg: err.message }); }); // eslint-disable-line no-unused-vars
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
});
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

async function call(u, method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* */ }
  return { s: r.status, j };
}
const menuOf = (...ids) => ({ groups: [...ids.map((t) => ({ id: `g-${t}`, tab: t })), { id: 'tools', tab: 'tools' }] });
const MENU_A = menuOf('overview', 'vms');
const MENU_B = menuOf('summary', 'hosts');

test('① menuUserKey — trim·소문자 · 허용 밖 이름은 해시 키 · 빈 이름은 null', () => {
  assert.equal(store.menuUserKey('JDoe'), 'jdoe');
  assert.equal(store.menuUserKey(' jdoe '), 'jdoe');
  assert.equal(store.menuUserKey('anonymous'), 'anonymous');
  const ad = store.menuUserKey('CORP\\jdoe');
  assert.match(ad, /^h:[0-9a-f]{16}$/, 'AD 형식은 거부하지 않고 해시 키');
  assert.equal(store.menuUserKey('corp\\JDOE'), ad, '대소문자 변형은 같은 키');
  assert.equal(store.menuUserKey(ad), ad, '이미 해시 키면 다시 해시하지 않는다(옛 파일 재로드)');
  assert.match(store.menuUserKey('john doe'), /^h:[0-9a-f]{16}$/);
  assert.match(store.menuUserKey('홍길동'), /^h:[0-9a-f]{16}$/);
  assert.notEqual(store.menuUserKey('john doe'), store.menuUserKey('CORP\\jdoe'));
  assert.equal(store.menuUserKey(''), null);
  assert.equal(store.menuUserKey('   '), null);
  assert.equal(store.menuUserKey(null), null);
  assert.equal(store.menuUserKey({ toString: 1 }), null, '문자열이 아니면 String() 을 부르지 않는다');
});

test('① AD 형식·대소문자 변형 이름이 같은 메뉴를 본다(실제 라우터)', async () => {
  for (const u of ['ad1', 'sp', 'mixed']) {
    const g = await call(u, 'GET', '/user-menu');
    assert.equal(g.s, 200, `${u} GET → ${g.s} ${JSON.stringify(g.j)}`);
    assert.equal(g.j.mine, null);
  }
  assert.equal((await call('ad1', 'PUT', '/user-menu', { menu: MENU_A })).s, 200);
  const twin = await call('ad1b', 'GET', '/user-menu');
  assert.deepEqual(twin.j.mine.groups.map((g) => g.id), ['g-overview', 'g-vms', 'tools'], 'corp\\JDOE 는 CORP\\jdoe 의 메뉴를 본다');
  assert.equal((await call('sp', 'PUT', '/user-menu', { menu: MENU_B })).s, 200);
  assert.deepEqual((await call('sp', 'GET', '/user-menu')).j.mine.groups.map((g) => g.id), ['g-summary', 'g-hosts', 'tools']);
  assert.equal((await call('mixed', 'PUT', '/user-menu', { menu: MENU_A })).s, 200);
  assert.deepEqual((await call('lower', 'GET', '/user-menu')).j.mine.groups.map((g) => g.id), ['g-overview', 'g-vms', 'tools'], "' jdoe ' 는 'JDoe' 의 메뉴를 본다");
  const j = JSON.parse(fs.readFileSync(path.join(tmp, 'user-menus.json'), 'utf8'));
  assert.ok(j.users.jdoe, '저장 키는 소문자');
  assert.equal(j.users.JDoe, undefined);
  assert.ok(Object.keys(j.users).some((k) => /^h:[0-9a-f]{16}$/.test(k)), 'AD 이름은 해시 키로 저장');
  // 정리
  for (const u of ['ad1', 'sp', 'mixed']) await call(u, 'DELETE', '/user-menu');
});

test('② 옛 파일의 대소문자만 다른 키는 로드 때 가장 최근 쪽으로 합친다(console.warn 1줄)', async () => {
  const file = path.join(tmp, 'user-menus.json');
  const old = {
    v: 1, distributed: null, history: [],
    users: {
      JDoe: { menu: { v: 1, groups: MENU_A.groups }, updatedAt: 100 },
      jdoe: { menu: { v: 1, groups: MENU_B.groups }, updatedAt: 200 },
      'CORP\\jdoe': { menu: { v: 1, groups: MENU_A.groups }, updatedAt: 300 },
      Op1: { menu: { v: 1, groups: MENU_B.groups }, updatedAt: 50, prev: { menu: { v: 1, groups: MENU_A.groups }, at: 400, by: 'noainred', mode: 'force' } },
      op1: { menu: { v: 1, groups: MENU_A.groups }, updatedAt: 350 },
    },
  };
  fs.writeFileSync(file, JSON.stringify(old));
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  try {
    store.invalidateUserMenus();
    const g = await call('lower', 'GET', '/user-menu');
    assert.deepEqual(g.j.mine.groups.map((x) => x.id), ['g-summary', 'g-hosts', 'tools'], 'updatedAt 200 쪽(jdoe)이 100 쪽(JDoe)을 이긴다');
    const ad = await call('ad1b', 'GET', '/user-menu');
    assert.deepEqual(ad.j.mine.groups.map((x) => x.id), ['g-overview', 'g-vms', 'tools'], '옛 원문 키 CORP\\jdoe 는 해시 키로 옮겨져 corp\\JDOE 가 본다');
    const op = await call('op', 'GET', '/user-menu');
    assert.deepEqual(op.j.mine.groups.map((x) => x.id), ['g-summary', 'g-hosts', 'tools'], 'prev.at 400 을 가진 Op1 레코드가 updatedAt 350 보다 최근');
    assert.equal(op.j.prev.mode, 'force');
  } finally { console.warn = orig; }
  const mine = warns.filter((w) => w.includes('[usermenu]') && w.includes('정규형'));
  assert.equal(mine.length, 1, `병합 사실은 console.warn 1줄: ${JSON.stringify(warns)}`);
  assert.match(mine[0], /JDoe→jdoe/);
  // 다음 저장이 정규형 키로 굳는다
  assert.equal((await call('view', 'PUT', '/user-menu', { menu: MENU_A })).s, 200);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(j.users).filter((k) => /jdoe/i.test(k)), ['jdoe']);
  assert.equal(j.users.Op1, undefined);
  fs.writeFileSync(file, JSON.stringify({ v: 1, users: {}, distributed: null, history: [] }));
  store.invalidateUserMenus();
});

test('③ 라벨 41자는 400 · {toString:1} 객체는 500 이 아니라 400 (field)', async () => {
  const long = await call('view', 'PUT', '/user-menu', { menu: { groups: [{ id: 'a', label: 'x'.repeat(41), tab: 'vms' }] } });
  assert.equal(long.s, 400);
  assert.equal(long.j.field, 'groups');
  assert.match(long.j.reason, /최대 40자/);
  const ok40 = await call('view', 'PUT', '/user-menu', { menu: { groups: [{ id: 'a', label: 'x'.repeat(40), tab: 'vms' }] } });
  assert.equal(ok40.s, 200);
  assert.equal(ok40.j.menu.groups[0].label.length, 40);
  const trap = { toString: 1 };
  const cases = [
    [{ groups: [{ id: trap, tab: 'vms' }] }, 'groups'],
    [{ groups: [{ id: 'a', label: trap, tab: 'vms' }] }, 'groups'],
    [{ groups: [{ id: 'a', tab: trap }] }, 'groups'],
    [{ groups: [{ id: 'a', children: [{ tool: trap }] }] }, 'children'],
    [{ groups: [{ id: 'a', children: [{ tab: trap }] }] }, 'children'],
    [{ groups: [{ id: 'a', children: [{ tool: 'gpu', seg: trap }] }] }, 'children'],
    [{ groups: [{ id: 'a', label: ['x'], tab: 'vms' }] }, 'groups'],
  ];
  for (const [menu, field] of cases) {
    const r = await call('view', 'PUT', '/user-menu', { menu });
    assert.equal(r.s, 400, `${JSON.stringify(menu)} → ${r.s} ${JSON.stringify(r.j)}`);
    assert.equal(r.j.field, field);
    assert.match(r.j.reason, /문자열이 아닙니다/);
  }
  await call('view', 'DELETE', '/user-menu');
});

test('④ 저장은 직전 메뉴를 prev(save)로 보관하고 restore-prev 로 되돌린다 · 같은 내용 재저장은 prev 불변', async () => {
  const a = await call('adm', 'PUT', '/user-menu', { menu: MENU_A });
  assert.equal(a.s, 200);
  assert.equal(a.j.prevKept, false, '첫 저장은 보관할 직전 메뉴가 없다');
  assert.equal((await call('adm', 'GET', '/user-menu')).j.prev, null);
  const b = await call('adm', 'PUT', '/user-menu', { menu: MENU_B });
  assert.equal(b.s, 200);
  assert.equal(b.j.prevKept, true);
  let g = await call('adm', 'GET', '/user-menu');
  assert.deepEqual(g.j.mine.groups.map((x) => x.id), ['g-summary', 'g-hosts', 'tools']);
  assert.equal(g.j.prev.mode, 'save');
  assert.equal(g.j.prev.by, 'adm', 'admin 역할은 보관자를 본다(본인)');
  assert.ok(Number.isFinite(g.j.prev.at));
  // 같은 내용을 다시 저장 — prev 는 그대로(강제 배포 prev 를 잃지 않기 위한 규칙과 같다)
  const again = await call('adm', 'PUT', '/user-menu', { menu: MENU_B });
  assert.equal(again.j.prevKept, false);
  const g2 = await call('adm', 'GET', '/user-menu');
  assert.equal(g2.j.prev.at, g.j.prev.at, '같은 내용 재저장은 prev 를 건드리지 않는다');
  // 복원 → A 로 돌아오고 prev 는 비운다
  const rs = await call('adm', 'POST', '/user-menu/restore-prev');
  assert.equal(rs.s, 200);
  assert.deepEqual(rs.j.menu.groups.map((x) => x.id), ['g-overview', 'g-vms', 'tools']);
  g = await call('adm', 'GET', '/user-menu');
  assert.deepEqual(g.j.mine.groups.map((x) => x.id), ['g-overview', 'g-vms', 'tools']);
  assert.equal(g.j.prev, null);
  // 강제 배포가 남긴 prev(force) 는 다음 저장의 prev(save) 가 덮는다 — 한 단계뿐이고 mode 가 그 사실을 말한다
  assert.equal((await call('view', 'PUT', '/user-menu', { menu: MENU_A })).s, 200);
  assert.equal((await call('sup', 'PUT', '/user-menu', { menu: MENU_B })).s, 200);
  assert.equal((await call('sup', 'POST', '/user-menu/distribute', { mode: 'force' })).s, 200);
  g = await call('view', 'GET', '/user-menu');
  assert.equal(g.j.mine, null);
  assert.equal(g.j.prev.mode, 'force');
  assert.equal((await call('view', 'PUT', '/user-menu', { menu: MENU_B })).s, 200);
  g = await call('view', 'GET', '/user-menu');
  assert.equal(g.j.prev.mode, 'force', '내 메뉴가 없던 상태에서의 첫 저장은 prev(force) 를 그대로 둔다');
  assert.equal((await call('view', 'PUT', '/user-menu', { menu: MENU_A })).s, 200);
  g = await call('view', 'GET', '/user-menu');
  assert.equal(g.j.prev.mode, 'save');
  const audit = fs.readFileSync(path.join(tmp, 'audit.ndjson'), 'utf8');
  assert.match(audit, /"action":"user-menu\.save"[^\n]*prev=save/);
});

test('⑤ 배포자·보관자 계정명(by)은 admin 역할에게만 — viewer·operator·데모 계정 응답에는 필드 자체가 없다', async () => {
  // ④ 의 force 배포가 남아 있다(view1 은 prev, distributed 있음)
  for (const u of ['view', 'op', 'demo']) {
    const g = await call(u, 'GET', '/user-menu');
    assert.equal(g.s, 200, u);
    assert.ok(g.j.distributed, u);
    assert.equal('by' in g.j.distributed, false, `${u}: distributed.by 없음`);
    assert.equal(g.j.distributed.mode, 'force');
    if (g.j.prev) assert.equal('by' in g.j.prev, false, `${u}: prev.by 없음`);
  }
  const adm = await call('adm', 'GET', '/user-menu');
  assert.equal(adm.j.distributed.by, 'noainred');
  const sup = await call('sup', 'GET', '/user-menu');
  assert.equal(sup.j.distributed.by, 'noainred');
  assert.equal((await call('sup', 'DELETE', '/user-menu/distribute')).s, 200);
});

test('⑥ A-09 — 저장소의 400 오류가 GET 에서도 400 이다(500 금지) · 두 GET 핸들러가 fail() 로 감싸여 있다', async () => {
  const g = await call('blank', 'GET', '/user-menu');
  assert.equal(g.s, 400, JSON.stringify(g.j));
  assert.equal(g.j.ok, false);
  assert.match(g.j.reason, /사용자 이름/);
  const src = stripComments(read('routes/api/userMenu.js'));
  const gets = src.match(/api\.get\('\/user-menu[^']*',[\s\S]*?\n  \}\);/g) || [];
  assert.equal(gets.length, 2);
  for (const h of gets) assert.match(h, /catch \(e\) \{ fail\(res, e, next\); \}/, h.slice(0, 60));
  // A-10: 응답의 by 는 seesNames 를 거친다(라우트가 d.by 를 그대로 싣지 않는다)
  assert.doesNotMatch(src, /by: d\.by, mode/);
  assert.match(src, /seesNames\(req\)/);
});
