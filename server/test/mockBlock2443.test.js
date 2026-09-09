/**
 * v2.443 — 목(가짜) 데이터가 중앙 인벤토리에 들어오지 않게 한다.
 *
 * 사용자 신고: "신규로 배포한 엣지인데 live 설정을 했는데 vcenter 에 east us 이런 목업 데이터가 올라와".
 *
 * 원인: 기존 차단(v2.428)은 push 본문의 `source === 'mock'` **플래그만** 봤다. 그런데
 *   · `DATA_SOURCE=auto` 는 vCenter 접속 실패 시 **목 데이터로 폴백**하면서도 source 는 'auto'
 *   · 구버전 엣지는 source 필드 자체를 안 보냄
 * → 실제로는 가짜인 인벤토리가 통과해 저장됐다. 내용(생성기 id·이름)으로도 판정하도록 고쳤다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMockVcenter, mockVcenterIdentities, generateSnapshot } from '../src/mock/generator.js';

test('목 사이트는 id·이름이 둘 다 같을 때만 목업으로 판정한다(오탐 방지)', () => {
  assert.equal(isMockVcenter({ id: 'vc-us-east', name: 'vcenter-us-east-01' }), true);
  // 고객이 우연히 같은 id 를 써도 이름이 다르면 실데이터로 본다 — 실운영 인벤토리를 지우면 안 된다.
  assert.equal(isMockVcenter({ id: 'vc-us-east', name: '우리 회사 vCenter' }), false);
  assert.equal(isMockVcenter({ id: 'nb-vc01', name: 'vcenter-us-east-01' }), false);
  assert.equal(isMockVcenter({ id: '', name: '' }), false);
  assert.equal(isMockVcenter(null), false);
  assert.equal(isMockVcenter(undefined), false);
});

test('판정 목록은 생성기가 실제로 만드는 사이트와 일치한다(목록이 따로 놀지 않게)', () => {
  const ids = mockVcenterIdentities();
  assert.ok(ids.length >= 10);
  const snap = generateSnapshot();
  for (const vc of snap.vcenters) {
    assert.equal(isMockVcenter(vc), true, `생성기가 만든 ${vc.id} 를 목업으로 못 잡는다`);
  }
  // 사용자가 본 그 사이트.
  assert.ok(ids.some((s) => s.id === 'vc-us-east' && s.name === 'vcenter-us-east-01'));
});

test('저장돼 있던 목 인벤토리를 정리한다 — 실데이터는 남긴다', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockinv-'));
  process.env.CONFIG_DIR = dir;
  const inv = await import(`../src/central/inventory.js?t=${Date.now()}`);

  inv.setInventory('vc-us-east', { vcenter: { id: 'vc-us-east', name: 'vcenter-us-east-01' }, hosts: [], vms: [] }, 'nb-irs');
  inv.setInventory('vc-ap-northeast', { vcenter: { id: 'vc-ap-northeast', name: 'vcenter-ap-northeast-01' }, hosts: [], vms: [] }, 'nb-irs');
  inv.setInventory('nb-vc01', { vcenter: { id: 'nb-vc01', name: 'NB 실제 vCenter' }, hosts: [{ id: 'h1' }], vms: [] }, 'nb-irs');

  const removed = inv.pruneMockInventory();
  assert.equal(removed.length, 2);
  assert.ok(removed.includes('vc-us-east'));
  assert.equal(inv.getInventory('vc-us-east'), null);
  assert.ok(inv.getInventory('nb-vc01'), '실데이터가 지워졌다');

  // 다시 불러도 아무것도 안 지운다(멱등).
  assert.deepEqual(inv.pruneMockInventory(), []);
});
