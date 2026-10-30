/**
 * v2.826 — 엣지 개별 central 토큰 자동 적용: 옛 판 엣지(실서버 agent-WA 2.775.0 — '엣지 응답 HTTP 401' 로 실패) 처리.
 *  · 401 = 옛 판 엣지(라우트 없음 → /api 로그인 인증) → '기능 없음' · 확정 취소 · hint 'upgrade'
 *  · 사전 점검이 엣지 판을 다시 당기고(refreshStatus), 낮으면서 SSH 통로도 없으면 **발급하지 않고** 멈춘다
 *  · upgradeFirst: 낮으면 번들 push → 새 판 확인(대기) → 발급·적용 / 이미 충분하면 건너뜀 / push 실패·시한 초과는 발급 전 중단
 *  · 낮은 판 + SSH 배포 기록: 수집 토큰 통로는 보내지 않고 SSH 로 바로
 *  · 실제 의존성 묶음(realTokenApplyDeps)에 refreshStatus·upgradeEdge 가 있다 · upgradeEdgeNow 는 번들 없음·push 실패를 사유로 돌려준다
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tokapply2826-'));
Object.assign(process.env, { CONFIG_DIR: DIR, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' });
for (const k of ['CENTRAL_URL', 'CENTRAL_TOKEN', 'AGENT_CENTRAL_TOKEN', 'COLLECTOR_TOKEN', 'EDGE_MODE', 'CENTRAL_REQUIRE_AGENT_TOKEN']) delete process.env[k];
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const J = await import('../src/central/tokenApplyJob.js');
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;
const TOK = 'A'.repeat(20) + 'b_c-' + 'Z'.repeat(19);

function fakeDeps(over = {}) {
  let t = NOW;
  const tokens = []; const calls = { issue: 0, revoke: 0, push: 0, ssh: 0, refresh: 0, upgrade: 0, save: [], audit: [] };
  const d = {
    calls, tokens,
    now: () => t, sleep: async (ms) => { t += ms; },
    tokensLoadError: () => null,
    findCollector: (n) => (String(n).toLowerCase() === 'agent-wa' ? { id: 'agent-WA', name: 'agent-WA', url: 'http://192.168.40.221:4000', token: 'COL-REG', enabled: true } : null),
    statusOf: () => ({ version: '2.775.0', hostname: 'LESANXMPWB01' }),
    listTokens: () => tokens.map((x) => ({ ...x })),
    issue: (agent) => { calls.issue++; tokens.push({ agent, createdAt: t, lastUsedAt: null }); return { ok: true, agent, token: TOK }; },
    audit: (o) => { calls.audit.push(o.action); },
    revoke: (agent) => { calls.revoke++; const i = tokens.findIndex((x) => x.agent === agent); if (i >= 0) tokens.splice(i, 1); return { ok: true }; },
    deployTargets: () => [],
    saveTarget: (b) => { calls.save.push(b); return { ok: true }; },
    pushEdge: async () => { calls.push++; return { ok: false, status: 401, body: null }; },   // 옛 판 엣지: 라우트 없음 → 로그인 인증 401
    sshApply: async () => { calls.ssh++; return { ok: true }; },
    refreshStatus: async () => { calls.refresh++; return true; },
    ...over,
  };
  return d;
}
const stepsOf = (job) => job.steps.map((s) => [s.key, s.state]);

test('1 실서버 사례 — 판 2.775.0 · 배포 기록 없음 · 업그레이드 옵션 없음 → 판을 다시 당기고, 발급하지 않고 멈춘다(hint upgrade)', async () => {
  J._resetForTest();
  const d = fakeDeps({ upgradeEdge: async () => ({ ok: true }) });
  const { job } = await J.startTokenApply('agent-WA', { by: 'noainred', deps: d, wait: true });
  assert.equal(job.state, 'failed');
  assert.deepEqual(stepsOf(job), [['precheck', 'bad']], '발급·전달 단계가 없다(공회전 없음)');
  assert.equal(d.calls.issue, 0); assert.equal(d.calls.push, 0); assert.equal(d.calls.revoke, 0);
  assert.equal(d.calls.refresh, 1, '낮게 보이면 그 엣지만 다시 당겨 확인한다');
  assert.equal(job.edgeVersion, '2.775.0'); assert.equal(job.hint, 'upgrade');
  assert.match(job.summary, /2\.775\.0/); assert.match(job.summary, /2\.776\.0/); assert.match(job.summary, /발급하지 않음/);
  assert.match(job.summary, /엣지 업그레이드 뒤 자동 적용/);
  assert.match(job.steps[0].detail, /방금 다시 당겨 확인/);
  assert.ok(!job.summary.includes('`'), '백틱 없음(BoldText)');
});

test('1b 업그레이드 push 가 연결돼 있지 않으면 hint 없이 수동 업그레이드·SSH 등록을 안내한다', async () => {
  J._resetForTest();
  const d = fakeDeps();
  const { job } = await J.startTokenApply('agent-WA', { deps: d, wait: true });
  assert.equal(job.state, 'failed'); assert.equal(job.hint, '');
  assert.match(job.summary, /설정 › 수집 서버 › 업그레이드/);
});

test('2 판을 모르는데 엣지가 401 → 기능 없음으로 읽고 확정 취소 · hint upgrade · 요약이 다음 수단을 말한다', async () => {
  J._resetForTest();
  const d = fakeDeps({ statusOf: () => ({}), upgradeEdge: async () => ({ ok: true }) });
  const { job } = await J.startTokenApply('agent-WA', { deps: d, wait: true });
  assert.equal(job.state, 'failed');
  assert.deepEqual(stepsOf(job), [['precheck', 'ok'], ['issue', 'ok'], ['edge-api', 'bad'], ['ssh', 'skip'], ['cleanup', 'ok']]);
  assert.equal(d.calls.push, 1); assert.equal(d.calls.revoke, 1); assert.equal(d.tokens.length, 0, '확정 취소 — 엣지는 아무것도 받지 않았다');
  const ea = job.steps.find((s) => s.key === 'edge-api');
  assert.match(ea.detail, /HTTP 401/); assert.match(ea.detail, /로그인 인증/); assert.match(ea.detail, /2\.776\.0 이상 필요/);
  assert.ok(!/엣지 응답 HTTP 401$/.test(ea.detail), '정체불명 오류 문구가 아니다');
  assert.equal(job.hint, 'upgrade');
  assert.match(job.summary, /엣지 업그레이드 뒤 자동 적용/);
  assert.match(job.steps[0].detail, /판을 몰라/);
});

test('2b 다시 당겨 보니 판이 충분하면 — 그대로 수집 토큰 통로로 적용한다(오래된 pull 상태로 업그레이드를 권하지 않는다)', async () => {
  J._resetForTest();
  let fresh = false;
  const d = fakeDeps({
    statusOf: () => ({ version: fresh ? '2.826.0' : '2.775.0' }),
    refreshStatus: async () => { fresh = true; return true; },
    pushEdge: async () => { d.tokens[0].lastUsedAt = d.now() + 1; return { ok: true, status: 200, body: { ok: true, applied: true, steps: [] } }; },
  });
  const { job } = await J.startTokenApply('agent-WA', { deps: d, wait: true });
  assert.equal(job.state, 'ok', job.summary); assert.equal(job.path, 'edge-api'); assert.equal(job.edgeVersion, '2.826.0');
  assert.deepEqual(stepsOf(job), [['precheck', 'ok'], ['issue', 'ok'], ['edge-api', 'ok'], ['verify', 'ok'], ['deploy-record', 'skip']]);
  assert.equal(d.calls.ssh, 0);
});

test('3 upgradeFirst — 낮은 판: 번들 push → 재시작 뒤 새 판 확인 → 발급 → 수집 토큰 통로 적용 · 단계·감사 기록', async () => {
  J._resetForTest();
  let upAt = null; let version = '2.775.0';
  const d = fakeDeps({
    statusOf: () => ({ version, hostname: 'LESANXMPWB01' }),
    upgradeEdge: async (c) => { d.calls.upgrade++; assert.equal(c.id, 'agent-WA'); upAt = d.now(); return { ok: true, version: '2.826.0' }; },
    // 엣지는 push 뒤 25초 동안 재시작(당김 실패) → 그 뒤 새 판으로 답한다
    refreshStatus: async () => { d.calls.refresh++; if (upAt != null && d.now() - upAt >= 25_000) version = '2.826.0'; return version === '2.826.0'; },
    pushEdge: async () => { d.calls.push++; d.tokens[0].lastUsedAt = d.now() + 1; return { ok: true, status: 200, body: { ok: true, applied: true, hostname: 'LESANXMPWB01', steps: [{ key: 'probe', ok: true, detail: '중앙 확인 성공' }] } }; },
  });
  const { job } = await J.startTokenApply('agent-WA', { by: 'noainred', deps: d, wait: true, upgradeFirst: true });
  assert.equal(job.state, 'ok', job.summary); assert.equal(job.path, 'edge-api'); assert.equal(job.upgradeFirst, true);
  assert.deepEqual(stepsOf(job), [['precheck', 'ok'], ['upgrade', 'ok'], ['issue', 'ok'], ['edge-api', 'ok'], ['verify', 'ok'], ['deploy-record', 'skip']]);
  assert.equal(d.calls.upgrade, 1); assert.equal(d.calls.push, 1); assert.equal(d.calls.ssh, 0);
  assert.equal(job.edgeVersion, '2.826.0');
  const up = job.steps.find((s) => s.key === 'upgrade');
  assert.match(up.detail, /v2\.826\.0 전달/); assert.match(up.detail, /엣지 판 2\.826\.0 확인/);
  assert.ok(d.calls.audit.includes('엣지 업그레이드 push(개별 토큰 자동 적용)'));
  assert.ok(d.calls.audit.indexOf('엣지 업그레이드 push(개별 토큰 자동 적용)') < d.calls.audit.indexOf('엣지 개별 central 토큰 발급(자동 적용)'), '업그레이드가 발급보다 먼저');
  const file = fs.readFileSync(path.join(DIR, J.LOG_FILE_NAME), 'utf8');
  assert.ok(!file.includes(TOK), '기록 파일에 평문 없음');
});

test('3b upgradeFirst — 판이 이미 충분하면 업그레이드 단계를 건너뛰고 바로 적용한다', async () => {
  J._resetForTest();
  const d = fakeDeps({
    statusOf: () => ({ version: '2.800.0' }),
    upgradeEdge: async () => { d.calls.upgrade++; return { ok: true, version: '2.826.0' }; },
    pushEdge: async () => { d.tokens[0].lastUsedAt = d.now() + 1; return { ok: true, status: 200, body: { ok: true, applied: true, steps: [] } }; },
  });
  const { job } = await J.startTokenApply('agent-WA', { deps: d, wait: true, upgradeFirst: true });
  assert.equal(job.state, 'ok', job.summary);
  assert.equal(d.calls.upgrade, 0); assert.equal(d.calls.refresh, 0, '충분하면 다시 당기지도 않는다');
  assert.deepEqual(stepsOf(job).slice(0, 3), [['precheck', 'ok'], ['upgrade', 'skip'], ['issue', 'ok']]);
});

test('3c upgradeFirst — 번들 push 실패 → 발급 전 중단(토큰 없음·취소 없음) · 사유를 싣는다', async () => {
  J._resetForTest();
  const d = fakeDeps({ upgradeEdge: async () => ({ ok: false, reason: 'HTTP 403 — 토큰 불일치 · 토큰(COLLECTOR_TOKEN) 불일치' }) });
  const { job } = await J.startTokenApply('agent-WA', { deps: d, wait: true, upgradeFirst: true });
  assert.equal(job.state, 'failed');
  assert.deepEqual(stepsOf(job), [['precheck', 'ok'], ['upgrade', 'bad']]);
  assert.equal(d.calls.issue, 0); assert.equal(d.calls.revoke, 0);
  assert.match(job.summary, /HTTP 403/); assert.match(job.summary, /발급하지 않았습니다/);
});

test('3d upgradeFirst — 시한 안에 새 판으로 올라오지 않으면 발급하지 않고 멈춘다(확인 횟수·지금 판을 남긴다)', async () => {
  J._resetForTest();
  const d = fakeDeps({ upgradeEdge: async () => ({ ok: true, version: '2.826.0' }), upgradeWaitMs: 60_000, upgradePollMs: 10_000 });
  const { job } = await J.startTokenApply('agent-WA', { deps: d, wait: true, upgradeFirst: true });
  assert.equal(job.state, 'failed'); assert.equal(d.calls.issue, 0);
  const up = job.steps.find((s) => s.key === 'upgrade');
  assert.equal(up.state, 'bad'); assert.match(up.detail, /60초 안에/); assert.match(up.detail, /확인 6회/); assert.match(up.detail, /지금 보이는 판 2\.775\.0/);
  assert.match(job.summary, /다시 실행하세요/);
});

test('3e upgradeFirst — 번들 판을 알면 그 판 이상으로 올라와야 확인(2.776 이상이어도 번들보다 낮은 중간 상태는 기다린다)', async () => {
  J._resetForTest();
  let version = '2.775.0'; let n = 0;
  const d = fakeDeps({
    statusOf: () => ({ version }),
    upgradeEdge: async () => ({ ok: true, version: '2.826.0' }),
    refreshStatus: async () => { n++; if (n === 2) version = '2.780.0'; if (n >= 4) version = '2.826.0'; return true; },   // n=1 은 사전 점검의 당김(그대로 낮음)
    pushEdge: async () => { d.tokens[0].lastUsedAt = d.now() + 1; return { ok: true, status: 200, body: { ok: true, applied: true, steps: [] } }; },
  });
  const { job } = await J.startTokenApply('agent-WA', { deps: d, wait: true, upgradeFirst: true });
  assert.equal(job.state, 'ok', job.summary);
  assert.match(job.steps.find((s) => s.key === 'upgrade').detail, /3회 당김/);
});

test('4 낮은 판 + SSH 배포 기록 1건 → 수집 토큰 통로는 보내지 않고 SSH 로 바로 · edgeNew false', async () => {
  J._resetForTest();
  let opts = null;
  const d = fakeDeps({
    deployTargets: () => [{ id: 'd1', agentName: 'agent-WA', host: '10.9.9.9', port: 22, username: 'root', collectorToken: 'COL-REG', centralToken: 'shared-old', portalPort: 4000 }],
    sshApply: async (target, token, o) => { opts = o; o.onStep('write', true, '기록'); d.tokens[0].lastUsedAt = d.now() + 1; return { ok: true }; },
  });
  const { job } = await J.startTokenApply('agent-WA', { deps: d, wait: true });
  assert.equal(job.state, 'ok', job.summary); assert.equal(job.path, 'ssh');
  assert.equal(d.calls.push, 0, '옛 판에는 보내지 않는다(401 이 될 뿐)');
  assert.equal(opts.edgeNew, false); assert.equal(opts.expectHostname, 'LESANXMPWB01');
  assert.deepEqual(stepsOf(job), [['precheck', 'ok'], ['issue', 'ok'], ['edge-api', 'skip'], ['ssh', 'ok'], ['verify', 'ok'], ['deploy-record', 'ok']]);
});

test('5 edgeApiVersionState — 충분 true · 낮음 false · 모름 null(낮다고 보지 않는다)', () => {
  assert.equal(J.edgeApiVersionState('2.776.0'), true);
  assert.equal(J.edgeApiVersionState('2.826.0'), true);
  assert.equal(J.edgeApiVersionState('2.775.0'), false);
  assert.equal(J.edgeApiVersionState(''), null);
  assert.equal(J.edgeApiVersionState('dev'), null);
  assert.equal(J.edgeApiVersionState(undefined), null);
  assert.equal(J.STEP_LABEL.upgrade, '엣지 업그레이드');
  // 웹 판정(views/edgeTokenSyncText.js)과 같은 최소 판 — 두 벌이면 테스트가 대조한다
  const webText = fs.readFileSync(new URL('../../web/src/views/edgeTokenSyncText.js', import.meta.url), 'utf8');
  const m = webText.match(/export const MIN_EDGE_API_VERSION = '([^']+)'/);
  assert.ok(m, '웹 상수가 있다'); assert.equal(m[1], J.MIN_EDGE_API_VERSION);
  // 웹 cmpVersion 사본은 서버 util 과 본문이 같다(주석 제외 — 제거기는 test/_stripComments.js 하나)
  const strip = (t) => stripComments(t).replace(/\s+/g, ' ').trim();
  const sv = strip(fs.readFileSync(new URL('../src/util/cmpVersion.js', import.meta.url), 'utf8'));
  const wv = strip(fs.readFileSync(new URL('../../web/src/cmpVersion.js', import.meta.url), 'utf8'));
  assert.equal(wv, sv, '웹 cmpVersion 이 서버 util 과 같다');
});

test('6 실제 의존성 — refreshStatus·upgradeEdge 가 있다 · upgradeEdgeNow 는 번들 없음·대상 아님·push 실패를 사유로(던지지 않는다)', async () => {
  const D = await import('../src/central/tokenApplyDeps.js');
  const d = D.realTokenApplyDeps();
  assert.equal(typeof d.refreshStatus, 'function'); assert.equal(typeof d.upgradeEdge, 'function');
  const col = { id: 'agent-WA', name: 'agent-WA', url: 'http://192.168.40.221:4000', token: 'COL-REG' };
  let r = await D.upgradeEdgeNow(col, { resolve: async () => null, settings: () => ({}) });
  assert.equal(r.ok, false); assert.ok(r.reason);
  r = await D.upgradeEdgeNow(col, { resolve: async () => ({ bytes: Buffer.from('x'), version: '2.826.0', manifest: null }), push: async (bytes, o) => { assert.deepEqual(o.ids, ['agent-WA']); return [{ id: 'agent-WA', ok: false, reason: 'HTTP 403 — 토큰 불일치' }]; }, settings: () => ({}) });
  assert.equal(r.ok, false); assert.equal(r.version, '2.826.0'); assert.match(r.reason, /HTTP 403/);
  r = await D.upgradeEdgeNow(col, { resolve: async () => ({ bytes: Buffer.from('x'), version: '2.826.0' }), push: async () => [], settings: () => ({}) });
  assert.equal(r.ok, false); assert.match(r.reason, /대상이 아닙니다/);
  r = await D.upgradeEdgeNow(col, { resolve: async () => ({ bytes: Buffer.from('x'), version: '2.826.0' }), push: async () => [{ id: 'agent-WA', ok: true, version: '2.826.0' }], settings: () => ({}) });
  assert.equal(r.ok, true); assert.equal(r.version, '2.826.0');
  r = await D.upgradeEdgeNow(col, { resolve: async () => { throw new Error('boom'); }, settings: () => ({}) });
  assert.equal(r.ok, false); assert.match(r.reason, /boom/);
});
