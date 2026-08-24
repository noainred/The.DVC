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
