/**
 * audit2680c — v2.680 감사 그룹 C 회귀.
 *  ① C-01 로그인 실패 분석 인자 클램프(헬퍼 + 라우트) — ?days=Infinity 가 끝나지 않는 조각 루프였다.
 *  ② A-05 CVP PSU 일부만 읽은 장비는 '측정' 이 아니라 partial · 빈 슬롯(absent)은 PSU 로 세지 않는다.
 *  ③ A-06 서버 전력 분모(devices·unread) · F-06 스토리지 전력 신선도는 엣지 시계와 중앙 수신 시각 중 이른 쪽.
 *  ④ C-02 /tools/power-total 비-admin 주소형 서버 id·이름 가림(addressHidden) + 캐시가 역할로 나뉜다.
 *  ⑤ C-03 super_admin 판정은 토큰의 superAdmin 표지 — 같은 이름의 AD 세션(표지 없음)은 super_admin 이 아니다.
 *  ⑥ C-06 /tools/gpu 비-admin 응답에서 수집 오류 원문(guestWhy.detail)을 뺀다.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2680c-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_SECRET = 'x'.repeat(40);
fs.writeFileSync(path.join(tmp, 'users.json'), JSON.stringify({ users: [
  { username: 'sa', name: 'sa', role: 'super_admin' },
  { username: 'sa2', name: 'sa2', role: 'super_admin' },
  { username: 'adm', name: 'adm', role: 'admin' },
] }));

const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * 60_000;
const USERS = {
  full: { username: 'adm', role: 'admin', scope: null },
  op: { username: 'op', role: 'operator', scope: null },
  // AD 세션: 로컬 super_admin 과 같은 이름이지만 토큰에 superAdmin 표지가 없다(resolveTokenUser 의 AD 분기).
  adSa: { username: 'sa', role: 'admin', scope: null },
  localSa: { username: 'sa', role: 'admin', superAdmin: true, scope: null },
};
let srv; let base;
before(async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api/admin', adminRouter);
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
});
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

async function call(u, method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, j };
}

test('① C-01 analyzeLoginFails — 범위 밖 인자를 자른다(Infinity 가 끝난다)', async () => {
  const { analyzeLoginFails, clampLoginFailParams, LOGIN_FAIL_RANGES } = await import('../src/security/loginFails.js');
  // Infinity 는 '못 읽은 값'(numOrNull → null) 이라 기본값, 유한한 큰 값은 상한.
  assert.deepEqual(clampLoginFailParams({ days: Infinity, threshold: 1e9, windowMin: -5 }), { days: 7, threshold: 1000, windowMin: 10 });
  assert.equal(clampLoginFailParams({ days: 36500 }).days, 90);
  assert.deepEqual(clampLoginFailParams({ days: '', threshold: 'abc' }, { days: 14, threshold: 7, windowMin: 30 }), { days: 14, threshold: 7, windowMin: 30 });
  assert.equal(clampLoginFailParams({ days: 0.2 }).days, 1);
  assert.deepEqual(LOGIN_FAIL_RANGES.days, [1, 90]);
  let reads = 0;
  const t0 = Date.now();
  const r = await analyzeLoginFails({ days: Infinity, threshold: Infinity, windowMin: 1e12 }, { now: NOW, db: { loginFailCandidates: () => { reads += 1; return []; } } });
  assert.ok(Date.now() - t0 < 10_000, '끝나야 한다');
  assert.equal(r.config.days, 7);
  assert.equal(r.config.windowMin, 1440);
  assert.ok(reads <= 7 * 24 + 1, `조각 수 — ${reads}`);
  reads = 0;
  const big = await analyzeLoginFails({ days: 36500, threshold: 1e9 }, { now: NOW, db: { loginFailCandidates: () => { reads += 1; return []; } } });
  assert.equal(big.config.days, 90); assert.equal(big.config.threshold, 1000);
  assert.ok(reads <= 90 * 24 + 1, `조각 수 상한(90일) — ${reads}`);
  assert.equal(big.scan.days, 90);
});

test('① C-01 라우트 — 쿼리값을 설정 범위로 자른다(소스 + 실제 응답)', async () => {
  const src = stripComments(fs.readFileSync(new URL('../src/routes/admin/backupNetSec.js', import.meta.url), 'utf8'));
  assert.match(src, /clampLoginFailParams\(req\.query, mon\)/, '라우트도 자른다(같은 키로 합류)');
  assert.doesNotMatch(src, /Number\(req\.query\.days\) \|\| mon\.days/);
  const r = await call('full', 'GET', '/admin/security/login-fails?days=36500&threshold=1e9&windowMin=abc');
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.config.days, 90);
  assert.equal(r.j.config.threshold, 1000);
});

test('② A-05 CVP PSU 일부만 읽음 → partial, 빈 슬롯은 PSU 아님', async () => {
  const { cvpDevicePower, buildPowerTotal } = await import('../src/power/total.js');
  const half = cvpDevicePower({ partsList: [{ kind: 'psu', power: { inW: 400 } }, { kind: 'psu', power: {} }] });
  assert.equal(half.partial, true); assert.equal(half.read, 1); assert.equal(half.psus, 2);
  const absent = cvpDevicePower({ partsList: [{ kind: 'psu', power: { inW: 400 } }, { kind: 'psu', state: 'absent' }] });
  assert.equal(absent.psus, 1); assert.equal(absent.partial, undefined, '빈 슬롯은 못 읽은 PSU 가 아니다');
  const r = buildPowerTotal({ now: NOW, network: [
    { cvpId: 'c', key: 'a', hostname: 'sw-half', partsAt: NOW, partsList: [{ kind: 'psu', power: { inW: 400 } }, { kind: 'psu', power: {} }] },
    { cvpId: 'c', key: 'b', hostname: 'sw-full', partsAt: NOW, partsList: [{ kind: 'psu', power: { inW: 300 } }] },
  ] });
  assert.equal(r.network.measured, 1, '일부만 읽은 장비는 측정으로 세지 않는다');
  assert.equal(r.network.partial, 1);
  assert.equal(r.network.partialWatts, 400);
  assert.equal(r.network.watts, 700, '읽은 PSU 는 더한다(하한)');
  assert.equal(r.network.items.find((x) => x.name === 'sw-half').partial, true);
});

test('③ A-06 서버 분모 · F-06 스토리지 신선도', async () => {
  const { buildPowerTotal, STORAGE_STALE_MS } = await import('../src/power/total.js');
  const servers = [
    { serverId: 's1', watts: 500, source: 'idrac' },
    { serverId: 'ome:1', watts: 300, source: 'ome' },
    { serverId: 'v', watts: 999, source: 'vcenter' },
  ];
  const r = buildPowerTotal({ now: NOW, servers, serversRegistered: 5 });
  assert.equal(r.servers.devices, 5);
  assert.equal(r.servers.unread, 4, '등록 5 − iDRAC·엣지 실측 1(OME 는 등록부 밖)');
  assert.equal(r.servers.ome, 1);
  const legacy = buildPowerTotal({ now: NOW, servers });
  assert.equal(legacy.servers.devices, null, '분모를 모르면 null(0 이 아니다)');
  assert.equal(legacy.servers.unread, null);
  // F-06: 엣지 시계가 빨라 power.at 이 미래여도, 중앙 수신 시각(collectedAt)이 오래됐으면 오래된 값이다.
  const dev = (pAt, cAt) => ({ id: 'u', name: 'u', type: 'unity480', collectMethod: 'ssh', snap: { ok: true, collectedAt: cAt, extra: { power: { watts: 500, at: pAt } } } });
  const stale = buildPowerTotal({ now: NOW, storage: [dev(NOW + 3_600_000, NOW - STORAGE_STALE_MS - 60_000)] });
  assert.equal(stale.storage.stale, 1); assert.equal(stale.storage.measured, 0);
  const future = buildPowerTotal({ now: NOW, storage: [dev(NOW + 3_600_000, undefined)] });
  assert.equal(future.storage.measured, 1);
  assert.equal(future.storage.items[0].ts, NOW, '미래 시각은 지금으로 본다');
  const both = buildPowerTotal({ now: NOW, storage: [dev(NOW - 60_000, NOW - 120_000)] });
  assert.equal(both.storage.items[0].ts, NOW - 120_000, '이른 쪽');
});

test('④ C-02 maskPowerServers — 주소형 id·이름을 가린다', async () => {
  const { maskPowerServers } = await import('../src/routes/api/overviewCards.js');
  const out = maskPowerServers({ servers: { items: [
    { id: '10.1.2.3', name: '10.1.2.3', watts: 1 },
    { id: 'remote:edge1:10.9.9.9', name: 'idrac-a.corp', watts: 2 },
    { id: 'svc-tag-1', name: 'R750-01', watts: 3 },
  ] } }, ['idrac-a.corp']);
  const [a, b, c] = out.servers.items;
  assert.match(a.id, /^masked-/); assert.match(a.name, /이름 가림/);
  assert.match(b.id, /^masked-/); assert.match(b.name, /이름 가림/);
  assert.equal(c.id, 'svc-tag-1'); assert.equal(c.name, 'R750-01');
  assert.ok(!JSON.stringify(out).includes('10.1.2.3'));
});

test('④ C-02 /tools/power-total — operator 는 addressHidden, admin 은 아니다(캐시가 역할로 나뉜다)', async () => {
  const a = await call('full', 'GET', '/tools/power-total');
  assert.equal(a.s, 200);
  assert.ok(!a.j.addressHidden);
  assert.ok(!('serverHosts' in a.j), '내부 주소 목록을 싣지 않는다');
  const o = await call('op', 'GET', '/tools/power-total');
  assert.equal(o.s, 200);
  assert.equal(o.j.addressHidden, true);
  assert.ok('devices' in o.j.servers, '서버 분모 필드');
  const src = stripComments(fs.readFileSync(new URL('../src/routes/api/overviewCards.js', import.meta.url), 'utf8'));
  assert.match(src, /if \(!admin\) \{\s*out = maskPowerServers\(out, serverHosts\)/, '비-admin 경로가 가림을 부른다');
});

test('⑤ C-03 같은 이름의 AD 세션은 super_admin 이 아니다', async () => {
  const { actorIsSuperAdmin } = await import('../src/auth/auth.js');
  assert.equal(actorIsSuperAdmin({ username: 'sa', role: 'admin' }), false);
  assert.equal(actorIsSuperAdmin({ username: 'sa', role: 'admin', superAdmin: true }), true);
  assert.equal(actorIsSuperAdmin({ username: 'adm', role: 'admin', superAdmin: true }), false, '저장 역할도 본다');
  let p = await call('adSa', 'GET', '/admin/permissions');
  assert.equal(p.s, 200); assert.equal(p.j.canEditAdminRow, false);
  p = await call('localSa', 'GET', '/admin/permissions');
  assert.equal(p.j.canEditAdminRow, true);
  const denied = await call('adSa', 'DELETE', '/admin/users/sa2');
  assert.equal(denied.s, 400); assert.equal(denied.j.code, 'super-admin-only');
  const pw = await call('adSa', 'POST', '/admin/users/sa2/password', { password: 'Abcdefgh1234!' });
  assert.notEqual(pw.s, 200, JSON.stringify(pw.j));
  const ok = await call('localSa', 'DELETE', '/admin/users/sa2');
  assert.equal(ok.s, 200, JSON.stringify(ok.j));
});

test('⑥ C-06 /tools/gpu 비-admin 은 수집 오류 원문을 받지 않는다', async () => {
  const { stripWhyDetail, maskGpuInventoryForUser } = await import('../src/gpu/guestWhy.js');
  const raw = { code: 'collect-failed', detail: 'connect ECONNREFUSED 10.0.0.5:22', agent: 'e1' };
  assert.deepEqual(stripWhyDetail(raw), { code: 'collect-failed', agent: 'e1', detail: null, detailHidden: true });
  assert.deepEqual(stripWhyDetail({ code: 'partial', detail: '1/3' }), { code: 'partial', detail: '1/3' }, '원문 오류가 아닌 detail 은 둔다');
  const inv = { items: [{ host: 'h', guestWhy: raw }], guestWhy: [{ ...raw, hosts: 1 }] };
  const m = maskGpuInventoryForUser(inv, false);
  assert.ok(!JSON.stringify(m).includes('10.0.0.5'));
  assert.equal(maskGpuInventoryForUser(inv, true), inv, 'admin 은 그대로');
  const src = stripComments(fs.readFileSync(new URL('../src/routes/api/hardwareGpu.js', import.meta.url), 'utf8'));
  assert.equal((src.match(/maskGpuInventoryForUser\(buildGpuInventory\(/g) || []).length, 2, '/tools/gpu 와 /tools/gpu.json 둘 다');
  const o = await call('op', 'GET', '/tools/gpu');
  assert.equal(o.s, 200);
  for (const it of o.j.items || []) if (it.guestWhy?.code === 'collect-failed') assert.equal(it.guestWhy.detail ?? null, null);
  for (const e of o.j.guestWhy || []) if (e.code === 'collect-failed') assert.equal(e.detail ?? null, null);
});
