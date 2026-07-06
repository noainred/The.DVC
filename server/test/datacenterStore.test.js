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

test('removeDatacenter + ensureDatacenter: 삭제한 법인은 자동 백필로 부활하지 않음(tombstone)', () => {
  // 수집서버 백필 시나리오: WA-IRS 법인이 ensure로 생성됨
  ensureDatacenter({ id: 'WA-IRS', name: 'WA-IRS' });
  assert.ok(listDatacenters().some((d) => d.id === 'wa-irs'));
  // 관리자가 삭제
  const del = removeDatacenter('wa-irs');
  assert.equal(del.ok, true);
  assert.equal(listDatacenters().some((d) => d.id === 'wa-irs'), false);
  // 수집서버가 계속 존재해 다시 ensure(백필)해도 부활하지 않아야 한다
  const re = ensureDatacenter({ id: 'WA-IRS', name: 'WA-IRS' });
  assert.equal(re.skipped, 'deleted');
  assert.equal(listDatacenters().some((d) => d.id === 'wa-irs'), false);
});

test('addDatacenter: 명시적 재등록은 tombstone 해제(다시 원하면 살아남)', () => {
  ensureDatacenter({ id: 'wa-irs', name: 'WA-IRS' });
  removeDatacenter('wa-irs');
  assert.equal(ensureDatacenter({ id: 'wa-irs' }).skipped, 'deleted'); // 아직 tombstone
  // 관리자가 명시적으로 다시 추가
  const add = addDatacenter({ id: 'wa-irs', name: 'WA-IRS' });
  assert.equal(add.ok, true);
  assert.ok(listDatacenters().some((d) => d.id === 'wa-irs'));
  // 이제 ensure가 정상 no-op(부활 아님, 이미 존재)
  assert.equal(ensureDatacenter({ id: 'wa-irs', name: 'WA-IRS' }).existed, true);
});
