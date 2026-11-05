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
// 포탈 등록 주소(새 vCenter)가 매핑 주소(vc-a.corp)와 다르다 — 다시 설치한 vCenter 의 전형(dr/check 사이트 매핑 warn · 버그 점검 B2-01)
fs.writeFileSync(path.join(tmp, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'vc-a', name: 'Seoul', host: 'https://vc-a-new.corp' }, { id: 'vc-b', name: 'Warsaw', host: 'https://vc-b.corp' }] }));

const { startFakeDirector } = await import('./_fakeBareosDirector.js');
const D = { jobs: new Map(), runs: new Map(), nextId: 500, cmds: [] };
const OFF = new Map();
const DROP = { on: false };
// restore 명령이 Director 에 닿는 순간의 실행 상태 파일(보내기 **전에** 'sending' 이 남았는지 — 재시작 뒤 다시 보내지 않는 근거)
const SNAP = [];
const runsFile = () => path.join(tmp, 'bareos-dr-runs.json');
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
  if (cmd.startsWith('restore ')) SNAP.push(fs.existsSync(runsFile()) ? fs.readFileSync(runsFile(), 'utf8') : '');
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
    generatedAt: new Date().toISOString(), source: 'mock',   // 운영과 같은 모양(ISO 문자열 · 연결 상태) — 숫자로 두면 B4-01 이 숨는다
    vcenters: [{ id: 'vc-a', name: 'Seoul', host: 'https://vc-a.corp', location: { region: 'KR' }, status: 'connected' }, { id: 'vc-b', name: 'Warsaw', host: 'https://vc-b.corp', location: { region: 'PL' }, status: 'connected' }],
    hosts: [{ id: 'vc-a:host-1', vcenterId: 'vc-a', name: 'esx-a1', cluster: 'CL-A', vcDatacenter: 'DC-NEW' }, { id: 'vc-a:host-2', vcenterId: 'vc-a', name: 'esx-a2', cluster: 'CL-B', vcDatacenter: 'DC-NEW' }],
    datastores: [{ id: 'vc-a:ds-1', vcenterId: 'vc-a', name: 'ds-a1', freeGB: 5000, capacityGB: 10000 }, { id: 'vc-a:ds-2', vcenterId: 'vc-a', name: 'ds-tight', freeGB: 300, capacityGB: 1000 }],
    vms: [
      { id: 'vc-a:vm-1', vcenterId: 'vc-a', name: 'web-01', powerState: 'POWERED_ON', snapshotCount: 0, vcDcPath: 'DC-A', folderPath: '/web', storageGB: 200, dev: { disks: [{ datastore: 'ds-a1' }] } },   // 홈 DS(검증 여유 판정 — v2.862)
      { id: 'vc-a:vm-5', vcenterId: 'vc-a', name: 'app-05', powerState: 'POWERED_OFF', snapshotCount: 0, vcDcPath: 'DC-A', folderPath: '/app', storageGB: 150 },
      { id: 'vc-a:vm-6', vcenterId: 'vc-a', name: 'db-06', powerState: 'POWERED_OFF', snapshotCount: 0, vcDcPath: 'DC-A', folderPath: '/db', storageGB: 50 },
      { id: 'vc-a:vm-7', vcenterId: 'vc-a', name: 'fs-07', powerState: 'POWERED_OFF', snapshotCount: 0, vcDcPath: 'DC-A', folderPath: '/fs', storageGB: 40 },
      { id: 'vc-a:vm-8', vcenterId: 'vc-a', name: 'mq-08', powerState: 'POWERED_OFF', snapshotCount: 0, vcDcPath: 'DC-A', folderPath: '/mq', storageGB: 40 },
      { id: 'vc-a:vm-10', vcenterId: 'vc-a', name: 'ci-10', powerState: 'POWERED_OFF', snapshotCount: 0, vcDcPath: 'DC-A', folderPath: '/ci', storageGB: 40 },
      { id: 'vc-a:vm-11', vcenterId: 'vc-a', name: 'ad-11', powerState: 'POWERED_OFF', snapshotCount: 0, vcDcPath: 'DC-A', folderPath: '/ad', storageGB: 40 },
      { id: 'vc-a:vm-12', vcenterId: 'vc-a', name: 'dns-12', powerState: 'POWERED_OFF', snapshotCount: 0, vcDcPath: 'DC-A', folderPath: '/dns', storageGB: 40 },
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
  for (const [k, vc, vm] of [['web', 'vc-a', 'vc-a:vm-1'], ['app', 'vc-a', 'vc-a:vm-5'], ['db', 'vc-b', 'vc-b:vm-9'], ['db6', 'vc-a', 'vc-a:vm-6'], ['fs7', 'vc-a', 'vc-a:vm-7'], ['mq8', 'vc-a', 'vc-a:vm-8'], ['ci10', 'vc-a', 'vc-a:vm-10'], ['ad11', 'vc-a', 'vc-a:vm-11'], ['dns12', 'vc-a', 'vc-a:vm-12']]) {
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
  assert.match(RN.sentItemState({ rid: 5 }, job({ jobid: 5, status: 'T', state: 'ok', nic: 'disconnect', at: now, finish: { nic: 'failed', detail: 'Tools' } }), {}, now).reason, /네트워크 끊기 실패/);
  assert.match(RN.sentItemState({ rid: 5 }, job({ jobid: 5, status: 'T', state: 'ok', nic: 'disconnect', verify: true, at: now, finish: { nic: 'ok', verify: 'failed', detail: 'Tools' } }), { verify: true }, now).reason, /켜 보기 실패/);
  assert.equal(RN.sentItemState({ rid: 5 }, job({ jobid: 5, status: 'T', state: 'ok', nic: 'disconnect', verify: true, at: now, finish: { nic: 'ok', verify: 'ok' } }), { verify: true }, now).state, 'ok');
  assert.equal(RN.sentItemState({ rid: 5 }, null, {}, now).state, 'failed');
  // 화면 상한이 서버와 같다(웹 bareosDrText.js — 한쪽만 바꾸면 화면이 통과시킨 계획을 서버가 거부한다)
  const web = fs.readFileSync(new URL('../../web/src/views/tools/bareosDrText.js', import.meta.url), 'utf8');
  assert.equal(Number(/export const DR_WAVES_MAX = (\d+);/.exec(web)?.[1]), RN.DR_WAVES_MAX);
  assert.equal(Number(/export const DR_ITEMS_MAX = (\d+);/.exec(web)?.[1]), RN.DR_ITEMS_MAX);
  assert.equal(Number(/export const DR_CHUNK = (\d+);/.exec(web)?.[1]), RN.DR_CONC_MAX, '동시 복원 수 상한 = 한 번에 보낼 수 있는 대수');
});

