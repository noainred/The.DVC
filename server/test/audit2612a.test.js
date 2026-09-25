// v2.612 감사 그룹 A — 범위 제한 admin 의 전 법인(엣지·사이트·장비) 자원 접근 차단 회귀 고정.
//   AUTHZ2612-01 스토리지·PDU·SAN 장비 내보내기·등록·삭제·수집 · AUTHZ2612-02 전 법인 공용 스칼라 설정 ·
//   AUTHZ2612-03 중계 토폴로지·HAProxy 경로 점검 · AUTHZ2612-04 RMA · AUTHZ2612-05 서버 성능 측정(hang 로그) ·
//   AUTHZ2612-06 베어메탈 스토리지·통합 계정 · AUTHZ2612-07 엣지 네트워크·수신 통계·토큰 목록 · AUTHZ2612-08 긴급중단 승인자.
// 실제 api·adminRouter 를 express 에 띄워 **상태코드**로 본다(AUTH_ENABLED=true — 꺼져 있으면 requireRole 이 모두 admin 으로 통과한다).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2612a-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

let srv, base, auth;
const USERS = {
  full: { username: 'full', role: 'admin', scope: null },
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-us-east'] } },
};
before(async () => {
  const express = (await import('express')).default;
  auth = await import('../src/auth/auth.js');
  const { api } = await import('../src/routes/api.js');
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api/admin', adminRouter);
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
});
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

async function call(u, method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* CSV 등 */ }
  return { s: r.status, t, j };
}

// 범위 제한 admin 은 403, 전체 범위 admin 은 403 이 아니어야 한다(조회만 — 상태를 바꾸지 않는 경로).
async function expectGate(method, p, { fullToo = true, body } = {}) {
  const sc = await call('sadm', method, p, body);
  assert.equal(sc.s, 403, `${method} ${p} 범위 제한 admin 은 403 이어야 한다 (받은 ${sc.s} ${sc.t.slice(0, 120)})`);
  assert.equal(sc.j?.error, 'forbidden');
  if (fullToo) {
    const f = await call('full', method, p, body);
    assert.notEqual(f.s, 403, `${method} ${p} 전체 범위 admin 은 403 이 아니어야 한다 (받은 ${f.s} ${f.t.slice(0, 120)})`);
  }
}

test('AUTHZ2612-01: 스토리지·PDU·SAN 장비 내보내기·삭제·수집은 범위 제한 admin 에 403', async () => {
  await expectGate('GET', '/tools/storage/devices/export.csv');
  await expectGate('GET', '/tools/storage/devices/export.txt');
  await expectGate('DELETE', '/tools/storage/devices/st-none', { fullToo: false });
  await expectGate('POST', '/tools/storage/collect-all', { fullToo: false });
  await expectGate('GET', '/tools/pdu/csv/export');
  await expectGate('DELETE', '/tools/pdu/devices/pdu-none', { fullToo: false });
  await expectGate('DELETE', '/tools/sanswitch/devices/sw-none', { fullToo: false });
  await expectGate('POST', '/tools/sanswitch/collect-all', { fullToo: false });
});

test('AUTHZ2612-02: 전 법인 공용 주기·보존·임계 설정은 범위 제한 admin 에 403', async () => {
  await expectGate('PUT', '/tools/storage/intervals', { fullToo: false, body: { global: { pollMs: 86_400_000 } } });
  await expectGate('PUT', '/tools/sanswitch/perf/settings', { fullToo: false, body: { retentionDays: 7 } });
  await expectGate('POST', '/tools/pdu/intervals', { fullToo: false, body: { pollMs: 86_400_000 } });
  await expectGate('POST', '/tools/pdu/thresholds', { fullToo: false, body: {} });
  await expectGate('PUT', '/tools/bm-storage/settings', { fullToo: false, body: {} });
  await expectGate('PUT', '/admin/perf/settings', { fullToo: false, body: {} });
  await expectGate('GET', '/tools/storage/intervals');
  await expectGate('GET', '/tools/sanswitch/perf/settings');
});

test('AUTHZ2612-03: 중계 토폴로지·HAProxy 경로 점검은 범위 제한 admin 에도 403(조회 포함)', async () => {
  await expectGate('GET', '/tools/relaytopo');
  await expectGate('GET', '/tools/relaytopo/export');
  await expectGate('PUT', '/tools/relaytopo', { fullToo: false, body: { main: { name: 'M' }, sites: [] } });
  await expectGate('POST', '/tools/relaytopo/apply/EU', { fullToo: false });
  await expectGate('GET', '/tools/relaycheck');
  await expectGate('PUT', '/tools/relaycheck/settings', { fullToo: false, body: {} });
  await expectGate('POST', '/tools/relaycheck/run', { fullToo: false });
});

test('AUTHZ2612-04: RMA 는 범위 제한 admin 에 403(조회·접근 설정·실행)', async () => {
  await expectGate('GET', '/tools/rma');
  await expectGate('GET', '/tools/rma/history');
  await expectGate('PUT', '/tools/rma/agents/edge-eu/access', { fullToo: false, body: { allowedIps: ['0.0.0.0/0'] } });
  await expectGate('POST', '/tools/rma/run', { fullToo: false, body: { agent: 'edge-eu', preset: 'uptime', params: {} } });
});

