// v2.721(감사 그룹 E) — B1-01 비용 태그 부분 읽기 · B1-02 그룹 준비율 분모 · B1-03 vSAN 추가분 확정 여부 · B1-04 재부팅 이벤트 읽기 절단.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2721e-'));
process.env.CONFIG_DIR = TMP;
process.env.DB_DIR = TMP;
const cost = await import('../src/cost/analyze.js');
const cs = await import('../src/cost/settings.js');
const mig = await import('../src/migration/analyze.js');
const core = await import('../src/corelicense/analyze.js');
const { analyzeReboots, PLANNED_WINDOW_MS } = await import('../src/hostcfg/reboots.js');

const H = 3_600_000;
const DAY = 24 * H;
const FIXED = Math.floor(1_800_000_000_000 / H) * H - 30 * 60_000;   // 정시 -30분(경계에서 떨어뜨린 고정 시각)
const vm = (name, extra = {}) => ({ id: `vc1:${name}`, name, vcenterId: 'vc1', cluster: 'C1', powerState: 'POWERED_ON', cpuCount: 2, memMB: 4096, storageGB: 10, ...extra });
const closers = [];
after(async () => { for (const c of closers) await c(); });

test('B1-01 태그 연결을 일부만 읽은 vCenter 의 무태그 VM 은 (태그 없음) 이 아니라 따로 묶고 tagPartial 로 센다', () => {
  const inv = { categories: [{ name: 'Owner' }], tags: [{ name: 'teamA', cat: 0 }], vmTags: { 'vm-1': [0] }, partialTags: true };
  const full = { categories: [{ name: 'Owner' }], tags: [{ name: 'teamA', cat: 0 }], vmTags: { 'vm-9': [0] }, partialTags: false };
  const snap = {
    vcenters: [{ id: 'vc1', tagInv: inv }, { id: 'vc2', tagInv: full }],
    vms: [vm('a', { id: 'vc1:vm-1' }), vm('b', { id: 'vc1:vm-2' }), { ...vm('c'), vcenterId: 'vc2', id: 'vc2:vm-3' }],
  };
  const r = cost.analyzeCost(snap, cs.DEFAULTS, { by: 'tag', category: 'owner' });
  const labels = Object.fromEntries(r.groups.map((g) => [g.label, g.vms]));
  assert.deepEqual(labels, { teamA: 1, [cost.TAG_PARTIAL]: 1, [cost.NO_TAG]: 1 }, '부분 읽기 vCenter 의 vm-2 는 (태그 없음) 이 아니다 · 다 읽은 vCenter 의 무태그는 (태그 없음)');
  assert.equal(r.notes.tagPartial, 1);
  assert.equal(r.notes.tagUnknown, 0);
  assert.notEqual(cost.TAG_PARTIAL, cost.NO_TAG);
  // 구버전 보고(partialTags 없음) — 잘림 개수로 판정한다(tags/analyze.js 와 같은 규칙).
  const old = { ...inv }; delete old.partialTags; old.truncated = { tags: 3 };
  const r2 = cost.analyzeCost({ ...snap, vcenters: [{ id: 'vc1', tagInv: old }] , vms: snap.vms.slice(0, 2) }, cs.DEFAULTS, { by: 'tag', category: 'owner' });
  assert.equal(r2.notes.tagPartial, 1);
});

test('B1-02 그룹 준비율의 분모는 판정한 VM(미수집 제외) — 전체와 같다', () => {
  const CFG = { question: null, consolidationNeeded: false, managedBy: null, cpuReservationMhz: 0, memReservationMB: 0 };
  const DEV = { disks: [], usb: 0, serial: 0, parallel: 0, cdroms: [] };
  const vms = [vm('r', { cfg: CFG, dev: DEV, hwVersion: 'vmx-19' }), vm('u1'), vm('u2'), vm('u3')];
  const r = mig.analyzeMigration(vms);
  assert.equal(r.readyPct, 100);
  assert.equal(r.groups[0].readyPct, 100, '예전: ready/vms = 25%');
  const none = mig.analyzeMigration([vm('x'), vm('y')]);
  assert.equal(none.groups[0].readyPct, null, '판정한 VM 이 0 이면 null');
});

test('B1-03 산정 못 한 호스트·용량 미상 vSAN DS 가 있으면 vSAN 추가분을 확정값으로 말하지 않는다', () => {
  const host = (name, sockets, cores) => ({ name, vcenterId: 'vc1', cluster: 'C', cpuSockets: sockets, cpuCores: cores, connectionState: 'CONNECTED' });
  const vsan = (gb) => ({ vcenterId: 'vc1', type: 'vsan', capacityGB: gb });
  const base = { vcenters: [{ id: 'vc1', name: 'VC1' }] };
  // 2대 미상(하한 licensed) → 추가분은 상한
  let r = core.analyzeCoreLicense({ ...base, hosts: [host('a', 2, 16), host('b', null, null), host('c', null, null)], datastores: [vsan(30 * 1024)] }, { vsanPlan: 'vvf' });
  assert.equal(r.totals.vsanAddonBound, 'upper');
  assert.equal(r.vcenters[0].vsanAddonBound, 'upper');
  assert.equal(r.totals.vsanAddonTib, 22);
  // 용량 미상 DS → 하한
  r = core.analyzeCoreLicense({ ...base, hosts: [host('a', 2, 16)], datastores: [vsan(30 * 1024), vsan(null)] }, { vsanPlan: 'vvf' });
  assert.equal(r.totals.vsanAddonBound, 'lower');
  // 둘 다 → 방향을 모른다 — 값을 지어내지 않는다
  r = core.analyzeCoreLicense({ ...base, hosts: [host('a', 2, 16), host('b', null, null)], datastores: [vsan(30 * 1024), vsan(null)] }, { vsanPlan: 'vvf' });
  assert.equal(r.totals.vsanAddonBound, 'unknown');
  assert.equal(r.totals.vsanAddonTib, null);
  assert.equal(r.vcenters[0].vsanAddonTib, null);
  // 다 읽었으면 확정
  r = core.analyzeCoreLicense({ ...base, hosts: [host('a', 2, 16)], datastores: [vsan(30 * 1024)] }, { vsanPlan: 'vvf' });
  assert.equal(r.totals.vsanAddonBound, 'exact');
  // 가정을 고르지 않으면 판정도 없다
  r = core.analyzeCoreLicense({ ...base, hosts: [host('a', 2, 16)], datastores: [vsan(30 * 1024)] }, { vsanPlan: 'none' });
  assert.equal(r.totals.vsanAddonBound, null);
});

