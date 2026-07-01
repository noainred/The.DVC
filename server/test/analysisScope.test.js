import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serverInScope } from '../src/insights/analysisScope.js';

// assign: vc1 → 법인 corpA. 서버들:
const assign = { vc1: 'corpA', vc2: 'corpB' };
const virtA = { id: 'a', vcenterId: 'vc1' };                 // vc1(→corpA) 가상화
const virtB = { id: 'b', vcenterId: 'vc2' };                 // vc2(→corpB) 가상화
const bmA = { id: 'c', datacenterId: 'corpA' };             // corpA baremetal(vCenter 없음)
const bmNone = { id: 'd' };                                  // 법인/ vCenter 둘 다 없음

test('전체(빈 스코프)는 모두 통과', () => {
  for (const s of [virtA, virtB, bmA, bmNone]) assert.equal(serverInScope(s, {}, assign), true);
});

test('법인(dc) 선택 → 그 법인의 모든 장비(가상화+baremetal)', () => {
  assert.equal(serverInScope(virtA, { datacenterId: 'corpA' }, assign), true);  // vc1→corpA
  assert.equal(serverInScope(bmA, { datacenterId: 'corpA' }, assign), true);    // corpA baremetal
  assert.equal(serverInScope(virtB, { datacenterId: 'corpA' }, assign), false); // corpB
  assert.equal(serverInScope(bmNone, { datacenterId: 'corpA' }, assign), false);
});

test('vCenter 선택 → 그 vCenter의 가상화 장비만', () => {
  assert.equal(serverInScope(virtA, { vcenterId: 'vc1' }, assign), true);
  assert.equal(serverInScope(bmA, { vcenterId: 'vc1' }, assign), false);   // baremetal 제외
  assert.equal(serverInScope(virtB, { vcenterId: 'vc1' }, assign), false);
});

test('Baremetal 선택 → vCenter 미소속 물리서버만', () => {
  assert.equal(serverInScope(bmA, { baremetal: true }, assign), true);
  assert.equal(serverInScope(bmNone, { baremetal: true }, assign), true);
  assert.equal(serverInScope(virtA, { baremetal: true }, assign), false);  // 가상화 제외
  assert.equal(serverInScope(virtB, { baremetal: '1' }, assign), false);
});

test('법인 미지정(datacenterId=__unmapped__) → 소속 법인 없는 서버만', () => {
  assert.equal(serverInScope(bmNone, { datacenterId: '__unmapped__' }, assign), true);
  assert.equal(serverInScope(bmA, { datacenterId: '__unmapped__' }, assign), false);  // corpA 있음
  assert.equal(serverInScope(virtA, { datacenterId: '__unmapped__' }, assign), false);
});

test('법인 dc + baremetal 조합 → 그 법인의 baremetal만', () => {
  assert.equal(serverInScope(bmA, { datacenterId: 'corpA', baremetal: true }, assign), true);
  assert.equal(serverInScope(virtA, { datacenterId: 'corpA', baremetal: true }, assign), false); // 가상화 제외
});

test('mappedVcenterId: vcenterId가 비어도 서비스태그 매핑 vCenter로 가상화 분류', () => {
  // 스캔 등록된 iDRAC 서버(vcenterId 없음)지만 서비스태그가 vc1의 ESXi 호스트와 일치 → mappedVcenterId=vc1.
  const mapped = { id: 'm', vcenterId: '', mappedVcenterId: 'vc1' };
  const assign2 = { vc1: 'corpA' };
  // vCenter(vc1) 선택 시 이 서버가 가상화 장비로 잡힘.
  assert.equal(serverInScope(mapped, { vcenterId: 'vc1' }, assign2), true);
  // Baremetal 선택 시 제외(가상화이므로).
  assert.equal(serverInScope(mapped, { baremetal: true }, assign2), false);
  // 법인(dc)은 매핑 vCenter의 소속 법인으로 해석.
  assert.equal(serverInScope(mapped, { datacenterId: 'corpA' }, assign2), true);
  // 명시 datacenterId가 있으면 그게 우선(매핑보다).
  const mappedWithDc = { id: 'm2', vcenterId: '', mappedVcenterId: 'vc1', datacenterId: 'corpB' };
  assert.equal(serverInScope(mappedWithDc, { datacenterId: 'corpB' }, assign2), true);
});
