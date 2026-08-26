// VM 수량 추이 DB 왕복 테스트(v2.345) — 임시 CONFIG_DIR 에 실제 vm-track.db 를 만들어
// 커밋→조회→diff 를 검증한다(순수 로직 테스트와 별개로 스키마·UPSERT·트랜잭션 실동작 확인).
// node:sqlite 가 없는 런타임에서는 skip(기능도 그 환경에선 available:false 로 비활성).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmtrack-'));
process.env.VMTRACK_DB_PATH = path.join(tmp, 'vm-track.db');

const sqliteOk = await import('node:sqlite').then(() => true).catch(() => false);
const db = await import('../src/vmtrack/db.js');

test('DB 왕복: 커밋 → 시계열/변경 조회 → 로스터 diff 기준', { skip: !sqliteOk ? 'node:sqlite 미지원 런타임' : false }, async () => {
  const ok = await db.getDb();
  assert.ok(ok, 'DB 초기화');
  assert.equal(db.vmtrackStatus().available, true);

  // 1차(기준선): vc1 2대.
  const live1 = [
    { vmId: 'vc1:vm-1', name: 'a', cluster: 'C1', host: 'esx1', datastore: 'ds1', powerState: 'POWERED_ON', cpu: 2, memMB: 4096, storageGB: 40, guestOS: 'Ubuntu' },
    { vmId: 'vc1:vm-2', name: 'b', cluster: 'C1', host: 'esx2', datastore: 'ds1', powerState: 'POWERED_OFF', cpu: 4, memMB: 8192, storageGB: 80, guestOS: 'CentOS' },
  ];
  let r = await db.commitSnapshot({
    slot: '2026-08-20T00', ts: 1_000,
    perVc: [{ vcenterId: 'vc1', total: 2, onCount: 1, added: [], removed: [], live: live1, baseline: true }],
    totalRow: { total: 2, onCount: 1, added: 0, removed: 0, baseline: true },
  });
  assert.equal(r.ok, true);

  const roster = await db.loadRoster('vc1');
  assert.equal(roster.size, 2, '로스터가 다음 diff 기준으로 저장됨');
  assert.equal(roster.get('vc1:vm-1').cluster, 'C1');

  // 2차: vm-2 삭제, vm-3 생성.
  const live2 = [live1[0], { vmId: 'vc1:vm-3', name: 'c', cluster: 'C2', host: 'esx3', datastore: 'ds2', powerState: 'POWERED_ON', cpu: 8, memMB: 16384, storageGB: 200, guestOS: 'RHEL' }];
  r = await db.commitSnapshot({
    slot: '2026-08-20T12', ts: 2_000,
    perVc: [{
      vcenterId: 'vc1', total: 2, onCount: 2,
      added: [live2[1]],
      removed: [{ vmId: 'vc1:vm-2', name: 'b', cluster: 'C1', host: 'esx2', datastore: 'ds1', powerState: 'POWERED_OFF', cpu: 4, memMB: 8192, storageGB: 80, guestOS: 'CentOS' }],
      live: live2, baseline: false,
    }],
    totalRow: { total: 2, onCount: 2, added: 1, removed: 1, baseline: false },
  });
  assert.equal(r.ok, true);

  // 시계열(전체 합계 행)
  const series = await db.readSeries({ vcenterId: '', sinceTs: 0 });
  assert.equal(series.length, 2);
  assert.equal(series[1].added, 1);
  assert.equal(series[1].removed, 1);

  // 변경 상세 — 슬롯 기준(전 vCenter)
  const changes = await db.readChanges({ slot: '2026-08-20T12' });
  assert.equal(changes.length, 2);
  const addedRow = changes.find((c) => c.kind === 'added');
  const removedRow = changes.find((c) => c.kind === 'removed');
  assert.equal(addedRow.name, 'c');
  assert.equal(addedRow.cluster, 'C2');
  assert.equal(addedRow.host, 'esx3');
  assert.equal(addedRow.datastore, 'ds2');
  assert.equal(removedRow.name, 'b');
  assert.equal(removedRow.host, 'esx2', '삭제 VM 의 마지막 위치 보존');

  // 로스터 갱신: 삭제분 제거 + 신규 반영
  const roster2 = await db.loadRoster('vc1');
  assert.deepEqual([...roster2.keys()].sort(), ['vc1:vm-1', 'vc1:vm-3']);
  assert.equal(await db.lastSnapshotSlot(), '2026-08-20T12');

  // 같은 슬롯 재실행(수동 스냅샷) → UPSERT 로 행이 늘지 않고 변경도 중복되지 않음
  r = await db.commitSnapshot({
    slot: '2026-08-20T12', ts: 2_500,
    perVc: [{ vcenterId: 'vc1', total: 2, onCount: 2, added: [live2[1]], removed: [], live: live2, baseline: false }],
    totalRow: { total: 2, onCount: 2, added: 1, removed: 0, baseline: false },
  });
  assert.equal(r.ok, true);
  assert.equal((await db.readSeries({ vcenterId: '', sinceTs: 0 })).length, 2, '슬롯 UPSERT — 행 증가 없음');
  assert.equal((await db.readChanges({ slot: '2026-08-20T12' })).length, 1, '이전 changes 는 교체됨');

  // 등록 해제 vCenter 로스터 정리
  assert.deepEqual(await db.rosterVcenters(), ['vc1']);
  await db.dropRoster('vc1');
  assert.equal((await db.loadRoster('vc1')).size, 0);
});

