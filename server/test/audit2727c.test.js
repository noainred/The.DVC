/**
 * v2.727 감사 C-01 · E-12 회귀 — VM 스토리지(storageGB/uncommittedGB)·GPU VRAM(memGB) 결측(null)을 소비처가 0 으로 되돌리지 않는다.
 *
 * 배경(감사 C.md C-01): `vcenter/soapClient.js` 는 v2.719(B1-09)부터 `summary.storage.committed/uncommitted` 를 못 읽은 VM 의
 * storageGB/uncommittedGB 를 **null** 로 싣는데, 소비처 12곳이 `Number(x) || 0`·`x || 0` 으로 null 을 0 으로 더해 ① 디스크 추이
 * 시계열(vm_disk_*)이 표지 없이 작게 적재되고 ② 인벤토리 합계·디스크 트렌드·정지 VM 회수량·공개 API 가 같은 스냅샷의 비용 배분
 * ('용량 모름 N대') 과 다른 말을 했다. 보고된 0 은 값이다 — 이 테스트는 null 과 0 을 **둘 다** 고정한다.
 *
 * 변이 검증(수정을 하나씩 되돌리면 해당 테스트가 실패해야 한다):
 *   M1 sampler.js `numOrNull(v.storageGB)` → `Number(v.storageGB) || 0`        : ① 실패(prov/used/off 가 커지고 vmStorageUnknown 0)
 *   M2 diskTrend.js committedOf 의 null 건너뛰기 제거                           : ③ 실패
 *   M3 guestOsAgg.js `numOrNull` → `Number(...) || 0`                           : ④ 실패
 *   M4 zombies.js slim 의 `numOrNull` → `|| 0`                                 : ⑤ 실패
 *   M5 inventory.js vmStorageUnknown 제거 / publicApi.js vmStorageUnknown 제거  : ⑧·⑨ 실패
 *   M6 toolsCapacity.js wasteReport `|| 0` 복원                                 : ⑧ 실패(poweredOff.storageUnknown 없음)
 *   M7 GpuTool/gpuUsageText `vramText` 제거                                     : 웹 vitest(audit2727g3a) 실패
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const ROOT = path.resolve(SRC, '..');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2727c-'));
process.env.CONFIG_DIR = DIR;
process.env.TEMP_DB_PATH = path.join(DIR, 'host-temp.db');
process.env.DATA_SOURCE = 'mock';

const { vmAllocRows, samplerWithheldOf } = await import('../src/metrics/sampler.js');
const { diskBreakdown, analyzeDiskTrend } = await import('../src/tools/diskTrend.js');
const { aggregateGuestOs } = await import('../src/inventory/guestOsAgg.js');
const { computeZombies } = await import('../src/reports/zombies.js');
const { computeUnprotected } = await import('../src/reports/unprotected.js');
const { VM_EXPORT_COLUMNS } = await import('../src/vcenter/vmExport.js');
const { summarizeHostGpu } = await import('../src/gpu/hostGpu.js');
const { ENDPOINTS } = await import('../src/publicapi/allowlist.js');

const ALL = { enabled: true, vcenterIds: [], trackTotal: true };
const NOW = Date.UTC(2026, 9, 8, 3, 30, 0); // 정시 −30분(v2.517 규약)

/* ── ① sampler: committed null 은 다섯 계열 전부에서 빠지고, uncommitted 만 null 이면 committed 는 더한다 ── */
test('C-01 ① vmAllocRows — storageGB null 인 VM 은 디스크 계열에서 빼고 vmStorageUnknown 으로 센다(보고된 0 은 값)', () => {
  const snap = { vcenters: [{ id: 'vc1', status: 'connected' }], hosts: [], datastores: [], vms: [
    { id: 'a', vcenterId: 'vc1', name: 'a', powerState: 'POWERED_OFF', storageGB: 500, uncommittedGB: 100, snapshotSizeGB: 0 },
    { id: 'b', vcenterId: 'vc1', name: 'b', powerState: 'POWERED_OFF', storageGB: null, uncommittedGB: null, snapshotSizeGB: 30 }, // 못 읽음(v2.719)
    { id: 'c', vcenterId: 'vc1', name: 'c', powerState: 'POWERED_ON', storageGB: 300, uncommittedGB: null, snapshotSizeGB: 7 },   // 미커밋만 못 읽음
    { id: 'd', vcenterId: 'vc1', name: 'd', powerState: 'POWERED_OFF', storageGB: 0, uncommittedGB: 0, snapshotSizeGB: 0 },       // 보고된 0 = 값
  ] };
  const out = vmAllocRows(snap, ALL);
  const rows = Object.fromEntries((out.get('vc1') || []).map((r) => [r.metric, r.v]));
  assert.equal(rows.vm_disk_prov_gb, 500 + 100 + 300, 'prov = a(500+100) + c(300, 미커밋 미상 → 커밋만) — b 는 빠진다');
  assert.equal(rows.vm_disk_used_gb, 500 + 300 + 0, 'used — b 는 빠지고 d(0) 는 값');
  assert.equal(rows.vm_disk_off_gb, 500 + 0, 'off — b 의 null 을 0 으로 더하지 않는다');
  assert.equal(rows.vm_snap_gb, 7, 'b 의 스냅샷 30 은 committed 를 모르는 VM 이라 계열에서 빠진다(다섯 계열이 같은 VM 집합)');
  assert.equal(rows.vm_snap_on_gb, 7);
  assert.equal(out.vmStorageUnknown, 2, 'b(committed) + c(uncommitted)');
  assert.deepEqual(out.vmStorageUnknownBy, { committed: 1, uncommitted: 1 });
  assert.ok(rows.vm_disk_prov_gb >= rows.vm_disk_used_gb, 'prov ≥ used 항등식 — uncommitted 미상 VM 의 committed 를 prov 에서도 더한다');
  // 전체('') 합계도 같은 값(보류하지 않는다 — v2.682 R3A-03)
  const tot = Object.fromEntries((out.get('') || []).map((r) => [r.metric, r.v]));
  assert.equal(tot.vm_disk_prov_gb, 900);
  // 전부 읽었으면 0
  const ok = vmAllocRows({ ...snap, vms: snap.vms.filter((v) => v.id !== 'b' && v.id !== 'c') }, ALL);
  assert.equal(ok.vmStorageUnknown, 0);
  assert.deepEqual(ok.vmStorageUnknownBy, { committed: 0, uncommitted: 0 });
});

