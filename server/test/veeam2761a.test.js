/**
 * test/veeam2761a.test.js — v2.761 Veeam 수집·파싱·관리 라우트 점검 확정분 회귀(그룹 A·B·D6).
 *
 *  · A1 복제·백업 복사 작업/세션은 '백업 중·대기' 근거가 아니다(작업 상태·세션 jobId·세션 유형 — 판정 하나).
 *  · A2 시한이 끊긴 뒤 부분 결과를 ok:true 로 돌려주지 않는다 · logout 은 상위 시한과 따로.
 *  · A3 로그인 뒤 GET 의 401 은 인증 정지가 아니다(kind 'token' — 이번 수집만 실패). 로그인 401 은 그대로 정지.
 *  · A4 페이지는 받은 개수로 넘기고 total 로 끝을 정한다 · 잘린 목록은 notes.
 *  · A6 에이전트 이름이 IP 면 첫 옥텟으로 자르지 않는다.  · A7 백업 1건의 파일 404 는 그 백업만.  · A8 마지막 백업 = 더 늦은 쪽.
 *  · B3 엣지 노드는 자기 몫의 '지금 읽기'·'연결 시험' 을 한다(정지 해제 경로) · 중앙 거절 문구는 정지 상태를 사실대로.
 *  · B4 접속처가 바뀌면 옛 결과·인증 정지를 지운다(단건 저장·대량 가져오기·엣지 pull).
 *  · B6 엣지 이름이 바뀌어도 옛 이름으로 받은 서버(비밀번호 포함)를 남기지 않는다.
 *  · D6 '지금 읽기' 응답의 ok 는 boolean · okCount/failCount · 꺼진 서버는 disabled.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'veeam2761a-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
const closers = [];

// Veeam(https://vbr…) 요청만 가짜로 받는다 — 폴러·라우트는 전역 fetch 를 쓴다(테스트 서버 요청은 진짜 fetch 로).
const realFetch = globalThis.fetch;
let vbrHandler = null;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://vbr')) {
    if (!vbrHandler) throw new TypeError('fetch failed');
    return vbrHandler(url, init || {});
  }
  return realFetch(url, init);
};
after(async () => {
  globalThis.fetch = realFetch;
  for (const c of closers.reverse()) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

const P = await import('../src/veeam/parse.js');
const R = await import('../src/veeam/registry.js');
const ST = await import('../src/veeam/store.js');
const C = await import('../src/veeam/client.js');
const poller = await import('../src/veeam/poller.js');
const { config } = await import('../src/config.js');
const KEEP_AGENT = { ...config.agent };
const resetAgent = () => { Object.assign(config.agent, KEEP_AGENT); config.agent.centralUrl = ''; config.agent.centralToken = ''; config.agent.name = ''; };
const clearRegistry = () => { for (const d of R.listServers()) R.deleteServer(d.id); };

const VC = 'apac:vc01';
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const abortErr = () => { const e = new Error('This operation was aborted'); e.name = 'AbortError'; return e; };

/** 가짜 Veeam REST — 경로별 응답. override(u, init) 가 Response 를 주면 그것을 쓴다. log 에 요청을 남긴다. */
function veeamFake({ jobs = { data: [] }, states = { data: [] }, bobj = { data: [] }, sessions = { data: [] }, tasks = () => ({ data: [] }),
  backups = { data: [] }, files = () => ({ data: [] }), rp = { data: [] }, override = null, log = [] } = {}) {
  return async (url, init = {}) => {
    const u = new URL(url);
    log.push({ path: u.pathname, search: u.search, method: init.method || 'GET', aborted: !!init.signal?.aborted });
    if (override) { const r = await override(u, init); if (r) return r; }
    if (init.signal?.aborted) throw abortErr();
    const p = u.pathname;
    if (p === '/api/oauth2/token') return json({ access_token: 'TKN', token_type: 'bearer' });
    if (p === '/api/oauth2/logout') return json({});
    if (p === '/api/v1/jobs') return json(jobs);
    if (p === '/api/v1/jobs/states') return json(states);
    if (p === '/api/v1/backupObjects') return json(bobj);
    if (p === '/api/v1/sessions') return json(sessions);
    let m = /^\/api\/v1\/sessions\/([^/]+)\/taskSessions$/.exec(p);
    if (m) return json(tasks(decodeURIComponent(m[1])));
    if (p === '/api/v1/restorePoints') return json(rp);
    if (p === '/api/v1/backups') return json(backups);
    m = /^\/api\/v1\/backups\/([^/]+)\/backupFiles$/.exec(p);
    if (m) { const f = files(decodeURIComponent(m[1])); return f instanceof Response ? f : json(f); }
    return json({ message: 'not found' }, 404);
  };
}
const SRV = { id: 'vbr-t', name: 'T', host: 'vbr-t.corp.local', port: 9419, username: 'svc', password: 'Pw-2761', apiVersion: '1.1-rev2' };
const BASIC_JOBS = { data: [{ id: 'j1', name: 'BJ', type: 'Backup', virtualMachines: { includes: [{ type: 'VirtualMachine', hostName: 'vc01.corp.local', name: 'web01', objectId: 'vm-101' }] } }] };

