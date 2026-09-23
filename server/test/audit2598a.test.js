// v2.598 감사 그룹 a — vCenter 수집·파싱(VC2598-01~10) + 요청 시한 상한(T2598-03) 회귀.
// 전부 실제 함수를 호출해 동작으로 본다. 기준 시각은 고정값(Date.now() 금지 — v2.517 규약).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2598a-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';   // 가짜 vCenter(127.0.0.1) 를 등록·접속하기 위한 이 테스트 전용 설정

const closers = [];
after(async () => { for (const c of closers) await c(); fs.rmSync(DIR, { recursive: true, force: true }); });
const T0 = Date.UTC(2026, 8, 23, 3, 30, 0);   // 고정 기준 시각

/* ───────── VC2598-01 스냅샷 크기: 델타 익스텐트·메모리 포함 ───────── */
test('VC2598-01 스냅샷 크기는 sesparse·delta 익스텐트와 .vmem 을 더한다(uniqueSize 우선)', async () => {
  const { snapshotInfo } = await import('../src/vcenter/soapParse.js');
  const GB = 1024 ** 3;
  const f = (name, type, size, unique) => `<file><key>1</key><name>[ds1] vm/${name}</name><type>${type}</type><size>${size}</size>${unique != null ? `<uniqueSize>${unique}</uniqueSize>` : ''}</file>`;
  const layout = '<val>'
    + f('vm.vmx', 'config', 4000)
    + f('vm.vmdk', 'diskDescriptor', 600)
    + f('vm-flat.vmdk', 'diskExtent', 100 * GB)                  // 기본 디스크 — 스냅샷 아님
    + f('vm-000001.vmdk', 'diskDescriptor', 400)                 // 델타 디스크립터(수백 바이트)
    + f('vm-000001-sesparse.vmdk', 'diskExtent', 20 * GB, 12 * GB) // 델타 익스텐트 — uniqueSize 12GB
    + f('vm_1-000002-delta.vmdk', 'diskExtent', 3 * GB)          // VMFS5 델타
    + f('vm-Snapshot1.vmsn', 'snapshotData', 1 * GB)
    + f('vm-Snapshot1.vmem', 'snapshotMemory', 4 * GB)
    + f('vm.vmsd', 'snapshotList', 1000)
    + '</val>';
  const snap = '<snapshot type="VirtualMachineSnapshot">snapshot-1</snapshot><rootSnapshotList><name>s1</name><createTime>2026-09-01T00:00:00Z</createTime></rootSnapshotList>';
  const r = snapshotInfo(snap, layout);
  // 12 + 3 + 1 + 4 GB + 디스크립터 400B + vmsd 1000B ≈ 20.0GB. 수정 전 코드는 .vmsn + 디스크립터 = 1.0GB.
  assert.equal(r.snapshotCount, 1);
  assert.equal(r.snapshotSizeGB, 20);
});

/* ───────── VC2598-10 자기닫힘 <val/> 이 다음 propSet 을 삼키지 않는다 ───────── */
test('VC2598-10 parseObjectContent: 자기닫힘 빈 속성은 빈 문자열이고 이웃 속성이 살아 있다', async () => {
  const { parseObjectContent } = await import('../src/vcenter/soapParse.js');
  const xml = '<returnval><obj type="VirtualMachine">vm-7</obj>'
    + '<propSet><name>snapshot</name><val xsi:type="VirtualMachineSnapshotInfo"/></propSet>'
    + '<propSet><name>name</name><val xsi:type="xsd:string">web&amp;01</val></propSet>'
    + '<propSet><name>layoutEx.file</name><val xsi:type="ArrayOfVirtualMachineFileLayoutExFileInfo"/></propSet>'
    + '<propSet><name>runtime.host</name><val type="HostSystem" xsi:type="ManagedObjectReference">host-1</val></propSet>'
    + '</returnval>';
  const [o] = parseObjectContent(xml);
  assert.equal(o.props.snapshot, '');
  assert.equal(o.props.name, 'web&01');
  assert.equal(o.props['layoutEx.file'], '');
  assert.equal(o.props['runtime.host'], 'host-1');
});

/* ───────── VC2598-02 성능 차트 결측(-1)은 null ───────── */
test('VC2598-02 entityMetricPoints: vCenter 결측(-1)은 0 이 아니라 null, 정상값은 환산', async () => {
  const { entityMetricPoints } = await import('../src/vcenter/soapClient.js');
  const pts = entityMetricPoints([{ t: 'a', v: 1234 }, { t: 'b', v: -1 }, { t: 'c', v: 0 }], 100);
  assert.deepEqual(pts, [{ t: 'a', v: 12.3 }, { t: 'b', v: null }, { t: 'c', v: 0 }]);
  assert.deepEqual(entityMetricPoints([{ t: 'x', v: -1 }, { t: 'y', v: 55 }], 1), [{ t: 'x', v: null }, { t: 'y', v: 55 }]);
});