/* ── ② samplerWithheldOf — lastRun 의 vmStorageUnknown·dsUsedUnknown 을 화면용 요약에 싣는다 ── */
test('C-01 ② samplerWithheldOf — 결측으로 뺀 VM·DS 수가 있으면 null 이 아니다', () => {
  assert.equal(samplerWithheldOf({ at: 1, rows: 3, hostsWithTemp: 2 }), null, '뺀 것이 없으면 null(0 칸을 늘어놓지 않는다)');
  const w = samplerWithheldOf({ at: 1, rows: 3, vmStorageUnknown: 2, vmStorageUnknownBy: { committed: 1, uncommitted: 1 }, dsUsedUnknown: 1 });
  assert.equal(w.vmStorageUnknown, 2);
  assert.equal(w.dsUsedUnknown, 1);
  assert.equal(w.staleVcenters, 0);
});

/* ── ②-b 실제 샘플 1회 — lastRun 에 실린다 ── */
test('C-01 ②-b 실제 샘플 1회 — lastRun.vmStorageUnknown 이 DS 와 같은 자리에 실린다', async () => {
  const sampler = await import('../src/metrics/sampler.js');
  const { store } = await import('../src/store.js');
  store.snapshot = { generatedAt: new Date(NOW).toISOString(), source: 'mock',
    vcenters: [{ id: 'vc-s', status: 'connected', name: 'vc-s' }], hosts: [], datastores: [], alarms: [], networks: [],
    vms: [
      { id: 'vc-s:1', vcenterId: 'vc-s', name: 'one', powerState: 'POWERED_ON', storageGB: 100, uncommittedGB: 0, memMB: 1024, memUsagePct: 10, cpuCount: 1, cpuUsagePct: 5 },
      { id: 'vc-s:2', vcenterId: 'vc-s', name: 'two', powerState: 'POWERED_OFF', storageGB: null, uncommittedGB: null },
    ] };
  await sampler._sampleOnceForTest();
  const st = sampler.metricsSamplerStatus();
  assert.ok(st.lastRun, '샘플이 돌지 않았다');
  assert.equal(st.lastRun.vmStorageUnknown, 1);
  assert.deepEqual(st.lastRun.vmStorageUnknownBy, { committed: 1, uncommitted: 0 });
});

