/**
 * 점검 3회차(2026-11-20 · ‘버그 안 나올 때까지’) — 2회차 수정의 회귀(탐침 문 ‘sent’ · 빠른 길 · 통로) · 서버 단독 비밀번호 정지 해제 · 결측 사유.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'hunt3-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const G = await import('../src/sshaccess/accountGate.js');
const ST = await import('../src/sshaccess/state.js');
const LM = await import('../src/sshaccess/loginMark.js');

let now = Math.floor(Date.now() / 3_600_000) * 3_600_000;   // 정시 경계(실제 시각 기준)
const clock = () => now;
const hex = (n) => n.toString(16).padStart(12, '0');
const srv = (acc, sid, ver = 'v1') => ({ credAccountId: acc, credVersion: ver, credAccountName: acc, name: sid, id: sid });
const opts = (log, extra = {}) => ({ feature: 'bm-usage', rejected: (r) => r?.authFailed === true, stopped: (code) => { log.stopped.push(code); return { ok: false, gated: code }; }, ...extra });
const pool = async (items, n, fn) => { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k]); } })); };

test('R3-1 · F1 아픈 서버 한 대(비밀번호 송신 뒤 시한)가 같은 계정의 정상 서버를 막지 않는다 · 정지하지 않는다', async () => {
  G._resetAccountGateForTest({ now: clock });
  const A = `a_${hex(0xd01)}`;
  const ids = Array.from({ length: 10 }, (_, i) => `s${i}`);
  const run = (sid) => () => new Promise((r) => setTimeout(() => r(sid === 's0' ? LM.markPasswordSent({ ok: false, error: 'Timed out while waiting for handshake' }) : { ok: true }), 5));
  for (let cyc = 0; cyc < 4; cyc += 1) {
    const log = { stopped: [] }; let ok = 0;
    await pool(ids, 4, async (sid) => { const r = await G.gateAccountLogin(srv(A, sid), run(sid), opts(log)); if (r.ok) ok += 1; });
    assert.equal(ok, 9, `주기 ${cyc}: 정상 9대 수집(2회차 판은 0대 · 3주기에 정지 — 재현) · 막힘 ${log.stopped.join(',')}`);
    now += 10 * 60_000;
  }
  assert.equal(ST.accountStopFor(A, 'v1'), null, '정지하지 않는다');
});

test('F1(b) · R3-2 빠른 길에서 동시에 나간 ‘sent’ 여러 대는 그 서버들만 — 정지 · 보류 없음', async () => {
  G._resetAccountGateForTest({ now: clock });
  const A = `a_${hex(0xd02)}`;
  const log = { stopped: [] };
  await G.gateAccountLogin(srv(A, 'h'), () => Promise.resolve({ ok: true }), opts(log));   // 빠른 길 열림
  const slow = new Set(['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7']);
  const ids = Array.from({ length: 14 }, (_, i) => (i < 7 ? `x${i + 1}` : `y${i}`));
  await Promise.all(ids.map((sid) => G.gateAccountLogin(srv(A, sid), () => new Promise((r) => setTimeout(() => r(slow.has(sid) ? LM.markPasswordSent({ ok: false }) : { ok: true }), slow.has(sid) ? 20 : 5)), opts(log))));
  assert.equal(ST.accountStopFor(A, 'v1'), null, '빠른 길의 sent 로는 정지하지 않는다(2회차 판은 곧바로 정지 — 재현)');
  assert.equal(log.stopped.length, 0);
  // 빠른 길은 그대로 열려 있다(느린 서버의 sent 가 빠른 길을 닫지 않는다 — 다음 접속들이 탐침을 기다리지 않고 함께)
  let inflight = 0; let peak = 0;
  const two = () => new Promise((r) => { inflight += 1; peak = Math.max(peak, inflight); setTimeout(() => { inflight -= 1; r({ ok: true }); }, 10); });
  await Promise.all([G.gateAccountLogin(srv(A, 'p1'), two, opts(log)), G.gateAccountLogin(srv(A, 'p2'), two, opts(log)), G.gateAccountLogin(srv(A, 'p3'), two, opts(log))]);
  assert.equal(peak, 3, `빠른 길 유지 — 동시 ${peak}`);
  let next = 0;
  await G.gateAccountLogin(srv(A, 'z-new'), () => { next += 1; return Promise.resolve({ ok: true }); }, opts(log));
  assert.equal(next, 1, '뒤에 오는 접속도 보류하지 않는다');
});

test('B1 유지 — 탐침이 연달아 ‘sent’(서로 다른 서버)면 남은 서버에 보내지 않고 · 그런 주기가 세 번이면 정지 · 사람이 풀면 새로 센다', async () => {
  G._resetAccountGateForTest({ now: clock });
  const A = `a_${hex(0xd03)}`;
  let sent = 0;
  const run = () => new Promise((r) => { sent += 1; setTimeout(() => r(LM.markPasswordSent({ ok: false })), 5); });
  for (let cyc = 1; cyc <= G.SENT_STOP_AFTER; cyc += 1) {
    const log = { stopped: [] };
    await pool(Array.from({ length: 8 }, (_, i) => `z${i}`), 4, (sid) => G.gateAccountLogin(srv(A, sid), run, opts(log)));
    assert.equal(sent, cyc * G.SENT_CHAIN_MAX, `주기마다 ${G.SENT_CHAIN_MAX}번까지만(예전 2회차 이전: 대기자마다)`);
    now += 5 * 60_000;
  }
  assert.equal(ST.accountStopFor(A, 'v1')?.cause, 'timeout');
  // 사람이 풀면 연속 수를 새로 센다(R3-1 원인 4 — 예전에는 다음 주기 첫 보류에서 곧바로 다시 정지)
  ST.clearAccountStop(A, { by: 't' });
  await pool(Array.from({ length: 4 }, (_, i) => `z${i}`), 4, (sid) => G.gateAccountLogin(srv(A, sid), run, opts({ stopped: [] })));
  assert.equal(ST.accountStopFor(A, 'v1'), null, '풀린 뒤 한 주기로는 다시 정지하지 않는다');
});

test('R3-5 집중 모니터링의 성공(freshMs 짧게)은 주기 수집의 빠른 길을 오래 열어 두지 않는다', async () => {
  G._resetAccountGateForTest({ now: clock });
  const A = `a_${hex(0xd04)}`;
  await G.gateAccountLogin(srv(A, 'f'), () => Promise.resolve({ ok: true }), opts({ stopped: [] }, { freshMs: G.FOCUS_FRESH_MS }));
  now += G.FOCUS_FRESH_MS + 1_000;   // 집중 분이 지난 뒤 — 주기 수집 시작(그 사이 비밀번호가 바뀜)
  let sent = 0;
  const log = { stopped: [] };
  await Promise.all(Array.from({ length: 20 }, (_, i) => G.gateAccountLogin(srv(A, `q${i}`), () => new Promise((r) => { sent += 1; setTimeout(() => r({ ok: false, authFailed: true }), 5); }), opts(log))));
  assert.equal(sent, 1, `탐침 하나 — 집중 세션이 빠른 길을 열어 두면 20회(재현) · 지금 ${sent}`);
});

test('W3-3 ‘모름’ 연속은 통로별 — SSH 폴러의 연결 거부 연속이 같은 계정의 WinRM 읽기를 막지 않는다', async () => {
  G._resetAccountGateForTest({ now: clock });
  const A = `a_${hex(0xd05)}`;
  const log = { stopped: [] };
  for (let i = 0; i < 5; i += 1) await G.gateAccountLogin(srv(A, `w${i}`), () => Promise.resolve({ ok: false, error: 'ECONNREFUSED' }), opts(log, { channel: 'ssh' }));
  assert.ok(log.stopped.includes('account-probe-unreached'), 'SSH 는 건너뜀');
  let ran = 0;
  await G.gateAccountLogin(srv(A, 'w0'), () => { ran += 1; return Promise.resolve({ ok: true }); }, opts({ stopped: [] }, { channel: 'winrm' }));
  assert.equal(ran, 1, 'WinRM 은 그대로 시도한다');
});

test('F3 결측 사유 — 계정 정지는 인증 정지 · 망 끊김 건너뜀은 접속 불가 · 판정 모름 보류는 시한(키 설정이 아니다)', async () => {
  const { osMissOf } = await import('../src/bmusage/missReason.js');
  assert.equal(osMissOf({ ok: false, authErrorCode: 'account-stopped' }), 'auth-stopped');
  assert.equal(osMissOf({ ok: false, authErrorCode: 'account-probe-unreached' }), 'unreachable');
  assert.equal(osMissOf({ ok: false, authErrorCode: 'account-login-unknown' }), 'timeout');
  assert.equal(osMissOf({ ok: false, authErrorCode: 'key-folder' }), 'cred-config');
});

test('N1 ② 같은 서버의 ‘sent’ 되풀이(집중 모니터링 한 대)는 그 서버만 쉰다 — 계정 보류 · 정지 없음 · 다른 서버는 그대로', async () => {
  G._resetAccountGateForTest({ now: clock });
  const A = `a_${hex(0xd06)}`;
  let sent = 0;
  const slow = () => new Promise((r) => { sent += 1; setTimeout(() => r(LM.markPasswordSent({ ok: false })), 2); });
  for (let m = 0; m < 6; m += 1) { await G.gateAccountLogin(srv(A, 'slow1'), slow, opts({ stopped: [] }, { freshMs: G.FOCUS_FRESH_MS })); now += 60_000; }
  assert.equal(sent, G.SERVER_SENT_MAX, `그 서버는 ${G.SERVER_SENT_MAX}번 뒤 쉰다 · 지금 ${sent}`);
  assert.equal(ST.accountStopFor(A, 'v1'), null, '계정은 정지하지 않는다(2회차 판은 5분 만에 정지 — 재현)');
  let other = 0;
  await G.gateAccountLogin(srv(A, 'ok1'), () => { other += 1; return Promise.resolve({ ok: true }); }, opts({ stopped: [] }));
  assert.equal(other, 1, '같은 계정의 다른 서버는 그대로');
});

test('L2 거부를 본 순간 상태 파일을 못 읽으면 메모리 정지를 건다(‘이미 정지’ 로 보지 않는다)', async () => {
  G._resetAccountGateForTest({ now: clock });
  const A = `a_${hex(0xd07)}`;
  const F = path.join(DIR, ST.STATE_FILE_NAME);
  const had = fs.existsSync(F) ? fs.readFileSync(F) : null;
  let sent = 0;
  const run = () => { sent += 1; fs.rmSync(F, { force: true }); fs.mkdirSync(F); ST._resetSshAccessStateForTest(); return Promise.resolve({ ok: false, authFailed: true }); };
  try {
    await G.gateAccountLogin(srv(A, 'r1'), run, opts({ stopped: [] }));
    fs.rmSync(F, { recursive: true, force: true }); if (had) fs.writeFileSync(F, had); ST._resetSshAccessStateForTest();
    await G.gateAccountLogin(srv(A, 'r2'), run, opts({ stopped: [] }));
    assert.equal(sent, 1, '다시 읽힌 뒤에도 같은 틀린 비밀번호를 보내지 않는다(메모리 정지 — 재현 2회)');
  } finally { try { fs.rmSync(F, { recursive: true, force: true }); if (had) fs.writeFileSync(F, had); } catch { /* */ } ST._resetSshAccessStateForTest(); }
});

