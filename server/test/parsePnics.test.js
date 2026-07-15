import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePnics } from '../src/vcenter/soapClient.js';

// vCenter config.network.pnic + hardware.pciDevice 매칭 — 특수기능 'NIC 속도/모델 확인'의
// vCenter 별도 컬럼 데이터 소스. pnic 자체엔 모델명이 없어 PCI 주소로 pciDevice와 매칭한다.

const PNIC_XML = `
<PhysicalNic xsi:type="PhysicalNic">
  <key>key-vim.host.PhysicalNic-vmnic0</key>
  <device>vmnic0</device>
  <pci>0000:19:00.0</pci>
  <driver>ixgben</driver>
  <linkSpeed><speedMb>10000</speedMb><duplex>true</duplex></linkSpeed>
  <validLinkSpecification><speedMb>1000</speedMb><duplex>true</duplex></validLinkSpecification>
  <validLinkSpecification><speedMb>10000</speedMb><duplex>true</duplex></validLinkSpecification>
  <mac>aa:bb:cc:dd:ee:00</mac>
</PhysicalNic>
<PhysicalNic xsi:type="PhysicalNic">
  <key>key-vim.host.PhysicalNic-vmnic1</key>
  <device>vmnic1</device>
  <pci>0000:19:00.1</pci>
  <driver>ixgben</driver>
  <validLinkSpecification><speedMb>10000</speedMb><duplex>true</duplex></validLinkSpecification>
  <mac>aa:bb:cc:dd:ee:01</mac>
</PhysicalNic>`;

const PCI_XML = `
<HostPciDevice>
  <id>0000:19:00.0</id>
  <classId>512</classId>
  <vendorName>Intel Corporation</vendorName>
  <deviceName>Ethernet Controller X710 for 10GbE SFP+</deviceName>
</HostPciDevice>
<HostPciDevice>
  <id>0000:19:00.1</id>
  <classId>512</classId>
  <vendorName>Intel Corporation</vendorName>
  <deviceName>Ethernet Controller X710 for 10GbE SFP+</deviceName>
</HostPciDevice>`;

test('parsePnics: 링크 살아있는 포트 — 현재속도·모델명(pciDevice 매칭) 파싱', () => {
  const nics = parsePnics(PNIC_XML, PCI_XML);
  assert.equal(nics.length, 2);
  const up = nics[0];
  assert.equal(up.device, 'vmnic0');
  assert.equal(up.driver, 'ixgben');
  assert.equal(up.speedMb, 10000);
  assert.equal(up.maxSpeedMb, 10000);
  assert.equal(up.link, true);
  assert.equal(up.model, 'Ethernet Controller X710 for 10GbE SFP+');
  assert.equal(up.vendor, 'Intel Corporation');
});

test('parsePnics: 다운 포트도 validLinkSpecification 정격으로 10G 식별(현재속도 0)', () => {
  const nics = parsePnics(PNIC_XML, PCI_XML);
  const down = nics[1];
  assert.equal(down.device, 'vmnic1');
  assert.equal(down.speedMb, 0);
  assert.equal(down.link, false);
  assert.equal(down.maxSpeedMb, 10000); // 지원속도 최대값으로 정격 판별
});

test('parsePnics: pciDevice 미매칭이면 모델 공란(드라이버는 유지)', () => {
  const nics = parsePnics(PNIC_XML, '');
  assert.equal(nics.length, 2);
  assert.equal(nics[0].model, '');
  assert.equal(nics[0].driver, 'ixgben');
});

test('parsePnics: 입력 없으면 빈 배열', () => {
  assert.deepEqual(parsePnics('', PCI_XML), []);
  assert.deepEqual(parsePnics(null, null), []);
});
