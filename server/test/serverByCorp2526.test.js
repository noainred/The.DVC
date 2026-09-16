/**
 * serverByCorp2526.test.js — 법인별 서버 수량 집계 회귀(v2.526, v2.527 에 중복 제거 추가).
 *
 * 사용자 요청(2026-09-16): "overview 화면에 전체 물리 서버 수량(idarc 에서 찾은 수량),
 * 가상화 호스트 수량, 법인별 서버 수량과 guestos 수량 표시해줘" →
 * (v2.527) "서버의 합/물리서버/가상화 호스트 이렇게 구분해서 전체 서버의 수량을 볼 수 있게".
 *
 * 여기서 고정하는 것은 **정직성 규칙**이다:
 *  · 귀속되지 않은 서버를 아무 법인에나 넣지 않는 것
 *  · OME 항목을 물리 서버로 세지 않는 것
 *  · 귀속 신호의 우선순위(명시 → 호스트 이름 → 서비스태그)가 전력 귀속과 같은 것
 *  · ★ **합계가 같은 장비를 두 번 세지 않는 것** — 이 현장은 iDRAC 등록 서버 대부분이 곧
 *    ESXi 호스트라(사용자 화면 실측 SN 27/27 · HB 32/32 …) 단순 합은 실제 대수의 두 배가 된다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { serversByCorp } from '../src/idrac/serverByCorp.js';

const HOSTS = [
  { name: 'esx01.corp.local', vcenterId: 'vc-kr', serviceTag: 'TAG001' },
  { name: 'esx02.corp.local', vcenterId: 'vc-pl', serviceTag: 'TAG002' },
];

test('명시 지정 > 호스트명 > 서비스태그 순서로 귀속한다', () => {
  const r = serversByCorp([
    { id: 'a', vcenterId: 'vc-us', name: 'esx01.corp.local', serviceTag: 'TAG002' }, // 명시가 이긴다
    { id: 'b', name: 'esx02' },                                                      // 짧은 이름 매칭
    { id: 'c', serviceTag: 'tag001' },                                               // 태그(대소문자 무시)
  ], HOSTS);
  assert.equal(r.byVcenter['vc-us'], 1);
  assert.equal(r.byVcenter['vc-pl'], 1);
  assert.equal(r.byVcenter['vc-kr'], 1);
  assert.deepEqual(r.matchedBy, { explicit: 1, hostName: 1, serviceTag: 1, none: 0 });
});

test('귀속되지 않은 서버는 어느 법인에도 넣지 않고 따로 센다', () => {
  const r = serversByCorp([{ id: 'x', name: 'unknown-box' }], HOSTS);
  assert.equal(r.total, 1);
  assert.equal(r.unassigned, 1);
  assert.deepEqual(r.byVcenter, {});
  // 합계 > 법인별 합 인 이유를 화면이 말할 수 있어야 한다.
  const summed = Object.values(r.byVcenter).reduce((a, b) => a + b, 0);
  assert.ok(r.total > summed);
});

test('OME 등록은 물리 서버가 아니다 — 세지 않는다', () => {
  const r = serversByCorp([
    { id: 'o', type: 'ome', name: 'esx01.corp.local' },
    { id: 's', name: 'esx01.corp.local' },
  ], HOSTS);
  assert.equal(r.total, 1);
  assert.equal(r.byVcenter['vc-kr'], 1);
});

test('비활성 서버도 세되 개수를 따로 밝힌다', () => {
  const r = serversByCorp([{ id: 'd', enabled: false, name: 'esx01' }], HOSTS);
  assert.equal(r.total, 1);
  assert.equal(r.disabled, 1);
  assert.equal(r.byVcenter['vc-kr'], 1);
});

test('법인(DataCenter) 축은 vCenter 귀속과 독립이다', () => {
  const r = serversByCorp([
    { id: 'a', name: 'esx01', datacenterId: 'dc-seoul' },
    { id: 'b', name: 'nowhere', datacenterId: 'dc-seoul' },   // vCenter 미귀속인데 법인은 있다
  ], HOSTS);
  assert.equal(r.byDatacenter['dc-seoul'], 2);
  assert.equal(r.unassigned, 1);
});

test('입력이 비어도 던지지 않는다', () => {
  const r = serversByCorp();
  assert.equal(r.total, 0);
  assert.deepEqual(r.byVcenter, {});
  assert.equal(r.union, 0);
  assert.equal(r.hostsTotal, 0);
});

/* ────────────────── v2.527 — 중복 제거 합계 ────────────────── */

