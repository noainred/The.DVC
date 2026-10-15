/**
 * test/audit2741h.test.js — v2.741 점검 수정 그룹 GG(vCenter 가공·스파크라인 배치) 회귀.
 *
 *  VC-01  layoutEx.file 은 ArrayOfVirtualMachineFileLayoutExFileInfo 이고 원소 이름이 타입 이름이다
 *         (<VirtualMachineFileLayoutExFileInfo>). 예전 split('<file>') 은 그 모양에서 블록 0개 —
 *         스냅샷 크기 0 · 유령 스냅샷 0(모름이 아니라 '없음') · 고아 VMDK 소유 집합 0 이었다.
 *         실제 parseObjectContent 를 거친 두 모양(ArrayOf · 옛 <file>)이 같은 결과를 내는지 본다.
 *  VC-02  REST 폴백 vCenter 의 VM 에는 memUsagePct·cpuUsagePct 가 없다 — sampler 가 `Number(x) || 0` 으로
 *         메모리 할당은 더하고 사용은 0 을 더해 vm_mem_used_mb 가 조용히 작게 쌓였다.
 *  VC-04  호스트 구성 갱신이 예산·일시 실패로 건너뛴 선택 묶음(잠금·vSAN·멀티패스·네트워크)을 null 로 '방금 읽음'
 *         캐시해 직전 값을 지우고 갱신 주기(6시간) 동안 다시 묻지 않았다.
 *  LEFT-03 회수 대상 스파크라인이 자격증명이 맞으면 VM 마다 vCenter 로그인 — vCenter 별 로그인 1회 배치로.
 *         단건 경로(fetchVmMetric)와 같은 값인지 가짜 vCenter 로 대조한다.
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2741h-'));
process.env.CONFIG_DIR = DIR;
process.env.TEMP_DB_PATH = path.join(DIR, 'host-temp.db');
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';   // 가짜 vCenter 가 127.0.0.1 에 산다 — 이 테스트 전용
process.env.AUTH_ENABLED = 'true';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

const closers = [];
after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

const GB = 1024 ** 3;

/* ───────────────────────── VC-01 layoutEx.file 두 모양 ───────────────────────── */

// vim25 직렬화: 속성 경로 'layoutEx.file' 의 val 은 ArrayOfVirtualMachineFileLayoutExFileInfo, 원소 이름은 타입 이름.
const fiArray = (k, name, type, size, unique) => `<VirtualMachineFileLayoutExFileInfo><key>${k}</key><name>${name}</name><type>${type}</type><size>${size}</size>`
  + `${unique != null ? `<uniqueSize>${unique}</uniqueSize>` : ''}<accessible>true</accessible></VirtualMachineFileLayoutExFileInfo>`;
// 옛 모양(테스트 픽스처가 쓰던 것 · 'layoutEx' 객체 전체를 받을 때의 속성 이름 원소) — 계속 받아야 한다.
const fiFile = (k, name, type, size, unique) => fiArray(k, name, type, size, unique).replaceAll('VirtualMachineFileLayoutExFileInfo', 'file');

const FILES = [
  [0, '[ds1] vm1/vm1.vmx', 'config', 3000],
  [1, '[ds1] vm1/vm1.vmdk', 'diskDescriptor', 600],
  [2, '[ds1] vm1/vm1-flat.vmdk', 'diskExtent', 40 * GB],
  [3, '[ds1] vm1/vm1-000001.vmdk', 'diskDescriptor', 400],
  [4, '[ds1] vm1/vm1-000001-sesparse.vmdk', 'diskExtent', 20 * GB, 12 * GB],
  [5, '[ds1] vm1/vm1-Snapshot1.vmsn', 'snapshotData', 1 * GB],
];
const SNAP = '<val xsi:type="VirtualMachineSnapshotInfo"><currentSnapshot type="VirtualMachineSnapshot">snapshot-1</currentSnapshot>'
  + '<rootSnapshotList><snapshot type="VirtualMachineSnapshot">snapshot-1</snapshot><vm type="VirtualMachine">vm-1</vm>'
  + '<name>pre-patch</name><createTime>2026-09-01T00:00:00Z</createTime></rootSnapshotList></val>';
const respOf = (fi, withSnap = true) => '<RetrievePropertiesResponse xmlns="urn:vim25"><returnval><obj type="VirtualMachine">vm-1</obj>'
  + `<propSet><name>layoutEx.file</name><val xsi:type="ArrayOfVirtualMachineFileLayoutExFileInfo">${FILES.map((a) => fi(...a)).join('')}</val></propSet>`
  + (withSnap ? `<propSet><name>snapshot</name>${SNAP}</propSet>` : '')
  + '</returnval></RetrievePropertiesResponse>';

