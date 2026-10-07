/**
 * v2.720 감사 그룹 G4 회귀 고정.
 *
 *  - B1-01  알림 엔진이 상한(위험 알람·끊긴 호스트 100, DS 200)으로 잘린 꼬리와, 지금 값을 읽지 못한 vCenter(연결 불가·
 *           점검중·첫 수집 중·비활성 — 인벤토리를 비운 경우 포함)의 항목을 '해소' 로 기록했다 → 판정 보류.
 *  - B1-04  /summary byVcenter.powerKw 가 전력 보고 호스트 0대인 vCenter 도 0.0 kW 였다 → null + powerServers.
 *  - B1-05  SAN 스토리지 사용량에서 모든 버킷이 부분 합으로 비워진 계열이 avgTotal 0 이었다 → null.
 *  - B1-06  CVP 장비별 트래픽 합에서 한 방향 값을 하나도 못 읽으면 0 bps 였다 → null.
 *  - B2-02  GET /tools/vm-tags 가 오류 원문(tagsError·customError)을 operator·범위 계정에도 줬다 → 전체 범위 admin 만.
 *
 * 기준 시각은 경계에서 떨어뜨린 고정값(Date.now() 를 쓰지 않는다 — CLAUDE.md v2.517).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a2720g4-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'false';

const { store } = await import('../src/store.js');
const alerts = await import('../src/alerts.js');

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000 - 30 * 60_000;   // 정시 −30분 고정

/* ── B1-01 ─────────────────────────────────────────────────────────── */
const CFG = {
  cooldownMin: 60,
  rules: { criticalAlarms: { enabled: true }, hostDisconnected: { enabled: true }, datastorePct: { enabled: true, threshold: 90 } },
};
const alarm = (i, vc = 'vc-a') => ({ id: `a${i}`, name: `alarm ${i}`, severity: 'critical', vcenterId: vc, entity: `e${i}` });

async function runWith(snap) {
  const orig = store.get;
  store.get = () => snap;
  try { await alerts._refreshStateForTest(CFG, false); } finally { store.get = orig; }
  return alerts.alertStatus();
}
const resolvedKeys = (st) => new Set(st.recent.filter((r) => r.severity === 'resolved').map((r) => r.key));

test('B1-01 ① 상한(100)으로 잘린 꼬리는 해소가 아니라 판정 보류다', async () => {
  alerts._resetAlertStateForTest();
  const list = Array.from({ length: 101 }, (_, i) => alarm(i));
  const vcs = [{ id: 'vc-a', status: 'connected' }];
  let st = await runWith({ vcenters: vcs, alarms: list, hosts: [], datastores: [], vms: [] });
  assert.ok(st.firing.some((f) => f.key === 'alarm:a99'));
  // 순서만 바뀌어 a99 가 101번째로 밀린다
  const re = [list[100], ...list.slice(0, 99), list[99]];
  st = await runWith({ vcenters: vcs, alarms: re, hosts: [], datastores: [], vms: [] });
  assert.ok(!resolvedKeys(st).has('alarm:a99'), '잘린 꼬리를 해소로 기록하면 안 된다');
  assert.ok(st.firing.some((f) => f.key === 'alarm:a99'), '발생 상태를 유지한다');
  // evaluate 자체도 꼬리 키를 held 로 싣는다(DS 200 상한 포함)
  const ds = Array.from({ length: 201 }, (_, i) => ({ id: `d${i}`, name: `d${i}`, vcenterId: 'vc-a', usagePct: 95 }));
  const out = alerts.evaluate({ vcenters: vcs, alarms: [], hosts: [], datastores: ds, vms: [] }, CFG);
  assert.equal(out.length, 200);
  assert.ok(out.held.has('ds:d200'));
});