test('① 설정 백업 복원은 실행 상태를 되살리지 않는다(진행 중에 만든 백업 → 끝난 회차가 OTP 없이 다시 돈다)', async () => {
  const { RESTORE_EXCLUDE, stagedNameIssue } = await import('../src/backup/stagedRestore.js');
  assert.ok(RESTORE_EXCLUDE.has('bareos-dr-runs.json'));
  assert.equal(stagedNameIssue('bareos-dr-runs.json'), '복원 제외');
});

const W = (k, name, extra = {}) => ({ id: ID[k], jobid: H(k, 130), newVm: { name, dc: 'DC-NEW', cluster: 'CL-A' }, ...extra });
const restoreCmds = () => D.cmds.filter((c) => c.startsWith('restore '));
const finishAll = async (state = 'T') => {
  for (const k of ['web', 'app', 'db6', 'fs7', 'mq8', 'ci10', 'ad11', 'dns12']) {
    for (const r of job(k).restores || []) {
      if (!r.drRun || !r.jobid || !registry.restoreOpen(r)) continue;   // 아직 도는 것만(끝난 복원은 그대로)
      registry.applyRestoreRow(ID[k], { jobid: r.jobid, status: state, type: 'R', endedAt: Date.now() });
      registry.patchRestoreFinish(ID[k], r.jobid, state === 'T' ? { nic: 'ok', at: Date.now(), ...(r.verify ? { verify: 'ok' } : {}) } : { nic: 'skipped', at: Date.now() });
    }
  }
};

test('② 시작 — 시험 1대 규칙은 회차 전체로 · 판정 · OTP · 진행 중 409', async () => {
  const waves = [{ name: '기반', concurrency: 1, items: [W('web', 'web-01-n')] }, { name: '나머지', concurrency: 1, items: [W('app', 'app-05-n'), W('db6', 'db-06-n')] }];
  let r = await call('admin', 'POST', '/dr/runs/check', { vcenterId: 'vc-a', waves });
  assert.equal(r.j.ok, false);
  assert.match(r.j.reason, /1대가 성공으로 끝난 뒤/);
  r = await call('admin', 'POST', '/dr/runs/check', { vcenterId: 'vc-a', waves: [{ concurrency: 1, items: [W('web', 'web-01-n')] }, { concurrency: 1, items: [W('app', 'app-05-n')] }] });
  assert.match(r.j.reason || '', /1대가 성공으로 끝난 뒤/, '단계마다 1대여도 회차 전체 2대 — 시험 규칙(50대 묶음마다 보면 비켜 간다)');
  // 시험 1대 성공 기록
  registry.addRestore(ID.db6, { jobid: 7001, mode: 'newVm', target: { name: 'db-06-trial' }, by: 't', client: 'kr-fd', dr: true, nic: 'disconnect' });
  registry.applyRestoreRow(ID.db6, { jobid: 7001, status: 'T', type: 'R', endedAt: Date.now() });
  registry.patchRestoreFinish(ID.db6, 7001, { nic: 'ok', at: Date.now() });
  r = await call('admin', 'POST', '/dr/runs/check', { vcenterId: 'vc-a', waves });
  assert.equal(r.j.ok, true, JSON.stringify(r.j));
  assert.equal(r.j.total, 3);
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
  const at0 = JSON.parse(SNAP[0]).runs.find((x) => x.id === ID.run);
  assert.equal(at0.waves[0].items[0].state, 'sending', '보내기 전에 파일에 남긴다');
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
  await tick();
  assert.equal(restoreCmds().length, 2, '동시 복원 수 1 — 앞 VM 이 끝나기 전에는 다음 VM 을 보내지 않는다');
  const v = RN.drRunsView().runs.find((x) => x.id === ID.run);
  assert.deepEqual([v.cur, v.waves[0].counts.ok, v.waves[1].counts.sent, v.waves[1].counts.queued], [1, 1, 1, 1]);
  const { listAudit } = await import('../src/audit.js');
  assert.ok(listAudit({ limit: 50, q: ID.run }).items.some((x) => /기준 시각 2026-11-01 00:00/.test(x.detail)));
});

