/**
 * test/bareosEdge2824.test.js — v2.824 Bareos 법인 Director **엣지 대행**(계획서 2차 — 사용자 선택 'Director 마다 선택(중앙/엣지 대행)' ·
 * '입력한 SSH·vCenter 비밀번호를 그 작업에만 실어 엣지로 1회 전달').
 *  ① 큐: 콘솔 비밀번호 없음 · 개별 토큰 전용 · 자기 몫만 · 남의 회신 403 · 결과 정제 · 두 번째 회신 stale · secretArgs 는 인출 응답 한 번에만(중앙에서 즉시 지움)
 *  ② 시한: 인출 전 secretArgs 시한(2분) → notSent + 비밀 삭제 · 상태 변경을 가져간 뒤 미회신 → unknown(다시 보내지 않음)
 *  ③ 배정 인출(bareos-config): 공유 토큰 403 · 자기 몫만(비밀번호 포함) · 설정을 못 읽으면 503 → 엣지 사본 유지
 *  ④ 종단(실제 centralRouter + 실제 워커 + 가짜 Director TLS-PSK): 등록·실행이 엣지 사본으로 그 Director 에 간다 · 중앙은 접속하지 않는다
 *  ⑤ 폴러: 엣지 Director 는 틱이 기다리지 않는다 · 진행 중 poll 1개 · 회신이 오면 원장 반영
 *  ⑥ 인증 실패 회신 → 중앙이 그 Director 정지 기록 → 주기 조회는 큐에 넣지 않는다
 *  ⑦ 워커 가드: 사본 없음·담당 다름·시한 지남 → notSent(Director 호출 0)
 *  ⑧ 자동 설정 대행: 사전 점검(SSH 비밀번호는 엣지 실행에만) · 2단계는 중앙이 만든 새 콘솔 비밀번호로 — 엣지 사본·중앙 설정·Director conf 가 같은 값
 */
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareosedge-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.CENTRAL_TOKEN = 'shared-token-for-bareos-edge-test-1234567890';
fs.writeFileSync(path.join(tmp, 'users.json'), JSON.stringify({ users: [{ username: 'adm', role: 'admin' }] }));

