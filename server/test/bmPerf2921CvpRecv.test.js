/**
 * v2.922(리눅스 성능 3a · 반증 D3) — CVP 포트 드롭이 **실제 중앙 수신 경로**(POST /api/central/cvp-data → sanitizeCvpBody → saveDevices → importSamples)
 *   를 통과해 남는가. 31140f2a 는 정제가 표본 행을 10칸으로 잘라 드롭이 사라지고, 표본 적재가 장비 레코드의 드롭을 null 로 덮었다.
 *   새 엣지 12칸 행은 드롭을 싣고 · 구 엣지 10칸 행은 port_latest 드롭을 덮지 않는다(드롭 칸이 없다 ≠ 못 읽음 null).
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bm2921cvprecv-'));
process.env.CENTRAL_TOKEN = 'ctok-2922';
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
let central; let port;
before(async () => {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use('/api/central', centralRouter);
  central = http.createServer(app);
  port = await listen(central);
});
after(() => { central?.close(); fs.rmSync(process.env.CONFIG_DIR, { recursive: true, force: true }); });

const post = (body) => fetch(`http://127.0.0.1:${port}/api/central/cvp-data`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': 'ctok-2922', 'X-Agent-Name': 'edge-a' }, body: JSON.stringify({ agent: 'edge-a', ...body }),
}).then(async (r) => ({ status: r.status, j: await r.json() }));

test('D3 실제 수신: 장비 레코드 드롭 7/9 → 12칸 표본(5/6)은 정제를 지나 port_latest·port_sample 에 남고 · 10칸 표본은 드롭을 덮지 않는다', async () => {
  const reg = await import('../src/cvp/registry.js');
  const db = await import('../src/cvp/db.js');
  const s = reg.saveServer({ name: 'CVP-edge', host: 'https://cvp.example.invalid', authMode: 'token', token: 'T', agent: 'edge-a' });
  const now = Date.now();
  const dev = { cvpId: s.id, key: 'SN1', hostname: 'leaf1', ts: now - 180_000,
    ports: [{ name: 'Et1', desc: 'bm-kr1-db01 eno1', speedBps: 1e10, oper: 'up', admin: 'up', inBps: 1, outBps: 2, inErr: 0, outErr: 0, inDrop: 7, outDrop: 9 },
      { name: 'Et2', desc: 'x', speedBps: 1e10, oper: 'up', admin: 'up', inBps: 1, outBps: 2, inErr: 0, outErr: 0, inDrop: 7, outDrop: 9 }] };
  const a = await post({ chunk: 0, chunks: 2, servers: [], devices: [dev] });
  assert.equal(a.status, 200, JSON.stringify(a.j));
  let rows = (await db.portLatestRows({ cvpIds: [s.id] })).rows;
  assert.deepEqual(rows.filter((r) => r.agent === 'edge-a').map((r) => [r.port, r.in_drop, r.out_drop]).sort(), [['Et1', 7, 9], ['Et2', 7, 9]]);
  // 새 엣지 12칸(Et1 — 드롭 5/6) · 구 엣지 10칸(Et2 — 드롭 칸 없음)
  const b = await post({ chunk: 1, chunks: 2, rows: [[s.id, 'SN1', 'Et1', now - 60_000, 100, 200, 1, 2, 0, 0, 5, 6], [s.id, 'SN1', 'Et2', now - 60_000, 100, 200, 1, 2, 0, 0]] });
  assert.equal(b.status, 200, JSON.stringify(b.j));
  rows = (await db.portLatestRows({ cvpIds: [s.id] })).rows.filter((r) => r.agent === 'edge-a');
  const by = Object.fromEntries(rows.map((r) => [r.port, r]));
  assert.deepEqual([by.Et1.in_drop, by.Et1.out_drop], [5, 6], '12칸 표본의 드롭이 정제를 지나 최신값이 된다');
  assert.equal(by.Et1.in_bps, 100);
  assert.deepEqual([by.Et2.in_drop, by.Et2.out_drop], [7, 9], '10칸 표본은 드롭을 null 로 덮지 않는다');
  assert.equal(by.Et2.in_bps, 100, '처리량은 그대로 갱신된다');
  const ser = await db.portSeries({ agent: 'edge-a', cvpId: s.id, key: 'SN1', port: 'Et1', hours: 1 });
  assert.deepEqual(ser.points.map((p) => [p.inDrop, p.outDrop]), [[5, 6]], 'port_sample 에도 드롭');
  const ser2 = await db.portSeries({ agent: 'edge-a', cvpId: s.id, key: 'SN1', port: 'Et2', hours: 1 });
  assert.deepEqual(ser2.points.map((p) => [p.inDrop, p.outDrop]), [[null, null]], '구 엣지 표본의 드롭은 null(0 아님)');
});

test('D3 정제 단위: 12칸은 12칸 · 10칸은 10칸(드롭을 지어내지 않는다) · 문자열 수치는 수로', async () => {
  const { sanitizeCvpBody } = await import('../src/central/cvpEdge.js');
  const now = Date.now();
  const c = sanitizeCvpBody({ rows: [['c1', 'K', 'P', now - 1000, 1, 2, 3, 4, 0, 0, '5', null], ['c1', 'K', 'P2', now - 1000, 1, 2, 3, 4, 0, 0]] }, new Set(['c1']), now);
  assert.equal(c.rows[0].length, 12); assert.equal(c.rows[0][10], 5); assert.equal(c.rows[0][11], null);
  assert.equal(c.rows[1].length, 10);
});
