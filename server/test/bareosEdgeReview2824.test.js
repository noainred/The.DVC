/**
 * test/bareosEdgeReview2824.test.js — v2.824 Bareos 법인 엣지 대행 **검토 확정분**(5축 + 반증) 회귀.
 *  R1 S1·C1  일괄 등록 결과 key 가 정제에서 글자('')가 돼 원장 0 → 숫자 key 보존(실제 centralRouter + 워커 + 가짜 Director 종단)
 *  R2 S2·C9  catalog errors 는 자기 키만 · runJob/restore 의 필수 값이 없으면 '성공' 이 아니라 결과 모름
 *  R3 I1·C3  저장 직후 엣지 사본이 옛 접속값 → 작업 connSig 로 배정을 즉시 다시 받는다 · 회신 사이 중앙 값이 바뀌면 정지를 걸지 않는다
 *  R4 P1     '결과 모름' 뒤 늦게 온 등록 회신 → 원장에 넣는다(이미 대상이면 끈다) · 다른 엣지의 회신은 받지 않는다
 *  R5 P3·C6  자동 설정에도 엣지 시한이 걸린다(SSH 를 끊는다) · 2단계는 시한 뒤 사본을 바꾸지 않고 되돌린다
 *  R6 S3·C7  2단계 저장이 회신 뒤 실패하면 원격이 바뀐 사실을 그대로 말한다 · 저장 판정은 보내기 전에(checkDirectorUpdate)
 *  R7 S6·I10 엣지 사본의 인증 정지 키는 엣지 자기 Director 와 나뉜다
 *  R8 P2     인출은 빈 자리만큼(max)
 *  R9 W1·W6·W7 폴러: 대행 중(회신 전)은 실패로 세지 않는다 · 할 일 없는 틱이 '대행 중' 을 지우지 않는다 · 도착한 실패는 센다
 */
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareosedgerev-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.CENTRAL_TOKEN = 'shared-token-for-bareos-edge-review-1234567890';
fs.writeFileSync(path.join(tmp, 'users.json'), JSON.stringify({ users: [{ username: 'adm', role: 'admin' }] }));

