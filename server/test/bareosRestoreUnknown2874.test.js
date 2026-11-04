/**
 * test/bareosRestoreUnknown2874.test.js — v2.874 점검 B5-01(high · 재현): 복원 명령을 보낸 뒤 회신이 끊긴 '결과 모름' 이 두 번째 복원을 부르지 않는다.
 *  예전: 묶음 전 항목이 결과 모름이면 502 '한 대도 시작하지 못했습니다'(웹은 확정 실패로 보여 다시 누르게 했다) · 원장 · 이름 예약 없음 → 같은 요청 두 번째가 202(실측).
 *  ① 묶음: 504 + code 'unknown' + unknown 수 · 원장에 결과 모름 기록 · 같은 요청은 Director 에 닿기 전에 거부 · 새 VM 이름 예약 · 삭제 409
 *  ② 단건: 보낸 뒤 끊김 = 504 결과 모름(ops.restore 가 MID_COMMAND_CODES 를 unknown 으로) · 원장 기록 · 다시 보내면 409 unknown-held
 *  ③ 붙잡기는 시한이 있다(RESTORE_UNKNOWN_HOLD_MS — 웹과 같은 값) · jobid 가 있으면(진행 중 추적) 결과 모름이 아니다
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareosunknown2874-'));
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


test('① 묶음 — 결과 모름은 504 · 원장에 남고 · 같은 요청은 Director 에 닿기 전에 거부 · 이름 예약 · 삭제 409', async () => {
  const items = [{ id: ID.web, jobid: H('web', 130), mode: 'newVm', newVm: { name: 'web-01-r' } }];
  DROP.on = true;
  let before = D.cmds.length;
  let r = await call('admin', 'POST', '/restore/bulk', { items, otp: otpNow() });
  DROP.on = false;
  assert.equal(r.s, 504, r.t);
  assert.deepEqual([r.j.ok, r.j.started, r.j.unknown, r.j.code], [false, 0, 1, 'unknown']);
  assert.equal(r.j.items[0].code, 'unknown');
  assert.match(r.j.reason, /결과를 모릅니다/);
  assert.equal(D.cmds.slice(before).filter((c) => c.startsWith('restore ')).length, 1, '첫 요청은 명령을 보냈다');
  const rec = job('web').restores[0];
  assert.deepEqual([rec.unknown, rec.state, rec.jobid, rec.mode, rec.target?.name, rec.batchId, rec.nic], [true, 'unknown', null, 'newVm', 'web-01-r', r.j.batchId, 'disconnect']);
  assert.equal(registry.restoreOpen(rec), false, 'jobid 가 없어 폴러가 추적하지 않는다');
  assert.equal(registry.restoreHeld(rec), true);
  // 같은 요청 — 판정에서 거부(OTP 를 쓰지 않고 Director 에 닿지 않는다)
  before = D.cmds.length;
  r = await call('admin', 'POST', '/restore/bulk', { items, otp: 'x' });
  assert.equal(r.s, 400, r.t);
  assert.match(r.j.plan.items[0].issue, /결과를 모릅니다/);
  assert.equal(D.cmds.length, before, 'Director 에 닿지 않는다');
  // 미리 보기도 같은 사유
  const ck = await call('admin', 'POST', '/restore-check/bulk', { items });
  assert.match(ck.j.plan.items[0].issue, /결과를 모릅니다/);
  // 다른 VM 이 그 이름을 쓰려 하면 예약(만들어졌을 수 있다)
  r = await call('admin', 'POST', '/restore-check/bulk', { items: [{ id: ID.app, jobid: H('app', 130), mode: 'newVm', newVm: { name: 'WEB-01-R' } }] });
  assert.match(r.j.plan.items[0].issue, /최근 복원/);
  // 결과 모름 대상은 지우지 않는다(지우면 그 복원을 확인할 길이 사라진다)
  r = await call('admin', 'DELETE', `/jobs/${ID.web}`);
  assert.equal(r.s, 409, r.t);
});

test('② 단건 — 보낸 뒤 끊김은 504 결과 모름 · 원장 기록 · 다시 보내면 409 unknown-held', async () => {
  DROP.on = true;
  let r = await call('admin', 'POST', `/jobs/${ID.app}/restore`, { jobid: H('app', 130), mode: 'newVm', newVm: { name: 'app-05-r' }, otp: generateToken(SECRET, { counter: Math.floor(Date.now() / 30_000) + 1 }) });   // ① 이 지금 칸을 썼다(1회용)
  DROP.on = false;
  assert.equal(r.s, 504, r.t);
  assert.equal(r.j.code, 'unknown');
  const rec = job('app').restores[0];
  assert.deepEqual([rec.unknown, rec.jobid, rec.target?.name], [true, null, 'app-05-r']);
  const before = D.cmds.length;
  r = await call('admin', 'POST', `/jobs/${ID.app}/restore`, { jobid: H('app', 130), mode: 'newVm', newVm: { name: 'app-05-r2' }, otp: 'x' });
  assert.equal(r.s, 409, r.t);
  assert.equal(r.j.code, 'unknown-held');
  assert.equal(D.cmds.length, before);
});

test('③ 붙잡기는 시한이 있다(웹과 같은 값) · jobid 가 있으면 결과 모름이 아니다', async () => {
  const { RESTORE_UNKNOWN_HOLD_MS, restoreUnknownHeld, restoreHeld } = registry;
  assert.equal(RESTORE_UNKNOWN_HOLD_MS, 6 * 3600_000);
  const now = Date.now();
  assert.equal(restoreUnknownHeld({ unknown: true, jobid: null, at: now - RESTORE_UNKNOWN_HOLD_MS + 1000 }, now), true);
  assert.equal(restoreUnknownHeld({ unknown: true, jobid: null, at: now - RESTORE_UNKNOWN_HOLD_MS - 1 }, now), false, '시한이 지나면 놓는다');
  assert.equal(restoreUnknownHeld({ unknown: true, jobid: 7, at: now }, now), false);
  assert.equal(restoreHeld({ jobid: 7, status: 'R', at: now }, now), true, '진행 중은 그대로 붙잡는다');
  assert.equal(restoreHeld({ jobid: 7, status: 'T', at: now }, now), false);
  // 웹(복원 화면의 고르기 막기)이 같은 시한을 쓴다
  const web = fs.readFileSync(new URL('../../web/src/views/tools/bareosRestoreText.js', import.meta.url), 'utf8');
  assert.match(web, /export const RESTORE_UNKNOWN_HOLD_MS = 6 \* 3600_000;/);
});
