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

test('F1(b) · R3-2 · H2 빠른 길의 ‘sent’ — 짧은 끊김의 동시분은 한 번만 센다(정지 없음) · 빠른 길은 닫혀 다음은 탐침', async () => {
  G._resetAccountGateForTest({ now: clock });
  const A = `a_${hex(0xd02)}`;
  const log = { stopped: [] };
  await G.gateAccountLogin(srv(A, 'h'), () => Promise.resolve({ ok: true }), opts(log));   // 빠른 길 열림
  const slow = new Set(['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7']);
  const ids = Array.from({ length: 14 }, (_, i) => (i < 7 ? `x${i + 1}` : `y${i}`));
  await Promise.all(ids.map((sid) => G.gateAccountLogin(srv(A, sid), () => new Promise((r) => setTimeout(() => r(slow.has(sid) ? LM.markPasswordSent({ ok: false }) : { ok: true }), slow.has(sid) ? 20 : 5)), opts(log))));
  assert.equal(ST.accountStopFor(A, 'v1'), null, '빠른 길 동시분 7대 sent 로 정지하지 않는다(그 창은 한 번 — 2회차 판은 곧바로 정지)');
  // 빠른 길이 닫혀 다음 접속은 탐침 하나부터(4회차 H2 — 3회차 판은 창 끝까지 열어 두어 틀린 비밀번호가 98 · 120회)
  let inflight = 0; let peak = 0; const order = [];
  const two = (k) => () => new Promise((r) => { order.push(k); inflight += 1; peak = Math.max(peak, inflight); setTimeout(() => { inflight -= 1; r({ ok: true }); }, 10); });
  await Promise.all(['p1', 'p2', 'p3'].map((k) => G.gateAccountLogin(srv(A, k), two(k), opts(log))));
  assert.ok(peak <= 2, `탐침 하나 뒤 함께 — 동시 ${peak}`);
});

test('H2 · R4W-1 틀린 비밀번호 + 느린 거부 — 빠른 길 창의 동시분 뒤로는 탐침 2번까지(합 3) · 서버 한 대 계정도 3번이면 정지', async () => {
  G._resetAccountGateForTest({ now: clock });
  const A = `a_${hex(0xd08)}`;
  await G.gateAccountLogin(srv(A, 'h0'), () => Promise.resolve({ ok: true }), opts({ stopped: [] }));   // 주기 도중 성공(빠른 길)
  let sent = 0;
  const wrongSlow = () => new Promise((r) => { sent += 1; setTimeout(() => r(LM.markPasswordSent({ ok: false })), 10); });
  await Promise.all(Array.from({ length: 4 }, (_, i) => G.gateAccountLogin(srv(A, `f${i}`), wrongSlow, opts({ stopped: [] }))));   // 막을 수 없는 동시분
  const before = sent;
  await Promise.all(Array.from({ length: 40 }, (_, i) => G.gateAccountLogin(srv(A, `q${i}`), wrongSlow, opts({ stopped: [] }))));
  assert.equal(before, 4);
  assert.equal(sent - before, G.SENT_STOP_TOTAL - 1, `빠른 길 창(1) + 탐침 ${G.SENT_STOP_TOTAL - 1}번 뒤 정지 · 지금 ${sent - before}`);
  assert.equal(ST.accountStopFor(A, 'v1')?.cause, 'timeout');
  // 서버 한 대 계정: 30분 쉼 사이로 3번 → 정지(3회차 판은 30분마다 3회 되풀이 · 정지 없음)
  G._resetAccountGateForTest({ now: clock });
  const B = `a_${hex(0xd09)}`;
  let one = 0;
  for (let m = 0; m < 180; m += 5) { await G.gateAccountLogin(srv(B, 'only'), () => { one += 1; return Promise.resolve(LM.markPasswordSent({ ok: false })); }, opts({ stopped: [] })); now += 5 * 60_000; }
  assert.equal(one, G.SENT_STOP_TOTAL, `한 대 계정도 ${G.SENT_STOP_TOTAL}번 뒤 정지 · 지금 ${one}`);
  assert.equal(ST.accountStopFor(B, 'v1')?.cause, 'timeout');
});

