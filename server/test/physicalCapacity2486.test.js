// v2.486 — Overview CPU/메모리 카드: iDRAC 인식 전체 물리 서버 코어·메모리 합계(순수 집계).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capacityOfInventory, aggregatePhysical } from '../src/idrac/physicalCapacity.js';

test('capacityOfInventory — CoreCount 우선, 없으면 소켓별 cores 합, 메모리는 TotalSystemMemoryGiB', () => {
  assert.deepEqual(capacityOfInventory({ cpu: { count: 2, cores: 64, threads: 128 }, memory: { totalGiB: 512 } }), { cores: 64, threads: 128, sockets: 2, memGiB: 512 });
  assert.deepEqual(capacityOfInventory({ cpu: { count: null, cores: null }, cpus: [{ cores: 32 }, { cores: 32 }], memory: {} }), { cores: 64, threads: null, sockets: 2, memGiB: null });
  assert.equal(capacityOfInventory(null), null);
  assert.equal(capacityOfInventory({ cpu: { cores: 0 } }).cores, null, '0/음수는 모른다로 취급');
});

test('aggregatePhysical — 중복 id 제거, 인벤토리 없는 서버는 개수만, GiB→GB 병기', () => {
  const servers = [
    { id: 'a' }, { id: 'b' }, { id: 'b' }, { id: 'c', remote: true, inv: { cpu: { count: 2, cores: 48 }, memory: { totalGiB: 256 } } }, { id: 'd' },
  ];
  const invs = { a: { cpu: { count: 2, cores: 64, threads: 128 }, memory: { totalGiB: 512 } }, b: { cpu: {}, cpus: [{ cores: 16 }], memory: { totalGiB: 128 } } };
  const r = aggregatePhysical(servers, (s) => (s.remote ? s.inv : invs[s.id] || null));
  assert.equal(r.servers, 4);
  assert.equal(r.withInventory, 3);
  assert.equal(r.withCores, 3); assert.equal(r.cores, 64 + 16 + 48);
  assert.equal(r.withMemory, 3); assert.equal(r.memGiB, 896);
  assert.equal(r.memGB, Math.round(896 * 1.073741824));
  assert.equal(r.sockets, 2 + 1 + 2);
  assert.equal(r.threads, 128);
  assert.deepEqual(aggregatePhysical([], () => null).servers, 0);
});