/* ── ③ diskTrend.diskBreakdown ── */
test('C-01 ③ diskBreakdown — null 은 합계에서 빠지고 storageUnknown·uncommittedUnknown·off.storageUnknown 으로 센다', () => {
  const ds = [{ id: 'ds1', capacityGB: 2000, usedGB: 1500 }];
  const vm = (o) => ({ id: `vc-a:${o.name}`, vcenterId: 'vc-a', powerState: 'POWERED_ON', storageGB: 100, uncommittedGB: 0, snapshotCount: 0, snapshotSizeGB: 0, ...o });
  const vms = [
    vm({ name: 'on1', storageGB: 400, uncommittedGB: 600, thin: true }),
    vm({ name: 'on2', storageGB: 200, uncommittedGB: null }),                       // 미커밋만 모름 → 커밋은 더한다(할당은 하한)
    vm({ name: 'off1', powerState: 'POWERED_OFF', storageGB: 50 }),
    vm({ name: 'offNull', powerState: 'POWERED_OFF', storageGB: null, uncommittedGB: null }), // 전부 모름 → 전부에서 뺀다
    vm({ name: 'tplNull', template: true, storageGB: null }),
    vm({ name: 'zero', powerState: 'POWERED_OFF', storageGB: 0 }),                 // 보고된 0 = 값
  ];
  const b = diskBreakdown(vms, ds, { now: NOW });
  assert.equal(b.vm.committedGB, 400 + 200 + 50 + 0);
  assert.equal(b.vm.uncommittedGB, 600);
  assert.equal(b.vm.provGB, 1250);
  assert.equal(b.vm.storageUnknown, 1, 'offNull');
  assert.equal(b.vm.uncommittedUnknown, 1, 'on2');
  assert.equal(b.vm.templateStorageUnknown, 1, 'tplNull');
  assert.equal(b.vm.templateGB, 0);
  assert.equal(b.reclaim.off.count, 3, '정지 VM 수는 그대로(미상 VM 도 정지 VM 이다)');
  assert.equal(b.reclaim.off.gb, 50, '정지 VM 회수량은 읽은 것만');
  assert.equal(b.reclaim.off.storageUnknown, 1);
  assert.equal(b.other.gb, null, '커밋을 못 읽은 VM 이 있으면 VM 외 사용량은 산정하지 않는다(부분 차이는 거짓)');
  const top = b.topOff.map((v) => [v.name, v.storageGB]);
  assert.deepEqual(top, [['off1', 50], ['zero', 0], ['offNull', null]], '값 있는 것 먼저 · 미상은 null 그대로(0 GB 로 보이지 않게)');
  // 판정 문장이 뺀 사실을 말한다
  const a = analyzeDiskTrend({ points: [], breakdown: b, now: NOW });
  const rec = a.verdicts.find((v) => v.key === 'reclaim');
  assert.match(rec.detail, /용량을 읽지 못한 정지 VM 1대는 이 수치에서 뺐습니다/);
  // 전부 읽은 입력은 예전과 같다(diskTrend2446 픽스처와 같은 산수)
  const b2 = diskBreakdown(vms.filter((v) => !/Null|on2/.test(v.name)), ds, { now: NOW });
  assert.equal(b2.vm.storageUnknown, 0); assert.equal(b2.vm.uncommittedUnknown, 0);
  assert.equal(b2.other.gb, 1500 - 450);
});

