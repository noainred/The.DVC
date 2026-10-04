// v2.689 G3 — 조회 게이트 비대칭 회귀 고정(형제 변경 라우트는 이미 막혀 있었는데 조회 GET 만 열려 있던 것).
//   GET /admin/host-access  : 허용 CIDR·방화벽 엔진 규칙·sudoers 힌트 → 전체 범위 + 설정 소유자(형제 변경 라우트와 같은 등급)
//   GET /admin/emergency-stop: 상태는 범위 관리자도 보되 승인 관리자 계정명(by)은 전체 범위만(POST 는 v2.612 에 막혔다)
//   GET /admin/memtrack     : 서버 전역 자기진단 → 전체 범위(같은 파일의 portal-db·logs 와 같은 기준)
// 실제 adminRouter 를 express 에 띄워 **상태코드**로 본다(AUTH_ENABLED=true — 꺼져 있으면 requireRole 이 모두 통과한다).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g3gates2689-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';

let srv, base;
const USERS = {
  owner: { username: 'noainred', role: 'admin', scope: null },     // 설정 소유자(항상 포함) · 전체 범위
  full: { username: 'full-g3', role: 'admin', scope: null },       // 전체 범위지만 소유자 아님
  sadm: { username: 'sadm-g3', role: 'admin', scope: { vcenters: ['vc-us-east'] } }, // 범위 관리자
};
before(async () => {
  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api/admin', adminRouter);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api/admin`;
});
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

async function get(u, p) {
  const r = await fetch(base + p, { headers: { 'x-u': u } });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, j, t };
}

test('GET /host-access: 범위 관리자 403(전체 범위) · 비소유 admin 403(소유자) · 소유자는 통과', async () => {
  const sc = await get('sadm', '/host-access');
  assert.equal(sc.s, 403, sc.t.slice(0, 160));
  assert.equal(sc.j?.error, 'forbidden');
  assert.notEqual(sc.j?.requiredOwner, true, '범위 판정이 먼저다(사유가 범위여야 한다)');
  const nf = await get('full', '/host-access');
  assert.equal(nf.s, 403, nf.t.slice(0, 160));
  assert.equal(nf.j?.requiredOwner, true, '설정 소유자가 아니면 403(requiredOwner)');
  const ok = await get('owner', '/host-access');
  assert.notEqual(ok.s, 403, ok.t.slice(0, 160));
});

test('GET /emergency-stop: 범위 관리자는 상태(active)만 — 승인자 계정명(by)은 가리고 가린 사실을 밝힌다', async () => {
  const es = await import('../src/security/emergencyStop.js');
  es.setEmergencyStop(true, ['boss-a', 'boss-b']);
  try {
    const sc = await get('sadm', '/emergency-stop');
    assert.equal(sc.s, 200, sc.t.slice(0, 160));
    assert.equal(sc.j?.active, true, '상태는 범위 관리자도 본다(v2.612 판단)');
    assert.deepEqual(sc.j?.by, [], '승인자 계정명이 실리면 안 된다');
    assert.equal(sc.j?.byHidden, true);
    assert.ok(!sc.t.includes('boss-a'), sc.t);
    const f = await get('full', '/emergency-stop');
    assert.equal(f.s, 200, f.t.slice(0, 160));
    assert.deepEqual(f.j?.by, ['boss-a', 'boss-b'], '전체 범위 admin 은 승인자를 본다');
  } finally { es.setEmergencyStop(false, ['boss-a', 'boss-b']); }
});

test('GET /memtrack: 범위 관리자 403 · 전체 범위 admin 은 403 아님', async () => {
  const sc = await get('sadm', '/memtrack');
  assert.equal(sc.s, 403, sc.t.slice(0, 160));
  assert.equal(sc.j?.error, 'forbidden');
  const f = await get('full', '/memtrack');
  assert.notEqual(f.s, 403, f.t.slice(0, 160));
});
