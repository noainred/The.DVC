/**
 * 점검 1회차(2026-11-20 · ‘버그 안 나올 때까지’) — 서버 접속 · 서버 정보 · WinRM · 서버 명령 실행 확정 결함 회귀.
 * S1: 공통 계정 탐침 문(accountGate)의 빠른 길 — 성공 뒤 비밀번호가 바뀌면 N대에 N번 보내던 것(재현 6/6).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'hunt1-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const G = await import('../src/sshaccess/accountGate.js');
const ST = await import('../src/sshaccess/state.js');

let t0 = Math.floor(Date.now() / 3_600_000) * 3_600_000;   // 정시 경계로 고정(실제 시각 기준)
let now = t0;
const clock = () => now;
const ID = { A: 'a_00000000000a', B: 'a_00000000000b', C: 'a_00000000000c', D: 'a_00000000000d' };   // 계정 id 꼴(state.ACC_ID_RE)
const srv = (id, ver = 'v1') => ({ credAccountId: id, credVersion: ver, credAccountName: id, name: `s-${id}` });
const opts = (sent) => ({ feature: 'bm-storage', rejected: (r) => r?.authFailed === true, stopped: (code) => { sent.stopped.push(code); return { ok: false, gated: code }; } });
/** 가짜 로그인 — 지금 비밀번호가 맞으면 성공 · 아니면 거부. 보낸 수를 센다. ms 동안 걸린다. */
function fakeLogin(sent, good, ms = 5) {
  return () => new Promise((r) => { sent.n += 1; setTimeout(() => r(good() ? { ok: true } : { ok: false, authFailed: true }), ms); });
}

test('S1 ① 성공이 오래됐으면(주기 사이) 탐침 하나부터 — 비밀번호가 바뀌었으면 N대 중 1번만 보낸다', async () => {
  G._resetAccountGateForTest({ now: clock });
  let pw = 'good';
  const sent = { n: 0, stopped: [] };
  const run = fakeLogin(sent, () => pw === 'good');
  // 주기 1: 6대 동시 — 탐침 하나 성공 뒤 나머지는 함께
  await Promise.all(Array.from({ length: 6 }, () => G.gateAccountLogin(srv(ID.A), run, opts(sent))));
  assert.equal(sent.n, 6); assert.equal(sent.stopped.length, 0);
  // 주기 사이(5분) — AD 에서 비밀번호가 바뀜
  now += 5 * 60_000; pw = 'rotated'; sent.n = 0;
  await Promise.all(Array.from({ length: 6 }, () => G.gateAccountLogin(srv(ID.A), run, opts(sent))));
  assert.equal(sent.n, 1, `탐침 하나만 — 예전에는 6번(빠른 길이 결과를 보지 않았다) · 지금 ${sent.n}`);
  assert.equal(sent.stopped.length, 5);
  assert.ok(ST.accountStopFor(ID.A, 'v1'), '계정 단위 정지');
});

test('S1 ② 빠른 길(최근 성공)에서도 결과를 본다 — 거부면 그 자리에서 정지 · 아직 시작하지 않은 접속은 보내지 않는다', async () => {
  G._resetAccountGateForTest({ now: clock });
  let pw = 'good';
  const sent = { n: 0, stopped: [] };
  const run = fakeLogin(sent, () => pw === 'good');
  await G.gateAccountLogin(srv(ID.B), run, opts(sent));
  assert.equal(sent.n, 1);
  // 신선한 성공 직후 비밀번호가 바뀜 — 한 대씩 차례로(풀 크기 1) 6대
  now += 10_000; pw = 'rotated'; sent.n = 0;
  for (let i = 0; i < 6; i += 1) await G.gateAccountLogin(srv(ID.B), run, opts(sent));
  assert.equal(sent.n, 1, `빠른 길의 첫 거부에서 정지 — 뒤 5대는 보내지 않는다 · 지금 ${sent.n}`);
  assert.equal(sent.stopped.length, 5);
  // 동시에 나간 접속(풀 크기 3)은 이미 나간 것까지만 — 정지 기록은 한 번
  G._resetAccountGateForTest({ now: clock });
  pw = 'good'; const s2 = { n: 0, stopped: [] };
  const run2 = fakeLogin(s2, () => pw === 'good', 20);
  await G.gateAccountLogin(srv(ID.C), run2, opts(s2));
  pw = 'rotated'; s2.n = 0;
  await Promise.all(Array.from({ length: 3 }, () => G.gateAccountLogin(srv(ID.C), run2, opts(s2))));
  assert.equal(s2.n, 3, '이미 동시에 나간 셋은 보냈다(풀 크기까지 — 한계)');
  await G.gateAccountLogin(srv(ID.C), run2, opts(s2));
  assert.equal(s2.n, 3, '그 뒤는 보내지 않는다');
});