test('VC-01 ① ArrayOf 모양(원소 = 타입 이름)도 스냅샷 크기·소유 경로를 읽는다 — 옛 <file> 모양과 결과가 같다', async () => {
  const { parseObjectContent, snapshotInfo, parseLayoutFilePaths } = await import('../src/vcenter/soapParse.js');
  const [arr] = parseObjectContent(respOf(fiArray));
  const [old] = parseObjectContent(respOf(fiFile));

  const sA = snapshotInfo(arr.props.snapshot, arr.props['layoutEx.file']);
  const sO = snapshotInfo(old.props.snapshot, old.props['layoutEx.file']);
  // 델타 디스크립터 400B + sesparse uniqueSize 12GB + vmsn 1GB ≈ 13.0GB — 예전 ArrayOf 모양에서는 0 이었다.
  assert.equal(sA.snapshotCount, 1);
  assert.equal(sA.snapshotSizeGB, 13, `ArrayOf 모양의 스냅샷 크기: ${sA.snapshotSizeGB}`);
  assert.deepEqual(sA, sO, '두 모양의 결과가 같아야 한다');

  const pA = parseLayoutFilePaths(arr.props['layoutEx.file']);
  assert.equal(pA.length, 6, `ArrayOf 모양의 소유 경로(예전 0 — 살아 있는 VM 의 디스크가 고아 후보로 나왔다): ${pA.length}`);
  assert.deepEqual(pA, parseLayoutFilePaths(old.props['layoutEx.file']));
  assert.ok(pA.includes('[ds1] vm1/vm1-flat.vmdk'));

  const { layoutFileBlocks } = await import('../src/vcenter/soapParse.js');
  assert.equal(typeof layoutFileBlocks, 'function', '경계 판정 헬퍼 하나를 세 소비처가 쓴다');
  assert.equal(layoutFileBlocks(arr.props['layoutEx.file']).length, 6, 'ArrayOf 원소 6개를 블록으로 나눈다(예전 0개)');
  assert.equal(layoutFileBlocks(old.props['layoutEx.file']).length, 6, '옛 <file> 모양도 6개');
});

test('VC-01 ② 유령 스냅샷 후보 — 스냅샷 0개 + 델타 파일 있음이면 ArrayOf 모양에서도 0 이 아니라 델타 크기다', async () => {
  const { parseObjectContent, snapshotInfo } = await import('../src/vcenter/soapParse.js');
  const [arr] = parseObjectContent(respOf(fiArray, false));
  const r = snapshotInfo(arr.props.snapshot, arr.props['layoutEx.file']);
  assert.equal(r.snapshotCount, 0);
  assert.equal(r.orphanDeltaGB, 12, `델타 디스크립터 400B + sesparse 12GB → 12.0GB(예전 0 — '유령 없음' 이라는 거짓): ${r.orphanDeltaGB}`);
  // 파일 목록이 없으면 모름(null) — 그대로다.
  assert.equal(snapshotInfo('', '').orphanDeltaGB, null);
  // 원소에 xsi:type 속성이 붙어 와도 읽는다(원소 경계 판정이 이름 뒤 공백도 받는다).
  const attr = FILES.map((a) => fiArray(...a).replace('<VirtualMachineFileLayoutExFileInfo>', '<VirtualMachineFileLayoutExFileInfo xsi:type="VirtualMachineFileLayoutExFileInfo">')).join('');
  assert.equal(snapshotInfo('', attr).orphanDeltaGB, 12);
});

test('VC-01 ③ 경계 판정은 <fileKey>·<fileName> 같은 다른 원소를 파일 블록으로 잘못 자르지 않는다', async () => {
  const { layoutFileBlocks } = await import('../src/vcenter/soapParse.js');
  const xml = '<disk><key>2000</key><chain><fileKey>1</fileKey><fileKey>2</fileKey></chain></disk><fileName>x</fileName>' + fiArray(0, '[d] a/a.vmx', 'config', 1);
  assert.equal(layoutFileBlocks(xml).length, 1);
  assert.deepEqual(layoutFileBlocks(''), []);
  assert.deepEqual(layoutFileBlocks(null), []);
});

/* ───────────────────────── VC-02 REST 폴백 VM 사용률 결측 ───────────────────────── */

