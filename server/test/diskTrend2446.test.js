// 디스크 트렌드(v2.446) — 할당/사용/회수 가능 정의, 판정 규칙, 증가율·ETA, 샘플러 집계 행.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diskBreakdown, analyzeDiskTrend, slopeOf, CITATIONS, DEFAULT_POLICY, diskTrendPolicyFromEnv } from '../src/tools/diskTrend.js';
import { vmAllocRows } from '../src/metrics/sampler.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-09T12:00:00Z');

const vm = (o) => ({ id: `vc-a:${o.name}`, vcenterId: 'vc-a', powerState: 'POWERED_ON', storageGB: 100, uncommittedGB: 0, snapshotCount: 0, snapshotSizeGB: 0, ...o });
const DS = [
  { id: 'vc-a:ds1', vcenterId: 'vc-a', capacityGB: 1000, usedGB: 600, freeGB: 400, usagePct: 60 },
  { id: 'vc-a:ds2', vcenterId: 'vc-a', capacityGB: 1000, usedGB: 900, freeGB: 100, usagePct: 90 },
  { id: 'vc-a:ds0', vcenterId: 'vc-a', capacityGB: 0, usedGB: 0, freeGB: 0 }, // 용량 미상 → 제외
];
const VMS = [
  vm({ name: 'on1', storageGB: 400, uncommittedGB: 600, thin: true }),           // 할당 1000
  vm({ name: 'on2', storageGB: 300, snapshotCount: 2, snapshotSizeGB: 40, snapshotOldestTs: NOW - 10 * DAY }),
  vm({ name: 'off1', powerState: 'POWERED_OFF', storageGB: 200 }),
  vm({ name: 'off2', powerState: 'POWERED_OFF', storageGB: 50, snapshotCount: 1, snapshotSizeGB: 5, snapshotOldestTs: NOW - 3_600_000 }),
  vm({ name: 'tpl', template: true, storageGB: 80 }),
];

test('할당 = committed+uncommitted, 사용 = DS 점유, 회수 가능 = 정지 VM + 스냅샷', () => {
  const b = diskBreakdown(VMS, DS, { now: NOW });
  assert.equal(b.ds.count, 2, '용량 미상 DS 제외');
  assert.equal(b.ds.capGB, 2000); assert.equal(b.ds.usedGB, 1500); assert.equal(b.ds.usagePct, 75);
  assert.equal(b.ds.warnCount, 0); assert.equal(b.ds.critCount, 1, 'ds2 90% 는 위험');
  assert.equal(b.vm.count, 4, '템플릿 제외'); assert.equal(b.vm.templates, 1);
  assert.equal(b.vm.committedGB, 950); assert.equal(b.vm.uncommittedGB, 600); assert.equal(b.vm.provGB, 1550);
  assert.equal(b.vm.overcommitPct, 77.5); assert.equal(b.vm.thinCount, 1);
  assert.equal(b.reclaim.off.count, 2); assert.equal(b.reclaim.off.gb, 250);
  assert.equal(b.reclaim.snap.count, 2); assert.equal(b.reclaim.snap.gb, 45);
  assert.equal(b.reclaim.totalGB, 295);
  assert.equal(b.reclaim.pctOfUsed, 19.7);
  assert.equal(b.reclaim.afterReclaimUsagePct, 60.3, '(1500-295)/2000');
  // VM 외 사용량 = 1500 − 950 − 80(템플릿)
  assert.equal(b.other.gb, 470);
  assert.equal(b.vm.templateGB, 80);
});

test('72시간 넘은 스냅샷만 "오래된" 으로 센다 — 생성시각 미상은 제외하고 개수로 알린다', () => {
  const b = diskBreakdown(VMS.concat([vm({ name: 'unk', snapshotCount: 1, snapshotSizeGB: 7 })]), DS, { now: NOW });
  assert.equal(b.reclaim.snapOld.count, 1, 'on2(10일) 만');
  assert.equal(b.reclaim.snapOld.gb, 40);
  assert.equal(b.reclaim.snapOld.unknownAge, 1);
  assert.equal(b.reclaim.snapOld.maxHours, 72);
});

test('VM 외 사용량이 음수(범위 밖 VM 이 DS 를 씀)면 null — 지어내지 않는다', () => {
  const b = diskBreakdown([vm({ name: 'big', storageGB: 5000 })], DS, { now: NOW });
  assert.equal(b.other.gb, null);
});