test('★ 같은 장비를 두 번 세지 않는다 — 합계 = 물리 전용 + 가상화 호스트', () => {
  // 현장 형태: iDRAC 서버 2대가 곧 ESXi 호스트 2대이고, 그 밖에 비가상화 서버 1대가 있다.
  const r = serversByCorp([
    { id: 'a', name: 'esx01.corp.local' },
    { id: 'b', name: 'esx02' },
    { id: 'c', name: 'db-baremetal', vcenterId: 'vc-kr' },
  ], HOSTS);
  assert.equal(r.total, 3);              // iDRAC 등록은 3대
  assert.equal(r.hostsTotal, 2);
  assert.equal(r.matchedCount, 2);       // 그중 2대가 ESXi 호스트와 같은 장비
  assert.equal(r.physicalOnly, 1);       // 남은 1대만 '물리 전용'
  assert.equal(r.union, 3);              // ★ 단순 합(3+2=5)이 아니라 실제 대수 3
  // 항등식: 합계 = 물리 전용 + 가상화 호스트
  assert.equal(r.union, r.physicalOnly + r.hostsTotal);
});

test('★ 명시 지정된 서버도 중복 판정 대상이다(v2.526 은 여기서 중복을 못 찾았다)', () => {
  // v2.526 은 `vcenterId` 가 있으면 이름·태그 조회를 **건너뛰었다**. 이 현장은 명시 지정이
  // 흔하므로 그대로 두면 중복이 0 으로 나오고 합계가 두 배가 된다.
  const r = serversByCorp([{ id: 'a', vcenterId: 'vc-kr', name: 'esx01.corp.local' }], HOSTS);
  assert.equal(r.matchedBy.explicit, 1);
  assert.equal(r.matchedCount, 1, '명시 지정이어도 ESXi 호스트와 같은 장비임을 찾아야 한다');
  assert.equal(r.physicalOnly, 0);
  assert.equal(r.union, 2, '호스트 2대뿐 — 등록 서버가 그중 하나이므로 합계는 2');
});

test('★ 법인별 합계도 같은 항등식을 지킨다', () => {
  const hosts = [
    { name: 'kr-esx01', vcenterId: 'vc-kr', serviceTag: 'K1' },
    { name: 'kr-esx02', vcenterId: 'vc-kr', serviceTag: 'K2' },
    { name: 'pl-esx01', vcenterId: 'vc-pl', serviceTag: 'P1' },
  ];
  const r = serversByCorp([
    { id: '1', name: 'kr-esx01' },                        // vc-kr 호스트와 동일
    { id: '2', serviceTag: 'K2' },                        // vc-kr 호스트와 동일(태그)
    { id: '3', name: 'kr-db01', vcenterId: 'vc-kr' },     // vc-kr 물리 전용
    { id: '4', name: 'pl-esx01' },                        // vc-pl 호스트와 동일
  ], hosts);
  assert.equal(r.byVcenterHosts['vc-kr'], 2);
  assert.equal(r.byVcenterMatched['vc-kr'], 2);
  assert.equal(r.byVcenterPhysicalOnly['vc-kr'], 1);
  assert.equal(r.byVcenterUnion['vc-kr'], 3);             // 2 호스트 + 1 물리 전용
  assert.equal(r.byVcenterUnion['vc-pl'], 1);             // 호스트 1대(등록 서버가 그것)
  for (const vc of ['vc-kr', 'vc-pl']) {
    assert.equal(
      r.byVcenterUnion[vc],
      (r.byVcenterHosts[vc] || 0) + (r.byVcenterPhysicalOnly[vc] || 0),
      `${vc}: 합계 = 물리 전용 + 가상화 호스트`,
    );
  }
});

test('귀속되지 않은 물리 전용 서버도 전체 합계에는 들어간다', () => {
  const r = serversByCorp([
    { id: 'a', name: 'esx01.corp.local' },   // vc-kr 호스트
    { id: 'z', name: 'orphan-box' },         // 어느 법인인지 모름 + 호스트도 아님
  ], HOSTS);
  assert.equal(r.unassigned, 1);
  assert.equal(r.physicalOnlyUnassigned, 1);
  // 법인별 합(2 호스트 + 0) 보다 전체 합(3)이 큰 것이 정상이다 — 화면이 그 이유를 밝힌다.
  assert.equal(r.union, 3);
  const perCorp = Object.values(r.byVcenterUnion).reduce((a, b) => a + b, 0);
  assert.equal(perCorp, 2);
  assert.ok(r.union > perCorp);
});

test("중복 0건은 '중복이 없다' 가 아니라 '못 찾았다' 일 수 있다 — 수치로 구분 가능해야 한다", () => {
  // iDRAC 이름이 ESXi 호스트명과 전혀 다르고 서비스태그도 비어 있는 경우(현실적으로 흔하다).
  const r = serversByCorp([
    { id: 'a', vcenterId: 'vc-kr', name: 'idrac-mgmt-01' },
    { id: 'b', vcenterId: 'vc-kr', name: 'idrac-mgmt-02' },
  ], HOSTS);
  assert.equal(r.matchedCount, 0);
  assert.equal(r.physicalOnly, 2);
  assert.equal(r.union, 4, '중복을 못 찾으면 합계가 실제보다 커진다 — 화면이 이 한계를 밝힌다');
  // 화면이 "중복으로 확인된 장비 없음" 을 말할 수 있도록 matchedCount 가 노출돼야 한다.
  assert.equal(typeof r.matchedCount, 'number');
});
