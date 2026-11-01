/**
 * test/bareosGroups2830.test.js — v2.830 Bareos 백업 그룹(사용자 요청 '전체 VM 에서 고른 VM 을 그룹으로 — 이름·스케줄·스토리지, 나중에 수정').
 *  ① 스케줄 판정(groupSchedule — 순수): 입력 판정 · 지난/다음 회차 · 같은 회차 한 번 · 바꾸기 전 회차 안 돌림 · 따라잡는 범위 밖은 놓침 · Full 요일
 *  ② 라우트(실제 routes/api.js + 가짜 Director): admin 전용 · 조회 밖 404 → 쓰기 밖 403 · 트리(시스템 VM 제외 · 등록 불가 사유)
 *  ③ 저장: 잡 없는 VM 은 **Director 스케줄 없이** 등록 · 등록 못 한 VM 은 빼고 사유 · 이름 중복·VM 두 그룹 409 · 스케줄을 바꾸면 anchorAt 갱신
 *  ④ 실행: run 명령에 storage=·pool= · pending(trigger group) · 이미 실행 중이면 건너뜀 · 실행 중 같은 대상 삭제 409(잠금 공용) · 같은 그룹 두 번 409
 *  ⑤ 예약 틱: 회차를 **보내기 전에** 파일에 남긴다 · 같은 회차 두 번 안 보냄 · 놓친 회차 기록 · 원장 손상이면 아무것도 안 보냄
 *  ⑥ 엣지 회신 정제(runJobs: 성공인데 jobid 없음 = 결과 모름) · ops.runJobs 세션이 끊기면 남은 것 건너뜀 · runJob 이름 검사
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareosgroups-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
process.env.SSRF_ALLOW_LOOPBACK = 'true';

const { generateSecret, generateToken } = await import('../src/auth/totp.js');
const SECRET = generateSecret();   // v2.831.1 보관 개수 저장의 본인 OTP 시험용(adm 만 등록 · noot 은 미등록)
fs.writeFileSync(path.join(tmp, 'users.json'), JSON.stringify({ users: [{ username: 'adm', role: 'admin', totpEnabled: true, totpSecret: SECRET }, { username: 'noot', role: 'admin' }] }));
const { startFakeDirector } = await import('./_fakeBareosDirector.js');
const S = await import('../src/bareos/groupSchedule.js');

const D = { jobs: new Map(), nextId: 900, cmds: [], gate: null, gateFor: null, hist: new Map(), ignoreDelete: false };
async function handle(cmd) {
  D.cmds.push(cmd);
  if (D.gate && (!D.gateFor || D.gateFor(cmd))) await D.gate;
  const kv = Object.fromEntries([...cmd.matchAll(/(\w+)=("(?:\\.|[^"])*"|\S+)/g)].map((m) => [m[1], m[2]]));
  if (cmd === '.clients') return { clients: [{ name: 'kr-fd' }] };
  if (cmd === '.storages') return { storages: [{ name: 'kr-sd' }, { name: 'kr-sd2' }] };
  if (cmd === '.pools') return { pools: [{ name: 'VMwareKR' }, { name: 'LongTerm' }] };
  if (cmd === '.jobs') return { jobs: [...D.jobs].map(([name]) => ({ name, enabled: true })) };
  if (cmd.startsWith('configure add job')) { D.jobs.set(kv.name, {}); return { add: { resource: 'Job', name: kv.name } }; }
  if (cmd.startsWith('run ')) { if (D.failRun?.(kv)) return { error: ['Storage resource "nope" not found.'] }; return { run: { jobid: D.nextId++ } }; }
  if (cmd.startsWith('list jobs job=') && D.hist.has(kv.job)) return { jobs: D.hist.get(kv.job).map((r) => ({ ...r })) };
  if (cmd.startsWith('list jobs')) return { jobs: [] };
  if (cmd.startsWith('delete jobid=')) {   // v2.831 보관 개수 정리
    const ids = new Set(kv.jobid.split(',').map(Number));
    if (!D.ignoreDelete) for (const [n, rows] of D.hist) D.hist.set(n, rows.filter((r) => !ids.has(r.jobid)));
    return {};
  }
  if (cmd.startsWith('llist jobid=')) return { jobs: [] };
  return { error: [`unknown command ${cmd}`] };
}

const USERS = {
  admin: { username: 'adm', role: 'admin', scope: null },
  noot: { username: 'noot', role: 'admin', scope: null },
  op: { username: 'op', role: 'operator', scope: null },
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-a'] } },
  wadm: { username: 'wadm', role: 'admin', scope: { writeVcenters: ['vc-b'] } },
  demo: { username: 'thedvcdemp', role: 'admin', demoGuest: true, scope: null },   // mock 모드 내장 데모 계정(요청 문맥 admin + demoGuest)
};
let srv; let base; let fd; let store; let registry; let groups; let runner; let runnerRetention;

before(async () => {
  fd = await startFakeDirector({ name: 'portal', password: 'pw-1', handle });
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  ({ store } = await import('../src/store.js'));
  registry = await import('../src/bareos/registry.js');
  groups = await import('../src/bareos/groups.js');
  runner = await import('../src/bareos/groupRunner.js');
  runnerRetention = await import('../src/bareos/groupRetention.js');
  store.snapshot = {
    generatedAt: Date.now(), source: 'mock',
    vcenters: [{ id: 'vc-a', name: 'Seoul', host: 'https://vc-a.corp' }, { id: 'vc-b', name: 'Warsaw', host: 'https://vc-b.corp' }],
    hosts: [], datastores: [], alarms: [], networks: [],
    vms: [
      { id: 'vc-a:vm-1', vcenterId: 'vc-a', name: 'web-01', folder: 'DC-A / web', powerState: 'POWERED_ON', storageGB: 120.04, vcDcPath: 'DC-A', folderPath: '/web' },
      { id: 'vc-a:vm-2', vcenterId: 'vc-a', name: 'tpl', template: true, folder: 'DC-A', vcDcPath: 'DC-A', folderPath: '/' },
      { id: 'vc-a:vm-3', vcenterId: 'vc-a', name: 'vapp-child', folder: 'DC-A', powerState: 'POWERED_ON', vcDcPath: null, folderPath: null },
      { id: 'vc-a:vm-5', vcenterId: 'vc-a', name: 'app-05', folder: 'DC-A / app', powerState: 'POWERED_ON', vcDcPath: 'DC-A', folderPath: '/app' },
      { id: 'vc-a:vm-6', vcenterId: 'vc-a', name: 'app-06', folder: 'DC-A / app', powerState: 'POWERED_OFF', vcDcPath: 'DC-A', folderPath: '/app' },
      { id: 'vc-a:vm-7', vcenterId: 'vc-a', name: 'vCLS-xyz', folder: 'DC-A', powerState: 'POWERED_ON', vcDcPath: 'DC-A', folderPath: '/' },
      { id: 'vc-b:vm-9', vcenterId: 'vc-b', name: 'db-09', folder: 'DC-B', powerState: 'POWERED_ON', vcDcPath: 'DC-B', folderPath: '/' },
    ],
  };
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api/tools/bareos-backup`;
  // Director + 매핑(vc-a·vc-b 같은 Director — 이 시험은 법인 구분보다 그룹 흐름을 본다)
  let r = await call('admin', 'POST', '/settings/directors', { name: '한국', host: '127.0.0.1', port: fd.port, consoleName: 'portal', password: 'pw-1', timeoutMs: 5000 });
  assert.equal(r.s, 201, r.t);
  const dir = r.j.director.id;
  r = await call('admin', 'PUT', '/settings', {
    sites: [
      { vcenterId: 'vc-a', directorId: dir, vcserver: 'vc-a.corp', client: 'kr-fd', storage: 'kr-sd', pool: 'VMwareKR', schedule: 'VMwareNightly', configFile: '/etc/bareos/vmware/vc-a.ini' },
      { vcenterId: 'vc-b', directorId: dir, vcserver: 'vc-b.corp', client: 'kr-fd', storage: 'kr-sd', pool: 'VMwareKR', configFile: '/etc/bareos/vmware/vc-b.ini' },
    ],
  });
  assert.equal(r.s, 200, r.t);
});
after(async () => { runner?._resetGroupRunnerForTest(); try { srv?.close(); } catch { /* */ } await fd?.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

