/**
 * v2.583 — Overview '물리 전용' 이 법인별 표에서 전부 0 이던 결함(사용자 신고 "서버 합계에 물리서버
 * 수량 안나오는거 수정해줘"). 물리 전용 서버는 정의상 ESXi 호스트가 아니라 이름·서비스태그 귀속이
 * 절대 맞지 않는다 — 등록부 vcenterId 가 비면 전부 미귀속이었다. 보조 귀속 ④ 관리자 지정(fleet-assign)
 * ⑤ 법인(DataCenter)의 vCenter 가 하나뿐일 때 그 vCenter 를 고정한다. 식별자는 전부 합성값이다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { serversByCorp } from '../src/idrac/serverByCorp.js';

const hosts = [
  { name: 'esx-a1.corp.local', vcenterId: 'vc-a', serviceTag: 'HTAG1' },
  { name: 'esx-b1', vcenterId: 'vc-b1', serviceTag: 'HTAG2' },
];
const opts = {
  fleetAssign: { ftag9: 'vc-b2', 'srv-assign-id': 'vc-a', ghosttag: 'vc-deleted' },
  dcVcenters: new Map([['dc-a', ['vc-a']], ['dc-b', ['vc-b1', 'vc-b2']], ['dc-empty', []]]),
  knownVcenters: new Set(['vc-a', 'vc-b1', 'vc-b2']),
};

test('④⑤ 는 기존 귀속(명시·호스트명·태그)을 바꾸지 않는다', () => {
  const servers = [
    { id: 's1', name: 'esx-a1', serviceTag: 'HTAG1', datacenterId: 'dc-b' },   // 호스트 일치 → vc-a (dc-b 가 아니다)
    { id: 's2', vcenterId: 'vc-b1', serviceTag: 'X2', datacenterId: 'dc-a' },  // 명시 → vc-b1
  ];
  const r = serversByCorp(servers, hosts, opts);
  assert.equal(r.byVcenter['vc-a'], 1);
  assert.equal(r.byVcenter['vc-b1'], 1);
  assert.equal(r.matchedBy.datacenter, 0);
  assert.equal(r.matchedBy.assigned, 0);
});

test('물리 전용 서버: 관리자 지정 → 법인의 유일 vCenter 순으로 귀속된다', () => {
  const servers = [
    { id: 'p1', serviceTag: 'FTAG9' },                           // fleet-assign(태그, 대소문자 무시) → vc-b2
    { id: 'srv-assign-id', serviceTag: '' },                     // fleet-assign(서버 id) → vc-a
    { id: 'p3', serviceTag: 'BM3', datacenterId: 'DC-A' },       // 법인 dc-a 의 vCenter 가 하나 → vc-a
  ];
  const r = serversByCorp(servers, hosts, opts);
  assert.equal(r.physicalOnly, 3);
  assert.equal(r.byVcenterPhysicalOnly['vc-b2'], 1);
  assert.equal(r.byVcenterPhysicalOnly['vc-a'], 2);
  assert.equal(r.matchedBy.assigned, 2);
  assert.equal(r.matchedBy.datacenter, 1);
  assert.equal(r.physicalOnlyUnassigned, 0);
  assert.equal(r.unassigned, 0);
});

test('법인의 vCenter 가 둘 이상이거나 없으면 추측하지 않고 법인별 미배치로 밝힌다', () => {
  const servers = [
    { id: 'q1', serviceTag: 'Q1', datacenterId: 'dc-b' },       // vCenter 2개 → 미배치(dc-b)
    { id: 'q2', serviceTag: 'Q2', datacenterId: 'dc-b' },
    { id: 'q3', serviceTag: 'Q3', datacenterId: 'dc-empty' },   // vCenter 0개 → 미배치(dc-empty)
    { id: 'q4', serviceTag: 'Q4' },                              // 법인도 모름
    { id: 'q5', serviceTag: 'GHOSTTAG' },                        // 지정 대상이 삭제된 vCenter → 쓰지 않는다
  ];
  const r = serversByCorp(servers, hosts, opts);
  assert.deepEqual(r.unplacedByDatacenter, { 'dc-b': 2, 'dc-empty': 1 });
  assert.equal(r.physicalOnlyNoDatacenter, 2);
  assert.equal(r.physicalOnlyUnassigned, 5);
  assert.equal(r.unassigned, 5);
  assert.deepEqual(r.byVcenterPhysicalOnly, {});
});

test('합계 항등식: 서버 합계 = 물리 전용 + 가상화 호스트, 법인 합 + 미배치 + 법인 모름 = 물리 전용', () => {
  const servers = [
    { id: 'a', name: 'esx-a1' }, { id: 'b', serviceTag: 'FTAG9' }, { id: 'c', datacenterId: 'dc-a' },
    { id: 'd', datacenterId: 'dc-b' }, { id: 'e' }, { id: 'f', type: 'ome', datacenterId: 'dc-a' },
  ];
  const r = serversByCorp(servers, hosts, opts);
  assert.equal(r.union, r.physicalOnly + r.hostsTotal);
  const placed = Object.values(r.byVcenterPhysicalOnly).reduce((x, y) => x + y, 0);
  const unplaced = Object.values(r.unplacedByDatacenter).reduce((x, y) => x + y, 0);
  assert.equal(placed + unplaced + r.physicalOnlyNoDatacenter, r.physicalOnly);
  assert.equal(r.total, 5, 'OME 는 세지 않는다');
});

test('보조 재료가 없으면 예전 동작과 같다(호출부 호환)', () => {
  const r = serversByCorp([{ id: 'z', datacenterId: 'dc-a', serviceTag: 'FTAG9' }], hosts);
  assert.equal(r.unassigned, 1);
  assert.equal(r.physicalOnlyNoDatacenter, 0);
  assert.deepEqual(r.unplacedByDatacenter, { 'dc-a': 1 });
});