test('④ 단계 실패 → 멈춤 · 멈춤이면 보내지 않는다 · 계속(OTP) → 다음', async () => {
  await finishAll('f');
  await tick();
  assert.equal(restoreCmds().length, 3, '실패해도 단계 안 남은 VM 은 보낸다(빈 자리 1)');
  assert.match(restoreCmds()[2], /vmname=db-06-n:/);
  let v = RN.drRunsView().runs.find((x) => x.id === ID.run);
  assert.equal(v.state, 'running');
  await finishAll('f');
  await tick();
  v = RN.drRunsView().runs.find((x) => x.id === ID.run);
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
  const gw = await call('wadm', 'GET', '/dr/runs?vcenterId=vc-a');
  assert.equal(gw.j.runs.find((x) => x.id === id).writable, true, '쓰기 범위 안 — 버튼을 연다');
});

test('⑥ 직전 복원 결과를 모르는 VM 은 보내지 않고 실패로 둔다 · 단계 끝에 멈춤', async () => {
  registry.addRestore(ID.app, { mode: 'newVm', target: { name: 'app-05-q' }, by: 't', client: 'kr-fd', unknown: true });
  assert.ok(job('app').restores.some((r) => registry.restoreUnknownHeld(r)), '준비: 결과 모름 기록');
  const run = RN.createRun({ vcenterId: 'vc-a', directorId: ID.dir, by: 'adm', waves: [{ name: 'U', concurrency: 1, items: [W('app', 'app-05-u')] }] });
  const before = restoreCmds().length;
  await tick();
  let v = RN.drRunsView().runs.find((x) => x.id === run.id);
  assert.equal(v.waves[0].items[0].state, 'failed');
  assert.match(v.waves[0].items[0].reason, /결과를 모릅니다/);
  assert.equal(restoreCmds().length, before, '보내지 않는다');
  await tick();
  v = RN.drRunsView().runs.find((x) => x.id === run.id);
  assert.equal(v.state, 'paused');
  RN.stopRun(run.id, 'adm');
});

const view = (id) => RN.drRunsView().runs.find((x) => x.id === id);
test('⑦ 반증 F1 — 다른 사유(점검 ✕)로 멈춘 뒤 계속해도, 그 뒤에 생긴 실패는 다시 멈춘다(다음 단계를 사람 확인 없이 보내지 않는다)', async () => {
  const run = RN.createRun({ vcenterId: 'vc-a', directorId: ID.dir, by: 'adm', waves: [
    { name: '기반', concurrency: 1, items: [W('fs7', 'fs-07-r'), W('mq8', 'mq-08-r')] },
    { name: 'DB', concurrency: 1, items: [W('web', 'web-01-r')] },
  ] });
  await tick();
  assert.deepEqual(view(run.id).waves[0].items.map((i) => i.state), ['sent', 'queued']);
  await finishAll('T');
  RN.setDrPollDirs(() => ({ [ID.dir]: { ok: false, code: 'timeout', at: Date.now() } }));   // 고RTT 법인의 일시적 Director 조회 실패 → 점검 ✕
  await tick();
  assert.equal(view(run.id).state, 'paused', '점검 ✕ 면 보내지 않고 멈춘다');
  RN.setDrPollDirs(() => ({}));
  RN.resumeRun(run.id, 'adm');
  await tick();
  assert.deepEqual(view(run.id).waves[0].items.map((i) => i.state), ['ok', 'sent']);
  await finishAll('f');   // 기반 2번째 VM 실패
  await tick();
  let v = view(run.id);
  assert.deepEqual([v.state, v.cur], ['paused', 0], '계속 이후의 실패는 확인되지 않았다 — 다음 단계로 넘기지 않는다');
  assert.ok(!restoreCmds().some((c) => c.includes('web-01-r')));
  RN.resumeRun(run.id, 'adm');   // 이번에는 그 실패를 보고 계속
  await tick(); await tick();
  v = view(run.id);
  assert.equal(v.cur, 1);
  assert.ok(restoreCmds().some((c) => c.includes('web-01-r')));
  await finishAll('T');
  await tick(); await tick();
  assert.equal(view(run.id).state, 'done');
});

