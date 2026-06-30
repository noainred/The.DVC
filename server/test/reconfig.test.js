import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHardware, buildReconfigSpec } from '../src/provision/reconfig.js';

// vim25 config.hardware.device 의 축약 샘플(디스크 50GB + SCSI + NIC).
const DEVICE_XML =
  '<VirtualDevice xsi:type="ParaVirtualSCSIController"><key>1000</key><deviceInfo><label>SCSI controller 0</label></deviceInfo><busNumber>0</busNumber></VirtualDevice>' +
  '<VirtualDevice xsi:type="VirtualDisk"><key>2000</key><deviceInfo><label>하드 디스크 1</label></deviceInfo>' +
  '<backing xsi:type="VirtualDiskFlatVer2BackingInfo"><fileName>[ds1] vm/vm.vmdk</fileName><diskMode>persistent</diskMode><thinProvisioned>true</thinProvisioned></backing>' +
  '<controllerKey>1000</controllerKey><unitNumber>0</unitNumber><capacityInKB>52428800</capacityInKB></VirtualDevice>' +
  '<VirtualDevice xsi:type="VirtualVmxnet3"><key>4000</key><deviceInfo><label>네트워크 어댑터 1</label></deviceInfo>' +
  '<backing xsi:type="VirtualEthernetCardNetworkBackingInfo"><deviceName>VM Network</deviceName></backing>' +
  '<macAddress>00:50:56:01:02:03</macAddress><connectable><connected>true</connected></connectable></VirtualDevice>';

const META = { numCPU: 4, memoryMB: 8192, cpuHotAdd: 'true', memHotAdd: 'true', powerState: 'poweredOn' };

test('parseHardware: 디스크/SCSI/NIC 파싱', () => {
  const hw = parseHardware(DEVICE_XML, META);
  assert.equal(hw.cpu, 4);
  assert.equal(hw.memMB, 8192);
  assert.equal(hw.cpuHotAdd, true);
  assert.equal(hw.disks.length, 1);
  assert.equal(hw.disks[0].key, 2000);
  assert.equal(hw.disks[0].capacityGB, 50);
  assert.equal(hw.disks[0].controllerKey, 1000);
  assert.equal(hw.disks[0].fileName, '[ds1] vm/vm.vmdk');
  assert.equal(hw.scsi.length, 1);
  assert.equal(hw.scsi[0].key, 1000);
  assert.equal(hw.nics.length, 1);
  assert.equal(hw.nics[0].key, 4000);
  assert.equal(hw.nics[0].network, 'VM Network');
  assert.equal(hw.nics[0].macAddress, '00:50:56:01:02:03');
});

test('buildReconfigSpec: CPU/RAM 증설(hot-add on) → spec 생성', () => {
  const hw = parseHardware(DEVICE_XML, META);
  const r = buildReconfigSpec(hw, { numCPUs: 8, memoryMB: 16384 });
  assert.equal(r.ok, true);
  assert.match(r.specXml, /<numCPUs>8<\/numCPUs>/);
  assert.match(r.specXml, /<memoryMB>16384<\/memoryMB>/);
  assert.equal(r.changes.length, 2);
});

test('buildReconfigSpec: CPU/RAM 감소는 차단(증설만)', () => {
  const hw = parseHardware(DEVICE_XML, META);
  const r = buildReconfigSpec(hw, { numCPUs: 2 });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /감소는 허용되지 않습니다/);
});

test('buildReconfigSpec: 전원 ON + hot-add 꺼짐 → 증설 거부', () => {
  const hw = parseHardware(DEVICE_XML, { ...META, cpuHotAdd: 'false', memHotAdd: 'false' });
  const r = buildReconfigSpec(hw, { numCPUs: 8 });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /hot-add가 비활성화/);
});

test('buildReconfigSpec: 디스크 증설 OK, 축소 차단', () => {
  const hw = parseHardware(DEVICE_XML, META);
  const ok = buildReconfigSpec(hw, { diskGrows: [{ key: 2000, newGB: 100 }] });
  assert.equal(ok.ok, true);
  assert.match(ok.specXml, /<operation>edit<\/operation>/);
  assert.match(ok.specXml, /<capacityInKB>104857600<\/capacityInKB>/); // 100GB
  const bad = buildReconfigSpec(hw, { diskGrows: [{ key: 2000, newGB: 30 }] });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(), /증설만 가능/);
});

test('buildReconfigSpec: 디스크 추가(다음 유닛, thin)', () => {
  const hw = parseHardware(DEVICE_XML, META);
  const r = buildReconfigSpec(hw, { diskAdds: [{ sizeGB: 200 }] });
  assert.equal(r.ok, true);
  assert.match(r.specXml, /<operation>add<\/operation><fileOperation>create<\/fileOperation>/);
  assert.match(r.specXml, /<unitNumber>1<\/unitNumber>/);   // 0은 사용중 → 1
  assert.match(r.specXml, /\[ds1\]/);                        // 기존 데이터스토어 재사용
});

