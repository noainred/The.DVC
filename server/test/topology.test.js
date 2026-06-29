import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTopology } from '../src/insights/topology.js';

// vCenter 2개, 클러스터(C1,C2,standalone), 호스트 4대, VM 몇 개.
const snap = {
  vcenters: [{ id: 'vc1', name: 'VC1' }, { id: 'vc2', name: 'VC2' }],
  hosts: [
    { id: 'h1', name: 'h1', vcenterId: 'vc1', cluster: 'C1', connectionState: 'CONNECTED', powerState: 'POWERED_ON' },
    { id: 'h2', name: 'h2', vcenterId: 'vc1', cluster: 'C1', connectionState: 'CONNECTED', powerState: 'POWERED_ON' },
    { id: 'h3', name: 'h3', vcenterId: 'vc1', cluster: 'C2', connectionState: 'CONNECTED', powerState: 'POWERED_ON' },
    { id: 'h4', name: 'h4', vcenterId: 'vc2', cluster: '', connectionState: 'CONNECTED', powerState: 'POWERED_ON' }, // standalone
  ],
  vms: [
    { id: 'vm1', name: 'vm1', vcenterId: 'vc1', host: 'h1', powerState: 'POWERED_ON' },
    { id: 'vm2', name: 'vm2', vcenterId: 'vc1', host: 'h1', powerState: 'POWERED_OFF' },
    { id: 'vm3', name: 'vm3', vcenterId: 'vc2', host: 'h4', powerState: 'POWERED_ON' },
  ],
};

test('buildTopology 전체: 노드 = vCenter + 클러스터 + 호스트 (VM은 미포함)', () => {
  const t = buildTopology(snap, {});
  // vCenter 2 + 클러스터 3(C1,C2,standalone) + 호스트 4 = 9
  assert.equal(t.counts.vcenters, 2);
  assert.equal(t.counts.clusters, 3);
  assert.equal(t.counts.hosts, 4);
  assert.equal(t.counts.vms, 0, '전체 모드에서는 개별 VM 노드 미생성');
  assert.equal(t.nodeCount, 2 + 3 + 4, '노드 합 = vCenter+클러스터+호스트');
  // 호스트 수는 스냅샷 호스트 수와 정확히 일치(노드 수와 혼동 금지).
  assert.equal(t.counts.hosts, snap.hosts.length);
});

test('buildTopology focus(vc1): 개별 VM 노드 포함', () => {
  const t = buildTopology(snap, { vcenterId: 'vc1' });
  assert.equal(t.counts.vcenters, 1);
  assert.equal(t.counts.hosts, 3);     // vc1 호스트 3
  assert.equal(t.counts.clusters, 2);  // C1, C2
  assert.equal(t.counts.vms, 2);       // vc1 VM 2개(템플릿 제외)
  assert.equal(t.nodeCount, 1 + 2 + 3 + 2);
});