test('⑧ 반증 F3 — 보내는 동안 멈추면 보내기 오류가 와도 멈춤(stopped) 그대로 · 다시 계속할 수 없다', async () => {
  const run = RN.createRun({ vcenterId: 'vc-a', directorId: ID.dir, by: 'adm', waves: [{ name: 'S', concurrency: 1, items: [W('fs7', 'fs-07-s')] }] });
  const svc = await import('../src/bareos/service.js');
  let release; const gate = new Promise((r) => { release = r; }); let called = false;
  svc._setSessionFactoryForTest(async () => { called = true; await gate; throw Object.assign(new Error('연결 거부'), { code: 'connect' }); });
  try {
    const tk = RN.drTick();
    for (let i = 0; i < 200 && !called; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(called, '보내기에 들어갔다');
    RN.stopRun(run.id, 'adm');
    release();
    await tk;
  } finally { svc._setSessionFactoryForTest(null); }
  const v = view(run.id);
  assert.equal(v.state, 'stopped', '보내기 오류가 stopped 를 paused 로 덮지 않는다');
  assert.throws(() => RN.resumeRun(run.id, 'adm'), /멈춤 상태인 회차만/);
});

test('⑨ 반증 F4 — 재시작 뒤 보내던 VM 은 원장에 결과 모름을 남겨 다른 경로의 복원을 막는다 · 그 묶음 기록이 원장에 있으면 그것으로 잇는다', async () => {
  const run = RN.createRun({ vcenterId: 'vc-a', directorId: ID.dir, by: 'adm', waves: [{ name: 'R', concurrency: 2, items: [W('mq8', 'mq-08-x'), W('web', 'web-01-x')] }] });
  const f = path.join(tmp, 'bareos-dr-runs.json');
  const db = JSON.parse(fs.readFileSync(f, 'utf8'));
  const r = db.runs.find((x) => x.id === run.id);
  // web 은 보냈고 원장에도 들어갔지만(jobid 777) 'sent' 저장 전에 재시작 · mq8 은 보냈는지 모른다
  r.waves[0].items[0].state = 'sending'; r.waves[0].items[0].batchId = `${run.id}-b1`;
  r.waves[0].items[1].state = 'sending'; r.waves[0].items[1].batchId = `${run.id}-b1`;
  fs.writeFileSync(f, JSON.stringify(db));
  registry.addRestore(ID.web, { jobid: 777, mode: 'newVm', target: { name: 'web-01-x' }, by: 'adm', client: 'kr-fd', batchId: `${run.id}-b1`, nic: 'disconnect', dr: true, drRun: run.id });
  RN._resetDrRunsForTest();
  const before = restoreCmds().length;
  await tick();
  const v = view(run.id);
  assert.deepEqual(v.waves[0].items.map((i) => [i.state, i.rid]), [['unknown', null], ['sent', 777]]);
  assert.equal(v.state, 'paused');
  assert.equal(restoreCmds().length, before, '다시 보내지 않는다');
  assert.ok(job('mq8').restores.some((x) => registry.restoreUnknownHeld(x) && x.drRun === run.id), '원장에 결과 모름 기록');
  const c = await call('admin', 'POST', '/restore-check/bulk', { items: [{ id: ID.mq8, jobid: H('mq8', 130), mode: 'newVm', nic: 'disconnect', newVm: { name: 'mq-08-y', cluster: 'CL-A' } }] });
  assert.equal(c.j.plan.ok, false);
  assert.match(c.j.plan.items[0].issue, /결과를 모릅니다|복구 순서/);
  RN.stopRun(run.id, 'adm');
  registry.applyRestoreRow(ID.web, { jobid: 777, status: 'T', type: 'R', endedAt: Date.now() });
  registry.patchRestoreFinish(ID.web, 777, { nic: 'ok', at: Date.now() });
});

test('⑩ 반증 F5 · F9 · F11 — 진행 중 회차는 보관 상한에서 남는다 · 원장 기록이 사라진 보냄은 결과 모름 · 회차의 대기 VM 은 묶음 복원이 막는다', async () => {
  const mk = (i, state) => ({ id: `r${i}`, state });
  const kept = RN.trimRuns([mk(0, 'done'), mk(1, 'paused'), ...Array.from({ length: 25 }, (_, i) => mk(i + 2, 'done')), mk(99, 'running')]);
  assert.ok(kept.some((r) => r.id === 'r1') && kept.some((r) => r.id === 'r99'), '멈춤 · 진행 중은 밀려나지 않는다');
  assert.equal(kept.filter((r) => r.state === 'done').length, 20);
  const now = Date.now();
  assert.equal(RN.sentItemState({ rid: 5, sentAt: now - 1000 }, { runsEpoch: now, restores: [] }, {}, now).state, 'unknown', '다시 묶기로 이력이 비었다');
  assert.equal(RN.sentItemState({ rid: 5, sentAt: now - 49 * 3600_000 }, { restores: [] }, {}, now).state, 'unknown', '48시간 넘게 기록이 없다');
  assert.equal(RN.sentItemState({ rid: 5, sentAt: now - 1000 }, { restores: [] }, {}, now).state, 'sent', '방금 보낸 것은 기다린다');
  // F11 — 진행 중 회차(멈춤)의 대기 VM
  const run = RN.createRun({ vcenterId: 'vc-a', directorId: ID.dir, by: 'adm', waves: [{ name: 'H', concurrency: 1, items: [W('fs7', 'fs-07-h')] }] });
  const c = await call('admin', 'POST', '/restore-check/bulk', { items: [{ id: ID.fs7, jobid: H('fs7', 130), mode: 'newVm', nic: 'disconnect', newVm: { name: 'fs-07-other', cluster: 'CL-A' } }] });
  assert.match(c.j.plan.items[0].issue, /복구 순서/);
  const g = await call('admin', 'POST', '/dr/runs/check', { vcenterId: 'vc-a', waves: [{ concurrency: 1, items: [W('web', 'web-01-z')] }] });
  assert.match(g.j.reason, /진행 중인 복구 순서/, '같은 법인 진행 중 회차');
  RN.stopRun(run.id, 'adm');
  // F10 — 엣지 노드에서는 시작 · 계속을 받지 않는다(실행기 타이머가 없다)
  const src = fs.readFileSync(new URL('../src/routes/api/bareosBackup.js', import.meta.url), 'utf8');
  for (const p of ["'/tools/bareos-backup/dr/runs', adminOnly", "'/tools/bareos-backup/dr/runs/:id/resume', adminOnly"]) {
    const i = src.indexOf(p);
    assert.ok(i > 0 && /if \(isEdgeNode\(\)\) return res\.status\(409\)/.test(src.slice(i, i + 300)), `${p} — 엣지 409`);
  }
});

/* ───────────── 버그 점검(재해 복구 1·2차 · 5축 + 반증 1인) 회귀 ───────────── */
const PLAN = await import('../src/bareos/drPlan.js');
const RS = await import('../src/bareos/restore.js');
const WEB = await import('../../web/src/views/tools/bareosDrText.js');
const stateFile = () => path.join(tmp, 'bareos-dr-runs.json');
const latestRun = (vc = 'vc-a') => RN.drRunsView().runs.filter((r) => r.vcenterId === vc).sort((a, b) => b.at - a.at)[0];

test('⑪ B4-01 이름 예약 해제 — ISO 시각 · vCenter 마다 · 여유 · 포탈 시계 / B4-02 시험 성공 = 끝맺음까지(서버 · 웹 · 실행기 같은 답) / B2-06 · B1-06', () => {
  const now = Date.now();
  const end = now - 3600_000;
  const jobs = [{ vcenterId: 'vc-a', restores: [{ mode: 'newVm', target: { name: 'X' }, state: 'error', at: end - 600_000, checkedAt: end, endedAt: end - 9 * 3600_000 }] }];
  const key = 'vc-a\u0000x';
  const snap = (extra = {}, vcx = {}) => ({ generatedAt: new Date(now).toISOString(), vcenters: [{ id: 'vc-a', status: 'connected', ...vcx }], ...extra });
  assert.equal(RS.inventoryAtOf(snap())('vc-a'), now, 'ISO 문자열을 읽는다(Number 였으면 0)');
  assert.ok(!RS.reservedRestoreNames(jobs, { now, snapAt: RS.inventoryAtOf(snap()) }).has(key), '끝을 본 뒤 여유를 넘긴 새 인벤토리 — 푼다');
  assert.ok(RS.reservedRestoreNames(jobs, { now, snapAt: RS.inventoryAtOf(snap({ generatedAt: new Date(end + 60_000).toISOString() })) }).has(key), '여유(수집 주기 · 시한) 안 — 풀지 않는다');
  for (const vcx of [{ status: 'maintenance', maintenance: true }, { stale: true }, { status: 'unreachable' }]) assert.ok(RS.reservedRestoreNames(jobs, { now, snapAt: RS.inventoryAtOf(snap({}, vcx)) }).has(key), `낡은 인벤토리(${JSON.stringify(vcx)}) — 풀지 않는다`);
  assert.ok(RS.reservedRestoreNames(jobs, { now, snapAt: RS.inventoryAtOf(snap({ initial: true })) }).has(key), '첫 병합 전 골격');
  assert.ok(!RS.reservedRestoreNames(jobs, { now, snapAt: RS.inventoryAtOf(snap({}, { collectSource: 'site', receivedAt: now })) }).has(key), '사이트는 엣지 수신 시각');
  assert.ok(RS.reservedRestoreNames(jobs, { now, snapAt: RS.inventoryAtOf(snap({}, { collectSource: 'site', receivedAt: end - 1 })) }).has(key), '사이트 수신이 끝보다 앞 — 풀지 않는다');
  // Director 시간대가 달라 endedAt 이 9시간 이르게 읽혀도 포탈 시계(checkedAt)로 본다
  const tz = [{ vcenterId: 'vc-a', restores: [{ ...jobs[0].restores[0], checkedAt: now - 60_000 }] }];
  assert.ok(RS.reservedRestoreNames(tz, { now, snapAt: RS.inventoryAtOf(snap()) }).has(key), 'endedAt 이 아니라 끝을 본 포탈 시각 기준');
  // 시험 1대 성공 — 끝맺음까지(B4-02) · 서버 drRestorePassed = 웹 drRestorePassed = 실행기 sentItemState 'ok'
  const cases = [
    { state: 'ok', nic: 'disconnect', finish: { nic: 'ok' } },
    { state: 'warning', nic: 'disconnect', finish: { nic: 'ok' } },
    { state: 'ok', nic: 'disconnect', finish: { nic: 'failed', detail: '권한' } },
    { state: 'ok', nic: 'disconnect' },
    { state: 'ok', nic: 'disconnect', verify: true, finish: { nic: 'ok', verify: 'ok' } },
    { state: 'ok', nic: 'disconnect', verify: true, finish: { nic: 'failed', verify: 'failed' } },
    { state: 'error', nic: 'disconnect', finish: { nic: 'skipped' } },
  ];
  const old = now - 30 * 3600_000;   // 끝맺음 시한(24시간)이 지난 행 — 실행기도 최종 판정을 낸다
  for (const c of cases) {
    const r = { jobid: 5, status: c.state === 'error' ? 'f' : 'T', at: old, endedAt: old, ...c };
    const srv = PLAN.drRestorePassed(r);
    assert.equal(WEB.drRestorePassed(r), srv, `웹 = 서버 ${JSON.stringify(c)}`);
    assert.equal(RN.sentItemState({ rid: 5 }, { restores: [r] }, { verify: c.verify === true }, now).state === 'ok', srv, `실행기 = 서버 ${JSON.stringify(c)}`);
  }
  assert.equal(PLAN.drTrialIssue([{ vcenterId: 'vc-a', restores: [{ dr: true, ...cases[2], at: now }] }], 'vc-a', 2, now) !== '', true, 'NIC 끊기 실패한 시험은 통과가 아니다');
  // B1-06: 끝맺음 시한이 지나도록 결과가 없으면 'ok' 가 아니라 결과 모름
  assert.equal(RN.sentItemState({ rid: 5 }, { restores: [{ jobid: 5, status: 'T', state: 'ok', nic: 'disconnect', at: old, endedAt: old }] }, {}, now).state, 'unknown');
  // B2-06: 단계 이름의 제어 · 양방향 문자
  const w = RN.normWaves([{ name: 'A\nB‮C', concurrency: 1, items: [{ id: 'a', jobid: 1, newVm: { name: 'x' } }] }]);
  assert.equal(w[0].name, 'A B C');
});

test('⑫ B1-01 · B3-03 저장 실패 — 시작은 되돌림(보내지 않음) · 멈춤은 메모리에 남기고 다음 틱에 다시 저장', async () => {
  const run = RN.createRun({ vcenterId: 'vc-a', directorId: ID.dir, by: 'adm', waves: [{ name: 'S', concurrency: 1, items: [W('ci10', 'ci-10-s')] }] });
  const f = stateFile();
  fs.rmSync(f); fs.mkdirSync(f);   // rename 이 실패한다(디스크 · 권한 오류 흉내)
  try {
    assert.throws(() => RN.createRun({ vcenterId: 'vc-b', directorId: ID.dir, by: 'adm', waves: [{ name: 'B', concurrency: 1, items: [{ id: ID.db, jobid: H('db', 130), newVm: { name: 'db-09-s' } }] }] }), (e) => e.code === 'save-failed' && !/\//.test(e.message));
    assert.ok(!RN.drRunsView().runs.some((r) => r.vcenterId === 'vc-b' && r.state === 'running'), '저장 못 한 시작은 메모리에도 없다');
    const st = RN.stopRun(run.id, 'adm');
    assert.deepEqual([st.state, st.saved], ['stopped', false], '멈춤은 되돌리지 않는다(보내지 않는 쪽)');
  } finally { fs.rmSync(f, { recursive: true, force: true }); }
  await tick();
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).runs.find((r) => r.id === run.id).state, 'stopped', '다음 틱에 다시 저장했다');
});

