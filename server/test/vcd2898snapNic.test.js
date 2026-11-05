/**
 * v2.898 — vCenter 개체 보기 2차: 스냅샷 트리(soapParse.snapshotTreeNodes) · VM 네트워크 어댑터(vmcfg dev.nics) ·
 * 엣지 수신 정제(central sanitizeInventoryList → sanitizeSnapTree · sanitizeVmDev). 새 vCenter 호출 없이 이미 받던 XML 을 넓혀 읽는다.
 * 시간 비율 테스트는 docs/rules/common.md 규칙대로 8배 크기 · 기준 24배 · 번갈아 5회 최솟값.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotInfo, snapshotTreeNodes, sanitizeSnapTree, SNAP_TREE_MAX } from '../src/vcenter/soapParse.js';
import { parseVmDeviceHygiene, sanitizeVmDev } from '../src/vmcfg/parse.js';
import { sanitizeInventoryList } from '../src/routes/central.js';

// vim25 직렬화 모양(속성 배열은 원소마다 속성 이름 태그) — 루트 2개 · 가지 1개 · 현재 위치는 깊이 2.
const node = (ref, name, extra = '', kids = '') => `<snapshot type="VirtualMachineSnapshot">${ref}</snapshot><vm type="VirtualMachine">vm-1</vm>`
  + `<name>${name}</name>${extra}<id>1</id><createTime>2026-10-01T00:00:00Z</createTime><state>poweredOff</state><quiesced>false</quiesced>${kids}<replaySupported>false</replaySupported>`;
const REAL = '<currentSnapshot type="VirtualMachineSnapshot">snapshot-3</currentSnapshot>'
  + `<rootSnapshotList>${node('snapshot-1', 'a', '<description>패치 &amp; 점검</description>',
    `<childSnapshotList>${node('snapshot-2', 'b', '', `<childSnapshotList>${node('snapshot-3', 'c')}</childSnapshotList>`)}</childSnapshotList>`
    + `<childSnapshotList>${node('snapshot-4', 'b2')}</childSnapshotList>`)}</rootSnapshotList>`
  + `<rootSnapshotList>${node('snapshot-9', 'root2')}</rootSnapshotList>`;

test('스냅샷 트리 — 전위 순서 · 깊이 · 현재 위치 · 설명(엔티티 복원) · 자식 뒤 값으로 덮지 않는다', () => {
  const t = snapshotTreeNodes(REAL);
  assert.deepEqual(t.map((x) => [x.d, x.name, x.current]), [[0, 'a', false], [1, 'b', false], [2, 'c', true], [1, 'b2', false], [0, 'root2', false]]);
  assert.equal(t[0].desc, '패치 & 점검');
  assert.equal(t[0].ts, Date.parse('2026-10-01T00:00:00Z'));
  assert.equal(t[0].state, 'poweredOff');
  assert.equal(t[0].quiesced, false);
  assert.equal(t[1].desc, null, '빈 설명은 null');
  // 원소 묶음(<VirtualMachineSnapshotTree>)이 있어도 같은 깊이(기존 픽스처 모양 — reports.test.js)
  const wrapped = '<currentSnapshot type="VirtualMachineSnapshot">snapshot-100</currentSnapshot><rootSnapshotList><VirtualMachineSnapshotTree>'
    + '<snapshot type="VirtualMachineSnapshot">snapshot-99</snapshot><name>p</name><childSnapshotList><VirtualMachineSnapshotTree>'
    + '<snapshot type="VirtualMachineSnapshot">snapshot-100</snapshot><name>q</name></VirtualMachineSnapshotTree></childSnapshotList></VirtualMachineSnapshotTree></rootSnapshotList>';
  assert.deepEqual(snapshotTreeNodes(wrapped).map((x) => [x.d, x.name, x.current]), [[0, 'p', false], [1, 'q', true]]);
});

test('스냅샷 트리 — 못 읽은 값은 null(지어내지 않는다) · 없는 VM 은 키 자체가 없다(응답 모양 유지)', () => {
  const bad = '<rootSnapshotList><snapshot type="VirtualMachineSnapshot">snapshot-1</snapshot><name></name><createTime>nope</createTime><state>weird</state><quiesced>maybe</quiesced></rootSnapshotList>';
  assert.deepEqual(snapshotTreeNodes(bad), [{ d: 0, name: null, desc: null, ts: null, state: null, quiesced: null, current: false }]);
  assert.equal(Object.hasOwn(snapshotInfo('', ''), 'snapshotTree'), false);
  assert.equal(snapshotInfo(REAL, '').snapshotTree.length, 5);
  assert.deepEqual(snapshotTreeNodes(null), []);
});

test(`스냅샷 트리 — 상한 ${SNAP_TREE_MAX}개 · 이름 80자 · 설명 200자`, () => {
  let xml = '';
  for (let i = 0; i < SNAP_TREE_MAX + 10; i++) xml += `<rootSnapshotList>${node(`snapshot-${i}`, 'n'.repeat(300), `<description>${'d'.repeat(500)}</description>`)}</rootSnapshotList>`;
  const t = snapshotTreeNodes(xml);
  assert.equal(t.length, SNAP_TREE_MAX);
  assert.equal(t[0].name.length, 80);
  assert.equal(t[0].desc.length, 200);
});

function pairMinTimes(fnSmall, fnBig, rounds = 5) {
  let a = Infinity; let b = Infinity;
  for (let i = 0; i < rounds; i++) {
    let t = process.hrtime.bigint(); fnSmall(); a = Math.min(a, Number(process.hrtime.bigint() - t) / 1e6);
    t = process.hrtime.bigint(); fnBig(); b = Math.min(b, Number(process.hrtime.bigint() - t) / 1e6);
  }
  return { a: Math.max(a, 0.05), b };
}

test('스냅샷 트리 — 닫는 > 없는 열기 태그 반복 · 긴 텍스트에서 선형(8배 크기 · 기준 24배)', () => {
  const mk = (n) => '<rootSnapshotList '.repeat(n) + '<currentSnapshot '.repeat(n) + '<name>' + 'x'.repeat(n * 10);
  const s = mk(6_000); const b = mk(48_000);
  const { a, b: tb } = pairMinTimes(() => snapshotTreeNodes(s), () => snapshotTreeNodes(b));
  assert.ok(tb / a < 24, `비율 ${(tb / a).toFixed(1)} (작은 ${a.toFixed(2)}ms · 큰 ${tb.toFixed(2)}ms)`);
});

test('엣지 정제 — 아는 키만 · 형식 밖 값은 null · 배열이 아니면 null · 상한', () => {
  assert.equal(sanitizeSnapTree('x'), null);
  assert.equal(sanitizeSnapTree({}), null);
  const out = sanitizeSnapTree([{ d: 2, name: 'a', desc: { x: 1 }, ts: '123', state: '<b>', quiesced: 'true', current: 1, extra: 'drop' }, null, 'str', [1]]);
  assert.deepEqual(out, [{ d: 2, name: 'a', desc: null, ts: null, state: null, quiesced: null, current: false }]);
  assert.equal(sanitizeSnapTree(Array.from({ length: 200 }, () => ({ d: 0, name: 'x' }))).length, SNAP_TREE_MAX);
  assert.equal(sanitizeSnapTree([{ d: -1 }, { d: 1.5 }, { d: 999 }]).every((x) => x.d === 0), true);
});

const NIC = (type, backing, extra = '') => `<VirtualDevice xsi:type="${type}"><key>4000</key><deviceInfo><label>Network adapter 1</label><summary>s</summary></deviceInfo>${backing}`
  + `<connectable><startConnected>true</startConnected><allowGuestControl>true</allowGuestControl><connected>false</connected><status>ok</status></connectable>`
  + `<addressType>assigned</addressType><macAddress>00:50:56:AB:CD:EF</macAddress>${extra}</VirtualDevice>`;

test('VM 네트워크 어댑터 — 표준 · 분산 · NSX · 유형 이름 · MAC · 연결(장치 XML 하나 — 새 호출 없음)', () => {
  const xml = NIC('VirtualVmxnet3', '<backing xsi:type="VirtualEthernetCardNetworkBackingInfo"><deviceName>VM &amp; Net</deviceName><useAutoDetect>false</useAutoDetect><network type="Network">network-12</network></backing>')
    + NIC('VirtualE1000e', '<backing xsi:type="VirtualEthernetCardDistributedVirtualPortBackingInfo"><port><switchUuid>50 1a</switchUuid><portgroupKey>dvportgroup-34</portgroupKey><portKey>7</portKey></port></backing>')
    + NIC('VirtualVmxnet3', '<backing xsi:type="VirtualEthernetCardOpaqueNetworkBackingInfo"><opaqueNetworkId>seg-uuid-1</opaqueNetworkId><opaqueNetworkType>nsx.LogicalSwitch</opaqueNetworkType></backing>')
    + NIC('VirtualSomethingNew', '<backing xsi:type="X"></backing>');
  const d = parseVmDeviceHygiene(xml, 1);
  assert.equal(d.nics.length, 3, '이더넷 카드가 아닌 장치는 어댑터로 세지 않는다');
  assert.deepEqual(d.nics[0], { label: 'Network adapter 1', adapter: 'VMXNET 3', backing: 'std', net: 'VM & Net', netRef: 'network-12', mac: '00:50:56:ab:cd:ef', connected: false, startConnected: true });
  assert.deepEqual([d.nics[1].adapter, d.nics[1].backing, d.nics[1].net, d.nics[1].netRef], ['E1000E', 'dvs', null, 'dvportgroup-34']);
  assert.deepEqual([d.nics[2].backing, d.nics[2].net, d.nics[2].netRef], ['nsx', 'seg-uuid-1', null]);
  assert.deepEqual(parseVmDeviceHygiene('', 1).nics, [], '장치 목록을 읽었는데 어댑터가 없으면 빈 배열');
});

test('vm.dev 정제 — nics 키가 없으면(이전 판 엣지) 싣지 않는다 · 형식 밖은 null', () => {
  assert.equal(Object.hasOwn(sanitizeVmDev({ at: 1, disks: [] }), 'nics'), false);
  const v = sanitizeVmDev({ at: 1, nics: [{ label: 'n', adapter: { x: 1 }, backing: 'evil', net: 5, netRef: 'dvportgroup-1; rm', mac: 'zz', connected: 'yes', startConnected: true, extra: 1 }, 'x'] });
  assert.deepEqual(v.nics, [{ label: 'n', adapter: null, backing: 'other', net: null, netRef: null, mac: null, connected: null, startConnected: true }]);
});

test('중앙 수신 — snapshotTree · dev.nics 가 정제를 거친다(모르는 키 · 객체 값은 남지 않는다)', () => {
  const dropped = { notObject: 0, otherVcenter: 0, badId: 0, coerced: 0 };
  const [o] = sanitizeInventoryList([{ id: 'vc1:vm-1', name: 'v', snapshotTree: [{ d: 0, name: { evil: 1 }, x: 1 }], dev: { at: 1, nics: [{ label: 'a', backing: 'dvs', netRef: 'dvportgroup-9' }] } }], 'vc1', 10, dropped);
  assert.deepEqual(o.snapshotTree, [{ d: 0, name: null, desc: null, ts: null, state: null, quiesced: null, current: false }]);
  assert.equal(o.dev.nics[0].netRef, 'dvportgroup-9');
  const [p] = sanitizeInventoryList([{ id: 'vc1:vm-2', snapshotTree: 'oops' }], 'vc1', 10, dropped);
  assert.equal(p.snapshotTree, null);
  assert.ok(dropped.coerced >= 1);
});
