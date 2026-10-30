/**
 * test/bareosReview2823.test.js — v2.823 법인별 Bareos 1차 **검토 확정분**(5축 + 반증 2인) 회귀.
 *  P1·C1  폴러가 Director 시한에 걸려도 읽은 행은 원장에 반영하고 회전은 시작한 항목만큼 나아간다(라이브락 없음)
 *  P3     '다시 끄기' 는 `.jobs` 를 읽은 뒤 그 순간의 원장으로 고른다 — 그사이 사용자가 다시 켠 잡을 끄지 않는다
 *  P9     조회 중에 들어온 대조 요청(requestReconcile)을 끝에서 지우지 않는다
 *  W4·P8  접속하지 않은 틱(idle)이 칩을 '정상' 으로 칠하지 않는다 · 조회 대상에서 빠진 Director 의 옛 결과를 버린다
 *  S3·C2  옛 잡(directorId 없음)이 있는 vCenter 를 다른 Director 에 새로 묶지 않는다
 *  S1·I3  범위 계정의 폴러 상태·'지금 조회' 는 자기 법인 Director 만
 *  S2     조회 무제한 + 쓰기 범위 지정 계정은 Director 설정·매핑·자동 설정을 바꾸지 못한다
 *  P4     매핑 저장은 읽은 설정 세대(rev)가 다르면 409(다른 화면의 저장을 조용히 덮지 않는다)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareosrev-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
fs.writeFileSync(path.join(tmp, 'users.json'), JSON.stringify({ users: [{ username: 'adm', role: 'admin' }] }));

const S = await import('../src/bareos/settings.js');
const R = await import('../src/bareos/registry.js');
const P = await import('../src/bareos/poller.js');
const { startFakeDirector } = await import('./_fakeBareosDirector.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = () => ({ jobs: new Map(), runs: new Map(), cmds: [], delay: new Map(), gates: new Map() });
const DS = { A: mk(), B: mk() };
const handleFor = (D) => async (cmd) => {
  D.cmds.push(cmd);
  for (const [prefix, g] of D.gates) if (cmd.startsWith(prefix)) await g;
  const kv = Object.fromEntries([...cmd.matchAll(/(\w+)=("(?:\\.|[^"])*"|\S+)/g)].map((m) => [m[1], m[2]]));
  if (cmd === '.jobs') return { jobs: [...D.jobs].map(([name, j]) => ({ name, enabled: j.enabled !== false })) };
  if (cmd.startsWith('llist jobid=')) {
    const id = Number(kv.jobid);
    if (D.delay.has(id)) await sleep(D.delay.get(id));
    const r = D.runs.get(id);
    return { jobs: r ? [{ jobid: id, name: r.name, type: 'B', level: 'I', jobstatus: r.status, starttime: '2026-10-30 02:00:00', endtime: '2026-10-30 02:10:00' }] : [] };
  }
  if (cmd.startsWith('list jobs')) return { jobs: [] };
  if (cmd.startsWith('enable ') || cmd.startsWith('disable ')) { const j = D.jobs.get(kv.job); if (!j) return { error: [`Job "${kv.job}" not found.`] }; j.enabled = cmd.startsWith('enable '); return {}; }
  return { error: [`unknown ${cmd}`] };
};

let srv; let base; let fdA; let fdB; let DA; let DB;
const USERS = {
  admin: { username: 'adm', role: 'admin', scope: null },
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-b'] } },
  wadm: { username: 'wadm', role: 'admin', scope: { writeVcenters: ['vc-b'] } },   // 조회 무제한 + 쓰기 범위 지정
};
before(async () => {
  fdA = await startFakeDirector({ name: 'portal', password: 'pw-a', handle: handleFor(DS.A) });
  fdB = await startFakeDirector({ name: 'portal', password: 'pw-b', handle: handleFor(DS.B) });
  DA = S.addDirector({ name: '한국 본사', host: '127.0.0.1', port: fdA.port, consoleName: 'portal', password: 'pw-a', timeoutMs: 5000 }).director.id;
  DB = S.addDirector({ name: '폴란드 법인', host: '127.0.0.1', port: fdB.port, consoleName: 'portal', password: 'pw-b', timeoutMs: 5000 }).director.id;
  S.saveSettings({ sites: [{ vcenterId: 'vc-a', directorId: DA }, { vcenterId: 'vc-b', directorId: DB }] });
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { store } = await import('../src/store.js');
  store.snapshot = {
    generatedAt: Date.now(), source: 'mock', hosts: [], datastores: [], alarms: [], networks: [], vms: [],
    vcenters: [{ id: 'vc-a', name: 'Seoul', host: 'vc-a.corp' }, { id: 'vc-b', name: 'Warsaw', host: 'vc-b.corp' }, { id: 'vc-c', name: 'Austin', host: 'vc-c.corp' }],
  };
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api/tools/bareos-backup`;
});
after(async () => { P._setPollBudgetForTest(null); try { srv?.close(); } catch { /* */ } await fdA?.close(); await fdB?.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

