// v2.697(B10) — VM 구성 속성 수집·판정·엣지 정제.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseVmCfgProps, parseVmDeviceHygiene, vmCfgFindings, sanitizeVmCfg, sanitizeVmDev, VM_CFG_PATHS, VM_CFG_CODES, shortName } from '../src/vmcfg/parse.js';
import { refreshVmCfg } from '../src/vmcfg/collect.js';
import { get, _resetVmCfgCache, pickDue, put } from '../src/vmcfg/cache.js';
import { sanitizeInventoryList } from '../src/routes/central.js';

const NOW = 1_800_000_000_000;

test('① parseVmCfgProps — 불리언·수치·무제한·관리 솔루션·질문·부팅 시각, 못 읽은 값은 null', () => {
  const c = parseVmCfgProps({
    'runtime.consolidationNeeded': 'true', 'config.changeTrackingEnabled': 'false',
    'config.cpuHotAddEnabled': 'true', 'config.cpuAllocation.reservation': '0', 'config.cpuAllocation.limit': '-1',
    'config.memoryAllocation.reservation': '2048', 'config.memoryAllocation.limit': '4096',
    'config.firmware': 'efi', 'config.guestId': 'rhel7_64Guest', 'guest.guestId': 'rhel8_64Guest',
    'guest.hostName': 'web01.corp.local', 'runtime.bootTime': '2026-10-01T00:00:00Z',
    'config.managedBy': '<extensionKey>com.vmware.vcHms</extensionKey><type>replica</type>',
    'runtime.question': '<id>1</id><text>msg.uuid.altered &amp; moved?</text>',
  }, NOW);
  assert.equal(c.consolidationNeeded, true);
  assert.equal(c.cbt, false);
  assert.equal(c.memHotAdd, null, '응답에 없는 불리언은 false 가 아니라 null');
  assert.equal(c.cpuReservationMhz, 0);
  assert.equal(c.cpuLimitMhz, -1);
  assert.equal(c.memLimitMB, 4096);
  assert.deepEqual(c.managedBy, { extensionKey: 'com.vmware.vcHms', type: 'replica' });
  assert.equal(c.question.text, 'msg.uuid.altered & moved?');
  assert.equal(c.bootTime, Date.parse('2026-10-01T00:00:00Z'));
  const empty = parseVmCfgProps({}, NOW);
  assert.equal(empty.managedBy, null); assert.equal(empty.question, null); assert.equal(empty.cpuLimitMhz, null);
  assert.equal(parseVmCfgProps({ 'config.cpuAllocation.limit': '' }).cpuLimitMhz, null, "Number('')===0 함정 — 빈 값은 0 이 아니다");
});

test('② parseVmDeviceHygiene — CD-ROM(ISO 연결)·플로피·독립/multi-writer/물리 RDM 디스크', () => {
  const xml = [
    '<VirtualDevice xsi:type="VirtualCdrom"><key>3000</key><deviceInfo><label>CD/DVD drive 1</label></deviceInfo>',
    '<backing xsi:type="VirtualCdromIsoBackingInfo"><fileName>[iso] rhel.iso</fileName></backing>',
    '<connectable><startConnected>true</startConnected><connected>true</connected></connectable></VirtualDevice>',
    '<VirtualDevice xsi:type="VirtualFloppy"><deviceInfo><label>Floppy 1</label></deviceInfo><connectable><connected>false</connected></connectable></VirtualDevice>',
    '<VirtualDevice xsi:type="VirtualDisk"><deviceInfo><label>Hard disk 1</label></deviceInfo>',
    '<backing xsi:type="VirtualDiskFlatVer2BackingInfo"><fileName>[ds1] vm/vm.vmdk</fileName><diskMode>independent_persistent</diskMode><sharing>sharingMultiWriter</sharing></backing><capacityInKB>10485760</capacityInKB></VirtualDevice>',
    '<VirtualDevice xsi:type="VirtualDisk"><deviceInfo><label>Hard disk 2</label></deviceInfo>',
    '<backing xsi:type="VirtualDiskRawDiskMappingVer1BackingInfo"><fileName>[ds1] vm/rdm.vmdk</fileName><compatibilityMode>physicalMode</compatibilityMode><diskMode>independent_persistent</diskMode></backing></VirtualDevice>',
    '<VirtualDevice xsi:type="VirtualUSBController"><deviceInfo><label>USB</label></deviceInfo></VirtualDevice>',
  ].join('');
  const d = parseVmDeviceHygiene(xml, NOW);
  assert.equal(d.cdroms.length, 1);
  assert.deepEqual({ c: d.cdroms[0].connected, iso: d.cdroms[0].iso, f: d.cdroms[0].file }, { c: true, iso: true, f: '[iso] rhel.iso' });
  assert.equal(d.floppies.length, 1);
  assert.equal(d.disks.length, 2);
  assert.equal(d.disks[0].sharing, 'sharingMultiWriter');
  assert.equal(d.disks[0].capacityGB, 10);
  assert.equal(d.disks[1].rdmMode, 'physicalMode');
  assert.equal(d.usb, 0, 'USB 컨트롤러는 장치가 아니다');
  const f = vmCfgFindings({ name: 'vm1', dev: d }).map((x) => x.code);
  for (const code of ['cdrom-connected', 'floppy', 'disk-independent', 'multi-writer', 'rdm-physical']) assert.ok(f.includes(code), code);
});