const { config } = await import('../src/config.js');
const S = await import('../src/bareos/settings.js');
const R = await import('../src/bareos/registry.js');
const P = await import('../src/bareos/poller.js');
const E = await import('../src/bareos/edgeOps.js');
const ER = await import('../src/bareos/edgeResult.js');
const ES = await import('../src/bareos/edgeStore.js');
const EStp = await import('../src/bareos/edgeSetup.js');
const A = await import('../src/bareos/autoSetup.js');
const svc = await import('../src/bareos/service.js');
const worker = await import('../src/agent/bareosOpWorker.js');
const pull = await import('../src/agent/bareosConfigPull.js');
const tokens = await import('../src/central/agentTokens.js');
const { startFakeDirector } = await import('./_fakeBareosDirector.js');
const { fakeServer, fakeConsole } = await import('./_fakeBareosSsh.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const D = { jobs: new Map(), runs: new Map(), nextId: 9000, cmds: [] };
const handle = async (cmd) => {
  D.cmds.push(cmd);
  const kv = Object.fromEntries([...cmd.matchAll(/(\w+)=("(?:\\.|[^"])*"|\S+)/g)].map((m) => [m[1], m[2]]));
  if (cmd === '.clients') return { clients: [{ name: 'pl-fd' }] };
  if (cmd === '.jobs') return { jobs: [...D.jobs].map(([name, j]) => ({ name, enabled: j.enabled !== false })) };
  if (cmd.startsWith('configure add job')) { D.jobs.set(kv.name, { enabled: true }); return { add: { resource: 'Job', name: kv.name } }; }
  if (cmd.startsWith('llist jobid=') || cmd.startsWith('list jobs')) return { jobs: [] };
  if (cmd.startsWith('enable ') || cmd.startsWith('disable ')) { const j = D.jobs.get(kv.job); if (!j) return { error: [`Job "${kv.job}" not found.`] }; j.enabled = cmd.startsWith('enable '); return {}; }
  return { error: [`unknown ${cmd}`] };
};

let fd; let srv; let base; let central; let DE; let tPl; let tKr;
const VMS = ['vm-1', 'vm-2', 'vm-3', 'vm-4', 'vm-5'];
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
    vms: VMS.map((m) => ({ id: `vc-pl:${m}`, vcenterId: 'vc-pl', name: `db-${m}`, powerState: 'POWERED_ON', snapshotCount: 0, vcDcPath: 'DC-PL', folderPath: '/' })),
  };
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/api/central', centralRouter);
  app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  central = `http://127.0.0.1:${srv.address().port}`;
  base = `${central}/api/tools/bareos-backup`;
  await asEdge('PL-Warsaw', tPl, () => pull.pullBareosConfigNow());
});
after(async () => { E._resetForTest(); A._setDepsForTest(); try { srv?.close(); } catch { /* */ } await fd?.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

async function call(method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, j, t };
}
async function asEdge(name, token, fn) {
  const keep = { ...config.agent };
  Object.assign(config.agent, { centralUrl: central, centralToken: token, name });
  try { return await fn(); } finally { Object.assign(config.agent, keep); }
}
const waitPending = async (n = 1) => { for (let i = 0; i < 300 && E.pendingView().length < n; i++) await sleep(10); assert.ok(E.pendingView().length >= n, '작업이 큐에 들어왔다'); };

test('R1 일괄 등록(엣지 대행): 결과가 VM 마다 짝지어져 원장에 들어간다(정제가 숫자 key 를 보존)', async () => {
  const before = D.jobs.size;
  const bulk = call('POST', '/jobs/bulk', { vcenterId: 'vc-pl', vmIds: ['vc-pl:vm-1', 'vc-pl:vm-2'] });
  await waitPending();
  await asEdge('PL-Warsaw', tPl, () => worker.runBareosOpWorkerOnce());
  const r = await bulk;
  assert.equal(r.s, 200, r.t);
  assert.equal(r.j.created, 2, r.t);
  assert.equal(D.jobs.size - before, 2, 'Director 에 잡 2개');
  for (const vm of ['vc-pl:vm-1', 'vc-pl:vm-2']) assert.equal(R.findByVm('vc-pl', vm)?.directorId, DE, `${vm} 원장`);
});

test('R2 정제: catalog errors 는 자기 키만 · addJobs 숫자 key 보존 · runJob·restore 필수 값 없으면 결과 모름', () => {
  const c = ER.sanitizeEdgeResult('catalog', { ok: true, value: { clients: ['a'], errors: JSON.parse('{"constructor":"x","toString":"y","pools":"bad"}') } });
  assert.deepEqual(Object.keys(c.value.errors), ['pools']);
  assert.equal(ER.sanitizeEdgeResult('addJobs', { ok: true, value: [{ key: 3, ok: true, name: 'j' }] }).value[0].key, 3);
  const rj = ER.sanitizeEdgeResult('runJob', { ok: true, value: 'abc' });
  assert.equal(rj.ok, false); assert.equal(rj.unknown, true); assert.equal(rj.code, 'unknown');
  assert.equal(ER.sanitizeEdgeResult('runJob', { ok: true, value: 42 }).value, 42);
  assert.equal(ER.sanitizeEdgeResult('restore', { ok: true, value: { rid: null, chain: [1] } }).unknown, true);
});

test('R3 저장 직후 엣지 사본이 옛 비밀번호여도 새 비밀번호에 인증 정지를 걸지 않는다(connSig → 배정 즉시 다시 받기)', async () => {
  // 엣지 사본 = 틀린 비밀번호(예전 값) · 중앙 = 맞는 비밀번호로 방금 고침
  S.updateDirector(DE, { password: 'wrong-pw' });
  pull._resetForTest();
  await asEdge('PL-Warsaw', tPl, () => pull.pullBareosConfigNow());
  assert.equal(ES.edgeDirectorById(DE).password, 'wrong-pw');
  S.updateDirector(DE, { password: 'pw-edge' });
  const t = call('POST', `/settings/directors/${DE}/test`, {});
  await waitPending();
  await asEdge('PL-Warsaw', tPl, () => worker.runBareosOpWorkerOnce());
  const r = await t;
  assert.equal(r.s, 200, r.t);
  assert.equal(ES.edgeDirectorById(DE).password, 'pw-edge', '엣지가 배정을 즉시 다시 받았다');
  assert.equal(svc.bareosAuthGuard.peekAuthStop(S.directorCred(S.directorById(DE))), null, '맞는 비밀번호에 정지 없음');

  // 회신을 기다리는 사이 중앙 값이 바뀌면 그 회신(옛 접속값의 결과)으로 정지를 풀지 않는다(정지 해제는 id 로 지운다 — 기록은 자격 해시로 대조돼 원래 안전)
  const p = svc.relayToEdge(S.directorById(DE), 'probe', {});
  const [op] = E.takeEdgeOps('PL-Warsaw');
  S.updateDirector(DE, { password: 'pw-edge-2' });
  const now = S.directorCred(S.directorById(DE));
  svc.bareosAuthGuard.markAuthStopped(now.id, now, '새 접속값으로 인증 실패(시험)');
  E.completeEdgeOp(op.id, 'PL-Warsaw', { ok: true, value: { director: 'bareos-dir', version: '24', clients: [] } });
  await p;
  assert.ok(svc.bareosAuthGuard.peekAuthStop(now), '옛 접속값의 성공 회신이 새 접속값의 정지를 풀지 않는다');
  // 같은 접속값의 인증 실패 회신은 기록한다
  const p2 = svc.relayToEdge(S.directorById(DE), 'probe', {});
  const [op2] = E.takeEdgeOps('PL-Warsaw');
  svc.bareosAuthGuard.clearAuthStop(now.id);
  E.completeEdgeOp(op2.id, 'PL-Warsaw', { ok: false, code: 'auth', authFailed: true, reason: 'Authorization failed.' });
  await assert.rejects(p2, (e) => e.code === 'auth');
  assert.ok(svc.bareosAuthGuard.peekAuthStop(now), '같은 접속값의 인증 실패는 정지');
  svc.bareosAuthGuard.clearAuthStop(now.id);
  S.updateDirector(DE, { password: 'pw-edge' });
  pull._resetForTest();
  await asEdge('PL-Warsaw', tPl, () => pull.pullBareosConfigNow());
});

test('R4 결과 모름 뒤 늦게 온 등록 회신 → 원장에 넣는다 · 이미 대상이면 그 잡을 끈다 · 다른 엣지 회신은 받지 않는다', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const p = svc.createBackupTarget({ vcenterId: 'vc-pl', vmId: 'vc-pl:vm-3', by: 't' });
    const [op] = E.takeEdgeOps('PL-Warsaw');
    assert.equal(op.kind, 'addJobs');
    mock.timers.tick(E.RESULT_MS.addJobs + 1);
    await assert.rejects(p, (e) => e.code === 'unknown' && /늦게 도착하면/.test(e.message));
    assert.equal(R.findByVm('vc-pl', 'vc-pl:vm-3'), null);
    assert.equal(E.completeEdgeOp(op.id, 'KR-Seoul', { ok: true, value: [{ key: 0, ok: true, name: 'pv-x' }] }).stale, true, '남의 엣지 회신은 받지 않는다');
    assert.equal(E.completeEdgeOp(op.id, 'PL-Warsaw', { ok: true, value: [{ key: 0, ok: true, name: 'pv-late-vm3' }] }).late, true);
    assert.equal(R.findByVm('vc-pl', 'vc-pl:vm-3')?.bareosJob, 'pv-late-vm3', '늦은 결과를 원장에 넣었다');
    // 같은 VM 의 늦은 회신이 또 오면(사용자가 그사이 다시 등록) — 원장에 넣지 못하므로 그 잡을 끈다
    const p2 = svc.createBackupTarget({ vcenterId: 'vc-pl', vmId: 'vc-pl:vm-4', by: 't' });
    const [op2] = E.takeEdgeOps('PL-Warsaw');
    mock.timers.tick(E.RESULT_MS.addJobs + 1);
    await assert.rejects(p2, (e) => e.code === 'unknown');
    R.addJob({ vcenterId: 'vc-pl', vmId: 'vc-pl:vm-4', vmName: 'db-vm-4', directorId: DE, bareosJob: 'pv-second-try', client: 'pl-fd', storage: 'File', pool: 'Full', createdBy: 't' });
    E.completeEdgeOp(op2.id, 'PL-Warsaw', { ok: true, value: [{ key: 0, ok: true, name: 'pv-late-vm4' }] });
    assert.ok(E.pendingView().some((o) => o.kind === 'disableJobs'), '원장에 못 넣은 늦은 잡은 끄러 보낸다');
  } finally { mock.timers.reset(); E._resetForTest(); }
});