const ALL = { enabled: true, vcenterIds: [], trackTotal: true };

test('VC-02 ① REST 폴백 vCenter(VM 사용률 필드 없음) — 메모리 사용을 0 으로 더하지 않고 할당·사용 둘 다에서 뺀다', async () => {
  const { vmAllocRows } = await import('../src/metrics/sampler.js');
  // restClient.js 가 만드는 VM 모양: memUsagePct·cpuUsagePct·storageGB 가 없다. 호스트 용량도 null(REST 폴백).
  const snap = { vcenters: [{ id: 'vcR', status: 'connected', collectSource: 'rest' }],
    hosts: [{ id: 'vcR:host-1', vcenterId: 'vcR', name: 'esx1', connectionState: 'CONNECTED', cpuCores: null, cpuTotalMhz: null, memTotalMB: null }],
    vms: [{ id: 'vcR:vm-1', vcenterId: 'vcR', name: 'a', powerState: 'POWERED_ON', cpuCount: 4, memMB: 16384 },
      { id: 'vcR:vm-2', vcenterId: 'vcR', name: 'b', powerState: 'POWERED_ON', cpuCount: 2, memMB: 8192 }], datastores: [] };
  const out = vmAllocRows(snap, ALL);
  const rows = Object.fromEntries((out.get('vcR') || []).map((r) => [r.metric, r.v]));
  assert.equal(rows.vm_mem_used_mb, undefined, `사용률을 모르는 VM 의 메모리 사용을 0 으로 적재했다(예전 used 0 · alloc 24576): ${JSON.stringify(rows)}`);
  assert.equal(rows.vm_mem_alloc_mb, undefined, '할당만 남기면 사용 ÷ 할당이 0% 로 그려진다 — 둘 다 뺀다');
  assert.deepEqual(out.vmUsageUnknown, { cpu: 0, mem: 2 }, '뺀 VM 수를 밝힌다(CPU 는 호스트 MHz 를 몰라 원래 집계 밖)');
});

test('VC-02 ② 섞인 vCenter — 읽은 VM 끼리만 더하고, 보고된 0% 는 값이다', async () => {
  const { vmAllocRows } = await import('../src/metrics/sampler.js');
  const snap = { vcenters: [{ id: 'vc1', status: 'connected' }],
    hosts: [{ id: 'vc1:host-1', vcenterId: 'vc1', name: 'esx1', connectionState: 'CONNECTED', cpuCores: 10, cpuTotalMhz: 20000, memTotalMB: 100000 }],
    vms: [
      { id: 'vc1:vm-1', vcenterId: 'vc1', name: 'a', host: 'esx1', powerState: 'POWERED_ON', cpuCount: 2, memMB: 1000, cpuUsagePct: 40, memUsagePct: 50 },
      { id: 'vc1:vm-2', vcenterId: 'vc1', name: 'b', host: 'esx1', powerState: 'POWERED_ON', cpuCount: 4, memMB: 3000 },                       // 사용률 모름
      { id: 'vc1:vm-3', vcenterId: 'vc1', name: 'c', host: 'esx1', powerState: 'POWERED_ON', cpuCount: 1, memMB: 500, cpuUsagePct: 0, memUsagePct: 0 }, // 보고된 0
      { id: 'vc1:vm-4', vcenterId: 'vc1', name: 'd', host: 'esx1', powerState: 'POWERED_ON', cpuCount: 1, memMB: 700, cpuUsagePct: null, memUsagePct: '' }, // 빈 값 = 모름
    ], datastores: [] };
  const out = vmAllocRows(snap, ALL);
  const rows = Object.fromEntries((out.get('vc1') || []).map((r) => [r.metric, r.v]));
  assert.equal(rows.vm_mem_alloc_mb, 1500, 'a(1000) + c(500) — b·d 는 사용률을 몰라 할당에서도 뺀다');
  assert.equal(rows.vm_mem_used_mb, 500, 'a 50% = 500, c 0% = 0(보고된 0 은 값)');
  assert.equal(rows.vm_cpu_alloc_mhz, (2 + 1) * 2000, 'CPU 도 같은 규칙 — a·c 만');
  assert.equal(rows.vm_cpu_used_mhz, Math.round(2 * 2000 * 0.4));
  assert.deepEqual(out.vmUsageUnknown, { cpu: 2, mem: 2 });
  const tot = Object.fromEntries((out.get('') || []).map((r) => [r.metric, r.v]));
  assert.equal(tot.vm_mem_alloc_mb, 1500, '전체 합계도 같은 VM 집합');
  // 다 읽었으면 0
  const ok = vmAllocRows({ ...snap, vms: snap.vms.filter((v) => v.name === 'a' || v.name === 'c') }, ALL);
  assert.deepEqual(ok.vmUsageUnknown, { cpu: 0, mem: 0 });
});

