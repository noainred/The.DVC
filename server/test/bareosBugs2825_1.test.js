/**
 * test/bareosBugs2825_1.test.js — v2.825.1 Bareos 전체 버그 점검(사용자 요청 '버그 찾아서 수정' · 5축 + 반증 1인) 확정분 회귀.
 *  G1  연결 시험 성공이 '시험하는 사이 바뀐 접속값' 의 인증 정지를 지우지 않는다(엣지 대행·중앙 직접 — clearAuthStopIfSame)
 *  G2  복원: 설정만 보면 아는 전제(Director 접속값 덜 됨)는 OTP 앞에서 — 1회용 코드를 태우지 않는다
 *  G3  엣지 addJobs 성공인데 잡 이름이 없으면 결과 모름(원장에 'undefined' 를 적지 않는다)
 *  G4  데모 합성 이력 jobid 가 이름끼리 겹치지 않는다
 *  G5  엣지 poll 회신의 recent 는 상한을 넘으면 최신을 남긴다
 *  G6  취소 라우트의 '이미 끝난 행' 은 백업 행(type B)만 반영한다
 *  G7  상태 조회는 대조를 먼저 한다(끝나지 않은 실행이 예산보다 많아도 .jobs·다시 끄기가 돈다)
 *  G12 목록 응답의 대상별 writable·settingsWritable(쓰기 범위 계정 — 화면이 버튼을 잠근다)
 *  G8  엣지 자동 설정은 같은 Director·서버에 한 번에 하나(되돌리기까지)
 *  G15 재시작하면 결과를 잃는 Bareos 작업 목록(업그레이드 자동 적용 대기)
 *  G17 폴러 상태의 running 은 '지금 조회 중'
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareosbugs28251-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.CENTRAL_TOKEN = 'shared-token-for-bareos-bugs-28251-1234567890';
const { generateSecret, generateToken } = await import('../src/auth/totp.js');
const SECRET = generateSecret();
fs.writeFileSync(path.join(tmp, 'users.json'), JSON.stringify({ users: [{ username: 'adm', role: 'admin', totpEnabled: true, totpSecret: SECRET }] }));

const S = await import('../src/bareos/settings.js');
const R = await import('../src/bareos/registry.js');
const P = await import('../src/bareos/poller.js');
const E = await import('../src/bareos/edgeOps.js');
const ER = await import('../src/bareos/edgeResult.js');
const EStp = await import('../src/bareos/edgeSetup.js');
const A = await import('../src/bareos/autoSetup.js');
const IF = await import('../src/bareos/inflight.js');
const { OPS } = await import('../src/bareos/ops.js');
const svc = await import('../src/bareos/service.js');
const demo = await import('../src/mock/demo/bareos.js');
const { demoHash } = await import('../src/mock/demo/flags.js');
const tokens = await import('../src/central/agentTokens.js');
const { startFakeDirector } = await import('./_fakeBareosDirector.js');
const { fakeServer, fakeConsole } = await import('./_fakeBareosSsh.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 기다림에 상한 — 닿지 않으면 파일 시한(120초)까지 멈추지 않고 이 사유로 바로 실패한다. */
const within = (p, ms, why) => {
  let t;
  const limit = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${why}(${ms}ms 안에 일어나지 않음)`)), ms); });
  return Promise.race([p, limit]).finally(() => clearTimeout(t));   // 시한 타이머를 남기지 않는다(파일이 늦게 끝나지 않게)
};
let gate = null; let gateHit = null; let gateAny = false;
let asUser = null;   // G12 — 쓰기 범위 계정으로 바꿔 부른다
const D = { rows: new Map() };
const handle = async (cmd) => {
  if (gateAny && gate) { gateHit?.(); await gate; }
  if (cmd === '.clients') { if (gate) { gateHit?.(); await gate; } return { clients: [{ name: 'fd' }] }; }
  const m = /^llist jobid=(\d+)$/.exec(cmd);
  if (m) { const r = D.rows.get(Number(m[1])); return { jobs: r ? [r] : [] }; }
  return { error: [`unknown ${cmd}`] };
};
let fd; let fd2; let srv; let base; let DE; let DD; let DR; let jobR;
before(async () => {
  fd = await startFakeDirector({ name: 'portal', password: 'pw-ok', handle });
  fd2 = await startFakeDirector({ name: 'portal', password: 'pw-ok', handle });   // DR — 같은 주소·콘솔은 다른 Director 와 겹치므로 포트를 달리한다
  tokens.issueAgentToken('PL-Warsaw');
  DE = S.addDirector({ name: '폴란드(엣지)', host: '127.0.0.1', port: 9101,   // 엣지 대행 — 중앙은 접속하지 않는다
    consoleName: 'portal', password: 'pw-ok', timeoutMs: 5000, agent: 'PL-Warsaw' }).director.id;
  // localhost 대신 127.0.0.1 — 가짜 Director 는 127.0.0.1 에서만 듣는다. CI(GitHub 러너)는 /etc/hosts 에 ::1 localhost 가 있어
  // 접속이 닿지 않으면 게이트를 영영 기다린다(추정 원인 — CI 에서 이 파일이 120초 시한에 걸렸다 · 기다림은 이제 within() 으로 상한)
  DD = S.addDirector({ name: '한국(직접)', host: '127.0.0.1', port: fd.port, consoleName: 'portal', password: 'pw-ok', timeoutMs: 15_000 }).director.id;
  DR = S.addDirector({ name: '미국(복원 시험)', host: '127.0.0.1', port: fd2.port, consoleName: 'portal', password: 'pw-ok', timeoutMs: 15_000 }).director.id;
  S.saveSettings({ sites: [
    { vcenterId: 'vc-pl', directorId: DE, vcserver: 'vc-pl.corp', client: 'pl-fd', storage: 'File', pool: 'Full', configFile: '/etc/bareos/vmware/vc-pl.ini' },
    { vcenterId: 'vc-us', directorId: DR, vcserver: 'vc-us.corp', client: 'us-fd', storage: 'File', pool: 'Full', configFile: '/etc/bareos/vmware/vc-us.ini' },
  ] });
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { store } = await import('../src/store.js');
  store.snapshot = {
    generatedAt: Date.now(), source: 'mock', hosts: [], datastores: [], alarms: [], networks: [],
    vcenters: [{ id: 'vc-pl', name: 'Warsaw', host: 'vc-pl.corp' }, { id: 'vc-us', name: 'Virginia', host: 'vc-us.corp' }],
    vms: [
      { id: 'vc-pl:vm-1', vcenterId: 'vc-pl', name: 'db-01', powerState: 'POWERED_ON', snapshotCount: 0, vcDcPath: 'DC-PL', folderPath: '/' },
      { id: 'vc-us:vm-1', vcenterId: 'vc-us', name: 'web-01', powerState: 'POWERED_OFF', snapshotCount: 0, vcDcPath: 'DC-US', folderPath: '/web' },
    ],
  };
  jobR = R.addJob({ vcenterId: 'vc-us', vmId: 'vc-us:vm-1', vmName: 'web-01', directorId: DR, bareosJob: 'pv-aaaa-vm-1', client: 'us-fd', storage: 'File', pool: 'Full', dc: 'DC-US', folder: '/web', createdBy: 't' }).id;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = asUser || { username: 'adm', role: 'admin', scope: null }; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api/tools/bareos-backup`;
});
after(async () => { E._resetForTest(); A._setDepsForTest(); try { srv?.close(); } catch { /* */ } await fd?.close(); await fd2?.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const post = (p, body = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => { const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ } return { s: r.status, j, t }; });

test('G1 연결 시험(엣지 대행): 옛 접속값의 성공 회신이 새 접속값의 인증 정지를 지우지 않는다', async () => {
  const t = post(`/settings/directors/${DE}/test`, {});
  for (let i = 0; i < 300 && !E.pendingView().length; i++) await sleep(10);
  const [op] = E.takeEdgeOps('PL-Warsaw');
  assert.equal(op.kind, 'probe');
  S.updateDirector(DE, { password: 'pw-new-wrong' });
  const now = S.directorCred(S.directorById(DE));
  svc.bareosAuthGuard.markAuthStopped(now.id, now, '새 접속값으로 인증 실패(폴러)');
  E.completeEdgeOp(op.id, 'PL-Warsaw', { ok: true, value: { director: 'bareos-dir', version: '24', clients: [] } });
  const r = await t;
  assert.equal(r.s, 200, r.t);
  assert.ok(svc.bareosAuthGuard.authStopFor(now), '새(틀린) 접속값의 정지는 남는다');
  svc.bareosAuthGuard.clearAuthStop(now.id);
  S.updateDirector(DE, { password: 'pw-ok' });
});

test('G1 연결 시험(중앙 직접): 시험 중 바뀐 접속값의 정지를 지우지 않는다 · 그대로면 지운다', async () => {
  let release; gate = new Promise((res) => { release = res; }); const hit = new Promise((res) => { gateHit = res; });
  const t = post(`/settings/directors/${DD}/test`, {});
  try { await within(hit, 20_000, '연결 시험이 가짜 Director 의 .clients 에 닿지 않았다'); } catch (e) {
    release(); gate = null;
    const r = await t.catch((x) => ({ s: 0, t: String(x) }));
    throw new Error(`${e.message} — 시험 응답 ${r.s}: ${String(r.t).slice(0, 300)}`);   // CI 에서 왜 닿지 않았는지 남긴다
  }
  S.updateDirector(DD, { password: 'pw-new-wrong' });
  const now = S.directorCred(S.directorById(DD));
  svc.bareosAuthGuard.markAuthStopped(now.id, now, '새 접속값으로 인증 실패(폴러)');
  release(); gate = null;
  const r = await t;
  assert.equal(r.s, 200, r.t);
  assert.ok(svc.bareosAuthGuard.authStopFor(now), '바뀐 접속값의 정지는 남는다');
  // 접속값이 그대로인 시험 성공은 정지를 푼다(예전 동작 유지)
  S.updateDirector(DD, { password: 'pw-ok' });
  const same = S.directorCred(S.directorById(DD));
  svc.bareosAuthGuard.markAuthStopped(same.id, same, '시험');
  assert.equal((await post(`/settings/directors/${DD}/test`, {})).s, 200);
  assert.equal(svc.bareosAuthGuard.authStopFor(same), null, '같은 접속값의 성공은 정지를 푼다');
});

test('G2 복원: Director 접속값이 덜 됐으면 OTP 를 쓰기 전에 409 — 같은 코드를 고친 뒤 쓸 수 있다', async () => {
  S.updateDirector(DR, { host: 'localhost' });   // 주소를 바꾸면 저장 비밀번호 폐기(accessMoved)
  const otp = generateToken(SECRET);
  const r1 = await post(`/jobs/${jobR}/restore`, { jobid: 130, mode: 'localVmdk', otp });
  assert.equal(r1.s, 409, r1.t); assert.equal(r1.j.code, 'not-configured');
  S.updateDirector(DR, { host: '127.0.0.1', password: 'pw-ok' });
  const r2 = await post(`/jobs/${jobR}/restore`, { jobid: 130, mode: 'localVmdk', otp });
  assert.notEqual(r2.s, 403, `같은 OTP 가 아직 쓸 수 있어야 한다(전제 실패가 태우지 않았다): ${r2.t}`);
});

test('G3 엣지 addJobs: 성공인데 잡 이름이 없으면 결과 모름 — 원장에 쓰지 않는다', async () => {
  const v = ER.sanitizeEdgeResult('addJobs', { ok: true, value: [{ key: 0, ok: true }, { key: 1, ok: true, name: 'bad name;rm' }, { key: 2, ok: true, name: 'pv-ok-vm-2' }] }).value;
  assert.equal(v[0].ok, false); assert.equal(v[0].code, 'unknown');
  assert.equal(v[1].ok, false); assert.equal(v[1].code, 'unknown');
  assert.deepEqual(v[2], { key: 2, ok: true, name: 'pv-ok-vm-2' });
  const p = svc.createBackupTarget({ vcenterId: 'vc-pl', vmId: 'vc-pl:vm-1', by: 'adm' });
  for (let i = 0; i < 300 && !E.pendingView().length; i++) await sleep(10);
  const [op] = E.takeEdgeOps('PL-Warsaw');
  assert.equal(op.kind, 'addJobs');
  E.completeEdgeOp(op.id, 'PL-Warsaw', { ok: true, value: [{ key: 0, ok: true }] });
  // v2.847 E2-1: 결과 모름이면 중앙이 `.jobs` 를 한 번 더 묻는다(잡이 생겼으면 원장 밖 잡을 끈다) — 그 조회가 오지 않으면 결과 모름 그대로
  for (let i = 0; i < 300 && !E.pendingView().length; i++) await sleep(10);
  const [names] = E.takeEdgeOps('PL-Warsaw');
  assert.equal(names?.kind, 'jobNames');
  E.completeEdgeOp(names.id, 'PL-Warsaw', { ok: false, code: 'connect', reason: 'down' });
  await assert.rejects(p, (e) => e.code === 'unknown');
  assert.equal(R.findByVm('vc-pl', 'vc-pl:vm-1'), null, '원장에 bareosJob undefined 를 적지 않았다');
});

test('G4 데모 합성 이력: 해시 칸이 겹치는 두 이름도 서로의 jobid 를 쓰지 않는다', () => {
  const seen = new Map(); let a = ''; let b = '';
  for (let i = 1; i < 200_000 && !b; i++) { const n = `pv-1a2b3c4d-vm-${i}`; const k = demoHash(n) % 4000; if (seen.has(k)) { a = seen.get(k); b = n; } else seen.set(k, n); }
  assert.ok(b, '충돌 이름 쌍');
  demo._resetBareosDemoForTest();
  const st = { sites: [] };
  for (const n of [a, b]) demo.demoCall(`configure add job name=${n} jobdefs=x client=c storage=s pool=p level=Incremental fdpluginoptions="\\"python3:x=y\\""`, st);
  const ids = (n) => new Set(demo.demoCall(`list jobs job=${n}`, st).jobs.map((r) => r.jobid));
  const ia = ids(a); const ib = ids(b);
  assert.ok(ia.size > 0 && ib.size > 0);
  for (const j of ib) {
    assert.ok(!ia.has(j), `jobid ${j} 가 두 이름에 겹친다`);
    assert.equal(demo.demoCall(`llist jobid=${j}`, st).jobs[0].name, b, `jobid ${j} 는 ${b} 의 행`);
  }
  demo._resetBareosDemoForTest();
});

test('G5 엣지 poll 회신: recent 가 상한을 넘으면 최신 행을 남긴다', () => {
  const recent = Array.from({ length: 6000 }, (_, i) => ({ jobid: i + 1, name: 'j', type: 'B', status: 'T' }));
  const v = ER.sanitizeEdgeResult('poll', { ok: true, value: { rows: [], attempted: 0, recent, redisabled: [] } }).value;
  assert.equal(v.recent.length, 5000);
  assert.ok(v.recent.some((r) => r.jobid === 6000), '가장 최근(가장 큰 jobid) 행이 남는다');
  assert.ok(!v.recent.some((r) => r.jobid === 1), '오래된 행부터 버린다');
});

test('G6 취소: 이미 끝난 행이 백업 실행이 아니면(Copy 등) 원장에 반영하지 않는다', async () => {
  S.updateDirector(DR, { host: '127.0.0.1', password: 'pw-ok' });
  D.rows.set(4242, { jobid: 4242, job: 'pv-aaaa-vm-1.2026', name: 'pv-aaaa-vm-1', type: 'C', level: 'F', jobstatus: 'T', starttime: '2026-10-30 01:00:00', endtime: '2026-10-30 01:10:00', jobbytes: 1, jobfiles: 1, joberrors: 0 });
  const before = R.getJob(jobR).lastRun || null;
  const r = await post(`/jobs/${jobR}/cancel`, { jobid: 4242 });
  assert.equal(r.s, 400, r.t); assert.equal(r.j.code, 'finished');
  assert.deepEqual(R.getJob(jobR).lastRun || null, before, 'Copy 행을 lastRun 에 넣지 않았다');
  D.rows.set(4243, { ...D.rows.get(4242), jobid: 4243, type: 'B' });
  const r2 = await post(`/jobs/${jobR}/cancel`, { jobid: 4243 });
  assert.equal(r2.s, 400); assert.equal(R.getJob(jobR).lastRun?.jobid, 4243, '백업 행은 반영');
});

test('G12 목록 응답: 쓰기 범위 밖 대상은 writable:false · 쓰기 범위 계정은 settingsWritable:false', async () => {
  const get = () => fetch(base).then((r) => r.json());
  const full = await get();
  assert.equal(full.settingsWritable, true);
  assert.equal(full.jobs.find((j) => j.id === jobR)?.writable, true);
  asUser = { username: 'w', role: 'admin', scope: { vcenters: [], writeVcenters: ['vc-pl'] } };
  try {
    const w = await get();
    assert.equal(w.settingsWritable, false, '전 법인 공용 설정은 쓰기 범위 계정이 바꿀 수 없다(fullWriteOnly 와 같은 판정)');
    assert.equal(w.jobs.find((j) => j.id === jobR)?.writable, false, 'vc-us 는 쓰기 범위 밖');
    const put = await fetch(`${base}/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(put.status, 403, '서버 게이트가 기준이다');
  } finally { asUser = null; }
});

test('G7 상태 조회: 대조를 먼저 — 끝나지 않은 실행을 다 읽지 못해도 .jobs·다시 끄기가 돈다', async () => {
  const calls = [];
  const ac = new AbortController();
  const s = {
    async call(cmd) {
      calls.push(cmd);
      if (cmd.startsWith('.jobs')) return { jobs: [{ name: 'pv-off', enabled: true }, { name: 'pv-on', enabled: true }] };
      if (cmd.startsWith('list jobs days=')) return { jobs: [] };
      if (cmd.startsWith('disable job=')) return {};
      if (cmd.startsWith('llist jobid=')) { if (calls.filter((c) => c.startsWith('llist')).length >= 2) ac.abort(); return { jobs: [] }; }
      return {};
    },
  };
  const work = Array.from({ length: 50 }, (_, i) => ({ jobid: 1000 + i }));
  const r = await OPS.poll(s, { work, reconcile: true, disableIfEnabled: ['pv-off'] }, { signal: ac.signal });
  assert.equal(r.reconciled, true, '대조를 했다');
  assert.deepEqual(r.redisabled, ['pv-off'], '다시 끄기를 했다');
  assert.ok(r.attempted < work.length, 'work 는 시한에 잘렸다');
  assert.equal(r.cut, false, '대조가 끝났으니 다음 틱에 대조를 다시 걸지 않는다');
  assert.ok(calls.indexOf('.jobs') < calls.findIndex((c) => c.startsWith('llist')), '.jobs 가 llist 보다 먼저');
});

test('G8 엣지 자동 설정: 같은 Director·서버는 한 번에 하나(앞 작업·되돌리기가 끝날 때까지 conflict)', async () => {
  const srvSsh = fakeServer();
  let releaseSsh; const held = new Promise((r) => { releaseSsh = r; });
  A._setDepsForTest({ ssh: async (creds, fn, opts) => { await held; return srvSsh.ssh(creds, fn, opts); }, openConsole: fakeConsole().open, sleep: async () => {} });
  try {
    const dir = { ...S.directorById(DE), edgeCopy: true };
    // 잠금이 없으면 두 번째 호출도 같은 SSH 를 기다린다 — 시간 안에 끝나지 않으면 'still-running' 으로 보고 실패시킨다(멈추지 않게)
    const settle = (p) => Promise.race([p.then(() => null, (e) => e), sleep(1500).then(() => ({ code: 'still-running' }))]);
    const first = EStp.runSetupOp('setup.preflight', dir, { body: { host: '10.20.30.40' } }, { password: 'x' }).catch((e) => e);
    await sleep(20);
    assert.equal((await settle(EStp.runSetupOp('setup.preflight', dir, { body: { host: '10.20.30.40' } }, { password: 'x' })))?.code, 'conflict');
    const other = { ...S.directorById(DD), edgeCopy: true };
    assert.equal((await settle(EStp.runSetupOp('setup.preflight', other, { body: { host: '10.20.30.40' } }, { password: 'x' })))?.code, 'conflict', '같은 서버면 다른 Director 도');
    releaseSsh();
    await first;
    srvSsh.st.uid = '0';
    const again = await EStp.runSetupOp('setup.preflight', dir, { body: { host: '10.20.30.40' } }, { password: 'x' }).catch((e) => e);
    assert.notEqual(again?.code, 'conflict', '앞 작업이 끝나면 다시 할 수 있다');
  } finally { releaseSsh(); A._setDepsForTest(); }
});

test('G15 재시작하면 결과를 잃는 작업 목록: 엣지 대행 상태 변경·자동 설정은 넣고 상태 조회는 넣지 않는다', () => {
  E._resetForTest(); IF._resetInflightForTest();
  const dir = { id: DE, agent: 'PL-Warsaw' };
  E.enqueueEdgeOp(dir, 'poll', {});
  assert.equal(IF.runningBareosWork().length, 0, 'poll 은 다음 주기에 다시 한다');
  E.enqueueEdgeOp(dir, 'addJobs', { items: [] });
  IF.noteSetupStart(DD, '한국');
  const w = IF.runningBareosWork();
  assert.equal(w.length, 2);
  assert.ok(w.every((x) => x.kind === 'bareos' && x.resumable === false));
  IF.noteSetupEnd(DD);
  assert.equal(IF.runningBareosWork().length, 1);
  E._resetForTest();
  const src = fs.readFileSync(new URL('../src/upgrade/manager.js', import.meta.url), 'utf8');
  assert.match(src, /\.\.\.bareosWork\(\)\]/, '업그레이드 자동 적용 대기 목록에 들어 있다');
});

test('G17 폴러 상태: running 은 지금 조회 중일 때만(타이머 유무는 started)', async () => {
  P._resetPollerForTest();
  let release; gate = new Promise((r) => { release = r; }); const hit = new Promise((r) => { gateHit = r; }); gateAny = true;
  const p = P.pollOnce({ trigger: 'manual', directorId: DR });
  await within(hit, 20_000, '상태 조회가 가짜 Director 에 닿지 않았다').catch(() => {});   // 닿지 않으면 아래 단언(mid.running)이 실패를 말한다
  const mid = P.pollerStatus();
  release(); gate = null; gateAny = false;
  await p;
  assert.equal(mid.running, true, '조회 중에는 running');
  assert.equal(mid.started, false, '주기 타이머는 시작하지 않았다');
  assert.equal(P.pollerStatus().running, false, '끝나면 running 이 아니다');
});
