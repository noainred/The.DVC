/**
 * test/bareosBugs2847c.test.js — v2.847 Bareos 버그 점검 2회차(반증 판정 hunt2/R.md) C 묶음: 인증 정지 · 엣지 대행 · 원장 · 예산.
 *  S2-1(= E2-4) v2.846 이 TLSv1.2 신원에 '#tls1.2' 를 붙여 올리기 전 정지가 업그레이드만으로 풀렸다 — 기동 뒤 한 번 옛 모양 기록을 새 신원으로 옮긴다
 *  E2-3 엣지 대행 작업이 끝나면 시한 신호의 abort 리스너를 뗀다(부른 쪽 secretArgs 를 신호 수명까지 붙잡지 않게)
 *  E2-2 엣지 워커가 실행 중인 상태 변경 작업을 업그레이드 대기 목록(runningBareosWork)에 싣는다
 *  D2-1 카탈로그를 유지한 다시 묶기 뒤 옛 복원 지점의 덮어쓰기는 그 지점의 백업 때 위치로 판정
 *  D2-4 실패 메일 상태 키 상한 ≥ 원장 상한(재시작 뒤 다시 알리지 않는다) · D2-6 그룹 원장을 못 읽으면 스토리지 삭제 · 편집 거부
 *  D2-7 deleteJob · patchJob 쓰기 실패면 메모리도 되돌린다 · C2-1 설정 조회는 남은 예산만 기다린다 · C2-5 다시 등록 서버 예산 < 화면 시한
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getEventListeners } from 'node:events';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareos2847c-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';

const S = await import('../src/bareos/settings.js');
const REG = await import('../src/bareos/registry.js');
const N = await import('../src/bareos/notify.js');
const EO = await import('../src/bareos/edgeOps.js');
const IF = await import('../src/bareos/inflight.js');
const G = await import('../src/bareos/groups.js');
const SV = await import('../src/bareos/manage/service.js');
const svc = await import('../src/bareos/service.js');
const { restorePlan, placementAt } = await import('../src/bareos/restore.js');
const ROUTE = await import('../src/routes/api/bareosManage.js');
const W = await import('../../web/src/views/tools/bareosCorpText.js');
const { store } = await import('../src/store.js');

after(() => { EO._resetForTest(); IF._resetInflightForTest(); svc._setSessionFactoryForTest(null); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('S2-1 올리기 전(신원에 TLS 판 없음) TLSv1.2 Director 의 인증 정지가 업그레이드 뒤에도 유지된다 — 같은 틀린 비밀번호로 다시 로그인하지 않는다', () => {
  const a = S.addDirector({ name: 'PL', host: 'pl.corp', consoleName: 'portal', password: 'pw-pl', tlsMax: 'TLSv1.2' }).director;
  const da = S.directorById(a.id);
  const now = S.directorCred(da);
  assert.match(now.username, /#tls1\.2$/);
  const legacy = { ...now, username: now.username.replace(/#tls1\.2$/, '') };   // v2.845 모양
  svc.bareosAuthGuard.markAuthStopped(legacy.id, legacy, '인증 실패(올리기 전)');
  svc._resetTlsStopMigrationForTest();   // 기동 직후
  const stop = svc.bareosAuthGuard.authStopFor(now);
  assert.ok(stop, '정지가 남는다(예전: null — 이번 주기에 다시 로그인)');
  assert.equal(stop.reason, '인증 실패(올리기 전)');
  assert.ok(svc.bareosAuthGuard.peekAuthStop(now), '화면 표시도 유지');
  // 그 뒤 사람이 비밀번호를 바꾸면 E-2 / 기존 규칙대로 풀린다(한 번 다시 시도)
  assert.equal(svc.bareosAuthGuard.authStopFor({ ...now, password: 'new-pw' }), null);
  S.deleteDirector(a.id, { inUseByJobs: 0 });
});

test('E2-3 엣지 대행 작업이 끝나면 시한 신호의 abort 리스너를 뗀다', async () => {
  const d = { id: 'dir_e', agent: 'edge-x', connSig: '' };
  const ac = new AbortController();
  const p = EO.enqueueEdgeOp(d, 'setup.manage', { action: 'console.add' }, { secretArgs: { ssh: { password: 'root-pw' }, accountPassword: 'acc-pw' }, signal: ac.signal });
  assert.equal(getEventListeners(ac.signal, 'abort').length, 1);
  const [op] = EO.takeEdgeOps('edge-x', 5);
  assert.equal(op.secretArgs.accountPassword, 'acc-pw');
  EO.completeEdgeOp(op.id, 'edge-x', { ok: true, value: { files: [{ path: '/etc/bareos/bareos-dir.d/console/a.conf', action: 'added' }], restarted: false, reloaded: true } });
  await p;
  assert.equal(getEventListeners(ac.signal, 'abort').length, 0, '끝난 작업의 리스너가 남지 않는다(예전: 신호가 끝날 때까지 남아 비밀번호 객체를 붙잡음)');
});

test('E2-2 엣지 워커 — 상태 변경 작업은 실행 ~ 회신까지 업그레이드 대기 목록에 · 조회(poll)는 넣지 않는다', () => {
  IF._resetInflightForTest();
  IF.noteEdgeOpStart('op1', 'setup.manage', 'dir_kr');
  const w = IF.runningBareosWork();
  assert.ok(w.some((x) => x.key === 'edge-run:op1' && /setup\.manage/.test(x.label) && !/pw|password/i.test(x.label)));
  IF.noteEdgeOpEnd('op1');
  assert.equal(IF.runningBareosWork().filter((x) => x.key.startsWith('edge-run:')).length, 0);
  const src = fs.readFileSync(new URL('../src/agent/bareosOpWorker.js', import.meta.url), 'utf8');
  assert.match(src, /const track = EDGE_MUTATING\.has\(op\.kind\) && op\.kind !== 'poll';\s*\n\s*if \(track\) noteEdgeOpStart\(op\.id, op\.kind, op\.directorId\);/);
  assert.match(src, /finally \{ inflight -= 1; if \(track\) noteEdgeOpEnd\(op\.id\); \}/, '회신까지 마친 뒤 뺀다');
});

test('D2-1 카탈로그를 유지한 다시 묶기 — 옛 지점의 덮어쓰기는 백업 때 위치로 판정(새 지점 · 새 VM 복원은 그대로)', () => {
  const j = REG.addJob({ vcenterId: 'vc-a', vmId: 'vc-a:vm-1', vmName: 'app', dc: 'DC-A', folder: '/old', directorId: 'dir_x', bareosJob: 'pv-1', client: 'c', storage: 's', pool: 'p', schedule: 'S', level: 'Incremental', createdBy: 'adm' });
  REG.applyRunRow(j.id, { jobid: 500, status: 'T', level: 'F', name: 'pv-1', type: 'B', starttime: '2026-10-01 01:00:00', endtime: '2026-10-01 01:10:00', jobbytes: 1, jobfiles: 1 });
  // 이름은 그대로 · 폴더만 옮긴 VM(같은 moref) — 다시 묶기는 지금 값으로
  REG.rebindJobs([{ id: j.id, bareosJob: 'pv-1', client: 'c', storage: 's', pool: 'p', vmName: 'app', dc: 'DC-A', folder: '/new' }], { restart: false });
  const g = REG.getJob(j.id);
  assert.deepEqual(g.placements.map((x) => [x.upToJobid, x.folder]), [[500, '/old']]);
  assert.equal(placementAt(g, 500).folder, '/old');
  assert.equal(placementAt(g, 501).folder, '/new');
  const snap = { vms: [{ id: 'vc-a:vm-1', vcenterId: 'vc-a', name: 'app', vcDcPath: 'DC-A', folderPath: '/new', powerState: 'POWERED_OFF', snapshotCount: 0 }] };
  const old = restorePlan({ mode: 'original', job: g, snapshot: snap, confirmName: 'app', jobid: 500 });
  assert.equal(old.ok, false);
  assert.match(old.issue, /다시 등록하기 전/);
  const fresh = restorePlan({ mode: 'original', job: g, snapshot: snap, confirmName: 'app', jobid: 501 });
  assert.ok(!(fresh.issue || '').includes('다시 등록하기 전'), fresh.issue);
  // 복원 라우트가 고른 jobid 를 넘긴다(안 넘기면 지금 위치로 판정해 옛 지점의 덮어쓰기가 열린다)
  const route = fs.readFileSync(new URL('../src/routes/api/bareosBackup.js', import.meta.url), 'utf8');
  assert.match(route, /const plan = restorePlan\(\{[^}]*\bjobid \}\);/);
  // 새 카탈로그(restart)면 옛 지점이 없다 — 기록을 비운다
  REG.rebindJobs([{ id: j.id, bareosJob: 'pv-1', client: 'c', storage: 's', pool: 'p', vmName: 'app', dc: 'DC-A', folder: '/new2' }], { restart: true });
  assert.deepEqual(REG.getJob(j.id).placements, []);
  REG.deleteJob(j.id, { directorId: 'dir_x' });
});

test('D2-4 원장 2,000개를 넘어도 재시작 뒤 이미 판정한 실패를 다시 알리지 않는다', async () => {
  const prev = store.snapshot;
  store.snapshot = { ...(prev || {}), source: 'live', vcenters: [] };
  try {
    N._resetForTest();
    await N.tick();
    await new Promise((r) => setTimeout(r, 5));
    const inputs = [];
    for (let i = 0; i < 2500; i += 1) inputs.push({ vcenterId: 'vc-n', vmId: `vc-n:vm-${i}`, vmName: `vm-${i}`, dc: 'DC', folder: '/', directorId: 'dir_n', bareosJob: `pn-${i}`, client: 'c', storage: 's', pool: 'p', schedule: 'S', level: 'Incremental', createdBy: 'adm' });
    const out = REG.addJobs(inputs);
    REG.inBatch(() => { for (const o of out) REG.applyRunRow(o.job.id, { jobid: 100, status: 'E', level: 'I', name: o.job.bareosJob, type: 'B', starttime: '2026-11-01 01:00:00', endtime: '2026-11-01 01:05:00', jobbytes: 0, jobfiles: 0, joberrors: 1 }); });
    await N.tick();
    assert.equal(N.bareosMailStatus()?.rows, 2500);
    N._resetForTest();   // 재시작
    await N.tick();
    assert.equal(N.bareosMailStatus(), null, '다시 알릴 줄이 없다(예전: 500줄)');
    REG.inBatch(() => { for (const o of out) REG.deleteJob(o.job.id, { directorId: 'dir_n' }); });
  } finally { store.snapshot = prev; }
});

test('D2-6 그룹 원장을 못 읽으면 스토리지 삭제 · 편집 계획을 거부(그룹 스토리지 없음으로 보지 않는다)', async () => {
  const DIR = S.addDirector({ name: '한국', host: '10.20.30.40', port: 9101, consoleName: 'portal' }).director.id;
  svc._setSessionFactoryForTest(async () => ({
    info: { banner: 'OK: bareos-dir Version: 25.0.4 (01 Jan 2026)' }, close() {},
    call: async (cmd) => {
      if (cmd === 'show storages') return { storages: { File: { name: 'File', address: 'sd' }, Fast: { name: 'Fast', address: 'sd' } } };
      return {};
    },
  }));
  fs.writeFileSync(path.join(tmp, 'bareos-groups.json'), '{ 손상');
  G._resetGroupsForTest();
  try {
    assert.ok(G.groupsLoadError());
    SV.forgetConfig(DIR);
    await assert.rejects(SV.planFor(S.directorById(DIR), 'storage.delete', { name: 'Fast' }), (e) => e.code === 'conflict' && /(그룹 원장을 읽지 못해|스토리지 목록을 읽지 못해)/.test(e.message));
  } finally {
    fs.rmSync(path.join(tmp, 'bareos-groups.json'), { force: true }); G._resetGroupsForTest(); svc._setSessionFactoryForTest(null); SV.forgetConfig(DIR);
  }
  const src = fs.readFileSync(new URL('../src/bareos/manage/service.js', import.meta.url), 'utf8');
  assert.match(src, /\(action === 'storage\.delete' \|\| action === 'storage\.edit'\) && groupsLoadError\(\)/);
});

test('D2-7 원장 쓰기가 실패하면 deleteJob · patchJob 도 메모리를 되돌린다(재시작 뒤 되살아나 켜짐으로 보이지 않게)', () => {
  const F = path.join(tmp, 'bareos-jobs.json');
  const j = REG.addJob({ vcenterId: 'vc-a', vmId: 'vc-a:vm-7', vmName: 'app-07', dc: 'DC', folder: '/', directorId: 'dir_x', bareosJob: 'pv-7', client: 'c', storage: 's', pool: 'p', schedule: 'S', level: 'Incremental', createdBy: 'adm' });
  const keep = fs.readFileSync(F, 'utf8');
  fs.rmSync(F); fs.mkdirSync(F); fs.writeFileSync(path.join(F, 'x'), '1');   // 쓰기 실패 흉내(rename 이 실패)
  try {
    assert.throws(() => REG.deleteJob(j.id, { directorId: 'dir_x' }));
    assert.ok(REG.getJob(j.id), '메모리에도 남는다(화면이 삭제됨으로 보이지 않게)');
    assert.ok(!REG.retiredNames().some((r) => r.name === 'pv-7'), '지운 이름도 되돌린다');
    assert.throws(() => REG.patchJob(j.id, { enabled: false }));
    assert.equal(REG.getJob(j.id).enabled !== false, true, 'patch 도 되돌린다');
  } finally { fs.rmSync(F, { recursive: true, force: true }); fs.writeFileSync(F, keep); }
  assert.equal(REG.deleteJob(j.id, { directorId: 'dir_x' }), true);
});

test('C2-1 설정 조회는 남은 예산만 기다린다(공유 조회는 끊지 않는다) · 예산은 라우트 진입부터', async () => {
  const DIR = S.addDirector({ name: '느린 법인', host: '10.9.9.9', port: 9101, consoleName: 'portal', agent: 'edge-slow' }).director.id;
  const t0 = Date.now();
  const r = await SV.planFor(S.directorById(DIR), 'console.add', { name: 'alice', profile: 'operator' }, { waitMs: 50 }).catch((e) => e);
  assert.ok(Date.now() - t0 < 2000, `엣지가 회신하지 않아도 waitMs 안에 판정으로 넘어간다(${Date.now() - t0}ms)`);
  assert.ok(r);
  EO._resetForTest(); SV.forgetConfig(DIR);
  const src = fs.readFileSync(new URL('../src/routes/api/bareosManage.js', import.meta.url), 'utf8');
  assert.match(src, /const t0 = Date\.now\(\);\s+\/\/ C2-1: 예산 시작\s*\n\s*const pre = otpPrecheck/);
  assert.match(src, /planFor\(d, action, input, \{ waitMs: MANAGE_BUDGET_MS - MANAGE_MIN_RUN_MS \}\)/);
  assert.match(src, /if \(left < MANAGE_MIN_RUN_MS\) return res\.status\(503\)/);
  assert.ok(src.indexOf('if (left < MANAGE_MIN_RUN_MS)') < src.indexOf('if (!otpVerify(req, res, pre.needOtp)) return;\n  if (!claimSetup'), '예산 부족 판정은 OTP 앞(1회용 코드를 태우지 않는다)');
  assert.ok(ROUTE.MANAGE_BUDGET_MS < 600_000 && ROUTE.BULK_BUDGET_MS < 600_000 && ROUTE.MANAGE_MIN_RUN_MS > 0);
});

test('C2-5 다시 등록 서버 예산 < 화면 시한(600초) · 스캔 화면 시한은 서버 대기 시간(relayLimits)으로', () => {
  assert.ok(SV.REREGISTER_BUDGET_MS < 600_000);
  assert.ok(SV.REREGISTER_MIN_BATCH_MS < SV.REREGISTER_BUDGET_MS);
  const lim = EO.relayLimits();
  assert.equal(W.scanWaitMs(lim), lim.pickupMs + lim.resultMs['setup.scan'] + 15_000);
  assert.ok(W.scanWaitMs(lim) >= lim.pickupMs + lim.resultMs['setup.scan'], '서버 최악보다 먼저 끊지 않는다(예전 200초 < 270초)');
  assert.equal(W.scanWaitMs(null), 300_000);
  const web = fs.readFileSync(new URL('../../web/src/views/tools/BareosCorp.jsx', import.meta.url), 'utf8');
  assert.ok(!/timeoutMs: 200_000/.test(web), '화면에 숫자를 박지 않는다');
});