test('VC-02 ③ samplerWithheldOf — 사용률 결측으로 뺀 VM 이 있으면 요약에 싣고, 없으면 기존 모양 그대로', async () => {
  const { samplerWithheldOf } = await import('../src/metrics/sampler.js');
  const w = samplerWithheldOf({ at: 1, rows: 3, vmUsageUnknown: { cpu: 0, mem: 2 } });
  assert.ok(w, '사용률 결측만 있어도 null 이 아니다(0 으로 채우지 않았다는 사실을 말한다)');
  assert.deepEqual(w.vmUsageUnknown, { cpu: 0, mem: 2 });
  assert.equal(samplerWithheldOf({ at: 1, rows: 3 }), null);
  assert.equal('vmUsageUnknown' in samplerWithheldOf({ at: 1, vmStorageUnknown: 1 }), false, '결측이 없으면 필드를 싣지 않는다(기존 요약 모양)');
});

/* ───────────────────────── VC-04 호스트 구성 선택 묶음 이어 싣기 ───────────────────────── */

const H6 = 6 * 3_600_000;
const T0 = Date.UTC(2026, 9, 15, 3, 30, 0);   // 고정 기준 시각(정시에서 떨어뜨림 — v2.517 규약)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostSettings = { hostCfgScan: true, hostCfgRefreshMs: H6, hostCfgPerCycle: 40 };
const MP = '<lun><id>L1</id><path><name>p1</name><pathState>active</pathState><lun>L1</lun><transport xsi:type="HostFibreChannelTargetTransport"></transport></path></lun>';
const VS = '<HostVirtualSwitch><name>vSwitch0</name><pnic>key-vim.host.PhysicalNic-vmnic0</pnic><portgroup>pg-1</portgroup></HostVirtualSwitch>';

/** 가짜 SOAP — bulkMs 는 첫 일괄 조회 지연, fail 은 { 경로: 'path'|'boom' } 으로 그 묶음을 실패시킨다. */
function hostClient({ bulkMs = 0, fail = {}, calls = [] } = {}) {
  return {
    async retrieveManyObjectProps(type, refs, paths) {
      calls.push(paths.join(','));
      if (type !== 'HostSystem') return refs.map((ref) => ({ ref, props: {} }));
      if (paths.includes('config.service')) {
        await sleep(bulkMs);
        return refs.map((ref) => ({ ref, props: { 'config.service': '<service><key>TSM-SSH</key><running>false</running></service>' } }));
      }
      for (const [k, how] of Object.entries(fail)) {
        if (paths.includes(k)) throw new Error(how === 'path' ? 'InvalidProperty: ' + k : 'socket hang up');
      }
      const props = {};
      if (paths.includes('config.lockdownMode')) props['config.lockdownMode'] = 'lockdownNormal';
      if (paths.includes('config.vsanHostConfig.enabled')) { props['config.vsanHostConfig.enabled'] = 'true'; props['runtime.vsanRuntimeInfo'] = '<membershipList>a</membershipList><membershipList>b</membershipList>'; }
      if (paths.includes('config.storageDevice.multipathInfo')) props['config.storageDevice.multipathInfo'] = MP;
      if (paths.includes('config.network.vswitch')) { props['config.network.vswitch'] = VS; props['config.network.portgroup'] = ''; props['config.network.proxySwitch'] = ''; }
      return refs.map((ref) => ({ ref, props: { ...props } }));
    },
    async callRaw() { return '<returnval></returnval>'; },
  };
}