/* ───────── VC2598-05 파생 알람 time = 처음 관측 시각 ───────── */
test('VC2598-05 stampAlarmFirstSeen: 계속 떠 있는 알람은 처음 본 시각을 유지하고, 해소 뒤 재발은 새 시각', async () => {
  const { stampAlarmFirstSeen } = await import('../src/vcenter/soapClient.js');
  const store = new Map();
  const mk = () => [{ id: 'vc1:host:esx1:disconnected' }];
  const a1 = stampAlarmFirstSeen('vc1', mk(), T0, store);
  const a2 = stampAlarmFirstSeen('vc1', mk(), T0 + 3 * 3_600_000, store);
  assert.equal(a2[0].time, new Date(T0).toISOString(), '3시간 뒤 수집에서도 발생 시각은 처음 본 시각');
  assert.equal(a2[0].lastSeen, new Date(T0 + 3 * 3_600_000).toISOString());
  assert.equal(a1[0].timeBasis, 'first-seen');
  stampAlarmFirstSeen('vc1', [], T0 + 4 * 3_600_000, store);                // 해소
  const a3 = stampAlarmFirstSeen('vc1', mk(), T0 + 5 * 3_600_000, store);  // 재발
  assert.equal(a3[0].time, new Date(T0 + 5 * 3_600_000).toISOString());
  assert.equal(store.has('vc2'), false);
});

/* ───────── VC2598-03 GPU 인벤토리: 호스트 키에 vCenter 축 ───────── */
test('VC2598-03 buildGpuInventory·gpuHostModelMap: 다른 vCenter 의 같은 이름 호스트가 섞이지 않는다', async () => {
  const { buildGpuInventory, gpuHostModelMap, gpuHostKey } = await import('../src/routes/api/hardwareGpu.js');
  const { setGuestGpu } = await import('../src/gpu/store.js');
  const snap = {
    hosts: [
      { id: 'vcA:host-1', name: 'esx01', vcenterId: 'vcA', gpus: [{ model: 'A100', memGB: 80, mode: 'passthrough' }] },
      { id: 'vcB:host-1', name: 'esx01', vcenterId: 'vcB', gpus: [{ model: 'T4', memGB: 16, mode: 'vgpu' }] },
    ],
    vms: [
      { id: 'vcA:vm-1', vcenterId: 'vcA', host: 'esx01', name: 'a1', powerState: 'POWERED_ON', gpu: { passthrough: 1 } },
      { id: 'vcB:vm-1', vcenterId: 'vcB', host: 'esx01', name: 'b1', powerState: 'POWERED_ON', gpu: { vgpu: 1 } },
      { id: 'vcB:vm-2', vcenterId: 'vcB', host: 'esx01', name: 'b2', powerState: 'POWERED_OFF', gpu: { vgpu: 1 } },
    ],
  };
  setGuestGpu({ vms: [{ vmId: 'vcA:vm-1', utilPct: 90, host: 'esx01' }, { vmId: 'vcB:vm-1', utilPct: 10, host: 'esx01' }] });
  const inv = buildGpuInventory(snap, null, null);
  const byVc = Object.fromEntries(inv.items.map((x) => [x.vcenterId, x]));
  assert.equal(byVc.vcA.assignedVms, 1);
  assert.deepEqual(byVc.vcA.assignedVmNames.map((x) => x.name), ['a1']);
  assert.equal(byVc.vcB.assignedVms, 2);
  assert.equal(byVc.vcA.utilPct, 90, 'vcA 호스트의 게스트 사용률에 vcB VM 값이 섞이면 안 된다');
  assert.equal(byVc.vcB.utilPct, 10);
  const m = gpuHostModelMap(snap.hosts);
  assert.equal(m.get(gpuHostKey('vcA', 'esx01')), 'A100');
  assert.equal(m.get(gpuHostKey('vcB', 'esx01')), 'T4');
});

