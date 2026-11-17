// 결정 권장안 구현 반증(적대적 재검토) — G1a(서버 보안) 확정분 회귀.
//  R1  64 F7: 서명 시각 창(±10분) 밖으로만 거부된 script · ssh 항목은 assignKey 가 중앙과 같아 다시 내려오지 않았다 — 시계를 맞춰도
//      재시작 전까지 영원히 멈췄다(보류에 시한 없음). SKEW_MS 뒤 첫 폴에서 한 번 다시 받는다(서명 없음 · 불일치는 중앙 지문이 바뀔 때만).
//  R2  64 F2: 자동 되돌림을 포기한(revertGaveUp) 뒤 확정 · 새 적용 거절 문구가 '곧 되돌립니다' · '확정하거나' 로 사실과 달랐다.
//  R3  66 ①: 표시 이름이 겹친 담당 엣지의 iLO 전용 대역은 '엣지 버전 미상(중앙 재시작 직후이거나 미등록)' 으로 보류돼 진짜 사유(이름 겹침)가 보이지 않았다.
// 결정(사용자 '권장안대로') 이어서 구현:
//  R4  스케줄 서명 대상에 인스턴스(v2) — 같은 법인의 다른 인스턴스로 옮기면 불일치 · 옛(v1) 서명은 배정 지문(v2)이 바뀌어 곧바로 다시 내려간다.
//  R5  원격 명령 위험 등급 넓힘 — tcp-send · udp-send · http-request(POST · 본문)도 소유자 등급 + 본인 OTP(서버 · 웹 판정 대조).
//  R6  RMA 비밀번호 설정 · 해제 · 원격 배포도 소유자 등급 + 본인 OTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'rebut-decide-'));
process.env.CONFIG_DIR = CFG;
process.env.PORT = '4000';
process.env.AGENT_NAME = 'edge-rebut';
process.env.RMA_INSTANCE = 'edge-i1';
process.env.RMA_ALLOW_CUSTOM = 'true';
process.env.AUTH_ENABLED = 'true';
delete process.env.RMA_PASSWORD;

const { generateSecret, generateToken } = await import('../src/auth/totp.js');
const OTP_SECRETS = { own: generateSecret(), adm: generateSecret() };
fs.writeFileSync(path.join(CFG, 'users.json'), JSON.stringify({ users: [
  { username: 'own', role: 'admin', totpEnabled: true, totpSecret: OTP_SECRETS.own },
  { username: 'adm', role: 'admin', totpEnabled: true, totpSecret: OTP_SECRETS.adm },
] }));
fs.writeFileSync(path.join(CFG, 'security-session.json'), JSON.stringify({ settingsOwners: ['own'] }));
// 같은 카운터의 코드는 한 번만 통과한다(minCounter · 창 ±1) — 쓸 때마다 다음 카운터(지금-1 부터 지금+1 까지 — 계정당 3번)를 쓴다.
const otpLast = {};
const otpOf = (u) => {
  const c = Math.max(Math.floor(Date.now() / 30_000) - 1, (otpLast[u] ?? -Infinity) + 1);
  otpLast[u] = c;
  return generateToken(OTP_SECRETS[u], { counter: c });
};