test('buildReconfigSpec: NIC 추가(표준/ DVS) + 삭제', () => {
  const hw = parseHardware(DEVICE_XML, META);
  const std = buildReconfigSpec(hw, { nicAdds: [{ network: 'DMZ' }] });
  assert.equal(std.ok, true);
  assert.match(std.specXml, /VirtualEthernetCardNetworkBackingInfo/);
  assert.match(std.specXml, /<deviceName>DMZ<\/deviceName>/);

  const dvs = buildReconfigSpec(hw, { nicAdds: [{ dvs: { switchUuid: 'aa-bb', portgroupKey: 'dvportgroup-9' } }] });
  assert.match(dvs.specXml, /DistributedVirtualPortBackingInfo/);
  assert.match(dvs.specXml, /<portgroupKey>dvportgroup-9<\/portgroupKey>/);

  const rm = buildReconfigSpec(hw, { nicRemoves: [4000] });
  assert.equal(rm.ok, true);
  assert.match(rm.specXml, /<operation>remove<\/operation><device xsi:type="VirtualVmxnet3"><key>4000<\/key>/);
});

test('buildReconfigSpec: 코어/소켓 — 약수면 적용, 아니면 거부', () => {
  const hw = parseHardware(DEVICE_XML, META); // cpu=4
  const ok = buildReconfigSpec(hw, { numCPUs: 8, coresPerSocket: 4 });
  assert.equal(ok.ok, true);
  assert.match(ok.specXml, /<numCoresPerSocket>4<\/numCoresPerSocket>/);
  const bad = buildReconfigSpec(hw, { numCPUs: 8, coresPerSocket: 3 });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(), /약수여야/);
  // vCPU 변경 없이 코어/소켓만
  const only = buildReconfigSpec(hw, { coresPerSocket: 2 });
  assert.equal(only.ok, true);
  assert.match(only.specXml, /<numCoresPerSocket>2<\/numCoresPerSocket>/);
});

test('buildReconfigSpec: 디스크 추가 데이터스토어 선택', () => {
  const hw = parseHardware(DEVICE_XML, META);
  // 데이터스토어 명시 → 그 데이터스토어 bracket으로 생성(기존 [ds1] 무시).
  const sel = buildReconfigSpec(hw, { diskAdds: [{ sizeGB: 50, datastore: 'ds-fast' }] });
  assert.equal(sel.ok, true);
  assert.match(sel.specXml, /<fileName>\[ds-fast\]<\/fileName>/);
  assert.match(sel.changes.join(), /ds-fast/);
  // 대괄호를 직접 넣어도 정규화.
  const br = buildReconfigSpec(hw, { diskAdds: [{ sizeGB: 50, datastore: '[ds-fast]' }] });
  assert.match(br.specXml, /<fileName>\[ds-fast\]<\/fileName>/);
  // 미지정 → 기존 디스크 위치([ds1]) 재사용.
  const auto = buildReconfigSpec(hw, { diskAdds: [{ sizeGB: 50 }] });
  assert.match(auto.specXml, /<fileName>\[ds1\]<\/fileName>/);
});

test('buildReconfigSpec: 디스크 추가 컨트롤러 선택', () => {
  const hw = parseHardware(DEVICE_XML, META);
  const ok = buildReconfigSpec(hw, { diskAdds: [{ sizeGB: 50, controllerKey: 1000 }] });
  assert.equal(ok.ok, true);
  assert.match(ok.specXml, /<controllerKey>1000<\/controllerKey>/);
  const bad = buildReconfigSpec(hw, { diskAdds: [{ sizeGB: 50, controllerKey: 9999 }] });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(), /지정한 디스크 컨트롤러/);
});

test('buildReconfigSpec: NIC 연결 토글', () => {
  const hw = parseHardware(DEVICE_XML, META); // nic 4000 connected:true
  const off = buildReconfigSpec(hw, { nicConnects: [{ key: 4000, connected: false }] });
  assert.equal(off.ok, true);
  assert.match(off.specXml, /<operation>edit<\/operation>/);
  assert.match(off.specXml, /<connected>false<\/connected>/);
  // 이미 연결 상태 → 변화 없음
  const noop = buildReconfigSpec(hw, { nicConnects: [{ key: 4000, connected: true }] });
  assert.equal(noop.ok, false);
});

test('buildReconfigSpec: 변경 없음 → ok=false', () => {
  const hw = parseHardware(DEVICE_XML, META);
  const r = buildReconfigSpec(hw, { numCPUs: 4, memoryMB: 8192 });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /변경 사항이 없습니다/);
});
