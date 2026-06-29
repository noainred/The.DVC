import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setFleetAssign, setFleetAssignMany, loadFleetAssign, applyFleetAssign, pruneFleetAssign, resetFleetAssign } from '../src/insights/fleetAssign.js';
import { setFleetTag, loadFleetTags, pruneFleetTags, resetFleetTags } from '../src/insights/fleetTags.js';

beforeEach(() => { resetFleetAssign(); resetFleetTags(); });

test('setFleetAssign: validIds로 유령 vCenter 거부', () => {
  const valid = new Set(['vc-kr', 'vc-eu']);
  assert.equal(setFleetAssign('z1', 'ghost', valid).ok, false); // 없는 vCenter
  assert.equal(setFleetAssign('z1', 'vc-kr', valid).ok, true);
  assert.equal(loadFleetAssign().z1, 'vc-kr');
});

test('setFleetAssign: 키는 소문자로 정규화 저장, 빈값이면 해제', () => {
  setFleetAssign('ABC123', 'vc-kr');
  assert.equal(loadFleetAssign().abc123, 'vc-kr'); // 소문자
  setFleetAssign('abc123', '');
  assert.equal(loadFleetAssign().abc123, undefined); // 해제
});

test('applyFleetAssign: 수동 등록이 비-iDRAC를 덮고, iDRAC(레지스트리)는 권위로 보존', () => {
  setFleetAssign('z1', 'vc-kr');     // 서비스태그 기준
  setFleetAssign('srv-2', 'vc-eu');  // serverId 기준
  const measured = [
    { serverId: 'srv-1', serviceTag: 'Z1', vcenterId: '', source: 'ome' },          // assign으로 채워짐
    { serverId: 'srv-2', serviceTag: '', vcenterId: '', source: 'ome' },            // serverId 키로 채워짐
    { serverId: 'srv-3', serviceTag: 'Z1', vcenterId: 'vc-existing', source: 'idrac' }, // iDRAC 권위 → 보존
    { serverId: 'srv-4', serviceTag: 'Z1', vcenterId: 'vc-inferred', source: 'ome' },   // OME 추론값을 수동이 덮음
  ];
  applyFleetAssign(measured);
  assert.equal(measured[0].vcenterId, 'vc-kr');
  assert.equal(measured[1].vcenterId, 'vc-eu');
  assert.equal(measured[2].vcenterId, 'vc-existing'); // idrac 보존
  assert.equal(measured[3].vcenterId, 'vc-kr');       // ome는 수동 우선
});

test('setFleetTag: 잘못된 tag 거부, 유효 태그 저장/해제', () => {
  assert.equal(setFleetTag('z1', 'nonsense').ok, false);
  assert.equal(setFleetTag('z1', 'baremetal').ok, true);
  assert.equal(loadFleetTags().z1, 'baremetal');
  assert.equal(setFleetTag('z1', 'auto').ok, true); // auto = 해제
  assert.equal(loadFleetTags().z1, undefined);
});

test('setFleetAssignMany: 일괄 설정/해제 + validIds 거부 + 정규화', () => {
  const valid = new Set(['vc-kr', 'vc-eu']);
  const r = setFleetAssignMany([['K1', 'vc-kr'], ['k2', 'vc-eu'], ['k3', 'ghost'], ['k1', '']], valid);
  assert.equal(r.ok, true);
  const a = loadFleetAssign();
  assert.equal(a.k1, undefined);   // 마지막 해제 반영
  assert.equal(a.k2, 'vc-eu');     // 소문자 정규화
  assert.equal(a.k3, undefined);   // 유령 vCenter 거부
});

test('setFleetAssign: 해제인데 이미 없으면 no-op(ok)', () => {
  assert.equal(setFleetAssign('nope', '').ok, true);
  assert.equal(loadFleetAssign().nope, undefined);
});

test('pruneFleetTags/Assign: live 키만 남기고 유령 키 제거', () => {
  setFleetTag('z1', 'exclude');
  setFleetTag('dead', 'baremetal');
  setFleetAssign('z1', 'vc-kr');
  setFleetAssign('deadkey', 'vc-eu');
  const live = new Set(['z1']);
  assert.equal(pruneFleetTags(live), 1);   // 'dead' 제거
  assert.equal(pruneFleetAssign(live), 1); // 'deadkey' 제거
  assert.equal(loadFleetTags().z1, 'exclude');
  assert.equal(loadFleetTags().dead, undefined);
  assert.equal(loadFleetAssign().z1, 'vc-kr');
  assert.equal(loadFleetAssign().deadkey, undefined);
  assert.equal(pruneFleetTags(live), 0);   // 더 이상 제거할 것 없음
});
