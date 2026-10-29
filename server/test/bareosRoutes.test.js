/**
 * test/bareosRoutes.test.js — Bareos VM 백업 라우트 계약(실제 routes/api.js · AUTH_ENABLED=true · TLS-PSK 가짜 Director).
 *  ① RBAC: admin 전용(operator·viewer 403) · 설정·카탈로그는 전체 범위 전용 · 배지는 tools 권한 + 범위 밖 빈 목록
 *  ② 범위: 조회 밖 404 → 쓰기 밖 403(writeVcenters) · 목록은 조회 범위 교집합 + 뺀 개수
 *  ③ 비밀: 응답에 비밀번호 없음(hasPassword) · 접속처를 바꾸면 저장 비밀번호 폐기 · 연결 시험은 저장 비밀 승계 시 **저장 주소로 고정**
 *  ④ 저장 차단: 루프백 아닌 차단 대역(링크로컬) · 인벤토리에 없는 vCenter 매핑 · 금지 글자 VM 은 등록 불가(사유)
 *  ⑤ 흐름: 등록(configure add job — 자격증명 없음) → 실행(202·중복 409) → 폴링(lastRun) → 로그(다른 잡 jobid 거부) → 비활성 → 삭제
 *  ⑥ 복원: OTP 없음 403 · 틀린 OTP 403 · 덮어쓰기 전제(켜짐) 400 · 새 VM 202(restore 명령 = jobid 체인 + powerstate off) · 진행 중 409
 *  ⑦ 가림·데모: 범위·데모 계정은 Director 주소·접속 오류 원문을 못 받는다 · 데모 계정은 사람이 등록한 Director 를 조회하지 못한다(접속 0)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareosroutes-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
process.env.SSRF_ALLOW_LOOPBACK = 'true'; // 가짜 Director 가 127.0.0.1 에 있다(실제 코드 경로 그대로 — ssrf 검사만 루프백 허용)

const { generateSecret, generateToken } = await import('../src/auth/totp.js');
const SECRET = generateSecret();
fs.writeFileSync(path.join(tmp, 'users.json'), JSON.stringify({ users: [
  { username: 'adm', role: 'admin', totpEnabled: true, totpSecret: SECRET },
  { username: 'noot', role: 'admin' },
] }));

const { startFakeDirector } = await import('./_fakeBareosDirector.js');

// ── 가짜 Director 의 상태(테스트가 상태를 바꾼다) ──
const D = { jobs: new Map(), runs: new Map(), nextId: 500, cmds: [] };
const HIST = (name) => [
  { jobid: 100, name, type: 'B', level: 'F', jobstatus: 'T', starttime: '2026-10-20 02:00:00', endtime: '2026-10-20 02:40:00', jobbytes: 1000, jobfiles: 3, joberrors: 0 },
  { jobid: 110, name, type: 'B', level: 'I', jobstatus: 'T', starttime: '2026-10-21 02:00:00', endtime: '2026-10-21 02:05:00', jobbytes: 10, jobfiles: 3, joberrors: 0 },
  { jobid: 120, name, type: 'B', level: 'I', jobstatus: 'f', starttime: '2026-10-22 02:00:00', endtime: '2026-10-22 02:01:00', jobbytes: 0, jobfiles: 0, joberrors: 1 },
  { jobid: 130, name, type: 'B', level: 'I', jobstatus: 'T', starttime: '2026-10-23 02:00:00', endtime: '2026-10-23 02:05:00', jobbytes: 12, jobfiles: 3, joberrors: 0 },
];
function handle(cmd) {
  D.cmds.push(cmd);
  const kv = Object.fromEntries([...cmd.matchAll(/(\w+)=("(?:\\.|[^"])*"|\S+)/g)].map((m) => [m[1], m[2]]));
  if (cmd === '.clients') return { clients: [{ name: 'kr-fd' }] };
  if (cmd === '.jobs') return { jobs: [...D.jobs.keys()].map((name) => ({ name })) };
  if (cmd.startsWith('configure add job')) {
    if (D.jobs.has(kv.name)) return { error: [`Resource "Job" with name "${kv.name}" already exists.`] };
    D.jobs.set(kv.name, { enabled: true }); return { add: { resource: 'Job', name: kv.name, filename: `/etc/bareos/bareos-dir.d/job/${kv.name}.conf` } };
  }
  if (cmd.startsWith('run ')) { const id = D.nextId++; D.runs.set(id, { name: kv.job, status: 'R', type: 'B' }); return { run: { jobid: id } }; }
  if (cmd.startsWith('restore ')) { const id = D.nextId++; D.runs.set(id, { name: 'PortalVmwareRestore', status: 'C', type: 'R' }); return { run: { jobid: id } }; }
  if (cmd.startsWith('llist jobid=')) {
    const id = Number(kv.jobid);
    const r = D.runs.get(id);
    if (r) return { jobs: [{ jobid: id, name: r.name, type: r.type, level: 'I', jobstatus: r.status, starttime: '2026-10-29 02:00:00', endtime: r.status === 'T' ? '2026-10-29 02:10:00' : '', jobbytes: r.status === 'T' ? 2048 : 0 }] };
    for (const n of D.jobs.keys()) { const h = HIST(n).find((x) => x.jobid === id); if (h) return { jobs: [h] }; }
    return { jobs: [] };
  }
  if (cmd.startsWith('list jobs job=')) return { jobs: HIST(kv.job).reverse() };
  if (cmd.startsWith('list jobs days=')) return { jobs: [...D.runs.entries()].filter(([, r]) => r.type === 'B').map(([jobid, r]) => ({ jobid, name: r.name, type: 'B', level: 'I', jobstatus: r.status })) };
  if (cmd.startsWith('list joblog')) return { joblog: [{ time: '2026-10-29 02:00:00', logtext: `log of ${kv.jobid}\n` }] };
  if (cmd.startsWith('.bvfs_get_jobids')) return { jobids: '100,110,130' };
  if (cmd.startsWith('cancel ')) { const r = D.runs.get(Number(kv.jobid)); if (r) r.status = 'A'; return { cancel: {} }; }
  if (cmd.startsWith('enable ') || cmd.startsWith('disable ')) return { ok: true };
  return { error: [`unknown command ${cmd}`] };
}

let srv, base, fd, store, registry;
const USERS = {
  admin: { username: 'adm', role: 'admin', scope: null },
  noot: { username: 'noot', role: 'admin', scope: null },
  op: { username: 'op', role: 'operator', scope: null },
  viewer: { username: 'vw', role: 'viewer', scope: null },
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-a'] } },
  wadm: { username: 'wadm', role: 'admin', scope: { writeVcenters: ['vc-a'] } },
  // mock 모드 내장 데모 계정 — 요청 문맥은 admin + demoGuest(auth/demoGuest.js)
  demo: { username: 'thedvcdemp', role: 'admin', demoGuest: true, scope: null },
};

before(async () => {
  fd = await startFakeDirector({ name: 'portal', password: 'pw-1', handle });
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  ({ store } = await import('../src/store.js'));
  registry = await import('../src/bareos/registry.js');
  store.snapshot = {
    generatedAt: Date.now(), source: 'mock',
    vcenters: [{ id: 'vc-a', name: 'Seoul', host: 'https://vc-a.corp', location: { region: 'KR' } }, { id: 'vc-b', name: 'Warsaw', host: 'https://vc-b.corp', location: { region: 'PL' } }],
    hosts: [{ id: 'vc-a:host-1', vcenterId: 'vc-a', name: 'esx-a1', cluster: 'CL-A' }],
    datastores: [{ id: 'vc-a:ds-1', vcenterId: 'vc-a', name: 'ds-a1' }],
    vms: [
      { id: 'vc-a:vm-1', vcenterId: 'vc-a', name: 'web-01', powerState: 'POWERED_ON', snapshotCount: 0, vcDatacenter: 'DC-A', folderPath: '/web' },
      { id: 'vc-a:vm-2', vcenterId: 'vc-a', name: 'tpl', template: true, powerState: 'POWERED_OFF', vcDatacenter: 'DC-A', folderPath: '/' },
      { id: 'vc-a:vm-3', vcenterId: 'vc-a', name: 'vapp-child', powerState: 'POWERED_ON', vcDatacenter: null, folderPath: null },
      { id: 'vc-a:vm-4', vcenterId: 'vc-a', name: 'bad:name', powerState: 'POWERED_ON', vcDatacenter: 'DC-A', folderPath: '/' },
      { id: 'vc-b:vm-9', vcenterId: 'vc-b', name: 'db-09', powerState: 'POWERED_ON', snapshotCount: 0, vcDatacenter: 'DC-B', folderPath: '/' },
    ],
    alarms: [], networks: [],
  };
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api/tools/bareos-backup`;
});
after(async () => { try { srv?.close(); } catch { /* */ } await fd?.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