async function call(u, method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, j, t };
}
let seq = 0;
function addTarget(D, directorId, vcenterId, { enabled = true, jobid = 0, status = 'T', legacy = false } = {}) {
  seq += 1;
  const name = `pv-${vcenterId}-vm-${seq}`;
  const job = R.addJob({ vcenterId, vmId: `${vcenterId}:vm-${seq}`, vmName: `vm-${seq}`, dc: 'DC', folder: '/', ...(legacy ? {} : { directorId }), bareosJob: name, client: 'fd', storage: 'File', pool: 'Full' });
  D.jobs.set(name, { enabled: true });
  if (!enabled) R.patchJob(job.id, { enabled: false });
  if (jobid) { R.markPending(job.id, { jobid, level: 'Incremental', by: 't' }); D.runs.set(jobid, { name, status }); }
  return { ...job, bareosJob: name };
}
const pendingOf = (ids) => R.listJobs().filter((j) => ids.includes(j.id) && j.pending).length;

test('P1·C1: 시한에 걸린 틱도 읽은 행을 반영하고 회전이 나아간다 — 몇 틱 안에 전부 끝난다(라이브락 없음)', async () => {
  P._resetPollerForTest();
  P._setPollBudgetForTest(1000);
  const t = [];
  for (let i = 0; i < 6; i++) t.push(addTarget(DS.A, DA, 'vc-a', { jobid: 1000 + i }));
  for (let i = 0; i < 6; i++) DS.A.delay.set(1000 + i, 380);   // 한 틱(1초)에 두세 건만 읽힌다
  const ids = t.map((x) => x.id);
  const first = await P.pollOnce({ trigger: 'manual', directorIds: [DA] });
  const after1 = pendingOf(ids);
  assert.ok(after1 < 6, `첫 틱이 시한에 걸려도 읽은 행은 반영했다(남은 대기 ${after1})`);
  assert.equal(first.directors[DA].ok, false, '시한에 걸린 것은 실패로 보인다(무음 아님)');
  assert.match(first.directors[DA].error, /시한.*반영/);
  assert.ok(first.directors[DA].updated >= 1);
  for (let k = 0; k < 6 && pendingOf(ids) > 0; k++) await P.pollOnce({ trigger: 'manual', directorIds: [DA] });
  assert.equal(pendingOf(ids), 0, '몇 틱 안에 대기 실행이 전부 내려간다');
  const asked = new Set(DS.A.cmds.filter((c) => c.startsWith('llist jobid=')).map((c) => c.slice(12)));
  assert.equal(asked.size, 6, '뒤쪽 jobid 도 굶지 않고 물었다');
  DS.A.delay.clear();
  P._setPollBudgetForTest(null);
});

