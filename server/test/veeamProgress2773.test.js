/**
 * v2.773 — Veeam 서버 '진행 상태'(사용자 요청 "진행상태를 자세하게 볼수있게 해줘" · 실서버 캡처: 엣지 AZ-IRS 개별 토큰 없음).
 *  · 단계 판정(veeam/progress.js veeamProgress) — 순수 함수, 이미 기록된 값만.
 *  · 실제 라우트 GET /api/admin/veeam/servers 가 progress 를 싣는다(실제 pullStats·ingestReject·veeamEdge·agentTokens 경유).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'veeamProg2773-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'az:vc01', name: 'az', host: 'az.corp.local', username: 'u', password: 'p' }] }));
const closers = [];
after(async () => {
  for (const c of closers.reverse()) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

const { veeamProgress, CONTACT_STALE_MS } = await import('../src/veeam/progress.js');
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;
const SRV = { id: 's1', name: 'AZ Veeam', agent: 'AZ-IRS', enabled: true, vcenterIds: ['az:vc01'] };
const stateOf = (r) => Object.fromEntries(r.steps.map((s) => [s.key, s.state]));
const pullRow = (eps, { verified = false, lastAt = NOW - 60_000 } = {}) => ({ agent: 'AZ-IRS', verified, firstAt: NOW - HOUR, lastAt, byEndpoint: eps });
const ep = (endpoint, o) => ({ endpoint, count: 1, okCount: 0, failCount: 0, lastOkAt: 0, lastFailAt: 0, lastStatus: 0, ...o });

test('실서버 사례: 공유 토큰 엣지 — 개별 토큰 ❌, 접속은 ✅(검증 안 된 이름), 배정 받기 403 ❌, 이후 ⏳ · 막힌 곳 = 개별 토큰', () => {
  const r = veeamProgress({
    server: SRV, readsHere: false, tokenAgents: ['other-edge'],
    pulls: { since: NOW - 2 * HOUR, rows: [pullRow([ep('/storage-config', { okCount: 3, lastOkAt: NOW - 60_000, lastStatus: 200 }), ep('/veeam-config', { failCount: 4, lastFailAt: NOW - 90_000, lastStatus: 403 })])] },
    rejects: { rows: [] }, edge: null, status: null, now: NOW,
  });
  assert.equal(r.mode, 'edge');
  assert.deepEqual(stateOf(r), { assign: 'ok', token: 'bad', contact: 'ok', pull: 'bad', read: 'wait', push: 'wait', result: 'wait' });
  assert.equal(r.blockedAt, 'token');
  const by = Object.fromEntries(r.steps.map((s) => [s.key, s]));
  assert.match(by.token.action, /수집 서버.*AZ-IRS.*CENTRAL_TOKEN/);
  assert.match(by.contact.text, /공유 토큰.*검증 안 됨/);
  assert.match(by.pull.text, /403/);
  assert.match(by.pull.text, /실패 4/);
  assert.equal(by.pull.at, NOW - 90_000);
  assert.equal(r.since, NOW - 2 * HOUR);
});

test('정상 엣지: 전 단계 ✅ · 막힌 곳 없음 · 시각이 단계마다 실린다', () => {
  const r = veeamProgress({
    server: SRV, readsHere: false, tokenAgents: ['az-irs'],
    pulls: { since: NOW - HOUR, rows: [pullRow([ep('/veeam-config', { okCount: 5, lastOkAt: NOW - 30_000, lastStatus: 200 })], { verified: true })] },
    rejects: { rows: [] },
    edge: { agent: 'AZ-IRS', at: NOW - 20_000, status: { servers: 1, version: '2.773.0', poller: { at: NOW - 25_000, ok: 1, fail: 0, running: false } }, lastPush: { at: NOW - 20_000, results: 1, saved: 1 } },
    status: { ok: true, stale: false, ts: NOW - 25_000, counts: { jobs: 7 } }, now: NOW,
  });
  assert.ok(Object.values(stateOf(r)).every((s) => s === 'ok'), JSON.stringify(stateOf(r)));
  assert.equal(r.blockedAt, null);
  assert.equal(r.steps.find((s) => s.key === 'result').text, '정상 — 작업 7개.');
  assert.equal(r.steps.find((s) => s.key === 'contact').at, NOW - 20_000);
  assert.doesNotMatch(r.steps.find((s) => s.key === 'contact').text, /검증 안 됨/);
});

test('기록 없음은 \'안 했다\' 로 단정하지 않는다 — 접속 ⏳·배정 받기 ⏳(판단 불가) · 오래된 접속은 ⚠', () => {
  const none = veeamProgress({ server: SRV, tokenAgents: ['AZ-IRS'], pulls: { since: NOW - 60_000, rows: [] }, rejects: { rows: [] }, now: NOW });
  assert.equal(stateOf(none).contact, 'wait');
  assert.equal(stateOf(none).pull, 'wait');
  assert.equal(none.blockedAt, 'contact');
  const old = veeamProgress({ server: SRV, tokenAgents: ['AZ-IRS'], pulls: { since: NOW - 9 * HOUR, rows: [pullRow([ep('/veeam-config', { okCount: 1, lastOkAt: NOW - 8 * HOUR, lastStatus: 200 })], { verified: true, lastAt: NOW - CONTACT_STALE_MS - 1 })] }, now: NOW });
  assert.equal(stateOf(old).contact, 'warn');
});

test('접속은 하는데 Veeam 배정을 가져간 기록이 없으면 ⚠(옛 판 엣지 가능성 — 판 표기) · 거절된 push 만 있으면 결과 올리기 ❌', () => {
  const r = veeamProgress({
    server: SRV, tokenAgents: ['AZ-IRS'],
    pulls: { since: NOW - HOUR, rows: [pullRow([ep('/storage-config', { okCount: 2, lastOkAt: NOW - 60_000, lastStatus: 200 })], { verified: true })] },
    rejects: { rows: [{ agent: 'az-irs', total: 3, lastAt: NOW - 50_000, lastReason: '개별 토큰 필요', byEndpoint: { '/veeam-data': 3 } }] },
    edge: { agent: 'AZ-IRS', at: 0, status: { version: '2.740.0', poller: {} } }, now: NOW,
  });
  const by = Object.fromEntries(r.steps.map((s) => [s.key, s]));
  assert.equal(by.pull.state, 'warn');
  assert.match(by.pull.text, /2\.740\.0/);
  assert.equal(by.push.state, 'bad');
  assert.match(by.push.text, /3회/);
});

test('결과 올리기: 결과를 실었는데 저장 0(옛 접속처) ⚠ · 엣지 폴러 전부 실패 ❌ · 개별 토큰 목록을 못 읽으면 ⚠(모름)', () => {
  const r = veeamProgress({
    server: SRV, tokenAgents: null,
    pulls: { since: NOW - HOUR, rows: [pullRow([ep('/veeam-config', { okCount: 1, lastOkAt: NOW - 60_000, lastStatus: 200 })], { verified: true })] },
    edge: { agent: 'AZ-IRS', at: NOW - 10_000, status: { servers: 1, poller: { at: NOW - 15_000, ok: 0, fail: 1 } }, lastPush: { at: NOW - 10_000, results: 1, saved: 0, dropped: { stale: 1 } } },
    status: { ok: false, ts: NOW - 15_000, error: 'HTTP 401' }, now: NOW,
  });
  const st = stateOf(r);
  assert.equal(st.token, 'warn');
  assert.equal(st.read, 'bad');
  assert.equal(st.push, 'warn');
  assert.equal(st.result, 'bad');
  assert.match(r.steps.find((s) => s.key === 'push').text, /옛 접속처 결과 1/);
  assert.match(r.steps.find((s) => s.key === 'result').text, /HTTP 401/);
});

test('수집 꺼짐: 배정 외 전부 skip · 막힌 곳 없음 / 직접 읽는 서버: 배정 → 이 노드에서 읽기 → 결과 3단계', () => {
  const off = veeamProgress({ server: { ...SRV, enabled: false }, tokenAgents: [], now: NOW });
  assert.ok(off.steps.every((s) => s.state === 'skip'));
  assert.equal(off.blockedAt, null);
  const local = veeamProgress({ server: { ...SRV, agent: '' }, readsHere: true, poller: { at: NOW - 5_000, ok: 2, fail: 1 }, status: { ok: true, stale: true, ts: NOW - 9 * HOUR }, now: NOW });
  assert.equal(local.mode, 'local');
  assert.deepEqual(local.steps.map((s) => s.key), ['assign', 'read', 'result']);
  assert.deepEqual(stateOf(local), { assign: 'ok', read: 'warn', result: 'warn' });
  assert.equal(local.since, null);
});

/* ═══════════════ 실제 라우트 ═══════════════ */
let base = '';
before(async () => {
  const express = (await import('express')).default;
  const { registerVeeam } = await import('../src/routes/admin/veeam.js');
  const app = express();
  app.use(express.json());
  const admin = express.Router();
  app.use('/api/admin', (req, _res, next) => { req.user = { username: 'adm', role: 'admin' }; next(); }, admin);
  registerVeeam(admin);
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  closers.push(() => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(() => ok()); }));
  base = `http://127.0.0.1:${srv.address().port}/api/admin/veeam/servers`;
});

