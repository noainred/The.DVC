/**
 * powermaxWritten2534.test.js — VMAX/PowerMax '할당' 이 아니라 **실제로 기록한 양** 을 쓴다.
 *
 * 사용자 신고(2026-09-16): "vmax, powermax 스토리지의 할당량 말고 실제로 디스크에 기록한 사용량
 * 보여줘". 화면에서 VMAX 11대가 전부 **정확히 100%**(전체 == 사용)였고, 12대 중 PowerMax 10.2
 * 한 대만 31.1% 로 정상이었다.
 *
 * ── 원인(재현으로 확정) ────────────────────────────────────────────────────────
 * v2.533 의 `powermaxCapacity` 는 `physicalCapacity` 를 ①순위로 봤다. V3 플랫폼(VMAX)
 * 응답에는 그 필드가 **있고 `used_capacity_gb == total_capacity_gb`** 다. 같은 응답의
 * `system_capacity` 로 계산하면 41.2% 다.
 *
 * ── 근거(정직 기록) ────────────────────────────────────────────────────────────
 * ★ Dell 공식 OpenAPI 스펙 원문(Dell 이 PyU4V 저장소 `tools/openapi.json` 에 커밋. PowerMax 10.3.
 *   developer.dell.com 은 이 환경에서 차단이라 이 경로로 확보했다):
 *     usable_used_tb  "Total Capacity in TBs used by Host, eNas and System
 *                      after Data reduction is applied"      ← 실제로 기록된 양
 *     subscribed_total_tb     "Host subscribed capacity plus eNas subscribed capacity in TBs"
 *     subscribed_allocated_tb "Host allocated plus eNas allocated capacity in TBs"
 *     disk_group_total_capacity_gb "The total disk group (raw) capacity including RAID overhead"
 * ★ 독립 구현 3종이 같은 선택을 한다 — OpenStack Cinder 의 Dell PowerMax 드라이버, Checkmk
 *   `unisphere_powermax_srp` 플러그인('Physical SRP Capacity'), Dell ansible-powermax.
 *
 * ⚠ **`physicalCapacity` 를 '원시 용량' 이라고 단정하지 말 것** — Dell 자신의 스펙에도 이
 *   스키마에는 설명이 없다(Java DTO 클래스명 반복). raw 를 뜻하는 필드는
 *   `disk_group_total_capacity_gb` 로 **따로 있다**. 확정된 것은 "확인한 V3 표본 2건에서
 *   used == total 이었다" 까지이며, 그래서 코드는 이 필드를 **마지막 수단**으로 쓰고
 *   `used === total` 이면 `suspect` 로 화면에 경고한다.
 *
 * ⚠ **이 현장 VMAX 11대의 실제 응답 본문은 확인하지 못했다.** 아래 수치는 공개 오픈소스
 *   테스트 데이터(Comcast/libstorage 의 VMAX200K 캡처, Checkmk 플러그인 헤더의 SRP 캡처)의
 *   **수치 관계만** 옮긴 것이고 식별자는 합성이다(CLAUDE.md v2.513 — 이 저장소는 공개다).
 *   보존한 관계: ① physicalCapacity used == total ② usable 440.74/1070.61 = 41.2%
 *   ③ V4 effective 1.47 − savings 0.98 = physical 0.49.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { powermaxCapacity, powermaxSrp, normalizePowermax } from '../src/storage/collectors/powermax.js';

/** V3(VMAX) 어레이 — physicalCapacity 가 used==total 이고 system_capacity 는 정상값을 준다. */
const V3_ARRAY = Object.freeze({
  symmetrixId: '000000000001', model: 'VMAX200K', ucode: '5977.1125.1125', local: true,
  physicalCapacity: { used_capacity_gb: 1325680.37, total_capacity_gb: 1325680.37 },
  disk_group_total_capacity_gb: 1325680.37,
  system_capacity: {
    usable_total_tb: 1070.61, usable_used_tb: 440.74,
    subscribed_total_tb: 693.84, subscribed_allocated_tb: 439.53,
    snapshot_total_tb: 12.5, snapshot_modified_tb: 1.2,
    subscribed_usable_capacity_percent: 65,
  },
});