test('P1: 매번 시한에 걸리는 앞 항목이 있어도 회전이 그 항목을 지나 뒤쪽을 읽는다(굶기지 않음)', async () => {
  P._resetPollerForTest();
  P._setPollBudgetForTest(1000);
  const t = [addTarget(DS.A, DA, 'vc-a', { jobid: 2000 }), addTarget(DS.A, DA, 'vc-a', { jobid: 2001 }), addTarget(DS.A, DA, 'vc-a', { jobid: 2002 })];
  DS.A.delay.set(2000, 3000);   // 첫 항목은 매번 예산(1초)을 넘긴다
  try {
    for (let k = 0; k < 3; k++) await P.pollOnce({ trigger: 'manual', directorIds: [DA] });
    assert.equal(pendingOf([t[1].id, t[2].id]), 0, '걸린 항목 뒤의 대기 실행도 내려갔다');
    assert.equal(pendingOf([t[0].id]), 1, '걸린 항목은 아직 대기(실패로 보인다)');
  } finally { DS.A.delay.clear(); P._setPollBudgetForTest(null); R.patchJob(t[0].id, { pending: null }); }
});

test('P3: 다시 끄기는 그 순간의 원장으로 — 조회 중 사용자가 다시 켠 잡은 끄지 않는다', async () => {
  P._resetPollerForTest();
  const x = addTarget(DS.B, DB, 'vc-b', { enabled: false });   // 원장: 꺼 둠 · Director: reload 로 다시 켜짐
  const run = addTarget(DS.B, DB, 'vc-b', { jobid: 51_000, status: 'R' });
  // v2.825.1(G7): 대조가 먼저다 — 틱이 시작된 뒤(.jobs 응답 전) 사용자가 다시 켠다. 다시 끌 이름은 .jobs 를 읽은 뒤 그 순간의 원장으로 고른다.
  let release; DS.B.gates.set('.jobs', new Promise((r) => { release = r; }));
  const p = P.pollOnce({ trigger: 'manual', directorIds: [DB] });
  for (let i = 0; i < 200 && !DS.B.cmds.includes('.jobs'); i++) await sleep(10);
  // 사용자가 '활성' 을 눌렀다(라우트: Director enable → 원장 enabled:true)
  DS.B.jobs.get(x.bareosJob).enabled = true;
  R.patchJob(x.id, { enabled: true });
  release(); DS.B.gates.clear();
  const st = await p;
  assert.equal(st.directors[DB].ok, true, JSON.stringify(st.directors[DB]));
  assert.ok(DS.B.cmds.includes('.jobs'), '대조를 했다');
  assert.ok(!DS.B.cmds.includes(`disable job=${x.bareosJob}`), '다시 켠 잡을 Director 에서 끄지 않았다');
  assert.equal(DS.B.jobs.get(x.bareosJob).enabled, true);
  // 원장에서 꺼져 있는 잡은 그대로 다시 끈다(I3 동작 유지)
  R.patchJob(x.id, { enabled: false });
  await P.pollOnce({ trigger: 'manual', directorIds: [DB] });
  assert.equal(DS.B.jobs.get(x.bareosJob).enabled, false, '원장이 끔이면 다시 끈다');
  R.patchJob(run.id, { pending: null });
});

test('P9: 대조 중에 들어온 요청은 다음 틱에도 남는다', async () => {
  P._resetPollerForTest();
  await P.pollOnce({ trigger: 'timer' });   // 틱 1 = 대조 틱
  let release; DS.B.gates.set('.jobs', new Promise((r) => { release = r; }));
  const p = P.pollOnce({ trigger: 'manual', directorIds: [DB] });
  for (let i = 0; i < 200 && !DS.B.gates.size; i++) await sleep(5);
  for (let i = 0; i < 200 && DS.B.cmds.filter((c) => c === '.jobs').length < 3; i++) await sleep(10);
  P.requestReconcile(DB);   // 자동 설정이 reload 를 보냈다 — 지금 바쁘니 기록만
  release(); DS.B.gates.clear();
  await p;
  const before = DS.B.cmds.filter((c) => c === '.jobs').length;
  await P.pollOnce({ trigger: 'timer' });   // 대조 틱이 아니다 — 남은 요청 때문에만 대조한다
  assert.equal(DS.B.cmds.filter((c) => c === '.jobs').length, before + 1, '요청이 지워지지 않아 다음 틱에 대조했다');
});

