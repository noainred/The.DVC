/**
 * 점검 2회차(2026-11-20 · ‘버그 안 나올 때까지’) — 계정 탐침 문 · 로그인 표시 회귀.
 * H1 메모리 정지 만료 · M1/Q1 망 끊김 직렬(탐침 순위 · 연속 ‘모름’ 건너뛰기) · B1 비밀번호를 보낸 뒤 판정 모름 · Q4 정지 풀기가 메모리 정지도 · Q1(b) 폴러 로그인 표시.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'hunt2-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.SSH_HOSTKEY_POLICY = 'observe';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const G = await import('../src/sshaccess/accountGate.js');
const ST = await import('../src/sshaccess/state.js');
const LM = await import('../src/sshaccess/loginMark.js');

const t0 = Math.floor(Date.now() / 3_600_000) * 3_600_000;   // 정시 경계(실제 시각 기준)
let now = t0;
const clock = () => now;
const hex = (n) => n.toString(16).padStart(12, '0');
const srv = (acc, sid, ver = 'v1') => ({ credAccountId: acc, credVersion: ver, credAccountName: acc, name: sid, id: sid });
const opts = (log) => ({ feature: 'bm-usage', rejected: (r) => r?.authFailed === true, stopped: (code) => { log.stopped.push(code); return { ok: false, gated: code }; } });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('H1 · Q4 메모리 정지(정지 기록을 못 쓸 때)는 만료되면 다시 걸린다 · 사람이 풀면 메모리 정지도 풀린다', async () => {
  G._resetAccountGateForTest({ now: clock });
  // 정지 기록 상한을 채워 setAccountStop 이 too-many 로 실패하게 한다(디스크 쓰기 실패와 같은 갈래)
  for (let i = 1; i <= 500; i += 1) { const r = ST.setAccountStop(`a_${hex(i)}`, { server: 'x', feature: 'f', version: '1' }); if (!r.ok) break; }
  const A = `a_${hex(0xabc)}`;
  assert.equal(ST.setAccountStop(A, { version: 'zz' }).code, 'too-many', '상한이 찼다');
  const log = { n: 0, stopped: [] };
  const run = () => { log.n += 1; return Promise.resolve({ ok: false, authFailed: true }); };
  const round = async () => { for (let i = 0; i < 8; i += 1) await G.gateAccountLogin(srv(A, `s${i}`), run, opts(log)); };
  await round();
  assert.equal(log.n, 1, '첫 거부 뒤 메모리 정지');
  now += 10 * 60_000; await round();
  assert.equal(log.n, 1, '1시간 안에는 보내지 않는다');
  now += 61 * 60_000; await round();
  assert.equal(log.n, 2, `만료 뒤 탐침 하나 → 거부 → 다시 메모리 정지(예전에는 만료된 항목이 남아 8대 모두 — 재현 20/20) · 지금 ${log.n}`);
  now += 5 * 60_000; await round();
  assert.equal(log.n, 2, '다시 건 메모리 정지가 듣는다');
  // Q4: 사람이 ‘정지 풀기’(디스크 줄은 없음 — already) → 메모리 정지도 풀린다
  assert.equal(ST.clearAccountStop(A, { by: 't' }).already, true);
  await G.gateAccountLogin(srv(A, 's0'), run, opts(log));
  assert.equal(log.n, 3, '정지 풀기 뒤에는 탐침이 나간다');
  // 상한 정리(다음 시험이 정지 기록을 쓸 수 있게)
  for (let i = 1; i <= 500; i += 1) ST.clearAccountStop(`a_${hex(i)}`, { by: 't' });
});

test('M1 · Q1 탐침이 ‘모름’(연결 실패)이면 최근에 붙었던 서버가 다음 탐침 · 세 번 연달으면 남은 대기자는 보내지 않는다 · 접속하지 않은 결과는 세지 않는다', async () => {
  G._resetAccountGateForTest({ now: clock });
  const A = `a_${hex(0xb01)}`;
  const log = { n: 0, stopped: [] };
  const order = [];
  const dead = new Set(['d1', 'd2', 'd3', 'd4', 'd5']);
  const run = (sid) => () => new Promise((r) => { order.push(sid); log.n += 1; setTimeout(() => r(dead.has(sid) ? { ok: false, error: 'ECONNREFUSED' } : { ok: true }), 5); });
  // 앞 주기: h1 이 붙었다(순위 0)
  await G.gateAccountLogin(srv(A, 'h1'), run('h1'), opts(log));
  now += 5 * 60_000; order.length = 0;
  // 이번 주기: 죽은 서버 둘이 먼저 줄을 서도 두 번째 탐침은 h1
  await Promise.all(['d1', 'd2', 'h1', 'h2'].map((sid) => G.gateAccountLogin(srv(A, sid), run(sid), opts(log))));
  assert.deepEqual(order.slice(0, 2), ['d1', 'h1'], `최근에 붙었던 서버가 다음 탐침 — ${order.join(' ')}`);
  // 망 끊김: 모두 죽음 · 아무도 최근 성공 없음 — 탐침 셋이 연달아 ‘모름’ 이면 나머지는 보내지 않는다(비밀번호 0)
  G._resetAccountGateForTest({ now: clock });
  const B = `a_${hex(0xb02)}`;
  const lb = { n: 0, stopped: [] };
  const runB = () => new Promise((r) => { lb.n += 1; setTimeout(() => r({ ok: false, error: 'connect timeout' }), 5); });
  const t1 = Date.now();
  await Promise.all(Array.from({ length: 10 }, (_, i) => G.gateAccountLogin(srv(B, `x${i}`), runB, opts(lb))));
  assert.equal(lb.n, G.PROBE_MISS_MAX, `탐침 ${G.PROBE_MISS_MAX}개만 — 예전에는 10개 직렬(재현 40대 × 15초 ≈ 10분) · 지금 ${lb.n}`);
  assert.equal(lb.stopped.filter((c) => c === 'account-probe-unreached').length, 10 - G.PROBE_MISS_MAX);
  assert.ok(Date.now() - t1 < 1000);
  // 잠시 뒤(같은 주기) 오는 접속도 보내지 않는다 · 시간이 지나면(다음 주기) 다시 탐침 — 이번엔 앞 주기에 실패한 서버(순위 2)보다 모르는 서버(순위 1)가 먼저
  now += 30_000;
  await G.gateAccountLogin(srv(B, 'x9'), runB, opts(lb));
  assert.equal(lb.n, G.PROBE_MISS_MAX);
  now += G.PROBE_MISS_HOLD_MS + 1;
  const ord2 = [];
  const runC = (sid) => () => new Promise((r) => { ord2.push(sid); setTimeout(() => r(sid.startsWith('x') ? { ok: false, error: 'ECONNREFUSED' } : { ok: true }), 5); });
  await Promise.all(['x0', 'x1', 'y-new'].map((sid) => G.gateAccountLogin(srv(B, sid), runC(sid), opts(lb))));
  // 먼저 온 접속은 곧바로 탐침(뒤에 누가 올지 모른다) — 그 다음 탐침은 대기자 중 ‘모름’ 이었던 서버(x1)보다 모르는 서버(y-new)
  assert.deepEqual(ord2.slice(0, 2), ['x0', 'y-new'], `대기자 중 앞에서 ‘모름’ 이었던 서버보다 모르는 서버가 먼저 탐침 — ${ord2.join(' ')}`);
  // 접속하지 않은 결과(전역 슬롯 가득 — busy)는 ‘모름’ 연속에 세지 않는다
  G._resetAccountGateForTest({ now: clock });
  const C = `a_${hex(0xb03)}`;
  const lc = { n: 0, stopped: [] };
  const runBusy = () => { lc.n += 1; return Promise.resolve({ ok: false, busy: true }); };
  for (let i = 0; i < 6; i += 1) await G.gateAccountLogin(srv(C, `b${i}`), runBusy, opts(lc));
  assert.equal(lc.n, 6); assert.equal(lc.stopped.length, 0, 'busy 는 건너뛰기를 부르지 않는다');
});

test('B1 비밀번호를 보낸 뒤 판정을 받지 못한 탐침 — 남은 대기자에게 보내지 않고 · 연달아 세 번이면 계정 정지(cause timeout) · 성공이면 지운다', async () => {
  G._resetAccountGateForTest({ now: clock });
  const A = `a_${hex(0xc01)}`;
  const log = { n: 0, stopped: [] };
  const run = () => new Promise((r) => { log.n += 1; setTimeout(() => r(LM.markPasswordSent({ ok: false, error: 'Timed out while waiting for handshake' })), 5); });
  for (let cyc = 1; cyc <= G.SENT_STOP_AFTER; cyc += 1) {
    await Promise.all(Array.from({ length: 4 }, (_, i) => G.gateAccountLogin(srv(A, `s${i}`), run, opts(log))));
    // 3회차: 한 대의 ‘sent’ 는 그 서버의 느림일 수 있어 다음 서버가 탐침 — 서로 다른 서버가 SENT_CHAIN_MAX 번 연달아야 계정 보류(예전 2회차 이전: 대기자마다)
    assert.equal(log.n, cyc * G.SENT_CHAIN_MAX, `주기마다 ${G.SENT_CHAIN_MAX}번까지만 · 주기 ${cyc}`);
    now += 5 * 60_000;
  }
  const st = ST.accountStopFor(A, 'v1');
  assert.ok(st && st.cause === 'timeout', `세 번 연달으면 계정 정지 · ${JSON.stringify(st)}`);
  assert.ok(log.stopped.includes('account-login-unknown'));
  await G.gateAccountLogin(srv(A, 's0'), run, opts(log));
  assert.equal(log.n, G.SENT_STOP_AFTER * G.SENT_CHAIN_MAX, '정지 뒤에는 보내지 않는다');
  // 성공 한 번이면 연속 수를 지운다
  G._resetAccountGateForTest({ now: clock });
  const B = `a_${hex(0xc02)}`;
  let k = 0;
  const run2 = () => Promise.resolve(++k === 2 ? { ok: true } : LM.markPasswordSent({ ok: false }));
  for (let i = 0; i < 4; i += 1) { await G.gateAccountLogin(srv(B, 'z'), run2, opts({ n: 0, stopped: [] })); now += 5 * 60_000; }
  assert.equal(ST.accountStopFor(B, 'v1'), null, '중간에 성공이 있으면 정지하지 않는다');
});

test('Q1(b) · B1 스토리지 수집 — 로그인 뒤 실패(df 마운트 없음)는 로그인 표시 · 판정 전 시한은 비밀번호 송신 표시 · 연결 거부는 표시 없음', async () => {
  const ssh2 = (await import('ssh2')).default;
  const C = await import('../src/bmstor/collect.js');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const sshd = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method !== 'password') return ctx.reject(['password']);
      if (ctx.password === 'slow') return void setTimeout(() => { try { ctx.reject(['password']); } catch { /* 끊김 */ } }, 2500);
      return ctx.password === 'P-1' ? ctx.accept() : ctx.reject(['password']);
    });
    client.on('ready', () => client.on('session', (acc) => acc().on('exec', (a) => { const st = a(); st.write('Filesystem 1024-blocks Used Available Capacity Mounted on\n'); st.exit(0); st.end(); })));
    client.on('error', () => {});
  });
  await new Promise((r) => sshd.listen(0, '127.0.0.1', r));
  const prev = process.env.BMSTOR_SSH_TIMEOUT_MS;
  process.env.BMSTOR_SSH_TIMEOUT_MS = '1200';
  try {
    const base = { host: '127.0.0.1', port: sshd.address().port, username: 'u', mounts: ['/data'] };
    const a = await C.collectServer({ ...base, password: 'P-1' });
    assert.equal(a.ok, false); assert.equal(LM.wasLoggedIn(a), true, 'df 에 마운트가 없어도 로그인은 됐다');
    const b = await C.collectServer({ ...base, password: 'slow' });
    assert.equal(b.ok, false); assert.equal(b.authFailed, undefined); assert.equal(LM.wasPasswordSent(b), true, `판정 전 시한 — 비밀번호는 갔다 · ${b.error}`);
    const c = await C.collectServer({ ...base, port: 1, password: 'P-1' });
    assert.equal(LM.wasPasswordSent(c), false); assert.equal(LM.wasLoggedIn(c), false, '연결 거부 — 비밀번호 안 감');
  } finally { sshd.close(); if (prev == null) delete process.env.BMSTOR_SSH_TIMEOUT_MS; else process.env.BMSTOR_SSH_TIMEOUT_MS = prev; }
});

