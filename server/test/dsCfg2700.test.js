// v2.700 — 데이터스토어 운영(A17)·멀티패스(A2)·vSAN(A19) 수집·판정.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDsCfgProps, parseMounts, dsCfgFindings, sanitizeDsCfg } from '../src/dscfg/parse.js';
import { refreshDsCfg, getDsCfg, _resetDsCfg } from '../src/dscfg/collect.js';
import { analyzeDatastores, analyzePaths, analyzeVsan } from '../src/dscfg/analyze.js';
import { parseMultipath, parseVsan, hostCfgFindings, parseHostCfgProps, sanitizeHostCfg } from '../src/hostcfg/parse.js';
import { refreshHostCfg } from '../src/hostcfg/collect.js';
import { get as hostGet, _resetHostCfgCache } from '../src/hostcfg/cache.js';
import { sanitizeInventoryList } from '../src/routes/central.js';

const NOW = 1_800_000_000_000;
const MOUNT = (acc, mnt) => `<DatastoreHostMount><key type="HostSystem">host-1</key><mountInfo><path>/vmfs/volumes/x</path><accessMode>readWrite</accessMode><mounted>${mnt}</mounted><accessible>${acc}</accessible></mountInfo></DatastoreHostMount>`;

test('① DS 운영 파서 — 마운트·유지보수·미할당 약정·SIOC·VM 수·SDRS, 못 읽은 값은 null', () => {
  const d = parseDsCfgProps({
    'summary.maintenanceMode': 'inMaintenance', 'summary.uncommitted': String(500 * 1024 ** 3),
    iormConfiguration: '<enabled>false</enabled><congestionThreshold>30</congestionThreshold>',
    vm: '<ManagedObjectReference type="VirtualMachine">vm-1</ManagedObjectReference><ManagedObjectReference type="VirtualMachine">vm-2</ManagedObjectReference>',
    host: MOUNT('true', 'true') + MOUNT('false', 'true') + MOUNT('true', 'false'),
    parent: 'group-p12',
  }, NOW);
  assert.deepEqual(d, { at: NOW, maintenance: 'inMaintenance', uncommittedGB: 500, sioc: false, vmCount: 2, inSdrs: true, mounts: { total: 3, notAccessible: 1, notMounted: 1 } });
  const e = parseDsCfgProps({}, NOW);
  assert.equal(e.vmCount, null); assert.equal(e.mounts, null); assert.equal(e.sioc, null); assert.equal(e.uncommittedGB, null);
  assert.deepEqual(parseMounts(''), { total: 0, notAccessible: 0, notMounted: 0 });
});

test('② DS 판정 — 오버할당 기준·SIOC 는 공유 VMFS/NFS 만·운영 속성 없으면 접근 불가·VMFS 만', () => {
  const codes = (ds) => dsCfgFindings(ds).map((f) => f.code);
  assert.deepEqual(codes({ accessible: false, vmfsMajor: 5 }), ['ds-inaccessible', 'ds-vmfs-old']);
  const base = { type: 'VMFS', capacityGB: 1000, usedGB: 600 };
  assert.deepEqual(codes({ ...base, dcfg: { uncommittedGB: 900, mounts: { total: 2, notAccessible: 0, notMounted: 0 }, sioc: true } }), ['ds-overcommit']);
  assert.deepEqual(codes({ ...base, dcfg: { uncommittedGB: 899 } }), [], '149% 는 기준 미만');
  assert.deepEqual(codes({ ...base, usedGB: null, dcfg: { uncommittedGB: 5000 } }), [], '사용량을 모르면 오버할당을 판정하지 않는다');
  assert.deepEqual(codes({ ...base, dcfg: { sioc: false, mounts: { total: 1, notAccessible: 0, notMounted: 0 } } }), [], '로컬(마운트 1) 은 SIOC 대상 아님');
  assert.deepEqual(codes({ ...base, type: 'vsan', dcfg: { sioc: false, mounts: { total: 4, notAccessible: 0, notMounted: 0 } } }), [], 'vSAN 은 SIOC 대상 아님');
  assert.deepEqual(codes({ ...base, dcfg: { sioc: false, mounts: { total: 4, notAccessible: 0, notMounted: 0 }, vmCount: 41 } }), ['ds-sioc-off', 'ds-many-vms']);
});