/* ───────── T2598-03 요청 시한 상한 ───────── */
test('T2598-03 normRequestTimeoutMs: 빈 값·0 은 기본(0), 그 밖은 [1초, 10분]', async () => {
  const { normRequestTimeoutMs, effectiveRequestTimeoutMs } = await import('../src/vcenter/soapParse.js');
  assert.equal(normRequestTimeoutMs(''), 0);
  assert.equal(normRequestTimeoutMs(null), 0);
  assert.equal(normRequestTimeoutMs(0), 0);
  assert.equal(normRequestTimeoutMs(-5), 0);
  assert.equal(normRequestTimeoutMs('abc'), 0);
  assert.equal(normRequestTimeoutMs(50), 1000);
  assert.equal(normRequestTimeoutMs('45000'), 45000);
  assert.equal(normRequestTimeoutMs(2 ** 31), 600000);
  assert.equal(normRequestTimeoutMs(1e12), 600000);
  assert.equal(effectiveRequestTimeoutMs(3e9, 30000), 600000, '옛 저장값도 실행 시 상한으로 자른다');
  assert.equal(effectiveRequestTimeoutMs(0, 30000), 30000);
  const { vcDeadlineMs } = await import('../src/store.js');
  assert.equal(vcDeadlineMs({ timeoutMs: 800_000_000 }), 1_800_000, '옛 저장값 ×3 이 2^31 을 넘어 즉시 발화하지 않는다');
  assert.ok(vcDeadlineMs({ timeoutMs: 800_000_000 }) < 2 ** 31 - 1);
  assert.equal(vcDeadlineMs({}), 90_000);
});

test('T2598-03 vCenter·NSX·Horizon 등록이 큰 timeoutMs 를 상한으로 자른다', async () => {
  const vcReg = await import('../src/vcenter/registry.js');
  const r = vcReg.addVcenter({ id: 'vc-t', name: 'T', host: 'https://10.0.0.5', username: 'u', password: 'p', timeoutMs: 3_000_000_000 });
  assert.equal(r.ok, true, r.reason);
  assert.equal(vcReg.loadRegistry().find((v) => v.id === 'vc-t').timeoutMs, 600000);
  const r0 = vcReg.addVcenter({ id: 'vc-t0', name: 'T0', host: 'https://10.0.0.6', username: 'u', password: 'p', timeoutMs: '' });
  assert.equal(r0.ok, true);
  assert.equal(vcReg.loadRegistry().find((v) => v.id === 'vc-t0').timeoutMs, 0, '빈 칸 = 기본값 규약 유지');

  const nsx = await import('../src/nsx/registry.js');
  const n = nsx.addManager({ id: 'nsx-t', name: 'N', host: 'https://10.0.0.7', username: 'admin', password: 'p', timeoutMs: 2 ** 32 });
  assert.equal(n.ok, true, n.reason);
  assert.equal(nsx.loadRegistry().find((m) => m.id === 'nsx-t').timeoutMs, 600000);

  const hz = await import('../src/horizon/horizon.js');
  const h = hz.upsertHorizon({ id: 'hz-t', name: 'H', host: 'https://10.0.0.8', username: 'u', domain: 'corp', password: 'p', timeoutMs: 2 ** 32 });
  assert.equal(h.ok, true, h.reason);
  assert.equal(hz.loadHorizon().find((x) => x.id === 'hz-t').timeoutMs, 600000);
  const h2 = hz.upsertHorizon({ id: 'hz-t2', name: 'H2', host: 'https://10.0.0.9', username: 'u', domain: 'corp', password: 'p', timeoutMs: '' });
  assert.equal(h2.ok, true);
  assert.equal(hz.loadHorizon().find((x) => x.id === 'hz-t2').timeoutMs, 15000);
});

/* ───────── 가짜 vCenter 로 collectFromVCenterSoap 실행(VC2598-04·05·07·08·09) ───────── */
const env = (inner) => '<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body>' + inner + '</soapenv:Body></soapenv:Envelope>';
const SC = env('<RetrieveServiceContentResponse xmlns="urn:vim25"><returnval>'
  + '<rootFolder type="Folder">group-d1</rootFolder><propertyCollector type="PropertyCollector">propertyCollector</propertyCollector>'
  + '<viewManager type="ViewManager">ViewManager</viewManager><sessionManager type="SessionManager">SessionManager</sessionManager>'
  + '<about><version>8.0.2</version><build>1</build><fullName>VMware vCenter Server 8.0.2</fullName><apiVersion>8.0.2.0</apiVersion></about>'
  + '</returnval></RetrieveServiceContentResponse>');