test('S1 ③ 한 주기 안의 성공은 서로 이어 준다(빠른 길 유지) · 오래되면 다시 탐침', async () => {
  G._resetAccountGateForTest({ now: clock });
  const sent = { n: 0, stopped: [] };
  const order = [];
  const run = () => new Promise((r) => { sent.n += 1; order.push(now); setTimeout(() => r({ ok: true }), 5); });
  await G.gateAccountLogin(srv(ID.D), run, opts(sent));
  // 50초씩 세 번 — 성공이 신선도를 이어서 빠른 길(동시 4대가 함께 나간다)
  for (let k = 0; k < 3; k += 1) {
    now += 50_000;
    let inflight = 0; let peak = 0;
    const r4 = () => new Promise((r) => { inflight += 1; peak = Math.max(peak, inflight); setTimeout(() => { inflight -= 1; r({ ok: true }); }, 10); });
    await Promise.all(Array.from({ length: 4 }, () => G.gateAccountLogin(srv(ID.D), r4, opts(sent))));
    assert.equal(peak, 4, `빠른 길 — 동시 4대(${k})`);
  }
  // 신선도가 지나면 탐침 하나가 먼저 — 탐침이 끝나기 전에는 다른 접속이 나가지 않는다(그 뒤 나머지는 함께)
  now += G.OK_FRESH_MS + 1;
  const ev = [];
  let n = 0;
  const r4 = () => new Promise((r) => { const k = n++; ev.push(`s${k}`); setTimeout(() => { ev.push(`e${k}`); r({ ok: true }); }, 10); });
  await Promise.all(Array.from({ length: 4 }, () => G.gateAccountLogin(srv(ID.D), r4, opts(sent))));
  assert.deepEqual(ev.slice(0, 2), ['s0', 'e0'], `탐침 하나가 먼저 끝난다 — ${ev.join(' ')}`);
  assert.deepEqual(ev.slice(2, 5).sort(), ['s1', 's2', 's3'], '그 뒤 나머지는 함께');
  assert.ok(G.OK_FRESH_MS < 5 * 60_000, '신선도는 주기(bm-usage 5분 · bm-storage 10분)보다 짧다');
});

test('T5 새 비밀번호 저장 전 확인은 계정과 같은 OS 서버만 후보 · 계정 OS 를 바꿔 OS 를 정한 서버가 어긋나면 거절', async () => {
  const VAULT = await import('../src/security/secretVault.js');
  VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
  const KS = await import('../src/bmusage/onboard/keyStore.js');
  const BM = await import('../src/bmstor/registry.js');
  const SA = await import('../src/sshaccess/service.js');
  const REFS = await import('../src/bmusage/onboard/refs.js');
  const ad = KS.saveAccount({ name: 'kr-ad', kind: 'os', corp: 'vcT', os: 'windows', logon: 'ad', domain: 'CORP', username: 'svc', password: 'Ad-1' }, { by: 't' });
  assert.equal(ad.ok, true, ad.reason);
  // Linux 서버가 자기 credRef 로 Windows AD 계정을 가리킴(resolveOsAuth 는 account-os 로 막는다) — 포트 1(붙으면 접속 실패로 드러난다)
  const lin = BM.saveBmServer({ name: 'lin-t5', host: '127.0.0.1', port: 1, vcenterId: 'vcT', os: 'linux', credRef: ad.account.id, mounts: ['/'], bindApproved: true });
  assert.equal(lin.ok, true, lin.reason);
  assert.equal(REFS.resolveOsAuth(BM.listBmServersRaw().find((x) => x.id === lin.server.id), { feature: 'bm-usage' }).code, 'account-os');
  const r = await SA.saveAccountChecked({ input: { id: ad.account.id, password: 'Ad-2' }, by: 't' });
  assert.equal(r.ok, true, `다른 OS 서버는 확인 후보가 아니다 — ${r.code} ${r.reason || ''}`);
  assert.equal(r.verified, undefined, 'Linux 서버로 AD 이름 · 새 비밀번호를 보내지 않았다');
  // 계정 OS 를 Linux → Windows 로 바꾸면 OS 를 정한 Linux 서버가 어긋난다 — 저장 전에 거절
  const lx = KS.saveAccount({ name: 'kr-lx', kind: 'os', corp: 'vcT', os: 'linux', username: 'mon', password: 'Lx-1' }, { by: 't' });
  assert.equal(BM.saveBmServer({ name: 'lin-t5b', host: '127.0.0.1', port: 1, vcenterId: 'vcT', os: 'linux', credRef: lx.account.id, mounts: ['/'], bindApproved: true }).ok, true);
  const bad = await SA.saveAccountChecked({ input: { id: lx.account.id, os: 'windows', logon: 'local', password: 'Win-1' }, by: 't' });
  assert.equal(bad.ok, false); assert.equal(bad.code, 'account-os', JSON.stringify(bad));
  assert.equal(KS.accountById(lx.account.id).os, 'linux', '저장하지 않았다');
});

