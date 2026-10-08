/**
 * userMenu2726.test.js — 계정별 좌측 메뉴(내 메뉴)·슈퍼 관리자 배포(v2.726) 회귀.
 *
 * 실제 `api` 라우터를 express 에 마운트하고 역할을 바꿔 가며 **상태코드로** 본다(소스 grep 이 아니다 — v2.536 규약).
 * 고정하는 것: ① 검증(모양·상한·중복·빈 그룹) ② 누구나 자기 메뉴를 저장·삭제·복원한다 ③ 배포는 super_admin + 전체 범위만
 * (역할 admin 은 `super-admin-only`) ④ 강제 배포는 직접 만든 메뉴를 prev 로 옮기고, 유지 배포는 건드리지 않는다
 * ⑤ 손상 파일은 보존하고 빈 저장소로 시작한다 ⑥ 감사 로그 ⑦ 라우터 등록·게이트 이름 등재.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usermenu2726-'));
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
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-us-east'] } },
  sup: { username: 'noainred', role: 'admin', superAdmin: true, scope: null },
  ssup: { username: 'sup2', role: 'admin', superAdmin: true, scope: { vcenters: ['vc-us-east'] } },
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
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
});
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

async function call(u, method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* */ }
  return { s: r.status, j };
}
const MENU = { groups: [
  { id: 'overview', tab: 'overview' },
  { id: 'server', label: '서버', children: [{ tab: 'vms' }, { tab: 'hosts' }, { tool: 'esxitemp' }] },
  { id: 'mine-1', label: '내 그룹', children: [{ tool: 'serveranalysis', seg: 'baremetal' }, { tool: 'gpu' }] },
  { id: 'tools', tab: 'tools' },
] };

test('① normalizeMenu — 모양·상한·중복·빈 그룹', () => {
  assert.throws(() => store.normalizeMenu(null), /groups/);
  assert.throws(() => store.normalizeMenu({ groups: [{ id: 'bad id', tab: 'vms' }] }), /그룹 id/);
  assert.throws(() => store.normalizeMenu({ groups: [{ id: 'a', children: [{ tool: '../x' }] }] }), /도구 키/);
  assert.throws(() => store.normalizeMenu({ groups: [{ id: 'a', tab: 'vms' }, { id: 'a', tab: 'hosts' }] }), /겹칩니다/);
  assert.throws(() => store.normalizeMenu({ groups: Array.from({ length: 41 }, (_, i) => ({ id: `g${i}`, tab: `t${i}` })) }), /최대 40개/);
  assert.throws(() => store.normalizeMenu({ groups: [{ id: 'a', children: Array.from({ length: 401 }, (_, i) => ({ tool: `k${i}` })) }] }), /최대 400개/);
  assert.throws(() => store.normalizeMenu({ groups: [{ id: 'a', children: [] }] }), /하나도 없습니다/);
  const r = store.normalizeMenu({ groups: [
    { id: 'server', label: 'x'.repeat(80), children: [{ tab: 'vms' }, { tab: 'vms' }, { tool: 'gpu' }] },
    { id: 'empty', children: [] },
    { id: 'again', children: [{ tool: 'gpu' }] },
    { id: 'tools', tab: 'tools' },
  ] });
  assert.equal(r.dedup, 2, 'vms 중복 1 + gpu 중복 1');
  assert.equal(r.emptyDropped, 2, '빈 그룹 1 + 중복만 남아 비게 된 그룹 1');
  assert.deepEqual(r.menu.groups.map((g) => g.id), ['server', 'tools']);
  assert.equal(r.menu.groups[0].label.length, 40);
  assert.deepEqual(r.menu.groups[0].children, [{ tab: 'vms' }, { tool: 'gpu' }]);
  assert.equal(r.menu.v, 1);
});

