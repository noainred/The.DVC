import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVmDevices, parseGuestDisks } from '../src/vcenter/soapParse.js';
import { csvLine, CSV_BOM } from '../src/util/csv.js';

// vSphere RetrieveProperties 의 ArrayOfVirtualDevice 직렬화 형태를 본뜬 샘플.
const DEVICE_XML = `
<VirtualDevice xsi:type="VirtualIDEController"><key>200</key><deviceInfo><label>IDE 0</label></deviceInfo></VirtualDevice>
<VirtualDevice xsi:type="VirtualVmxnet3">
  <key>4000</key>
  <deviceInfo><label>Network adapter 1</label><summary>DVSwitch: 50 1c ab</summary></deviceInfo>
  <backing xsi:type="VirtualEthernetCardDistributedVirtualPortBackingInfo"><port><portgroupKey>dvportgroup-11</portgroupKey></port></backing>
  <connectable><connected>true</connected></connectable>
  <macAddress>00:50:56:aa:bb:01</macAddress>
</VirtualDevice>
<VirtualDevice xsi:type="VirtualE1000e">
  <key>4001</key>
  <deviceInfo><label>Network adapter 2</label><summary>VM Network</summary></deviceInfo>
  <backing xsi:type="VirtualEthernetCardNetworkBackingInfo"><deviceName>VM Network</deviceName></backing>
  <connectable><connected>false</connected></connectable>
  <macAddress>00:50:56:aa:bb:02</macAddress>
</VirtualDevice>
<VirtualDevice xsi:type="VirtualDisk">
  <key>2000</key>
  <deviceInfo><label>Hard disk 1</label></deviceInfo>
  <backing xsi:type="VirtualDiskFlatVer2BackingInfo">
    <fileName>[DS-GOLD-01] vm1/vm1.vmdk</fileName>
    <diskMode>persistent</diskMode>
    <thinProvisioned>true</thinProvisioned>
  </backing>
  <capacityInKB>104857600</capacityInKB>
</VirtualDevice>
<VirtualDevice xsi:type="VirtualDisk">
  <key>2001</key>
  <deviceInfo><label>Hard disk 2</label></deviceInfo>
  <backing xsi:type="VirtualDiskRawDiskMappingVer1BackingInfo">
    <fileName>[DS-RDM] vm1/vm1_1.vmdk</fileName>
    <diskMode>independent_persistent</diskMode>
  </backing>
  <capacityInKB>524288000</capacityInKB>
</VirtualDevice>`;

test('parseVmDevices: NIC 2종(연결/끊김·DVS/표준)·디스크 2종(thin/RDM)·데이터스토어 파싱', () => {
  const { nics, disks } = parseVmDevices(DEVICE_XML);
  assert.equal(nics.length, 2);
  assert.deepEqual(nics[0], { label: 'Network adapter 1', type: 'Vmxnet3', mac: '00:50:56:aa:bb:01', network: 'DVSwitch: 50 1c ab', connected: true });
  assert.equal(nics[1].type, 'E1000e');
  assert.equal(nics[1].network, 'VM Network'); // 표준 백킹은 deviceName 우선
  assert.equal(nics[1].connected, false);
  assert.equal(disks.length, 2);
  assert.deepEqual(disks[0], { label: 'Hard disk 1', capacityGB: 100, thin: true, rdm: false, mode: 'persistent', datastore: 'DS-GOLD-01', fileName: '[DS-GOLD-01] vm1/vm1.vmdk' });
  assert.equal(disks[1].rdm, true);
  assert.equal(disks[1].capacityGB, 500);
  assert.equal(disks[1].datastore, 'DS-RDM');
  // IDE 컨트롤러 같은 비 NIC/디스크 장치는 무시.
});

test('parseVmDevices: 빈/없음 안전', () => {
  assert.deepEqual(parseVmDevices(''), { nics: [], disks: [] });
  assert.deepEqual(parseVmDevices(undefined), { nics: [], disks: [] });
});

test('parseGuestDisks: 게스트 파티션 용량/사용량(GB) 계산', () => {
  const xml = `
<GuestDiskInfo><diskPath>/</diskPath><capacity>53687091200</capacity><freeSpace>21474836480</freeSpace></GuestDiskInfo>
<GuestDiskInfo><diskPath>C:\\</diskPath><capacity>107374182400</capacity><freeSpace>53687091200</freeSpace></GuestDiskInfo>`;
  const parts = parseGuestDisks(xml);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0], { path: '/', capacityGB: 50, freeGB: 20, usedGB: 30 });
  assert.equal(parts[1].path, 'C:\\');
  assert.equal(parts[1].capacityGB, 100);
  assert.deepEqual(parseGuestDisks(''), []);
});

test('vmExportCsv 규칙: 수식 인젝션 가드 + 쉼표/따옴표 quoting + BOM', () => {
  // csvLine 은 export 가 쓰는 그 함수 — 위험 셀(=로 시작)과 쉼표 포함 셀을 확인.
  const line = csvLine(['=cmd|evil', 'a,b', 'plain', 'say "hi"']);
  assert.equal(line, `'=cmd|evil,"a,b",plain,"say ""hi"""`); // 수식 가드는 ' 접두(쉼표 없으면 quoting 불필요)
  assert.equal(CSV_BOM.charCodeAt(0), 0xFEFF); // 엑셀 한글 호환 BOM
});
