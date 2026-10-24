/**
 * v2.776 — 엣지 개별 central 토큰 자동 적용(사용자 요청: 자동 수정 + 세부 진행 화면 + 로그 저장 · 실서버 AZ-IRS 공유 토큰 → Veeam 403).
 *  A 엣지: agent/centralTokenApply.js — 형식 · 엄격 기록 · 확인 실패 시 파일·메모리 원복 · 응답에 토큰 없음 · config 우선순위(AGENT_CENTRAL_TOKEN)
 *  B 중앙 작업: central/tokenApplyJob.js(가짜 의존성) — 수집 토큰 통로 · 엣지 되돌림 → 발급 취소(SSH 안 감) · 404 → SSH · 배포 기록 맞춤 ·
 *    이미 토큰 있음 → 발급 안 함 · 동시 실행 거부 · 재시작 시 '진행 중' 정리 · 기록에 평문 없음
 *  C 종단: 실제 중앙 라우트(발급·작업·health-probe) + 실제 엣지 라우트(/api/collector/central-token) — 한 프로세스에서 HTTP 로
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tokapply2776-'));
Object.assign(process.env, { CONFIG_DIR: DIR, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' });
for (const k of ['CENTRAL_URL', 'CENTRAL_TOKEN', 'AGENT_CENTRAL_TOKEN', 'COLLECTOR_TOKEN', 'EDGE_MODE', 'CENTRAL_REQUIRE_AGENT_TOKEN']) delete process.env[k];
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const { config } = await import('../src/config.js');
const A = await import('../src/agent/centralTokenApply.js');
const J = await import('../src/central/tokenApplyJob.js');
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;
const TOK = 'A'.repeat(20) + 'b_c-' + 'Z'.repeat(19);   // 43자 base64url
assert.equal(TOK.length, 43);

/* ═════════════ A 엣지 ═════════════ */
test('A-1 형식이 아니면 거부하고 아무것도 쓰지 않는다', async () => {
  const env = path.join(DIR, 'a1.env'); fs.writeFileSync(env, 'PORT=4000\n');
  config.agent.centralUrl = 'http://central.invalid:4001';
  const r = await A.applyAgentCentralToken({ token: 'short', envFile: env, probe: async () => ({ ok: true }) });
  assert.equal(r.ok, false); assert.equal(r.reason, 'bad-token');
  assert.equal(fs.readFileSync(env, 'utf8'), 'PORT=4000\n');
});

test('A-2 성공 — AGENT_CENTRAL_TOKEN 기록(다른 줄·CENTRAL_TOKEN 그대로) · 메모리 반영 · 응답에 토큰 평문 없음', async () => {
  const env = path.join(DIR, 'a2.env');
  const orig = 'PORT=4000\nCENTRAL_URL=http://c:4001\nCENTRAL_TOKEN=shared-old\nCOLLECTOR_TOKEN=col\n';
  fs.writeFileSync(env, orig);
  config.agent.centralUrl = 'http://c:4001'; config.agent.centralToken = 'shared-old';
  let probed = '';
  const r = await A.applyAgentCentralToken({ token: TOK, envFile: env, probe: async (t) => { probed = t; return { ok: true, yourAgent: 'AZ-IRS', ms: 3 }; } });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.applied, true);
  assert.equal(probed, TOK, '확인은 새 토큰으로');
  const after = fs.readFileSync(env, 'utf8');
  assert.match(after, new RegExp(`^AGENT_CENTRAL_TOKEN=${TOK}$`, 'm'));
  assert.match(after, /^CENTRAL_TOKEN=shared-old$/m, '받는 문(CENTRAL_TOKEN)은 건드리지 않는다');
  assert.match(after, /^COLLECTOR_TOKEN=col$/m);
  assert.equal(config.agent.centralToken, TOK);
  assert.ok(!JSON.stringify(r).includes(TOK), '응답에 토큰 평문이 없다');
  assert.ok(r.fp && r.fp.length >= 6);
});

test('A-3 확인 실패 — 아무것도 바꾸지 않는다(파일 바이트 그대로 · 메모리·process.env 그대로) · applied:false', async () => {
  const env = path.join(DIR, 'a3.env');
  const orig = 'PORT=4000\nCENTRAL_TOKEN=shared-old\n# 주석 유지\n';
  fs.writeFileSync(env, orig);
  config.agent.centralUrl = 'http://c:4001'; config.agent.centralToken = 'shared-old';
  delete process.env.AGENT_CENTRAL_TOKEN;
  const r = await A.applyAgentCentralToken({ token: TOK, envFile: env, probe: async () => ({ ok: false, reason: '중앙이 새 토큰을 거절했습니다(HTTP 403)' }) });
  assert.equal(r.ok, false); assert.equal(r.applied, false); assert.equal(r.reason, 'probe-failed');
  assert.equal(fs.readFileSync(env, 'utf8'), orig);
  assert.equal(config.agent.centralToken, 'shared-old');
  assert.equal(process.env.AGENT_CENTRAL_TOKEN, undefined);
});

test('A-4 portal.env 를 읽지 못하면(디렉터리) 쓰지 않고 메모리도 그대로', async () => {
  const env = path.join(DIR, 'a4-dir.env'); fs.mkdirSync(env, { recursive: true });
  config.agent.centralUrl = 'http://c:4001'; config.agent.centralToken = 'shared-old';
  const r = await A.applyAgentCentralToken({ token: TOK, envFile: env, probe: async () => ({ ok: true }) });
  assert.equal(r.ok, false); assert.equal(r.reason, 'persist-failed');
  assert.equal(config.agent.centralToken, 'shared-old');
});

