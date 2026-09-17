/**
 * test/zeroCapacityPurge2541.test.js — 0 바이트 용량 행 1회 정리(v2.541).
 *
 * 배경: 사용자 신고(Unity `OC2-unity-03`)에서 **수집이 전량 실패인 장비**의 용량 추이가
 * `0.0 TB` 선으로 그려지고 있었다. 지금 적재 경로는 `capacityPointEligible`(v2.531)에
 * 막히므로 새 행은 생기지 않지만, 그 가드 이전에 쌓인 행은 남아 있다.
 *
 * ⚠ 이 테스트가 고정하는 것은 **'행만 지운다'** 는 경계다 — 장비 이력을 통째로 지우는
 * `capacityBasisMigration`(v2.534)과 섞이면 멀쩡한 이력이 사라진다.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmp; let db;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zerocap-'));
  process.env.CONFIG_DIR = tmp;
  const cfg = await import('../src/config.js');
  cfg.config.configDir = tmp;
  db = await import('../src/storage/db.js');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const snap = (deviceId, totalBytes, usedBytes, at) => ({
  deviceId, ok: true, collectedAt: at, capacity: { totalBytes, usedBytes },
});

test('0 바이트 행만 지우고 유효한 행은 남긴다', async () => {
  const DAY = 86400000;
  const t0 = Date.parse('2026-09-10T03:00:00Z');
  // 정상 장비 — 유효 2점
  await db.saveCapacityPoint(snap('good', 100e12, 40e12, t0));
  await db.saveCapacityPoint(snap('good', 100e12, 41e12, t0 + DAY));
  // 섞인 장비 — 유효 1점(그 뒤에 0 행을 직접 넣는다. 지금 API 로는 넣을 수 없다)
  await db.saveCapacityPoint(snap('mixed', 50e12, 10e12, t0));

  // 가드를 우회해 '옛 배포가 남긴' 0 행을 직접 심는다(재현).
  await db._insertRawCapacityForTest('mixed', t0 + DAY, 0, 0);
  await db._insertRawCapacityForTest('deadonly', t0 + DAY, 0, 0);
  await db._insertRawCapacityForTest('deadonly', t0 + 2 * DAY, null, null);

  const before2 = await db.dailySeries(null, 0);
  assert.ok(before2.some((r) => r.device_id === 'deadonly'), '심은 0 행이 있어야 한다');

  const r = await db.purgeZeroCapacityRows({ once: 'test-purge-1' });
  assert.equal(r.ran, true);
  assert.equal(r.devices, 2, '0 행을 가진 장비는 mixed·deadonly 둘');
  assert.ok(r.rows >= 3, `지운 행 수: ${r.rows}`);

  const after2 = await db.dailySeries(null, 0);
  const byDev = (id) => after2.filter((x) => x.device_id === id);
  assert.equal(byDev('good').length, 2, '정상 장비의 행은 건드리지 않는다');
  assert.equal(byDev('mixed').length, 1, '섞인 장비는 유효한 행만 남는다');
  assert.equal(byDev('deadonly').length, 0, '0 행뿐인 장비는 비워진다');
  assert.ok(after2.every((x) => Number(x.total_bytes) > 0), '0 이하 행이 남으면 안 된다');
});

test('마커로 1회만 돈다 — 재기동마다 지우지 않는다', async () => {
  const again = await db.purgeZeroCapacityRows({ once: 'test-purge-1' });
  assert.equal(again.ran, false, '같은 마커로 두 번째 실행은 no-op');
});

test('지운 사실을 장비별로 남긴다 — 조용한 삭제 금지', async () => {
  const resets = await db.capacityResets();
  assert.ok(resets.mixed, 'mixed 에 정리 기록이 있어야 한다');
  assert.equal(resets.mixed.kind, 'zero-rows', '기준 변경(v2.534)과 구분되는 종류여야 한다');
  assert.ok(Number(resets.mixed.rows) > 0);
  assert.ok(!resets.good, '행을 잃지 않은 장비에는 기록을 남기지 않는다');
});
