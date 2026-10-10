// v2.733 점검 3회차 그룹 d — 데이터 정직성(C2-01·C2-02·C2-06).
//   C2-01 NSX: live·auto 모드 + 매니저 등록 0 이면 데모 매니저 3대를 source='live' 로 싣던 것 → 합성은 mock 모드에서만.
//   C2-02 전력: 읽지 못한 vCenter(LASTGOOD 이월·낡은 위임·점검중)·끊긴 호스트의 vCenter 추정 전력을 ts=now 로 적재·합산하던 것.
//   C2-06 용량: REST 폴백 vCenter 호스트의 코어·CPU·메모리 용량이 0 으로 합계·비율에 들어가던 것(DS capacity||0 포함).
// 원칙: 실제 함수·라우터를 불러 값으로 판정한다(소스 grep 이 아니다). 못 읽은 것을 0·지금·정상으로 만들지 않는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2733d-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'live';
// 가짜 HTTPS vCenter(REST 폴백)는 openssl 자체서명이다 — 장비 인증서 정책을 observe 로(이 테스트가 보는 것은 TLS 가 아니다).
process.env.TLS_PEER_POLICY = 'observe';
process.env.SSRF_ALLOW_LOOPBACK = 'true';

after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const listen = (srv) => new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv.address().port)));
const json = (r, o, s = 200) => { r.writeHead(s, { 'content-type': 'application/json' }); r.end(JSON.stringify(o)); };

/* ── 공통 픽스처 ──────────────────────────────────────────────────────────── */
const host = (vc, name, w, extra = {}) => ({
  id: `${vc}:${name}`, vcenterId: vc, name, cluster: 'CL', connectionState: 'CONNECTED', powerWatts: w,
  cpuCores: 16, cpuTotalMhz: 32_000, memTotalMB: 262_144, cpuUsageMhz: 1_000, memUsageMB: 1_000, ...extra,
});
let _gen = 0;
/** 읽힌 vCenter 1개(vc-a) + 읽지 못한 vCenter 3개(연결 실패 이월·점검중·낡은 위임) + vc-a 의 끊긴 호스트 1대. */
function powerSnap() {
  _gen += 1;
  return {
    generatedAt: new Date(Date.UTC(2026, 0, 5, 3, 30, _gen)).toISOString(),
    vcenters: [
      { id: 'vc-a', name: 'A', status: 'connected', location: { region: 'Asia' } },
      { id: 'vc-b', name: 'B', status: 'unreachable', stale: true, location: { region: 'Asia' } },
      { id: 'vc-c', name: 'C', status: 'maintenance', location: { region: 'Asia' } },
      { id: 'vc-d', name: 'D', status: 'connected', collectSource: 'site', stale: true, location: { region: 'Asia' } },
    ],
    hosts: [
      host('vc-a', 'esx-a1', 400),
      host('vc-a', 'esx-a2', 300, { connectionState: 'DISCONNECTED' }),
      host('vc-b', 'esx-b1', 900),
      host('vc-c', 'esx-c1', 500),
      host('vc-d', 'esx-d1', 700),
    ],
    vms: [], datastores: [], networks: [], alarms: [],
  };
}
const ALL_VC = new Set(['vc-a', 'vc-b', 'vc-c', 'vc-d']);
const vcEntries = (list) => list.filter((m) => m.source === 'vcenter').map((m) => m.serverId).sort();

/* ── C2-01 NSX ────────────────────────────────────────────────────────────── */
test('C2-01: live·auto + NSX 매니저 등록 0 → 빈 스냅샷(데모 매니저를 지어내지 않는다) · mock 은 데모 3대', async () => {
  const { setDataSource } = await import('../src/runtime-settings.js');
  const { nsxStore } = await import('../src/nsx/store.js');
  for (const ds of ['live', 'auto']) {
    assert.equal(setDataSource(ds).ok, true);
    await nsxStore.refresh();
    const s = nsxStore.get();
    assert.equal(s.source, ds);
    assert.deepEqual(s.managers, [], `${ds}: 등록 0 이면 매니저가 없다(데모 nsx-seoul 등을 싣지 않는다)`);
    assert.equal(s.segments.length, 0);
    assert.equal(s.dfw.length, 0);
    assert.equal(s.rollup.managers, 0, `${ds}: rollup 모양은 그대로(managers 0)`);
  }
  // 서비스 점검 'NSX 매니저 미등록'(off)이 다시 도달한다 — 예전에는 데모 3대 때문에 '정상 · 매니저 3' 이었다.
  const { getServiceCheck } = await import('../src/health/services.js');
  const row = getServiceCheck().checks.find((c) => c.key === 'nsx');
  assert.equal(row?.status, 'off', JSON.stringify(row));
  assert.match(row.detail, /미등록/);
  // mock 은 예전대로 데모 3대(데모 규칙 — 합성은 mock 모드에서만).
  setDataSource('mock');
  await nsxStore.refresh();
  const m = nsxStore.get();
  assert.equal(m.source, 'mock');
  assert.equal(m.managers.length, 3);
  assert.ok(m.rollup.managers === 3 && m.rollup.segments > 0);
  setDataSource('live');
});

