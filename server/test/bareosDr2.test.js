/**
 * test/bareosDr2.test.js — 재해 복구 2차: 복구 순서(단계 자동 실행 · bareos/drRunner.js) — 시안 ② Disaster2 '3. 복구 순서'.
 *  ① normWaves · sentItemState(순수)
 *  ② 시작: 시험 1대 규칙은 회차 전체 대수로 · 판정은 묶음 복원과 같다 · OTP · 진행 중 회차 409
 *  ③ 단계: 동시 수만큼만 보내고, 앞 단계가 끝나야(끝맺음 포함) 다음 단계 · 원장에 dr · drRun 표지 · 켜 보기 단계는 verify(지우지 않음)
 *  ④ 단계 실패 → 멈춤 · 계속(OTP) → 다음 단계 · 멈춤이면 보내지 않는다
 *  ⑤ 재시작: 보내던(sending) 항목은 결과 모름 · 다시 보내지 않고 멈춘다 · 범위 밖 회차는 404
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareosdr2-'));
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
      { id: 'vc-a:vm-6', vcenterId: 'vc-a', name: 'db-06', powerState: 'POWERED_OFF', snapshotCount: 0, vcDcPath: 'DC-A', folderPath: '/db', storageGB: 50 },
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
  for (const [k, vc, vm] of [['web', 'vc-a', 'vc-a:vm-1'], ['app', 'vc-a', 'vc-a:vm-5'], ['db', 'vc-b', 'vc-b:vm-9'], ['db6', 'vc-a', 'vc-a:vm-6']]) {
    r = await call('admin', 'POST', '/jobs', { vcenterId: vc, vmId: vm });
    assert.equal(r.s, 201, r.t);
    ID[k] = r.j.job.id;
  }
});

const job = (k) => registry.getJob(ID[k]);
const H = (k, j) => (OFF.get(job(k).bareosJob) ?? 0) + j;



const RN = await import('../src/bareos/drRunner.js');
// 시작 라우트가 첫 걸음을 바로 띄운다(drTick — 재진입 가드) — 그 걸음이 끝날 때까지 기다린 뒤 한 걸음 더
const tick = async () => { for (let i = 0; i < 200; i++) { const r = await RN.drTick(); if (r !== null) return r; await new Promise((res) => setTimeout(res, 25)); } throw new Error('tick busy'); };

test('① 단계 정규화 · 보낸 항목 상태', () => {
  const it = (id, name) => ({ id, jobid: 10, newVm: { name, cluster: 'CL' } });
  assert.throws(() => RN.normWaves([]), /1~10/);
  assert.throws(() => RN.normWaves([{ concurrency: 0, items: [it('a', 'x')] }]), /동시 복원 수/);
  assert.throws(() => RN.normWaves([{ concurrency: 1, items: [it('a', 'x')] }, { concurrency: 1, items: [it('a', 'y')] }]), /두 단계/);
  assert.throws(() => RN.normWaves([{ concurrency: 1, items: [it('a', 'x'), it('b', 'X')] }]), /겹칩니다/);
  assert.throws(() => RN.normWaves([{ concurrency: 1, items: [it('a', 'x;y')] }]), /새 VM 이름/);
  const w = RN.normWaves([{ name: '', concurrency: 2, verify: 'yes', items: [it('a', 'x')] }]);
  assert.deepEqual([w[0].name, w[0].verify], ['1단계', false], '켜 보기는 불리언 true 만');
  const job = (r) => ({ restores: [r] });
  const now = Date.now();
  assert.equal(RN.sentItemState({ rid: 5 }, job({ jobid: 5, status: 'R', state: 'running', nic: 'disconnect' }), {}, now).state, 'sent');
  assert.equal(RN.sentItemState({ rid: 5 }, job({ jobid: 5, status: 'T', state: 'ok', nic: 'disconnect', at: now }), {}, now).state, 'sent', '끊기 끝맺음 전');
  assert.equal(RN.sentItemState({ rid: 5 }, job({ jobid: 5, status: 'T', state: 'ok', nic: 'disconnect', at: now, finish: { nic: 'ok' } }), {}, now).state, 'ok');
  assert.match(RN.sentItemState({ rid: 5 }, job({ jobid: 5, status: 'f', state: 'error', nic: 'disconnect', at: now, finish: { nic: 'skipped' } }), {}, now).reason, /성공으로 끝나지/);
  assert.match(RN.sentItemState({ rid: 5 }, job({ jobid: 5, status: 'T', state: 'ok', nic: 'disconnect', at: now, finish: { nic: 'failed', verify: 'failed', detail: 'Tools' } }), { verify: true }, now).reason, /네트워크 끊기 실패|켜 보기 실패/);
  assert.equal(RN.sentItemState({ rid: 5 }, null, {}, now).state, 'failed');
});

const W = (k, name, extra = {}) => ({ id: ID[k], jobid: H(k, 130), newVm: { name, dc: 'DC-NEW', cluster: 'CL-A' }, ...extra });
const restoreCmds = () => D.cmds.filter((c) => c.startsWith('restore '));
const finishAll = async (state = 'T') => {
  for (const k of ['web', 'app', 'db6']) {
    for (const r of job(k).restores || []) {
      if (!r.drRun || !r.jobid) continue;
      registry.applyRestoreRow(ID[k], { jobid: r.jobid, status: state, type: 'R', endedAt: Date.now() });
      registry.patchRestoreFinish(ID[k], r.jobid, state === 'T' ? { nic: 'ok', at: Date.now(), ...(r.verify ? { verify: 'ok' } : {}) } : { nic: 'skipped', at: Date.now() });
    }
  }
};

test('② 시작 — 시험 1대 규칙은 회차 전체로 · 판정 · OTP · 진행 중 409', async () => {
  const waves = [{ name: '기반', concurrency: 1, items: [W('web', 'web-01-n')] }, { name: '나머지', concurrency: 1, items: [W('app', 'app-05-n')] }];
  let r = await call('admin', 'POST', '/dr/runs/check', { vcenterId: 'vc-a', waves });
  assert.equal(r.j.ok, false);
  assert.match(r.j.reason, /1대가 성공으로 끝난 뒤/, '단계마다 1대여도 회차 전체 2대 — 시험 규칙');
  // 시험 1대 성공 기록
  registry.addRestore(ID.db6, { jobid: 7001, mode: 'newVm', target: { name: 'db-06-trial' }, by: 't', client: 'kr-fd', dr: true, nic: 'disconnect' });
  registry.applyRestoreRow(ID.db6, { jobid: 7001, status: 'T', type: 'R', endedAt: Date.now() });
  registry.patchRestoreFinish(ID.db6, 7001, { nic: 'ok', at: Date.now() });
  r = await call('admin', 'POST', '/dr/runs/check', { vcenterId: 'vc-a', waves });
  assert.equal(r.j.ok, true, JSON.stringify(r.j));
  assert.equal(r.j.total, 2);
  r = await call('admin', 'POST', '/dr/runs/check', { vcenterId: 'vc-a', waves: [{ concurrency: 1, items: [{ ...W('web', 'web-01-n'), newVm: { name: 'web-01-n', dc: 'DC-NEW' } }] }] });
  assert.match(r.j.issues[0].issue, /클러스터/, '묶음 복원과 같은 dr 판정');
  assert.equal((await call('sadm', 'POST', '/dr/runs/check', { vcenterId: 'vc-b', waves })).s, 404);
  assert.equal((await call('admin', 'POST', '/dr/runs', { vcenterId: 'vc-a', waves, otp: '000000' })).s, 403, '틀린 OTP');
  assert.equal(restoreCmds().length, 0);
  r = await call('admin', 'POST', '/dr/runs', { vcenterId: 'vc-a', waves, drBefore: '2026-11-01T00:00', otp: otpNow() });
  assert.equal(r.s, 201, r.t);
  ID.run = r.j.run.id;
  r = await call('admin', 'POST', '/dr/runs', { vcenterId: 'vc-a', waves, otp: 'x' });
  assert.equal(r.s, 409, '진행 중 회차는 OTP 앞에서 거부');
});

test('③ 단계 — 동시 수만큼 · 앞 단계가 끝맺음까지 끝나야 다음 · dr 표지', async () => {
  await tick();
  let cmds = restoreCmds();
  assert.equal(cmds.length, 1, '1단계 1대만');
  assert.match(cmds[0], /vmname=web-01-n:/);
  const rec = job('web').restores.find((x) => x.drRun === ID.run);
  assert.deepEqual([rec.dr, rec.nic, rec.verify ?? null], [true, 'disconnect', null]);
  await tick();
  assert.equal(restoreCmds().length, 1, '1단계가 끝나기 전에는 2단계를 보내지 않는다');
  registry.applyRestoreRow(ID.web, { jobid: rec.jobid, status: 'T', type: 'R', endedAt: Date.now() });
  await tick();
  assert.equal(restoreCmds().length, 1, '끝맺음(NIC 끊기) 전에는 끝이 아니다');
  registry.patchRestoreFinish(ID.web, rec.jobid, { nic: 'ok', at: Date.now() });
  await tick();   // 1단계 끝 → 다음 단계로
  await tick();   // 2단계 보냄
  cmds = restoreCmds();
  assert.equal(cmds.length, 2);
  assert.match(cmds[1], /vmname=app-05-n:/);
  const v = RN.drRunsView().runs.find((x) => x.id === ID.run);
  assert.deepEqual([v.cur, v.waves[0].counts.ok, v.waves[1].counts.sent], [1, 1, 1]);
  const { listAudit } = await import('../src/audit.js');
  assert.ok(listAudit({ limit: 50, q: ID.run }).items.some((x) => /기준 시각 2026-11-01 00:00/.test(x.detail)));
});

test('④ 단계 실패 → 멈춤 · 멈춤이면 보내지 않는다 · 계속(OTP) → 다음', async () => {
  await finishAll('f');
  await tick();
  let v = RN.drRunsView().runs.find((x) => x.id === ID.run);
  assert.equal(v.state, 'paused');
  assert.match(v.reason, /실패/);
  assert.equal((await call('admin', 'POST', `/dr/runs/${ID.run}/resume`, { otp: '000000' })).s, 403);
  const r = await call('admin', 'POST', `/dr/runs/${ID.run}/resume`, { otp: generateToken(SECRET, { counter: Math.floor(Date.now() / 30_000) + 1 }) });
  assert.equal(r.s, 200, r.t);
  await tick();
  v = RN.drRunsView().runs.find((x) => x.id === ID.run);
  assert.equal(v.state, 'done', '마지막 단계를 확인하고 넘기면 끝');
  assert.equal((await call('admin', 'POST', `/dr/runs/${ID.run}/stop`, {})).s, 409, '끝난 회차는 멈출 수 없다');
});

test('⑤ 재시작 — 보내던 항목은 결과 모름(다시 보내지 않음) · 멈춤 · 범위 밖 404', async () => {
  // 새 회차(시험 성공은 ② 에서 있음) — 3단계 중 1단계를 보내는 중 재시작한 모양을 만든다
  const waves = [{ name: 'A', concurrency: 1, items: [W('db6', 'db-06-b')] }];
  let r = await call('adm2', 'POST', '/dr/runs', { vcenterId: 'vc-a', waves, otp: otpNow() });   // 다른 계정(1회용 코드 사용 기록은 계정마다)
  assert.equal(r.s, 201, r.t);
  const id = r.j.run.id;
  await new Promise((res) => setTimeout(res, 50));
  // 파일에서 그 항목을 'sending' 으로 바꾸고 모듈 메모리를 비운다(재시작)
  const f = path.join(tmp, 'bareos-dr-runs.json');
  const db = JSON.parse(fs.readFileSync(f, 'utf8'));
  const run = db.runs.find((x) => x.id === id);
  run.waves[0].items[0].state = 'sending'; run.waves[0].items[0].rid = null;
  fs.writeFileSync(f, JSON.stringify(db));
  RN._resetDrRunsForTest();
  const before = restoreCmds().length;
  await tick();
  const v = RN.drRunsView().runs.find((x) => x.id === id);
  assert.deepEqual([v.state, v.waves[0].items[0].state], ['paused', 'unknown']);
  assert.match(v.reason, /결과를 모릅니다/);
  assert.equal(restoreCmds().length, before, '다시 보내지 않는다');
  assert.equal((await call('sadm', 'POST', `/dr/runs/${id}/stop`, {})).s, 200, '범위 계정도 자기 vCenter 회차는 멈출 수 있다');
  assert.equal((await call('wadm', 'POST', `/dr/runs/${id}/stop`, {})).s, 409, '이미 멈춤');
  const g = await call('sadm', 'GET', '/dr/runs?vcenterId=vc-b');
  assert.equal(g.s, 404);
});
