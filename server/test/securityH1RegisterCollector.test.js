/**
 * 보안 감사 2026-09-12 H-1 회귀 테스트 — /register-collector agent 바인딩 우회.
 * 침해된 개별 토큰 엣지가 X-Agent-Name 에 자기 이름을 넣어 미들웨어를 통과하고 body.name 에는
 * 남의 엣지 이름을 넣어 그 수집 서버 항목을 탈취하던 결함(requestedAgent OR 순서)을 고정한다.
 * body.name 은 헤더 유무와 무관하게 항상 토큰 agent 와 대조되어야 한다.
 */
import { test, before, after } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-h1-'));
process.env.CONFIG_DIR = CFG;
process.env.CENTRAL_TOKEN = 'shared-token-for-h1-test-1234567890';
// v2.613 TESTDOC2613-07: 자기등록 검증 ping(`verifyDerivedCollectorUrl`)이 응답 없는 사설 주소(10.20.30.40)로 나가 8초 시한을
//   기다렸다(20초 테스트). 루프백에 **목 엣지**를 띄워 ping 에 자기 이름으로 답한다 — 검증 성공 경로까지 실제로 지난다.
process.env.SSRF_ALLOW_LOOPBACK = 'true';

let tokens; let server; let base; let tokA; let mockEdge; let edgeUrl;

before(async () => {
  tokens = await import('../src/central/agentTokens.js');
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use(express.json());
  app.use('/api/central', centralRouter);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/central`;
  tokA = tokens.issueAgentToken('edgeA').token;
  mockEdge = http.createServer((req, res) => {
    if (req.url.startsWith('/api/collector/ping')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, agent: 'edgeA', hostname: 'edge-a', datacenter: '', version: '2.613.0' })); return; }
    res.statusCode = 404; res.end('{}');
  });
  mockEdge.listen(0, '127.0.0.1');
  await new Promise((r) => mockEdge.once('listening', r));
  edgeUrl = `http://127.0.0.1:${mockEdge.address().port}`;
});
after(() => { try { server?.close(); } catch { /* */ } try { mockEdge?.close(); } catch { /* */ } });

const post = (p, token, body, headers = {}) => fetch(`${base}${p}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Central-Token': token } : {}), ...headers },
  body: JSON.stringify(body),
});

test('H-1: X-Agent-Name 로 미들웨어를 통과해도 body.name 이 남의 이름이면 403', async () => {
  const res = await post('/register-collector',
    tokA,
    { name: 'edgeB', urlHint: 'http://10.9.9.9:4000', collectorToken: 'ATTACKER' },
    { 'X-Agent-Name': 'edgeA' });
  assert.equal(res.status, 403, '헤더로 우회한 타 엣지 이름 등록은 거부되어야 한다');
  const j = await res.json();
  assert.match(j.reason || '', /edgeA/);
});

test('H-1: body.agent 로 미들웨어를 통과해도 body.name 이 다르면 403', async () => {
  const res = await post('/register-collector', tokA,
    { agent: 'edgeA', name: 'edgeB', urlHint: 'http://10.9.9.9:4000', collectorToken: 'X' });
  assert.equal(res.status, 403);
});

test('H-1: 자기 이름(body.name===agent) 등록은 통과(정상 자기등록 보존)', async () => {
  const res = await post('/register-collector', tokA,
    { name: 'edgeA', urlHint: edgeUrl, collectorToken: 'own-token' });
  // 200(등록/ping 결과) 또는 400(ping 실패 등)일 수 있으나 **403(바인딩 거부)이 아니어야** 한다.
  assert.notEqual(res.status, 403, `정상 자기등록이 바인딩으로 막히면 안 된다(status=${res.status})`);
});