test('★★ 회귀 — physicalCapacity(used==total)가 system_capacity 를 이기면 안 된다', () => {
  const c = powermaxCapacity(V3_ARRAY);
  assert.equal(c.basis, 'system_capacity.usable', 'Dell 이 뜻을 명시한 필드가 우선이다');
  assert.equal(c.documented, true);
  assert.equal(c.suspect, false);
  // v2.533 은 여기서 100.0 이 나왔다 — 그것이 사용자가 본 화면이다.
  assert.equal(Math.round((c.usedBytes / c.totalBytes) * 1000) / 10, 41.2);
  assert.equal(Math.round(c.totalBytes / 1e12 * 100) / 100, 1070.61);
  assert.equal(Math.round(c.usedBytes / 1e12 * 100) / 100, 440.74);
});

test('구독·할당·실제기록을 **각각** 싣는다 — 셋은 뜻이 다르므로 합치지 않는다', () => {
  const d = powermaxCapacity(V3_ARRAY).detail;
  assert.equal(d.subscribedTb, 693.84, '호스트에 약속한 씬 크기(구독)');
  assert.equal(d.allocatedTb, 439.53, '씬 풀에서 할당된 양');
  assert.equal(d.usableUsedTb, 440.74, '데이터 감축 후 실제로 기록된 양');
  assert.equal(d.usableTotalTb, 1070.61);
  assert.equal(d.subscribedPct, 65, 'Dell 이 100% 초과가 정상이라고 명시한 값');
  // raw 는 Dell 이 뜻을 명시한 유일한 필드에서만 온다(physicalCapacity 를 raw 라 부르지 않는다).
  assert.equal(d.rawTb, 1325.68);
});

test('★ physicalCapacity 밖에 없고 used==total 이면 **의심 표시**를 단다', () => {
  const c = powermaxCapacity({
    symmetrixId: 'x', physicalCapacity: { used_capacity_gb: 76290.38, total_capacity_gb: 76290.38 },
  });
  assert.equal(c.basis, 'physicalCapacity');
  assert.equal(c.documented, false, 'Dell 스펙에 설명이 없는 필드다');
  assert.equal(c.suspect, true, '사용 == 전체는 사용량이 아닐 가능성이 크다');
});

test('physicalCapacity 라도 used != total 이면 의심하지 않는다(10.2 실측 31.1%)', () => {
  const c = powermaxCapacity({ physicalCapacity: { used_capacity_gb: 65134.0, total_capacity_gb: 209160.8 } });
  assert.equal(c.suspect, false);
  assert.equal(c.documented, false, '그래도 문서화되지 않은 필드라는 사실은 남는다');
});

test('usable_used_tb 가 0 이어도 정상 판정 — null 과 0 을 구분한다', () => {
  const c = powermaxCapacity({ system_capacity: { usable_total_tb: 100, usable_used_tb: 0 } });
  assert.equal(c.basis, 'system_capacity.usable');
  assert.equal(c.usedBytes, 0, '빈 어레이는 0% 가 맞다');
  // used 가 아예 없으면(null) system_capacity 를 쓸 수 없다 — 0 으로 지어내지 않는다.
  const n = powermaxCapacity({ system_capacity: { usable_total_tb: 100 } });
  assert.equal(n, null, 'usable_used_tb 가 없으면 사용량을 만들어내지 않는다');
});

/* ── SRP(풀) ─────────────────────────────────────────────────────────────────── */

/** V3 SRP — Checkmk 플러그인 헤더의 실캡처 수치 관계(식별자만 합성). */
const V3_SRP = Object.freeze({
  srpId: 'SRP_1', num_of_disk_groups: 2, reserved_cap_percent: 10,
  srp_capacity: {
    usable_used_tb: 34.32, usable_total_tb: 171.15,
    subscribed_total_tb: 120.5, subscribed_allocated_tb: 34.1,
    effective_used_capacity_percent: 23,
  },
  srp_efficiency: { data_reduction_ratio_to_one: 1.6, compression_state: 'Enabled' },
});