/* ── ④ guestOsAgg ── */
test('C-01 ④ aggregateGuestOs — storageGB null 은 diskGB 합에서 빠지고 storageUnknown 으로 센다', () => {
  const fam = (os) => (/windows/i.test(os || '') ? 'Windows' : 'Linux');
  const r = aggregateGuestOs([
    { vcenterId: 'vc-a', guestOS: 'Windows Server 2019', powerState: 'POWERED_ON', cpuCount: 4, memMB: 8192, storageGB: 100 },
    { vcenterId: 'vc-a', guestOS: 'Windows Server 2019', powerState: 'POWERED_ON', cpuCount: 2, memMB: 4096, storageGB: null },
    { vcenterId: 'vc-a', guestOS: 'Ubuntu 22.04', powerState: 'POWERED_ON', cpuCount: 8, memMB: 16384, storageGB: 0 },
  ], fam);
  const win = r.items.find((i) => i.os === 'Windows Server 2019');
  assert.equal(win.diskGB, 100); assert.equal(win.storageUnknown, 1);
  const ubu = r.items.find((i) => i.os === 'Ubuntu 22.04');
  assert.equal(ubu.diskGB, 0); assert.equal(ubu.storageUnknown, 0, '보고된 0 은 값');
  assert.equal(r.storageUnknown, 1);
});

/* ── ⑤ zombies ── */
test('C-01 ⑤ computeZombies — 정지 VM·템플릿의 null 용량은 합계에서 빠지고 개수로 밝힌다(목록은 null 그대로)', () => {
  const r = computeZombies({ vms: [
    { id: 'a:1', name: 'off-null', vcenterId: 'a', powerState: 'POWERED_OFF', connectionState: 'connected', storageGB: null },
    { id: 'a:2', name: 'off-200', vcenterId: 'a', powerState: 'POWERED_OFF', connectionState: 'connected', storageGB: 200 },
    { id: 'a:3', name: 'off-0', vcenterId: 'a', powerState: 'POWERED_OFF', connectionState: 'connected', storageGB: 0 },
    { id: 'a:4', name: 'tpl-null', vcenterId: 'a', powerState: 'POWERED_OFF', template: true, storageGB: null },
    { id: 'a:5', name: 'tpl-80', vcenterId: 'a', powerState: 'POWERED_OFF', template: true, storageGB: 80 },
    { id: 'a:6', name: 'hog', vcenterId: 'a', powerState: 'POWERED_ON', connectionState: 'connected', storageGB: 100, snapshotCount: 2, snapshotSizeGB: 40, snapshotOldestTs: NOW - 30 * 86_400_000 },
  ] }, { now: NOW });
  assert.equal(r.summary.poweredOffGB, 200);
  assert.equal(r.summary.poweredOffStorageUnknown, 1);
  assert.equal(r.summary.templateGB, 80);
  assert.equal(r.summary.templateStorageUnknown, 1);
  assert.equal(r.summary.reclaimableGB, 200 + 40, '회수 가능도 읽은 정지 VM 만');
  assert.deepEqual(r.poweredOff.map((v) => [v.name, v.storageGB]), [['off-200', 200], ['off-0', 0], ['off-null', null]], '값 있는 것 먼저 · null 그대로');
  assert.equal(r.templates[0].name, 'tpl-80');
});

/* ── ⑥ unprotected ── */
test('C-01 ⑥ computeUnprotected — 목록의 storageGB null 은 0 으로 바뀌지 않고 정렬은 값 있는 것 먼저', () => {
  const r = computeUnprotected([
    { id: '1', name: 'web-01', vcenterId: 'a', powerState: 'POWERED_ON', storageGB: null },
    { id: '2', name: 'db-01', vcenterId: 'a', powerState: 'POWERED_ON', storageGB: 20 },
    { id: '3', name: 'zero', vcenterId: 'a', powerState: 'POWERED_ON', storageGB: 0 },
  ], [], { now: NOW });
  assert.deepEqual(r.unprotected.map((v) => [v.name, v.storageGB]), [['db-01', 20], ['zero', 0], ['web-01', null]]);
});

/* ── ⑦ vmExport CSV 열 ── */
test('C-01 ⑦ VM 내보내기 "스토리지 프로비저닝(GB)" — 한쪽이라도 못 읽었으면 빈 칸(0 으로 합치지 않는다)', () => {
  const col = VM_EXPORT_COLUMNS.find((c) => c.key === 'storageProvisionedGB');
  assert.equal(col.get({ storageGB: null, uncommittedGB: 10 }), '');
  assert.equal(col.get({ storageGB: 10, uncommittedGB: null }), '');
  assert.equal(col.get({ storageGB: 10, uncommittedGB: 5 }), 15);
  assert.equal(col.get({ storageGB: 0, uncommittedGB: 0 }), 0, '보고된 0 은 값');
  assert.equal(VM_EXPORT_COLUMNS.find((c) => c.key === 'storageUsedGB').get({ storageGB: null }), '');
});

