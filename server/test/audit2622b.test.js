/**
 * audit2622b.test.js — v2.622 감사 그룹 B 회귀 고정(RECENT-01·02, LEFT-04, DATA-04·05).
 *
 *  RECENT-01 점검중(maintenance) vCenter 하나가 전체('') VM·디스크 합계 적재를 기한 없이 막던 것
 *  RECENT-02 일일 헬스체크의 '사용량 미상 DS' 가 store 롤업 기준과 달라 용량 0 DS 하나로 종합이 '확인 불가' 가 되던 것
 *  LEFT-04   라이트사이징 누적(updateVmStats)이 적재에서 뺀 vCenter 의 동결 VM 값을 매 분 누적하던 것
 *  DATA-04   디스크 트렌드가 사용량 미상 DS 를 분모에서만 빼 오버서브스크립션·회수 비율이 부풀던 것
 *  DATA-05   미보호 VM 리포트가 이벤트를 수집하지 않은 vCenter 의 VM 을 전부 '미보호' 로 세던 것
 *
 * 기준 시각은 Date.now() 를 쓰지 않는다 — 정시에서 떨어뜨린 고정 시각(CLAUDE.md v2.517 규약).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2622b-'));
process.env.CONFIG_DIR = DIR;
process.env.TEMP_DB_PATH = path.join(DIR, 'host-temp.db');

const MIN = 60_000;
const NOW = Date.UTC(2026, 8, 20, 3, 30, 0);   // 2026-09-20 03:30:00Z — 정시에서 30분 떨어진 과거

const sampler = await import('../src/metrics/sampler.js');
const vmStats = await import('../src/reports/vmStats.js');
const { computeHealthReport } = await import('../src/reports/healthReport.js');
const { diskBreakdown, analyzeDiskTrend } = await import('../src/tools/diskTrend.js');
const { computeUnprotected } = await import('../src/reports/unprotected.js');

const snapOf = (vcs) => ({
  vcenters: vcs,
  hosts: vcs.map((vc) => ({ id: `h-${vc.id}`, vcenterId: vc.id, name: `esx-${vc.id}`, cluster: 'c1', cpuCores: 10, cpuTotalMhz: 20000 })),
  vms: vcs.map((vc) => ({ id: `v-${vc.id}`, vcenterId: vc.id, host: `esx-${vc.id}`, powerState: 'POWERED_ON', memMB: 4096, memUsagePct: 50, cpuCount: 2, cpuUsagePct: 40, storageGB: 10 })),
  datastores: vcs.map((vc) => ({ id: `d-${vc.id}`, vcenterId: vc.id, capacityGB: 100, usedGB: 50 })),
  alarms: [],
});
const ALL = { enabled: true, vcenterIds: [], trackTotal: true };

/* ── RECENT-01 ──────────────────────────────────────────────────────────── */

test('RECENT-01 점검중 vCenter 는 전체(\'\') 합계를 막지 않는다 — 그 행만 빼고 부분 합 표식을 싣는다', () => {
  const r = sampler.vmAllocRows(snapOf([{ id: 'a', status: 'connected' }, { id: 'b', status: 'maintenance', maintenance: true }]), ALL);
  assert.equal(r.has('b'), false, '점검중 vCenter 의 동결 값이 적재됐다');
  assert.ok(r.has('a'));
  assert.ok(r.has(''), '점검중 vCenter 하나로 전체 합계가 사라졌다');
  assert.equal(r.totalWithheld, false);
  assert.equal(r.totalPartial, true);
  assert.equal(r.maintenanceExcluded, 1);
  // 전체 합계에는 점검중 vCenter 의 값이 들어가지 않는다(a 의 값과 같다)
  const tot = Object.fromEntries(r.get('').map((x) => [x.metric, x.v]));
  const a = Object.fromEntries(r.get('a').map((x) => [x.metric, x.v]));
  assert.equal(tot.vm_mem_alloc_mb, a.vm_mem_alloc_mb);
});

test('RECENT-01 수집 실패(unreachable)·낡은 위임은 예전처럼 전체 합계를 보류한다', () => {
  const r = sampler.vmAllocRows(snapOf([{ id: 'a', status: 'connected' }, { id: 'b', status: 'maintenance' }, { id: 'c', status: 'unreachable', stale: true }]), ALL);
  assert.equal(r.has(''), false);
  assert.equal(r.totalWithheld, true);
  assert.equal(r.staleVcenters, 1);
  assert.equal(r.maintenanceExcluded, 1);
});