test('A-6 반증 F3 — 확인하는 동안에는 파일·메모리가 아직 이전 값(확인된 뒤에만 바꾼다)', async () => {
  const env = path.join(DIR, 'a6.env'); const orig = 'PORT=4000\nCENTRAL_TOKEN=shared-old\n'; fs.writeFileSync(env, orig);
  config.agent.centralUrl = 'http://c:4001'; config.agent.centralToken = 'shared-old';
  let during = null;
  const r = await A.applyAgentCentralToken({ token: TOK, envFile: env, probe: async () => { during = [config.agent.centralToken, fs.readFileSync(env, 'utf8')]; return { ok: true, yourAgent: 'AZ-IRS', ms: 1 }; } });
  assert.equal(r.applied, true);
  assert.deepEqual(during, ['shared-old', orig]);
});

test('A-5 config — AGENT_CENTRAL_TOKEN 이 보내는 토큰, CENTRAL_TOKEN 은 받는 문(별도 프로세스)', () => {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', "const { config } = await import('./src/config.js'); console.log(JSON.stringify([config.agent.centralToken, config.central.token]));"],
    { cwd: path.resolve(new URL('..', import.meta.url).pathname), env: { ...process.env, CONFIG_DIR: DIR, CENTRAL_TOKEN: 'shared-in', AGENT_CENTRAL_TOKEN: 'agent-out' }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), ['agent-out', 'shared-in']);
});

/* ═════════════ B 중앙 작업(가짜 의존성) ═════════════ */
function fakeDeps(over = {}) {
  let t = NOW;
  const tokens = []; const calls = { issue: 0, revoke: 0, push: 0, ssh: 0, save: [], audit: [] };
  const d = {
    calls, tokens,
    now: () => t, sleep: async (ms) => { t += ms; },
    tokensLoadError: () => null,
    findCollector: (n) => (String(n).toLowerCase() === 'az-irs' ? { id: 'AZ-IRS', name: 'AZ-IRS', url: 'http://192.168.88.221:4068', token: 'COL-REG', enabled: true } : null),
    statusOf: () => ({ version: '2.776.0' }),
    listTokens: () => tokens.map((x) => ({ ...x })),
    issue: (agent) => { calls.issue++; tokens.push({ agent, createdAt: t, lastUsedAt: null }); return { ok: true, agent, token: TOK }; },
    audit: (o) => { calls.audit.push(o.action); },
    revoke: (agent) => { calls.revoke++; const i = tokens.findIndex((x) => x.agent === agent); if (i >= 0) tokens.splice(i, 1); return { ok: true }; },
    deployTargets: () => [{ id: 'd1', agentName: 'AZ-IRS', host: '10.9.9.9', port: 22, username: 'root', collectorToken: 'COL-OLD', centralToken: 'shared-old', portalPort: 4000 }],
    saveTarget: (b) => { calls.save.push(b); return { ok: true }; },
    pushEdge: async () => { calls.push++; tokens[0].lastUsedAt = t + 1; return { ok: true, status: 200, body: { ok: true, applied: true, steps: [{ key: 'probe', ok: true, detail: '중앙 확인 성공' }] } }; },
    sshApply: async () => { calls.ssh++; return { ok: true }; },
    ...over,
  };
  return d;
}

test('B-1 수집 토큰 통로 성공 — 단계·통로·배포 기록(central·수집 토큰) 맞춤 · 기록 파일에 평문 없음', async () => {
  J._resetForTest();
  const d = fakeDeps();
  const r = await J.startTokenApply('AZ-IRS', { by: 'noainred', deps: d, wait: true });
  const job = r.job;
  assert.equal(job.state, 'ok', job.summary); assert.equal(job.path, 'edge-api');
  assert.deepEqual(job.steps.map((s) => [s.key, s.state]), [['precheck', 'ok'], ['issue', 'ok'], ['edge-api', 'ok'], ['verify', 'ok'], ['deploy-record', 'ok']]);
  assert.equal(d.calls.ssh, 0);
  assert.equal(d.calls.save.length, 1);
  assert.equal(d.calls.save[0].centralToken, TOK);
  assert.equal(d.calls.save[0].collectorToken, 'COL-REG', '배포 기록 수집 토큰을 등록값으로(등록값과 다름 해소)');
  assert.equal(d.calls.save[0].host, '10.9.9.9', '접속처를 바꾸지 않는다(비밀 승계 판정 유지)');
  const file = fs.readFileSync(path.join(DIR, J.LOG_FILE_NAME), 'utf8');
  assert.ok(!file.includes(TOK), '작업 기록 파일에 토큰 평문이 없다');
  assert.ok(file.includes(job.fp));
  assert.deepEqual(d.calls.audit, ['엣지 개별 central 토큰 발급(자동 적용)', '엣지 개별 central 토큰 자동 적용 완료'], '반증 F8: 발급·결과가 감사에 남는다');
});

test('B-2 엣지가 확인 실패(바뀐 것 없음)로 답하면 — SSH 로 가지 않고 발급 취소(확인 요청이 lastUsedAt 을 찍었어도 확정 답이 우선)', async () => {
  J._resetForTest();
  const d = fakeDeps();
  d.pushEdge = async () => { d.tokens[0].lastUsedAt = d.now(); return { ok: true, status: 200, body: { ok: false, applied: false, reason: 'probe-failed', probe: { reason: '중앙은 이 토큰을 엣지 X 의 것으로 봅니다' }, steps: [] } }; };
  const { job } = await J.startTokenApply('AZ-IRS', { deps: d, wait: true });
  assert.equal(job.state, 'failed');
  assert.equal(d.calls.ssh, 0);
  assert.equal(d.calls.revoke, 1);
  assert.equal(d.tokens.length, 0);
  assert.match(job.summary, /같은 경로라 SSH 로도 같습니다/);
});