async function call(u, method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, j, t };
}
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };
const EVERY = { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], time: '02:10', level: 'Incremental' };

/* ───────── ① 스케줄 판정 ───────── */
test('① 입력 판정 — 시각 형식 · 켰는데 요일 없음 · Full 요일은 실행 요일 안에서만 · 레벨 Full 이면 Full 요일 없음', () => {
  assert.throws(() => S.normSchedule({ enabled: true, days: [1], time: '24:00' }), /HH:MM/);
  assert.throws(() => S.normSchedule({ enabled: true, days: [], time: '02:00' }), /요일/);
  assert.deepEqual(S.normSchedule({ enabled: false, days: [], time: '02:00' }).days, []);
  const s = S.normSchedule({ enabled: true, days: [5, 1, 1, 9, 3], time: '02:10', level: 'Incremental', fullDays: [5, 6] });
  assert.deepEqual(s.days, [1, 3, 5]);
  assert.deepEqual(s.fullDays, [5]);
  assert.deepEqual(S.normSchedule({ enabled: true, days: [1], time: '02:10', level: 'Full', fullDays: [1] }).fullDays, []);
  assert.equal(S.normSchedule({ enabled: true, days: [1], time: '02:10', level: '아무거나' }).level, 'Incremental');
});

test('① 지난/다음 회차 — 서버 현지 시각 · 같은 분은 지난 회차 · Full 요일 레벨', () => {
  const sched = S.normSchedule({ enabled: true, days: [1, 3, 5], time: '02:10', level: 'Incremental', fullDays: [5] });
  const wed10 = new Date(2026, 9, 28, 10, 0).getTime();   // 2026-10-28 수요일
  assert.equal(new Date(wed10).getDay(), 3);
  const last = S.lastDueSlot(sched, wed10);
  assert.equal(last.key, '2026-10-28 02:10');
  assert.equal(last.level, 'Incremental');
  const next = S.nextSlot(sched, wed10);
  assert.equal(next.key, '2026-10-30 02:10');
  assert.equal(next.level, 'Full', '금요일은 Full 요일');
  const at = new Date(2026, 9, 30, 2, 10).getTime();
  assert.equal(S.lastDueSlot(sched, at).key, '2026-10-30 02:10', '그 분 정각이면 지난 회차');
  assert.equal(S.nextSlot(sched, at).key, '2026-11-02 02:10', '월말을 넘겨 다음 월요일');
  assert.equal(S.nextSlot({ ...sched, enabled: false }, wed10), null);
  assert.equal(S.scheduleText(sched), '월·수·금 02:10 Incremental (Full: 금)');
  assert.equal(S.scheduleText(EVERY), '매일 02:10 Incremental');
  assert.equal(S.scheduleText({ ...sched, enabled: false }), '스케줄 꺼짐(수동 실행만)');
});

test('① decideFire — 한 회차 한 번 · 스케줄을 바꾸기 전 회차는 안 돌림 · 따라잡는 범위 밖은 놓침', () => {
  const sched = S.normSchedule(EVERY);
  const slot = new Date(2026, 9, 28, 2, 10).getTime();
  const g = { schedule: sched, anchorAt: slot - 60_000, lastKey: '' };
  assert.equal(S.decideFire(g, slot + 30_000).action, 'fire');
  assert.equal(S.decideFire({ ...g, lastKey: '2026-10-28 02:10' }, slot + 30_000).action, 'none', '같은 회차는 한 번');
  assert.equal(S.decideFire({ ...g, anchorAt: slot + 1 }, slot + 30_000).action, 'none', '02:10 뒤에 저장한 스케줄은 내일부터');
  assert.equal(S.decideFire(g, slot + S.CATCHUP_MS + 1).action, 'miss');
  assert.equal(S.decideFire(g, slot + S.CATCHUP_MS).action, 'fire', '경계는 돌린다');
  assert.equal(S.decideFire({ ...g, schedule: { ...sched, enabled: false } }, slot + 30_000).action, 'none');
});

/* ───────── ② 트리·권한 ───────── */
test('② 트리 — admin 전용 · 범위 밖 404 · 시스템 VM 제외 · 등록 불가 사유 · 용량', async () => {
  assert.equal((await call('op', 'GET', '/groups/tree?vcenterId=vc-a')).s, 403);
  assert.equal((await call('sadm', 'GET', '/groups/tree?vcenterId=vc-b')).s, 404);
  const r = await call('admin', 'GET', '/groups/tree?vcenterId=vc-a');
  assert.equal(r.s, 200, r.t);
  const ids = r.j.vms.map((v) => v.id);
  assert.ok(!ids.includes('vc-a:vm-2') && !ids.includes('vc-a:vm-7'), '템플릿·vCLS 는 트리에 없다');
  assert.ok(ids.includes('vc-a:vm-1') && ids.includes('vc-a:vm-3'));
  const vapp = r.j.vms.find((v) => v.id === 'vc-a:vm-3');
  assert.equal(vapp.eligible, false);
  assert.match(vapp.reason, /데이터센터·폴더 경로/);
  assert.equal(r.j.vms.find((v) => v.id === 'vc-a:vm-1').gb, 120);
  assert.equal(r.j.writable, true);
  assert.equal(r.j.director.name, '한국');
  assert.ok(r.j.limits.maxMembers > 0 && typeof r.j.tz === 'string');
  assert.doesNotMatch(r.t, /pw-1/);
});

test('② 스토리지·풀 목록 — Director 카탈로그 · 범위 밖 404', async () => {
  assert.equal((await call('sadm', 'GET', '/groups/options?vcenterId=vc-b')).s, 404);
  const r = await call('admin', 'GET', '/groups/options?vcenterId=vc-a&refresh=1');
  assert.equal(r.s, 200, r.t);
  assert.deepEqual(r.j.storages, ['kr-sd', 'kr-sd2']);
  assert.deepEqual(r.j.pools, ['LongTerm', 'VMwareKR']);
});

