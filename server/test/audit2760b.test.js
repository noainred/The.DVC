import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v2.760 점검 확정분(B-03·B-04·B-09) 회귀 고정 — 수정 전 코드로 되돌리면 실패하는 것을 확인했다.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2760b-'));
process.env.CONFIG_DIR = TMP;
process.env.VMTRACK_DB_PATH = path.join(TMP, 'vt.db');

const DAY = 86_400_000;
const BASE = Math.floor(Date.now() / DAY) * DAY - 3 * DAY; // 사흘 전 UTC 자정(경계에서 떨어뜨려 아래 시각을 더한다)
const mkVms = (vc, n, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `${vc}:vm${from + i}`, vcenterId: vc, name: `vm${from + i}`, powerState: 'POWERED_ON' }));

/* ── B-03 ── */
test('B-03 — 연결된 빈 vCenter(0대)에 새로 만든 VM 은 다음 슬롯에서 신규(added)로 잡힌다', async () => {
  const svc = await import('../src/vmtrack/service.js');
  const at = (h) => new Date(BASE + h * 3600_000);
  const vcs = [{ id: 'full', status: 'connected' }, { id: 'empty', status: 'connected' }];
  let r = await svc.takeVmSnapshot({ vcenters: vcs, vms: mkVms('full', 3), datastores: [] }, { now: at(1) });   // 기준선
  assert.ok(r.ok);
  r = await svc.takeVmSnapshot({ vcenters: vcs, vms: mkVms('full', 3), datastores: [] }, { now: at(13) });      // empty 는 여전히 0대
  assert.ok(r.ok);
  r = await svc.takeVmSnapshot({ vcenters: vcs, vms: [...mkVms('full', 3), ...mkVms('empty', 2)], datastores: [] }, { now: at(25) });
  assert.ok(r.ok);
  const one = await svc.vmtrackSeries({ days: 10, vcenterId: 'empty' });
  const last = one.points[one.points.length - 1];
  assert.equal(last.total, 2);
  assert.equal(last.added, 2, '0대 기준선 위에 생긴 VM 은 신규다(예전에는 기준선으로 다시 잡혀 0)');
  assert.equal(last.baseline, false);
});

test('B-03 — 한 번도 읽은 적 없는 vCenter 의 첫 슬롯은 여전히 기준선이다(전량 신규로 잡지 않는다)', async () => {
  const svc = await import('../src/vmtrack/service.js');
  const r = await svc.takeVmSnapshot({ vcenters: [{ id: 'fresh', status: 'connected' }], vms: mkVms('fresh', 4), datastores: [] }, { now: new Date(BASE + 37 * 3600_000) });
  assert.ok(r.ok);
  const one = await svc.vmtrackSeries({ days: 10, vcenterId: 'fresh' });
  const last = one.points[one.points.length - 1];
  assert.equal(last.added, 0);
  assert.equal(last.baseline, true);
});

/* ── B-04 ── */
test('B-04 — 라이트사이징 RAM 은 0.1GB 단위(1.5GB VM 의 회수는 0.5GB), 못 읽은 메모리·vCPU 는 null + 권고 보류', async () => {
  const { computeRightsizing } = await import('../src/reports/rightsizing.js');
  const st = { samples: 50, cpuAvg: 10, cpuMax: 15, memAvg: 30, memMax: 30, sinceTs: 0 };
  const r = computeRightsizing([
    { id: 'a', name: 'vm-1.5G', powerState: 'POWERED_ON', cpuCount: 4, memMB: 1536 },
    { id: 'b', name: 'vm-memnull', powerState: 'POWERED_ON', cpuCount: 4, memMB: null },
  ], () => st);
  const a = r.oversized.find((x) => x.id === 'a');
  assert.equal(a.ramGB, 1.5);
  assert.equal(a.suggestedRamGB, 1);
  assert.equal(a.reclaimRamGB, 0.5);
  const b = r.oversized.find((x) => x.id === 'b');
  assert.equal(b.ramGB, null, "못 읽은 메모리는 '0GB' 가 아니다");
  assert.ok(b.held.includes('mem'));
  assert.equal(b.reclaimRamGB, 0);
  assert.equal(r.reclaimableRamGB, 0.5);
});

test('B-04 — 유휴 VM 의 vCPU 를 못 읽었으면 null 로 싣고 회수 합계에는 0 으로 더한다', async () => {
  const { computeRightsizing } = await import('../src/reports/rightsizing.js');
  const st = { samples: 50, cpuAvg: 1, cpuMax: 2, memAvg: 5, memMax: 6, sinceTs: 0 };
  const r = computeRightsizing([{ id: 'c', name: 'idle', powerState: 'POWERED_ON', cpuCount: null, memMB: 2048 }], () => st);
  assert.equal(r.idle[0].vcpu, null);
  assert.equal(r.idle[0].reclaimVcpu, 0);
  assert.equal(r.idle[0].reclaimRamGB, 2);
  assert.equal(r.reclaimableVcpu, 0);
});

/* ── B-09 ── */
test('B-09 — 검색: 메모리를 못 읽은 VM 은 RAM 최소·최대 조건 어디에도 맞지 않고 memGB 는 null', async () => {
  const { snapshotFilter, slimVm } = await import('../src/search/deepSearch.js');
  const snap = { vms: [
    { id: 'v1', vcenterId: 'vc', name: 'known', memMB: 4096 },
    { id: 'v2', vcenterId: 'vc', name: 'unknown', memMB: null },
  ] };
  assert.deepEqual(snapshotFilter(snap, { f: { ramMaxGB: '8' } }).map((v) => v.id), ['v1']);
  assert.deepEqual(snapshotFilter(snap, { f: { ramMinGB: '1' } }).map((v) => v.id), ['v1']);
  assert.equal(slimVm(snap.vms[1]).memGB, null);
  assert.equal(slimVm(snap.vms[0]).memGB, 4);
});