test('B-3 옛 판 엣지(404) → SSH 통로 · 판 모름이면 CENTRAL_TOKEN 도 바꾼다고 알린다 · 사용 확인을 기다린다', async () => {
  J._resetForTest();
  let opts = null;
  const d = fakeDeps({ statusOf: () => ({ version: '2.770.0' }), pushEdge: async () => ({ ok: false, status: 404, body: null }) });
  // 재시작한 엣지가 확인 대기 중 어느 시점에 새 토큰으로 접속한다(가짜 시계 기준 40초 뒤)
  d.sshApply = async (target, token, o) => { opts = o; o.onStep('write', true, 'AGENT_CENTRAL_TOKEN·CENTRAL_TOKEN 기록'); return { ok: true }; };
  const realList = d.listTokens;
  d.listTokens = () => { const l = realList(); if (l[0] && d.now() >= NOW + 40_000) l[0].lastUsedAt = NOW + 40_000; return l; };
  const { job } = await J.startTokenApply('AZ-IRS', { deps: d, wait: true });
  assert.equal(job.state, 'ok', job.summary); assert.equal(job.path, 'ssh');
  assert.equal(opts.edgeNew, false, '옛 판(2.770) — SSH 본문이 키 구성을 보고 CENTRAL_TOKEN 교체 여부를 정한다');
  assert.equal(opts.urlPort, 4000, '배포 기록의 portalPort(수집 URL 의 포워딩 포트가 아니라)');
  assert.match(job.steps.find((s) => s.key === 'edge-api').detail, /HTTP 404/);
});

test('B-4 404 + 배포 기록 없음 → 발급 취소 · 실패 / SSH 가 쓴 뒤 실패(되돌림 없음) → 취소하지 않고 경고', async () => {
  J._resetForTest();
  let d = fakeDeps({ pushEdge: async () => ({ ok: false, status: 404 }), deployTargets: () => [] });
  let { job } = await J.startTokenApply('AZ-IRS', { deps: d, wait: true });
  assert.equal(job.state, 'failed'); assert.equal(d.calls.revoke, 1);
  assert.equal(job.steps.find((s) => s.key === 'ssh').state, 'skip');

  J._resetForTest();
  d = fakeDeps({ pushEdge: async () => ({ ok: false, status: null, error: 'connect ETIMEDOUT' }) });
  d.sshApply = async (t, tok, o) => { o.onStep('write', true, 'AGENT_CENTRAL_TOKEN 기록'); return { ok: false, reason: '연결이 끊겼습니다' }; };
  ({ job } = await J.startTokenApply('AZ-IRS', { deps: d, wait: true }));
  assert.equal(job.state, 'failed'); assert.equal(d.calls.revoke, 0, '엣지가 새 토큰을 쓰고 있을 수 있으면 취소하지 않는다');
  assert.equal(job.steps.find((s) => s.key === 'cleanup').state, 'warn');
});

test('B-5 이미 개별 토큰이 있으면 발급하지 않는다 · 동시 실행 거부 · 재시작 시 진행 중 기록 정리', async () => {
  J._resetForTest();
  const d = fakeDeps(); d.tokens.push({ agent: 'AZ-IRS', lastUsedAt: NOW });
  const { job } = await J.startTokenApply('AZ-IRS', { deps: d, wait: true });
  assert.equal(job.state, 'failed'); assert.equal(d.calls.issue, 0);

  J._resetForTest();
  let release; const gate = new Promise((ok) => { release = ok; });
  const d2 = fakeDeps({ pushEdge: async () => { await gate; return { ok: false, status: 404 }; }, deployTargets: () => [] });
  const first = J.startTokenApply('AZ-IRS', { deps: d2 });
  assert.equal(first.ok, true);
  const second = J.startTokenApply('az-irs', { deps: d2 });
  assert.equal(second.ok, false); assert.equal(second.jobId, first.job.id);
  // 진행 중인 채로 '재시작'(메모리 초기화 → 파일에서 다시 읽기)
  J._resetForTest();
  const reloaded = J.getJob(first.job.id);
  assert.equal(reloaded.state, 'failed');
  assert.match(reloaded.summary, /다시 시작돼 작업이 중단/);
  release();
});

/* ═════════════ C 종단(실제 라우트) ═════════════ */
let centralBase = ''; let edgeBase = '';
before(async () => {
  const express = (await import('express')).default;
  // 엣지(같은 프로세스): 수집 라우터
  const { collectorRouter } = await import('../src/routes/collector.js');
  const edge = express(); edge.use('/api/collector', collectorRouter);
  const es = await new Promise((ok) => { const s = edge.listen(0, '127.0.0.1', () => ok(s)); });
  closers.push(() => new Promise((ok) => { es.closeAllConnections?.(); es.close(() => ok()); }));
  edgeBase = `http://127.0.0.1:${es.address().port}`;
  // 중앙: central 라우터(health-probe) + 관리 라우트(발급·작업)
  const { centralRouter } = await import('../src/routes/central.js');
  const { registerCentralTokens } = await import('../src/routes/admin/centralTokens.js');
  const app = express(); app.use(express.json());
  app.use('/api/central', centralRouter);
  const admin = express.Router();
  app.use('/api/admin', (req, _res, next) => { req.user = { username: 'noainred', role: 'admin' }; next(); }, admin);
  registerCentralTokens(admin);
  const cs = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  closers.push(() => new Promise((ok) => { cs.closeAllConnections?.(); cs.close(() => ok()); }));
  centralBase = `http://127.0.0.1:${cs.address().port}`;
});