test('② 검토 H1 — 데모 계정은 스토리지·풀 목록으로 사람이 등록한 Director 에 접속하지 못한다(403 · 접속 0)', async () => {
  D.cmds.length = 0;
  const r = await call('demo', 'GET', '/groups/options?vcenterId=vc-a');
  assert.equal(r.s, 403, r.t);
  assert.equal(D.cmds.length, 0, `Director 에 닿았다: ${D.cmds.join(' | ')}`);
});

/* ───────── ③ 저장 ───────── */
let G1 = '';
test('③ 만들기 — 잡 없는 VM 은 Director 스케줄 없이 등록 · 등록 못 한 VM 은 빼고 사유 · 그룹 저장', async () => {
  D.cmds.length = 0;
  const r = await call('admin', 'POST', '/groups', {
    vcenterId: 'vc-a', name: '웹 서버', vmIds: ['vc-a:vm-1', 'vc-a:vm-5', 'vc-a:vm-3'], schedule: EVERY, storage: 'kr-sd2', pool: 'LongTerm',
  });
  assert.equal(r.s, 201, r.t);
  G1 = r.j.group.id;
  assert.deepEqual(r.j.group.vmIds.sort(), ['vc-a:vm-1', 'vc-a:vm-5']);
  assert.equal(r.j.excluded.length, 1);
  assert.equal(r.j.excluded[0].vmId, 'vc-a:vm-3');
  assert.match(r.j.excluded[0].reason, /경로/);
  const adds = D.cmds.filter((c) => c.startsWith('configure add job'));
  assert.equal(adds.length, 2);
  for (const c of adds) assert.doesNotMatch(c, /schedule=/, `그룹이 실행하므로 Director 스케줄을 붙이지 않는다: ${c}`);
  assert.equal(r.j.group.scheduleText, '매일 02:10 Incremental');
  assert.ok(r.j.group.next?.key);
  assert.deepEqual(r.j.doubleScheduled, [], '새로 만든 잡에는 Director 스케줄이 없다');
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'bareos-groups.json'), 'utf8'));
  assert.equal(saved.groups.length, 1);
  assert.equal(fs.statSync(path.join(tmp, 'bareos-groups.json')).mode & 0o777, 0o600);
});

test('③ 이름 중복(대소문자 무시)·VM 두 그룹 409 · 등록된 VM 이 하나도 없으면 409 · 쓰기 범위 밖 403', async () => {
  let r = await call('admin', 'POST', '/groups', { vcenterId: 'vc-a', name: '웹 서버', vmIds: ['vc-a:vm-6'], schedule: EVERY });
  assert.equal(r.s, 409);
  r = await call('admin', 'POST', '/groups', { vcenterId: 'vc-a', name: 'other', vmIds: ['vc-a:vm-1'], schedule: EVERY });
  assert.equal(r.s, 409);
  assert.match(r.j.reason, /그룹 하나에만/);
  r = await call('admin', 'POST', '/groups', { vcenterId: 'vc-a', name: 'vapp 만', vmIds: ['vc-a:vm-3'], schedule: EVERY });
  assert.equal(r.s, 409);
  assert.equal(r.j.excluded.length, 1);
  r = await call('admin', 'POST', '/groups', { vcenterId: 'vc-a', name: '없는 VM', vmIds: ['vc-a:vm-404'], schedule: EVERY });
  assert.equal(r.s, 400);
  r = await call('admin', 'POST', '/groups', { vcenterId: 'vc-a', name: 'vCLS', vmIds: ['vc-a:vm-7'], schedule: EVERY });
  assert.equal(r.s, 400, '검토 L6 — 화면 트리만 거르면 API 로 vCLS 를 넣을 수 있었다');
  assert.match(r.j.reason, /시스템 VM/);
  r = await call('wadm', 'POST', '/groups', { vcenterId: 'vc-a', name: '쓰기 밖', vmIds: ['vc-a:vm-6'], schedule: EVERY });
  assert.equal(r.s, 403, '조회는 되지만 쓰기 범위 밖');
  r = await call('sadm', 'POST', '/groups', { vcenterId: 'vc-b', name: '조회 밖', vmIds: ['vc-b:vm-9'], schedule: EVERY });
  assert.equal(r.s, 404, '조회 범위 밖은 존재를 숨긴다');
  r = await call('sadm', 'PUT', `/groups/${G1}`, { name: 'x', vmIds: ['vc-a:vm-1'], schedule: EVERY });
  assert.equal(r.s, 200, `조회 범위 vc-a 계정은 vc-a 그룹을 고칠 수 있다(쓰기 범위 미지정 = 조회 범위): ${r.t}`);
  assert.equal(r.j.group.name, 'x');
  r = await call('wadm', 'DELETE', `/groups/${G1}`);
  assert.equal(r.s, 403);
});

test('③ 고치기 — 이름·VM·스토리지 · 스케줄을 바꾸면 anchorAt 이 지금으로(그 앞 회차는 돌리지 않는다)', async () => {
  const before = groups.getGroup(G1);
  await new Promise((r) => setTimeout(r, 5));
  let r = await call('admin', 'PUT', `/groups/${G1}`, { name: '웹 서버', vmIds: ['vc-a:vm-1', 'vc-a:vm-5', 'vc-a:vm-6'], schedule: EVERY, storage: 'kr-sd2', pool: 'LongTerm' });
  assert.equal(r.s, 200, r.t);
  assert.equal(r.j.group.vmIds.length, 3);
  assert.equal(groups.getGroup(G1).anchorAt, before.anchorAt, '스케줄이 같으면 anchorAt 그대로');
  r = await call('admin', 'PUT', `/groups/${G1}`, { name: '웹 서버', vmIds: ['vc-a:vm-1', 'vc-a:vm-5', 'vc-a:vm-6'], schedule: { ...EVERY, time: '03:30' }, storage: 'kr-sd2', pool: 'LongTerm' });
  assert.equal(r.s, 200, r.t);
  assert.ok(groups.getGroup(G1).anchorAt > before.anchorAt);
  assert.equal(r.j.group.schedule.time, '03:30');
  r = await call('admin', 'PUT', `/groups/${G1}`, { name: '웹 서버', vmIds: ['vc-a:vm-1'], schedule: EVERY, storage: 'bad name!' });
  assert.equal(r.s, 400);
  // 검토 M2: 열 때의 수정 시각과 다르면(그사이 다른 화면이 고침) 덮어쓰지 않는다 — 그쪽에서 넣은 VM 이 조용히 빠졌다
  const cur = groups.getGroup(G1);
  r = await call('admin', 'PUT', `/groups/${G1}`, { name: '웹 서버', vmIds: ['vc-a:vm-1'], schedule: cur.schedule, storage: 'kr-sd2', pool: 'LongTerm', updatedAt: cur.updatedAt - 1 });
  assert.equal(r.s, 409, r.t);
  assert.match(r.j.reason, /다른 화면/);
  assert.equal(groups.getGroup(G1).vmIds.length, 3, '거부한 저장은 아무것도 바꾸지 않는다');
  r = await call('admin', 'PUT', `/groups/${G1}`, { name: '웹 서버', vmIds: cur.vmIds, schedule: cur.schedule, storage: 'kr-sd2', pool: 'LongTerm', updatedAt: cur.updatedAt });
  assert.equal(r.s, 200, r.t);
});