/* ═══════════════ A1 ═══════════════ */
test('A1: 복제·백업 복사 작업(상태 Running·실행 중 세션)은 백업 중·대기 배지를 만들지 않는다 · 백업 작업은 그대로', () => {
  assert.equal(P.isBackupSessionType('BackupJob'), true);
  assert.equal(P.isBackupSessionType(undefined), true, '유형이 없으면 받는다(작업 판정이 다시 거른다)');
  assert.equal(P.isBackupSessionType('BackupCopy'), false);
  assert.equal(P.isBackupSessionType('BackupCopyJob'), false);
  assert.equal(P.isBackupSessionType('ReplicaJob'), false);
  assert.equal(P.isBackupSessionType('ConfigurationBackup'), false);
  const r = P.buildServerResult({
    jobs: { data: [
      { id: 'RJ', name: 'RJ-DR', type: 'Replica', virtualMachines: { includes: [{ type: 'VirtualMachine', hostName: 'vc01.corp.local', name: 'db02', objectId: 'vm-2' }] } },
      { id: 'BCJ', name: 'BCJ-Offsite', type: 'BackupCopy', virtualMachines: { includes: [] } },
      { id: 'J1', name: 'BJ-Web', type: 'Backup', virtualMachines: { includes: [{ type: 'VirtualMachine', hostName: 'vc01.corp.local', name: 'web01', objectId: 'vm-1' }] } },
    ] },
    states: { data: [{ id: 'RJ', status: 'Running' }, { id: 'BCJ', status: 'Running' }, { id: 'J1', status: 'Running' }] },
    sessions: [{ session: { id: 's1', jobId: 'BCJ', state: 'Working' }, tasks: { data: [
      { name: 'db03', objectId: 'vm-3', state: 'Pending' }, { name: 'db04', objectId: 'vm-4', state: 'Working', progressPercent: 40 },
    ] } }],
  });
  const byM = Object.fromEntries(r.vms.map((v) => [v.m, v]));
  assert.equal(byM['vm-2'].run, 0, '복제 작업만 도는 VM 은 백업 중이 아니다');
  assert.equal(byM['vm-3'], undefined, '백업 복사 세션의 대기 task 는 항목을 만들지 않는다');
  assert.equal(byM['vm-4'], undefined, '백업 복사 세션의 진행 task 는 항목을 만들지 않는다');
  assert.equal(byM['vm-1'].run, 1, '백업 작업은 그대로 작업 단위 백업 중'); assert.equal(byM['vm-1'].by, 'job');
  assert.equal(r.counts.running, 1); assert.equal(r.counts.pending, 0);
  const m = P.matchToVcenter({ id: VC, host: 'vc01.corp.local' }, ['vm-1', 'vm-2', 'vm-3', 'vm-4'].map((x, i) => ({ id: `${VC}:${x}`, name: `n${i}` })), [{ server: { id: 'v', name: 'V' }, result: r }]);
  assert.deepEqual(Object.keys(m.byVm), [`${VC}:vm-1`], '복제·복사에만 걸린 VM 은 배지 없음');
});

test('A1: 수집기 — 실행 중 세션 필터가 끝난 세션 필터와 같은 판정(백업 복사 세션의 task 를 읽지 않는다)', async () => {
  const log = [];
  const r = await C.collectVeeamServer(SRV, { fetchImpl: veeamFake({ jobs: BASIC_JOBS, log,
    sessions: { data: [{ id: 'sc', jobId: 'jc', state: 'Working', sessionType: 'BackupCopy' }, { id: 'sb', jobId: 'j1', state: 'Working', sessionType: 'BackupJob' }] } }) });
  assert.equal(r.ok, true);
  const taskPaths = log.filter((x) => x.path.endsWith('/taskSessions')).map((x) => x.path);
  assert.ok(taskPaths.includes('/api/v1/sessions/sb/taskSessions'));
  assert.ok(!taskPaths.includes('/api/v1/sessions/sc/taskSessions'), '백업 복사 세션은 실행 중 백업 세션이 아니다');
});

