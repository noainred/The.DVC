/**
 * v2.428 — 구성도(중앙→Edge DVC HAProxy→IRS) 미스매치 12건 수정 회귀 테스트.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'topo2428-'));

test('#2 portalUnitAllowed: 포탈 유닛만 허용(haproxy/nginx/socat 거부)', async () => {
  const { portalUnitAllowed } = await import('../src/agent/deploy.js');
  assert.equal(portalUnitAllowed('vmware-portal'), true);
  assert.equal(portalUnitAllowed('vmware-portal@irs'), true);
  assert.equal(portalUnitAllowed('vmware-portal-irs'), true, '별도 인스턴스 명명(기존 테스트 규약)');
  for (const u of ['haproxy', 'nginx', 'socat@4068', 'vmware-portal-rma@a', '']) assert.equal(portalUnitAllowed(u), false, u);
});

test('#3 pickSshTarget: host 가 겹치면 후보 반환(자동 선택 금지), sshTargetId 로 지정, 포워딩 경유 판정', async () => {
  const { pickSshTarget } = await import('../src/agent/deployRegistry.js');
  const targets = [
    { id: 't-edge', host: '192.168.60.221', port: 22, agentName: 'gm1', portalPort: 4000 },
    { id: 't-irs', host: '192.168.60.221', port: 4067, agentName: 'gm1-IRS', portalPort: 4000 },
    { id: 't-other', host: '192.168.64.221', port: 22 },
  ];
  const r = pickSshTarget(targets, '192.168.60.221');
  assert.equal(r.ok, false); assert.equal(r.candidates.length, 2); assert.match(r.reason, /sshTargetId/);
  const irs = pickSshTarget(targets, '192.168.60.221', 't-irs');
  assert.equal(irs.ok, true); assert.equal(irs.target.id, 't-irs'); assert.equal(irs.viaRelay, true);
  const one = pickSshTarget(targets, '192.168.64.221');
  assert.equal(one.ok, true); assert.equal(one.viaRelay, false);
  assert.equal(pickSshTarget(targets, '10.0.0.9').ok, false);
  assert.equal(pickSshTarget(targets, '192.168.60.221', 'nope').ok, false);
});

test('#9 identityIssue: DC 일치는 더 이상 통과가 아니며, 응답 agent 가 다른 등록 항목 id 면 즉시 불일치', async () => {
  const { identityIssue } = await import('../src/collector/registry.js');
  const entry = { id: 'gm1-IRS', name: 'GM1-IRS', datacenter: 'gm1' };
  const iss = identityIssue(entry, { agent: 'gm1', hostname: 'edge-a' }, ['gm1', 'gm1-IRS']);
  assert.ok(iss, '포워딩이 A 자신으로 되돌아온 경우를 잡는다'); assert.match(iss.reason, /다른 수집 서버 항목/);
  assert.equal(identityIssue(entry, { agent: 'GM1-IRS' }, ['gm1', 'gm1-IRS']), null);
  assert.equal(identityIssue(entry, {}, []), null);
});

test('#5 backoffFor: ok/404/403 → 6h, 400 → 30분, 연결 실패 → 60초', async () => {
  const { backoffFor } = await import('../src/agent/selfRegister.js');
  assert.equal(backoffFor({ ok: true }), 6 * 3_600_000);
  assert.equal(backoffFor({ ok: false, status: 404 }), 6 * 3_600_000);
  assert.equal(backoffFor({ ok: false, status: 400 }), 30 * 60_000);
  assert.equal(backoffFor({ ok: false, reason: 'ECONNREFUSED' }), 60_000);
  assert.equal(backoffFor(null), 60_000);
});

test('#8 clientIp: trust proxy 설정 시에만 req.ip, 아니면 소켓 peer', async () => {
  const { clientIp } = await import('../src/util/rateLimit.js');
  const mk = (trust) => ({ ip: '10.1.1.1', socket: { remoteAddress: '192.168.88.221' }, app: { get: (k) => (k === 'trust proxy' ? trust : undefined) } });
  assert.equal(clientIp(mk(false)), '192.168.88.221');
  assert.equal(clientIp(mk(1)), '10.1.1.1');
});

test('#11 takeJobsWait: 대기 중 연결이 끊기면(isAlive=false) 깨어나도 claim 하지 않는다', async () => {
  const jobs = await import('../src/rma/jobs.js');
  jobs._resetRma?.();
  const p = jobs.takeJobsWait('AG-X', 'i1', 300, { isAlive: () => false });
  setTimeout(() => jobs.enqueueJob('AG-X', { cmd: 'uptime', args: {}, timeoutMs: 10_000 }, { user: 't' }), 50);
  const got = await p;
  assert.deepEqual(got, [], '끊긴 클라이언트에게는 잡을 주지 않는다');
  const again = jobs.takeJobs('AG-X', 'i1');
  assert.equal(again.length, 1, '잡은 큐에 남아 다음 폴이 가져간다');
  jobs._resetRma?.();
});

test('#6/#7 agentIdentity: 같은 이름·다른 hostname → 충돌, 같은 vcenterId·다른 agent → 충돌', async () => {
  const ai = await import('../src/central/agentIdentity.js');
  ai._resetForTest();
  ai.noteAgentIdentity('hd', { hostname: 'edge-a' });
  const c = ai.noteAgentIdentity('HD', { hostname: 'irs-b' });
  assert.equal(c.conflict.hostname, 'edge-a');
  ai.noteVcenterOwner('vc-ap-northeast', 'hd');
  const v = ai.noteVcenterOwner('vc-ap-northeast', 'agent-MI');
  assert.equal(v.conflict.agent, 'hd');
  const sum = ai.agentIdentitySummary();
  assert.ok(sum.byAgent.hd.conflict); assert.equal(sum.vcenterConflicts[0].vcenterId, 'vc-ap-northeast');
  ai._resetForTest();
});

let server, base, tokens;
before(async () => {
  process.env.CENTRAL_TOKEN = '';
  tokens = await import('../src/central/agentTokens.js');
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express(); app.use(express.json()); app.use('/api/central', centralRouter);
  server = app.listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

test('#12 중앙 /inventory: source=mock 인 push 는 400 으로 거부하고 저장하지 않는다', async () => {
  const { getInventory } = await import('../src/central/inventory.js');
  const t = tokens.issueAgentToken('mock-edge');
  const r = await fetch(`${base}/api/central/inventory`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': t.token, 'X-Agent-Hostname': 'irs-x' },
    body: JSON.stringify({ agent: 'mock-edge', vcenterId: 'vc-ap-northeast', vcenter: { id: 'vc-ap-northeast' }, source: 'mock', hosts: [], vms: [] }) });
  const j = await r.json();
  assert.equal(r.status, 400); assert.match(j.reason, /mock/);
  assert.equal(getInventory('vc-ap-northeast'), null);
});