/* ───────── ④ 실행 ───────── */
test('④ 지금 실행 — 202 · run 에 storage=·pool= · pending(trigger group) · 다시 실행하면 이미 실행 중이라 건너뜀', async () => {
  D.cmds.length = 0;
  let r = await call('admin', 'POST', `/groups/${G1}/run`, { level: 'Full' });
  assert.equal(r.s, 202, r.t);
  assert.ok(await until(() => !runner.groupRunning(G1)));
  const runs = D.cmds.filter((c) => c.startsWith('run '));
  assert.equal(runs.length, 3);
  for (const c of runs) assert.match(c, /^run job=\S+ level=Full storage=kr-sd2 pool=LongTerm yes$/);
  const fire = groups.getGroup(G1).lastFire;
  assert.equal(fire.started, 3);
  assert.equal(fire.trigger, 'manual');
  const j = registry.listJobs().find((x) => x.vmId === 'vc-a:vm-1');
  assert.equal(j.pending.trigger, 'group');
  assert.equal(j.pending.level, 'Full');
  r = await call('admin', 'POST', `/groups/${G1}/run`, {});
  assert.equal(r.s, 202);
  assert.ok(await until(() => !runner.groupRunning(G1)));
  const again = groups.getGroup(G1).lastFire;
  assert.equal(again.started, 0);
  assert.equal(again.skipped, 3);
  assert.match(again.items[0].reason, /이미 실행 중/);
  assert.equal((await call('admin', 'POST', `/groups/${G1}/run`, { level: 'Weekly' })).s, 400);
});

test('④ 실행 중에는 같은 그룹 409 · 같은 대상 삭제 409(잠금 공용) · 그룹 삭제 409 — Director 가 run 을 붙잡은 동안', async () => {
  for (const j of registry.listJobs()) registry.patchJob(j.id, { pending: null });
  let release;
  D.gate = new Promise((r) => { release = r; });
  D.gateFor = (c) => c.startsWith('run ');
  const r = await call('admin', 'POST', `/groups/${G1}/run`, {});
  assert.equal(r.s, 202);
  assert.ok(await until(() => D.cmds.some((c) => c.startsWith('run ')) && runner.groupRunning(G1)));
  assert.equal((await call('admin', 'POST', `/groups/${G1}/run`, {})).s, 409);
  assert.equal((await call('admin', 'DELETE', `/groups/${G1}`)).s, 409);
  const { runningBareosWork } = await import('../src/bareos/inflight.js');
  assert.ok(runningBareosWork().some((w) => w.key === `group:${G1}`), '업그레이드 자동 적용이 그룹 실행을 기다린다');
  const member = registry.listJobs().find((x) => x.vmId === 'vc-a:vm-1');
  const del = await call('admin', 'DELETE', `/jobs/${member.id}`);
  assert.equal(del.s, 409, del.t);
  assert.match(del.j.reason, /다른 요청을 처리하는 중/);
  D.gate = null; release();
  assert.ok(await until(() => !runner.groupRunning(G1)));
  assert.equal(groups.getGroup(G1).lastFire.started, 3);
  assert.ok(!runningBareosWork().some((w) => w.key === `group:${G1}`), '끝나면 목록에서 빠진다');
});

test('④ Director 가 거부한 항목은 실패로(사유·lastError) · 나머지는 계속', async () => {
  for (const j of registry.listJobs()) registry.patchJob(j.id, { pending: null, lastError: null });
  const target = registry.listJobs().find((x) => x.vmId === 'vc-a:vm-5').bareosJob;
  D.failRun = (kv) => kv.job === target;
  await call('admin', 'POST', `/groups/${G1}/run`, {});
  assert.ok(await until(() => !runner.groupRunning(G1)));
  D.failRun = null;
  const f = groups.getGroup(G1).lastFire;
  assert.equal(f.started, 2);
  assert.equal(f.failed, 1);
  assert.match(f.items.find((x) => x.vmId === 'vc-a:vm-5').reason, /Storage resource/);
  assert.match(registry.listJobs().find((x) => x.vmId === 'vc-a:vm-5').lastError.message, /그룹 ‘웹 서버’ 실행 실패/);
});

/* ───────── ⑤ 예약 틱 ───────── */
test('⑤ 예약 — 회차를 보내기 전에 파일에 남긴다 · 같은 회차는 다시 안 보냄 · trigger group-schedule', async () => {
  for (const j of registry.listJobs()) registry.patchJob(j.id, { pending: null });
  const g = groups.getGroup(G1);
  const slot = S.nextSlot(g.schedule, Date.now());
  assert.ok(slot);
  let release;
  D.cmds.length = 0;
  D.gate = new Promise((r) => { release = r; });
  D.gateFor = (c) => c.startsWith('run ');
  const tick = runner.groupTick(slot.at + 30_000);
  assert.ok(await until(() => D.cmds.some((c) => c.startsWith('run '))));
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'bareos-groups.json'), 'utf8')).groups.find((x) => x.id === G1);
  assert.equal(onDisk.lastKey, slot.key, 'Director 가 run 을 받는 순간 이미 회차가 파일에 있다(한 번 이하)');
  D.gate = null; release();
  const out = await tick;
  assert.deepEqual(out.fired, [G1]);
  const f = groups.getGroup(G1).lastFire;
  assert.equal(f.trigger, 'timer');
  assert.equal(f.key, slot.key);
  assert.equal(registry.listJobs().find((x) => x.vmId === 'vc-a:vm-1').pending.trigger, 'group-schedule');
  for (const j of registry.listJobs()) registry.patchJob(j.id, { pending: null });
  D.cmds.length = 0;
  const again = await runner.groupTick(slot.at + 60_000);
  assert.deepEqual(again.fired, []);
  assert.equal(D.cmds.filter((c) => c.startsWith('run ')).length, 0, '같은 회차는 두 번 보내지 않는다');
});

test('⑤ 놓친 회차 — 따라잡는 범위를 넘기면 돌리지 않고 missed 로 남긴다', async () => {
  const g = groups.getGroup(G1);
  const slot = S.nextSlot(g.schedule, Date.now() + 86_400_000);   // 내일 회차(아직 처리 안 한 회차)
  D.cmds.length = 0;
  const out = await runner.groupTick(slot.at + 10 * 60_000, { catchupMs: 60_000 });
  assert.deepEqual(out.missed, [G1]);
  assert.deepEqual(out.fired, []);
  assert.equal(D.cmds.filter((c) => c.startsWith('run ')).length, 0);
  const after2 = groups.getGroup(G1);
  assert.equal(after2.missed.key, slot.key);
  assert.equal(after2.lastKey, slot.key);
});