test('DB 왕복(v2.347): 전원 전환 카운터·changes kind 저장/조회', { skip: !sqliteOk ? 'node:sqlite 미지원 런타임' : false }, async () => {
  const live = [{ vmId: 'vc2:a', name: 'a', cluster: 'C1', host: 'esx1', datastore: 'ds1', powerState: 'POWERED_ON', cpu: 2, memMB: 2048, storageGB: 20, guestOS: 'Ubuntu' }];
  const r = await db.commitSnapshot({
    slot: '2026-08-24T00', ts: 9_000,
    perVc: [{
      vcenterId: 'vc2', total: 1, onCount: 1, added: [], removed: [],
      poweredOn: [{ ...live[0], prevPowerState: 'POWERED_OFF' }],
      poweredOff: [],
      live, baseline: false,
    }],
    totalRow: { total: 1, onCount: 1, added: 0, removed: 0, poweredOn: 1, poweredOff: 0, baseline: false },
  });
  assert.equal(r.ok, true);

  const rows = await db.readSeries({ vcenterId: 'vc2', sinceTs: 0 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].powered_on, 1, '전환 카운터가 시계열에 저장됨(차트 원천)');
  assert.equal(rows[0].powered_off, 0);

  const changes = await db.readChanges({ slot: '2026-08-24T00' });
  const onRow = changes.find((c) => c.kind === 'powered_on');
  assert.ok(onRow, 'kind=powered_on 행 저장');
  assert.equal(onRow.name, 'a');
  assert.equal(onRow.host, 'esx1', '전환 VM 도 위치 정보 포함(클릭 상세)');
  assert.equal(onRow.datastore, 'ds1');
});