async function call(u, method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, j, t };
}

test('① RBAC: operator·viewer 403 · 설정은 범위 계정 403', async () => {
  assert.equal((await call('op', 'GET', '')).s, 403);
  assert.equal((await call('viewer', 'GET', '')).s, 403);
  assert.equal((await call('op', 'POST', '/jobs', { vcenterId: 'vc-a', vmId: 'vc-a:vm-1' })).s, 403);
  assert.equal((await call('sadm', 'GET', '/settings')).s, 403);
  assert.equal((await call('sadm', 'PUT', '/settings', { director: { host: 'x.corp' } })).s, 403);
  assert.equal((await call('sadm', 'GET', '/catalog')).s, 403);
});

test('③④ 설정: 차단 주소 400 · 비밀번호는 응답에 없음 · 접속처 변경 시 비밀번호 폐기 · 모르는 vCenter 매핑 400', async () => {
  assert.equal((await call('admin', 'PUT', '/settings', { director: { host: '169.254.169.254', consoleName: 'portal', password: 'pw-1' } })).s, 400);
  let r = await call('admin', 'PUT', '/settings', { director: { host: 'bareos-dir.corp', port: 9101, consoleName: 'portal', password: 'pw-1' } });
  assert.equal(r.s, 200);
  assert.equal(r.j.settings.director.hasPassword, true);
  assert.doesNotMatch(r.t, /pw-1/);
  r = await call('admin', 'PUT', '/settings', { director: { host: 'other-dir.corp' } });
  assert.deepEqual(r.j.droppedSecrets, ['password']);
  assert.equal(r.j.settings.director.hasPassword, false);
  r = await call('admin', 'PUT', '/settings', { sites: [{ vcenterId: 'vc-zzz', vcserver: 'v', client: 'kr-fd', storage: 'kr-sd', pool: 'P', configFile: '/etc/bareos/x.ini' }] });
  assert.equal(r.s, 400);
  // 실제로 쓸 설정: 가짜 Director(127.0.0.1) + vc-a·vc-b 매핑
  r = await call('admin', 'PUT', '/settings', {
    director: { host: '127.0.0.1', port: fd.port, consoleName: 'portal', password: 'pw-1', timeoutMs: 5000 },
    sites: [
      { vcenterId: 'vc-a', vcserver: 'vc-a.corp', client: 'kr-fd', storage: 'kr-sd', pool: 'VMwareKR', schedule: 'VMwareNightly', configFile: '/etc/bareos/vmware/vc-a.ini' },
      { vcenterId: 'vc-b', vcserver: 'vc-b.corp', client: 'pl-fd', storage: 'pl-sd', pool: 'VMwarePL', configFile: '/etc/bareos/vmware/vc-b.ini' },
    ],
  });
  assert.equal(r.s, 200, r.t);
  const raw = fs.readFileSync(path.join(tmp, 'bareos.json'), 'utf8');
  assert.ok(raw.includes('"consoleName": "portal"'));
  assert.equal((fs.statSync(path.join(tmp, 'bareos.json')).mode & 0o777), 0o600);
});