test('VC-04 ① 예산 초과로 선택 묶음을 못 읽은 주기 — 직전 값을 지우지 않고 이어 싣고, 그 사실을 상태가 말한다', async () => {
  const hc = await import('../src/hostcfg/collect.js');
  const cache = await import('../src/hostcfg/cache.js');
  cache._resetHostCfgCache(); hc._resetHostCfgGaps();
  // 1) 예산 넉넉 — 네 묶음 모두 읽힌다
  const r1 = await hc.refreshHostCfg(hostClient(), 'vc4', ['host-1'], { settings: hostSettings, budgetMs: 10_000, now: T0 });
  const v1 = cache.get('vc4', 'host-1');
  assert.equal(r1.fetched, 1);
  assert.ok(v1.mp && v1.net && v1.vsan, `1회차에 묶음이 채워진다: ${JSON.stringify({ mp: v1.mp, net: v1.net, vsan: v1.vsan })}`);
  assert.equal(v1.lockdown, 'normal');
  assert.equal(r1.groupsSkipped, null);
  // 2) 갱신 주기 뒤 — 첫 일괄 조회(60ms)가 예산(30ms)을 넘겨 선택 묶음을 하나도 못 읽는다
  const calls = [];
  const r2 = await hc.refreshHostCfg(hostClient({ bulkMs: 60, calls }), 'vc4', ['host-1'], { settings: hostSettings, budgetMs: 30, now: T0 + 7 * 3_600_000 });
  assert.ok(!calls.some((x) => x.includes('multipathInfo')), '예산이 끝나 선택 묶음을 묻지 않았다(재현 조건)');
  const v2 = cache.get('vc4', 'host-1');
  assert.deepEqual(v2.mp, v1.mp, `멀티패스 직전 값이 null 로 덮이면 안 된다(예전: null): ${JSON.stringify(v2.mp)}`);
  assert.deepEqual(v2.net, v1.net);
  assert.deepEqual(v2.vsan, v1.vsan);
  assert.equal(v2.lockdown, 'normal');
  assert.ok(r2.groupsSkipped && r2.groupsSkipped['멀티패스'] === 1, `건너뛴 묶음을 밝힌다: ${JSON.stringify(r2)}`);
  assert.equal(r2.carried, 4);
  const st = cache.hostCfgStatus().vcenters.find((x) => x.vcenterId === 'vc4');
  assert.ok(st.groupsSkipped?.['잠금 모드'], '상태에도 싣는다(조용히 \'다 읽음\' 이라 말하지 않는다)');
  assert.ok(hc.groupGapOf('vc4', 'host-1'), '그 호스트를 묶음 재시도로 기록한다');
});

test('VC-04 ② 묶음을 못 읽은 호스트는 갱신 주기(6시간)를 기다리지 않고 재시도 시각에 다시 고른다 — 다 읽으면 기록을 지운다', async () => {
  const hc = await import('../src/hostcfg/collect.js');
  const cache = await import('../src/hostcfg/cache.js');
  cache._resetHostCfgCache(); hc._resetHostCfgGaps();
  const t1 = T0 + 7 * 3_600_000;
  // 처음부터 예산 부족 — 직전 값이 없으므로 묶음은 모름(null)으로 남는다(지어내지 않는다)
  await hc.refreshHostCfg(hostClient({ bulkMs: 60 }), 'vc5', ['host-1'], { settings: hostSettings, budgetMs: 30, now: t1 });
  assert.equal(cache.get('vc5', 'host-1').mp, null, '읽은 적이 없으면 null(모름)');
  // 30초 뒤 — 재시도 시각 전이라 고르지 않는다
  const r2 = await hc.refreshHostCfg(hostClient(), 'vc5', ['host-1'], { settings: hostSettings, budgetMs: 10_000, now: t1 + 30_000 });
  assert.equal(r2.due, 0);
  // 11분 뒤 — 갱신 주기(6시간) 전인데도 묶음 재시도로 다시 골라 채운다(예전: due 0 → 6시간 동안 null)
  const r3 = await hc.refreshHostCfg(hostClient(), 'vc5', ['host-1'], { settings: hostSettings, budgetMs: 10_000, now: t1 + 11 * 60_000 });
  assert.equal(r3.due, 1, `묶음 재시도로 골라야 한다: ${JSON.stringify(r3)}`);
  assert.equal(r3.gapRetry, 1);
  assert.ok(cache.get('vc5', 'host-1').mp, '이번에는 멀티패스를 읽었다');
  assert.equal(hc.groupGapOf('vc5', 'host-1'), null, '다 읽었으면 재시도 기록을 지운다');
  // 인벤토리에서 사라진 호스트의 재시도 기록은 정리한다
  await hc.refreshHostCfg(hostClient({ bulkMs: 60 }), 'vc5', ['host-9'], { settings: hostSettings, budgetMs: 30, now: t1 + 12 * 60_000 });
  assert.ok(hc.groupGapOf('vc5', 'host-9'));
  await hc.refreshHostCfg(hostClient(), 'vc5', [], { settings: hostSettings, budgetMs: 10_000, now: t1 + 13 * 60_000, allRefs: ['host-1'] });
  assert.equal(hc.groupGapOf('vc5', 'host-9'), null);
});