const { config } = await import('../src/config.js');
const S = await import('../src/bareos/settings.js');
const R = await import('../src/bareos/registry.js');
const P = await import('../src/bareos/poller.js');
const E = await import('../src/bareos/edgeOps.js');
const ES = await import('../src/bareos/edgeStore.js');
const A = await import('../src/bareos/autoSetup.js');
const svc = await import('../src/bareos/service.js');
const worker = await import('../src/agent/bareosOpWorker.js');
const pull = await import('../src/agent/bareosConfigPull.js');
const tokens = await import('../src/central/agentTokens.js');
const { startFakeDirector } = await import('./_fakeBareosDirector.js');
const { fakeServer, fakeConsole } = await import('./_fakeBareosSsh.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const D = { jobs: new Map(), runs: new Map(), nextId: 7000, cmds: [] };
const handle = async (cmd) => {
  D.cmds.push(cmd);
  const kv = Object.fromEntries([...cmd.matchAll(/(\w+)=("(?:\\.|[^"])*"|\S+)/g)].map((m) => [m[1], m[2]]));
  if (cmd === '.clients') return { clients: [{ name: 'pl-fd' }] };
  if (cmd === '.jobs') return { jobs: [...D.jobs].map(([name, j]) => ({ name, enabled: j.enabled !== false })) };
  if (cmd.startsWith('configure add job')) { D.jobs.set(kv.name, { enabled: true }); return { add: { resource: 'Job', name: kv.name } }; }
  if (cmd.startsWith('run ')) { const id = D.nextId++; D.runs.set(id, { name: kv.job, status: 'R' }); return { run: { jobid: id } }; }
  if (cmd.startsWith('llist jobid=')) { const r = D.runs.get(Number(kv.jobid)); return { jobs: r ? [{ jobid: Number(kv.jobid), name: r.name, type: 'B', level: 'I', jobstatus: r.status, starttime: '2026-10-30 02:00:00', endtime: '2026-10-30 02:10:00', jobbytes: 100, jobfiles: 1 }] : [] }; }
  if (cmd.startsWith('list jobs')) return { jobs: [] };
  if (cmd.startsWith('enable ') || cmd.startsWith('disable ')) { const j = D.jobs.get(kv.job); if (!j) return { error: [`Job "${kv.job}" not found.`] }; j.enabled = cmd.startsWith('enable '); return {}; }
  return { error: [`unknown ${cmd}`] };
};

let fd; let srv; let base; let central; let DE; let tPl; let tKr;
before(async () => {
  fd = await startFakeDirector({ name: 'portal', password: 'pw-edge', handle });
  tPl = tokens.issueAgentToken('PL-Warsaw').token;
  tKr = tokens.issueAgentToken('KR-Seoul').token;
  DE = S.addDirector({ name: '폴란드 법인', host: '127.0.0.1', port: fd.port, consoleName: 'portal', password: 'pw-edge', timeoutMs: 5000, agent: 'PL-Warsaw' }).director.id;
  S.saveSettings({ sites: [{ vcenterId: 'vc-pl', directorId: DE, vcserver: 'vc-pl.corp', client: 'pl-fd', storage: 'File', pool: 'Full', configFile: '/etc/bareos/vmware/vc-pl.ini' }] });
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { centralRouter } = await import('../src/routes/central.js');
  const { store } = await import('../src/store.js');
  store.snapshot = {
    generatedAt: Date.now(), source: 'mock', hosts: [], datastores: [], alarms: [], networks: [],
    vcenters: [{ id: 'vc-pl', name: 'Warsaw', host: 'vc-pl.corp' }],
    vms: [{ id: 'vc-pl:vm-1', vcenterId: 'vc-pl', name: 'db-01', powerState: 'POWERED_ON', snapshotCount: 0, vcDcPath: 'DC-PL', folderPath: '/' }],
  };
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/api/central', centralRouter);
  app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  central = `http://127.0.0.1:${srv.address().port}`;
  base = `${central}/api/tools/bareos-backup`;
});
after(async () => { E._resetForTest(); A._setDepsForTest(); try { srv?.close(); } catch { /* */ } await fd?.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

async function call(method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, j, t };
}
/** 이 프로세스를 잠시 그 엣지로(같은 프로세스 — 중앙 라우트는 CENTRAL_URL 이 없을 때 대행한다). */
async function asEdge(name, token, fn) {
  const keep = { ...config.agent };
  Object.assign(config.agent, { centralUrl: central, centralToken: token, name });
  try { return await fn(); } finally { Object.assign(config.agent, keep); }
}
const waitPending = async (n = 1) => { for (let i = 0; i < 300 && E.pendingView().length < n; i++) await sleep(10); assert.ok(E.pendingView().length >= n, '작업이 큐에 들어왔다'); };

test('① 큐: 콘솔 비밀번호 없음 · 개별 토큰 전용 · 자기 몫만 · 남의 회신 403 · 정제 · stale · secretArgs 는 인출 한 번에만', async () => {
  const dir = S.directorById(DE);
  const p = E.enqueueEdgeOp(dir, 'setup.preflight', { body: { host: '10.0.0.9' } }, { secretArgs: { password: 'ssh-Top-Secret' } });
  let r = await fetch(`${central}/api/central/bareos-ops`, { headers: { 'X-Central-Token': process.env.CENTRAL_TOKEN } });
  assert.equal(r.status, 403); assert.equal((await r.json()).agentTokenRequired, true);
  r = await fetch(`${central}/api/central/bareos-ops`, { headers: { 'X-Central-Token': tKr } });
  assert.deepEqual((await r.json()).ops, [], '남의 몫은 받지 않는다');
  r = await fetch(`${central}/api/central/bareos-ops?agent=PL-Warsaw`, { headers: { 'X-Central-Token': tKr } });
  assert.equal(r.status, 403, '?agent= 로 남의 몫을 고를 수 없다');
  assert.ok(!JSON.stringify(E.pendingView()).includes('ssh-Top-Secret'), '대기 목록에 비밀 없음');
  r = await fetch(`${central}/api/central/bareos-ops`, { headers: { 'X-Central-Token': tPl } });
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const ops = (await r.json()).ops;
  assert.equal(ops.length, 1); assert.equal(ops[0].directorId, DE);
  assert.equal(ops[0].secretArgs.password, 'ssh-Top-Secret', '비밀은 인출 응답에만');
  assert.ok(!JSON.stringify(ops).includes('pw-edge'), '콘솔 비밀번호는 싣지 않는다');
  assert.ok(ops[0].ttlMs > 0 && ops[0].ttlMs < E.RESULT_MS['setup.preflight']);
  assert.ok(E._peekForTest().every((o) => o.secretArgs === null), '인출 뒤 중앙 메모리에서 지웠다');
  r = await fetch(`${central}/api/central/bareos-ops`, { headers: { 'X-Central-Token': tPl } });
  assert.deepEqual((await r.json()).ops, [], '두 번 받지 않는다');
  const post = (tok, body) => fetch(`${central}/api/central/bareos-op-result`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': tok }, body: JSON.stringify(body) });
  assert.equal((await post(tKr, { id: ops[0].id, result: { ok: true, value: {} } })).status, 403, '남의 회신 거부');
  r = await post(tPl, { id: ops[0].id, result: { ok: true, password: 'leak', value: { host: 'h', items: [{ key: 'root', label: 'root', status: 'weird', detail: 'x', extra: 1 }], junk: 1 } } });
  assert.equal(r.status, 200);
  const res = await p;
  assert.equal(res.ok, true); assert.equal(res.password, undefined); assert.equal(res.value.junk, undefined);
  assert.deepEqual(res.value.items, [{ key: 'root', label: 'root', status: 'unknown', detail: 'x', hint: '' }], '모르는 상태는 확인 불가 · 모르는 필드 버림');
  assert.equal((await (await post(tPl, { id: ops[0].id, result: { ok: true } })).json()).stale, true);
  assert.equal((await E.enqueueEdgeOp(dir, 'runJob', {}, { secretArgs: { x: 'y' } })).ok, false, '비밀 인자는 자동 설정에만');
});

test('② 시한: 인출 전 secretArgs 시한 → notSent·비밀 삭제 · 상태 변경을 가져간 뒤 미회신 → unknown', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const dir = S.directorById(DE);
    const p1 = E.enqueueEdgeOp(dir, 'setup.fdIni', { body: {} }, { secretArgs: { password: 'p', vcpass: 'v' } });
    mock.timers.tick(E.SECRET_TTL_MS + 1);
    const r1 = await p1;
    assert.equal(r1.notSent, true); assert.equal(r1.code, 'not-sent');
    assert.equal(E._peekForTest().length, 0, '작업째 지웠다(비밀 포함)');
    const p2 = E.enqueueEdgeOp(dir, 'runJob', { job: 'x', level: 'Full' });
    assert.equal(E.takeEdgeOps('PL-Warsaw').length, 1);
    mock.timers.tick(E.RESULT_MS.runJob + 1);
    const r2 = await p2;
    assert.equal(r2.unknown, true, '가져간 상태 변경의 미회신은 결과 모름');
    assert.ok(E.RESULT_MS['setup.director'] > A.BUDGET.sessionMs + E.MARGIN_MS, '자동 설정 회신 시한 > SSH 세션 예산 + 여유(엣지가 끝까지 할 수 있게)');
  } finally { mock.timers.reset(); E._resetForTest(); }
});

test('③ 배정 인출: 공유 토큰 403 · 자기 몫만(비밀번호 포함) · 엣지 사본 반영 · 설정을 못 읽으면 503 → 사본 유지', async () => {
  let r = await fetch(`${central}/api/central/bareos-config`, { headers: { 'X-Central-Token': process.env.CENTRAL_TOKEN } });
  assert.equal(r.status, 403);
  r = await fetch(`${central}/api/central/bareos-config`, { headers: { 'X-Central-Token': tKr } });
  assert.deepEqual((await r.json()).directors, []);
  const pr = await asEdge('PL-Warsaw', tPl, () => pull.pullBareosConfigNow());
  assert.equal(pr.ok, true, JSON.stringify(pr));
  assert.equal(ES.edgeDirectorById(DE)?.password, 'pw-edge', '엣지 사본에 콘솔 비밀번호');
  const raw = fs.readFileSync(path.join(tmp, 'bareos-edge-directors.json'), 'utf8');
  assert.ok(raw.includes(DE));
  // 중앙 설정 손상 → 503 → 엣지는 사본을 지우지 않는다
  const file = path.join(tmp, 'bareos.json');
  const keep = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, '{ broken');
  S._resetForTest();
  try {
    r = await fetch(`${central}/api/central/bareos-config`, { headers: { 'X-Central-Token': tPl } });
    assert.equal(r.status, 503);
    pull._resetForTest();
    const pr2 = await asEdge('PL-Warsaw', tPl, () => pull.pullBareosConfigNow());
    assert.equal(pr2.ok, false);
    assert.equal(ES.edgeDirectorById(DE)?.password, 'pw-edge', '사본 유지');
  } finally {
    fs.writeFileSync(file, keep); S._resetForTest();
    for (const f of fs.readdirSync(tmp)) if (f.startsWith('bareos.json.corrupt')) fs.rmSync(path.join(tmp, f));
  }
});

test('④·⑤ 종단: 등록·실행은 엣지 사본으로 그 Director 에 · 폴러는 기다리지 않고 회신 때 반영', async () => {
  const before = D.cmds.length;
  const add = call('POST', '/jobs', { vcenterId: 'vc-pl', vmId: 'vc-pl:vm-1' });
  await waitPending();
  await asEdge('PL-Warsaw', tPl, () => worker.runBareosOpWorkerOnce());
  const a = await add;
  assert.equal(a.s, 201, a.t);
  assert.equal(a.j.job.directorId, DE);
  assert.ok(D.cmds.slice(before).some((c) => c.startsWith('configure add job')), '엣지가 Director 에 잡을 만들었다');
  const run = call('POST', `/jobs/${a.j.job.id}/run`, {});
  await waitPending();
  await asEdge('PL-Warsaw', tPl, () => worker.runBareosOpWorkerOnce());
  const rr = await run;
  assert.equal(rr.s, 202, rr.t);
  assert.ok(rr.j.jobid >= 7000);
  // 폴러: 실행이 끝났다 — 틱은 회신을 기다리지 않는다
  for (const x of D.runs.values()) x.status = 'T';
  P._resetPollerForTest();
  const t0 = Date.now();
  const st = await P.pollOnce({ trigger: 'manual' });
  assert.ok(Date.now() - t0 < 2000, '틱이 엣지 회신을 기다리지 않았다');
  assert.equal(st.directors[DE].relay, 'sent');
  assert.equal((await P.pollOnce({ trigger: 'manual' })).directors[DE].relay, 'pending', '진행 중 poll 은 하나');
  assert.equal(E.pendingView().filter((o) => o.kind === 'poll').length, 1);
  await asEdge('PL-Warsaw', tPl, () => worker.runBareosOpWorkerOnce());
  for (let i = 0; i < 100 && R.getJob(a.j.job.id)?.pending; i++) await sleep(10);
  assert.equal(R.getJob(a.j.job.id).pending, null, '회신이 오면 원장에 반영');
  assert.equal(R.getJob(a.j.job.id).lastRun?.state, 'ok');
  assert.equal(P.pollerStatus().directors[DE].relay, 'done');
});

test('⑥ 인증 실패 회신 → 중앙이 정지 기록 → 주기 조회는 큐에 넣지 않는다', async () => {
  S.updateDirector(DE, { password: 'wrong-pw' });
  pull._resetForTest();
  await asEdge('PL-Warsaw', tPl, () => pull.pullBareosConfigNow());
  const t = call('POST', `/settings/directors/${DE}/test`, {});
  await waitPending();
  await asEdge('PL-Warsaw', tPl, () => worker.runBareosOpWorkerOnce());
  const r = await t;
  assert.equal(r.s, 502, r.t);
  const cred = S.directorCred(S.directorById(DE));
  assert.ok(svc.bareosAuthGuard.peekAuthStop(cred), '엣지 회신의 인증 실패를 중앙이 기록');
  await assert.rejects(svc.relayToEdge(S.directorById(DE), 'poll', {}, { trigger: 'timer' }), (e) => e.code === 'auth-stopped');
  assert.equal(E.pendingView().length, 0, '정지면 큐에 넣지 않는다');
  S.updateDirector(DE, { password: 'pw-edge' });
  pull._resetForTest();
  await asEdge('PL-Warsaw', tPl, () => pull.pullBareosConfigNow());
  svc.bareosAuthGuard.clearAuthStop(cred.id);
});

test('⑦ 워커 가드: 사본 없음·담당 다름·시한 지남 → notSent(Director 호출 0)', async () => {
  const n = D.cmds.length;
  const op = { id: 'x1', kind: 'probe', directorId: DE, args: {}, ttlMs: 60_000 };
  await asEdge('PL-Warsaw', tPl, async () => {
    assert.equal((await worker.runBareosEdgeOp(op, { getDirector: () => null })).notSent, true);
    assert.equal((await worker.runBareosEdgeOp(op, { getDirector: () => ({ ...ES.edgeDirectorById(DE), agent: 'OTHER' }) })).notSent, true);
    assert.equal((await worker.runBareosEdgeOp({ ...op, ttlMs: 1 }, { receivedAt: Date.now() - 10_000 })).notSent, true);
    assert.equal((await worker.runBareosEdgeOp({ ...op, kind: 'rm-rf' })).notSent, true);
  });
  assert.equal(D.cmds.length, n, 'Director 에 아무것도 보내지 않았다');
});

test('⑧ 자동 설정 대행: 사전 점검(SSH 비밀번호는 엣지 실행에만) · 2단계 새 콘솔 비밀번호 = 중앙 생성값(엣지 사본·중앙 설정·conf 같은 값)', async () => {
  const srvSsh = fakeServer();
  const con = fakeConsole();
  A._setDepsForTest({ ssh: srvSsh.ssh, openConsole: con.open, sleep: async () => {} });
  const pf = call('POST', `/settings/directors/${DE}/auto-setup/preflight`, { host: '10.20.30.40', password: 'ssh-Pre-Secret' });
  await waitPending();
  assert.ok(!JSON.stringify(E.pendingView()).includes('ssh-Pre-Secret'));
  await asEdge('PL-Warsaw', tPl, () => worker.runBareosOpWorkerOnce());
  const r1 = await pf;
  assert.equal(r1.s, 200, r1.t);
  assert.equal(r1.j.relay, 'PL-Warsaw');
  assert.equal(srvSsh.st.creds.password, 'ssh-Pre-Secret', '엣지가 그 비밀번호로 SSH');
  assert.ok(Array.isArray(r1.j.items) && r1.j.items.length > 3);
  assert.ok(!r1.t.includes('ssh-Pre-Secret'));
  // 2단계 — 중앙이 콘솔 비밀번호를 만들어 보낸다
  const body = { host: '10.20.30.40', username: 'root', password: 'ssh-Dir-Secret', restoreClient: 'pl-fd', restoreStorage: 'File', restorePool: 'Full' };
  const dr = call('POST', `/settings/directors/${DE}/auto-setup/director`, body);
  await waitPending();
  await asEdge('PL-Warsaw', tPl, () => worker.runBareosOpWorkerOnce());
  const r2 = await dr;
  assert.equal(r2.s, 200, r2.t);
  const confPw = /Password = "([^"]+)"/.exec(srvSsh.F.get('/etc/bareos/bareos-dir.d/console/portal.conf')?.content || '')?.[1];
  assert.match(confPw, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(S.directorById(DE).password, confPw, '중앙 설정 = Director conf 의 새 콘솔 비밀번호');
  assert.equal(ES.edgeDirectorById(DE).password, confPw, '엣지 사본도 바로 그 값(다음 인출 전 작업이 옛 비밀번호로 실패하지 않게)');
  assert.equal(S.directorById(DE).host, '10.20.30.40');
  assert.ok(!r2.t.includes(confPw) && !r2.t.includes('ssh-Dir-Secret'), '응답에 비밀 없음');
  assert.equal(con.seen.at(-1).password, confPw, '엣지가 새 콘솔로 접속 확인');
});

test('담당 엣지는 중앙이 아는 엣지만(pickAgent) · 엣지 대행 Director 의 새 비밀번호 시험은 저장 뒤', async () => {
  let r = await call('POST', '/settings/directors', { name: '없는 엣지 법인', host: 'x.corp', agent: 'NOPE-Edge' });
  assert.equal(r.s, 400); assert.equal(r.j.field, 'agent');
  r = await call('POST', '/settings/directors', { name: '한국 법인', host: 'kr.corp', agent: 'kr-seoul' });
  assert.equal(r.s, 201, r.t); assert.equal(r.j.director.agent, 'KR-Seoul', '목록 표기로');
  r = await call('POST', `/settings/directors/${DE}/test`, { password: 'new-one' });
  assert.equal(r.s, 400);
  const g = await call('GET', '/settings');
  assert.ok(g.j.agents.includes('PL-Warsaw'));
});
