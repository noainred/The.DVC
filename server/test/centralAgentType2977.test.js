// v2.977 전체 점검(엣지 축): central 의 agent 주장은 글자 하나만(심층 방어).
//   ⚠ 정정(같은 날 반증 F1): 처음에는 '개별 토큰 엣지가 ?agent[]= 로 다른 법인 자격증명을 받는다(재현)' 로 적었으나, 그 재현은 queryNormalizer 가 없는
//   맨 express 구성이었다. 운영 포탈(index.js)은 정규화가 /api/central 보다 먼저 돌아 배열을 마지막 글자로 바꾸고, 미들웨어 대조가 403 을 낸다.
//   이 파일은 ① 정규화 없는 구성(정규화 순서가 바뀌어도)에서 400 ② 운영 구성(정규화 먼저)에서 403 · 유출 없음 ③ 64자를 넘는 이름의 잘림 비교(F5)를 고정한다.
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

const { queryNormalizer } = await import('../src/util/queryNormalize.js');
const app = express();
app.use(express.json());
app.use('/api/central', centralRouter);
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
// 운영 구성(index.js 순서) — 쿼리 정규화가 central 보다 먼저
const prod = express();
prod.use(queryNormalizer());
prod.use(express.json());
prod.use('/api/central', centralRouter);
const srvProd = await new Promise((r) => { const s = prod.listen(0, '127.0.0.1', () => r(s)); });
after(() => { srv.close(); srvProd.close(); fs.rmSync(DIR, { recursive: true, force: true }); });
const baseProd = `http://127.0.0.1:${srvProd.address().port}/api/central`;
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

test('정규화 없는 구성 — ?agent[]= · ?agent[0]= · ?agent[k]= 는 400(심층 방어 — 정규화 순서가 바뀌어도 대조가 무너지지 않게)', async () => {
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

test('운영 구성(쿼리 정규화 먼저) — 같은 요청이 403 이고 다른 법인 비밀번호가 응답에 없다', async () => {
  for (const q of ['agent[]=edge-b', 'agent[0]=edge-b', 'agent=edge-a&agent=edge-b']) {
    const r = await fetch(`${baseProd}/assignment?${q}`, { headers: { 'X-Central-Token': tokA } });
    const text = await r.text();
    assert.equal(r.status, 403, `${q} → ${r.status}`);
    assert.ok(!text.includes('B-SECRET'), q);
  }
});

test('반증 F5 — 64자를 넘는 agent 주장은 잘리지 않은 원문으로 대조한다(64자 이름 엣지가 더 긴 이름의 설정을 받지 못한다)', async () => {
  const name64 = `e${'x'.repeat(63)}`;
  const tok64 = issueAgentToken(name64).token;
  const longer = `${name64}-other`;
  const r = await fetch(`${base}/storage-config?agent=${encodeURIComponent(longer)}`, { headers: { 'X-Central-Token': tok64 } });
  assert.equal(r.status, 403, `64자 토큰으로 ${longer.length}자 이름 → ${r.status}`);
  const own = await fetch(`${base}/storage-config?agent=${encodeURIComponent(name64)}`, { headers: { 'X-Central-Token': tok64 } });
  assert.notEqual(own.status, 403, '자기 이름은 통과');
});
