// v2.743 점검 2회차 — 그룹 GE(VM 수량 추이 · VM 생성·삭제 이력 · 게스트 디스크 최신값).
//
// VC-01 — VM 수량 추이(vmtrack)와 VM 생성·삭제 이력(vm-lifecycle)이 **읽지 못한 vCenter 의 빈 VM 목록** 을 '삭제' 로 셌다.
//   store.js 는 비활성 vCenter 를 VM 없이 status 'disabled' 로 넣고, 점검중 vCenter 도 직전 캐시가 없으면(재시작 직후) VM 0개다.
//   추이 필터는 unreachable·pending 만 걸러 그 둘을 diff 했고 → 직전 로스터 전부가 removed · skipped 0 · 다시 켜면 기준선(added 0).
//   이력 화면은 그 vCenter 를 빈 이름 집합으로 넣어 existsNow=false('없음' 호박색)였다.
// VC-02 — 게스트 디스크 vm_latest 가 **등록부에서 지운 vCenter** 의 행을 무기한 남기고 회수 가능 합계에 더했다(coverage 에는 그 vCenter 줄이 없다).
//   ⚠ '등록된 vCenter 의 오래된 행' 은 db.js 가 의도로 남기는 값이다(검증자 B) — 합계에서 빼지 않고 개수·용량으로 밝힌다.
//
// 실제 함수(takeVmSnapshot · vmtrackSeries · liveNamesOf · analyzeLifecycle · commitCollection · reclaimReport · pruneOrphanVcenters)와
// 웹 문구 모듈(vmLifeText · guestDiskText)을 부른다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2743e-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'live';
process.env.VMTRACK_DB_PATH = path.join(tmp, 'vm-track.db');
process.env.GUESTDISK_DB_PATH = path.join(tmp, 'guest-disk.db');

const sqliteOk = await import('node:sqlite').then(() => true).catch(() => false);
const SKIP = !sqliteOk ? 'node:sqlite 미지원 런타임' : false;
const H = 3_600_000;

// ─────────────────────────────── VC-01 ───────────────────────────────

const vm = (i, vc) => ({ id: `${vc}:vm-${i}`, name: `vm${i}`, vcenterId: vc, powerState: 'POWERED_ON', cpuCount: 2, memMB: 4096, storageGB: 10, host: 'h1', cluster: 'c1' });
const ds = (i, vc) => ({ id: `${vc}:ds${i}`, name: `ds${i}`, vcenterId: vc, capacityGB: 1000, usedGB: 400, freeGB: 600, storageType: 'VMFS' });

test('VC-01 ① 판정 한 벌 — connected 는 읽음 · VM 이 있으면 직전 값 서빙 · 그 밖의 빈 목록은 사유', async () => {
  const { inventoryUnreadReason } = await import('../src/vmtrack/diff.js');
  assert.equal(inventoryUnreadReason({ status: 'connected' }, 0), null, 'connected 의 VM 0개는 사실(정말 비었을 수 있다)');
  assert.equal(inventoryUnreadReason({ status: 'disabled' }, 0), 'disabled');
  assert.equal(inventoryUnreadReason({ status: 'maintenance', maintenance: true }, 0), 'maintenance', '캐시 없는 점검중');
  assert.equal(inventoryUnreadReason({ status: 'maintenance', maintenance: true }, 5), null, '캐시 있는 점검중은 예전처럼 diff');
  assert.equal(inventoryUnreadReason({ status: 'unreachable' }, 5), null, 'lastGood 보류(VM 있음)는 예전처럼 diff');
  assert.equal(inventoryUnreadReason({ status: 'unreachable' }, 0), 'unreachable');
  assert.equal(inventoryUnreadReason({ status: 'pending' }, 0), 'pending');
  assert.equal(inventoryUnreadReason({}, 0), 'unknown');
  assert.equal(inventoryUnreadReason(null, 3), 'unknown', '스냅샷에 없는 vCenter 는 모른다');
});

