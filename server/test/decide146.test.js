/**
 * 146회차(141 결정 D1 · D2 — 사용자 ‘권장안대로’) 회귀 — 실제 키 저장소 + secretVault · 실제 등록부 · 실제 상태 파일 · 실제 ssh2 가짜 sshd(시도를 센다).
 *  D1 공통 계정 탐침(accountGate): 성공했던 판은 **유효 시간(2분)** 동안만 기다리지 않는다 — 지나면 다음 접속이 다시 탐침, 나머지는 그 **로그인** 결과를 기다린다.
 *    ① 유효 시간이 지난 뒤 AD 에서 비밀번호가 바뀌면 동시 8 접속 중 틀린 비밀번호는 1회(예전 8회) · 유효 시간 안의 연속 접속은 예전처럼 기다리지 않는다 · 시계가 뒤로 가면 탐침
 *    ② 탐침은 로그인 직후 풀어 준다(authed — 명령 시간까지 기다리지 않음) · 매달린 탐침도 로그인했으면 막지 않는다 · 먼저 풀린 탐침이 run 끝에 새 탐침의 자리를 지우지 않는다
 *    ③ 탐침이 실패(던짐 · 시한 · 연결)하면 다음 하나가 탐침 — 성공했던 판은 연달아 OTHER_MAX 번이면 한 유효 시간 동안 예전처럼 · 처음 판은 끝까지 하나씩
 *    ④ 실제 bm-storage 주기(bmCollectNow · collectMany 동시 4): 3분 뒤 AD 비밀번호가 바뀌면 틀린 비밀번호 1회(예전 4회) · 다시 탐침의 대기는 로그인까지(df 시간이 아니라)
 *    ⑤ 실제 서버 정보 읽기(readServer)도 다시 탐침의 대기는 로그인까지 · 수집 함수(collectServer · collectOsUsage)는 로그인 직후 onLogin 을 한 번 부른다
 *  D2 자격 없는 예전 항목: 키 · 비밀번호가 없으면 접속하지 않는다(root + 빈 비밀번호 금지) — 중앙 · 엣지 위임 · 엣지에서 SSH 를 거는 함수 모두.
 *    ⑥ 예전 항목(승인 없음) — 해석 no-cred · bm-storage 주기 0회 · 서버 정보 not-configured(‘승인 모두 없음’) · bm-usage 사유 cred-config
 *    ⑦ 엣지 위임 서버 — 잡 · PUSH 에 싣지 않고 사유를 남긴다 · 엣지가 받은 빈 비밀번호 서버(collectMany — bmstorWorker · /api/collector/bmstor-collect)도 0회
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'dc146-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.SSH_HOSTKEY_POLICY = 'observe';
process.env.BMSTOR_IO_SAMPLE_SEC = '0';   // df 만(I/O 표본 sleep 없음)
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

const VAULT = await import('../src/security/secretVault.js');
VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
const ssh2 = (await import('ssh2')).default;
const KS = await import('../src/bmusage/onboard/keyStore.js');
const REFS = await import('../src/bmusage/onboard/refs.js');
const BM = await import('../src/bmstor/registry.js');
const ST = await import('../src/sshaccess/state.js');
const G = await import('../src/sshaccess/accountGate.js');
const RS = await import('../src/sshaccess/readServer.js');
const BP = await import('../src/bmstor/poller.js');
const JOBS = await import('../src/bmstor/jobs.js');
const COL = await import('../src/bmstor/collect.js');
const OS = await import('../src/bmusage/collectors/osSsh.js');
const MR = await import('../src/bmusage/missReason.js');
const { store } = await import('../src/store.js');
store.snapshot = { ...store.get(), vcenters: [{ id: 'vcA', name: 'KR-SEL' }, { id: 'vcB', name: 'US-EAST' }] };

const rsa = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
/** 가짜 sshd — st.password 만 받는다 · 모든 인증 시도를 시각과 함께 센다 · df 는 요청 마운트 '/' 로 답한다(execDelayMs 만큼 늦게). */
async function fakeSshd() {
  const st = { password: null, seen: [], execEnds: [], execDelayMs: 0 };
  const srv = new ssh2.Server({ hostKeys: [rsa()] }, (client) => {
    client.on('authentication', (ctx) => {
      st.seen.push({ method: ctx.method, username: ctx.username, password: ctx.method === 'password' ? ctx.password : undefined, at: performance.now() });
      if (ctx.method === 'password' && st.password && ctx.password === st.password) return ctx.accept();
      return ctx.reject(['password']);
    });
    client.on('ready', () => client.on('session', (accept) => {
      const s = accept();
      s.on('exec', (acc, _rej, info) => {
        const stream = acc();
        const out = /^df /.test(info.command) ? 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 500 500 50% /\n' : 'ok\n';
        setTimeout(() => { st.execEnds.push(performance.now()); stream.write(out); stream.exit(0); stream.end(); }, st.execDelayMs);
      });
    }));
    client.on('error', () => {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, st, close: () => srv.close() };
}
const SSHD = await fakeSshd();
test.after(() => SSHD.close());

const srv = (body) => { const r = BM.saveBmServer({ host: '127.0.0.1', port: SSHD.port, mounts: ['/'], ...body }); assert.equal(r.ok, true, r.reason); return BM.listBmServersRaw().find((x) => x.id === r.server.id); };
const byId = (id) => BM.listBmServersRaw().find((x) => x.id === id);
const pwTries = (pw, from = 0) => SSHD.st.seen.slice(from).filter((x) => x.method === 'password' && x.password === pw).length;
/** 실제 시각에서 offset 만큼 옮긴 시계(시험 안에서만 — 정지 기록 · 유효 시간 모두 이 시계를 본다). */
function shiftClock(t) {
  const real = Date.now;
  const c = { offset: 0 };
  t.mock.method(Date, 'now', () => real.call(Date) + c.offset);
  return c;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const opts = { feature: 'bm-usage', rejected: (r) => r?.authFailed === true, stopped: (code) => ({ ok: false, gated: code }) };
let accSeq = 0;
const acctId = () => `a_${(0xd146000 + (accSeq += 1)).toString(16).padStart(12, '0')}`;

test('① D1 — 유효 시간이 지나면 다시 탐침: AD 비밀번호가 바뀐 뒤 동시 8 접속 중 틀린 비밀번호 1회 · 유효 시간 안은 기다리지 않음 · 시계가 뒤로 가면 탐침', async (t) => {
  G._resetAccountGateForTest();
  const clock = shiftClock(t);
  const s0 = { credAccountId: acctId(), credVersion: '1700000000001', credAccountName: 'd1', name: 'd1-0' };
  assert.equal((await G.gateAccountLogin(s0, async () => ({ ok: true }), opts)).ok, true, '앞 주기 — 탐침 성공');
  // 유효 시간 안: 동시 8 접속이 서로 기다리지 않는다(정상 경로 지연 없음 — 8개가 함께 떠 있다)
  clock.offset = 60_000;
  let active = 0; let maxActive = 0; let n = 0;
  const okRun = async () => { n += 1; active += 1; maxActive = Math.max(maxActive, active); await wait(30); active -= 1; return { ok: true }; };
  const t0 = performance.now();
  const rsIn = await Promise.all(Array.from({ length: 8 }, (_, i) => G.gateAccountLogin({ ...s0, name: `in-${i}` }, okRun, opts)));
  const inMs = performance.now() - t0;
  assert.equal(rsIn.filter((x) => x.ok).length, 8); assert.equal(n, 8);
  assert.equal(maxActive, 8, '유효 시간 안에서는 8개가 함께 접속(탐침 대기 없음)');
  assert.ok(inMs < 30 * 4, `8개가 한 번의 접속 시간 남짓에 끝난다(${Math.round(inMs)}ms)`);
  // 유효 시간이 지나서 AD 에서 비밀번호가 바뀜(포탈 판은 그대로) — 예전에는 8개가 모두 틀린 비밀번호를 보냈다
  clock.offset = 60_000 + G.OK_TTL_MS + 1_000;
  let sent = 0;
  const rejRun = async () => { sent += 1; await wait(20); return { ok: false, authFailed: true }; };
  const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => G.gateAccountLogin({ ...s0, name: `rot-${i}` }, rejRun, opts)));
  assert.equal(sent, 1, '틀린 비밀번호는 탐침 하나만');
  assert.equal(rs.filter((x) => x.gated === 'account-stopped').length, 7);
  assert.ok(ST.accountStopFor(s0.credAccountId, s0.credVersion), '그 자리에서 계정 정지');
  // 시계가 뒤로 가면(나이 < 0) 유효하지 않다 — 탐침 하나
  const s1 = { credAccountId: acctId(), credVersion: '1700000000002', credAccountName: 'd1b', name: 'd1b-0' };
  clock.offset = 0;
  await G.gateAccountLogin(s1, async () => ({ ok: true }), opts);
  clock.offset = -3_600_000;
  let sentB = 0;
  await Promise.all(Array.from({ length: 8 }, () => G.gateAccountLogin(s1, async () => { sentB += 1; await wait(20); return { ok: false, authFailed: true }; }, opts)));
  assert.equal(sentB, 1, '시계가 뒤로 가도 틀린 비밀번호는 하나');
});

test('② D1 — 다시 탐침은 로그인 직후 풀어 준다(명령 시간까지 기다리지 않음) · 매달린 탐침도 로그인했으면 막지 않는다 · 먼저 풀린 탐침이 새 탐침의 자리를 지우지 않는다', async (t) => {
  G._resetAccountGateForTest();
  const clock = shiftClock(t);
  const s0 = { credAccountId: acctId(), credVersion: '1700000000003', credAccountName: 'd2', name: 'd2-0' };
  await G.gateAccountLogin(s0, async () => ({ ok: true }), opts);
  clock.offset = G.OK_TTL_MS + 1_000;   // 다시 탐침
  const log = [];
  let release1;
  const probe = G.gateAccountLogin(s0, async (authed) => { log.push('p-login'); authed(); await new Promise((r) => { release1 = r; }); log.push('p-end'); return { ok: true }; }, opts);
  const others = Array.from({ length: 3 }, (_, i) => G.gateAccountLogin({ ...s0, name: `w-${i}` }, async () => { log.push(`w${i}`); return { ok: true }; }, opts));
  const rs = await Promise.all(others);
  assert.equal(rs.filter((x) => x.ok).length, 3, '탐침의 명령이 끝나기 전(매달려 있어도) 나머지가 접속했다');
  assert.deepEqual(log.slice(0, 1), ['p-login']); assert.ok(!log.includes('p-end'));
  // 다시 탐침이 성공하면 유효 시간을 새로 연다 — 그 뒤 동시 접속은 함께(하나씩 탐침이 되지 않는다)
  let active = 0; let maxActive = 0;
  await Promise.all(Array.from({ length: 4 }, (_, i) => G.gateAccountLogin({ ...s0, name: `x-${i}` }, async () => { active += 1; maxActive = Math.max(maxActive, active); await wait(15); active -= 1; return { ok: true }; }, opts)));
  assert.equal(maxActive, 4, '새로 연 유효 시간 안 — 4개가 함께');
  // 유효 시간이 또 지난 뒤 새 탐침이 자리를 잡았을 때, 먼저 풀린 탐침이 끝나도 그 자리를 지우지 않는다(셋째 접속은 새 탐침을 기다린다)
  clock.offset = 2 * G.OK_TTL_MS + 2_000;
  let release2; const order = [];
  const p2 = G.gateAccountLogin(s0, async () => { order.push('p2-start'); await new Promise((r) => { release2 = r; }); order.push('p2-end'); return { ok: true }; }, opts);
  await wait(5);
  release1(); await probe;
  const p3 = G.gateAccountLogin(s0, async () => { order.push('p3'); return { ok: true }; }, opts);
  await wait(20);
  assert.deepEqual(order, ['p2-start'], '셋째는 새 탐침의 결과를 기다린다');
  release2(); await Promise.all([p2, p3]);
  assert.deepEqual(order, ['p2-start', 'p2-end', 'p3']);
});

test('③ D1 — 탐침 실패(던짐 · 시한 · 연결)면 다음 하나가 탐침 — 성공했던 판은 연달아 OTHER_MAX 번이면 그 뒤로 함께 · 처음 판은 끝까지 하나씩 · 영원히 막히지 않는다', async (t) => {
  G._resetAccountGateForTest();
  const clock = shiftClock(t);
  // 성공했던 판 — 다시 탐침이 셋 연달아 판정을 못 내면(망 장애) 나머지는 함께 간다(차례로 서버 수만큼 기다리지 않는다)
  const s0 = { credAccountId: acctId(), credVersion: '1700000000004', credAccountName: 'd3', name: 'd3-0' };
  await G.gateAccountLogin(s0, async () => ({ ok: true }), opts);
  clock.offset = G.OK_TTL_MS + 1_000;
  let k = 0; let active = 0; let maxActive = 0;
  const fails = [async () => { throw new Error('boom'); }, async () => ({ ok: false, timeout: true, error: '시한 초과' }), async () => ({ ok: false, error: 'connect ECONNREFUSED' })];
  const order = [];
  // 모두 판정을 못 낸다(첫 셋은 던짐 · 시한 · 연결 실패, 나머지도 연결 실패) — 처음 셋은 하나씩, 그 뒤 나머지 일곱은 함께
  const run = async () => { const i = k++; order.push(['s', i]); active += 1; maxActive = Math.max(maxActive, active); await wait(15); active -= 1; order.push(['e', i]); if (i < fails.length) return fails[i](); return { ok: false, error: 'connect ECONNREFUSED' }; };
  const rs = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => G.gateAccountLogin({ ...s0, name: `o-${i}` }, run, opts)));
  assert.equal(k, 10, '모두 접속했다(막히지 않음)');
  assert.equal(rs.filter((x) => x.status === 'rejected').length, 1, '던진 탐침은 그 호출에만 던진다');
  const at = (kind, i) => order.findIndex((x) => x[0] === kind && x[1] === i);
  assert.ok(at('s', 1) > at('e', 0) && at('s', 2) > at('e', 1), '처음 셋은 하나씩(앞 탐침이 끝난 뒤)');
  assert.ok(at('s', 3) > at('e', 2), '셋째가 끝난 뒤에야 나머지');
  assert.equal(maxActive, 7, `세 번 판정을 못 낸 뒤 나머지 일곱은 함께(maxActive ${maxActive})`);
  assert.equal(ST.accountStopFor(s0.credAccountId, s0.credVersion), null, '연결 실패 · 시한으로는 멈추지 않는다');
  // 처음 판(성공한 적 없음)은 예전처럼 끝까지 하나씩(반증 F2 설계 그대로)
  const s1 = { credAccountId: acctId(), credVersion: '1700000000005', credAccountName: 'd3b', name: 'd3b-0' };
  let k1 = 0; let a1 = 0; let m1 = 0;
  await Promise.all(Array.from({ length: 6 }, () => G.gateAccountLogin(s1, async () => { k1 += 1; a1 += 1; m1 = Math.max(m1, a1); await wait(5); a1 -= 1; return { ok: false, error: 'connect ECONNREFUSED' }; }, opts)));
  assert.equal(k1, 6); assert.equal(m1, 1, '처음 판은 하나씩');
});

