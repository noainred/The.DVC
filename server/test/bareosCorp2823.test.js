/**
 * test/bareosCorp2823.test.js — v2.823 법인별 Bareos(사용자 요청 '법인별로 bareos 를 설치 — 법인의 vCenter 가 법인에 설치된 bareos 에 연결해서 백업 ·
 * 초기 설치만 하면 세부 설정을 포탈에서').
 *  ① 설정 v1→v2 이관: 로드는 파일을 다시 쓰지 않는다 · 옛 매핑·Director 는 'dir_default' · 저장은 v2 + 구버전 호환 director 사본
 *  ② Director 마다: 주소가 바뀌면 그 Director 의 비밀번호만 폐기 · 같은 이름·같은 콘솔 거부 · 매핑·대상이 있으면 삭제 409 ·
 *     백업 대상이 있는 vCenter 는 다른 Director 로 옮기거나 매핑을 지울 수 없다 · 인증 정지 기록은 Director 마다(옛 Director 는 예전 id)
 *  ③ 라우트(가짜 Director 2대 — 실제 TLS-PSK 경로): 잡 명령은 **그 잡의 Director 로만** 간다 · 폴러는 Director 마다 병렬(느린 하나가 다른 하나를 막지 않는다)
 *     · 지운 잡의 '다시 끄기' 는 그 잡의 Director 로 · 범위 계정 목록에는 자기 vCenter 의 법인만(주소 가림)
 *  ④ 자동 설정 확장: 사전 점검 해석(못 읽음 ≠ 없음) · FD 플러그인 줄 넣기(같은 값 그대로 · 다른 값·블록 2개 거부 · -t·재시작 실패 원복)
 *     · Pool·Schedule 블록 = 웹 사전 준비 블록(글자까지) · 입력 화이트리스트 · 매핑 제안(빈 칸만 · 지어내지 않음) · 메일 법인 열
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareoscorp-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
fs.writeFileSync(path.join(tmp, 'users.json'), JSON.stringify({ users: [{ username: 'adm', role: 'admin' }] }));

// ① 은 파일을 먼저 둔다(모듈이 처음 읽을 때 v1 → v2)
const V1 = { version: 1, director: { host: 'old-dir.corp', port: 9101, consoleName: 'portal', password: 'pw-old', timeoutMs: 15000, tlsMax: 'TLSv1.3' },
  defaults: { level: 'Incremental' }, sites: [{ vcenterId: 'vc-a', vcserver: 'vc-a.corp', client: 'kr-fd', storage: 'kr-sd', pool: 'P', configFile: '/etc/bareos/vmware/vc-a.ini' }] };
const FILE = path.join(tmp, 'bareos.json');
fs.writeFileSync(FILE, JSON.stringify(V1, null, 2));

const S = await import('../src/bareos/settings.js');
const R = await import('../src/bareos/registry.js');
const A = await import('../src/bareos/autoSetup.js');
const { directorPrepBlock } = await import('../../web/src/views/tools/bareosText.js');
const { startFakeDirector } = await import('./_fakeBareosDirector.js');

test('① v1 → v2: 로드는 파일을 다시 쓰지 않는다 · dir_default · 저장은 v2 + director 사본', () => {
  const before = fs.readFileSync(FILE, 'utf8');
  const s = S.loadSettings();
  assert.equal(s.directors.length, 1);
  assert.equal(s.directors[0].id, S.DEFAULT_DIRECTOR_ID);
  assert.equal(s.directors[0].password, 'pw-old');
  assert.equal(s.sites[0].directorId, S.DEFAULT_DIRECTOR_ID);
  assert.equal(fs.readFileSync(FILE, 'utf8'), before, '로드는 파일을 바꾸지 않는다');
  assert.equal(S.directorCred(s.directors[0]).id, 'director', '옛 Director 의 인증 정지 기록 id 를 잇는다');
  assert.equal(S.jobDirectorId({ vcenterId: 'vc-a' }), S.DEFAULT_DIRECTOR_ID, '옛 잡(directorId 없음)은 매핑으로 푼다');
  assert.equal(S.jobDirectorId({ vcenterId: 'vc-none' }), S.DEFAULT_DIRECTOR_ID);
  S.saveSettings({ defaults: { level: 'Full' } });
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.equal(raw.version, 2);
  assert.equal(raw.directors[0].id, S.DEFAULT_DIRECTOR_ID);
  assert.equal(raw.director.host, 'old-dir.corp', '구버전 호환 사본');
  assert.equal(raw.sites[0].directorId, S.DEFAULT_DIRECTOR_ID);
  S._resetForTest();
  assert.equal(S.loadSettings().directors.length, 1, 'v2 로 다시 읽어도 하나(사본을 Director 로 다시 만들지 않는다)');
});

let DA = ''; let DB = '';
test('② Director 마다: 비밀번호 폐기 · 겹침 거부 · 삭제 409 · 대상 있는 vCenter 이동 409 · 인증 정지 id', () => {
  DA = S.addDirector({ name: '한국 본사', host: 'kr.corp', consoleName: 'portal', password: 'pw-a' }).director.id;
  DB = S.addDirector({ name: '폴란드 법인', host: 'pl.corp', consoleName: 'portal', password: 'pw-b' }).director.id;
  assert.match(DA, S.DIRECTOR_ID_RE);
  assert.notEqual(DA, DB);
  assert.throws(() => S.addDirector({ name: '한국 본사', host: 'x.corp' }), /이미 있습니다/);
  assert.throws(() => S.addDirector({ name: '다른 이름', host: 'KR.corp', consoleName: 'portal' }), /이미 등록돼/, '같은 콘솔(대소문자 무시 주소)');
  assert.throws(() => S.addDirector({ name: '<b>' }), /쓸 수 없는 글자/);
  // 한 Director 의 주소를 바꾸면 그 Director 비밀번호만 폐기
  assert.deepEqual(S.updateDirector(DA, { host: 'kr2.corp' }).droppedSecrets, ['password']);
  assert.equal(S.directorById(DB).password, 'pw-b', '다른 법인 Director 비밀번호는 그대로');
  assert.deepEqual(S.updateDirector(DA, { password: 'pw-a2' }).droppedSecrets, []);
  // 매핑: vc-a → DA, vc-b → DB
  S.saveSettings({ sites: [
    { vcenterId: 'vc-a', directorId: DA, vcserver: 'vc-a.corp', client: 'kr-fd', storage: 'kr-sd', pool: 'P', configFile: '/etc/bareos/vmware/vc-a.ini' },
    { vcenterId: 'vc-b', directorId: DB },   // 묶기만(빈 칸은 나중에 — 매핑 채움)
  ] });
  assert.deepEqual(S.siteMissing(S.siteFor('vc-b')), ['vcserver', 'FD 클라이언트', '스토리지', '풀', 'INI 경로']);
  assert.throws(() => S.deleteDirector(DB), (e) => e.code === 'conflict' && /vc-b/.test(e.message), '매핑이 있으면 지우지 않는다');
  assert.throws(() => S.deleteDirector(S.DEFAULT_DIRECTOR_ID, { inUseByJobs: 2 }), (e) => e.code === 'conflict', '대상이 있으면 지우지 않는다');
  const lock = new Map([['vc-a', new Set([DA])]]);
  assert.throws(() => S.saveSettings({ sites: [{ vcenterId: 'vc-a', directorId: DB }, { vcenterId: 'vc-b', directorId: DB }] }, { jobDirs: lock }), (e) => e.code === 'conflict' && /옮길 수 없습니다/.test(e.message));
  assert.throws(() => S.saveSettings({ sites: [{ vcenterId: 'vc-b', directorId: DB }] }, { jobDirs: lock }), (e) => e.code === 'conflict' && /지울 수 없습니다/.test(e.message));
  assert.equal(S.siteFor('vc-a').directorId, DA, '거부된 저장은 아무것도 바꾸지 않았다');
  assert.notEqual(S.directorCred(S.directorById(DA)).id, S.directorCred(S.directorById(DB)).id, '인증 정지는 Director 마다');
  S.deleteDirector(S.DEFAULT_DIRECTOR_ID);
  assert.equal(S.directorById(S.DEFAULT_DIRECTOR_ID), null);
});

/* ───────────────────────── ③ 라우트 — 가짜 Director 2대 ───────────────────────── */
const mk = () => ({ jobs: new Map(), runs: new Map(), nextId: 1000, cmds: [], gate: null });
const DS = { A: mk(), B: mk() };
const handleFor = (D, base) => async (cmd) => {
  D.cmds.push(cmd);
  if (D.gate) await D.gate;
  const kv = Object.fromEntries([...cmd.matchAll(/(\w+)=("(?:\\.|[^"])*"|\S+)/g)].map((m) => [m[1], m[2]]));
  if (cmd === '.clients') return { clients: [{ name: 'bareos-fd' }] };
  if (cmd === '.storages') return { storages: [{ name: 'File' }] };
  if (cmd === '.pools') return { pools: [{ name: 'Full' }, { name: 'PortalVmwareFull' }, { name: 'Incremental' }] };
  if (cmd === '.schedules') return { schedules: [{ name: 'WeeklyCycle' }, { name: 'PortalVmwareNightly' }] };
  if (cmd === '.jobdefs' || cmd === '.filesets') return {};
  if (cmd === '.jobs') return { jobs: [...D.jobs].map(([name, j]) => ({ name, enabled: j.enabled !== false })) };
  if (cmd.startsWith('configure add job')) { D.jobs.set(kv.name, { enabled: true }); return { add: { resource: 'Job', name: kv.name } }; }
  if (cmd.startsWith('run ')) { const id = base + D.nextId++; D.runs.set(id, { name: kv.job, status: 'R', type: 'B' }); return { run: { jobid: id } }; }
  if (cmd.startsWith('llist jobid=')) { const r = D.runs.get(Number(kv.jobid)); return { jobs: r ? [{ jobid: Number(kv.jobid), name: r.name, type: r.type, level: 'I', jobstatus: r.status, starttime: '2026-10-30 02:00:00', endtime: '' }] : [] }; }
  if (cmd.startsWith('list jobs')) return { jobs: [] };
  if (cmd.startsWith('enable ') || cmd.startsWith('disable ')) { const j = D.jobs.get(kv.job); if (!j) return { error: [`Job "${kv.job}" not found.`] }; j.enabled = cmd.startsWith('enable '); return {}; }
  return { error: [`unknown ${cmd}`] };
};

let srv; let base; let fdA; let fdB; let store;
const USERS = { admin: { username: 'adm', role: 'admin', scope: null }, sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-b'] } } };
before(async () => {
  fdA = await startFakeDirector({ name: 'portal', password: 'pw-a2', handle: handleFor(DS.A, 0) });
  fdB = await startFakeDirector({ name: 'portal', password: 'pw-b', handle: handleFor(DS.B, 50_000) });
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  ({ store } = await import('../src/store.js'));
  store.snapshot = {
    generatedAt: Date.now(), source: 'mock',
    vcenters: [{ id: 'vc-a', name: 'Seoul', host: 'https://vc-a.corp' }, { id: 'vc-b', name: 'Warsaw', host: 'https://vc-b.corp:443/sdk' }],
    hosts: [], datastores: [], alarms: [], networks: [],
    vms: [
      { id: 'vc-a:vm-1', vcenterId: 'vc-a', name: 'web-01', powerState: 'POWERED_ON', snapshotCount: 0, vcDcPath: 'DC-A', folderPath: '/web' },
      { id: 'vc-b:vm-9', vcenterId: 'vc-b', name: 'db-09', powerState: 'POWERED_ON', snapshotCount: 0, vcDcPath: 'DC-B', folderPath: '/' },
    ],
  };
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api/tools/bareos-backup`;
});
after(async () => { try { srv?.close(); } catch { /* */ } await fdA?.close(); await fdB?.close(); A._setDepsForTest(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

async function call(u, method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, j, t };
}

test('③ 잡 명령은 그 잡의 Director 로만 · 매핑 채움 제안 · 폴러 병렬 · 다시 끄기도 그 Director · 범위 계정 가림', async () => {
  // 접속처를 바꾸면 비밀번호가 폐기되므로 같은 요청에 넣는다
  let r = await call('admin', 'PUT', `/settings/directors/${DA}`, { host: '127.0.0.1', port: fdA.port, timeoutMs: 5000, password: 'pw-a2' });
  assert.equal(r.s, 200, r.t);
  r = await call('admin', 'PUT', `/settings/directors/${DB}`, { host: '127.0.0.1', port: fdB.port, timeoutMs: 5000, password: 'pw-b' });
  assert.equal(r.s, 200, r.t);
  assert.doesNotMatch(r.t, /pw-b/);
  assert.equal((await call('admin', 'PUT', `/settings/directors/${DB}`, { port: fdA.port })).s, 400, '다른 Director 와 같은 콘솔(주소:포트·이름)은 거부');

  // 매핑 채움(5단계) — 그 Director 의 카탈로그 + vCenter 등록부 주소. 하나뿐이거나 포탈 이름이면 고르고, 아니면 비운다(지어내지 않음)
  const sug = await call('admin', 'GET', `/settings/directors/${DB}/suggest`);
  assert.equal(sug.s, 200, sug.t);
  const f = sug.j.suggestions.find((x) => x.vcenterId === 'vc-b').fields;
  assert.equal(f.vcserver.value, 'vc-b.corp', '등록부 주소에서 스킴·포트·경로를 뗀다');
  assert.equal(f.client.value, 'bareos-fd');
  assert.equal(f.storage.value, 'File');
  assert.equal(f.pool.value, 'PortalVmwareFull', '포탈이 만든 풀을 고른다');
  assert.equal(f.schedule.value, 'PortalVmwareNightly');
  assert.equal(f.configFile.value, '/etc/bareos/vmware/vc-b.ini');
  assert.equal(sug.j.suggestions.length, 1, '이 Director 에 묶인 vCenter 만');
  assert.ok(DS.B.cmds.includes('.clients') && !DS.A.cmds.includes('.clients'), '카탈로그는 그 Director 에서만 읽었다');
  // 매핑 저장 — 백업 대상이 있는 vCenter 의 Director 는 못 바꾼다(아래 등록 뒤 확인)
  r = await call('admin', 'PUT', '/settings', { sites: [
    S.siteFor('vc-a'),
    { vcenterId: 'vc-b', directorId: DB, vcserver: 'vc-b.corp', client: 'bareos-fd', storage: 'File', pool: 'PortalVmwareFull', schedule: '', configFile: '/etc/bareos/vmware/vc-b.ini' },
  ] });
  assert.equal(r.s, 200, r.t);

  // 등록 — vc-a 는 A, vc-b 는 B 에만 configure add
  const ja = await call('admin', 'POST', '/jobs', { vcenterId: 'vc-a', vmId: 'vc-a:vm-1' });
  assert.equal(ja.s, 201, ja.t);
  const jb = await call('admin', 'POST', '/jobs', { vcenterId: 'vc-b', vmId: 'vc-b:vm-9' });
  assert.equal(jb.s, 201, jb.t);
  assert.equal(ja.j.job.directorId, DA);
  assert.equal(jb.j.job.directorId, DB);
  const adds = (D) => D.cmds.filter((c) => c.startsWith('configure add job'));
  assert.equal(adds(DS.A).length, 1); assert.match(adds(DS.A)[0], /vm-1/);
  assert.equal(adds(DS.B).length, 1); assert.match(adds(DS.B)[0], /vm-9/);
  assert.match(adds(DS.B)[0], /client=bareos-fd storage=File pool=PortalVmwareFull/);
  // 대상이 생긴 vCenter 는 다른 Director 로 옮길 수 없다
  r = await call('admin', 'PUT', '/settings', { sites: [{ ...S.siteFor('vc-a'), directorId: DB }, S.siteFor('vc-b')] });
  assert.equal(r.s, 409, r.t);
  assert.equal((await call('admin', 'DELETE', `/settings/directors/${DA}`)).s, 409, '대상·매핑이 있는 Director 는 지우지 않는다');

  // 실행 — 각자 자기 Director
  const ra = await call('admin', 'POST', `/jobs/${ja.j.job.id}/run`, {});
  const rb = await call('admin', 'POST', `/jobs/${jb.j.job.id}/run`, {});
  assert.equal(ra.s, 202); assert.equal(rb.s, 202);
  assert.ok(ra.j.jobid < 50_000 && rb.j.jobid > 50_000, 'jobid 는 각 Director 의 것');
  assert.equal(DS.A.cmds.filter((c) => c.startsWith('run ')).length, 1);
  assert.equal(DS.B.cmds.filter((c) => c.startsWith('run ')).length, 1);
  assert.ok(!DS.A.cmds.some((c) => c.includes(jb.j.job.bareosJob)), 'A 에는 B 잡 이름이 한 번도 가지 않았다');
  assert.ok(!DS.B.cmds.some((c) => c.includes(ja.j.job.bareosJob)), 'B 에는 A 잡 이름이 한 번도 가지 않았다');

  // 폴러 — Director 마다 병렬: A 를 붙잡아도 B 는 끝까지 간다
  const poller = await import('../src/bareos/poller.js');
  poller._resetPollerForTest();
  for (const D of [DS.A, DS.B]) for (const x of D.runs.values()) x.status = 'T';   // 실행이 끝났다 — 폴러가 pending 을 내린다
  let rel; DS.A.gate = new Promise((x) => { rel = x; });
  const bBefore = DS.B.cmds.length;
  const p = poller.pollOnce({ trigger: 'manual' });
  // v2.825.1(G7): 대조(.jobs)가 먼저, 실행 상태(llist)가 나중이다 — 마지막 명령을 기다린다
  for (let i = 0; i < 200 && !DS.B.cmds.slice(bBefore).includes(`llist jobid=${rb.j.jobid}`); i++) await new Promise((x) => setTimeout(x, 15));
  assert.ok(DS.B.cmds.slice(bBefore).includes(`llist jobid=${rb.j.jobid}`), 'A 가 붙잡힌 동안 B 의 실행 상태를 읽었다');
  assert.ok(DS.B.cmds.slice(bBefore).includes('.jobs'), 'A 가 붙잡힌 동안 B 의 대조를 끝까지 했다');
  rel(); DS.A.gate = null;
  const st = await p;
  assert.equal(st.ok, true, JSON.stringify(st));
  assert.equal(st.directors[DA].ok, true); assert.equal(st.directors[DB].ok, true);
  assert.equal(st.directors[DB].name, '폴란드 법인');

  // 지운 잡의 '다시 끄기' 는 그 잡의 Director 로 — A 의 잡을 지우고 Director reload(다시 켜짐) 흉내
  const del = await call('admin', 'DELETE', `/jobs/${ja.j.job.id}`);
  assert.equal(del.s, 200, del.t);
  assert.equal(R.retiredNames().find((x) => x.name === ja.j.job.bareosJob)?.directorId, DA);
  for (const j of DS.A.jobs.values()) j.enabled = true;
  const dBefore = DS.B.cmds.filter((c) => c.startsWith('disable ')).length;
  await poller.pollOnce({ trigger: 'manual' });
  assert.equal(DS.A.jobs.get(ja.j.job.bareosJob).enabled, false, 'A 에서 다시 껐다');
  assert.equal(DS.B.cmds.filter((c) => c.startsWith('disable ')).length, dBefore, 'B 에는 끄기를 보내지 않았다');

  // 범위 계정(vc-b 만) — 목록에 자기 법인만, 주소는 가린다
  const sl = await call('sadm', 'GET', '');
  assert.equal(sl.s, 200);
  assert.deepEqual(sl.j.directors.map((x) => x.name), ['폴란드 법인']);
  assert.equal(sl.j.directors[0].masked, true);
  assert.doesNotMatch(sl.t, /127\.0\.0\.1|"consoleName"/);
  assert.equal((await call('sadm', 'GET', `/settings/directors/${DB}/catalog`)).s, 403, '카탈로그는 전체 범위 전용');
});

test('③ 인증 정지는 Director 마다 — A 가 멈춰도 B 의 주기 조회는 돈다', async () => {
  const svc = await import('../src/bareos/service.js');
  const credA = S.directorCred(S.directorById(DA));
  svc.bareosAuthGuard.markAuthStopped(credA.id, credA, 'Authorization failed.');
  try {
    await assert.rejects(svc.withDirector(DA, async () => 'x', { trigger: 'timer' }), (e) => e.code === 'auth-stopped' && /한국 본사/.test(e.message));
    assert.equal(await svc.withDirector(DB, async () => 'ok', { trigger: 'timer' }), 'ok');
    assert.equal(await svc.withDirector(DA, async () => 'manual', { trigger: 'manual' }), 'manual', '수동은 계속');
  } finally { svc.bareosAuthGuard.clearAuthStop(credA.id); }
});

/* ───────────────────────── ④ 자동 설정 확장 ───────────────────────── */
test('④ Pool·Schedule 블록 = 웹 사전 준비 블록(글자까지) · 입력 화이트리스트', () => {
  const defaults = { fileSet: 'PortalVmwareGeneric', jobDefs: 'PortalVmwareDefaults', restoreJob: 'PortalVmwareRestore', pluginName: 'python3' };
  const pools = { fullDays: 90, incrDays: 30, maxVolumeGB: 50 };
  const schedule = { fullDay: 'sat', time: '01:30' };
  const server = A.directorResources({ defaults, consoleName: 'portal', consolePassword: '<생성한 비밀번호>', restoreClient: 'bareos-fd', restoreStorage: 'File', restorePool: 'PortalVmwareFull', pools, schedule });
  assert.equal(server.map((r) => r.text).join('\n'), directorPrepBlock({ defaults, consoleName: 'portal', anyClient: 'bareos-fd', anyStorage: 'File', anyPool: 'PortalVmwareFull', pools, schedule }));
  assert.deepEqual(server.map((r) => `${r.type}/${r.name}`).slice(-3), ['pool/PortalVmwareFull', 'pool/PortalVmwareIncr', 'schedule/PortalVmwareNightly']);
  const sched = server.at(-1).text;
  assert.match(sched, /Run = Full sat at 01:30/);
  assert.equal((sched.match(/Run = Incremental/g) || []).length, 6, '나머지 요일은 증분(요일마다 한 줄)');
  assert.doesNotMatch(sched, /Incremental sat/);
  assert.match(server[1].text, /Full Backup Pool = "PortalVmwareFull"[\s\S]*Incremental Backup Pool = "PortalVmwareIncr"/);
  assert.doesNotMatch(A.directorResources({ defaults, consoleName: 'portal', consolePassword: 'x', restoreClient: 'c', restoreStorage: 's', restorePool: 'p' })[1].text, /Backup Pool/, '풀을 안 만들면 JobDefs 도 그대로');
  for (const bad of [{ pools: { fullDays: 0, incrDays: 1, maxVolumeGB: 1 } }, { pools: { fullDays: 1, incrDays: 1, maxVolumeGB: 'x' } }, { schedule: { fullDay: 'sunday', time: '01:00' } }, { schedule: { fullDay: 'sun', time: '25:00' } }, { schedule: { fullDay: 'sun', time: '1:00;id' } }]) {
    assert.ok(A.normVmwareExtras(bad).issue, JSON.stringify(bad));
  }
  assert.deepEqual(A.normVmwareExtras({ pools: { fullDays: '90', incrDays: 30, maxVolumeGB: 50 } }).pools, { fullDays: 90, incrDays: 30, maxVolumeGB: 50 });
});

const PREFLIGHT_OUT = [
  '@@id', '0', '@@pkg', 'bareos-director 25.0.4', 'bareos-storage 25.0.4', 'bareos-filedaemon 25.0.4', 'bareos-vmware-plugin -', 'bareos-filedaemon-python3-plugin 25.0.4',
  '@@svc', 'bareos-dir active', 'bareos-sd inactive', 'bareos-fd active', '@@py', '3.9.18', '@@pyvmomi', '9.0.0.0', '@@vddk', '@@plugdir', '/usr/lib64/bareos/plugins',
  '@@fdconf', '@@layout', 'D', 'C', '@@res', 'client bareos-fd', 'storage File', 'pool Full', 'pool Incremental', 'schedule WeeklyCycle', 'client bad;name', '@@end', '',
].join('\n');

test('④ 사전 점검 해석: 없음·멈춤·버전 충돌은 짚고, 못 읽은 것(VDDK)은 확인 불가 · 리소스 이름은 화이트리스트', () => {
  const r = A.parsePreflight(PREFLIGHT_OUT);
  const by = Object.fromEntries(r.items.map((x) => [x.key, x]));
  assert.equal(by.root.status, 'ok');
  assert.equal(by['pkg:bareos-vmware-plugin'].status, 'missing');
  assert.equal(by['pkg:bareos-director'].detail, '25.0.4');
  assert.equal(by['svc:bareos-sd'].status, 'missing');
  assert.equal(by.pyvmomi.status, 'warn', 'pyVmomi 9 + Python 3.9 — 플러그인이 시작하지 못한다');
  assert.equal(by.vddk.status, 'unknown', '찾지 못함은 없음이 아니다');
  assert.equal(by.fdplugin.status, 'missing');
  assert.equal(by.layout.status, 'ok');
  assert.equal(r.pluginDir, '/usr/lib64/bareos/plugins');
  assert.deepEqual(r.resources.client, ['bareos-fd'], '리소스 이름 규칙에 맞지 않는 줄은 버린다');
  assert.deepEqual(r.resources.pool, ['Full', 'Incremental']);
  // 출력이 중간에 끊기면 그 뒤는 전부 확인 불가(없음으로 단정하지 않는다)
  const cut = A.parsePreflight(PREFLIGHT_OUT.split('@@py')[0]);
  const c = Object.fromEntries(cut.items.map((x) => [x.key, x.status]));
  assert.equal(c.output, 'unknown');
  assert.equal(c.python, 'unknown'); assert.equal(c.vddk, 'unknown'); assert.equal(c.layout, 'unknown'); assert.equal(c.fdplugin, 'unknown');
});

const MYSELF = 'Client {\n  Name = bareos-fd\n  Maximum Concurrent Jobs = 20\n  # Plugin Directory = "/usr/lib/bareos/plugins"\n  # Plugin Names = ""\n}\n';
test('④ FD 플러그인 줄: 없는 줄만 닫는 괄호 앞에 · 같은 값 그대로 · 다른 값·블록 2개·한 줄 블록 거부', () => {
  const r = A.fdPluginEdit(MYSELF, '/usr/lib64/bareos/plugins');
  assert.equal(r.action, 'updated');
  assert.equal(r.text, 'Client {\n  Name = bareos-fd\n  Maximum Concurrent Jobs = 20\n  # Plugin Directory = "/usr/lib/bareos/plugins"\n  # Plugin Names = ""\n  Plugin Directory = "/usr/lib64/bareos/plugins"\n  Plugin Names = "python3"\n}\n');
  assert.equal(A.fdPluginEdit(r.text, '/usr/lib64/bareos/plugins').action, 'unchanged', '두 번 돌려도 그대로');
  assert.equal(A.fdPluginEdit('Client {\n  PluginNames = python3\n  Plugin Directory = /usr/lib64/bareos/plugins/\n}\n', '/usr/lib64/bareos/plugins').action, 'unchanged', '띄어쓰기·따옴표·끝 슬래시가 달라도 같은 값');
  assert.match(A.fdPluginEdit('Client {\n  Plugin Names = "python3:ldap"\n}\n', '/usr/lib64/bareos/plugins').issue, /덮지 않습니다/);
  assert.match(A.fdPluginEdit('Client {\n  Plugin Directory = "/opt/x"\n}\n', '/usr/lib64/bareos/plugins').issue, /직접 확인/);
  assert.match(A.fdPluginEdit('Client {\n}\nClient {\n}\n', '/usr/lib64/bareos/plugins').issue, /2개/);
  assert.match(A.fdPluginEdit('Client { Name = x }\n', '/usr/lib64/bareos/plugins').issue, /한 줄/);
  assert.match(A.fdPluginEdit('# Client {\n', '/usr/lib64/bareos/plugins').issue, /0개/, '주석 속 Client 는 세지 않는다');
});

/** 가짜 FD 서버 — setupFdPlugin 이 쓰는 명령만. */
function fakeFd({ content = MYSELF, testCode = 0, active = 'active', plugin = true, mktemp = true } = {}) {
  const F = new Map([['/etc/bareos/bareos-fd.d/client/myself.conf', content]]);
  const st = { cmds: [], restarts: 0, writes: [] };
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const exec = async (cmd) => {
    st.cmds.push(cmd);
    let m;
    if (cmd === 'id -u') return ok('0\n');
    if (cmd.startsWith('command -v bareos-fd')) return ok(`F\n${plugin ? 'P:/usr/lib64/bareos/plugins\n' : ''}Y\n`);
    if (/^if ! \[ "\$\(readlink -f -- \S+\)" = "\S+" \]; then echo LINK; elif \[ -L (\S+) \]/.test(cmd)) return ok(`FILE\nroot bareos 640\n${F.get('/etc/bareos/bareos-fd.d/client/myself.conf')}`);
    // v2.823 검토(S5): 사본·원복은 심링크가 아닐 때만(가짜 파일계에는 심링크가 없다 — 명령 모양만 고정)
    if ((m = /^\[ "\$\(readlink -f -- \S+\)" = "\S+" \] && \[ ! -L (\S+) \] && \[ ! -e (\S+) \] && cp -p (\S+) (\S+)$/.exec(cmd))) { if (F.has(m[2])) return { code: 1, stdout: '', stderr: '' }; F.set(m[4], F.get(m[3])); return ok(); }
    if ((m = /^\[ "\$\(readlink -f -- \S+\)" = "\S+" \] && \[ ! -L (\S+) \] && cp -p (\S+) (\S+) && systemctl restart bareos-fd$/.exec(cmd))) { F.set(m[3], F.get(m[2])); st.restarts += 1; return ok(); }
    if ((m = /^mktemp -d \/tmp\/([a-z-]+)\.X{10}$/.exec(cmd))) return mktemp ? ok(`/tmp/${m[1]}.Ab3dEf7hIj\n`) : { code: 1, stdout: '', stderr: 'mktemp: failed' };
    if (/^test -d \S+ && test ! -L \S+ && test -O \S+ && echo ok$/.test(cmd)) return ok('ok\n');
    if ((m = /^\[ "\$\(readlink -f -- \S+\)" = "\S+" \] && install -o root -g bareos -m 640 (\S+) (\S+) && rm -f \S+$/.exec(cmd))) { F.set(m[2], F.get(m[1])); F.delete(m[1]); return ok(); }
    if (cmd === 'bareos-fd -t 2>&1') return { code: testCode, stdout: testCode ? 'Config error: line 6' : '', stderr: '' };
    if (cmd.startsWith('systemctl restart bareos-fd 2>&1')) { st.restarts += 1; return ok(`${active}\n`); }
    if (/^rm -rf \/tmp\/portal-bareos\.\w+$/.test(cmd)) return ok();
    return { code: 127, stdout: '', stderr: `unknown: ${cmd}` };
  };
  const api = { exec, writeFile: async (p, c, mode) => { st.writes.push({ p, mode }); F.set(p, String(c)); } };
  return { F, st, ssh: async (_c, fn) => fn(api) };
}
const conf = '/etc/bareos/bareos-fd.d/client/myself.conf';
const PB = () => ({ directorId: DB, host: '10.20.30.40', password: 'ssh-Secret-1' });

test('④ FD 플러그인 켜기: 넣고 재시작 · 이미 있으면 그대로(재시작 없음) · -t 실패·재시작 실패는 사본으로 원복 · 남의 값 거부 · 비밀번호는 명령에 없음', async () => {
  let f = fakeFd();
  A._setDepsForTest({ ssh: f.ssh });
  const r = await A.setupFdPlugin(PB());
  assert.equal(r.action, 'updated');
  assert.match(f.F.get(conf), /Plugin Names = "python3"\n}\n$/);
  assert.ok(f.F.has(r.backup) && f.F.get(r.backup) === MYSELF, '쓰기 전 사본');
  assert.equal(f.st.restarts, 1);
  assert.ok(!f.st.cmds.join('\n').includes('ssh-Secret-1'));
  assert.ok(f.st.writes.every((w) => w.mode === 0o600));

  f = fakeFd({ content: f.F.get(conf) });
  A._setDepsForTest({ ssh: f.ssh });
  assert.equal((await A.setupFdPlugin(PB())).action, 'unchanged');
  assert.equal(f.st.restarts, 0, '바꾸지 않으면 재시작하지 않는다');

  f = fakeFd({ testCode: 1 });
  A._setDepsForTest({ ssh: f.ssh });
  await assert.rejects(A.setupFdPlugin(PB()), (e) => e.code === 'config-test' && /되돌리고/.test(e.message));
  assert.equal(f.F.get(conf), MYSELF, '-t 실패 → 원래 내용');

  f = fakeFd({ active: 'failed' });
  A._setDepsForTest({ ssh: f.ssh });
  await assert.rejects(A.setupFdPlugin(PB()), (e) => e.code === 'remote' && /되돌리고/.test(e.message));
  assert.equal(f.F.get(conf), MYSELF, '재시작 실패 → 원래 내용');
  assert.equal(f.st.restarts, 2, '되돌린 뒤 다시 재시작');

  f = fakeFd({ content: 'Client {\n  Plugin Names = "python3:ldap"\n}\n' });
  A._setDepsForTest({ ssh: f.ssh });
  await assert.rejects(A.setupFdPlugin(PB()), (e) => e.code === 'conflict');
  assert.equal(f.st.cmds.filter((c) => c.includes('cp -p')).length, 0, '거부면 사본도 만들지 않는다(아무것도 안 바꿈)');

  f = fakeFd({ plugin: false });
  A._setDepsForTest({ ssh: f.ssh });
  await assert.rejects(A.setupFdPlugin(PB()), (e) => e.code === 'invalid' && /python3-plugin/.test(e.message));

  // v2.823 검토(C6 — 재현): 임시 디렉터리를 못 만들면 아무것도 바꾸지 않았다 — 사본·원복·재시작 없이 끝나고 '세션이 끊겨' 라고 말하지 않는다
  f = fakeFd({ mktemp: false });
  A._setDepsForTest({ ssh: f.ssh });
  await assert.rejects(A.setupFdPlugin(PB()), (e) => !/세션이 끊겨/.test(e.message));
  assert.equal(f.st.restarts, 0, '바꾼 것이 없으면 재시작하지 않는다');
  assert.equal(f.st.cmds.filter((c) => c.includes('cp -p')).length, 0, '사본도 만들지 않았다');
  assert.equal(f.F.get(conf), MYSELF);
  // S5: 원복 명령은 conf 자리가 심링크가 아닐 때만
  f = fakeFd({ testCode: 1 });
  A._setDepsForTest({ ssh: f.ssh });
  await assert.rejects(A.setupFdPlugin(PB()));
  assert.ok(f.st.cmds.some((c) => /\[ ! -L \S+myself\.conf \] && cp -p \S+portal-bak\.\d+ \S+myself\.conf && systemctl restart bareos-fd$/.test(c)), '원복은 심링크 확인 뒤');
  A._setDepsForTest();
});

test('④ 매핑 제안(순수): 하나뿐·포탈 이름·설치 기본 이름만 고르고 그 밖은 비운다 · 메일에 법인 Director 열', async () => {
  const { suggestMapping } = await import('../src/routes/api/bareosBackup.js');
  const out = suggestMapping({ director: { id: 'dir_x' }, sites: [{ vcenterId: 'vc-q', directorId: 'dir_x' }, { vcenterId: 'vc-z', directorId: 'dir_y' }],
    catalog: { clients: ['a-fd', 'b-fd'], storages: ['File'], pools: ['P1', 'P2'], schedules: [] }, vcenters: [{ id: 'vc-q', host: 'https://vc-q.corp/' }] });
  assert.equal(out.length, 1);
  assert.equal(out[0].fields.client.value, '', '후보가 둘이면 고르지 않는다');
  assert.deepEqual(out[0].fields.client.choices, ['a-fd', 'b-fd']);
  assert.equal(out[0].fields.storage.value, 'File');
  assert.equal(out[0].fields.pool.value, '');
  assert.equal(out[0].fields.vcserver.value, 'vc-q.corp');
  const { renderBareosMail } = await import('../src/bareos/notify.js');
  const m = renderBareosMail([{ at: Date.now(), vcenterId: 'vc-q', directorId: 'dir_x', vmName: 'v<1>', kind: 'backup', state: 'error', status: 'f', jobid: 5, jobName: 'pv-1' }], (id) => id, () => '폴란드 <법인>');
  assert.match(m.html, /<th style="padding:4px 8px">법인 Director<\/th>/);
  assert.match(m.html, /폴란드 &lt;법인&gt;/, '이름도 esc');
  assert.match(m.text, /폴란드 <법인>/);
});
