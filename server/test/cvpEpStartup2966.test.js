/**
 * v2.966 — CVP 위치(EndpointLocation) 조회를 부품 주기와 따로 센다.
 *   예전: 위치 조회 대상 고르기가 부품 주기(기본 30분)에 묶여, 기동 직후 첫 부품 주기(vCenter 첫 수집 전 — 인벤토리가 빔)에
 *   묻는 MAC 이 0개였는데 그 주기를 '했다' 로 쳐서 다음 부품 주기까지 '위치 조회(주기)' 칸이 비었다(v2.940 데모 관찰).
 *   이제: 인벤토리가 비었으면 묻지도 소모하지도 않고 다음 폴링에 다시 본다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cvpep2966-'));
Object.assign(process.env, { CONFIG_DIR: TMP, DB_DIR: TMP, DATA_SOURCE: 'mock' });
fs.writeFileSync(path.join(TMP, 'cvp-settings.json'), JSON.stringify({ endpointPerCycle: 1 }));   // 한 주기에 하나씩 — 소모 여부를 가를 수 있게
fs.writeFileSync(path.join(TMP, 'datacenters.json'), JSON.stringify({ datacenters: [{ id: 'dc-seoul', name: 'Seoul 법인' }], assign: { 'vc-a': 'dc-seoul' } }));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const cvpDemo = await import('../src/mock/demo/cvp.js');
const cvpReg = await import('../src/cvp/registry.js');
const cvpPoller = await import('../src/cvp/poller.js');
const { getStatus } = await import('../src/cvp/store.js');
const { store } = await import('../src/store.js');

test('inventoryReady — 호스트 · VM 이 하나라도 있어야 준비', () => {
  assert.equal(cvpPoller.inventoryReady(null), false);
  assert.equal(cvpPoller.inventoryReady({ hosts: [], vms: [] }), false);
  assert.equal(cvpPoller.inventoryReady({ hosts: [{ id: 'h' }], vms: [] }), true);
  assert.equal(cvpPoller.inventoryReady({ hosts: [], vms: [{ id: 'v' }] }), true);
});

test('기동 직후 빈 인벤토리 주기는 위치 조회를 소모하지 않는다 — 다음 (부품 주기가 아닌) 폴링에 묻는다', async () => {
  const servers = cvpDemo.demoCvpServers([{ id: 'dc-seoul', name: 'Seoul 법인', code: 'SEO' }]);
  assert.equal(cvpReg.seedDemoServers(servers).ok, true);
  cvpPoller._resetForTest();
  assert.equal(cvpPoller.inventoryReady(store.get()), false, '시작 상태 — vCenter 첫 수집 전');
  let r = await cvpPoller.pollCvpOnce({ trigger: 'test' });
  assert.equal(r.ok, true, JSON.stringify(r));
  for (const s of servers) assert.equal(getStatus(s.id)?.endpoints, undefined, `${s.id} — 인벤토리가 비면 묻지 않는다`);
  // vCenter 첫 수집이 끝났다 — 같은 법인 호스트 NIC 하나
  store.snapshot = { ...store.get(), hosts: [{ id: 'vc-a:h1', vcenterId: 'vc-a', name: 'esx1', nics: [{ device: 'vmnic0', mac: 'b8:59:9f:00:00:01' }, { device: 'vmnic1', mac: 'b8:59:9f:00:00:02' }] }], vms: [] };
  r = await cvpPoller.pollCvpOnce({ trigger: 'test' });   // 주기 폴링(수동 아님) — 부품 주기는 방금 지났다
  assert.equal(r.ok, true, JSON.stringify(r));
  for (const s of servers) {
    const ep = getStatus(s.id)?.endpoints;
    assert.ok(ep, `${s.id} — 다음 폴링에 위치를 묻는다(예전에는 다음 부품 주기 30분 뒤까지 비었다)`);
    assert.equal(ep.asked, 1);
  }
  // 이번에는 물었으니 소모한다 — 바로 다음 폴링은 남은 MAC(vmnic1)을 묻지 않고 직전 요약을 그대로 싣는다
  const at = getStatus(servers[0].id).endpoints.at;
  r = await cvpPoller.pollCvpOnce({ trigger: 'test' });
  assert.equal(getStatus(servers[0].id).endpoints.at, at, '물은 뒤에는 위치 조회 주기(부품 주기와 같은 길이)를 지킨다');
});