test('VC-01 ② 추이 — 비활성·캐시 없는 점검중 vCenter 의 빈 목록을 삭제로 적재하지 않고, 다시 켜면 그 사이 생성분을 신규로 센다', { skip: SKIP }, async () => {
  const svc = await import('../src/vmtrack/service.js');
  const db = await import('../src/vmtrack/db.js');
  const vmsA = Array.from({ length: 5 }, (_, i) => vm(i, 'vcA'));
  const vmsB = Array.from({ length: 3 }, (_, i) => vm(i, 'vcB'));
  const dsA = [ds(1, 'vcA'), ds(2, 'vcA')];
  const dsB = [ds(1, 'vcB')];
  // 슬롯 1 — 둘 다 연결(기준선)
  const r1 = await svc.takeVmSnapshot({ vcenters: [{ id: 'vcA', status: 'connected' }, { id: 'vcB', status: 'connected' }], vms: [...vmsA, ...vmsB], datastores: [...dsA, ...dsB] },
    { trigger: 'test', now: new Date('2026-10-14T01:00:00Z') });
  assert.equal(r1.ok, true);
  assert.equal(r1.total, 8);

  // 슬롯 2 — vcA 비활성(store 는 VM·DS 없이 status 만 넣는다)
  const r2 = await svc.takeVmSnapshot({ vcenters: [{ id: 'vcA', status: 'disabled' }, { id: 'vcB', status: 'connected' }], vms: [...vmsB], datastores: [...dsB] },
    { trigger: 'test', now: new Date('2026-10-14T13:00:00Z') });
  assert.equal(r2.ok, true);
  assert.equal(r2.removed, 0, '비활성 vCenter 의 VM 5대를 삭제로 세지 않는다');
  assert.equal(r2.skippedCount, 1, '빠진 vCenter 를 밝힌다(부분 합)');
  assert.deepEqual(r2.skippedVcenters.map((x) => [x.id, x.reason]), [['vcA', 'disabled']], '비활성은 사유를 따로');
  assert.equal(r2.skippedByReason?.disabled, 1);
  assert.equal((await db.loadRoster('vcA')).size, 5, '비활성 동안 로스터를 지우지 않는다');
  assert.equal((await db.loadDsRoster('vcA')).size, 2, '데이터스토어 로스터도 지우지 않는다(해제로 적재하지 않는다)');
  const dsChanges2 = await svc.vmtrackDsChanges({ slot: r2.slot });
  assert.equal(dsChanges2.filter((c) => c.kind === 'ds_removed').length, 0, 'DS 해제 0건');

  // 슬롯 3 — vcA 다시 연결(그 사이 VM 1대 생성) · vcB 는 점검중인데 재시작 직후라 캐시 없음(VM 0)
  const vmsA3 = [...vmsA, vm(9, 'vcA')];
  const r3 = await svc.takeVmSnapshot({ vcenters: [{ id: 'vcA', status: 'connected' }, { id: 'vcB', status: 'maintenance', maintenance: true }], vms: vmsA3, datastores: dsA },
    { trigger: 'test', now: new Date('2026-10-15T01:00:00Z') });
  assert.equal(r3.ok, true);
  assert.equal(r3.added, 1, '다시 켠 vCenter 는 기준선이 아니다 — 그 사이 생성분 1대가 신규');
  assert.equal(r3.removed, 0, '캐시 없는 점검중 vCenter 의 VM 3대를 삭제로 세지 않는다');
  assert.equal(r3.baseline, false);
  assert.deepEqual(r3.skippedVcenters.map((x) => [x.id, x.reason]), [['vcB', 'maintenance']]);
  assert.equal((await db.loadRoster('vcB')).size, 3, '점검중 vCenter 로스터 보존');

  // 슬롯 4 — vcB 점검 끝(연결) · VM 그대로 → 변화 0
  const r4 = await svc.takeVmSnapshot({ vcenters: [{ id: 'vcA', status: 'connected' }, { id: 'vcB', status: 'connected' }], vms: [...vmsA3, ...vmsB], datastores: [...dsA, ...dsB] },
    { trigger: 'test', now: new Date('2026-10-15T13:00:00Z') });
  assert.equal(r4.added, 0);
  assert.equal(r4.removed, 0);
  assert.equal(r4.skippedCount, undefined, '모두 읽었으면 빠진 vCenter 없음');

  // 시계열에도 삭제가 없고, 빠진 슬롯은 부분 합 표시(skipped)를 갖는다
  const ser = await svc.vmtrackSeries({ days: 30 });
  const bySlot = new Map(ser.points.map((p) => [p.slot, p]));
  assert.equal(bySlot.get(r2.slot).removed, 0);
  assert.equal(bySlot.get(r2.slot).skipped, 1);
  assert.equal(bySlot.get(r3.slot).removed, 0);
  assert.equal(bySlot.get(r3.slot).added, 1);
  assert.equal(bySlot.get(r3.slot).skipped, 1);
});

