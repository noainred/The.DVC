// v2.694: '스캔 대역·설정 › ② 에이전트별 대역·보고 현황' 의 에이전트별 대역 삭제(사용자 요청 "등록된 에이전트별 대역 삭제하는 기능").
//   mode 'ranges' = 대역만 비움(포트·주기는 남는다) · 'agent' = 설정·보고 기록까지 · 화면이 본 목록(expect)과 다르면 409 ·
//   이 포탈은 등록 삭제 불가(400) · 범위 계정 403. 실제 admin 라우터를 띄워 상태코드로 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

function runChild(body, { user, setup }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipscan2694-'));
  setup?.(dir);
  const script = `
    const SRC = ${JSON.stringify(SRC + '/')};
    const express = (await import('express')).default;
    const fs = await import('node:fs');
    const { store } = await import(SRC + 'store.js');
    await store.refresh?.();
    const { adminRouter } = await import(SRC + 'routes/admin.js');
    const app = express(); app.use(express.json());
    app.use((req, _r, n) => { req.user = ${JSON.stringify(user)}; n(); });
    app.use('/api/admin', adminRouter);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const call = async (m, p, b) => { const r = await fetch(base + '/api/admin' + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t.slice(0, 200); } return { s: r.status, j }; };
    const get = (p) => call('GET', p);
    const post = (p, b) => call('POST', p, b);
    const out = {};
    try { ${body} } catch (e) { out.err = String(e && e.stack || e); } finally { srv.close(); }
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' }, encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 180_000,
  });
  assert.equal(r.status, 0, (r.stderr || '').slice(-2000));
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `${r.stdout.slice(-800)} ${r.stderr.slice(-800)}`);
  const o = JSON.parse(line.slice(2));
  assert.equal(o.err, undefined, o.err);
  return { ...o, dir };
}

const FULL = { username: 'full', role: 'admin', scope: null };

test('① 대역만 삭제 · 등록 삭제(대소문자 무시) · 409 · 400 · 404 · 다른 에이전트는 그대로', () => {
  const o = runChild(`
    fs.writeFileSync(process.env.CONFIG_DIR + '/ipam-scan.json', JSON.stringify({ agents: {
      __local__: { enabled: true, ranges: ['10.10.0.0/24'], ports: [22, 443] },
      'Edge-A': { enabled: true, ranges: ['10.20.0.0/24', '10.20.1.0/24'], ports: [80] },
      'Edge-B': { enabled: true, ranges: ['10.30.0.0/24'] } } }));
    const S = await import(SRC + 'ipam/scanStore.js'); // 이미 로드된 모듈이라 보고 기록은 함수로 넣는다
    S.recordAgentReport('Edge-A', { scanned: 5, alive: 2 }); S.recordAgentReport('Edge-B', { scanned: 3, alive: 1 });
    out.stale = await post('/ipam/scan/agent/delete', { agent: 'Edge-A', mode: 'ranges', expect: ['10.20.0.0/24'] });
    out.localAgent = await post('/ipam/scan/agent/delete', { agent: '__local__', mode: 'agent' });
    out.badMode = await post('/ipam/scan/agent/delete', { agent: 'Edge-A', mode: 'x' });
    out.local = await post('/ipam/scan/agent/delete', { agent: '__local__', mode: 'ranges', expect: ['10.10.0.0/24'] });
    out.localAfter = S.loadScanSettings('__local__');
    out.edgeA = await post('/ipam/scan/agent/delete', { agent: 'edge-a', mode: 'agent', expect: ['10.20.0.0/24', '10.20.1.0/24'] });
    out.agents = S.listScanAgents().map((a) => a.name);
    out.reports = Object.keys(S.getAgentReports());
    out.edgeB = S.loadScanSettings('Edge-B');
    out.unknown = await post('/ipam/scan/agent/delete', { agent: 'Edge-Z', mode: 'agent' });
    out.list = await get('/ipam/scan/ranges');
  `, { user: FULL });
  assert.equal(o.stale.s, 409); assert.equal(o.stale.j.code, 'stale');
  assert.equal(o.localAgent.s, 400); assert.equal(o.localAgent.j.code, 'local');
  assert.equal(o.badMode.s, 400);
  assert.equal(o.local.s, 200); assert.equal(o.local.j.removedRanges, 1);
  assert.deepEqual(o.localAfter.ranges, []); assert.deepEqual(o.localAfter.ports, [22, 443], '대역만 비우고 포트·켜짐은 남는다'); assert.equal(o.localAfter.enabled, true);
  assert.equal(o.edgeA.s, 200); assert.equal(o.edgeA.j.removedRanges, 2); assert.equal(o.edgeA.j.removedReport, true);
  assert.deepEqual(o.agents.sort(), ['Edge-B', '__local__'], '대소문자만 다른 이름으로도 그 항목을 지운다');
  assert.deepEqual(o.reports, ['Edge-B']);
  assert.deepEqual(o.edgeB.ranges, ['10.30.0.0/24'], '다른 에이전트는 그대로');
  assert.equal(o.unknown.s, 404);
  assert.ok(!o.list.j.agents.some((a) => a.name === 'Edge-A'), '② 표에서 빠진다');
  assert.ok(!o.list.j.rows.some((r) => r.agent === '__local__'), '이 포탈의 대역 행도 없다');
});

test('② 범위 계정은 403(전 법인 스캔 설정)', () => {
  const s = runChild(`out.p = await post('/ipam/scan/agent/delete', { agent: '__local__', mode: 'ranges' });`,
    { user: { username: 'scoped', role: 'admin', scope: { vcenters: ['vc-x'] } } });
  assert.equal(s.p.s, 403);
});