test('VC-04 ③ 일시 실패는 이어 싣고, 경로 오류(그 버전에 없는 경로)는 예전대로 모름(null) — 다시 묻지 않는다', async () => {
  const hc = await import('../src/hostcfg/collect.js');
  const cache = await import('../src/hostcfg/cache.js');
  cache._resetHostCfgCache(); hc._resetHostCfgGaps();
  await hc.refreshHostCfg(hostClient(), 'vc6', ['host-1'], { settings: hostSettings, budgetMs: 10_000, now: T0 });
  const v1 = cache.get('vc6', 'host-1');
  // 멀티패스 일시 실패(socket hang up) + 잠금 모드 경로 오류
  const r2 = await hc.refreshHostCfg(hostClient({ fail: { 'config.storageDevice.multipathInfo': 'boom', 'config.lockdownMode': 'path' } }), 'vc6', ['host-1'],
    { settings: hostSettings, budgetMs: 10_000, now: T0 + 7 * 3_600_000 });
  const v2 = cache.get('vc6', 'host-1');
  assert.deepEqual(v2.mp, v1.mp, '일시 실패한 묶음은 직전 값을 잇는다');
  assert.equal(v2.lockdown, null, '경로 오류는 그 버전에 없는 값 — 모름');
  assert.deepEqual(Object.keys(r2.groupsSkipped), ['멀티패스'], '경로 오류는 건너뜀으로 세지 않는다');
  assert.equal(cache.statusOf('vc6').noLockdownPath, true);
});

/* ───────────────────────── LEFT-03 스파크라인 vCenter 별 배치 ───────────────────────── */

const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => resolve(b)); });
const ENV = (inner) => '<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body>'
  + inner + '</soapenv:Body></soapenv:Envelope>';
const SC_XML = ENV('<RetrieveServiceContentResponse xmlns="urn:vim25"><returnval>'
  + '<rootFolder type="Folder">group-d1</rootFolder><propertyCollector type="PropertyCollector">propertyCollector</propertyCollector>'
  + '<viewManager type="ViewManager">ViewManager</viewManager><sessionManager type="SessionManager">SessionManager</sessionManager>'
  + '<perfManager type="PerformanceManager">PerfMgr</perfManager>'
  + '<about><version>8.0.2</version><build>1</build><fullName>VMware vCenter Server 8.0.2</fullName><apiVersion>8.0.2.0</apiVersion></about>'
  + '</returnval></RetrieveServiceContentResponse>');
const FAULT = (type, msg) => ENV(`<soapenv:Fault><faultcode>ServerFaultCode</faultcode><faultstring>${msg}</faultstring>`
  + `<detail><${type}Fault xmlns="urn:vim25" xsi:type="${type}"></${type}Fault></detail></soapenv:Fault>`);
const counterInfo = (key, group, name) => `<PerfCounterInfo><key>${key}</key><nameInfo><label>x</label><summary>x</summary><key>${name}</key></nameInfo>`
  + `<groupInfo><label>x</label><summary>x</summary><key>${group}</key></groupInfo><unitInfo><label>%</label><summary>x</summary><key>percent</key></unitInfo>`
  + '<rollupType>average</rollupType><statsType>rate</statsType><level>1</level></PerfCounterInfo>';
const CATALOG = ENV('<RetrievePropertiesResponse xmlns="urn:vim25"><returnval><obj type="PerformanceManager">PerfMgr</obj><propSet><name>perfCounter</name>'
  + `<val xsi:type="ArrayOfPerfCounterInfo">${counterInfo(6, 'cpu', 'usage')}${counterInfo(24, 'mem', 'usage')}</val></propSet></returnval></RetrievePropertiesResponse>`);
const TS = ['2026-10-08T00:00:00Z', '2026-10-08T00:30:00Z', '2026-10-08T01:00:00Z', '2026-10-08T01:30:00Z', '2026-10-08T02:00:00Z'];
// VM·카운터마다 결정적 값 — 배치로 묻든 하나씩 묻든 같은 값이어야 한다. vm-2 의 셋째 표본은 -1(결측).
const valOf = (ref, cid, i) => (ref === 'vm-2' && i === 2 ? -1 : ((Number(String(ref).replace(/\D/g, '')) * 997 + Number(cid) * 31 + i * 137) % 9000) + 100);
const entityXml = (ref, cids) => `<returnval xsi:type="PerfEntityMetric"><entity type="VirtualMachine">${ref}</entity>`
  + TS.map((t) => `<sampleInfo><timestamp>${t}</timestamp><interval>1800</interval></sampleInfo>`).join('')
  + cids.map((cid) => `<value xsi:type="PerfMetricIntSeries"><id><counterId>${cid}</counterId><instance></instance></id>`
    + TS.map((_, i) => `<value>${valOf(ref, cid, i)}</value>`).join('') + '</value>').join('')
  + '</returnval>';

