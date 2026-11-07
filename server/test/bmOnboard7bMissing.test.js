/**
 * 7b단계 누락 점검 · 연결 시험 · 수집 건강 RTT —
 *  · 누락 점검 칸은 보드 커버리지 값(entry.coverage) 그대로 · 수집 기록이 없으면 unknown(없음 아님) · 미귀속 · 엣지 서버는 엣지 봉투 coverage · 제안은 OS 만/iDRAC 만에만(자동 등록 없음)
 *  · 연결 시험: 요청은 id 만(주소를 바꿀 수 없다) · 키 해석 실패는 접속하지 않음 · 범위 404/403
 *  · 수집 건강: 중앙 직접 법인 RTT 800ms+ 경고 · 모르면 null(정상으로 보이지 않는다)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm7bmiss-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const { missingCheck } = await import('../src/bmusage/onboard/missing.js');

test('① 누락 점검 — 보드 커버리지 값 그대로 · 기록 없음은 unknown · 미귀속 · 엣지 봉투 · 사유 있는 제외는 none · 제안은 OS 만 / iDRAC 만', () => {
  const targets = [
    { key: 'K1', name: 'a1.corp.example', vcenterId: 'vcA', paths: ['idrac'], idrac: { host: 'https://10.0.0.1' } },
    { key: 'K2', name: 'a2', vcenterId: 'vcA', paths: ['os', 'idrac'] },
    { key: 'K3', name: 'a3', vcenterId: 'vcA', paths: ['os'] },
  ];
  const skipped = [{ key: 'K4', name: 'u1', reason: 'unassigned' }, { key: 'K5', name: 'e1', reason: 'edge-delegated', agent: 'Edge-A', vcenterId: 'vcE' }, { key: 'K6', name: 'n1', reason: 'no-os-cred', vcenterId: 'vcA' }, { key: 'K7', name: 'e2', reason: 'edge-delegated', agent: 'Edge-A', vcenterId: 'vcE' }];
  const entryByKey = new Map([['K1', { coverage: 'idrac' }], ['K2', { coverage: 'both' }]]);
  const m = missingCheck({ targets, skipped, entryByKey, edgeEntry: (a, k) => (k === 'K5' ? { coverage: 'os' } : null), vcName: (v) => `name-${v}` });
  const by = Object.fromEntries(m.rows.map((r) => [r.key, r]));
  assert.equal(by.K1.bucket, 'idrac'); assert.equal(by.K2.bucket, 'both');
  assert.equal(by.K3.bucket, 'unknown', '수집 기록이 없으면 없음(none)이 아니라 모름'); assert.equal(by.K3.reason, 'no-record');
  assert.equal(by.K4.bucket, 'unassigned');
  assert.equal(by.K5.bucket, 'os'); assert.equal(by.K5.via, 'edge');
  assert.equal(by.K7.bucket, 'unknown', '엣지 보관분이 없으면 모름');
  assert.equal(by.K6.bucket, 'none'); assert.equal(by.K6.reason, 'no-os-cred');
  assert.deepEqual(m.counts, { both: 1, os: 1, idrac: 1, none: 1, unassigned: 1, unknown: 2 });
  assert.deepEqual(by.K1.suggest, { name: 'a1.corp.example', corp: 'name-vcA', service_tag: '', os_host: 'a1.corp.example', idrac_host: '10.0.0.1', collect_via: 'auto' }, 'FQDN 이름만 OS 주소로 제안');
  assert.equal(by.K5.suggest.collect_via, 'edge');
  assert.equal(by.K2.suggest, undefined); assert.equal(by.K3.suggest, undefined);
  const ip = missingCheck({ targets: [{ key: 'X', name: '10.1.2.3', vcenterId: 'vcA' }], entryByKey: new Map([['X', { coverage: 'idrac' }]]) });
  assert.equal(ip.rows[0].suggest.os_host, undefined, 'IP 이름은 OS 주소로 제안하지 않는다');
});

test('② 연결 시험 — 키 해석 실패 · 인증 수단 없음은 접속하지 않는다 · 라우트는 id 만 받고 범위 404/403', async (t) => {
  const BM = await import('../src/bmstor/registry.js');
  const { testSavedOs } = await import('../src/routes/api/bmOnboard.js');
  const a = BM.saveBmServer({ name: 'k1', host: '10.70.0.1', username: 'mon', mounts: ['/'], keyRef: 'k_000000000000', vcenterId: 'vcA' });
  const b = BM.saveBmServer({ name: 'k2', host: '10.70.0.2', username: 'mon', mounts: ['/'], vcenterId: 'vcB' });
  const r1 = await testSavedOs(BM.listBmServersRaw().find((x) => x.id === a.server.id));
  assert.equal(r1.kind, 'auth-unresolved'); assert.match(r1.reason, /키 저장소에 없습니다/);
  const r2 = await testSavedOs(BM.listBmServersRaw().find((x) => x.id === b.server.id));
  assert.equal(r2.kind, 'no-secret');
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { store } = await import('../src/store.js');
  store.snapshot = { ...store.get(), vcenters: [{ id: 'vcA', name: 'A' }, { id: 'vcB', name: 'B' }] };
  const USERS = { adm: { username: 'adm', role: 'admin', scope: null }, sa: { username: 'sa', role: 'admin', scope: { vcenters: ['vcA'] } }, ro: { username: 'ro', role: 'admin', scope: { vcenters: ['vcA', 'vcB'], writeVcenters: ['vcA'] } } };
  const app = express(); app.use(express.json());
  app.use((req, _r, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => srv.close());
  const call = async (u, body) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/tools/bm-usage/onboard/test`, { method: 'POST', headers: { 'x-u': u, 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { s: r.status, j: await r.json() }; };
  assert.equal((await call('sa', { id: b.server.id })).s, 404, '조회 밖 = 없는 서버');
  assert.equal((await call('ro', { id: b.server.id })).s, 403, '조회는 되지만 쓰기 밖');
  const ok = await call('adm', { id: a.server.id, host: '203.0.113.9' });
  assert.equal(ok.s, 200); assert.equal(ok.j.kind, 'auth-unresolved', '요청의 host 는 무시(저장 항목으로만)');
});

test('③ 수집 건강 — 중앙 직접 법인 RTT 800ms+ 경고 · 핑 값이 없으면 null(정상 아님) · 엣지 행에는 싣지 않는다', async () => {
  const { bmCollectHealthView, RTT_WARN_MS } = await import('../src/routes/api/bmCollectHealth.js');
  assert.equal(RTT_WARN_MS, 800);
  const health = { node: { cycleMs: 1000, budgetMs: 300000, cyclePct: 1, conc: null, ssh: null, db: null, reasons: [] }, byCorp: { vcA: { servers: 2, ok: 2, fail: 0, reasons: {} }, vcP: { servers: 1, ok: 1, fail: 0, reasons: {} }, vcN: { servers: 1, ok: 1, fail: 0, reasons: {} } } };
  const deps = { localHealth: async () => health, localEnabled: async () => true, localCorps: async () => ['vcA', 'vcP', 'vcN'], localTrend: async () => [], listEdgeBmUsage: async () => [],
    rttOf: async () => (vc) => (vc === 'vcA' ? { rttMs: 35, at: 1 } : vc === 'vcP' ? { rttMs: 912, at: 1 } : null) };
  const v = await bmCollectHealthView({ user: { username: 'adm', role: 'admin', scope: null } }, {}, deps);
  const by = Object.fromEntries(v.rows.map((r) => [r.vcenterId, r]));
  assert.equal(by.vcA.rttHigh, false); assert.equal(by.vcA.rttMs, 35);
  assert.equal(by.vcP.rttHigh, true); assert.equal(by.vcP.rttMs, 912);
  assert.equal(by.vcN.rttHigh, null, '모르면 null'); assert.equal(by.vcN.rttMs, null);
});