test('R5 자동 설정에도 엣지 시한이 걸린다 · 2단계는 시한 뒤 사본을 바꾸지 않고 되돌린다', async () => {
  // ① 사전 점검: SSH 가 5초 걸려도 ttl(1초 하한)에 끊긴다
  A._setDepsForTest({
    ssh: (_creds, _fn, opts) => new Promise((res, rej) => {
      const t = setTimeout(() => res({ ok: true, code: 0, stdout: '' }), 5_000);
      opts?.signal?.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('aborted'), { code: 'aborted' })); }, { once: true });
    }),
  });
  try {
    const t0 = Date.now();
    const r = await asEdge('PL-Warsaw', tPl, () => worker.runBareosEdgeOp({ id: 'p1', kind: 'setup.preflight', directorId: DE, ttlMs: 1_000, args: { body: { host: '10.20.30.40' } }, secretArgs: { password: 'ssh-x' } }));
    assert.equal(r.ok, false);
    assert.ok(Date.now() - t0 < 3_000, `시한에 끊겼다(${Date.now() - t0}ms)`);
  } finally { A._setDepsForTest(); }
  // ② 2단계: 새 콘솔 확인이 시한을 넘기면 사본을 바꾸지 않고 원격을 되돌린다
  const srvSsh = fakeServer();
  const con = fakeConsole();
  A._setDepsForTest({ ssh: srvSsh.ssh, openConsole: async (c) => { await sleep(400); return con.open(c); }, sleep: async () => {} });
  try {
    const dir = ES.edgeDirectorById(DE);
    const keep = dir.password;
    const cp = 'A'.repeat(32);
    await assert.rejects(
      EStp.runSetupOp('setup.director', dir, { body: { host: '10.20.30.40', username: 'root', restoreClient: 'pl-fd', restoreStorage: 'File', restorePool: 'Full' }, defaults: S.loadSettings().defaults },
        { password: 'ssh-y', consolePassword: cp }, { signal: AbortSignal.timeout(200) }),
      (e) => e.code === 'save',
    );
    assert.equal(ES.edgeDirectorById(DE).password, keep, '시한 뒤에는 사본을 바꾸지 않는다');
    assert.ok(![...srvSsh.F.values()].some((f) => String(f.content).includes(cp)), '원격에 새 콘솔 비밀번호가 남지 않았다(되돌림)');
  } finally { A._setDepsForTest(); }
});