test('③ vmCfgFindings — 심각도 순서·템플릿 예외·게스트 OS/호스트명 비교·IP 이름은 비교하지 않음', () => {
  const vm = { name: 'web01', cfg: { question: { text: 'q' }, cpuLimitMhz: 1000, memLimitMB: -1, cbt: false, guestIdConfig: 'rhel7_64Guest', guestIdTools: 'RHEL7_64guest', guestHostName: 'web02.corp' } };
  const codes = vmCfgFindings(vm).map((x) => x.code);
  assert.equal(codes[0], 'question');
  assert.ok(codes.includes('cpu-limit')); assert.ok(!codes.includes('mem-limit'), '-1 = 무제한');
  assert.ok(!codes.includes('guestos-mismatch'), '대소문자·Guest 접미는 같은 OS');
  assert.ok(codes.includes('hostname-mismatch'));
  const t = vmCfgFindings({ ...vm, template: true }).map((x) => x.code);
  assert.ok(!t.includes('question') && !t.includes('cbt-off'));
  assert.equal(shortName('10.0.0.1'), null);
  assert.deepEqual(vmCfgFindings({ name: 'x' }), [], 'cfg·dev 가 없으면 판정하지 않는다(미수집)');
  for (const c of Object.keys(VM_CFG_CODES)) assert.ok(['crit', 'warn', 'info'].includes(VM_CFG_CODES[c]));
});

function fakeClient({ fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async retrieveManyObjectProps(type, refs, paths) {
      calls.push({ type, n: refs.length, paths });
      if (fail) throw new Error(fail);
      return refs.map((ref) => ({ type, ref, props: paths.includes('config.hardware.device') ? { 'config.hardware.device': '' } : { 'config.changeTrackingEnabled': 'true' } }));
    },
  };
}
const SET = { vmCfgScan: true, vmCfgRefreshMs: 1_800_000, vmCfgPerCycle: 3, vmDevRefreshMs: 21_600_000, vmDevPerCycle: 2 };

test('④ refreshVmCfg — 주기당 상한·오래된 것부터·prune·경로 오류 백오프·꺼짐', async () => {
  _resetVmCfgCache();
  const refs = ['vm-1', 'vm-2', 'vm-3', 'vm-4', 'vm-5'];
  const c = fakeClient();
  const r = await refreshVmCfg(c, 'vc1', refs, { now: NOW, settings: SET });
  assert.equal(r.cfg.fetched, 3); assert.equal(r.dev.fetched, 2);
  assert.ok(VM_CFG_PATHS.every((p) => c.calls[0].paths.includes(p)));
  const r2 = await refreshVmCfg(c, 'vc1', refs, { now: NOW + 1000, settings: SET });
  assert.equal(r2.cfg.fetched, 2, '안 읽은 VM 2대만 남았다');
  assert.equal(get('vc1', 'vm-5').cfg.cbt, true);
  await refreshVmCfg(c, 'vc1', ['vm-1'], { now: NOW + 2000, settings: SET });
  assert.equal(get('vc1', 'vm-5'), null, '인벤토리에서 사라진 VM 은 버린다');
  _resetVmCfgCache();
  const bad = fakeClient({ fail: 'ServerFaultCode: InvalidProperty config.firmware' });
  await refreshVmCfg(bad, 'vc2', refs, { now: NOW, settings: SET });
  const n = bad.calls.length;
  await refreshVmCfg(bad, 'vc2', refs, { now: NOW + 60_000, settings: SET });
  assert.equal(bad.calls.length, n, '경로 오류는 갱신 주기만큼 다시 묻지 않는다');
  assert.deepEqual(await refreshVmCfg(c, 'vc3', refs, { now: NOW, settings: { ...SET, vmCfgScan: false } }), { skipped: 'off' });
});