test('③ 연결 시험: 저장 비밀번호로 시험하면 요청의 주소를 무시하고 저장 주소로 · 새 비밀번호면 요청 주소로', async () => {
  let r = await call('admin', 'POST', '/settings/test', { director: { host: '127.0.0.1', port: 1 } });
  assert.equal(r.s, 200, r.t);
  assert.equal(r.j.version, '25.0.4');
  assert.deepEqual(r.j.clients, ['kr-fd']);
  r = await call('admin', 'POST', '/settings/test', { director: { host: '127.0.0.1', port: 1, consoleName: 'portal', password: 'pw-1' } });
  assert.equal(r.s, 502);
  assert.equal(r.j.code, 'connect');
});

test('④ 등록 후보: 범위 밖 404 · 템플릿·위치 없음·금지 글자는 사유와 함께 불가', async () => {
  assert.equal((await call('sadm', 'GET', '/vm-candidates?vcenterId=vc-b')).s, 404);
  const r = await call('admin', 'GET', '/vm-candidates?vcenterId=vc-a');
  const by = Object.fromEntries(r.j.items.map((x) => [x.name, x]));
  assert.equal(by['web-01'].eligible, true);
  assert.match(by.tpl.reason, /템플릿/);
  assert.match(by['vapp-child'].reason, /데이터센터·폴더/);
  assert.match(by['bad:name'].reason, /콜론/);
  assert.equal(r.j.writable, true);
  assert.equal((await call('wadm', 'GET', '/vm-candidates?vcenterId=vc-b')).j.writable, false);
});

