// v2.630 감사 그룹 c — 게스트 디스크 부분 합(A2-01) · CVP 포트·BGP 상태 번역(A2-02·A2-03) ·
// 디스크 트렌드 회수 가능 시계열(DATA2630-01) · vmtrack DS 시작값 메모(PERF2630-01).
// 기준 시각은 Date.now() 가 아니라 고정값(CLAUDE.md 규약). DB 는 임시 디렉터리.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2630c-'));
process.env.GUESTDISK_DB_PATH = path.join(TMP, 'guest-disk.db');
process.env.VMTRACK_DB_PATH = path.join(TMP, 'vm-track.db');

const sqliteOk = await import('node:sqlite').then(() => true).catch(() => false);
const SKIP = !sqliteOk ? 'node:sqlite 미지원 런타임' : false;

const { sanitizeGuestDiskVms } = await import('../src/guestdisk/analyze.js');
const gd = await import('../src/guestdisk/db.js');
const { linkWord, portsSummary, bgpSummary, bgpStateWord, parseInterfaces } = await import('../src/cvp/parse.js');
const { vmAllocRows } = await import('../src/metrics/sampler.js');
const { VMPERF_VMDISK_METRICS } = await import('../src/metrics/vmperfDb.js');
const { diskHistoryPoint } = await import('../src/routes/api/toolsCapacity.js');
const vt = await import('../src/vmtrack/db.js');
const vts = await import('../src/vmtrack/service.js');

// ── A2-01 ────────────────────────────────────────────────────────────────
const vmOf = (parts) => ({ vmId: 'vc1:vm-1', vmName: 'web01', allocGB: null, usedGB: null, parts });
function summarize(parts) {
  // service.collect 와 같은 순서: vmSummary 성격의 합은 정제가 들고 오는 값이 아니므로 여기서 계산해 싣는다.
  let alloc = 0; let used = 0;
  for (const p of parts) if (p.usedGB != null) { alloc += p.capGB; used += p.usedGB; }
  return sanitizeGuestDiskVms([{ ...vmOf(parts), allocGB: alloc, usedGB: used }])[0];
}

test('A2-01 정제: 여유 미보고 파티션의 경로를 unknownPaths 로 이어받는다(엣지 → 중앙 재정제도)', () => {
  const r = summarize([{ path: 'C:\\', capGB: 100, usedGB: 50 }, { path: 'D:\\', capGB: 500, usedGB: null }]);
  assert.equal(r.partsUnknown, 1);
  assert.deepEqual(r.unknownPaths, ['D:\\']);
  const again = sanitizeGuestDiskVms([r])[0];           // 중앙 수신 재정제
  assert.equal(again.partsUnknown, 1);
  assert.deepEqual(again.unknownPaths, ['D:\\']);
  // 온전한 VM 에는 필드가 없다(기존 모양)
  const ok = summarize([{ path: 'C:\\', capGB: 100, usedGB: 50 }]);
  assert.equal(ok.unknownPaths, undefined);
  assert.equal(ok.partsUnknown, undefined);
});