/* ═══════════════ A2 ═══════════════ */
test('A2: 시한이 끊기면(soft 구간이 취소 오류를 삼켜도) 부분 결과를 ok:true 로 돌려주지 않는다 · logout 은 끊긴 signal 을 쓰지 않는다', async () => {
  const ac = new AbortController();
  const log = [];
  const fake = veeamFake({ jobs: BASIC_JOBS, log, override: (u) => {
    if (u.pathname === '/api/v1/restorePoints') { ac.abort(); throw abortErr(); }
    return null;
  } });
  await assert.rejects(C.collectVeeamServer(SRV, { signal: ac.signal, fetchImpl: fake }), /시한/);
  const lo = log.find((x) => x.path === '/api/oauth2/logout');
  assert.ok(lo, '시한이 끊긴 뒤에도 logout 을 시도한다');
  assert.equal(lo.aborted, false, 'logout 은 상위(끊긴) signal 이 아니라 자기 짧은 시한');
  // 시한 안에 끝나면 그대로 성공
  const ok = await C.collectVeeamServer(SRV, { signal: new AbortController().signal, fetchImpl: veeamFake({ jobs: BASIC_JOBS }) });
  assert.equal(ok.ok, true);
});

/* ═══════════════ A3 ═══════════════ */
test('A3: 로그인 성공 뒤 GET 의 401 은 인증 정지가 아니다(kind token · 부분 결과도 아님) · 로그인 401 은 그대로 정지', async () => {
  const mid401 = (path) => veeamFake({ jobs: BASIC_JOBS, override: (u) => (u.pathname === path ? new Response('', { status: 401 }) : null) });
  for (const p of ['/api/v1/jobs/states', '/api/v1/backupObjects', '/api/v1/restorePoints']) {
    await assert.rejects(C.collectVeeamServer(SRV, { fetchImpl: mid401(p) }), (e) => e.authFailed !== true && e.kind === 'token' && e.status === 401, `${p} 401`);
  }
  const d = { ...SRV, id: 'vbr-a3' };
  poller.authGuard.clearAuthStop(d.id);
  vbrHandler = mid401('/api/v1/jobs/states');
  try {
    const r1 = await poller.collectOne(d);
    assert.equal(r1.ok, false); assert.equal(r1.kind, 'token'); assert.equal(r1.authStop, null);
    assert.equal(poller.authGuard.peekAuthStop(d), null, '정지 기록이 생기지 않는다');
    vbrHandler = veeamFake({ jobs: BASIC_JOBS });
    const r2 = await poller.collectOne(d);
    assert.equal(r2.ok, true, '다음 주기는 다시 로그인해 읽는다');
    // 로그인 401 은 지금처럼 주기 수집을 멈춘다(계정 잠금 예방)
    vbrHandler = veeamFake({ override: (u) => (u.pathname === '/api/oauth2/token' ? new Response('', { status: 401 }) : null) });
    const r3 = await poller.collectOne(d);
    assert.equal(r3.kind, 'auth'); assert.ok(r3.authStop);
    assert.equal((await poller.collectOne(d)).kind, 'auth-stopped');
  } finally { vbrHandler = null; poller.authGuard.clearAuthStop(d.id); }
});

