// v2.732(점검 2회차 B3-08): GET /api/admin/ipam/db-info 가 범위 관리자에게 전 법인 원장(ipam.db 전체) 행 수를 줬다.
// 실제 라우트(registerCentralIpam)를 express 에 띄워 상태코드·값으로 본다 — 범위 계정 count null + fleetCountsHidden, 전체 범위는 원값.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dbinfo2732d-'));
process.env.CONFIG_DIR = CFG;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';
process.env.IPAM_WRITE_WORKER = '0';

const express = (await import('express')).default;
const { registerCentralIpam } = await import('../src/routes/admin/centralIpam.js');
const { syncLedger } = await import('../src/ipam/db.js');

let user = null;
const app = express();
app.use(express.json());
app.use((req, _r, n) => { req.user = user; n(); });
const router = express.Router();
registerCentralIpam(router);
app.use('/api/admin', router);
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${srv.address().port}/api/admin`;
after(() => { srv.close(); fs.rmSync(CFG, { recursive: true, force: true }); });

const row = (ip, vc) => ({ ip, vcenterId: vc, vcenterName: vc, ownerType: 'vm', ownerName: `vm-${ip}`, powerState: 'POWERED_ON' });

test('B3-08: 범위 관리자는 전 법인 원장 행 수를 받지 않는다 · 전체 범위는 원값', async () => {
  assert.equal(await syncLedger([row('10.0.0.1', 'vc-a'), row('10.0.0.2', 'vc-a'), row('10.9.0.1', 'vc-b')]), true);

  user = { username: 'full', role: 'admin', scope: null };
  const full = await (await fetch(`${base}/ipam/db-info`)).json();
  assert.equal(full.count, 3, JSON.stringify(full));
  assert.equal(full.fleetCountsHidden, undefined);
  assert.equal(full.kind, 'sqlite');

  user = { username: 'sadmin', role: 'admin', scope: { vcenters: ['vc-a'] } };
  const r = await fetch(`${base}/ipam/db-info`);
  assert.equal(r.status, 200);
  const scoped = await r.json();
  assert.equal(scoped.count, null, `범위 계정에 전 법인 합계가 나갔다: ${JSON.stringify(scoped)}`);
  assert.equal(scoped.fleetCountsHidden, true);
  assert.equal(scoped.kind, 'sqlite', '종류·경로는 그대로(경로 가림은 정책 — 별건)');
  assert.equal(typeof scoped.path, 'string');
});