test('A2-01 커밋: 부분 합은 vm_series·vm_last 에 적재하지 않고 vm_latest 는 직전 값 유지 · 일시 미보고 경로는 part_last 에 남는다', { skip: SKIP }, async () => {
  const vc = 'vc1';
  const good = summarize([{ path: 'C:\\', capGB: 100, usedGB: 50 }, { path: 'D:\\', capGB: 500, usedGB: 400 }]);
  let r = await gd.commitCollection(vc, 'VC', [good], { ts: 1_000, changeThresholdGB: 1 });
  assert.equal(r.ok, true); assert.equal(r.vmSeriesRows, 1);

  const partial = summarize([{ path: 'C:\\', capGB: 100, usedGB: 50 }, { path: 'D:\\', capGB: 500, usedGB: null }]);
  assert.equal(partial.allocGB, 100);                    // 부분 합(재현 입력)
  r = await gd.commitCollection(vc, 'VC', [partial], { ts: 2_000, changeThresholdGB: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.vmSeriesRows, 0, '부분 합으로 vm_series 에 새 점이 생기면 안 된다');
  assert.equal(r.partialVms, 1); assert.equal(r.partialHeld, 1);

  const series = await gd.vmSeries('vc1:vm-1', 0);
  assert.deepEqual(series.map((p) => p.allocGB), [600]);
  const latest = await gd.listLatest([vc]);
  const l = latest[0];
  assert.equal(Number(l.allocGB ?? l.alloc_gb), 600, 'vm_latest 는 마지막 온전한 관측을 유지');
  const cur = await gd.currentPartPaths('vc1:vm-1');
  const paths = [...(cur instanceof Set ? cur : (cur || []))].map((x) => (typeof x === 'string' ? x : x.path)).sort();
  assert.deepEqual(paths, ['C:\\', 'D:\\'], '일시 미보고 D: 는 언마운트가 아니다');

  // 전부 미보고 → 0/0 점도 적재하지 않는다
  const none = summarize([{ path: 'C:\\', capGB: 100, usedGB: null }, { path: 'D:\\', capGB: 500, usedGB: null }]);
  r = await gd.commitCollection(vc, 'VC', [none], { ts: 3_000, changeThresholdGB: 1 });
  assert.equal(r.vmSeriesRows, 0);
  assert.equal((await gd.vmSeries('vc1:vm-1', 0)).length, 1);

  // 경로 없이 개수만 온 구버전 엣지 행 → 경로 삭제를 통째로 건너뛴다
  const legacy = { vmId: 'vc1:vm-1', vmName: 'web01', allocGB: 100, usedGB: 50, partCount: 1, partsUnknown: 1, parts: [{ path: 'C:\\', capGB: 100, usedGB: 50 }] };
  r = await gd.commitCollection(vc, 'VC', sanitizeGuestDiskVms([legacy]), { ts: 4_000, changeThresholdGB: 1 });
  const cur2 = await gd.currentPartPaths('vc1:vm-1');
  assert.equal([...(cur2 instanceof Set ? cur2 : (cur2 || []))].length, 2);

  // 다시 온전해지면 정상 적재 + 실제로 사라진 경로는 지워진다
  const back = summarize([{ path: 'C:\\', capGB: 100, usedGB: 60 }]);
  r = await gd.commitCollection(vc, 'VC', [back], { ts: 5_000, changeThresholdGB: 1 });
  assert.equal(r.vmSeriesRows, 1);
  const cur3 = await gd.currentPartPaths('vc1:vm-1');
  assert.equal([...(cur3 instanceof Set ? cur3 : (cur3 || []))].length, 1);
});

// ── A2-02 · A2-03 ────────────────────────────────────────────────────────
test('A2-02 linkWord: 미연결·트랜시버 없음은 down 이 아니라 nolink', () => {
  for (const w of ['notconnect', 'notPresent', 'NotConnected', 'disconnected']) assert.equal(linkWord(w), 'nolink', w);
  for (const w of ['linkDown', 'errdisabled', 'intfOperDown', 'lowerLayerDown', 'down']) assert.equal(linkWord(w), 'down', w);
  assert.equal(linkWord('linkUp'), 'up');
  assert.equal(linkWord('connected'), 'up');
  assert.equal(linkWord(false), 'down');
  assert.equal(linkWord('weird'), 'unknown');
});

test('A2-02 portsSummary: 기본 설정(enabled) 미사용 포트는 down 으로 세지 않고 noLink 로 밝힌다', () => {
  const ports = [
    { oper: linkWord('linkUp'), admin: linkWord('enabled') },
    { oper: linkWord('notconnect'), admin: linkWord('enabled') },
    { oper: linkWord('notPresent'), admin: linkWord('enabled') },
    { oper: linkWord('linkDown'), admin: linkWord('enabled') },
  ];
  assert.deepEqual(portsSummary(ports), { total: 4, up: 1, down: 1, noLink: 2 });
  assert.deepEqual(portsSummary([{ oper: 'up', admin: 'up' }]), { total: 1, up: 1, down: 0 }, 'nolink 0 이면 필드 없음(기존 모양)');
});

test('A2-02 parseInterfaces → 요약: notconnect 포트가 다운 KPI 에 들어가지 않는다', () => {
  const nd = [
    { name: 'Ethernet1', operStatus: 'linkUp', adminStatus: 'enabled' },
    { name: 'Ethernet2', operStatus: 'notconnect', adminStatus: 'enabled' },
  ].map((x) => JSON.stringify(x)).join('\n');
  const r = parseInterfaces(nd);
  if (r.ports) {
    const s = portsSummary(r.ports);
    assert.equal(s.down, 0);
  }
});

test('A2-03 BGP: MIB 정수 6 은 established, 1~5 는 down, 모르는 값은 stateUnknown', () => {
  assert.equal(bgpStateWord(6), 'established');
  assert.equal(bgpStateWord('6'), 'established');
  assert.equal(bgpStateWord(1), 'down');
  assert.equal(bgpStateWord('Active'), 'down');
  assert.equal(bgpStateWord('OpenSent'), 'down');
  assert.equal(bgpStateWord('Idle (Admin)'), 'down');
  assert.equal(bgpStateWord('Established'), 'established');
  for (const w of ['unknown', 'n/a', '7', '']) assert.equal(bgpStateWord(w), 'unknown', w);
  const s = bgpSummary([{ state: '6' }, { state: 'Active' }, { state: 'n/a' }, { state: 'Established' }]);
  assert.equal(s.established, 2); assert.equal(s.down, 1); assert.equal(s.stateUnknown, 1);
  assert.equal(bgpSummary([{ state: 'Established' }]).stateUnknown, undefined, '모르는 것 0 이면 필드 없음');
});

// ── DATA2630-01 ─────────────────────────────────────────────────────────
test('DATA2630-01 샘플러: 전원 켜진 VM 스냅샷 계열 vm_snap_on_gb 를 따로 적재한다', () => {
  assert.ok(VMPERF_VMDISK_METRICS.includes('vm_snap_on_gb'));
  const snap = {
    hosts: [],
    datastores: [],
    vms: [
      { id: 'vc-a:1', vcenterId: 'vc-a', powerState: 'POWERED_OFF', storageGB: 100, uncommittedGB: 0, snapshotSizeGB: 60 },
      { id: 'vc-a:2', vcenterId: 'vc-a', powerState: 'POWERED_ON', storageGB: 50, uncommittedGB: 0, snapshotSizeGB: 10 },
    ],
  };
  const out = vmAllocRows(snap, { enabled: true, vcenterIds: [], trackTotal: false, retentionDays: 30 });
  const m = Object.fromEntries(out.get('vc-a').map((r) => [r.metric, r.v]));
  assert.equal(m.vm_disk_off_gb, 100);
  assert.equal(m.vm_snap_gb, 70);
  assert.equal(m.vm_snap_on_gb, 10);
});

test('DATA2630-01 시계열 점: 새 계열이 있으면 정지 + 켜진 스냅샷, 없으면 옛 합 + reclaimLegacy', () => {
  const now = diskHistoryPoint({ ts: 1, vm_disk_off_gb: 100, vm_snap_gb: 70, vm_snap_on_gb: 10 });
  assert.equal(now.reclaimGB, 110);        // 현재값(breakdown) 정의와 같다 — 정지 VM 스냅샷 60 을 두 번 세지 않는다
  assert.equal(now.reclaimLegacy, undefined);
  const old = diskHistoryPoint({ ts: 0, vm_disk_off_gb: 100, vm_snap_gb: 70 });
  assert.equal(old.reclaimGB, 170);
  assert.equal(old.reclaimLegacy, true);
  const none = diskHistoryPoint({ ts: 2, ds_cap_gb_vc: 10 });
  assert.equal(none.reclaimGB, null);
  assert.equal(none.reclaimLegacy, undefined);
});

// ── PERF2630-01 ─────────────────────────────────────────────────────────
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 10, 3, 0, 0);   // 고정 기준 시각

