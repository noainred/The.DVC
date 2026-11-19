/**
 * test/vmPerf2926.test.js — v2.926 성능 화면 후속(시안 docs/design/vm-perf §8 '남긴 것' ②): 엣지 위임 vCenter 의 409 skip 본문에
 *   담당 엣지 포탈 주소(`edge:{id,name,url}`)를 **관리자에게만** 싣는다. 판정 · 사유 문구 · 로그인 0 은 v2.744 그대로(audit2744f 가 고정).
 *   등록부에 없는 엣지 · url 없는 엣지 · 비관리자 · site 가 아닌 skip(비활성)에는 싣지 않는다(지어내지 않는다).
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vmperf2926-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'true';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

const closers = [];
after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

const vmRow = (vcId) => ({ id: `${vcId}:vm-1`, vcenterId: vcId, name: `${vcId}-g1`, powerState: 'POWERED_ON', cpuUsagePct: 10, memUsagePct: 20, host: `${vcId}-h1`, cpuCount: 2, memMB: 4096, cluster: 'C1' });
const hostRow = (vcId) => ({ id: `${vcId}:host-1`, vcenterId: vcId, name: `${vcId}-h1`, cluster: 'C1', connectionState: 'CONNECTED', cpuCores: 8, cpuTotalMhz: 20000, memTotalMB: 65536 });

let base;
before(async () => {
  // 엣지 위임 vCenter 3개: edge1(등록부에 url 있음) · edge2(등록부에 있지만 url 없음) · ghost(등록부에 없음) + 비활성 vCenter 1개.
  fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [
    { id: 'vc-s1', name: 'VC-S1', host: 'http://127.0.0.1:9', username: 'u', password: 'p', enabled: true, collectMode: 'site', remoteAgent: 'Edge1', timeoutMs: 1000 },
    { id: 'vc-s2', name: 'VC-S2', host: 'http://127.0.0.1:9', username: 'u', password: 'p', enabled: true, collectMode: 'site', remoteAgent: 'edge2', timeoutMs: 1000 },
    { id: 'vc-s3', name: 'VC-S3', host: 'http://127.0.0.1:9', username: 'u', password: 'p', enabled: true, collectMode: 'site', remoteAgent: 'ghost', timeoutMs: 1000 },
    { id: 'vc-o', name: 'VC-O', host: 'http://127.0.0.1:9', username: 'u', password: 'p', enabled: false, timeoutMs: 1000 },
  ] }));
  fs.writeFileSync(path.join(DIR, 'collectors.json'), JSON.stringify({ collectors: [
    { id: 'edge1', name: 'AZ 엣지', url: 'http://192.0.2.10:4000/', token: 't1' },
    { id: 'edge2', name: 'PL 엣지', token: 't2' },
  ] }));
  const { store } = await import('../src/store.js');
  const ids = ['vc-s1', 'vc-s2', 'vc-s3', 'vc-o'];
  store.snapshot = {
    ...(store.get() || {}), source: 'live', generatedAt: '2026-11-06T22:00:00.000Z',
    vcenters: ids.map((id) => ({ id, name: id.toUpperCase(), status: 'connected' })),
    vms: ids.map(vmRow), hosts: ids.map(hostRow), datastores: [], networks: [], alarms: [],
  };
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'u1', role: req.get('x-role') || 'admin', scope: null }; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  base = `http://127.0.0.1:${srv.address().port}`;
});

const call = async (p, headers = {}) => {
  const r = await fetch(`${base}${p}`, { headers });
  let j = null; try { j = await r.json(); } catch { j = null; }
  return { status: r.status, j };
};
const vmPath = (vc, q) => `/api/vms/${encodeURIComponent(`${vc}:vm-1`)}/metrics?${q}`;
const hostPath = (vc, q) => `/api/hosts/${encodeURIComponent(`${vc}:host-1`)}/metrics?${q}`;

test('엣지 위임(site) 409 — 관리자에게는 담당 엣지 포탈 주소(edge)를 싣는다 · 사유 · skipReason 은 그대로 · 단건 type= 도 같다', async () => {
  for (const q of ['types=cpu,mem,disk,net&interval=day', 'type=cpu&interval=day', 'types=cpu&interval=realtime&manual=1']) {
    const r = await call(vmPath('vc-s1', q));
    assert.equal(r.status, 409, q);
    assert.equal(r.j.skipReason, 'site');
    assert.ok(typeof r.j.reason === 'string' && r.j.reason.length > 0, '사유 문구는 그대로');
    assert.deepEqual(r.j.edge, { id: 'edge1', name: 'AZ 엣지', url: 'http://192.0.2.10:4000/' }, `edge: ${JSON.stringify(r.j.edge)}`);
  }
  const h = await call(hostPath('vc-s1', 'types=cpu&interval=day'));
  assert.equal(h.status, 409); assert.deepEqual(h.j.edge, { id: 'edge1', name: 'AZ 엣지', url: 'http://192.0.2.10:4000/' });
});

test('비관리자 · url 없는 엣지 · 등록부에 없는 엣지 · 비활성 vCenter 에는 edge 를 싣지 않는다(지어내지 않는다)', async () => {
  const viewer = await call(vmPath('vc-s1', 'types=cpu&interval=day'), { 'x-role': 'viewer' });
  assert.equal(viewer.status, 409); assert.equal(viewer.j.skipReason, 'site'); assert.equal('edge' in viewer.j, false, '관리 주소는 비관리자에게 가린다');
  const op = await call(vmPath('vc-s1', 'types=cpu&interval=day'), { 'x-role': 'operator' });
  assert.equal(op.status, 409); assert.equal('edge' in op.j, false);
  const noUrl = await call(vmPath('vc-s2', 'types=cpu&interval=day'));
  assert.equal(noUrl.status, 409); assert.equal('edge' in noUrl.j, false, 'url 이 없는 엣지는 싣지 않는다');
  const ghost = await call(vmPath('vc-s3', 'types=cpu&interval=day'));
  assert.equal(ghost.status, 409); assert.equal('edge' in ghost.j, false, '등록부에 없는 엣지는 싣지 않는다');
  const off = await call(vmPath('vc-o', 'types=cpu&interval=day'));
  assert.equal(off.status, 409); assert.equal(off.j.skipReason, 'disabled'); assert.equal('edge' in off.j, false, 'site 가 아닌 skip 에는 싣지 않는다');
});

test('edgeHint 순수 — 대소문자 · 이름 일치 · 던지지 않는다', async () => {
  const { edgeHint } = await import('../src/routes/api/vmMetrics.js');
  const admin = { user: { username: 'a', role: 'admin' } };
  assert.deepEqual(edgeHint(admin, { remoteAgent: 'EDGE1' }, { skipReason: 'site' }), { edge: { id: 'edge1', name: 'AZ 엣지', url: 'http://192.0.2.10:4000/' } });
  assert.deepEqual(edgeHint(admin, { remoteAgent: 'az 엣지' }, { skipReason: 'site' }).edge?.id, 'edge1');
  assert.deepEqual(edgeHint(admin, { remoteAgent: '' }, { skipReason: 'site' }), {});
  assert.deepEqual(edgeHint(admin, null, { skipReason: 'site' }), {});
  assert.deepEqual(edgeHint(admin, { remoteAgent: 'edge1' }, null), {});
  assert.deepEqual(edgeHint({ user: { username: 'v', role: 'viewer' } }, { remoteAgent: 'edge1' }, { skipReason: 'site' }), {});
});
