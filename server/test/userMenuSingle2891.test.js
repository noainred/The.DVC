/**
 * test/userMenuSingle2891.test.js — v2.891 단독 메뉴(사용자 요청 '메뉴 수정에서 단독 메뉴로 추가하는 기능 만들어줘').
 *  ① normalizeMenu: 최상위 { id, tool, seg? } 를 받는다 · 형식 검사(도구 키 · 조각) · 같은 항목은 단독 · 그룹 통틀어 앞의 것만 · 항목 수에 센다
 *  ② 실제 api 라우터: 저장 → 조회 왕복(단독 도구 · 그룹 항목 tab 단독) · 400 field
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usermenu2891-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';

let srv, base, store;
before(async () => {
  const express = (await import('express')).default;
  store = await import('../src/usermenu/store.js');
  const { api } = await import('../src/routes/api.js');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = { username: 'view1', role: 'viewer', scope: null }; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
});
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
const call = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { s: r.status, j: await r.json().catch(() => null) };
};

test('① normalizeMenu — 최상위 단독 도구', () => {
  const r = store.normalizeMenu({ groups: [
    { id: 'overview', tab: 'overview' },
    { id: 'custom-1', tool: 'gpu' },
    { id: 'custom-2', tool: 'serveranalysis', seg: 'baremetal' },
    { id: 'custom-3', tab: 'vms' },
    { id: 'server', children: [{ tab: 'vms' }, { tool: 'gpu' }, { tab: 'hosts' }] },   // 단독과 겹치는 vms · gpu 는 버린다
    { id: 'custom-4', tool: 'gpu' },                                                   // 같은 단독 두 번 — 뒤의 것 버림
  ] });
  assert.deepEqual(r.menu.groups, [
    { id: 'overview', tab: 'overview' },
    { id: 'custom-1', tool: 'gpu' },
    { id: 'custom-2', tool: 'serveranalysis', seg: 'baremetal' },
    { id: 'custom-3', tab: 'vms' },
    { id: 'server', children: [{ tab: 'hosts' }] },
  ]);
  assert.equal(r.dedup, 3);
  assert.throws(() => store.normalizeMenu({ groups: [{ id: 'a', tool: '../x' }] }), (e) => /도구 키/.test(e.message) && e.field === 'groups');
  assert.throws(() => store.normalizeMenu({ groups: [{ id: 'a', tool: 'gpu', seg: 'a b' }] }), /주소 조각/);
  assert.throws(() => store.normalizeMenu({ groups: [{ id: 'a', tool: { toString: 1 } }] }), /문자열이 아닙니다/);
  // tab 이 있으면 tab 이 이긴다(예전 모양 그대로)
  assert.deepEqual(store.normalizeMenu({ groups: [{ id: 'a', tab: 'vms', tool: 'gpu' }] }).menu.groups, [{ id: 'a', tab: 'vms' }]);
  // 항목 상한에 단독도 센다
  assert.throws(() => store.normalizeMenu({ groups: [{ id: 'a', tool: 'k0' }, { id: 'b', children: Array.from({ length: 400 }, (_, i) => ({ tool: `k${i + 1}` })) }] }), /최대 400개/);
});

test('② 실제 라우터 — 저장 · 조회 왕복 · 400 field', async () => {
  const menu = { groups: [{ id: 'custom-1', tool: 'gpu' }, { id: 'custom-2', tab: 'vms' }, { id: 'tools', tab: 'tools' }] };
  const put = await call('PUT', '/user-menu', { menu });
  assert.equal(put.s, 200, JSON.stringify(put.j));
  const g = await call('GET', '/user-menu');
  assert.deepEqual(g.j.mine.groups, menu.groups);
  const bad = await call('PUT', '/user-menu', { menu: { groups: [{ id: 'x', tool: 'a b' }] } });
  assert.equal(bad.s, 400);
  assert.equal(bad.j.field, 'groups');
});
