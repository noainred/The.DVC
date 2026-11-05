/**
 * test/bareosCancel2867.test.js — v2.867 Bareos 백업 중단 · 취소(사용자 요청 '단일 백업 중단 · 그룹 백업 중단' · 시안 docs/design/bareos-cancel/).
 *  ① 판정(cancelState — 순수): 지금 도는 실행일 때만 '멈추는 중' · CANCEL_WAIT_MS 뒤 '멈추지 않음' · 다시 보내기 문 · 폴러 추적 기간
 *  ② 스케줄 건너뛰기(skipKey): 그 회차만 'skipped' 로 넘김 · 기록하면 지움 · 스케줄을 고치면 지움
 *  ③ 작업 표 · 엣지 회신: ops.cancelJobs 가 항목마다 단건과 같은 검사 · 세션이 끊기면 남은 것 건너뜀 · 정제(성공인데 결과 없음 = 결과 모름 · 숫자 key)
 *  ④ 단건 취소 라우트: 원장 cancelReq · 목록 cancel · 두 번째는 409(멈추지 않음이면 다시) · 끝나면(A) 지움
 *  ⑤ 그룹 회차 중단 — 단계별: Director 실행 중(묶음 취소 · 회차 기록 · 보관 정리 안 함) · 보내는 중(덩어리를 끊지 않고 회신 뒤 취소) ·
 *     줄 대기(아무것도 보내지 않음 · 전부 시작 전 멈춤) · 덩어리 사이(남은 덩어리 안 보냄)
 *  ⑥ 확인 · 권한: 이름 재입력 400 · 멈출 것 없음 409 · operator 403 · 조회 밖 404 · 쓰기 밖 403 · 범위 확대 · 다음 회차 건너뛰기
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareoscancel-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
fs.writeFileSync(path.join(tmp, 'users.json'), JSON.stringify({ users: [{ username: 'adm', role: 'admin' }] }));

const { startFakeDirector } = await import('./_fakeBareosDirector.js');
const C = await import('../src/bareos/cancelState.js');
const S = await import('../src/bareos/groupSchedule.js');
const { OPS } = await import('../src/bareos/ops.js');
const { sanitizeEdgeResult } = await import('../src/bareos/edgeResult.js');
const { RESULT_MS } = await import('../src/bareos/edgeOps.js');

/** 가짜 Director — run 은 R 로 남고(끝나지 않는다) cancel 은 cancelTo 상태로 바꾼다(기본 A — 바로 멈춤). */
const D = { jobs: new Map(), runs: new Map(), nextId: 5000, cmds: [], gate: null, gateFor: null, cancelTo: 'A', cancelFail: false };
async function handle(cmd) {
  D.cmds.push(cmd);
  if (D.gate && (!D.gateFor || D.gateFor(cmd))) await D.gate;
  const kv = Object.fromEntries([...cmd.matchAll(/(\w+)=("(?:\\.|[^"])*"|\S+)/g)].map((m) => [m[1], m[2]]));
  if (cmd === '.clients') return { clients: [{ name: 'kr-fd' }] };
  if (cmd === '.storages') return { storages: [{ name: 'kr-sd' }] };
  if (cmd === '.pools') return { pools: [{ name: 'VMwareKR' }] };
  if (cmd === '.jobs') return { jobs: [...D.jobs.keys()].map((name) => ({ name, enabled: true })) };
  if (cmd.startsWith('configure add job')) { D.jobs.set(kv.name, {}); return { add: { resource: 'Job', name: kv.name } }; }
  if (cmd.startsWith('run ')) { const id = D.nextId++; D.runs.set(id, { name: kv.job, status: 'R' }); return { run: { jobid: id } }; }
  if (cmd.startsWith('llist jobid=')) {
    const r = D.runs.get(Number(kv.jobid));
    return { jobs: r ? [{ jobid: Number(kv.jobid), job: `${r.name}.2026`, name: r.name, type: 'B', level: 'I', jobstatus: r.status, starttime: '2026-11-03 01:00:00', endtime: r.status === 'R' ? '' : '2026-11-03 01:05:00', jobbytes: 0, jobfiles: 0, joberrors: 0 }] : [] };
  }
  if (cmd.startsWith('cancel jobid=')) { const r = D.runs.get(Number(kv.jobid)); if (!r || D.cancelFail) return { error: ['No Jobs running.'] }; r.status = D.cancelTo; return { cancel: { jobid: Number(kv.jobid) } }; }
  if (cmd.startsWith('list jobs')) return { jobs: [] };
  return { error: [`unknown command ${cmd}`] };
}

const USERS = {
  admin: { username: 'adm', role: 'admin', scope: null },
  op: { username: 'op', role: 'operator', scope: null },
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-a'] } },
  wadm: { username: 'wadm', role: 'admin', scope: { writeVcenters: ['vc-b'] } },
};
let srv; let base; let fd; let store; let registry; let groups; let runner; let poller;

const VMS = [];
for (let i = 1; i <= 20; i++) VMS.push({ id: `vc-a:vm-${i}`, vcenterId: 'vc-a', name: `a-${String(i).padStart(2, '0')}`, folder: 'DC-A / g', powerState: 'POWERED_ON', storageGB: 10, vcDcPath: 'DC-A', folderPath: '/g' });
VMS.push({ id: 'vc-b:vm-1', vcenterId: 'vc-b', name: 'b-01', folder: 'DC-B', powerState: 'POWERED_ON', storageGB: 10, vcDcPath: 'DC-B', folderPath: '/' });

before(async () => {
  fd = await startFakeDirector({ name: 'portal', password: 'pw-1', handle });
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  ({ store } = await import('../src/store.js'));
  registry = await import('../src/bareos/registry.js');
  groups = await import('../src/bareos/groups.js');
  runner = await import('../src/bareos/groupRunner.js');
  poller = await import('../src/bareos/poller.js');
  store.snapshot = {
    generatedAt: Date.now(), source: 'mock',
    vcenters: [{ id: 'vc-a', name: 'Seoul', host: 'https://vc-a.corp' }, { id: 'vc-b', name: 'Warsaw', host: 'https://vc-b.corp' }],
    hosts: [], datastores: [], alarms: [], networks: [], vms: VMS,
  };
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api/tools/bareos-backup`;
  let r = await call('admin', 'POST', '/settings/directors', { name: '한국', host: '127.0.0.1', port: fd.port, consoleName: 'portal', password: 'pw-1', timeoutMs: 5000 });
  assert.equal(r.s, 201, r.t);
  const dir = r.j.director.id;
  r = await call('admin', 'PUT', '/settings', {
    sites: [
      { vcenterId: 'vc-a', directorId: dir, vcserver: 'vc-a.corp', client: 'kr-fd', storage: 'kr-sd', pool: 'VMwareKR', configFile: '/etc/bareos/vmware/vc-a.ini' },
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
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };
const OFF = { enabled: false, days: [], time: '02:10', level: 'Incremental' };
const DAILY = { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], time: '02:10', level: 'Incremental' };
async function makeGroup(name, vmIds, { schedule = OFF, vcenterId = 'vc-a', keep } = {}) {
  const r = await call('admin', 'POST', '/groups', { vcenterId, name, vmIds, schedule, ...(keep !== undefined ? { keep } : {}) });
  assert.equal(r.s, 201, r.t);
  return r.j.group;
}
const jobOf = (vmId) => registry.listJobs().find((j) => j.vmId === vmId);
async function runAndWait(g) {
  const before = groups.getGroup(g.id).lastFire?.at ?? 0;
  const r = await call('admin', 'POST', `/groups/${g.id}/run`, {});
  assert.equal(r.s, 202, r.t);
  assert.ok(await until(() => (groups.getGroup(g.id).lastFire?.at ?? 0) > before && !runner.groupRunning(g.id)), '그룹 실행 기록');
  return groups.getGroup(g.id).lastFire;
}

/* ───────── ① 판정 ───────── */
test('① cancelInfo — 지금 도는 실행일 때만 · CANCEL_WAIT_MS 뒤 멈추지 않음 · 다시 보내기 문 · 폴러 추적 기간', () => {
  const now = 1_800_000_000_000;
  const run = { pending: { jobid: 7, since: now - 1000, state: 'running' } };
  assert.equal(C.cancelInfo(run, now), null, '보내지 않았으면 없음');
  const j = { ...run, cancelReq: { jobid: 7, at: now - 5000, by: 'adm', via: 'group' } };
  assert.deepEqual(C.cancelInfo(j, now), { jobid: 7, at: now - 5000, by: 'adm', via: 'group', stuck: false });
  assert.equal(C.cancelInfo(j, now - 5000 + C.CANCEL_WAIT_MS).stuck, true, '기준 시간이 지나면 멈추지 않음');
  assert.equal(C.cancelInfo({ ...j, pending: { jobid: 8, since: now } }, now), null, '다른 실행이 돌면 지난 기록');
  assert.equal(C.cancelInfo({ cancelReq: j.cancelReq, lastRun: { jobid: 7, status: 'A', state: 'canceled' } }, now), null, '끝난 실행이면 없음');
  // Bareos 스케줄 실행(pending 없음 · lastRun 이 실행 중)
  const sched = { lastRun: { jobid: 9, status: 'R', state: 'running', startedAt: now - 60_000 }, cancelReq: { jobid: 9, at: now - 1000, by: 'adm' } };
  assert.equal(C.cancelInfo(sched, now).via, 'single');
  assert.equal(C.cancelGate(j, now).code, 'sent');
  assert.equal(C.cancelGate(j, now - 5000 + C.CANCEL_WAIT_MS).ok, true, '멈추지 않음이면 다시 보낼 수 있다');
  assert.equal(C.cancelGate({}, now).code, 'idle');
  assert.equal(C.cancelTracked(sched, now), true, 'pending 없는 실행은 폴러가 따로 묻는다');
  assert.equal(C.cancelTracked(j, now), false, 'pending 실행은 이미 묻는다');
  assert.equal(C.cancelTracked(sched, now - 1000 + C.CANCEL_TRACK_MS), false, '추적 기간이 지나면 대조 틱에 맡긴다');
});

test('① Director 상태 문구 — 취소를 받아 멈추는 중은 FD 대기가 아니라 canceling(진행 현황판 사유)', async () => {
  const { dirReasonOf } = await import('../src/bareos/liveParse.js');
  assert.equal(dirReasonOf('is waiting for client to cancel'), 'canceling');
  assert.equal(dirReasonOf('is being canceled'), 'canceling');
  assert.equal(dirReasonOf('is waiting for Client kr-fd to connect'), 'client');
  assert.equal(dirReasonOf('has been canceled'), 'done');
});

/* ───────── ② 건너뛰기 ───────── */
test('② decideFire — skipKey 회차는 skipped 로 넘기고 그 뒤 회차는 돈다', () => {
  const sched = S.normSchedule(DAILY);
  const slot = new Date(2026, 10, 4, 2, 10).getTime();
  const g = { schedule: sched, anchorAt: slot - 86_400_000, lastKey: '', skipKey: '2026-11-04 02:10' };
  assert.deepEqual(S.decideFire(g, slot + 30_000), { action: 'miss', slot: S.lastDueSlot(sched, slot + 30_000), reason: 'skipped' });
  assert.equal(S.decideFire({ ...g, skipKey: '2026-11-05 02:10' }, slot + 30_000).action, 'fire', '다른 회차 표지는 이 회차를 막지 않는다');
});

/* ───────── ③ 작업 표 · 정제 ───────── */
test('③ ops.cancelJobs — 항목마다 단건과 같은 검사 · 세션이 끊기면 남은 것은 건너뜀', async () => {
  const rows = { 11: { jobid: 11, name: 'pv-a', type: 'B', jobstatus: 'R' }, 12: { jobid: 12, name: 'pv-b', type: 'B', jobstatus: 'T' }, 13: { jobid: 13, name: 'other', type: 'B', jobstatus: 'R' } };
  const sent = [];
  const s = { call: async (cmd) => {
    sent.push(cmd);
    const m = /^llist jobid=(\d+)$/.exec(cmd);
    if (m) return { jobs: rows[m[1]] ? [rows[m[1]]] : [] };
    if (cmd.startsWith('cancel jobid=')) return { cancel: {} };
    throw new Error('?');
  } };
  const out = await OPS.cancelJobs(s, { items: [
    { key: 0, jobid: 11, name: 'pv-a' }, { key: 1, jobid: 12, name: 'pv-b' }, { key: 2, jobid: 13, name: 'pv-c' }, { key: 3, jobid: 14, name: 'pv-d', pendingJobid: 14 }, { key: 4, jobid: 15, name: 'bad name' },
  ] });
  assert.deepEqual(out.map((x) => [x.key, x.ok, !!x.canceled, !!x.final, !!x.cleared]), [[0, true, true, false, false], [1, true, false, true, false], [2, false, false, false, false], [3, true, false, false, true], [4, false, false, false, false]]);
  assert.match(out[2].message, /이 대상의 실행이 아닙니다/, '잡 이름이 다르면 취소하지 않는다');
  assert.deepEqual(sent.filter((c) => c.startsWith('cancel')), ['cancel jobid=11'], '돌고 있고 이름이 맞는 실행만 cancel');
  const dead = { call: async () => { const e = new Error('closed'); e.code = 'closed'; throw e; } };
  const d = await OPS.cancelJobs(dead, { items: [{ key: 0, jobid: 1, name: 'pv-a' }, { key: 1, jobid: 2, name: 'pv-b' }] });
  assert.equal(d[0].code, 'closed');
  assert.equal(d[1].code, 'skipped');
  assert.ok(RESULT_MS.cancelJobs > RESULT_MS.cancel, '묶음 회신 시한은 단건보다 길다');
});

test('③ 엣지 회신 정제 — 성공인데 결과 없음은 결과 모름 · 숫자 key 보존 · 끝난 행', () => {
  const r = sanitizeEdgeResult('cancelJobs', { ok: true, value: [{ key: 0, ok: true, canceled: true }, { key: 1, ok: true }, { key: 2, ok: true, final: { jobid: 5, name: 'pv', type: 'B', status: 'T' } }, { key: '3', ok: true, cleared: true }, { key: 4, ok: false, code: 'invalid', message: 'x' }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value[0], { key: 0, ok: true, canceled: true });
  assert.equal(r.value[1].ok, false, '성공으로 받지 않는다');
  assert.equal(r.value[1].code, 'unknown');
  assert.equal(r.value[2].final.jobid, 5);
  assert.equal(r.value[3].key, -1, '글자 key 는 짝짓지 않는다');
  assert.equal(r.value[4].code, 'invalid');
});

/* ───────── ④ 단건 취소 ───────── */
test('④ 단건 취소 — 원장 cancelReq · 목록 cancel · 두 번째는 409 · 끝나면(A) 지움', async () => {
  const g = await makeGroup('S1', ['vc-a:vm-1']);   // 잡 등록용(그룹은 쓰지 않는다)
  assert.ok(g.id);
  const j = jobOf('vc-a:vm-1');
  D.cancelTo = 'R';   // Director 가 아직 멈추지 않았다
  let r = await call('admin', 'POST', `/jobs/${j.id}/run`, {});
  assert.equal(r.s, 202, r.t);
  const jobid = r.j.jobid;
  r = await call('admin', 'POST', `/jobs/${j.id}/cancel`, { jobid });
  assert.equal(r.s, 200, r.t);
  assert.equal(r.j.canceling, true);
  assert.equal(jobOf('vc-a:vm-1').cancelReq.jobid, jobid);
  r = await call('admin', 'GET', '');
  const v = r.j.jobs.find((x) => x.id === j.id);
  assert.equal(v.cancel.jobid, jobid);
  assert.equal(v.cancel.stuck, false);
  assert.equal(v.cancelReq, undefined, '원장 칸은 그대로 싣지 않는다(판정 한 곳)');
  assert.ok(r.j.cancelWaitMs > 0);
  r = await call('admin', 'POST', `/jobs/${j.id}/cancel`, { jobid });
  assert.equal(r.s, 409, '이미 보냈으면 다시 보내지 않는다');
  assert.equal(r.j.code, 'sent');
  // 멈추지 않음(기준 시간 경과) → 다시 보낼 수 있다
  registry.patchJob(j.id, { cancelReq: { ...jobOf('vc-a:vm-1').cancelReq, at: Date.now() - C.CANCEL_WAIT_MS - 1 } });
  const nCancel = D.cmds.filter((c) => c === `cancel jobid=${jobid}`).length;
  r = await call('admin', 'POST', `/jobs/${j.id}/cancel`, { jobid });
  assert.equal(r.s, 200, r.t);
  assert.equal(D.cmds.filter((c) => c === `cancel jobid=${jobid}`).length, nCancel + 1);
  // Director 가 멈춤(A) → 폴러가 반영하면 pending · cancelReq 를 내린다
  D.runs.get(jobid).status = 'A';
  await poller.pollOnce({ trigger: 'manual', reconcile: false });
  const after = jobOf('vc-a:vm-1');
  assert.equal(after.pending, null);
  assert.equal(after.cancelReq, null);
  assert.equal(after.lastRun.state, 'canceled');
  D.cancelTo = 'A';
});

/* ───────── ⑤ 그룹 회차 중단 ───────── */
test('⑤ Director 실행 중 — 이번 회차 실행을 한 번에 취소 · 회차 기록 · 보관 정리 안 함 · 다시 누르면 409', async () => {
  const g0 = await makeGroup('R1', ['vc-a:vm-2', 'vc-a:vm-3']);
  // 보관 개수 저장은 본인 OTP 를 묻는다(v2.831.1) — 이 시험은 원장에 바로 둔다(보관 정리 판정만 본다)
  const g = groups.updateGroup(g0.id, { name: g0.name, vmIds: g0.vmIds, schedule: g0.schedule, storage: '', pool: '', keep: 3 }, { by: 'adm' });
  assert.equal(g.keep, 3);
  D.cancelTo = 'R';
  const fire = await runAndWait(g);
  assert.equal(fire.started, 2);
  const ids = fire.items.map((it) => it.jobid);
  let r = await call('admin', 'GET', '/groups/tree?vcenterId=vc-a');
  const tg = r.j.groups.find((x) => x.id === g.id);
  assert.equal(tg.stop.phase, 'running');
  assert.equal(tg.stop.fire, 2);
  r = await call('admin', 'POST', `/groups/${g.id}/cancel`, {});
  assert.equal(r.s, 400, '이름 재입력이 없으면 400');
  r = await call('admin', 'POST', `/groups/${g.id}/cancel`, { confirmName: 'r1' });
  assert.equal(r.s, 400, '대소문자까지 같아야 한다');
  r = await call('admin', 'POST', `/groups/${g.id}/cancel`, { confirmName: 'R1' });
  assert.equal(r.s, 202, r.t);
  assert.equal(r.j.phase, 'running');
  assert.equal(r.j.fire, 2);
  assert.ok(await until(() => groups.getGroup(g.id).lastFire?.canceled), '회차 기록에 중단');
  const lf = groups.getGroup(g.id).lastFire;
  assert.equal(lf.canceled.canceled, 2);
  assert.equal(lf.canceled.phase, 'running');
  assert.equal(lf.canceled.scope, 'fire');
  assert.deepEqual(lf.items.map((it) => it.state), ['canceled', 'canceled']);
  for (const id of ids) assert.ok(D.cmds.includes(`cancel jobid=${id}`));
  assert.equal(jobOf('vc-a:vm-2').cancelReq.via, 'group');
  assert.equal(runner.pruneDue(groups.getGroup(g.id), new Map(), Date.now() + 365 * 86_400_000), false, '중단된 회차로는 보관 정리를 하지 않는다');
  r = await call('admin', 'POST', `/groups/${g.id}/cancel`, { confirmName: 'R1' });
  assert.equal(r.s, 409, '이미 취소를 보냈으면 멈출 것이 없다');
  assert.equal(r.j.idle, true);
  r = await call('admin', 'GET', '/groups/tree?vcenterId=vc-a');
  const t2 = r.j.groups.find((x) => x.id === g.id);
  assert.equal(t2.stop.sent, 2, '멈추는 중 2');
  assert.deepEqual([t2.stop.sentFire, t2.stop.stuckFire], [2, 0], 'v2.904: 이번 회차 실행의 취소 수를 따로(sentFire)');
  assert.equal(r.j.vms.find((v) => v.id === 'vc-a:vm-2').cancel.via, 'group');
  // 진행 현황판 — 그룹 회차 띠 · 행의 멈추는 중
  r = await call('admin', 'GET', '/live');
  const corp = r.j.corps.find((c) => c.vcenterId === 'vc-a');
  assert.ok(corp.groupRuns.some((x) => x.id === g.id && x.plan.sent === 2));
  assert.ok('next' in corp.groupRuns.find((x) => x.id === g.id), '확인 창의 다음 회차 값(스케줄 꺼짐이면 null)');
  assert.equal(corp.writable, true);
  for (const id of ids) D.runs.get(id).status = 'A';
  D.cancelTo = 'A';
});

test('⑤ 이미 단건 취소를 보낸 실행에는 묶음 취소를 다시 보내지 않는다(멈추지 않음이 아니면)', async () => {
  const g = await makeGroup('MIX', ['vc-a:vm-13', 'vc-a:vm-14']);
  D.cancelTo = 'R';
  const fire = await runAndWait(g);
  const [a, b] = fire.items;
  let r = await call('admin', 'POST', `/jobs/${jobOf(a.vmId).id}/cancel`, { jobid: a.jobid });
  assert.equal(r.s, 200, r.t);
  r = await call('admin', 'POST', `/groups/${g.id}/cancel`, { confirmName: 'MIX' });
  assert.equal(r.s, 202, r.t);
  assert.equal(r.j.fire, 1, '멈추는 중인 실행은 빼고 1대');
  assert.ok(await until(() => groups.getGroup(g.id).lastFire?.canceled));
  assert.equal(D.cmds.filter((c) => c === `cancel jobid=${a.jobid}`).length, 1, '단건으로 보낸 것 한 번뿐');
  assert.equal(D.cmds.filter((c) => c === `cancel jobid=${b.jobid}`).length, 1);
  for (const it of fire.items) D.runs.get(it.jobid).status = 'A';
  D.cancelTo = 'A';
});

test('⑤ 보내는 중 — 보내던 덩어리는 끊지 않고 회신 뒤 그 실행을 취소한다', async () => {
  const g = await makeGroup('SEND', ['vc-a:vm-4', 'vc-a:vm-5', 'vc-a:vm-15']);
  const names = new Set(['vc-a:vm-4', 'vc-a:vm-5'].map((id) => jobOf(id).bareosJob));
  // vm-15 는 이미 돌고 있다(Bareos 스케줄 — 러너가 '이미 실행 중' 으로 건너뛴다) → 그 밖 실행 1
  const pj = jobOf('vc-a:vm-15');
  const pid = D.nextId++;
  D.runs.set(pid, { name: pj.bareosJob, status: 'R' });
  registry.markPending(pj.id, { jobid: pid, level: 'Incremental', by: 'bareos', trigger: 'schedule' });
  let release; D.gate = new Promise((r) => { release = r; }); D.gateFor = (cmd) => cmd.startsWith('run ') && names.has(/job=(\S+)/.exec(cmd)?.[1]);
  D.cancelTo = 'R';
  let r = await call('admin', 'POST', `/groups/${g.id}/run`, {});
  assert.equal(r.s, 202, r.t);
  assert.ok(await until(() => D.cmds.some((c) => c.startsWith('run ') && names.has(/job=(\S+)/.exec(c)?.[1]))), '첫 run 이 Director 에 닿음(회신 대기)');
  // 반증 F3: 보내는 중 계획 — 회신 대기 덩어리(2)는 '그 밖' 도 '시작 전 멈춤' 도 아니다
  const tr = await call('admin', 'GET', '/groups/tree?vcenterId=vc-a');
  const plan = tr.j.groups.find((x) => x.id === g.id).stop;
  assert.equal(plan.phase, 'sending');
  assert.equal(plan.extra, 1, '그 밖 실행은 이미 돌던 vm-15 하나뿐');
  assert.equal(plan.progress.inflight, 2);
  r = await call('admin', 'POST', `/groups/${g.id}/cancel`, { confirmName: 'SEND' });
  assert.equal(r.s, 202, r.t);
  assert.equal(r.j.phase, 'sending');
  assert.equal(r.j.halted, 0, '회신 대기 덩어리는 시작 전 멈춤이 아니다');
  assert.equal(r.j.fire, 2, '회신 대기 2대는 시작한 뒤 취소된다');
  r = await call('admin', 'POST', `/groups/${g.id}/run`, {});
  assert.equal(r.s, 409, '멈추는 동안 같은 그룹 실행은 409');
  D.gate = null; release();
  assert.ok(await until(() => groups.getGroup(g.id).lastFire?.canceled && !runner.groupRunning(g.id)), '러너가 끝에 취소하고 기록');
  const lf = groups.getGroup(g.id).lastFire;
  assert.equal(lf.canceled.phase, 'sending');
  assert.equal(lf.canceled.canceled, 2, '보낸 덩어리의 실행은 회신을 받은 뒤 취소');
  assert.equal(lf.started, 2);
  for (const it of lf.items.filter((x) => x.jobid)) assert.ok(D.cmds.includes(`cancel jobid=${it.jobid}`));
  assert.ok(!D.cmds.includes(`cancel jobid=${pid}`), '범위 확대를 고르지 않으면 그 밖 실행은 그대로');
  for (const it of lf.items.filter((x) => x.jobid)) D.runs.get(it.jobid).status = 'A';
  D.runs.get(pid).status = 'T';
  D.cancelTo = 'A';
});

test('⑤ 줄 대기 — 줄에서 빼고 아무것도 보내지 않는다(전부 시작 전 멈춤)', async () => {
  const ga = await makeGroup('LINE-A', ['vc-a:vm-6']);
  const gb = await makeGroup('LINE-B', ['vc-a:vm-7', 'vc-a:vm-8']);
  const aName = jobOf('vc-a:vm-6').bareosJob;
  const bNames = new Set(['vc-a:vm-7', 'vc-a:vm-8'].map((id) => jobOf(id).bareosJob));
  let release; D.gate = new Promise((r) => { release = r; }); D.gateFor = (cmd) => cmd.startsWith('run ') && cmd.includes(`job=${aName} `);
  let r = await call('admin', 'POST', `/groups/${ga.id}/run`, {});
  assert.equal(r.s, 202, r.t);
  assert.ok(await until(() => D.cmds.some((c) => c.startsWith('run ') && c.includes(`job=${aName} `))));
  r = await call('admin', 'POST', `/groups/${gb.id}/run`, {});
  assert.equal(r.s, 202, r.t);
  assert.equal(runner.groupProgress(gb.id)?.queued, true, 'B 는 같은 Director 줄에서 차례를 기다린다');
  r = await call('admin', 'POST', `/groups/${gb.id}/cancel`, { confirmName: 'LINE-B' });
  assert.equal(r.s, 202, r.t);
  assert.equal(r.j.phase, 'queued');
  assert.equal(r.j.halted, 2);
  assert.ok(await until(() => groups.getGroup(gb.id).lastFire?.canceled), '회차 기록은 바로');
  const lf = groups.getGroup(gb.id).lastFire;
  assert.equal(lf.halted, 2);
  assert.equal(lf.started, 0);
  assert.deepEqual(lf.items.map((x) => x.state), ['halted', 'halted']);
  assert.equal(runner.groupRunning(gb.id), false, '줄에서 빠졌다 — 다시 실행할 수 있다');
  D.gate = null; release();
  assert.ok(await until(() => !runner.groupRunning(ga.id)));
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(D.cmds.filter((c) => c.startsWith('run ') && bNames.has(/job=(\S+)/.exec(c)?.[1])).length, 0, '차례가 와도 B 는 아무것도 보내지 않는다');
  const gb2 = groups.getGroup(gb.id);
  assert.equal(gb2.fires.length, 1, '차례가 와도 회차를 다시 기록하지 않는다(실행 자체를 건너뛴다)');
  assert.equal(gb2.lastFire.canceled.phase, 'queued');
  for (const it of groups.getGroup(ga.id).lastFire.items) if (it.jobid) D.runs.get(it.jobid).status = 'T';
});

test('⑤ 덩어리 사이 — 중단 신호가 서 있으면 남은 덩어리는 보내지 않는다(runGroup 직접)', async () => {
  const g = await makeGroup('HALT', ['vc-a:vm-9']);
  const ctl = { ctrl: new AbortController(), cancel: { at: Date.now(), by: 'adm', includeScheduled: false }, progress: null };
  ctl.ctrl.abort();
  const n0 = D.cmds.filter((c) => c.startsWith('run ')).length;
  const fire = await runner.runGroup(g.id, { trigger: 'manual', by: 'adm', ctl });
  assert.equal(D.cmds.filter((c) => c.startsWith('run ')).length, n0, 'run 을 보내지 않는다');
  assert.equal(fire.halted, 1);
  assert.equal(fire.items[0].state, 'halted');
  assert.equal(fire.canceled.halted, 1);
});

/* ───────── ⑥ 확인 · 권한 · 범위 · 건너뛰기 ───────── */
test('⑥ 권한 — operator 403 · 조회 밖 404 · 쓰기 밖 403 · 멈출 것 없음 409', async () => {
  const ga = await makeGroup('P-A', ['vc-a:vm-10']);
  const gb = await makeGroup('P-B', ['vc-b:vm-1'], { vcenterId: 'vc-b' });
  assert.equal((await call('op', 'POST', `/groups/${ga.id}/cancel`, { confirmName: 'P-A' })).s, 403);
  assert.equal((await call('sadm', 'POST', `/groups/${gb.id}/cancel`, { confirmName: 'P-B' })).s, 404, '조회 범위 밖은 404');
  assert.equal((await call('wadm', 'POST', `/groups/${ga.id}/cancel`, { confirmName: 'P-A' })).s, 403, '조회는 되지만 쓰기 범위 밖은 403');
  const r = await call('admin', 'POST', `/groups/${ga.id}/cancel`, { confirmName: 'P-A' });
  assert.equal(r.s, 409, '돈 적이 없으면 멈출 것이 없다');
  assert.equal(r.j.idle, true);
  assert.equal((await call('admin', 'POST', '/groups/nope/cancel', { confirmName: 'x' })).s, 404);
  // 단건 취소도 같은 범위
  const j = jobOf('vc-a:vm-10');
  assert.equal((await call('wadm', 'POST', `/jobs/${j.id}/cancel`, { jobid: 1 })).s, 403);
});

test('⑥ 범위 확대 · 다음 회차 건너뛰기 — 그 밖 실행(Bareos 스케줄)까지 · skipKey 기록', async () => {
  const g = await makeGroup('ALL', ['vc-a:vm-11', 'vc-a:vm-12'], { schedule: DAILY });
  D.cancelTo = 'R';
  // vm-12 는 Bareos 스케줄이 돌린 실행(pending 없음 · lastRun 실행 중)
  const sj = jobOf('vc-a:vm-12');
  const sid = D.nextId++;
  D.runs.set(sid, { name: sj.bareosJob, status: 'R' });
  registry.patchJob(sj.id, { lastRun: { jobid: sid, status: 'R', state: 'running', level: 'I', startedAt: Date.now() - 60_000, endedAt: null, bytes: null, files: null, errors: null, checkedAt: Date.now() } });
  // 이번 회차(수동 실행) — vm-11 만 시작한다(vm-12 는 lastRun 실행 중이어도 pending 이 없어 보낸다 — 그래서 먼저 원장 pending 을 넣어 건너뛰게)
  registry.markPending(sj.id, { jobid: sid, level: 'Incremental', by: 'bareos', trigger: 'schedule' });
  const fire = await runAndWait(g);
  assert.equal(fire.started, 1);
  let r = await call('admin', 'GET', '/groups/tree?vcenterId=vc-a');
  const tg = r.j.groups.find((x) => x.id === g.id);
  assert.equal(tg.stop.fire, 1);
  assert.equal(tg.stop.extra, 1, '그 밖 실행 1');
  const next = S.nextSlot(groups.getGroup(g.id).schedule, Date.now());
  r = await call('admin', 'POST', `/groups/${g.id}/cancel`, { confirmName: 'ALL', includeScheduled: true, skipNext: true });
  assert.equal(r.s, 202, r.t);
  assert.equal(r.j.extra, 1);
  assert.equal(r.j.skipKey, next.key);
  assert.equal(groups.getGroup(g.id).skipKey, next.key);
  assert.ok(await until(() => groups.getGroup(g.id).lastFire?.canceled));
  const c = groups.getGroup(g.id).lastFire.canceled;
  assert.equal(c.scope, 'all');
  assert.equal(c.canceled, 1);
  assert.equal(c.extra.canceled, 1);
  assert.ok(D.cmds.includes(`cancel jobid=${sid}`), 'Bareos 스케줄 실행도 취소');
  r = await call('admin', 'GET', '/groups/tree?vcenterId=vc-a');
  assert.equal(r.j.groups.find((x) => x.id === g.id).next.skip, true, '다음 회차에 건너뜀 표시');
  { const st = r.j.groups.find((x) => x.id === g.id).stop; assert.deepEqual([st.sent, st.sentFire], [2, 1], 'v2.904: 그 밖 실행(스케줄)의 취소는 sentFire 에 넣지 않는다'); }
  // 스케줄을 고치면 건너뛰기 표지는 지운다(옛 스케줄의 회차였다)
  const cur = groups.getGroup(g.id);
  r = await call('admin', 'PUT', `/groups/${g.id}`, { name: cur.name, vmIds: cur.vmIds, schedule: { ...DAILY, time: '03:20' }, storage: '', pool: '', updatedAt: cur.updatedAt });
  assert.equal(r.s, 200, r.t);
  assert.equal(groups.getGroup(g.id).skipKey, '');
  D.cancelTo = 'A';
});

test('⑦ 반증 F1 — 실행 중이라 차지하지 못한 예약 회차는 중단 때 돌리지 않음으로 남긴다(중단 직후 다시 출발하지 않게)', async () => {
  const g = await makeGroup('DUE', ['vc-a:vm-16'], { schedule: DAILY });
  D.cancelTo = 'R';
  await runAndWait(g);
  const nx = S.nextSlot(groups.getGroup(g.id).schedule, Date.now());
  const nowF = nx.at + 30_000;   // 그 회차 시각이 지났다(틱은 실행 중이라 차지하지 못했다고 본다)
  const r = runner.cancelGroupRun(g.id, { by: 'adm', now: nowF });
  assert.equal(r.dueKey, nx.key);
  await r.done;
  const g2 = groups.getGroup(g.id);
  assert.equal(g2.missed.reason, 'stopped');
  assert.equal(g2.lastKey, nx.key);
  const t = await runner.groupTick(nowF + 1_000);
  assert.ok(!t.fired.includes(g.id), '그 회차를 다시 보내지 않는다');
  assert.match(g2.lastFire.canceled.dueKey, /\d{4}-/);
  for (const it of g2.lastFire.items.filter((x) => x.jobid)) D.runs.get(it.jobid).status = 'A';
  D.cancelTo = 'A';
});

test('⑦ 반증 F2 — 취소가 한 건도 가지 않으면 중단하지 못함(effective false · 사유) · 보관 정리를 막지 않는다', async () => {
  const g0 = await makeGroup('FAIL', ['vc-a:vm-17', 'vc-a:vm-18']);
  groups.updateGroup(g0.id, { name: g0.name, vmIds: g0.vmIds, schedule: g0.schedule, storage: '', pool: '', keep: 3 }, { by: 'adm' });
  D.cancelTo = 'R'; D.cancelFail = true;
  const fire = await runAndWait(g0);
  let r = await call('admin', 'POST', `/groups/${g0.id}/cancel`, { confirmName: 'FAIL' });
  assert.equal(r.s, 202, r.t);
  assert.ok(await until(() => groups.getGroup(g0.id).lastFire?.canceled));
  const c = groups.getGroup(g0.id).lastFire.canceled;
  assert.equal(c.effective, false);
  assert.equal(c.failed, 2);
  assert.match(c.reason, /취소 실패/);
  assert.equal(runner.pruneDue(groups.getGroup(g0.id), new Map(), Date.now() + 365 * 86_400_000), true, '멈추지 못한 회차는 보관 정리를 막지 않는다');
  // 다시 시도할 수 있다(이번 회차 실행이 그대로 돈다)
  r = await call('admin', 'GET', '/groups/tree?vcenterId=vc-a');
  assert.equal(r.j.groups.find((x) => x.id === g0.id).stop.phase, 'running');
  D.cancelFail = false;
  for (const it of fire.items) D.runs.get(it.jobid).status = 'A';
  D.cancelTo = 'A';
});

test('⑦ 반증 F7 — 회차 뒤 그룹에서 뺀 VM 의 이번 회차 실행도 취소한다', async () => {
  const g = await makeGroup('MOVE', ['vc-a:vm-19', 'vc-a:vm-20']);
  D.cancelTo = 'R';
  const fire = await runAndWait(g);
  const cur = groups.getGroup(g.id);
  groups.updateGroup(g.id, { name: cur.name, vmIds: ['vc-a:vm-19'], schedule: cur.schedule, storage: '', pool: '' }, { by: 'adm' });
  const r = await call('admin', 'POST', `/groups/${g.id}/cancel`, { confirmName: 'MOVE' });
  assert.equal(r.s, 202, r.t);
  assert.equal(r.j.fire, 2);
  assert.ok(await until(() => groups.getGroup(g.id).lastFire?.canceled));
  for (const it of fire.items) assert.ok(D.cmds.includes(`cancel jobid=${it.jobid}`));
  for (const it of fire.items) D.runs.get(it.jobid).status = 'A';
  D.cancelTo = 'A';
});