test('DB 왕복(v2.348): 데이터스토어 집계 열 + ds_changes/ds_roster', { skip: !sqliteOk ? 'node:sqlite 미지원 런타임' : false }, async () => {
  const dsLive = [
    { dsId: 'vc3:d1', name: 'd1', type: 'vsan', capGB: 1000, usedGB: 450, freeGB: 550, usagePct: 45 },
    { dsId: 'vc3:d2', name: 'd2', type: 'NFS', capGB: 2000, usedGB: 100, freeGB: 1900, usagePct: 5 },
  ];
  // 1차: 기준선(변경 없음)
  let r = await db.commitSnapshot({
    slot: '2026-08-24T12', ts: 20_000,
    perVc: [{
      vcenterId: 'vc3', total: 0, onCount: 0, added: [], removed: [], poweredOn: [], poweredOff: [], live: [],
      ds: { count: 2, capGB: 3000, usedGB: 550, added: [], removed: [], changed: [], live: dsLive },
      baseline: true,
    }],
    totalRow: { total: 0, onCount: 0, added: 0, removed: 0, poweredOn: 0, poweredOff: 0, dsCount: 2, dsCapGB: 3000, dsUsedGB: 550, baseline: true },
  });
  assert.equal(r.ok, true);
  let rows = await db.readSeries({ vcenterId: 'vc3', sinceTs: 0 });
  assert.equal(rows[0].ds_count, 2);
  assert.equal(rows[0].ds_cap_gb, 3000);
  assert.equal(rows[0].ds_used_gb, 550);

  const dsRoster = await db.loadDsRoster('vc3');
  assert.equal(dsRoster.size, 2, 'DS 로스터가 다음 diff 기준으로 저장');
  assert.equal(dsRoster.get('vc3:d1').used_gb, 450);

  // 2차: d1 사용량 +50GB, d2 연결 해제
  r = await db.commitSnapshot({
    slot: '2026-08-25T00', ts: 21_000,
    perVc: [{
      vcenterId: 'vc3', total: 0, onCount: 0, added: [], removed: [], poweredOn: [], poweredOff: [], live: [],
      ds: {
        count: 1, capGB: 1000, usedGB: 500,
        added: [], removed: [dsLive[1]],
        changed: [{ ...dsLive[0], usedGB: 500, prevUsedGB: 450, deltaGB: 50 }],
        live: [{ ...dsLive[0], usedGB: 500 }],
      },
      baseline: false,
    }],
    totalRow: { total: 0, onCount: 0, added: 0, removed: 0, poweredOn: 0, poweredOff: 0, dsCount: 1, dsCapGB: 1000, dsUsedGB: 500, baseline: false },
  });
  assert.equal(r.ok, true);

  const dsChanges = await db.readDsChanges({ slot: '2026-08-25T00' });
  assert.equal(dsChanges.length, 2);
  const changed = dsChanges.find((c) => c.kind === 'ds_changed');
  assert.equal(changed.name, 'd1');
  assert.equal(changed.delta_gb, 50);
  assert.equal(changed.prev_used_gb, 450, '상세에서 이전→현재 표시용');
  const removed = dsChanges.find((c) => c.kind === 'ds_removed');
  assert.equal(removed.name, 'd2');
  assert.equal(removed.used_gb, 100, '해제된 DS 는 마지막 관측치');

  const roster2 = await db.loadDsRoster('vc3');
  assert.deepEqual([...roster2.keys()], ['vc3:d1'], '해제된 DS 는 로스터에서 제거');
  assert.equal(roster2.get('vc3:d1').used_gb, 500, '변경분 반영');
});