test('⑬ B1-03 · B3-02 멈춘 회차에 남은 보내던 VM — 붙잡고 결과 모름 기록(재시작 뒤)', async () => {
  const run = RN.createRun({ vcenterId: 'vc-a', directorId: ID.dir, by: 'adm', waves: [{ name: 'X', concurrency: 1, items: [W('ad11', 'ad-11-x')] }] });
  RN.stopRun(run.id, 'adm');
  const f = stateFile();
  const db = JSON.parse(fs.readFileSync(f, 'utf8'));
  Object.assign(db.runs.find((r) => r.id === run.id).waves[0].items[0], { state: 'sending', batchId: `${run.id}-zz` });
  fs.writeFileSync(f, JSON.stringify(db));
  RN._resetDrRunsForTest();
  assert.ok(RN.drRunHeldIds().has(ID.ad11), '멈춘 회차라도 보내던 VM 은 다른 경로가 보내지 못한다');
  const before = restoreCmds().length;
  await tick();
  const v = RN.drRunsView().runs.find((x) => x.id === run.id);
  assert.deepEqual([v.state, v.waves[0].items[0].state], ['stopped', 'unknown']);
  assert.ok(job('ad11').restores.some((r) => registry.restoreUnknownHeld(r) && r.drRun === run.id), '원장에 결과 모름 붙잡기');
  assert.equal(restoreCmds().length, before);
});

