/**
 * test/bareosLive2833.test.js — v2.833 Bareos 진행 현황판(사용자 요청 '진행 중인 백업 현황판 — 전체 법인 · 단일 법인 · 백업 속도 상태' · 결정 'Director 상태 조회').
 *  ① liveParse — FD 상태 평문(쉼표 숫자 · 레벨 · Terminated Jobs 절 무시) · JSON 으로 감싼 원문 · 구조화 JSON · 고유 잡 이름 → 리소스 이름 · 긴 입력 선형
 *  ② ops.liveStatus — FD 마다 status client= · 틀린 이름은 보내지 않음 · 세션째 끊기면 남은 FD 건너뜀 · 엣지 회신 정제(음수·문자열 버림)
 *  ③ 원장 lastRate — 끝난 성공(T·W)만 · 바이트·시각을 다 읽었을 때만 · 더 새 jobid 만
 *  ④ liveTick(가짜 Director) — 실행 중 잡이 있는 Director 만 묻는다 · 잡이 없으면 접속 0 · 실패는 속도 모름(null — 0 아님)
 *  ⑤ 라우트 — admin 전용 · 범위 밖 법인은 목록에 없음 · 느림 판정 · 오늘 합계 · 오류 원문·주소 없음 · 데모 계정은 상태 조회를 깨우지 않음
 *  ⑥ Command ACL 에 delete(v2.831 보관 정리) · status — 서버·웹 글자 같음
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareoslive-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
const HERE = path.dirname(fileURLToPath(import.meta.url));

const LP = await import('../src/bareos/liveParse.js');
const { OPS } = await import('../src/bareos/ops.js');
const { sanitizeEdgeResult } = await import('../src/bareos/edgeResult.js');
const { startFakeDirector } = await import('./_fakeBareosDirector.js');

const FD_TEXT = [
  'kr-fd Version: 24.0.1 (05 Sep 2026)',
  'Running Jobs:',
  'JobId 501 Job vm-j1.2026-10-31_02.00.00_05 is running.',
  '    Full Backup Job started: 31-Oct-26 02:00',
  '    Files=3 Bytes=412,345,678,912 AveBytes/sec=95,123,456 LastBytes/sec=168,000,000 Errors=0',
  '    Bwlimit=0 ReadBytes=412,345,678,912',
  'JobId 502 Job vm-j2.2026-10-31_02.00.01_06 is running.',
  '    Incremental Backup Job started: 31-Oct-26 02:00',
  '    Files=1 Bytes=1,000,000 AveBytes/sec=900,000 LastBytes/sec=800,000 Errors=0',
  'JobId 601 Job vm-j6.2026-10-31_02.10.00_07 is running.',
  '    Incremental Backup Job started: 31-Oct-26 02:10',
  '    Files=1 Bytes=5,000 AveBytes/sec=1,000 LastBytes/sec=7,000,000 Errors=0',
  '====',
  'Terminated Jobs:',
  ' JobId  Level    Files      Bytes   Status   Finished        Name',
  'JobId 400 Job old.2026-10-30_02.00.00_01 is running.',
].join('\n');

test('① FD 상태 평문 — 쉼표 숫자 · 레벨 · 잡 이름 · Terminated Jobs 절 무시', () => {
  const r = LP.parseFdStatus(FD_TEXT);
  assert.equal(r.length, 3, '끝난 잡 절(400)은 보지 않는다');
  assert.deepEqual(r[0], { jobid: 501, job: 'vm-j1.2026-10-31_02.00.00_05', name: 'vm-j1', level: 'F', bytes: 412345678912, files: 3, aveRate: 95123456, lastRate: 168000000 });
  assert.equal(r[1].level, 'I');
  assert.equal(LP.rateNowOf(r[1]), 800000);
  assert.equal(LP.rateNowOf({ aveRate: 5, lastRate: null }), 5);
  assert.equal(LP.rateNowOf(null), null);
  assert.deepEqual(LP.parseFdStatus('No Jobs running.\n'), []);
  // 바이트 줄이 없으면 null(0 이 아니다)
  assert.equal(LP.parseFdStatus('JobId 7 Job x is running.\n')[0].bytes, null);
  assert.equal(LP.jobNameOf('pv-a.b.2026-10-31_02.00.00_05'), 'pv-a.b');
  assert.equal(LP.jobNameOf('weird'), 'weird');
});

test('① JSON 으로 감싼 원문 · 구조화 JSON · 같은 jobid 는 하나', () => {
  assert.equal(LP.parseStatusRaw(JSON.stringify({ jsonrpc: '2.0', result: { output: FD_TEXT } })).length, 3);
  const s = LP.parseStatusRaw(JSON.stringify({ result: { running: [{ jobid: 77, job: 'vm-q.2026-10-31_02.00.00_01', jobbytes: '12', jobfiles: 1, avebytes_sec: 3, lastbytes_sec: 4 }] } }));
  assert.deepEqual(s.map((x) => [x.jobid, x.name, x.bytes, x.lastRate]), [[77, 'vm-q', 12, 4]]);
  assert.deepEqual(LP.parseStatusRaw(''), []);
  assert.deepEqual(LP.parseStatusRaw('{broken'), [], '깨진 JSON 은 평문으로 — 잡 줄이 없으면 빈 목록');
});

test('① 긴 외부 입력은 선형(ReDoS — 비율로 본다)', () => {
  const t = (n) => { const s = `JobId 1 Job x is running.\n    Files=${'1,'.repeat(n)} Bytes=1\n${'a'.repeat(n)}\n`; const a = process.hrtime.bigint(); LP.parseFdStatus(s); return Number(process.hrtime.bigint() - a); };
  t(1000);
  const small = t(20_000); const big = t(200_000);
  assert.ok(big < small * 40 + 5e7, `10배 입력이 ${(big / Math.max(1, small)).toFixed(1)}배 — 이차 시간 의심`);
});

test('② ops.liveStatus — FD 마다 status client= · 틀린 이름은 보내지 않음 · 세션째 끊기면 건너뜀', async () => {
  const cmds = [];
  const s = { async callRaw(cmd) { cmds.push(cmd); if (cmd.includes('dead-fd')) { const e = new Error('closed'); e.code = 'closed'; throw e; } return FD_TEXT; } };
  const out = await OPS.liveStatus(s, { clients: ['kr-fd', 'bad name', 'dead-fd', 'later-fd'] });
  assert.deepEqual(cmds, ['status client=kr-fd', 'status client=dead-fd']);
  assert.equal(out.clients[0].jobs.length, 3);
  assert.equal(out.clients[1].code, 'invalid');
  assert.equal(out.clients[2].ok, false);
  assert.equal(out.clients[3].code, 'skipped');
  const { MUTATING } = await import('../src/bareos/ops.js');
  assert.ok(!MUTATING.has('liveStatus'), '읽기 전용 — 상태를 바꾸지 않는다');
});

test('② 엣지 회신 정제 — 음수·문자열 숫자는 null · jobid 없는 줄은 버림', () => {
  const r = sanitizeEdgeResult('liveStatus', { ok: true, value: { clients: [{ client: 'kr-fd', ok: true, jobs: [{ jobid: 5, bytes: -1, lastRate: '9', aveRate: 7 }, { bytes: 3 }] }, { client: 'x', ok: false, code: 'timeout' }] } });
  assert.equal(r.ok, true);
  assert.equal(r.value.clients[0].jobs.length, 1);
  assert.equal(r.value.clients[0].jobs[0].bytes, null);
  assert.equal(r.value.clients[0].jobs[0].aveRate, 7);
  assert.equal(r.value.clients[1].code, 'timeout');
});

/* ───────── 원장 · 폴러 · 라우트(가짜 Director) ───────── */
const NOW = Date.now();
const MIN = 60_000;
const D = { cmds: [], fdText: FD_TEXT, failStatus: false };
let fd; let srv; let base; let REG; let LIVE;
const USERS = {
  admin: { username: 'adm', role: 'admin', scope: null },
  op: { username: 'op', role: 'operator', scope: null },
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-b'] } },
  demo: { username: 'thedvcdemp', role: 'admin', demoGuest: true, scope: null },
};
const job = (id, vmId, vmName, o = {}) => ({
  id, vcenterId: 'vc-a', vmId, vmName, dc: 'DC', folder: '/db', directorId: 'dir_kr', bareosJob: `vm-${id}`, client: 'kr-fd', storage: 'kr-sd', pool: 'p', schedule: '',
  level: 'Incremental', enabled: true, createdBy: 'adm', createdAt: NOW - 30 * 86_400_000, pending: null, lastRun: null, lastError: null, missingInDirector: false, restores: [], ...o,
});