test('B1-01 ② 인벤토리를 비운 연결 불가 vCenter 의 항목은 해소로 기록하지 않는다', async () => {
  alerts._resetAlertStateForTest();
  const host = { id: 'h1', name: 'esx1', vcenterId: 'vc-b', connectionState: 'DISCONNECTED' };
  const ds = { id: 'ds1', name: 'ds1', vcenterId: 'vc-b', usagePct: 96, freeGB: 1 };
  let st = await runWith({ vcenters: [{ id: 'vc-b', status: 'connected' }], alarms: [alarm(1, 'vc-b')], hosts: [host], datastores: [ds], vms: [] });
  assert.equal(st.firing.length, 3);
  for (const status of ['unreachable', 'maintenance', 'pending']) {
    st = await runWith({ vcenters: [{ id: 'vc-b', status }], alarms: [], hosts: [], datastores: [], vms: [] });
    assert.equal(resolvedKeys(st).size, 0, `${status}: 모름을 복구로 기록하면 안 된다`);
    assert.equal(st.firing.length, 3);
  }
  // 다시 연결됐는데 정말 없으면 그때 해소다(보류가 해소를 영원히 막지는 않는다)
  st = await runWith({ vcenters: [{ id: 'vc-b', status: 'connected' }], alarms: [], hosts: [], datastores: [], vms: [] });
  assert.deepEqual([...resolvedKeys(st)].sort(), ['alarm:a1', 'ds:ds1', 'host:h1']);
});

/* ── B1-04 ─────────────────────────────────────────────────────────── */
test('B1-04 /summary byVcenter.powerKw — 전력 보고 0대면 null + powerServers', async () => {
  const express = (await import('express')).default;
  const { registerInventory } = await import('../src/routes/api/inventory.js');
  const api = express.Router(); registerInventory(api);
  const snap = {
    generatedAt: new Date(NOW).toISOString(), source: 'mock',
    vcenters: [{ id: 'vc-p', name: 'P', status: 'connected' }, { id: 'vc-q', name: 'Q', status: 'connected' }],
    hosts: [
      { id: 'h1', vcenterId: 'vc-p', connectionState: 'CONNECTED', cpuCores: 8, memTotalMB: 1024, powerWatts: 500 },
      { id: 'h2', vcenterId: 'vc-q', connectionState: 'CONNECTED', cpuCores: 8, memTotalMB: 1024 },
    ],
    vms: [], datastores: [], networks: [], alarms: [], collectionErrors: [],
  };
  const orig = store.get;
  store.get = () => snap;
  const app = express(); app.use(express.json()); app.use('/api', api);
  const srv = app.listen(0, '127.0.0.1'); await new Promise((r) => srv.once('listening', r));
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/summary`);
    assert.equal(r.status, 200);
    const j = await r.json();
    const p = j.byVcenter.find((x) => x.id === 'vc-p'); const q = j.byVcenter.find((x) => x.id === 'vc-q');
    assert.equal(p.powerKw, 0.5); assert.equal(p.powerServers, 1);
    assert.equal(q.powerKw, null, '측정 0대는 0.0 kW 가 아니다'); assert.equal(q.powerServers, 0);
  } finally { srv.close(); store.get = orig; }
});

/* ── B1-05 ─────────────────────────────────────────────────────────── */
test('B1-05 SAN 스토리지 — 모든 버킷이 부분 합이면 avgTotal 등은 null(0 아님)', async () => {
  const pdb = await import('../src/sanswitch/perfDb.js');
  const BM = 6 * 60_000;
  const F = Math.floor(NOW / BM) * BM - 10 * HOUR;
  const name = 'SYMMETRIX::000111222333::FA-1D';
  // 포트 2: 조회 직전(이월 한계 안) + 50분 뒤 / 포트 1: 10분 뒤 — 어느 버킷도 두 포트를 다 갖지 못한다
  const r = await pdb.importSamples([
    { d: 'sw1', ts: F - 30_000, p: 2, b: 100 },
    { d: 'sw1', ts: F + 10 * 60_000, p: 1, b: 100 },
    { d: 'sw1', ts: F + 50 * 60_000, p: 2, b: 100 },
  ], [{ d: 'sw1', p: 1, ts: F, name }, { d: 'sw1', p: 2, ts: F, name }]);
  assert.equal(r.inserted, 3);
  const out = await pdb.storageSeriesMulti(['sw1'], { from: F, to: F + HOUR, points: 10, carryMs: 60_000 });
  const s = out.series.find((x) => x.key.startsWith('SYMMETRIX'));
  assert.ok(s, '계열이 있어야 한다');
  assert.ok(s.partialBuckets >= 2);
  assert.equal(s.avgTotal, null); assert.equal(s.maxTotal, null);
  assert.equal(s.peakAvg, null); assert.equal(s.peakTotal, null);
});

/* ── B1-06 ─────────────────────────────────────────────────────────── */
test('B1-06 CVP 트래픽 합 — 한 방향을 하나도 못 읽으면 null(0 bps 아님)', async () => {
  const cdb = await import('../src/cvp/db.js');
  await cdb.saveDevices({ cvpId: 'cvp1', devices: [{ key: 'SN1', ts: NOW, hostname: 'sw-a',
    ports: [{ name: 'Ethernet1', oper: 'up', speedBps: 1e10, outBps: 1000 }, { name: 'Ethernet2', oper: 'up', speedBps: 1e10, outBps: 500 }] }] });
  const t = await cdb.trafficByDevice({ now: NOW + 60_000 });
  const row = t.rows.find((x) => x.key === 'SN1');
  assert.ok(row);
  assert.equal(row.measured, 2);
  assert.equal(row.outBps, 1500);
  assert.equal(row.inBps, null, '수신을 하나도 못 읽었으면 0 이 아니라 null');
});

/* ── B2-02 ─────────────────────────────────────────────────────────── */
test('B2-02 /tools/vm-tags — 오류 원문은 전체 범위 admin 에게만, 캐시가 역할을 섞지 않는다', async () => {
  const express = (await import('express')).default;
  const { registerVmTags, ERROR_HIDDEN_TEXT } = await import('../src/routes/api/vmTags.js');
  const raw = 'GET /api/cis/tagging/tag -> 500 connect ECONNREFUSED 10.20.30.40:443';
  const snap = {
    generatedAt: new Date(NOW + 1).toISOString(),
    vcenters: [{ id: 'vc-t', name: 'T', status: 'connected', tagInv: { at: NOW, tagsError: raw, customError: 'connect ECONNREFUSED 10.20.30.40:443' } }],
    vms: [], hosts: [], datastores: [],
  };
  const orig = store.get;
  store.get = () => snap;
  const mk = (role) => {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.user = { username: role, role }; next(); });
    const r = express.Router(); registerVmTags(r); app.use('/api', r);
    return app;
  };
  const get = async (app) => {
    const srv = app.listen(0, '127.0.0.1'); await new Promise((r) => srv.once('listening', r));
    try { return await (await fetch(`http://127.0.0.1:${srv.address().port}/api/tools/vm-tags`)).json(); } finally { srv.close(); }
  };
  try {
    const adm = await get(mk('admin'));
    assert.equal(adm.vcenters[0].tagsError, raw);
    const op = await get(mk('operator'));   // 같은 범위('all')·같은 스냅샷 — admin 캐시가 나가면 안 된다
    assert.equal(op.vcenters[0].tagsError, ERROR_HIDDEN_TEXT);
    assert.equal(op.vcenters[0].customError, ERROR_HIDDEN_TEXT);
    assert.equal(op.errorsHidden, true);
    assert.equal(op.status, null);
    assert.ok(!JSON.stringify(op).includes('10.20.30.40'));
  } finally { store.get = orig; }
});

