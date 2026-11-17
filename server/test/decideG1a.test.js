// '결정 필요' 권장안 구현 — 그룹 G1a(서버 보안 · 권한). 전체 점검 56~75회차가 남긴 결정 항목.
//  64 F7  점검 스케줄 script · ssh 항목 HMAC 서명 — 비밀번호가 있는 엣지는 서명 없음/불일치 항목을 실행하지 않고 unknown
//  64 등급 /tools/rma/run 의 상태 변경 · 임의 실행(danger) · 셸 점검 저장 = 설정 소유자 등급 + 본인 OTP
//  64 F2  호스트 접근 되돌림 자동 재시도 시한(처음 실패부터) — 지나면 수동 조치 필요 · 확정 때 실패 연속 수 0
//  66 ①  findCollectorByName = id 정확 일치 먼저 · 이름은 유일할 때만(둘 이상 null + 사유) · agentNameClash 같은 순서
//  63 ②  비관리자 토폴로지 판본의 사이트 비고 가림
//  72     NSX 인증서 — 범위 계정에는 귀속 vCenter 분만(무귀속 숨김)
//  69 ③  vcInfoBody 수집 오류 원문은 전체 범위 관리자만
//  67 ①  공개 API 500 의 reason 은 일반 문구 + 요청 id(원문은 서버 로그)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'decide-g1a-'));
process.env.CONFIG_DIR = CFG;
process.env.PORT = '4000';
process.env.CENTRAL_TOKEN = 'shared-token-for-decide-g1a-000000000000';
process.env.AUTH_ENABLED = 'true';
process.env.AGENT_NAME = 'edge-g1a';
process.env.RMA_ALLOW_CUSTOM = 'true';   // 엣지 script 점검이 실제로 돌 수 있는 조건 — 서명 판정이 없으면 실행된다(변이 검증의 근거)
delete process.env.RMA_PASSWORD;

const { generateSecret, generateToken } = await import('../src/auth/totp.js');
const SECRETS = { own: generateSecret(), own2: generateSecret(), adm: generateSecret(), own3: generateSecret() };
fs.writeFileSync(path.join(CFG, 'users.json'), JSON.stringify({ users: [
  { username: 'own', role: 'admin', totpEnabled: true, totpSecret: SECRETS.own },
  { username: 'own2', role: 'admin', totpEnabled: true, totpSecret: SECRETS.own2 },
  { username: 'own3', role: 'admin', totpEnabled: true, totpSecret: SECRETS.own3 },
  { username: 'adm', role: 'admin', totpEnabled: true, totpSecret: SECRETS.adm },
  { username: 'noot', role: 'admin' },
] }));
fs.writeFileSync(path.join(CFG, 'security-session.json'), JSON.stringify({ settingsOwners: ['own', 'own2', 'own3', 'noot'] }));
const otpOf = (u) => generateToken(SECRETS[u]);