/** 가짜 vCenter — 로그인·카탈로그·QueryPerf(여러 querySpec)·로그아웃. 삭제된 VM(vm-404)이 섞인 QueryPerf 는 통째로 fault. */
async function fakePerfVcenter() {
  const st = { logins: 0, queryPerf: 0, specs: [] };
  const srv = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const send = (code, xml) => { res.writeHead(code, { 'content-type': 'text/xml' }); res.end(xml); };
    if (req.url !== '/sdk') { res.writeHead(404); return res.end(); }
    if (body.includes('<RetrieveServiceContent')) return send(200, SC_XML);
    if (body.includes('<Login ')) { st.logins += 1; return send(200, ENV('<LoginResponse xmlns="urn:vim25"><returnval><key>s1</key><userName>u</userName></returnval></LoginResponse>')); }
    if (body.includes('<Logout ')) return send(200, ENV('<LogoutResponse xmlns="urn:vim25"></LogoutResponse>'));
    if (body.includes('<RetrieveProperties') && body.includes('PerformanceManager')) return send(200, CATALOG);
    if (body.includes('<QueryPerf ')) {
      st.queryPerf += 1;
      const specs = [...body.matchAll(/<querySpec>([\s\S]*?)<\/querySpec>/g)].map((m) => ({
        ref: /<entity type="VirtualMachine">([^<]+)<\/entity>/.exec(m[1])?.[1],
        cids: [...m[1].matchAll(/<counterId>(\d+)<\/counterId>/g)].map((x) => x[1]),
      }));
      st.specs.push(specs.length);
      if (specs.some((s) => s.ref === 'vm-404')) return send(500, FAULT('ManagedObjectNotFound', 'The object has already been deleted or has not been completely created'));
      return send(200, ENV(`<QueryPerfResponse xmlns="urn:vim25">${specs.map((s) => entityXml(s.ref, s.cids)).join('')}</QueryPerfResponse>`));
    }
    return send(500, FAULT('NotSupported', 'not supported in this fake'));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  return { host: `http://127.0.0.1:${srv.address().port}`, st };
}

test('LEFT-03 ① fetchVmsPerfSeries — 로그인 1회로 여러 VM 을 받고, 점은 단건 경로(fetchVmMetric)와 같다(-1 은 null)', async () => {
  const { fetchVmMetric, fetchVmsPerfSeries } = await import('../src/vcenter/soapClient.js');
  const fv = await fakePerfVcenter();
  const vc = { id: 'vc-eq', name: 'VC-EQ', host: fv.host, username: 'u', password: 'p', enabled: true, timeoutMs: 5000 };
  const refs = ['vm-1', 'vm-2', 'vm-3', 'vm-17'];
  for (const type of ['cpu', 'mem']) {
    const single = {};
    for (const ref of refs) single[ref] = (await fetchVmMetric(vc, ref, type, 'week')).points;
    const before = fv.st.logins;
    const batch = await fetchVmsPerfSeries(vc, refs, type, 'week', { chunkSize: 3 });
    assert.equal(fv.st.logins - before, 1, `배치는 vCenter 당 로그인 1회: ${fv.st.logins - before}`);
    for (const ref of refs) assert.deepEqual(batch.points.get(ref), single[ref], `${type} ${ref} — 단건 경로와 같은 점`);
    assert.equal(batch.errors.size, 0);
  }
  assert.equal(fetchVmsPerfSeries.length >= 3, true);
  const p2 = (await fetchVmsPerfSeries(vc, ['vm-2'], 'cpu', 'week')).points.get('vm-2');
  assert.equal(p2[2].v, null, 'vCenter 결측(-1)은 0 이 아니라 null');
  assert.equal(p2.length, TS.length);
});