test('R6 2단계: 저장 판정은 보내기 전에 · 회신 뒤 저장이 실패하면 원격이 바뀐 사실을 말한다', () => {
  const other = S.addDirector({ name: '충돌 법인', host: '10.9.9.9', port: 9101, consoleName: 'portal', password: 'p', agent: 'KR-Seoul' }).director.id;
  try {
    assert.throws(() => S.checkDirectorUpdate(DE, { host: '10.9.9.9', port: 9101, consoleName: 'portal', password: 'q' }), (e) => e.code === 'invalid', '같은 콘솔이면 보내기 전에 거부');
    assert.equal(S.directorById(DE).host, '127.0.0.1', '판정만 — 저장하지 않는다');
  } finally { S.deleteDirector(other); }
  const src = fs.readFileSync(new URL('../src/routes/api/bareosBackup.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function runSetup('), src.indexOf("api.post('/tools/bareos-backup/settings/directors/:directorId/auto-setup/preflight'"));
  assert.ok(fn.indexOf('checkDirectorUpdate(') > 0 && fn.indexOf('checkDirectorUpdate(') < fn.indexOf('relayToEdge('), '저장 판정이 엣지로 보내기 전');
  assert.match(fn, /새 콘솔 비밀번호로 바뀌었고 중앙은 옛 값입니다/);
});