/* ── RECENT-02 ──────────────────────────────────────────────────────────── */

test('RECENT-02 용량 0 DS 는 사용량 미상으로 세지 않는다(store 롤업과 같은 기준)', () => {
  const rep = computeHealthReport({
    vcenters: [{ id: 'v1', status: 'connected' }], hosts: [], vms: [], alarms: [],
    datastores: [{ name: 'nfs0', vcenterId: 'v1', capacityGB: 0, usedGB: null, freeGB: null, usagePct: null },
      { name: 'ok', vcenterId: 'v1', capacityGB: 100, usedGB: 10, usagePct: 10 }],
  }, { now: NOW });
  assert.equal(rep.summary.unknown.dsUsageUnknown, 0);
  assert.equal(rep.sections.find((s) => s.key === 'datastores').status, 'ok');
  assert.equal(rep.overall, 'ok');
});

test('RECENT-02 usagePct 가 없어도 used/free 로 계산해 임계를 판정하고, used·free 가 둘 다 없으면 미상으로 센다', () => {
  const rep = computeHealthReport({
    vcenters: [{ id: 'v1', status: 'connected' }], hosts: [], vms: [], alarms: [],
    datastores: [
      { name: 'freeOnly', vcenterId: 'v1', capacityGB: 100, usedGB: null, freeGB: 4, usagePct: null },  // 96% → crit
      { name: 'unk', vcenterId: 'v1', capacityGB: 100, usedGB: null, freeGB: null, usagePct: null },
    ],
  }, { now: NOW });
  const ds = rep.sections.find((s) => s.key === 'datastores');
  assert.equal(ds.count, 1);
  assert.equal(ds.items[0].usagePct, 96);
  assert.equal(ds.status, 'crit');
  assert.equal(rep.summary.unknown.dsUsageUnknown, 1);
});

/* ── LEFT-04 ────────────────────────────────────────────────────────────── */

test('LEFT-04 updateVmStats 는 skipVcenterIds 의 VM 을 누적하지 않는다', () => {
  vmStats._resetVmStats();
  const vm = (pct) => ({ vcenterId: 'm', id: 'vm-m', powerState: 'POWERED_ON', cpuUsagePct: pct, memUsagePct: pct });
  for (let i = 0; i < 60; i++) vmStats.updateVmStats({ vms: [vm(10)] }, NOW + i * MIN);
  let skipped = 0;
  for (let i = 0; i < 240; i++) skipped += vmStats.updateVmStats({ vms: [vm(95)] }, NOW + (60 + i) * MIN, { skipVcenterIds: new Set(['m']) }).skipped;
  const st = vmStats.vmStatsFor('vm-m');
  assert.equal(st.samples, 60, '동결 값이 표본으로 쌓였다');
  assert.equal(st.cpuAvg, 10);
  assert.equal(skipped, 240);
});

test('LEFT-04 실제 샘플 경로 — 점검중 vCenter VM 은 누적되지 않고 lastRun.vmStatsSkipped 로 밝힌다', async () => {
  vmStats._resetVmStats();
  const { store } = await import('../src/store.js');
  store.snapshot = snapOf([{ id: 'l4-maint', status: 'maintenance', maintenance: true }, { id: 'l4-ok', status: 'connected' }]);
  await sampler._sampleOnceForTest();
  assert.equal(vmStats.vmStatsFor('v-l4-maint'), null, '점검중 vCenter VM 이 누적됐다');
  assert.ok(vmStats.vmStatsFor('v-l4-ok'));
  assert.equal(sampler.metricsSamplerStatus().lastRun?.vmStatsSkipped, 1);
});

/* ── DATA-04 ────────────────────────────────────────────────────────────── */