test('C 종단 — 발급 → 엣지 라우트(수집 토큰) → 엣지가 새 토큰으로 health-probe → 중앙 사용 확인 → 기록 조회', async () => {
  J._resetForTest();
  const T = await import('../src/central/agentTokens.js'); T._resetAgentTokenCache();
  const { _resetForTest: resetApply } = A; resetApply();
  config.central.token = 'SHARED-CENTRAL';                    // 중앙 활성(공유 토큰도 계속 받는다)
  config.collector.token = 'COLTOK-E2E';                      // 엣지 수집 토큰
  config.agent.centralUrl = centralBase; config.agent.name = 'AZ-IRS'; config.agent.centralToken = 'SHARED-CENTRAL';
  fs.writeFileSync(path.join(DIR, 'collectors.json'), JSON.stringify({ collectors: [{ id: 'AZ-IRS', name: 'AZ-IRS', url: edgeBase, token: 'COLTOK-E2E', enabled: true }] }));
  fs.writeFileSync(path.join(DIR, 'portal.env'), 'PORT=4000\nCENTRAL_TOKEN=SHARED-CENTRAL\nCOLLECTOR_TOKEN=COLTOK-E2E\n');

  // 수집 토큰이 틀리면 엣지가 거절하고 아무것도 바꾸지 않는다
  const bad = await fetch(`${edgeBase}/api/collector/central-token`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Collector-Token': 'WRONG' }, body: JSON.stringify({ token: TOK }) });
  assert.equal(bad.status, 403);
  assert.equal(config.agent.centralToken, 'SHARED-CENTRAL');

  const st = await fetch(`${centralBase}/api/admin/central/agent-tokens/AZ-IRS/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(st.status, 202);
  const { job } = await st.json();
  let cur = job;
  for (let i = 0; i < 100 && cur.state === 'running'; i++) {
    await new Promise((ok) => setTimeout(ok, 100));
    cur = (await (await fetch(`${centralBase}/api/admin/central/token-apply/jobs/${job.id}`)).json()).job;
  }
  assert.equal(cur.state, 'ok', `${cur.summary} :: ${JSON.stringify(cur.steps)}`);
  assert.equal(cur.path, 'edge-api');
  const envAfter = fs.readFileSync(path.join(DIR, 'portal.env'), 'utf8');
  const m = /^AGENT_CENTRAL_TOKEN=(.+)$/m.exec(envAfter);
  assert.ok(m, 'portal.env 에 AGENT_CENTRAL_TOKEN');
  assert.equal(String(T.resolveAgentByToken(m[1])).toLowerCase(), 'az-irs', '그 값은 중앙이 AZ-IRS 로 해석하는 개별 토큰');
  assert.match(envAfter, /^CENTRAL_TOKEN=SHARED-CENTRAL$/m);
  assert.equal(config.agent.centralToken, m[1]);
  // 기록 조회 — 목록·단건에 평문 없음
  const list = await (await fetch(`${centralBase}/api/admin/central/token-apply/jobs?agent=AZ-IRS`)).json();
  assert.equal(list.jobs[0].id, job.id);
  assert.ok(!JSON.stringify(list).includes(m[1]), '기록 응답에 토큰 평문이 없다');
  // 이미 개별 토큰이 생겼으니 다시 누르면 사전 점검에서 멈춘다(기존 토큰 폐기 방지)
  const again = await (await fetch(`${centralBase}/api/admin/central/agent-tokens/AZ-IRS/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  let j2 = again.job;
  for (let i = 0; i < 50 && j2.state === 'running'; i++) { await new Promise((ok) => setTimeout(ok, 50)); j2 = (await (await fetch(`${centralBase}/api/admin/central/token-apply/jobs/${again.job.id}`)).json()).job; }
  assert.equal(j2.state, 'failed'); assert.match(j2.steps[0].detail, /이미 개별 토큰/);
  assert.equal(String(T.resolveAgentByToken(m[1])).toLowerCase(), 'az-irs', '기존 토큰이 그대로 유효');
});

/* ═════════════ D SSH 통로 본문(가짜 셸 — 파일 내용을 흉내 낸다) ═════════════ */
function fakeShell({ env, root = true, active = 'active', appendFails = false, restoreFails = false, hostname = 'edge2' }) {
  const fs0 = { '/etc/vmware-portal/portal.env': env };
  const cmds = [];
  const tmp = {};
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const exec = async (c) => {
    cmds.push(c);
    if (c === 'id -u') return ok(root ? '0\n' : '1000\n');
    if (c.startsWith('ss -ltnp')) return ok('');
    if (c.startsWith('grep -E \'^PORT=\'')) return ok('PORT=4000\n');
    if (c.startsWith('test -f')) return ok('yes\n');
    let m;
    if ((m = /^grep -oE '\^\(([A-Z_|]+)\)=' '([^']+)'/.exec(c))) { const ks = m[1].split('|'); return ok(fs0[m[2]].split('\n').map((l) => l.split('=')[0]).filter((k) => ks.includes(k)).map((k) => `${k}=`).join('\n')); }
    // v2.777 정체 확인 — 이름 키 두 개(값까지 — 비밀 아님) · hostname
    if ((m = /^grep -E '\^\(AGENT_NAME\|COLLECTOR_DATACENTER\)=' '([^']+)'/.exec(c))) { const ls = fs0[m[1]].split('\n').filter((x) => /^(AGENT_NAME|COLLECTOR_DATACENTER)=/.test(x)); return ok(ls.length ? `${ls.join('\n')}\n` : ''); }
    if (c.startsWith('hostname')) return ok(hostname ? `${hostname}\n` : '');
    if ((m = /^grep -E '\^EDGE_MODE=' '([^']+)'/.exec(c))) { const l = fs0[m[1]].split('\n').filter((x) => x.startsWith('EDGE_MODE=')).pop(); return ok(l ? `${l}\n` : ''); }
    if ((m = /^cp -p '([^']+)' '([^']+)'/.exec(c))) { if (restoreFails && m[1].includes('.bak-token-')) return { code: 1, stdout: '', stderr: 'Read-only file system' }; fs0[m[2]] = fs0[m[1]]; return ok(); }
    if ((m = /^sed -i '\/\^([A-Z_]+)=\/d' '([^']+)'$/.exec(c))) { fs0[m[2]] = fs0[m[2]].split('\n').filter((l) => !l.startsWith(`${m[1]}=`)).join('\n'); return ok(); }
    if ((m = /^cat '([^']+)' >> '([^']+)'$/.exec(c))) { if (appendFails) return { code: 1, stdout: '', stderr: 'No space left on device' }; fs0[m[2]] += tmp[m[1]]; return ok(); }
    if (c.startsWith('rm -f')) return ok();
    if (c.startsWith('systemctl is-active')) return ok(`${active}\n`);
    return ok('');
  };
  const writeFile = async (p, text) => { tmp[p] = text; };
  return { exec, writeFile, cmds, files: fs0 };
}
const ENV0 = 'PORT=4000\nAGENT_NAME=AZ-IRS\nCENTRAL_URL=http://c:4001\nCENTRAL_TOKEN=shared-old\nCOLLECTOR_TOKEN=col';
const AG = { agent: 'AZ-IRS' };

test('D-1 SSH 본문 — AGENT_CENTRAL_TOKEN 만 쓰고(받는 문 그대로) 재시작 · 토큰이 어떤 명령 인자에도 없다', async () => {
  const { applyAgentCentralTokenOverExec } = await import('../src/agent/deploy.js');
  const sh = fakeShell({ env: ENV0 });
  const steps = [];
  const r = await applyAgentCentralTokenOverExec(sh, TOK, { ...AG, host: '10.9.9.9', urlPort: 4000, edgeNew: true, onStep: (k, ok) => steps.push(`${k}:${ok}`), waitTries: 2, waitDelaySec: 0 });
  assert.equal(r.ok, true, r.reason);
  const env = sh.files['/etc/vmware-portal/portal.env'];
  assert.match(env, new RegExp(`^AGENT_CENTRAL_TOKEN=${TOK}$`, 'm'));
  assert.match(env, /^CENTRAL_TOKEN=shared-old$/m);
  assert.ok(sh.cmds.every((c) => !c.includes(TOK)), '토큰이 셸 명령 인자로 나가지 않는다(ps 노출 방지 — SFTP 임시 파일)');
  assert.ok(sh.cmds.some((c) => c.startsWith('systemctl restart vmware-portal')));
  assert.deepEqual(steps, ['ssh:true', 'identity:true', 'backup:true', 'write:true', 'restart:true']);
});

test('D-2 옛 판(edgeNew:false · CENTRAL_TOKEN 줄 있음) — CENTRAL_TOKEN 도 새 값 / 재시작 실패 → 사본으로 원복·다시 시작', async () => {
  const { applyAgentCentralTokenOverExec } = await import('../src/agent/deploy.js');
  let sh = fakeShell({ env: ENV0 });
  let r = await applyAgentCentralTokenOverExec(sh, TOK, { ...AG, host: 'h', urlPort: 4000, edgeNew: false, waitTries: 2, waitDelaySec: 0 });
  assert.equal(r.ok, true);
  assert.match(sh.files['/etc/vmware-portal/portal.env'], new RegExp(`^CENTRAL_TOKEN=${TOK}$`, 'm'));

  sh = fakeShell({ env: ENV0, active: 'failed' });
  r = await applyAgentCentralTokenOverExec(sh, TOK, { ...AG, host: 'h', urlPort: 4000, edgeNew: false, waitTries: 3, waitDelaySec: 0 });
  assert.equal(r.ok, false); assert.equal(r.reverted, true);
  assert.equal(sh.files['/etc/vmware-portal/portal.env'], ENV0, '원래 내용으로');
  assert.equal(sh.cmds.filter((c) => c.startsWith('systemctl restart')).length, 2, '되돌린 뒤 다시 시작');
});

test('D-3 붙이기 실패(디스크 가득) → 사본으로 원복 · 재시작하지 않음 / root 아님 → 아무것도 바꾸지 않음', async () => {
  const { applyAgentCentralTokenOverExec, forceAgentCentralToken } = await import('../src/agent/deploy.js');
  let sh = fakeShell({ env: ENV0, appendFails: true });
  let r = await applyAgentCentralTokenOverExec(sh, TOK, { ...AG, host: 'h', urlPort: 4000, edgeNew: false, waitTries: 2, waitDelaySec: 0 });
  assert.equal(r.ok, false); assert.equal(r.reverted, true);
  assert.equal(sh.files['/etc/vmware-portal/portal.env'], ENV0, 'CENTRAL_TOKEN 줄만 지워진 채 남지 않는다');
  assert.ok(!sh.cmds.some((c) => c.startsWith('systemctl restart')));

  sh = fakeShell({ env: ENV0, root: false });
  r = await applyAgentCentralTokenOverExec(sh, TOK, { ...AG, host: 'h', urlPort: 4000, edgeNew: true });
  assert.equal(r.ok, false); assert.match(r.reason, /root/);
  assert.equal(sh.cmds.length, 1);
  // 진입 검사 — 형식·host
  assert.match((await forceAgentCentralToken({}, TOK)).reason, /host\/username/);
  assert.match((await forceAgentCentralToken({ host: 'h', username: 'root' }, "abc'; rm -rf /")).reason, /형식/);
});

test('B-6 반증 F1 — 엣지 응답을 못 받았지만(시한) 새 토큰 요청이 이미 받아들여졌으면 회수하지 않고 적용으로 본다', async () => {
  J._resetForTest();
  const d = fakeDeps({ deployTargets: () => [] });
  d.pushEdge = async () => { d.tokens[0].lastUsedAt = d.now() + 1; return { ok: false, status: null, body: null, error: 'The operation was aborted due to timeout' }; };
  const { job } = await J.startTokenApply('AZ-IRS', { deps: d, wait: true });
  assert.equal(d.calls.revoke, 0, '엣지가 쓰고 있을 수 있는 토큰을 회수하지 않는다(회수하면 엣지가 잠긴다)');
  assert.equal(job.path, 'edge-api');
  assert.equal(job.steps.find((x) => x.key === 'edge-api').state, 'warn');
  assert.equal(job.state, 'ok', job.summary);
});

test('B-7 반증 F4 — 수집 서버가 보고한 엣지 이름이 다르면 발급하지 않는다', async () => {
  J._resetForTest();
  const d = fakeDeps({ statusOf: () => ({ version: '2.776.0', agent: 'AZ-IRS-2' }) });
  const { job } = await J.startTokenApply('AZ-IRS', { deps: d, wait: true });
  assert.equal(job.state, 'failed'); assert.equal(d.calls.issue, 0);
  assert.match(job.steps[0].detail, /AZ-IRS-2/);
});

test('B-8 반증 F4 — 확인은 받아들인 요청(pullStats verified·성공)으로 — 이름 불일치 403 은 확인으로 치지 않는다', async () => {
  J._resetForTest();
  const d = fakeDeps({ statusOf: () => ({ version: '2.770.0' }), pushEdge: async () => ({ ok: false, status: 404 }), verifyWaitMs: 20_000 });
  d.sshApply = async (tg, tok, o) => { o.onStep('write', true, 'AGENT_CENTRAL_TOKEN 기록'); d.tokens[0].lastUsedAt = d.now() + 1; return { ok: true }; };   // 인증은 됐지만(lastUsedAt) 이름이 달라 403
  d.pullStats = () => ({ rows: [{ agent: 'AZ-IRS', verified: true, byEndpoint: [{ endpoint: '/veeam-config', lastOkAt: 0, lastFailAt: d.now() }] }] });
  const { job } = await J.startTokenApply('AZ-IRS', { deps: d, wait: true });
  assert.equal(job.state, 'warn', '받아들인 요청이 없으면 ok 로 끝내지 않는다');
  assert.equal(job.steps.find((x) => x.key === 'verify').state, 'warn');
});

test('B-9 반증 F8 — 그 사이 다시 발급된 토큰은 정리 단계가 회수하지 않는다', async () => {
  J._resetForTest();
  const d = fakeDeps({ deployTargets: () => [] });
  d.pushEdge = async () => { d.tokens[0] = { agent: 'AZ-IRS', createdAt: d.now() + 999, lastUsedAt: null }; return { ok: false, status: 404 }; };
  const { job } = await J.startTokenApply('AZ-IRS', { deps: d, wait: true });
  assert.equal(d.calls.revoke, 0);
  assert.equal(job.steps.find((x) => x.key === 'cleanup').state, 'warn');
});

test('B-10 엣지가 기록 실패(바뀐 것 없음)로 답한 뒤 SSH 도 쓰기 전에 멈추면 — 확인 요청 기록이 있어도 회수한다', async () => {
  J._resetForTest();
  const d = fakeDeps({ statusOf: () => ({ version: '2.776.0' }) });
  d.pushEdge = async () => { d.tokens[0].lastUsedAt = d.now(); return { ok: true, status: 200, body: { ok: false, applied: false, reason: 'persist-failed', steps: [] } }; };
  d.sshApply = async () => ({ ok: false, reason: 'portal.env 수정에는 root 권한이 필요합니다' });
  const { job } = await J.startTokenApply('AZ-IRS', { deps: d, wait: true });
  assert.equal(job.state, 'failed'); assert.equal(d.calls.revoke, 1);
});

test('D-4 반증 F6 — 옛 판 엣지의 키 구성이 위험하면 바꾸지 않고 멈춘다(값은 읽지 않는다) · 반증 F5 — 되돌리기 실패를 되돌렸다고 말하지 않는다', async () => {
  const { applyAgentCentralTokenOverExec, oldEdgeEnvDecision } = await import('../src/agent/deploy.js');
  assert.equal(oldEdgeEnvDecision(['CENTRAL_TOKEN', 'COLLECTOR_TOKEN'], '').ok, true);
  assert.equal(oldEdgeEnvDecision(['CENTRAL_TOKEN'], 'all').ok, false, 'EDGE_MODE=all + COLLECTOR_TOKEN 없음 → 수집 토큰까지 바뀐다');
  assert.equal(oldEdgeEnvDecision(['CENTRAL_TOKEN', 'COLLECTOR_TOKEN'], 'all').ok, true);
  assert.match(oldEdgeEnvDecision(['EDGE_TOKEN', 'COLLECTOR_TOKEN'], 'all').reason, /EDGE_TOKEN/);
  // EDGE_TOKEN 만 쓰는 권장 구성 — 아무것도 쓰지 않는다
  const env1 = 'PORT=4000\nAGENT_NAME=AZ-IRS\nEDGE_MODE=all\nEDGE_TOKEN=e\nCOLLECTOR_TOKEN=c';
  let sh = fakeShell({ env: env1 });
  let r = await applyAgentCentralTokenOverExec(sh, TOK, { ...AG, host: 'h', urlPort: 4000, edgeNew: false, waitTries: 2, waitDelaySec: 0 });
  assert.equal(r.ok, false); assert.match(r.reason, /v2\.776/);
  assert.equal(sh.files['/etc/vmware-portal/portal.env'], env1);
  assert.ok(!sh.cmds.some((c) => c.startsWith('cp ') || c.startsWith('sed ') || c.startsWith('systemctl restart')));
  assert.ok(sh.cmds.every((c) => !/grep -E '\^(CENTRAL_TOKEN|EDGE_TOKEN|COLLECTOR_TOKEN)=/.test(c)), '토큰 값을 출력하는 grep 이 없다(키 이름만 -o)');
  // 붙이기 실패 + 되돌리기도 실패 → restoreFailed(되돌렸다고 말하지 않는다)
  sh = fakeShell({ env: ENV0, appendFails: true, restoreFails: true });
  r = await applyAgentCentralTokenOverExec(sh, TOK, { ...AG, host: 'h', urlPort: 4000, edgeNew: false, waitTries: 2, waitDelaySec: 0 });
  assert.equal(r.ok, false); assert.equal(r.reverted, undefined); assert.equal(r.restoreFailed, true);
  assert.match(r.reason, /직접 복구/);
});

test('D-5 반증 F5 — SSH 가 되돌리기에 실패하면 중앙은 발급을 취소하지 않는다', async () => {
  J._resetForTest();
  const d = fakeDeps({ statusOf: () => ({ version: '2.770.0' }), pushEdge: async () => ({ ok: false, status: 404 }) });
  d.sshApply = async (tg, tok, o) => { o.onStep('write', false, '기록 실패 — 사본으로 되돌리기도 실패'); return { ok: false, restoreFailed: true, backup: '/etc/vmware-portal/portal.env.bak-token-1', reason: '직접 복구' }; };
  const { job } = await J.startTokenApply('AZ-IRS', { deps: d, wait: true });
  assert.equal(job.state, 'failed'); assert.equal(d.calls.revoke, 0);
  assert.match(job.steps.find((x) => x.key === 'cleanup').detail, /직접 복구/);
});

test('B-11 반증 F1 — 응답 시한 뒤 엣지의 늦은 요청이 회수 직전에 받아들여졌으면 회수하지 않는다', async () => {
  J._resetForTest();
  const d = fakeDeps({ statusOf: () => ({ version: '2.776.0' }) });
  d.pushEdge = async () => ({ ok: false, status: null, body: null, error: 'The operation was aborted due to timeout' });
  // SSH 통로는 쓰기 전에 멈추지만, 그 사이 엣지의 늦은 확인 요청(새 토큰)이 중앙에 받아들여졌다
  d.sshApply = async () => { d.tokens[0].lastUsedAt = d.now() + 1; return { ok: false, reason: 'SSH 접속 시간 초과' }; };
  const { job } = await J.startTokenApply('AZ-IRS', { deps: d, wait: true });
  assert.equal(job.state, 'failed');
  assert.equal(d.calls.revoke, 0, '엣지가 쓰고 있을 수 있는 토큰은 회수하지 않는다');
  assert.match(job.steps.find((x) => x.key === 'cleanup').detail, /받아들였습니다/);
});

/* ═════════════ E v2.777 — 메인 → 엣지1(포워딩) → 엣지2 구성: 접속한 장비가 그 엣지인가(이름·보고 호스트 이름) ═════════════ */
test('E-1 effectiveAgentName(config.js 순서 · 마지막 값 · 따옴표) · sameHostName(대소문자·끝 점·FQDN/짧은 이름·모름은 null)', async () => {
  const { effectiveAgentName } = await import('../src/agent/deploy.js');
  const { sameHostName } = await import('../src/util/sameHostName.js');
  assert.equal(effectiveAgentName('AGENT_NAME=EDGE1\nAGENT_NAME="AZ-IRS"\n', 'h'), 'AZ-IRS', 'EnvironmentFile — 마지막 값이 이긴다 · 따옴표 벗김');
  assert.equal(effectiveAgentName('COLLECTOR_DATACENTER=DC-2\n', 'h'), 'DC-2');
  assert.equal(effectiveAgentName("AGENT_NAME=''\nCOLLECTOR_DATACENTER=DC-2", 'h'), 'DC-2', '빈 AGENT_NAME 은 다음 순서로');
  assert.equal(effectiveAgentName('', 'edge2\n'), 'edge2');
  assert.equal(effectiveAgentName('', ''), '');
  assert.equal(sameHostName('Edge2', 'edge2'), true);
  assert.equal(sameHostName('edge2.corp.local.', 'EDGE2.corp.local'), true);
  assert.equal(sameHostName('edge2', 'edge2.corp.local'), true, '한쪽만 FQDN 이면 첫 마디로');
  assert.equal(sameHostName('edge2.a.local', 'edge2.b.local'), false, '둘 다 FQDN 이면 전체가 같아야');
  assert.equal(sameHostName('edge1', 'edge2'), false);
  assert.equal(sameHostName('', 'edge2'), null, '모르면 판정하지 않는다');
  assert.equal(sameHostName(undefined, 'edge2'), null);
});

test('E-2 SSH 가 엣지1 자신에 닿으면(포워딩 오류) 이름이 달라 아무것도 바꾸지 않는다 · 보고 호스트 이름이 다르면 멈춘다 · 대상 이름 모르면 멈춘다', async () => {
  const { applyAgentCentralTokenOverExec } = await import('../src/agent/deploy.js');
  const touched = (sh) => sh.cmds.some((c) => c.startsWith('cp ') || c.startsWith('sed ') || c.startsWith('cat ') || c.startsWith('systemctl restart'));
  // ① 엣지1(중계)에 붙었다 — 그 portal.env 의 이름은 EDGE1
  const env1 = ENV0.replace('AGENT_NAME=AZ-IRS', 'AGENT_NAME=EDGE1');
  let sh = fakeShell({ env: env1, hostname: 'edge1' });
  const steps = [];
  let r = await applyAgentCentralTokenOverExec(sh, TOK, { ...AG, host: '10.0.0.1', urlPort: 4000, edgeNew: true, onStep: (k, ok, d) => steps.push([k, ok, d]), waitTries: 2, waitDelaySec: 0 });
  assert.equal(r.ok, false); assert.match(r.reason, /'EDGE1'.*'AZ-IRS'/);
  assert.equal(sh.files['/etc/vmware-portal/portal.env'], env1, '엣지1 의 portal.env 그대로');
  assert.ok(!touched(sh));
  assert.deepEqual(steps.map((x) => `${x[0]}:${x[1]}`), ['ssh:true', 'identity:false']);
  // ② 이름은 같지만(portal.env 를 복사해 만든 장비) 엣지가 보고한 호스트 이름과 다르다
  sh = fakeShell({ env: ENV0, hostname: 'edge1' });
  r = await applyAgentCentralTokenOverExec(sh, TOK, { ...AG, expectHostname: 'edge2.corp.local', host: 'h', urlPort: 4000, edgeNew: true, waitTries: 2, waitDelaySec: 0 });
  assert.equal(r.ok, false); assert.match(r.reason, /edge1.*edge2\.corp\.local/);
  assert.ok(!touched(sh));
  // ③ 같은 장비(FQDN 보고 · 짧은 hostname) — 진행
  sh = fakeShell({ env: ENV0, hostname: 'edge2' });
  const st3 = [];
  r = await applyAgentCentralTokenOverExec(sh, TOK, { ...AG, expectHostname: 'EDGE2.corp.local', host: 'h', urlPort: 4000, edgeNew: true, onStep: (k, ok, d) => st3.push([k, ok, d]), waitTries: 2, waitDelaySec: 0 });
  assert.equal(r.ok, true, r.reason);
  assert.match(st3.find((x) => x[0] === 'identity')[2], /AZ-IRS.*edge2.*EDGE2\.corp\.local 과 같음/);
  // ④ 보고 호스트 이름이 없으면(옛 엣지) 이름으로만 확인하고 진행
  sh = fakeShell({ env: ENV0, hostname: 'anything' });
  r = await applyAgentCentralTokenOverExec(sh, TOK, { ...AG, host: 'h', urlPort: 4000, edgeNew: true, waitTries: 2, waitDelaySec: 0 });
  assert.equal(r.ok, true, r.reason);
  // ⑤ 대상 이름을 모르면 확인할 수 없으니 멈춘다
  sh = fakeShell({ env: ENV0 });
  r = await applyAgentCentralTokenOverExec(sh, TOK, { host: 'h', urlPort: 4000, edgeNew: true });
  assert.equal(r.ok, false); assert.match(r.reason, /agentName/);
  assert.ok(!touched(sh));
  // ⑥ AGENT_NAME 이 없으면 config.js 처럼 hostname 으로 — 이름이 hostname 인 엣지
  sh = fakeShell({ env: 'PORT=4000\nCENTRAL_URL=http://c\n', hostname: 'az-irs' });
  r = await applyAgentCentralTokenOverExec(sh, TOK, { ...AG, host: 'h', urlPort: 4000, edgeNew: true, waitTries: 2, waitDelaySec: 0 });
  assert.equal(r.ok, true, r.reason);
  // 정체 확인 명령이 비밀 키를 출력하지 않는다(이름 키 두 개만)
  assert.ok(sh.cmds.every((c) => !/grep[^|]*TOKEN/.test(c) || /grep -oE/.test(c)));
});

test('E-3 작업 — 사전 점검이 엣지 보고 호스트 이름을 기록 · SSH 에 대상 이름·보고 호스트를 넘긴다 · 수집 토큰 통로 응답의 호스트가 다르면 확인 필요', async () => {
  // ① 기록 + SSH 인자
  J._resetForTest();
  let opts = null;
  let d = fakeDeps({ statusOf: () => ({ version: '2.770.0', agent: 'AZ-IRS', hostname: 'edge2.corp.local' }), pushEdge: async () => ({ ok: false, status: 404, body: null }) });
  d.sshApply = async (target, token, o) => { opts = o; d.tokens[0].lastUsedAt = d.now() + 1; return { ok: true }; };
  let { job } = await J.startTokenApply('AZ-IRS', { deps: d, wait: true });
  assert.equal(job.edgeHost, 'edge2.corp.local');
  assert.match(job.steps[0].detail, /보고 호스트 edge2\.corp\.local/);
  assert.equal(opts.agent, 'AZ-IRS'); assert.equal(opts.expectHostname, 'edge2.corp.local');
  assert.equal(J.getJob(job.id).edgeHost, 'edge2.corp.local', '기록 파일에도 남는다');
  // ② 수집 토큰 통로 — 받은 장비의 호스트 이름이 다르다 → 경고(되돌리지 않는다 · 엣지 이름은 엣지의 중앙 확인이 이미 맞췄다)
  J._resetForTest();
  d = fakeDeps({ statusOf: () => ({ version: '2.777.0', agent: 'AZ-IRS', hostname: 'edge2' }) });
  d.pushEdge = async () => { d.tokens[0].lastUsedAt = d.now() + 1; return { ok: true, status: 200, body: { ok: true, applied: true, hostname: 'edge1', steps: [] } }; };
  ({ job } = await J.startTokenApply('AZ-IRS', { deps: d, wait: true }));
  const ea = job.steps.find((s) => s.key === 'edge-api');
  assert.equal(ea.state, 'warn'); assert.match(ea.detail, /'edge1'.*'edge2'/);
  assert.equal(job.state, 'warn', '최종 상태도 확인 필요'); assert.match(job.summary, /호스트 이름/);
  assert.equal(d.calls.revoke, 0);
  // ③ 같으면 ok — 그리고 응답에 호스트 이름이 없으면(판정 불가) 그대로 ok
  for (const hn of ['EDGE2', undefined]) {
    J._resetForTest();
    d = fakeDeps({ statusOf: () => ({ version: '2.777.0', hostname: 'edge2' }) });
    d.pushEdge = async () => { d.tokens[0].lastUsedAt = d.now() + 1; return { ok: true, status: 200, body: { ok: true, applied: true, ...(hn ? { hostname: hn } : {}), steps: [] } }; };
    ({ job } = await J.startTokenApply('AZ-IRS', { deps: d, wait: true }));
    assert.equal(job.state, 'ok', `${hn}: ${job.summary}`);
  }
});

test('E-4 엣지 응답 정제에 hostname(글자만 · 128자 · 줄바꿈 제거) · 엣지 적용 응답이 자기 호스트 이름을 싣는다', async () => {
  const { sanitizeEdgeReply } = await import('../src/central/tokenApplyDeps.js');
  assert.equal(sanitizeEdgeReply({ ok: true, hostname: 'a\nb' }).hostname, 'a b');
  assert.equal(sanitizeEdgeReply({ ok: true, hostname: 'x'.repeat(500) }).hostname.length <= 128, true);
  assert.equal(sanitizeEdgeReply({ ok: true, hostname: { evil: 1 } }).hostname, '');
  A._resetForTest();
  const r = await A.applyAgentCentralToken({ token: 'bad' });
  assert.equal(r.hostname, os.hostname());
});