const SG = await import('../src/rma/signing.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;   // 정시 경계로 떨어뜨린 기준 시각(테스트 규약)

const { store } = await import('../src/store.js');
store.snapshot = { generatedAt: Date.now(), source: 'mock', vcenters: [{ id: 'vc-1', name: 'Seoul', host: 'https://vc-1.corp' }, { id: 'vc-2', name: 'Warsaw', host: 'https://vc-2.corp' }], hosts: [], datastores: [], vms: [], alarms: [], networks: [] };

let server; let base;
const USERS = {
  own: { username: 'own', role: 'admin' }, own2: { username: 'own2', role: 'admin' }, own3: { username: 'own3', role: 'admin' },
  adm: { username: 'adm', role: 'admin' }, noot: { username: 'noot', role: 'admin' },
  fadm: { username: 'fadm', role: 'admin' },
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-1'] } },
  wadm: { username: 'wadm', role: 'admin', scope: { vcenters: [], writeVcenters: ['vc-1'] } },
};
before(async () => {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const { registerRma } = await import('../src/routes/api/rma.js');
  const { registerVcInfo } = await import('../src/routes/api/vcInfo.js');
  const { registerHostAccess } = await import('../src/routes/admin/hostAccess.js');
  const app = express();
  app.use(express.json());
  app.use('/api/central', centralRouter);
  const api = express.Router();
  const admin = express.Router();
  app.use((req, _res, next) => { if (req.headers['x-u']) req.user = USERS[req.headers['x-u']] || null; next(); });
  registerRma(api); registerVcInfo(api); registerHostAccess(admin);
  app.use('/api', api);
  app.use('/api/admin', admin);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => { try { server?.close(); } catch { /* */ } try { fs.rmSync(CFG, { recursive: true, force: true }); } catch { /* */ } });
const call = async (u, p, body, method = body ? 'POST' : 'GET') => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(u ? { 'x-u': u } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, j, t };
};

// ── 64 F7: 스케줄 서명(순수) ──────────────────────────────────────────────────
test('64 F7 — script · ssh 항목만 서명(사본) · 내용 · id · 법인 · 주기 · 시각 창이 서명 대상', () => {
  const tests = [{ id: 't1', test: 'script', args: { command: 'echo a', timeoutMs: 30000 }, intervalSec: 60 }, { id: 't2', test: 'ping', args: { host: '10.0.0.1' }, intervalSec: 60 },
    { id: 't3', test: 'ssh', args: { host: '10.0.0.2', credentialId: 'cred_a', command: 'uptime' }, intervalSec: 300 }];
  const signed = SG.signScheduleTests('pw-1', 'Edge-A', tests, NOW);
  assert.ok(signed[0].sig && signed[0].sigAt === NOW && signed[2].sig, 'script · ssh 에 서명');
  assert.equal(signed[1].sig, undefined, '프리셋 점검은 서명하지 않는다(옛 엣지 · 옛 중앙 섞임 영향 없음)');
  assert.equal(tests[0].sig, undefined, '저장본(원본)을 바꾸지 않는다');
  const ok = (it, o = {}) => SG.verifyScheduleItem('pw-1', 'edge-a', it, { now: NOW + 1000, ...o });
  assert.equal(ok(signed[0]).ok, true, '법인 이름은 대소문자 무시');
  assert.equal(ok({ ...signed[0], sig: undefined }).code, 'unsigned');
  assert.match(ok({ ...signed[0], sig: undefined }).reason, /서명 없음/);
  for (const [label, it] of [['인수', { ...signed[0], args: { ...signed[0].args, command: 'rm -rf /tmp/x' } }], ['주기', { ...signed[0], intervalSec: 30 }], ['id', { ...signed[0], id: 't9' }], ['점검', { ...signed[0], test: 'ssh' }]]) {
    assert.equal(ok(it).code, 'mismatch', `${label}을 바꾸면 서명 불일치여야 한다`);
  }
  assert.equal(SG.verifyScheduleItem('pw-1', 'edge-b', signed[0], { now: NOW }).code, 'mismatch', '다른 법인');
  assert.equal(SG.verifyScheduleItem('pw-2', 'edge-a', signed[0], { now: NOW }).code, 'mismatch', '다른 비밀번호');
  assert.equal(ok(signed[0], { now: NOW + SG.SKEW_MS + 1 }).code, 'window', '받을 때는 서명 시각 창(±10분)을 본다');
  assert.equal(ok(signed[0], { now: NOW + 86_400_000, checkWindow: false }).ok, true, '보관본은 창을 다시 보지 않는다(HMAC 만)');
  assert.equal(SG.verifyScheduleItem('', 'edge-a', { ...tests[0] }).ok, true, '비밀번호 없는 엣지는 예전처럼');
  assert.equal(SG.verifyScheduleItem('pw-1', 'edge-a', tests[1]).ok, true, '서명이 필요 없는 점검');
  // 잡 서명과 섞이지 않는다(같은 비밀번호 · 같은 문자열 재료라도 접두가 다르다)
  assert.notEqual(SG.signScheduleItem('pw-1', 'edge-a', { id: 'x', test: 'script', args: {}, intervalSec: 0, sigAt: 0 }), SG.signJob('pw-1', { reqId: 'x', agent: 'edge-a', cmd: 'script', args: {}, timeoutMs: 0, issuedAt: 0 }));
  assert.equal(SG.scheduleSignKey(''), '');
  assert.notEqual(SG.scheduleSignKey('a'), SG.scheduleSignKey('b'));
});

// ── 64 F7: 중앙 배포(rma-poll) ────────────────────────────────────────────────
test('64 F7 — rma-poll 이 script 항목에 법인 비밀번호 서명을 붙이고, 비밀번호를 등록하면 assignKey 가 바뀌어 다시 내려간다', async () => {
  const tokens = await import('../src/central/agentTokens.js');
  const sch = await import('../src/rma/schedules.js');
  const sec = await import('../src/rma/agentSecrets.js');
  const t = tokens.issueAgentToken('RMA-G1A');
  sch.upsertScheduleItem('RMA-G1A', { test: 'script', args: { command: 'echo g1a' }, intervalSec: 60 });
  sch.upsertScheduleItem('RMA-G1A', { test: 'tcp', args: { host: '10.0.0.1', port: 22 }, intervalSec: 60 });
  const poll = async (b) => {
    const r = await fetch(`${base}/central/rma-poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': t.token, 'X-Agent-Name': 'RMA-G1A' }, body: JSON.stringify({ agent: 'RMA-G1A', instance: 'i1', wait: 0, info: {}, ...b }) });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  const a = await poll({});
  assert.ok(a.schedule, '첫 폴은 스케줄을 받는다');
  assert.doesNotMatch(a.schedule.assignKey, /:k/, '비밀번호가 없으면 assignKey 는 예전 모양');
  assert.ok(a.schedule.tests.every((x) => !x.sig), '비밀번호가 없으면 서명 없음');
  const again = await poll({ scheduleVersion: a.schedule.version, assignKey: a.schedule.assignKey });
  assert.equal(again.schedule, undefined, '같은 배정이면 다시 내려가지 않는다');
  sec.setRmaPassword('RMA-G1A', 'pw-g1a');
  const b = await poll({ scheduleVersion: a.schedule.version, assignKey: a.schedule.assignKey });
  assert.ok(b.schedule, '비밀번호를 등록하면 스케줄 버전이 같아도 다시 내려간다(엣지가 새 서명으로 다시 판정)');
  assert.match(b.schedule.assignKey, /:k[0-9a-f]{12}$/);
  const script = b.schedule.tests.find((x) => x.test === 'script');
  const tcp = b.schedule.tests.find((x) => x.test === 'tcp');
  assert.equal(SG.verifyScheduleItem('pw-g1a', 'rma-g1a', script).ok, true, '엣지가 같은 비밀번호로 검증된다');
  assert.equal(tcp.sig, undefined);
  assert.ok(sch.scheduleFor('RMA-G1A').tests.every((x) => !x.sig && !x.sigAt), '중앙 저장본에는 서명을 남기지 않는다');
  assert.ok(!JSON.stringify(b).includes('pw-g1a'), '비밀번호는 선로에 싣지 않는다');
  // 상태 한 줄(중앙 화면) — 엣지에 비밀번호가 있는데 중앙에 없으면 그 점검이 멈춘다고 말한다
  assert.match(sch.scheduleSignNote({ tests: sch.scheduleFor('RMA-G1A').tests, hasPassword: false, instances: [{ signed: true }] }), /중앙에 이 법인의 RMA 비밀번호가 없어 외부 스크립트 · SSH 점검 1개/);
  assert.equal(sch.scheduleSignNote({ tests: sch.scheduleFor('RMA-G1A').tests, hasPassword: true, instances: [{ signed: true }] }), '');
  assert.match(sch.scheduleSignNote({ tests: sch.scheduleFor('RMA-G1A').tests, hasPassword: true, instances: [{ signed: true, scheduleSigRejected: 1 }] }), /서명 없음\/불일치로 외부 스크립트 · SSH 점검 1개/);
  assert.equal(sch.scheduleSignNote({ tests: [{ test: 'tcp' }], hasPassword: false, instances: [{ signed: true }] }), '', '셸 점검이 없으면 해당 없음');
  sec.setRmaPassword('RMA-G1A', '');
});

// ── 64 F7: 엣지(rma/agent.js) ───────────────────────────────────────────────
test('64 F7 — 비밀번호가 있는 엣지는 서명 없음/불일치/시각 창 밖 script 를 실행하지 않고 unknown · 서명된 것과 비밀번호 없는 엣지는 실행', async () => {
  const A = await import('../src/rma/agent.js');
  const mk = (n) => path.join(CFG, `marker-${n}`);
  const item = (id, n) => ({ id, test: 'script', args: { command: `touch ${mk(n)}`, timeoutMs: 5000 }, intervalSec: 60, enabled: true });
  const now = Date.now();
  const good = SG.signScheduleTests('pw-edge', 'edge-g1a', [item('s-good', 'good')], now)[0];
  const wrong = SG.signScheduleTests('other', 'edge-g1a', [item('s-wrong', 'wrong')], now)[0];
  const stale = SG.signScheduleTests('pw-edge', 'edge-g1a', [item('s-stale', 'stale')], now - SG.SKEW_MS - 60_000)[0];
  const forged = { ...item('s-forged', 'forged'), sigIssue: '' };   // 받은 항목의 sigIssue 는 믿지 않는다
  const preset = { id: 'p1', test: 'file-exists', args: { path: '/var/log', expect: 1 }, intervalSec: 60, enabled: true };
  A.applySchedule({ version: 7, assignKey: 'k7', tests: [item('s-unsigned', 'unsigned'), good, wrong, stale, forged, preset] }, { password: 'pw-edge', now });
  const by = Object.fromEntries(A._scheduleForTest().tests.map((x) => [x.id, x]));
  assert.match(by['s-unsigned'].sigIssue, /서명 없음/);
  assert.match(by['s-wrong'].sigIssue, /서명 불일치/);
  assert.match(by['s-stale'].sigIssue, /허용 오차/);
  assert.match(by['s-forged'].sigIssue, /서명 없음/);
  assert.equal(by['s-good'].sigIssue, undefined);
  assert.equal(by.p1.sigIssue, undefined, '프리셋은 서명을 보지 않는다');
  await A.tickSchedule(Date.now() + 120_000);
  for (const n of ['unsigned', 'wrong', 'stale', 'forged']) assert.equal(fs.existsSync(mk(n)), false, `서명 문제(${n}) script 가 실행됐다`);
  assert.equal(fs.existsSync(mk('good')), true, '서명이 맞는 script 는 실행된다');
  const out = Object.fromEntries(A._outboxForTest().map((r) => [r.id, r]));
  assert.equal(out['s-unsigned'].status, 'unknown');
  assert.match(out['s-unsigned'].reply, /서명 없음 — 이 엣지는 RMA_PASSWORD/, '사유가 중앙 점검 상태에 그대로 보인다');
  assert.equal(out['s-good'].status, 'ok');
  // 기동(파일 보관본): 받을 때의 판정은 이어 가고(창 밖 재전송이 재시작으로 살아나지 않게), 맞는 서명은 창을 다시 보지 않는다 · 첫 폴에서 다시 받는다
  const saved = { version: 7, assignKey: 'k7', tests: A._scheduleForTest().tests };
  A.applySchedule(saved, { fresh: false, password: 'pw-edge', now: now + 86_400_000 });
  const by2 = Object.fromEntries(A._scheduleForTest().tests.map((x) => [x.id, x]));
  assert.match(by2['s-stale'].sigIssue, /허용 오차/, '받을 때 창 밖으로 거부된 항목은 재시작 뒤에도 거부');
  assert.equal(by2['s-good'].sigIssue, undefined, '보관본의 맞는 서명은 하루 뒤에도 유효(HMAC 만)');
  assert.equal(A._scheduleForTest().assignKey, '', '서명이 필요한 항목이 있으면 첫 폴에서 중앙 사본을 다시 받는다');
  A.applySchedule(saved, { fresh: false, password: 'changed-pw', now });
  assert.match(Object.fromEntries(A._scheduleForTest().tests.map((x) => [x.id, x]))['s-good'].sigIssue, /불일치/, '엣지 비밀번호가 바뀌면 보관본도 거부');
  // 비밀번호 없는 엣지는 예전처럼(서명 판정 없음)
  A.applySchedule({ version: 8, assignKey: 'k8', tests: [item('s-nopw', 'nopw')] }, { password: '', now: Date.now() });
  assert.equal(A._scheduleForTest().tests[0].sigIssue, undefined);
  assert.equal(A._scheduleForTest().assignKey, 'k8');
  await A.tickSchedule(Date.now() + 120_000);
  assert.equal(fs.existsSync(mk('nopw')), true, '비밀번호가 없는 엣지는 서명 없이 실행(예전 동작)');
  // 하트비트가 거부 수를 싣는다(중앙 화면) — 옛 엣지(필드 없음)는 0
  const J = await import('../src/rma/jobs.js');
  J.noteHeartbeat('HB-G1A', 'i1', { signed: true, scheduleSigRejected: 3 });
  J.noteHeartbeat('HB-G1A', 'i2', { signed: true });
  const g = J.listRmaAgents().find((x) => x.agent === 'HB-G1A');
  assert.deepEqual(g.instances.map((i) => i.scheduleSigRejected).sort(), [0, 3]);
});

// ── 64 등급: /tools/rma/run · 스케줄 저장 ───────────────────────────────────
test('64 등급 — 상태 변경 · 임의 실행 명령은 설정 소유자 등급 + 본인 OTP, 읽기 프리셋은 예전처럼 admin + 전체 범위', async () => {
  const J = await import('../src/rma/jobs.js');
  J._resetRma();
  const pendingOf = () => J.takeJobs('RUN-G1A', 'i1');
  // 소유자가 아닌 admin: 자유 명령 · 서비스 제어 · ssh-exec(1회 입력 포함) 403 · 대기열에 들어가지 않는다
  for (const [cmd, args, extra] of [['custom', { command: 'id' }, {}], ['service-restart', { unit: 'vmware-portal' }, {}], ['ssh-exec', { host: '10.0.0.5', command: 'id', username: 'root' }, { secret: { username: 'root', password: 'p' } }]]) {
    const r = await call('adm', '/tools/rma/run', { agent: 'RUN-G1A', cmd, args, ...extra, otp: otpOf('adm') });
    assert.equal(r.s, 403, `${cmd}: ${r.t}`);
    assert.equal(r.j.requiredOwner, true);
  }
  assert.deepEqual(pendingOf(), [], '거부된 요청이 대기열에 들어갔다');
  // 읽기 프리셋은 소유자가 아니어도 그대로
  const up = await call('adm', '/tools/rma/run', { agent: 'RUN-G1A', cmd: 'uptime' });
  assert.equal(up.s, 200, up.t);
  assert.equal(pendingOf().length, 1);
  // 소유자: OTP 없음 · 틀림 403 → 맞으면 200
  assert.equal((await call('own', '/tools/rma/run', { agent: 'RUN-G1A', cmd: 'custom', args: { command: 'id' } })).s, 403);
  const bad = await call('own', '/tools/rma/run', { agent: 'RUN-G1A', cmd: 'custom', args: { command: 'id' }, otp: '000000' });
  assert.equal(bad.s, 403); assert.equal(bad.j.needOtp, true);
  assert.deepEqual(pendingOf(), []);
  const ok = await call('own', '/tools/rma/run', { agent: 'RUN-G1A', cmd: 'custom', args: { command: 'id' }, otp: otpOf('own') });
  assert.equal(ok.s, 200, ok.t);
  assert.equal(pendingOf().length, 1);
  // OTP 가 없는 소유자는 needEnroll(소유자 예외 없음 — 호스트 접근 적용과 같은 판정)
  const ne = await call('noot', '/tools/rma/run', { agent: 'RUN-G1A', cmd: 'rma-restart' });
  assert.equal(ne.s, 403); assert.equal(ne.j.needEnroll, true);
  // 셸 점검(script · ssh) 저장도 같은 게이트 — 스케줄로 우회하지 못한다. 다른 점검은 그대로.
  const sp = await call('adm', '/tools/rma/agents/RUN-G1A/schedule', { test: 'script', args: { command: 'id' }, intervalSec: 60, otp: otpOf('adm') }, 'PUT');
  assert.equal(sp.s, 403, sp.t);
  const sch = await import('../src/rma/schedules.js');
  assert.equal(sch.scheduleFor('RUN-G1A').tests.length, 0, '거부된 셸 점검이 저장됐다');
  assert.equal((await call('adm', '/tools/rma/agents/RUN-G1A/schedule', { test: 'tcp', args: { host: '10.0.0.1', port: 22 }, intervalSec: 60 }, 'PUT')).s, 200);
  const so = await call('own2', '/tools/rma/agents/RUN-G1A/schedule', { test: 'script', args: { command: 'id' }, intervalSec: 60, otp: otpOf('own2') }, 'PUT');
  assert.equal(so.s, 200, so.t);
  assert.equal(sch.scheduleFor('RUN-G1A').tests.length, 2);
  // 화면이 쓰는 표지(판정은 서버 하나)
  const cat = await call('adm', '/tools/rma');
  const pc = Object.fromEntries(cat.j.catalog.map((p) => [p.id, p.ownerOtp]));
  assert.deepEqual([pc.custom, pc['ssh-exec'], pc['service-stop'], pc.reboot, pc.uptime, pc.ping], [true, true, true, true, false, false]);
  const tc = Object.fromEntries(cat.j.tests.map((t) => [t.id, t.ownerOtp]));
  assert.deepEqual([tc.script, tc.ssh, tc.tcp, tc['rma-itself']], [true, true, false, false]);
});

test('64 등급 — 호스트 접근 적용은 옮긴 공용 OTP 게이트(ownOtpGate)를 그대로 쓴다', async () => {
  const S = await import('../src/hostaccess/service.js');
  S._setExec({ fw: async () => ({ ok: false, code: 1, stdout: '', stderr: 'not running' }), sshdCtl: async () => ({ ok: true }), sshdActive: async () => true, isSudoDenied: () => false });
  try {
    const ne = await call('noot', '/admin/host-access/apply', { settings: {} });
    assert.equal(ne.s, 403); assert.equal(ne.j.needEnroll, true);
    assert.match(ne.j.reason, /서버 접근 경로 변경/);
    const bad = await call('own3', '/admin/host-access/apply', { settings: {}, otp: '000000' });
    assert.equal(bad.s, 403); assert.match(bad.j.reason, /OTP 인증 실패/);
    assert.equal((await call('adm', '/admin/host-access/apply', { settings: {}, otp: otpOf('adm') })).s, 403, '소유자가 아니면 OTP 앞에서 막힌다');
  } finally { S._setExec(null); }
});

// ── 64 F2: 되돌림 재시도 시한 ───────────────────────────────────────────────
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
test('64 F2 시한 — 처음 실패부터 시한이 지나면 자동 재시도를 멈추고(수동 조치 필요 · pending 유지) 기동 때도 다시 시도하지 않는다 · 수동 되돌림은 된다', async () => {
  const S = await import('../src/hostaccess/service.js');
  const St = await import('../src/hostaccess/settings.js');
  St._resetHostAccessCache(); St.saveHostAccess({ pending: null, applied: null });
  const st = { reloads: 0, failReload: 1e9 };
  S._setExec({ fw: fakeFw(st), sshdCtl: async () => ({ ok: true }), sshdActive: async () => true, isSudoDenied: () => false });
  S._setRevertRetryMinMs(20); S._setRevertRetryWindowMs(250);
  try {
    assert.equal((await S.applyHostAccess({ ssh: { mode: 'deny' }, confirmMinutes: 1 }, { requesterIp: '10.1.1.1', by: 't' })).ok, true);
    St.saveHostAccess({ pending: { ...St.loadHostAccess().pending, deadline: Date.now() + 10 } });
    await S.resumeHostAccessPending();
    for (let k = 0; k < 60 && St.loadHostAccess().pending?.revertGaveUp !== true; k++) await sleep(25);
    const p = St.loadHostAccess().pending;
    assert.ok(p, 'pending 을 지웠다(되돌리지 못했는데)');
    assert.equal(p.revertGaveUp, true, `시한이 지나도 포기하지 않았다(reload ${st.reloads}회)`);
    assert.ok(p.revertFirstFailedAt > 0 && p.revertGaveUpAt >= p.revertFirstFailedAt);
    assert.ok(st.reloads >= 3, '시한 안에서는 늘어나는 간격으로 다시 시도한다');
    const n = st.reloads;
    await sleep(400);
    assert.equal(st.reloads, n, '시한이 지난 뒤에도 자동 재시도가 계속됐다');
    await S.resumeHostAccessPending();
    await sleep(100);
    assert.equal(st.reloads, n, '포기한 상태를 기동 때 다시 자동 시도했다');
    const status = await S.hostAccessStatus({});
    assert.equal(status.revertRetryWindowMs, 250, '화면은 시한을 API 값으로 말한다');
    // 수동 되돌림 — 실패해도 자동 재시도를 다시 걸지 않는다(포기 유지)
    const m = await S.revertHostAccess({ by: 'admin' });
    assert.equal(m.ok, false); assert.equal(m.gaveUp, true);
    assert.match(m.errors.join(' '), /수동 조치 필요/);
    await sleep(200);
    assert.equal(st.reloads, n + 1);
    // firewalld 가 돌아오면 수동 되돌림으로 풀린다 · 실패 연속 수 0
    st.failReload = 0;
    assert.equal((await S.revertHostAccess({ by: 'admin' })).ok, true);
    assert.equal(St.loadHostAccess().pending, null);
    assert.equal(S._revertFailStreak(), 0);
  } finally { S._setRevertRetryMinMs(); S._setRevertRetryWindowMs(); S._setExec(null); }
});

test('64 F2 — 확정(confirm)으로 끝나면 실패 연속 수를 0 으로(다음 첫 재시도 간격이 앞선 실패에 끌려 길어지지 않게)', async () => {
  const S = await import('../src/hostaccess/service.js');
  const St = await import('../src/hostaccess/settings.js');
  St._resetHostAccessCache(); St.saveHostAccess({ pending: null, applied: null });
  const st = { reloads: 0, failReload: 2 };
  S._setExec({ fw: fakeFw(st), sshdCtl: async () => ({ ok: true }), sshdActive: async () => true, isSudoDenied: () => false });
  S._setRevertRetryMinMs(60_000);
  try {
    assert.equal((await S.applyHostAccess({ ssh: { mode: 'deny' }, confirmMinutes: 5 }, { requesterIp: '10.1.1.1', by: 't' })).ok, true);
    assert.equal((await S.revertHostAccess({ by: 'admin' })).ok, false);
    assert.equal((await S.revertHostAccess({ by: 'admin' })).ok, false);
    assert.equal(S._revertFailStreak(), 2);
    assert.equal((await S.confirmHostAccess({ by: 'admin' })).ok, true);
    assert.equal(S._revertFailStreak(), 0, '확정으로 끝났는데 실패 연속 수가 남았다');
  } finally { S._setRevertRetryMinMs(); S._setExec(null); St.saveHostAccess({ pending: null, applied: null }); }
});

// ── 66 ①: 수집 서버 이름 조회 순서 ──────────────────────────────────────────
test('66 ① — findCollectorByName: id 정확 일치 먼저(목록 순서 무관) · 이름은 유일할 때만 · 겹치면 null + 사유 · agentNameClash 같은 답', async () => {
  const reg = await import('../src/collector/registry.js');
  const CT = await import('../src/bmusage/targets.js');
  const { remoteCollectorIndex } = await import('../src/insights/fleetInventory.js');
  const rows = [
    { id: 'g1a-x1', name: 'g1a-gm1', url: 'https://10.9.1.7:3443', token: 'TOK-X1', enabled: true },
    { id: 'g1a-gm1', name: 'Warsaw-g1a', url: 'https://10.9.1.1:3443', token: 'TOK-GM1', enabled: true },
    { id: 'g1a-a', name: 'dup-g1a', url: 'https://10.9.1.21:3443', token: 'TOK-A', enabled: true },
    { id: 'g1a-b', name: 'DUP-g1a', url: 'https://10.9.1.22:3443', token: 'TOK-B', enabled: true },
  ];
  for (const r of rows) { const a = reg.addCollector(r, { managed: true }); assert.ok(a && a.ok !== false, JSON.stringify(a)); }
  try {
    const hit = reg.findCollectorByName('G1A-GM1');
    assert.equal(hit?.id, 'g1a-gm1', '앞 항목의 표시 이름이 이 id 와 같아도 id 일치가 먼저(예전: g1a-x1 — 남의 엣지)');
    assert.equal(hit.token, 'TOK-GM1');
    assert.equal(reg.findCollectorByName(' warsaw-G1A ')?.id, 'g1a-gm1', '유일한 표시 이름');
    assert.equal(reg.findCollectorByName('dup-g1a'), null, '표시 이름이 둘이면 정하지 않는다');
    const why = reg.resolveCollectorByName('dup-g1a');
    assert.equal(why.issue, 'ambiguous'); assert.equal(why.count, 2);
    assert.match(why.reason, /2개라 어느 엣지인지 정할 수 없습니다/);
    assert.equal(reg.resolveCollectorByName('no-such-g1a').issue, 'not-found');
    assert.equal(reg.findCollectorByName('g1a-a')?.id, 'g1a-a', 'id 로는 정해진다');
    // 엣지 당기기(엣지 로그 인출 · 토큰 점검의 엣지 조회가 쓰는 길)는 접속하지 않고 그 사유를 그대로 낸다
    const { pullFromEdge } = await import('../src/central/edgePull.js');
    const p = await pullFromEdge('dup-g1a', '/api/x');
    assert.deepEqual([p.ok, p.kind, p.fetched], [false, 'ambiguous', false]);
    assert.match(p.reason, /정할 수 없습니다/);
    const d = await import('../src/central/tokenApplyDeps.js');
    const deps = d.realTokenApplyDeps(() => {});
    assert.equal(typeof deps.collectorReason, 'function', '토큰 자동 적용도 같은 사유를 쓴다');
    assert.match(deps.collectorReason('dup-g1a'), /정할 수 없습니다/);
    assert.equal(deps.collectorReason('g1a-a'), '');
    // agentNameClash — 같은 등록부에서 같은 순서 규칙
    const idx = remoteCollectorIndex({ list: reg.loadCollectors(), error: null });
    assert.equal(CT.agentNameClash(idx, 'g1a-gm1', 'g1a-x1'), reg.findCollectorByName('g1a-gm1')?.id !== 'g1a-x1', '이름 g1a-gm1 은 다른 수집 서버로 간다');
    assert.equal(CT.agentNameClash(idx, 'Warsaw-g1a', 'g1a-gm1'), false);
    assert.equal(CT.agentNameClash(idx, 'dup-g1a', 'g1a-a'), true, '겹친 이름(다른 URL)은 이름으로 정할 수 없다');
  } finally { for (const r of rows) reg.removeCollector(r.id); }
});

// ── 63 ②: 토폴로지 비고 가림 ───────────────────────────────────────────────
test('63 ② — 비관리자 토폴로지 판본은 사이트 비고를 비우고 있었다는 사실만(noteHidden)', async () => {
  const { maskTopology } = await import('../src/routes/api/relaytopo.js');
  const t = { main: { privateIp: '10.0.0.1', ssh: { username: 'root' } }, services: [], sites: [
    { dc: 'KR', note: 'IRS 10.20.30.40 root/비번은 위키', edge: { privateIp: '10.1.1.1', publicIp: '1.2.3.4', ssh: { username: 'ops' } }, irs: { privateIp: '10.1.1.2' } },
    { dc: 'PL', note: '', edge: {}, irs: {} },
  ] };
  const m = maskTopology(t);
  assert.equal(m.sites[0].note, ''); assert.equal(m.sites[0].noteHidden, true);
  assert.equal(m.sites[1].noteHidden, undefined, '비고가 없으면 표지도 없다');
  assert.ok(!JSON.stringify(m).includes('10.20.30.40'), '비고 안의 주소가 가린 판본에 남았다');
  assert.equal(t.sites[0].note.includes('10.20.30.40'), true, '원본은 바꾸지 않는다');
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fs.readFileSync(new URL('../src/routes/api/relaytopo.js', import.meta.url), 'utf8'));
  assert.match(src, /topology:\s*admin\s*\?\s*topo\s*:\s*maskTopology\(topo\)/, '조회 라우트가 비관리자에게 maskTopology 를 쓴다');
});

// ── 72: NSX 인증서 범위 ────────────────────────────────────────────────────
test('72 — NSX 인증서: 범위 계정에는 귀속 vCenter 분만 · 무귀속은 숨김 · vCenter 필터는 그 귀속분', async () => {
  const { scopedCertItems } = await import('../src/routes/api/reports.js');
  const vcs = [{ id: 'vc-1', location: { region: 'KR' } }, { id: 'vc-2', location: { region: 'PL' } }];
  const items = [{ kind: 'vcenter', id: 'vc-1' }, { kind: 'vcenter', id: 'vc-2' }, { kind: 'nsx', id: 'n1', vcenterId: 'vc-1' }, { kind: 'nsx', id: 'n2', vcenterId: 'vc-2' }, { kind: 'nsx', id: 'n0', vcenterId: '' }, { kind: 'nsx', id: 'nr', region: 'KR' }];
  const ids = (a, f) => scopedCertItems(items, a, f, vcs).map((x) => x.id).sort();
  assert.deepEqual(ids(new Set(['vc-1']), ''), ['n1', 'vc-1'], '범위 계정: 귀속분만(예전: NSX 전부 숨김) · 무귀속 · 지역만 있는 항목은 숨김');
  assert.deepEqual(ids(null, ''), ['n0', 'n1', 'n2', 'nr', 'vc-1', 'vc-2'], '전체 범위: 전부');
  assert.deepEqual(ids(null, 'vc-2'), ['n2', 'vc-2'], 'vCenter 필터: 그 귀속분(무귀속 제외)');
  assert.deepEqual(ids(new Set(['vc-1']), 'vc-2'), [], '범위 밖 vCenter 필터는 비어 있다');
});

// ── 69 ③: vcInfoBody 오류 원문 ─────────────────────────────────────────────
test('69 ③ — vcInfoBody: 수집 오류 원문은 rawErrors(전체 범위 관리자)만 · 그 밖은 고정 문구 · 라우트 판정', async () => {
  const { vcInfoBody } = await import('../src/routes/api/vcInfo.js');
  const { ERROR_HIDDEN_TEXT } = await import('../src/routes/api/vmTags.js');
  const RAW = 'ServerFaultCode: NoPermission on 10.9.8.7 user svc-portal';
  const nc = vcInfoBody('perms', 'v', { at: null, items: [], error: RAW });
  assert.equal(nc.error, ERROR_HIDDEN_TEXT); assert.ok(!nc.notCollected.includes('10.9.8.7')); assert.equal(nc.errorHidden, true);
  const dv = vcInfoBody('dvpg', 'v', { at: 1, items: [], error: RAW, lagError: RAW, dvsError: null });
  assert.deepEqual([dv.error, dv.lagError, dv.dvsError], [ERROR_HIDDEN_TEXT, ERROR_HIDDEN_TEXT, null], '오류가 없으면 null 그대로(지어내지 않는다)');
  const ln = vcInfoBody('linked', 'v', { at: 1, nodes: [], replication: [], error: null, replError: RAW });
  assert.equal(ln.replError, ERROR_HIDDEN_TEXT);
  const up = vcInfoBody('updates', 'v', { at: 1, pending: [], error: null, pendingError: RAW });
  assert.equal(up.pendingError, ERROR_HIDDEN_TEXT);
  const vl = vcInfoBody('vlcm', 'v', { at: 1, items: [{ cluster: 'c1', error: RAW }, { cluster: 'c2', error: null }], error: null });
  assert.deepEqual(vl.items.map((x) => x.error), [ERROR_HIDDEN_TEXT, null]);
  const tk = vcInfoBody('tasks', 'v', { at: 1, items: [{ key: 't1', error: 'A specified parameter was not correct' }], error: null });
  assert.equal(tk.items[0].error, 'A specified parameter was not correct', '작업 결과의 error 는 수집 오류가 아니다');
  assert.ok(!JSON.stringify([nc, dv, ln, up, vl]).includes('10.9.8.7'));
  const raw = vcInfoBody('perms', 'v', { at: null, items: [], error: RAW }, { admin: true, rawErrors: true });
  assert.equal(raw.error, RAW); assert.equal(raw.errorHidden, undefined);
  // 라우트: 전체 범위 관리자만 원문 — 조회 범위 계정 · 쓰기 범위 계정은 요약
  const C = await import('../src/vcinfo/collect.js');
  C.putFromEdge('vc-1', { alarms: { at: null, error: RAW } }, 'e1');
  const got = async (u) => (await call(u, '/vcenter-info/alarms?vcenterId=vc-1')).j;
  assert.equal((await got('fadm')).error, RAW, '전체 범위 관리자는 원문');
  for (const u of ['sadm', 'wadm']) assert.equal((await got(u)).error, ERROR_HIDDEN_TEXT, `${u} 에 원문이 나갔다`);
  C._resetVcInfo();
});

// ── 67 ①: 공개 API 500 ─────────────────────────────────────────────────────
test('67 ① — 공개 API 500 은 원문 없이 일반 문구 + 요청 id · 원문은 서버 로그에(요청 id 로 대조)', async () => {
  const express = (await import('express')).default;
  const v1 = (await import('../src/routes/publicApi.js')).default;
  const keys = await import('../src/publicapi/keys.js');
  const key = keys.issueApiKey({ name: 'g1a', groups: ['inventory'] }).plaintext;
  const app = express();
  app.use('/api/v1', v1);
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const saved = store.snapshot;
  const logs = []; const orig = console.error;
  console.error = (...a) => { logs.push(a.join(' ')); };
  try {
    store.snapshot = { ...saved, vcenters: [null] };   // 핸들러 안에서 TypeError(내부 예외)
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/v1/inventory/summary`, { headers: { 'X-Api-Key': key } });
    const b = await r.json();
    assert.equal(r.status, 500);
    assert.equal(b.code, 'internal');
    assert.ok(b.requestId && b.reason.includes(b.requestId), JSON.stringify(b));
    assert.match(b.reason, /^내부 오류 — 요청 id /);
    assert.doesNotMatch(JSON.stringify(b), /TypeError|Cannot read|null/i, '내부 예외 원문이 외부로 나갔다');
    const line = logs.find((l) => l.includes(b.requestId));
    assert.ok(line && /Cannot read|TypeError/.test(line), '원문이 요청 id 와 함께 서버 로그에 남아야 한다');
  } finally { console.error = orig; store.snapshot = saved; srv.close(); }
  const doc = fs.readFileSync(new URL('../../docs/API-PUBLIC.md', import.meta.url), 'utf8');
  assert.match(doc, /\| 500 \| `internal` \|[^\n]*요청 id[^\n]*requestId/, 'API-PUBLIC.md 오류 계약 줄');
});

// ── 64 F5(현행 유지 · 문구): 같은 호스트 비루프백 프록시 ─────────────────────
test('66 ② — 허용목록 밖 프록시 오류 문구가 허용목록에 넣으면 진행된다고 말한다(판정은 그대로)', async () => {
  const R = await import('../src/hostaccess/render.js');
  const { settings } = R.normalizeSettings({ web: { mode: 'allowlist', allow: ['10.1.1.0/24'] } }, { portalPorts: ['4000'] });
  const cur = R.parseListAll('public (active)\n  target: default\n  interfaces: ens192\n  services: ssh\n  ports: 4000/tcp\n  rich rules:\n');
  const bad = R.planCommands(settings, cur, { requesterIp: '10.1.1.50', peerIp: '172.17.0.1' });
  assert.ok(bad.errors.some((e) => /172\.17\.0\.1.*허용목록에 그 주소를 넣으면 진행됩니다/.test(e)), JSON.stringify(bad.errors));
});