test('⑭ B1-02 보내기 전 세션 끊김은 대기로 돌리고 멈춤 · 보내기 전 판정 막힘은 바로 멈춤(단계 끝까지 기다리지 않음)', async () => {
  const svc = await import('../src/bareos/service.js');
  let run = RN.createRun({ vcenterId: 'vc-a', directorId: ID.dir, by: 'adm', waves: [{ name: 'D', concurrency: 2, items: [W('dns12', 'dns-12-d'), W('ci10', 'ci-10-d')] }] });
  const before = restoreCmds().length;
  svc._setSessionFactoryForTest(async () => ({ call: async () => { throw Object.assign(new Error('세션 끊김'), { code: 'closed' }); }, close() {}, _fail() {} }));
  try { await tick(); } finally { svc._setSessionFactoryForTest(null); }
  let v = RN.drRunsView().runs.find((x) => x.id === run.id);
  assert.deepEqual(v.waves[0].items.map((i) => i.state), ['queued', 'queued'], '보내지 않은 VM 을 실패로 굳히지 않는다');
  assert.equal(v.state, 'paused');
  assert.match(v.reason, /보내지 못했습니다/);
  assert.equal(restoreCmds().length, before);
  RN.stopRun(run.id, 'adm');
  // 판정 막힘: 1번 VM 의 클러스터가 없어졌다 — 그 VM 은 실패 · 바로 멈춤 · 2번은 대기 그대로
  run = RN.createRun({ vcenterId: 'vc-a', directorId: ID.dir, by: 'adm', waves: [{ name: 'P', concurrency: 1, items: [{ ...W('ci10', 'ci-10-p'), newVm: { name: 'ci-10-p', dc: 'DC-NEW', cluster: 'CL-ZZ' } }, W('dns12', 'dns-12-p')] }] });
  await tick();
  v = RN.drRunsView().runs.find((x) => x.id === run.id);
  assert.deepEqual([v.state, v.waves[0].items.map((i) => i.state)], ['paused', ['failed', 'queued']]);
  assert.match(v.waves[0].items[0].reason, /보내지 않았습니다/);
  RN.resumeRun(run.id, 'adm');
  await tick();
  assert.ok(restoreCmds().some((c) => c.includes('dns-12-p')), '확인하고 계속하면 다음 VM 을 보낸다');
  await finishAll('T'); await tick(); await tick();
  assert.equal(RN.drRunsView().runs.find((x) => x.id === run.id).state, 'done');
});

