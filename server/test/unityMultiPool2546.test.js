/**
 * test/unityMultiPool2546.test.js — Unity 다중 풀 집계 회귀(v2.546).
 *
 * ── 왜 이 파일이 생겼나 (2026-09-17 사용자 질문) ───────────────────────────────────
 * "현재 구조에서 pool 이 2개 이상이어도 계산 가능해?" → 조사 결과 **계산은 되지만 한계 3건**
 * 이 있었고, 그중 하나는 **지금도 오류 없이 틀린 값**을 만들고 있었다.
 *
 * 확정 결함(재현으로 확인): `buildSnapshot` 이 사용량을 못 읽은 풀을
 *   `Number.isFinite(p.usedBytes) ? p.usedBytes : 0`
 * 으로 **0 으로 세었다**. 2풀 중 하나에서 `Current allocation`·`Remaining space` 를 지우면
 * 사용률이 **25.5% → 17%** 로 떨어지는데 `poolsUnreadable` 도 뜨지 않았다(경고 0건).
 * v2.530 '틀린 값은 빈 값보다 나쁘다' · v2.525 '0 을 지어내지 않는다' 를 함께 어긴 것이다.
 *
 * ⚠ 픽스처 `uemcli-pool-detail-2pool-2546.txt` 의 **pool_1 은 실장비 원본 수치**이고
 *   **pool_2 는 합성**이다(이 현장에는 다중 풀 장비가 없어 실제 2풀 출력을 본 적이 없다).
 *   합성이지만 **항등식은 지켰다** — `Total = Current allocation + Remaining + Preallocated`
 *   (58772198260736 = 53952823013376 + 4818175094784 + 1200152576). 그 성질이 깨지면
 *   `checkSpaceIdentity` 계열 검사가 무의미해진다. 식별자는 v2.513 규약대로 합성이다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePools } from '../src/storage/collectors/uemcliParse.js';
import { buildSnapshot } from '../src/storage/collectors/unitySsh.js';
import { capacityPointEligible } from '../src/storage/db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => fs.readFileSync(path.join(HERE, 'fixtures', n), 'utf8');
const TWO = () => fx('uemcli-pool-detail-2pool-2546.txt');
const ONE = () => fx('uemcli-pool-detail-2542.txt');
const DEV = { id: 'u1', type: 'unity480', name: 'OC2-unity-02', host: '10.94.41.236' };

/** 픽스처에서 지정한 풀 레코드의 어떤 키 줄을 지운다(그 필드를 '못 읽은' 상태 재현). */
function dropKeys(text, recordNo, keys) {
  const out = [];
  let inRec = false;
  for (const line of text.split('\n')) {
    if (/^\d+:/.test(line)) inRec = line.startsWith(`${recordNo}:`);
    if (inRec && keys.some((k) => new RegExp(`^\\s*${k}\\s`).test(line))) continue;
    out.push(line);
  }
  return out.join('\n');
}

test('2풀 파싱 — 풀마다 자기 임계·용량을 갖는다', () => {
  const pools = parsePools(TWO());
  assert.equal(pools.length, 2);
  assert.equal(pools[0].totalBytes, 117544396521472);
  assert.equal(pools[0].pct, 25.5);
  assert.equal(pools[1].totalBytes, 58772198260736);
  assert.equal(pools[1].pct, 91.8);          // 전체는 여유인데 이 풀만 꽉 찼다
  assert.equal(pools[0].alertThresholdPct, 70);
  assert.equal(pools[1].alertThresholdPct, 70);
});

test('2풀 합계 — 전체·사용량을 모두 더하고 사용률이 맞다', () => {
  const snap = buildSnapshot(DEV, { poolDetail: TWO() }, {});
  assert.equal(snap.sections.pools, 'ok');
  assert.equal(snap.capacity.totalBytes, 117544396521472 + 58772198260736);
  assert.equal(snap.capacity.usedBytes, 29973250195456 + 53952823013376);
  assert.equal(snap.capacity.pct, 47.6);
  // 두 풀 모두 집계 대상이므로 제외 표시가 없어야 한다.
  assert.equal(snap.extra.poolsUnreadable, undefined);
  assert.equal(snap.extra.poolsUsedUnreadable, undefined);
  assert.ok(snap.pools.every((p) => p.capacityCounted === true));
});

