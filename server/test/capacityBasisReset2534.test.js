/**
 * capacityBasisReset2534.test.js — 측정 기준이 바뀐 장비의 용량 이력 1회 재시작.
 *
 * 사용자 결정(2026-09-16, AskUserQuestion): v2.534 가 VMAX/PowerMax 사용량을 '할당' 에서
 * '데이터 감축 후 실제 기록량' 으로 바꾸면 그 장비의 이력이 이어지지 않는다. 선택지는
 * ① 기준 열 추가 ② **해당 장비 이력만 삭제** ③ 그대로 두고 릴리스 노트로만 이었고 ②를 골랐다.
 *
 * 이 파일이 고정하는 것:
 *  - 대상 타입(vmax·powermax)만 지운다 — 다른 수집기의 이력을 건드리지 않는다.
 *  - **1회만** 실행된다(재기동마다 지우면 이력이 영원히 안 쌓인다).
 *  - 지운 사실을 장비별로 남긴다 — 화면이 '관측 N일' 이 왜 짧은지 말해야 한다(조용한 삭제 금지).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'capreset-'));
process.env.CONFIG_DIR = TMP;

const db = await import('../src/storage/db.js');
const { affectedDeviceIds, AFFECTED_TYPES, MIGRATION_ID, runCapacityBasisMigration } =
  await import('../src/storage/capacityBasisMigration.js');

const DEVICES = [
  { id: 'vm1', type: 'vmax' }, { id: 'vm2', type: 'VMAX' },
  { id: 'pm1', type: 'powermax' },
  { id: 'un1', type: 'unity' }, { id: 'is1', type: 'isilon' }, { id: 'vx1', type: 'vplex' },
];

test('대상은 vmax·powermax 뿐 — 다른 수집기 이력을 건드리지 않는다', () => {
  assert.deepEqual(affectedDeviceIds(DEVICES).sort(), ['pm1', 'vm1', 'vm2']);
  assert.deepEqual([...AFFECTED_TYPES], ['vmax', 'powermax']);
  assert.deepEqual(affectedDeviceIds([]), []);
  assert.deepEqual(affectedDeviceIds(null), []);
});

/** 장비 하나에 이력 점 n개를 심는다(원시 + 일 롤업 양쪽). */
async function seed(id, n) {
  for (let i = 0; i < n; i += 1) {
    await db.saveCapacityPoint({
      deviceId: id, ok: true, collectedAt: (20000 - i) * 86_400_000,
      capacity: { totalBytes: 100e12, usedBytes: 100e12 },   // v2.533 의 '100%' 행을 흉내낸다
    });
  }
}

test('★ 지정한 장비의 원시·일 롤업이 모두 지워지고, 다른 장비는 그대로다', async () => {
  await seed('vm1', 3); await seed('un1', 3);
  assert.ok((await db.dailySeries('vm1', 0)).length > 0, '심은 이력이 있어야 한다');

  const r = await db.resetCapacityHistory(['vm1'], { reason: '테스트' });
  assert.equal(r.ran, true);
  assert.ok(r.rows > 0, '지운 행 수를 보고한다');

  assert.equal((await db.dailySeries('vm1', 0)).length, 0, '대상 장비 이력이 비었다');
  assert.ok((await db.dailySeries('un1', 0)).length > 0, '다른 장비는 건드리지 않는다');
  assert.equal((await db.capacityHistory('vm1', 0)).length, 0, '원시 이력도 지운다');
});

test('★ 조용히 지우지 않는다 — 언제·왜 재시작했는지 남는다', async () => {
  const resets = await db.capacityResets();
  assert.ok(resets.vm1, '재시작 기록이 있어야 화면이 관측 N일을 설명할 수 있다');
  assert.equal(resets.vm1.reason, '테스트');
  assert.ok(Number.isFinite(resets.vm1.at));
  assert.ok(!resets.un1, '지우지 않은 장비에는 기록이 없다');
});

test('★ `once` 마커 — 두 번째 호출은 아무 것도 하지 않는다', async () => {
  await seed('pm1', 2);
  const first = await db.resetCapacityHistory(['pm1'], { reason: 'r', once: 'unit-test-once' });
  assert.equal(first.ran, true);
  await seed('pm1', 2);                         // 새 기준으로 다시 쌓였다고 가정
  const second = await db.resetCapacityHistory(['pm1'], { reason: 'r', once: 'unit-test-once' });
  assert.equal(second.ran, false, '재기동마다 지우면 이력이 영원히 안 쌓인다');
  assert.ok((await db.dailySeries('pm1', 0)).length > 0, '새로 쌓인 이력이 살아 있다');
});

test('지운 행이 0 이어도 재시작 기록은 남긴다(새 장비와 구분)', async () => {
  await db.resetCapacityHistory(['never-seen'], { reason: 'r2' });
  const resets = await db.capacityResets();
  assert.ok(resets['never-seen']);
  assert.equal(resets['never-seen'].rows, 0);
});

test('마이그레이션 — 타입 필터를 통과한 장비만, 그리고 1회만 돈다', async () => {
  await seed('vm2', 2); await seed('is1', 2);
  const a = await runCapacityBasisMigration({ devices: DEVICES });
  assert.equal(a.ran, true);
  assert.equal((await db.dailySeries('vm2', 0)).length, 0);
  assert.ok((await db.dailySeries('is1', 0)).length > 0, 'isilon 이력은 남는다');

  await seed('vm2', 2);
  const b = await runCapacityBasisMigration({ devices: DEVICES });
  assert.equal(b.ran, false, `마커(${MIGRATION_ID})가 재실행을 막는다`);
  assert.ok((await db.dailySeries('vm2', 0)).length > 0);
});

test('대상 장비가 하나도 없으면 아무 것도 하지 않는다', async () => {
  const r = await runCapacityBasisMigration({ devices: [{ id: 'x', type: 'unity' }] });
  assert.equal(r.ran, false);
});

test('소스 규약 — 기동 시 1회 호출이 배선돼 있다', () => {
  const code = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.ok(code.includes('runCapacityBasisMigration'), '기동에 배선되지 않으면 이력이 안 지워진다');
  assert.ok(/runCapacityBasisMigration\(\)[\s\S]{0,400}catch/.test(code),
    '이력 정리 실패가 포탈 기동을 막으면 안 된다');
});

test.after(() => { try { db._resetForTest(); fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
