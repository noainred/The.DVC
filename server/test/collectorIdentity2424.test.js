/**
 * v2.424 — 중앙→엣지A→(포워딩)→엣지B 토폴로지 트러블슈팅: 응답 엣지 정체 대조, peer IP 유도 자기등록 검증.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coll-id-'));
process.env.SSRF_ALLOW_LOOPBACK = 'true'; // 테스트용 가짜 엣지가 127.0.0.1 — 운영 기본은 차단

test('identityIssue: 응답 agent 가 id/name/DC 중 하나와 같으면 null, 다르면 사유, 구버전(agent 없음)은 판정 안 함', async () => {
  const { identityIssue } = await import('../src/collector/registry.js');
  const entry = { id: 'gm1-IRS', name: 'GM1-IRS', datacenter: 'gm1' };
  assert.equal(identityIssue(entry, { agent: 'gm1-irs' }), null);
  assert.ok(identityIssue(entry, { agent: 'GM1' }), 'v2.428: DC 이름과 같은 것만으로는 통과하지 않는다(포워딩이 중계 엣지 자신으로 되돌아온 경우)');
  assert.equal(identityIssue(entry, {}), null, '구버전 엣지');
  const iss = identityIssue(entry, { agent: 'gm2', hostname: 'edge-a' });
  assert.equal(iss.agent, 'gm2'); assert.match(iss.reason, /응답한 엣지는 'gm2'\(edge-a\)/);
});

let central, base, edgeA, edgeAPort, tokens;
const edgeAgentName = { v: 'edge-A' };
before(async () => {
  process.env.CENTRAL_TOKEN = '';
  tokens = await import('../src/central/agentTokens.js');
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express(); app.use(express.json()); app.use('/api/central', centralRouter);
  central = app.listen(0); await new Promise((r) => central.once('listening', r)); base = `http://127.0.0.1:${central.address().port}`;
  // 가짜 엣지A: 토큰 'tokA' 만 받고, 자기 이름을 돌려준다(엣지B 의 자기등록이 A 주소로 유도되는 상황 재현)
  const a = express();
  a.get('/api/collector/ping', (req, res) => {
    if (req.get('X-Collector-Token') !== 'tokA') return res.status(403).json({ ok: false });
    res.json({ ok: true, agent: edgeAgentName.v, hostname: 'hostA', version: '2.424.0', datacenter: 'gm1' });
  });
  edgeA = a.listen(0); await new Promise((r) => edgeA.once('listening', r)); edgeAPort = edgeA.address().port;
});
after(() => { central?.close(); edgeA?.close(); });

test('verifyDerivedCollectorUrl: 다른 엣지(중계 A)가 응답하면 거부 + EDGE_ADVERTISE_URL 안내, 토큰 거부(403)·불통도 거부, 일치면 ok', async () => {
  const { verifyDerivedCollectorUrl } = await import('../src/collector/registry.js');
  const url = `http://127.0.0.1:${edgeAPort}`;
  let v = await verifyDerivedCollectorUrl({ url, name: 'edge-B', datacenter: 'gm1', token: 'tokA' });
  assert.equal(v.ok, false); assert.match(v.reason, /응답한 엣지가 'edge-A'/); assert.match(v.reason, /EDGE_ADVERTISE_URL/);
  v = await verifyDerivedCollectorUrl({ url, name: 'edge-B', token: 'tokB' });
  assert.equal(v.ok, false); assert.match(v.reason, /거부\(403\)/);
  v = await verifyDerivedCollectorUrl({ url: 'http://127.0.0.1:1', name: 'edge-B', token: 'tokB' });
  assert.equal(v.ok, false); assert.match(v.reason, /닿지 못함/);
  v = await verifyDerivedCollectorUrl({ url, name: 'edge-A', token: 'tokA' });
  assert.equal(v.ok, true);
});

test('자기등록 라우트: urlHint(관리자가 의도한 포워딩 주소) 는 검증 없이 등록된다', async () => {
  const { loadCollectors } = await import('../src/collector/registry.js');
  const tb = tokens.issueAgentToken('edge-B2');
  const r = await fetch(`${base}/api/central/register-collector`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': tb.token }, body: JSON.stringify({ name: 'edge-B2', port: 4000, collectorToken: 'tokB', urlHint: `http://127.0.0.1:${edgeAPort + 1}` }) });
  assert.equal(r.status, 200, await r.text());
  assert.equal(loadCollectors().find((c) => c.id === 'edge-B2').url, `http://127.0.0.1:${edgeAPort + 1}`);
});
