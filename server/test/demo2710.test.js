/**
 * v2.710 데모(mock) 3차 점검 — 전수 화면 조사(상단 탭 11 · 설정 51 · 특수 기능 100)에서 찾은 것.
 * 고정:
 *  ① 제품 결함 — /tools/report/capacity 가 async forecastCapacity 를 await 없이 펼쳐 `{listLimit…}` 만 나가던 것
 *     (v2.537~, 모든 모드에서 '추세 산출 0개 · 관측 undefined일'). 실제 라우터로 응답 모양을 본다.
 *  ② 데모 합성 추세는 실제 추세가 하나도 없을 때만 · R² 를 지어내지 않는다 · 실제 행이 있으면 건드리지 않는다.
 *  ③ iDRAC 스캔 로그 데모 — 법인 할당 뒤 · 비어 있을 때만 · 과거 14일 · 위임은 dispatch/result 짝.
 *  ④ 태그 정책 데모 — 파일이 없고 mock 일 때만 데모 정책(demo:true) · 저장하면 그 값이 이긴다 · mock 이 아니면 비어 있다.
 *  ⑤ VM DNS 변경 이력 데모 — 변경 행의 '바뀐 뒤' 는 지금 실제 값이라 다음 주기가 다른 변경으로 읽지 않는다.
 *  ⑥ 로그 폴러의 데모 첫 수집 기간은 가용성 화면의 가장 긴 보기(90일)를 덮는다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'demo2710-'));
process.env.CONFIG_DIR = TMP;
process.env.DB_DIR = TMP;
process.env.DATA_SOURCE = 'mock';

const { setDataSource } = await import('../src/runtime-settings.js');
const ADMIN = { username: 'adm', role: 'admin', scope: {} };

async function call(mount, router, user, url) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(mount, router);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}${mount}${url}`);
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally { srv.close(); }
}

test('① /tools/report/capacity 는 예측 결과 전체를 돌려준다(Promise 를 펼치지 않는다)', async () => {
  const { store } = await import('../src/store.js');
  await store.refresh().catch(() => {});
  const { api } = await import('../src/routes/api.js');
  const r = await call('/api', api, ADMIN, '/tools/report/capacity?days=14');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.config && r.body.config.days === 14, `config.days 가 있어야 한다: ${JSON.stringify(r.body).slice(0, 200)}`);
  assert.equal(typeof r.body.scannedDatastores, 'number');
  assert.ok(Array.isArray(r.body.datastores) && Array.isArray(r.body.soon));
  // mock 스냅샷 + 롤업 이력 없음 → 데모 합성 행이 채워지고 그 사실을 밝힌다
  assert.equal(r.body.synthesized, true);
  assert.ok(r.body.datastores.length > 0 && r.body.datastores.every((d) => d.synthesized === true && d.r2 === null));
});

test('② 데모 합성 추세 — 실제 행이 있으면 그대로 · 정렬 · 범위 필터', async () => {
  const { withDemoForecast } = await import('../src/routes/api/reports.js');
  const snap = { datastores: [
    { id: 'a', name: 'A', vcenterId: 'vc1', capacityGB: 1000, usedGB: 990, usagePct: 99 },
    { id: 'b', name: 'B', vcenterId: 'vc2', capacityGB: 1000, usedGB: 100, usagePct: 10 },
    { id: 'c', name: 'C', vcenterId: 'vc1', capacityGB: 0, usedGB: 0 },          // 용량 0 → 제외
    { id: 'd', name: 'D', vcenterId: 'vc1', capacityGB: 500, usedGB: null },      // 사용량 모름 → 제외
  ] };
  const real = { datastores: [{ id: 'x', r2: 0.9 }], soon: [] };
  assert.equal(withDemoForecast(real, snap), real, '실제 추세가 있으면 손대지 않는다');
  const r = withDemoForecast({ datastores: [], soon: [] }, snap);
  assert.deepEqual(r.datastores.map((d) => d.id), ['a', 'b']);
  assert.ok(r.datastores[0].daysToLimit <= r.datastores[1].daysToLimit);
  assert.equal(r.soon.length, r.datastores.filter((d) => d.daysToLimit <= 30).length);
  const onlyVc2 = withDemoForecast({ datastores: [], soon: [] }, snap, 'vc2');
  assert.deepEqual(onlyVc2.datastores.map((d) => d.id), ['b']);
});

test('③ iDRAC 스캔 로그 데모 — 법인 할당 뒤 · 비었을 때만 · 과거 14일 · 위임 짝', async () => {
  const idrac = await import('../src/mock/demo/idrac.js');
  const log = await import('../src/idrac/scanLog.js');
  const dcs = await import('../src/datacenter/store.js');
  const SNAP = { vcenters: [{ id: 'vc-ap-northeast' }, { id: 'vc-eu-west' }] };
  idrac._resetIdracDemoForTest();
  assert.equal((await idrac.ensureScanLogDemo(SNAP)).skipped, 'no-corp-yet');
  dcs.ensureDatacenter({ id: 'dc-s1', name: 'S1' });
  dcs.ensureDatacenter({ id: 'dc-s2', name: 'S2' });
  dcs.setVcenterDatacenterMany([{ vcenterId: 'vc-ap-northeast', datacenterId: 'dc-s1' }, { vcenterId: 'vc-eu-west', datacenterId: 'dc-s2' }]);
  const now = Date.now();
  const r = await idrac.ensureScanLogDemo(SNAP, now);
  assert.ok(r.added > 0);
  const rows = log.listIdracScanLog({ limit: 1000 }).rows || log.listIdracScanLog({ limit: 1000 });
  const list = Array.isArray(rows) ? rows : rows.entries;
  assert.equal(list.length, r.added);
  assert.ok(list.every((e) => e.at < now && e.at > now - 16 * 86_400_000), '과거 14일 안');
  assert.ok(list.every((e) => e.datacenterId === 'dc-s1' || e.datacenterId === 'dc-s2'), '법인 칸은 할당된 DataCenter');
  // vc-ap-northeast·vc-eu-west 는 데모 엣지 위임 → dispatch/result 가 같은 reqId 로 짝
  const disp = list.filter((e) => e.phase === 'dispatch');
  assert.ok(disp.length > 0);
  for (const d of disp) assert.ok(list.some((e) => e.phase === 'result' && e.reqId === d.reqId && e.at > d.at), '회신이 위임보다 뒤');
  // 다시 불러도 늘지 않는다(기록이 있으면 건드리지 않는다)
  idrac._resetIdracDemoForTest();
  assert.equal((await idrac.ensureScanLogDemo(SNAP, now)).added, 0);
  setDataSource('live');
  try { idrac._resetIdracDemoForTest(); assert.ok((await idrac.ensureScanLogDemo(SNAP, now)).skipped); } finally { setDataSource('mock'); }
});

test('④ 태그 정책 데모 — 파일이 없고 mock 일 때만, 저장하면 그 값이 이긴다', async () => {
  const pol = await import('../src/tags/policy.js');
  pol._resetTagPolicy();
  const d = pol.loadTagPolicy();
  assert.equal(d.demo, true);
  assert.deepEqual(d.requiredCategories, ['Environment', 'Owner-Team', 'Corp']);
  setDataSource('live');
  try { pol._resetTagPolicy(); const l = pol.loadTagPolicy(); assert.deepEqual(l.requiredCategories, []); assert.notEqual(l.demo, true); } finally { setDataSource('mock'); }
  pol._resetTagPolicy();
  const s = pol.saveTagPolicy({ requiredCategories: ['Backup'], corpCategory: '' }, 'adm');
  assert.equal(s.ok, true);
  pol._resetTagPolicy();
  const after = pol.loadTagPolicy();
  assert.deepEqual(after.requiredCategories, ['Backup']);
  assert.notEqual(after.demo, true, '저장한 뒤에는 데모 정책이 아니다');
});

test('⑤ VM DNS 변경 이력 데모 — 바뀐 뒤는 지금 값, 다음 주기는 변경을 만들지 않는다', async () => {
  const { generateSnapshot } = await import('../src/mock/generator.js');
  const poller = await import('../src/vmdns/poller.js');
  const db = await import('../src/vmdns/db.js');
  const { effectiveServers } = await import('../src/vmdns/analyze.js');
  const snap = generateSnapshot();
  const now = Date.now();
  const first = await poller.runVmDnsHistoryOnce({ snap, now });
  assert.equal(first.ok, true);
  const ch = (await db.listChanges({ since: 0, limit: 500 })).changes.filter((c) => !c.first);
  assert.ok(ch.length > 0, '데모 변경 행이 생긴다');
  const byId = new Map(snap.vms.map((v) => [String(v.id), v]));
  for (const c of ch) {
    assert.ok(c.ts < now, '과거 시각');
    assert.deepEqual(c.after, effectiveServers(byId.get(c.vmId)), '바뀐 뒤 = 지금 값');
    assert.notDeepEqual(c.before, c.after);
  }
  const second = await poller.runVmDnsHistoryOnce({ snap, now: now + 60_000 });
  assert.equal(second.changed, 0, '다음 주기는 데모 행을 다른 변경으로 읽지 않는다');
  const { history } = await db.vmHistory(ch[0].vmId);
  const firstObs = history.find((h) => h.first);
  const changeRow = history.find((h) => !h.first);
  assert.ok(firstObs && changeRow);
  assert.ok(firstObs.ts < changeRow.ts, '첫 관측이 데모 변경보다 앞선다(첫 관측이 늦게 보이지 않게)');
  assert.deepEqual(firstObs.after, changeRow.before, '첫 관측 값 = 바뀌기 전 값');
});

test('⑥ 로그 폴러 데모 첫 수집은 90일 보기를 덮는다', async () => {
  const { MOCK_FIRST_DAYS } = await import('../src/logs/poller.js');
  assert.ok(MOCK_FIRST_DAYS > 90);
});
