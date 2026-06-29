import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setFleetAssign, loadFleetAssign, applyFleetAssign, resetFleetAssign } from '../src/insights/fleetAssign.js';
import { setFleetTag, loadFleetTags, resetFleetTags } from '../src/insights/fleetTags.js';

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

test('applyFleetAssign: vcenterId 비어있는 항목만 채움(기존 값 보존)', () => {
  setFleetAssign('z1', 'vc-kr');     // 서비스태그 기준
  setFleetAssign('srv-2', 'vc-eu');  // serverId 기준
  const measured = [
    { serverId: 'srv-1', serviceTag: 'Z1', vcenterId: '' },        // assign으로 채워짐
    { serverId: 'srv-2', serviceTag: '', vcenterId: '' },          // serverId 키로 채워짐
    { serverId: 'srv-3', serviceTag: 'Z1', vcenterId: 'vc-existing' }, // 기존 값 보존
  ];
  applyFleetAssign(measured);
  assert.equal(measured[0].vcenterId, 'vc-kr');
  assert.equal(measured[1].vcenterId, 'vc-eu');
  assert.equal(measured[2].vcenterId, 'vc-existing');
});

test('setFleetTag: 잘못된 tag 거부, 유효 태그 저장/해제', () => {
  assert.equal(setFleetTag('z1', 'nonsense').ok, false);
  assert.equal(setFleetTag('z1', 'baremetal').ok, true);
  assert.equal(loadFleetTags().z1, 'baremetal');
  assert.equal(setFleetTag('z1', 'auto').ok, true); // auto = 해제
  assert.equal(loadFleetTags().z1, undefined);
});
