// v2.973 하드웨어 내보내기 — '안 나오는 정보' 채우기(사용자 요청 2026-11-11: A1~A14 · B1 · C1 · C2 모두 진행).
//   A: 엣지 서버만 비던 값 — 엣지 축약 인벤토리(collector/compactInv.js)와 중앙 수신 정제(collector/remoteInventory.js INV_SHAPE)에 **짝으로** 추가.
//   B1: 팬 상태(수집기가 health.fan 을 채우지 않음) → 부품 원소 판정. C1: 사양서 vCenter 두 줄. C2: 열 너비를 값 길이에.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactInv } from '../src/collector/compactInv.js';
import { sanitizeRemoteInv } from '../src/collector/remoteInventory.js';
import { HW_FIELDS } from '../src/insights/hwExport/catalog.js';
import { specOf } from '../src/insights/hwExport/rows.js';
import { fitWidths, dispLen } from '../src/insights/hwExport/xlsx.js';
import { BIOS_KEYS } from '../src/idrac/biosKeys.js';

// iDRAC fetchInventory(idrac/redfish.js) 모양의 인벤토리 — 이번에 엣지가 새로 싣는 값을 모두 채운다.
function fullInv() {
  return {
    system: { model: 'PowerEdge R640', serviceTag: '2JSRMK3', biosVersion: '2.19.1', hostName: 'h1', health: 'OK', manufacturer: 'Dell Inc.', powerState: 'On',
      assetTag: 'A-77', uuid: '4c4c4544-0000', serialNumber: 'SER-DROP', sku: 'SKU-DROP', indicatorLED: 'Off' },
    cpu: { model: 'Xeon 6246R', count: 2, cores: 32, threads: 64, health: 'OK' },
    memory: { totalGiB: 384, health: 'OK' },
    idrac: { firmwareVersion: '6.10', model: '14G Monolithic', type: 'BMC', dateTime: 'X-DROP' },
    bios: { version: '2.19.1', attributes: { BootMode: 'Uefi', LogicalProc: 'Enabled', NotListed: 'DROP', SysProfile: { nested: 1 } }, attributeCount: 400 },
    powerCap: { limitWatts: 700, allocatedWatts: 1, metricWatts: 2 },
    licenses: [{ name: 'iDRAC9 Enterprise', type: 'Perpetual', entitlement: 'ENT-DROP', expiry: '' }],
    network: [{ name: 'iDRAC.Embedded.1', mac: 'AA:BB', hostName: 'idrac-h1', fqdn: 'idrac-h1.x', ipv4: '10.1.1.5' }],
    nics: [{ name: 'NIC.Integrated.1', model: 'BRCM 5720', firmware: '21.80', ports: [{ id: 'NIC.Integrated.1-1', link: 'Up', speedMbps: 1000, mac: 'CC' }] }],
    cpus: [{ socket: 'CPU.Socket.1', model: 'Xeon', cores: 16, threads: 32, maxSpeedMHz: 4000, manufacturer: 'Intel', health: 'OK', state: 'Enabled' }],
    disks: [{ name: 'Disk 0', model: 'ST600', capacityGB: 600, media: 'HDD', protocol: 'SAS', rpm: 10000, health: 'OK', state: 'Enabled', serial: 'S-DROP', predictiveFailure: false }],
    psus: [{ name: 'PS1 Status', model: 'PWR 750W', manufacturer: 'DELL', capacityWatts: 750, firmware: '00.1D.7D', serial: 'P-DROP', partNumber: 'PN-DROP', health: 'OK', state: 'Enabled' }],
    memoryDimms: [{ locator: 'A1', sizeGB: 32, type: 'DDR4', speedMHz: 2933, manufacturer: 'Hynix', partNumber: 'HMA', rank: 2, serial: 'M-DROP', health: 'OK', state: 'Enabled' }],
    storageControllers: [{ name: 'PERC H730P', model: 'PERC', firmware: '25.5', speedGbps: 12, protocols: ['SAS'], health: 'OK' }],
    pcie: [{ name: 'BOSS-S1', model: 'BOSS', manufacturer: 'DELL', deviceType: 'MultiFunction', firmware: '2.5.13', health: 'OK' }],
    fans: [{ name: 'Fan1A', health: 'OK' }, { name: 'Fan2A', health: 'Critical' }],
    health: { overall: 'OK', processor: 'OK', memory: 'OK', storage: 'OK', psu: 'OK', fan: '', battery: '' },
    collections: { psus: 'ok', disks: 'ok', fans: 'ok', pcie: 'ok' },
    collectedAt: 1_700_000_000_000,
  };
}

test('짝 — 엣지가 싣는 값은 중앙 정제를 그대로 통과한다(한쪽만 넓히면 버려진다 — 이 비교가 잡는다)', () => {
  const c = compactInv(fullInv());
  const s = sanitizeRemoteInv(JSON.parse(JSON.stringify(c)));
  assert.deepEqual(JSON.parse(JSON.stringify(s)), JSON.parse(JSON.stringify(c)));
});

