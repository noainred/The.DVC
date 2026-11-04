/**
 * test/bareosRestoreBulkRoutes2861.test.js — v2.861 묶음 복원 라우트(실제 routes/api.js · AUTH_ENABLED=true · TLS-PSK 가짜 Director).
 *  ① 복원 지점 묶음: 세션 하나로 VM 마다 성공 백업 + 체인 길이 · 범위 밖 항목은 '찾을 수 없음'(존재를 흘리지 않는다)
 *  ② 미리 보기: Director 에 닿지 않는다 · OTP 를 쓰지 않는다 · 덮어쓰기 2대 이상 거부 · 데이터스토어 여유
 *  ③ 실행 순서: OTP 미등록 403 → 조회 밖 404 → 쓰기 밖 403 → 판정 400(OTP 를 태우지 않는다) → 틀린 OTP 403 → 202
 *     restore 명령은 VM 마다 jobid 체인 + powerstate off(select 없음) · 원장 restores 에 batchId · nic · 감사 · 진행 중이면 다시 거부
 *  ④ 복원이 끝나면(폴러) 새 VM 의 NIC 끊기 마무리가 원장에 남는다(데모 vmclone 경로)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareosbulkroutes-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
process.env.SSRF_ALLOW_LOOPBACK = 'true';

const { generateSecret, generateToken } = await import('../src/auth/totp.js');
const SECRET = generateSecret();
fs.writeFileSync(path.join(tmp, 'users.json'), JSON.stringify({ users: [
  { username: 'adm', role: 'admin', totpEnabled: true, totpSecret: SECRET },
  { username: 'noot', role: 'admin' },
  { username: 'sadm', role: 'admin', totpEnabled: true, totpSecret: SECRET },
  { username: 'wadm', role: 'admin', totpEnabled: true, totpSecret: SECRET },
  { username: 'adm2', role: 'admin', totpEnabled: true, totpSecret: SECRET },
] }));

const { startFakeDirector } = await import('./_fakeBareosDirector.js');
const D = { jobs: new Map(), runs: new Map(), nextId: 500, cmds: [] };
const OFF = new Map();
const HIST = (name) => { const o = OFF.get(name) ?? 0; return [
  { jobid: 100 + o, name, type: 'B', level: 'F', jobstatus: 'T', starttime: '2026-10-20 02:00:00', endtime: '2026-10-20 02:40:00', jobbytes: 1000 },
  { jobid: 110 + o, name, type: 'B', level: 'I', jobstatus: 'T', starttime: '2026-10-21 02:00:00', endtime: '2026-10-21 02:05:00', jobbytes: 10 },
  { jobid: 120 + o, name, type: 'B', level: 'I', jobstatus: 'f', starttime: '2026-10-22 02:00:00', endtime: '2026-10-22 02:01:00', jobbytes: 0 },
  { jobid: 130 + o, name, type: 'B', level: 'I', jobstatus: 'T', starttime: '2026-10-23 02:00:00', endtime: '2026-10-23 02:05:00', jobbytes: 12 },
]; };
async function handle(cmd) {
  D.cmds.push(cmd);
  const kv = Object.fromEntries([...cmd.matchAll(/(\w+)=("(?:\\.|[^"])*"|\S+)/g)].map((m) => [m[1], m[2]]));
  if (cmd === '.clients') return { clients: [{ name: 'kr-fd' }] };
  if (cmd === '.jobs') return { jobs: [...D.jobs].map(([name]) => ({ name, enabled: true })) };
  if (cmd.startsWith('configure add job')) { D.jobs.set(kv.name, {}); OFF.set(kv.name, OFF.size * 1000); return { add: { resource: 'Job', name: kv.name } }; }
  if (cmd.startsWith('restore ')) { const id = D.nextId++; D.runs.set(id, { name: 'PortalVmwareRestore', status: 'C', type: 'R' }); return { run: { jobid: id } }; }
  if (cmd.startsWith('llist jobid=')) {
    const id = Number(kv.jobid);
    const r = D.runs.get(id);
    if (r) return { jobs: [{ jobid: id, name: r.name, type: r.type, level: 'F', jobstatus: r.status, starttime: '2026-10-29 02:00:00', endtime: r.status === 'T' ? '2026-10-29 02:10:00' : '' }] };
    for (const n of D.jobs.keys()) { const h = HIST(n).find((x) => x.jobid === id); if (h) return { jobs: [h] }; }
    return { jobs: [] };
  }
  if (cmd.startsWith('list jobs job=')) return { jobs: HIST(kv.job) };
  if (cmd.startsWith('list jobs days=')) return { jobs: [] };
  return { error: [`unknown command ${cmd}`] };
}

let srv, base, fd, store, registry;
const USERS = {
  admin: { username: 'adm', role: 'admin', scope: null },
  noot: { username: 'noot', role: 'admin', scope: null },
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-a'] } },
  wadm: { username: 'wadm', role: 'admin', scope: { writeVcenters: ['vc-a'] } },
  adm2: { username: 'adm2', role: 'admin', scope: null },
};
// 404 · 403 · 400 은 OTP 검사 전에 끝난다 — 그 호출에는 아무 값이나. 실제 토큰은 지금 시각 하나(시간창 ±1 안)
const otpNow = () => generateToken(SECRET, { counter: Math.floor(Date.now() / 30_000) });

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
    datastores: [{ id: 'vc-a:ds-1', vcenterId: 'vc-a', name: 'ds-a1', freeGB: 5000, capacityGB: 10000 }, { id: 'vc-a:ds-2', vcenterId: 'vc-a', name: 'ds-tight', freeGB: 300, capacityGB: 1000 }],
    vms: [
      { id: 'vc-a:vm-1', vcenterId: 'vc-a', name: 'web-01', powerState: 'POWERED_ON', snapshotCount: 0, vcDcPath: 'DC-A', folderPath: '/web', storageGB: 200, dev: { disks: [{ datastore: 'ds-a1' }] } },   // 홈 DS(검증 여유 판정 — v2.862)
      { id: 'vc-a:vm-5', vcenterId: 'vc-a', name: 'app-05', powerState: 'POWERED_OFF', snapshotCount: 0, vcDcPath: 'DC-A', folderPath: '/app', storageGB: 150 },
      { id: 'vc-b:vm-9', vcenterId: 'vc-b', name: 'db-09', powerState: 'POWERED_ON', snapshotCount: 0, vcDcPath: 'DC-B', folderPath: '/', storageGB: 50 },
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

const ID = {};
test('준비: Director · 매핑 · 대상 3대(vc-a 2 · vc-b 1)', async () => {
  let r = await call('admin', 'POST', '/settings/directors', { name: '한국', host: '127.0.0.1', port: fd.port, consoleName: 'portal', password: 'pw-1', timeoutMs: 5000 });
  assert.equal(r.s, 201, r.t);
  const DIR = r.j.director.id;
  ID.dir = DIR;
  r = await call('admin', 'PUT', '/settings', { sites: [
    { vcenterId: 'vc-a', directorId: DIR, vcserver: 'vc-a.corp', client: 'kr-fd', storage: 'kr-sd', pool: 'VMwareKR', configFile: '/etc/bareos/vmware/vc-a.ini' },
    { vcenterId: 'vc-b', directorId: DIR, vcserver: 'vc-b.corp', client: 'kr-fd', storage: 'kr-sd', pool: 'VMwareKR', configFile: '/etc/bareos/vmware/vc-b.ini' },
  ] });
  assert.equal(r.s, 200, r.t);
  for (const [k, vc, vm] of [['web', 'vc-a', 'vc-a:vm-1'], ['app', 'vc-a', 'vc-a:vm-5'], ['db', 'vc-b', 'vc-b:vm-9']]) {
    r = await call('admin', 'POST', '/jobs', { vcenterId: vc, vmId: vm });
    assert.equal(r.s, 201, r.t);
    ID[k] = r.j.job.id;
  }
});

const job = (k) => registry.getJob(ID[k]);
const H = (k, j) => (OFF.get(job(k).bareosJob) ?? 0) + j;

test('① 복원 지점 묶음 — 세션 하나 · 성공 백업 + 체인 길이 · 범위 밖은 찾을 수 없음', async () => {
  const before = D.cmds.length;
  let r = await call('admin', 'POST', '/restore-points/bulk', { ids: [ID.web, ID.app] });
  assert.equal(r.s, 200, r.t);
  const [w, a] = r.j.items;
  assert.equal(w.ok, true);
  assert.deepEqual(w.points.map((p) => [p.jobid, p.chain]), [[H('web', 130), 3], [H('web', 110), 2], [H('web', 100), 1]]);
  assert.equal(a.points[0].jobid, H('app', 130));
  assert.equal(D.cmds.slice(before).filter((c) => c.startsWith('list jobs job=')).length, 2);
  r = await call('sadm', 'POST', '/restore-points/bulk', { ids: [ID.web, ID.db, 'nope'] });
  assert.equal(r.s, 200);
  assert.deepEqual(r.j.items.map((x) => x.ok), [true, false, false]);
  assert.equal(r.j.items[1].reason, r.j.items[2].reason, '범위 밖과 없는 대상은 같은 답');
  assert.equal(r.j.items[1].vmName, undefined, '범위 밖 VM 이름을 싣지 않는다');
  assert.equal((await call('admin', 'POST', '/restore-points/bulk', { ids: [] })).s, 400);
});

test('② 미리 보기 — Director 에 닿지 않고 OTP 를 쓰지 않는다 · 덮어쓰기 2대 거부 · 여유 부족', async () => {
  const before = D.cmds.length;
  let r = await call('admin', 'POST', '/restore-check/bulk', { items: [
    { id: ID.web, jobid: H('web', 130), mode: 'newVm', newVm: { name: 'web-01-r', datastore: 'ds-tight' } },
    { id: ID.app, jobid: H('app', 130), mode: 'newVm', newVm: { name: 'app-05-r', datastore: 'ds-tight' } },
  ] });
  assert.equal(r.s, 200, r.t);
  assert.equal(r.j.plan.ok, false);
  assert.equal(r.j.plan.capacity[0].verdict, 'short');
  assert.doesNotMatch(r.t, /pluginOptions|python3:/, '내부 플러그인 옵션은 싣지 않는다');
  r = await call('admin', 'POST', '/restore-check/bulk', { items: [
    { id: ID.web, jobid: H('web', 130), mode: 'original', confirmName: 'web-01' },
    { id: ID.app, jobid: H('app', 130), mode: 'newVm', newVm: { name: 'app-05-r' } },
  ] });
  assert.match(r.j.plan.items[0].issue, /1대씩/);
  r = await call('admin', 'POST', '/restore-check/bulk', { items: [
    { id: ID.web, jobid: H('web', 130), mode: 'newVm', newVm: { name: 'web-01-r', datastore: 'ds-a1' } },
    { id: ID.app, jobid: H('app', 130), mode: 'localVmdk' },
  ] });
  assert.equal(r.j.plan.ok, true, r.t);
  assert.deepEqual(r.j.plan.items.map((x) => x.nic), ['disconnect', null]);
  assert.equal(D.cmds.length, before, 'Director 명령 0');
  // 상한은 항목을 돌기 전에(반증 L2) — 판정 문구는 같은 상한
  r = await call('admin', 'POST', '/restore-check/bulk', { items: Array.from({ length: 60 }, (_, i) => ({ id: ID.web, jobid: 1, mode: 'newVm', newVm: { name: `n${i}` } })) });
  assert.match(r.j.plan.issue, /50대까지/);
});

test('③ 실행 — OTP 미등록 403 · 조회 밖 404 · 쓰기 밖 403 · 판정 400 은 OTP 를 태우지 않는다 · 202 · 원장 · 진행 중 거부', async () => {
  const items = [
    { id: ID.web, jobid: H('web', 130), mode: 'newVm', newVm: { name: 'web-01-r', datastore: 'ds-a1' } },
    { id: ID.app, jobid: H('app', 130), mode: 'newVm', newVm: { name: 'app-05-r' }, nic: 'keep' },
  ];
  assert.equal((await call('noot', 'POST', '/restore/bulk', { items })).j.needEnroll, true);
  assert.equal((await call('sadm', 'POST', '/restore/bulk', { items: [...items, { id: ID.db, jobid: H('db', 130), mode: 'newVm', newVm: { name: 'db-r' } }], otp: 'x' })).s, 404);
  // 쓰기 범위 밖은 **올바른 OTP 여도** 403(사유 = 조회 전용) — 틀린 OTP 의 403 과 섞이지 않게(변이 M13)
  const wDenied = await call('wadm', 'POST', '/restore/bulk', { items: [{ id: ID.db, jobid: H('db', 130), mode: 'newVm', newVm: { name: 'db-r' } }], otp: otpNow() });
  assert.equal(wDenied.s, 403);
  assert.match(wDenied.j.reason, /조회 전용/);
  const wc = await call('wadm', 'POST', '/restore-check/bulk', { items: [{ id: ID.db, jobid: H('db', 130), mode: 'newVm', newVm: { name: 'db-r' } }] });
  assert.match(wc.j.plan.items[0].issue, /조회 전용/);
  const t1 = otpNow();
  let r = await call('admin', 'POST', '/restore/bulk', { items: [items[0], { ...items[1], newVm: { name: 'WEB-01-R' } }], otp: t1 });
  assert.equal(r.s, 400, '묶음 안 이름 겹침');
  assert.match(r.j.plan.items[1].issue, /겹칩니다/);
  assert.equal((await call('admin', 'POST', '/restore/bulk', { items, otp: '000000' })).s, 403);
  const before = D.cmds.length;
  r = await call('admin', 'POST', '/restore/bulk', { items, otp: t1 });   // 판정 400 은 t1 을 쓰지 않았다
  assert.equal(r.s, 202, r.t);
  assert.equal(r.j.started, 2);
  assert.match(r.j.batchId, /^rb-/);
  const cmds = D.cmds.slice(before).filter((c) => c.startsWith('restore '));
  assert.equal(cmds.length, 2);
  assert.match(cmds[0], new RegExp(`jobid=${H('web', 100)},${H('web', 110)},${H('web', 130)} restorejob=PortalVmwareRestore pluginoptions="\\\\"python3:vcserver=vc-a.corp:dc=DC-A:folder=/web:vmname=web-01-r:config_file=/etc/bareos/vmware/vc-a.ini:restore_powerstate=off:restore_datastore=ds-a1\\\\"" all done yes$`));   // v2.874 B1-01
  assert.ok(cmds.every((c) => !/\bselect\b/.test(c)));
  const wr = job('web').restores[0];
  assert.deepEqual([wr.batchId, wr.nic, wr.mode, wr.target.name], [r.j.batchId, 'disconnect', 'newVm', 'web-01-r']);
  assert.equal(job('app').restores[0].nic, 'keep');
  const { listAudit } = await import('../src/audit.js');
  assert.ok(listAudit({ limit: 20, q: r.j.batchId }).items.length >= 3, '항목마다 + 묶음 한 줄');
  r = await call('admin', 'POST', '/restore/bulk', { items: [items[0]], otp: 'x' });
  assert.equal(r.s, 400);
  assert.match(r.j.plan.items[0].issue, /진행 중/);
});

test('④ 복원이 끝나면 새 VM 의 NIC 끊기 마무리 — 끊기를 고른 복원만', async () => {
  for (const k of ['web', 'app']) D.runs.get(job(k).restores[0].jobid).status = 'T';
  await call('admin', 'POST', '/poll');
  assert.equal(job('web').restores[0].state, 'ok');
  for (let i = 0; i < 40 && job('web').restores[0].finish?.nic !== 'ok'; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(job('web').restores[0].finish?.nic, 'ok', JSON.stringify(job('web').restores[0].finish));
  assert.equal(job('app').restores[0].finish, undefined, 'nic=keep 은 손대지 않는다');
  // 끝난 뒤에도 하루 동안 그 이름은 예약(다음 인벤토리 수집 전 같은 이름 VM 이 둘이 되지 않게)
  const r = await call('admin', 'POST', '/restore-check/bulk', { items: [{ id: ID.app, jobid: H('app', 130), mode: 'newVm', newVm: { name: 'WEB-01-R' } }] });
  assert.match(r.j.plan.items[0].issue, /최근 복원이/);
});

test('⑤ v2.862 복원 검증 · 일일 요약 — 전체 범위 · OTP · 입력 확인을 OTP 앞에서 · 검증 회차 = 새 VM(꺼진 채) · 결과가 원장에', async () => {
  // 정책: 범위 계정 403 · 틀린 값 400(OTP 를 쓰기 전) · 저장 200
  // 범위 계정은 **올바른 OTP 여도** 403(사유 = 전체 범위) — 틀린 OTP 의 403 과 섞이지 않게(변이 C11)
  const sDenied = await call('sadm', 'PUT', '/rehearsal', { enabled: true, otp: otpNow() });
  assert.equal(sDenied.s, 403);
  assert.match(sDenied.j.reason, /전체 범위/);
  let r = await call('admin', 'PUT', '/rehearsal', { enabled: true, weekday: 9, otp: 'x' });
  assert.equal(r.s, 400);
  assert.equal((await call('admin', 'PUT', '/rehearsal', { enabled: true, otp: '000000' })).s, 403);
  r = await call('adm2', 'PUT', '/rehearsal', { enabled: false, weekday: 6, time: '03:17', perCorp: 2, deleteOnOk: true, datastores: { 'vc-b': 'ds-secret-warsaw' }, otp: otpNow() });
  assert.equal(r.s, 200, r.t);
  // 지금 검증: 마지막 백업이 성공한 대상만 — web 만 성공 처리
  registry.patchJob(ID.web, { lastRun: { jobid: H('web', 130), state: 'ok', status: 'T', endedAt: Date.now() } });
  assert.equal((await call('admin', 'POST', '/rehearsal/run', { directorId: ID.dir, otp: '000000' })).s, 403, '지금 검증도 본인 OTP');
  assert.equal((await call('admin', 'POST', '/rehearsal/run', { directorId: 'nope', otp: 'x' })).s, 404);
  const before = D.cmds.length;
  r = await call('admin', 'POST', '/rehearsal/run', { directorId: ID.dir, otp: generateToken(SECRET, { counter: Math.floor(Date.now() / 30_000) + 1 }) });
  assert.equal(r.s, 202, r.t);
  assert.equal(r.j.started, 1);
  const cmd = D.cmds.slice(before).find((c) => c.startsWith('restore '));
  assert.match(cmd, /pluginoptions="\\"python3:vcserver=vc-a\.corp:dc=DC-A:folder=\/web:vmname=web-01-verify-\d{8}:config_file=\/etc\/bareos\/vmware\/vc-a\.ini:restore_powerstate=off\\""/, '새 VM · 꺼진 채 · 날짜 이름');
  const rr = job('web').restores[0];
  assert.deepEqual([rr.verify, rr.nic, rr.mode, !!rr.rehearsal], [true, 'disconnect', 'newVm', true]);
  // 복원이 끝나면 bareos-verify(데모 경로) — 결과가 원장 finish 에
  D.runs.get(rr.jobid).status = 'T';
  await call('admin', 'POST', '/poll');
  for (let i = 0; i < 50 && !['ok', 'failed'].includes(job('web').restores[0].finish?.verify); i++) await new Promise((res) => setTimeout(res, 100));
  assert.ok(['ok', 'failed'].includes(job('web').restores[0].finish?.verify), JSON.stringify(job('web').restores[0].finish));
  // 회차는 보내기 전에 기록 — 같은 날 다시 돌지 않는다(정기 틱의 dueOf 가 본다)
  const ga = await call('admin', 'GET', '/rehearsal');
  assert.match(ga.j.weeks[ID.dir] || '', /^\d{4}-\d{2}-\d{2}$/);
  // 결과 목록: 범위 계정은 자기 법인만(web 은 vc-a)
  const g = await call('sadm', 'GET', '/rehearsal');
  assert.equal(g.s, 200);
  assert.ok(g.j.results.every((x) => x.vcenterId === 'vc-a'));
  // 반증 F1: 범위 밖 vCenter 의 정책 DS · 저장한 계정 · 회차 항목을 싣지 않는다
  assert.doesNotMatch(g.t, /ds-secret-warsaw|db-09/);
  assert.equal(g.j.policy.savedBy, '');
  assert.ok(g.j.runs.every((x) => (x.items || []).every((it) => it.jobId !== ID.db)));
  assert.match((await call('admin', 'GET', '/rehearsal')).t, /ds-secret-warsaw/, '전체 범위 관리자는 본다');
  // v2.863 정책 화면의 vCenter 별 데이터스토어 칸 — 활성 대상이 있는 vCenter 목록(전체 범위만 · 범위 계정에는 없다)
  const gv = (await call('admin', 'GET', '/rehearsal')).j.vcenters;
  assert.ok(Array.isArray(gv) && gv.some((v) => v.id === 'vc-a' && v.jobs >= 1), JSON.stringify(gv));
  assert.equal(g.j.vcenters, undefined, '범위 계정에는 vCenter 목록을 싣지 않는다(정책 편집은 전체 범위 전용)');
  assert.equal(g.j.results[0].jobId, ID.web);
  // 일일 요약: 범위 계정 403 · 틀린 시각 400 · 저장
  assert.equal((await call('sadm', 'GET', '/digest')).s, 403);
  assert.equal((await call('admin', 'PUT', '/digest', { time: '8:3' })).s, 400);
  r = await call('admin', 'PUT', '/digest', { enabled: true, time: '08:31' });
  assert.deepEqual([r.s, r.j.config.time], [200, '08:31']);
  // v2.870 감사 A3-03: '지금 보내 보기' 도 쓰기 범위 무제한만 — 거부 사유가 fullWriteOnly 의 것인지(다른 게이트의 403 으로 통과하지 않게 · audits.md 교훈)
  const ws = await call('wadm', 'POST', '/digest/send', {});
  assert.equal(ws.s, 403, ws.t);
  assert.match(ws.j.reason, /쓰기 범위\(수정 가능 vCenter\)가 지정되지 않은 계정만/);
});

test('⑥ v2.866 복원 › 폴더 표 — 목록에 전원 · 용량 · 마지막 성공 · 폴더 VM 수는 조회 범위 안 vCenter 만', async () => {
  const { lastOkOf, restoreFolderCounts } = await import('../src/routes/api/bareosBackup.js');
  // 마지막 성공: 성공 · 경고만 · 가장 늦은 끝(없으면 시작) · 없으면 null(포탈 기록에 없음)
  assert.deepEqual(lastOkOf({ jobid: 5, state: 'error', level: 'I', endedAt: 900 }, [{ jobid: 3, state: 'ok', level: 'F', endedAt: 500 }, { jobid: 4, state: 'warning', level: 'I', startedAt: 700 }]), { at: 700, level: 'I', jobid: 4 });
  assert.equal(lastOkOf(null, []), null);
  assert.equal(lastOkOf({ state: 'ok', endedAt: 0 }, null), null, '시각을 모르는 성공은 시각을 지어내지 않는다');
  // 폴더 VM 수: 대상이 있는 vCenter 만 · 템플릿 제외
  const cnt = restoreFolderCounts([{ vcenterId: 'vc-a' }], [
    { vcenterId: 'vc-a', vcDcPath: 'DC', folderPath: '/x' }, { vcenterId: 'vc-a', vcDcPath: 'DC', folderPath: '/x' },
    { vcenterId: 'vc-a', vcDcPath: 'DC', folderPath: '/x', template: true }, { vcenterId: 'vc-z', vcDcPath: 'DC', folderPath: '/x' },
  ]);
  assert.deepEqual(cnt, [{ vcenterId: 'vc-a', dc: 'DC', folder: '/x', vms: 2 }]);
  // 목록: finishedRuns 원문은 싣지 않고 lastOk 만 · 전원 · 용량(인벤토리)
  const list = await call('admin', 'GET', '');
  assert.equal(list.s, 200, list.t);
  const web = list.j.jobs.find((j) => j.id === ID.web);
  assert.deepEqual([web.powerState, web.storageGB], ['POWERED_ON', 200]);
  assert.ok('lastOk' in web);
  assert.ok(list.j.jobs.every((j) => !('finishedRuns' in j)));
  // 폴더 수: 전체 범위는 두 vCenter · 범위 계정은 자기 vCenter 만(다른 vCenter 의 이름 · 폴더를 싣지 않는다)
  const a = await call('admin', 'GET', '/restore-folders');
  assert.equal(a.s, 200, a.t);
  assert.deepEqual(a.j.folders.map((f) => `${f.vcenterId}${f.folder}:${f.vms}`).sort(), ['vc-a/app:1', 'vc-a/web:1', 'vc-b/:1']);
  assert.equal(a.j.vcNames['vc-b'], 'Warsaw');
  const s = await call('sadm', 'GET', '/restore-folders');
  assert.equal(s.s, 200, s.t);
  assert.ok(s.j.folders.every((f) => f.vcenterId === 'vc-a'));
  assert.doesNotMatch(s.t, /Warsaw|vc-b/);
});