test('④ D1 — 실제 bm-storage 주기: 3분 뒤 AD 비밀번호가 바뀌면 틀린 비밀번호 1회(예전 동시 수 4) · 다시 탐침의 대기는 로그인까지', async (t) => {
  G._resetAccountGateForTest();
  const clock = shiftClock(t);
  const acc = KS.saveAccount({ name: 'd4-lin', kind: 'os', corp: 'vcA', os: 'linux', username: 'svc4', password: 'D4-pw-1' }).account;
  assert.equal(ST.setAssign('vcA', 'linux', { account: acc.id, auth: '' }).ok, true);
  const ids = [];
  for (let i = 0; i < 6; i += 1) { const s = srv({ name: `d4-${i}`, vcenterId: 'vcA', os: 'linux', addrOnly: true }); assert.equal(BM.setBmServerInherit(s.id, { on: true }).ok, true); ids.push(s.id); }
  SSHD.st.password = 'D4-pw-1';
  const r1 = await BP.bmCollectNow('auto');
  assert.equal(r1.okCount, 6, JSON.stringify(r1));
  // 다시 탐침(3분 뒤 · 비밀번호 맞음) — df 가 400ms 걸려도 나머지는 탐침의 **로그인** 뒤 바로 붙는다
  clock.offset = 3 * 60_000;
  SSHD.st.execDelayMs = 400;
  const a0 = SSHD.st.seen.length; const e0 = SSHD.st.execEnds.length;
  const r2 = await BP.bmCollectNow('auto');
  assert.equal(r2.okCount, 6);
  const auths = SSHD.st.seen.slice(a0).filter((x) => x.method === 'password').map((x) => x.at).sort((a, b) => a - b);
  const firstExecEnd = Math.min(...SSHD.st.execEnds.slice(e0));
  assert.ok(auths[1] < firstExecEnd, `둘째 로그인(${Math.round(auths[1] - auths[0])}ms 뒤)이 탐침의 df 가 끝나기(${Math.round(firstExecEnd - auths[0])}ms 뒤) 전`);
  SSHD.st.execDelayMs = 0;
  // 또 3분 뒤 AD 에서 비밀번호가 바뀜(포탈 판은 그대로)
  clock.offset = 6 * 60_000;
  SSHD.st.password = 'D4-pw-2';
  const n0 = SSHD.st.seen.length;
  const r3 = await BP.bmCollectNow('auto');
  assert.equal(r3.okCount, 0);
  assert.equal(pwTries('D4-pw-1', n0), 1, '틀린 비밀번호는 탐침 하나만(예전 collectMany 동시 4)');
  assert.ok(ST.accountStopFor(acc.id, KS.accountSecretVersion(KS.accountById(acc.id))), '그 주기 안에 계정 정지');
  ST.setAssign('vcA', 'linux', null);
  for (const id of ids) BM.removeBmServer(id);
});

