// 게스트 디스크 회수 리포트 재개발(v2.466) — 엣지 push 수신 sanitize + 커버리지 DB 조회 회귀 고정.
//
// 근본 원인(재개발 배경): 중앙은 collectMode='site' vCenter 에 직접 SOAP 를 못 걸어 guest.disk 를
// 라이브 조회할 수 없다 → site vCenter 는 게스트 디스크 데이터가 아예 없었다. 해결: 엣지가 로컬
// vCenter 의 guest.disk 를 수집해 /api/central/guest-disk 로 push 하고 중앙이 커밋한다.
// 여기서는 (1) 엣지를 맹신하지 않는 sanitize, (2) 커버리지(수집 유무·신선도) 조회를 고정한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sanitizeGuestDiskVms } from '../src/guestdisk/analyze.js';

test('sanitizeGuestDiskVms — 식별불가 행 제거·숫자 강제·파티션 상한', () => {
  const raw = [
    { vmId: 'vc:vm-1', vmName: 'W1', allocGB: 100, usedGB: 20, partCount: 1, parts: [{ path: 'C:\\', capGB: 100, usedGB: 20 }] },
    { vmName: 'no-id' },                                   // vmId 없음 → 버린다(DB PK)
    { vmId: 'vc:vm-2', allocGB: -5, usedGB: 'x', parts: [{ path: 'D:\\', capGB: -1, usedGB: NaN }, { /* 잡음 */ }, null] },
  ];
  const out = sanitizeGuestDiskVms(raw);
  assert.equal(out.length, 2, 'vmId 없는 행은 제외');
  assert.equal(out[0].vmName, 'W1');
  assert.equal(out[0].parts[0].capGB, 100);
  // 음수·비유한 값은 0 으로 강제(트래픽 없음/오염 방지), vmName 없으면 vmId 로 폴백.
  assert.equal(out[1].allocGB, 0);
  assert.equal(out[1].usedGB, 0);
  assert.equal(out[1].vmName, 'vc:vm-2');
  assert.equal(out[1].parts[0].capGB, 0);
  assert.equal(out[1].parts[0].usedGB, 0);
  // partCount 미지정이면 실제 파티션 수로 채운다(null/잡음 파티션은 걸러진 뒤 카운트).
  assert.equal(out[1].partCount, 1);
});

test('sanitizeGuestDiskVms — VM/파티션 상한으로 폭주 방지', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ vmId: `vm-${i}`, parts: Array.from({ length: 5 }, (_, j) => ({ path: `p${j}`, capGB: 1, usedGB: 1 })) }));
  const out = sanitizeGuestDiskVms(many, { maxVms: 3, maxParts: 2 });
  assert.equal(out.length, 3, 'maxVms 상한');
  assert.equal(out[0].parts.length, 2, 'maxParts 상한');
  assert.equal(out[0].partCount, 2, 'partCount 는 저장된 parts 수(상한 반영)');
});

test('sanitizeGuestDiskVms — partCount 는 엣지 신고값이 아닌 저장 파티션 수', () => {
  // 엣지가 partCount=4096 을 보내도 실제 저장 parts(상한 128 이내)만 반영해야 관측/표시가 일치.
  const raw = [{ vmId: 'vm-x', partCount: 4096, parts: [{ path: 'C:\\', capGB: 50, usedGB: 10 }, { path: 'D:\\', capGB: 20, usedGB: 5 }] }];
  const out = sanitizeGuestDiskVms(raw);
  assert.equal(out[0].partCount, 2, '신고 partCount(4096) 가 아니라 실제 parts.length(2)');
});

test('coverageByVcenter — vCenter별 데이터 유무·VM수·최신ts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-cov-'));
  process.env.GUESTDISK_DB_PATH = path.join(dir, 'guest-disk.db');
  const db = await import(`../src/guestdisk/db.js?t=${Date.now()}`);
  const gdb = await db.getDb();
  if (!gdb) { console.warn('node:sqlite 없음 — 커버리지 테스트 skip'); return; }

  const vmsA = sanitizeGuestDiskVms([
    { vmId: 'A:vm-1', vmName: 'a1', allocGB: 100, usedGB: 20, parts: [{ path: 'C:\\', capGB: 100, usedGB: 20 }] },
    { vmId: 'A:vm-2', vmName: 'a2', allocGB: 50, usedGB: 40, parts: [{ path: 'C:\\', capGB: 50, usedGB: 40 }] },
  ]);
  await db.commitCollection('A', 'VC A', vmsA, { ts: 5000, changeThresholdGB: 1 });
  await db.commitCollection('B', 'VC B', sanitizeGuestDiskVms([{ vmId: 'B:vm-1', vmName: 'b1', allocGB: 10, usedGB: 3, parts: [{ path: '/', capGB: 10, usedGB: 3 }] }]), { ts: 9000, changeThresholdGB: 1 });

  const cov = await db.coverageByVcenter(['A', 'B']);
  assert.equal(cov.get('A').vmCount, 2);
  assert.equal(cov.get('A').lastTs, 5000);
  assert.equal(cov.get('B').vmCount, 1);
  assert.equal(cov.get('B').lastTs, 9000);

  // scope 준수: 빈 배열이면 빈 결과(범위 밖 데이터 미노출), 선택 밖 vCenter 는 포함 안 함.
  assert.equal((await db.coverageByVcenter([])).size, 0);
  const only = await db.coverageByVcenter(['A']);
  assert.equal(only.size, 1);
  assert.ok(!only.has('B'));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('commitCollection — 빈 수집은 이전 latest 를 지우지 않는다(blip 방어)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-empty-'));
  process.env.GUESTDISK_DB_PATH = path.join(dir, 'guest-disk.db');
  const db = await import(`../src/guestdisk/db.js?t=${Date.now()}-e`);
  const gdb = await db.getDb();
  if (!gdb) { console.warn('node:sqlite 없음 — 빈수집 방어 테스트 skip'); return; }

  const vc = 'vc-e';
  await db.commitCollection(vc, 'VC E', [{ vmId: 'vc-e:vm-1', vmName: 'W1', allocGB: 100, usedGB: 20, partCount: 1, parts: [{ path: 'C:\\', capGB: 100, usedGB: 20 }] }], { ts: 1000, changeThresholdGB: 1 });
  assert.equal((await db.listLatest([vc])).length, 1, '수집 후 latest 1행');

  // 빈 수집(콜드스타트/Tools 미보고 blip) — DELETE 를 건너뛰어 이전 latest 유지.
  const r = await db.commitCollection(vc, 'VC E', [], { ts: 2000, changeThresholdGB: 1 });
  assert.equal(r.skippedEmpty, true, '빈 수집은 skippedEmpty');
  assert.equal((await db.listLatest([vc])).length, 1, '빈 수집이 latest 를 지우지 않는다');

  // 실제로 VM 이 줄어든(비지 않은) 수집은 사라진 VM 을 정상 제거한다.
  await db.commitCollection(vc, 'VC E', [{ vmId: 'vc-e:vm-2', vmName: 'W2', allocGB: 50, usedGB: 10, partCount: 1, parts: [{ path: 'C:\\', capGB: 50, usedGB: 10 }] }], { ts: 3000, changeThresholdGB: 1 });
  const latest = await db.listLatest([vc]);
  assert.equal(latest.length, 1);
  assert.equal(latest[0].vmId, 'vc-e:vm-2', '비지 않은 수집은 vm_latest 를 정상 교체');

  fs.rmSync(dir, { recursive: true, force: true });
});