test('R7 엣지 사본의 인증 정지 키는 엣지 자기 Director 와 나뉜다', () => {
  assert.match(S.directorCred(ES.edgeDirectorById(DE)).id, /^edge-director:/);
  assert.match(S.directorCred(S.directorById(DE)).id, /^director:/);
  assert.equal(S.directorCred({ id: 'dir_default' }).id, 'director');
  assert.equal(S.directorCred({ id: 'dir_default', edgeCopy: true }).id, 'edge-director:dir_default');
});

test('R8 인출은 빈 자리만큼(max)', async () => {
  try {
    const dir = S.directorById(DE);
    for (let i = 0; i < 3; i++) E.enqueueEdgeOp(dir, 'probe', {});
    const r = await fetch(`${central}/api/central/bareos-ops?max=1`, { headers: { 'X-Central-Token': tPl } });
    assert.equal((await r.json()).ops.length, 1);
    assert.equal(E.takeEdgeOps('PL-Warsaw', 0).length, 0);
    assert.equal(E.takeEdgeOps('PL-Warsaw').length, 2);
    assert.ok(worker.OP_CONCURRENCY >= 3);
  } finally { E._resetForTest(); }
});

test('R9 폴러: 회신 전 대행은 실패로 세지 않는다 · 할 일 없는 틱이 대행 표지를 지우지 않는다 · 도착한 실패는 센다', async () => {
  E._resetForTest();
  P._resetPollerForTest();
  let st = await P.pollOnce({ trigger: 'manual' });
  assert.equal(st.directors[DE].relay, 'sent');
  assert.equal(st.ok, true, '대행 중은 실패가 아니다');
  assert.equal(st.directorsFailed, 0);
  assert.equal(st.idle, false, '보냈으면 할 일이 있었다');
  st = await P.pollOnce({ trigger: 'timer', reconcile: false });
  assert.equal(st.directors[DE].relay, 'pending', '진행 중 poll 이 있으면 대행 표지 유지(깜빡임 없음)');
  const [op] = E.takeEdgeOps('PL-Warsaw');
  E.completeEdgeOp(op.id, 'PL-Warsaw', { ok: false, code: 'connect', reason: '연결 거부(ECONNREFUSED)' });
  for (let i = 0; i < 50 && P.pollerStatus().directors[DE].ok !== false; i++) await sleep(10);
  assert.equal(P.pollerStatus().directors[DE].ok, false);
  st = await P.pollOnce({ trigger: 'manual' });
  assert.equal(st.ok, false, '도착한 실패는 센다');
  assert.match(st.error, /연결 거부/, '사유가 빈칸이 아니다');
  E._resetForTest();
});
