/**
 * test/veeam2751.test.js — v2.751 Veeam 백업 VM 표시(vCenter › VM 및 폴더 'Veeam 백업 VM 표시') 회귀.
 *
 *  · parse     : 작업 includes(감싼·안 감싼 모양) · 백업 객체 · 실행 중 task · task 를 못 읽으면 작업 단위 · 컨테이너는 펼치지 않고 센다.
 *  · 대조       : moref 우선 · 이름은 vCenter 안에서 하나뿐일 때만 · Veeam 이 적은 vCenter 가 다르면 버리고 센다.
 *  · 정제       : 엣지 결과는 아는 필드만·상한·미래 시각 자르기·작업 인덱스 범위 밖 버림 · 배정되지 않은 서버 거절.
 *  · 등록부     : 응답에 비밀번호 없음 · 접속처가 바뀌면 저장 비밀번호를 승계하지 않음 · 루프백·링크로컬 차단.
 *  · 수집기     : 토큰 요청에도 x-api-version · 401 은 authFailed(주기 정지) · 리다이렉트 거부 · 오류 문구에 비밀번호 없음.
 *  · 엣지 진입  : 실제 pullVeeamConfigNow · pushVeeamNow → 실제 centralRouter(veeam-config·veeam-data).
 *  · 배지 라우트 : 범위 밖 vCenter 404 · 등록 없음 configured:false.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'veeam2751-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.CENTRAL_TOKEN = 'ctok-2751';
delete process.env.CENTRAL_URL;
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const P = await import('../src/veeam/parse.js');
const R = await import('../src/veeam/registry.js');
const ST = await import('../src/veeam/store.js');
const { config } = await import('../src/config.js');

const VC = 'apac:vc01';
const JOBS = {
  data: [
    { id: 'j1', name: 'BJ-Web', type: 'Backup', isDisabled: false, virtualMachines: { includes: [
      { inventoryObject: { type: 'VirtualMachine', hostName: 'vc01.corp.local', name: 'web01', objectId: 'vm-101' }, size: '10 GB' },
      { inventoryObject: { type: 'Folder', hostName: 'vc01.corp.local', name: 'DB', objectId: 'group-v9' } },
    ] } },
    { id: 'j2', name: 'BJ-App', type: 'Backup', virtualMachines: { includes: [
      { type: 'VirtualMachine', hostName: 'vc01', name: 'app01', objectId: 'vm-201' },
      { type: 'VirtualMachine', hostName: 'vc01', name: 'app02', objectId: 'vm-202' },
    ] } },
  ],
  pagination: { total: 2, count: 2, skip: 0, limit: 500 },
};
const STATES = { data: [{ id: 'j1', status: 'Inactive', lastResult: 'Success', lastRun: '2026-10-21T15:00:00Z' }, { id: 'j2', status: 'Running', lastResult: 'Warning', lastRun: '2026-10-22T01:00:00Z' }] };
const BOBJ = { data: [
  { id: 'b1', name: 'db01', type: 'VM', platformName: 'VMware', objectId: 'vm-301', path: 'vc01.corp.local\\DC\\db01', restorePointsCount: 14 },
  { id: 'b2', name: 'linux-phys', type: 'Computer', platformName: 'Linux' },
  { id: 'b3', name: 'other', type: 'VM', platformName: 'VMware', objectId: 'vm-101', path: 'vc99.corp.local\\DC\\other', restorePointsCount: 3 },
] };

test('parse: 작업 includes 두 모양 · 백업 객체 · 컨테이너는 세기만 · 실행 중 작업의 task', () => {
  const r = P.buildServerResult({
    jobs: JOBS, states: STATES, backupObjects: BOBJ,
    sessions: [{ session: { id: 's1', jobId: 'j2', state: 'Working', sessionType: 'BackupJob' }, tasks: { data: [
      { name: 'app01', objectId: 'vm-201', state: 'Working', progress: { progressPercent: 42.4 } },
      { name: 'app02', objectId: 'vm-202', state: 'Pending' },
      { name: 'done', objectId: 'vm-999', state: 'Stopped' },
    ] } }],
  });
  assert.equal(r.jobs.length, 2);
  assert.equal(r.counts.containers, 1, '폴더 포함은 펼치지 않고 센다');
  assert.ok(r.notes.some((n) => /컨테이너 1개/.test(n)));
  const by = Object.fromEntries(r.vms.map((v) => [v.n, v]));
  assert.equal(by.web01.m, 'vm-101');
  assert.deepEqual(by.web01.j, [0]);
  assert.equal(by.web01.run, 0, '실행 중이 아닌 작업');
  assert.equal(by.app01.run, 1); assert.equal(by.app01.pg, 42); assert.equal(by.app01.by, 'task');
  assert.equal(by.app02.run, 2, 'Pending = 대기');
  assert.equal(by.db01.rp, 14, '백업 객체의 복원 지점');
  assert.equal(by.db01.h, 'vc01.corp.local', 'path 첫 마디가 vCenter');
  assert.ok(!by['linux-phys'], 'VMware 가 아닌 객체는 버린다');
  assert.ok(!by.done, '끝난 task 는 백업 중이 아니다');
  assert.equal(r.jobs[1].lastRun, Date.parse('2026-10-22T01:00:00Z'));
  assert.equal(r.jobs[1].running, true);
});

test('parse: 실행 중 작업의 task 를 못 읽으면 작업에 VM 단위로 든 VM 을 작업 단위 \'백업 중\' 으로 둔다', () => {
  const r = P.buildServerResult({ jobs: JOBS, states: STATES, sessions: [{ session: { id: 's1', jobId: 'j2', state: 'Working' }, tasks: null, tasksError: 'HTTP 404' }] });
  const by = Object.fromEntries(r.vms.map((v) => [v.n, v]));
  assert.equal(by.app01.run, 1); assert.equal(by.app01.by, 'job');
  assert.equal(by.app02.run, 1);
  assert.equal(by.web01.run, 0, '다른 작업의 VM 은 아니다');
  // 세션 목록을 못 받아도 작업 상태가 Running 이면 작업 단위로 둔다.
  const r2 = P.buildServerResult({ jobs: JOBS, states: STATES });
  assert.equal(r2.vms.find((v) => v.n === 'app01').run, 1);
});

test('parse: 모르는 모양은 버린다(지어내지 않는다) · moref 형태가 아니면 moref 로 쓰지 않는다', () => {
  const r = P.buildServerResult({ jobs: { data: [null, 'x', { id: 'j', name: 'J', virtualMachines: { includes: [{ type: 'VirtualMachine', name: 'v', objectId: '5012-abcd' }, 7] } }] } });
  assert.equal(r.vms.length, 1);
  assert.equal(r.vms[0].m, '', 'GUID 는 moref 가 아니다');
  assert.equal(P.buildServerResult({}).vms.length, 0);
});

test('대조: moref 우선 · 다른 vCenter 의 VM 은 버리고 센다 · 이름은 하나뿐일 때만', () => {
  const res = P.buildServerResult({ jobs: JOBS, states: STATES, backupObjects: BOBJ });
  const vms = [
    { id: `${VC}:vm-101`, name: 'web01' }, { id: `${VC}:vm-201`, name: 'app01' }, { id: `${VC}:vm-202`, name: 'app02' },
    { id: `${VC}:vm-301`, name: 'db01' }, { id: 'other:vm-101', name: 'web01' },
  ];
  const m = P.matchToVcenter({ id: VC, host: 'https://VC01.corp.local:443/sdk' }, vms, [{ server: { id: 'v1', name: 'VBR-A' }, result: res }]);
  assert.deepEqual(Object.keys(m.byVm).sort(), [`${VC}:vm-101`, `${VC}:vm-201`, `${VC}:vm-202`, `${VC}:vm-301`].sort());
  assert.deepEqual(m.byVm[`${VC}:vm-101`].jobs, ['BJ-Web']);
  assert.equal(m.byVm[`${VC}:vm-201`].run, 1, '작업 상태 Running → 작업 단위 백업 중');
  assert.equal(m.byVm[`${VC}:vm-201`].lastResult, 'Warning');
  assert.equal(m.byVm[`${VC}:vm-301`].rp, 14);
  assert.equal(m.otherVcenter, 1, 'vc99 의 vm-101 은 이 vCenter 의 vm-101 이 아니다(moref 는 vCenter 마다 겹친다)');
  // 짧은 이름(vc01)으로 등록된 Veeam 도 같은 vCenter 로 본다.
  assert.equal(P.sameHost('vc01', 'https://vc01.corp.local'), true);
  assert.equal(P.sameHost('vc02.corp.local', 'vc01.corp.local'), false);
  // 이름 대조 — 동명 VM 이 둘이면 고르지 않는다.
  const byName = P.matchToVcenter({ id: VC, host: '' }, [{ id: `${VC}:vm-1`, name: 'dup' }, { id: `${VC}:vm-2`, name: 'DUP' }, { id: `${VC}:vm-3`, name: 'solo' }],
    [{ server: { id: 'v', name: 'V' }, result: { jobs: [], vms: [{ n: 'dup', m: '', h: '', j: [], rp: 1, run: 0 }, { n: 'Solo', m: '', h: '', j: [], rp: 2, run: 0 }, { n: 'gone', m: '', h: '', j: [], rp: 1, run: 0 }] } }]);
  assert.equal(byName.ambiguous, 1);
  assert.equal(byName.unmatched, 1);
  assert.deepEqual(Object.keys(byName.byVm), [`${VC}:vm-3`]);
});

test('정제: 아는 필드만 · 미래 시각은 수신 시각으로 · 범위 밖 작업 인덱스·moref 아닌 값은 버린다', () => {
  const now = 1_800_000_000_000;
  const r = P.sanitizeServerResult({
    ok: true, ts: now + 3_600_000, evil: 'x', apiVersion: '1.1-rev0',
    jobs: [{ id: 'j1', name: 'A', lastRun: '123', extra: 1 }],
    vms: [{ n: 'a', m: 'vm-1', j: [0, 5, -1, 'x'], run: 1, pg: 250 }, { n: '', m: 'not-moref' }, 'junk', { n: 'b', m: 'vm-2', h: 'h\nx', run: 9, rp: '3' }],
    notes: ['ok', 5],
  }, now);
  assert.equal(r.ts, now); assert.equal(r.edgeTs, now + 3_600_000);
  assert.equal(r.evil, undefined);
  assert.equal(r.jobs[0].lastRun, 123); assert.equal(r.jobs[0].extra, undefined);
  assert.equal(r.vms.length, 2);
  assert.deepEqual(r.vms[0].j, [0]); assert.equal(r.vms[0].pg, 100);
  assert.equal(r.vms[1].run, 0); assert.equal(r.vms[1].rp, 3); assert.equal(r.vms[1].h, 'h x');
  assert.deepEqual(r.notes, ['ok']);
  assert.equal(P.sanitizeServerResult({ ok: true }), null, 'ts 없으면 버린다');
});

test('등록부: 응답에 비밀번호 없음 · 접속처가 바뀌면 비밀번호를 승계하지 않음 · 루프백·링크로컬 차단 · vCenter 필수', () => {
  R._resetForTest();
  const d = R.saveServer({ name: 'VBR-A', host: 'vbr-a.corp.local', username: 'svc', password: 'PW-secret-1', vcenterIds: [VC], agent: 'edge-a' });
  assert.equal(d.password, undefined); assert.equal(d.hasPassword, true);
  assert.equal(d.port, 9419); assert.equal(d.apiVersion, '1.1-rev0');
  assert.ok(!JSON.stringify(R.listServers()).includes('PW-secret-1'));
  // 같은 접속처 + 빈 비밀번호 = 기존 유지
  R.saveServer({ id: d.id, name: 'VBR-A2', host: 'vbr-a.corp.local', username: 'svc', password: '', vcenterIds: [VC], agent: 'edge-b' });
  assert.equal(R.getServerWithSecret(d.id).password, 'PW-secret-1', 'agent 변경은 승계한다');
  // host 변경 + 빈 비밀번호 = 버린다
  const moved = R.saveServer({ id: d.id, name: 'VBR-A2', host: 'attacker.example', username: 'svc', password: '', vcenterIds: [VC], agent: 'edge-a' });
  assert.deepEqual(moved.droppedSecrets, ['password']);
  assert.equal(R.getServerWithSecret(d.id).password, undefined);
  assert.throws(() => R.saveServer({ name: 'x', host: '127.0.0.1', username: 'u', password: 'p', vcenterIds: [VC] }), /차단/);
  assert.throws(() => R.saveServer({ name: 'x', host: '169.254.169.254', username: 'u', password: 'p', vcenterIds: [VC] }), /차단/);
  assert.throws(() => R.saveServer({ name: 'x', host: 'ok.corp', username: 'u', password: 'p', vcenterIds: [] }), /vCenter/);
  assert.throws(() => R.saveServer({ name: 'x', host: 'ok.corp', username: 'u', password: 'a\nb', vcenterIds: [VC] }), /제어문자/);
  assert.throws(() => R.saveServer({ name: 'x', host: 'ok.corp', username: 'u', password: 'p', vcenterIds: [VC], apiVersion: '1.1; rm' }), /API 판/);
  // 파일은 0600 이고 비밀은 봉인 규약(평문 모드면 평문 — secretVault 정책)으로 쓰인다.
  const st = fs.statSync(path.join(DIR, 'veeam-servers.json'));
  assert.equal(st.mode & 0o777, 0o600);
  R.deleteServer(d.id);
});

test('수집기: 토큰 요청에도 x-api-version · 401 은 authFailed · 리다이렉트 거부 · 오류에 비밀번호 없음 · task 404 는 작업 단위', async () => {
  const { collectVeeamServer, testVeeamServer } = await import('../src/veeam/client.js');
  const srv = { id: 'v', name: 'V', host: 'vbr.corp.local', port: 9419, username: 'svc', password: 'Pw-Leak-Check', apiVersion: '1.1-rev2' };
  const calls = [];
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const ok = async (url, init) => {
    calls.push({ url, method: init.method, ver: init.headers['x-api-version'], auth: init.headers.Authorization || '' });
    const u = new URL(url);
    if (u.pathname === '/api/oauth2/token') { assert.match(String(init.body), /grant_type=password/); return json({ access_token: 'TKN', token_type: 'bearer' }); }
    if (u.pathname === '/api/oauth2/logout') return json({});
    if (u.pathname === '/api/v1/jobs') return json(JOBS);
    if (u.pathname === '/api/v1/jobs/states') return json(STATES);
    if (u.pathname === '/api/v1/backupObjects') return json(BOBJ);
    if (u.pathname === '/api/v1/sessions') return json({ data: [{ id: 's1', jobId: 'j2', state: 'Working', sessionType: 'BackupJob' }, { id: 's0', jobId: 'j1', state: 'Stopped' }] });
    if (u.pathname.endsWith('/taskSessions')) return json({ message: 'not found' }, 404);
    return json({}, 404);
  };
  const r = await collectVeeamServer(srv, { fetchImpl: ok });
  assert.equal(r.ok, true);
  assert.ok(calls.every((c) => c.ver === '1.1-rev2'), '모든 요청(토큰 포함)에 x-api-version');
  assert.equal(calls[0].auth, '', '토큰 요청에는 Bearer 가 없다');
  assert.ok(calls.slice(1).every((c) => c.auth === 'Bearer TKN'));
  assert.equal(calls.filter((c) => c.method !== 'GET' && !/oauth2/.test(c.url)).length, 0, '조회 전용 — oauth2 밖 POST 없음');
  assert.ok(calls.some((c) => /oauth2\/logout/.test(c.url)), '세션을 닫는다');
  assert.equal(r.vms.find((v) => v.n === 'app01').by, 'job', 'task 404 → 작업 단위');
  assert.ok(r.notes.some((n) => /작업 단위/.test(n)));
  // 401 → authFailed, 비밀번호가 문구에 없다
  await assert.rejects(collectVeeamServer(srv, { fetchImpl: async () => json({ message: 'bad Pw-Leak-Check' }, 401) }), (e) => e.authFailed === true && !e.message.includes('Pw-Leak-Check'));
  // 400 invalid_grant 도 인증 실패(주기 정지 대상) · 본문 되울림 비밀번호 가림
  await assert.rejects(collectVeeamServer(srv, { fetchImpl: async () => json({ error: 'invalid_grant', error_description: 'wrong password Pw-Leak-Check' }, 400) }), (e) => e.authFailed === true && !e.message.includes('Pw-Leak-Check'));
  // 리다이렉트는 따라가지 않는다(토큰을 다른 주소로 보내지 않는다)
  await assert.rejects(collectVeeamServer(srv, { fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://evil.example/' } }) }), /리다이렉트|redirect|3\d\d/i);
  const t = await testVeeamServer(srv, { fetchImpl: ok });
  assert.equal(t.ok, true); assert.equal(t.jobs, 2);
});

test('폴러: 401 이면 주기 수집을 멈추고(정지 기록) 수동 실행은 막지 않는다 · 자격증명이 바뀌면 재개', async () => {
  const poller = await import('../src/veeam/poller.js');
  const d = { id: 'vbr-x', name: 'X', host: 'vbr-x.corp', port: 9419, username: 'u', password: 'p1', vcenterIds: [VC] };
  poller.authGuard.markAuthStopped(d.id, d, '인증 실패(401)');
  const r = await poller.collectOne(d);
  assert.equal(r.kind, 'auth-stopped'); assert.equal(r.ok, false);
  assert.ok(r.authStop && r.authStop.attempts >= 1);
  assert.equal(poller.authGuard.authStopFor({ ...d, password: 'p2' }), null, '비밀번호가 바뀌면 자동 재개');
});

/* ═══════════════ 엣지 진입 — 실제 pull·push → 실제 centralRouter ═══════════════ */
let port = 0;
before(async () => {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use('/api/central', centralRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  port = srv.address().port;
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }));
});

