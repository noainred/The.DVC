/**
 * v2.777 — 사용자 구성 '메인 → 엣지1:포트(haproxy 포워딩) → 엣지2' 에서 개별 토큰 자동 적용이 동작하는가(실제 중앙·엣지 라우트).
 *  · 메인 → 엣지2 수집 URL 은 엣지1 의 포워딩 포트 · 엣지2 의 CENTRAL_URL 도 엣지1 의 포워딩 포트(엣지2 → 메인)
 *  · haproxy 는 TCP 포워더로 흉내 낸다(mode tcp 와 같은 동작 — 바이트를 그대로 넘긴다). 포워더를 실제로 지났는지 연결 수로 확인한다.
 *  · 사용자 요청 '엣지에서 보고하는 호스트네임을 기록해서 검증' — 중앙이 pull 로 기록한 호스트 이름과 토큰을 받은 엣지의 호스트 이름을 대조
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'topo2777-'));
Object.assign(process.env, { CONFIG_DIR: DIR, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' });
for (const k of ['CENTRAL_URL', 'CENTRAL_TOKEN', 'AGENT_CENTRAL_TOKEN', 'COLLECTOR_TOKEN', 'EDGE_MODE', 'CENTRAL_REQUIRE_AGENT_TOKEN']) delete process.env[k];
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const express = (await import('express')).default;
const { config } = await import('../src/config.js');
const J = await import('../src/central/tokenApplyJob.js');
const T = await import('../src/central/agentTokens.js');
const A = await import('../src/agent/centralTokenApply.js');
const S = await import('../src/collector/state.js');

const listen = (app) => new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
const closeSrv = (s) => () => new Promise((ok) => { s.closeAllConnections?.(); s.close(() => ok()); });
/** haproxy(mode tcp) 흉내 — 받은 연결을 대상 포트로 그대로 잇고 연결 수를 센다 */
function forwarder(targetPort) {
  const st = { conns: 0 }; const socks = new Set();
  const srv = net.createServer((c) => {
    st.conns++; const u = net.connect(targetPort, '127.0.0.1'); socks.add(c); socks.add(u);
    c.pipe(u); u.pipe(c); c.on('error', () => u.destroy()); u.on('error', () => c.destroy());
    c.on('close', () => { socks.delete(c); u.destroy(); }); u.on('close', () => { socks.delete(u); c.destroy(); });
  });
  closers.push(() => new Promise((ok) => { for (const x of socks) x.destroy(); srv.close(() => ok()); }));
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ port: srv.address().port, st })));
}

// 엣지2(수집 라우터) · 중앙(central 라우터 + 관리 라우트) — 한 프로세스, 서로 다른 포트
const { collectorRouter } = await import('../src/routes/collector.js');
const e2 = express(); e2.use('/api/collector', collectorRouter);
const e2s = await listen(e2); closers.push(closeSrv(e2s));
const { centralRouter } = await import('../src/routes/central.js');
const { registerCentralTokens } = await import('../src/routes/admin/centralTokens.js');
const c = express(); c.use(express.json()); c.use('/api/central', centralRouter);
const admin = express.Router();
c.use('/api/admin', (req, _r, n) => { req.user = { username: 'noainred', role: 'admin' }; n(); }, admin);
registerCentralTokens(admin);
const cs = await listen(c); closers.push(closeSrv(cs));
const centralDirect = `http://127.0.0.1:${cs.address().port}`;
// 엣지1 의 포워딩 두 개
const toEdge2 = await forwarder(e2s.address().port);     // 메인 → 엣지1:4001 → 엣지2:4000
const toCentral = await forwarder(cs.address().port);    // 엣지2 → 엣지1:포트 → 메인

