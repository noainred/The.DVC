// 같은 슬롯 재실행 시 증감 이력 보존(확정 버그 수정) — v2.371.
// 재실행(수동 스냅샷)은 **이미 갱신된 로스터**를 기준으로 diff 하므로 변경분이 0건으로
// 재계산된다. 과거에는 (a) snaps upsert 가 added/removed 를 excluded(=0) 로 덮어쓰고
// (b) changes/ds_changes 를 무조건 DELETE 해서, 최초 실행이 남긴 '어떤 VM/DS 가 변했는지'가
// 영구 소실됐다. 수정: upsert 는 MAX 로 보존, DELETE 는 신규 적재분이 1건 이상일 때만.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmtrack-rerun-'));
process.env.VMTRACK_DB_PATH = path.join(tmp, 'vm-track.db');

const sqliteOk = await import('node:sqlite').then(() => true).catch(() => false);
const db = await import('../src/vmtrack/db.js');

const vm = (id, name) => ({ vmId: id, name, cluster: 'C1', host: 'esx1', datastore: 'ds1', powerState: 'POWERED_ON', cpu: 2, memMB: 4096, storageGB: 40, guestOS: 'Ubuntu' });

test('같은 슬롯 빈손 재실행이 증감 이력을 지우지 않는다', { skip: !sqliteOk ? 'node:sqlite 미지원 런타임' : false }, async () => {
  assert.ok(await db.getDb(), 'DB 초기화');

  // 1) 기준선 슬롯 — vm-1 만.
  let r = await db.commitSnapshot({
    slot: '2026-08-27T00', ts: 1_000,
    perVc: [{ vcenterId: 'vc1', total: 1, onCount: 1, added: [], removed: [], live: [vm('vc1:vm-1', 'a')], baseline: true }],
    totalRow: { total: 1, onCount: 1, added: 0, removed: 0, baseline: true },
  });
  assert.equal(r.ok, true);

  // 2) 다음 슬롯 최초 실행 — vm-2·vm-3 생성(added=2).
  const live2 = [vm('vc1:vm-1', 'a'), vm('vc1:vm-2', 'b'), vm('vc1:vm-3', 'c')];
  r = await db.commitSnapshot({
    slot: '2026-08-27T12', ts: 2_000,
    perVc: [{ vcenterId: 'vc1', total: 3, onCount: 3, added: [vm('vc1:vm-2', 'b'), vm('vc1:vm-3', 'c')], removed: [], live: live2, baseline: false }],
    totalRow: { total: 3, onCount: 3, added: 2, removed: 0, baseline: false },
  });
  assert.equal(r.ok, true);

  const changesBefore = await db.readChanges({ slot: '2026-08-27T12' });
  assert.equal(changesBefore.filter((c) => c.kind === 'added').length, 2, '최초 실행: added 상세 2건');
  const seriesBefore = await db.readSeries({ sinceTs: 0, vcenterId: 'vc1' });
  const rowBefore = seriesBefore.find((x) => x.slot === '2026-08-27T12');
  assert.equal(rowBefore.added, 2, '최초 실행: added 카운트 2');

  // 3) **같은 슬롯 재실행** — 로스터가 이미 갱신됐으니 diff 는 0건(빈손).
  r = await db.commitSnapshot({
    slot: '2026-08-27T12', ts: 2_500,
    perVc: [{ vcenterId: 'vc1', total: 3, onCount: 3, added: [], removed: [], live: live2, baseline: false }],
    totalRow: { total: 3, onCount: 3, added: 0, removed: 0, baseline: false },
  });
  assert.equal(r.ok, true);

  // 이력이 보존되어야 한다(과거에는 0건으로 소실).
  const changesAfter = await db.readChanges({ slot: '2026-08-27T12' });
  assert.equal(changesAfter.filter((c) => c.kind === 'added').length, 2, '재실행 후에도 added 상세 2건 보존');
  const seriesAfter = await db.readSeries({ sinceTs: 0, vcenterId: 'vc1' });
  const rowAfter = seriesAfter.find((x) => x.slot === '2026-08-27T12');
  assert.equal(rowAfter.added, 2, '재실행 후에도 added 카운트 2 보존');
  assert.equal(rowAfter.total, 3, 'total 은 최신값으로 갱신');
});

test('실제 변경이 있는 재실행은 이력을 최신으로 교체한다(중복 누적 없음)', { skip: !sqliteOk ? 'node:sqlite 미지원 런타임' : false }, async () => {
  // 같은 슬롯을 '변경분 있는' 상태로 두 번 커밋 → 누적되지 않고 교체되어야 한다.
  const added1 = [vm('vc2:vm-9', 'x')];
  let r = await db.commitSnapshot({
    slot: '2026-08-28T00', ts: 3_000,
    perVc: [{ vcenterId: 'vc2', total: 1, onCount: 1, added: added1, removed: [], live: added1, baseline: false }],
    totalRow: { total: 1, onCount: 1, added: 1, removed: 0, baseline: false },
  });
  assert.equal(r.ok, true);
  r = await db.commitSnapshot({
    slot: '2026-08-28T00', ts: 3_500,
    perVc: [{ vcenterId: 'vc2', total: 1, onCount: 1, added: added1, removed: [], live: added1, baseline: false }],
    totalRow: { total: 1, onCount: 1, added: 1, removed: 0, baseline: false },
  });
  assert.equal(r.ok, true);
  const ch = await db.readChanges({ slot: '2026-08-28T00' });
  assert.equal(ch.filter((c) => c.kind === 'added' && c.vcenter_id === 'vc2').length, 1, '중복 누적 없이 1건');
});