test('엣지 pull → 배정 서버(자격증명 포함)를 받아 로컬 등록부에 반영 · push → 중앙이 배정된 서버만 적재', async () => {
  R._resetForTest(); ST._resetForTest();
  const mine = R.saveServer({ name: 'VBR-E', host: 'vbr-e.corp.local', username: 'svc', password: 'pw-e', vcenterIds: [VC], agent: 'edge-a' });
  const other = R.saveServer({ name: 'VBR-O', host: 'vbr-o.corp.local', username: 'svc', password: 'pw-o', vcenterIds: [VC], agent: 'edge-b' });
  const keep = { ...config.agent };
  const quiet = console.log; console.log = () => {};
  try {
    config.agent.centralUrl = `http://127.0.0.1:${port}`;
    config.agent.centralToken = 'ctok-2751';
    config.agent.name = 'edge-a';
    const { pullVeeamConfigNow } = await import('../src/agent/veeamConfigPull.js');
    const pr = await pullVeeamConfigNow();
    assert.equal(pr.ok, true, pr.reason); assert.equal(pr.count, 1);
    const local = R.serversForThisNode();
    assert.deepEqual(local.map((x) => x.id), [mine.id]);
    assert.equal(local[0].password, 'pw-e'); assert.equal(local[0].pulled, true);
    // 엣지 결과(내 것 + 남의 것 하나를 끼워 넣는다)
    ST.putResult(mine.id, { ok: true, ts: Date.now(), jobs: [{ id: 'j', name: 'J' }], vms: [{ n: 'web01', m: 'vm-101', h: '', j: [0], rp: 2, run: 1, pg: 10, by: 'task' }], counts: {}, notes: [] });
    ST.putResult(other.id, { ok: true, ts: Date.now(), jobs: [], vms: [], counts: {}, notes: [] });
    const push = await import('../src/veeam/push.js');
    const body = push.buildPushBody();
    assert.deepEqual(body.results.map((x) => x.serverId), [mine.id], '이 엣지 몫만 싣는다');
    const r = await push.pushVeeamNow();
    assert.equal(r.ok, true, r.reason); assert.equal(r.sent, 1);
    assert.equal(ST.getRecord(mine.id).via, 'edge');
    // 남의 서버 id 를 직접 보내면 거절한다
    const res = await fetch(`http://127.0.0.1:${port}/api/central/veeam-data?agent=edge-a`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': 'ctok-2751', 'X-Agent-Name': 'edge-a' },
      body: JSON.stringify({ agent: 'edge-a', results: [{ serverId: other.id, ok: true, ts: Date.now(), vms: [] }] }) });
    const j = await res.json();
    assert.equal(j.saved, 0); assert.equal(j.dropped.notOwned, 1);
    // 결과 0건이어도 상태는 받는다
    const res0 = await fetch(`http://127.0.0.1:${port}/api/central/veeam-data?agent=edge-a`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': 'ctok-2751', 'X-Agent-Name': 'edge-a' },
      body: JSON.stringify({ agent: 'edge-a', status: { servers: 0 }, results: [] }) });
    assert.equal(res0.status, 200);
    const { veeamEdgeStatus } = await import('../src/central/veeamEdge.js');
    assert.equal(veeamEdgeStatus('edge-a').status.servers, 0);
  } finally { console.log = quiet; Object.assign(config.agent, keep); }
});