test('W4·P8: 접속하지 않은 Director 는 조회 전(녹색 아님) · 비밀번호가 폐기된 Director 의 옛 결과는 버린다', async () => {
  P._resetPollerForTest();
  await P.pollOnce({ trigger: 'timer' });   // 틱 1(대조 틱 — 모든 Director 에 접속한다)
  const DC = S.addDirector({ name: '미국 법인', host: '127.0.0.1', port: 9, consoleName: 'portal', password: 'pw-c' }).director.id;   // 대조 틱 사이에 추가
  try {
    const st = await P.pollOnce({ trigger: 'timer' });   // 틱 2 — C 는 할 일이 없어 접속하지 않는다
    assert.equal(st.directors[DC].ok, null, '한 번도 접속하지 않았으면 조회 전');
    assert.notEqual(st.directors[DA]?.ok, undefined);
    S.updateDirector(DC, { host: '127.0.0.2' });   // 접속처 변경 → 비밀번호 폐기 → 조회 대상에서 빠진다
    const st2 = await P.pollOnce({ trigger: 'timer' });
    assert.equal(st2.directors[DC], undefined, '조회 대상이 아닌 Director 의 옛 결과를 남기지 않는다');
  } finally { S.deleteDirector(DC); }
});

test('S3·C2: 옛 잡(directorId 없음)이 있는 vCenter 를 다른 Director 에 새로 묶지 않는다', async () => {
  const legacy = addTarget(DS.A, '', 'vc-c', { legacy: true });
  assert.equal(S.jobDirectorId(legacy), S.DEFAULT_DIRECTOR_ID, '매핑 없는 옛 잡은 dir_default 로 풀린다');
  const cur = (await call('admin', 'GET', '/settings')).j;
  const r = await call('admin', 'PUT', '/settings', { sites: [...cur.sites, { vcenterId: 'vc-c', directorId: DB }] });
  assert.equal(r.s, 409, r.t);
  assert.match(r.j.reason, /옮길 수 없습니다/);
  assert.equal(S.siteFor('vc-c'), null, '거부된 저장은 아무것도 바꾸지 않았다');
  R.deleteJob(legacy.id);
});

test('S1·I3: 범위 계정의 폴러 상태와 지금 조회는 자기 법인 Director 만', async () => {
  P._resetPollerForTest();
  await P.pollOnce({ trigger: 'manual' });
  const full = await call('admin', 'GET', '');
  assert.ok(full.j.poller.directors[DA] && full.j.poller.directors[DB]);
  const sl = await call('sadm', 'GET', '');
  assert.equal(sl.s, 200);
  assert.deepEqual(Object.keys(sl.j.poller.directors), [DB], '목록 GET 의 폴러 상태에 다른 법인 Director 가 없다');
  assert.doesNotMatch(sl.t, /한국 본사/);
  const aBefore = DS.A.cmds.length; const bBefore = DS.B.cmds.length;
  const pr = await call('sadm', 'POST', '/poll');
  assert.equal(pr.s, 200, pr.t);
  assert.deepEqual(Object.keys(pr.j.poller.directors), [DB]);
  assert.doesNotMatch(pr.t, /한국 본사/);
  assert.equal(DS.A.cmds.length, aBefore, '범위 계정의 지금 조회는 다른 법인 Director 에 접속하지 않는다');
  assert.ok(DS.B.cmds.length > bBefore, '자기 법인 Director 는 조회했다');
});

test('S2: 조회 무제한 + 쓰기 범위 지정 계정은 Director 설정·매핑·자동 설정을 바꾸지 못한다(조회는 된다)', async () => {
  assert.equal((await call('wadm', 'GET', '/settings')).s, 200, '조회는 된다(전체 조회 범위)');
  const hostBefore = S.directorById(DA).host;
  const cases = [
    ['PUT', `/settings/directors/${DA}`, { host: 'evil.corp' }],
    ['POST', '/settings/directors', { name: '새 법인', host: 'n.corp' }],
    ['DELETE', `/settings/directors/${DA}`],
    ['PUT', '/settings', { sites: [{ vcenterId: 'vc-a', directorId: DA, client: 'evil-fd' }] }],
    ['POST', `/settings/directors/${DA}/auto-setup/preflight`, { host: '10.0.0.1', password: 'x' }],
    ['POST', `/settings/directors/${DA}/auto-setup/director`, { host: '10.0.0.1', password: 'x' }],
  ];
  for (const [m, p, b] of cases) {
    const r = await call('wadm', m, p, b);
    assert.equal(r.s, 403, `${m} ${p} → ${r.s} ${r.t}`);
  }
  assert.equal(S.directorById(DA).host, hostBefore, '주소가 바뀌지 않았다(비밀번호도 그대로)');
  assert.equal(S.directorById(DA).password, 'pw-a');
});

