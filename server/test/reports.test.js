/**
 * 특수기능 리포트 10종(v2.217) 핵심 로직 테스트 — 순수 함수에 fixture를 직접 주입.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { snapshotInfo } from '../src/vcenter/soapParse.js';
import { certExpiryStatus } from '../src/security/certMonitor.js';
import { computeZombies } from '../src/reports/zombies.js';
import { computeRightsizing, suggestSize } from '../src/reports/rightsizing.js';
import { computeCompliance, esxiSupportStatus, hwVersionNum } from '../src/reports/compliance.js';
import { filterChangeEvents, classifyChange } from '../src/reports/changes.js';
import { isBackupEvent, computeUnprotected } from '../src/reports/unprotected.js';
import { computeHealthReport, buildDailyReportText } from '../src/reports/healthReport.js';
import { updateVmStats, vmStatsFor, _resetVmStats } from '../src/reports/vmStats.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-08-04T00:00:00Z');

/* ── snapshotInfo: 생성일 파싱 ── */
const SNAP_XML = `
<currentSnapshot type="VirtualMachineSnapshot">snapshot-100</currentSnapshot>
<rootSnapshotList>
  <VirtualMachineSnapshotTree>
    <snapshot type="VirtualMachineSnapshot">snapshot-99</snapshot>
    <name>pre-patch</name>
    <createTime>2026-07-01T10:00:00Z</createTime>
    <childSnapshotList>
      <VirtualMachineSnapshotTree>
        <snapshot type="VirtualMachineSnapshot">snapshot-100</snapshot>
        <name>after-&amp;-fix</name>
        <createTime>2026-07-20T10:00:00Z</createTime>
      </VirtualMachineSnapshotTree>
    </childSnapshotList>
  </VirtualMachineSnapshotTree>
</rootSnapshotList>`;

test('snapshotInfo: 중첩 트리에서 개수·가장 오래된/최신 생성일·이름을 파싱', () => {
  const r = snapshotInfo(SNAP_XML, '');
  assert.equal(r.snapshotCount, 2);
  assert.equal(r.snapshotOldestTs, Date.parse('2026-07-01T10:00:00Z'));
  assert.equal(r.snapshotNewestTs, Date.parse('2026-07-20T10:00:00Z'));
  assert.deepEqual(r.snapshotNames, ['pre-patch', 'after-&-fix']); // 엔티티 복원 확인
});

test('snapshotInfo: 스냅샷 없음 → 0/nulls (회귀: 기존 필드 유지)', () => {
  const r = snapshotInfo('', '');
  assert.equal(r.snapshotCount, 0);
  assert.equal(r.snapshotSizeGB, 0);
  assert.equal(r.snapshotOldestTs, null);
});

/* ── 인증서 만료 상태 ── */
test('certExpiryStatus: 만료/D-30/D-90/정상 분류', () => {
  assert.equal(certExpiryStatus(NOW - DAY, { now: NOW }).status, 'expired');
  assert.equal(certExpiryStatus(NOW + 10 * DAY, { now: NOW }).status, 'critical');
  assert.equal(certExpiryStatus(NOW + 60 * DAY, { now: NOW }).status, 'expiring');
  assert.equal(certExpiryStatus(NOW + 200 * DAY, { now: NOW }).status, 'ok');
  assert.equal(certExpiryStatus(NaN).status, 'unknown');
  assert.equal(certExpiryStatus(NOW + 60 * DAY, { now: NOW }).daysLeft, 60);
});

/* ── 좀비/방치 리소스 ── */
const zsnap = {
  vms: [
    { id: 'a:1', name: 'orphan-vm', vcenterId: 'a', powerState: 'POWERED_OFF', connectionState: 'orphaned', storageGB: 50 },
    { id: 'a:2', name: 'off-vm', vcenterId: 'a', powerState: 'POWERED_OFF', connectionState: 'connected', storageGB: 200 },
    { id: 'a:3', name: 'tpl', vcenterId: 'a', powerState: 'POWERED_OFF', template: true, storageGB: 80 },
    { id: 'a:4', name: 'snap-hog', vcenterId: 'a', powerState: 'POWERED_ON', connectionState: 'connected', storageGB: 100, snapshotCount: 2, snapshotSizeGB: 40, snapshotOldestTs: NOW - 30 * DAY },
    { id: 'a:5', name: 'ok-vm', vcenterId: 'a', powerState: 'POWERED_ON', connectionState: 'connected', storageGB: 100 },
  ],
};
test('computeZombies: 고아·정지·템플릿·스냅샷 대식가 분류와 회수 용량', () => {
  const r = computeZombies(zsnap, { now: NOW });
  assert.equal(r.orphaned.length, 1);
  assert.equal(r.orphaned[0].name, 'orphan-vm');
  assert.equal(r.poweredOff.length, 1); // 고아·템플릿은 정지 목록에서 제외
  assert.equal(r.templates.length, 1);
  assert.equal(r.snapshotHogs.length, 1);
  assert.equal(r.summary.reclaimableGB, 200 + 40);
});

