/**
 * 70회차(인사이트 1차) — 실제 라우터 · 함수로 본다.
 *  F1 범위 계정 · vCenter 를 고른 FinOps/전력 분석: 수동 소속(fleet-assign — 통합 서버 인벤토리에서 관리자가 고른 법인)을
 *     '범위 안 vCenter' 집합으로만 검사해, 다른 법인으로 옮긴 서버가 원격 수집기 귀속(옛 법인)으로 범위 계정 · 고른 vCenter 합계에 남았다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'insights70-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'false';
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({
  vcenters: [
    { id: 'vc-a', name: 'A', host: 'a.example.invalid', username: 'u', password: 'p' },
    { id: 'vc-b', name: 'B', host: 'b.example.invalid', username: 'u', password: 'p' },
  ],
}));
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * 60_000;

const servers = [];
after(async () => {
  for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

const express = (await import('express')).default;
const { store } = await import('../src/store.js');
const { insightsRouter } = await import('../src/routes/insights.js');
const st = await import('../src/collector/state.js');
const { setFleetAssign } = await import('../src/insights/fleetAssign.js');

store.snapshot = {
  generatedAt: new Date(NOW).toISOString(), source: 'live',
  vcenters: [
    { id: 'vc-a', name: 'A', status: 'connected', location: { region: 'Asia' } },
    { id: 'vc-b', name: 'B', status: 'connected', location: { region: 'Europe' } },
  ],
  hosts: [
    { id: 'vc-a:esx-a1', vcenterId: 'vc-a', name: 'esx-a1', cluster: 'CL', connectionState: 'CONNECTED' },
    { id: 'vc-b:esx-b1', vcenterId: 'vc-b', name: 'esx-b1', cluster: 'CL', connectionState: 'CONNECTED' },
  ],
  vms: [], datastores: [], networks: [], alarms: [], collectionErrors: [],
};

const ADMIN = { username: 'adm', role: 'admin', name: 'adm', scope: null };
const SCOPED_A = { username: 'sa', role: 'admin', name: 'sa', scope: { vcenters: ['vc-a'] } };
async function serve(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { ...user }; next(); });
  app.use('/api/insights', insightsRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(srv);
  const base = `http://127.0.0.1:${srv.address().port}`;
  return async (p) => { const r = await fetch(base + p); let b = null; try { b = await r.json(); } catch { /* */ } return { status: r.status, b }; };
}

/* ── F1 ─────────────────────────────────────────────────────────────────── */
test('F1: 원격 수집 베어메탈을 관리자가 vc-b 로 옮겼으면(fleet-assign) vc-a 범위 계정 · ?vcenterId=vc-a 합계에 들지 않는다', async () => {
  // 엣지(수집 서버 edge-a)가 vc-a 로 귀속해 보고한 베어메탈 — 관리자가 통합 서버 인벤토리에서 vc-b 로 옮겼다.
  st.setRemoteHost('bm-moved', { watts: 700, ts: Date.now() - 60_000, collectorId: 'edge-a', serverName: 'bm-moved', serverId: 7, vcenterId: 'vc-a', serviceTag: 'MOVED1' });
  assert.equal(setFleetAssign('MOVED1', 'vc-b', new Set(['vc-a', 'vc-b'])).ok, true);

  const adm = await serve(ADMIN);
  const all = await adm('/api/insights/finops');
  assert.equal(all.status, 200);
  const rowB = (all.b.byVcenter || []).find((v) => v.vcId === 'vc-b');
  assert.equal(rowB?.watts, 700, `전체 보기(관리자): 수동 소속이 이긴다 — vc-b. 실제 ${JSON.stringify(all.b.byVcenter)}`);

  const pickA = await adm('/api/insights/finops?vcenterId=vc-a');
  assert.equal(pickA.b.totals.watts, null, `vc-a 를 고르면 vc-b 로 옮긴 서버는 빠진다(측정 0대 → 모름 · F2) — 실제 ${pickA.b.totals.watts}W`);
  const pbA = await adm('/api/insights/power-breakdown?vcenterId=vc-a');
  assert.equal(pbA.b.totals.watts, null, `전력 분석 vc-a — 실제 ${pbA.b.totals.watts}W ${JSON.stringify(pbA.b.servers)}`);
  const pickB = await adm('/api/insights/finops?vcenterId=vc-b');
  assert.equal(pickB.b.totals.watts, 700, '고른 vc-b 에는 든다');

  const sa = await serve(SCOPED_A);
  const fa = await sa('/api/insights/finops');
  assert.equal(fa.status, 200);
  assert.equal(fa.b.totals.watts, null, `vc-a 범위 계정에 vc-b 서버 전력이 샌다 — 실제 ${fa.b.totals.watts}W`);
  assert.ok(!(fa.b.topHosts || []).some((h) => h.host === 'bm-moved'), `서버 이름이 샌다: ${JSON.stringify(fa.b.topHosts)}`);
  const pa = await sa('/api/insights/power-breakdown');
  assert.ok(!(pa.b.servers || []).some((x) => x.name === 'bm-moved'), `전력 분석 servers 로 샌다: ${JSON.stringify(pa.b.servers)}`);
  assert.equal(pa.b.totals.watts, null);
});