/* ═══════════════ A4 ═══════════════ */
test('A4: 서버가 limit 을 낮춰도 받은 개수로 넘기고 total 로 끝을 정한다 · total 보다 적게 끝나면 notes', async () => {
  const all = Array.from({ length: 1000 }, (_, i) => ({ id: `o${i}`, name: `vm${i}`, type: 'VM', platformName: 'VMware', objectId: `vm-${i + 1}`, restorePointsCount: 1 }));
  const paged = (list, total, cap = 200) => (u) => {
    if (u.pathname !== '/api/v1/backupObjects') return null;
    const skip = Number(u.searchParams.get('skip')); const lim = Math.min(cap, Number(u.searchParams.get('limit')));
    const items = list.slice(skip, skip + lim);
    return json({ data: items, pagination: { total, count: items.length, skip, limit: lim } });
  };
  const log = [];
  const r = await C.collectVeeamServer(SRV, { fetchImpl: veeamFake({ jobs: BASIC_JOBS, log, override: paged(all, 1000) }) });
  assert.equal(r.counts.backupObjects, 1000, '1000개 전부');
  assert.deepEqual(log.filter((x) => x.path === '/api/v1/backupObjects').map((x) => new URLSearchParams(x.search).get('skip')), ['0', '200', '400', '600', '800']);
  assert.ok(!r.notes.some((n) => /잘려/.test(n)));
  const r2 = await C.collectVeeamServer(SRV, { fetchImpl: veeamFake({ jobs: BASIC_JOBS, override: paged(all.slice(0, 600), 2000) }) });
  assert.equal(r2.counts.backupObjects, 600);
  assert.ok(r2.notes.some((n) => /백업 객체.*600개에서 잘려/.test(n)), r2.notes.join(' | '));
  // total 이 null 이면 모름 — 짧은 페이지가 끝(Number(null)===0 으로 첫 페이지에서 끝내지 않는다는 뜻이 아니라, 0 으로 읽지 않는다)
  const nullTotal = (u) => (u.pathname === '/api/v1/backupObjects' ? json({ data: all.slice(Number(u.searchParams.get('skip')), Number(u.searchParams.get('skip')) + 500), pagination: { total: null } }) : null);
  const r3 = await C.collectVeeamServer(SRV, { fetchImpl: veeamFake({ jobs: BASIC_JOBS, override: nullTotal }) });
  assert.equal(r3.counts.backupObjects, 1000, 'total 이 null 이면 짧은 페이지까지 읽는다');
});

/* ═══════════════ A6 ═══════════════ */
test('A6: 에이전트 이름이 IP 면 첫 옥텟으로 다른 VM 에 붙이지 않는다 · FQDN↔짧은 이름은 그대로', () => {
  const vms = [{ id: `${VC}:vm-11`, name: '10.1.5.7-legacy-app' }, { id: `${VC}:vm-12`, name: 'web01' }, { id: `${VC}:vm-13`, name: 'fe80::1-host' }];
  const res = { jobs: [], vms: [
    { n: '10.20.30.40', m: '', h: '', j: [], rp: 7, run: 0, pg: null, by: '', ag: 1 },
    { n: 'fe80::99', m: '', h: '', j: [], rp: 2, run: 0, pg: null, by: '', ag: 1 },
    { n: 'web01.corp.local', m: '', h: '', j: [], rp: 3, run: 0, pg: null, by: '', ag: 1 },
  ] };
  const m = P.matchToVcenter({ id: VC, host: 'vc01.corp.local' }, vms, [{ server: { id: 'v', name: 'V' }, result: res }]);
  assert.equal(m.byVm[`${VC}:vm-11`], undefined, "'10.20.30.40' 을 '10' 으로 잘라 붙이지 않는다");
  assert.equal(m.byVm[`${VC}:vm-13`], undefined, 'IPv6 도 자르지 않는다');
  assert.equal(m.byVm[`${VC}:vm-12`]?.rp, 3, 'FQDN 컴퓨터 이름 ↔ 짧은 VM 이름은 그대로 맞춘다');
});

/* ═══════════════ A7 ═══════════════ */
test('A7: 백업 1건의 파일 404 는 그 백업만 용량을 비운다 · 처음부터 연속 404 면 미지원', async () => {
  const backups = { data: Array.from({ length: 30 }, (_, i) => ({ id: `b${i}`, name: `B${i}`, jobId: 'j1' })) };
  const good = { data: [{ backupSize: 100, dataSize: 200, creationTime: '2026-10-22T00:00:00Z' }] };
  const r = await C.collectVeeamServer(SRV, { fetchImpl: veeamFake({ jobs: BASIC_JOBS, backups, files: (id) => (id === 'b0' ? json({ message: 'gone' }, 404) : good) }) });
  assert.equal(r.backups.filter((b) => b.bs != null).length, 29, '나머지 29개 용량은 그대로');
  assert.ok(!r.notes.some((n) => /주지 않아/.test(n)), '판 미지원이라 말하지 않는다');
  assert.ok(r.notes.some((n) => /백업 1개는 파일 목록을 받지 못해/.test(n)), r.notes.join(' | '));
  const log = [];
  const r2 = await C.collectVeeamServer(SRV, { fetchImpl: veeamFake({ jobs: BASIC_JOBS, backups, log, files: () => json({ message: 'no route' }, 404) }) });
  assert.ok(r2.notes.some((n) => /백업 파일 목록\(용량\)을 REST 로 주지 않아/.test(n)));
  assert.ok(log.filter((x) => x.path.endsWith('/backupFiles')).length < 10, '미지원으로 정한 뒤로는 묻지 않는다');
});

