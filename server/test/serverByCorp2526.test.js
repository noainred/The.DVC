/**
 * serverByCorp2526.test.js — 법인별 물리 서버 집계 회귀(v2.526).
 *
 * 사용자 요청(2026-09-16): "overview 화면에 전체 물리 서버 수량(idarc 에서 찾은 수량),
 * 가상화 호스트 수량, 법인별 서버 수량과 guestos 수량 표시해줘".
 *
 * 여기서 고정하는 것은 **정직성 규칙**이다 — 귀속되지 않은 서버를 아무 법인에나 넣지 않는 것,
 * OME 항목을 물리 서버로 세지 않는 것, 귀속 신호의 우선순위(명시 → 호스트명 → 서비스태그)가
 * 전력 귀속과 같은 것. 순서가 뒤집히면 같은 서버가 전력 화면과 다른 법인에 잡힌다.
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
});