let jobId;
test('②⑤ 등록: 조회 밖 404 · 쓰기 밖 403 · 201 + configure add job(자격증명 없음) · 중복 400', async () => {
  assert.equal((await call('sadm', 'POST', '/jobs', { vcenterId: 'vc-b', vmId: 'vc-b:vm-9' })).s, 404);
  assert.equal((await call('wadm', 'POST', '/jobs', { vcenterId: 'vc-b', vmId: 'vc-b:vm-9' })).s, 403);
  const r = await call('admin', 'POST', '/jobs', { vcenterId: 'vc-a', vmId: 'vc-a:vm-1' });
  assert.equal(r.s, 201, r.t);
  jobId = r.j.job.id;
  assert.match(r.j.job.bareosJob, /^pv-[0-9a-f]{8}-vm-1$/);
  const add = D.cmds.find((c) => c.startsWith('configure add job'));
  assert.match(add, /fdpluginoptions="\\"python3:vcserver=vc-a\.corp:dc=DC-A:folder=\/web:vmname=web-01:config_file=\/etc\/bareos\/vmware\/vc-a\.ini\\""/);
  assert.match(add, /client=kr-fd storage=kr-sd pool=VMwareKR schedule=VMwareNightly level=Incremental/);
  assert.doesNotMatch(add, /vcpass|vcuser|pw-1/);
  assert.equal((await call('admin', 'POST', '/jobs', { vcenterId: 'vc-a', vmId: 'vc-a:vm-1' })).s, 400);
  // 범위 계정(vc-a)은 vc-a 대상만 본다 — vc-b 대상을 하나 더 만들어 뺀 개수를 확인
  assert.equal((await call('admin', 'POST', '/jobs', { vcenterId: 'vc-b', vmId: 'vc-b:vm-9', schedule: '' })).s, 201);
  const l = await call('sadm', 'GET', '');
  assert.deepEqual(l.j.jobs.map((j) => j.vmName), ['web-01']);
  assert.equal(l.j.omittedOutOfScope, 1);
  assert.doesNotMatch(l.t, /pw-1/);
});

test('⑤ 실행 202 · 실행 중 409 · 폴링으로 lastRun · 로그는 이 대상의 jobid 만', async () => {
  const r = await call('admin', 'POST', `/jobs/${jobId}/run`, { level: 'Full' });
  assert.equal(r.s, 202, r.t);
  const jid = r.j.jobid;
  assert.ok(D.cmds.includes(`run job=${registry.getJob(jobId).bareosJob} level=Full yes`));
  assert.equal((await call('admin', 'POST', `/jobs/${jobId}/run`)).s, 409);
  D.runs.get(jid).status = 'T';
  const p = await call('admin', 'POST', '/poll');
  assert.equal(p.j.poller.ok, true, JSON.stringify(p.j));
  const j = registry.getJob(jobId);
  assert.equal(j.pending, null);
  assert.equal(j.lastRun.jobid, jid);
  assert.equal(j.lastRun.state, 'ok');
  assert.equal(j.lastRun.bytes, 2048);
  assert.equal((await call('admin', 'GET', `/jobs/${jobId}/log?jobid=${jid}`)).j.lines[0], `2026-10-29 02:00:00 log of ${jid}`);
  const other = D.nextId++; D.runs.set(other, { name: 'SomeOtherJob', status: 'T', type: 'B' });
  assert.equal((await call('admin', 'GET', `/jobs/${jobId}/log?jobid=${other}`)).s, 400);
  assert.equal((await call('sadm', 'GET', `/jobs/${registry.listJobs().find((x) => x.vcenterId === 'vc-b').id}/history`)).s, 404);
});