test('⑤ D1 — 서버 정보 읽기(readServer)도 다시 탐침의 대기는 로그인까지 · 수집 함수는 로그인 직후 onLogin 을 한 번(틀린 비밀번호면 부르지 않음)', async (t) => {
  G._resetAccountGateForTest();
  const clock = shiftClock(t);
  const acc = KS.saveAccount({ name: 'd5-lin', kind: 'os', corp: 'vcB', os: 'linux', username: 'svc5', password: 'D5-pw' }).account;
  assert.equal(ST.setAssign('vcB', 'linux', { account: acc.id, auth: '' }).ok, true);
  const list = [];
  for (let i = 0; i < 3; i += 1) { const s = srv({ name: `d5-${i}`, vcenterId: 'vcB', os: 'linux', addrOnly: true }); assert.equal(BM.setBmServerInherit(s.id, { on: true }).ok, true); list.push(s); }
  SSHD.st.password = 'D5-pw';
  const plan = { linux: { command: 'echo ok', timeoutMs: 5_000 } };
  assert.equal((await RS.readServer(list[0].id, { feature: 'server-info', plan })).ok, true);
  clock.offset = 3 * 60_000;
  SSHD.st.execDelayMs = 400;
  const a0 = SSHD.st.seen.length; const e0 = SSHD.st.execEnds.length;
  const rs = await Promise.all(list.map((s) => RS.readServer(s.id, { feature: 'server-info', plan })));
  assert.equal(rs.filter((x) => x.ok).length, 3, JSON.stringify(rs.map((x) => x.code)));
  const auths = SSHD.st.seen.slice(a0).filter((x) => x.method === 'password').map((x) => x.at).sort((a, b) => a - b);
  assert.ok(auths[1] < Math.min(...SSHD.st.execEnds.slice(e0)), '둘째 로그인이 탐침의 명령이 끝나기 전');
  SSHD.st.execDelayMs = 0;
  // 수집 함수 두 개 — 로그인 직후 한 번, 틀린 비밀번호면 부르지 않는다
  const host = { host: '127.0.0.1', port: SSHD.port, username: 'root', mounts: ['/'] };
  let c1 = 0; const okC = await COL.collectServer({ ...host, password: 'D5-pw' }, { onLogin: () => { c1 += 1; } });
  assert.equal(okC.ok, true); assert.equal(c1, 1);
  let c2 = 0; await COL.collectServer({ ...host, password: 'nope' }, { onLogin: () => { c2 += 1; } });
  assert.equal(c2, 0);
  let c3 = 0; await OS.collectOsUsage({ ...host, password: 'D5-pw' }, { budgetMs: 8_000, onLogin: () => { c3 += 1; } });
  assert.equal(c3, 1, 'collectOsUsage 도 로그인 직후 한 번');
  // 두 폴러가 authed 를 넘긴다(bm-usage 는 시한을 탐침 뒤 run 안에서 연다)
  const src = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
  assert.match(src('bmusage/poller.js'), /gateAccountLogin\(target\.osHost, \(authed\) => withDeadline\(DEVICE_TIMEOUT_MS, \(signal\) => collectOsUsage\(target\.osHost, \{ signal, [^\n]*, top, onLogin: authed \}\)/);
  assert.match(src('bmstor/poller.js'), /const gatedCollect = \(s\) => gateAccountLogin\(s, \(authed\) => collectServer\(s, \{ onLogin: authed \}\)/);
  ST.setAssign('vcB', 'linux', null);
});

test('⑥ D2 — 키 · 비밀번호 · 승인 없는 예전 항목은 접속하지 않는다(해석 no-cred · bm-storage 0회 · 서버 정보 ‘승인 모두 없음’ · bm-usage cred-config)', async () => {
  const legacy = srv({ name: 'd6-legacy', vcenterId: 'vcA' });
  const [r] = REFS.withResolvedAuth([byId(legacy.id)], { feature: 'bm-storage' });
  assert.equal(r.authErrorCode, 'no-cred'); assert.equal(r.authError, REFS.NO_CRED_LEGACY_ERROR); assert.equal(r.password, '');
  assert.equal(REFS.withResolvedAuth([byId(legacy.id)], { feature: 'bm-usage' })[0].authErrorCode, 'no-cred');
  // 자기 비밀번호가 있는 예전 항목은 예전 그대로(같은 객체 — 해석하지 않는다)
  const own = srv({ name: 'd6-own', vcenterId: 'vcA', password: 'Own-6' });
  const ownRaw = byId(own.id);
  assert.equal(REFS.withResolvedAuth([ownRaw], { feature: 'bm-storage' })[0], ownRaw);
  SSHD.st.password = 'Own-6';
  const n0 = SSHD.st.seen.length;
  await BP.bmCollectNow('manual');
  assert.equal(pwTries('', n0), 0, 'root + 빈 비밀번호 시도 0회');
  assert.ok(pwTries('Own-6', n0) >= 1, '비밀번호가 있는 서버는 예전처럼 붙는다');
  const row = BP.getBmLatest().get(legacy.id);
  assert.equal(row.ok, false); assert.equal(row.error, REFS.NO_CRED_LEGACY_ERROR);
  assert.equal(row.authStopped, undefined, '인증 정지(authGuard)에 들지 않는다');
  // 서버 정보 — not-configured · 예전 항목 문구(승인 모두 없음) · 0회
  const rr = await RS.readServer(legacy.id, { feature: 'server-info', plan: { linux: { command: 'echo ok', timeoutMs: 5_000 } } });
  assert.equal(rr.code, 'not-configured'); assert.equal(rr.reason, REFS.NO_CRED_LEGACY_ERROR); assert.match(rr.reason, /승인 모두 없음/);
  assert.equal(pwTries('', n0), 0);
  // bm-usage — 해석을 거치지 않은 대상(예전 형태)도 수집 함수가 막는다 · 사유는 ‘키 · 계정 설정으로 시도 안 함’
  const os0 = await OS.collectOsUsage({ host: '127.0.0.1', port: SSHD.port, username: 'root', password: '' }, { budgetMs: 5_000 });
  assert.equal(os0.ok, false); assert.equal(os0.authErrorCode, 'no-cred'); assert.equal(MR.osMissOf(os0), 'cred-config');
  assert.equal(pwTries('', n0), 0, 'bm-usage 도 0회');
  BM.removeBmServer(legacy.id); BM.removeBmServer(own.id);
});

test('⑦ D2 — 엣지 위임 서버: 자격이 없으면 잡 · PUSH 에 싣지 않고 사유를 남긴다 · 엣지가 받은 빈 비밀번호 서버(collectMany)도 0회', async () => {
  const e1 = srv({ name: 'd7-poll', vcenterId: 'vcA', agent: 'edge-d7' });
  const e2 = srv({ name: 'd7-push', vcenterId: 'vcA', agent: 'edge-d7p', dispatch: 'push' });
  const e3 = srv({ name: 'd7-pw', vcenterId: 'vcA', agent: 'edge-d7', password: 'Edge-pw' });
  const r = await BP.bmCollectNow('manual');
  assert.equal(r.ok, true);
  const jobs = JOBS.takeBmstorJobs('edge-d7');
  const jobIds = jobs.flatMap((j) => (j.servers || []).map((x) => x.id));
  assert.ok(!jobIds.includes(e1.id), '자격 없는 서버는 잡에 없다');
  assert.ok(jobIds.includes(e3.id), '비밀번호가 있는 엣지 위임 서버는 예전처럼 잡에');
  assert.ok(jobs.flatMap((j) => j.servers || []).every((x) => typeof x.password === 'string' && x.password), '잡에 빈 비밀번호 없음');
  for (const s of [e1, e2]) {
    const row = BP.getBmLatest().get(s.id);
    assert.equal(row?.ok, false); assert.equal(row.error, BP.NO_CRED_EDGE_ERROR, s.name);
  }
  // 엣지 쪽(옛 중앙이 빈 비밀번호를 실어 보낸 잡 · PUSH) — 엣지의 bmstorWorker · /bmstor-collect 가 부르는 collectMany 가 붙지 않는다
  const n0 = SSHD.st.seen.length;
  const out = await COL.collectMany([{ id: 'x1', host: '127.0.0.1', port: SSHD.port, username: 'root', password: '', mounts: ['/'] }, { id: 'x2', host: '127.0.0.1', port: SSHD.port, username: 'root', mounts: ['/'] }]);
  assert.equal(SSHD.st.seen.length, n0, '엣지 수집 함수도 0회');
  assert.deepEqual(out.map((x) => x.error), [COL.NO_CRED_TEXT, COL.NO_CRED_TEXT]);
  const src = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
  assert.match(src('agent/bmstorWorker.js'), /import \{ collectMany \} from '\.\.\/bmstor\/collect\.js';/);
  assert.match(src('routes/collector.js'), /import \{ collectMany as bmstorCollectMany \} from '\.\.\/bmstor\/collect\.js';/);
  for (const s of [e1, e2, e3]) BM.removeBmServer(s.id);
});
