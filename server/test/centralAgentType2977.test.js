// v2.977 전체 점검(엣지 축 — 재현): 개별 토큰 엣지가 `?agent[]=<다른 엣지>` 로 토큰 ↔ agent 대조를 우회해 다른 법인의 자격증명을 받던 결함.
//   원인: 미들웨어 strAgent 는 배열을 '' 로 읽어 대조를 건너뛰고, 핸들러의 String(req.query.agent) 는 ['edge-b'] → 'edge-b' 로 읽었다.
//   고침: central 미들웨어가 쿼리 · 본문 agent 가 글자가 아니면 400(agentClaimTypeIssue).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'central-agent-type-2977-'));
process.env.CONFIG_DIR = DIR;
process.env.CENTRAL_TOKEN = 'shared-2977';
process.env.DATA_SOURCE = 'live';
process.env.AUTH_SECRET = 'test-secret-2977-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

const express = (await import('express')).default;
const { issueAgentToken } = await import('../src/central/agentTokens.js');
const { addAssignment } = await import('../src/central/assignments.js');
const { centralRouter, agentClaimTypeIssue } = await import('../src/routes/central.js');

const tokA = issueAgentToken('edge-a').token;
issueAgentToken('edge-b');
assert.ok(addAssignment({ agent: 'edge-b', ips: '10.9.9.1', username: 'root', password: 'B-SECRET-pw' }).ok);
assert.ok(addAssignment({ agent: 'edge-a', ips: '10.9.9.2', username: 'root', password: 'A-SECRET-pw' }).ok);

const app = express();
app.use(express.json());
app.use('/api/central', centralRouter);
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
after(() => { srv.close(); fs.rmSync(DIR, { recursive: true, force: true }); });
const base = `http://127.0.0.1:${srv.address().port}/api/central`;
const call = async (method, p, { body, headers = {} } = {}) => {
  const r = await fetch(base + p, { method, headers: { 'X-Central-Token': tokA, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, text };
};

test('형식 판정 — 쿼리 · 본문 agent 가 글자가 아니면 사유, 없거나 null 이면 통과', () => {
  assert.equal(agentClaimTypeIssue({ query: {} }), null);
  assert.equal(agentClaimTypeIssue({ query: { agent: 'edge-a' } }), null);
  assert.match(agentClaimTypeIssue({ query: { agent: ['edge-b'] } }), /배열/);
  assert.match(agentClaimTypeIssue({ query: { agent: { k: 'edge-b' } } }), /object/);
  assert.equal(agentClaimTypeIssue({ query: {}, body: { agent: null } }), null);
  assert.match(agentClaimTypeIssue({ query: {}, body: { agent: ['edge-b'] } }), /본문/);
  assert.equal(agentClaimTypeIssue({ query: {}, body: [1, 2] }), null);
});

test('개별 토큰 edge-a — ?agent[]= · ?agent[0]= · ?agent[k]= 로 edge-b 의 iDRAC 비밀번호를 받지 못한다(400)', async () => {
  for (const q of ['agent[]=edge-b', 'agent[0]=edge-b', 'agent[k]=edge-b', 'agent=edge-a&agent=edge-b']) {
    const r = await call('GET', `/assignment?${q}`);
    assert.equal(r.status, 400, `${q} → ${r.status} ${r.text.slice(0, 120)}`);
    assert.ok(!r.text.includes('B-SECRET'), `${q}: 다른 법인 비밀번호가 응답에 없다`);
  }
  for (const p of ['/storage-config', '/users-config', '/bmstor-jobs', '/pdu-config', '/sanswitch-config', '/gpu-guest-config', '/capture-jobs']) {
    const r = await call('GET', `${p}?agent[]=edge-b`);
    assert.equal(r.status, 400, `${p} → ${r.status}`);
  }
});

test('정상 경로는 그대로 — 글자 agent 가 남이면 403, 자기 이름이면 자기 배정만', async () => {
  const other = await call('GET', '/assignment?agent=edge-b');
  assert.equal(other.status, 403);
  const mine = await call('GET', '/assignment?agent=edge-a');
  assert.equal(mine.status, 200, mine.text);
  assert.ok(mine.text.includes('A-SECRET') && !mine.text.includes('B-SECRET'));
  const hdr = await call('GET', '/assignment', { headers: { 'X-Agent-Name': 'edge-a' } });
  assert.equal(hdr.status, 200);
});

test('본문 agent 가 배열이면 POST 도 400', async () => {
  const r = await call('POST', '/register-collector', { body: { agent: ['edge-b'], name: 'edge-a', url: 'https://10.0.0.5:8443' } });
  assert.equal(r.status, 400, r.text);
});