test('⑮ B1-04 첫 수집 전 골격 — 멈추지 않고 기다림(사유) · 30분 넘으면 멈춤 / B2-04 인증 정지면 보내지 않고 멈춤', async () => {
  let run = RN.createRun({ vcenterId: 'vc-a', directorId: ID.dir, by: 'adm', waves: [{ name: 'K', concurrency: 1, items: [W('ci10', 'ci-10-k')] }] });
  const before = restoreCmds().length;
  store.snapshot.initial = true;
  try {
    await tick();
    let v = RN.drRunsView().runs.find((x) => x.id === run.id);
    assert.equal(v.state, 'running');
    assert.match(v.reason, /수집을 기다리는/);
    for (let i = 0; i < 200 && (await RN.drTick(Date.now() + 31 * 60_000)) === null; i++) await new Promise((r) => setTimeout(r, 25));
    v = RN.drRunsView().runs.find((x) => x.id === run.id);
    assert.equal(v.state, 'paused');
    assert.match(v.reason, /읽지 못해/);
  } finally { delete store.snapshot.initial; }
  assert.equal(restoreCmds().length, before);
  RN.stopRun(run.id, 'adm');
  const svc = await import('../src/bareos/service.js');
  const S = await import('../src/bareos/settings.js');
  const cred = S.directorCred(S.directorById(ID.dir, svc.effectiveSettings()));
  svc.bareosAuthGuard.markAuthStopped(cred.id, cred, '인증 실패(시험)');
  try {
    run = RN.createRun({ vcenterId: 'vc-a', directorId: ID.dir, by: 'adm', waves: [{ name: 'A', concurrency: 1, items: [W('ci10', 'ci-10-a')] }] });
    await tick();
    const v = RN.drRunsView().runs.find((x) => x.id === run.id);
    assert.equal(v.state, 'paused');
    assert.match(v.reason, /인증 실패/);
    assert.equal(restoreCmds().length, before, '틀린 줄 아는 접속값으로 다시 로그인하지 않는다');
    RN.stopRun(run.id, 'adm');
  } finally { svc.bareosAuthGuard.clearAuthStop(cred.id); }
});

