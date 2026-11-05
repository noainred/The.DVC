/**
 * v2.899 — 버그 수정 · 개선 묶음(사용자 요청 '버그 수정이나 개선을 위한 작업 진행' · 범위: 버그 2건 · VMXNET3 권장 · 수집 확장 3종 · 전체 점검).
 *  ⓐ-1 연결된 vCenter: 범위 계정에는 조회 범위 안 등록 vCenter 와 짝지은 노드만 이름을 보인다(파트너 · 복제 이름도)
 *  ⓐ-2 데모: VM 스냅샷 개수 · 트리가 생성할 때마다 바뀌지 않는다
 */
import test from 'node:test';
import assert from 'node:assert/strict';

test('ⓐ-1 연결된 vCenter — 범위 계정은 짝지은 노드만 이름 · 전체 범위는 그대로', async () => {
  const { maskLinkedForScope } = await import('../src/routes/api/vcInfo.js');
  const body = {
    nodes: [
      { node: 'a.corp', type: 'VCSA_EMBEDDED', partners: ['b.corp', 'c.corp'], portal: { id: 'a' } },
      { node: 'b.corp', type: 'VCSA_EMBEDDED', partners: ['a.corp'], portal: null },
      { node: 'c.corp', type: 'VCSA_EMBEDDED', partners: [], portal: { id: 'c' } },
    ],
    replication: [{ node: 'a.corp', partner: 'b.corp', available: false, replicating: true, lag: 3 }],
  };
  const m = maskLinkedForScope(body, new Set(['a', 'c']));
  assert.deepEqual(m.nodes.map((n) => n.node), ['a.corp', null, 'c.corp']);
  assert.equal(m.nodes[1].masked, true);
  assert.deepEqual(m.nodes[0].partners, [null, 'c.corp'], '파트너 이름도 가린다');
  assert.deepEqual([m.replication[0].node, m.replication[0].partner, m.replication[0].available], ['a.corp', null, false], '복제 상태는 이름만 가리고 값은 남긴다');
  assert.equal(m.maskedNodes, 1);
  assert.equal(JSON.stringify(m).includes('b.corp'), false, '가린 이름이 응답 어디에도 남지 않는다');
  assert.equal(maskLinkedForScope(body, null), body, '전체 범위 계정은 그대로');
});

test('ⓐ-2 데모 — 같은 VM 의 스냅샷 개수 · 트리 노드 수가 생성마다 같다', async () => {
  const { generateSnapshot } = await import('../src/mock/generator.js');
  const a = generateSnapshot(0); const b = generateSnapshot(1);
  const byId = new Map(b.vms.map((v) => [v.id, v]));
  let n = 0;
  for (const v of a.vms) {
    const w = byId.get(v.id);
    if (!w) continue;
    assert.equal(v.snapshotCount, w.snapshotCount, v.id);
    assert.equal((v.snapshotTree || []).length, (w.snapshotTree || []).length, v.id);
    if (v.snapshotCount) { n += 1; assert.equal(v.snapshotTree.length, v.snapshotCount, '트리 노드 수 = 개수'); }
  }
  assert.ok(n > 0, '스냅샷이 있는 데모 VM 이 있다');
});
