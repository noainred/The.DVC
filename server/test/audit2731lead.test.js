/**
 * v2.731 점검 1회차 — 리드 통합분 회귀.
 *
 * ① A3-01 후속: 중앙이 접속처(대역·계정) 변경으로 iDRAC 스캔 할당의 비밀번호를 폐기하면 엣지는 비밀번호가 빈 할당을 받는다.
 *    그 할당으로 대역 전체에 로그인하면 iDRAC 마다 인증 실패가 쌓인다(계정 잠금 위험) — 엣지는 스캔하지 않고 사유 no-password 를 남긴다.
 *    비밀번호가 있는 할당은 예전처럼 스캔한다(빈 대역이라 0대 — 결과 회신까지 간다).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2731lead-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'mock';
process.env.CENTRAL_TOKEN = 'ctok-2731';
process.env.SSRF_ALLOW_LOOPBACK = 'true';

const servers = [];
after(() => { for (const s of servers) s.close(); fs.rmSync(TMP, { recursive: true, force: true }); });
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

test('A3-01 후속: 비밀번호가 빈 iDRAC 스캔 할당은 스캔하지 않고 no-password 를 남긴다 · 비밀번호가 있으면 스캔한다', async () => {
  const { config } = await import('../src/config.js');
  const scanner = await import('../src/agent/scanner.js');
  const express = (await import('express')).default;
  let assignment = { ok: true, assigned: true, agent: 'edge-x', ips: ['10.255.255.1'], username: 'root', password: '' };
  const results = [];
  const app = express();
  app.use(express.json());
  app.get('/api/central/assignment', (_req, res) => res.json(assignment));
  app.post('/api/central/result', (req, res) => { results.push(req.body); res.json({ ok: true }); });
  const srv = http.createServer(app); servers.push(srv);
  const port = await listen(srv);
  const prev = { url: config.agent.centralUrl, token: config.agent.centralToken, name: config.agent.name, auto: config.agent.autoRegister };
  config.agent.centralUrl = `http://127.0.0.1:${port}`; config.agent.centralToken = 'ctok-2731'; config.agent.name = 'edge-x';
  config.agent.autoRegister = false;
  try {
    const r1 = await scanner.runAgentScan();
    assert.equal(r1.reason, 'no-password', JSON.stringify(r1));
    assert.equal(r1.assigned, true);
    assert.equal(r1.scanned, undefined, '스캔하지 않는다');
    assert.equal(results.length, 0, '스캔하지 않았으므로 결과도 회신하지 않는다');
    assert.equal(scanner.getAgentScanStatus().last.reason, 'no-password');

    assignment = { ...assignment, ips: [], password: 'pw-ok' };
    const r2 = await scanner.runAgentScan();
    assert.notEqual(r2.reason, 'no-password', JSON.stringify(r2));
    assert.equal(r2.assigned, true);
    assert.equal(r2.scanned, 0);
    assert.equal(results.length, 1, '비밀번호가 있으면 스캔하고 결과를 회신한다');
  } finally {
    config.agent.centralUrl = prev.url; config.agent.centralToken = prev.token; config.agent.name = prev.name; config.agent.autoRegister = prev.auto;
  }
});