test('A1~A14 — 새로 싣는 값 · 여전히 싣지 않는 값(시리얼 · 부품번호(PSU) · 라이선스 주문 식별자 · 목록 밖 BIOS 항목)', () => {
  const s = sanitizeRemoteInv(JSON.parse(JSON.stringify(compactInv(fullInv()))));
  assert.deepEqual([s.system.manufacturer, s.system.powerState, s.system.assetTag, s.system.uuid], ['Dell Inc.', 'On', 'A-77', '4c4c4544-0000']);
  assert.equal(s.cpu.threads, 64);
  assert.deepEqual([s.cpus[0].threads, s.cpus[0].maxSpeedMHz, s.cpus[0].manufacturer], [32, 4000, 'Intel']);
  assert.equal(s.memoryDimms[0].rank, 2); assert.equal(s.disks[0].rpm, 10000); assert.equal(s.storageControllers[0].speedGbps, 12);
  assert.equal(s.psus[0].firmware, '00.1D.7D'); assert.equal(s.pcie[0].firmware, '2.5.13'); assert.equal(s.nics[0].firmware, '21.80');
  assert.equal(s.powerCap.limitWatts, 700); assert.equal(s.idrac.model, '14G Monolithic');
  assert.deepEqual(s.bios.attributes, { BootMode: 'Uefi', LogicalProc: 'Enabled' }, '목록 키 · 스칼라만');
  assert.deepEqual(s.licenses, [{ name: 'iDRAC9 Enterprise', type: 'Perpetual', expiry: '' }]);
  assert.deepEqual(s.network, [{ name: 'iDRAC.Embedded.1', mac: 'AA:BB', hostName: 'idrac-h1', fqdn: 'idrac-h1.x', ipv4: '10.1.1.5' }]);
  const txt = JSON.stringify(s);
  for (const bad of ['SER-DROP', 'SKU-DROP', 'S-DROP', 'P-DROP', 'PN-DROP', 'M-DROP', 'ENT-DROP', 'X-DROP', 'DROP"']) assert.ok(!txt.includes(bad), bad);
  assert.ok(BIOS_KEYS.includes('BootMode'));
});

test('구버전 엣지 모양 — 새 값이 없으면 키를 만들지 않는다(구버전 판정을 바꾸지 않게)', () => {
  const c = compactInv({ system: { model: 'R640' }, cpus: [{ socket: 'C1', cores: 8 }], psus: [{ model: 'P' }] });
  assert.deepEqual(Object.keys(c.system).sort(), ['biosVersion', 'health', 'hostName', 'model', 'serviceTag']);
  for (const k of ['powerCap', 'licenses', 'network']) assert.ok(!(k in c), k);
  assert.ok(!('threads' in c.cpus[0]) && !('firmware' in c.psus[0]));
  // 중앙 정제는 객체가 아닌 BIOS 설정 · 모르는 키를 버린다
  const s = sanitizeRemoteInv({ bios: { version: '1', attributes: 'x' }, system: { model: 'R', evil: 'DROP' } });
  assert.deepEqual(s.bios, { version: '1' }); assert.ok(!('evil' in s.system));
});

test('내보내기 칸 — 엣지 서버도 채워진다 · B1 팬 상태는 팬 원소 판정(수집기가 health.fan 을 비워 둔다)', () => {
  const inv = sanitizeRemoteInv(JSON.parse(JSON.stringify(compactInv(fullInv()))));
  const c = { inv, corpName: 'WA', kind: 'bm', name: 'h1', serviceTag: '2JSRMK3' };
  const g = (k) => HW_FIELDS.get(k).get(c);
  assert.equal(g('id.sum.manufacturer'), 'Dell Inc.'); assert.equal(g('id.sum.powerState'), 'On');
  assert.equal(g('cpu.sum.threads'), 64); assert.equal(g('psu.sum.capW'), 700);
  assert.equal(g('bios.sum.bootMode'), 'Uefi'); assert.equal(g('mgmt.sum.model'), '14G Monolithic'); assert.equal(g('mgmt.sum.license'), 'iDRAC9 Enterprise');
  assert.equal(g('health.sum.fan'), 'Critical', '팬 하나가 Critical');
  assert.equal(g('health.sum.psu'), 'OK');
  const noFans = { inv: { health: { fan: 'Warning' } }, kind: 'bm' };
  assert.equal(HW_FIELDS.get('health.sum.fan').get(noFans), 'Warning', '팬 목록이 없으면 저장된 롤업 글자');
  const failed = { inv: { fans: [{ health: 'OK' }], collections: { fans: 'failed' }, health: {} }, kind: 'bm' };
  assert.equal(HW_FIELDS.get('health.sum.fan').get(failed), '', '못 읽은 컬렉션은 OK 로 만들지 않는다');
});

test('C1 — 사양서 기본 식별에 vCenter 는 한 줄', () => {
  const sp = specOf({ inv: fullInv(), corpName: 'WA', kind: 'bm', name: 'h1', hostName: 'h1', serviceTag: '2JSRMK3', vcenterName: 'vc-1' }, true);
  const id = sp.sections.find((x) => x.title === '기본 식별');
  assert.equal(id.rows.filter(([k]) => k === 'vCenter').length, 1);
  assert.deepEqual(id.rows.find(([k]) => k === 'vCenter'), ['vCenter', 'vc-1']);
});

test('C2 — 열 너비는 값 길이까지 넓힌다(한글 2칸 · 상한 60 · 비고 열 제외)', () => {
  assert.equal(dispLen('LESASBPAPWA01.wa.dvc.lgensol.com'), 32); assert.equal(dispLen('법인'), 4); assert.equal(dispLen(1472), 5);
  const cols = [{ key: 'name', label: '서버', kind: 'text' }, { key: 'note', label: '비고', kind: 'text' }];
  const w = fitWidths(cols, [{ cells: ['LESASBPAPWA01.wa.dvc.lgensol.com', 'x'.repeat(300)] }, { cells: ['y'.repeat(500), ''] }], () => 10);
  assert.equal(w[0], 60, '상한'); assert.equal(w[1], 10, '비고 열은 그대로');
  assert.equal(fitWidths(cols, [{ cells: ['LESASBPAPWA01.wa.dvc.lgensol.com', ''] }], () => 10)[0], 34);
});