test('⑯ B2-01 dr/check 사이트 매핑 warn 도 범위 · 데모 계정에 값 가림 / B4-06 점검중 vCenter 는 ✕ / B4-03 · B4-05 standalone · 접근 불가 DS · 같은 이름 DS', async () => {
  let r = await call('admin', 'GET', '/dr/check?vcenterId=vc-a');
  const site = r.j.checks.find((c) => c.key === 'site');
  assert.equal(site.state, 'warn');
  assert.match(site.detail, /vc-a\.corp/, '전체 범위 관리자는 값을 본다');
  r = await call('sadm', 'GET', '/dr/check?vcenterId=vc-a');
  const s2 = r.j.checks.find((c) => c.key === 'site');
  assert.equal(s2.state, 'warn');
  assert.doesNotMatch(s2.detail, /vc-a\.corp|vc-a-new|\.ini|kr-fd/, '범위 계정에는 주소 · INI · FD 를 싣지 않는다');
  const vcA = store.snapshot.vcenters.find((v) => v.id === 'vc-a');
  vcA.maintenance = true; vcA.status = 'maintenance';
  try {
    r = await call('admin', 'GET', '/dr/check?vcenterId=vc-a');
    assert.equal(r.j.checks.find((c) => c.key === 'vcenter').state, 'bad', '점검중 vCenter 의 인벤토리는 옛것이다');
  } finally { delete vcA.maintenance; vcA.status = 'connected'; }
  const snap = { vcenters: [{ id: 'v', status: 'connected' }], hosts: [{ vcenterId: 'v', name: 'h1', cluster: 'standalone', vcDatacenter: null }], datastores: [{ vcenterId: 'v', name: 'd1', freeGB: 10, capacityGB: 20 }, { vcenterId: 'v', name: 'd1', freeGB: 5000, capacityGB: 9000 }, { vcenterId: 'v', name: 'dx', freeGB: 1, capacityGB: 2, accessible: false }], vms: [] };
  const view = PLAN.drCheckView({ vcenterId: 'v', snapshot: snap, jobs: [], site: null, director: null, dirPoll: null, lastOkOf: () => null });
  assert.deepEqual(view.targets.clusters, [], 'standalone 은 클러스터가 아니다');
  assert.equal(view.checks.find((c) => c.key === 'vcenter').state, 'unknown', '호스트는 있는데 데이터센터를 못 읽음 — 0 으로 단정하지 않는다');
  assert.equal(view.targets.datastores.find((d) => d.name === 'd1').freeGB, null, '같은 이름 DS 둘 — 여유를 싣지 않는다');
  const job0 = { id: 'j', vcenterId: 'v', vmName: 'x', vmId: 'v:x', dc: 'DC', folder: '/' };
  assert.match(RS.restorePlan({ mode: 'newVm', job: job0, snapshot: snap, newVm: { name: 'y', cluster: 'standalone' }, pluginName: 'vmware', base: { vcserver: 'v', configFile: '/x.ini' } }).issue || '', /클러스터가 아닙니다/);
  assert.match(RS.restorePlan({ mode: 'newVm', job: job0, snapshot: snap, newVm: { name: 'y', datastore: 'dx' }, pluginName: 'vmware', base: { vcserver: 'v', configFile: '/x.ini' } }).issue || '', /접근할 수 없습니다/);
});

test('⑰ B3-04 보내는 중인 새 이름 · 진행 중 회차가 쓸 이름은 묶음 복원이 쓰지 못한다 / B5-06 · B2-05 상태 파일 못 읽음은 계획 확인도 503 / B2-03 Director 미완은 OTP 앞 409', async () => {
  const L = await import('../src/bareos/jobLocks.js');
  const k = L.restoreNameKey('vc-a', 'zz-dup');
  assert.ok(L.tryHoldNames([k]));
  try {
    const r = await call('admin', 'POST', '/restore-check/bulk', { items: [{ id: ID.ci10, jobid: H('ci10', 130), mode: 'newVm', nic: 'disconnect', newVm: { name: 'ZZ-DUP', cluster: 'CL-A' } }] });
    assert.match(r.j.plan.items[0].issue || '', /최근 복원/, '다른 요청이 지금 보내는 이름');
    assert.equal(L.tryHoldNames([k]), false);
  } finally { L.releaseNames([k]); }
  const run = RN.createRun({ vcenterId: 'vc-a', directorId: ID.dir, by: 'adm', waves: [{ name: 'N', concurrency: 1, items: [W('ci10', 'ci-10-n')] }] });
  let r = await call('admin', 'POST', '/restore-check/bulk', { items: [{ id: ID.fs7, jobid: H('fs7', 130), mode: 'newVm', nic: 'disconnect', newVm: { name: 'ci-10-n', cluster: 'CL-A' } }] });
  assert.match(r.j.plan.items[0].issue || '', /최근 복원/, '회차가 쓸 이름');
  RN.stopRun(run.id, 'adm');
  // 상태 파일 손상 → 계획 확인도 503
  const f = stateFile();
  const keep = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, '{"runs":{}}');
  RN._resetDrRunsForTest();
  try {
    r = await call('admin', 'POST', '/dr/runs/check', { vcenterId: 'vc-a', waves: [{ concurrency: 1, items: [W('fs7', 'fs-07-q')] }] });
    assert.equal(r.s, 503, 'B3-06: 모양이 틀린 상태 파일은 손상과 같다');
  } finally { fs.writeFileSync(f, keep); RN._resetDrRunsForTest(); }
  // Director 접속값이 덜 됐으면(주소를 바꿔 저장 비밀번호 폐기) 시작은 OTP 앞에서 409
  const S = await import('../src/bareos/settings.js');
  const svc = await import('../src/bareos/service.js');
  const d = S.directorById(ID.dir, svc.effectiveSettings());
  r = await call('admin', 'PUT', `/settings/directors/${ID.dir}`, { name: d.name, host: 'localhost', port: d.port, consoleName: d.consoleName, timeoutMs: 5000 });
  assert.ok(r.s < 300, r.t);
  r = await call('admin', 'POST', '/dr/runs', { vcenterId: 'vc-a', waves: [{ concurrency: 1, items: [W('fs7', 'fs-07-q')] }], otp: '000000' });
  assert.equal(r.s, 409, '틀린 OTP 라도 403 이 아니라 409 — 전제가 OTP 앞이다');
  assert.match(r.j.reason, /덜 됐습니다/);
});

