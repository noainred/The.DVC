// v2.622 감사 그룹 E — 범위 제한 admin 차단(SEC-01·03·04).
// 실제 adminRouter 를 express 에 띄워 **상태코드·응답·저장 파일**로 본다(AUTH_ENABLED=true — 사용자 주입은 x-u 헤더).
//   SEC-01: 알림 채널·일일 리포트 쓰기·발송은 전체 범위만(범위 admin 403, 파일 불변).
//   SEC-03: GPU 게스트 엣지 배포·엣지 사용자·진단 조회는 전체 범위만 · 물리 GPU 목록은 범위 안 서버만.
//   SEC-04: NSX 매니저 목록은 범위 안 vCenter 에 연결된 것만(omittedOutOfScope 로 밝힘).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2622e-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
delete process.env.CENTRAL_URL;

// 범위 밖(vc-eu-west)·범위 안(vc-us-east) 데이터를 하나씩. 주소는 TEST-NET(192.0.2.0/24)·예시 도메인.
fs.writeFileSync(path.join(tmp, 'nsx.json'), JSON.stringify({ managers: [
  { id: 'n-eu', name: 'eu-nsx', host: 'https://nsx-eu.corp.example', username: 'eu-admin', password: 'x', vcenterId: 'vc-eu-west', location: { region: 'Unknown' } },
  { id: 'n-us', name: 'us-nsx', host: 'https://nsx-us.corp.example', username: 'us-admin', password: 'y', vcenterId: 'vc-us-east', location: { region: 'Unknown' } },
  { id: 'n-none', name: 'none-nsx', host: 'https://nsx-none.corp.example', username: 'none-admin', password: 'z', vcenterId: '', location: { region: 'Unknown' } },
] }));
fs.writeFileSync(path.join(tmp, 'gpu-physical.json'), JSON.stringify({ servers: [
  { id: 'g-eu', name: 'gpu-eu', host: '192.0.2.31', username: 'gpu-eu-user', password: 'a', vcenterId: 'vc-eu-west' },
  { id: 'g-us', name: 'gpu-us', host: '192.0.2.32', username: 'gpu-us-user', password: 'b', vcenterId: 'vc-us-east' },
] }));

const USERS = {
  full: { username: 'full', role: 'admin', scope: null },
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-us-east'] } },
};
let srv, base;

before(async () => {
  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api/admin', adminRouter);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api/admin`;
});
after(() => {
  try { srv?.close(); } catch { /* */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
});

async function call(u, method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, t, j };
}

test('SEC-01: 범위 admin 은 알림 채널·일일 리포트를 바꾸거나 발송하지 못한다(파일 불변) · 전체 admin 은 그대로', async () => {
  const alertsFile = path.join(tmp, 'alerts.json');
  const hook = { channels: { webhook: { enabled: true, url: 'https://attacker.example/hook' } } };
  const p = await call('sadm', 'PUT', '/alerts', hook);
  assert.equal(p.s, 403, `PUT /alerts ${p.s} ${p.t.slice(0, 200)}`);
  assert.equal(p.j?.error, 'forbidden');
  assert.equal(fs.existsSync(alertsFile) && fs.readFileSync(alertsFile, 'utf8').includes('attacker.example'), false, '웹훅이 저장되지 않는다');
  for (const [m, route] of [['POST', '/alerts/test'], ['PUT', '/report/daily'], ['POST', '/report/daily/run']]) {
    const r = await call('sadm', m, route, { enabled: true, hour: 3, minute: 0 });
    assert.equal(r.s, 403, `${m} ${route} ${r.s} ${r.t.slice(0, 200)}`);
  }
  // 조회는 그대로(v2.604 정책) — 범위 admin 도 200.
  assert.equal((await call('sadm', 'GET', '/alerts')).s, 200);
  // 전체 admin 은 저장 가능.
  const f = await call('full', 'PUT', '/alerts', { channels: { webhook: { enabled: false } }, cooldownMin: 7 });
  assert.equal(f.s, 200, f.t.slice(0, 200));
  assert.equal(f.j?.config?.cooldownMin, 7);
  const d = await call('full', 'PUT', '/report/daily', { enabled: false, hour: 4, minute: 5 });
  assert.equal(d.s, 200, d.t.slice(0, 200));
});

test('SEC-03: 엣지 배포 설정·엣지 사용자·진단 조회는 범위 admin 403 · 전체 admin 200', async () => {
  const put = await call('full', 'PUT', '/gpu-guest/deploy/edge-eu', { vcenters: { 'vc-eu-west': { username: 'gpuop', password: 'pw', vmIps: { 'vm-1': '192.0.2.99' } } } });
  assert.equal(put.s, 200, put.t.slice(0, 200));
  for (const route of ['/gpu-guest/deploy/edge-eu', '/gpu-guest/deploy/agents', '/gpu-guest/diag', '/edge-users/agents', '/edge-users/edge-eu']) {
    const s = await call('sadm', 'GET', route);
    assert.equal(s.s, 403, `sadm GET ${route} ${s.s} ${s.t.slice(0, 200)}`);
    assert.doesNotMatch(s.t, /gpuop|192\.0\.2\.99/, `${route} 응답에 배포 계정·IP 가 새지 않는다`);
    const f = await call('full', 'GET', route);
    assert.equal(f.s, 200, `full GET ${route} ${f.s} ${f.t.slice(0, 200)}`);
  }
  const f = await call('full', 'GET', '/gpu-guest/deploy/edge-eu');
  assert.match(f.t, /gpuop/, '전체 admin 은 배포 설정을 그대로 본다');
});