test('⑤ 검토 L10 — 같은 Director 의 그룹은 차례로(동시에 세션을 열지 않는다) · 다른 그룹은 앞 그룹이 끝난 뒤 보낸다', async () => {
  for (const j of registry.listJobs()) registry.patchJob(j.id, { pending: null });
  const g1 = groups.getGroup(G1);
  const r = await call('admin', 'POST', '/groups', { vcenterId: 'vc-b', name: '바르샤바', vmIds: ['vc-b:vm-9'], schedule: g1.schedule });
  assert.equal(r.s, 201, r.t);
  const G2 = r.j.group.id;
  const slot = S.nextSlot(g1.schedule, Date.now() + 2 * 86_400_000);   // 아직 아무도 처리하지 않은 회차
  let release;
  D.cmds.length = 0;
  D.gate = new Promise((res) => { release = res; });
  D.gateFor = (c) => c.startsWith('run ');
  // CI 불안정(PR #841 — 문서만 바꾼 PR 에서 2 !== 1): 앞 시험의 실행 기록 지연 쓰기(FIRE_FLUSH_MS)가 이 구간에 떨어지면 쓰기가 하나 더 세졌다 — 먼저 비운다
  groups._flushGroupsForTest();
  const w0 = groups._groupsWritesForTest();
  const tick = runner.groupTick(slot.at + 30_000);
  try {
    assert.ok(await until(() => D.cmds.some((c) => c.startsWith('run '))));
    assert.equal(groups._groupsWritesForTest() - w0, 1, '두 그룹의 회차 차지가 원장 쓰기 한 번(검토 M1 — 그룹마다 쓰면 300그룹에 3초 정지)');
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(D.cmds.filter((c) => c.startsWith('run ')).length, 1, `앞 그룹이 붙잡힌 동안 다른 그룹의 세션이 run 을 보냈다: ${D.cmds.filter((c) => c.startsWith('run ')).join(' | ')}`);
  } finally {
    // 실패해도 붙잡은 run 을 풀고 시험 그룹을 지운다 — 예전에는 여기서 멈춘 채 뒤 시험 3건이 '다른 그룹에 있음'·'실행 중' 으로 연달아 깨졌다
    D.gate = null; release();
  }
  const out = await tick;
  try {
    assert.deepEqual(out.fired.sort(), [G1, G2].sort());
    assert.equal(groups.getGroup(G2).lastFire.started, 1);
    assert.equal(groups.getGroup(G1).lastFire.key, slot.key);
    assert.equal(groups.getGroup(G1).sending, null, '실행 기록이 쓰이면 보내는 중 표지를 지운다');
  } finally {
    await until(() => !runner.groupRunning(G2));
    await call('admin', 'DELETE', `/groups/${G2}`);
  }
});

test('⑤ 검토 M1·L2 — 회차 차지는 한 틱에 쓰기 한 번 · 보내는 중 표지 · 실행 기록은 메모리 먼저, 파일은 모아서', () => {
  const a = groups.addGroup({ vcenterId: 'vc-t', name: 'A', vmIds: ['t:1'], schedule: EVERY }, { now: 1000 });
  const b = groups.addGroup({ vcenterId: 'vc-t', name: 'B', vmIds: ['t:2'], schedule: EVERY }, { now: 1000 });
  const rev0 = groups.groupsRev();
  const got = groups.claimSlots([{ id: a.id, key: '2099-01-01 02:10' }, { id: b.id, key: '2099-01-01 02:10' }, { id: 'nope', key: 'x' }]);
  assert.deepEqual(got.sort(), [a.id, b.id].sort());
  assert.equal(groups.groupsRev() - rev0, 1, '두 그룹을 한 번의 쓰기로');
  const disk = () => JSON.parse(fs.readFileSync(path.join(tmp, 'bareos-groups.json'), 'utf8')).groups.find((x) => x.id === a.id);
  assert.equal(disk().sending.key, '2099-01-01 02:10', '보내는 중 표지도 같은 쓰기에(재시작하면 남는다)');
  assert.deepEqual(groups.claimSlots([{ id: a.id, key: '2099-01-01 02:10' }]), [], '같은 회차는 다시 차지하지 않는다');
  assert.deepEqual(groups.claimSlots([{ id: a.id, key: '2098-12-31 02:10' }]), [], '더 앞선 회차도(시계 역행 — 검토 L1)');
  groups.recordFire(a.id, { key: '2099-01-01 02:10', at: 5, trigger: 'timer', total: 1, started: 1, items: [] });
  assert.equal(groups.getGroup(a.id).sending, null);
  assert.equal(disk().sending?.key, '2099-01-01 02:10', '파일은 아직(모아서 쓴다)');
  groups._flushGroupsForTest();
  assert.equal(disk().sending, null);
  assert.equal(disk().lastFire.started, 1);
  groups.deleteGroup(a.id); groups.deleteGroup(b.id);
});

test('⑤ 검토 M4 — 돌 차례인 회차를 틱 전에 스케줄을 고치면 조용히 버리지 않고 남긴다 · 검토 L1 시계 역행', () => {
  const slot = new Date(2026, 9, 28, 2, 0).getTime();
  const sched = { ...EVERY, time: '02:00' };
  const g = groups.addGroup({ vcenterId: 'vc-t', name: 'M4', vmIds: ['t:9'], schedule: sched }, { now: slot - 3_600_000 });
  const after = groups.updateGroup(g.id, { name: 'M4', vmIds: ['t:9'], schedule: { ...sched, fullDays: [3] } }, { now: slot + 10_000 });
  assert.equal(after.missed?.reason, 'edited');
  assert.equal(after.missed.key, '2026-10-28 02:00');
  assert.equal(after.lastKey, '2026-10-28 02:00');
  assert.equal(S.decideFire(after, slot + 25_000).action, 'none');
  // 시계 역행: 이미 오늘 회차를 처리했으면(lastKey) 어제 회차를 '놓침' 으로 다시 보지 않는다(그러면 오늘 회차가 다시 나갔다)
  assert.equal(S.decideFire({ schedule: S.normSchedule(EVERY), anchorAt: 0, lastKey: '2026-10-28 02:10' }, new Date(2026, 9, 28, 2, 9, 55).getTime()).action, 'none');
  groups.deleteGroup(g.id);
});

test('⑥ 검토 L3·L4 — 보내지 못함 · 실패 · 결과 모름을 나눈다(순수)', () => {
  assert.equal(runner.chunkErrorState({ code: 'auth-stopped' }), 'notsent');
  assert.equal(runner.chunkErrorState({ code: 'connect' }), 'notsent');
  assert.equal(runner.chunkErrorState({ code: 'error', notSent: true }), 'notsent');
  assert.equal(runner.chunkErrorState({ code: 'unknown' }), 'unknown');
  assert.equal(runner.chunkErrorState({ code: 'timeout' }), 'unknown');
  assert.equal(runner.chunkErrorState({ code: 'error' }), 'failed');
  assert.equal(runner.itemState({ ok: true, jobid: 5 }), 'started');
  assert.equal(runner.itemState({ ok: false, code: 'closed' }), 'unknown', '명령 도중 끊김 — Director 가 받았을 수 있다');
  assert.equal(runner.itemState({ ok: false, code: 'skipped' }), 'notsent');
  assert.equal(runner.itemState({ ok: false, code: 'invalid' }), 'failed');
  assert.equal(runner.itemState({ ok: false, code: 'jsonrpc' }), 'failed', 'Director 가 오류 객체로 거부 = 실행 안 됨');
  assert.equal(runner.itemState(undefined), 'unknown');
});