test('배지 라우트: 범위 밖 vCenter 404 · 등록 없음 configured:false · 등록 있음은 대조 결과', async () => {
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { registerVeeamBadges } = await import('../src/routes/api/veeam.js');
  const prev = store.snapshot;
  store.snapshot = { source: 'live', vcenters: [{ id: VC, name: 'vc01' }, { id: 'eu:vc02', name: 'vc02' }],
    vms: [{ id: `${VC}:vm-101`, vcenterId: VC, name: 'web01' }, { id: 'eu:vc02:vm-5', vcenterId: 'eu:vc02', name: 'x' }], hosts: [] };
  const app = express();
  let user = { username: 'u', role: 'viewer', scope: { vcenters: [VC] } };
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); registerVeeamBadges(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const get = async (q) => { const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/veeam/badges?vcenterId=${encodeURIComponent(q)}`); return { status: res.status, body: await res.json() }; };
  try {
    assert.equal((await get('eu:vc02')).status, 404, '범위 밖은 404(존재 은닉)');
    assert.equal((await get('nope')).status, 404);
    const r = await get(VC);
    assert.equal(r.status, 200);
    // 앞 테스트가 이 vCenter 에 서버(VBR-E)를 등록하고 결과를 적재했다 — vm-101 이 '백업 중'.
    assert.equal(r.body.configured, true);
    assert.equal(r.body.byVm[`${VC}:vm-101`].run, 1);
    assert.ok(!JSON.stringify(r.body).includes('vbr-e.corp.local'), '배지 응답에 Veeam 주소를 싣지 않는다');
    user = { username: 'v', role: 'viewer' };
    for (const d of R.listServers()) R.deleteServer(d.id);
    const r2 = await get('eu:vc02');
    assert.equal(r2.body.configured, false);
  } finally { store.snapshot = prev; }
});
