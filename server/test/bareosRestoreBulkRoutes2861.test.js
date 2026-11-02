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
      { id: 'vc-a:vm-1', vcenterId: 'vc-a', name: 'web-01', powerState: 'POWERED_ON', snapshotCount: 0, vcDcPath: 'DC-A', folderPath: '/web', storageGB: 200 },
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
  assert.match(cmds[0], new RegExp(`jobid=${H('web', 100)},${H('web', 110)},${H('web', 130)} restorejob=PortalVmwareRestore pluginoptions="python3:vmname=web-01-r:restore_powerstate=off:restore_datastore=ds-a1" all done yes$`));
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
});
