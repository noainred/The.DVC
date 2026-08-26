import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopedVcenterIds, writeScopedVcenterIds, inUserWriteScope, inUserScope } from '../src/auth/scope.js';

const SNAP = { vcenters: [
  { id: 'kr1', location: { region: 'APAC' } },
  { id: 'kr2', location: { region: 'APAC' } },
  { id: 'pl1', location: { region: 'EU' } },
  { id: 'us1', location: { region: 'AMER' } },
] };
const U = (scope) => ({ username: 't', scope });

test('writeVcenters 미설정 → 쓰기 범위 = 조회 범위(기존 동작 보존)', () => {
  // 무제한 계정
  assert.equal(writeScopedVcenterIds(U(undefined), SNAP), null);
  assert.equal(writeScopedVcenterIds(U({ vcenters: [], regions: [], writeVcenters: [] }), SNAP), null);
  // 조회 제한 계정 — 쓰기도 같은 집합
  const u = U({ vcenters: ['kr1'], regions: ['EU'], writeVcenters: [] });
  const read = scopedVcenterIds(u, SNAP);
  const write = writeScopedVcenterIds(u, SNAP);
  assert.deepEqual([...write].sort(), [...read].sort()); // kr1 + EU(pl1)
  assert.ok(inUserWriteScope(u, SNAP, 'pl1'));
  assert.ok(!inUserWriteScope(u, SNAP, 'us1'));
});

test('조회 무제한 + writeVcenters 설정 → 그 vCenter 만 수정 가능(조회는 전체)', () => {
  const u = U({ vcenters: [], regions: [], writeVcenters: ['kr1'] });
  assert.equal(scopedVcenterIds(u, SNAP), null);        // 조회 전체
  assert.ok(inUserScope(u, SNAP, 'us1'));
  const w = writeScopedVcenterIds(u, SNAP);
  assert.deepEqual([...w], ['kr1']);
  assert.ok(inUserWriteScope(u, SNAP, 'kr1'));
  assert.ok(!inUserWriteScope(u, SNAP, 'us1'));         // 조회는 되지만 수정 불가
});

test('조회 제한 + writeVcenters → 교집합만(조회 못 하는 vCenter 는 수정도 불가)', () => {
  const u = U({ vcenters: ['kr1', 'kr2'], regions: [], writeVcenters: ['kr2', 'us1'] });
  const w = writeScopedVcenterIds(u, SNAP);
  assert.deepEqual([...w].sort(), ['kr2']);             // us1 은 조회 범위 밖 → 무효
  assert.ok(!inUserWriteScope(u, SNAP, 'us1'));
  assert.ok(!inUserWriteScope(u, SNAP, 'kr1'));         // 조회는 되지만 쓰기 목록에 없음
  assert.ok(inUserWriteScope(u, SNAP, 'kr2'));
});

test('리전 확장 조회 + writeVcenters 교집합', () => {
  const u = U({ vcenters: [], regions: ['APAC'], writeVcenters: ['kr1', 'pl1'] });
  const w = writeScopedVcenterIds(u, SNAP);
  assert.deepEqual([...w], ['kr1']);                    // pl1(EU)은 조회 범위 밖
});

test('writeVcenters 교집합이 비면 어떤 vCenter 도 수정 불가(빈 Set ≠ 무제한)', () => {
  const u = U({ vcenters: ['kr1'], regions: [], writeVcenters: ['us1'] });
  const w = writeScopedVcenterIds(u, SNAP);
  assert.equal(w.size, 0);
  assert.ok(!inUserWriteScope(u, SNAP, 'kr1'));
  assert.ok(!inUserWriteScope(u, SNAP, 'us1'));
});
