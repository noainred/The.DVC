// v2.629 감사 그룹 a — DATA2629-01~06 · WEB2629-01 회귀.
//   ① 디스크 추세 회수량: 정지 VM 의 스냅샷을 두 번 세지 않는다
//   ② 좀비 리포트 회수량: 같은 판정(snapshotReclaimGB 한 벌)
//   ③ 일일 헬스체크: Tools 미수집 VM 은 '미실행' 이 아니라 확인 불가 · NOT_RESPONDING 호스트는 끊김
//   ④ 준수 리포트: KPI 는 목록 상한과 무관한 전량 · 뺀 개수 · '(미수집)' 분리
//   ⑤ 운영 인사이트 회수: 과대 VM 은 초과분만 (실제 라우터)
//   ⑥ VM 목록 평균 사용률: 값 없는 VM 은 분모 제외 · 대상 0 이면 null (실제 라우터)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2629a-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';

const { diskBreakdown, snapshotReclaimGB } = await import('../src/tools/diskTrend.js');
const { computeZombies } = await import('../src/reports/zombies.js');
const { computeHealthReport } = await import('../src/reports/healthReport.js');
const { computeCompliance } = await import('../src/reports/compliance.js');

const NOW = Date.UTC(2026, 8, 27, 3, 30, 0); // 고정 기준 시각(경계에서 떨어뜨림)

test('① DATA2629-01 정지 VM + 스냅샷: 회수량은 committed 한 번만', () => {
  const vms = [
    { id: 'a', powerState: 'POWERED_OFF', storageGB: 100, snapshotCount: 1, snapshotSizeGB: 60 },
    { id: 'b', powerState: 'POWERED_ON', storageGB: 50, snapshotCount: 2, snapshotSizeGB: 20 },
  ];
  const b = diskBreakdown(vms, [{ capacityGB: 400, usedGB: 200 }], { now: NOW });
  assert.equal(b.reclaim.off.gb, 100);
  assert.equal(b.reclaim.snap.gb, 80, '표시용 스냅샷 합계는 전체 그대로');
  assert.equal(b.reclaim.snap.reclaimGB, 20);
  assert.equal(b.reclaim.snap.overlapGB, 60);
  assert.equal(b.reclaim.totalGB, 120);
  assert.equal(b.reclaim.pctOfUsed, 60);
  assert.ok(b.reclaim.totalGB <= 150, '회수량이 VM 이 쓰는 디스크 전체를 넘지 않는다');
  // 발견의 재현 그대로
  const r = diskBreakdown([{ id: 'a', powerState: 'POWERED_OFF', storageGB: 100, snapshotCount: 1, snapshotSizeGB: 60 }], [{ capacityGB: 200, usedGB: 100 }], { now: NOW }).reclaim;
  assert.equal(r.totalGB, 100);
  assert.equal(r.afterReclaimUsagePct, 0);
  assert.equal(r.pctOfUsed, 100);
});

test('① helper: 이미 회수 대상인 VM 의 스냅샷은 빼고 음수·결측은 무시', () => {
  assert.equal(snapshotReclaimGB([{ id: 'x', snapshotSizeGB: 5 }, { id: 'y', snapshotSizeGB: 7 }, { id: 'z', snapshotSizeGB: null }], new Set(['y'])), 5);
});

test('② DATA2629-02 좀비 리포트: 정지 VM 의 스냅샷 대식가를 회수량에 두 번 넣지 않는다', () => {
  const z = computeZombies({ vms: [
    { id: 'a', powerState: 'POWERED_OFF', storageGB: 100, snapshotCount: 1, snapshotSizeGB: 60, connectionState: 'connected' },
    { id: 'b', powerState: 'POWERED_ON', storageGB: 40, snapshotCount: 1, snapshotSizeGB: 30, connectionState: 'connected' },
  ] }, { now: NOW });
  assert.equal(z.summary.poweredOffGB, 100);
  assert.equal(z.summary.snapshotHogGB, 90, '표시용 스냅샷 대식가 합계는 그대로');
  assert.equal(z.summary.snapshotInPoweredOffGB, 60);
  assert.equal(z.summary.reclaimableGB, 130);
});

test('③ DATA2629-03 Tools 미수집(REST 폴백) VM 은 미실행이 아니라 확인 불가', () => {
  const r = computeHealthReport({
    vcenters: [{ id: 'vc1', status: 'connected', collectMethod: 'rest', alarmsUnknown: true }],
    hosts: [], datastores: [], alarms: [],
    vms: [
      { id: 'vc1:vm-1', vcenterId: 'vc1', name: 'a', powerState: 'POWERED_ON' },
      { id: 'vc1:vm-2', vcenterId: 'vc1', name: 'b', powerState: 'POWERED_ON', toolsStatus: '' },
    ],
  }, { now: NOW });
  const tools = r.sections.find((s) => s.key === 'tools');
  assert.equal(tools.count, 0);
  assert.equal(tools.status, 'unknown');
  assert.equal(tools.unknown, 2);
  assert.match(tools.detail, /Tools 상태 미수집 VM 2대/);
  assert.equal(r.summary.toolsUnknown, 2);
  // 수집된 미실행은 여전히 경고
  const r2 = computeHealthReport({ vcenters: [], hosts: [], datastores: [], alarms: [],
    vms: [{ id: 'x', name: 'x', powerState: 'POWERED_ON', toolsStatus: 'NOT_RUNNING' }, { id: 'y', name: 'y', powerState: 'POWERED_ON' }] }, { now: NOW });
  const t2 = r2.sections.find((s) => s.key === 'tools');
  assert.equal(t2.status, 'warn');
  assert.equal(t2.count, 1);
});