test('DB 왕복(v2.353): ds_series — 첫 관측/변화 기록, carry-in, 같은 슬롯 재실행 무중복', { skip: !sqliteOk ? 'node:sqlite 미지원 런타임' : false }, async () => {
  const mk = (dsId, capGB, usedGB) => ({ dsId, name: dsId.split(':')[1], type: 'VMFS', capGB, usedGB, freeGB: capGB - usedGB, usagePct: Math.round((usedGB / capGB) * 1000) / 10 });
  // 1차(기준선): 두 DS 모두 series 에 기록.
  let r = await db.commitSnapshot({
    slot: '2026-08-21T00', ts: 10_000,
    perVc: [{ vcenterId: 'vcds', total: 0, onCount: 0, added: [], removed: [], live: [], baseline: true,
      ds: { count: 2, capGB: 3000, usedGB: 600, added: [], removed: [], changed: [],
        live: [mk('vcds:a', 1000, 500), mk('vcds:b', 2000, 100)],
        series: [mk('vcds:a', 1000, 500), mk('vcds:b', 2000, 100)], baseline: true } }],
    totalRow: { total: 0, onCount: 0, added: 0, removed: 0, dsCount: 2, dsCapGB: 3000, dsUsedGB: 600, baseline: true },
  });
  assert.equal(r.ok, true);

  // 2차: a 만 +10GB 변화 → a 만 기록.
  r = await db.commitSnapshot({
    slot: '2026-08-21T12', ts: 20_000,
    perVc: [{ vcenterId: 'vcds', total: 0, onCount: 0, added: [], removed: [], live: [], baseline: false,
      ds: { count: 2, capGB: 3000, usedGB: 610, added: [], removed: [],
        changed: [{ ...mk('vcds:a', 1000, 510), prevUsedGB: 500, deltaGB: 10 }],
        live: [mk('vcds:a', 1000, 510), mk('vcds:b', 2000, 100)],
        series: [mk('vcds:a', 1000, 510)], baseline: false } }],
    totalRow: { total: 0, onCount: 0, added: 0, removed: 0, dsCount: 2, dsCapGB: 3000, dsUsedGB: 610, baseline: false },
  });
  assert.equal(r.ok, true);

  // a: 관측 2행(500 → 510). b: 첫 관측 1행뿐(변화 없음 — diff-압축).
  let sa = await db.readDsSeries({ dsId: 'vcds:a', sinceTs: 0 });
  assert.equal(sa.rows.length, 2);
  assert.deepEqual(sa.rows.map((x) => x.used_gb), [500, 510]);
  const sb = await db.readDsSeries({ dsId: 'vcds:b', sinceTs: 0 });
  assert.equal(sb.rows.length, 1);

  // carry-in: 윈도우가 2차 이후부터면 a 의 시작값은 직전 관측(510).
  sa = await db.readDsSeries({ dsId: 'vcds:a', sinceTs: 15_000 });
  assert.equal(sa.carryIn.used_gb, 500, '윈도우 직전 마지막 관측');
  assert.equal(sa.rows.length, 1);

  // 같은 슬롯 재실행(수동 스냅샷): UNIQUE(slot, ds_id) upsert — 행이 늘지 않고 값만 갱신.
  r = await db.commitSnapshot({
    slot: '2026-08-21T12', ts: 21_000,
    perVc: [{ vcenterId: 'vcds', total: 0, onCount: 0, added: [], removed: [], live: [], baseline: false,
      ds: { count: 2, capGB: 3000, usedGB: 612, added: [], removed: [], changed: [],
        live: [mk('vcds:a', 1000, 512), mk('vcds:b', 2000, 100)],
        series: [mk('vcds:a', 1000, 512)], baseline: false } }],
    totalRow: { total: 0, onCount: 0, added: 0, removed: 0, dsCount: 2, dsCapGB: 3000, dsUsedGB: 612, baseline: false },
  });
  assert.equal(r.ok, true);
  sa = await db.readDsSeries({ dsId: 'vcds:a', sinceTs: 0 });
  assert.equal(sa.rows.length, 2, '같은 슬롯은 중복 행이 아니라 갱신');
  assert.deepEqual(sa.rows.map((x) => x.used_gb), [500, 512]);

  // 기간 증감 상위 재료: 로스터 + 윈도우/carry 조회가 값을 돌려준다.
  const roster = await db.listDsRoster();
  assert.ok(roster.some((x) => x.ds_id === 'vcds:a'));
  const win = await db.dsSeriesWindow(15_000);
  assert.ok(win.some((x) => x.ds_id === 'vcds:a'));
  const carry = await db.dsSeriesCarry(15_000);
  assert.ok(carry.some((x) => x.ds_id === 'vcds:a' && x.used_gb === 500));
});

