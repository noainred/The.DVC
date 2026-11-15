/**
 * veeamFullAudit2.test.js — 전체 소스 점검 2회차(백업 ② · Veeam · 공용 백업 서버) 확정분.
 *  ① V-1: 전 법인 공용 쓰기 · 실행의 판정은 조회 ∧ 쓰기 전체 하나(scopeMerge.denyFleetWrite · denyScopedRun) — 쓰기 범위만 줄인 관리자도 403(writeScope:'partial'),
 *         조회 범위 계정은 예전 사유 그대로. 라우트 안 인라인 검사 7곳(vclogs · login-fails · permissions 둘 · os-scan · remote config · vcenters test 새 항목)도 같은 판정.
 *  ② V-2: 쓰기 클라이언트 list() 는 total 이 null 이면 모름(Number(null)===0 금지) · total 이 있으면 짧은 쪽에서 멈추지 않는다 · 상한이면 truncated —
 *         백업 삭제는 목록을 다 못 읽었으면 '지울 것이 없습니다(성공)' 대신 보내지 않음 · 개체 범위 확인(F3)도 잘린 목록이면 건너뛴다.
 *  ③ V-3: 업그레이드 자동 적용 대기에 Veeam 관리 작업 · 보내는 중 실행 · 엣지 대행 상태 변경 · 엣지 워커 실행 중 작업이 들어간다(읽기 작업은 넣지 않는다).
 *  ④ V-4: 세션 추적 가드는 서버마다 — 느린 서버의 회신을 기다리는 동안 다음 틱이 다른 서버를 읽는다.
 *  ⑤ V-5: 시각을 모르는 복원 지점(pointAt null)은 0(1970)이 아니라 null.
 *  ⑥ V-7: 이 vCenter 를 맡는 B&R 둘이 같은 이름이면 어느 서버로 보낼지 단정하지 않는다(unknown).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'veeamfullaudit2-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const rd = (p) => stripComments(fs.readFileSync(path.join(SRC, p), 'utf8'));

const { store } = await import('../src/store.js');
store.snapshot = { ...store.get(), vcenters: [{ id: 'vcA', name: 'A' }, { id: 'vcB', name: 'B' }] };
const SM = await import('../src/auth/scopeMerge.js');
const SC = await import('../src/auth/scope.js');
const SH = await import('../src/routes/admin/shared.js');

const U = {
  adm: { username: 'adm', role: 'admin', scope: null },
  wadm: { username: 'wadm', role: 'admin', scope: { vcenters: [], writeVcenters: ['vcA'] } },   // 조회 무제한 + 쓰기 vcA
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vcA'] } },                        // 조회 vcA
  boom: { username: 'boom', role: 'admin', scope: { vcenters: [], get writeVcenters() { throw new Error('boom'); } } },
};
const fakeRes = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };

test('① V-1 — denyFleetWrite · denyScopedRun: 조회 ∧ 쓰기 전체만 통과 · 쓰기 범위 사유는 따로', () => {
  for (const [who, deny, partial] of [['adm', false, false], ['wadm', true, true], ['sadm', true, false], ['boom', true, true]]) {
    const res = fakeRes();
    assert.equal(SM.denyFleetWrite({ user: U[who] }, res, '전 법인 공용'), deny, who);
    if (!deny) { assert.equal(res.body, null); continue; }
    assert.equal(res.code, 403, who);
    if (partial) { assert.equal(res.body.writeScope, 'partial', who); assert.equal(res.body.reason, SC.WRITE_SCOPE_PARTIAL_REASON); }
    else assert.equal(res.body.reason, '전 법인 공용');
    const r2 = fakeRes();
    assert.equal(SM.denyScopedRun({ user: U[who] }, r2, '수동 수집'), true, `${who} — 실행도 같은 판정`);
  }
  assert.equal(SH.WRITE_SCOPE_PARTIAL_REASON, SC.WRITE_SCOPE_PARTIAL_REASON, '문구는 하나(공용 게이트가 다시 내보낸다)');
});

let srv;
const base = async () => {
  if (srv) return `http://127.0.0.1:${srv.address().port}/api`;
  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express(); app.use(express.json());
  app.use((req, _r, next) => { req.user = U[req.headers['x-u']] || null; next(); });
  app.use('/api/admin', adminRouter);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return `http://127.0.0.1:${srv.address().port}/api`;
};
test.after(() => srv?.close());
const call = async (who, method, p, body) => {
  const r = await fetch(`${await base()}${p}`, { method, headers: { 'content-type': 'application/json', 'x-u': who }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { j = null; }
  return { status: r.status, body: j };
};

test('① V-1 — 라우트: 쓰기 범위만 줄인 관리자는 전 법인 공용 쓰기 · 실행 · 새 항목 시험이 403 · 조회 범위 계정도 403', async () => {
  const cases = [
    ['PUT', '/admin/vclogs/settings', { pollIntervalMin: 30 }],
    ['POST', '/admin/vclogs/collect', {}],
    ['PUT', '/admin/security/login-fails/settings', { enabled: false }],
    ['POST', '/admin/security/login-fails/run', {}],
    ['PUT', '/admin/permissions', { role: 'viewer', perms: {} }],
    ['POST', '/admin/permissions/reset', {}],
    ['PUT', '/admin/os-scan/settings', { enabled: false }],
    ['POST', '/admin/certs/refresh', {}],
    ['POST', '/admin/vcenters/test', { host: 'evil.example', username: 'u', password: 'p' }],
  ];
  for (const [m, p, b] of cases) {
    const w = await call('wadm', m, p, b);
    assert.equal(w.status, 403, `wadm ${m} ${p}`); assert.equal(w.body?.writeScope, 'partial', `${p} — 쓰기 범위 사유`);
    const s = await call('sadm', m, p, b);
    assert.equal(s.status, 403, `sadm ${m} ${p}`); assert.notEqual(s.body?.writeScope, 'partial', `${p} — 조회 범위 사유 그대로`);
  }
  // 저장된 범위 밖 vCenter 시험은 조회 범위 계정에 404(예전 그대로) · 조회 무제한 계정은 저장 항목 시험으로 들어간다(새 항목만 403)
  assert.equal((await call('sadm', 'POST', '/admin/vcenters/test', { id: 'vcB' })).status, 404);
});

test('① V-1 — 소스 스윕: 고친 7곳은 denyFleetWrite · 조회 범위만 보는 403 인라인 검사가 쓰기 라우트에 다시 생기지 않는다', () => {
  const sites = [
    ['routes/admin/backupNetSec.js', 2], ['routes/admin/users.js', 2], ['routes/admin/opsSettings.js', 1], ['routes/remote.js', 1],
  ];
  for (const [f, n] of sites) assert.equal((rd(f).match(/denyFleetWrite\(req, res,/g) || []).length, n, f);
  assert.match(rd('routes/admin/vcenters.js'), /if \(!isFullReadWriteScope\(req\.user, store\.get\(\)\)\) \{\n\s*const id = String/);
  assert.match(rd('auth/scopeMerge.js'), /export function denyScopedRun\(req, res, what = '이 실행'\) \{\n\s*return denyFleetWrite\(/);
  // 쓰기 메서드 라우트 줄에 조회 범위만 보는 403 이 붙어 있으면 실패(같은 줄 · 다음 3줄)
  const routeFiles = ['routes/admin/backupNetSec.js', 'routes/admin/users.js', 'routes/admin/opsSettings.js', 'routes/remote.js', 'routes/admin/vcenters.js'];
  for (const f of routeFiles) {
    const lines = rd(f).split('\n');
    lines.forEach((l, i) => {
      if (!/\.(put|post|delete|patch)\('/.test(l)) return;
      const win = lines.slice(i, i + 4).join('\n');
      assert.doesNotMatch(win, /if \(scopedVcenterIds\(req\.user, store\.get\(\)\)\)( return)? (res\.status\(403\)|\{)/, `${f}:${i + 1}`);
    });
  }
});

// ── V-2 ───────────────────────────────────────────────────────────
function fakeVbr(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname}`;
    calls.push({ key, query: Object.fromEntries(u.searchParams) });
    const h = routes[key];
    const r = typeof h === 'function' ? h({ url: u }) : h;
    if (!r) return new Response(JSON.stringify({ message: 'no route' }), { status: 404 });
    return new Response(r.status === 204 ? null : JSON.stringify(r.json ?? {}), { status: r.status || 200, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  fn.deletes = () => calls.filter((c) => c.key.startsWith('DELETE '));
  return fn;
}
const TOKEN = { 'POST /api/oauth2/token': { json: { access_token: 't' } }, 'POST /api/oauth2/logout': { status: 200 } };
const SRV = { id: 'vbr-1', name: 'OC2', host: 'vbr.corp.local', port: 9419, username: 'svc', password: 'pw', enabled: true, agent: '' };
const VM = { name: 'LESAREP02', objectId: 'vm-77', hostName: 'oc2-vc.corp.local' };
const MARK = 'x [vmware-portal:managed] y';
const INC = (n, o) => ({ type: 'VirtualMachine', hostName: 'oc2-vc.corp.local', name: n, objectId: o });
const JOB = { 'GET /api/v1/jobs': { json: { data: [{ id: 'job-1', name: 'PORTAL-OC2-d6c8d5' }] } },
  'GET /api/v1/jobs/job-1': { json: { id: 'job-1', name: 'PORTAL-OC2-d6c8d5', description: MARK, virtualMachines: { includes: [INC('LESAREP02', 'vm-77'), INC('b', 'vm-2')] } } },
  'PUT /api/v1/jobs/job-1': { json: {} } };
const OBJ = (id, name, moref) => ({ id, name, objectId: moref, platformName: 'VMware' });
// 서버가 limit 을 낮춰(2개씩) 주는 쪽 나눔 — total 은 정확히
const paged = (all, { totalOf = (n) => n } = {}) => ({ url }) => {
  const skip = Number(url.searchParams.get('skip') || 0);
  return { json: { data: all.slice(skip, skip + 2), pagination: { total: totalOf(all.length) } } };
};

test('② V-2 — list(): total 이 있으면 짧은 쪽에서 멈추지 않는다 · total null 은 모름 · 상한은 truncated', async () => {
  const { makeRunClient } = await import('../src/veeam/run/client.js');
  const items = Array.from({ length: 5 }, (_, i) => ({ id: `o${i}` }));
  const f1 = fakeVbr({ ...TOKEN, 'GET /api/v1/x': paged(items) });
  const c1 = makeRunClient(SRV, { fetchImpl: f1 });
  const a = await c1.list('/api/v1/x');
  assert.equal(a.length, 5, '서버가 2개씩 줘도 total 까지 읽는다'); assert.equal(a.truncated, undefined);
  // total null — 첫 쪽(2개 · PAGE 보다 짧음)에서 끝으로 본다(모름 → 짧은 쪽 규칙). 0 으로 읽어 '다 읽음' 으로 단정하지 않는다
  const f2 = fakeVbr({ ...TOKEN, 'GET /api/v1/x': { json: { data: items.slice(0, 2), pagination: { total: null } } } });
  const b = await makeRunClient(SRV, { fetchImpl: f2 }).list('/api/v1/x');
  assert.equal(b.length, 2);
  // 빈 쪽인데 total 이 더 있다 → truncated
  const f3 = fakeVbr({ ...TOKEN, 'GET /api/v1/x': ({ url }) => (Number(url.searchParams.get('skip')) ? { json: { data: [], pagination: { total: 9 } } } : { json: { data: items.slice(0, 2), pagination: { total: 9 } } }) });
  const c = await makeRunClient(SRV, { fetchImpl: f3 }).list('/api/v1/x');
  assert.equal(c.length, 2); assert.equal(c.truncated, true);
  // max 상한
  const d = await makeRunClient(SRV, { fetchImpl: fakeVbr({ ...TOKEN, 'GET /api/v1/x': paged(items) }) }).list('/api/v1/x', { max: 3 });
  assert.equal(d.length, 3); assert.equal(d.truncated, true);
});

test('② V-2 — 백업 삭제: 개체 목록이 쪽으로 나뉘어도 이 VM 개체를 찾는다 · 잘린 목록이면 보내지 않는다 · 잘린 지점 목록이면 개체 삭제를 건너뛴다', async () => {
  const manage = await import('../src/veeam/run/manage.js');
  const objs = [OBJ('obj-1', 'a', 'vm-1'), OBJ('obj-2', 'b', 'vm-2'), OBJ('obj-77', 'LESAREP02', 'vm-77')];   // 이 VM 은 둘째 쪽에
  const baseR = { ...TOKEN, ...JOB, 'GET /api/v1/backups': { json: { data: [{ id: 'bk-1', jobId: 'job-1' }], pagination: { total: 1 } } },
    'GET /api/v1/backups/bk-1/objects': paged(objs),
    'GET /api/v1/backupObjects/obj-77/restorePoints': { json: { data: [{ id: 'p1', backupId: 'bk-1' }], pagination: { total: 1 } } },
    'DELETE /api/v1/backupObjects/obj-77': { status: 202, json: {} } };
  const ok = fakeVbr(baseR);
  const r = await manage.opDeleteBackup(SRV, { jobName: 'PORTAL-OC2-d6c8d5', vm: VM, fetchImpl: ok });
  assert.equal(r.ok, true, r.reason); assert.equal(r.deleted, 1, '둘째 쪽의 개체도 찾는다(예전: 첫 쪽에서 멈춰 \'지울 것이 없습니다\')');
  // 개체 목록이 잘렸다(빈 쪽인데 total 이 더 있음) → 성공으로 답하지 않는다
  const cut = fakeVbr({ ...baseR, 'GET /api/v1/backups/bk-1/objects': ({ url }) => (Number(url.searchParams.get('skip')) ? { json: { data: [], pagination: { total: 3 } } } : { json: { data: objs.slice(0, 2), pagination: { total: 3 } } }) });
  const r2 = await manage.opDeleteBackup(SRV, { jobName: 'PORTAL-OC2-d6c8d5', vm: VM, fetchImpl: cut });
  assert.equal(r2.ok, false); assert.equal(r2.notSent, true); assert.match(r2.reason, /끝까지 읽지 못해/); assert.equal(cut.deletes().length, 0);
  // 개체의 복원 지점 목록이 잘렸다(다른 백업 지점이 못 읽은 쪽에 있을 수 있다) → 개체 삭제 건너뜀
  const pts = fakeVbr({ ...baseR, 'GET /api/v1/backupObjects/obj-77/restorePoints': ({ url }) => (Number(url.searchParams.get('skip')) ? { json: { data: [], pagination: { total: 5 } } } : { json: { data: [{ id: 'p1', backupId: 'bk-1' }], pagination: { total: 5 } } }) });
  const r3 = await manage.opDeleteBackup(SRV, { jobName: 'PORTAL-OC2-d6c8d5', vm: VM, fetchImpl: pts });
  assert.equal(r3.ok, false); assert.equal(pts.deletes().length, 0, 'F3 확인을 부분 목록으로 통과하지 않는다');
});

test('③ V-3 — 업그레이드 대기: Veeam 관리 작업 · 보내는 중 실행 · 엣지 대행 상태 변경 · 엣지 워커 실행 중', async () => {
  const IF = await import('../src/veeam/run/inflight.js');
  const runs = await import('../src/veeam/run/runs.js');
  const E = await import('../src/veeam/run/edgeOps.js');
  runs._resetForTest(); E._resetForTest(); IF._resetVeeamInflightForTest();
  assert.deepEqual(IF.runningVeeamWork(), []);
  const tok = runs.claimServer('vbr-1', 'deleteBackup', 'kim');
  let w = IF.runningVeeamWork();
  assert.equal(w.length, 1); assert.equal(w[0].kind, 'veeam'); assert.match(w[0].label, /백업 삭제/); assert.equal(w[0].resumable, false);
  assert.ok(!JSON.stringify(w).includes('kim'), '사용자 이름은 싣지 않는다');
  runs.releaseServer('vbr-1', tok);
  assert.equal(IF.runningVeeamWork().length, 0);
  // 엣지 대행: 상태 변경만(세션 조회는 넣지 않는다)
  E.enqueueEdgeOp({ id: 'vbr-e', agent: 'edge-pl' }, 'sessions', { sessionIds: ['s1'] });
  E.enqueueEdgeOp({ id: 'vbr-e', agent: 'edge-pl' }, 'quickBackup', { vms: [] });
  w = IF.runningVeeamWork();
  assert.equal(w.length, 1, '읽기(sessions)는 기다리지 않는다'); assert.match(w[0].label, /Quick Backup/);
  E._resetForTest();
  // 엣지 워커 실행 중
  IF.noteVeeamEdgeOpStart('op1', 'deleteBackup', 'vbr-e');
  assert.equal(IF.runningVeeamWork().length, 1);
  IF.noteVeeamEdgeOpEnd('op1');
  assert.equal(IF.runningVeeamWork().length, 0);
  // 소스: 업그레이드 관리자 · 엣지 워커 · 삭제 라우트의 요청 감사(보내기 전)
  const mg = rd('upgrade/manager.js');
  assert.match(mg, /\.\.\.bareosWork\(\), \.\.\.veeamWork\(\)\]/);
  assert.match(mg, /NON_SCAN_KINDS = new Set\(\[[^\]]*'veeam'/);
  const wk = rd('agent/veeamRunWorker.js');
  assert.match(wk, /if \(track\) noteVeeamEdgeOpStart\(op\.id, op\.kind, op\.serverId\);\n\s*try \{/);
  assert.match(wk, /finally \{ if \(track\) noteVeeamEdgeOpEnd\(op\.id\); \}/);
  const bm = rd('routes/api/backupManage.js');
  const iReq = bm.indexOf("action: 'Veeam 포탈 잡 백업 삭제 요청'"); const iSend = bm.indexOf("dispatchOp(server, 'deleteBackup'");
  assert.ok(iReq > 0 && iReq < iSend, '삭제 요청 감사는 보내기 전에');
});

test('④ V-4(+반증 R-4) — 세션 추적: 느린 서버(꺼진 엣지)를 기다리는 동안 다음 틱이 같은 틱에 묶였던 빠른 서버를 다시 읽는다 · 느린 서버는 겹쳐 읽지 않는다', async () => {
  const REG = await import('../src/veeam/registry.js');
  const runs = await import('../src/veeam/run/runs.js');
  const E = await import('../src/veeam/run/edgeOps.js');
  const { authGuard } = await import('../src/veeam/poller.js');
  runs._resetForTest(); E._resetForTest();
  const slow = REG.saveServer({ name: 'SLOW', host: 'vbr-slow.corp.local', username: 'u', password: 'p', agent: 'edge-x', vcenterIds: ['vcA'] });   // 엣지 대행 — 아무도 가져가지 않는다
  const fast = REG.saveServer({ name: 'FAST', host: 'vbr-fast.corp.local', username: 'u', password: 'p', vcenterIds: ['vcB'] });                   // 중앙 직접 — 인증 정지라 즉시 '보내지 않음'
  assert.ok(slow.id && fast.id, '등록');
  authGuard.markAuthStopped(fast.id, REG.getServerWithSecret(fast.id), '시험용 정지');
  const grp = (srv, sid) => ({ serverId: srv.id, serverName: srv.name, kind: 'quick', state: 'running', sessions: [{ id: sid, objectIds: [sid], finished: false }] });
  const vm = (srv, sid) => ({ vmId: sid, name: sid, objectId: sid, serverId: srv.id, how: 'quick', state: 'running', sessionId: sid });
  runs._resetForTest();   // 파일을 다시 읽게(_runs = null)
  fs.writeFileSync(path.join(DIR, 'veeam-backup-runs.json'), JSON.stringify({ runs: [{ id: 'run-1', at: Date.now(), status: 'running', mode: 'quick', user: 't', vms: [vm(slow, 's-slow'), vm(fast, 's-fast')], groups: [grp(slow, 's-slow'), grp(fast, 's-fast')] }] }));
  const fastSess = () => runs.getRun('run-1').groups.find((g) => g.serverId === fast.id).sessions[0];
  const tickA = runs.trackOnce();   // 느린 서버 회신(인출 시한 수 분)을 기다리며 끝나지 않는다 — 기다리지 않는다
  for (let i = 0; i < 20 && !fastSess().lastErrorAt; i++) await new Promise((r) => setTimeout(r, 5));
  const first = fastSess().lastErrorAt;
  assert.ok(first > 0, '빠른 서버는 첫 틱에서 읽었다');
  await new Promise((r) => setTimeout(r, 5));
  const tickB = await runs.trackOnce();
  assert.notEqual(tickB.skipped, true, '전역 가드로 통째로 건너뛰지 않는다');
  assert.ok(fastSess().lastErrorAt > first, '같은 틱에 묶였던 빠른 서버를 다음 틱이 다시 읽는다(반증 R-4 — 예전 판은 틱 A 가 끝날 때까지 건너뛰었다)');
  assert.equal(E.pendingView().filter((o) => o.kind === 'sessions').length, 1, '느린 서버는 겹쳐 보내지 않는다(대기 1건)');
  E._resetForTest(); void tickA;
});
test('⑤ V-5 — 복원 지점 시각을 모르면 null(0 · 1970 아님)', () => {
  const bm = rd('routes/api/backupManage.js');
  assert.match(bm, /const pointAt0 = numOrNull\(b\.pointAt\);\n\s*const pointAt = pointAt0 !== null && pointAt0 > 946_684_800_000 \? pointAt0 : null;/);
  assert.doesNotMatch(bm, /Number\.isFinite\(Number\(b\.pointAt\)\)/);
});

test('⑥ V-7 — 같은 이름 B&R 두 대: 어느 서버로 보낼지 단정하지 않는다', async () => {
  const { runStatusOf } = await import('../src/veeam/run/plan.js');
  const vm = { id: 'vcA:vm-1', name: 'web', vcenterId: 'vcA', moref: 'vm-1' };
  const servers = [{ id: 's-a', name: 'VBR' }, { id: 's-b', name: 'vbr' }];
  const r = runStatusOf(vm, { servers, known: true, entry: { rp: 3, lb: Date.now(), servers: ['VBR'] } });
  assert.equal(r.status, 'unknown'); assert.match(r.reason, /같은 이름/); assert.equal(r.serverId, undefined);
  // 이름이 다르면 그 서버
  const r2 = runStatusOf(vm, { servers: [{ id: 's-a', name: 'VBR-A' }, { id: 's-b', name: 'VBR-B' }], known: true, entry: { rp: 3, lb: Date.now(), servers: ['VBR-B'] } });
  assert.equal(r2.status, 'protected'); assert.equal(r2.serverId, 's-b');
});

test('⑦ V-9(4회차) — 시계 보정이 0 이어도 엣지가 보낸 poller.at · authStop.since 는 수신 시각으로 자른다', async () => {
  const { saveVeeamEdgeStatus, veeamEdgeStatus, _resetForTest } = await import('../src/central/veeamEdge.js');
  const { sanitizeServerResult } = await import('../src/veeam/parse.js');
  const now = Date.parse('2026-11-15T10:00:00Z');
  const future = now + 40 * 86_400_000;   // 40일 앞선 엣지 시계(보정 창 밖 — 보정 0)
  _resetForTest();
  saveVeeamEdgeStatus('edge-x', { poller: { at: future, ok: 1, fail: 0 } }, null, { clockOffsetMs: 0, now });
  assert.equal(veeamEdgeStatus('edge-x').status.poller.at, now, 'poller.at 는 미래가 아니다');
  saveVeeamEdgeStatus('edge-y', { poller: { at: now - 60_000 } }, null, { clockOffsetMs: 0, now });
  assert.equal(veeamEdgeStatus('edge-y').status.poller.at, now - 60_000, '과거 값은 그대로');
  const r = sanitizeServerResult({ ok: true, ts: now - 1000, jobs: [], vms: [], authStop: { since: future, attempts: 1, reason: 'x' } }, now, { clockOffsetMs: 0 });
  assert.equal(r.authStop.since, now, 'authStop.since 도 미래가 아니다');
  const r2 = sanitizeServerResult({ ok: true, ts: now - 1000, jobs: [], vms: [], authStop: { since: now - 5000, attempts: 1, reason: 'x' } }, now, { clockOffsetMs: 0 });
  assert.equal(r2.authStop.since, now - 5000);
});