test('H-1 · R4S-2 느리지만 맞는 서버 두 대에 집중 모니터링 + 정상 서버 주기 수집 — 정지하지 않고 정상 서버는 매 주기 수집', async () => {
  G._resetAccountGateForTest({ now: clock });
  const A = `a_${hex(0xd0a)}`;
  const slowRun = () => Promise.resolve(LM.markPasswordSent({ ok: false }));
  let healthy = 0;
  for (let t = 0; t < 30 * 60; t += 30) {   // 30분 · 30초 틱
    await G.gateAccountLogin(srv(A, t % 60 === 0 ? 'S1' : 'S2'), slowRun, opts({ stopped: [] }, { freshMs: G.FOCUS_FRESH_MS }));
    if (t % 300 === 150) {   // 5분마다 주기 수집(정상 서버 5대)
      const r = await Promise.all(Array.from({ length: 5 }, (_, i) => G.gateAccountLogin(srv(A, `H${i}`), () => Promise.resolve({ ok: true }), opts({ stopped: [] }))));
      healthy += r.filter((x) => x.ok).length;
    }
    now += 30_000;
  }
  assert.equal(ST.accountStopFor(A, 'v1'), null, '정지하지 않는다(3회차 판은 약 7분에 정지 — 재현 60~88%)');
  assert.equal(healthy, 30, '정상 서버는 6주기 × 5대 모두 수집');
});

test('M2 집중 모니터링의 성공은 주기 수집의 빠른 길을 열지 않는다 · R4S-1 그 서버 쉼은 빠른 길에서도', async () => {
  G._resetAccountGateForTest({ now: clock });
  const A = `a_${hex(0xd0b)}`;
  await G.gateAccountLogin(srv(A, 'f1'), () => Promise.resolve({ ok: true }), opts({ stopped: [] }, { freshMs: G.FOCUS_FRESH_MS }));
  const order = [];
  const run = (k) => () => new Promise((r) => { order.push(`s${k}`); setTimeout(() => { order.push(`e${k}`); r({ ok: true }); }, 10); });
  await Promise.all(Array.from({ length: 5 }, (_, i) => G.gateAccountLogin(srv(A, `b${i}`), run(i), opts({ stopped: [] }))));
  assert.deepEqual(order.slice(0, 2), ['s0', 'e0'], `집중 성공으로 빠른 길이 열리지 않는다 — 탐침 하나부터 · ${order.join(' ')}`);
  // R4S-1: 탐침에서 sent 를 낸 서버는 빠른 길이 열려 있어도 쉰다
  G._resetAccountGateForTest({ now: clock });
  const B = `a_${hex(0xd0c)}`;
  await G.gateAccountLogin(srv(B, 'S'), () => Promise.resolve(LM.markPasswordSent({ ok: false })), opts({ stopped: [] }));
  await G.gateAccountLogin(srv(B, 'H'), () => Promise.resolve({ ok: true }), opts({ stopped: [] }));   // 빠른 길 열림
  let sent = 0; const log = { stopped: [] };
  await G.gateAccountLogin(srv(B, 'S'), () => { sent += 1; return Promise.resolve({ ok: true }); }, opts(log));
  assert.equal(sent, 0, '쉬는 서버는 빠른 길로도 보내지 않는다'); assert.deepEqual(log.stopped, ['account-login-unknown']);
  // 사람이 풀면(세대) 그 서버 쉼도 풀린다(R4W-2 · L-2)
  ST.clearAccountStop(B, { by: 't' });
  await G.gateAccountLogin(srv(B, 'S'), () => { sent += 1; return Promise.resolve({ ok: true }); }, opts(log));
  assert.equal(sent, 1);
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

test('F3 · F4 결측 사유 — 계정 정지는 인증 정지 · 탐침 문이 보내지 않은 것은 gate-held(키 설정 · 미도달 · 시한이 아니다) · 목록 셋에 같이', async () => {
  const { osMissOf } = await import('../src/bmusage/missReason.js');
  assert.equal(osMissOf({ ok: false, authErrorCode: 'account-stopped' }), 'auth-stopped');
  // 4회차 F4-1 · F4-2: 탐침 문이 보내지 않은 것은 전용 code(‘iDRAC 미도달’ · ‘SSH 시한 초과’ 로 단정하지 않는다)
  assert.equal(osMissOf({ ok: false, authErrorCode: 'account-probe-unreached' }), 'gate-held');
  assert.equal(osMissOf({ ok: false, authErrorCode: 'account-login-unknown' }), 'gate-held');
  assert.equal(osMissOf({ ok: false, authErrorCode: 'key-folder' }), 'cred-config');
  const { HEALTH_REASON_CODES } = await import('../src/bmusage/collectHealth.js');
  const { FOCUS_MISS } = await import('../src/bmusage/focus/run.js');
  assert.ok(HEALTH_REASON_CODES.includes('gate-held') && FOCUS_MISS.includes('gate-held'));
  assert.match(fs.readFileSync(new URL('../src/central/bmPerfOpsPull.js', import.meta.url), 'utf8'), /'gate-held'\]\);/, '중앙 화이트리스트에도');
});

