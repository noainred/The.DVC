import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupRemoteServers } from '../src/collector/remoteInventory.js';

test('dedupRemoteServers: 같은 엣지를 두 수집서버(nj/NJ)가 pull한 중복을 물리 1대로 합침', () => {
  const list = [
    { id: 'idrac-10.112.161.212', serviceTag: 'HST4ZB4', host: '10.112.161.212', collectorId: 'nj', datacenterId: '' },
    { id: 'idrac-10.112.161.212', serviceTag: 'HST4ZB4', host: '10.112.161.212', collectorId: 'NJ', datacenterId: 'NJ' },
    { id: 'idrac-10.112.161.213', serviceTag: 'HGPR0C4', host: '10.112.161.213', collectorId: 'nj', datacenterId: 'NJ' },
    { id: 'idrac-10.112.161.213', serviceTag: 'HGPR0C4', host: '10.112.161.213', collectorId: 'NJ', datacenterId: 'NJ' },
  ];
  const out = dedupRemoteServers(list);
  assert.equal(out.length, 2); // 4행 → 물리 2대
  // datacenterId가 채워진 쪽을 보존
  const a = out.find((s) => s.serviceTag === 'HST4ZB4');
  assert.equal(a.datacenterId, 'NJ');
});

test('dedupRemoteServers: 서로 다른 물리 서버(태그 다름)는 합치지 않음', () => {
  const out = dedupRemoteServers([
    { id: 'a', serviceTag: 'TAG1', host: '10.0.0.1' },
    { id: 'b', serviceTag: 'TAG2', host: '10.0.0.2' },
  ]);
  assert.equal(out.length, 2);
});

test('dedupRemoteServers: 서비스태그 없으면 id로, id도 없으면 주소로 dedup', () => {
  const out = dedupRemoteServers([
    { id: 'x1', serviceTag: '', host: '10.0.0.5' },
    { id: 'x1', serviceTag: '', host: '10.0.0.5' }, // 같은 id
    { id: '', serviceTag: '', host: 'https://10.0.0.6' },
    { id: '', serviceTag: '', host: '10.0.0.6' }, // 같은 주소(스킴 무시)
  ]);
  assert.equal(out.length, 2);
});

test('dedupRemoteServers: 식별키가 전혀 없는 항목은 합치지 않고 보존', () => {
  const out = dedupRemoteServers([{ id: '', serviceTag: '', host: '' }, { id: '', serviceTag: '', host: '' }]);
  assert.equal(out.length, 2);
});
