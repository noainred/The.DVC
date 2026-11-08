/**
 * test/sanStorage2947gate.test.js — v2.947 SAN 스토리지 성능 라우트의 **권한 · 범위 게이트**(인증 켬 · req.user 주입 — toolNames2679 와 같은 방식).
 *  · 조회(GET)는 tools 권한 + 전체 범위 — 범위 제한 관리자는 403(SAN 은 vCenter 귀속 없는 인프라).
 *  · 매핑 · 임계값 PUT 은 admin + 조회 · 쓰기 전체 범위 — operator 403 · 범위 admin 403 · 쓰기 범위만 줄인 admin 403 · 전체 범위 admin 은 본문 검사까지 간다(400).
 *  · 포트 이름 CSV 는 data.csv + admin.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sanstorage2947g-'));
process.env.CONFIG_DIR = tmp;
process.env.SANSW_PERF_ROLLUP_BACKFILL = '0';
Object.assign(process.env, { DATA_SOURCE: 'mock', AUTH_ENABLED: 'true', IPAM_WRITE_WORKER: '0' });

const USERS = {
  full: { username: 'full', role: 'admin', scope: null },
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-us-east'] } },
  wadm: { username: 'wadm', role: 'admin', scope: { vcenters: [], writeVcenters: ['vc-us-east'] } },
  op: { username: 'op', role: 'operator', scope: null },
};
let srv; let base;
before(async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
});
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

async function call(u, method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, j, t };
}

test('조회 — 범위 제한 관리자 403 · 전체 범위는 200(빈 법인 필터라 집계 없음)', async () => {
  // 법인 필터를 존재하지 않는 값으로 — 장비 0대라 무거운 집계 없이 게이트만 본다.
  const a = await call('sadm', 'GET', '/tools/san-storage?datacenterId=__nope__');
  assert.equal(a.s, 403, a.t.slice(0, 200));
  const b = await call('full', 'GET', '/tools/san-storage?datacenterId=__nope__');
  assert.equal(b.s, 200, b.t.slice(0, 200)); assert.deepEqual(b.j.rows, []);
  const c = await call('sadm', 'GET', '/tools/san-storage/check?datacenterId=__nope__');
  assert.equal(c.s, 403);
  const d = await call('sadm', 'GET', '/tools/san-storage/check-settings');
  assert.equal(d.s, 403);
  const e = await call('full', 'GET', '/tools/san-storage/check-settings');
  assert.equal(e.s, 200); assert.equal(e.j.values.dirBusyBadPct, 70);
});

test('쓰기 — operator · 범위 admin · 쓰기 범위 admin 은 403, 전체 범위 admin 은 본문 검사(400)까지 간다', async () => {
  for (const u of ['op', 'sadm', 'wadm']) {
    assert.equal((await call(u, 'PUT', '/tools/san-storage/mapping', { kinds: {} })).s, 403, `mapping ${u}`);
    assert.equal((await call(u, 'PUT', '/tools/san-storage/check-settings', { values: {} })).s, 403, `settings ${u}`);
  }
  const bad = await call('full', 'PUT', '/tools/san-storage/mapping', { kinds: { k: 'maybe' } });
  assert.equal(bad.s, 400); assert.match(bad.j.reason, /array · host/);
  const bad2 = await call('full', 'PUT', '/tools/san-storage/check-settings', { values: { nope: 1 } });
  assert.equal(bad2.s, 400);
  const ok = await call('full', 'PUT', '/tools/san-storage/mapping', { kinds: {}, directors: {} });
  assert.equal(ok.s, 200);
  assert.ok(fs.existsSync(path.join(tmp, 'san-storage-map.json')), '원자 쓰기로 저장됨');
});

test('포트 이름 CSV — operator 403 · 범위 admin 403 · 전체 범위 admin 200', async () => {
  assert.equal((await call('op', 'GET', '/tools/san-storage/port-names.csv?datacenterId=__nope__')).s, 403);
  assert.equal((await call('sadm', 'GET', '/tools/san-storage/port-names.csv?datacenterId=__nope__')).s, 403);
  const ok = await call('full', 'GET', '/tools/san-storage/port-names.csv?datacenterId=__nope__');
  assert.equal(ok.s, 200, ok.t.slice(0, 200)); assert.match(ok.t, /연결 장비 이름/);
});