/* ── C2-02 전력 ───────────────────────────────────────────────────────────── */
test('C2-02: 판정 본체는 leaf 하나 — metrics/sampler.js 의 unreadVcenterReasons 와 결과가 같다', async () => {
  const leaf = await import('../src/metrics/unreadVcenters.js');
  const sampler = await import('../src/metrics/sampler.js');
  const cases = [
    powerSnap(),
    { vcenters: [{ id: 'x', status: 'pending' }, { id: 'y', maintenance: true, status: 'connected' }, { id: 7, status: 'unreachable' }, null, { status: 'unreachable' }] },
    { vcenters: [] }, {}, null,
  ];
  for (const s of cases) assert.deepEqual([...leaf.unreadVcenterReasons(s)], [...sampler.unreadVcenterReasons(s)]);
  assert.deepEqual([...leaf.unreadVcenterReasons(powerSnap())], [['vc-b', 'unreachable'], ['vc-c', 'maintenance'], ['vc-d', 'stale']]);
});

test('C2-02: allMeasuredPower 는 읽지 못한 vCenter·끊긴 호스트의 vCenter 추정 전력을 넣지 않는다(판정 입력을 주면)', async () => {
  const { allMeasuredPower, vcPowerSkipReason, vcPowerSkippedOf } = await import('../src/idrac/service.js');
  const { unreadVcenterReasons } = await import('../src/metrics/unreadVcenters.js');
  const { usageReadable } = await import('../src/store.js');
  const snap = powerSnap();
  const skip = { unread: unreadVcenterReasons(snap), hostReadable: usageReadable };
  const m = await allMeasuredPower({ hosts: snap.hosts, vcenterFirst: true, ...skip });
  assert.deepEqual(vcEntries(m), ['vc:vc-a:esx-a1'], '연결된 vCenter 의 연결된 호스트만 지금 값이다');
  assert.equal(m.find((e) => e.serverId === 'vc:vc-a:esx-a1').watts, 400);
  // 판정 입력이 없으면 예전 그대로(호출부가 넘긴다 — 다른 호출부의 동작을 몰래 바꾸지 않는다).
  const legacy = await allMeasuredPower({ hosts: snap.hosts, vcenterFirst: true });
  assert.equal(vcEntries(legacy).length, 5);
  // 사유·개수
  assert.equal(vcPowerSkipReason(snap.hosts[2], skip), 'unreachable');
  assert.equal(vcPowerSkipReason(snap.hosts[1], skip), 'host-unread');
  assert.equal(vcPowerSkipReason(snap.hosts[0], skip), null);
  const sk = vcPowerSkippedOf(snap.hosts, skip);
  assert.deepEqual(sk, { hosts: 4, vcenters: 4, byReason: { 'host-unread': 1, unreachable: 1, maintenance: 1, stale: 1 } });
  // 전력 값이 없던 호스트는 '뺀 것' 이 아니다
  assert.equal(vcPowerSkippedOf([host('vc-b', 'nopower', null)], skip).hosts, 0);
});

