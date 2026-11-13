/**
 * v2.954(점검 A-1 · A-4) — 온보딩 엣지 배포 행 · 연결 시험의 범위.
 *  A-1: 귀속 없는(corp/vcenterId 없음) 엣지 배포 행 빼기(DELETE /onboard/edge-rows) · 서버 연결 시험(POST /onboard/test)은
 *       조회 ∧ 쓰기 전체 범위(isFullReadWriteScope)만. 예전에는 조회 범위만 봐 scope = { writeVcenters: ['vcA'] } admin 이 지나갔다
 *       (엣지가 그 서버 수집을 멈춘다 · 저장된 비밀로 SSH 시험 접속).
 *  A-4: 엣지 배포 행 목록(GET /onboard/edge-rows)은 범위 계정에 키 · 공통 계정 **이름**을 주지 않는다(있는지 불리언만 — /ssh-keys · /accounts 와 같은 가림).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmonb2954-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const { store } = await import('../src/store.js');
store.snapshot = { ...store.get(), vcenters: [{ id: 'vcA', name: 'KR-SEL' }, { id: 'vcB', name: 'PL-WAW' }] };
const ED = await import('../src/bmusage/onboard/edgeDeploy.js');
const BMR = await import('../src/bmstor/registry.js');
const { registerBmOnboard } = await import('../src/routes/api/bmOnboard.js');

const USERS = {
  full: { username: 'full', role: 'admin', scope: null },
  wadm: { username: 'wadm', role: 'admin', scope: { vcenters: [], writeVcenters: ['vcA'] } },   // 조회 무제한 · 쓰기 vcA 만
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vcA'] } },
};

const tested = [];
async function app(t) {
  const express = (await import('express')).default;
  const router = express.Router();
  registerBmOnboard(router, { testOs: async (s) => { tested.push(s.name); return { ok: true, kind: 'fake' }; } });
  const a = express(); a.use(express.json());
  a.use((req, _r, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  a.use('/api', router);
  const srv = await new Promise((r) => { const s = a.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => srv.close());
  return async (u, method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api${p}`, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const txt = await r.text(); let j = {}; try { j = JSON.parse(txt); } catch { /* */ }
    return { s: r.status, j };
  };
}

function seedEdge() {
  const r = ED.applyEdgeChanges({ upserts: [
    { agent: 'edge-a', row: { name: 'orphan1', corp: '', osHost: '10.9.0.1', osKey: 'k-orphan', osCred: 'c-orphan' } },
    { agent: 'edge-a', row: { name: 'sel1', corp: 'vcA', idracHost: '10.9.0.2', osHost: '10.9.0.3', osKey: 'k-sel', osCred: 'shared-ops', idracCred: 'shared-idrac' } },
  ] }, { by: 'test' });
  assert.equal(r.ok, true, JSON.stringify(r));
}

test('A-1: 귀속 없는 엣지 배포 행 빼기 — 쓰기만 줄인 admin 403 · 전체 범위 admin 은 뺀다', async (t) => {
  seedEdge();
  const call = await app(t);
  const w = await call('wadm', 'DELETE', '/tools/bm-usage/onboard/edge-rows?agent=edge-a&name=orphan1');
  assert.equal(w.s, 403, `조회 무제한 + writeVcenters admin 이 귀속 없는 행을 뺐다: ${JSON.stringify(w.j)}`);
  assert.ok(ED.edgeRowsFor('edge-a').some((r) => r.name === 'orphan1'), '거부했으면 행이 남아 있어야 한다');
  const s = await call('sadm', 'DELETE', '/tools/bm-usage/onboard/edge-rows?agent=edge-a&name=orphan1');
  assert.equal(s.s, 404, '조회 범위 계정에는 귀속 없는 행이 없다(존재 은닉)');
  const f = await call('full', 'DELETE', '/tools/bm-usage/onboard/edge-rows?agent=edge-a&name=orphan1');
  assert.equal(f.s, 200, JSON.stringify(f.j));
  assert.ok(!ED.edgeRowsFor('edge-a').some((r) => r.name === 'orphan1'));
  // 귀속 행은 기존대로 쓰기 범위 — wadm 은 vcA 쓰기가 있다
  const ws = await call('wadm', 'DELETE', '/tools/bm-usage/onboard/edge-rows?agent=edge-a&name=sel1');
  assert.equal(ws.s, 200, JSON.stringify(ws.j));
});

test('A-1: 귀속 없는 서버 연결 시험 — 쓰기만 줄인 admin 403(시험 접속 없음) · 전체 범위 admin 은 시험한다', async (t) => {
  const sv = BMR.saveBmServer({ name: 'orphan-os', host: '10.60.9.9', username: 'root', mounts: ['/'] });
  assert.equal(sv.ok, true, JSON.stringify(sv));
  const id = BMR.listBmServersRaw().find((x) => x.name === 'orphan-os').id;
  assert.equal(BMR.listBmServersRaw().find((x) => x.id === id).vcenterId || '', '', '귀속 없는 서버여야 한다');
  const call = await app(t);
  tested.length = 0;
  const w = await call('wadm', 'POST', '/tools/bm-usage/onboard/test', { id });
  assert.equal(w.s, 403, `조회 무제한 + writeVcenters admin 이 귀속 없는 서버에 저장 비밀로 시험 접속했다: ${JSON.stringify(w.j)}`);
  assert.deepEqual(tested, [], '거부했으면 시험 본체가 불리지 않아야 한다');
  const s = await call('sadm', 'POST', '/tools/bm-usage/onboard/test', { id });
  assert.equal(s.s, 404);
  const f = await call('full', 'POST', '/tools/bm-usage/onboard/test', { id });
  assert.equal(f.s, 200, JSON.stringify(f.j));
  assert.deepEqual(tested, ['orphan-os']);
});

test('A-4: 엣지 배포 목록 — 범위 계정에는 키 · 공통 계정 이름 대신 있는지만 · 전체 범위는 이름', async (t) => {
  seedEdge();
  const call = await app(t);
  const s = await call('sadm', 'GET', '/tools/bm-usage/onboard/edge-rows');
  assert.equal(s.s, 200);
  const rows = s.j.agents.flatMap((a) => a.rows);
  assert.deepEqual(rows.map((r) => r.name), ['sel1'], '범위 계정은 자기 법인 행만');
  const r = rows[0];
  assert.equal(r.osKey, true, `키 이름이 범위 계정에 나갔다: ${r.osKey}`);
  assert.equal(r.osCred, true);
  assert.equal(r.idracCred, true);
  assert.ok(!JSON.stringify(s.j).includes('shared-ops') && !JSON.stringify(s.j).includes('k-sel'), '응답 어디에도 이름 원문이 없어야 한다');
  const f = await call('full', 'GET', '/tools/bm-usage/onboard/edge-rows');
  const fr = f.j.agents.flatMap((a) => a.rows).find((x) => x.name === 'sel1');
  assert.equal(fr.osKey, 'k-sel');
  assert.equal(fr.osCred, 'shared-ops');
  assert.equal(fr.idracCred, 'shared-idrac');
});
