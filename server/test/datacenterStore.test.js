import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  listDatacenters, getDatacenterAssign, addDatacenter, updateDatacenter, removeDatacenter,
  setVcenterDatacenter, setVcenterDatacenterMany, datacenterOfVcenter, resetDatacenters, ensureDatacenter,
} from '../src/datacenter/store.js';

beforeEach(() => resetDatacenters());

test('ensureDatacenter: 없으면 생성, 있으면 no-op(수집 서버 자동 등록용)', () => {
  const r1 = ensureDatacenter({ id: 'OC1', name: 'OC1' });
  assert.equal(r1.ok, true);
  assert.equal(listDatacenters().find((d) => d.id === 'oc1').name, 'OC1'); // id 정규화(소문자)
  // 두 번째 호출은 no-op(중복 생성 없음).
  const r2 = ensureDatacenter({ id: 'oc1', name: 'OC1' });
  assert.equal(r2.ok, true);
  assert.equal(r2.existed, true);
  assert.equal(listDatacenters().filter((d) => d.id === 'oc1').length, 1);
  // name 없으면 id를 이름으로.
  ensureDatacenter({ id: 'nb' });
  assert.equal(listDatacenters().find((d) => d.id === 'nb').name, 'nb');
});

test('addDatacenter: id 정규화/검증 + 중복 거부', () => {
  assert.equal(addDatacenter({ id: 'Seoul-DC1', name: '서울 IDC', region: 'KR' }).ok, true);
  assert.equal(listDatacenters()[0].id, 'seoul-dc1'); // 소문자
  assert.equal(addDatacenter({ id: 'seoul-dc1', name: '중복' }).ok, false); // 중복
  assert.equal(addDatacenter({ id: 'bad id!', name: 'x' }).ok, false);      // 잘못된 문자
  assert.equal(addDatacenter({ id: 'x', name: '' }).ok, false);            // name 필수
});

test('setVcenterDatacenter: 유효 DataCenter만 허용 + 해제', () => {
  addDatacenter({ id: 'dc1', name: 'DC1' });
  assert.equal(setVcenterDatacenter('vc-kr', 'ghost').ok, false); // 없는 DataCenter
  assert.equal(setVcenterDatacenter('vc-kr', 'dc1').ok, true);
  assert.equal(datacenterOfVcenter('vc-kr'), 'dc1');
  assert.equal(setVcenterDatacenter('vc-kr', '').ok, true);       // 해제
  assert.equal(datacenterOfVcenter('vc-kr'), '');
});

test('setVcenterDatacenterMany: 일괄 + 유령 무시 + 변경수', () => {
  addDatacenter({ id: 'dc1', name: 'DC1' });
  addDatacenter({ id: 'dc2', name: 'DC2' });
  const r = setVcenterDatacenterMany([['vc-a', 'dc1'], ['vc-b', 'dc2'], ['vc-c', 'ghost']]);
  assert.equal(r.ok, true);
  assert.equal(r.changed, 2);                 // ghost 무시
  const a = getDatacenterAssign();
  assert.equal(a['vc-a'], 'dc1');
  assert.equal(a['vc-b'], 'dc2');
  assert.equal(a['vc-c'], undefined);
});

test('removeDatacenter: 삭제 시 할당된 vCenter 매핑도 정리', () => {
  addDatacenter({ id: 'dc1', name: 'DC1' });
  setVcenterDatacenter('vc-a', 'dc1');
  assert.equal(removeDatacenter('dc1').ok, true);
  assert.equal(getDatacenterAssign()['vc-a'], undefined); // 유령 매핑 제거
  assert.equal(removeDatacenter('dc1').ok, false);        // 이미 없음
});

test('updateDatacenter: 이름/리전 수정', () => {
  addDatacenter({ id: 'dc1', name: 'DC1' });
  assert.equal(updateDatacenter('dc1', { name: 'DC-One', region: 'KR' }).ok, true);
  assert.equal(listDatacenters()[0].name, 'DC-One');
  assert.equal(updateDatacenter('dc1', { name: '' }).ok, false); // name 비우기 불가
  assert.equal(updateDatacenter('nope', { name: 'x' }).ok, false);
});