test('AUTHZ2612-05: 서버 성능 측정·hang 로그는 범위 제한 admin 에 403', async () => {
  await expectGate('GET', '/admin/perf');
  await expectGate('GET', '/admin/perf/hangs');
  await expectGate('DELETE', '/admin/perf/hangs', { fullToo: false });
});

test('AUTHZ2612-06: 베어메탈 스토리지·통합 계정은 범위 제한 admin 에 403', async () => {
  await expectGate('GET', '/tools/bm-storage');
  await expectGate('GET', '/tools/bm-storage/export.csv');
  await expectGate('DELETE', '/tools/bm-storage/servers/none', { fullToo: false });
  await expectGate('GET', '/tools/credentials');
  await expectGate('DELETE', '/tools/credentials/none', { fullToo: false });
});

test('AUTHZ2612-07: 엣지 네트워크·수신 통계·토큰 목록·로그인 실패 상태는 범위 제한 admin 에 403', async () => {
  await expectGate('GET', '/admin/security/login-fails/status');
  await expectGate('GET', '/admin/net/agents');
  await expectGate('GET', '/admin/net/monitors');
  await expectGate('DELETE', '/admin/net/monitors/none', { fullToo: false });
  await expectGate('GET', '/admin/central/ingest-stats');
  await expectGate('GET', '/admin/central/agent-tokens');
});

test('AUTHZ2612-08: 긴급중단 — 범위 제한 admin 은 요청도 승인도 못 한다(상태 조회는 그대로)', async () => {
  auth.createUser({ username: 'boss1', role: 'admin', name: 'B1' }, { trusted: true });
  auth.createUser({ username: 'boss2', role: 'admin', name: 'B2' }, { trusted: true });
  auth.createUser({ username: 'sappr', role: 'admin', name: 'S', scope: { vcenters: ['vc-us-east'] } }, { trusted: true });
  const approvals = (a, b) => ({ action: 'stop', approvals: [{ username: a, code: '000000' }, { username: b, code: '000000' }] });
  // 요청자가 범위 제한 → fleetOnly
  const r1 = await call('sadm', 'POST', '/admin/emergency-stop', approvals('boss1', 'boss2'));
  assert.equal(r1.s, 403);
  assert.equal(r1.j?.error, 'forbidden');
  // 요청자는 전체 범위지만 승인자가 범위 제한 → OTP 검증 전에 범위 사유로 403
  const r2 = await call('full', 'POST', '/admin/emergency-stop', approvals('sappr', 'boss1'));
  assert.equal(r2.s, 403);
  assert.match(r2.j?.reason || '', /범위가 제한된 계정/);
  // 대조: 전체 범위 승인자 둘이면 범위 사유가 아니라 OTP 단계에서 걸린다
  const r3 = await call('full', 'POST', '/admin/emergency-stop', approvals('boss1', 'boss2'));
  assert.doesNotMatch(r3.j?.reason || '', /범위가 제한된 계정/);
  // 상태 조회는 범위 제한 admin 도 본다(전 수집이 멈췄는지 알아야 한다)
  const g = await call('sadm', 'GET', '/admin/emergency-stop');
  assert.notEqual(g.s, 403);
});

test('AUTHZ2612-01·03·04·05·06: 소스 스윕 — adminOnly 라우트는 전부 전체 범위 게이트를 함께 건다', () => {
  const files = ['routes/api/storageMon.js', 'routes/api/pdu.js', 'routes/api/sanSwitch.js', 'routes/api/rma.js',
    'routes/api/bmstor.js', 'routes/api/credentials.js', 'routes/api/relaytopo.js', 'routes/api/relaycheck.js',
    'routes/admin/perfMonitor.js'];
  const bad = [];
  let seen = 0;
  for (const f of files) {
    const lines = stripComments(read(f)).split('\n');
    lines.forEach((ln, i) => {
      if (!/\b(api|adminRouter)\.(get|post|put|delete|patch)\(\s*['"]/.test(ln)) return;
      if (!/\badminOnly\b|requireRole\(\s*['"]admin/.test(ln)) return;
      seen++;
      if (!/\b(fullScopeOnly|fleetOnly)\b/.test(ln)) bad.push(`${f}:${i + 1}`);
    });
  }
  assert.ok(seen > 80, `스윕 대상 라우트가 너무 적다(${seen}) — 정규식이 형태를 놓쳤다`);
  assert.deepEqual(bad, [], `전체 범위 게이트가 빠진 adminOnly 라우트: ${bad.join(', ')}`);
  // 조회 라우트의 범위 판정은 역할과 무관해야 한다(예전 `!admin &&`·`role !== 'admin' &&`)
  assert.doesNotMatch(stripComments(read('routes/api/relaytopo.js')), /!admin\s*&&\s*scopedVcenterIds/);
  assert.doesNotMatch(stripComments(read('routes/api/relaycheck.js')), /role\s*!==\s*'admin'\s*&&\s*scopedVcenterIds/);
});