test('F1(②): 등록부가 vc-b 로 귀속한 iDRAC 서버의 이름이 vc-a 호스트와 같아도 vc-a 범위 · 고른 vc-a 에 끌려오지 않는다(전체 보기는 vc-b)', async () => {
  const idracReg = await import('../src/idrac/registry.js');
  const { getDb: getPowerDb } = await import('../src/idrac/db.js');
  assert.equal(idracReg.addServer({ id: 'idr-x', name: 'esx-a1', host: 'https://10.99.70.9', username: 'root', password: 'pw', vcenterId: 'vc-b', hostNames: ['esx-a1'], enabled: true }).ok, true);
  (await getPowerDb()).insert('idr-x', 450, Date.now() - 60_000);

  const adm = await serve(ADMIN);
  const all = await adm('/api/insights/finops');
  const inB = (all.b.topHosts || []).find((h) => h.host === 'esx-a1');
  assert.equal(inB?.vcenterId, 'vc-b', `전체 보기: 등록부 귀속(vc-b) — 실제 ${JSON.stringify(all.b.topHosts)}`);
  const pickA = await adm('/api/insights/finops?vcenterId=vc-a');
  assert.ok(!(pickA.b.topHosts || []).some((h) => h.host === 'esx-a1'), `고른 vc-a 에 vc-b 서버가 이름 맞춤으로 들어왔다: ${JSON.stringify(pickA.b.topHosts)}`);
  const pbA = await adm('/api/insights/power-breakdown?vcenterId=vc-a');
  assert.ok(!(pbA.b.servers || []).some((x) => x.name === 'esx-a1'), JSON.stringify(pbA.b.servers));

  const sa = await serve(SCOPED_A);
  const fa = await sa('/api/insights/finops');
  assert.ok(!(fa.b.topHosts || []).some((h) => h.host === 'esx-a1'), `vc-a 범위 계정에 vc-b 서버가 샌다: ${JSON.stringify(fa.b.topHosts)}`);
  const pa = await sa('/api/insights/power-breakdown');
  assert.ok(!(pa.b.servers || []).some((x) => x.name === 'esx-a1'), JSON.stringify(pa.b.servers));
});

test('F1: 소스 계약 — 두 라우트가 measuredForSlice 하나를 쓰고, 조각 vCenter 집합(validIds)을 applyFleetAssign 에 넘기지 않는다', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fs.readFileSync(new URL('../src/routes/insights.js', import.meta.url), 'utf8'));
  assert.equal((src.match(/measuredForSlice\(await allMeasuredPower/g) || []).length, 2);
  assert.doesNotMatch(src, /applyFleetAssign\([^)]*\)\s*,\s*validIds\)/);
});

/* ── F2 ─────────────────────────────────────────────────────────────────── */
test("F2: 측정한 서버가 0대면 FinOps · 전력 분석 합계는 '모름'(null) — 0 W · ₩0 · 0 kg 이 아니다 · 한 대라도 있으면 수", async () => {
  const { computeFinOps } = await import('../src/insights/finops.js');
  const { computePowerBreakdown } = await import('../src/insights/powerBreakdown.js');
  const snap = store.get();
  const cfg = { tariffPerKwh: 100, currency: '₩', co2KgPerKwh: 0.5, pue: 1.5 };
  const f0 = computeFinOps(snap, [], cfg);
  assert.equal(f0.measuredHosts, 0);
  for (const [k, v] of Object.entries(f0.totals)) assert.equal(v, null, `FinOps totals.${k} — 실제 ${v}`);
  assert.deepEqual(Object.keys(f0.totals).sort(), ['co2MonthKg', 'co2YearKg', 'costDay', 'costMonth', 'costYear', 'facilityWatts', 'kwhDay', 'kwhMonth', 'kwhYear', 'watts'], '키는 그대로(화면이 필드를 읽는다)');
  const f1 = computeFinOps(snap, [{ serverName: 'x', host: 'esx-a1', watts: 100 }], cfg);
  assert.equal(f1.totals.watts, 100);
  assert.equal(f1.totals.facilityWatts, 150);
  const zero = computeFinOps(snap, [{ serverName: 'z', host: 'esx-a1', watts: 0 }], cfg);
  assert.equal(zero.totals.watts, 0, '측정한 0 W 는 값이다');
  const p0 = computePowerBreakdown(snap, []);
  for (const [k, v] of Object.entries(p0.totals)) assert.equal(v, null, `전력 분석 totals.${k} — 실제 ${v}`);
  const p1 = computePowerBreakdown(snap, [{ serverName: 'x', host: 'esx-a1', watts: 200 }]);
  assert.equal(p1.totals.watts, 200);
});

/* ── F3 ─────────────────────────────────────────────────────────────────── */
test('F3: 토폴로지 · 3D 구성도에서 vCenter 하나를 고르면 고르기 목록(vcenters)이 그 하나로 줄지 않는다 — 범위 안 vCenter 전부 · 범위 밖은 여전히 없음', async () => {
  const adm = await serve(ADMIN);
  for (const p of ['/api/insights/topology?vcenterId=vc-a', '/api/insights/graph?vcenterId=vc-a']) {
    const r = await adm(p);
    assert.equal(r.status, 200);
    assert.deepEqual((r.b.vcenters || []).map((v) => v.id).sort(), ['vc-a', 'vc-b'], `${p} — 다른 vCenter 로 바로 옮길 수 없다: ${JSON.stringify(r.b.vcenters)}`);
  }
  const t = await adm('/api/insights/topology?vcenterId=vc-a');
  assert.deepEqual(t.b.tree.map((n) => n.id), ['vc-a'], '트리는 고른 vCenter 만(그대로)');
  const sa = await serve(SCOPED_A);
  for (const p of ['/api/insights/topology', '/api/insights/topology?vcenterId=vc-a', '/api/insights/graph?vcenterId=vc-a', '/api/insights/topology?vcenterId=vc-b']) {
    const r = await sa(p);
    assert.equal(r.status, 200);
    assert.deepEqual((r.b.vcenters || []).map((v) => v.id), ['vc-a'], `${p} — 범위 계정 목록은 범위 안만: ${JSON.stringify(r.b.vcenters)}`);
  }
});