test('service(v2.354): vmtrackDsSeriesAll — 선택 vCenter 의 전체 DS 를 슬롯 축에 step 으로', { skip: !sqliteOk ? 'node:sqlite 미지원 런타임' : false }, async () => {
  const svc = await import('../src/vmtrack/service.js');
  // 서비스는 Date.now() 기준 윈도우라 실제 최근 ts 로 커밋한다.
  const now = Date.now();
  const t1 = now - 3_600_000;
  const t2 = now;
  const mk = (dsId, capGB, usedGB) => ({ dsId, name: dsId.split(':')[1], type: 'NFS', capGB, usedGB, freeGB: capGB - usedGB, usagePct: Math.round((usedGB / capGB) * 1000) / 10 });
  let r = await db.commitSnapshot({
    slot: '2026-08-24T00', ts: t1,
    perVc: [{ vcenterId: 'vcsvc', total: 0, onCount: 0, added: [], removed: [], live: [], baseline: true,
      ds: { count: 2, capGB: 3000, usedGB: 700, added: [], removed: [], changed: [],
        live: [mk('vcsvc:big', 2000, 600), mk('vcsvc:small', 1000, 100)],
        series: [mk('vcsvc:big', 2000, 600), mk('vcsvc:small', 1000, 100)], baseline: true } }],
    totalRow: { total: 0, onCount: 0, added: 0, removed: 0, dsCount: 2, dsCapGB: 3000, dsUsedGB: 700, baseline: true },
  });
  assert.equal(r.ok, true);
  r = await db.commitSnapshot({
    slot: '2026-08-24T12', ts: t2,
    perVc: [{ vcenterId: 'vcsvc', total: 0, onCount: 0, added: [], removed: [], live: [], baseline: false,
      ds: { count: 2, capGB: 3000, usedGB: 750, added: [], removed: [],
        changed: [{ ...mk('vcsvc:big', 2000, 650), prevUsedGB: 600, deltaGB: 50 }],
        live: [mk('vcsvc:big', 2000, 650), mk('vcsvc:small', 1000, 100)],
        series: [mk('vcsvc:big', 2000, 650)], baseline: false } }],
    totalRow: { total: 0, onCount: 0, added: 0, removed: 0, dsCount: 2, dsCapGB: 3000, dsUsedGB: 750, baseline: false },
  });
  assert.equal(r.ok, true);

  // vCenter 미지정은 거부(전체 일괄은 응답이 수 MB — 지원하지 않음).
  const none = await svc.vmtrackDsSeriesAll({ days: 30, vcenterId: '' });
  assert.equal(none.total, 0);
  assert.ok(none.reason);

  const all = await svc.vmtrackDsSeriesAll({ days: 30, vcenterId: 'vcsvc' });
  assert.equal(all.total, 2);
  const big = all.items.find((x) => x.dsId === 'vcsvc:big');
  const small = all.items.find((x) => x.dsId === 'vcsvc:small');
  // 슬롯 2개 축 위에 step: big 은 600→650, small 은 관측 1회지만 두 슬롯 모두 100 유지.
  assert.deepEqual(big.points.map((p) => p.usedGB), [600, 650]);
  assert.deepEqual(small.points.map((p) => p.usedGB), [100, 100]);
  assert.equal(big.deltaGB, 50);
  assert.equal(small.deltaGB, 0);
  // 기본 정렬은 사용량 큰 순.
  assert.equal(all.items[0].dsId, 'vcsvc:big');

  // 페이지: limit 1 → 1개씩, offset 이동.
  const p1 = await svc.vmtrackDsSeriesAll({ days: 30, vcenterId: 'vcsvc', limit: 1, offset: 1 });
  assert.equal(p1.total, 2);
  assert.equal(p1.items.length, 1);
  assert.equal(p1.items[0].dsId, 'vcsvc:small');

  // 검색어 필터.
  const qq = await svc.vmtrackDsSeriesAll({ days: 30, vcenterId: 'vcsvc', q: 'big' });
  assert.equal(qq.total, 1);

  // scope 밖 vCenter 는 빈 결과(사용자 데이터 범위 강제).
  const scoped = await svc.vmtrackDsSeriesAll({ days: 30, vcenterId: 'vcsvc', scopeIds: new Set(['other']) });
  assert.equal(scoped.total, 0);
});

