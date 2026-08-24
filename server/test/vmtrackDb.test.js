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
