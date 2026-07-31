import test from 'node:test';
import assert from 'node:assert/strict';
import { scopedVcenterIds } from '../src/auth/scope.js';

const snap = {
  vcenters: [
    { id: 'vc-seoul', location: { region: '아시아' } },
    { id: 'vc-tokyo', location: { region: '아시아' } },
    { id: 'vc-warsaw', location: { region: '유럽' } },
    { id: 'vc-nyc', location: { region: '북미' } },
  ],
};

test('scope 없음 → null(전체 허용)', () => {
  assert.equal(scopedVcenterIds(null, snap), null);
  assert.equal(scopedVcenterIds({ role: 'admin' }, snap), null);
  assert.equal(scopedVcenterIds({ scope: { vcenters: [], regions: [] } }, snap), null);
});

test('명시 vCenter 제한', () => {
  const set = scopedVcenterIds({ scope: { vcenters: ['vc-seoul'], regions: [] } }, snap);
  assert.deepEqual([...set], ['vc-seoul']);
});

test('리전 제한 → 그 리전의 모든 vCenter 포함', () => {
  const set = scopedVcenterIds({ scope: { vcenters: [], regions: ['아시아'] } }, snap);
  assert.ok(set.has('vc-seoul') && set.has('vc-tokyo'));
  assert.ok(!set.has('vc-warsaw') && !set.has('vc-nyc'));
});

test('vCenter + 리전 합집합', () => {
  const set = scopedVcenterIds({ scope: { vcenters: ['vc-nyc'], regions: ['유럽'] } }, snap);
  assert.deepEqual([...set].sort(), ['vc-nyc', 'vc-warsaw']);
});