test('보안(v2.364): snapId 로 조회해도 scope 밖 vCenter 변경은 새지 않는다', { skip: !sqliteOk ? 'node:sqlite 미지원 런타임' : false }, async () => {
  const svc = await import('../src/vmtrack/service.js');
  const slot = '2026-08-26T00';
  const vmA = { vmId: 'vcA:1', name: 'a1', cluster: 'C', host: 'h', datastore: 'd', powerState: 'POWERED_ON', cpu: 1, memMB: 1024, storageGB: 10, guestOS: 'L' };
  const vmB = { vmId: 'vcB:1', name: 'b1', cluster: 'C', host: 'h', datastore: 'd', powerState: 'POWERED_ON', cpu: 1, memMB: 1024, storageGB: 10, guestOS: 'L' };
  const r = await db.commitSnapshot({
    slot, ts: 30_000,
    perVc: [
      { vcenterId: 'vcscopeA', total: 1, onCount: 1, added: [vmA], removed: [], live: [vmA], baseline: false,
        ds: { count: 1, capGB: 100, usedGB: 10, added: [{ dsId: 'vcA:ds', name: 'dsA', type: 'NFS', capGB: 100, usedGB: 10, freeGB: 90, usagePct: 10 }], removed: [], changed: [], live: [], series: [] } },
      { vcenterId: 'vcscopeB', total: 1, onCount: 1, added: [vmB], removed: [], live: [vmB], baseline: false,
        ds: { count: 1, capGB: 100, usedGB: 20, added: [{ dsId: 'vcB:ds', name: 'dsB', type: 'NFS', capGB: 100, usedGB: 20, freeGB: 80, usagePct: 20 }], removed: [], changed: [], live: [], series: [] } },
    ],
    totalRow: { total: 2, onCount: 2, added: 2, removed: 0, baseline: false, dsCount: 2, dsCapGB: 200, dsUsedGB: 30 },
  });
  assert.equal(r.ok, true);

  // vcscopeB 의 snapId 확보(공격자가 순차 정수 snapId 를 열거하는 상황을 모사).
  const allRows = await db.readSeries({ vcenterId: 'ALL', sinceTs: 0 });
  const snapB = allRows.find((x) => x.slot === slot && x.vcenter_id === 'vcscopeB');
  assert.ok(snapB?.id, 'vcscopeB 스냅샷 id');

  // 범위가 vcscopeA 뿐인 계정이 vcscopeB 의 snapId 로 조회 → 반드시 빈 결과(누출 차단).
  const leak = await svc.vmtrackChanges({ snapId: snapB.id, scopeIds: new Set(['vcscopeA']) });
  assert.equal(leak.length, 0, 'scope 밖 snapId 는 VM 변경이 새지 않아야 한다');
  const dsLeak = await svc.vmtrackDsChanges({ snapId: snapB.id, scopeIds: new Set(['vcscopeA']) });
  assert.equal(dsLeak.length, 0, 'scope 밖 snapId 는 DS 변경도 새지 않아야 한다');

  // 자기 범위(vcscopeB)면 정상 조회 + vcenterId 가 실려 온다(필터가 동작할 수 있는 근거).
  const own = await svc.vmtrackChanges({ snapId: snapB.id, scopeIds: new Set(['vcscopeB']) });
  assert.equal(own.length, 1);
  assert.equal(own[0].vmId, 'vcB:1');
  assert.equal(own[0].vcenterId, 'vcscopeB', 'SELECT 에 vcenter_id 가 실려야 scope 필터가 동작');
  const ownDs = await svc.vmtrackDsChanges({ snapId: snapB.id, scopeIds: new Set(['vcscopeB']) });
  assert.equal(ownDs.length, 1);
  assert.equal(ownDs[0].vcenterId, 'vcscopeB');

  // 범위 무제한(scopeIds=null)은 전부 조회(관리자).
  const admin = await svc.vmtrackChanges({ snapId: snapB.id, scopeIds: null });
  assert.equal(admin.length, 1);
});

