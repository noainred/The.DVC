// v3.0.1 — VM 사양 변경의 NIC 연결 해제가 'SOAP 500: Required property allowGuestControl is missing from data object of type
//   VirtualDeviceConnectInfo' 로 늘 실패했다(사용자 실측 2026-11-13). 원인: connectable 원소 순서가 vim25 스키마 순서
//   (startConnected · allowGuestControl · connected)가 아니었다 — vCenter 의 SOAP 역직렬화는 순서를 지킨다. NIC 추가도 같은 순서였다.
//   이 파일이 고정하는 것: ① 세 생산자(사양 변경 토글 · 사양 변경 NIC 추가 · VM 복제 NIC 끊기)가 스키마 순서로 만든다
//   ② 토글은 읽은 장치를 그대로 되돌려 보내고 connectable 만 바꾼다(MAC · backing 포트 · slotInfo 보존) ③ allowGuestControl 은 읽은 값을 지킨다
//   ④ 장치 본문은 GET 응답(JSON)에 실리지 않는다 ⑤ connectInfo.js 밖에서 connectable 을 조립하지 않는다(소스 스윕).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHardware, buildReconfigSpec } from '../src/provision/reconfig.js';
import { nicDisconnectSpec } from '../src/vmclone/vsphere.js';
import { connectInfoXml, withConnectable, readConnectFlag, deviceInnerOf } from '../src/vcenter/connectInfo.js';
import { stripComments } from './_stripComments.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');

// vim25 RetrieveProperties 가 돌려주는 모양의 DVS NIC(읽은 그대로 — connectable 에 migrateConnect · status 포함).
const nicXml = ({ key = 4000, guest = 'true', connected = 'true' } = {}) =>
  `<VirtualDevice xsi:type="VirtualVmxnet3"><key>${key}</key>` +
  `<deviceInfo><label>Network adapter 1</label><summary>DVSwitch: 50 2a aa bb</summary></deviceInfo>` +
  `<backing xsi:type="VirtualEthernetCardDistributedVirtualPortBackingInfo"><port><switchUuid>50 2a aa bb</switchUuid>` +
  `<portgroupKey>dvportgroup-9</portgroupKey><portKey>123</portKey><connectionCookie>987654</connectionCookie></port></backing>` +
  `<connectable><migrateConnect>unset</migrateConnect><startConnected>${connected}</startConnected><allowGuestControl>${guest}</allowGuestControl>` +
  `<connected>${connected}</connected><status>ok</status></connectable>` +
  `<slotInfo xsi:type="VirtualDevicePciBusSlotInfo"><pciSlotNumber>192</pciSlotNumber></slotInfo>` +
  `<controllerKey>100</controllerKey><unitNumber>7</unitNumber><addressType>assigned</addressType>` +
  `<macAddress>00:50:56:01:02:03</macAddress><wakeOnLanEnabled>true</wakeOnLanEnabled>` +
  `<resourceAllocation><reservation>0</reservation><share><shares>50</shares><level>normal</level></share><limit>-1</limit></resourceAllocation>` +
  `<uptCompatibilityEnabled>true</uptCompatibilityEnabled></VirtualDevice>`;

const SCSI = '<VirtualDevice xsi:type="ParaVirtualSCSIController"><key>1000</key><deviceInfo><label>SCSI controller 0</label></deviceInfo><busNumber>0</busNumber></VirtualDevice>';
const META_ON = { numCPU: 8, memoryMB: 16384, cpuHotAdd: 'false', memHotAdd: 'false', powerState: 'poweredOn' };

// spec 안 모든 connectable 의 자식 원소 이름 순서.
const connOrders = (xml) => [...String(xml).matchAll(/<connectable>([\s\S]*?)<\/connectable>/g)]
  .map((m) => [...m[1].matchAll(/<(\w+)>/g)].map((t) => t[1]));
const SCHEMA = ['startConnected', 'allowGuestControl', 'connected'];

test('① connectInfoXml — 스키마 순서 · 세 칸 모두 · 불리언 문자열', () => {
  const x = connectInfoXml({ startConnected: false, allowGuestControl: true, connected: false });
  assert.equal(x, '<connectable><startConnected>false</startConnected><allowGuestControl>true</allowGuestControl><connected>false</connected></connectable>');
  assert.deepEqual(connOrders(connectInfoXml({})), [SCHEMA]);   // 값이 없어도 칸은 빠지지 않는다(필수)
});