test('③ 멀티패스 — 공유 LUN(FC·iSCSI)만 단일 경로로 센다, 죽은 경로 집계, 정책 분포', () => {
  const path = (lun, st, tr) => `<path><key>p</key><name>vmhba</name><pathState>${st}</pathState><lun>${lun}</lun><transport xsi:type="${tr}"></transport></path>`;
  const x = `<lun>${path('key-vim.host.ScsiDisk-A', 'active', 'HostFibreChannelTargetTransport')}${path('key-vim.host.ScsiDisk-A', 'standby', 'HostFibreChannelTargetTransport')}<policy xsi:type="P"><policy>VMW_PSP_RR</policy></policy></lun>`
    + `<lun>${path('key-vim.host.ScsiDisk-B', 'active', 'HostInternetScsiTargetTransport')}${path('key-vim.host.ScsiDisk-B', 'dead', 'HostInternetScsiTargetTransport')}<policy xsi:type="P"><policy>VMW_PSP_MRU</policy></policy></lun>`
    + `<lun>${path('key-vim.host.ScsiDisk-L', 'active', 'HostParallelScsiTargetTransport')}<policy xsi:type="P"><policy>VMW_PSP_FIXED</policy></policy></lun>`;
  const m = parseMultipath(x);
  assert.equal(m.luns, 3); assert.equal(m.shared, 2); assert.equal(m.paths, 5); assert.equal(m.dead, 1);
  assert.deepEqual(m.deadLuns, ['B']); assert.equal(m.singlePath, 1); assert.deepEqual(m.singleLuns, ['B']);
  assert.deepEqual(m.policies, { VMW_PSP_RR: 1, VMW_PSP_MRU: 1, VMW_PSP_FIXED: 1 });
  assert.equal(parseMultipath(undefined), null);
  const v = parseVsan('true', '<membershipList><nodeUuid>a</nodeUuid></membershipList><membershipList><nodeUuid>b</nodeUuid></membershipList><diskIssues><diskId>d</diskId></diskIssues>');
  assert.deepEqual(v, { enabled: true, diskIssues: 1, members: 2 });
  assert.equal(parseVsan(undefined, undefined), null);
  const codes = hostCfgFindings({ connectionState: 'CONNECTED', hcfg: { mp: m, vsan: v } }, NOW).map((f) => f.code);
  assert.deepEqual(codes, ['mp-dead', 'mp-single', 'vsan-disk-issue']);
  assert.equal(parseHostCfgProps({}, NOW).mp, null, '경로를 요청하지 않았으면 모름');
  const s = sanitizeHostCfg({ mp: { luns: 3, dead: -1, policies: { 'bad key': 1, VMW_PSP_RR: 2 }, deadLuns: ['a', 5] }, vsan: { enabled: 'x', diskIssues: 2 } });
  assert.deepEqual(s.mp.policies, { VMW_PSP_RR: 2 }); assert.equal(s.mp.dead, 0); assert.deepEqual(s.mp.deadLuns, ['a']);
  assert.deepEqual(s.vsan, { enabled: null, diskIssues: 2, members: null });
});