test('상위 목록: 정지 VM 은 커밋 순, 스냅샷은 크기 순 + 나이(일)', () => {
  const b = diskBreakdown(VMS, DS, { now: NOW });
  assert.deepEqual(b.topOff.map((v) => v.name), ['off1', 'off2']);
  assert.deepEqual(b.topSnap.map((v) => [v.name, v.ageDays]), [['on2', 10], ['off2', 0]]);
});

const series = (n, startUsed, perDay, extra = {}) => Array.from({ length: n }, (_, i) => ({
  ts: NOW - (n - 1 - i) * DAY, dsCapGB: 2000, dsUsedGB: startUsed + perDay * i,
  provGB: 1550 + i, usedGB: 900 + perDay * i, offGB: 250, snapGB: 45, reclaimGB: 295, ...extra,
}));

test('증가율은 최소제곱 기울기, 예상일은 (임계 − 현재) ÷ 증가율', () => {
  const b = diskBreakdown(VMS, DS, { now: NOW });                 // 사용 1500 / 2000 (75%)
  const a = analyzeDiskTrend({ points: series(15, 1360, 10), breakdown: b, days: 30, now: NOW });
  assert.equal(a.growth.usedGBperDay, 10);
  assert.equal(a.growth.samples, 15);
  assert.equal(a.eta.daysToCrit, 20, '(1700-1500)/10');
  assert.equal(a.eta.daysToFull, 50);
  assert.equal(a.eta.daysToWarn, 0, '이미 75%');
  assert.equal(a.eta.daysGainedByReclaim, 30, '295/10 ≈ 30');
  const eta = a.verdicts.find((v) => v.key === 'eta');
  assert.equal(eta.level, 'crit', '20일 ≤ 30일 → 위험');
  assert.equal(a.worst, 'crit');
});

test('표본이 정책 하한 미만이면 증가율을 산정하지 않고 이유를 준다', () => {
  const b = diskBreakdown(VMS, DS, { now: NOW });
  const a = analyzeDiskTrend({ points: series(2, 1400, 10), breakdown: b, days: 7, now: NOW });
  assert.equal(a.growth.usedGBperDay, null);
  assert.match(a.growth.reason, /표본 2점/);
  assert.equal(a.verdicts.find((v) => v.key === 'eta').level, 'insufficient');
  assert.equal(a.eta.daysToCrit, null);
  const a0 = analyzeDiskTrend({ points: [], breakdown: b, days: 7, now: NOW });
  assert.match(a0.growth.reason, /아직 없습니다/);
});

test('사용량이 줄면 예상일 없음·정상, 증가율 음수 표기', () => {
  const b = diskBreakdown(VMS, DS, { now: NOW });
  const a = analyzeDiskTrend({ points: series(10, 1600, -5), breakdown: b, days: 30, now: NOW });
  assert.equal(a.growth.usedGBperDay, -5);
  assert.equal(a.eta.daysToCrit, null);
  assert.equal(a.verdicts.find((v) => v.key === 'eta').level, 'ok');
});

test('thin 오버서브스크립션(할당 > 용량)은 경고, 미커밋은 회수 가능으로 세지 않는다', () => {
  const vms = [vm({ name: 'thin', storageGB: 500, uncommittedGB: 2000, thin: true })];
  const b = diskBreakdown(vms, DS, { now: NOW });
  assert.equal(b.vm.provGB, 2500); assert.equal(b.vm.overcommitPct, 125);
  assert.equal(b.reclaim.totalGB, 0);
  const a = analyzeDiskTrend({ points: [], breakdown: b, days: 30, now: NOW });
  const o = a.verdicts.find((v) => v.key === 'oversub');
  assert.equal(o.level, 'warn');
  assert.match(o.detail, /회수 가능.*이 아니라/);
  assert.ok(o.cite.includes('vsphere-oversub'));
});