const ps = (name, val) => `<propSet><name>${name}</name><val>${val}</val></propSet>`;
const obj = (type, ref, props) => `<returnval><obj type="${type}">${ref}</obj>${props}</returnval>`;
const INV = env('<RetrievePropertiesResponse xmlns="urn:vim25">'
  + obj('HostSystem', 'host-1', ps('name', 'esx-a') + ps('runtime.connectionState', 'connected') + ps('summary.hardware.numCpuCores', '8') + ps('summary.hardware.cpuMhz', '2000') + ps('summary.hardware.memorySize', String(64 * 1024 ** 3)))
  + obj('HostSystem', 'host-2', ps('name', 'esx-b') + ps('runtime.connectionState', 'disconnected'))
  + obj('VirtualMachine', 'vm-1', ps('name', 'app') + ps('runtime.host', 'host-1') + ps('runtime.powerState', 'poweredOn') + ps('summary.config.template', 'false'))
  + obj('VirtualMachine', 'vm-2', ps('name', 'tpl') + ps('runtime.host', 'host-1') + ps('runtime.powerState', 'poweredOff') + ps('summary.config.template', 'true'))
  + obj('Datastore', 'datastore-1', ps('name', 'nfs-gone') + ps('summary.type', 'NFS') + ps('summary.capacity', String(1024 ** 4)) + ps('summary.accessible', 'false'))
  + obj('Datastore', 'datastore-2', ps('name', 'vmfs-ok') + ps('summary.type', 'VMFS') + ps('summary.capacity', String(100 * 1024 ** 3)) + ps('summary.freeSpace', String(40 * 1024 ** 3)) + ps('summary.accessible', 'true'))
  + obj('Network', 'network-1', ps('name', 'VM Network'))
  + '</RetrievePropertiesResponse>');

const SC_PERF = SC.replace('<about>', '<perfManager type="PerformanceManager">PerfMgr</perfManager><about>');
const PERF_CATALOG = env('<RetrievePropertiesResponse xmlns="urn:vim25">'
  + obj('PerformanceManager', 'PerfMgr', '<propSet><name>perfCounter</name><val xsi:type="ArrayOfPerfCounterInfo">'
    + '<PerfCounterInfo><key>99</key><nameInfo><key>power</key></nameInfo><groupInfo><key>power</key></groupInfo><rollupType>average</rollupType><level>1</level></PerfCounterInfo>'
    + '</val></propSet>')
  + '</RetrievePropertiesResponse>');
// host-1 은 결측(-1), host-2 는 측정 0W — 둘은 달라야 한다.
const POWER = env('<QueryPerfResponse xmlns="urn:vim25">'
  + '<returnval xsi:type="PerfEntityMetric"><entity type="HostSystem">host-1</entity><value xsi:type="PerfMetricIntSeries"><id><counterId>99</counterId><instance></instance></id><value>-1</value></value></returnval>'
  + '<returnval xsi:type="PerfEntityMetric"><entity type="HostSystem">host-2</entity><value xsi:type="PerfMetricIntSeries"><id><counterId>99</counterId><instance></instance></id><value>0</value></value></returnval>'
  + '</QueryPerfResponse>');

async function fakeVc({ perf = false } = {}) {
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
      const ok = (x) => { res.writeHead(200, { 'content-type': 'text/xml' }); res.end(x); };
      if (b.includes('<RetrieveServiceContent')) return ok(perf ? SC_PERF : SC);
      if (b.includes('<obj type="PerformanceManager">')) return ok(PERF_CATALOG);
      if (b.includes('<QueryPerf ')) return ok(POWER);
      if (b.includes('<Login ')) return ok(env('<LoginResponse xmlns="urn:vim25"><returnval><key>s</key></returnval></LoginResponse>'));
      if (b.includes('<Logout')) return ok(env('<LogoutResponse xmlns="urn:vim25"/>'));
      if (b.includes('<CreateContainerView')) return ok(env('<CreateContainerViewResponse xmlns="urn:vim25"><returnval type="ContainerView">session[1]view-1</returnval></CreateContainerViewResponse>'));
      if (b.includes('<RetrieveProperties')) return ok(INV);
      res.writeHead(500, { 'content-type': 'text/xml' }); res.end(env('<soapenv:Fault><faultstring>unexpected</faultstring></soapenv:Fault>'));
    });
  });
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  return `http://127.0.0.1:${port}`;
}