test('⑥ 복원: OTP 없는 계정 403 · 전제 실패는 OTP 를 쓰기 전에 400 · 틀린 OTP 403 · 실패한 백업 거부 · 새 VM 202 · 진행 중 409', async () => {
  assert.equal((await call('noot', 'POST', `/jobs/${jobId}/restore`, { jobid: 130, mode: 'newVm', newVm: { name: 'web-01-r' } })).s, 403);
  const now = Math.floor(Date.now() / 30_000);
  const t1 = generateToken(SECRET, { counter: now });
  let r = await call('admin', 'POST', `/jobs/${jobId}/restore`, { jobid: 130, mode: 'original', confirmName: 'web-01', otp: t1 });
  assert.equal(r.s, 400);
  assert.match(r.j.reason, /켜져 있습니다/);
  r = await call('admin', 'POST', `/jobs/${jobId}/restore`, { jobid: 130, mode: 'newVm', newVm: { name: 'web-01' }, otp: t1 });
  assert.match(r.j.reason, /이미 있습니다/, '같은 vCenter 의 동명 VM 거부');
  assert.equal((await call('admin', 'POST', `/jobs/${jobId}/restore`, { jobid: 130, mode: 'newVm', newVm: { name: 'web-01-r' }, otp: '000000' })).s, 403);
  // 전제 실패는 OTP 를 쓰지 않았다 — t1 은 아직 쓸 수 있다
  r = await call('admin', 'POST', `/jobs/${jobId}/restore`, { jobid: 120, mode: 'newVm', newVm: { name: 'web-01-r', datastore: 'ds-a1' }, otp: t1 });
  assert.equal(r.s, 400, '실패한 백업(120)은 복원 지점이 아니다');
  assert.match(r.j.reason, /성공한 백업이 아닙니다/);
  const t2 = generateToken(SECRET, { counter: now + 1 });
  r = await call('admin', 'POST', `/jobs/${jobId}/restore`, { jobid: 130, mode: 'newVm', newVm: { name: 'web-01-r', datastore: 'ds-a1' }, otp: t2 });
  assert.equal(r.s, 202, r.t);
  assert.deepEqual(r.j.fromJobids, [100, 110, 130]);
  const cmd = D.cmds.find((c) => c.startsWith('restore '));
  assert.equal(cmd, 'restore client=kr-fd restoreclient=kr-fd jobid=100,110,130 restorejob=PortalVmwareRestore pluginoptions="python3:vmname=web-01-r:restore_powerstate=off:restore_datastore=ds-a1" select all done yes');
  assert.equal(registry.getJob(jobId).restores[0].jobid, r.j.jobid);
  assert.equal((await call('admin', 'POST', `/jobs/${jobId}/restore`, { jobid: 130, mode: 'localVmdk', otp: 'x' })).s, 409);
  // 폴링이 복원 상태를 갱신한다
  D.runs.get(r.j.jobid).status = 'T';
  await call('admin', 'POST', '/poll');
  assert.equal(registry.getJob(jobId).restores[0].state, 'ok');
});

test('⑦ 가림·데모: Director 주소는 전체 범위 관리자만 · 데모 계정의 실 Director 조회는 403(접속 0)', async () => {
  const full = await call('admin', 'GET', '');
  assert.equal(full.j.director.host, '127.0.0.1');
  assert.equal(full.j.director.consoleName, 'portal');
  for (const u of ['sadm', 'demo']) {
    const r = await call(u, 'GET', '');
    assert.equal(r.s, 200, u);
    assert.equal(r.j.director.masked, true, u);
    assert.equal(r.j.director.host, undefined, u);
    assert.doesNotMatch(r.t, /127\.0\.0\.1|"consoleName"/, u);
  }
  const conns = fd.identities.length;
  for (const p of [`/jobs/${jobId}/history`, `/jobs/${jobId}/restore-points`, `/jobs/${jobId}/log?jobid=100`]) {
    const r = await call('demo', 'GET', p);
    assert.equal(r.s, 403, p);
    assert.equal(r.j.demoGuest, true, p);
  }
  assert.equal(fd.identities.length, conns, '데모 계정 조회가 실제 Director 에 접속했다');
  assert.equal((await call('admin', 'GET', `/jobs/${jobId}/history`)).s, 200, '같은 조회를 관리자는 한다(대조)');
  assert.ok(fd.identities.length > conns);
});

test('⑤ 비활성 → 삭제(Director 잡은 disable, 원장만 삭제 · conf 경로 안내) · 배지는 범위 밖 빈 목록', async () => {
  assert.equal((await call('viewer', 'GET', '/badges?vcenterId=vc-a')).s, 403, 'viewer 는 tools 권한이 없다(vm-clone 배지와 같다)');
  assert.deepEqual((await call('op', 'GET', '/badges?vcenterId=vc-a')).j.vmIds, ['vc-a:vm-1']);
  assert.deepEqual((await call('sadm', 'GET', '/badges?vcenterId=vc-b')).j.vmIds, []);
  assert.equal((await call('wadm', 'PATCH', `/jobs/${registry.listJobs().find((x) => x.vcenterId === 'vc-b').id}`, { enabled: false })).s, 403);
  let r = await call('admin', 'PATCH', `/jobs/${jobId}`, { enabled: false });
  assert.equal(r.s, 200);
  assert.equal(r.j.job.enabled, false);
  assert.equal((await call('admin', 'POST', `/jobs/${jobId}/run`)).s, 409, '비활성 대상은 실행하지 않는다');
  r = await call('admin', 'DELETE', `/jobs/${jobId}`);
  assert.equal(r.s, 200);
  assert.match(r.j.note, /bareos-dir\.d\/job\/pv-/);
  assert.equal(registry.getJob(jobId), null);
  assert.ok(D.cmds.filter((c) => c.startsWith('disable job=')).length >= 2);
});