test('사용률 판정선은 vCenter 기본 알람(75/85) 이고 env 로 바꿀 수 있다', () => {
  const b = diskBreakdown(VMS, DS, { now: NOW }); // 75%
  const a = analyzeDiskTrend({ points: [], breakdown: b, days: 30, now: NOW });
  assert.equal(a.verdicts.find((v) => v.key === 'usage').level, 'warn');
  const p = diskTrendPolicyFromEnv({ DISKTREND_WARN_PCT: '80', DISKTREND_CRIT_PCT: '', DISKTREND_SNAPSHOT_MAX_HOURS: 'abc' });
  assert.deepEqual(p, { warnPct: 80 }, '빈 값·비수치는 기본값 유지');
  const b2 = diskBreakdown(VMS, DS, { now: NOW, policy: p });
  const a2 = analyzeDiskTrend({ points: [], breakdown: b2, days: 30, now: NOW, policy: p });
  assert.equal(a2.policy.warnPct, 80); assert.equal(a2.policy.critPct, DEFAULT_POLICY.critPct);
  assert.equal(a2.verdicts.find((v) => v.key === 'usage').level, 'ok', '75% < 80%');
});

test('오래된 스냅샷 경고는 KB 318825 를, VM 외 사용량 힌트는 고아 디스크 KB 를 인용한다', () => {
  const b = diskBreakdown(VMS, DS, { now: NOW });
  const a = analyzeDiskTrend({ points: [], breakdown: b, days: 30, now: NOW });
  const s = a.verdicts.find((v) => v.key === 'snapshot-age');
  assert.equal(s.level, 'warn'); assert.ok(s.cite.includes('kb-snapshot-bp'));
  const o = a.verdicts.find((v) => v.key === 'other');
  assert.ok(o, 'VM 외 470GB(23%) > 5% → 힌트'); assert.ok(o.cite.includes('kb-orphaned'));
  // 인용 id 는 전부 CITATIONS 에 존재해야 화면 번호가 붙는다.
  const ids = new Set(CITATIONS.map((c) => c.id));
  for (const v of a.verdicts) for (const c of v.cite || []) assert.ok(ids.has(c), `미정의 인용 ${c}`);
  assert.ok(CITATIONS.length >= 8);
  for (const c of CITATIONS) assert.match(c.url, /^https:\/\/(techdocs|knowledge)\.broadcom\.com\//);
  assert.ok(a.methodology.length >= 4);
});

test('회수 가능이 0 이면 판정이 정상으로 내려간다', () => {
  const b = diskBreakdown([vm({ name: 'on', storageGB: 100 })], [DS[0]], { now: NOW });
  const a = analyzeDiskTrend({ points: [], breakdown: b, days: 30, now: NOW });
  assert.equal(a.verdicts.find((v) => v.key === 'reclaim').level, 'ok');
});

test('slopeOf: 분산 0·표본 1 은 null', () => {
  assert.equal(slopeOf([1], [1]), null);
  assert.equal(slopeOf([1, 1], [1, 2]), null);
  assert.equal(slopeOf([0, 1, 2], [0, 2, 4]), 2);
});

test('샘플러: VM 디스크 4계열을 전원 무관하게 집계하고 템플릿은 제외한다(vCenter별 + 전체)', () => {
  const snap = {
    hosts: [{ vcenterId: 'vc-a', name: 'h1', cpuCores: 10, cpuTotalMhz: 20000 }],
    vms: VMS.map((v) => ({ ...v, host: 'h1', cpuCount: 2, memMB: 1024, cpuUsagePct: 10, memUsagePct: 10 })),
    datastores: DS,
  };
  const out = vmAllocRows(snap, { enabled: true, vcenterIds: [], trackTotal: true, retentionDays: 30 });
  const rows = out.get('vc-a');
  const m = Object.fromEntries(rows.map((r) => [r.metric, r.v]));
  assert.equal(m.vm_disk_prov_gb, 1550);
  assert.equal(m.vm_disk_used_gb, 950);
  assert.equal(m.vm_disk_off_gb, 250);
  assert.equal(m.vm_snap_gb, 45);
  assert.equal(m.ds_cap_gb_vc, 2000); assert.equal(m.ds_used_gb_vc, 1500);
  const all = Object.fromEntries(out.get('').map((r) => [r.metric, r.v]));
  assert.equal(all.vm_disk_prov_gb, 1550, '전체 합계 키');
  // 기존 CPU/MEM 계열은 전원 On 만 — 회귀 확인(on1·on2 = 4 vCPU × 2000MHz)
  assert.equal(m.vm_cpu_alloc_mhz, 8000);
});