test('② 누구나(viewer) 자기 메뉴를 저장·조회·삭제한다 — 400 은 사유와 field 를 돌려준다', async () => {
  let g = await call('view', 'GET', '/user-menu');
  assert.equal(g.s, 200);
  assert.equal(g.j.mine, null);
  assert.equal(g.j.distributed, null);
  assert.equal(g.j.canDistribute, false);
  assert.ok(Array.isArray(g.j.categories));
  const bad = await call('view', 'PUT', '/user-menu', { menu: { groups: [{ id: 'x', children: [{ tool: 'a b' }] }] } });
  assert.equal(bad.s, 400);
  assert.equal(bad.j.field, 'children');
  const put = await call('view', 'PUT', '/user-menu', { menu: MENU });
  assert.equal(put.s, 200, JSON.stringify(put.j));
  assert.equal(put.j.menu.groups.length, 4);
  g = await call('view', 'GET', '/user-menu');
  assert.deepEqual(g.j.mine.groups.map((x) => x.id), ['overview', 'server', 'mine-1', 'tools']);
  // 다른 사용자에게는 보이지 않는다
  const other = await call('op', 'GET', '/user-menu');
  assert.equal(other.j.mine, null);
  const del = await call('view', 'DELETE', '/user-menu');
  assert.equal(del.s, 200);
  assert.equal(del.j.removed, true);
  g = await call('view', 'GET', '/user-menu');
  assert.equal(g.j.mine, null);
  const again = await call('view', 'DELETE', '/user-menu');
  assert.equal(again.j.removed, false);
  const noPrev = await call('view', 'POST', '/user-menu/restore-prev');
  assert.equal(noPrev.s, 404);
});

test('③ 배포 게이트 — viewer·operator·역할 admin·범위 제한 super_admin 은 403, 전체 범위 super_admin 만 통과', async () => {
  for (const [u, p] of [['view', 'GET'], ['op', 'POST'], ['adm', 'POST'], ['adm', 'GET'], ['adm', 'DELETE']]) {
    const r = await call(u, p, '/user-menu/distribute', p === 'POST' ? { mode: 'keep' } : undefined);
    assert.equal(r.s, 403, `${u} ${p} → ${r.s}`);
    assert.equal(r.j.error, 'forbidden');
  }
  const adm = await call('adm', 'POST', '/user-menu/distribute', { mode: 'keep' });
  assert.equal(adm.j.reason, 'super-admin-only');
  assert.equal(adm.j.requiredRole, 'super_admin');
  const ss = await call('ssup', 'POST', '/user-menu/distribute', { mode: 'keep' });
  assert.equal(ss.s, 403, '범위 제한 super_admin 은 fleet 게이트에 걸린다');
  // 내 메뉴 없이 배포 → 400
  const noMine = await call('sup', 'POST', '/user-menu/distribute', { mode: 'keep' });
  assert.equal(noMine.s, 400);
  assert.match(noMine.j.reason, /먼저 내 메뉴/);
  const st = await call('sup', 'GET', '/user-menu/distribute');
  assert.equal(st.s, 200);
  assert.equal(st.j.hasMine, false);
  assert.ok(st.j.users >= 1, '로컬 계정 수(시드된 admin·noainred·demo)');
});