/* ── ⑧ 실제 api 라우터 — 인벤토리 합계·VM 목록·낭비·thin·guest-os·zombies·disk-history·공개 API ── */
function runLive(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2727c-live-'));
  const boot = `
    const express = (await import('express')).default;
    const { store } = await import(${JSON.stringify(path.join(SRC, 'store.js'))});
    const v1 = (await import(${JSON.stringify(path.join(SRC, 'routes/publicApi.js'))})).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const keys = await import(${JSON.stringify(path.join(SRC, 'publicapi/keys.js'))});
    await store.refresh({ force: true });
    const app = express();
    app.use('/api/v1', v1);
    app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const get = async (p, key) => { const r = await fetch(base + p, { headers: key ? { 'X-Api-Key': key } : {} }); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };
    const out = await (async () => { ${script} })();
    srv.close();
    console.log('@@' + JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', boot], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' },
    encoding: 'utf8', cwd: ROOT, timeout: 180_000,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr?.slice(-1500)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력에 결과가 없습니다: ${r.stdout.slice(-800)}`);
  return JSON.parse(line.slice(2));
}

test('C-01 ⑧ 실제 라우터 — 결측 VM 수가 응답마다 실리고 합계는 읽은 VM 만이다(변경 전후 대조)', () => {
  const r = runLive(`
    const snap = store.get();
    const real = snap.vms.filter((v) => !v.template);
    const off = real.filter((v) => v.powerState === 'POWERED_OFF' && v.storageGB > 0).slice(0, 2);
    const on = real.find((v) => v.powerState === 'POWERED_ON' && v.storageGB > 0 && !off.includes(v));
    const thin = real.find((v) => v.thin && v.uncommittedGB > 0 && v.storageGB > 0 && !off.includes(v) && v !== on);
    const removed = off[0].storageGB + off[1].storageGB + on.storageGB;
    const k = keys.issueApiKey({ name: 'c', groups: ['inventory'] }).plaintext;
    // 변경 전(모두 읽은 스냅샷) — memoJson 은 스냅샷 세대 키라 뒤 요청은 generatedAt 을 바꿔 새로 계산하게 한다.
    const before = {
      summary: (await get('/api/summary')).body, vms: (await get('/api/vms?limit=1')).body,
      waste: (await get('/api/tools/waste')).body, thin: (await get('/api/tools/thin-vms')).body, pub: (await get('/api/v1/inventory/summary', k)).body,
    };
    for (const v of [...off, on]) { v.storageGB = null; v.uncommittedGB = null; }   // 못 읽음 3대(정지 2 · 구동 1)
    if (thin) thin.uncommittedGB = null;                                                 // 미커밋만 못 읽음 1대
    snap.generatedAt = new Date(Date.parse(snap.generatedAt) + 1000).toISOString();
    const summary = (await get('/api/summary')).body;
    const vms = (await get('/api/vms?limit=1')).body;
    const waste = (await get('/api/tools/waste')).body;
    const thinR = (await get('/api/tools/thin-vms')).body;
    const guest = (await get('/api/tools/guest-os')).body;
    const guestVms = (await get('/api/tools/guest-os/vms?power=off')).body;
    const zomb = (await get('/api/tools/report/zombies')).body;
    const disk = (await get('/api/tools/capacity/disk-history?days=7')).body;
    const pub = (await get('/api/v1/inventory/summary', k)).body;
    return {
      ids: [...off, on].map((v) => v.id), thinId: thin ? thin.id : null, removed, thinUncommitted: thin ? thin.uncommittedGB : null,
      before: { provTB: before.summary.allocation.provisionedStorageTB, beforeUnknown: before.summary.allocation.vmStorageUnknown,
        diskGB: before.vms.totals.diskGB, offGB: before.waste.poweredOff.storageGB, thinGB: before.waste.thinReclaim.reclaimableGB,
        thinProvTB: before.thin.provisionedTB, pubProv: before.pub.data.vmProvisionedGB, pubUnknown: before.pub.data.vmStorageUnknown },
      summary: { alloc: summary.allocation, byVcUnknown: summary.byVcenter.reduce((a, x) => a + (x.vmStorageUnknown || 0), 0),
        osUnknown: (summary.osAllocation || []).reduce((a, x) => a + (x.storageUnknown || 0), 0) },
      vmsTotals: vms.totals,
      waste: { off: waste.poweredOff, thin: waste.thinReclaim, byVc: waste.byVcenter },
      thin: { storageUnknown: thinR.storageUnknown, uncommittedUnknown: thinR.uncommittedUnknown, nullProv: thinR.items.filter((x) => x.provisionedGB == null).length,
        provTB: thinR.provisionedTB },
      guest: { storageUnknown: guest.storageUnknown, itemUnknown: guest.items.reduce((a, x) => a + (x.storageUnknown || 0), 0) },
      guestVmsNull: guestVms.items.filter((x) => x.diskGB == null).map((x) => x.name),
      zomb: zomb.summary,
      disk: disk.breakdown && disk.breakdown.vm,
      pub: pub && pub.data,
    };
  `);
  const unknownCount = 3;
  const b = r.before;
  assert.equal(b.beforeUnknown, 0, '목 스냅샷은 전부 읽은 상태'); assert.equal(b.pubUnknown, 0);
  // /summary — 합계는 읽은 VM 만(변경 전 − 뺀 3대의 용량), 뺀 수는 세 곳에 실린다
  assert.equal(r.summary.alloc.vmStorageUnknown, unknownCount, 'allocation.vmStorageUnknown');
  assert.equal(r.summary.byVcUnknown, unknownCount, 'byVcenter[].vmStorageUnknown 합');
  assert.equal(r.summary.osUnknown, unknownCount, 'osAllocation[].storageUnknown 합');
  assert.ok(Math.abs((b.provTB - r.summary.alloc.provisionedStorageTB) * 1024 - r.removed) <= 1024 * 0.11,
    `프로비저닝 합계가 뺀 VM 용량만큼 줄어야 한다: 전 ${b.provTB}TB 후 ${r.summary.alloc.provisionedStorageTB}TB 뺀 ${r.removed}GB`);
  // /vms totals
  assert.equal(r.vmsTotals.storageUnknown, unknownCount);
  assert.equal(r.vmsTotals.diskGB, b.diskGB - r.removed, '/vms totals.diskGB 는 읽은 VM 만');
  // /tools/waste
  assert.equal(r.waste.off.storageUnknown, 2, '정지 VM 중 못 읽은 2대');
  assert.equal(r.waste.byVc.reduce((a, e) => a + (e.poweredOffStorageUnknown || 0), 0), 2);
  const nullRows = r.waste.off.vms.filter((v) => v.storageGB == null);
  assert.ok(nullRows.length <= 2 && nullRows.every((v) => r.ids.includes(v.id)), '목록의 null 은 그 VM 뿐이고 0 으로 바뀌지 않는다');
  if (r.thinId) {
    assert.equal(r.waste.thin.uncommittedUnknown, 1, 'thin VM 의 미커밋 결측');
    assert.equal(r.waste.thin.reclaimableGB, b.thinGB - r.thinUncommitted, 'Thin 회수 가능은 읽은 VM 만');
    assert.equal(r.thin.uncommittedUnknown, 1);
    assert.equal(r.thin.nullProv, 1, 'thin-vms: 미커밋을 모르면 할당도 모른다');
    assert.ok(r.thin.provTB <= b.thinProvTB, 'thin-vms 할당 합계는 줄거나 같다(0 으로 채우지 않는다)');
  }
  // /tools/guest-os
  assert.equal(r.guest.storageUnknown, unknownCount);
  assert.equal(r.guest.itemUnknown, unknownCount);
  assert.equal(r.guestVmsNull.length, 2, 'guest-os/vms?power=off 의 diskGB null 은 정지 2대뿐');
  // zombies
  assert.equal(r.zomb.poweredOffStorageUnknown, 2);
  // disk-history breakdown
  assert.ok(r.disk, 'disk-history 가 breakdown 을 돌려준다');
  assert.equal(r.disk.storageUnknown, unknownCount);
  assert.equal(r.disk.uncommittedUnknown, r.thinId ? 1 : 0);
  // 공개 API — 선언 필드 그대로, 내부와 같은 수
  assert.equal(r.pub.vmStorageUnknown, unknownCount);
  assert.equal(r.pub.vmProvisionedGB, b.pubProv - r.removed, '공개 API vmProvisionedGB 는 뺀 VM 용량만큼 줄어든다');
  assert.ok(Math.abs(r.pub.vmProvisionedGB / 1024 - r.summary.alloc.provisionedStorageTB) <= 0.06, '공개 API 와 내부 /summary 가 같은 값');
});

