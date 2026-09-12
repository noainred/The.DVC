// v2.491 — 도구 화면의 클러스터·폴더 하위 범위 필터(순수 판정) 회귀 고정.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normGroupQuery, hasGroup, vmGroupMatch, filterVmsByGroup, inventoryGroups } from '../src/routes/api/groupFilter.js';

const vms = [
  { name: 'a', cluster: 'CL1', folder: 'vm/Prod' },
  { name: 'b', cluster: 'CL1', folder: 'vm/Dev' },
  { name: 'c', cluster: 'CL2', folder: 'vm/Prod' },
  { name: 't', cluster: 'CL2', folder: 'vm/Prod', template: true },
  { name: 'n', cluster: '', folder: '' },
];
const hosts = [
  { name: 'h1', cluster: 'CL1' }, { name: 'h2', cluster: 'CL1' },
  { name: 'h3', cluster: 'CL2' }, { name: 'h4', cluster: 'CL3-empty' }, { name: 'h5', cluster: '' },
];

test('normGroupQuery — 공백 제거·미지정은 빈 값(필터 없음)', () => {
  assert.deepEqual(normGroupQuery({ cluster: '  CL1 ', folder: 'vm/Prod' }), { cluster: 'CL1', folder: 'vm/Prod' });
  assert.deepEqual(normGroupQuery({}), { cluster: '', folder: '' });
  assert.equal(hasGroup(normGroupQuery({})), false);
  assert.equal(hasGroup(normGroupQuery({ folder: 'vm' })), true);
  // 과도한 길이는 잘라 저장·로그 오염을 막는다.
  assert.equal(normGroupQuery({ cluster: 'x'.repeat(500) }).cluster.length, 300);
});

test('vmGroupMatch — 완전일치 AND(부분일치·대소문자 무시 없음)', () => {
  const g = { cluster: 'CL1', folder: 'vm/Prod' };
  assert.equal(vmGroupMatch(vms[0], g), true);
  assert.equal(vmGroupMatch(vms[1], g), false);       // 폴더 불일치
  assert.equal(vmGroupMatch(vms[2], g), false);       // 클러스터 불일치
  assert.equal(vmGroupMatch(vms[0], { cluster: 'cl1', folder: '' }), false); // 대소문자 다르면 불일치
  assert.equal(vmGroupMatch(vms[0], { cluster: 'CL', folder: '' }), false);  // 접두 일치는 불일치
  assert.equal(vmGroupMatch(vms[4], { cluster: '', folder: '' }), true);     // 미선택이면 전부 통과
});

test('filterVmsByGroup — 미선택이면 원본 그대로, 선택 시 교집합', () => {
  assert.equal(filterVmsByGroup(vms, { cluster: '', folder: '' }), vms); // 불필요한 복사 없음
  assert.deepEqual(filterVmsByGroup(vms, { cluster: 'CL1', folder: '' }).map((v) => v.name), ['a', 'b']);
  assert.deepEqual(filterVmsByGroup(vms, { cluster: '', folder: 'vm/Prod' }).map((v) => v.name), ['a', 'c', 't']);
  assert.deepEqual(filterVmsByGroup(vms, { cluster: 'CL2', folder: 'vm/Prod' }).map((v) => v.name), ['c', 't']);
  assert.deepEqual(filterVmsByGroup(vms, { cluster: '없는클러스터', folder: '' }), []);
  assert.deepEqual(filterVmsByGroup(null, { cluster: 'CL1', folder: '' }), []);
});

test('inventoryGroups — 실재 값만·이름순·템플릿 제외·호스트만 있는 클러스터 유지', () => {
  const g = inventoryGroups({ hosts, vms });
  assert.deepEqual(g.clusters.map((c) => c.name), ['CL1', 'CL2', 'CL3-empty']); // 빈 이름 제외, 이름순
  assert.deepEqual(g.clusters.find((c) => c.name === 'CL1'), { name: 'CL1', hosts: 2, vms: 2 });
  // 템플릿은 VM 수에서 제외(낭비 리소스가 다루는 모집단과 동일)
  assert.deepEqual(g.clusters.find((c) => c.name === 'CL2'), { name: 'CL2', hosts: 1, vms: 1 });
  // 호스트만 있고 VM 이 0 인 클러스터도 실재하므로 목록에 남는다
  assert.deepEqual(g.clusters.find((c) => c.name === 'CL3-empty'), { name: 'CL3-empty', hosts: 1, vms: 0 });
  assert.deepEqual(g.folders, [{ name: 'vm/Dev', vms: 1 }, { name: 'vm/Prod', vms: 2 }]);
});

test('inventoryGroups — 폴더 미수집(REST 경로) vCenter 는 빈 배열(추정 금지)', () => {
  const g = inventoryGroups({ hosts: [{ cluster: 'CL1' }], vms: [{ name: 'a', cluster: 'CL1' }] });
  assert.deepEqual(g.folders, []);
  assert.deepEqual(g.clusters, [{ name: 'CL1', hosts: 1, vms: 1 }]);
  assert.deepEqual(inventoryGroups({}), { clusters: [], folders: [] });
});