test('④ 유지 배포는 직접 만든 메뉴를 두고, 강제 배포는 prev 로 옮긴다 — 복원·철회', async () => {
  // view1·op1 이 직접 만든 메뉴를 갖는다
  assert.equal((await call('view', 'PUT', '/user-menu', { menu: MENU })).s, 200);
  assert.equal((await call('op', 'PUT', '/user-menu', { menu: MENU })).s, 200);
  // 슈퍼 관리자가 자기 메뉴를 저장
  const SUP_MENU = { groups: [{ id: 'overview', tab: 'overview' }, { id: 'net', label: '네트워크', children: [{ tab: 'networks' }, { tool: 'cvp' }] }, { id: 'tools', tab: 'tools' }] };
  assert.equal((await call('sup', 'PUT', '/user-menu', { menu: SUP_MENU })).s, 200);
  const badMode = await call('sup', 'POST', '/user-menu/distribute', { mode: 'bogus' });
  assert.equal(badMode.s, 400);
  assert.equal(badMode.j.field, 'mode');
  // keep
  const keep = await call('sup', 'POST', '/user-menu/distribute', { mode: 'keep' });
  assert.equal(keep.s, 200, JSON.stringify(keep.j));
  assert.equal(keep.j.counts.forced, 0);
  assert.equal(keep.j.counts.custom, 3, 'view1 · op1 · noainred');
  let g = await call('view', 'GET', '/user-menu');
  assert.ok(g.j.mine, 'keep 은 내 메뉴를 건드리지 않는다');
  assert.equal(g.j.distributed.mode, 'keep');
  assert.deepEqual(g.j.distributed.menu.groups.map((x) => x.id), ['overview', 'net', 'tools']);
  assert.equal(g.j.prev, null);
  // force
  const force = await call('sup', 'POST', '/user-menu/distribute', { mode: 'force' });
  assert.equal(force.s, 200);
  assert.equal(force.j.counts.forced, 2, '배포자 자신은 빼고 view1·op1');
  g = await call('view', 'GET', '/user-menu');
  assert.equal(g.j.mine, null, 'force 는 내 메뉴를 지운다');
  assert.equal(g.j.prev.mode, 'force');
  assert.equal(g.j.prev.by, 'noainred');
  const sup = await call('sup', 'GET', '/user-menu');
  assert.ok(sup.j.mine, '배포자 자신의 메뉴는 그대로');
  // 복원
  const rs = await call('view', 'POST', '/user-menu/restore-prev');
  assert.equal(rs.s, 200);
  assert.deepEqual(rs.j.menu.groups.map((x) => x.id), ['overview', 'server', 'mine-1', 'tools']);
  g = await call('view', 'GET', '/user-menu');
  assert.ok(g.j.mine);
  assert.equal(g.j.prev, null);
  // 현황·기록
  const st = await call('sup', 'GET', '/user-menu/distribute');
  assert.equal(st.j.distributed.mode, 'force');
  assert.equal(st.j.history.length, 2);
  assert.equal(st.j.history[0].mode, 'force');
  // 철회
  const clr = await call('sup', 'DELETE', '/user-menu/distribute');
  assert.equal(clr.j.removed, true);
  g = await call('op', 'GET', '/user-menu');
  assert.equal(g.j.distributed, null);
  assert.equal(g.j.prev.mode, 'force', '철회는 사용자의 prev 를 건드리지 않는다');
  // 감사 로그
  const audit = fs.readFileSync(path.join(tmp, 'audit.ndjson'), 'utf8');
  assert.match(audit, /"action":"user-menu\.distribute"/);
  assert.match(audit, /"action":"user-menu\.restore"/);
  assert.match(audit, /"action":"user-menu\.distribute-clear"/);
  assert.doesNotMatch(audit, /"user":"\[object/);
});

test('⑤ 손상 파일은 보존하고 빈 저장소로 시작한다 — 다음 저장이 손상본을 덮지 않는다', async () => {
  const file = path.join(tmp, 'user-menus.json');
  fs.writeFileSync(file, '{ not json');
  store.invalidateUserMenus();
  const g = await call('view', 'GET', '/user-menu');
  assert.equal(g.s, 200);
  assert.equal(g.j.mine, null);
  assert.ok(fs.readdirSync(tmp).some((n) => n.startsWith('user-menus.json.corrupt.')), '손상본 보존');
  assert.equal((await call('view', 'PUT', '/user-menu', { menu: MENU })).s, 200);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(j.users.view1?.menu);
  // 저장된 파일을 다시 읽어도 같은 결과(재시작 재현)
  store.invalidateUserMenus();
  assert.equal(store.userMenuOf('view1').mine.groups.length, 4);
});

test('⑥ 배선 — 라우터 등록·게이트 이름 등재·알려진 설정 파일', () => {
  assert.match(read('routes/api.js'), /registerUserMenu\(api\)/);
  const doc = fs.readFileSync(path.join(HERE, '..', '..', 'scripts', 'api-doc.mjs'), 'utf8');
  assert.match(doc, /requireSuperAdmin:/);
  assert.match(doc, /menuFleetOnly:/);
  assert.match(read('portalcheck/archScan.js'), /'user-menus\.json'/);
  // 배포 라우트 3개는 전부 adminOnly + 전체 범위 + super_admin 순서다
  const src = stripComments(read('routes/api/userMenu.js'));
  const dist = src.match(/api\.(get|post|delete)\('\/user-menu\/distribute',[^\n]*/g) || [];
  assert.equal(dist.length, 3);
  for (const line of dist) assert.match(line, /adminOnly, menuFleetOnly, requireSuperAdmin/);
});
