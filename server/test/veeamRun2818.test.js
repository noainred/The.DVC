import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v2.818 Backup 현황 › 백업 실행(Veeam B&R REST) — 쓰기 클라이언트·후보 체인·결과 모름(F2)·시한(F3)·판정(F6)·엣지 대행(비밀 없음·바인딩·정제 — F1)·
// 인증 정지(모니터링과 같은 기록)·실행 기록·라우트 범위(조회 밖 404 → 쓰기 밖 403). 실제 VBR 은 없다 — 가짜 응답(fetchImpl)으로 계약을 고정한다.
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-veeamrun-'));
process.env.CONFIG_DIR = CFG;
process.env.CENTRAL_TOKEN = 'shared-token-for-veeamrun-test-1234567890';

const exec = await import('../src/veeam/run/exec.js');
const plan = await import('../src/veeam/run/plan.js');
const settings = await import('../src/veeam/run/settings.js');
const edgeOps = await import('../src/veeam/run/edgeOps.js');
const dispatch = await import('../src/veeam/run/dispatch.js');
const runs = await import('../src/veeam/run/runs.js');
const worker = await import('../src/agent/veeamRunWorker.js');
const { authGuard } = await import('../src/veeam/poller.js');

/* ── 가짜 VBR(fetchImpl) ─────────────────────────────────────────────── */
function fakeVbr(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname}`;
    let body = init.body;
    try { body = typeof body === 'string' && body.startsWith('{') ? JSON.parse(body) : body; } catch { /* form */ }
    calls.push({ key, headers: init.headers || {}, body, redirect: init.redirect });
    const h = routes[key];
    const r = typeof h === 'function' ? h({ url: u, body, calls }) : h;
    if (r === 'THROW') { const e = new TypeError('fetch failed'); e.cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); throw e; }
    if (!r) return new Response(JSON.stringify({ errorCode: 'NotFound', message: 'no route' }), { status: 404 });
    return new Response(r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? ''), { status: r.status || 200, headers: r.headers || { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  fn.posts = () => calls.filter((c) => c.key.startsWith('POST /api/v1/'));
  return fn;
}
const TOKEN = { 'POST /api/oauth2/token': { json: { access_token: 'tok-abc' } }, 'POST /api/oauth2/logout': { status: 200, text: '' } };
const SRV = { id: 'vbr-x', name: 'VBR-KR', host: 'vbr.corp.local', port: 9419, username: 'CORP\\svc', password: 'S3cret!pw', apiVersion: '1.2-rev0', enabled: true, agent: '' };
const VMS = [{ name: 'erp-db', objectId: 'vm-10', hostName: 'kr-vc01.corp.local' }, { name: 'erp-app', objectId: 'vm-12', hostName: 'kr-vc01.corp.local' }];

/* ── 쓰기 클라이언트·Quick Backup ───────────────────────────────────── */
test('Quick Backup: 토큰(form·x-api-version·리다이렉트 안 따라감) → A 성공 · 응답·사유에 비밀 없음', async () => {
  const f = fakeVbr({ ...TOKEN, [`POST ${exec.QUICK_PATH}`]: ({ body }) => (body.virtualMachines ? { status: 201, json: { id: 'sess-1', state: 'Starting' } } : null) });
  const r = await exec.opQuickBackup(SRV, { vms: VMS, fetchImpl: f });
  assert.equal(r.ok, true, r.reason); assert.equal(r.variant, 'A:virtualMachines[]');
  assert.deepEqual(r.sessions, [{ id: 'sess-1', objectIds: ['vm-10', 'vm-12'] }]);
  const tok = f.calls[0];
  assert.equal(tok.key, 'POST /api/oauth2/token'); assert.match(tok.body, /grant_type=password/); assert.equal(tok.headers['x-api-version'], '1.2-rev0'); assert.equal(tok.redirect, 'manual');
  assert.equal(f.calls[1].body.virtualMachines[0].type, 'VirtualMachine');
  assert.ok(!JSON.stringify(r).includes('S3cret') && !JSON.stringify(r).includes('tok-abc'));
});

test('Quick Backup 후보: A/B 모양 거절 → C(VM 별) · 409 는 다음 후보로 넘어가지 않는다(시작 안 됨 = 실패)', async () => {
  let n = 0;
  const c = fakeVbr({ ...TOKEN, [`POST ${exec.QUICK_PATH}`]: ({ body }) => (body.virtualMachines || body.objects ? { status: 400, json: { message: 'unknown property' } } : { status: 201, json: { id: `s-${++n}`, state: 'Starting' } }) });
  const rc = await exec.opQuickBackup(SRV, { vms: VMS, fetchImpl: c });
  assert.equal(rc.variant, 'C:per-vm'); assert.deepEqual(rc.sessions.map((s) => s.objectIds[0]), ['vm-10', 'vm-12']);
  const busy = fakeVbr({ ...TOKEN, [`POST ${exec.QUICK_PATH}`]: { status: 409, json: { message: 'job is running' } } });
  const rb = await exec.opQuickBackup(SRV, { vms: VMS, fetchImpl: busy });
  assert.equal(rb.ok, false); assert.equal(rb.unknown, false); assert.equal(busy.posts().length, 1);
});

test('F2: 상태 변경 요청이 끊김·503·504 면 실패가 아니라 결과 모름(unknown) — 다음 후보로도 넘어가지 않는다', async () => {
  for (const resp of ['THROW', { status: 503, json: {} }, { status: 504, text: 'gateway timeout' }]) {
    const f = fakeVbr({ ...TOKEN, [`POST ${exec.QUICK_PATH}`]: resp });
    const r = await exec.opQuickBackup(SRV, { vms: VMS, fetchImpl: f });
    assert.equal(r.ok, false); assert.equal(r.unknown, true, JSON.stringify(r)); assert.match(r.reason, /알 수 없습니다/);
    assert.equal(f.posts().length, 1, '같은 요청을 모양만 바꿔 다시 보내지 않는다');
  }
  // 잡 시작이 끊겨도 모름
  const g = fakeVbr({ ...TOKEN, 'GET /api/v1/jobs': { json: { data: [{ id: 'jp', name: 'P' }] } },
    'GET /api/v1/jobs/jp': { json: { id: 'jp', name: 'P', description: exec.PORTAL_MARKER, virtualMachines: { includes: VMS.map((v) => ({ inventoryObject: { type: 'VirtualMachine', ...v } })) } } },
    'POST /api/v1/jobs/jp/start': 'THROW' });
  const rg = await exec.opPortalJob(SRV, { jobName: 'P', repositoryId: 'r1', vms: VMS, fetchImpl: g });
  assert.equal(rg.unknown, true); assert.equal(g.calls.filter((x) => x.key.endsWith('/start')).length, 1);
});

test('F3: 시한(deadlineAt)이 지났으면 상태 변경 요청을 보내지 않는다(notSent)', async () => {
  const f = fakeVbr({ ...TOKEN, [`POST ${exec.QUICK_PATH}`]: { status: 201, json: { id: 's' } } });
  const r = await exec.opQuickBackup(SRV, { vms: VMS, deadlineAt: Date.now() - 1, fetchImpl: f });
  assert.equal(r.notSent, true); assert.equal(f.calls.length, 0);
  const p = await exec.opPortalJob(SRV, { jobName: 'P', repositoryId: 'r1', vms: VMS, deadlineAt: Date.now() - 1, fetchImpl: f });
  assert.equal(p.notSent, true); assert.equal(f.calls.length, 0);
});

test('자격 거부: 토큰 401·400 invalid_grant 는 authFailed(아무것도 보내지 않음)', async () => {
  for (const resp of [{ status: 401, json: {} }, { status: 400, json: { error: 'invalid_grant' } }]) {
    const f = fakeVbr({ 'POST /api/oauth2/token': resp });
    const r = await exec.opQuickBackup(SRV, { vms: VMS, fetchImpl: f });
    assert.equal(r.authFailed, true); assert.equal(r.unknown, false); assert.equal(f.calls.length, 1);
  }
  const red = fakeVbr({ 'POST /api/oauth2/token': { status: 307, headers: { location: 'https://evil.example/steal?x=1' }, text: '' } });
  const rr = await exec.opQuickBackup(SRV, { vms: VMS, fetchImpl: red });
  assert.equal(rr.ok, false); assert.equal(rr.unknown, false); assert.ok(!rr.reason.includes('steal'));
});

test('포탈 전용 잡: 없으면 만들고(모양 후보) 시작 · 표지 없는 같은 이름 잡은 손대지 않는다 · 있으면 빠진 VM 만 추가', async () => {
  let created = null;
  const f1 = fakeVbr({ ...TOKEN, 'GET /api/v1/jobs': { json: { data: [] } },
    'POST /api/v1/jobs': ({ body }) => { if (body.virtualMachines.includes[0].inventoryObject) return { status: 400, json: { message: 'bad include' } }; created = body; return { status: 201, json: { id: 'job-new' } }; },
    'POST /api/v1/jobs/job-new/start': { status: 201, json: { id: 'sess-9', state: 'Starting' } } });
  const r1 = await exec.opPortalJob(SRV, { jobName: 'PORTAL-kr', repositoryId: 'r1', retention: 5, vms: VMS, fetchImpl: f1 });
  assert.equal(r1.ok, true, r1.reason); assert.equal(r1.created, true); assert.match(r1.variant, /create:Backup:flat/);
  assert.ok(created.description.includes(exec.PORTAL_MARKER)); assert.equal(created.storage.retentionPolicy.quantity, 5); assert.equal(created.schedule.runAutomatically, false);
  const r0 = await exec.opPortalJob(SRV, { jobName: 'PORTAL-kr', repositoryId: '', vms: VMS, fetchImpl: fakeVbr({ ...TOKEN, 'GET /api/v1/jobs': { json: { data: [] } } }) });
  assert.equal(r0.ok, false); assert.equal(r0.notSent, true);
  const f2 = fakeVbr({ ...TOKEN, 'GET /api/v1/jobs': { json: { data: [{ id: 'jh', name: 'PORTAL-kr' }] } }, 'GET /api/v1/jobs/jh': { json: { id: 'jh', name: 'PORTAL-kr', description: 'human job', virtualMachines: { includes: [] } } } });
  const r2 = await exec.opPortalJob(SRV, { jobName: 'PORTAL-kr', repositoryId: 'r1', vms: VMS, fetchImpl: f2 });
  assert.equal(r2.ok, false); assert.match(r2.reason, /포탈이 만든 잡이 아닙니다/);
  assert.ok(!f2.calls.some((c) => c.key.startsWith('PUT') || c.key.endsWith('/start')));
  let put = null;
  const f3 = fakeVbr({ ...TOKEN, 'GET /api/v1/jobs': { json: { data: [{ id: 'jp', name: 'PORTAL-kr' }] } },
    'GET /api/v1/jobs/jp': { json: { id: 'jp', name: 'PORTAL-kr', description: exec.PORTAL_MARKER, virtualMachines: { includes: [{ inventoryObject: { type: 'VirtualMachine', hostName: 'KR-VC01.corp.local', name: 'erp-db', objectId: 'vm-10' } }] } } },
    'PUT /api/v1/jobs/jp': ({ body }) => { put = body; return { status: 200, json: body }; }, 'POST /api/v1/jobs/jp/start': { status: 201, json: { id: 'sess-3', state: 'Starting' } } });
  const r3 = await exec.opPortalJob(SRV, { jobName: 'PORTAL-kr', repositoryId: 'r1', vms: VMS, fetchImpl: f3 });
  assert.equal(r3.ok, true, r3.reason); assert.equal(r3.added, 1); assert.equal(put.virtualMachines.includes[1].inventoryObject.objectId, 'vm-12');
});

test('세션: 한 로그인으로 여러 세션 · VM 별 작업 정제', async () => {
  const f = fakeVbr({ ...TOKEN,
    'GET /api/v1/sessions/s1': { json: { id: 's1', state: 'Stopped', endTime: '2026-10-29T05:00:00Z', result: { result: 'Warning' } } },
    'GET /api/v1/sessions/s1/taskSessions': { json: { data: [{ name: 'erp-db', state: 'Stopped', result: { result: 'Success' }, progress: { progressPercent: '100' } }] } },
    'GET /api/v1/sessions/s2': { json: { id: 's2', state: 'Working', progressPercent: 40 } } });
  const r = await exec.opSessions(SRV, { sessionIds: ['s1', 's2', '../x'], fetchImpl: f });
  assert.equal(r.ok, true); assert.equal(f.calls.filter((c) => c.key === 'POST /api/oauth2/token').length, 1);
  assert.equal(r.sessions.length, 2); assert.equal(r.sessions[0].finished, true); assert.equal(r.sessions[0].tasks[0].progress, 100);
  assert.equal(r.sessions[1].finished, false); assert.equal(r.sessions[1].tasksKnown, false);
});

/* ── 판정 ───────────────────────────────────────────────────────────── */
test('판정: 보호(그 서버)·다른 곳·잡만·미보호·모름·매핑 없음 — 대조 결과(byVm)만 읽는다', () => {
  const servers = [{ id: 's1', name: 'VBR-KR' }, { id: 's2', name: 'VBR-KR2' }];
  const vm = { id: 'vcA:vm-1', vcenterId: 'vcA', name: 'a' };
  assert.equal(plan.runStatusOf(vm, { servers: [], known: true }).status, 'unmapped');
  assert.equal(plan.runStatusOf(vm, { servers, known: false }).status, 'unknown');
  assert.equal(plan.runStatusOf(vm, { servers, known: true }).status, 'unprotected');
  const p = plan.runStatusOf(vm, { servers, known: true, entry: { rp: 3, servers: ['VBR-KR2'], jobs: ['J'] } });
  assert.equal(p.status, 'protected'); assert.equal(p.serverId, 's2');   // 그 VM 을 백업한 서버로 보낸다
  assert.equal(plan.runStatusOf(vm, { servers, known: true, entry: { rp: 3, servers: ['EM-only'] } }).status, 'elsewhere');
  assert.equal(plan.runStatusOf(vm, { servers, known: true, entry: { rp: null, lb: null, jobs: ['J'], servers: ['VBR-KR'] } }).status, 'in-job');
  assert.equal(plan.runStatusOf(vm, { servers, known: true, entry: { rp: 0, lb: 1_790_000_000_000, servers: ['VBR-KR'] } }).status, 'protected');
  assert.equal(plan.morefOf({ id: 'a:b:vm-3', vcenterId: 'a:b' }), 'vm-3');
});

test('방식 배정 · F6 포탈 잡 이름은 vCenter 마다 다르다(한글 이름·특수문자도)', () => {
  const S = { serverId: 's1', serverName: 'VBR' };
  const it = (id, vc, status, extra = {}) => ({ vm: { id: `${vc}:${id}`, vcenterId: vc, name: id }, run: { status, objectId: id, ...S, ...extra }, hostName: 'kr-vc01' });
  const items = [it('vm-1', 'A', 'protected'), it('vm-2', 'A', 'unprotected'), it('vm-3', 'B', 'in-job'), it('vm-4', 'A', 'unknown'), it('vm-5', 'A', 'protected', { running: true }),
    { vm: { id: 'C:vm-6', vcenterId: 'C', name: 'x' }, run: { status: 'protected', objectId: 'vm-6', ...S }, hostName: '' }];
  const q = plan.planBackup(items, { mode: 'quick', unprotected: 'portal' });
  assert.deepEqual(q.vms.map((v) => v.how), ['quick', 'portal', 'portal', 'skip', 'skip', 'skip']);
  assert.deepEqual(q.groups.map((g) => `${g.kind}:${g.vcenterId || ''}:${g.refs.length}`).sort(), ['portal:A:1', 'portal:B:1', 'quick::1']);
  assert.deepEqual(plan.planBackup(items, { mode: 'quick', unprotected: 'skip' }).vms.map((v) => v.how), ['quick', 'skip', 'skip', 'skip', 'skip', 'skip']);
  const a = plan.portalJobName('PORTAL-', { id: 'vc-seoul', name: '서울' });
  const b = plan.portalJobName('PORTAL-', { id: 'vc-busan', name: '부산' });
  const c = plan.portalJobName('PORTAL-', { id: 'x1', name: 'KR VC' });
  const d = plan.portalJobName('PORTAL-', { id: 'x2', name: 'KR/VC' });
  assert.notEqual(a, b); assert.notEqual(c, d); assert.match(a, /^PORTAL-vcenter-[0-9a-f]{6}$/);
  assert.equal(plan.portalJobName('PORTAL-', { id: 'vc-seoul', name: '서울' }), a);   // 결정적(같은 vCenter → 같은 이름)
  assert.deepEqual(plan.veeamHostFor({ host: 'h' }, { manual: 'm' }), { name: 'm', how: 'manual' });
  assert.deepEqual(plan.veeamHostFor({ host: 'h' }, { aliasHosts: ['al'] }), { name: 'al', how: 'alias' });
  assert.deepEqual(plan.veeamHostFor({ host: 'h' }, { aliasHosts: ['a1', 'a2'] }), { name: 'h', how: 'host' });
});

test('설정: 형식 오류는 거부(조용히 버리지 않는다) · 정규화', () => {
  settings._resetForTest();
  assert.equal(settings.saveRunSettings({ jobPrefix: '<x>' }).ok, false);
  assert.equal(settings.saveRunSettings({ servers: { s1: { retention: 0 } } }).ok, false);
  assert.equal(settings.saveRunSettings({ hosts: { vc: 'a b' } }).ok, false);
  const r = settings.saveRunSettings({ jobPrefix: 'BK-', servers: { s1: { repositoryId: 'r-1', retention: '9' } }, hosts: { vcA: 'kr-vc01.corp.local' } });
  assert.equal(r.ok, true); assert.deepEqual(settings.serverRunSettings('s1'), { repositoryId: 'r-1', retention: 9 });
  assert.equal(settings.serverRunSettings('nope').retention, settings.DEFAULT_RETENTION);
});

/* ── 인증 정지(모니터링과 같은 기록) ─────────────────────────────────── */
test('인증 정지: 실행 중 자격 거부 → 같은 정지 기록 → 다음 실행·세션 확인을 보내지 않는다 · 비밀번호 바꾸면 풀림', async () => {
  const s = { ...SRV, id: 'vbr-auth' };
  const bad = fakeVbr({ 'POST /api/oauth2/token': { status: 401, json: {} } });
  const r1 = await dispatch.dispatchOp(s, 'quickBackup', { vms: VMS }, { fetchImpl: bad });
  assert.equal(r1.authFailed, true);
  assert.ok(authGuard.peekAuthStop(s), '모니터링 폴러와 같은 정지 기록');
  const n = bad.calls.length;
  const r2 = await dispatch.dispatchOp(s, 'sessions', { sessionIds: ['x'] }, { fetchImpl: bad });
  assert.equal(r2.authStopped, true); assert.equal(bad.calls.length, n);
  assert.equal(dispatch.authStopOf({ ...s, password: 'new' }), null);
  authGuard.clearAuthStop(s.id);
});

/* ── 엣지 대행 ──────────────────────────────────────────────────────── */
let server; let base; let tokens;
before(async () => {
  tokens = await import('../src/central/agentTokens.js');
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express(); app.use(express.json()); app.use('/api/central', centralRouter);
  server = app.listen(0); await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/central`;
});
after(() => { try { server?.close(); } catch { /* */ } edgeOps._resetForTest(); });