/* ── ⑨ 공개 API 계약·문서 ── */
test('C-01 ⑨ 공개 API allowlist·문서에 vmStorageUnknown 이 선언돼 있다(투사 계약 — 선언 없는 필드는 나가지 않는다)', () => {
  const ep = ENDPOINTS.find((e) => e.path === '/inventory/summary');
  assert.ok(ep.fields.includes('vmStorageUnknown'));
  const doc = fs.readFileSync(path.join(ROOT, '..', 'docs', 'API-PUBLIC.md'), 'utf8');
  assert.match(doc, /`vmStorageUnknown`/);
});

/* ── ⑩ 소스 스윕 — 소비처에 `storageGB || 0` 류가 남아 있지 않다 ── */
test('C-01 ⑩ 소스 스윕 — 소비처 10곳에 VM 스토리지 결측을 0 으로 접는 꼴이 없다', () => {
  const files = ['metrics/sampler.js', 'tools/diskTrend.js', 'inventory/guestOsAgg.js', 'reports/zombies.js', 'reports/unprotected.js',
    'vcenter/vmExport.js', 'routes/api/inventory.js', 'routes/api/toolsCapacity.js', 'routes/api/toolsInfo.js', 'routes/publicApi.js'];
  const bad = /(?:Number\((?:v|vm|x)\.(?:storageGB|uncommittedGB)\)\s*\|\|\s*0)|(?:(?:v|vm|x)\.(?:storageGB|uncommittedGB)\s*\|\|\s*0)|(?:num\((?:v|vm|x)\.(?:storageGB|uncommittedGB)\))/;
  for (const f of files) {
    const src = fs.readFileSync(path.join(SRC, f), 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const m = src.match(bad);
    assert.equal(m, null, `${f}: ${m && m[0]}`);
  }
});

/* ── ⑪ E-12 GPU VRAM — 서버 소비처는 null 을 지킨다 ── */
test('E-12 ⑪ summarizeHostGpu — memGB 를 보고하지 않은 카드가 있으면 capacityGB 는 null(0 아님)', () => {
  const host = { id: 'h1', gpus: [{ model: 'NVIDIA A40', memGB: null, mode: 'vgpu' }] };
  const s = summarizeHostGpu(host, [], new Map(), { now: NOW });
  assert.equal(s.capacityGB, null);
  assert.equal(s.allocCapacityGB, null);
  const s2 = summarizeHostGpu({ id: 'h2', gpus: [{ model: 'NVIDIA A40', memGB: 45, mode: 'vgpu' }] }, [], new Map(), { now: NOW });
  assert.equal(s2.capacityGB, 45);
});

test('E-12 ⑪-b buildGpuInventory — 호스트 행의 memGB 는 null 그대로 나간다(CSV 는 빈 칸)', async () => {
  const { buildGpuInventory } = await import('../src/routes/api/hardwareGpu.js');
  const snap = { vcenters: [{ id: 'vc1' }], hosts: [
    { id: 'h1', name: 'esx1', vcenterId: 'vc1', cluster: 'c', gpus: [{ model: 'NVIDIA A40', memGB: null, mode: 'vgpu' }] },
    { id: 'h2', name: 'esx2', vcenterId: 'vc1', cluster: 'c', gpus: [{ model: 'NVIDIA A40', memGB: 45, mode: 'vgpu' }] },
  ], vms: [], datastores: [] };
  const inv = buildGpuInventory(snap, 'vc1', null);
  const byHost = Object.fromEntries(inv.items.map((i) => [i.host, i.memGB]));
  assert.equal(byHost.esx1, null);
  assert.equal(byHost.esx2, 45);
  const { guardCell } = await import('../src/util/csv.js');
  assert.equal(guardCell(null), '', 'CSV 셀은 빈 칸');
});

test.after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });
