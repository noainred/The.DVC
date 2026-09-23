/**
 * v2.583 — 폴러 상태의 범위 유출(감사 확정 — v2.574 SEC-05·SEC-07 의 형제 누락) + inv.* 우회 2경로.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { scopePollerStatus, scopeDbStatus } from '../src/auth/scopeStatus.js';

const st = {
  running: false,
  inFlight: [{ deviceId: 'vc-a' }, { deviceId: 'vc-b' }],
  lastResult: { at: 1, trigger: 'timer', ms: 5, users: 812, vcenters: 11, records: 29, targets: 400,
    errors: [{ vcenterId: 'vc-a', error: 'x' }, { vcenterId: 'vc-z', error: 'SOAP 10.0.0.9 refused' }],
    skippedVcenters: [{ vcenterId: 'vc-z', why: 'off' }] },
};

test('범위 계정 — 보이는 vCenter 것만 남기고 전 법인 합계는 싣지 않는다', () => {
  const r = scopePollerStatus(st, new Set(['vc-a']));
  assert.equal(r.scoped, true);
  assert.deepEqual(r.inFlight, [{ deviceId: 'vc-a' }]);
  assert.deepEqual(r.lastResult.errors, [{ vcenterId: 'vc-a', error: 'x' }]);
  assert.deepEqual(r.lastResult.skippedVcenters, []);
  for (const k of ['users', 'vcenters', 'records', 'targets']) assert.ok(!(k in r.lastResult), `${k} 는 전 법인 합계 — 싣지 않는다`);
  assert.equal(r.lastResult.at, 1);
});

test('전체 범위(null)는 원본 그대로', () => {
  assert.equal(scopePollerStatus(st, null), st);
});

test('DB 경로는 관리자에게만', () => {
  assert.deepEqual(scopeDbStatus({ available: true, path: '/etc/x.db' }, { role: 'operator' }), { available: true });
  assert.equal(scopeDbStatus({ available: true, path: '/etc/x.db' }, { role: 'admin' }).path, '/etc/x.db');
});

test('라우트가 헬퍼를 쓴다 — curuser 3곳 · guest-disk 2곳 · /top 권한 게이트 · /search/nl 권한 게이트', () => {
  const cu = fs.readFileSync(new URL('../src/routes/api/curUser.js', import.meta.url), 'utf8');
  assert.equal((cu.match(/scopePollerStatus\(/g) || []).length, 3);
  assert.doesNotMatch(cu, /poller: curUserPollerStatus\(\),/);
  const gd = fs.readFileSync(new URL('../src/routes/api/toolsGuestDisk.js', import.meta.url), 'utf8');
  assert.equal((gd.match(/scopePollerStatus\(guestDiskPollerStatus\(\), allowed\)/g) || []).length, 2);
  const inv = fs.readFileSync(new URL('../src/routes/api/inventory.js', import.meta.url), 'utf8');
  const topSrc = inv.slice(inv.indexOf("api.get('/top'"), inv.indexOf("api.get('/alarms'"));
  for (const k of ['vmsByCpuUsage', 'vmsByRam', 'hostsByCpu', 'hostsByPower', 'datastoresByUsage']) assert.match(topSrc, new RegExp(`${k}: gate\\(`), `${k} 는 권한 게이트를 거친다`);
  assert.match(topSrc, /extraKey: `\$\{scopeKey\(req\.user, store\.get\(\)\)\}\|p\$\{topPermKey\(req\.user\)\}`/, '캐시 키에 권한 조합');
  const nl = fs.readFileSync(new URL('../src/routes/api/searchNotes.js', import.meta.url), 'utf8');
  assert.match(nl, /if \(need && !userHasPermission\(req\.user, need\)\)/);
});

test('/top — inv.vms 가 없는 역할은 VM 목록이 비고 withheld 로 밝힌다 · 캐시가 권한 사이에 새지 않는다(실제 api 라우터)', async () => {
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'top2583-'));
  fs.writeFileSync(path.join(dir, 'permissions.json'), JSON.stringify({ schemaVersion: 2, matrix: { operator: ['dashboard', 'tools', 'inv.vms', 'inv.hosts', 'inv.datastores'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
  const apiPath = new URL('../src/routes/api.js', import.meta.url).pathname;
  const storePath = new URL('../src/store.js', import.meta.url).pathname;
  const script = `
    const express = (await import('express')).default;
    const { store } = await import(${JSON.stringify(storePath)});
    try { await store.refresh(); } catch {}
    const { api } = await import(${JSON.stringify(apiPath)});
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { username: req.get('x-u'), role: req.get('x-u'), scope: null }; next(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const get = async (u) => { const r = await fetch(base + '/api/top?limit=5', { headers: { 'x-u': u } }); return { status: r.status, body: await r.json() }; };
    const op = await get('operator');
    const vw = await get('viewer');
    const op2 = await get('operator');
    const nl = await fetch(base + '/api/search/nl', { method: 'POST', headers: { 'x-u': 'viewer', 'content-type': 'application/json' }, body: JSON.stringify({ query: 'cpu 높은 vm' }) });
    srv.close();
    console.log('@@' + JSON.stringify({ op: { s: op.status, vms: op.body.vmsByRam?.length, w: op.body.withheld }, vw: { s: vw.status, vms: vw.body.vmsByRam?.length, hosts: vw.body.hostsByCpu?.length, w: vw.body.withheld, scope: vw.body.scope }, op2: op2.body.vmsByRam?.length, nl: nl.status }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true' }, encoding: 'utf8', cwd: path.resolve(new URL('..', import.meta.url).pathname), timeout: 120_000,
  });
  assert.equal(r.status, 0, r.stderr.slice(-800));
  const out = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('@@')).slice(2));
  assert.equal(out.op.s, 200);
  assert.ok(out.op.vms > 0, '권한 있는 역할은 VM 목록을 받는다');
  assert.deepEqual(out.op.w, []);
  assert.equal(out.vw.vms, 0, 'inv.vms 없는 역할은 VM 목록이 비어야 한다');
  assert.equal(out.vw.hosts, 0);
  assert.deepEqual(out.vw.w.map((x) => x.requiredPerm), ['inv.vms', 'inv.hosts', 'inv.datastores']);
  assert.ok(out.vw.scope.vms > 0, '개수(대시보드 수준)는 남는다');
  assert.ok(out.op2 > 0, '권한 없는 사용자의 결과가 캐시로 권한 있는 사용자에게 새지 않는다(역방향도)');
  assert.equal(out.nl, 403, '자연어 검색도 결과 종류의 권한이 없으면 403');
});

test('#6 무인증 API 키 거부의 감사 기록 — 출처당 1분 한 줄, 넘친 건수는 다음 줄에 합친다', async () => {
  const { denyAuditGate, _resetDenyAuditGate } = await import('../src/publicapi/auth.js');
  _resetDenyAuditGate();
  assert.deepEqual(denyAuditGate('10.0.0.1', 0), { write: true, folded: 0 });
  for (let i = 1; i <= 500; i++) assert.equal(denyAuditGate('10.0.0.1', i * 100).write, false);
  assert.deepEqual(denyAuditGate('10.0.0.1', 60_001), { write: true, folded: 500 }, '버리지 않고 합친다');
  assert.equal(denyAuditGate('10.0.0.2', 60_002).write, true, '다른 출처는 따로');
});

test('#3·#4·#5 — bm-usage 설정·상태 범위/역할 · 수동 수집 전체 범위 전용 · finops 캐시 키에 vcenterId', async () => {
  const { scopeMainSettings, scopeEdgeSettings } = await import('../src/routes/api/bmUsage.js');
  const s = { enabled: true, corps: { 'vc-a': true, 'vc-b': true }, enterpriseAckBy: 'admin1' };
  const r = scopeMainSettings(s, new Set(['vc-a']), false);
  assert.deepEqual(r.corps, { 'vc-a': true });
  assert.equal(r.corpsScoped, true);
  assert.ok(!('enterpriseAckBy' in r));
  assert.equal(scopeMainSettings(s, null, true), s, '전체 범위 관리자는 그대로');
  assert.equal(scopeEdgeSettings(s, new Set(['vc-a'])).corpsCount, 2, 'corps 맵 개수를 센다(예전엔 늘 null)');
  const src = fs.readFileSync(new URL('../src/routes/api/bmUsage.js', import.meta.url), 'utf8');
  const col = src.slice(src.indexOf("api.post('/tools/bm-usage/collect'"));
  assert.match(col.slice(0, 600), /if \(scopedVcenterIds\(req\.user, store\.get\(\)\)\) \{\s*return res\.status\(403\)/);
  const ins = fs.readFileSync(new URL('../src/routes/insights.js', import.meta.url), 'utf8');
  assert.match(ins, /\|vc:\$\{String\(req\.query\.vcenterId \|\| ''\)\}`;/);
});

test('라우트 수준 — 범위 operator 에게 폴러 합계·DB 경로·동의자 이름이 나가지 않는다(curuser 4 · bm-usage · waste/off-check · guest-disk 2)', async () => {
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope2583-'));
  fs.writeFileSync(path.join(dir, 'bmusage-settings.json'), JSON.stringify({ enabled: false, corps: { 'vc-zzz': true }, enterpriseAck: true, enterpriseAckBy: 'someadmin', enterpriseAckAt: 1 }));
  const apiPath = new URL('../src/routes/api.js', import.meta.url).pathname;
  const storePath = new URL('../src/store.js', import.meta.url).pathname;
  const script = `
    const express = (await import('express')).default;
    const { store } = await import(${JSON.stringify(storePath)});
    try { await store.refresh(); } catch {}
    const { api } = await import(${JSON.stringify(apiPath)});
    const snap = store.get();
    const vc = snap.vcenters[0].id;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = req.get('x-s') ? { username: 'op', role: 'operator', scope: { vcenters: [vc] } } : { username: 'ad', role: 'admin', scope: null }; next(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    await fetch(base + '/api/tools/waste/off-check/run', { method: 'POST' });
    const out = {};
    for (const u of ['/tools/curuser', '/tools/curuser/settings', '/tools/curuser/activity', '/tools/curuser/history?vcenterId=' + encodeURIComponent(vc), '/tools/bm-usage', '/tools/waste/off-check', '/tools/guest-disk', '/tools/guest-disk/status']) {
      const r = await fetch(base + '/api' + u, { headers: { 'x-s': '1' } });
      out[u.split('?')[0]] = { s: r.status, b: await r.json().catch(() => null) };
    }
    const col = await fetch(base + '/api/tools/bm-usage/collect', { method: 'POST', headers: { 'x-s': '1', 'content-type': 'application/json' }, body: '{}' });
    out.collect = { s: col.status, b: await col.json().catch(() => null) };
    const adm = await (await fetch(base + '/api/tools/waste/off-check')).json();
    srv.close();
    console.log('@@' + JSON.stringify({ out, admLast: adm.lastResult ? Object.keys(adm.lastResult) : null, vc }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true' }, encoding: 'utf8', cwd: path.resolve(new URL('..', import.meta.url).pathname), timeout: 120_000,
  });
  assert.equal(r.status, 0, r.stderr.slice(-800));
  const o = JSON.parse(r.stdout.split('@@')[1]);
  const TOTALS = ['users', 'vcenters', 'targets', 'records', 'offVms', 'newStreaks', 'cleared', 'vms'];
  for (const [u, { s, b }] of Object.entries(o.out)) {
    if (s !== 200 || !b) continue;
    if (b.db) assert.ok(!('path' in b.db), `${u}: operator 에게 DB 경로`);
    const lr = b.poller?.lastResult || b.lastResult;
    if (lr) {
      assert.equal(lr.scoped, true, `${u}: scoped 표시`);
      for (const k of TOTALS) assert.ok(!(k in lr), `${u}: 전 법인 합계 ${k}`);
    }
  }
  assert.equal(o.out.collect.s, 403, '범위 계정은 전 법인 수동 수집(로그인 시도)을 일으킬 수 없다');
  assert.ok(!('counts' in (o.out.collect.b || {})), '전 법인 집계를 싣지 않는다');
  const bm = o.out['/tools/bm-usage'].b;
  assert.ok(bm && bm.settings, 'bm-usage 응답');
  assert.equal(bm.settings.corpsScoped, true);
  assert.deepEqual(Object.keys(bm.settings.corps), [], '범위 밖 법인 opt-in 은 보이지 않는다');
  assert.ok(!('enterpriseAckBy' in bm.settings), '동의자 계정명은 admin 에게만');
  if (bm.status) assert.ok(!('enterpriseAckBy' in bm.status));
  assert.ok(o.admLast && o.admLast.includes('offVms'), `off-check 가 실제로 돌아 전 법인 합계가 있어야 이 검사가 의미가 있다: ${o.admLast}`);
  assert.equal(o.out['/tools/waste/off-check'].b.lastResult?.scoped, true, 'off-check 범위 축약');
  fs.rmSync(dir, { recursive: true, force: true });
});