test('⑤ refreshVmCfg — 시간 예산을 넘기면 다음 조각을 시작하지 않는다', async () => {
  _resetVmCfgCache();
  const refs = Array.from({ length: 600 }, (_, i) => `vm-${i}`);
  const c = fakeClient();
  const r = await refreshVmCfg(c, 'vc1', refs, { now: NOW, budgetMs: 0, settings: { ...SET, vmCfgPerCycle: 600 } });
  assert.equal(r.cfg.fetched, 0); assert.equal(r.cfg.cut, 600);
  assert.equal(c.calls.length, 0);
});

test('⑥ pickDue — 안 읽은 것 먼저, 그다음 오래된 순', () => {
  _resetVmCfgCache();
  put('v', 'a', 'cfg', { at: NOW - 3_600_000 }); put('v', 'b', 'cfg', { at: NOW - 7_200_000 }); put('v', 'c', 'cfg', { at: NOW });
  assert.deepEqual(pickDue('v', ['a', 'b', 'c', 'd'], 'cfg', { now: NOW, periodMs: 1_800_000, max: 10 }), ['d', 'b', 'a']);
});

test('⑦ 엣지 수신 정제 — 아는 필드만, 모양이 아니면 null', () => {
  assert.equal(sanitizeVmCfg('x'), null);
  const c = sanitizeVmCfg({ cbt: 'yes', cpuLimitMhz: '500', firmware: { a: 1 }, question: { text: 'q'.repeat(2000) }, evil: 1, managedBy: {} });
  assert.equal(c.cbt, null); assert.equal(c.cpuLimitMhz, 500); assert.equal(c.firmware, null);
  assert.equal(c.question.text.length, 512); assert.equal('evil' in c, false); assert.equal(c.managedBy, null);
  const d = sanitizeVmDev({ cdroms: [null, { label: 'x', connected: true, iso: 'y' }], disks: 'no', usb: -3 });
  assert.equal(d.cdroms.length, 1); assert.equal(d.cdroms[0].iso, false); assert.deepEqual(d.disks, []); assert.equal(d.usb, 0);
  const dropped = { notObject: 0, otherVcenter: 0, badId: 0, coerced: 0 };
  const out = sanitizeInventoryList([{ id: 'vc1:vm-1', name: 'a', cfg: 'junk', dev: { cdroms: [] } }], 'vc1', 10, dropped);
  assert.equal(out[0].cfg, null); assert.ok(Array.isArray(out[0].dev.cdroms)); assert.equal(dropped.coerced, 1);
});

test('⑧ 수집기 배선 — 인벤토리 수집이 refreshVmCfg 를 부르고 캐시 값을 vm.cfg·vm.dev 로 싣는다', () => {
  const src = fs.readFileSync(new URL('../src/vcenter/soapClient.js', import.meta.url), 'utf8');
  assert.match(src, /refreshVmCfg\(c, vc\.id, vmRefs\b/);
  // v2.720(감사 R2-01): '기다린 뒤 캐시를 싣는다' 를 고정한다 — runAux 앞의 await 를 지우면 아래 VM 조립이 갱신 전 캐시를 싣고
  //   갱신의 SOAP 호출이 finally 의 로그아웃과 경쟁한다. 형제 갱신(호스트·경합·DS·클러스터·태그)도 같은 모양으로 고정한다.
  assert.match(src, /await runAux\('vmcfg',[^\n]*refreshVmCfg\(c, vc\.id, vmRefs\b/);
  for (const [k, fn] of [['hostcfg', 'refreshHostCfg'], ['contention', 'refreshContention'], ['dscfg', 'refreshDsCfg'], ['clustercfg', 'refreshClusterCfg'], ['tags', 'refreshTagInv']]) {
    assert.match(src, new RegExp(`await runAux\\('${k}',[^\\n]*${fn}\\(`), `${k} 갱신은 await runAux 로 기다린다`);
  }
  assert.match(src, /cfgEntry\?\.cfg \? \{ cfg: cfgEntry\.cfg \}/);
  // 30초 인벤토리 요청 자체에는 구성 경로를 싣지 않는다(응답 크기 — vmcfg/cache.js 머리말).
  const vmSpec = /type: 'VirtualMachine', paths: \[([\s\S]*?)\] \}/.exec(src)[1];
  assert.ok(!vmSpec.includes('config.changeTrackingEnabled'));
});