async function commitDs(slot, ts, series) {
  return vt.commitSnapshot({
    slot, ts,
    totalRow: { total: 0, onCount: 0, added: 0, removed: 0 },
    perVc: [{ vcenterId: 'vc1', total: 0, onCount: 0, added: [], removed: [], live: [], baseline: false,
      ds: { count: series.length, capGB: 0, usedGB: 0, added: [], removed: [], changed: [], live: [], series } }],
  });
}

test('PERF2630-01 시작값 메모: 같은 창 경계·세대면 같은 객체, 커밋·prune 뒤에는 새로 읽는다', { skip: SKIP }, async () => {
  assert.ok(await vt.getDb());
  assert.equal((await commitDs('s1', T0 - 20 * DAY, [{ dsId: 'ds1', capGB: 100, usedGB: 10 }])).ok, true);
  assert.equal((await commitDs('s2', T0 - 5 * DAY, [{ dsId: 'ds1', capGB: 100, usedGB: 30 }])).ok, true);

  const since = T0 - 10 * DAY;
  const a = await vts._dsStartValuesForTest(since);
  const b = await vts._dsStartValuesForTest(since + 60_000);   // sinceTs 는 움직여도 경계(첫 창 관측)는 같다
  assert.equal(a, b, '같은 경계·세대면 메모를 쓴다');
  assert.equal(a.carry.get('ds1'), 10);
  assert.equal(a.firstIn.get('ds1'), 30);

  // 메모 없이 직접 계산한 값과 같다(결과 동일성)
  const [w, c] = await Promise.all([vt.dsSeriesWindow(since), vt.dsSeriesCarry(since)]);
  assert.deepEqual([...a.carry], c.map((r) => [r.ds_id, r.used_gb]));
  assert.equal(a.firstIn.get('ds1'), w[0].used_gb);

  // 새 슬롯 커밋 → 세대가 바뀌어 다시 읽는다
  assert.equal((await commitDs('s3', T0 - 1 * DAY, [{ dsId: 'ds2', capGB: 50, usedGB: 5 }])).ok, true);
  const d = await vts._dsStartValuesForTest(since);
  assert.notEqual(d, a);
  assert.equal(d.firstIn.get('ds2'), 5);

  // 창 경계가 달라지면(다른 days) 다른 결과
  const e = await vts._dsStartValuesForTest(T0 - 3 * DAY);
  assert.equal(e.carry.get('ds1'), 30);
  assert.ok(vts._dsStartMemoSize() <= 8);
});