test('C2-02: store 오버레이 — 전력 DB 에 적재하지 않고 measuredPower·롤업 합계에서 빼며 개수를 밝힌다', async () => {
  const { overlayIdracPower, scopedRollups } = await import('../src/store.js');
  const { getDb } = await import('../src/idrac/db.js');
  const snap = powerSnap();
  await overlayIdracPower(snap);
  const mp = snap.measuredPower;
  assert.ok(mp, 'measuredPower 가 만들어진다');
  assert.equal(mp.totalWatts, 400, `합계는 지금 값만(예전 2,800W) — 실제 ${mp.totalWatts}`);
  assert.equal(mp.servers, 1);
  assert.deepEqual(mp.vcPowerSkipped, { hosts: 4, vcenters: 4, byReason: { 'host-unread': 1, unreachable: 1, maintenance: 1, stale: 1 } });
  // 전력 DB(+ power_hourly 롤업)에 몇 시간 전 값을 ts=now 로 적재하지 않는다.
  const latest = (await getDb()).latestAll();
  assert.ok(latest.has('vc:vc-a:esx-a1'), '읽은 호스트는 적재한다');
  for (const k of ['vc:vc-a:esx-a2', 'vc:vc-b:esx-b1', 'vc:vc-c:esx-c1', 'vc:vc-d:esx-d1']) assert.equal(latest.has(k), false, `${k} 를 적재하지 않는다`);
  // 롤업(범위 재계산 경로) — powerKw 와 뺀 개수
  const g = scopedRollups(snap, ALL_VC).global;
  assert.equal(g.powerKw, 0.4);
  assert.equal(g.vcPowerSkipped.hosts, 4);
  // vCenter 별 — 읽지 못한 vCenter 는 0 kW 가 아니라 모른다(측정 대수 0)
  const site = (id) => scopedRollups(snap, ALL_VC).sites.find((s) => s.id === id).metrics;
  assert.equal(site('vc-a').powerKw, 0.4);
  assert.equal(site('vc-b').powerKw, null);
  // 측정 전력이 없을 때의 폴백 합계(호스트 powerWatts)도 같은 판정
  const bare = powerSnap();
  const fb = scopedRollups(bare, ALL_VC).global;
  assert.equal(fb.powerWatts, 400, `폴백 합계 — 실제 ${fb.powerWatts}`);
  assert.equal(fb.powerReporting, 1);
});

test('C2-02: /insights/finops·/power-breakdown 실제 라우터 — 합계에서 빼고 vcPowerSkipped 로 밝힌다', async () => {
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { insightsRouter } = await import('../src/routes/insights.js');
  store.snapshot = powerSnap();
  const app = express();
  app.use((req, _res, next) => { req.user = { username: 'admin', role: 'admin', scope: null }; next(); });
  app.use('/api/insights', insightsRouter);
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  try {
    const base = `http://127.0.0.1:${srv.address().port}/api/insights`;
    const f = await (await fetch(`${base}/finops`)).json();
    assert.equal(f.totals.watts, 400, `FinOps 합계(예전 2,800W 에 몇 시간 전 값 포함) — 실제 ${f.totals.watts}`);
    assert.equal(f.measuredHosts, 1);
    assert.equal(f.vcPowerSkipped.hosts, 4);
    assert.equal(f.vcPowerSkipped.byReason.unreachable, 1);
    const p = await (await fetch(`${base}/power-breakdown`)).json();
    assert.equal(p.totals.watts, 400);
    assert.equal(p.vcPowerSkipped.hosts, 4);
  } finally { srv.close(); }
});

test('C2-02: 통합 서버 인벤토리 — 읽지 못한 vCenter 호스트의 전력 칸은 null + 사유, 분류는 그대로', async () => {
  const { getFleetInventory } = await import('../src/insights/fleetInventory.js');
  const snap = powerSnap();
  const inv = await getFleetInventory(snap);
  const row = (n) => inv.virtualizationHosts.find((h) => h.name === n);
  assert.equal(inv.virtualizationHosts.length, 5, '분류(가상화 호스트 5대)는 바뀌지 않는다');
  assert.equal(row('esx-a1').watts, 400);
  assert.equal(row('esx-b1').watts, null, '몇 시간 전 값을 지금 W 로 보이지 않는다');
  assert.equal(row('esx-b1').powerUnread, 'unreachable');
  assert.equal(row('esx-d1').powerUnread, 'stale');
  assert.equal(row('esx-a2').powerUnread, 'host-unread');
  assert.equal(row('esx-a1').powerUnread, undefined);
  assert.equal(inv.summary.vcPowerSkipped.hosts, 4);
  assert.equal(snap.hosts[2].powerWatts, 900, '입력 스냅샷을 바꾸지 않는다(사본)');
});