test('★ 사용량을 못 읽은 풀은 0 으로 세지 않고 합계에서 뺀다 (v2.545 결함)', () => {
  const broken = dropKeys(TWO(), 2, ['Current allocation', 'Remaining space']);
  const pools = parsePools(broken);
  assert.equal(pools.length, 2);
  assert.equal(pools[1].usedBytes, null, 'used 를 못 읽으면 null 이어야 한다(0 이 아니다)');

  const snap = buildSnapshot(DEV, { poolDetail: broken }, {});
  // v2.545 는 total 176.3TB / used 27.3TB → 17.0% 였다. 이제 pool_1 만 남는다.
  assert.equal(snap.capacity.totalBytes, 117544396521472);
  assert.equal(snap.capacity.usedBytes, 29973250195456);
  assert.equal(snap.capacity.pct, 25.5, '남은 풀만의 정직한 사용률');
  assert.equal(snap.extra.poolsUsedUnreadable, 1);
  assert.equal(snap.extra.poolsUnreadable, undefined, '전체 용량은 읽었으므로 이쪽이 아니다');
  assert.equal(snap.pools[0].capacityCounted, true);
  assert.equal(snap.pools[1].capacityCounted, false);
  // 조용히 빼지 않는다.
  assert.match(snap.extra.capacityBasisNote, /사용량을 읽지 못한 풀 1개는 합계에서 제외/);
});

test('전체 용량을 못 읽은 풀은 기존대로 poolsUnreadable 로 센다(사유를 섞지 않는다)', () => {
  const broken = dropKeys(TWO(), 2, ['Total space']);
  const snap = buildSnapshot(DEV, { poolDetail: broken }, {});
  assert.equal(snap.extra.poolsUnreadable, 1);
  assert.equal(snap.extra.poolsUsedUnreadable, undefined);
});

test('★ 일부 풀이 빠진 주기는 증가량 시계열에 적재하지 않는다(사용자 선택)', () => {
  const ok = buildSnapshot(DEV, { poolDetail: TWO() }, {});
  assert.deepEqual(capacityPointEligible(ok), { ok: true });

  const partial = buildSnapshot(DEV, { poolDetail: dropKeys(TWO(), 2, ['Current allocation', 'Remaining space']) }, {});
  const gate = capacityPointEligible(partial);
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, 'partial-pools');

  // ⚠ 화면 표시는 막지 않는다 — 막는 것은 시계열 적재뿐이다.
  assert.equal(partial.sections.capacity, 'ok');
  assert.equal(partial.capacity.pct, 25.5);
});

test('구버전 엣지(플래그 없음)는 예전처럼 적재된다 — 조용히 죽지 않는다', () => {
  const legacy = { ok: true, capacity: { totalBytes: 1000, usedBytes: 100 }, extra: {} };
  assert.deepEqual(capacityPointEligible(legacy), { ok: true });
});

test('풀 1개일 때 수치가 v2.545 와 같다(회귀 없음)', () => {
  const snap = buildSnapshot(DEV, { poolDetail: ONE() }, {});
  assert.equal(snap.capacity.totalBytes, 117544396521472);
  assert.equal(snap.capacity.usedBytes, 29973250195456);
  assert.equal(snap.capacity.pct, 25.5);
  assert.equal(snap.extra.poolsUsedUnreadable, undefined);
  assert.deepEqual(capacityPointEligible(snap), { ok: true });
});

test('사용자에게 보이는 문구에 백틱을 쓰지 않는다(BoldText 는 ** 만 처리한다)', () => {
  const snap = buildSnapshot(DEV, { poolDetail: TWO() }, {});
  assert.ok(!String(snap.extra.capacityBasisNote).includes('`'));
  const src = fs.readFileSync(path.join(HERE, '../src/storage/collectors/unitySsh.js'), 'utf8');
  // 문자열 리터럴 안의 백틱(주석 제외)을 막기 위해 capacityBasisNote 대입부만 검사한다.
  for (const m of src.matchAll(/capacityBasisNote\s*\+?=\s*([^;]+);/g)) {
    assert.ok(!/`[^`\n$]*`/.test(m[1].replace(/`[^`]*\$\{[^}]*\}[^`]*`/g, '')),
      `capacityBasisNote 문구에 백틱이 있다: ${m[1].slice(0, 80)}`);
  }
});
