import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 엣지별 개별 central 토큰 + agent 바인딩 회귀 테스트.
// 공유 토큰 1개로 남의 사이트 iDRAC/게스트 자격증명을 인출할 수 있었던 문제(보안 점검 HIGH)의
// 방어가 실제 라우터 경로에서 성립하는지 확인한다.
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-central-tok-'));
process.env.CONFIG_DIR = CFG;
process.env.CENTRAL_TOKEN = 'shared-token-for-test-1234567890';

let tokens; let server; let base;

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
});
after(() => { try { server?.close(); } catch { /* */ } });

const get = (p, token) => fetch(`${base}${p}`, { headers: token ? { 'X-Central-Token': token } : {} });

test('토큰 발급: 평문은 1회만 반환되고 파일엔 해시만 0600으로 저장', () => {
  const r = tokens.issueAgentToken('OC2');
  assert.equal(r.ok, true);
  assert.ok(r.token && r.token.length >= 32);
  const file = path.join(CFG, 'central-agent-tokens.json');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(r.token), '토큰 평문이 파일에 저장되면 안 됨');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // 목록에는 비밀이 노출되지 않는다.
  const listed = tokens.listAgentTokens().find((t) => t.agent === 'OC2');
  assert.ok(listed && !('hash' in listed) && !('token' in listed));
});

test('resolveAgentByToken: 올바른 토큰만 agent로 해석', () => {
  const r = tokens.issueAgentToken('WA');
  assert.equal(tokens.resolveAgentByToken(r.token), 'WA');
  assert.equal(tokens.resolveAgentByToken('wrong-token'), null);
  assert.equal(tokens.resolveAgentByToken(''), null);
});

test('개별 토큰은 자기 agent만 조회 가능(남의 이름은 403) — 자격증명 횡탈 차단', async () => {
  const a = tokens.issueAgentToken('SITE-A');
  const own = await get('/assignment?agent=SITE-A', a.token);
  assert.equal(own.status, 200, '자기 것은 허용');
  const other = await get('/assignment?agent=SITE-B', a.token);
  assert.equal(other.status, 403, '남의 이름은 거부');
  const body = await other.json();
  assert.match(body.reason, /SITE-A/);
  // 게스트 비번·사용자 해시 경로도 동일하게 막혀야 한다.
  for (const p of ['/gpu-guest-config?agent=SITE-B', '/users-config?agent=SITE-B']) {
    assert.equal((await get(p, a.token)).status, 403, `${p} 거부`);
  }
});

test('대소문자 무시 매칭 — 엣지 AGENT_NAME 표기 차이로 정상 요청이 막히지 않음', async () => {
  const a = tokens.issueAgentToken('GM1');
  assert.equal((await get('/assignment?agent=gm1', a.token)).status, 200);
});

test('공유 CENTRAL_TOKEN은 하위호환 유지(이관 전 엣지 무중단) + 사용 통계 기록', async () => {
  const { getCentralAuthStats } = await import('../src/routes/central.js');
  const before = getCentralAuthStats().uses;
  const r = await get('/assignment?agent=ANY-EDGE', process.env.CENTRAL_TOKEN);
  assert.equal(r.status, 200, '공유 토큰은 계속 동작');
  assert.ok(getCentralAuthStats().uses > before, '공유 토큰 사용이 집계돼 이관 필요를 알린다');
});

test('잘못된 토큰은 403, 토큰 없으면 403', async () => {
  assert.equal((await get('/assignment?agent=OC2', 'nope')).status, 403);
  assert.equal((await get('/assignment?agent=OC2')).status, 403);
});

test('회수(revoke) 후에는 그 토큰이 무효', async () => {
  const a = tokens.issueAgentToken('TEMP-EDGE');
  assert.equal((await get('/assignment?agent=TEMP-EDGE', a.token)).status, 200);
  assert.equal(tokens.revokeAgentToken('TEMP-EDGE').ok, true);
  assert.equal(tokens.resolveAgentByToken(a.token), null);
  assert.equal((await get('/assignment?agent=TEMP-EDGE', a.token)).status, 403);
});

test('재발급은 회전 — 이전 토큰 무효화', async () => {
  const first = tokens.issueAgentToken('ROTATE-ME');
  const second = tokens.issueAgentToken('ROTATE-ME');
  assert.notEqual(first.token, second.token);
  assert.equal(tokens.resolveAgentByToken(first.token), null, '이전 토큰은 폐기');
  assert.equal(tokens.resolveAgentByToken(second.token), 'ROTATE-ME');
});

test('WAN TLS 기본 검증 ON(기본값 반전 회귀 방지)', async () => {
  const { WAN_TLS_VERIFY } = await import('../src/util/resilientFetch.js');
  assert.equal(WAN_TLS_VERIFY, true, 'WAN_TLS_INSECURE 미설정이면 검증 ON이어야 함');
});
