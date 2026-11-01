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
async function handle(cmd) {
  D.cmds.push(cmd);
  if (D.gate && (!D.gateFor || D.gateFor(cmd))) await D.gate;   // 시험이 명령을 붙잡아 둔다(동시성 시험 — 결정적으로)
  const kv = Object.fromEntries([...cmd.matchAll(/(\w+)=("(?:\\.|[^"])*"|\S+)/g)].map((m) => [m[1], m[2]]));
  if (cmd === '.clients') return { clients: [{ name: 'kr-fd' }] };
  if (cmd === '.jobs') return D.emptyJobs ? { jobs: [] } : { jobs: [...D.jobs].map(([name, j]) => ({ name, enabled: j.enabled !== false })) };   // 실제처럼 enabled(메모리 값)
  if (cmd.startsWith('configure add job')) {
    if (D.jobs.has(kv.name)) return { error: [`Resource "Job" with name "${kv.name}" already exists.`] };
    D.jobs.set(kv.name, { enabled: true }); return { add: { resource: 'Job', name: kv.name, filename: `/etc/bareos/bareos-dir.d/job/${kv.name}.conf` } };
  }
  if (cmd.startsWith('run ')) { const id = D.nextId++; D.runs.set(id, { name: kv.job, status: 'R', type: 'B' }); return { run: { jobid: id } }; }
  if (cmd.startsWith('restore ')) { const id = D.nextId++; D.runs.set(id, { name: 'PortalVmwareRestore', status: 'C', type: 'R' }); return { run: { jobid: id } }; }
  if (cmd.startsWith('llist jobid=')) {
    const id = Number(kv.jobid);
    if (D.denyLlist?.has(id)) return { error: ['llist: access denied'] };
    const r = D.runs.get(id);
    if (r) return { jobs: [{ jobid: id, name: r.name, type: r.type, level: 'I', jobstatus: r.status, starttime: '2026-10-29 02:00:00', endtime: r.status === 'T' ? '2026-10-29 02:10:00' : '', jobbytes: r.status === 'T' ? 2048 : 0 }] };
    for (const n of D.jobs.keys()) { const h = HIST(n).find((x) => x.jobid === id); if (h) return { jobs: [h] }; }
    return { jobs: [] };
  }
  if (cmd.startsWith('list jobs job=')) return { jobs: HIST(kv.job) };   // 실제 Director 처럼 오름차순(v2.822 W1)
  if (cmd.startsWith('list jobs days=')) return { jobs: [...D.runs.entries()].filter(([, r]) => r.type === 'B').map(([jobid, r]) => ({ jobid, name: r.name, type: 'B', level: 'I', jobstatus: r.status })) };
  if (cmd.startsWith('list joblog')) return { joblog: [{ time: '2026-10-29 02:00:00', logtext: `log of ${kv.jobid}\n` }] };
  if (cmd.startsWith('.bvfs_get_jobids')) return { jobids: '90,100,105,110,130' };   // 실제처럼 FD+FileSet 로 골라 다른 VM(90·105)이 섞인다 — 포탈은 쓰면 안 된다(S1)
  if (cmd.startsWith('cancel ')) { const r = D.runs.get(Number(kv.jobid)); if (r) r.status = 'A'; return { cancel: {} }; }
  if (cmd.startsWith('enable ') || cmd.startsWith('disable ')) {   // 실제처럼 메모리 값만 바꾸고, 모르는 잡은 거부(ua_cmds.cc)
    const j = D.jobs.get(kv.job);
    if (!j) return { error: [`Job "${kv.job}" not found.`] };
    j.enabled = cmd.startsWith('enable ');
    return { [cmd.split(' ')[0]]: { jobs: [kv.job] } };
  }
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
      { id: 'vc-a:vm-1', vcenterId: 'vc-a', name: 'web-01', powerState: 'POWERED_ON', snapshotCount: 0, vcDcPath: 'DC-A', folderPath: '/web', guestOS: 'Microsoft Windows Server 2022 (64-bit)' },
      { id: 'vc-a:vm-2', vcenterId: 'vc-a', name: 'tpl', template: true, powerState: 'POWERED_OFF', vcDcPath: 'DC-A', folderPath: '/', guestOS: 'unknown' },
      { id: 'vc-a:vm-3', vcenterId: 'vc-a', name: 'vapp-child', powerState: 'POWERED_ON', vcDcPath: null, folderPath: null },
      { id: 'vc-a:vm-4', vcenterId: 'vc-a', name: 'bad:name', powerState: 'POWERED_ON', vcDcPath: 'DC-A', folderPath: '/' },
      { id: 'vc-b:vm-9', vcenterId: 'vc-b', name: 'db-09', powerState: 'POWERED_ON', snapshotCount: 0, vcDcPath: 'DC-B', folderPath: '/' },
      { id: 'vc-a:vm-5', vcenterId: 'vc-a', name: 'app-05', powerState: 'POWERED_ON', snapshotCount: 0, vcDcPath: 'DC-A', folderPath: '/app' },
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
  assert.equal((await call('sadm', 'GET', '/settings/directors/dir_x/catalog')).s, 403);
  assert.equal((await call('sadm', 'POST', '/settings/directors', { name: 'x', host: 'x.corp' })).s, 403);
});

let DIR = '';
test('③④ 설정: 차단 주소 400 · 비밀번호는 응답에 없음 · 접속처 변경 시 비밀번호 폐기 · 모르는 vCenter 매핑 400', async () => {
  assert.equal((await call('admin', 'POST', '/settings/directors', { name: '한국', host: '169.254.169.254', consoleName: 'portal', password: 'pw-1' })).s, 400);
  let r = await call('admin', 'POST', '/settings/directors', { name: '한국', host: 'bareos-dir.corp', port: 9101, consoleName: 'portal', password: 'pw-1' });
  assert.equal(r.s, 201, r.t);
  DIR = r.j.director.id;
  assert.equal(r.j.director.hasPassword, true);
  assert.doesNotMatch(r.t, /pw-1/);
  r = await call('admin', 'PUT', `/settings/directors/${DIR}`, { host: 'other-dir.corp' });
  assert.deepEqual(r.j.droppedSecrets, ['password']);
  assert.equal(r.j.director.hasPassword, false);
  assert.equal((await call('admin', 'PUT', '/settings', { director: { host: 'x.corp' } })).s, 400, '접속값은 Director 경로로만');
  r = await call('admin', 'PUT', '/settings', { sites: [{ vcenterId: 'vc-zzz', directorId: DIR, vcserver: 'v', client: 'kr-fd', storage: 'kr-sd', pool: 'P', configFile: '/etc/bareos/x.ini' }] });
  assert.equal(r.s, 400);
  // 실제로 쓸 설정: 가짜 Director(127.0.0.1) + vc-a·vc-b 매핑
  r = await call('admin', 'PUT', `/settings/directors/${DIR}`, { host: '127.0.0.1', port: fd.port, consoleName: 'portal', password: 'pw-1', timeoutMs: 5000 });
  assert.equal(r.s, 200, r.t);
  r = await call('admin', 'PUT', '/settings', {
    sites: [
      { vcenterId: 'vc-a', directorId: DIR, vcserver: 'vc-a.corp', client: 'kr-fd', storage: 'kr-sd', pool: 'VMwareKR', schedule: 'VMwareNightly', configFile: '/etc/bareos/vmware/vc-a.ini' },
      { vcenterId: 'vc-b', directorId: DIR, vcserver: 'vc-b.corp', client: 'pl-fd', storage: 'pl-sd', pool: 'VMwarePL', configFile: '/etc/bareos/vmware/vc-b.ini' },
    ],
  });
  assert.equal(r.s, 200, r.t);
  const raw = fs.readFileSync(path.join(tmp, 'bareos.json'), 'utf8');
  assert.ok(raw.includes('"consoleName": "portal"'));
  assert.equal((fs.statSync(path.join(tmp, 'bareos.json')).mode & 0o777), 0o600);
});

test('③ 연결 시험: 저장 비밀번호로 시험하면 요청의 주소를 무시하고 저장 주소로 · 새 비밀번호면 요청 주소로', async () => {
  let r = await call('admin', 'POST', `/settings/directors/${DIR}/test`, { director: { host: '127.0.0.1', port: 1 } });
  assert.equal(r.s, 200, r.t);
  assert.equal(r.j.version, '25.0.4');
  assert.deepEqual(r.j.clients, ['kr-fd']);
  r = await call('admin', 'POST', `/settings/directors/${DIR}/test`, { director: { host: '127.0.0.1', port: 1, consoleName: 'portal', password: 'pw-1' } });
  assert.equal(r.s, 502);
  assert.equal(r.j.code, 'connect');
  // v2.822 단계별 진단 — 실패 단계와 그 뒤 '시도 안 함' · 성공 시험도 단계를 돌려준다
  const st = Object.fromEntries(r.j.stages.map((x) => [x.key, x]));
  assert.equal(st.address.ok, true); assert.equal(st.tcp.ok, false); assert.ok(st.tcp.hint); assert.equal(st.tls.skipped, true);
  const good = await call('admin', 'POST', `/settings/directors/${DIR}/test`, {});
  assert.deepEqual(good.j.stages.map((x) => x.ok ?? 'skip'), [true, 'skip', true, true, true, true, true]);
  // v2.822(B4) 감사 대상은 실제 접속한 주소 — 저장 비밀번호 시험은 요청 주소를 무시한다
  const { listAudit } = await import('../src/audit.js');
  const last = listAudit({ limit: 20, q: 'Bareos 연결 시험' }).items[0];
  assert.ok(last, '연결 시험 감사 기록');
  assert.equal(last.target, `한국 127.0.0.1:${fd.port}`, '저장 비밀번호 시험은 요청의 주소(127.0.0.1:1)가 아니라 실제 접속한 저장 주소');
  const bodyHost = await call('admin', 'POST', `/settings/directors/${DIR}/test`, { director: { host: '10.9.9.9', port: 1 } });
  assert.equal(bodyHost.s, 200, '저장 비밀번호 시험은 요청 주소를 무시한다(v2.480)');
  assert.equal(listAudit({ limit: 20, q: 'Bareos 연결 시험' }).items[0].target, `한국 127.0.0.1:${fd.port}`);
});

test('④ 등록 후보: 범위 밖 404 · 템플릿·위치 없음·금지 글자는 사유와 함께 불가', async () => {
  assert.equal((await call('sadm', 'GET', '/vm-candidates?vcenterId=vc-b')).s, 404);
  const r = await call('admin', 'GET', '/vm-candidates?vcenterId=vc-a');
  const by = Object.fromEntries(r.j.items.map((x) => [x.name, x]));
  assert.equal(by['web-01'].eligible, true);
  assert.match(by.tpl.reason, /템플릿/);
  assert.match(by['vapp-child'].reason, /데이터센터·폴더/);
  assert.match(by['bad:name'].reason, /콜론/);
  // v2.834 게스트 OS — 분류는 서버 · 'unknown'·빈 값은 모름(null — 기타로 세지 않는다)
  assert.deepEqual([by['web-01'].os, by['web-01'].guestOS], ['windows', 'Microsoft Windows Server 2022 (64-bit)']);
  assert.deepEqual([by.tpl.os, by.tpl.guestOS], [null, null]);
  assert.deepEqual([by['vapp-child'].os, by['vapp-child'].guestOS], [null, null]);
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
  // v2.822.5: 로그를 열면 그 실행의 상태가 원장에 반영된다 — 폴러를 기다리지 않는다(Director 명령 수는 그대로: llist + list joblog)
  const r2 = await call('admin', 'POST', `/jobs/${jobId}/run`, { level: 'Incremental' });
  assert.equal(r2.s, 202, r2.t);
  const jid2 = r2.j.jobid;
  let lg = await call('admin', 'GET', `/jobs/${jobId}/log?jobid=${jid2}`);
  assert.equal(lg.j.state, 'running');
  assert.equal(registry.getJob(jobId).lastRun.jobid, jid2, '실행 중인 실행도 최근 실행으로 반영');
  lg = await call('admin', 'GET', `/jobs/${jobId}/log?jobid=${jid2}`);
  assert.equal(lg.j.stateChanged, false, '실행 중이고 바뀐 것이 없으면 false(파일을 다시 쓰지 않는다)');
  assert.equal(registry.getJob(jobId).pending.jobid, jid2);
  D.runs.get(jid2).status = 'W';
  const before = D.cmds.length;
  lg = await call('admin', 'GET', `/jobs/${jobId}/log?jobid=${jid2}`);
  assert.equal(lg.s, 200, lg.t);
  assert.equal(lg.j.stateChanged, true);
  assert.equal(lg.j.state, 'warning');
  assert.deepEqual(D.cmds.slice(before).map((c) => c.split(' ')[0]), ['llist', 'list'], 'Director 명령은 llist·list joblog 두 개뿐');
  assert.equal(registry.getJob(jobId).pending, null, '끝난 실행은 추적 해제');
  assert.equal(registry.getJob(jobId).lastRun.jobid, jid2);
  assert.equal(registry.getJob(jobId).lastRun.state, 'warning');
  assert.equal((await call('admin', 'GET', `/jobs/${jobId}/log?jobid=${jid2}`)).j.stateChanged, false, '두 번째는 바뀐 것 없음');
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
  assert.equal(cmd, 'restore client=kr-fd restoreclient=kr-fd jobid=100,110,130 restorejob=PortalVmwareRestore pluginoptions="python3:vmname=web-01-r:restore_powerstate=off:restore_datastore=ds-a1" all done yes');
  assert.equal(D.cmds.filter((c) => c.startsWith('.bvfs_get_jobids')).length, 0, 'S1: 체인은 이 잡의 이력으로만 — bvfs 는 같은 FD 의 다른 VM(90·105)을 섞는다');
  assert.equal(registry.getJob(jobId).restores[0].jobid, r.j.jobid);
  assert.equal((await call('admin', 'POST', `/jobs/${jobId}/restore`, { jobid: 130, mode: 'localVmdk', otp: 'x' })).s, 409);
  // 폴링이 복원 상태를 갱신한다
  D.runs.get(r.j.jobid).status = 'T';
  await call('admin', 'POST', '/poll');
  assert.equal(registry.getJob(jobId).restores[0].state, 'ok');
});

test('⑦ 가림·데모: Director 주소는 전체 범위 관리자만 · 데모 계정의 실 Director 조회는 403(접속 0)', async () => {
  const full = await call('admin', 'GET', '');
  const fd0 = full.j.directors.find((d) => d.id === DIR);
  assert.equal(fd0.host, '127.0.0.1');
  assert.equal(fd0.consoleName, 'portal');
  assert.equal(full.j.jobs.find((j) => j.id === jobId).directorId, DIR, '잡에 법인 Director id');
  for (const u of ['sadm', 'demo']) {
    const r = await call(u, 'GET', '');
    assert.equal(r.s, 200, u);
    const d0 = r.j.directors.find((d) => d.id === DIR);
    assert.equal(d0.masked, true, u);
    assert.equal(d0.host, undefined, u);
    assert.equal(d0.name, '한국', u);
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

test('⑧ 일괄 등록(v2.822): 조회 밖 404 · 쓰기 밖 403 · 상한 400 · Director 세션 1개로 순차 등록 · 한 대의 실패가 나머지를 막지 않는다', async () => {
  assert.equal((await call('sadm', 'POST', '/jobs/bulk', { vcenterId: 'vc-b', vmIds: ['vc-b:vm-9'] })).s, 404);
  assert.equal((await call('wadm', 'POST', '/jobs/bulk', { vcenterId: 'vc-b', vmIds: ['vc-b:vm-9'] })).s, 403);
  assert.equal((await call('op', 'POST', '/jobs/bulk', { vcenterId: 'vc-a', vmIds: ['vc-a:vm-5'] })).s, 403, 'admin 전용');
  const many = Array.from({ length: 201 }, (_, i) => `vc-a:vm-x${i}`);
  const big = await call('admin', 'POST', '/jobs/bulk', { vcenterId: 'vc-a', vmIds: many });
  assert.equal(big.s, 400);
  assert.equal(big.j.maxBulk, 200);
  assert.equal((await call('admin', 'POST', '/jobs/bulk', { vcenterId: 'vc-a', vmIds: [] })).s, 400);
  const cand = await call('admin', 'GET', '/vm-candidates?vcenterId=vc-a');
  assert.equal(cand.j.maxBulk, 200, '화면은 상한을 API 값으로 쓴다');
  assert.ok(Number.isInteger(cand.j.jobsLeft));
  const conns = fd.identities.length;
  const adds = D.cmds.filter((c) => c.startsWith('configure add job')).length;
  // vm-1 은 앞 시험에서 지워졌다(Director 에는 비활성 잡이 남아 있다 → 접미사 r2 로 새 잡) · vm-2 템플릿 · vm-3 위치 없음 · 없는 VM · 중복 id
  const r = await call('admin', 'POST', '/jobs/bulk', { vcenterId: 'vc-a', vmIds: ['vc-a:vm-5', 'vc-a:vm-1', 'vc-a:vm-2', 'vc-a:vm-3', 'vc-a:nope', 'vc-a:vm-5'] });
  assert.equal(r.s, 200, r.t);
  assert.equal(r.j.ok, true);
  assert.equal(r.j.created, 2);
  assert.equal(r.j.failed, 3, '중복 id 는 한 번만');
  const by = Object.fromEntries(r.j.results.map((x) => [x.vmId, x]));
  assert.equal(by['vc-a:vm-5'].ok, true);
  assert.equal(by['vc-a:vm-1'].ok, true);
  assert.match(by['vc-a:vm-1'].bareosJob, /-r2$/, 'Director 에 같은 이름이 남아 있으면 접미사로 새 잡');
  assert.match(by['vc-a:vm-2'].reason, /템플릿/);
  assert.match(by['vc-a:vm-3'].reason, /데이터센터·폴더/);
  assert.match(by['vc-a:nope'].reason, /인벤토리에 없습니다/);
  assert.equal(fd.identities.length - conns, 1, 'Director 세션은 하나');
  assert.equal(D.cmds.filter((c) => c.startsWith('configure add job')).length - adds, 3, 'vm-5 1번 + vm-1 2번(이미 있음 → r2) — 준비 단계에서 걸러진 VM 은 Director 에 닿지 않는다');
  assert.ok(registry.findByVm('vc-a', 'vc-a:vm-5'));
  // 모두 실패면 ok:false + 사유(대상별 결과는 그대로)
  const none = await call('admin', 'POST', '/jobs/bulk', { vcenterId: 'vc-a', vmIds: ['vc-a:vm-5'] });
  assert.equal(none.j.ok, false);
  assert.match(none.j.results[0].reason, /이미 백업 대상/);
});

test('⑨ B2(v2.822): 같은 대상의 실행 요청이 동시에 오면 하나만 Director 에 간다(나머지 409) · B3: /poll 응답도 범위 관리자에게 가린다', async () => {
  const id = registry.findByVm('vc-a', 'vc-a:vm-5').id;
  const runs = D.cmds.filter((c) => c.startsWith('run ')).length;
  const rs = await Promise.all([call('admin', 'POST', `/jobs/${id}/run`, {}), call('admin', 'POST', `/jobs/${id}/run`, {}), call('admin', 'POST', `/jobs/${id}/run`, {})]);
  assert.deepEqual(rs.map((r) => r.s).sort(), [202, 409, 409], rs.map((r) => r.t).join(' | '));
  assert.equal(D.cmds.filter((c) => c.startsWith('run ')).length - runs, 1, 'Director 에 run 은 한 번');
  // B3 — 폴러 오류 원문(주소가 실린다)은 전체 범위 관리자만
  const svc = await import('../src/bareos/service.js');
  svc._setSessionFactoryForTest(async () => { const e = new Error('Director 에 연결하지 못했습니다: 10.1.2.3:9101 연결 거부'); e.code = 'connect'; throw e; });
  try {
    const s = await call('sadm', 'POST', '/poll');
    assert.equal(s.s, 200);
    assert.equal(s.j.poller.ok, false);
    assert.doesNotMatch(s.t, /10\.1\.2\.3/, '범위 관리자 응답에 Director 주소가 없다');
    const a = await call('admin', 'POST', '/poll');
    assert.match(a.j.poller.error, /10\.1\.2\.3/, '전체 범위 관리자는 원문을 본다');
  } finally { svc._setSessionFactoryForTest(null); }
});

test('⑩ v2.822 확정 결함: C3 동시 등록·원장 못 씀·원장 손상 · I3 reload 뒤 다시 끄기 · P5 취소로 추적 해제 · P4 복원 중 삭제 409 · C5 한 건 거부', async () => {
  store.snapshot.vms.push(
    { id: 'vc-a:vm-6', vcenterId: 'vc-a', name: 'app-06', powerState: 'POWERED_OFF', snapshotCount: 0, vcDcPath: 'DC-A', folderPath: '/app' },
    { id: 'vc-a:vm-7', vcenterId: 'vc-a', name: 'app-07', powerState: 'POWERED_OFF', snapshotCount: 0, vcDcPath: 'DC-A', folderPath: '/app' },
    { id: 'vc-a:vm-8', vcenterId: 'vc-a', name: 'app-08', powerState: 'POWERED_OFF', snapshotCount: 0, vcDcPath: 'DC-A', folderPath: '/app' },
  );
  const addsFor = (moref) => D.cmds.filter((c) => c.startsWith('configure add job') && new RegExp(`name=pv-[0-9a-f]+-${moref}(-r\\d)?\\b`).test(c)).length;
  // C3 — 같은 VM 을 동시에 두 번: Director 잡은 하나(예전에는 -r2 고아)
  const two = await Promise.all([call('admin', 'POST', '/jobs', { vcenterId: 'vc-a', vmId: 'vc-a:vm-6' }), call('admin', 'POST', '/jobs', { vcenterId: 'vc-a', vmId: 'vc-a:vm-6' })]);
  assert.deepEqual(two.map((r) => r.s).sort(), [201, two.find((r) => r.s !== 201).s].sort());
  assert.ok([400, 409].includes(two.find((r) => r.s !== 201).s), two.map((r) => r.t).join(' | '));
  assert.equal(addsFor('vm-6'), 1, 'configure add 는 한 번');
  const j6 = registry.findByVm('vc-a', 'vc-a:vm-6');

  // I3 — 비활성 대상·지운 대상의 잡이 Director reload 로 다시 켜지면 대조 틱이 다시 끈다
  assert.equal((await call('admin', 'PATCH', `/jobs/${j6.id}`, { enabled: false })).s, 200);
  const retired = registry.retiredNames().map((r) => r.name);
  assert.ok(retired.length >= 1, '⑤ 에서 지운 대상의 잡 이름이 남아 있다');
  for (const j of D.jobs.values()) j.enabled = true;   // Director reload — disable 은 conf 에 없어 다시 켜진다
  let p = await call('admin', 'POST', '/poll');
  assert.equal(p.j.poller.ok, true, p.t);
  assert.equal(D.jobs.get(j6.bareosJob).enabled, false, '비활성 대상을 다시 껐다');
  for (const n of retired) assert.equal(D.jobs.get(n).enabled, false, `지운 대상 ${n} 을 다시 껐다`);
  assert.ok(p.j.poller.redisabled >= 1 + retired.length);
  // I2-5(v2.822.3): `.jobs` 가 한 번 비어 오면(ACL·일시 오류) 지운 잡 기록을 지우지 않고, 대상을 '없음' 으로 칠하지도 않는다
  const keepRetired = registry.retiredNames().length;
  D.emptyJobs = true;
  await call('admin', 'POST', '/poll');
  D.emptyJobs = false;
  assert.equal(registry.retiredNames().length, keepRetired);
  assert.equal(registry.getJob(j6.id).missingInDirector, false);
  // C2-3(v2.822.3): 자동 설정의 reload 뒤 대조를 앞당긴다 — requestReconcile 이 정기 대조를 기다리지 않고 다시 끈다
  const poller = await import('../src/bareos/poller.js');
  // ① 폴러가 바쁠 때 요청하면 표시만 남기고 다음 정기 틱(대조 틱이 아니어도)에 대조한다
  poller._resetPollerForTest();
  await poller.pollOnce({ trigger: 'timer' });   // 틱 1 = 정기 대조
  for (const j of D.jobs.values()) j.enabled = true;
  registry.markPending(j6.id, { jobid: 990001, level: 'I', by: 't' });   // 할 일이 있어야 접속한다(붙잡을 명령)
  let rel; D.gate = new Promise((r) => { rel = r; }); D.gateFor = (c) => c === 'llist jobid=990001';
  const busyPoll = poller.pollOnce({ trigger: 'timer' });   // 틱 2 — 대조 틱이 아니다
  for (let i = 0; i < 100 && !poller.pollerStatus().busy; i++) await new Promise((r) => setTimeout(r, 10));
  poller.requestReconcile();   // 바쁘다 — 표시만
  rel(); D.gate = null; D.gateFor = null;
  const r2 = await busyPoll;
  assert.equal(r2.reconciled, false, '틱 2 는 대조하지 않았다');
  const r3 = await poller.pollOnce({ trigger: 'timer' });   // 틱 3 — 대조 틱이 아니지만 표시가 있다
  assert.equal(r3.reconciled, true, '표시가 있으면 다음 틱에 대조한다');
  assert.equal(D.jobs.get(j6.bareosJob).enabled, false);
  registry.clearPending(j6.id, 't');
  // ② 바쁘지 않으면 바로
  for (const j of D.jobs.values()) j.enabled = true;
  const disables = D.cmds.filter((c) => c.startsWith('disable job=')).length;
  poller.requestReconcile();
  for (let i = 0; i < 100 && D.cmds.filter((c) => c.startsWith('disable job=')).length === disables; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(D.cmds.filter((c) => c.startsWith('disable job=')).length > disables, '대조를 바로 돌려 다시 끈다');
  assert.equal(D.jobs.get(j6.bareosJob).enabled, false);
  for (let i = 0; i < 200 && poller.pollerStatus().busy; i++) await new Promise((r) => setTimeout(r, 20));   // 앞당긴 대조가 끝나기를

  D.jobs.delete(retired[0]);   // 관리자가 conf 를 지우고 reload
  await call('admin', 'POST', '/poll');
  assert.ok(!registry.retiredNames().some((r) => r.name === retired[0]), 'Director 에서 사라진 잡은 기록에서도 지운다');

  // P5 — Director 가 모르는 pending 은 취소로 추적만 내린다(예전에는 영구 409)
  registry.markPending(j6.id, { jobid: 777777, level: 'I', by: 't' });
  assert.equal((await call('admin', 'DELETE', `/jobs/${j6.id}`)).s, 409);
  const c = await call('admin', 'POST', `/jobs/${j6.id}/cancel`, {});
  assert.equal(c.s, 200, c.t);
  assert.equal(c.j.cleared, true);
  assert.equal(registry.getJob(j6.id).pending, null);
  assert.match(registry.getJob(j6.id).lastError.message, /777777/);
  assert.equal(D.cmds.filter((x) => x === 'cancel jobid=777777').length, 0, 'Director 에 없는 실행에 cancel 을 보내지 않는다');

  // P4 — 복원이 진행 중이면 삭제 409 · C5 — 그 복원의 llist 가 거부돼도 다른 대상의 갱신은 계속
  registry.addRestore(j6.id, { jobid: 888888, fromJobids: [100], mode: 'newVm', by: 't', client: 'kr-fd' });
  const del = await call('admin', 'DELETE', `/jobs/${j6.id}`);
  assert.equal(del.s, 409);
  assert.match(del.j.reason, /복원이 진행 중/);
  D.denyLlist = new Set([888888]);
  const j5 = registry.findByVm('vc-a', 'vc-a:vm-5');
  for (const r of D.runs.values()) if (r.name === j5.bareosJob) r.status = 'T';
  p = await call('admin', 'POST', '/poll');
  D.denyLlist = null;
  assert.equal(p.j.poller.ok, true, p.t);
  assert.ok(p.j.poller.itemErrors >= 1);
  assert.equal(registry.getJob(j5.id).pending, null, '한 건의 거부가 다른 대상의 갱신을 막지 않는다');

  // S3·I5 — 등록 뒤 이름이 바뀌면 목록에 drift · 덮어쓰기 복원은 OTP 를 쓰기 전에 400
  // v2.846(C-5): 목록 GET 은 memoJson(스냅샷 세대 열쇠) — 실제 수집은 새 스냅샷(새 generatedAt)을 만든다. 시험은 제자리로 고치므로 세대를 올린다
  const bumpSnap = () => { store.snapshot.generatedAt = (Number(store.snapshot.generatedAt) || Date.now()) + 1; };
  const vm6 = store.snapshot.vms.find((v) => v.id === 'vc-a:vm-6');
  vm6.name = 'app-06-old'; bumpSnap();
  const lst = await call('admin', 'GET', '');
  assert.deepEqual(lst.j.jobs.find((x) => x.id === j6.id).drift, ['이름']);
  vm6.name = 'app-06'; bumpSnap();
  assert.equal((await call('admin', 'GET', '')).j.jobs.find((x) => x.id === j6.id).drift, undefined);
  // v2.834 — 목록의 OS 는 지금 인벤토리 기준(등록 때 값을 원장에 굳히지 않는다)
  assert.equal((await call('admin', 'GET', '')).j.jobs.find((x) => x.id === j6.id).os, null);
  vm6.guestOS = 'Other 4.x or later Linux (64-bit)'; bumpSnap();
  const withOs = (await call('admin', 'GET', '')).j.jobs.find((x) => x.id === j6.id);
  assert.deepEqual([withOs.os, withOs.guestOS], ['linux', 'Other 4.x or later Linux (64-bit)']);
  delete vm6.guestOS;

  // I8 — 실제 원장에 남은 데모 대상: 실제 Director 에 run·enable 을 보내지 않고, 지우기는 원장에서만
  const dj = registry.addJob({ vcenterId: 'vc-a', vmId: 'vc-a:demo-1', vmName: 'demo-1', dc: 'DC-A', folder: '/', bareosJob: 'pv-demo-vm-1', client: 'kr-fd', storage: 'kr-sd', pool: 'P', demo: true });
  const before = D.cmds.length;
  assert.equal((await call('admin', 'POST', `/jobs/${dj.id}/run`, {})).s, 409);
  assert.equal((await call('admin', 'PATCH', `/jobs/${dj.id}`, { enabled: false })).s, 409);
  const dd = await call('admin', 'DELETE', `/jobs/${dj.id}`);
  assert.equal(dd.s, 200, dd.t);
  assert.match(dd.j.note, /원장에서만/);
  assert.equal(D.cmds.slice(before).filter((x) => x.includes('pv-demo-vm-1')).length, 0, '실제 Director 에 데모 잡 명령을 보내지 않는다');

  // C2-14(v2.822.3): 활성 전환·취소도 대상마다 한 번에 하나 — 삭제와 겹치면 Director 잡이 켜진 채 원장에서 사라졌다
  store.snapshot.vms.push({ id: 'vc-a:vm-10', vcenterId: 'vc-a', name: 'app-10', powerState: 'POWERED_OFF', snapshotCount: 0, vcDcPath: 'DC-A', folderPath: '/app' });
  assert.equal((await call('admin', 'POST', '/jobs', { vcenterId: 'vc-a', vmId: 'vc-a:vm-10' })).s, 201);
  const j10 = registry.findByVm('vc-a', 'vc-a:vm-10');
  // 삭제가 Director 의 disable 에서 붙잡혀 있는 동안(잠금을 쥔 채) PATCH 가 오면 409 — 잠금이 없으면 PATCH 가 잡을 켠 뒤 삭제가 원장을 지웠다
  let release; D.gate = new Promise((r) => { release = r; }); D.gateFor = (c) => c.startsWith(`disable job=${j10.bareosJob}`);
  const del10 = call('admin', 'DELETE', `/jobs/${j10.id}`);
  for (let i = 0; i < 100 && !D.cmds.includes(`disable job=${j10.bareosJob}`); i++) await new Promise((r) => setTimeout(r, 20));
  const pt = await call('admin', 'PATCH', `/jobs/${j10.id}`, { enabled: true });
  release(); D.gate = null; D.gateFor = null;
  assert.equal(pt.s, 409, pt.t);
  assert.equal((await del10).s, 200);
  assert.equal(D.jobs.get(j10.bareosJob).enabled, false, '지운 대상의 Director 잡은 꺼진 채');
  assert.equal(D.cmds.filter((c) => c === `enable job=${j10.bareosJob}`).length, 0, 'PATCH 는 Director 에 닿지 않았다');

  // C3 — 원장 파일을 못 쓰면 만든 Director 잡을 끄고 이름을 밝힌다 · 메모리에도 남기지 않는다
  const file = path.join(tmp, 'bareos-jobs.json');
  const saved = fs.readFileSync(file);
  fs.rmSync(file); fs.mkdirSync(file); fs.writeFileSync(path.join(file, 'x'), '');   // rename 이 실패하는 자리
  const w = await call('admin', 'POST', '/jobs', { vcenterId: 'vc-a', vmId: 'vc-a:vm-7' });
  fs.rmSync(file, { recursive: true }); fs.writeFileSync(file, saved);
  assert.equal(w.s, 500, w.t);
  assert.match(w.j.reason, /원장에 넣지 못했습니다/);
  assert.match(w.j.reason, /비활성화했습니다/);
  const orphan = [...D.jobs.keys()].find((n) => /-vm-7$/.test(n));
  assert.equal(D.jobs.get(orphan).enabled, false, '고아 잡은 꺼 둔다');
  assert.equal(registry.findByVm('vc-a', 'vc-a:vm-7'), null, '파일에 못 쓴 대상은 메모리에도 없다');

  // C3 — 원장을 못 읽은 상태(손상)면 Director 에 닿기 전에 503
  fs.writeFileSync(file, '{ broken');
  registry._resetForTest();
  const conns = fd.identities.length;
  const r = await call('admin', 'POST', '/jobs', { vcenterId: 'vc-a', vmId: 'vc-a:vm-8' });
  assert.equal(r.s, 503, r.t);
  assert.equal(fd.identities.length, conns, 'Director 에 접속하지 않았다');
  assert.equal(addsFor('vm-8'), 0);

  // S2 — 로드 오류 원문(JSON.parse 가 파일 조각을 싣는다 — 손상된 비밀번호 조각)을 응답에 싣지 않는다
  fs.writeFileSync(file, '{"jobs": [], "x": Sup3rS3cretLeak}');
  registry._resetForTest();
  for (const u of ['admin', 'sadm', 'demo']) {
    const g = await call(u, 'GET', '');
    assert.equal(g.s, 200, u);
    assert.ok(g.j.registryLoadError, u);
    assert.doesNotMatch(g.t, /Sup3rS3cret/, `${u}: 원문 조각이 없다`);
  }
  assert.match((await call('admin', 'GET', '')).j.registryLoadError.reason, /JSON 형식 오류/);
  assert.equal((await call('sadm', 'GET', '')).j.registryLoadError.reasonDetailHidden, true);
});