/* ═══════════════ A8 ═══════════════ */
test('A8: 마지막 백업 = 성공 task 끝 시각과 최신 복원 지점 중 더 늦은 쪽(src 는 이긴 쪽)', () => {
  const T1 = Date.parse('2026-10-21T01:00:00Z'); const T2 = Date.parse('2026-10-22T01:10:00Z');
  assert.deepEqual(P.lastBackupOf({ lt: { r: 'Success', e: T1 }, rl: [T2, T1 - 1000] }), { t: T2, src: 'rp' });
  assert.deepEqual(P.lastBackupOf({ lt: { r: 'Warning', e: T2 }, rl: [T1] }), { t: T2, src: 'task' });
  assert.deepEqual(P.lastBackupOf({ lt: { r: 'Failed', e: T2 }, rl: [T1] }), { t: T1, src: 'rp' }, '실패 task 는 후보가 아니다');
  assert.deepEqual(P.lastBackupOf({ lt: { r: 'Success', e: T1 } }), { t: T1, src: 'task' });
  assert.equal(P.lastBackupOf({ rl: [] }), null);
});

/* ═══════════════ B6 ═══════════════ */
test('B6: 엣지 이름이 바뀌면 옛 이름으로 받은 서버(비밀번호 포함)도 교체 대상 · 이 노드가 직접 등록한 남의 몫은 남는다', () => {
  clearRegistry(); resetAgent();
  try {
    const local = R.saveServer({ name: 'Local', host: 'vbr-local.corp', username: 'svc', password: 'pw-l', vcenterIds: [VC], agent: 'edge-z' });
    config.agent.name = 'edge-a';
    const a = R.applyPulledServers([{ id: 'vbr-old1', name: 'Old', host: 'vbr-old1.corp', port: 9419, username: 'svc', password: 'TopSecret!9', agent: 'edge-a', vcenterIds: [VC] }]);
    assert.equal(a.count, 1);
    config.agent.name = 'edge-a2';
    const b = R.applyPulledServers([]);
    assert.deepEqual(b.removed, ['vbr-old1'], '옛 이름으로 받은 원소도 removed(호출부가 결과를 지운다)');
    assert.equal(R.getServerWithSecret('vbr-old1'), null, '봉인된 비밀번호가 남지 않는다');
    assert.ok(R.getServerWithSecret(local.id), 'pulled 아닌 남의 몫은 남는다');
  } finally { resetAgent(); clearRegistry(); }
});

