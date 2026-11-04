/**
 * test/bareosDr1.test.js — 재해 복구 1차(시안 ② 'vCenter 를 다시 설치한 뒤 법인째 되살리기' · 사용자 결정 '두 번에 나눠' · ② 표준).
 *  ① restorePlan 새 VM 의 데이터센터 바꾸기(dc) — 인벤토리에 있는 이름만 · 클러스터는 그 데이터센터 안 · 복원 명령의 dc 만 바뀌고 폴더는 백업 때 경로
 *  ② drItemIssue — 새 VM · 네트워크 끊은 채 · 클러스터(또는 호스트) — 서버가 지킨다(화면이 아니라)
 *  ③ drCheckView — 다시 설치된 vCenter(VM 0 · 호스트 있음) · 매핑 빠짐 · Director 조회 상태 · 포탈이 모르는 것은 'unknown'
 *  ④ 라우트: dr 묶음은 규칙 위반을 Director 에 닿기 전에 400 · 지킨 묶음은 dc · restore_cluster 를 싣고 202 · 복원 지점마다 백업 때 위치(at) · dr/check 범위 밖 404
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareosdr1-'));
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
const DROP = { on: false };
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
  if (cmd.startsWith('restore ') && DROP.on) throw new Error('drop');   // 명령을 받은 뒤 끊는다(결과 모름)
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
    hosts: [{ id: 'vc-a:host-1', vcenterId: 'vc-a', name: 'esx-a1', cluster: 'CL-A', vcDatacenter: 'DC-NEW' }, { id: 'vc-a:host-2', vcenterId: 'vc-a', name: 'esx-a2', cluster: 'CL-B', vcDatacenter: 'DC-NEW' }],
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



const { restorePlan } = await import('../src/bareos/restore.js');
const { drItemIssue, drCheckView } = await import('../src/bareos/drPlan.js');

test('① 새 VM 데이터센터 바꾸기 — 인벤토리 이름만 · 클러스터는 그 데이터센터 안 · 폴더는 백업 때 경로', () => {
  const job = { vcenterId: 'vc-a', vmId: 'vc-a:vm-old', vmName: 'web-01', dc: 'DC-OLD', folder: '/web' };
  const snap = { vms: [], datastores: [], hosts: [{ vcenterId: 'vc-a', name: 'esx-1', cluster: 'CL-A', vcDatacenter: 'DC-NEW' }, { vcenterId: 'vc-a', name: 'esx-9', cluster: 'CL-Z', vcDatacenter: 'DC-OTHER' }] };
  const base = { vcserver: 'vc-a.corp', configFile: '/etc/bareos/vmware/vc-a.ini' };
  const p = restorePlan({ mode: 'newVm', job, snapshot: snap, newVm: { name: 'web-01', dc: 'DC-NEW', cluster: 'CL-A' }, base });
  assert.equal(p.ok, true, p.issue);
  assert.match(p.pluginOptions, /:dc=DC-NEW:folder=\/web:vmname=web-01:/);
  assert.match(p.pluginOptions, /restore_cluster=CL-A/);
  assert.deepEqual([p.target.dc, p.target.cluster], ['DC-NEW', 'CL-A']);
  assert.match(restorePlan({ mode: 'newVm', job, snapshot: snap, newVm: { name: 'web-01', dc: 'DC-NOPE' }, base }).issue, /데이터센터 ‘DC-NOPE’/);
  assert.match(restorePlan({ mode: 'newVm', job, snapshot: snap, newVm: { name: 'web-01', dc: 'DC-NEW', cluster: 'CL-Z' }, base }).issue, /데이터센터 ‘DC-NEW’/, '다른 데이터센터의 클러스터는 거부');
  // 바꾸지 않으면 백업 때 데이터센터 그대로(예전 동작)
  assert.match(restorePlan({ mode: 'newVm', job, snapshot: snap, newVm: { name: 'web-01-r' }, base }).pluginOptions, /:dc=DC-OLD:/);
});

test('② 재해 복구 묶음 규칙 — 새 VM · 끊은 채 · 클러스터', () => {
  const ok = { mode: 'newVm', nic: 'disconnect', plan: { target: { cluster: 'CL-A' } } };
  assert.equal(drItemIssue(ok), '');
  assert.equal(drItemIssue({ ...ok, plan: { target: { esxHost: 'esx-1' } } }), '');
  assert.match(drItemIssue({ ...ok, nic: 'keep' }), /끊은 채/);
  assert.match(drItemIssue({ ...ok, mode: 'original' }), /새 VM/);
  assert.match(drItemIssue({ ...ok, plan: { target: {} } }), /클러스터/);
});

test('③ 새 vCenter 점검 — 다시 설치됨 · 매핑 빠짐 · 조회 상태 · 모르는 것은 unknown', () => {
  const snap = { vcenters: [{ id: 'vc-a', name: 'NJ' }], vms: [], hosts: [{ vcenterId: 'vc-a', cluster: 'CL-A', vcDatacenter: 'DC-NEW' }, { vcenterId: 'vc-a', cluster: 'CL-A', vcDatacenter: 'DC-NEW' }],
    datastores: [{ vcenterId: 'vc-a', name: 'ds-1', freeGB: 100, capacityGB: 200 }, { vcenterId: 'vc-a', name: 'ds-x', freeGB: '', capacityGB: null }] };
  const jobs = [{ vcenterId: 'vc-a', vmId: 'vc-a:vm-1', lastRun: null }, { vcenterId: 'vc-a', vmId: 'vc-a:vm-2', lastRun: null }, { vcenterId: 'vc-b', vmId: 'vc-b:vm-9' }];
  const site = { vcserver: 'vc-a.corp', configFile: '/x.ini', client: 'kr-fd' };
  const v = drCheckView({ vcenterId: 'vc-a', snapshot: snap, jobs, site, director: { id: 'D1', name: '한국' }, dirPoll: { ok: true, at: 1 }, lastOkOf: () => null });
  const by = Object.fromEntries(v.checks.map((c) => [c.key, c]));
  assert.equal(by.director.state, 'ok');
  assert.equal(by.vcenter.state, 'ok');
  assert.match(by.vcenter.detail, /다시 설치됨/);
  assert.deepEqual([by.fdIni.state, by.perm.state], ['unknown', 'unknown'], '포탈이 읽지 못하는 것은 단정하지 않는다');
  assert.deepEqual(v.targets.dcs, ['DC-NEW']);
  assert.deepEqual(v.targets.clusters, [{ name: 'CL-A', dc: 'DC-NEW' }], '같은 클러스터 호스트는 하나로');
  assert.deepEqual(v.targets.datastores.map((d) => [d.name, d.freeGB]), [['ds-1', 100], ['ds-x', null]], "못 읽은 여유는 null('' 을 0 으로 보지 않는다)");
  assert.deepEqual([v.counts.jobs, v.counts.missing], [2, 2]);
  const b = drCheckView({ vcenterId: 'vc-a', snapshot: snap, jobs, site: { vcserver: 'vc-a.corp' }, director: null, dirPoll: null, lastOkOf: () => null });
  const bb = Object.fromEntries(b.checks.map((c) => [c.key, c]));
  assert.deepEqual([bb.director.state, bb.site.state], ['bad', 'bad']);
  assert.match(bb.site.detail, /FD INI 경로 · FD 이름/);
  assert.equal(drCheckView({ vcenterId: 'vc-a', snapshot: snap, jobs, site, director: { id: 'D1', name: '한국' }, dirPoll: null, lastOkOf: () => null }).checks[0].state, 'unknown', '조회 전은 모름');
  assert.equal(drCheckView({ vcenterId: 'vc-z', snapshot: snap, jobs, site, director: null, dirPoll: null, lastOkOf: () => null }).checks.find((c) => c.key === 'vcenter').state, 'bad');
});

test('④ 라우트 — dr 규칙 위반은 Director 에 닿기 전 400 · 지키면 dc · restore_cluster 로 202 · 지점마다 백업 때 위치 · dr/check 범위', async () => {
  // 지점마다 백업 때 위치(at)
  let r = await call('admin', 'POST', '/restore-points/bulk', { ids: [ID.web] });
  assert.equal(r.s, 200, r.t);
  assert.deepEqual(r.j.items[0].points[0].at, { dc: 'DC-A', folder: '/web', vmName: 'web-01' });
  const item = { id: ID.web, jobid: H('web', 130), mode: 'newVm', newVm: { name: 'web-01-dr', dc: 'DC-NEW', cluster: 'CL-A' }, nic: 'keep' };
  const before = D.cmds.length;
  r = await call('admin', 'POST', '/restore/bulk', { items: [item], dr: true, otp: 'x' });
  assert.equal(r.s, 400, r.t);
  assert.match(r.j.plan.items[0].issue, /끊은 채/);
  r = await call('admin', 'POST', '/restore-check/bulk', { items: [{ ...item, nic: 'disconnect', newVm: { name: 'web-01-dr', dc: 'DC-NEW' } }], dr: true });
  assert.match(r.j.plan.items[0].issue, /클러스터/, '미리 보기도 같은 규칙');
  assert.equal(D.cmds.length, before, 'Director 에 닿지 않는다');
  // 같은 항목을 dr 없이 보내면 일반 묶음 규칙만(예전 동작 — nic keep 허용)
  r = await call('admin', 'POST', '/restore-check/bulk', { items: [item] });
  assert.equal(r.j.plan.items[0].ok, true, JSON.stringify(r.j.plan.items[0]));
  r = await call('admin', 'POST', '/restore/bulk', { items: [{ ...item, nic: 'disconnect' }], dr: true, otp: otpNow() });
  assert.equal(r.s, 202, r.t);
  const cmd = D.cmds.slice(before).find((c) => c.startsWith('restore '));
  assert.match(cmd, /dc=DC-NEW:folder=\/web:vmname=web-01-dr:.*restore_cluster=CL-A/);
  const { listAudit } = await import('../src/audit.js');
  assert.ok(listAudit({ limit: 20, q: r.j.batchId }).items.some((x) => x.action === 'Bareos 재해 복구'));
  // dr/check
  r = await call('admin', 'GET', '/dr/check?vcenterId=vc-a');
  assert.equal(r.s, 200, r.t);
  assert.deepEqual(r.j.targets.dcs, ['DC-NEW']);
  assert.ok(r.j.checks.some((c) => c.key === 'site' && /vc-a\.corp/.test(c.detail)), '전체 범위는 매핑 값을 본다');
  assert.equal((await call('sadm', 'GET', '/dr/check?vcenterId=vc-b')).s, 404, '조회 범위 밖은 없는 것과 같다');
  const sv = await call('sadm', 'GET', '/dr/check?vcenterId=vc-a');
  assert.equal(sv.s, 200);
  assert.equal(sv.j.checks.find((c) => c.key === 'site').detail, '채워져 있음', '범위 계정에는 매핑 값을 가린다');
  assert.equal((await call('admin', 'GET', '/dr/check')).s, 400);
});