test('P4: 매핑 저장은 읽은 설정 세대가 다르면 409 — 다른 화면의 저장을 조용히 덮지 않는다', async () => {
  const x = (await call('admin', 'GET', '/settings')).j;
  const y = (await call('admin', 'GET', '/settings')).j;
  assert.equal(typeof x.rev, 'string');
  const a = await call('admin', 'PUT', '/settings', { rev: x.rev, sites: x.sites.map((s) => (s.vcenterId === 'vc-a' ? { ...s, client: 'kr-fd' } : s)) });
  assert.equal(a.s, 200, a.t);
  const b = await call('admin', 'PUT', '/settings', { rev: y.rev, sites: y.sites.map((s) => (s.vcenterId === 'vc-b' ? { ...s, client: 'pl-fd' } : s)) });
  assert.equal(b.s, 409, b.t);
  assert.equal(b.j.code, 'stale');
  assert.equal(S.siteFor('vc-a').client, 'kr-fd', '먼저 저장한 쪽이 살아 있다');
  const y2 = (await call('admin', 'GET', '/settings')).j;
  const c = await call('admin', 'PUT', '/settings', { rev: y2.rev, sites: y2.sites.map((s) => (s.vcenterId === 'vc-b' ? { ...s, client: 'pl-fd' } : s)) });
  assert.equal(c.s, 200, '다시 읽은 뒤에는 저장된다');
  assert.equal(S.siteFor('vc-a').client, 'kr-fd');
  assert.equal(S.siteFor('vc-b').client, 'pl-fd');
});

test('W1: 인벤토리에서 빠진 vCenter 의 저장된 매핑은 다시 보내도 받는다(막다른 길 없음) · 새로 묶는 vCenter 는 인벤토리에 있어야 한다', async () => {
  const cur = S.loadSettings().sites;
  S.saveSettings({ sites: [...cur, { vcenterId: 'vc-gone', directorId: DB }] });   // 등록 해제된 vCenter 의 옛 매핑(모듈로 직접)
  const g = (await call('admin', 'GET', '/settings')).j;
  const keep = await call('admin', 'PUT', '/settings', { rev: g.rev, sites: g.sites.map((s) => (s.vcenterId === 'vc-a' ? { ...s, pool: 'P2' } : s)) });
  assert.equal(keep.s, 200, `다른 Director 의 저장이 막히지 않는다 — ${keep.t}`);
  const g2 = (await call('admin', 'GET', '/settings')).j;
  const drop = await call('admin', 'PUT', '/settings', { rev: g2.rev, sites: g2.sites.filter((s) => s.vcenterId !== 'vc-gone') });
  assert.equal(drop.s, 200, '빼기도 된다');
  assert.equal(S.siteFor('vc-gone'), null);
  const g3 = (await call('admin', 'GET', '/settings')).j;
  const add = await call('admin', 'PUT', '/settings', { rev: g3.rev, sites: [...g3.sites, { vcenterId: 'vc-new', directorId: DB }] });
  assert.equal(add.s, 400, '인벤토리에 없는 vCenter 를 새로 묶지는 않는다');
});

test('I4·W9: 데모는 사람이 등록한 Director 가 하나도 없을 때만(비밀번호 없는 Director 를 추가해도 데모가 꺼진다)', async () => {
  const svc = await import('../src/bareos/service.js');
  assert.equal(svc.isDemoActive({ directors: [] }), true, 'mock 모드 + Director 0개 = 데모');
  assert.equal(svc.isDemoActive({ directors: [{ id: 'dir_x', name: 'x', host: 'x.corp', consoleName: '', password: '' }] }), false, '접속값이 덜 된 Director 도 사람이 등록한 것이다');
});