const SG = await import('../src/rma/signing.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

after(() => { try { fs.rmSync(CFG, { recursive: true, force: true }); } catch { /* */ } });

// ── R1 ──────────────────────────────────────────────────────────────────────
test('R1 64 F7 — 시각 창 밖으로만 거부된 항목은 SKEW_MS 뒤 첫 폴에서 다시 받는다(영원히 멈추지 않는다) · 다시 받은 새 서명이면 실행 가능', async () => {
  const A = await import('../src/rma/agent.js');
  const now = Date.now();
  const item = (id) => ({ id, test: 'script', args: { command: 'true', timeoutMs: 5000 }, intervalSec: 60, enabled: true });
  // 엣지 시계가 중앙보다 20분 앞섰다 — 서명(HMAC)은 맞고 시각만 창 밖
  const skewed = SG.signScheduleTests('pw-edge', 'edge-rebut', [item('w1')], now - 20 * 60_000, 'edge-i1')[0];
  A.applySchedule({ version: 3, assignKey: 'k3', tests: [skewed] }, { password: 'pw-edge', now });
  assert.match(A._scheduleForTest().tests[0].sigIssue, /허용 오차/);
  assert.match(A._scheduleForTest().tests[0].sigIssue, /10분 안에/, '사유가 다시 받는 시점을 사실대로 말한다');
  assert.equal(A.scheduleAssignKeyForPoll(now), 'k3', '곧바로 재요청하지는 않는다(폴마다 전량 재전송 금지)');
  assert.equal(A.scheduleAssignKeyForPoll(now + SG.SKEW_MS), '', 'SKEW_MS 뒤에는 assignKey 를 비워 중앙이 새 서명으로 다시 내려보낸다(예전: 영원히 k3)');
  // 시계를 맞춘 뒤 중앙이 다시 내려보낸 사본 — 판정이 풀리고 재요청 표지도 지운다
  const fresh = SG.signScheduleTests('pw-edge', 'edge-rebut', [item('w1')], now + SG.SKEW_MS, 'edge-i1')[0];
  A.applySchedule({ version: 3, assignKey: 'k3', tests: [fresh] }, { password: 'pw-edge', now: now + SG.SKEW_MS + 1000 });
  assert.equal(A._scheduleForTest().tests[0].sigIssue, undefined);
  assert.equal(A.scheduleAssignKeyForPoll(now + 10 * SG.SKEW_MS), 'k3', '풀린 뒤에는 재요청하지 않는다');
  // 서명 불일치 · 서명 없음은 시간으로 풀리지 않는다 — 주기 재요청을 걸지 않는다(중앙 비밀번호를 고치면 :k 지문이 바뀌어 다시 내려간다)
  const wrong = SG.signScheduleTests('other-pw', 'edge-rebut', [item('w2')], now, 'edge-i1')[0];
  A.applySchedule({ version: 4, assignKey: 'k4', tests: [wrong, item('w3')] }, { password: 'pw-edge', now });
  assert.ok(A._scheduleForTest().tests.every((t) => t.sigIssue));
  assert.equal(A.scheduleAssignKeyForPoll(now + 10 * SG.SKEW_MS), 'k4');
});

// ── R2 ──────────────────────────────────────────────────────────────────────
const LIST_ALL = 'public (active)\n  target: default\n  services: ssh\n  ports: 4000/tcp 22/tcp\n  rich rules:\n';
function fakeFw(st) {
  return async (args) => {
    if (args[0] === '--state') return { ok: true, code: 0, stdout: 'running\n', stderr: '' };
    if (args[0] === '--get-default-zone') return { ok: true, code: 0, stdout: 'public\n', stderr: '' };
    if (args.includes('--list-all')) return { ok: true, code: 0, stdout: LIST_ALL, stderr: '' };
    if (args[0] === '--reload') { st.reloads++; return st.failReload > 0 ? (st.failReload--, { ok: false, code: 1, stdout: '', stderr: 'Error: COMMAND_FAILED' }) : { ok: true, code: 0, stdout: 'success', stderr: '' }; }
    return { ok: true, code: 0, stdout: 'success', stderr: '' };
  };
}
test('R2 64 F2 — 자동 되돌림을 포기한 뒤의 확정 · 새 적용 거절은 수동 조치 필요를 말한다(곧 되돌립니다 · 확정하거나 금지)', async () => {
  const S = await import('../src/hostaccess/service.js');
  const St = await import('../src/hostaccess/settings.js');
  St._resetHostAccessCache(); St.saveHostAccess({ pending: null, applied: null });
  const st = { reloads: 0, failReload: 1e9 };
  S._setExec({ fw: fakeFw(st), sshdCtl: async () => ({ ok: true }), sshdActive: async () => true, isSudoDenied: () => false });
  S._setRevertRetryMinMs(20); S._setRevertRetryWindowMs(150);
  try {
    assert.equal((await S.applyHostAccess({ ssh: { mode: 'deny' }, confirmMinutes: 1 }, { requesterIp: '10.1.1.1', by: 't' })).ok, true);
    // 포기 전(기한 안): 예전 문구 그대로
    const before = await S.applyHostAccess({ ssh: { mode: 'deny' }, confirmMinutes: 1 }, { requesterIp: '10.1.1.1', by: 't' });
    assert.match(before.errors.join(' '), /먼저 확정하거나 되돌리세요/);
    St.saveHostAccess({ pending: { ...St.loadHostAccess().pending, deadline: Date.now() + 10 } });
    await S.resumeHostAccessPending();
    for (let k = 0; k < 80 && St.loadHostAccess().pending?.revertGaveUp !== true; k++) await sleep(25);
    assert.equal(St.loadHostAccess().pending?.revertGaveUp, true);
    const c = await S.confirmHostAccess({ by: 'admin' });
    assert.equal(c.ok, false);
    assert.match(c.errors.join(' '), /수동 조치 필요/);
    assert.doesNotMatch(c.errors.join(' '), /곧 되돌립니다/, '자동 재시도를 멈췄는데 곧 되돌린다고 말했다');
    const a = await S.applyHostAccess({ ssh: { mode: 'deny' }, confirmMinutes: 1 }, { requesterIp: '10.1.1.1', by: 't' });
    assert.equal(a.ok, false);
    assert.match(a.errors.join(' '), /수동 조치 필요/);
    assert.doesNotMatch(a.errors.join(' '), /확정하거나/, '기한이 지나 확정할 수 없는데 확정하라고 했다');
    st.failReload = 0;
    assert.equal((await S.revertHostAccess({ by: 'admin' })).ok, true, '수동 되돌림으로 풀린다');
  } finally { S._setRevertRetryMinMs(); S._setRevertRetryWindowMs(); S._setExec(null); St.saveHostAccess({ pending: null, applied: null }); }
});

// ── R3 ──────────────────────────────────────────────────────────────────────
test('R3 66 ① — 표시 이름이 겹친 담당 엣지의 iLO 전용 대역 보류 사유는 이름 겹침을 말한다(재시작 직후 · 미등록 추측 금지)', async () => {
  const reg = await import('../src/collector/registry.js');
  const P = await import('../src/central/idracScanPush.js');
  for (const r of [
    { id: 'rb-a', name: 'rb-dup', url: 'https://10.9.2.21:3443', token: 'TOK-A', enabled: true },
    { id: 'rb-b', name: 'RB-DUP', url: 'https://10.9.2.22:3443', token: 'TOK-B', enabled: true },
  ]) { const x = reg.addCollector(r, { managed: true }); assert.ok(x && x.ok !== false, JSON.stringify(x)); }
  assert.equal(P.edgeVersionOf('rb-dup'), '', '겹친 이름 — 버전을 모른다');
  const why = P.collectorAmbiguityReason('rb-dup');
  assert.match(why, /2개라 어느 엣지인지 정할 수 없습니다/);
  assert.equal(P.collectorAmbiguityReason('rb-a'), '', 'id 로 지정하면 겹침이 아니다');
  const g = P.iloEdgeGate({ hasIlo: true, hasDell: false, version: P.edgeVersionOf('rb-dup'), unknownWhy: why });
  assert.equal(g.delegate, false, '버전을 모르면 iLO 전용 대역은 여전히 보류(안전 쪽)');
  assert.match(g.reason, /2개라 어느 엣지인지 정할 수 없습니다/);
  assert.doesNotMatch(g.reason, /중앙 재시작 직후/, '진짜 사유를 추측 문구로 덮었다');
  // 이름 겹침이 아닌 미상(예전 문구 그대로)
  assert.match(P.iloEdgeGate({ hasIlo: true, hasDell: false, version: '' }).reason, /중앙 재시작 직후/);
  // 기동 주기 스캔 경로(scanPoller)가 이 사유를 넘기는가 — 소스 고정(주석 제거 후)
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fs.readFileSync(new URL('../src/idrac/scanPoller.js', import.meta.url), 'utf8'));
  assert.match(src, /iloEdgeGate\(\{[^}]*unknownWhy:\s*collectorAmbiguityReason\(e\.agent\)/);
});

// ── R4 ──────────────────────────────────────────────────────────────────────
test('R4 스케줄 서명 대상에 인스턴스 — 다른 인스턴스로 옮기면 불일치 · 형식 밖 이름은 양쪽 default · 옛(v1) 서명은 배정 지문이 바뀌어 다시 내려간다', async () => {
  const A = await import('../src/rma/agent.js');
  const crypto = await import('node:crypto');
  const now = Date.now();
  const item = (id) => ({ id, test: 'ssh', args: { host: '10.0.0.9', credentialId: 'c1', command: 'id' }, intervalSec: 60, enabled: true });
  const mine = SG.signScheduleTests('pw-edge', 'edge-rebut', [item('i-mine')], now, 'EDGE-I1')[0];   // 대소문자는 같은 인스턴스
  const other = SG.signScheduleTests('pw-edge', 'edge-rebut', [item('i-other')], now, 'edge-i2')[0];
  A.applySchedule({ version: 9, assignKey: 'k9', tests: [mine, other] }, { password: 'pw-edge', now });
  const by = Object.fromEntries(A._scheduleForTest().tests.map((x) => [x.id, x]));
  assert.equal(by['i-mine'].sigIssue, undefined, '이 인스턴스에 서명된 항목은 실행된다');
  assert.match(by['i-other'].sigIssue || '', /서명 불일치/, '다른 인스턴스에 배정된 항목을 옮겨 붙였는데 실행 대상이 됐다');
  // 중앙 rma-poll 과 같은 규칙 — 형식 밖 인스턴스 이름은 양쪽 모두 default
  assert.equal(SG.scheduleSignInstance('bad name!'), 'default');
  assert.equal(SG.scheduleSignInstance(''), 'default');
  assert.equal(SG.scheduleSignInstance(' Edge-I1 '), 'edge-i1');
  // 옛(v1 — 인스턴스 없음) 서명: 엣지는 불일치로 실행하지 않고, 중앙의 배정 지문(:k)이 v1 과 달라 곧바로 새 서명 사본을 다시 내려보낸다
  const v1canon = (agent, it) => JSON.stringify(['rma-schedule', String(it.id), agent.toLowerCase(), String(it.test), Object.keys(it.args).sort().map((k) => [k, String(it.args[k])]), Number(it.intervalSec), Number(it.sigAt)]);
  const old = { ...item('i-v1'), sigAt: now };
  old.sig = crypto.createHmac('sha256', 'pw-edge').update(v1canon('edge-rebut', old)).digest('hex');
  assert.equal(SG.verifyScheduleItem('pw-edge', 'edge-rebut', old, { now, instance: 'edge-i1' }).code, 'mismatch');
  const v1key = crypto.createHmac('sha256', 'pw-edge').update('rma-schedule-key').digest('hex').slice(0, 12);
  assert.notEqual(SG.scheduleSignKey('pw-edge'), v1key, '배정 지문이 v1 과 같으면 옛 서명을 든 엣지에 다시 내려가지 않는다');
});

// ── R5 · R6: 라우트 ──────────────────────────────────────────────────────────
let server; let base;
before(async () => {
  const express = (await import('express')).default;
  const { registerRma } = await import('../src/routes/api/rma.js');
  const app = express();
  app.use(express.json());
  const USERS = { own: { username: 'own', role: 'admin' }, adm: { username: 'adm', role: 'admin' } };
  app.use((req, _res, next) => { if (req.headers['x-u']) req.user = USERS[req.headers['x-u']] || null; next(); });
  const api = express.Router();
  registerRma(api);
  app.use('/api', api);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => { try { server?.close(); } catch { /* */ } });
const call = async (u, p, body, method = body ? 'POST' : 'GET') => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(u ? { 'x-u': u } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, j, t };
};

test('R5 원격 명령 위험 등급 — tcp-send · udp-send · http-request(POST · 본문)는 소유자 등급 + 본인 OTP, http-request GET 은 그대로 · 서버 · 웹 판정이 같다', async () => {
  const J = await import('../src/rma/jobs.js');
  J._resetRma();
  const pending = () => J.takeJobs('R5-EDGE', 'i1');
  for (const [cmd, args] of [['tcp-send', { host: '10.0.0.7', port: 6379, data: 'FLUSHALL' }], ['udp-send', { host: '10.0.0.7', port: 514, data: 'x' }],
    ['http-request', { url: 'http://10.0.0.7/admin/reset', method: 'POST' }], ['http-request', { url: 'http://10.0.0.7/x', method: ' post ' }],
    ['http-request', { url: 'http://10.0.0.7/x', method: 'GET', body: '{"a":1}' }]]) {
    const r = await call('adm', '/tools/rma/run', { agent: 'R5-EDGE', cmd, args, otp: otpOf('adm') });
    assert.equal(r.s, 403, `${cmd} ${JSON.stringify(args)}: ${r.t}`);
    assert.equal(r.j.requiredOwner, true);
  }
  assert.deepEqual(pending(), [], '거부된 요청이 대기열에 들어갔다');
  const get = await call('adm', '/tools/rma/run', { agent: 'R5-EDGE', cmd: 'http-request', args: { url: 'http://10.0.0.7/health', method: 'GET' } });
  assert.equal(get.s, 200, `본문 없는 GET 은 예전처럼: ${get.t}`);
  assert.equal(pending().length, 1);
  const ok = await call('own', '/tools/rma/run', { agent: 'R5-EDGE', cmd: 'tcp-send', args: { host: '10.0.0.7', port: 6379, data: 'PING' }, otp: otpOf('own') });
  assert.equal(ok.s, 200, ok.t);
  // 화면 표지 + 웹 판정이 서버 판정과 같은 입력에서 같다
  const cat = await call('adm', '/tools/rma');
  const pc = Object.fromEntries(cat.j.catalog.map((p) => [p.id, p]));
  assert.equal(pc['tcp-send'].ownerOtp, true); assert.equal(pc['udp-send'].ownerOtp, true);
  assert.equal(pc['http-request'].ownerOtp, false, '인수 없이 보면 GET — 인수 규칙(dangerIf)으로 판정');
  assert.deepEqual(pc['http-request'].dangerIf, { methodPost: true, body: true });
  const { rmaRunNeedsOwnerOtp } = await import('../src/routes/api/rma.js');
  const W = await import('../../web/src/views/tools/remoteCommand.js');
  const owner = { name: 'own', settingsOwnerTier: true };
  for (const args of [{}, { method: 'GET' }, { method: 'post' }, { method: ' POST ' }, { method: 'PUT' }, { body: '' }, { body: '  ' }, { body: 'x' }, { method: 'GET', body: '{}' }, { method: null, body: null }]) {
    const srv = rmaRunNeedsOwnerOtp('http-request', args);
    assert.equal(W.ownerOtpGate(pc['http-request'], owner, args).need, srv, `웹 · 서버 판정이 갈렸다: ${JSON.stringify(args)}`);
  }
  assert.equal(W.ownerOtpGate(pc['tcp-send'], { name: 'adm', settingsOwnerTier: false }, {}).locked, true);
});

test('R6 RMA 비밀번호 설정 · 해제 · 원격 배포는 소유자 등급 + 본인 OTP', async () => {
  const sec = await import('../src/rma/agentSecrets.js');
  const pw = await call('adm', '/tools/rma/agents/R6-EDGE/password', { password: 'pw-r6-0001', otp: otpOf('adm') }, 'PUT');
  assert.equal(pw.s, 403, pw.t); assert.equal(pw.j.requiredOwner, true);
  assert.equal(sec.rmaPasswordFor('R6-EDGE'), '', '소유자가 아닌 admin 이 서명 비밀번호를 바꿨다');
  const noOtp = await call('own', '/tools/rma/agents/R6-EDGE/password', { password: 'pw-r6-0001' }, 'PUT');
  assert.equal(noOtp.s, 403); assert.equal(noOtp.j.needOtp, true);
  const ok = await call('own', '/tools/rma/agents/R6-EDGE/password', { password: 'pw-r6-0001', otp: otpOf('own') }, 'PUT');
  assert.equal(ok.s, 200, ok.t);
  assert.equal(sec.rmaPasswordFor('R6-EDGE'), 'pw-r6-0001');
  const clr = await call('adm', '/tools/rma/agents/R6-EDGE/password', { password: '' }, 'PUT');
  assert.equal(clr.s, 403, '해제도 같은 게이트');
  assert.equal(sec.rmaPasswordFor('R6-EDGE'), 'pw-r6-0001');
  const dep = await call('adm', '/tools/rma/deploy', { host: '10.0.0.8', username: 'root', password: 'x', instances: [{ name: 'default', priority: 100 }], allowCustom: true, clearPassword: true });
  assert.equal(dep.s, 403, dep.t); assert.equal(dep.j.requiredOwner, true);
  const depNo = await call('own', '/tools/rma/deploy', { host: '10.0.0.8', username: 'root', password: 'x', instances: [] });
  assert.equal(depNo.s, 403); assert.equal(depNo.j.needOtp, true);
  // 게이트를 지나면 배포 입력 검증으로 간다(접속 전 400 — 빈 인스턴스)
  const depOk = await call('own', '/tools/rma/deploy', { host: '10.0.0.8', username: 'root', password: 'x', instances: [], otp: otpOf('own') });
  assert.notEqual(depOk.s, 403, depOk.t);
});