test('SEC-03: 물리 GPU 목록은 범위 admin 에게 범위 안 서버만 · 뺀 개수·함대 집계 은닉을 밝힌다', async () => {
  const s = await call('sadm', 'GET', '/gpu-physical');
  assert.equal(s.s, 200, s.t.slice(0, 200));
  assert.deepEqual(s.j.servers.map((x) => x.id), ['g-us']);
  assert.doesNotMatch(s.t, /192\.0\.2\.31|gpu-eu-user/, '범위 밖 물리 서버의 주소·계정이 새지 않는다');
  assert.equal(s.j.scoped, true);
  assert.equal(s.j.omittedOutOfScope, 1);
  assert.equal(s.j.status.fleetCountsHidden, true);
  assert.equal(s.j.status.servers, 1, '서버 수는 범위 안 개수');
  assert.equal(s.j.status.lastRun, undefined, '전 함대 실행 집계는 싣지 않는다');
  const f = await call('full', 'GET', '/gpu-physical');
  assert.equal(f.s, 200);
  assert.deepEqual(f.j.servers.map((x) => x.id).sort(), ['g-eu', 'g-us']);
  assert.equal(f.j.scoped, undefined);
});

test('SEC-03: scopePhysicalView 순수 판정 — 소속 없는 서버는 뺀다 · 결과도 같은 id 로 거른다', async () => {
  const { scopePhysicalView } = await import('../src/routes/admin/gpuGuest.js');
  const v = scopePhysicalView(
    [{ id: 'a', vcenterId: 'vc-1' }, { id: 'b', vcenterId: '' }, { id: 'c', vcenterId: 'vc-2' }, null],
    [{ id: 'a', count: 1 }, { id: 'c', count: 2 }], { intervalMs: 60000, servers: 3, lastRun: { ok: 3 } }, new Set(['vc-1']));
  assert.deepEqual(v.servers.map((x) => x.id), ['a']);
  assert.deepEqual(v.results.map((x) => x.id), ['a']);
  assert.equal(v.omittedOutOfScope, 3);
  assert.deepEqual(v.status, { intervalMs: 60000, servers: 1, fleetCountsHidden: true });
  const all = scopePhysicalView([{ id: 'a' }], [], { x: 1 }, null);
  assert.deepEqual(all, { servers: [{ id: 'a' }], results: [], status: { x: 1 } });
});

test('SEC-04: NSX 매니저 목록은 범위 admin 에게 범위 안 vCenter 에 연결된 것만 · 전체 admin 은 전부', async () => {
  const s = await call('sadm', 'GET', '/nsx/managers');
  assert.equal(s.s, 200, s.t.slice(0, 200));
  assert.deepEqual(s.j.managers.map((m) => m.id), ['n-us']);
  assert.doesNotMatch(s.t, /nsx-eu|eu-admin|nsx-none|none-admin/, '범위 밖·귀속 불명 매니저의 host·계정이 새지 않는다');
  assert.equal(s.j.scoped, true);
  assert.equal(s.j.omittedOutOfScope, 2);
  assert.doesNotMatch(s.t, /"password"/);
  const f = await call('full', 'GET', '/nsx/managers');
  assert.equal(f.s, 200);
  assert.deepEqual(f.j.managers.map((m) => m.id).sort(), ['n-eu', 'n-none', 'n-us']);
  assert.equal(f.j.scoped, undefined);
});

test('SEC-04: scopeNsxManagers — 배열 vcenterIds 는 범위 안 id 로 자르고 가린 개수를 밝힌다', async () => {
  const { scopeNsxManagers } = await import('../src/routes/admin/nsxImport.js');
  const r = scopeNsxManagers([
    { id: 'm1', vcenterIds: ['vc-1', 'vc-2'] },
    { id: 'm2', vcenterIds: ['vc-2'] },
    { id: 'm3', vcenterId: 'vc-1' },
  ], new Set(['vc-1']));
  assert.deepEqual(r.managers, [{ id: 'm1', vcenterIds: ['vc-1'], vcenterIdsHidden: 1 }, { id: 'm3', vcenterId: 'vc-1' }]);
  assert.equal(r.omittedOutOfScope, 1);
  assert.deepEqual(scopeNsxManagers([{ id: 'x' }], null), { managers: [{ id: 'x' }] });
});