test('F2 · F4 · F5 — 정지 사유가 화면 응답에 실린다 · 펼쳐도 로그인 표시를 잇고 스토리지 정지를 푼다 · 못 읽음 정지는 그 사유 그대로', async () => {
  const VAULT = await import('../src/security/secretVault.js');
  VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
  const KS = await import('../src/bmusage/onboard/keyStore.js');
  const SA = await import('../src/sshaccess/service.js');
  const acc = KS.saveAccount({ name: 'h3-acc', kind: 'os', corp: '', os: 'linux', username: 'u3', password: 'P-3' }, { by: 't' }).account;
  assert.equal(ST.setAccountStop(acc.id, { server: 's', feature: 'bm-usage', version: KS.accountSecretVersion(KS.accountById(acc.id)), cause: 'timeout' }).ok, true);
  const v = await SA.buildView();
  const row = v.accounts.find((a) => a.id === acc.id);
  assert.equal(row?.stop?.cause, 'timeout', JSON.stringify(row?.stop));
  // F4: collectMany 가 결과를 펼쳐도 로그인 표시를 잇는다(폴러 noteAuth 가 그것으로 스토리지 인증 정지를 푼다)
  const C = await import('../src/bmstor/collect.js');
  const res = await C.collectMany([{ id: 'x' }], { collect: async () => LM.markLoggedIn({ ok: false, mounts: [], error: 'df 출력에서 요청 마운트를 찾지 못했습니다.' }) });
  assert.equal(LM.wasLoggedIn(res[0]), true);
  const src = fs.readFileSync(new URL('../src/bmstor/poller.js', import.meta.url), 'utf8');
  assert.match(src, /if \(r\?\.ok \|\| logged\) \{ authGuard\.clearAuthStop\(srv\.id\); return r; \}/);
  assert.match(src, /\{ logged: wasLoggedIn\(r\) \}\)/);
  // F5: 정지 문구는 authStopText 로(못 읽음 정지를 ‘거부’ 로 지어내지 않는다)
  const rs = fs.readFileSync(new URL('../src/sshaccess/readServer.js', import.meta.url), 'utf8');
  assert.match(rs, /reason: authStopText\(stop, \(x\) =>/);
});