/* ── C2-06 용량 ───────────────────────────────────────────────────────────── */
let _tls = null;
function tlsOpts() {
  if (_tls) return _tls;
  const dir = path.join(TMP, 'tls');
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  _tls = { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
  return _tls;
}

test('C2-06: REST 폴백 — 호스트 용량은 null + restUnknown hostCapacity, capacity 없는 DS 는 capacityGB null(0 GB 아님)', async () => {
  const GB = 1024 ** 3;
  const srv = https.createServer(tlsOpts(), (q, r) => {
    const u = q.url;
    if (u === '/api/session') return q.method === 'DELETE' ? json(r, {}) : json(r, 'tok');
    if (u === '/api/vcenter/host') return json(r, [{ host: 'host-1', name: 'esx1', connection_state: 'CONNECTED', power_state: 'POWERED_ON' }]);
    if (u === '/api/vcenter/vm') return json(r, [{ vm: 'vm-1', name: 'v1', power_state: 'POWERED_ON', cpu_count: 4, memory_size_MiB: 8192 }]);
    if (u === '/api/vcenter/datastore') return json(r, [
      { datastore: 'ds-1', name: 'ok', type: 'VMFS', capacity: 100 * GB, free_space: 40 * GB },
      { datastore: 'ds-2', name: 'gone', type: 'NFS' },   // 접근 불가 DS — capacity·free_space 가 빠진다
    ]);
    if (u === '/api/vcenter/cluster') return json(r, []);
    if (u === '/api/vcenter/network') return json(r, []);
    return json(r, {}, 404);
  });
  const port = await listen(srv);
  try {
    const { config } = await import('../src/config.js');
    const prev = config.vcSoapMetrics;
    config.vcSoapMetrics = false;
    try {
      const { collectFromVCenter } = await import('../src/vcenter/restClient.js');
      const s = await collectFromVCenter({ id: 'vc-r', name: 'R', host: `https://127.0.0.1:${port}`, username: 'u', password: 'p' });
      const h = s.hosts[0];
      assert.equal(h.cpuCores, null); assert.equal(h.cpuTotalMhz, null); assert.equal(h.memTotalMB, null);
      assert.ok(s.vcenter.restUnknown.includes('hostCapacity'), JSON.stringify(s.vcenter.restUnknown));
      assert.ok(s.vcenter.restUnknown.includes('dsCapacity'));
      const ok = s.datastores.find((d) => d.name === 'ok');
      assert.deepEqual([ok.capacityGB, ok.freeGB, ok.usedGB, ok.usagePct], [100, 40, 60, 60], '용량을 읽은 DS 는 예전 그대로');
      const gone = s.datastores.find((d) => d.name === 'gone');
      assert.equal(gone.capacityGB, null, "capacity 가 없으면 '0 GB' 가 아니라 모른다");
      assert.equal(gone.usedGB, null); assert.equal(gone.freeGB, null); assert.equal(gone.usagePct, null);
      // 롤업: 그 DS 는 용량 합에 들어가지 않고 '사용량 미상' 으로 센다(조용히 빠지지 않는다)
      const { scopedRollups, dsUsageUnknownOf } = await import('../src/store.js');
      assert.equal(dsUsageUnknownOf(gone), true);
      const g = scopedRollups({ ...s, vcenters: [s.vcenter] }, new Set(['vc-r'])).global;
      assert.equal(g.datastoresUsageUnknown, 1);
      assert.equal(g.storageTotalTB, Math.round((100 / 1024) * 10) / 10);
      assert.equal(g.hostsCapacityUnknown, 1);
    } finally { config.vcSoapMetrics = prev; }
  } finally { srv.close(); }
});

/** SOAP vCenter(용량 읽음) + REST 폴백 vCenter(용량 없음) — 같은 클러스터 이름. */
function capSnap() {
  _gen += 1;
  const rest = (name) => ({ id: `vc-r:${name}`, vcenterId: 'vc-r', name, cluster: 'CL', connectionState: 'CONNECTED', cpuCores: null, cpuTotalMhz: null, memTotalMB: null });
  const vm = (vc, i, cpu, mem) => ({ id: `${vc}:vm-${i}`, vcenterId: vc, name: `${vc}-vm-${i}`, cluster: 'CL', powerState: 'POWERED_ON', cpuCount: cpu, memMB: mem });
  return {
    generatedAt: new Date(Date.UTC(2026, 0, 5, 3, 30, _gen)).toISOString(),
    vcenters: [
      { id: 'vc-s', name: 'S', status: 'connected', location: { region: 'Asia' } },
      { id: 'vc-r', name: 'R', status: 'connected', collectSource: 'rest', restUnknown: ['hostCapacity'], location: { region: 'Asia' } },
    ],
    hosts: [
      host('vc-s', 'esx-s1', 0, { cpuCores: 32, cpuTotalMhz: 64_000, memTotalMB: 524_288 }),
      rest('esx-r1'), rest('esx-r2'),
    ],
    vms: [vm('vc-s', 1, 64, 262_144), vm('vc-r', 1, 40, 131_072), vm('vc-r', 2, 40, 131_072)],
    datastores: [], networks: [], alarms: [],
  };
}

test('C2-06: /tools/capacity 실제 라우트 — 용량 모르는 클러스터의 비율·여유는 null, 합계 비율은 다 읽은 클러스터만', async () => {
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { registerToolsCapacity } = await import('../src/routes/api/toolsCapacity.js');
  store.snapshot = capSnap();
  const r = express.Router();
  registerToolsCapacity(r);
  const app = express();
  app.use((req, _res, next) => { req.user = { username: 'admin', role: 'admin', scope: null }; next(); });
  app.use('/api', r);
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  try {
    const d = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/tools/capacity`)).json();
    const rc = d.clusters.find((c) => c.vcenterId === 'vc-r');
    const sc = d.clusters.find((c) => c.vcenterId === 'vc-s');
    assert.equal(rc.capacityUnknown, 2);
    assert.equal(rc.cores, null, "코어 0 이 아니라 모른다");
    assert.equal(rc.memTotalGB, null);
    assert.equal(rc.vcpuPerCore, null, '0:1(초록)이 아니다');
    assert.equal(rc.ramOvercommitPct, null, '0%(초록)이 아니다');
    assert.equal(rc.ramHeadroomGB, null);
    assert.equal(sc.capacityUnknown, 0);
    assert.equal(sc.vcpuPerCore, 2);       // 64 vCPU / 32 코어
    assert.equal(sc.ramOvercommitPct, 50); // 256GB / 512GB
    const t = d.totals;
    assert.equal(t.capacityUnknown, 2);
    assert.equal(t.cores, 32);
    assert.equal(t.vcpuPerCore, 2, `합계 비율은 용량을 다 읽은 클러스터끼리(예전 (64+80)/32=4.5) — 실제 ${t.vcpuPerCore}`);
    assert.equal(t.ramHeadroomGB, 256);
    assert.equal(d.clusters[d.clusters.length - 1].vcenterId, 'vc-r', 'null(모름)은 정렬 뒤로');
  } finally { srv.close(); }
});

test('C2-06: 비교 매트릭스·롤업 — 용량 모르는 셀은 총량·과할당 null + capacityUnknown, 롤업은 hostsCapacityUnknown', async () => {
  const { clusterMatrix } = await import('../src/tools/compareMatrix.js');
  const { scopedRollups, hostCapacityKnown } = await import('../src/store.js');
  const snap = capSnap();
  const m = clusterMatrix(snap);
  const row = m.rows.find((x) => x.name === 'CL');
  const rcell = row.cells['vc-r'];
  assert.equal(rcell.capacityUnknown, 2);
  for (const k of ['vcpuPerCore', 'memOvercommitPct', 'cpuTotalGhz', 'memTotalGB']) assert.equal(rcell[k], null, `REST 셀 ${k}`);
  const scell = row.cells['vc-s'];
  assert.equal(scell.capacityUnknown, undefined, '다 읽은 셀은 설명 키를 싣지 않는다(셀 키 = 지표 키 계약)');
  assert.equal(scell.vcpuPerCore, 2);
  assert.equal(scell.cpuTotalGhz, 64);
  // 합계 열은 부분 합이라 null
  assert.equal(row.total.vcpuPerCore, null, `합계 셀 — 예전 (64+80)/32=4.5 — 실제 ${row.total.vcpuPerCore}`);
  assert.equal(row.total.cpuTotalGhz, null);
  assert.equal(m.colTotals['vc-s'].vcpuPerCore, 2);
  // 롤업
  assert.equal(hostCapacityKnown(snap.hosts[0]), true);
  assert.equal(hostCapacityKnown(snap.hosts[1]), false);
  const g = scopedRollups(snap, new Set(['vc-s', 'vc-r'])).global;
  assert.equal(g.hostsCapacityUnknown, 2);
  assert.equal(g.cpuCores, 32, '읽은 호스트의 합');
  const site = scopedRollups(snap, new Set(['vc-s', 'vc-r'])).sites.find((s) => s.id === 'vc-r').metrics;
  assert.equal(site.hostsCapacityUnknown, 2);
});