test('Q2 · W2-1 승인 · 미지정 OS 여러 대는 등록부 한 번 쓰기(서버 수에 곱으로 늘지 않는다) · 고른 확인 서버가 대상 밖이면 후보를 돌려준다', async () => {
  const VAULT = await import('../src/security/secretVault.js');
  VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
  const BM = await import('../src/bmstor/registry.js');
  const { addrKey } = await import('../src/bmusage/onboard/bindRule.js');
  const SA = await import('../src/sshaccess/service.js');
  const { store } = await import('../src/store.js');
  store.snapshot = { ...store.get(), vcenters: [{ id: 'vcQ', name: 'Q' }] };
  const mk = (n, tag) => Array.from({ length: n }, (_, i) => ({ name: `${tag}-${i}`, host: `10.${tag === 'a' ? 1 : 2}.${Math.floor(i / 250)}.${(i % 250) + 1}`, port: 22, vcenterId: 'vcQ', os: 'linux', addrOnly: true, mounts: ['/'] }));
  assert.equal(BM.applyBmServerBatch([...mk(40, 'a'), ...mk(400, 'b')]).ok, true);
  const pick = (tag) => BM.listBmServersRaw().filter((s) => s.name.startsWith(`${tag}-`));
  const body = (xs) => ({ ids: xs.map((s) => s.id), expectAddrs: Object.fromEntries(xs.map((s) => [s.id, addrKey(s.host, s.port, s.username)])), expectKeys: Object.fromEntries(xs.map((s) => [s.id, BM.inheritKeyOf(s)])), by: 't' });
  const timeOf = async (fn) => { const a = process.hrtime.bigint(); const r = await fn(); return { r, ms: Number(process.hrtime.bigint() - a) / 1e6 }; };
  const small = await timeOf(() => SA.approveInherit(body(pick('a'))));
  const big = await timeOf(() => SA.approveInherit(body(pick('b'))));
  assert.equal(small.r.ok, true, JSON.stringify(small.r)); assert.equal(big.r.approved, 400);
  // 서버마다 persist 면 10배 대수에 시간이 약 10배 이상(매번 등록부 전체) — 한 번 쓰기면 비슷하다(비율 · 여유 크게)
  assert.ok(big.ms < Math.max(small.ms, 5) * 8, `한 번 쓰기 — 40대 ${small.ms.toFixed(0)}ms · 400대 ${big.ms.toFixed(0)}ms`);
  assert.ok(pick('b').every((s) => BM.inheritActive(s)));
  // 미지정으로도 한 번 쓰기
  const os1 = await timeOf(() => SA.setServersOs({ ids: pick('b').map((s) => s.id), os: '' }));
  assert.equal(os1.r.ok, true); assert.equal(os1.r.changed, 400); assert.ok(pick('b').every((s) => !s.os));
  // W2-1: 고른 확인 서버가 승인으로 계정을 쓰게 되는 서버가 아니면 후보(조용히 첫 대로 바꾸지 않는다)
  const KS = await import('../src/bmusage/onboard/keyStore.js');
  const acc = KS.saveAccount({ name: 'q-lin', kind: 'os', corp: 'vcQ', os: 'linux', username: 'qq', password: 'Q-1' }, { by: 't' }).account;
  ST.setAssign('vcQ', 'linux', { account: acc.id, auth: '' }, { by: 't' });
  const fresh = BM.applyBmServerBatch(mk(2, 'a').map((x, i) => ({ ...x, name: `w-${i}`, host: `10.9.9.${i + 1}` })));
  assert.equal(fresh.ok, true);
  const ws = BM.listBmServersRaw().filter((s) => s.name.startsWith('w-'));
  const other = pick('a')[0];   // 이미 승인된 서버 — 이번 승인 대상이 아니다
  const nv = await SA.approveInherit({ ...body(ws), verifyServerId: other.id, dryRun: true });
  assert.equal(nv.code, 'need-verify', JSON.stringify(nv)); assert.deepEqual(nv.candidates.map((c) => c.id).sort(), ws.map((s) => s.id).sort());
});

test('W2-2 ‘직접 켜야’ 표시 — 설치 · 준비 기능 이름은 placement 한 곳(installCred 가 같은 목록) · 화면 카탈로그가 explicit 로 싣는다', async () => {
  const PL = await import('../src/bmusage/onboard/placement.js');
  const IC = await import('../src/focusmon/audit/installCred.js');
  assert.deepEqual([...IC.CRED_FEATURES], [IC.INSTALL_FEATURE, IC.PREP_FEATURE]);
  assert.equal(IC.CRED_FEATURES, PL.KEY_EXPLICIT_FEATURES);
  const SA = await import('../src/sshaccess/service.js');
  const v = await SA.buildView();
  const ex = Object.fromEntries(v.features.map((f) => [f.id, f.explicit]));
  for (const f of ['server-cmd', 'disk-audit-install', 'focus-mon-prep']) assert.equal(ex[f], true, f);
  assert.equal(ex['bm-usage'], false);
});