test('① 사양 변경 NIC 연결 해제 — 사용자 실패 사례(전원 ON · DVS · hot-add 꺼짐)가 스키마 순서로 나간다', () => {
  const hw = parseHardware(SCSI + nicXml(), META_ON);
  // 화면(VmReconfig.jsx buildPlan)은 바뀐 칸만 보낸다 — 사용자 사례의 본문은 nicConnects 하나.
  const r = buildReconfigSpec(hw, { nicConnects: [{ key: 4000, connected: false }] });
  assert.equal(r.ok, true, r.errors.join());
  assert.deepEqual(r.changes, ['NIC 연결 해제 ((DVS:dvportgroup-9))']);
  assert.deepEqual(connOrders(r.specXml), [SCHEMA]);
  assert.match(r.specXml, /<connectable><startConnected>false<\/startConnected><allowGuestControl>true<\/allowGuestControl><connected>false<\/connected><\/connectable>/);
});

test('② 연결 토글은 읽은 장치를 그대로 되돌려 보낸다 — connectable 만 바뀐다', () => {
  const hw = parseHardware(nicXml(), META_ON);
  const { specXml } = buildReconfigSpec(hw, { nicConnects: [{ key: 4000, connected: false }] });
  const dev = /<device xsi:type="VirtualVmxnet3">([\s\S]*)<\/device>/.exec(specXml)[1];
  const conn = connectInfoXml({ startConnected: false, allowGuestControl: true, connected: false });
  // 읽은 본문에서 connectable 한 덩어리만 바뀐 것과 같아야 한다(MAC · addressType · 포트 · cookie · slotInfo · 자원 할당 보존).
  assert.equal(dev, deviceInnerOf(nicXml()).replace(/<connectable>[\s\S]*?<\/connectable>/, conn));
  for (const keep of ['<macAddress>00:50:56:01:02:03</macAddress>', '<addressType>assigned</addressType>', '<portKey>123</portKey>',
    '<connectionCookie>987654</connectionCookie>', '<pciSlotNumber>192</pciSlotNumber>', '<controllerKey>100</controllerKey>']) {
    assert.ok(dev.includes(keep), `보존: ${keep}`);
  }
  // VirtualDevice sequence: key · deviceInfo · backing · connectable · slotInfo …
  assert.ok(dev.indexOf('</backing>') < dev.indexOf('<connectable>') && dev.indexOf('</connectable>') < dev.indexOf('<slotInfo'));
  assert.equal((specXml.match(/<connectable>/g) || []).length, 1);
  assert.doesNotMatch(specXml, /<status>|<migrateConnect>/);   // 읽기 전용 상태 · 선택 칸은 새 connectable 에 싣지 않는다
});

test('③ allowGuestControl 은 읽은 값을 지킨다(이 화면은 그 칸을 바꾸지 않는다)', () => {
  const hw = parseHardware(nicXml({ guest: 'false', connected: 'false' }), META_ON);
  assert.equal(hw.nics[0].allowGuestControl, false);
  const { ok, specXml } = buildReconfigSpec(hw, { nicConnects: [{ key: 4000, connected: true }] });
  assert.equal(ok, true);
  assert.match(specXml, /<connectable><startConnected>true<\/startConnected><allowGuestControl>false<\/allowGuestControl><connected>true<\/connected><\/connectable>/);
  // 못 읽은 장치(칸 없음)는 null — 그때만 새 NIC 기본값 true.
  const bare = parseHardware('<VirtualDevice xsi:type="VirtualVmxnet3"><key>4001</key><connectable><connected>true</connected></connectable></VirtualDevice>', META_ON);
  assert.equal(bare.nics[0].allowGuestControl, null);
  assert.match(buildReconfigSpec(bare, { nicConnects: [{ key: 4001, connected: false }] }).specXml, /<allowGuestControl>true<\/allowGuestControl>/);
});

