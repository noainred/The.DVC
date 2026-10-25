/**
 * v2.781(점검 G2) — 엣지 개별 central 토큰 자동 적용의 '받아들였는가' 판정 · 엣지 쪽 '읽히지 않는 env 파일' 거부.
 *  A-B1 acceptedSince 가 pullStats 행의 **끈적한** verified 플래그 + 공유·개별 요청이 섞인 lastOkAt 을 봐서, 한 번이라도 개별 토큰 요청이 성공한
 *       이름이면 이후 공유 토큰 pull(X-Agent-Name)도 '새 토큰을 받아들임' 으로 봤다.
 *       ① 중앙→엣지 POST 가 결과를 모르는 실패(ECONNREFUSED)인데 '적용됨' → 작업 ok(엣지는 토큰을 받은 적 없음)
 *       ② 엣지 persist-failed(바뀐 것 없음) → SSH 쓰기 전 실패 → 그 사이 공유 pull 때문에 회수 안 함 → 다음 실행이 사전 점검에서 막힘
 *       수정: 행에 lastVerifiedOkAt(그 요청이 개별 토큰으로 검증됐고 status<400 일 때만) — acceptedSince 는 그것만 본다.
 *       이중 방어: 엣지가 applied:false 로 확정 답했고 SSH 가 쓰지 않았으면(또는 SSH 를 못 가면) 회수는 definite.
 *  A-I1 Windows 옛 start-portal.bat(PORTAL_ENV_FILE 없음) 엣지 — 다음 기동이 읽지 않는 파일에 쓰고 applied:true 로 답하던 것을
 *       쓰기·확인 전에 applied:false · persist-failed 로 답한다(중앙은 '바뀐 것 없음' 으로 다룬다).
 * ⚠ 이 파일의 A-B1 회귀는 **실제** recordPull/pullStats 를 쓴다(가짜 행은 B-8 처럼 새 필드가 없어 결함을 가린다).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2781b-'));
Object.assign(process.env, { CONFIG_DIR: DIR, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' });
for (const k of ['CENTRAL_URL', 'CENTRAL_TOKEN', 'AGENT_CENTRAL_TOKEN', 'COLLECTOR_TOKEN', 'EDGE_MODE', 'CENTRAL_REQUIRE_AGENT_TOKEN']) delete process.env[k];
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const { config } = await import('../src/config.js');
const P = await import('../src/central/pullStats.js');
const J = await import('../src/central/tokenApplyJob.js');
const A = await import('../src/agent/centralTokenApply.js');

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;   // 정시 경계로 고정(docs/rules/common.md)
const TOK = 'Q'.repeat(21) + '_x-' + 'k'.repeat(19);
assert.equal(TOK.length, 43);

/** 실제 pullStats 를 쓰는 의존성. clock 은 테스트가 움직인다. */
function mkDeps(over = {}) {
  const st = { clock: NOW, tokens: [], revoke: 0 };
  const d = {
    st,
    now: () => st.clock, sleep: async (ms) => { st.clock += ms; },
    tokensLoadError: () => null,
    findCollector: (n) => ({ id: 'c1', name: n, url: 'https://edge:4000', token: 'col', enabled: true }),
    listTokens: () => st.tokens.map((x) => ({ ...x })),
    issue: (n) => { st.tokens = [{ agent: n, createdAt: st.clock, lastUsedAt: null }]; return { ok: true, token: TOK }; },
    revoke: (n) => { st.revoke++; st.tokens = st.tokens.filter((t) => t.agent !== n); return { ok: true }; },
    statusOf: () => ({ version: '2.777.0', agent: 'AZ-IRS', hostname: 'irs01' }),
    deployTargets: () => [],
    saveTarget: () => ({ ok: true }),
    pushEdge: async () => ({ ok: false, status: null, body: null, error: 'x' }),
    sshApply: async () => ({ ok: false, reason: 'x' }),
    pullStats: P.pullStats,
    verifyWaitMs: 20_000,
    ...over,
  };
  return d;
}
const sharedPull = (d) => P.recordPull('AZ-IRS', '/veeam-config', { status: 200, verified: false, now: d.st.clock });