test('N1 ② 같은 서버의 ‘sent’(집중 모니터링 한 대)는 그 서버가 쉰다(30분) — 다른 서버의 성공이 수를 지운다 · 계정 정지 없음', async () => {
  G._resetAccountGateForTest({ now: clock });
  const A = `a_${hex(0xd06)}`;
  let sent = 0;
  const slow = () => new Promise((r) => { sent += 1; setTimeout(() => r(LM.markPasswordSent({ ok: false })), 2); });
  for (let m = 0; m < 6; m += 1) { await G.gateAccountLogin(srv(A, 'slow1'), slow, opts({ stopped: [] }, { freshMs: G.FOCUS_FRESH_MS })); now += 60_000; }
  assert.equal(sent, 1, `한 번 뒤 그 서버는 쉰다 · 지금 ${sent}`);
  let other = 0;
  await G.gateAccountLogin(srv(A, 'ok1'), () => { other += 1; return Promise.resolve({ ok: true }); }, opts({ stopped: [] }));
  assert.equal(other, 1, '같은 계정의 다른 서버는 그대로');
  for (let m = 0; m < 3; m += 1) {
    now += 31 * 60_000;
    await G.gateAccountLogin(srv(A, 'slow1'), slow, opts({ stopped: [] }, { freshMs: G.FOCUS_FRESH_MS }));
    await G.gateAccountLogin(srv(A, `ok${m + 2}`), () => Promise.resolve({ ok: true }), opts({ stopped: [] }));
  }
  assert.equal(ST.accountStopFor(A, 'v1'), null, '다른 서버의 성공이 끼면 계정은 정지하지 않는다');
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

test('R4S-3 스토리지 중앙 수집은 장비 시한 안에서(세션을 끊는다) — 시한 > 로그인 + df + I/O 표본 · 탐침 대기는 시한 밖', async () => {
  const C = await import('../src/bmstor/collect.js');
  const env = { BMSTOR_SSH_TIMEOUT_MS: '15000', SSH_EXEC_TIMEOUT_MS: '60000', BMSTOR_IO_SAMPLE_SEC: '5' };
  assert.ok(C.collectDeadlineMs(env) > 15_000 + 60_000 + (5 + 20) * 1000, String(C.collectDeadlineMs(env)));
  assert.ok(C.collectDeadlineMs({ ...env, BMSTOR_IO_SAMPLE_SEC: '0' }) > 15_000 + 60_000);
  const src = fs.readFileSync(new URL('../src/bmstor/poller.js', import.meta.url), 'utf8');
  assert.match(src, /const gatedCollect = \(s\) => gateAccountLogin\(s, \(\) => \{[\s\S]{0,400}withDeadline\(collectDeadlineMs\(\), \(signal\) => collectServer\(s, \{ signal,/);
});