test('v2.720 통합 B1-06 — CVP Overview 트래픽: 한 방향을 못 읽은 장비는 그 방향을 0 이 아니라 못 읽음으로 센다', async () => {
  const { buildCvpOverview } = await import('../src/cvp/overview.js');
  const ov = buildCvpOverview({ now: NOW, servers: [{ id: 'c1', name: 'CVP1' }], devices: [], traffic: [
    { cvpId: 'c1', key: 'sw1', measured: 4, unmeasured: 0, inBps: 1000, outBps: null },
    { cvpId: 'c1', key: 'sw2', measured: 2, unmeasured: 0, inBps: 500, outBps: 200 },
  ] });
  const t = ov.totals?.traffic || ov.traffic;
  assert.ok(t, JSON.stringify(Object.keys(ov)));
  assert.equal(t.outUnread, 1, '송신을 못 읽은 장비 1대');
  assert.equal(t.inUnread ?? 0, 0);
  const top = Object.values(ov.corps || {}).flatMap?.((c) => c.traffic?.top || []) || (ov.corps || []).flatMap((c) => c.traffic?.top || []);
  const sw1 = top.find((d) => d.key === 'sw1');
  if (sw1) assert.equal(sw1.outBps, null, '목록에서도 못 읽은 방향은 null');
});
