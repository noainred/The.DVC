import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v2.416 RMA central 라우트(HTTP) 회귀 — 개별 토큰 전용·agent 바인딩·소유권·하트비트·롱폴.
// 원격 명령은 자격증명보다 큰 권한이라 공유 CENTRAL_TOKEN 으로는 어떤 잡도 내주지 않는다.
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-rma-central-'));
process.env.CONFIG_DIR = CFG;
process.env.CENTRAL_TOKEN = 'shared-token-for-rma-test-1234567890';

let tokens; let jobs; let server; let base;

before(async () => {
  tokens = await import('../src/central/agentTokens.js');
  jobs = await import('../src/rma/jobs.js');
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

const post = (p, body, token, extra = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Central-Token': token } : {}), ...extra }, body: JSON.stringify(body) });

test('rma-poll: 공유 토큰은 403, 개별 토큰은 하트비트 기록 + 즉시 빈 잡', async () => {
  jobs._resetRma();
  const shared = await post('/rma-poll', { agent: 'X', instance: 'a', info: {}, wait: 0 }, process.env.CENTRAL_TOKEN);
  assert.equal(shared.status, 403);
  assert.match((await shared.json()).reason, /개별 토큰/);
  const t = tokens.issueAgentToken('RMA-A');
  const r = await post('/rma-poll', { agent: 'RMA-A', instance: 'node1', info: { hostname: 'h1', version: '2.416.0', priority: 10, signed: true }, wait: 0 }, t.token);
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).jobs, []);
  const g = jobs.listRmaAgents().find((x) => x.agent === 'RMA-A');
  assert.ok(g); assert.equal(g.instances[0].instance, 'node1'); assert.equal(g.instances[0].hostname, 'h1'); assert.equal(g.instances[0].online, true);
});

test('rma-poll: 남의 agent 이름으로는 403(바인딩), 잘못된 instance 형식은 default 로', async () => {
  const t = tokens.issueAgentToken('RMA-B');
  const other = await post('/rma-poll', { agent: 'RMA-A', instance: 'z', wait: 0 }, t.token);
  assert.equal(other.status, 403);
  const bad = await post('/rma-poll', { agent: 'RMA-B', instance: '../../etc', wait: 0 }, t.token);
  assert.equal(bad.status, 200);
  assert.ok(jobs.listRmaAgents().find((x) => x.agent === 'RMA-B').instances.some((i) => i.instance === 'default'));
});

test('rma-poll 롱폴 → enqueue 로 깨어남 → rma-result 로 ack, 남의 reqId 는 403', async () => {
  const tA = tokens.issueAgentToken('RMA-C');
  const tB = tokens.issueAgentToken('RMA-D');
  const pending = post('/rma-poll', { agent: 'RMA-C', instance: 'n', info: {}, wait: 3000 }, tA.token);
  await new Promise((r) => setTimeout(r, 50));
  const { reqId } = jobs.enqueueJob('RMA-C', { cmd: 'uptime', args: {}, timeoutMs: 5000 }, { timeoutMs: 5000 });
  const r = await pending;
  const body = await r.json();
  assert.equal(body.jobs.length, 1); assert.equal(body.jobs[0].reqId, reqId);
  // 다른 엣지가 이 reqId 로 결과 위조 → 403
  const forged = await post('/rma-result', { reqId, result: { ok: true, stdout: 'fake' } }, tB.token);
  assert.equal(forged.status, 403);
  assert.equal(jobs.getJob(reqId).state, 'running');
  // 소유 엣지의 결과 → done
  const ok = await post('/rma-result', { reqId, result: { ok: true, stdout: 'up 1 day', exitCode: 0, durationMs: 12 } }, tA.token);
  assert.equal((await ok.json()).ok, true);
  assert.equal(jobs.getJob(reqId).state, 'done');
  assert.equal(jobs.getJob(reqId).result.stdout, 'up 1 day');
  // 모르는 reqId 는 stale 로 무해하게
  const stale = await post('/rma-result', { reqId: 'rma_nope', result: {} }, tA.token);
  assert.equal((await stale.json()).stale, true);
});

// ── v2.418: 결과 동봉·스케줄 배포·접속 허용 IP ──
test('rma-poll: 스케줄 배포(assignKey) + 결과 동봉 반영(남의 항목 id 는 무시) + 접속 허용 IP 거부', async () => {
  const t = tokens.issueAgentToken('RMA-E');
  const sch = await import('../src/rma/schedules.js');
  const res = await import('../src/rma/testResults.js');
  const settings = await import('../src/rma/settings.js');
  const item = sch.upsertScheduleItem('RMA-E', { test: 'tcp', args: { host: 'h', port: 22 }, intervalSec: 60, name: 'ssh' });
  // 첫 폴: scheduleVersion 0 → 스케줄 내려옴
  let r = await post('/rma-poll', { agent: 'RMA-E', instance: 'n1', info: {}, wait: 0, scheduleVersion: 0 }, t.token);
  let body = await r.json();
  assert.ok(body.schedule, '스케줄 배포'); assert.equal(body.schedule.tests[0].id, item.id); assert.ok(body.schedule.assignKey);
  // 같은 버전·같은 assignKey 로 폴 → 스케줄 미포함, 결과 동봉 반영
  r = await post('/rma-poll', { agent: 'RMA-E', instance: 'n1', info: {}, wait: 0, scheduleVersion: body.schedule.version, assignKey: body.schedule.assignKey,
    results: [{ id: item.id, test: 'tcp', status: 'bad', reply: 'closed', at: Date.now() }, { id: 'forged', test: 'tcp', status: 'ok', reply: 'x', at: Date.now() }] }, t.token);
  body = await r.json();
  assert.equal(body.schedule, undefined); assert.equal(body.accepted, 1, '알려진 항목만 반영');
  const rows = res.latestResults({ agent: 'RMA-E' });
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'bad'); assert.equal(rows[0].instance, 'n1'); assert.equal(rows[0].name, 'ssh');
  // 접속 허용 IP 설정 → 127.0.0.1 이 목록에 없으면 403
  settings.setAgentAccess('RMA-E', { allowedIps: ['10.9.9.9'] });
  r = await post('/rma-poll', { agent: 'RMA-E', instance: 'n1', info: {}, wait: 0 }, t.token);
  assert.equal(r.status, 403); assert.match((await r.json()).reason, /허용 IP/);
  settings.setAgentAccess('RMA-E', { allowedIps: ['127.0.0.0/8'] });
  r = await post('/rma-poll', { agent: 'RMA-E', instance: 'n1', info: {}, wait: 0 }, t.token);
  assert.equal(r.status, 200);
  settings.setAgentAccess('RMA-E', {});
});
