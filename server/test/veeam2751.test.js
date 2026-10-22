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

test('검토 #1·#2: moref 가 있으면 이름으로 대신 맞추지 않고, vCenter 를 모르는 moref 는 이름까지 같아야 한다', () => {
  const vms = [{ id: `${VC}:vm-900`, name: 'app01' }, { id: `${VC}:vm-50`, name: 'db01' }];
  const res = { jobs: [], vms: [
    { n: 'app01', m: 'vm-100', h: 'vc01.corp.local', j: [], rp: 14, run: 0 },   // 지운 VM 의 복원 지점 — 같은 이름의 새 VM 에 붙으면 안 된다
    { n: 'web77', m: 'vm-50', h: '', j: [], rp: null, run: 1 },                  // vCenter 를 모르는 task — 다른 vCenter 의 vm-50
  ] };
  const m = P.matchToVcenter({ id: VC, host: 'vc01.corp.local' }, vms, [{ server: { id: 's', name: 'S' }, result: res }]);
  assert.deepEqual(m.byVm, {}, JSON.stringify(m.byVm));
  assert.equal(m.unmatched, 2);
  // 같은 이름이면 vCenter 를 몰라도 인정한다
  const m2 = P.matchToVcenter({ id: VC, host: 'vc01.corp.local' }, vms, [{ server: { id: 's', name: 'S' }, result: { jobs: [], vms: [{ n: 'DB01', m: 'vm-50', h: '', j: [], rp: 3, run: 0 }] } }]);
  assert.equal(m2.byVm[`${VC}:vm-50`].rp, 3);
});

test('검토 #3: 둘 다 FQDN 이면 첫 마디만 같은 다른 vCenter 를 같은 것으로 보지 않는다', () => {
  assert.equal(P.sameHost('vc01.pl.corp', 'https://vc01.kr.corp'), false);
  assert.equal(P.sameHost('vc01', 'https://vc01.kr.corp'), true, '한쪽이 짧은 이름이면 같다');
  assert.equal(P.sameHost('VC01.KR.CORP', 'https://vc01.kr.corp:443/sdk'), true);
  assert.equal(P.sameHost('10.0.0.1', '10.0.0.2'), false);
});

test('검토 #4: 꺼진 작업·복제·복사 작업에만 든 VM 은 배지를 달지 않는다', () => {
  const res = { jobs: [
    { id: 'a', name: 'BJ-Off', type: 'Backup', disabled: true }, { id: 'b', name: 'RJ', type: 'VSphereReplica' },
    { id: 'c', name: 'BCJ', type: 'BackupCopy' }, { id: 'd', name: 'BJ-On', type: 'Backup' },
  ], vms: [
    { n: 'x1', m: 'vm-1', h: '', j: [0, 1, 2], rp: null, run: 0 },
    { n: 'x2', m: 'vm-2', h: '', j: [1, 3], rp: null, run: 0 },
  ] };
  const vms = [{ id: `${VC}:vm-1`, name: 'x1' }, { id: `${VC}:vm-2`, name: 'x2' }];
  const m = P.matchToVcenter({ id: VC, host: '' }, vms, [{ server: { id: 's', name: 'S' }, result: res }]);
  assert.equal(m.byVm[`${VC}:vm-1`], undefined);
  assert.deepEqual(m.byVm[`${VC}:vm-2`].jobs, ['BJ-On'], '근거가 되는 작업만 적는다');
});

test('검토 #6: 실패해 마지막 성공분을 쓰거나 오래된 결과의 백업 중은 지운다(백업 대상은 둔다)', () => {
  const r = { ts: 1_000, vms: [{ n: 'a', m: 'vm-1', run: 1, pg: 37, by: 'task', rp: 5 }] };
  assert.equal(P.withoutStaleRunning(r, { failed: true, now: 1_001 }).vms[0].run, 0);
  assert.equal(P.withoutStaleRunning(r, { failed: false, now: 1_000 + 3_600_000, maxAgeMs: 1_200_000 }).vms[0].run, 0);
  assert.equal(P.withoutStaleRunning(r, { failed: false, now: 2_000, maxAgeMs: 1_200_000 }).vms[0].run, 1);
  assert.equal(P.withoutStaleRunning(r, { failed: true, now: 1_001 }).vms[0].rp, 5);
});