test('③ DATA2629-06 NOT_RESPONDING 호스트는 연결 끊김으로 센다', () => {
  const r = computeHealthReport({ vcenters: [], datastores: [], alarms: [], vms: [],
    hosts: [{ name: 'h1', vcenterId: 'vc1', connectionState: 'NOT_RESPONDING' }, { name: 'h2', vcenterId: 'vc1', connectionState: 'CONNECTED' }] }, { now: NOW });
  const h = r.sections.find((s) => s.key === 'hosts');
  assert.equal(h.status, 'crit');
  assert.equal(h.count, 1);
  assert.equal(h.items[0].name, 'h1');
});

test('④ DATA2629-04 준수 KPI 는 전량 · 목록만 상한 · 뺀 개수를 밝힌다 · 미수집 분리', () => {
  const vms = Array.from({ length: 800 }, (_, i) => ({ id: `v${i}`, name: `v${i}`, toolsVersionStatus: 'guestToolsNeedUpgrade', hwVersion: 'vmx-10' }));
  vms.push({ id: 'rest', name: 'rest', powerState: 'POWERED_ON', hwVersion: 'vmx-19' });
  const c = computeCompliance({ vms, hosts: [] }, { now: NOW });
  assert.equal(c.summary.toolsNeedUpgrade, 800);
  assert.equal(c.summary.oldHwVms, 800);
  assert.equal(c.tools.needUpgrade.length, 500);
  assert.equal(c.tools.needUpgradeOmitted, 300);
  assert.equal(c.hwVersion.old.length, 500);
  assert.equal(c.hwVersion.oldOmitted, 300);
  const distUp = c.tools.dist.find((d) => d.key === 'guestToolsNeedUpgrade');
  assert.equal(distUp.count, c.summary.toolsNeedUpgrade, 'KPI 와 분포표가 같은 수를 말한다');
  assert.equal(c.tools.dist.find((d) => d.key === '(미수집)')?.count, 1);
  assert.equal(c.tools.dist.find((d) => d.key === 'guestToolsNotInstalled'), undefined, '미수집을 미설치로 세지 않는다');
  assert.equal(c.summary.toolsNotCollected, 1);
});

// ⑤⑥ 실제 라우터 — store.get 을 합성 스냅샷으로
const { store } = await import('../src/store.js');
const express = (await import('express')).default;
const { api } = await import('../src/routes/api.js');
const SNAP = {
  generatedAt: new Date(NOW).toISOString(),
  vcenters: [{ id: 'vc1', name: 'vc1', status: 'connected' }],
  hosts: [], datastores: [], alarms: [], networks: [],
  vms: [
    { id: 'vc1:vm-1', vcenterId: 'vc1', name: 'big', powerState: 'POWERED_ON', cpuCount: 8, cpuUsagePct: 3, memUsagePct: 90, memMB: 65536, storageGB: 10 },
    { id: 'vc1:vm-2', vcenterId: 'vc1', name: 'rest', powerState: 'POWERED_ON', cpuCount: 2, memMB: 2048, storageGB: 10 },
    { id: 'vc1:vm-3', vcenterId: 'vc1', name: 'off', powerState: 'POWERED_OFF', cpuCount: 2, memMB: 2048, storageGB: 10 },
  ],
  rollups: {},
};

async function withServer(fn) {
  const orig = store.get;
  store.get = () => SNAP;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try { return await fn(`http://127.0.0.1:${srv.address().port}`); } finally { store.get = orig; srv.close(); }
}

test('⑤ DATA2629-05 과대 VM 은 초과분만 회수 가능(메모리 90% VM 의 RAM 은 회수 대상 아님)', async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/api/tools/insights`);
    assert.equal(r.status, 200);
    const j = await r.json();
    const rs = j.rightsizing;
    assert.equal(rs.oversizedCount, 1);
    assert.equal(rs.reclaimableVcpu, 7, '8 vCPU · 3% → 권고 1 → 초과 7');
    assert.equal(rs.reclaimableRamGB, 0, '메모리 90% 사용 → 권고가 현재 사양 → 회수 0');
    assert.equal(rs.reclaimBasis, 'instant');
  });
});

test('⑥ WEB2629-01 VM 평균 사용률: 값 없는 VM 은 분모 제외 · 대상 0 이면 null', async () => {
  await withServer(async (base) => {
    const j = await (await fetch(`${base}/api/vms`)).json();
    assert.equal(j.totals.avgCpuUsagePct, 3, 'REST 폴백 VM(값 없음)을 0 으로 넣지 않는다');
    assert.equal(j.totals.avgMemUsagePct, 90);
    assert.deepEqual(j.totals.usageUnknown, { cpu: 1, mem: 1 });
    const off = await (await fetch(`${base}/api/vms?powerState=POWERED_OFF`)).json();
    assert.equal(off.totals.poweredOn, 0);
    assert.equal(off.totals.avgCpuUsagePct, null);
    assert.equal(off.totals.avgMemUsagePct, null);
  });
});

test('cleanup', () => { fs.rmSync(TMP, { recursive: true, force: true }); });
