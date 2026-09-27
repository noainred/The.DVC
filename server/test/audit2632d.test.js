// v2.632 감사 그룹 D(권한·보안) 회귀 — AX3-01..08. 실제 라우터를 express 에 띄워 상태코드·응답으로 본다.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2632d-'));
process.env.CONFIG_DIR = CFG;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';

const express = (await import('express')).default;
const FULL = { username: 'root', role: 'admin', scope: {} };
let VC_A; let VC_B;
let SCOPED;
const HOUR = 3_600_000;
const T0 = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000; // 정시 −30분(경계에서 떨어뜨린 고정 기준)

async function call(mount, router, user, method, url, body) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(mount, router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err?.message || err) }));
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}${mount}${url}`, {
      method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 비 JSON */ }
    return { status: res.status, body: json, text };
  } finally { srv.close(); }
}

let store; let remoteRouter; let adminRouter; let api;
before(async () => {
  ({ store } = await import('../src/store.js'));
  await store.refresh().catch(() => {});
  const vcs = [...new Set(store.get().vms.map((v) => v.vcenterId))];
  [VC_A, VC_B] = vcs;
  SCOPED = { username: 'adm2', role: 'admin', scope: { vcenters: [VC_A] } };
  ({ remoteRouter } = await import('../src/routes/remote.js'));
  ({ adminRouter } = await import('../src/routes/admin.js'));
  ({ api } = await import('../src/routes/api.js'));
});

test('AX3-01: GET /remote/config 는 범위 admin 에게 범위 밖 프록시를 주지 않고 개수를 밝힌다', async () => {
  const { saveProxy } = await import('../src/proxy/registry.js');
  saveProxy({ name: 'P-B', proxyHost: '10.2.2.2', vcenterIds: [VC_B], deploy: { host: '10.2.2.9', username: 'root', password: 'x' } });
  saveProxy({ name: 'P-A', proxyHost: '10.1.1.1', vcenterIds: [VC_A, VC_B] });
  const s = await call('/api/remote', remoteRouter, SCOPED, 'GET', '/config');
  assert.equal(s.status, 200);
  assert.ok(!s.text.includes('10.2.2.2') && !s.text.includes('10.2.2.9'), '범위 밖 프록시 주소가 샜다');
  assert.equal(s.body.scoped, true);
  assert.ok(s.body.omittedOutOfScope >= 1);
  const pa = s.body.config.proxies.find((p) => p.name === 'P-A');
  assert.deepEqual(pa.vcenterIds, [VC_A], 'vcenterIds 도 범위 안으로 잘라야 한다');
  const f = await call('/api/remote', remoteRouter, FULL, 'GET', '/config');
  assert.ok(f.text.includes('10.2.2.2'), '전체 범위 admin 은 예전 그대로 전부');
});

test('AX3-02: 프로비저닝 작업 목록·단건은 범위 밖을 숨긴다(목록은 개수, 단건은 404)', async () => {
  const snap = store.get();
  const src = snap.vms.find((v) => v.vcenterId === VC_B);
  const { createJob } = await import('../src/provision/jobs.js');
  const r = createJob({ sourceId: src.id, perVm: [{ name: 'corpB-secret-vm', ip: '10.99.1.5' }], guest: {} }, { user: { username: 'root', role: 'admin' } });
  assert.equal(r.ok, true, r.reason);
  const id = r.job.id;
  const l = await call('/api', api, SCOPED, 'GET', '/provision/jobs');
  assert.equal(l.status, 200);
  assert.ok(!l.text.includes('corpB-secret-vm') && !l.text.includes('10.99.1.5'));
  assert.ok(l.body.omittedOutOfScope >= 1);
  const one = await call('/api', api, SCOPED, 'GET', `/provision/jobs/${id}`);
  assert.equal(one.status, 404);
  const full = await call('/api', api, FULL, 'GET', `/provision/jobs/${id}`);
  assert.equal(full.status, 200);
});

test('AX3-03: RDP 티켓은 필드 길이 상한(거부)과 사용자당 보관 상한을 갖는다', async () => {
  const OP = { username: 'op', role: 'operator', scope: {} };
  const big = await call('/api/remote', remoteRouter, OP, 'POST', '/rdp-ticket', { username: 'u', password: 'x'.repeat(5000) });
  assert.equal(big.status, 400);
  const obj = await call('/api/remote', remoteRouter, OP, 'POST', '/rdp-ticket', { username: 'u', password: { a: 1 } });
  assert.equal(obj.status, 400);
  const ok = await call('/api/remote', remoteRouter, OP, 'POST', '/rdp-ticket', { username: 'u', password: 'p@ss' });
  assert.equal(ok.status, 200);
  const t = await import('../src/proxy/rdpTicket.js');
  t._resetRdpTickets();
  const ids = [];
  for (let i = 0; i < t.MAX_TICKETS_PER_OWNER + 5; i++) ids.push(t.issueRdpTicket({ username: 'u', password: String(i) }, { owner: 'op' }));
  const other = t.issueRdpTicket({ username: 'v', password: 'z' }, { owner: 'other' });
  assert.equal(t.consumeRdpTicket(ids[0]), null, '같은 사용자의 가장 오래된 티켓은 밀려난다');
  assert.ok(t.consumeRdpTicket(ids[ids.length - 1]), '최신 티켓은 남는다');
  assert.ok(t.consumeRdpTicket(other), '다른 사용자의 티켓은 밀어내지 않는다');
});

test('AX3-04: GPU 시계열 JSON 내보내기는 스트리밍이고 동시 1건 가드(409)를 갖는다', async () => {
  const { getMetricsDb } = await import('../src/metrics/db.js');
  const db = await getMetricsDb();
  const host = store.get().hosts[0];
  for (let i = 0; i < 5; i++) db.insertMany([{ metric: 'gpu_util', k: host.id, v: 10 + i }], T0 - (5 - i) * 60_000);
  const r = await call('/api', api, FULL, 'GET', '/tools/gpu/export.json?range=all');
  assert.equal(r.status, 200);
  const j = JSON.parse(r.text);
  assert.ok(j.sampleCount >= 5 && Array.isArray(j.points) && j.points.length === j.sampleCount);
  assert.equal(j.truncated, false);
  assert.ok(!r.text.includes('\n  '), '들여쓰기 직렬화(동기 대용량 문자열)를 하지 않는다');
  const { acquireExport } = await import('../src/util/exportBusy.js');
  const lock = acquireExport('gpu.series.export', { user: FULL });
  try {
    const b = await call('/api', api, FULL, 'GET', '/tools/gpu/export.json?range=all');
    assert.equal(b.status, 409);
    assert.equal(b.body.error, 'export_busy');
    const c = await call('/api', api, FULL, 'GET', '/tools/gpu/export.csv?range=all');
    assert.equal(c.status, 409);
  } finally { lock.release(); }
  const again = await call('/api', api, FULL, 'GET', '/tools/gpu/export.csv?range=all');
  assert.equal(again.status, 200, '끝나면 잠금이 풀린다');
});

test('AX3-05: DataCenter 목록·순서는 범위 admin 에게 범위 안 할당만 준다', async () => {
  await call('/api/admin', adminRouter, FULL, 'POST', '/datacenters', { id: 'corp-b', name: 'Corp-B-Secret', memo: 'b note' });
  await call('/api/admin', adminRouter, FULL, 'POST', '/datacenters', { id: 'corp-a', name: 'Corp-A' });
  const as = await call('/api/admin', adminRouter, FULL, 'PUT', '/datacenters/assign', { entries: [[VC_B, 'corp-b'], [VC_A, 'corp-a']] });
  assert.equal(as.status, 200);
  const s = await call('/api/admin', adminRouter, SCOPED, 'GET', '/datacenters');
  assert.equal(s.status, 200);
  assert.ok(!s.text.includes('Corp-B-Secret') && !s.text.includes(VC_B));
  assert.deepEqual(Object.keys(s.body.assign), [VC_A]);
  assert.deepEqual(s.body.datacenters.map((d) => d.id), ['corp-a']);
  assert.ok(s.body.omittedOutOfScope >= 2);
  const o = await call('/api/admin', adminRouter, SCOPED, 'GET', '/datacenter-order');
  assert.ok(!o.text.includes('Corp-B-Secret'));
  assert.deepEqual(o.body.datacenters.map((d) => d.id), ['corp-a']);
  const f = await call('/api/admin', adminRouter, FULL, 'GET', '/datacenters');
  assert.ok(f.text.includes('Corp-B-Secret'));
});

test('AX3-06: 범위 admin 의 /packages?baseUrl= 은 무시되고 그 사실을 밝힌다', async () => {
  const s = await call('/api/admin', adminRouter, SCOPED, 'GET', '/packages?baseUrl=' + encodeURIComponent('http://10.255.255.1:9'));
  assert.equal(s.status, 200);
  assert.equal(s.body.baseUrlIgnored, true);
  assert.ok(!JSON.stringify(s.body.remote || {}).includes('10.255.255.1'));
});

test('AX3-07: 인증서 즉시 재확인은 범위 계정 403', async () => {
  const s = await call('/api/admin', adminRouter, SCOPED, 'POST', '/certs/refresh', {});
  assert.equal(s.status, 403);
  assert.equal(s.body.requiredOwner, true);
});

test('AX3-08: DataCenter 일괄 할당은 원소 모양을 검사한다(500 금지)', async () => {
  const bad = await call('/api/admin', adminRouter, FULL, 'PUT', '/datacenters/assign', { entries: [42, 'x', null] });
  assert.equal(bad.status, 400);
  const obj = await call('/api/admin', adminRouter, FULL, 'PUT', '/datacenters/assign', { entries: [{ vcenterId: VC_B, datacenterId: 'corp-a' }, 7] });
  assert.equal(obj.status, 200);
  assert.equal(obj.body.malformed, 1);
  const { setVcenterDatacenterMany, getDatacenterAssign } = await import('../src/datacenter/store.js');
  assert.equal(getDatacenterAssign()[VC_B], 'corp-a');
  const r = setVcenterDatacenterMany([[VC_A, 'ghost']]);
  assert.equal(r.unknownDatacenter, 1);
});