/* ═════════════ pullStats — lastVerifiedOkAt ═════════════ */
test('P-1 lastVerifiedOkAt 은 개별 토큰으로 검증되고 성공한 요청에서만 오른다(공유 pull·검증된 403 은 올리지 않는다)', () => {
  P.resetPullStats();
  P.recordPull('E1', '/health-probe', { status: 200, verified: true, now: NOW + 10 });
  P.recordPull('E1', '/veeam-config', { status: 200, verified: false, now: NOW + 20 });   // 공유 토큰 + X-Agent-Name
  P.recordPull('E1', '/veeam-config', { status: 403, verified: true, now: NOW + 30 });    // 개별 토큰이지만 거절
  P.recordPull('E1', '/veeam-config', { status: 0, verified: true, now: NOW + 40 });      // 상태 모름
  const row = P.pullStats().rows.find((r) => r.agent === 'E1');
  assert.equal(row.verified, true, '행 플래그는 예전처럼 끈적하다(지도·Veeam 진행 상태 표시용)');
  assert.equal(row.lastVerifiedOkAt, NOW + 10);
  // 공유만 쓴 행은 0
  P.recordPull('E2', '/veeam-config', { status: 200, verified: false, now: NOW + 50 });
  assert.equal(P.pullStats().rows.find((r) => r.agent === 'E2').lastVerifiedOkAt, 0);
  P.resetPullStats();
});

/* ═════════════ A-B1 경로 ① — 결과를 모르는 실패 + 공유 pull ═════════════ */
test('B1-1 앞서 개별 토큰 요청이 한 번 성공한 이름이어도, 중앙→엣지 ECONNREFUSED 동안의 공유 토큰 pull 은 적용 근거가 아니다', async () => {
  P.resetPullStats(); J._resetForTest();
  const d = mkDeps();
  sharedPull(d);
  P.recordPull('AZ-IRS', '/health-probe', { status: 200, verified: true, now: d.st.clock });   // 같은 가동 중 앞선 일(이전 작업의 probe 등)
  d.st.clock += 60_000;
  d.pushEdge = async () => { d.st.clock += 10_000; sharedPull(d); return { ok: false, status: null, body: null, error: 'connect ECONNREFUSED' }; };
  const { job } = await J.startTokenApply('AZ-IRS', { deps: d, wait: true });
  assert.notEqual(job.state, 'ok', `엣지가 받은 적 없는 토큰을 '완료' 로 끝내지 않는다: ${job.summary}`);
  assert.equal(job.steps.find((x) => x.key === 'edge-api').state, 'bad');
  assert.equal(d.st.tokens.length, 0, '엣지에 전달하지 못한 토큰은 회수한다');
  assert.equal(d.st.revoke, 1);
  P.resetPullStats();
});

test('B1-2 결과를 모르는 실패여도 새 토큰의 검증된 요청이 실제로 받아들여졌으면 그대로 적용됨으로 본다(반증 F1 유지)', async () => {
  P.resetPullStats(); J._resetForTest();
  const d = mkDeps();
  d.pushEdge = async () => {
    d.st.clock += 2_000; P.recordPull('AZ-IRS', '/health-probe', { status: 200, verified: true, now: d.st.clock });   // 엣지의 확인 요청(새 토큰)
    d.st.clock += 15_000; return { ok: false, status: null, body: null, error: 'The operation was aborted due to timeout' };
  };
  const { job } = await J.startTokenApply('AZ-IRS', { deps: d, wait: true });
  assert.equal(job.path, 'edge-api');
  assert.equal(job.steps.find((x) => x.key === 'edge-api').state, 'warn');
  assert.equal(d.st.revoke, 0, '엣지가 쓰고 있을 수 있는 토큰은 회수하지 않는다');
  P.resetPullStats();
});

/* ═════════════ A-B1 경로 ② — persist-failed → SSH 쓰기 전 실패 ═════════════ */
test('B1-3 엣지 persist-failed 뒤 SSH 가 쓰기 전에 멈추면 — 그 사이 공유 pull 이 와도 회수하고, 다음 실행이 막히지 않는다', async () => {
  P.resetPullStats(); J._resetForTest();
  const target = { id: 'd1', agentName: 'AZ-IRS', host: '10.0.0.9', port: 22, username: 'root', portalPort: 4000 };
  const d = mkDeps({ deployTargets: () => [target] });
  d.pushEdge = async () => {
    d.st.clock += 2_000; P.recordPull('AZ-IRS', '/health-probe', { status: 200, verified: true, now: d.st.clock }); d.st.tokens[0].lastUsedAt = d.st.clock;
    d.st.clock += 500;
    return { ok: true, status: 200, body: { ok: false, applied: false, reason: 'persist-failed', steps: [{ key: 'persist', ok: false, detail: 'portal.env 에 쓰지 못했습니다' }], hostname: 'irs01' } };
  };
  d.sshApply = async (_t, _tk, { onStep }) => { d.st.clock += 8_000; sharedPull(d); onStep('identity', false, 'not that edge'); return { ok: false, reason: '접속한 장비가 그 엣지가 아닙니다(아무것도 바꾸지 않았습니다)' }; };
  const { job } = await J.startTokenApply('AZ-IRS', { deps: d, wait: true });
  assert.equal(job.state, 'failed');
  assert.equal(d.st.tokens.length, 0, '엣지가 저장하지 않은 토큰을 남기지 않는다');
  assert.equal(job.steps.find((x) => x.key === 'cleanup').state, 'ok');
  // 다음 실행 — 사전 점검이 '이미 개별 토큰' 으로 막지 않는다
  d.pushEdge = async () => ({ ok: false, status: 404 });
  d.sshApply = async () => ({ ok: false, reason: 'x' });
  const r2 = await J.startTokenApply('AZ-IRS', { deps: d, wait: true });
  assert.equal(r2.job.steps[0].state, 'ok', r2.job.steps[0].detail);
  P.resetPullStats();
});