/** V4 SRP — effective(감축 후 논리) 와 physical(실제 기록) 이 분리돼 있다. */
const V4_SRP = Object.freeze({
  srpId: 'SRP_1',
  fba_srp_capacity: {
    provisioned: { provisioned_tb: 41.22, effective_capacity_tb: 294.49, provisioned_percent: 14.0 },
    effective: {
      used_tb: 1.47, total_tb: 294.49, free_tb: 293.02, effective_used_percent: 1.0,
      physical_capacity: { used_tb: 0.49, total_tb: 108.95, free_tb: 108.46 },
    },
    data_reduction: { savings_tb: 0.98, data_reduction_ratio_to_one: 6.0 },
  },
});

test('SRP V3 — usable_used_tb 를 실제 기록으로 읽는다', () => {
  const s = powermaxSrp(V3_SRP);
  assert.equal(s.id, 'SRP_1');
  assert.equal(s.basis, 'srp_capacity.usable');
  assert.equal(Math.round(s.usedBytes / 1e12 * 100) / 100, 34.32);
  assert.equal(Math.round(s.totalBytes / 1e12 * 100) / 100, 171.15);
  assert.equal(s.subscribedTb, 120.5);
  assert.equal(s.drr, 1.6);
  assert.equal(s.compression, 'Enabled');
});

test('★ SRP V4 — effective(감축 후 논리) 가 아니라 **physical(실제 기록)** 을 쓴다', () => {
  const s = powermaxSrp(V4_SRP);
  assert.equal(s.basis, 'fba_srp_capacity.effective.physical_capacity');
  assert.equal(Math.round(s.usedBytes / 1e12 * 100) / 100, 0.49, '실제로 디스크에 기록된 양');
  assert.equal(Math.round(s.totalBytes / 1e12 * 100) / 100, 108.95);
  // effective 는 참고로만 싣는다 — 이것을 사용량으로 쓰면 3배 부풀려진다(감축 6:1).
  assert.equal(s.effectiveUsedTb, 1.47);
  assert.equal(s.savingsTb, 0.98);
  // 실캡처의 교차검증 관계: effective − savings = physical.
  assert.equal(Math.round((s.effectiveUsedTb - s.savingsTb) * 100) / 100, 0.49);
  assert.equal(s.subscribedTb, 41.22, 'V4 의 구독은 provisioned.provisioned_tb 다');
});

test('SRP 형식을 못 읽으면 null — 지어내지 않는다', () => {
  assert.equal(powermaxSrp(null), null);
  assert.equal(powermaxSrp({ srpId: 'x' }), null);
  assert.equal(powermaxSrp({ srpId: 'x', srp_capacity: { usable_total_tb: 0 } }), null);
});

/* ── 정규화 ──────────────────────────────────────────────────────────────────── */

const dev = { id: 'pm-1', type: 'vmax', name: 'TEST-VMAX', host: '10.0.0.1' };

test('정규화 — V3 어레이는 system_capacity 로 41.2%, 합계 상세가 붙는다', () => {
  const snap = normalizePowermax(dev, {
    version: { version: 'V9.2.4.9' },
    arrays: [{ symmetrixId: V3_ARRAY.symmetrixId, model: V3_ARRAY.model, ucode: V3_ARRAY.ucode }],
    caps: { [V3_ARRAY.symmetrixId]: powermaxCapacity(V3_ARRAY) },
    srps: { [V3_ARRAY.symmetrixId]: [powermaxSrp(V3_SRP)] },
  });
  assert.equal(snap.capacity.pct, 41.2);
  assert.equal(snap.extra.capacityBasis, 'system_capacity.usable');
  assert.ok(!snap.extra.capacitySuspect);
  assert.equal(snap.extra.capacityDetail.subscribedTb, 693.84);
  assert.equal(snap.extra.capacityDetail.allocatedTb, 439.53);
  assert.equal(snap.extra.capacityDetail.usableUsedTb, 440.74);
  assert.equal(snap.extra.capacityDetail.srps.length, 1);
  assert.equal(snap.extra.capacityDetail.srps[0].basis, 'srp_capacity.usable');
  assert.ok(snap.extra.capacityBasisNote.includes('감축'), '무엇을 센 값인지 화면이 말한다');
});