test('service(v2.355): ds-change-log / ds-pivot — 슬롯 칩 로그와 DS별 피벗', { skip: !sqliteOk ? 'node:sqlite 미지원 런타임' : false }, async () => {
  const svc = await import('../src/vmtrack/service.js');
  // 앞 테스트(vcsvc)에서 2026-08-24T12 슬롯에 big +50GB 변경이 기록돼 있다.
  const log = await svc.vmtrackDsChangeLog({ days: 30, vcenterId: 'vcsvc' });
  const slot12 = log.slots.find((g) => g.slot === '2026-08-24T12');
  assert.ok(slot12, '변경이 있던 슬롯이 로그에 나온다');
  assert.equal(slot12.items.length, 1);
  assert.equal(slot12.items[0].dsId, 'vcsvc:big');
  assert.equal(slot12.items[0].deltaGB, 50);
  assert.equal(slot12.sumDeltaGB, 50);
  // 기준선 슬롯(변경 0)은 행 자체가 없다(변경분만 저장 — 정직한 로그).
  assert.ok(!log.slots.find((g) => g.slot === '2026-08-24T00'));

  // 피벗: changedOnly 기본 — 움직인 big 만. 슬롯 칸은 변경 없으면 0, 관측 전이면 null.
  const piv = await svc.vmtrackDsPivot({ days: 30, vcenterId: 'vcsvc' });
  assert.ok(piv.slotCols.length >= 1);
  const big = piv.items.find((x) => x.dsId === 'vcsvc:big');
  assert.ok(big, '변화한 DS 는 나온다');
  assert.equal(big.slots['2026-08-24T12']?.deltaGB, 50);
  assert.ok(!piv.items.find((x) => x.dsId === 'vcsvc:small'), 'changedOnly 기본 — 무변화 DS 숨김');
  const all = await svc.vmtrackDsPivot({ days: 30, vcenterId: 'vcsvc', changedOnly: false });
  assert.ok(all.items.find((x) => x.dsId === 'vcsvc:small'), 'changedOnly=false 면 전체');
  // scope 강제.
  const scoped = await svc.vmtrackDsPivot({ days: 30, vcenterId: 'vcsvc', scopeIds: new Set(['other']) });
  assert.equal(scoped.total, 0);
});

// 이 테스트는 dropRoster 로 다른 vc 로스터를 지울 수 있어 **파일 맨 끝**에 둔다(뒤 테스트 오염 방지).
test('정합(v2.366): 일시 unreachable vCenter 의 로스터는 보존(복구 시 +N 오탐 방지)', { skip: !sqliteOk ? 'node:sqlite 미지원 런타임' : false }, async () => {
  const svc = await import('../src/vmtrack/service.js');
  // 1) vcU 로스터 확립(연결·VM 1대).
  await svc.takeVmSnapshot({
    vcenters: [{ id: 'vcU', status: 'connected' }],
    vms: [{ vcenterId: 'vcU', vmId: 'vcU:1', name: 'x', powerState: 'POWERED_ON', cpu: 1, memMB: 1024, storageGB: 10 }],
    datastores: [],
  }, { trigger: 'test', now: new Date('2026-08-27T00:30:00') });
  assert.equal((await db.loadRoster('vcU')).size, 1, 'vcU 로스터 확립');

  // 2) 이번 스냅샷: 기존 로스터의 vc 는 전부 unreachable+VM0(처리에서 제외)로 두고, 새 healthy vc
  //    하나에만 VM 을 준다. 기존 vc 들을 모두 snap.vcenters 에 등재(status 무관)해 등록해제로 오인
  //    되지 않게 한다 — vcU 로스터가 삭제되면 안 된다.
  const existing = await db.rosterVcenters();
  const vcenters = existing.map((id) => ({ id, status: 'unreachable' }))
    .concat([{ id: 'vcHealthy366', status: 'connected' }]);
  await svc.takeVmSnapshot({
    vcenters,
    vms: [{ vcenterId: 'vcHealthy366', vmId: 'vcHealthy366:1', name: 'h', powerState: 'POWERED_ON', cpu: 1, memMB: 1024, storageGB: 10 }],
    datastores: [],
  }, { trigger: 'test', now: new Date('2026-08-27T12:30:00') });
  assert.equal((await db.loadRoster('vcU')).size, 1, '일시 unreachable vc 의 로스터는 삭제되지 않는다');

  // 3) 등록 해제(스냅샷에서 아예 빠진) vc 는 여전히 정리된다: vcU 를 뺀 목록으로 스냅샷.
  await svc.takeVmSnapshot({
    vcenters: [{ id: 'vcHealthy366', status: 'connected' }],
    vms: [{ vcenterId: 'vcHealthy366', vmId: 'vcHealthy366:1', name: 'h', powerState: 'POWERED_ON', cpu: 1, memMB: 1024, storageGB: 10 }],
    datastores: [],
  }, { trigger: 'test', now: new Date('2026-08-28T00:30:00') });
  assert.equal((await db.loadRoster('vcU')).size, 0, '스냅샷에서 사라진 vc 는 로스터 정리');
});