test('S2 OS 단계 지정을 지우면 위 단계(법인) 계정으로 옮겨 가는 서버 한 대로 먼저 확인 — 실패면 지우지 않는다', async () => {
  const crypto = await import('node:crypto');
  const ssh2 = (await import('ssh2')).default;
  const KS = await import('../src/bmusage/onboard/keyStore.js');
  const BM = await import('../src/bmstor/registry.js');
  const SA = await import('../src/sshaccess/service.js');
  const REFS = await import('../src/bmusage/onboard/refs.js');
  const { store } = await import('../src/store.js');
  process.env.SSH_HOSTKEY_POLICY = 'observe';
  store.snapshot = { ...store.get(), vcenters: [{ id: 'vcG', name: 'G' }] };
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const seen = [];
  const sshd = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => { if (ctx.method === 'password') { seen.push(`${ctx.username}:${ctx.password}`); if (ctx.username === 'lu' && ctx.password === 'L-pw') return ctx.accept(); } ctx.reject(['password']); });
    client.on('ready', () => client.on('session', (acc) => acc().on('exec', (a) => { const st = a(); st.write('ok\n'); st.exit(0); st.end(); })));
    client.on('error', () => {});
  });
  await new Promise((r) => sshd.listen(0, '127.0.0.1', r));
  try {
    const L = KS.saveAccount({ kind: 'os', os: 'linux', name: 'L', corp: 'vcG', username: 'lu', password: 'L-pw' }, { by: 't' }).account;
    const M = KS.saveAccount({ kind: 'os', os: 'linux', name: 'M', corp: 'vcG', username: 'mu', password: 'M-pw' }, { by: 't' }).account;
    ST.setAssign('vcG', 'all', { account: L.id, auth: '' }, { by: 't' });
    ST.setAssign('vcG', 'linux', { account: M.id, auth: '' }, { by: 't' });
    const mk = (name, port) => {
      const r = BM.saveBmServer({ host: '127.0.0.1', port, mounts: ['/'], name, vcenterId: 'vcG', os: 'linux', addrOnly: true });
      const s = BM.listBmServersRaw().find((x) => x.id === r.server.id);
      assert.equal(BM.setBmServerInherit(s.id, { on: true, expectAddr: `127.0.0.1:${port}|root`, expectKey: BM.inheritKeyOf(s), by: 't' }).ok, true);
      return s.id;
    };
    const dead = mk('g-dead', 9); const live = mk('g-live', sshd.address().port);
    // 대상 없이 지우기 — 409 need-verify + 옮겨 가는 서버 후보(지우지 않는다)
    const n = await SA.setAssignment({ corp: 'vcG', level: 'linux', accountId: '', by: 't' });
    assert.equal(n.code, 'need-verify', JSON.stringify(n)); assert.deepEqual(n.candidates.map((x) => x.id).sort(), [dead, live].sort());
    assert.match(n.reason, /위 단계 계정\(L\)/);
    assert.equal(ST.assignFor('vcG', 'linux')?.account, M.id, '지우지 않았다');
    // 확인 실패(닫힌 포트) — 지우지 않는다
    const f = await SA.setAssignment({ corp: 'vcG', level: 'linux', accountId: '', verifyServerId: dead, by: 't' });
    assert.equal(f.code, 'verify-failed'); assert.equal(ST.assignFor('vcG', 'linux')?.account, M.id);
    // 확인 성공 — 위 단계 계정 L 로 한 번 로그인한 뒤 지운다
    const ok = await SA.setAssignment({ corp: 'vcG', level: 'linux', accountId: '', verifyServerId: live, by: 't' });
    assert.equal(ok.ok, true, JSON.stringify(ok)); assert.equal(ok.verified.account, 'L');
    assert.deepEqual(seen, ['lu:L-pw'], '위 단계 계정 비밀번호 한 번');
    assert.equal(ST.assignFor('vcG', 'linux'), null);
    assert.equal(REFS.effectiveAccountOf(BM.listBmServersRaw().find((x) => x.id === live)).accountId, L.id);
    // 법인 단계를 지우면 옮겨 갈 위 단계가 없다 — 확인 없이(비밀번호가 가지 않는다)
    const top = await SA.setAssignment({ corp: 'vcG', level: 'all', accountId: '', by: 't' });
    assert.equal(top.ok, true, JSON.stringify(top)); assert.equal(seen.length, 1);
  } finally { sshd.close(); }
});