test('B1-04 analyzeReboots — readFrom 이하로 판정 창이 걸친 부팅은 근거가 빠졌을 수 있어 단정하지 않는다', () => {
  const boot = FIXED - 20 * DAY;
  const hosts = [
    { id: 'h1', name: 'esx-a', vcenterId: 'vc1', connectionState: 'CONNECTED', bootTime: boot },
    { id: 'h2', name: 'esx-b', vcenterId: 'vc1', connectionState: 'CONNECTED', bootTime: boot },
    { id: 'h3', name: 'esx-c', vcenterId: 'vc1', connectionState: 'CONNECTED', bootTime: FIXED - DAY },
  ];
  const ev = [{ vcenterId: 'vc1', entity: 'esx-b', ts: boot - H, type: 'EnteredMaintenanceModeEvent', user: 'adm' }];
  const cov = () => ({ firstTs: FIXED - 60 * DAY, lastTs: FIXED });
  const readFrom = boot + DAY;     // 그보다 오래된 이벤트는 입력에 없다
  const r = analyzeReboots(hosts, ev, { now: FIXED, days: 30, coverageOf: cov, readFrom });
  const k = Object.fromEntries(r.rows.map((x) => [x.name, [x.kind, x.readCut]]));
  assert.deepEqual(k['esx-a'], ['no-events', true], '예전: unknown(이벤트는 받았는데 근거 없음)');
  assert.deepEqual(k['esx-b'], ['planned', false], '보이는 유지보수 근거는 그대로 쓴다');
  assert.deepEqual(k['esx-c'], ['unknown', false], '읽은 구간 안의 부팅은 예전 판정');
  assert.equal(r.readCut, 1);
  assert.ok(FIXED - DAY - PLANNED_WINDOW_MS > readFrom);
  assert.equal(analyzeReboots(hosts, ev, { now: FIXED, days: 30, coverageOf: cov }).readCut, 0, '절단이 없으면 예전 그대로');
});

test('B1-04 라우트 — 상한 + 1 로 읽어 truncated·readFrom 을 싣고 잘린 구간 부팅은 no-events', async () => {
  const express = (await import('express')).default;
  const { getLogsDb } = await import('../src/logs/db.js');
  const { registerHostHygiene } = await import('../src/routes/api/hostHygiene.js');
  const { store } = await import('../src/store.js');
  // 라우트는 Date.now() 로 창을 잡으므로 실제 시각 기준이되, 경계에서 일 단위로 떨어뜨린다.
  const now = Math.floor(Date.now() / H) * H - 30 * 60_000;
  const boot = now - 20 * DAY;
  const db = await getLogsDb();
  const rows = [
    { vcenterId: 'vc1', key: 'old', ts: now - 60 * DAY, severity: 'info', type: 'HostConnectionLostEvent', user: '', entity: 'esx-old', message: 'old' },
    { vcenterId: 'vc1', key: 'maint', ts: boot - H, severity: 'info', type: 'EnteredMaintenanceModeEvent', user: 'adm', entity: 'esx-a', message: 'm' },
  ];
  for (let i = 0; i < 20_001; i += 1) rows.push({ vcenterId: 'vc1', key: `n${i}`, ts: now - 2 * DAY + i * 1000, severity: 'info', type: 'HostConnectionLostEvent', user: '', entity: 'esx-noise', message: `n${i}` });
  db.insertMany(rows);
  const prev = store.snapshot;
  store.snapshot = {
    source: 'live', generatedAt: '2026-10-07T03:30:00.000Z', vcenters: [{ id: 'vc1', name: 'VC1' }],
    hosts: [{ id: 'vc1:h1', name: 'esx-a', vcenterId: 'vc1', connectionState: 'CONNECTED', bootTime: boot }],
    vms: [], datastores: [], networks: [], alarms: [], collectionErrors: [],
  };
  try {
    const router = express.Router();
    registerHostHygiene(router);
    const app = express();
    app.use((req, _res, next) => { req.user = { username: 'admin', role: 'admin', scope: null }; next(); });
    app.use('/api', router);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    closers.push(() => new Promise((r) => srv.close(r)));
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/tools/host-hygiene/reboots?days=30`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.truncated, true);
    assert.equal(body.readLimit, 20_000);
    assert.ok(Number.isFinite(body.readFrom) && body.readFrom > boot);
    const a = body.rows.find((x) => x.name === 'esx-a');
    assert.equal(a.kind, 'no-events', '예전: 유지보수 이벤트가 잘려 unknown');
    assert.equal(a.readCut, true);
  } finally { store.snapshot = prev; }
});