test('④ 장치 본문은 GET /vm/:id/hardware 응답(JSON)에 실리지 않는다', () => {
  const hw = parseHardware(nicXml(), META_ON);
  assert.ok(hw.nics[0].deviceInner.includes('<macAddress>'));
  const json = JSON.stringify(hw);
  assert.doesNotMatch(json, /deviceInner|pciSlotNumber/);
  assert.match(json, /"allowGuestControl":true/);
});

test('① 사양 변경 NIC 추가 — 스키마 순서 · 전원 상태에 따라 connected', () => {
  const on = buildReconfigSpec(parseHardware(nicXml(), META_ON), { nicAdds: [{ dvs: { switchUuid: 'aa-bb', portgroupKey: 'dvportgroup-9' } }] });
  assert.deepEqual(connOrders(on.specXml), [SCHEMA]);
  assert.match(on.specXml, /<startConnected>true<\/startConnected><allowGuestControl>true<\/allowGuestControl><connected>true<\/connected>/);
  const off = buildReconfigSpec(parseHardware(nicXml(), { ...META_ON, powerState: 'poweredOff' }), { nicAdds: [{ network: 'VM Network' }] });
  assert.match(off.specXml, /<startConnected>true<\/startConnected><allowGuestControl>true<\/allowGuestControl><connected>false<\/connected>/);
});

test('① VM 복제 NIC 끊기도 같은 헬퍼 — 순서 · 게스트 제어 값 유지(못 읽으면 false)', () => {
  const { specXml, count } = nicDisconnectSpec(nicXml({ key: 4000, guest: 'true' }) + nicXml({ key: 4001, guest: 'false' }));
  assert.equal(count, 2);
  assert.deepEqual(connOrders(specXml), [SCHEMA, SCHEMA]);
  assert.deepEqual([...specXml.matchAll(/<allowGuestControl>(\w+)</g)].map((m) => m[1]), ['true', 'false']);
});

test('withConnectable — connectable 이 없는 장치는 그 뒤 원소 가장 앞에 넣는다(끝에 덧붙여 macAddress 뒤로 가지 않게)', () => {
  const conn = connectInfoXml({ startConnected: false, allowGuestControl: false, connected: false });
  assert.equal(withConnectable('<key>1</key><backing/><addressType>assigned</addressType><macAddress>m</macAddress>', conn),
    `<key>1</key><backing/>${conn}<addressType>assigned</addressType><macAddress>m</macAddress>`);
  assert.equal(withConnectable('<key>1</key><slotInfo><pciSlotNumber>1</pciSlotNumber></slotInfo><controllerKey>100</controllerKey>', conn),
    `<key>1</key>${conn}<slotInfo><pciSlotNumber>1</pciSlotNumber></slotInfo><controllerKey>100</controllerKey>`);
  assert.equal(withConnectable('<key>1</key>', conn), `<key>1</key>${conn}`);
  // 본문의 '$&' 같은 치환 패턴 글자는 그대로 남는다.
  assert.equal(withConnectable('<key>1</key><deviceInfo><label>a$&b</label></deviceInfo><connectable><connected>true</connected></connectable>', conn),
    `<key>1</key><deviceInfo><label>a$&b</label></deviceInfo>${conn}`);
});

test('readConnectFlag — 못 읽으면 null(false 로 단정하지 않는다)', () => {
  const inner = deviceInnerOf(nicXml({ guest: 'false' }));
  assert.equal(readConnectFlag(inner, 'allowGuestControl'), false);
  assert.equal(readConnectFlag(inner, 'connected'), true);
  assert.equal(readConnectFlag('<key>1</key>', 'connected'), null);
  assert.equal(readConnectFlag('<connectable><connected>maybe</connected></connectable>', 'connected'), null);
});

test('⑤ 소스 스윕 — connectInfo.js 밖에서 connectable 을 조립하지 않는다', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(m?js)$/.test(e.name) || p.endsWith(path.join('vcenter', 'connectInfo.js'))) continue;
      const code = stripComments(fs.readFileSync(p, 'utf8'));
      // 조립 = 여는 태그 바로 뒤에 자식 원소를 붙여 쓴 문자열. 읽기용 정규식(`<connectable>[\s\S]*?`·`<connectable>(`)은 해당하지 않는다.
      if (/<connectable><(?:startConnected|allowGuestControl|connected|migrateConnect|\$\{)/.test(code)) offenders.push(path.relative(SRC, p));
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, []);
});