/* ── 라이트사이징 ── */
test('suggestSize: 피크 기준 여유 목표 축소 추천 (현재보다 크게 추천하지 않음)', () => {
  const s = suggestSize(8, 32, 20, 30); // 피크 CPU 20% → 8*0.2/0.6=2.67→3
  assert.equal(s.suggestedVcpu, 3);
  assert.equal(s.suggestedRamGB, 13);
  const s2 = suggestSize(2, 4, 95, 95);
  assert.ok(s2.suggestedVcpu <= 2 && s2.suggestedRamGB <= 4);
});

test('computeRightsizing: 통계 기반 과대할당 판정 + 통계 부족 시 순간값 폴백', () => {
  const vms = [
    { id: 'v1', name: 'big-idle', vcenterId: 'a', powerState: 'POWERED_ON', cpuCount: 8, memMB: 32768, cpuUsagePct: 2, memUsagePct: 10 },
    { id: 'v2', name: 'oversized', vcenterId: 'a', powerState: 'POWERED_ON', cpuCount: 8, memMB: 16384, cpuUsagePct: 50, memUsagePct: 50 },
    { id: 'v3', name: 'hot', vcenterId: 'a', powerState: 'POWERED_ON', cpuCount: 2, memMB: 4096, cpuUsagePct: 95, memUsagePct: 50 },
  ];
  // v2는 순간값은 50%지만 관측 통계로는 평균 8%·피크 20% → 통계가 이겨야 함.
  const stats = { v2: { samples: 100, cpuAvg: 8, memAvg: 20, cpuMax: 20, memMax: 40, sinceTs: NOW - DAY } };
  const r = computeRightsizing(vms, (id) => stats[id] || null);
  assert.equal(r.idle.length, 1);
  assert.equal(r.idle[0].name, 'big-idle');
  assert.equal(r.oversized.length, 1);
  assert.equal(r.oversized[0].name, 'oversized');
  assert.ok(r.oversized[0].suggestedVcpu < 8);
  assert.equal(r.undersized.length, 1);
  assert.equal(r.undersized[0].name, 'hot');
  assert.ok(r.reclaimableVcpu > 0);
});

test('vmStats: 누적 평균/피크 관측 + 전원 OFF/템플릿 제외', () => {
  _resetVmStats();
  const mk = (cpu) => ({ vms: [
    { id: 'x', powerState: 'POWERED_ON', cpuUsagePct: cpu, memUsagePct: 50 },
    { id: 'off', powerState: 'POWERED_OFF', cpuUsagePct: 99, memUsagePct: 99 },
  ] });
  updateVmStats(mk(10), NOW); updateVmStats(mk(30), NOW + 60_000);
  const st = vmStatsFor('x');
  assert.equal(st.samples, 2);
  assert.equal(st.cpuAvg, 20);
  assert.equal(st.cpuMax, 30);
  assert.equal(vmStatsFor('off'), null);
});

/* ── 버전/패치 준수 ── */
test('esxiSupportStatus/hwVersionNum: EOL 판정과 vmx 파싱', () => {
  assert.equal(esxiSupportStatus('6.7.0', NOW).status, 'eol');
  assert.equal(esxiSupportStatus('7.0.3', NOW).status, 'eol'); // 2025-10-02 종료
  assert.equal(esxiSupportStatus('8.0.2', NOW).status, 'supported');
  assert.equal(hwVersionNum('vmx-13'), 13);
  assert.equal(hwVersionNum(''), null);
});

test('computeCompliance: Tools 상태·HW 버전·ESXi 분포 집계', () => {
  const snap = {
    vms: [
      { id: '1', name: 'v1', vcenterId: 'a', toolsVersionStatus: 'guestToolsNeedUpgrade', hwVersion: 'vmx-10', powerState: 'POWERED_ON' },
      { id: '2', name: 'v2', vcenterId: 'a', toolsVersionStatus: 'guestToolsCurrent', hwVersion: 'vmx-19', powerState: 'POWERED_ON' },
      { id: '3', name: 'tpl', vcenterId: 'a', template: true, toolsVersionStatus: 'guestToolsCurrent', hwVersion: 'vmx-19' },
    ],
    hosts: [{ version: '6.7.0', build: '1' }, { version: '8.0.2', build: '2' }],
  };
  const r = computeCompliance(snap, { now: NOW });
  assert.equal(r.summary.vms, 2); // 템플릿 제외
  assert.equal(r.summary.toolsNeedUpgrade, 1);
  assert.equal(r.summary.oldHwVms, 1);
  assert.equal(r.summary.eolHosts, 1); // 6.7=eol, 8.0=supported
});