test('★ 정규화 — 10.x 처럼 usable_* 가 없으면 **SRP 의 물리값**으로 대체한다', () => {
  const sym = { symmetrixId: 'A2', physicalCapacity: { used_capacity_gb: 65134.0, total_capacity_gb: 209160.8 } };
  const snap = normalizePowermax(dev, {
    arrays: [{ symmetrixId: 'A2' }],
    caps: { A2: powermaxCapacity(sym) },
    srps: { A2: [powermaxSrp(V4_SRP)] },
  });
  // physicalCapacity(문서 없음) 대신 SRP 의 physical_capacity(문서 있음)를 쓴다.
  assert.equal(snap.extra.capacityBasis, 'srp:fba_srp_capacity.effective.physical_capacity');
  assert.equal(Math.round(snap.capacity.totalBytes / 1e12 * 100) / 100, 108.95);
  assert.equal(Math.round(snap.capacity.usedBytes / 1e12 * 100) / 100, 0.49);
  assert.equal(snap.extra.capacityDetail.savingsTb, 0.98);
});

test('★ 정규화 — SRP 도 없고 physicalCapacity 가 used==total 이면 화면이 경고한다', () => {
  const sym = { symmetrixId: 'A3', physicalCapacity: { used_capacity_gb: 1000, total_capacity_gb: 1000 } };
  const snap = normalizePowermax(dev, { arrays: [{ symmetrixId: 'A3' }], caps: { A3: powermaxCapacity(sym) } });
  assert.equal(snap.capacity.pct, 100);
  assert.equal(snap.extra.capacitySuspect, true);
  assert.ok(snap.extra.capacityBasisNote.includes('실제 기록량이 아닐 수 있습니다'),
    '조용히 100% 를 보여주면 사용자가 용량 부족으로 오해한다');
});

test('엣지 구버전 push(옛 caps 형태 usable_*_tb)도 계속 받는다', () => {
  const snap = normalizePowermax(dev, {
    arrays: [{ symmetrixId: 'A4' }],
    caps: { A4: { usable_total_tb: 100, usable_used_tb: 60 } },
  });
  assert.equal(snap.capacity.pct, 60);
});

test('용량을 못 읽은 어레이는 0 으로 채우지 않고 합계에서 뺀다', () => {
  const snap = normalizePowermax(dev, {
    arrays: [{ symmetrixId: 'A5' }, { symmetrixId: 'A6' }],
    caps: { A5: powermaxCapacity(V3_ARRAY) },   // A6 은 없음
  });
  assert.equal(snap.pools.length, 1, '없는 어레이를 0 으로 만들지 않는다');
  assert.equal(snap.capacity.pct, 41.2);
});

test('소스 규약 — SRP 조회가 collect 에 실제로 배선돼 있다', async () => {
  const fs = await import('node:fs');
  const code = fs.readFileSync(new URL('../src/storage/collectors/powermax.js', import.meta.url), 'utf8');
  assert.ok(code.includes('/srp'), 'SRP 경로 조회가 있어야 10.x 의 실제 기록량을 읽는다');
  assert.ok(code.includes('powermaxSrp('), 'collect 가 SRP 파서를 호출해야 한다');
  // SRP 실패가 용량 섹션을 깨뜨리면 안 된다(부가 정보다).
  assert.ok(code.includes('raw.srpError'), 'SRP 실패는 사유를 남기되 수집을 실패로 만들지 않는다');
});