test('라우트: GET /admin/veeam/servers 의 서버마다 progress — 실제 pullStats(공유 토큰 403)·개별 토큰 목록에서 판정', async () => {
  const R = await import('../src/veeam/registry.js');
  const P = await import('../src/central/pullStats.js');
  const T = await import('../src/central/agentTokens.js');
  R.saveServer({ name: 'AZ Veeam', host: 'vbr-az.corp', username: 'svc', password: 'pw', vcenterIds: ['az:vc01'], agent: 'AZ-IRS', enabled: true });
  P.resetPullStats();
  P.recordPull('AZ-IRS', '/veeam-config', { status: 403, verified: false });
  let r = await (await fetch(base)).json();
  let s = r.servers.find((x) => x.agent === 'AZ-IRS');
  assert.ok(s.progress, 'progress 필드');
  assert.equal(s.progress.blockedAt, 'token');
  assert.equal(s.progress.steps.find((x) => x.key === 'pull').state, 'bad');
  assert.ok(Array.isArray(r.tokenAgents), 'tokenAgents 는 예전처럼 배열');
  // 개별 토큰을 발급하고 엣지가 개별 토큰으로 배정을 받아 가면 → 토큰 ✅ · 배정 받기 ✅ · 다음 막힌 곳은 엣지에서 읽기(⏳)
  const issued = T.issueAgentToken('AZ-IRS');
  // 발급만 하고 엣지가 아직 그 토큰을 쓰지 않으면(lastUsedAt 없음) 토큰 단계는 ⚠ — 실서버에서 가장 흔히 빠뜨리는 둘째 절반(엣지 CENTRAL_TOKEN 교체).
  r = await (await fetch(base)).json();
  s = r.servers.find((x) => x.agent === 'AZ-IRS');
  assert.equal(s.progress.steps.find((x) => x.key === 'token').state, 'warn');
  assert.match(s.progress.steps.find((x) => x.key === 'token').action, /CENTRAL_TOKEN/);
  assert.equal(String(T.resolveAgentByToken(issued.token)).toLowerCase(), 'az-irs');   // 엣지가 개별 토큰으로 접속(touch → lastUsedAt)
  P.recordPull('AZ-IRS', '/veeam-config', { status: 200, verified: true });
  r = await (await fetch(base)).json();
  s = r.servers.find((x) => x.agent === 'AZ-IRS');
  const st = Object.fromEntries(s.progress.steps.map((x) => [x.key, x.state]));
  assert.equal(st.token, 'ok');
  assert.equal(st.pull, 'ok');
  assert.equal(s.progress.blockedAt, 'read');
});

test('라우트: 개별 토큰 파일을 못 읽으면 토큰 단계는 \'없음\' 이 아니라 모름(⚠) — 거짓 \'토큰 없음\' 금지', async () => {
  const T = await import('../src/central/agentTokens.js');
  fs.writeFileSync(path.join(DIR, 'central-agent-tokens.json'), '{ 손상');
  T._resetAgentTokenCache();
  const r = await (await fetch(base)).json();
  const s = r.servers.find((x) => x.agent === 'AZ-IRS');
  const tok = s.progress.steps.find((x) => x.key === 'token');
  assert.equal(tok.state, 'warn');
  assert.match(tok.text, /읽지 못했습니다/);
  assert.deepEqual(r.tokenAgents, []);
});