test('LEFT-03 ② 삭제된 VM 이 섞인 청크는 같은 세션에서 하나씩 다시 묻는다 — 그 VM 만 실패, 로그인은 1회', async () => {
  const { fetchVmsPerfSeries } = await import('../src/vcenter/soapClient.js');
  const fv = await fakePerfVcenter();
  const vc = { id: 'vc-del', name: 'VC-DEL', host: fv.host, username: 'u', password: 'p', enabled: true, timeoutMs: 5000 };
  const r = await fetchVmsPerfSeries(vc, ['vm-1', 'vm-404', 'vm-3'], 'cpu', 'week');
  assert.equal(fv.st.logins, 1);
  assert.ok(r.points.get('vm-1')?.length && r.points.get('vm-3')?.length, '다른 VM 은 값이 있다');
  assert.ok(r.errors.has('vm-404'), '삭제된 VM 만 오류');
  assert.equal(r.points.has('vm-404'), false);
});

test('LEFT-03 ③ /tools/waste/spark — 자격증명이 맞아도 VM 마다가 아니라 vCenter 마다 로그인 1회 · 값은 예전과 같은 모양', async () => {
  const fvA = await fakePerfVcenter();
  const fvB = await fakePerfVcenter();
  fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [
    { id: 'vc-a', name: 'VC-A', host: fvA.host, username: 'u', password: 'p', enabled: true, timeoutMs: 5000 },
    { id: 'vc-b', name: 'VC-B', host: fvB.host, username: 'u', password: 'p', enabled: true, timeoutMs: 5000 },
  ] }));
  const { store } = await import('../src/store.js');
  const mk = (vcId, n) => ({ id: `${vcId}:vm-${n}`, vcenterId: vcId, name: `${vcId}-g${n}`, powerState: 'POWERED_ON', cpuUsagePct: 10, memUsagePct: 20, cpuCount: 2, memMB: 4096 });
  const vmsA = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => mk('vc-a', n));
  const vmsB = [...[1, 2, 3].map((n) => mk('vc-b', n)), mk('vc-b', 404)];
  store.snapshot = { ...(store.get() || {}), source: 'live', generatedAt: new Date().toISOString(),
    vcenters: [{ id: 'vc-a', name: 'VC-A', status: 'connected' }, { id: 'vc-b', name: 'VC-B', status: 'connected' }],
    vms: [...vmsA, ...vmsB], hosts: [], datastores: [], networks: [], alarms: [] };
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const ids = [...vmsA, ...vmsB].map((v) => v.id);
  const post = async (body) => (await fetch(`${base}/api/tools/waste/spark`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();

  const j = await post({ vmIds: ids, type: 'cpu' });
  assert.equal(fvA.st.logins, 1, `vCenter A 는 VM 10대인데 로그인 1회여야 한다(예전 10회): ${fvA.st.logins}`);
  assert.equal(fvB.st.logins, 1, `vCenter B 도 1회: ${fvB.st.logins}`);
  assert.deepEqual(j.authStopped, {});
  // 값 모양 — 예전과 같다: { t, v } 배열에 null 점은 빠진다. 단건 경로 값과 대조.
  const { fetchVmMetric } = await import('../src/vcenter/soapClient.js');
  const singleA2 = (await fetchVmMetric({ id: 'vc-a', host: fvA.host, username: 'u', password: 'p', timeoutMs: 5000 }, 'vm-2', 'cpu', 'week')).points
    .filter((p) => p.v != null).map((p) => ({ t: p.t, v: p.v }));
  assert.deepEqual(j.series['vc-a:vm-2'], singleA2, '스파크 점 = 단건 경로 점(null 제외)');
  assert.equal(j.series['vc-a:vm-2'].length, TS.length - 1, '결측 1점은 빠진다');
  assert.equal(j.series['vc-b:vm-404'], null, '삭제된 VM 만 null');
  for (const v of vmsB.slice(0, 3)) assert.ok(Array.isArray(j.series[v.id]) && j.series[v.id].length >= TS.length - 1, `${v.id} 는 값이 있다(같은 청크의 삭제된 VM 때문에 비지 않는다)`);
  // 다시 열면 캐시 — 로그인 0 · 실패한 VM 은 캐시하지 않아 다시 묻는다(B 만 1회)
  const a0 = fvA.st.logins; const b0 = fvB.st.logins;
  const j2 = await post({ vmIds: ids, type: 'cpu' });
  assert.equal(fvA.st.logins - a0, 0, '성공한 VM 은 5분 캐시');
  assert.equal(fvB.st.logins - b0, 1, '실패한 VM(vm-404)만 다시 묻는다 — 그 vCenter 로그인 1회');
  assert.deepEqual(j2.series['vc-a:vm-2'], singleA2);
});