test('검토 #8: 오류 문구는 가린 뒤에 자르고, URL 인코딩된 비밀번호도 가린다', async () => {
  const { collectVeeamServer } = await import('../src/veeam/client.js');
  const pw = 'Pw+Enc/Check&1';
  const srv = { id: 'v', name: 'V', host: 'vbr.corp.local', port: 9419, username: 'svc', password: pw };
  const body = `${'x'.repeat(290)} ${encodeURIComponent(pw)} ${pw}`;
  await assert.rejects(collectVeeamServer(srv, { fetchImpl: async () => new Response(JSON.stringify({ message: body }), { status: 500 }) }),
    (e) => !e.message.includes(pw) && !e.message.includes(encodeURIComponent(pw)) && !e.message.includes('Pw+Enc') && !e.message.includes('Pw%2BEnc'));
});

test('상세: 마지막 task(완료 시각·결과·용량) · 복원 지점(개수·최근) · 백업 파일 용량 → VM 상세 창 값', () => {
  const r = P.buildServerResult({
    jobs: JOBS, states: STATES, backupObjects: BOBJ,
    lastTasks: [{ session: { id: 's9', jobId: 'j1', state: 'Stopped' }, tasks: { data: [
      { name: 'web01', objectId: 'vm-101', state: 'Stopped', result: { result: 'Success', message: '' }, creationTime: '2026-10-21T16:00:00Z', endTime: '2026-10-21T16:42:00Z', progress: { processedSize: 1000, readSize: 400, transferredSize: 100 } },
    ] } }],
    restorePoints: { data: [
      { id: 'rp1', name: 'web01', platformName: 'VMware', creationTime: '2026-10-20T16:00:00Z', backupId: 'b1' },
      { id: 'rp2', name: 'web01', platformName: 'VMware', creationTime: '2026-10-21T16:00:00Z', backupId: 'b1' },
      { id: 'rpx', name: 'unknown-vm', platformName: 'VMware', creationTime: '2026-10-21T16:00:00Z', backupId: 'b1' },
    ] },
    backups: [{ backup: { id: 'b1', name: 'BJ-Web', jobId: 'j1', repositoryName: 'Repo1' }, files: { data: [
      { backupSize: 300, dataSize: 900, creationTime: '2026-10-20T16:30:00Z', objectRestorePointIds: ['rp1'] },
      { backupSize: 50, dataSize: 120, creationTime: '2026-10-21T16:40:00Z', dedupRatio: 1.5, compressRatio: 2, objectRestorePointIds: ['rp2'] },
      { backupSize: 999, creationTime: '2026-10-19T16:40:00Z', objectRestorePointIds: ['rp1', 'rpx'] },
    ] } }],
  });
  const web = r.vms.find((v) => v.n === 'web01');
  assert.equal(web.lt.r, 'Success'); assert.equal(web.lt.e, Date.parse('2026-10-21T16:42:00Z')); assert.equal(web.lt.ps, 1000);
  assert.equal(web.rn, 2); assert.equal(web.rl[0], Date.parse('2026-10-21T16:00:00Z'));
  assert.equal(web.sz, 350, 'VM 하나의 복원 지점만 담은 파일만 그 VM 용량 — 다른 것이 섞인 파일(999)은 나누지 않는다');
  assert.equal(r.backups[0].bs, 1349); assert.equal(r.backups[0].dd, 1.5, '최근 파일의 비율');
  // 정제 왕복 + 대조 + 상세
  const clean = P.sanitizeServerResult({ ...r, ok: true, ts: Date.now() });
  assert.equal(clean.vms.find((v) => v.n === 'web01').sz, 350);
  const vms = [{ id: `${VC}:vm-101`, name: 'web01' }];
  const m = P.matchToVcenter({ id: VC, host: 'vc01.corp.local' }, vms, [{ server: { id: 'v', name: 'VBR-A' }, result: clean }], { refsFor: `${VC}:vm-101` });
  const cur = m.byVm[`${VC}:vm-101`];
  assert.equal(cur.lb, Date.parse('2026-10-21T16:42:00Z')); assert.equal(cur.lbSrc, 'task', '완료 시각은 task 의 끝');
  const d = P.buildVmDetail(cur);
  assert.equal(d.lastTask.durationSec, 42 * 60); assert.equal(d.lastTask.job, 'BJ-Web');
  assert.equal(d.restorePoints.count, 2); assert.equal(d.restorePoints.oldest, Date.parse('2026-10-20T16:00:00Z'));
  assert.equal(d.vmSize, 350); assert.equal(d.backups[0].repo, 'Repo1'); assert.equal(d.backups[0].files, 3);
  assert.deepEqual(d.servers.map((x) => x.name), ['VBR-A']);
  // task 가 실패면 완료 시각은 복원 지점 생성 시각으로(완료라고 말하지 않는다)
  assert.deepEqual(P.lastBackupOf({ lt: { r: 'Failed', e: 5 }, rl: [3] }), { t: 3, src: 'rp' });
  assert.equal(P.lastBackupOf({}), null);
});