test('F1: 엣지 작업에는 비밀번호가 없다(서버 id·남은 시간뿐) · 개별 토큰 전용 · 자기 몫만 · 남의 회신 거부 · 결과 정제', async () => {
  const tKr = tokens.issueAgentToken('KR-Seoul').token;
  const tPl = tokens.issueAgentToken('PL-Warsaw').token;
  const p = edgeOps.enqueueEdgeOp({ ...SRV, agent: 'PL-Warsaw' }, 'quickBackup', { vms: VMS });
  let r = await fetch(`${base}/veeam-run-ops`, { headers: { 'X-Central-Token': process.env.CENTRAL_TOKEN } });
  assert.equal(r.status, 403);
  r = await fetch(`${base}/veeam-run-ops`, { headers: { 'X-Central-Token': tKr } });
  assert.deepEqual((await r.json()).ops, []);
  r = await fetch(`${base}/veeam-run-ops?agent=PL-Warsaw`, { headers: { 'X-Central-Token': tKr } });
  assert.equal(r.status, 403);
  r = await fetch(`${base}/veeam-run-ops`, { headers: { 'X-Central-Token': tPl } });
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const ops = (await r.json()).ops;
  assert.equal(ops.length, 1); assert.equal(ops[0].serverId, 'vbr-x');
  assert.ok(!JSON.stringify(ops).includes('S3cret'), '비밀번호를 싣지 않는다');
  assert.ok(ops[0].ttlMs > 0 && ops[0].ttlMs < edgeOps.RESULT_MS.quickBackup, '남은 시간(엣지 시계와 무관) — 중앙 시한보다 짧게');
  r = await fetch(`${base}/veeam-run-result`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': tKr }, body: JSON.stringify({ id: ops[0].id, result: { ok: true } }) });
  assert.equal(r.status, 403);
  r = await fetch(`${base}/veeam-run-result`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': tPl },
    body: JSON.stringify({ id: ops[0].id, result: { ok: true, variant: 'A', password: 'leak', sessions: [{ id: 's-1', objectIds: ['vm-10', { x: 1 }] }, 'junk'] } }) });
  assert.equal(r.status, 200);
  const res = await p;
  assert.equal(res.ok, true); assert.equal(res.password, undefined); assert.deepEqual(res.sessions, [{ id: 's-1', objectIds: ['vm-10'] }]);
  r = await fetch(`${base}/veeam-run-result`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': tPl }, body: JSON.stringify({ id: ops[0].id, result: { ok: true } }) });
  assert.equal((await r.json()).stale, true);
  edgeOps._resetForTest();
});

test('엣지 워커: 배정 안 된 서버·담당 다른 서버는 실행하지 않는다 · 시한 지난 작업은 보내지 않는다', async () => {
  const f = fakeVbr({ ...TOKEN, [`POST ${exec.QUICK_PATH}`]: { status: 201, json: { id: 's' } } });
  const op = { id: 'o1', kind: 'quickBackup', serverId: 'vbr-x', args: { vms: VMS }, ttlMs: 60_000 };
  const notMine = await worker.runEdgeOp(op, { fetchImpl: f, getServer: () => ({ ...SRV, pulled: true, agent: 'OTHER' }) });
  assert.equal(notMine.notSent, true);
  const local = await worker.runEdgeOp(op, { fetchImpl: f, getServer: () => ({ ...SRV, pulled: false, agent: '' }) });
  assert.equal(local.notSent, true);
  const late = await worker.runEdgeOp({ ...op, ttlMs: 1 }, { receivedAt: Date.now() - 10_000, fetchImpl: f, getServer: () => ({ ...SRV, pulled: true, agent: '' }) });
  assert.equal(late.notSent, true);
  assert.equal(f.calls.length, 0);
});

/* ── 실행 기록 ──────────────────────────────────────────────────────── */
test('실행: 세션 결과 반영(VM 별 작업 우선 · 목록에 없으면 단정하지 않음) · 재시작 복구(보내던 VM 은 확인 불가 · 다시 보내지 않음)', () => {
  const run = { vms: [{ vmId: 'a', name: 'erp-db', objectId: 'vm-10', sessionId: 's1', state: 'running' }, { vmId: 'b', name: 'erp-app', objectId: 'vm-12', sessionId: 's1', state: 'running' }] };
  runs.applySession(run, 's1', { finished: true, tasksKnown: true, result: 'Success', tasks: [{ name: 'erp-db', result: 'Success', state: 'Stopped', progress: 100 }] });
  assert.equal(run.vms[0].state, 'success'); assert.equal(run.vms[1].state, 'unknown');
  const r2 = { vms: [{ vmId: 'c', name: 'x', objectId: 'vm-3', sessionId: 's2', state: 'running' }] };
  runs.applySession(r2, 's2', { finished: true, tasksKnown: false, result: 'Failed', tasks: [] });
  assert.equal(r2.vms[0].state, 'failed');
  runs._resetForTest();
  fs.writeFileSync(path.join(CFG, 'veeam-backup-runs.json'), JSON.stringify({ version: 1, runs: [{ id: 'vbr_1', at: Date.now(), status: 'running', groups: [{ serverId: 's', kind: 'quick', state: 'starting', sessions: [] }],
    vms: [{ vmId: 'a', name: 'a', state: 'starting' }, { vmId: 'b', name: 'b', state: 'queued' }, { vmId: 'c', name: 'c', state: 'running', sessionId: 'x' }] }] }));
  assert.equal(runs.recoverInterrupted(), 2);
  assert.deepEqual(runs.getRun('vbr_1').vms.map((v) => v.state), ['unknown', 'skipped', 'running']);
});

/* ── 라우트 범위 ─────────────────────────────────────────────────────── */
test('라우트: VM 목록 범위 밖 404 · 미리보기는 조회 밖 404 → 쓰기 밖 403 · 설정은 전체 범위만', async () => {
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { registerBackupRun } = await import('../src/routes/api/backupRun.js');
  const SNAP = { vcenters: [{ id: 'kr1', name: 'kr1' }, { id: 'kr2', name: 'kr2' }, { id: 'us1', name: 'us1' }],
    vms: [{ id: 'kr1:vm-1', vcenterId: 'kr1', name: 'a' }, { id: 'kr2:vm-2', vcenterId: 'kr2', name: 'b' }, { id: 'us1:vm-3', vcenterId: 'us1', name: 'c' }] };
  const origGet = store.get;
  store.get = () => SNAP;
  const user = { username: 'scoped', role: 'admin', scope: { vcenters: ['kr1', 'kr2'], regions: [], writeVcenters: ['kr1'] } };
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); registerBackupRun(api); app.use('/api', api);
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  const b = `http://127.0.0.1:${srv.address().port}/api`;
  const post = (p, body) => fetch(`${b}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${b}/tools/backup-run/vms?vcenterId=us1`)).status, 404);
    const j = await (await fetch(`${b}/tools/backup-run/vms`)).json();
    assert.deepEqual(j.vcenters.map((v) => v.id).sort(), ['kr1', 'kr2']);
    const k = await (await fetch(`${b}/tools/backup-run/vms?vcenterId=kr1`)).json();
    assert.equal(k.rows[0].run.status, 'unmapped');
    assert.equal((await post('/tools/backup-run/plan', { vmIds: ['us1:vm-3'] })).status, 404);
    assert.equal((await post('/tools/backup-run/plan', { vmIds: ['kr2:vm-2'] })).status, 403);
    const ok = await post('/tools/backup-run/plan', { vmIds: ['kr1:vm-1'] });
    assert.equal(ok.status, 200); const pj = await ok.json();
    assert.equal(pj.vms[0].how, 'skip'); assert.ok(pj.blocked);
    assert.equal((await fetch(`${b}/tools/backup-run/settings`)).status, 403);
    assert.equal((await fetch(`${b}/tools/backup-run/runs/nope`)).status, 404);
  } finally { store.get = origGet; srv.close(); }
});