test('R2 · T4 로그인은 됐고 그 뒤에 실패한 탐침(loggedIn)은 성공으로 본다 — 기다리던 접속을 하나씩 직렬로 풀지 않는다', async () => {
  G._resetAccountGateForTest({ now: clock });
  const sent = { n: 0, stopped: [] };
  let inflight = 0; let peak = 0; let k = 0;
  // 첫 접속(탐침): 로그인 뒤 명령 실패(WinRM Fault · 세션 잃음 꼴) · 나머지는 성공
  const run = () => new Promise((r) => { const me = k++; sent.n += 1; inflight += 1; peak = Math.max(peak, inflight); setTimeout(() => { inflight -= 1; r(me === 0 ? { ok: false, loggedIn: true } : { ok: true }); }, 10); });
  await Promise.all(Array.from({ length: 5 }, () => G.gateAccountLogin(srv('a_0000000000e1'), run, opts(sent))));
  assert.equal(sent.n, 5); assert.equal(sent.stopped.length, 0);
  assert.equal(peak, 4, `탐침 뒤 나머지 4대는 함께(예전에는 ‘모름’ 이라 하나씩 — 최대 1) · 지금 ${peak}`);
  // 로그인 자체가 안 된 실패(연결 실패)는 여전히 ‘모름’ — 다음 하나가 새 탐침(한꺼번에 풀지 않는다)
  G._resetAccountGateForTest({ now: clock });
  inflight = 0; peak = 0; k = 0;
  const run2 = () => new Promise((r) => { k += 1; inflight += 1; peak = Math.max(peak, inflight); setTimeout(() => { inflight -= 1; r({ ok: false, error: 'connect' }); }, 5); });
  await Promise.all(Array.from({ length: 4 }, () => G.gateAccountLogin(srv('a_0000000000e2'), run2, opts({ n: 0, stopped: [] }))));
  assert.equal(peak, 1, '연결 실패는 하나씩');
});

test('R2 · T4 코어가 로그인 뒤 실패에 loggedIn 을 싣는다(SSH 콜백 진입 · WinRM afterLogin) — 소스 대조(종단 재현은 hunt/winrm/gate.mjs: 3대 15초 → 10초)', () => {
  const src = fs.readFileSync(new URL('../src/sshaccess/readServer.js', import.meta.url), 'utf8');
  assert.match(src, /async \(\{ exec \}\) => \{ logged = true;/);
  assert.match(src, /loggedIn: logged \}\)\), '서버 읽기 시한 초과'\)/);
  assert.match(src, /loggedIn: e\?\.afterLogin === true/);
  const cl = fs.readFileSync(new URL('../src/winrm/client.js', import.meta.url), 'utf8');
  assert.ok(cl.indexOf('loggedIn = true;') > cl.indexOf('const created = await call(WS.ACTION.create'), 'AUTHENTICATE 응답을 받은 뒤에만 로그인으로 친다');
});