test('VC2598-04·05·07 가짜 vCenter 수집: 네트워크 수는 null · 접근 불가 DS 는 사용률 null + 접근 불가 알람 · 알람 시각 유지', async () => {
  const { collectFromVCenterSoap } = await import('../src/vcenter/soapClient.js');
  const host = await fakeVc();
  const vc = { id: 'vc-fake', name: 'fake', host, username: 'u', password: 'p', timeoutMs: 5000 };
  const s1 = await collectFromVCenterSoap(vc);
  const net = s1.networks[0];
  assert.equal(net.hostCount, null, '수집하지 않은 호스트 수를 vCenter 전체 호스트 수로 지어내지 않는다');
  assert.equal(net.vmCount, null);
  const gone = s1.datastores.find((d) => d.name === 'nfs-gone');
  assert.equal(gone.freeGB, null);
  assert.equal(gone.usedGB, null);
  assert.equal(gone.usagePct, null, 'freeSpace 가 없으면 100% 가 아니다');
  const okDs = s1.datastores.find((d) => d.name === 'vmfs-ok');
  assert.equal(okDs.usagePct, 60);
  const kinds = s1.alarms.map((a) => a.id.split(':').pop()).sort();
  assert.deepEqual(kinds, ['disconnected', 'inaccessible']);
  assert.ok(!s1.alarms.some((a) => /usage at 100/.test(a.message)), '접근 불가 DS 에 사용률 critical 알람을 내지 않는다');
  const t1 = s1.alarms.find((a) => a.id.endsWith(':disconnected')).time;
  await new Promise((r) => setTimeout(r, 15));
  const s2 = await collectFromVCenterSoap(vc);
  assert.equal(s2.alarms.find((a) => a.id.endsWith(':disconnected')).time, t1, '다음 수집에서도 발생 시각은 그대로');
  // 템플릿은 호스트 vmCount 에 포함된다(정의 유지 — VC2598-09 보고 참조)
  assert.equal(s1.hosts.find((h) => h.name === 'esx-a').vmCount, 2);
});

test('VC2598-09 롤업은 vms 에 포함된 템플릿 수를 밝힌다', async () => {
  const { scopedRollups } = await import('../src/store.js');
  const snap = {
    vcenters: [{ id: 'v1', status: 'connected', location: { region: 'APAC' } }],
    hosts: [], datastores: [], alarms: [], networks: [],
    vms: [
      { id: 'v1:vm-1', vcenterId: 'v1', powerState: 'POWERED_ON' },
      { id: 'v1:vm-2', vcenterId: 'v1', powerState: 'POWERED_OFF', template: true },
      { id: 'v1:vm-3', vcenterId: 'v1', powerState: 'POWERED_OFF' },
    ],
  };
  const r = scopedRollups(snap, new Set(['v1']));
  assert.equal(r.global.vms, 3);
  assert.equal(r.global.templates, 1);
  assert.equal(r.global.vmsPoweredOff, 2, '꺼짐 수에는 템플릿이 포함된다 — templates 로 차이를 설명한다');
  assert.equal(r.sites[0].metrics.templates, 1);
  assert.equal(r.byRegion[0].templates, 1);
});

/* ───────── VC2598-06 콜론 포함 vCenter id ───────── */
test('VC2598-06 vcRefOf: vCenter id 에 콜론이 있어도 vCenter·moref 를 바르게 가른다', async () => {
  const { vcRefOf } = await import('../src/routes/api/vmMetrics.js');
  assert.deepEqual(vcRefOf({ id: 'apac:vc01:vm-12', vcenterId: 'apac:vc01' }), { vcId: 'apac:vc01', moref: 'vm-12' });
  assert.deepEqual(vcRefOf({ id: 'vc02:host-9', vcenterId: 'vc02' }), { vcId: 'vc02', moref: 'host-9' });
  // 소스 스윕: 이 파일에서 id 를 첫 콜론으로 쪼개는 코드가 되살아나지 않는다.
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fs.readFileSync(new URL('../src/routes/api/vmMetrics.js', import.meta.url), 'utf8'));
  assert.equal((src.match(/\.indexOf\(':'\)/g) || []).length, 0);
});

/* ───────── VC2598-08 호스트 전력 결측(-1)은 미수집 ───────── */
test('VC2598-08 전력 카운터 -1 은 powerWatts 미수집(undefined), 측정 0W 는 0 으로 남는다', async () => {
  const { collectFromVCenterSoap } = await import('../src/vcenter/soapClient.js');
  const host = await fakeVc({ perf: true });
  const s = await collectFromVCenterSoap({ id: 'vc-pwr', name: 'pwr', host, username: 'u', password: 'p', timeoutMs: 5000 });
  const a = s.hosts.find((h) => h.name === 'esx-a');
  const b = s.hosts.find((h) => h.name === 'esx-b');
  assert.equal(a.powerWatts, undefined, '결측(-1)을 -1W 로 저장·합산하지 않는다');
  assert.equal(a.vcPowerWatts, undefined);
  assert.equal(b.powerWatts, 0, '받은 0 은 측정값이다');
});