/* ── 구성 변경 이력 ── */
test('classifyChange/filterChangeEvents: 변경성 이벤트만 통과 + 분류·계정 필터', () => {
  assert.equal(classifyChange('VmReconfiguredEvent'), '설정 변경');
  assert.equal(classifyChange('TaskEvent'), '기타');
  const rows = [
    { type: 'VmReconfiguredEvent', user: 'ADMIN\\kim', entity: 'web-01', ts: 1 },
    { type: 'UserLoginSessionEvent', user: 'x', entity: '', ts: 2 },       // 변경성 아님 → 제외
    { type: 'VmPoweredOffEvent', user: 'ADMIN\\lee', entity: 'db-01', ts: 3 },
  ];
  const all = filterChangeEvents(rows);
  assert.equal(all.length, 2);
  const onlyKim = filterChangeEvents(rows, { user: 'kim' });
  assert.equal(onlyKim.length, 1);
  assert.equal(onlyKim[0].category, '설정 변경');
});

/* ── 미보호 VM ── */
test('isBackupEvent/computeUnprotected: 백업 계정 스냅샷 이벤트로 보호 판정', () => {
  const rows = [
    { type: 'VmSnapshotCreatedEvent', user: 'DOMAIN\\svc-veeam', entity: 'web-01', ts: NOW - DAY, message: 'Create virtual machine snapshot' },
    { type: 'VmSnapshotCreatedEvent', user: 'admin', entity: 'db-01', ts: NOW - DAY, message: '수동 스냅샷' }, // 백업 계정 아님
    { type: 'VmReconfiguredEvent', user: 'svc-veeam', entity: 'app-01', ts: NOW - DAY, message: '' },          // 스냅샷 이벤트 아님
  ];
  assert.ok(isBackupEvent(rows[0]));
  assert.ok(!isBackupEvent(rows[1]));
  assert.ok(!isBackupEvent(rows[2]));
  const vms = [
    { id: '1', name: 'web-01', vcenterId: 'a', powerState: 'POWERED_ON', storageGB: 10 },
    { id: '2', name: 'db-01', vcenterId: 'a', powerState: 'POWERED_ON', storageGB: 20 },
    { id: '3', name: 'off-vm', vcenterId: 'a', powerState: 'POWERED_OFF', storageGB: 5 }, // 판정 제외
  ];
  const r = computeUnprotected(vms, rows, {});
  assert.equal(r.summary.protectedCount, 1);
  assert.equal(r.summary.unprotectedCount, 1);
  assert.equal(r.unprotected[0].name, 'db-01');
});

/* ── 일일 헬스체크 ── */
test('computeHealthReport: 섹션 상태와 종합 판정 + 텍스트 리포트', () => {
  const snap = {
    vcenters: [{ id: 'a', name: 'A', status: 'connected' }, { id: 'b', name: 'B', status: 'unreachable', error: 'timeout' }],
    hosts: [{ name: 'h1', vcenterId: 'a', connectionState: 'CONNECTED' }],
    vms: [
      { id: '1', name: 'v1', vcenterId: 'a', powerState: 'POWERED_ON', toolsStatus: 'RUNNING', snapshotCount: 1, snapshotSizeGB: 5, snapshotOldestTs: NOW - 10 * DAY },
      { id: '2', name: 'v2', vcenterId: 'a', powerState: 'POWERED_ON', toolsStatus: 'NOT_RUNNING' },
    ],
    datastores: [{ name: 'ds1', vcenterId: 'a', usagePct: 96, freeGB: 10 }],
    alarms: [],
  };
  const r = computeHealthReport(snap, { now: NOW });
  assert.equal(r.overall, 'crit'); // vCenter unreachable + ds 96%
  const by = Object.fromEntries(r.sections.map((s) => [s.key, s]));
  assert.equal(by.vcenters.status, 'crit');
  assert.equal(by.datastores.status, 'crit');
  assert.equal(by.snapshots.count, 1);
  assert.equal(by.tools.count, 1);
  const text = buildDailyReportText(r, '테스트 포탈');
  assert.match(text, /테스트 포탈 일일 헬스체크/);
  assert.match(text, /vCenter 수집 실패: 1건/);
});
