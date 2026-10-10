/**
 * v2.732(점검 2회차 그룹 c) — 라우트 두 곳을 **실제 `api` 라우터**로 본다(소스 grep 아님).
 *
 * B4-01(숨은 의존): 로그 폴러가 site vCenter 에 로그인하지 않게 되면, `/tools/vclogs/sources` 가 site 를 local 로 분류하던 탓에
 *   화면(VcenterLogs.jsx — remote 일 때만 연합 조회)이 중앙 DB 를 읽고 그 vCenter 로그가 **조용히 멈춘다**. 이제 site 는 remote(연합 조회)이고
 *   담당 엣지 이름은 등록부 remoteAgent → 위임 인벤토리 순서, 모르면 지어내지 않고 표지 + agentUnknown 이다. 비활성·점검중은 local 그대로.
 * B6-03: 미보호 VM(⑩ — 60초 폴링) 리포트가 2만 행을 한 문장으로 읽던 것 — 이제 queryAsync(시간 조각 + 양보)를 쓴다.
 *   ⑨ 구성 변경(버튼 조회)은 그대로다(기존 소스 검사 bugfixes20260810 이 그 줄을 고정 — 바꾸려면 그 정규식도 함께).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2732c-routes-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({
  vcenters: [
    { id: 'vc-d', name: 'D', host: 'd.example', username: 'u', password: 'p' },
    { id: 'vc-m', name: 'M', host: 'm.example', username: 'u', password: 'p', maintenance: true },
    { id: 'vc-x', name: 'X', host: 'x.example', username: 'u', password: 'p', enabled: false },
    { id: 'vc-sa', name: 'SA', host: 'sa.example', username: 'u', password: 'p', collectMode: 'site', remoteAgent: 'edge-a' },
    { id: 'vc-sb', name: 'SB', host: 'sb.example', username: 'u', password: 'p', collectMode: 'site' },
    { id: 'vc-sc', name: 'SC', host: 'sc.example', username: 'u', password: 'p', collectMode: 'site' },
  ],
}));

const servers = [];
after(async () => {
  for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

const express = (await import('express')).default;
const { api } = await import('../src/routes/api.js');
const { setInventory } = await import('../src/central/inventory.js');
const { SITE_AGENT_UNKNOWN_LABEL } = await import('../src/routes/api/checksLogs.js');

async function serve(scope = null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'admin', role: 'admin', scope }; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(srv);
  const base = `http://127.0.0.1:${srv.address().port}`;
  return async (p) => { const r = await fetch(base + p); let b = null; try { b = await r.json(); } catch { /* */ } return { status: r.status, b }; };
}

test('B4-01 ④ /tools/vclogs/sources: site vCenter 는 remote(연합 조회) · 담당 엣지 = 등록부 → 위임 인벤토리 · 모르면 표지 + agentUnknown · 비활성·점검중은 local', async () => {
  // vc-sb 는 등록부에 담당 엣지가 없고 위임 인벤토리가 관측한 엣지만 있다
  setInventory('vc-sb', { vcenter: { id: 'vc-sb', status: 'ok' }, hosts: [], vms: [] }, 'edge-obs', Date.now());
  // vc-sa 는 등록부(edge-a)와 관측(edge-other)이 다르다 — 설정이 먼저다
  setInventory('vc-sa', { vcenter: { id: 'vc-sa', status: 'ok' }, hosts: [], vms: [] }, 'edge-other', Date.now());
  const get = await serve(null);
  const r = await get('/api/tools/vclogs/sources');
  assert.equal(r.status, 200);
  assert.deepEqual([...r.b.local].sort(), ['vc-d', 'vc-m', 'vc-x'], `site 는 local 이 아니다: ${JSON.stringify(r.b)}`);
  const remote = Object.fromEntries(r.b.remote.map((x) => [x.vcenterId, x]));
  assert.equal(remote['vc-sa']?.agent, 'edge-a', '등록부의 담당 엣지가 관측값보다 먼저다');
  assert.equal(remote['vc-sb']?.agent, 'edge-obs', '등록부에 없으면 위임 인벤토리가 관측한 엣지');
  assert.equal(remote['vc-sc']?.agent, SITE_AGENT_UNKNOWN_LABEL, '담당 엣지를 모르면 이름을 지어내지 않고 표지를 싣는다(연합 조회는 vCenter id 로 동작)');
  assert.equal(remote['vc-sc']?.agentUnknown, true);
  assert.ok(!remote['vc-sa'].agentUnknown && !remote['vc-sb'].agentUnknown);
  for (const id of ['vc-d', 'vc-m', 'vc-x']) assert.ok(!remote[id], `${id} 는 직접 수집(또는 그 이력) — local 이다`);

  // 범위 계정: 범위 안 site 하나만, 범위 밖 vCenter 는 존재도 싣지 않는다(v2.574 SEC-01)
  const gs = await serve({ vcenters: ['vc-sa'] });
  const rs = await gs('/api/tools/vclogs/sources');
  assert.equal(rs.status, 200);
  assert.deepEqual(rs.b.local, []);
  assert.deepEqual(rs.b.remote.map((x) => x.vcenterId), ['vc-sa']);
});

test('B6-03 ⑤ 미보호 VM 리포트(60초 폴링)는 조각 조회(queryAsync)를 쓴다 — 2만 행 한 문장(query)을 부르지 않는다', async () => {
  const { getLogsDb } = await import('../src/logs/db.js');
  const db = await getLogsDb();
  const H = 3_600_000;
  const NOW = Math.floor(Date.now() / H) * H - 30 * 60_000;   // 이벤트 시각만 정한다(경계 판정에 쓰지 않는다)
  db.insertMany(Array.from({ length: 200 }, (_, i) => ({ vcenterId: 'vc-d', key: `s${i}`, ts: NOW - (i + 1) * 10 * 60_000, severity: 'info',
    type: i % 2 ? 'TaskEvent' : 'VmReconfiguredEvent', user: 'DOMAIN\\svc-backup', entity: `vm-${i}`, message: i % 2 ? `Task: Create virtual machine snapshot vm-${i}` : `Reconfigured vm-${i}` })));
  const origQ = db.query; const origA = db.queryAsync;
  assert.equal(typeof origA, 'function');
  const bigSync = []; const asyncCalls = [];
  db.query = (f, limit, offset) => { if (Number(limit) >= 20_000) bigSync.push({ f, limit }); return origQ(f, limit, offset); };
  db.queryAsync = (f, limit, opts) => { asyncCalls.push({ f, limit }); return origA(f, limit, opts); };
  try {
    const get = await serve(null);
    const u = await get('/api/tools/report/unprotected?lookbackDays=7');
    assert.equal(u.status, 200, JSON.stringify(u.b).slice(0, 300));
  } finally { db.query = origQ; db.queryAsync = origA; }
  assert.deepEqual(bigSync, [], `2만 행 한 문장 조회가 남아 있다: ${JSON.stringify(bigSync).slice(0, 300)}`);
  assert.ok(asyncCalls.some((x) => x.f.q === 'Snapshot' && x.limit === 20_000), `미보호 VM 리포트: ${JSON.stringify(asyncCalls).slice(0, 300)}`);
});