test('상세: 같은 서버 안에 동명 VM 이 둘이면 복원 지점을 어느 쪽에도 붙이지 않는다 · 정제는 음수·범위 밖 인덱스를 버린다', () => {
  const r = P.buildServerResult({
    jobs: { data: [{ id: 'j', name: 'J', virtualMachines: { includes: [
      { type: 'VirtualMachine', hostName: 'vcA.corp', name: 'dup', objectId: 'vm-1' }, { type: 'VirtualMachine', hostName: 'vcB.corp', name: 'dup', objectId: 'vm-1' },
    ] } }] },
    restorePoints: [{ id: 'p', name: 'dup', creationTime: '2026-10-21T00:00:00Z', backupId: 'b' }],
  });
  assert.ok(r.vms.every((v) => v.rn == null));
  assert.ok(r.notes.some((n) => /복원 지점 1개/.test(n)));
  const c = P.sanitizeServerResult({ ok: true, ts: 1, jobs: [], backups: [{ id: 'b', bs: -5, j: 3 }], vms: [{ n: 'a', m: 'vm-1', rb: [0, 7], rl: [5, -1, 'x'], sz: -3, lt: { r: 'Success', e: -1, j: 9 } }] });
  assert.equal(c.backups[0].bs, null); assert.equal(c.backups[0].j, null);
  assert.deepEqual(c.vms[0].rb, [0]); assert.deepEqual(c.vms[0].rl, [5]); assert.equal(c.vms[0].sz, null);
  assert.equal(c.vms[0].lt.e, null); assert.equal(c.vms[0].lt.j, null);
});