test('B1-4 이중 방어 — 엣지가 applied:false 로 확정 답했고 SSH 가 쓰지 않았으면, 검증된 요청 기록이 있어도 회수한다(배포 기록 없음 갈래 포함)', async () => {
  // 늦게 도착한 검증 요청(응답 뒤 시각)이 있다고 가정 — 확정 답이 우선이다
  const freshRow = (d) => () => ({ rows: [{ agent: 'AZ-IRS', verified: true, lastVerifiedOkAt: d.st.clock + 10, byEndpoint: [{ endpoint: '/veeam-config', lastOkAt: d.st.clock + 10 }] }], since: NOW });
  const body = { ok: true, status: 200, body: { ok: false, applied: false, reason: 'persist-failed', steps: [] } };
  // ① 배포 기록 없음(SSH 못 감)
  J._resetForTest();
  let d = mkDeps({ pushEdge: async () => { d.st.clock += 1_000; return body; } });
  d.pullStats = freshRow(d);
  let { job } = await J.startTokenApply('AZ-IRS', { deps: d, wait: true });
  assert.equal(job.state, 'failed'); assert.equal(d.st.revoke, 1, '배포 기록 없음 갈래도 확정 답이면 회수');
  // ② SSH 가 쓰기 전에 멈춤
  J._resetForTest();
  d = mkDeps({ deployTargets: () => [{ id: 'd1', agentName: 'AZ-IRS', host: 'h', port: 22, username: 'root', portalPort: 4000 }], pushEdge: async () => { d.st.clock += 1_000; return body; } });
  d.pullStats = freshRow(d);
  d.sshApply = async () => ({ ok: false, reason: 'root 권한이 필요합니다' });
  ({ job } = await J.startTokenApply('AZ-IRS', { deps: d, wait: true }));
  assert.equal(job.state, 'failed'); assert.equal(d.st.revoke, 1, 'SSH 쓰기 전 실패도 회수');
  // ③ SSH 가 쓰고 재시작한 뒤 되돌렸다 — 재시작한 엣지가 새 토큰을 썼을 수 있으므로 확정으로 보지 않는다(받아들인 기록이 있으면 회수 안 함)
  J._resetForTest();
  d = mkDeps({ deployTargets: () => [{ id: 'd1', agentName: 'AZ-IRS', host: 'h', port: 22, username: 'root', portalPort: 4000 }], pushEdge: async () => { d.st.clock += 1_000; return body; } });
  d.pullStats = freshRow(d);
  d.sshApply = async (_t, _tk, { onStep }) => { onStep('write', true, 'AGENT_CENTRAL_TOKEN 기록'); d.st.clock += 5_000; return { ok: false, reverted: true, reason: '재시작 뒤 서비스 상태가 failed 였습니다 — 되돌렸습니다' }; };
  ({ job } = await J.startTokenApply('AZ-IRS', { deps: d, wait: true }));
  assert.equal(job.state, 'failed'); assert.equal(d.st.revoke, 0, '쓰고 재시작한 뒤의 되돌림은 받아들인 기록이 있으면 회수하지 않는다');
});

