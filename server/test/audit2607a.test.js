/**
 * v2.607 감사 그룹 a — 범위(scope) 제한 admin 인가.
 *   AUTHZ2607-01 사용자 관리 — 범위 admin 이 자기·타인 scope 를 해제/확대하거나 범위 없는 계정을 만들고·비밀번호·OTP 를
 *                대리 설정하던 경로(v2.605·2.606 범위 가드 전부 무력화)
 *   AUTHZ2607-02 /admin/deep-search/probe 범위 교집합(형제 /tools/deep-search 와 같은 판단)
 *   AUTHZ2607-03 vCenter 등록부 목록·수정·삭제·등록·데이터소스 범위
 *   AUTHZ2607-04 IPAM vCenter 스캔 대역 PUT/DELETE/import 범위
 *   AUTHZ2607-05 전 법인 공용 스칼라 설정(vmseries·curuser·bm-usage·guest-disk·waste·off-check) — ignoredGlobal
 *                (v2.605 '남긴 것' 재확인)
 *   AUTHZ2607-06 게스트 조사 스케줄·분석·vCenter 로그 수동 수집 범위
 *   AUTHZ2607-07 감사 로그·위임 인벤토리·소유 엣지 — 범위 계정 403
 *   RECENT2607-03 /remote/proxies 저장이 범위 밖 vCenter 배정을 지우던 것(v2.606 필터 + 전체 교체)
 *
 * 하니스는 v2.536·v2.605·v2.606 과 같다 — **실제 라우터를 express 에 마운트하고 상태코드·파일 상태로** 본다. 요청자
 * 레코드는 매 요청 users.json 최신값에서 읽는다(resolveTokenUser 와 같은 성질 — 자기 scope 해제가 다음 요청에 먹는지를
 * 봐야 한다). 자식 프로세스인 이유: config.js 싱글턴이라 이 프로세스에서 CONFIG_DIR 을 다시 못 가리킨다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

function runChild(body, { env = {}, setup = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2607a-'));
  if (setup) setup(dir);
  const script = `
    const SRC = ${JSON.stringify(SRC + '/')};
    const fs = await import('node:fs'); const path = await import('node:path');
    const express = (await import('express')).default;
    const { store } = await import(SRC + 'store.js');
    await store.refresh?.();
    const auth = await import(SRC + 'auth/auth.js');
    const { api } = await import(SRC + 'routes/api.js');
    const { adminRouter } = await import(SRC + 'routes/admin.js');
    const { remoteRouter } = await import(SRC + 'routes/remote.js');
    auth.createUser({ username: 'boss', role: 'admin', name: 'B' }, { trusted: true });
    auth.createUser({ username: 'sadm', role: 'admin', name: 'S', scope: { vcenters: ['vc-us-east'] } }, { trusted: true });
    auth.createUser({ username: 'sub', role: 'viewer', name: 'U', scope: { vcenters: ['vc-us-east'] } }, { trusted: true });
    auth.createUser({ username: 'euop', role: 'operator', name: 'E', scope: { vcenters: ['vc-eu-west'] } }, { trusted: true });
    const app = express(); app.use(express.json({ limit: '5mb' }));
    app.use((req, _r, n) => {
      const name = req.headers['x-u'] || 'full';
      if (name === 'full') { req.user = { username: 'full', role: 'admin', scope: null }; return n(); }
      const u = auth.listUsers().find((x) => x.username === name);
      req.user = u ? { username: u.username, role: u.role, scope: u.scope } : null; n();
    });
    app.use('/api/admin', adminRouter); app.use('/api/remote', remoteRouter); app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const call = async (u, method, p, b) => {
      const r = await fetch(base + '/api' + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t.slice(0, 300); }
      return { s: r.status, j };
    };
    const CFG = process.env.CONFIG_DIR;
    const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(CFG, f), 'utf8')); } catch { return null; } };
    const userRec = (n) => auth.listUsers().find((x) => x.username === n) || null;
    const out = {};
    try { ${body} } catch (e) { out.err = String(e && e.stack || e); } finally { srv.close(); }
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', ...env },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 180_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${(r.stderr || '').slice(-2000)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력 없음: ${r.stdout.slice(-1000)} ${r.stderr.slice(-1000)}`);
  const o = JSON.parse(line.slice(2));
  assert.equal(o.err, undefined, o.err);
  return o;
}

test('AUTHZ2607-01: 범위 admin 은 자기 scope 를 해제·확대하지 못하고, 범위 밖·전체 범위 계정을 만들거나 바꾸지 못한다', () => {
  const o = runChild(`
    out.total0 = auth.listUsers().length;
    out.list = (await call('sadm', 'GET', '/admin/users')).j;
    out.selfNull = (await call('sadm', 'PATCH', '/admin/users/sadm', { scope: null })).s;
    out.selfWiden = (await call('sadm', 'PATCH', '/admin/users/sadm', { scope: { vcenters: ['vc-us-east', 'vc-eu-west'] } })).s;
    out.selfRegion = (await call('sadm', 'PATCH', '/admin/users/sadm', { scope: { vcenters: ['vc-us-east'], regions: ['EMEA'] } })).s;
    out.sadmAfter = userRec('sadm').scope;
    out.createFull = (await call('sadm', 'POST', '/admin/users', { username: 'evil', role: 'admin', name: 'E' })).s;
    out.createOut = (await call('sadm', 'POST', '/admin/users', { username: 'evil2', role: 'viewer', scope: { vcenters: ['vc-eu-west'] } })).s;
    out.createIn = (await call('sadm', 'POST', '/admin/users', { username: 'okuser', role: 'viewer', scope: { vcenters: ['vc-us-east'] } })).s;
    out.evil = !!userRec('evil'); out.evil2 = !!userRec('evil2'); out.okuser = !!userRec('okuser');
    out.pwBoss = (await call('sadm', 'POST', '/admin/users/boss/password', { password: 'Xx!23456789abc' })).s;
    out.bossHasPw = userRec('boss').hasPassword;
    out.totpBoss = (await call('sadm', 'POST', '/admin/users/boss/totp/begin')).s;
    out.patchBoss = (await call('sadm', 'PATCH', '/admin/users/boss', { role: 'viewer' })).s;
    out.delBoss = (await call('sadm', 'DELETE', '/admin/users/boss')).s;
    out.patchEu = (await call('sadm', 'PATCH', '/admin/users/euop', { scope: { vcenters: ['vc-us-east'] } })).s;
    out.euAfter = userRec('euop').scope;
    out.perm = (await call('sadm', 'PUT', '/admin/permissions', { operator: [], viewer: [] })).s;
    out.pwSub = (await call('sadm', 'POST', '/admin/users/sub/password', { password: 'Yy!23456789abc' })).s;
    out.patchSubRole = (await call('sadm', 'PATCH', '/admin/users/sub', { role: 'operator' })).s;
    out.selfNarrow = (await call('sadm', 'PATCH', '/admin/users/sadm', { name: 'S2' })).s;
    // 전체 범위 admin 은 예전 그대로
    out.fullList = (await call('full', 'GET', '/admin/users')).j.users.length;
    out.fullPatch = (await call('full', 'PATCH', '/admin/users/sadm', { scope: null })).s;
    out.sadmFreed = userRec('sadm').scope;
  `);
  assert.deepEqual(o.list.users.map((u) => u.username).sort(), ['sadm', 'sub'], '범위 밖·전체 범위 계정은 목록에서 숨긴다');
  assert.equal(o.list.omittedOutOfScope, o.total0 - 2);
  assert.equal(o.selfNull, 403, '수정 전: 200 이고 scope 가 지워져 전체 범위가 됐다');
  assert.equal(o.selfWiden, 403);
  assert.equal(o.selfRegion, 403, '리전은 vCenter 가 늘면 커진다 — 요청자 리전 밖은 거부');
  assert.deepEqual(o.sadmAfter.vcenters, ['vc-us-east']);
  assert.equal(o.createFull, 403, '수정 전: 200 이고 scope 없는 admin 이 생겼다');
  assert.equal(o.createOut, 403);
  assert.equal(o.createIn, 200);
  assert.equal(o.evil, false); assert.equal(o.evil2, false); assert.equal(o.okuser, true);
  assert.equal(o.pwBoss, 404, '수정 전: 200 {ok:true} — 전체 범위 admin 비밀번호 대리 설정');
  assert.equal(o.bossHasPw, false);
  assert.equal(o.totpBoss, 404);
  assert.equal(o.patchBoss, 404);
  assert.equal(o.delBoss, 404);
  assert.equal(o.patchEu, 404);
  assert.deepEqual(o.euAfter.vcenters, ['vc-eu-west']);
  assert.equal(o.perm, 403);
  assert.equal(o.pwSub, 200, '범위 안 계정은 예전처럼 대리 관리한다');
  assert.equal(o.patchSubRole, 200);
  assert.equal(o.selfNarrow, 200);
  assert.ok(o.fullList >= 4);
  assert.equal(o.fullPatch, 200);
  assert.deepEqual(o.sadmFreed.vcenters, [], '전체 범위 admin 은 scope 해제를 그대로 할 수 있다');
});

test('AUTHZ2607-02·06·07: 게스트 명령·게스트 조사·분석·감사 로그·위임 인벤토리 범위', () => {
  const o = runChild(`
    const snap = store.get();
    out.inScope = snap.vms.filter((v) => v.vcenterId === 'vc-us-east' && !v.template).length;
    const pr = await call('sadm', 'POST', '/admin/deep-search/probe', { probe: { type: 'process', pattern: 'x' }, vcenterIds: [], maxVms: 1 });
    out.probe = { s: pr.s, cand: pr.j && pr.j.candidates };
    out.probeOut = (await call('sadm', 'POST', '/admin/deep-search/probe', { probe: { type: 'process', pattern: 'x' }, vcenterIds: ['vc-eu-west'], maxVms: 1 })).s;
    const fp = await call('full', 'POST', '/admin/deep-search/probe', { probe: { type: 'process', pattern: 'x' }, vcenterIds: [], maxVms: 1 });
    out.fullCand = fp.j && fp.j.candidates;
    out.gsOut = (await call('sadm', 'PUT', '/admin/security/guest-scans', { vcenterId: 'vc-eu-west', type: 'login-fails', name: 'x' })).s;
    out.gsEmpty = (await call('sadm', 'PUT', '/admin/security/guest-scans', { vcenterId: '', type: 'login-fails', name: 'x' })).s;
    const fullJob = await call('full', 'PUT', '/admin/security/guest-scans', { vcenterId: 'vc-eu-west', type: 'login-fails', name: 'eu' });
    out.fullJobId = fullJob.j && fullJob.j.id;
    const inJob = await call('sadm', 'PUT', '/admin/security/guest-scans', { vcenterId: 'vc-us-east', type: 'net-issues', name: 'us' });
    out.inJob = inJob.s;
    const lst = (await call('sadm', 'GET', '/admin/security/guest-scans')).j;
    out.sadmJobs = lst.jobs.map((j) => j.vcenterId); out.sadmOmitted = lst.omittedOutOfScope;
    out.gsDel = (await call('sadm', 'DELETE', '/admin/security/guest-scans/' + out.fullJobId)).s;
    out.gsRun = (await call('sadm', 'POST', '/admin/security/guest-scans/' + out.fullJobId + '/run')).s;
    out.gsHijack = (await call('sadm', 'PUT', '/admin/security/guest-scans', { id: out.fullJobId, vcenterId: 'vc-us-east', name: 'mine' })).s;
    out.fullJobs = (await call('full', 'GET', '/admin/security/guest-scans')).j.jobs.map((j) => j.vcenterId).sort();
    out.lf = (await call('sadm', 'GET', '/admin/security/login-fails?vcenterId=vc-us-east')).s;
    out.lfSettings = (await call('sadm', 'PUT', '/admin/security/login-fails/settings', { days: 1 })).s;
    out.ni = (await call('sadm', 'GET', '/admin/security/net-issues?vcenterId=vc-eu-west')).s;
    const niIn = await call('sadm', 'GET', '/admin/security/net-issues');
    out.niIn = { s: niIn.s, vc: niIn.j && niIn.j.config && niIn.j.config.vcenterId };
    out.li = (await call('sadm', 'GET', '/admin/net/log-issues?vcenterId=vc-eu-west')).s;
    out.vclogs = (await call('sadm', 'POST', '/admin/vclogs/collect')).s;
    out.vclogSettings = (await call('sadm', 'PUT', '/admin/vclogs/settings', { retentionDays: 1 })).s;
    out.audit = (await call('sadm', 'GET', '/admin/audit')).s;
    out.inv = (await call('sadm', 'GET', '/admin/central/inventory')).s;
    out.owner = (await call('sadm', 'POST', '/admin/central/inventory/owner', { vcenterId: 'vc-eu-west', agent: '' })).s;
    out.fullAudit = (await call('full', 'GET', '/admin/audit')).s;
    out.fullInv = (await call('full', 'GET', '/admin/central/inventory')).s;
    out.fullNi = (await call('full', 'GET', '/admin/security/net-issues')).s;
  `);
  assert.equal(o.probe.s, 200);
  assert.equal(o.probe.cand, o.inScope, '수정 전: candidates=전 함대(약 2,100) — 범위 밖 VM 까지 게스트 명령 대상');
  assert.equal(o.probeOut, 404);
  assert.ok(o.fullCand > o.inScope, '전체 범위 admin 은 예전 그대로');
  assert.equal(o.gsOut, 404, '수정 전: 200 으로 범위 밖 vCenter 잡이 저장됐다');
  assert.equal(o.gsEmpty, 404);
  assert.equal(o.inJob, 200);
  assert.deepEqual(o.sadmJobs, ['vc-us-east']);
  assert.equal(o.sadmOmitted, 1);
  assert.equal(o.gsDel, 404); assert.equal(o.gsRun, 404); assert.equal(o.gsHijack, 404);
  assert.deepEqual(o.fullJobs, ['vc-eu-west', 'vc-us-east'], '범위 밖 잡은 그대로 남는다');
  assert.equal(o.lf, 403);
  assert.equal(o.lfSettings, 403);
  assert.equal(o.ni, 404);
  assert.deepEqual(o.niIn, { s: 200, vc: 'vc-us-east' }, '미지정이면 범위가 하나일 때 그 vCenter 로 강제');
  assert.equal(o.li, 404);
  assert.equal(o.vclogs, 403);
  assert.equal(o.vclogSettings, 403);
  assert.equal(o.audit, 403, '수정 전: 200 — 전 사용자·전 법인 감사 기록');
  assert.equal(o.inv, 403);
  assert.equal(o.owner, 403);
  assert.equal(o.fullAudit, 200); assert.equal(o.fullInv, 200); assert.equal(o.fullNi, 200);
});

test('AUTHZ2607-03·04: vCenter 등록부·IPAM 스캔 대역 — 범위 밖은 404, 전 법인 동작은 403, 범위 안은 그대로', () => {
  const o = runChild(`
    const reg = await import(SRC + 'vcenter/registry.js');
    reg.addVcenter({ id: 'vc-us-east', name: 'a', host: 'https://10.10.0.5', username: 'svc@a', password: 'p1' });
    reg.addVcenter({ id: 'vc-eu-west', name: 'b', host: 'https://10.53.0.5', username: 'svc@b', password: 'p2' });
    const l = (await call('sadm', 'GET', '/admin/vcenters')).j;
    out.list = l.vcenters.map((v) => v.id); out.omit = l.omittedOutOfScope;
    out.put = (await call('sadm', 'PUT', '/admin/vcenters/vc-eu-west', { enabled: false })).s;
    out.del = (await call('sadm', 'DELETE', '/admin/vcenters/vc-eu-west')).s;
    out.test = (await call('sadm', 'POST', '/admin/vcenters/test', { id: 'vc-eu-west' })).s;
    out.testNew = (await call('sadm', 'POST', '/admin/vcenters/test', { host: 'https://10.1.1.1', username: 'x', password: 'y' })).s;
    out.add = (await call('sadm', 'POST', '/admin/vcenters', { id: 'vc-new', name: 'n', host: 'https://10.2.2.2', username: 'u', password: 'p' })).s;
    out.ds = (await call('sadm', 'PUT', '/admin/data-source', { dataSource: 'live' })).s;
    out.order = (await call('sadm', 'PUT', '/admin/vcenter-order', { order: ['vc-eu-west'] })).s;
    out.orderGet = (await call('sadm', 'GET', '/admin/vcenter-order')).j.vcenters.map((v) => v.id);
    out.putIn = (await call('sadm', 'PUT', '/admin/vcenters/vc-us-east', { name: 'a2' })).s;
    out.after = reg.listRegistry().map((v) => [v.id, v.enabled !== false]);
    out.fullList = (await call('full', 'GET', '/admin/vcenters')).j.vcenters.length;
    // IPAM
    out.fput = (await call('full', 'PUT', '/admin/ipam/vc-ranges', { vcenterId: 'vc-eu-west', ranges: ['10.53.0.0/24'] })).s;
    out.sput = (await call('sadm', 'PUT', '/admin/ipam/vc-ranges', { vcenterId: 'vc-eu-west', ranges: ['10.99.0.0/24'] })).s;
    out.sdel = (await call('sadm', 'DELETE', '/admin/ipam/vc-ranges/vc-eu-west')).s;
    out.sputIn = (await call('sadm', 'PUT', '/admin/ipam/vc-ranges', { vcenterId: 'vc-us-east', ranges: ['10.10.0.0/24'] })).s;
    const csv = 'vcenter,ranges,enabled\\nvc-eu-west,10.77.0.0/24,true\\nvc-us-east,10.11.0.0/24,true\\n';
    const imp = await call('sadm', 'POST', '/admin/ipam/vc-ranges/import', { csv, overwrite: true });
    out.imp = { s: imp.s, oos: imp.j && imp.j.skippedOutOfScope, failed: (imp.j && imp.j.failed || []).length };
    out.results = (await call('sadm', 'GET', '/admin/ipam/scan/results')).s;
    out.ranges = (await call('full', 'GET', '/tools/ipam/vc-ranges')).j;
  `);
  assert.deepEqual(o.list, ['vc-us-east'], '수정 전: 범위 밖 vCenter 의 관리 주소·계정명까지 보였다');
  assert.equal(o.omit, 1);
  assert.equal(o.put, 404, '수정 전: 200 으로 범위 밖 vCenter 가 꺼졌다');
  assert.equal(o.del, 404);
  assert.equal(o.test, 404);
  assert.equal(o.testNew, 403);
  assert.equal(o.add, 403);
  assert.equal(o.ds, 403);
  assert.equal(o.order, 403);
  assert.deepEqual(o.orderGet, ['vc-us-east']);
  assert.equal(o.putIn, 200);
  assert.deepEqual(o.after, [['vc-us-east', true], ['vc-eu-west', true]]);
  assert.equal(o.fullList, 2);
  assert.equal(o.fput, 200);
  assert.equal(o.sput, 404, '수정 전: 200 으로 보이지 않는 법인 대역을 덮어썼다');
  assert.equal(o.sdel, 404);
  assert.equal(o.sputIn, 200);
  // v2.611 LEFT2611-04: 범위 밖 vCenter 행은 '알 수 없는 vCenter' 와 같은 오류 행이다(존재 은닉) — 예전 skippedOutOfScope 개수도
  //   존재 단서였다. 저장되지 않는다는 성질(아래 ranges 검사)은 그대로다.
  assert.equal(o.imp.s, 200); assert.equal(o.imp.oos, undefined); assert.equal(o.imp.failed, 1);
  assert.equal(o.results, 403);
  const txt = JSON.stringify(o.ranges);
  assert.ok(txt.includes('10.53.0.0/24'), '범위 밖 대역은 그대로: ' + txt);
  assert.ok(!txt.includes('10.99.0.0') && !txt.includes('10.77.0.0'), txt);
  assert.ok(txt.includes('10.11.0.0/24'), '범위 안 import 행은 저장: ' + txt);
});

test('AUTHZ2607-05: 범위 admin 이 보낸 전역 필드(사용 여부·보존일·주기)는 적용하지 않고 ignoredGlobal 로 밝힌다 · 전체 범위 admin 은 그대로', () => {
  const o = runChild(`
    const before = {
      vms: (await call('full', 'GET', '/tools/vmseries/settings')).j.settings,
      cur: (await call('full', 'GET', '/tools/curuser/settings')).j.settings,
    };
    const r1 = await call('sadm', 'PUT', '/tools/vmseries/settings', { retentionDays: 1, enabled: true });
    out.vms = { s: r1.s, ig: r1.j.ignoredGlobal };
    out.vmsAfter = (await call('full', 'GET', '/tools/vmseries/settings')).j.settings;
    out.vmsBefore = before.vms;
    const r2 = await call('sadm', 'PUT', '/tools/curuser/settings', { retentionDays: 1, enabled: true });
    out.cur = { s: r2.s, ig: r2.j.ignoredGlobal };
    out.curAfter = (await call('full', 'GET', '/tools/curuser/settings')).j.settings;
    out.curBefore = before.cur;
    const r3 = await call('sadm', 'PUT', '/tools/bm-usage/settings', { rawRetentionDays: 7, enabled: true });
    out.bm = { s: r3.s, ig: r3.j.ignoredGlobal, raw: r3.j.settings && r3.j.settings.rawRetentionDays, en: r3.j.settings && r3.j.settings.enabled };
    const gd0 = (await call('full', 'GET', '/tools/guest-disk/status')).j;
    const r4 = await call('sadm', 'PUT', '/tools/guest-disk/settings', { retentionDays: 7, enabled: !((gd0.settings || {}).enabled) });
    out.gd = { s: r4.s, ig: r4.j.ignoredGlobal, same: JSON.stringify(r4.j.settings) === JSON.stringify(gd0.settings) };
    const w0 = (await call('full', 'GET', '/tools/waste/settings')).j.settings;
    const r5 = await call('sadm', 'PUT', '/tools/waste/settings', { retentionDays: 1, enabled: !w0.enabled });
    out.waste = { s: r5.s, ig: r5.j.ignoredGlobal, ret: r5.j.settings.retentionDays === w0.retentionDays, en: r5.j.settings.enabled === w0.enabled };
    const r6 = await call('sadm', 'PUT', '/tools/waste/off-check/settings', { enabled: true, intervalHours: 1 });
    out.off = { s: r6.s, ig: r6.j.ignoredGlobal };
    // 왕복(같은 값)은 무시 목록에 싣지 않는다
    const rt = await call('sadm', 'PUT', '/tools/vmseries/settings', { ...before.vms, targets: {} });
    out.roundTrip = rt.j.ignoredGlobal || null;
    // 전체 범위 admin 은 그대로 적용
    const f = await call('full', 'PUT', '/tools/vmseries/settings', { retentionDays: 3 });
    out.full = { s: f.s, ret: f.j.settings.retentionDays, ig: f.j.ignoredGlobal || null };
  `);
  assert.equal(o.vms.s, 200);
  assert.ok(o.vms.ig.includes('retentionDays') && o.vms.ig.includes('enabled'), JSON.stringify(o.vms));
  assert.equal(o.vmsAfter.retentionDays, o.vmsBefore.retentionDays, '수정 전: 보존일 1일이 저장돼 전 법인 스파이크 DB 가 prune 됐다');
  assert.equal(o.vmsAfter.enabled, o.vmsBefore.enabled);
  assert.ok(o.cur.ig.includes('enabled'), JSON.stringify(o.cur));
  assert.equal(o.curAfter.enabled, o.curBefore.enabled);
  assert.ok(o.bm.ig.includes('rawRetentionDays'), JSON.stringify(o.bm));
  assert.notEqual(o.bm.raw, 7);
  assert.ok(o.gd.ig.includes('enabled'), JSON.stringify(o.gd)); assert.equal(o.gd.same, true);
  assert.ok(o.waste.ig.includes('retentionDays'), JSON.stringify(o.waste)); assert.equal(o.waste.ret, true); assert.equal(o.waste.en, true);
  assert.ok(o.off.ig.includes('enabled') || o.off.ig.includes('intervalHours'), JSON.stringify(o.off));
  assert.equal(o.roundTrip, null, '같은 값을 되돌려 보낸 왕복은 무시했다고 말하지 않는다: ' + JSON.stringify(o.roundTrip));
  assert.equal(o.full.s, 200); assert.equal(o.full.ret, 3); assert.equal(o.full.ig, null);
});

test('RECENT2607-03: 범위 admin 의 프록시 저장은 범위 밖 vCenter 배정을 보존하고, 공유 프록시의 주소 변경·삭제는 403', () => {
  const o = runChild(`
    const reg = await import(SRC + 'proxy/registry.js');
    const c = reg.saveProxy({ name: 'p1', proxyHost: '10.20.0.1', vcenterIds: ['vc-us-east', 'vc-eu-west'] });
    const id = c.proxy.id;
    const e = reg.saveProxy({ name: 'p-eu', proxyHost: '10.30.0.1', vcenterIds: ['vc-eu-west'] });
    const full = (await call('sadm', 'GET', '/remote/proxies/full')).j.proxies.find((p) => p.id === id);
    out.seen = full.vcenterIds;
    // 화면처럼 받은 값을 그대로(이름 그대로) 되돌려 저장
    const rt = await call('sadm', 'POST', '/remote/proxies', { ...full, vcenterIds: full.vcenterIds });
    out.rt = { s: rt.s, v: rt.j.proxy && rt.j.proxy.vcenterIds };
    out.afterRt = reg.listProxiesSafe().find((p) => p.id === id).vcenterIds;
    out.rename = (await call('sadm', 'POST', '/remote/proxies', { id, name: 'renamed' })).s;
    out.host = (await call('sadm', 'POST', '/remote/proxies', { id, proxyHost: '10.66.6.6' })).s;
    out.drop = (await call('sadm', 'POST', '/remote/proxies', { id, vcenterIds: [] })).s;
    out.afterDrop = reg.listProxiesSafe().find((p) => p.id === id).vcenterIds;
    out.del = (await call('sadm', 'DELETE', '/remote/proxies/' + id)).s;
    out.delEu = (await call('sadm', 'DELETE', '/remote/proxies/' + e.proxy.id)).s;
    out.cfg = (await call('sadm', 'PUT', '/remote/config', { proxyHost: '10.1.1.1' })).s;
    const mine = await call('sadm', 'POST', '/remote/proxies', { name: 'mine', proxyHost: '10.40.0.1', vcenterIds: ['vc-us-east', 'vc-eu-west'] });
    out.mine = { s: mine.s, v: mine.j.proxy && mine.j.proxy.vcenterIds, ig: mine.j.ignoredOutOfScope };
    out.mineStored = reg.listProxiesSafe().find((p) => p.name === 'mine').vcenterIds;
    out.delMine = (await call('sadm', 'DELETE', '/remote/proxies/' + mine.j.proxy.id)).s;
    out.final = reg.listProxiesSafe().map((p) => [p.name, p.proxyHost, p.vcenterIds]);
    out.fullDel = (await call('full', 'DELETE', '/remote/proxies/' + e.proxy.id)).s;
  `);
  assert.deepEqual(o.seen, ['vc-us-east']);
  assert.equal(o.rt.s, 200);
  assert.deepEqual(o.rt.v, ['vc-us-east'], '응답도 범위로 거른다');
  assert.deepEqual(o.afterRt.sort(), ['vc-eu-west', 'vc-us-east'], '수정 전: [vc-us-east] 로 교체돼 vc-eu-west 가 기본 프록시로 떨어졌다');
  assert.equal(o.rename, 403);
  assert.equal(o.host, 403);
  assert.equal(o.drop, 200);
  assert.deepEqual(o.afterDrop, ['vc-eu-west'], '범위 안 배정만 빠진다');
  assert.equal(o.del, 404, '범위 안 배정이 없어진 공유 프록시는 존재 은닉');
  assert.equal(o.delEu, 404);
  assert.equal(o.cfg, 403);
  assert.equal(o.mine.s, 200); assert.deepEqual(o.mine.v, ['vc-us-east']); assert.equal(o.mine.ig, 1);
  assert.deepEqual(o.mineStored, ['vc-us-east']);
  assert.equal(o.delMine, 200);
  assert.deepEqual(o.final, [['p1', '10.20.0.1', ['vc-eu-west']], ['p-eu', '10.30.0.1', ['vc-eu-west']]]);
  assert.equal(o.fullDel, 200);
});