test('VC-01 ③ 생성·삭제 이력 — 읽지 못한 vCenter(빈 목록·비연결)는 이름 대조를 하지 않는다(existsNow null · 사유 unread)', async () => {
  const { liveNamesOf } = await import('../src/routes/api/vmLifecycle.js');
  const { analyzeLifecycle } = await import('../src/vmlife/analyze.js');
  const snap = {
    vcenters: [{ id: 'vcOn', status: 'connected' }, { id: 'vcOff', status: 'disabled' }, { id: 'vcMt', status: 'maintenance', maintenance: true },
      { id: 'vcEmpty', status: 'connected' }, { id: 'vcCache', status: 'maintenance', maintenance: true }],
    vms: [{ vcenterId: 'vcOn', name: 'web01' }, { vcenterId: 'vcCache', name: 'cached01' }],
  };
  const live = liveNamesOf(snap, ['vcOn', 'vcOff', 'vcMt', 'vcEmpty', 'vcCache']);
  assert.ok(live.has('vcOn'));
  assert.equal(live.has('vcOff'), false, '비활성 vCenter 는 대조하지 않는다');
  assert.equal(live.has('vcMt'), false, '캐시 없는 점검중 vCenter 는 대조하지 않는다');
  assert.ok(live.has('vcEmpty') && live.get('vcEmpty').size === 0, '연결된 vCenter 의 빈 목록은 사실(없음)');
  assert.ok(live.has('vcCache'), '점검중이라도 캐시 VM 이 있으면 예전처럼 대조');
  assert.equal(liveNamesOf({ ...snap, initial: true }, ['vcOn']), null, '첫 병합 전 골격은 모름');

  const NOW = Date.parse('2026-10-15T03:00:00Z');
  const rows = [
    { ts: NOW - 2 * H, vcenterId: 'vcOn', type: 'VmCreatedEvent', entity: 'web01', user: 'a', detail: null },
    { ts: NOW - 2 * H, vcenterId: 'vcOff', type: 'VmCreatedEvent', entity: 'off01', user: 'a', detail: null },
    { ts: NOW - 2 * H, vcenterId: 'vcEmpty', type: 'VmCreatedEvent', entity: 'gone01', user: 'a', detail: null },
  ];
  const r = analyzeLifecycle(rows, { days: 7, now: NOW, liveNames: live });
  const by = new Map(r.events.map((e) => [e.vm, e]));
  assert.equal(by.get('web01').existsNow, true);
  assert.equal(by.get('off01').existsNow, null, '비활성 vCenter 의 VM 을 \'없음\' 이라 하지 않는다');
  assert.equal(by.get('off01').existsWhy, 'unread');
  assert.equal(by.get('gone01').existsNow, false, '연결된 vCenter 에 없으면 없음');
  assert.equal(by.get('gone01').existsWhy, undefined);
  const r0 = analyzeLifecycle(rows, { days: 7, now: NOW, liveNames: null });
  assert.equal(r0.events[0].existsWhy, 'initial', '인벤토리 자체를 모르면(첫 수집 중) initial');

  const { existsText } = await import('../../web/src/views/vmlife/vmLifeText.js');
  const t = existsText(by.get('off01'));
  assert.equal(t.text, '모름');
  assert.match(t.title, /읽지 못/, '모름의 이유는 \'첫 수집 중\' 이 아니라 그 vCenter 를 지금 읽지 못한 것');
  assert.doesNotMatch(t.title, /첫 수집/);
  assert.match(existsText({ existsNow: null, existsWhy: 'initial' }).title, /첫 수집/);
  assert.match(existsText({ existsNow: null }).title, /첫 수집/, '구버전 서버(existsWhy 없음)는 예전 문구');
  for (const s of [t.title, t.text]) { assert.doesNotMatch(s, /`/); assert.doesNotMatch(s, /\*\*/); }
});

// ─────────────────────────────── VC-02 ───────────────────────────────

const gdVm = (i, vc, used = 50) => ({ vmId: `${vc}:vm-${i}`, vmName: `vm${i}`, allocGB: 500, usedGB: used, partCount: 1, parts: [{ path: 'C:\\', capGB: 500, usedGB: used }] });
const DAY = 86_400_000;

test('VC-02 ① 회수 리포트 — 등록에서 지운 vCenter 의 행은 합계·목록에서 빼고 개수로, 등록된 vCenter 의 오래된 행은 합계에 남기고 밝힌다', { skip: SKIP }, async () => {
  const { store } = await import('../src/store.js');
  const gdb = await import('../src/guestdisk/db.js');
  const svc = await import('../src/guestdisk/service.js');
  fs.writeFileSync(path.join(tmp, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'vcLive', name: 'Live', host: 'https://vc-live.invalid' }] }));
  const prev = store.snapshot;
  store.snapshot = {
    source: 'live', generatedAt: new Date().toISOString(),
    vcenters: [{ id: 'vcLive', name: 'Live', status: 'connected' }, { id: 'vcOff', name: 'Off', status: 'disabled' }],
    vms: [{ id: 'vcLive:vm-1', vcenterId: 'vcLive', name: 'vm1', cluster: 'c1' }], hosts: [], datastores: [],
  };
  try {
    const now = Date.now();
    assert.equal((await gdb.commitCollection('vcGone', 'Deleted VC', [gdVm(1, 'vcGone'), gdVm(2, 'vcGone')], { ts: now - 40 * DAY })).ok, true);
    assert.equal((await gdb.commitCollection('vcLive', 'Live', [gdVm(1, 'vcLive')], { ts: now - 60_000 })).ok, true);
    assert.equal((await gdb.commitCollection('vcOff', 'Off', [gdVm(1, 'vcOff', 100)], { ts: now - 50 * DAY })).ok, true);

    const rep = await svc.reclaimReport({});
    const ids = rep.rows.map((r) => r.vmId).sort();
    assert.deepEqual(ids, ['vcLive:vm-1', 'vcOff:vm-1'], '삭제된 vCenter 의 VM 은 목록에 없다');
    assert.equal(rep.totalReclaimGB, 450 + 400, '합계 = 알려진 vCenter 의 행(오래된 vcOff 행 포함 — 의도로 남기는 값)');
    assert.equal(rep.orphanRows, 2);
    assert.equal(rep.orphanVcenters, 1);
    assert.equal(rep.collectedCount, 2, '수집된 VM 수에서도 삭제된 vCenter 를 뺀다');
    assert.equal(rep.staleRows, 1, '오래된 관측 1대');
    assert.equal(rep.staleReclaimGB, 400);
    assert.equal(rep.staleAfterMs, 36 * H, '경계 = 수집 주기(기본 12시간) × 3 — 부분 합 보류 시한과 같은 값');
    assert.equal(rep.staleAfterMs, gdb.latestHoldMs());
    assert.equal(rep.rows.find((r) => r.vmId === 'vcOff:vm-1').stale, true);
    assert.equal(rep.rows.find((r) => r.vmId === 'vcLive:vm-1').stale, undefined);
    const cov = new Map(rep.coverage.map((c) => [c.vcenterId, c]));
    assert.equal(cov.get('vcOff').stale, true, 'coverage 가 오래된 vCenter 를 표시');
    assert.equal(cov.get('vcLive').stale, undefined);
    assert.equal(cov.has('vcGone'), false);
    // 삭제된 vCenter 를 직접 골라도 보이지 않는다
    assert.equal((await svc.reclaimReport({ vcenterId: 'vcGone' })).rows.length, 0);
    // CSV 도 같은 목록
    assert.doesNotMatch(svc.reclaimCsv(rep.rows), /Deleted VC/);
    // 범위 계정 — 허용 vCenter 만, 삭제된 vCenter 개수를 싣지 않는다
    const scoped = await svc.reclaimReport({ allowed: new Set(['vcLive']) });
    assert.deepEqual(scoped.rows.map((r) => r.vmId), ['vcLive:vm-1']);
    assert.equal(scoped.orphanRows, 0);

    // 등록부를 읽지 못하면 판정하지 않는다 — 예전처럼 전부 두고(지우는 쪽으로 단정하지 않는다) 정리도 하지 않는다
    fs.writeFileSync(path.join(tmp, 'vcenters.json'), '{ broken');
    assert.equal(svc.knownVcenterIds(), null);
    const rep2 = await svc.reclaimReport({});
    assert.equal(rep2.rows.length, 4, '판정 불가 → 예전 동작');
    assert.equal(rep2.orphanRows, 0);
    const skipped = await svc.pruneOrphanGuestDisk();
    assert.equal(skipped.ok, false);
    assert.equal(skipped.skipped, 'registry-unreadable');
    assert.equal((await gdb.listLatest(['vcGone'])).length, 2, '등록부 손상 한 번이 행을 지우지 않는다');

    // 알려진 vCenter 가 하나도 없으면(첫 병합 전) 지우지 않는다
    fs.writeFileSync(path.join(tmp, 'vcenters.json'), JSON.stringify({ vcenters: [] }));
    const r0 = await svc.pruneOrphanGuestDisk({ vcenters: [] });
    assert.equal(r0.skipped, 'no-known-vcenters');
    assert.equal((await gdb.listLatest(['vcGone'])).length, 2);
  } finally {
    store.snapshot = prev;
  }
});

test('VC-02 ② 정리 — 등록부·스냅샷 어디에도 없는 vCenter 의 최신 행·diff 기준을 지우고, 비활성처럼 알려진 vCenter 는 남긴다', { skip: SKIP }, async () => {
  const { store } = await import('../src/store.js');
  const gdb = await import('../src/guestdisk/db.js');
  const svc = await import('../src/guestdisk/service.js');
  const poller = await import('../src/guestdisk/poller.js');
  fs.writeFileSync(path.join(tmp, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'vcLive', name: 'Live', host: 'https://vc-live.invalid' }] }));
  const prev = store.snapshot;
  store.snapshot = { source: 'live', vcenters: [{ id: 'vcLive', status: 'connected' }, { id: 'vcOff', status: 'disabled' }], vms: [], hosts: [], datastores: [] };
  try {
    const r = await poller.runOrphanPrune();
    assert.equal(r.ok, true);
    assert.deepEqual(r.vcenters, ['vcGone']);
    assert.equal(r.removedRows, 2);
    assert.equal((await gdb.listLatest(['vcGone'])).length, 0);
    assert.equal((await gdb.listLatest(['vcOff'])).length, 1, '비활성(스냅샷에만 있는) vCenter 의 오래된 관측은 남긴다');
    assert.equal((await gdb.listLatest(['vcLive'])).length, 1);
    const db = await gdb.getDb();
    assert.equal(db.prepare("SELECT COUNT(*) n FROM part_last WHERE vcenter_id='vcGone'").get().n, 0, 'part_last 도 지운다(남으면 prune 이 추이 마지막 행을 영원히 남긴다)');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM vm_last WHERE vcenter_id='vcGone'").get().n, 0);
    assert.ok(db.prepare("SELECT COUNT(*) n FROM part_last WHERE vcenter_id='vcLive'").get().n > 0);
    assert.equal(poller.guestDiskOrphanPruneStatus().removedRows, 2, '정리 결과를 남긴다(전체 범위 라우트만 싣는다)');
    assert.equal('lastOrphanPrune' in poller.guestDiskPollerStatus(), false, '범위 계정에도 나가는 폴러 상태에는 싣지 않는다');
    const again = await poller.runOrphanPrune();
    assert.equal(again.removedRows, 0, '두 번째는 지울 것이 없다');
    // 라우트는 정리 결과(전 함대의 삭제된 vCenter id)를 전체 범위 계정에게만 싣는다(소스 — 주석 제거 후)
    const { stripComments } = await import('./_stripComments.js');
    const route = stripComments(fs.readFileSync(new URL('../src/routes/api/toolsGuestDisk.js', import.meta.url), 'utf8'));
    assert.match(route, /!allowed && guestDiskOrphanPruneStatus\(\)/);
  } finally {
    store.snapshot = prev;
  }
});

test('VC-02 ③ 화면 문구 — 오래된 관측은 남긴 사실과 함께, 삭제된 vCenter 는 제외 사실을 말한다', async () => {
  const { reclaimFreshnessNote, coverageStateText } = await import('../../web/src/views/tools/guestDiskText.js');
  const t = reclaimFreshnessNote({ staleRows: 3, staleReclaimGB: 120.5, staleAfterMs: 36 * H, orphanRows: 2, orphanVcenters: 1 });
  assert.match(t, /VM 3대/);
  assert.match(t, /36시간/);
  assert.match(t, /빼지 않았습니다/);
  assert.match(t, /vCenter 1곳의 VM 2대/);
  assert.match(t, /제외/);
  assert.doesNotMatch(t, /`/);
  assert.equal(reclaimFreshnessNote({}), '', '구버전 서버(필드 없음)는 말하지 않는다');
  assert.equal(reclaimFreshnessNote({ staleRows: 0, orphanRows: 0 }), '');
  assert.equal(coverageStateText({ vmCount: 3, stale: true }), '⚠ 오래된 관측');
  assert.equal(coverageStateText({ vmCount: 3 }), '✅ 데이터 있음');
  assert.equal(coverageStateText({ vmCount: 0, collectSource: 'site' }), '⏳ 엣지 push 대기');
  assert.equal(coverageStateText({ vmCount: 0, collectSource: 'direct' }), '⏳ 미수집');
  const src = fs.readFileSync(new URL('../../web/src/views/tools/GuestDiskReport.jsx', import.meta.url), 'utf8');
  assert.match(src, /reclaimFreshnessNote\(data\)/, '화면이 그 문구를 그린다');
  assert.match(src, /coverageStateText\(c\)/);
});