before(async () => {
  fd = await startFakeDirector({ name: 'portal', password: 'pw-1', handle: async (cmd) => {
    D.cmds.push(cmd);
    if (cmd.startsWith('status client=')) return D.failStatus ? { error: ['Client resource not found'] } : D.fdText;
    if (cmd.startsWith('llist') || cmd.startsWith('list')) return { jobs: [] };
    if (cmd === '.jobs') return { jobs: [] };
    return { error: [`unknown ${cmd}`] };
  } });
  fs.writeFileSync(path.join(tmp, 'users.json'), JSON.stringify({ users: [{ username: 'adm', role: 'admin' }] }));
  fs.writeFileSync(path.join(tmp, 'bareos.json'), JSON.stringify({
    version: 2,
    directors: [{ id: 'dir_kr', name: 'KR-dir', host: '127.0.0.1', port: fd.port, consoleName: 'portal', password: 'pw-1', timeoutMs: 5000 }],
    defaults: {},
    sites: [{ vcenterId: 'vc-a', directorId: 'dir_kr', vcserver: 'vc-a.corp', client: 'kr-fd', storage: 'kr-sd', pool: 'p', configFile: '/etc/bareos/vmware/kr.ini' }],
  }));
  const done = (jobid, status, endedAt, bytes, dur = 10 * MIN, level = 'I') => ({ jobid, status, state: status === 'T' ? 'ok' : status === 'W' ? 'warning' : 'error', level, startedAt: endedAt - dur, endedAt, bytes, files: 1, errors: 0, checkedAt: NOW });
  fs.writeFileSync(path.join(tmp, 'bareos-jobs.json'), JSON.stringify({ version: 1, retired: [], jobs: [
    // 실행 중(포탈이 시작 · 20분 전) — 지난 성공 평균 1,000,000 B/s → FD 지금 800,000(80% — 느림 아님)
    job('j1', 'vc-a:vm-1', 'db-01', { pending: { jobid: 501, since: NOW - 20 * MIN, level: 'Full', state: 'running', status: 'R', trigger: 'group', by: 'adm' },
      lastRate: { jobid: 401, level: 'F', bps: 100_000_000, bytes: 1, at: NOW - 3_600_000 } }),
    // 실행 중 — 지난 평균 10,000,000 → 지금 800,000(8% · 20분 지남 → 느림)
    job('j2', 'vc-a:vm-2', 'db-02', { pending: { jobid: 502, since: NOW - 20 * MIN, level: 'Incremental', state: 'running', status: 'R', trigger: 'manual', by: 'adm' },
      lastRate: { jobid: 402, level: 'I', bps: 10_000_000, bytes: 1, at: NOW - 3_600_000 } }),
    // 대기 중(FD 가 모름) · 오늘 끝난 성공·실패
    job('j3', 'vc-a:vm-3', 'app-03', { pending: { jobid: 503, since: NOW - MIN, level: 'Incremental', state: 'queued', status: 'C' },
      lastRun: done(300, 'T', NOW - 30 * MIN, 5_000_000_000), finishedRuns: [done(300, 'T', NOW - 30 * MIN, 5_000_000_000)] }),
    job('j4', 'vc-a:vm-4', 'app-04', { lastRun: done(301, 'f', NOW - 40 * MIN, null), finishedRuns: [done(301, 'f', NOW - 40 * MIN, null)] }),
    job('j5', 'vc-a:vm-5', 'old-05'),   // ③ 원장 시험 전용(사흘 전 실행 — 오늘 합계에 섞이지 않게)
    // 같은 Director 의 다른 법인(vc-b) 실행 — 흐름은 법인마다(Chromium 확인: Director 단위면 두 법인 합계가 겹쳐 세졌다)
    { ...job('j6', 'vc-b:vm-9', 'pl-09', { pending: { jobid: 601, since: NOW - 10 * MIN, level: 'Incremental', state: 'running', status: 'R' } }), vcenterId: 'vc-b' },
    // 설정에 없는 Director 의 실행 — onDirector 가 던지는 경로(흐름은 모름 null)
    { ...job('j7', 'vc-c:vm-7', 'gone-07', { pending: { jobid: 701, since: NOW - 10 * MIN, state: 'running', status: 'R' } }), vcenterId: 'vc-c', directorId: 'dir_gone' },
    // 데모 잡 — 실제 Director 를 쓰는 동안은 묻지 않는다
    job('j8', 'vc-a:vm-8', 'demo-08', { demo: true, pending: { jobid: 801, since: NOW - MIN, state: 'running', status: 'R' } }),
  ] }));
  REG = await import('../src/bareos/registry.js');
  LIVE = await import('../src/bareos/liveStatus.js');
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { store } = await import('../src/store.js');
  store.snapshot = {
    generatedAt: NOW, source: 'mock',
    vcenters: [{ id: 'vc-a', name: 'Seoul' }, { id: 'vc-b', name: 'Warsaw' }], hosts: [], datastores: [], alarms: [], networks: [],
    vms: [{ id: 'vc-a:vm-1', vcenterId: 'vc-a', name: 'db-01', folder: 'DC / db', storageGB: 622 }, { id: 'vc-a:vm-2', vcenterId: 'vc-a', name: 'db-02', folder: 'DC / db', storageGB: null }],
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api/tools/bareos-backup`;
});
after(async () => { LIVE?._resetLiveForTest(); try { srv?.close(); } catch { /* */ } await fd?.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
const get = async (u, p) => { const r = await fetch(base + p, { headers: { 'x-u': u } }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ } return { s: r.status, j, t }; };

test('③ 원장 lastRate — 끝난 성공(T·W)에 바이트·시각이 다 있을 때만 · 더 새 jobid 만', () => {
  const id = 'j5';
  const T = NOW - 3 * 86_400_000;
  const lr = () => REG.jobDigests().find((j) => j.id === id).lastRate ?? null;
  REG.applyRunRow(id, { jobid: 310, status: 'f', level: 'I', startedAt: T - 20 * MIN, endedAt: T - 10 * MIN, bytes: 5 });
  assert.equal(lr(), null, '실패는 기준이 아니다');
  REG.applyRunRow(id, { jobid: 311, status: 'T', level: 'I', startedAt: T - 20 * MIN, endedAt: T - 10 * MIN, bytes: null });
  assert.equal(lr(), null, '바이트를 모르면 지어내지 않는다');
  REG.applyRunRow(id, { jobid: 312, status: 'W', level: 'F', startedAt: T - 20 * MIN, endedAt: T - 10 * MIN, bytes: 600_000_000 });
  assert.deepEqual(lr(), { jobid: 312, level: 'F', bps: 1_000_000, bytes: 600_000_000, at: T - 10 * MIN });
  REG.applyRunRow(id, { jobid: 305, status: 'T', level: 'I', startedAt: T - 30 * MIN, endedAt: T - 29 * MIN, bytes: 60 });
  assert.equal(lr().jobid, 312, '옛 jobid 가 덮지 않는다');
});

test('④ liveTick — 실행 중 잡이 있는 Director 만 FD 상태를 묻고 · 결과를 잡에 붙인다 · 실패는 속도 모름', async () => {
  D.cmds.length = 0;
  const r = await LIVE.liveTick();
  assert.deepEqual(r.asked.sort(), ['dir_gone', 'dir_kr']);
  assert.equal(LIVE.liveSnapshot('dir_gone', 'vc-c').live.ok, false, 'Director 가 없으면(던짐) 조회 실패');
  assert.equal(LIVE.liveSnapshot('dir_gone', 'vc-c').hist.at(-1).rate, null, '던진 경로도 흐름은 모름(0 아님)');
  const { liveTargets } = LIVE;
  const { effectiveSettings } = await import('../src/bareos/service.js');
  assert.ok(!liveTargets(REG.jobDigests(), effectiveSettings(), false).some((t) => t.jobs.some((x) => x.job.demo)), '데모 잡은 실제 Director 에 묻지 않는다');
  assert.ok(liveTargets(REG.jobDigests(), effectiveSettings(), true).every((t) => t.jobs.every((x) => x.job.demo)), '데모 Director 일 때는 데모 잡만');
  assert.deepEqual(D.cmds.filter((c) => c.startsWith('status')), ['status client=kr-fd'], 'FD 는 하나(잡·법인 FD 가 같다)');
  const snap = LIVE.liveSnapshot('dir_kr', 'vc-a');
  assert.equal(snap.live.ok, true);
  assert.equal(snap.live.jobs.get(501).lastRate, 168_000_000);
  assert.equal(snap.hist.at(-1).rate, 168_000_000 + 800_000, '흐름 = 그 법인의 실행 중 잡의 지금 속도 합');
  assert.equal(LIVE.liveSnapshot('dir_kr', 'vc-b').hist.at(-1).rate, 7_000_000, '같은 Director 의 다른 법인은 따로 센다(겹쳐 세지 않는다)');
  D.failStatus = true;
  try {
    await LIVE.liveTick();
    const s2 = LIVE.liveSnapshot('dir_kr', 'vc-a');
    assert.equal(s2.live.ok, false, 'Director 가 거부한 응답(JSON 오류)을 잡 0개 성공으로 보지 않는다');
    assert.equal(s2.live.code, 'jsonrpc');
    // 실행 중 잡 속도를 하나도 모르면 법인 합계도 모름(null — 0 이 아니다)
    const { corpView } = await import('../src/routes/api/bareosLive.js');
    const { effectiveSettings } = await import('../src/bareos/service.js');
    const st = effectiveSettings();
    const cv = corpView(st.sites[0], st, REG.jobDigests(), { now: Date.now() });
    assert.equal(cv.rateNow, null);
    assert.equal(cv.rateUnknown, cv.running);
    assert.equal(s2.hist.at(-1).rate, null, '조회 실패는 0 이 아니라 모름');
  } finally { D.failStatus = false; }
  await LIVE.liveTick();
});

test('⑤ 라우트 — admin 전용 · 실행·대기·느림·오늘 합계 · 지금 속도 합 · 원문·주소 없음', async () => {
  assert.equal((await get('op', '/live')).s, 403);
  const r = await get('admin', '/live');
  assert.equal(r.s, 200, r.t);
  const c = r.j.corps.find((x) => x.vcenterId === 'vc-a');
  assert.equal(c.vcName, 'Seoul');
  assert.equal(c.running, 2);
  assert.equal(c.waiting, 1);
  assert.equal(c.rateNow, 168_000_000 + 800_000);
  assert.equal(c.slow, 1);
  const r2 = c.rows.find((x) => x.jobid === 502);
  assert.equal(r2.slow, true);
  assert.equal(r2.sizeGb, null, '용량을 모르면 null');
  const r1 = c.rows.find((x) => x.jobid === 501);
  assert.equal(r1.bytes, 412_345_678_912);
  assert.equal(r1.sizeGb, 622);
  assert.equal(r1.slow, undefined);
  const { runningRow } = await import('../src/routes/api/bareosLive.js');
  const jq = { vmId: 'v', vmName: 'q', lastRate: null };
  assert.equal(runningRow(jq, { jobid: 9, state: 'queued' }, { jobid: 9, bytes: 1, lastRate: 2 }, true).state, 'running', 'FD 가 실행 중으로 보고하면 실행 중');
  assert.equal(runningRow(jq, { jobid: 9, state: 'queued' }, null, true).state, 'queued');
  assert.equal(runningRow(jq, { jobid: 9, state: 'queued' }, { jobid: 9 }, false).state, 'queued', '조회 실패면 원장 상태 그대로');
  // 느림 경계 — 지난 평균의 절반 이하 · 5분 뒤부터
  const jb = { vmId: 'v', vmName: 'b', lastRate: { bps: 100 } };
  const run = { jobid: 9, state: 'running', since: Date.now() - 10 * MIN };
  assert.equal(runningRow(jb, run, { jobid: 9, lastRate: 50 }, true).slow, true);
  assert.equal(runningRow(jb, run, { jobid: 9, lastRate: 51 }, true).slow, undefined);
  assert.equal(runningRow(jb, { ...run, since: Date.now() - MIN }, { jobid: 9, lastRate: 1 }, true).slow, undefined, '막 시작한 잡은 판정하지 않는다');
  assert.equal(runningRow({ ...jb, lastRate: null }, run, { jobid: 9, lastRate: 1 }, true).slow, undefined, '기준이 없으면 판정하지 않는다');
  const q = c.rows.find((x) => x.jobid === 503);
  assert.equal(q.state, 'queued');
  assert.equal(q.rateNow, null, 'FD 가 모르는 잡은 속도 모름');
  assert.equal(c.today.ok, 1);
  assert.equal(c.today.fail, 1);
  assert.equal(c.today.bytes, 5_000_000_000);
  assert.equal(r.j.totals.running, 2);
  assert.doesNotMatch(r.t, /127\.0\.0\.1|pw-1|portal/, '주소·비밀번호·콘솔 이름 없음');
  // 범위 계정 — 자기 법인(vc-b)만: vc-a 는 목록에 없다
  const sc = await get('sadm', '/live');
  assert.equal(sc.s, 200);
  assert.equal(sc.j.corps.length, 0);
});

test('⑤ 데모 계정은 사람이 등록한 Director 의 상태 조회를 깨우지 않는다', async () => {
  for (let i = 0; i < 100 && LIVE._liveBusyForTest(); i++) await new Promise((res) => setTimeout(res, 20));   // 앞 시험이 깨운 조회가 끝난 뒤
  LIVE._resetLiveForTest();
  D.cmds.length = 0;
  const r = await get('demo', '/live');
  assert.equal(r.s === 200 || r.s === 403, true);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(D.cmds.filter((c) => c.startsWith('status')).length, 0, '데모 계정 요청으로 실제 Director 에 접속하지 않는다');
  assert.equal(LIVE.liveActive(), false);
});

test('⑥ Command ACL 에 delete(보관 정리) · status(진행 현황) — 서버 자동 설정과 웹 안내 블록이 같은 줄', () => {
  const srvSrc = fs.readFileSync(path.join(HERE, '..', 'src', 'bareos', 'autoSetup.js'), 'utf8');
  const webSrc = fs.readFileSync(path.join(HERE, '..', '..', 'web', 'src', 'views', 'tools', 'bareosText.js'), 'utf8');
  const acl = (s) => /Command ACL = ([^'`]+)/.exec(s)?.[1].trim();
  assert.equal(acl(srvSrc), acl(webSrc));
  for (const c of ['delete', 'status', 'list', 'run']) assert.ok(acl(srvSrc).split(/,\s*/).includes(c), c);
});