/* ═══════════════ 관리 라우트(B3·B4·D6) ═══════════════ */
let base = '';
before(async () => {
  const express = (await import('express')).default;
  const { registerVeeam } = await import('../src/routes/admin/veeam.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin' }; next(); });
  const r = express.Router(); registerVeeam(r); app.use('/api/admin', r);
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  closers.push(() => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(() => ok()); }));
  base = `http://127.0.0.1:${srv.address().port}/api/admin/veeam/servers`;
});
const post = async (p, body = {}) => { const res = await realFetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
const okResult = (ts = Date.now()) => ({ ok: true, ts, jobs: [{ id: 'j', name: 'J' }], vms: [{ n: 'old-vm', m: 'vm-777', h: '', j: [0], rp: 3, run: 0, pg: null, by: '' }], counts: {}, notes: [] });

test('D6: 지금 읽기 응답 — ok 는 boolean · okCount/failCount · 꺼진 서버는 disabled(시도하지 않는다) · 실패 사유', async () => {
  clearRegistry(); resetAgent();
  const on = R.saveServer({ name: 'On', host: 'vbr-d6.corp', username: 'svc', password: 'pw', vcenterIds: [VC] });
  const off = R.saveServer({ name: 'Off', host: 'vbr-d6off.corp', username: 'svc', password: 'pw', vcenterIds: [VC], enabled: false });
  try {
    let hit = 0;
    vbrHandler = (url, init) => { hit++; return veeamFake({ jobs: BASIC_JOBS })(url, init); };
    const a = await post(`/${off.id}/collect`);
    assert.equal(a.body.ok, false); assert.equal(a.body.disabled, true); assert.ok(a.body.reason);
    assert.equal(hit, 0, '꺼진 서버는 접속하지 않는다');
    const b = await post(`/${on.id}/collect`);
    assert.equal(b.body.ok, true, JSON.stringify(b.body)); assert.equal(b.body.okCount, 1); assert.equal(b.body.failCount, 0);
    assert.equal(b.body.status.ok, true);
    vbrHandler = veeamFake({ override: (u) => (u.pathname === '/api/oauth2/token' ? new Response('down', { status: 503 }) : null) });
    const c = await post(`/${on.id}/collect`);
    assert.equal(c.body.ok, false); assert.equal(c.body.okCount, 0); assert.equal(c.body.failCount, 1);
    assert.match(c.body.reason, /503/);
  } finally { vbrHandler = null; clearRegistry(); }
});

test('B3: 엣지 노드는 받은 자기 몫의 지금 읽기·연결 시험을 한다(수동 실행이 인증 정지를 푼다) · 중앙은 정지 상태를 사실대로 거절', async () => {
  clearRegistry(); resetAgent();
  try {
    config.agent.centralUrl = 'http://127.0.0.1:9'; config.agent.name = 'edge-a';
    R.applyPulledServers([{ id: 'vbr-e1', name: 'E1', host: 'vbr-e1.corp.local', port: 9419, username: 'svc', password: 'pw-e', agent: 'edge-a', vcenterIds: [VC] }]);
    const full = R.getServerWithSecret('vbr-e1');
    poller.authGuard.markAuthStopped('vbr-e1', full, '인증 실패(401)');
    vbrHandler = veeamFake({ jobs: BASIC_JOBS });
    const t = await post('/vbr-e1/test');
    assert.equal(t.body.ok, true, JSON.stringify(t.body)); assert.equal(t.body.edge, undefined);
    const c = await post('/vbr-e1/collect');
    assert.equal(c.body.edge, undefined, JSON.stringify(c.body)); assert.equal(c.body.ok, true);
    assert.equal(poller.authGuard.peekAuthStop(full), null, '수동 실행 성공이 정지를 풀었다');
    // 중앙: 엣지 담당 서버는 읽지 않는다 — 그 엣지가 정지 중이면 '다음 주기에 반영' 이라 말하지 않는다
    resetAgent(); clearRegistry();
    const d = R.saveServer({ name: 'EB', host: 'vbr-eb.corp', username: 'svc', password: 'pw', vcenterIds: [VC], agent: 'edge-b' });
    ST.putResult(d.id, { ok: false, ts: Date.now(), kind: 'auth-stopped', error: '인증 실패로 주기 수집을 멈췄습니다', authStop: { since: 1, attempts: 1, reason: 'x' }, jobs: [], vms: [], counts: {}, notes: [] }, { via: 'edge', agent: 'edge-b' });
    const r1 = await post(`/${d.id}/collect`);
    assert.equal(r1.body.edge, true);
    assert.match(r1.body.reason, /멈춰/); assert.doesNotMatch(r1.body.reason, /다음 수집 주기에 반영/);
    const r2 = await post(`/${d.id}/test`);
    assert.equal(r2.body.edge, true); assert.match(r2.body.reason, /멈춰/);
    ST.putResult(d.id, okResult(), { via: 'edge', agent: 'edge-b' });
    const r3 = await post(`/${d.id}/collect`);
    assert.equal(r3.body.edge, true); assert.match(r3.body.reason, /엣지 포탈/);
  } finally { vbrHandler = null; resetAgent(); clearRegistry(); ST.dropResult('vbr-e1'); poller.authGuard.clearAuthStop('vbr-e1'); }
});

test('B4: 접속처가 바뀌면 옛 결과(lastOk)와 인증 정지를 지운다 — 단건 저장 · 대량 가져오기 · 바뀌지 않으면 둔다', async () => {
  clearRegistry(); resetAgent();
  const { store } = await import('../src/store.js');
  const prevSnap = store.snapshot;
  store.snapshot = { source: 'live', vcenters: [{ id: VC, name: 'vc01' }], vms: [], hosts: [] };
  try {
    const d = R.saveServer({ name: 'M', host: 'vbr-m-old.corp', username: 'svc', password: 'pw-m', vcenterIds: [VC] });
    const oldFull = { ...R.getServerWithSecret(d.id) };
    ST.putResult(d.id, okResult());
    poller.authGuard.markAuthStopped(d.id, oldFull, '인증 실패(401)');
    const same = await post('', { id: d.id, name: 'M2', host: 'vbr-m-old.corp', username: 'svc', vcenterIds: [VC] });
    assert.equal(same.status, 201, JSON.stringify(same.body));
    assert.ok(ST.getRecord(d.id), '접속처가 그대로면 결과를 둔다');
    assert.ok(poller.authGuard.peekAuthStop(oldFull), '접속처가 그대로면 정지도 둔다');
    const mv = await post('', { id: d.id, name: 'M2', host: 'vbr-m-new.corp', username: 'svc', vcenterIds: [VC] });
    assert.equal(mv.status, 201, JSON.stringify(mv.body));
    assert.equal(ST.getRecord(d.id), null, '옛 접속처의 VM 표가 새 서버의 마지막 성공으로 쓰이지 않는다');
    assert.equal(poller.authGuard.peekAuthStop(oldFull), null, '옛 접속처의 인증 정지를 지운다');
    // 대량 가져오기 — 같은 host:port 의 계정 변경(=접속처 변경)
    const b = R.saveServer({ name: 'BK', host: 'vbr-bk.corp', username: 'svc', password: 'pw-b', vcenterIds: [VC] });
    ST.putResult(b.id, okResult());
    const text = ['name host port username vcenters agent apiVersion enabled note password', 'BK vbr-bk.corp - svc2 vc01 중앙 - true - NewPw!2'].join('\n');
    const dry = await post('/import', { text, format: 'text', dryRun: true });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    const done = await post('/import', { text, format: 'text', selectLines: dry.body.report.filter((x) => x.action !== 'error').map((x) => x.line) });
    assert.equal(done.body.updated, 1, JSON.stringify(done.body));
    assert.equal(ST.getRecord(b.id), null, '대량 가져오기도 옛 결과를 지운다');
  } finally { store.snapshot = prevSnap; clearRegistry(); }
});

test('B4: 엣지 pull — 같은 id 의 접속처가 바뀌면 옛 결과·인증 정지를 지운다(실제 pullVeeamConfigNow)', async () => {
  clearRegistry(); resetAgent();
  let servers = [];
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, servers })); });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  closers.push(() => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(() => ok()); }));
  const quiet = console.log; console.log = () => {};
  const quietW = console.warn; console.warn = () => {};
  try {
    config.agent.centralUrl = `http://127.0.0.1:${srv.address().port}`; config.agent.centralToken = 'tok-2761'; config.agent.name = 'edge-p';
    vbrHandler = veeamFake({ override: (u) => (u.pathname === '/api/oauth2/token' ? new Response('down', { status: 503 }) : null) });
    const S = { id: 'vbr-p1', name: 'P1', host: 'vbr-p-old.corp.local', port: 9419, username: 'svc', password: 'pw-p', agent: 'edge-p', vcenterIds: [VC] };
    const { pullVeeamConfigNow } = await import('../src/agent/veeamConfigPull.js');
    servers = [S];
    assert.equal((await pullVeeamConfigNow()).ok, true);
    await (poller._runningForTest() || Promise.resolve());
    const oldFull = { ...R.getServerWithSecret(S.id) };
    ST.putResult(S.id, okResult());
    poller.authGuard.markAuthStopped(S.id, oldFull, '인증 실패(401)');
    servers = [{ ...S, host: 'vbr-p-new.corp.local' }];
    assert.equal((await pullVeeamConfigNow()).ok, true);
    await (poller._runningForTest() || Promise.resolve());
    assert.equal(poller.authGuard.peekAuthStop(oldFull), null, '옛 접속처의 인증 정지를 지운다');
    const rec = ST.getRecord(S.id);
    assert.ok(!rec?.lastOk, '옛 접속처의 VM 표(lastOk)를 새 서버 결과로 승계하지 않는다');
  } finally { console.log = quiet; console.warn = quietW; vbrHandler = null; resetAgent(); clearRegistry(); ST.dropResult('vbr-p1'); poller.authGuard.clearAuthStop('vbr-p1'); }
});