test('S8 사용 기록 읽기 오류는 손상이 아니다 — 원본을 옮기지 않고 · 다시 읽기 전에는 쓰지 않고 · 다시 읽으면 합친다', async () => {
  const U = await import('../src/sshaccess/usage.js');
  const F = path.join(DIR, 'ssh-key-usage.json');
  const FP = 'ACCT:a_0000000000f1';
  const old = { rows: [{ fingerprint: FP, keyName: 'k', server: 's1', corp: 'vcA', feature: 'bm-usage', firstAt: 1000, lastAt: Date.now() - 1000, count: 7, okCount: 7, failCount: 0, lastOk: true, lastCode: 'ok' }], recent: [] };
  // 읽기 오류 흉내 — 파일 자리에 디렉터리(EISDIR · 시스템 코드)
  fs.rmSync(F, { force: true, recursive: true }); fs.mkdirSync(F);
  U._resetKeyUsageForTest();
  U.noteKeyUse({ fingerprint: FP, server: 's1', corp: 'vcA', feature: 'bm-usage', ok: true, code: 'ok' });
  assert.equal(fs.readdirSync(DIR).some((f) => f.startsWith('ssh-key-usage.json.corrupt')), false, '읽기 오류는 보존본으로 옮기지 않는다');
  assert.equal(U.flushKeyUsage().reason, 'read-error', '다시 읽기 전에는 쓰지 않는다');
  assert.ok(fs.statSync(F).isDirectory());
  // 사람이 고침(원본 복구) — 시간이 지나면 다시 읽어 합친 뒤 쓴다
  fs.rmdirSync(F); fs.writeFileSync(F, JSON.stringify(old));
  const r = U.flushKeyUsage({ now: Date.now() + 31_000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  const saved = JSON.parse(fs.readFileSync(F, 'utf8'));
  assert.equal(saved.rows.length, 1); assert.equal(saved.rows[0].count, 8, '원본 7 + 메모리 1');
  // 손상(JSON 아님)은 예전대로 보존 후 빈 기록
  fs.writeFileSync(F, '{nope'); U._resetKeyUsageForTest();
  assert.equal(U.keyUsageLoadFailed(), true);
  assert.equal(fs.readdirSync(DIR).some((f) => f.startsWith('ssh-key-usage.json.corrupt')), true);
  U._resetKeyUsageForTest();
});

test('W6 코어 결과 코드 목록은 웹 문구 시험(web/src/views/tools/serverInfoText.test.js)의 목록과 같다', async () => {
  const RS = await import('../src/sshaccess/readServer.js');
  assert.deepEqual([...RS.READ_CODES], ['ok', 'not-found', 'registry-unreadable', 'edge-delegated', 'disabled', 'not-configured', 'cred', 'auth-rejected', 'same-cred-rejected',
    'hostkey', 'tls', 'timeout', 'exec-timeout', 'exec-truncated', 'connect', 'no-plan']);
});

test('U7 · U8 ssh 실행 — 덩어리 경계의 UTF-8 글자를 잇는다 · 상한에 걸린 마지막 덩어리도 상한까지 싣는다(partial)', async () => {
  const crypto = await import('node:crypto');
  const ssh2 = (await import('ssh2')).default;
  const SX = await import('../src/proxy/sshExec.js');
  process.env.SSH_HOSTKEY_POLICY = 'observe';
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const sshd = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === 'P-1' ? ctx.accept() : ctx.reject(['password'])));
    client.on('ready', () => client.on('session', (acc) => acc().on('exec', (a, _r, info) => {
      const st = a();
      if (info.command === 'ko') { const b = Buffer.from('가나다\n', 'utf8'); st.write(b.subarray(0, 1)); setTimeout(() => { st.write(b.subarray(1, 5)); setTimeout(() => { st.write(b.subarray(5)); st.exit(0); st.end(); }, 20); }, 20); return; }
      const chunk = Buffer.alloc(4096, 0x61);
      let i = 0; const tick = () => { if (i++ < 40) { st.write(chunk); setTimeout(tick, 2); } else { st.exit(0); st.end(); } }; tick();
    })));
    client.on('error', () => {});
  });
  await new Promise((r) => sshd.listen(0, '127.0.0.1', r));
  try {
    const creds = { host: '127.0.0.1', port: sshd.address().port, username: 'u', password: 'P-1', singlePasswordAttempt: true };
    const ko = await SX.withSsh(creds, async ({ exec }) => exec('ko', 10_000));
    assert.equal(ko.stdout, '가나다\n', `깨진 글자 없음 — ${JSON.stringify(ko.stdout)}`);
    const big = await SX.withSsh(creds, async ({ exec }) => exec('big', 10_000, { partial: true, maxBytes: 64 * 1024 }));
    assert.equal(big.truncated, true);
    assert.equal(big.stdout.length, 64 * 1024, `상한까지 — ${big.stdout.length}`);
  } finally { sshd.close(); }
});