test('④ 수집 — DS 캐시 상한·prune·InvalidProperty 백오프 / 호스트 선택 경로(vSAN 미지원은 그 묶음만)', async () => {
  _resetDsCfg();
  let calls = 0;
  const c = { async retrieveManyObjectProps(type, refs) { calls += 1; return refs.map((ref) => ({ ref, props: { 'summary.maintenanceMode': 'normal' } })); } };
  const settings = { dsCfgScan: true, dsCfgRefreshMs: 1_800_000, dsCfgPerCycle: 2 };
  const r = await refreshDsCfg(c, 'vc1', ['ds-1', 'ds-2', 'ds-3'], { now: NOW, settings });
  assert.equal(r.fetched, 2);
  await refreshDsCfg(c, 'vc1', ['ds-1', 'ds-2', 'ds-3'], { now: NOW + 1, settings });
  assert.ok(getDsCfg('vc1', 'ds-3'));
  await refreshDsCfg(c, 'vc1', ['ds-3'], { now: NOW + 2, settings });
  assert.equal(getDsCfg('vc1', 'ds-1'), null, '인벤토리에서 사라진 DS 는 지운다');
  const bad = { async retrieveManyObjectProps() { throw new Error('InvalidProperty: iormConfiguration'); } };
  _resetDsCfg();
  await refreshDsCfg(bad, 'vc2', ['ds-1'], { now: NOW, settings });
  const r2 = await refreshDsCfg(c, 'vc2', ['ds-1'], { now: NOW + 1000, settings });
  assert.equal(r2.skipped, 'backoff');

  _resetHostCfgCache();
  const asked = [];
  const hc = {
    async retrieveManyObjectProps(type, refs, paths) {
      asked.push(paths[0]);
      if (paths[0] === 'config.vsanHostConfig.enabled') throw new Error('InvalidProperty: config.vsanHostConfig');
      if (paths[0] === 'config.storageDevice.multipathInfo') return refs.map((ref) => ({ ref, props: { 'config.storageDevice.multipathInfo': '<path><pathState>dead</pathState><lun>L</lun><transport xsi:type="HostFibreChannelTargetTransport"/></path>' } }));
      return refs.map((ref) => ({ ref, props: {} }));
    },
    async callRaw() { return ''; },
  };
  const hs = { hostCfgScan: true, hostCfgRefreshMs: 21_600_000, hostCfgPerCycle: 10 };
  await refreshHostCfg(hc, 'vc1', ['host-1'], { now: NOW, settings: hs });
  const h = hostGet('vc1', 'host-1');
  assert.equal(h.vsan, null, 'vSAN 경로 미지원이면 그 값만 모름');
  assert.equal(h.mp.dead, 1);
  asked.length = 0;
  await refreshHostCfg(hc, 'vc1', ['host-2'], { now: NOW, settings: hs });
  assert.ok(!asked.includes('config.vsanHostConfig.enabled'), '미지원 묶음은 다시 묻지 않는다');
  assert.ok(asked.includes('config.storageDevice.multipathInfo'));
});