test('S7·S8·C8·C7(순수): 깨진 글자·포함 지시는 고치지 않는다 · 사전 점검의 못 읽음 ≠ 없음 · 제안 INI 경로가 겹치지 않는다', async () => {
  const A = await import('../src/bareos/autoSetup.js');
  const dir = '/usr/lib64/bareos/plugins';
  assert.match(A.fdPluginEdit('Client {\n  Name = x # �\n}\n', dir).issue, /UTF-8/, 'S7');
  assert.match(A.fdPluginEdit('Client {\n  Name = x\n  @/etc/bareos/extra.conf\n}\n', dir).issue, /포함 지시/, 'S8');
  assert.equal(A.fdPluginEdit('Client {\n  Name = x\n}\n', dir).action, 'updated', '평범한 블록은 그대로 고친다');
  assert.equal(A.fdPluginEdit(`Client {\n  Plugin Directory = "${dir}${'/'.repeat(200)}"\n  Plugin Names = "python3"\n}\n`, dir).action, 'unchanged', '끝 슬래시는 선형으로 뗀다');
  const head = '@@id\n0\n@@pkg\n@@svc\n@@py\n3.6.8\n';
  const tail = '@@vddk\n@@plugdir\n@@layout\nD\nC\n@@res\n@@end\n';
  const pre = (pyv, fd) => A.parsePreflight(`${head}@@pyvmomi\n${pyv}\n${tail.replace('@@layout', `@@fdconf\n${fd}@@layout`)}`).items;
  const pv = pre('?', '').find((x) => x.key === 'pyvmomi');
  assert.equal(pv.status, 'warn', 'C8①: Python 3.8 미만에서 설치됐지만 버전을 못 읽음 — 없음이 아니다');
  assert.equal(pre('-', '').find((x) => x.key === 'pyvmomi').status, 'missing');
  const nofile = pre('8.0.1', 'NOFILE\n').find((x) => x.key === 'fdplugin');
  assert.equal(nofile.status, 'missing'); assert.match(nofile.detail, /myself\.conf 없음/, 'C8②');
  assert.doesNotMatch(nofile.hint, /넣습니다/, '3단계가 넣는다고 하지 않는다');
  assert.match(pre('8.0.1', '').find((x) => x.key === 'fdplugin').hint, /넣습니다/, '파일은 있고 줄만 없으면 3단계가 넣는다');
  const { suggestMapping } = await import('../src/routes/api/bareosBackup.js');
  const out = suggestMapping({ director: { id: 'd' }, sites: [{ vcenterId: 'KR_VC01', directorId: 'd' }, { vcenterId: 'kr-vc01', directorId: 'd' }], catalog: {}, vcenters: [] });
  const paths = out.map((x) => x.fields.configFile.value);
  assert.equal(new Set(paths).size, 2, `C7: 조각이 같아도 경로가 다르다 ${paths}`);
  assert.equal(paths[0], '/etc/bareos/vmware/kr-vc01.ini');
});

test('C3: 가리키는 Director 가 설정에 없는 잡은 원장에서만 취소·삭제된다(막다른 409 없음)', async () => {
  const orphan = addTarget(DS.A, 'dir_gone00001', 'vc-a', { jobid: 0 });
  R.markPending(orphan.id, { jobid: 777, level: 'Full', by: 't' });
  const aBefore = DS.A.cmds.length;
  const c = await call('admin', 'POST', `/jobs/${orphan.id}/cancel`, {});
  assert.equal(c.s, 200, c.t); assert.equal(c.j.cleared, true);
  assert.match(c.j.note, /설정에 없어/);
  const d = await call('admin', 'DELETE', `/jobs/${orphan.id}`);
  assert.equal(d.s, 200, d.t);
  assert.match(d.j.note, /원장에서만/);
  assert.equal(R.getJob(orphan.id), null);
  assert.equal(DS.A.cmds.length, aBefore, '어느 Director 에도 명령을 보내지 않았다');
});