test('B1-5 SSH 통로 성공 뒤 확인 — 공유 pull 만 오면 ok 가 아니고, 새 토큰의 검증된 요청이 오면 ok', async () => {
  const target = { id: 'd1', agentName: 'AZ-IRS', host: 'h', port: 22, username: 'root', portalPort: 4000 };
  // 공유 pull 만
  P.resetPullStats(); J._resetForTest();
  P.recordPull('AZ-IRS', '/health-probe', { status: 200, verified: true, now: NOW - 5 * 60_000 });   // 앞선 일
  let d = mkDeps({ deployTargets: () => [target], statusOf: () => ({ version: '2.770.0', agent: 'AZ-IRS' }), pushEdge: async () => ({ ok: false, status: 404 }) });
  d.sleep = async (ms) => { d.st.clock += ms; sharedPull(d); };
  d.sshApply = async (_t, _tk, { onStep }) => { onStep('write', true, 'AGENT_CENTRAL_TOKEN 기록'); return { ok: true }; };
  let { job } = await J.startTokenApply('AZ-IRS', { deps: d, wait: true });
  assert.equal(job.state, 'warn', '공유 토큰 pull 은 새 토큰 확인이 아니다');
  // 새 토큰의 검증된 요청
  P.resetPullStats(); J._resetForTest();
  d = mkDeps({ deployTargets: () => [target], statusOf: () => ({ version: '2.770.0', agent: 'AZ-IRS' }), pushEdge: async () => ({ ok: false, status: 404 }) });
  d.sleep = async (ms) => { d.st.clock += ms; P.recordPull('AZ-IRS', '/veeam-config', { status: 200, verified: true, now: d.st.clock }); };
  d.sshApply = async (_t, _tk, { onStep }) => { onStep('write', true, 'AGENT_CENTRAL_TOKEN 기록'); return { ok: true }; };
  ({ job } = await J.startTokenApply('AZ-IRS', { deps: d, wait: true }));
  assert.equal(job.state, 'ok', job.summary);
  P.resetPullStats();
});

/* ═════════════ A-I1 — 엣지: 다음 기동이 읽지 않는 env 파일 ═════════════ */
test('I1-1 env 파일이 기동 때 읽힌 파일이 아니면(옛 start-portal.bat) 확인·기록 없이 applied:false · persist-failed — 파일·메모리 그대로', async () => {
  A._resetForTest();
  const env = path.join(DIR, 'i1.env'); const orig = 'PORT=4000\nCENTRAL_TOKEN=shared-old\n'; fs.writeFileSync(env, orig);
  config.agent.centralUrl = 'http://c:4001'; config.agent.centralToken = 'shared-old';
  delete process.env.AGENT_CENTRAL_TOKEN;
  let probed = 0;
  const r = await A.applyAgentCentralToken({ token: TOK, envFile: env, envFileLoaded: false, probe: async () => { probed++; return { ok: true, yourAgent: 'AZ-IRS', ms: 1 }; } });
  assert.equal(r.ok, false); assert.equal(r.applied, false); assert.equal(r.reason, 'persist-failed');
  assert.equal(probed, 0, '쓸 수 없으면 중앙 확인도 하지 않는다');
  assert.equal(fs.readFileSync(env, 'utf8'), orig);
  assert.equal(config.agent.centralToken, 'shared-old');
  assert.equal(process.env.AGENT_CENTRAL_TOKEN, undefined);
  const st = r.steps.find((x) => x.key === 'persist');
  assert.ok(st && st.ok === false); assert.match(st.detail, /PORTAL_ENV_FILE/);
  assert.ok(!JSON.stringify(r).includes(TOK));
  // 기본값(리눅스 — systemd EnvironmentFile 이 읽는다)은 예전처럼 기록한다
  const r2 = await A.applyAgentCentralToken({ token: TOK, envFile: env, probe: async () => ({ ok: true, yourAgent: 'AZ-IRS', ms: 1 }) });
  assert.equal(r2.applied, true, JSON.stringify(r2));
  config.agent.centralToken = 'shared-old'; delete process.env.AGENT_CENTRAL_TOKEN;
});

test('I1-2 중앙 — 엣지의 persist-failed 사유(단계 문구)를 작업 기록에 남긴다', async () => {
  P.resetPullStats(); J._resetForTest();
  const d = mkDeps({ pushEdge: async () => ({ ok: true, status: 200, body: { ok: false, applied: false, reason: 'persist-failed', steps: [{ key: 'persist', ok: false, detail: '시작 스크립트가 PORTAL_ENV_FILE 을 넘기지 않아 기록해도 다음 기동이 읽지 않습니다' }] } }) });
  const { job } = await J.startTokenApply('AZ-IRS', { deps: d, wait: true });
  assert.equal(job.state, 'failed');
  assert.match(job.steps.find((x) => x.key === 'edge-api').detail, /PORTAL_ENV_FILE/);
  assert.equal(d.st.revoke, 1);
});