test('상세: vCenter 를 모르는 항목은 같은 moref 라도 이름이 다르면 합치지 않는다(다른 vCenter 의 VM)', () => {
  const r = P.buildServerResult({
    jobs: { data: [{ id: 'j', name: 'J', virtualMachines: { includes: [{ type: 'VirtualMachine', hostName: 'vcA.corp', name: 'alpha', objectId: 'vm-7' }] } }] },
    backupObjects: [{ name: 'beta', type: 'VM', platformName: 'VMware', objectId: 'vm-7', restorePointsCount: 4 }],
  });
  const alpha = r.vms.find((v) => v.n === 'alpha');
  assert.equal(alpha.rp, null, 'beta 의 복원 지점이 alpha 에 붙지 않는다');
  assert.ok(r.vms.find((v) => v.n === 'beta'));
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
    const { issueAgentToken } = await import('../src/central/agentTokens.js');
    const tokA = issueAgentToken('edge-a').token;
    // 검토 #5: 공유 토큰은 Veeam 위임 라우트에서 403 — 어느 엣지인지 가릴 수 없어 남의 엣지 비밀번호를 받아 갈 수 있다.
    for (const [m, u] of [['GET', '/veeam-config?agent=edge-a'], ['POST', '/veeam-data?agent=edge-a']]) {
      const r = await fetch(`http://127.0.0.1:${port}/api/central${u}`, { method: m, headers: { 'Content-Type': 'application/json', 'X-Central-Token': 'ctok-2751', 'X-Agent-Name': 'edge-a' }, ...(m === 'POST' ? { body: JSON.stringify({ results: [] }) } : {}) });
      assert.equal(r.status, 403, `${m} ${u} 공유 토큰`);
      assert.equal((await r.json()).agentTokenRequired, true);
    }
    config.agent.centralUrl = `http://127.0.0.1:${port}`;
    config.agent.centralToken = tokA;
    config.agent.name = 'edge-a';
    const { pullVeeamConfigNow } = await import('../src/agent/veeamConfigPull.js');
    // pull 이 새 배정을 받으면 바로 백그라운드 수집(pollVeeamOnce)을 돌린다. 그 결과(via 'local')가 아래 push 보다 늦게 오면
    // 러너 속도에 따라 기록을 덮어써 흔들렸다(v2.751 릴리스 러너에서 재현) — 네트워크 없이 끝나게 인증 정지로 두고, 끝날 때까지 기다린다.
    const poller = await import('../src/veeam/poller.js');
    poller.authGuard.markAuthStopped(mine.id, R.getServerWithSecret(mine.id), '테스트 — 백그라운드 수집이 네트워크로 나가지 않게');
    const pr = await pullVeeamConfigNow();
    assert.equal(pr.ok, true, pr.reason); assert.equal(pr.count, 1);
    const bg = poller._runningForTest();
    assert.ok(bg, 'pull 직후 백그라운드 수집이 시작된다');
    await bg;
    assert.equal(ST.getRecord(mine.id)?.result?.kind, 'auth-stopped', '백그라운드 수집은 네트워크 없이 끝났다');
    poller.authGuard.clearAuthStop(mine.id);
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
    const res = await fetch(`http://127.0.0.1:${port}/api/central/veeam-data?agent=edge-a`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': tokA, 'X-Agent-Name': 'edge-a' },
      body: JSON.stringify({ agent: 'edge-a', results: [{ serverId: other.id, ok: true, ts: Date.now(), vms: [] }] }) });
    const j = await res.json();
    assert.equal(j.saved, 0); assert.equal(j.dropped.notOwned, 1);
    // 결과 0건이어도 상태는 받는다
    const res0 = await fetch(`http://127.0.0.1:${port}/api/central/veeam-data?agent=edge-a`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': tokA, 'X-Agent-Name': 'edge-a' },
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
    // 검토 #7: 실패 결과의 오류 원문(주소 포함)은 관리자에게만 — 범위 viewer 에게는 일반 문구.
    const sid = R.listServers().find((x) => x.name === 'VBR-E').id;
    ST.putResult(sid, { ok: false, ts: Date.now(), error: 'vbr-e.corp.local:9419 응답이 없습니다(60초 초과)', jobs: [], vms: [], counts: {}, notes: [] });
    const rv = await get(VC);
    assert.ok(!JSON.stringify(rv.body).includes('vbr-e.corp.local'), 'viewer 에게 Veeam 주소가 새지 않는다');
    assert.match(rv.body.servers.find((x) => x.name === 'VBR-E').error, /관리자 화면/);
    assert.equal(rv.body.byVm[`${VC}:vm-101`]?.run ?? 0, 0, '실패해 마지막 성공분을 쓰면 백업 중을 지운다');
    user = { username: 'adm', role: 'admin' };
    assert.match((await get(VC)).body.servers.find((x) => x.name === 'VBR-E').error, /vbr-e\.corp\.local/, '관리자는 원문을 본다');
    // 상세 라우트 — 범위 밖 404 · 없는 VM 404 · 있는 VM 은 상세
    const getD = async (vc, vm) => { const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/veeam/vm-detail?vcenterId=${encodeURIComponent(vc)}&vmId=${encodeURIComponent(vm)}`); return { status: res.status, body: await res.json() }; };
    user = { username: 'u', role: 'viewer', scope: { vcenters: [VC] } };
    assert.equal((await getD('eu:vc02', 'eu:vc02:vm-5')).status, 404);
    assert.equal((await getD(VC, `${VC}:vm-999`)).status, 404);
    const dd = await getD(VC, `${VC}:vm-101`);
    assert.equal(dd.status, 200); assert.equal(dd.body.vm.name, 'web01');
    assert.ok(dd.body.detail && dd.body.detail.jobs.length >= 1, JSON.stringify(dd.body).slice(0, 300));
    assert.ok(!JSON.stringify(dd.body).includes('vbr-e.corp.local'));
    user = { username: 'v', role: 'viewer' };
    for (const d of R.listServers()) R.deleteServer(d.id);
    const r2 = await get('eu:vc02');
    assert.equal(r2.body.configured, false);
  } finally { store.snapshot = prev; }
});

/* ═══════════════ 대량 등록(CSV·자유텍스트) ═══════════════ */
const B = await import('../src/veeam/bulk.js');
const VCS = [{ id: 'vc-az', name: 'vcenter-az-01' }, { id: 'vc-pl', name: 'vcenter-pl-01' }, { id: 'vc-dup1', name: 'same' }, { id: 'vc-dup2', name: 'same' }];

test('대량: CSV·자유텍스트 파싱 · vCenter 는 id 또는 이름(;) · 동명·모르는 vCenter 는 사유', () => {
  const csv = B.sampleCsv();
  const c = B.parseServersCsv(csv);
  assert.equal(c.error, undefined, c.error);
  assert.equal(c.rows.length, 2, '샘플 주석 행은 건너뛴다');
  assert.equal(c.rows[1].vcenters, 'vc-pl;vc-pl-dr');
  const t = B.parseServersText(B.sampleText());
  assert.equal(t.error, undefined, t.error);
  assert.ok(t.rows.length >= 3, JSON.stringify(t.rows.map((r) => r.host)));
  assert.ok(t.rows.some((r) => r.host === 'vbr-us.corp.local' && r.agent === '중앙' && r.password === 'ChangeMe!3'), '키=값형 한글 키');
  const r = B.resolveVcenters('vc-az; vcenter-pl-01;nope;same', VCS);
  assert.deepEqual(r.ids, ['vc-az', 'vc-pl']); assert.deepEqual(r.unknown, ['nope']); assert.deepEqual(r.ambiguous, ['same']);
});

test('대량: 내보내기·샘플에 비밀번호 없음 · 엣지는 아는 이름만 · 계정이 바뀌면 비밀번호 필요 · 신규는 비밀번호 필수', () => {
  const out = B.serversToCsv([{ name: 'A', host: 'h', port: 9419, username: 'u', password: 'SECRET-X', vcenterIds: ['vc-az'], agent: 'az-edge' }]);
  assert.ok(!out.includes('SECRET-X'));
  assert.ok(!B.serversToText([{ name: 'A', host: 'h', password: 'SECRET-X', vcenterIds: [] }]).includes('SECRET-X'));
  const prev = { id: 'vbr-1', host: 'vbr.corp', port: 9419, username: 'svc', agent: 'old-edge', vcenterIds: ['vc-az'] };
  const ctx = { existing: (k) => (k === 'vbr.corp:9419' ? prev : undefined), vcenters: VCS, agents: ['AZ-Edge'] };
  const add = B.toSaveInput({ name: 'N', host: 'new.corp', port: '', username: 'svc', vcenters: 'vc-az', agent: 'az-edge', enabled: true, _hasPassword: false }, ctx);
  assert.equal(add.agent, 'AZ-Edge', '대소문자만 다른 값은 목록 표기로');
  assert.match(B.inputIssue(add, { isNew: true }), /비밀번호가 필요/);
  const typo = B.toSaveInput({ name: 'N', host: 'new.corp', username: 'svc', vcenters: 'vc-az', agent: 'az-edg', _hasPassword: true, password: 'p' }, ctx);
  assert.match(B.inputIssue(typo, { isNew: true }), /엣지 목록에 없습니다/);
  const keepOld = B.toSaveInput({ name: 'N', host: 'vbr.corp', username: 'svc', vcenters: '', agent: 'old-edge', _hasPassword: false }, ctx);
  assert.equal(keepOld.id, 'vbr-1'); assert.equal(keepOld.agent, 'old-edge', '이미 저장된 값은 목록에 없어도 통과');
  assert.deepEqual(keepOld.vcenterIds, ['vc-az'], 'vCenter 칸을 비우면 기존 유지');
  assert.equal(B.inputIssue(keepOld), null);
  const moved = B.toSaveInput({ name: 'N', host: 'vbr.corp', username: 'other', vcenters: 'vc-az', agent: '', _hasPassword: false }, ctx);
  assert.match(B.inputIssue(moved), /승계하지 않습니다/);
  assert.equal(B.cleanInput(moved)._moved, undefined);
});

test('대량: 실제 관리 라우트 — 드라이런 → 저장(추가·수정) · 비밀번호 유지 · 내보내기에 비밀번호 없음', async () => {
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { registerVeeam } = await import('../src/routes/admin/veeam.js');
  const prevSnap = store.snapshot;
  store.snapshot = { source: 'live', vcenters: VCS.slice(0, 2), vms: [], hosts: [] };
  for (const d of R.listServers()) R.deleteServer(d.id);
  R.saveServer({ name: 'Old', host: 'vbr-old.corp', username: 'svc', password: 'KEEP-PW', vcenterIds: ['vc-az'] });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin' }; next(); });
  const r = express.Router(); registerVeeam(r); app.use('/api/admin', r);
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  closers.push(() => new Promise((ok) => srv.close(() => ok())));
  const base = `http://127.0.0.1:${srv.address().port}/api/admin/veeam/servers`;
  const post = async (path, body) => { const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
  try {
    const text = [
      'name host port username vcenters agent apiVersion enabled note password',
      '"AZ Veeam" vbr-az.corp - svc vcenter-az-01 중앙 - true - NewPw!1',
      '"Old renamed" vbr-old.corp - svc vc-az - - true - -',
      '"Bad" vbr-bad.corp - svc nope 중앙 - true - x',
    ].join('\n');
    const dry = await post('/import', { text, format: 'text', dryRun: true });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    const act = Object.fromEntries(dry.body.report.map((x) => [x.name, x.action]));
    assert.equal(act['AZ Veeam'], 'add'); assert.equal(act['Old renamed'], 'update'); assert.equal(act.Bad, 'error');
    const done = await post('/import', { text, format: 'text', selectLines: dry.body.report.filter((x) => x.action !== 'error').map((x) => x.line) });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.added, 1); assert.equal(done.body.updated, 1);
    const old = R.listServers().find((d) => d.host === 'vbr-old.corp');
    assert.equal(old.name, 'Old renamed');
    assert.equal(R.getServerWithSecret(old.id).password, 'KEEP-PW', '비밀번호를 비운 행은 기존 유지');
    assert.equal(R.getServerWithSecret(R.listServers().find((d) => d.host === 'vbr-az.corp').id).password, 'NewPw!1');
    const exp = await fetch(`${base}/export.csv`);
    assert.equal(exp.status, 200);
    const expText = await exp.text();
    assert.ok(!expText.includes('KEEP-PW') && !expText.includes('NewPw!1'), '내보내기에 비밀번호 없음');
    // 단건 저장도 모르는 엣지 이름은 400
    const bad = await post('', { name: 'X', host: 'vbr-x.corp', username: 'u', password: 'p', vcenterIds: ['vc-az'], agent: 'ghost-edge' });
    assert.equal(bad.status, 400); assert.equal(bad.body.field, 'agent');
  } finally { store.snapshot = prevSnap; for (const d of R.listServers()) R.deleteServer(d.id); }
});