async function runApply() {
  const st = await fetch(`${centralDirect}/api/admin/central/agent-tokens/AZ-IRS/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(st.status, 202);
  let job = (await st.json()).job;
  for (let i = 0; i < 150 && job.state === 'running'; i++) {
    await new Promise((ok) => setTimeout(ok, 100));
    job = (await (await fetch(`${centralDirect}/api/admin/central/token-apply/jobs/${job.id}`)).json()).job;
  }
  return job;
}
function setup(reportedHost) {
  J._resetForTest(); A._resetForTest();
  fs.rmSync(path.join(DIR, 'central-agent-tokens.json'), { force: true }); T._resetAgentTokenCache();
  config.central.token = 'SHARED';
  config.collector.token = 'COLTOK';
  config.agent.name = 'AZ-IRS'; config.agent.centralToken = 'SHARED';
  config.agent.centralUrl = `http://127.0.0.1:${toCentral.port}`;   // 엣지2 의 CENTRAL_URL = 엣지1 포워딩
  fs.writeFileSync(path.join(DIR, 'collectors.json'), JSON.stringify({ collectors: [{ id: 'AZ-IRS', name: 'AZ-IRS', url: `http://127.0.0.1:${toEdge2.port}`, token: 'COLTOK', enabled: true }] }));
  fs.writeFileSync(path.join(DIR, 'portal.env'), 'PORT=4000\nAGENT_NAME=AZ-IRS\nCENTRAL_URL=http://edge1:4001\nCENTRAL_TOKEN=SHARED\nCOLLECTOR_TOKEN=COLTOK\n');
  // 중앙이 pull 로 기록해 둔 엣지 정체(실제 pull 은 엣지 export 의 agent·hostname = os.hostname() 을 남긴다)
  S.setCollectorStatus('AZ-IRS', { ok: true, version: '2.777.0', agent: 'AZ-IRS', hostname: reportedHost });
}

test('T-1 포워딩 두 단 — 수집 토큰 통로로 적용 · 엣지2 의 확인 요청도 포워딩을 지난다 · 보고 호스트 이름과 받은 장비가 같다 · CENTRAL_TOKEN 그대로', async () => {
  setup(os.hostname());
  const before = await fetch(`${config.agent.centralUrl}/api/central/veeam-config?agent=AZ-IRS`, { headers: { 'X-Central-Token': 'SHARED', 'X-Agent-Name': 'AZ-IRS' } });
  assert.equal(before.status, 403, '공유 토큰으로는 Veeam 설정을 받지 못한다(사용자 화면과 같은 상태)');
  const c0 = { e: toEdge2.st.conns, c: toCentral.st.conns };
  const job = await runApply();
  assert.equal(job.state, 'ok', `${job.summary} :: ${JSON.stringify(job.steps)}`);
  assert.equal(job.path, 'edge-api');
  assert.equal(job.edgeHost, os.hostname(), '작업 기록에 엣지가 보고한 호스트 이름');
  assert.match(job.steps.find((s) => s.key === 'edge-api').detail, /보고값과 같음/);
  assert.ok(toEdge2.st.conns > c0.e, '메인 → 엣지1 → 엣지2 포워딩을 지났다');
  assert.ok(toCentral.st.conns > c0.c, '엣지2 의 새 토큰 확인(health-probe)이 엣지2 → 엣지1 → 메인 포워딩을 지났다');
  const env = fs.readFileSync(path.join(DIR, 'portal.env'), 'utf8');
  assert.match(env, /^AGENT_CENTRAL_TOKEN=[A-Za-z0-9_-]{43}$/m);
  assert.match(env, /^CENTRAL_TOKEN=SHARED$/m, '받는 문(엣지2 자신의 /api/central)은 그대로');
  const after2 = await fetch(`${config.agent.centralUrl}/api/central/veeam-config?agent=AZ-IRS`, { headers: { 'X-Central-Token': config.agent.centralToken, 'X-Agent-Name': 'AZ-IRS' } });
  assert.equal(after2.status, 200, '적용 뒤 엣지2 가 포워딩을 거쳐 Veeam 설정을 받는다');
});

test('T-2 보고 호스트 이름과 토큰을 받은 장비의 호스트 이름이 다르면 — 완료(확인 필요)로 알린다', async () => {
  setup('some-other-box.corp.local');
  const job = await runApply();
  assert.equal(job.state, 'warn', job.summary);
  assert.equal(job.edgeHost, 'some-other-box.corp.local');
  const ea = job.steps.find((s) => s.key === 'edge-api');
  assert.equal(ea.state, 'warn'); assert.ok(ea.detail.includes(`'${os.hostname()}'`) && ea.detail.includes("'some-other-box.corp.local'"), ea.detail);
});