test('⑤ 분석 — DS 커버리지, 경로 합계·정책, vSAN 분할·용량', () => {
  const dsr = analyzeDatastores([{ id: 'a', name: 'a', accessible: false }, { id: 'b', name: 'b', dcfg: {} }, { id: 'c', name: 'c' }]);
  assert.deepEqual(dsr.coverage, { datastores: 3, cfg: 1, notCollected: 2 });
  assert.equal(dsr.rows.length, 1);
  const hosts = [
    { id: 'h1', name: 'h1', vcenterId: 'v', cluster: 'C', connectionState: 'CONNECTED', hcfg: { mp: { luns: 2, shared: 2, paths: 4, dead: 1, deadLuns: ['x'], singlePath: 0, singleLuns: [], policies: { RR: 2 } }, vsan: { enabled: true, diskIssues: 0, members: 2 } } },
    { id: 'h2', name: 'h2', vcenterId: 'v', cluster: 'C', connectionState: 'CONNECTED', hcfg: { mp: { luns: 2, shared: 2, paths: 4, dead: 0, deadLuns: [], singlePath: 0, singleLuns: [], policies: { RR: 2 } }, vsan: { enabled: true, diskIssues: 1, members: 2 } } },
    { id: 'h3', name: 'h3', vcenterId: 'v', cluster: 'C', connectionState: 'CONNECTED', hcfg: { vsan: { enabled: true, diskIssues: 0, members: 3 } } },
    { id: 'h4', name: 'h4', vcenterId: 'v', cluster: 'C', connectionState: 'DISCONNECTED', hcfg: { vsan: { enabled: true } } },
  ];
  const p = analyzePaths(hosts, { onlyIssues: true });
  assert.deepEqual(p.coverage, { hosts: 3, read: 2, notCollected: 1 });
  assert.equal(p.rows.length, 1); assert.deepEqual(p.policies, { RR: 4 });
  hosts.push(
    { id: 'k1', name: 'k1', vcenterId: 'v', cluster: 'D', connectionState: 'CONNECTED', hcfg: { vsan: { enabled: true, diskIssues: 0, members: 2 } } },
    { id: 'k2', name: 'k2', vcenterId: 'v', cluster: 'D', connectionState: 'CONNECTED', hcfg: { vsan: { enabled: true, diskIssues: 0, members: 2 } } },
  );
  const v = analyzeVsan(hosts, [{ id: 'd', name: 'vsanDatastore', vcenterId: 'v', type: 'vsan', capacityGB: 100, usedGB: 75 }]);
  assert.deepEqual(v.clusters.find((c) => c.cluster === 'D').findings, [], '멤버 수 = vSAN 호스트 수면 정상');
  assert.equal(v.clusters.find((c) => c.cluster === 'C').hosts, 3);
  assert.deepEqual(v.clusters.find((c) => c.cluster === 'C').findings.map((f) => f.code), ['vsan-partition', 'vsan-disk-issue']);
  assert.deepEqual(v.datastores[0].findings.map((f) => f.code), ['vsan-capacity-high']);
});

test('⑥ 엣지 정제 — dcfg 아는 필드만', () => {
  const v = sanitizeDsCfg({ maintenance: 'evil', vmCount: -3, mounts: { total: 2 }, extra: 1 });
  assert.equal(v.maintenance, null); assert.equal(v.vmCount, null); assert.deepEqual(v.mounts, { total: 2, notAccessible: 0, notMounted: 0 });
  const dropped = { coerced: 0 };
  const out = sanitizeInventoryList([{ id: 'vc1:ds-1', name: 'd', dcfg: 'junk', vmfsMajor: '6' }], 'vc1', 10, dropped);
  assert.equal(out[0].dcfg, null); assert.equal(out[0].vmfsMajor, 6);
});

// v2.727(감사 C-05): 멤버 0개 입력에서 vsan-partition 이 나지 않는다 — enabled + membershipList 0 은 '못 읽음(null)' 이다.
test('⑦ vSAN 멤버 0개 — parseVsan 은 null(판정 보류) · analyzeVsan 은 분할이라 말하지 않고 membersUnknown 으로 센다', () => {
  const v0 = parseVsan('true', '<diskIssues><diskId>d</diskId></diskIssues>');
  assert.equal(v0.members, null); assert.equal(v0.diskIssues, 1);
  assert.equal(parseVsan('false', '').members, 0, '꺼진 호스트의 0 은 값');
  const hosts = [
    { id: 'a', name: 'a', vcenterId: 'v', cluster: 'Z', connectionState: 'CONNECTED', hcfg: { vsan: v0 } },
    { id: 'b', name: 'b', vcenterId: 'v', cluster: 'Z', connectionState: 'CONNECTED', hcfg: { vsan: parseVsan('true', '') } },
  ];
  const r = analyzeVsan(hosts, []);
  assert.deepEqual(r.clusters[0].findings.map((f) => f.code), ['vsan-disk-issue'], 'vsan-partition 없음');
  assert.equal(r.clusters[0].membersUnknown, 2); assert.equal(r.clusters[0].minMembers, null);
});