test('DATA-04 사용량 미상 DS 가 있으면 할당 비율 분모는 용량을 아는 DS 전체이고 사용량 대비 비율은 null', () => {
  const dss = [
    { id: 'd1', vcenterId: 'v', capacityGB: 10000, usedGB: 6000, freeGB: 4000 },
    { id: 'd2', vcenterId: 'v', capacityGB: 10000, usedGB: null, freeGB: null },
  ];
  const vms = [
    { id: 'a', powerState: 'POWERED_ON', storageGB: 6000, uncommittedGB: 1500 },
    { id: 'b', powerState: 'POWERED_OFF', storageGB: 6000, uncommittedGB: 1500 },
  ];
  const b = diskBreakdown(vms, dss, { now: NOW });
  assert.equal(b.ds.usageUnknown, 1);
  assert.equal(b.vm.overcommitPct, 75);          // 15000 / 20000 (예전 150)
  assert.equal(b.vm.committedPctOfCap, 60);
  assert.equal(b.vm.capBasisGB, 20000);
  assert.equal(b.reclaim.pctOfUsed, null);
  assert.equal(b.reclaim.afterReclaimUsagePct, null);
  assert.equal(b.reclaim.ratioUnavailable, 'ds-usage-unknown');
  const t = analyzeDiskTrend({ points: [], breakdown: b, now: NOW });
  const flat = JSON.stringify(t);
  assert.ok(!flat.includes('오버서브스크립션 — 할당(프로비저닝)이 용량의 150%'));
  assert.ok(!/null%/.test(flat), '문장에 null 이 샜다');
  assert.ok(flat.includes('사용량 대비 비율·회수 후 사용률은 계산하지 않았습니다'));
});

test('DATA-04 사용량이 전부 읽히면 예전 계산 그대로', () => {
  const b = diskBreakdown([{ id: 'a', powerState: 'POWERED_OFF', storageGB: 100, uncommittedGB: 0 }],
    [{ id: 'd1', capacityGB: 1000, usedGB: 400 }], { now: NOW });
  assert.equal(b.vm.overcommitPct, 10);
  assert.equal(b.reclaim.pctOfUsed, 25);
  assert.equal(b.reclaim.afterReclaimUsagePct, 30);
  assert.equal(b.reclaim.ratioUnavailable, undefined);
});

/* ── DATA-05 ────────────────────────────────────────────────────────────── */

const vmsU = [
  { id: '1', name: 'c1', vcenterId: 'central-vc', powerState: 'POWERED_ON', storageGB: 10 },
  { id: '2', name: 's1', vcenterId: 'site-vc', powerState: 'POWERED_ON', storageGB: 10 },
  { id: '3', name: 's2', vcenterId: 'site-vc', powerState: 'POWERED_ON', storageGB: 10 },
];
const rowsU = [{ type: 'VmSnapshotCreated Snapshot', user: 'svc-veeam', entity: 'c1', vcenterId: 'central-vc', ts: NOW }];

test('DATA-05 이벤트가 저장되지 않은 vCenter 의 VM 은 미보호가 아니라 판정 불가', () => {
  const r = computeUnprotected(vmsU, rowsU, { coveredVcenterIds: new Set(['central-vc']) });
  assert.equal(r.summary.protectedCount, 1);
  assert.equal(r.summary.unprotectedCount, 0);
  assert.equal(r.summary.undeterminedCount, 2);
  assert.deepEqual(r.summary.undeterminedByReason, { 'no-events': 2 });
  assert.deepEqual(r.summary.noEventVcenters, ['site-vc']);
  assert.equal(r.summary.protectedPct, 100);
  assert.equal(r.undetermined.length, 2);
});

test('DATA-05 로그 수집이 꺼졌거나 info 를 저장하지 않으면 미확인 VM 전부 판정 불가 · 비율 null', () => {
  const off = computeUnprotected(vmsU.slice(1), [], { logSettings: { enabled: false, minSeverity: 'info' } });
  assert.equal(off.summary.unprotectedCount, 0);
  assert.deepEqual(off.summary.undeterminedByReason, { 'log-collection-off': 2 });
  assert.equal(off.summary.protectedPct, null);
  const sev = computeUnprotected(vmsU.slice(1), [], { logSettings: { enabled: true, minSeverity: 'warning' } });
  assert.deepEqual(sev.summary.undeterminedByReason, { 'severity-filter': 2 });
});

test('DATA-05 커버리지 근거가 없으면 예전 판정 그대로(진짜 백업 공백을 숨기지 않는다)', () => {
  const r = computeUnprotected(vmsU, rowsU, {});
  assert.equal(r.summary.unprotectedCount, 2);
  assert.equal(r.summary.undeterminedCount, 0);
  assert.equal(r.summary.coverageKnown, false);
  assert.equal(r.summary.protectedPct, 33);
});
