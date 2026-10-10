/**
 * test/audit2733i_guestScanWrite.test.js — 게스트 조사 작업(`/admin/security/guest-scans`)이 **쓰기 범위**(writeVcenters)를 지키는가
 * (v2.733 점검 3회차 C3-02a).
 *
 * 결함(재현): PUT·DELETE·run 의 바깥 조건이 `scopedVcenterIds`(조회 범위)라, '조회 무제한 + writeVcenters 지정' 계정(fwa)은 쓰기
 *   범위 검사 자체를 건너뛰었다 — 수정 권한이 없는 vCenter B 의 게스트에 로그인·명령을 실행하는 작업을 저장(200)·실행(200)했다.
 *   형제 `/admin/guest/add-user`·`/admin/deep-search/probe`(게스트 명령 = 상태 변경 등급)는 쓰기 범위다.
 * 응답 규약(server/CLAUDE.md v2.369): 조회 범위 밖 404(존재 은닉) · 조회는 되는데 쓰기 범위 밖 403. GET 은 조회 범위로 보여 주고
 *   쓰기 밖 작업에는 `writable:false` 를 단다(형제 `GET /vm/:id/hardware` 는 조회 범위만 본다).
 * ⚠ 실제 adminRouter 를 express 에 마운트해 상태코드·파일 상태로 본다(소스 grep 이 아니다).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2733i-gs-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';

const A = 'vc-us-east';
const B = 'vc-eu-west';
const USERS = {
  full: null,
  fwa: { vcenters: [], regions: [], writeVcenters: [A] },          // 조회 전체 · 수정 A
  wsa: { vcenters: [A, B], regions: [], writeVcenters: [A] },      // 조회 A·B · 수정 A
  sadm: { vcenters: [A], regions: [] },                            // 조회 A(쓰기 = 조회)
};

let base; let srv;
before(async () => {
  const { store } = await import('../src/store.js');
  await store.refresh?.();
  const ids = new Set((store.get().vcenters || []).map((v) => v.id));
  assert.ok(ids.has(A) && ids.has(B), `목 스냅샷에 ${A}·${B} 가 있어야 한다: ${[...ids].join(',')}`);
  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express(); app.use(express.json());
  app.use((req, _r, n) => {
    const name = req.headers['x-u'] || 'full';
    req.user = { username: name, role: 'admin', scope: USERS[name] ?? null };
    n();
  });
  app.use('/api/admin', adminRouter);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(async () => {
  await new Promise((r) => { srv?.closeAllConnections?.(); srv?.close(r); });
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

const call = async (u, method, p, b) => {
  const r = await fetch(`${base}/api/admin${p}`, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t; }
  return { s: r.status, j };
};
const jobsOf = async (u) => (await call(u, 'GET', '/security/guest-scans')).j;

test('C3-02a 조회 무제한 + writeVcenters(fwa): 쓰기 범위 밖 vCenter 의 게스트 조사 작업 저장·수정·삭제·실행은 403', async () => {
  assert.equal((await call('full', 'PUT', '/security/guest-scans', { id: 'job-B', vcenterId: B, type: 'login-fails', name: 'eu' })).s, 200);
  assert.equal((await call('full', 'PUT', '/security/guest-scans', { id: 'job-A', vcenterId: A, type: 'net-issues', name: 'us' })).s, 200);

  let r = await call('fwa', 'PUT', '/security/guest-scans', { id: 'job-fwaB', vcenterId: B, type: 'login-fails', name: 'x' });
  assert.equal(r.s, 403, `수정 전: 200 — 쓰기 범위 밖 B 게스트에 로그인하는 작업이 저장됐다: ${JSON.stringify(r.j)}`);
  r = await call('fwa', 'PUT', '/security/guest-scans', { id: 'job-fwaE', vcenterId: '', type: 'login-fails', name: 'x' });
  assert.equal(r.s, 403, 'vCenter 를 비운 작업도 쓰기 범위 계정은 만들 수 없다');
  r = await call('fwa', 'PUT', '/security/guest-scans', { id: 'job-B', vcenterId: A, name: 'mine' });
  assert.equal(r.s, 403, '쓰기 범위 밖 작업을 자기 범위로 옮겨 가로채지 못한다');
  assert.equal((await call('fwa', 'DELETE', '/security/guest-scans/job-B')).s, 403);
  assert.equal((await call('fwa', 'POST', '/security/guest-scans/job-B/run')).s, 403, '수정 전: 200 — B 게스트에 조사 명령을 실행했다');
  assert.equal((await call('fwa', 'DELETE', '/security/guest-scans/no-such-job')).s, 404, '없는 작업은 404');

  r = await call('fwa', 'PUT', '/security/guest-scans', { id: 'job-fwaA', vcenterId: A, type: 'login-fails', name: 'mine-a' });
  assert.equal(r.s, 200, '쓰기 범위 안(A)은 그대로 된다');

  const full = await jobsOf('full');
  const b = full.jobs.find((j) => j.id === 'job-B');
  assert.ok(b, '범위 밖 작업은 그대로 남는다');
  assert.equal(b.vcenterId, B);
  assert.equal(b.name, 'eu', '가로채기 시도가 저장되지 않았다');
  assert.ok(!full.jobs.some((j) => j.id === 'job-fwaB' || j.id === 'job-fwaE'));
});

test('C3-02a 조회 범위 밖은 404(존재 은닉) · 조회는 되는데 쓰기 밖은 403 — wsa·sadm', async () => {
  let r = await call('wsa', 'PUT', '/security/guest-scans', { id: 'job-wsaB', vcenterId: B, type: 'login-fails', name: 'x' });
  assert.equal(r.s, 403, `wsa 는 B 를 조회할 수 있다 — 존재가 이미 보이므로 403(v2.369 규약): ${r.s}`);
  assert.equal((await call('wsa', 'DELETE', '/security/guest-scans/job-B')).s, 403);
  assert.equal((await call('wsa', 'POST', '/security/guest-scans/job-B/run')).s, 403);

  assert.equal((await call('sadm', 'PUT', '/security/guest-scans', { id: 'job-sB', vcenterId: B, type: 'login-fails', name: 'x' })).s, 404);
  assert.equal((await call('sadm', 'DELETE', '/security/guest-scans/job-B')).s, 404);
  assert.equal((await call('sadm', 'POST', '/security/guest-scans/job-B/run')).s, 404);
  assert.equal((await call('sadm', 'PUT', '/security/guest-scans', { id: 'job-B', vcenterId: A, name: 'h' })).s, 404, '보이지 않는 작업을 가로채지 못한다(404)');
});

test('C3-02a GET: 조회 범위로 보여 주고 쓰기 밖 작업은 writable:false · 조회 밖은 숨기고 개수를 밝힌다', async () => {
  const fwa = await jobsOf('fwa');
  const fB = fwa.jobs.find((j) => j.id === 'job-B');
  const fA = fwa.jobs.find((j) => j.id === 'job-A');
  assert.ok(fB && fA, `조회 무제한 계정은 전부 본다: ${JSON.stringify(fwa).slice(0, 300)}`);
  assert.equal(fB.writable, false);
  assert.equal(fA.writable, true);

  const wsa = await jobsOf('wsa');
  assert.equal(wsa.jobs.find((j) => j.id === 'job-B')?.writable, false, 'wsa 는 B 를 조회할 수 있다 — 보이되 편집 불가 표지');

  const sadm = await jobsOf('sadm');
  assert.ok(!sadm.jobs.some((j) => j.vcenterId === B), '조회 범위 밖은 숨긴다');
  assert.ok(sadm.omittedOutOfScope >= 1);
  assert.ok(sadm.jobs.every((j) => j.writable === true));

  const full = await jobsOf('full');
  assert.ok(full.jobs.length >= 3);
  assert.ok(full.jobs.every((j) => !('writable' in j)), '전체 범위 응답은 예전 모양 그대로');
});