test('설정 변경 백업 지문 — 예약·실행 필드(lastKey·lastFire·sending·missed)는 지문을 바꾸지 않고, 그룹 정의는 바꾼다', async () => {
  const backup = await import('../src/backup/service.js');
  assert.ok(backup.MIXED_STATE_FILES.has('bareos-groups.json'));
  const base = { id: 'g', name: 'A', vcenterId: 'v', vmIds: ['x'], schedule: EVERY, storage: '', pool: '', anchorAt: 1, lastKey: '', lastFire: null, missed: null, sending: null };
  const fp = (g) => backup.settingsFingerprint({ 'bareos-groups.json': JSON.stringify({ version: 1, groups: [g] }) });
  const f0 = fp(base);
  assert.equal(fp({ ...base, lastKey: 'k', lastFire: { started: 1 }, sending: { key: 'k' }, missed: { key: 'k' } }), f0, '예약 회차마다 change 백업이 생기면 안 된다');
  assert.notEqual(fp({ ...base, name: 'B' }), f0);
  assert.notEqual(fp({ ...base, vmIds: ['x', 'y'] }), f0);
});

/* ───────── ⑥ 엣지·작업 표 ───────── */
test('⑥ 엣지 회신 정제 — runJobs 성공인데 jobid 없음은 결과 모름 · 숫자 key 보존', async () => {
  const { sanitizeEdgeResult } = await import('../src/bareos/edgeResult.js');
  const r = sanitizeEdgeResult('runJobs', { ok: true, value: [{ key: 0, ok: true, jobid: 77 }, { key: 1, ok: true }, { key: 2, ok: false, code: 'invalid', message: 'x' }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value[0], { key: 0, ok: true, jobid: 77 });
  assert.equal(r.value[1].ok, false);
  assert.equal(r.value[1].code, 'unknown');
  assert.equal(r.value[2].code, 'invalid');
  const { RESULT_MS } = await import('../src/bareos/edgeOps.js');
  const { MUTATING } = await import('../src/bareos/ops.js');
  assert.ok(RESULT_MS.runJobs > RESULT_MS.runJob);
  assert.ok(MUTATING.has('runJobs'), '가져간 뒤 미회신은 결과 모름(다시 보내지 않음)');
  const { PICKUP_MS } = await import('../src/bareos/edgeOps.js');
  assert.ok(runner.RUN_DEADLINE_MS > PICKUP_MS + RESULT_MS.runJobs, '중앙 시한은 엣지 인출 대기 + 회신 시한보다 길다(검토 M3 — 회신 시한만 보면 인출이 늦을 때 jobid 를 잃었다)');
});

test('⑥ ops.runJobs — 세션이 끊기면 남은 항목은 보내지 않고 건너뜀 · runJob 은 스토리지·풀 이름을 검사', async () => {
  const { OPS } = await import('../src/bareos/ops.js');
  const { BareosConsoleError } = await import('../src/bareos/console.js');
  const sent = [];
  let n = 0;
  const s = { call: async (cmd) => { sent.push(cmd); n += 1; if (n === 2) throw new BareosConsoleError('connect', 'gone'); return { run: { jobid: 10 + n } }; } };
  const out = await OPS.runJobs(s, { items: [{ key: 0, job: 'a', level: 'Incremental' }, { key: 1, job: 'b', level: 'Full', storage: 'sd2' }, { key: 2, job: 'c', level: 'Incremental' }] });
  assert.deepEqual(out.map((x) => [x.key, x.ok, x.code || '']), [[0, true, ''], [1, false, 'connect'], [2, false, 'skipped']]);
  assert.equal(sent.length, 2, '끊긴 뒤에는 보내지 않는다');
  assert.equal(sent[1], 'run job=b level=Full storage=sd2 yes');
  const bad = await OPS.runJobs({ call: async () => ({ run: { jobid: 1 } }) }, { items: [{ key: 0, job: 'a', level: 'Full', storage: 'x;y' }] });
  assert.equal(bad[0].ok, false);
  assert.match(bad[0].message, /스토리지 이름/);
});

/* ───────── 손상·삭제 ───────── */
test('손상된 그룹 원장 — 보존 · 저장 503 · 예약 틱은 아무것도 보내지 않음 · 트리는 손상 표시', async () => {
  const f = path.join(tmp, 'bareos-groups.json');
  groups._flushGroupsForTest();
  const good = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, '{ broken');
  groups._resetGroupsForTest();
  let r = await call('admin', 'GET', '/groups/tree?vcenterId=vc-a');
  assert.equal(r.j.groupsLoadError, true);
  assert.equal(r.j.groups.length, 0);
  r = await call('admin', 'POST', '/groups', { vcenterId: 'vc-a', name: '새 그룹', vmIds: ['vc-a:vm-6'], schedule: EVERY });
  assert.equal(r.s, 503);
  const out = await runner.groupTick(Date.now());
  assert.equal(out.scanned, false);
  assert.ok(fs.readdirSync(tmp).some((n) => n.startsWith('bareos-groups.json.corrupt')), '손상본 보존');
  fs.writeFileSync(f, good);
  groups._resetGroupsForTest();
  assert.ok(groups.getGroup(G1));
});

/* ───────── ⑦ v2.831 보관 개수 ───────── */
// 카탈로그 시각(현지 · 시간대 없음) — 원장 잡 등록 뒤의 시각이어야 정리 대상이다(v2.831.1 ⑨ since). 실제 시각에서 분 단위로 떨어뜨린다
const pad2 = (n) => String(n).padStart(2, '0');
const catAt = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:00`; };
const H0 = Math.floor(Date.now() / 60_000) * 60_000 + 3_600_000;
const hrow = (jobid, name, level, st = 'T', at = H0 + jobid * 60_000) => ({ jobid, name, type: 'B', level, jobstatus: st, jobbytes: 1000, starttime: catAt(at), endtime: '' });
test('⑦ v2.831 보관 개수 — 저장(1~365 · 비우면 제한 없음) · 보내지 않으면 그대로 · 틀린 값 400 · v2.831.1 지울 범위가 넓어지는 저장만 본인 OTP', async () => {
  const g = groups.getGroup(G1);
  const body = (extra) => ({ name: g.name, vmIds: g.vmIds, schedule: g.schedule, storage: g.storage, pool: g.pool, ...extra });
  // 코드 셋(now-1·now·now+1)은 검증 창 ±1 단계 안 — 단계 끝 15초 안이면 다음 단계까지 기다린다(bareosAutoSetup ⑤ 와 같은 이유)
  const left = 30_000 - (Date.now() % 30_000);
  if (left < 15_000) await new Promise((r) => setTimeout(r, left + 50));
  const now = Math.floor(Date.now() / 30_000);
  const [t1, t2, t3] = [now - 1, now, now + 1].map((counter) => generateToken(SECRET, { counter }));
  // 처음 정함 → OTP 필요: 코드 없음(검증을 부르지 않음) · 틀린 코드 · 미등록 계정은 403 이고 저장하지 않는다
  let r = await call('admin', 'PUT', `/groups/${G1}`, body({ keep: 2 }));
  assert.equal(r.s, 403, r.t);
  assert.equal(r.j.needOtp, true);
  assert.match(r.j.reasons.join(), /처음 정함/);
  assert.equal((await call('admin', 'PUT', `/groups/${G1}`, body({ keep: 2, otp: '000000' }))).s, 403);
  const ne = await call('noot', 'PUT', `/groups/${G1}`, body({ keep: 2, otp: t1 }));
  assert.equal(ne.s, 403); assert.equal(ne.j.needEnroll, true);
  assert.equal(groups.getGroup(G1).keep ?? null, null, 'OTP 를 통과하지 못한 저장은 반영하지 않는다');
  for (const bad of [0, 366, 1.5, 'abc', -1]) assert.equal((await call('admin', 'PUT', `/groups/${G1}`, body({ keep: bad, otp: t1 }))).s, 400, `${bad} — 입력 오류는 OTP 를 쓰기 전에 400`);
  r = await call('admin', 'PUT', `/groups/${G1}`, body({ keep: 2, otp: t1, updatedAt: groups.getGroup(G1).updatedAt }));
  assert.equal(r.s, 200, r.t);
  assert.equal(r.j.group.keep, 2);
  assert.equal(r.j.group.keepText, '최근 2회 보관');
  // OTP 없이 되는 저장: keep 을 보내지 않음(그대로) · 늘리기 · 제한 없음으로 풀기
  r = await call('admin', 'PUT', `/groups/${G1}`, body({}));
  assert.equal(r.s, 200, r.t);
  assert.equal(groups.getGroup(G1).keep, 2, '보관 개수를 보내지 않은 저장이 조용히 제한 없음으로 바꾸면 안 된다');
  assert.equal((await call('admin', 'PUT', `/groups/${G1}`, body({ keep: 5 }))).s, 200, '늘리기는 OTP 없이');
  assert.equal((await call('admin', 'PUT', `/groups/${G1}`, body({ keep: 3 }))).s, 403, '줄이기는 OTP');
  assert.equal((await call('admin', 'PUT', `/groups/${G1}`, body({ keep: 3, otp: t1 }))).s, 403, '쓴 코드는 다시 못 쓴다');
  assert.equal((await call('admin', 'PUT', `/groups/${G1}`, body({ keep: 3, otp: t2 }))).s, 200);
  assert.equal((await call('admin', 'PUT', `/groups/${G1}`, body({ keep: null }))).s, 200, '제한 없음으로 풀기는 OTP 없이');
  assert.equal((await call('admin', 'PUT', `/groups/${G1}`, body({ keep: 2, otp: t3 }))).s, 200);
  assert.equal(groups.getGroup(G1).keep, 2);
  // 보관 개수가 있는 새 그룹은 OTP — 코드가 없으면 Director 에 잡을 등록하지 않는다(게이트가 등록 앞)
  D.cmds.length = 0;
  r = await call('admin', 'POST', '/groups', { vcenterId: 'vc-b', name: '보관 그룹', vmIds: ['vc-b:vm-9'], schedule: EVERY, keep: 7 });
  assert.equal(r.s, 403, r.t);
  assert.equal(r.j.needOtp, true);
  assert.equal(D.cmds.filter((c) => c.startsWith('configure')).length, 0, 'OTP 를 통과하기 전에는 잡을 만들지 않는다');
  r = await call('admin', 'GET', '/groups/tree?vcenterId=vc-a');
  assert.deepEqual(r.j.keepLimits, { min: 1, max: 365, presets: [3, 7, 14, 30] });
});

test('⑦ v2.831.1 쓰는 순간에 다시 본다 — 그사이 보관 개수가 늘었으면 OTP 없는 저장을 409', () => {
  const g = groups.getGroup(G1);
  const { keepOtpReasons } = runnerRetention;
  assert.throws(() => groups.updateGroup(G1, { name: g.name, vmIds: g.vmIds, schedule: g.schedule, storage: g.storage, pool: g.pool, keep: 1 },
    { check: (cur, nv) => (keepOtpReasons(cur, nv).length ? '본인 OTP 가 필요합니다' : '') }), /본인 OTP/);
  assert.equal(groups.getGroup(G1).keep, 2, '거부하면 바꾸지 않는다');
});

test('⑦ v2.843 정리 미리 보기 — 같은 입력·같은 판정으로 개수만(delete 0) · 저장 전 keep · 조회 범위 · 실제 정리와 같은 수', async () => {
  const g = groups.getGroup(G1);
  const jobs = registry.jobDigests().filter((j) => g.vmIds.includes(j.vmId));
  const [A, B] = jobs.map((j) => j.bareosJob);
  // 아래 '⑦ 정리' 시험과 같은 이력 — 미리 보기 수가 실제로 지운 수와 같아야 한다
  D.hist.set(A, [hrow(1, A, 'F'), hrow(2, A, 'I'), hrow(3, A, 'I', 'f'), hrow(4, A, 'F'), hrow(5, A, 'I'), hrow(6, A, 'I'), hrow(7, A, 'I', 'R')]);
  D.hist.set(B, [hrow(11, B, 'I'), hrow(12, B, 'I'), hrow(13, B, 'I')]);
  D.cmds.length = 0;
  let r = await call('admin', 'POST', `/groups/${G1}/prune-preview`, {});
  assert.equal(r.s, 200, r.t);
  assert.equal(r.j.keep, 2);
  assert.equal(r.j.would, 3, '기준 Full(4) 앞의 끝난 실행 1·2·3');
  assert.equal(r.j.vms, 1);
  assert.equal(r.j.noBase, 1, 'Full 없는 잡 B');
  assert.equal(r.j.failed, 0);
  assert.equal(r.j.rows[0].would, 3, '지울 것이 많은 VM 먼저');
  assert.equal(D.cmds.filter((c) => c.startsWith('delete')).length, 0, '미리 보기는 지우지 않는다');
  assert.deepEqual(D.hist.get(A).map((x) => x.jobid), [1, 2, 3, 4, 5, 6, 7], '카탈로그 그대로');
  assert.equal(groups.getGroup(G1).lastPrune?.at ?? null, g.lastPrune?.at ?? null, '정리 기록을 남기지 않는다');
  // 저장 전 값(keep 6) — 같은 판정으로
  r = await call('admin', 'POST', `/groups/${G1}/prune-preview`, { keep: 6 });
  assert.equal(r.j.would, 0, '최근 6회면 지울 것 없음');
  assert.equal((await call('admin', 'POST', `/groups/${G1}/prune-preview`, { keep: 0 })).s, 400, '틀린 값은 400');
  assert.equal((await call('admin', 'POST', `/groups/${G1}/prune-preview`, { keep: null })).s, 400, '제한 없음이면 미리 볼 것이 없다');
  // 읽기 전용 — 조회 범위만 본다(쓰기 범위 밖 관리자도 본다) · 조회 범위 밖은 404 · admin 만
  assert.equal((await call('wadm', 'POST', `/groups/${G1}/prune-preview`, {})).s, 200, '쓰기 범위 밖이어도 읽기 범위면 미리 본다');
  assert.equal((await call('op', 'POST', `/groups/${G1}/prune-preview`, {})).s, 403);
  assert.equal((await call('admin', 'POST', '/groups/nope/prune-preview', {})).s, 404);
  assert.equal(D.cmds.filter((c) => c.startsWith('delete')).length, 0);
});

test('⑦ v2.831 정리 — 기준 Full 앞의 끝난 실행만 지운다 · Full 없는 잡은 지우지 않는다 · 다시 읽어 실제로 사라진 것만 셈 · 감사', async () => {
  const g = groups.getGroup(G1);
  const jobs = registry.jobDigests().filter((j) => g.vmIds.includes(j.vmId));
  assert.ok(jobs.length >= 2);
  const [A, B] = jobs.map((j) => j.bareosJob);   // 나머지 잡은 이력이 없다(list jobs 가 빈 목록 — 지울 것 없음)
  D.hist.set(A, [hrow(1, A, 'F'), hrow(2, A, 'I'), hrow(3, A, 'I', 'f'), hrow(4, A, 'F'), hrow(5, A, 'I'), hrow(6, A, 'I'), hrow(7, A, 'I', 'R')]);
  D.hist.set(B, [hrow(11, B, 'I'), hrow(12, B, 'I'), hrow(13, B, 'I')]);
  D.cmds.length = 0;
  const out = await runner.pruneGroup(G1);
  const dels = D.cmds.filter((c) => c.startsWith('delete '));
  assert.deepEqual(dels, ['delete jobid=1,2,3'], '기준 Full(4) 앞의 끝난 실행만 · Full 없는 잡 B 는 지우지 않는다');
  assert.equal(out.deleted, 3);
  assert.equal(out.noBase, 1);
  assert.equal(out.keptMax, 3);
  assert.equal(out.keptMin, 0, '이력이 없는 잡(셋째)은 보유 0 — 숨기지 않는다');
  assert.deepEqual(D.hist.get(A).map((r) => r.jobid), [4, 5, 6, 7], '끝나지 않은 실행(7)은 남는다');
  const lp = groups.getGroup(G1).lastPrune;
  assert.equal(lp.deleted, 3);
  assert.equal(lp.keep, 2);
  D.cmds.length = 0;
  assert.equal((await runner.pruneGroup(G1)).deleted, 0);
  assert.equal(D.cmds.filter((c) => c.startsWith('delete ')).length, 0, '지울 것이 없으면 delete 를 보내지 않는다');
  // Director 가 지우지 않았으면(응답은 성공) 다시 읽어 '지우지 못함' 으로 센다
  D.hist.set(A, [...D.hist.get(A), hrow(8, A, 'F'), hrow(9, A, 'I')]);
  D.ignoreDelete = true;
  try {
    const o2 = await runner.pruneGroup(G1);
    assert.equal(o2.deleted, 0);
    assert.equal(o2.notDeleted, 3, '4·5·6 을 보냈지만 남아 있다(7 은 실행 중이라 보내지 않는다)');
  } finally { D.ignoreDelete = false; }
  // 반증 F1(v2.831.1): 원장 잡 등록 시각보다 먼저 시작한 행(같은 이름으로 다시 등록한 잡의 예전 이력)은 지우지 않는다
  const jA = registry.jobDigests().find((j) => j.bareosJob === A);
  D.hist.set(B, [hrow(31, B, 'F', 'T', jA.createdAt - 86_400_000), hrow(32, B, 'I', 'T', jA.createdAt - 3_600_000), hrow(33, B, 'F'), hrow(34, B, 'F'), hrow(35, B, 'F')]);
  D.cmds.length = 0;
  await runner.pruneGroup(G1);
  const delB = D.cmds.filter((c) => c.startsWith('delete ')).join(' ');
  assert.doesNotMatch(delB, /\b3[12]\b/, `등록 전 이력(31·32)은 지우지 않는다: ${delB}`);
  assert.deepEqual(D.hist.get(B).map((r) => r.jobid).filter((x) => x === 31 || x === 32), [31, 32]);
  const { listAudit } = await import('../src/audit.js');
  const audit = listAudit({ limit: 50, q: '보관 정리' }).items || listAudit({ limit: 50, q: '보관 정리' });
  assert.ok(JSON.stringify(audit).includes('jobid 1,2,3'), '지운 jobid 를 감사에 남긴다');
});

test('⑦ v2.831 pruneDue — 보관 개수 · 시작한 실행 · 같은 실행으로 한 번(개수만 바꿔서는 안 돎) · 끝날 때까지 기다림(상한 뒤엔 진행)', async () => {
  const { PRUNE_WAIT_MAX_MS } = await import('../src/bareos/groupRetention.js');
  const g = { keep: 3, vmIds: ['a', 'b'], lastFire: { at: 1000, started: 2 }, lastPrune: null };
  const idle = new Map([['a', { pending: null }], ['b', { pending: null }]]);
  const busy = new Map([['a', { pending: { jobid: 5 } }], ['b', { pending: null }]]);
  assert.equal(runner.pruneDue(g, idle, 2000), true);
  assert.equal(runner.pruneDue(g, busy, 2000), false);
  assert.equal(runner.pruneDue(g, busy, 1000 + PRUNE_WAIT_MAX_MS), true);
  assert.equal(runner.pruneDue({ ...g, keep: null }, idle, 2000), false);
  assert.equal(runner.pruneDue({ ...g, lastFire: { at: 1000, started: 0 } }, idle, 2000), false);
  assert.equal(runner.pruneDue({ ...g, lastPrune: { fireAt: 1000, keep: 3 } }, idle, 2000), false);
  assert.equal(runner.pruneDue({ ...g, lastPrune: { fireAt: 1000, keep: 7 } }, idle, 2000), false, '반증 F5: 보관 개수를 바꾸기만 해서는 정리하지 않는다(다음 실행이 끝난 뒤)');
});

test('⑦ v2.831 지문 — 실행 이력(fires)·정리 결과(lastPrune)는 지문을 바꾸지 않고 보관 개수는 바꾼다', async () => {
  const backup = await import('../src/backup/service.js');
  const base = { id: 'g', name: 'A', vcenterId: 'v', vmIds: ['x'], schedule: EVERY, storage: '', pool: '', keep: 7, fires: [], lastPrune: null };
  const fp = (g) => backup.settingsFingerprint({ 'bareos-groups.json': JSON.stringify({ version: 1, groups: [g] }) });
  assert.equal(fp({ ...base, fires: [{ at: 1 }], lastPrune: { at: 2, deleted: 3 } }), fp(base));
  assert.notEqual(fp({ ...base, keep: 14 }), fp(base));
});

test('그룹 지우기 — 그룹만 지우고 백업 대상(잡)은 남긴다', async () => {
  const before = registry.listJobs().length;
  const r = await call('admin', 'DELETE', `/groups/${G1}`);
  assert.equal(r.s, 200, r.t);
  assert.equal(groups.getGroup(G1), null);
  assert.equal(registry.listJobs().length, before);
});
