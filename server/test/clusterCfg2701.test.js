// v2.701 — 클러스터 HA·DRS(A6) · 호스트 네트워크(A10) 수집·판정·엣지 정제.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClusterCfgProps, parseRules, clusterCfgFindings, sanitizeClusterCfgList, CLUSTER_CFG_PATHS } from '../src/clustercfg/parse.js';
import { refreshClusterCfg, getClusterCfg, _resetClusterCfg } from '../src/clustercfg/collect.js';
import { analyzeClusters, clusterOf } from '../src/clustercfg/analyze.js';
import { parseNetwork, hostCfgFindings, sanitizeHostCfg, clusterDrift, parseHostCfgProps, HOST_NET_PATHS } from '../src/hostcfg/parse.js';
import { refreshHostCfg } from '../src/hostcfg/collect.js';
import { get as hostGet, _resetHostCfgCache } from '../src/hostcfg/cache.js';

const NOW = 1_800_000_000_000;
const CFG = `<dasConfig><enabled>true</enabled><vmMonitoring>vmMonitoringDisabled</vmMonitoring><hostMonitoring>disabled</hostMonitoring>
<admissionControlEnabled>false</admissionControlEnabled><defaultVmSettings><vmToolsMonitoringSettings><enabled>false</enabled></vmToolsMonitoringSettings></defaultVmSettings></dasConfig>
<dasVmConfig><key type="VirtualMachine">vm-9</key></dasVmConfig>
<drsConfig><enabled>true</enabled><enableVmBehaviorOverrides>true</enableVmBehaviorOverrides><defaultVmBehavior>manual</defaultVmBehavior></drsConfig>
<rule xsi:type="ClusterAntiAffinityRuleSpec"><key>1</key><enabled>true</enabled><name>db &amp; anti</name><mandatory>false</mandatory><inCompliance>false</inCompliance><vm type="VirtualMachine">vm-1</vm><vm type="VirtualMachine">vm-2</vm></rule>
<rule xsi:type="ClusterVmHostRuleInfo"><key>2</key><enabled>false</enabled><name>pin</name><vmGroupName>g</vmGroupName></rule>
<drsVmConfig><key type="VirtualMachine">vm-3</key></drsVmConfig>`;
const SUM = '<numHosts>3</numHosts><numEffectiveHosts>2</numEffectiveHosts>';

test('① 클러스터 파서 — HA 의 첫 enabled 만, DRS, 규칙(xsi 종류·VM 참조·XML 이스케이프), EVC 없음 = 꺼짐(\'\')', () => {
  const c = parseClusterCfgProps('domain-c7', { name: 'CL1', configurationEx: CFG, summary: SUM }, NOW);
  assert.deepEqual(c.ha, { enabled: true, admission: false, hostMon: 'disabled', vmMon: 'vmMonitoringDisabled' });
  assert.deepEqual(c.drs, { enabled: true, behavior: 'manual' });
  assert.equal(c.rulesTotal, 2);
  assert.deepEqual(c.rules[0], { name: 'db & anti', type: 'anti-affinity', enabled: true, inCompliance: false, mandatory: false, vms: ['vm-1', 'vm-2'] });
  assert.equal(c.rules[1].type, 'vm-host');
  assert.equal(c.rules[1].inCompliance, null, '보고되지 않은 준수 여부는 null(준수로 칠하지 않는다)');
  assert.equal(c.evc, '');
  assert.equal(c.numHosts, 3); assert.equal(c.numEffectiveHosts, 2);
  const e = parseClusterCfgProps('domain-c8', { name: 'CL2' }, NOW);
  assert.equal(e.ha, null); assert.equal(e.drs, null); assert.equal(e.evc, null, 'summary 를 못 읽으면 EVC 는 모름');
  assert.equal(e.rulesTotal, null); assert.equal(e.numHosts, null);
  assert.ok(CLUSTER_CFG_PATHS.includes('configurationEx'));
  // <ruleX> 같은 다른 태그를 규칙으로 읽지 않는다
  assert.equal(parseRules('<rules><enabled>true</enabled></rules>').rulesTotal, 0);
  const mixed = parseRules('<rules><enabled>true</enabled></rules><rule xsi:type="ClusterAffinityRuleSpec"><name>a</name></rule>');
  assert.equal(mixed.rulesTotal, 1); assert.equal(mixed.rules[0].enabled, null, '<rules> 의 enabled 를 규칙 값으로 읽지 않는다');
});

test('② 클러스터 판정 — HA·수용 제어·호스트 모니터링·유효 호스트·규칙·DRS·EVC 혼재, 단일 호스트는 그것 하나', () => {
  const c = parseClusterCfgProps('domain-c7', { name: 'CL1', configurationEx: CFG, summary: SUM }, NOW);
  const hosts = [{ cpuModel: 'Xeon Gold 6248' }, { cpuModel: 'Xeon Gold 6348' }, { cpuModel: 'Xeon Gold 6348', connectionState: 'DISCONNECTED' }];
  assert.deepEqual(clusterCfgFindings(c, hosts).map((f) => f.code),
    ['ha-ac-off', 'ha-hostmon-off', 'hosts-ineffective', 'drs-manual', 'rule-violation', 'rule-disabled', 'evc-off-mixed']);
  assert.deepEqual(clusterCfgFindings({ ...c, ha: { enabled: false, admission: false, hostMon: 'disabled' } }, hosts).map((f) => f.code)[0], 'ha-off', 'HA 꺼짐이면 수용 제어·모니터링을 따로 말하지 않는다');
  assert.ok(!clusterCfgFindings({ ...c, ha: { enabled: false } }, hosts).some((f) => f.code === 'ha-ac-off'));
  assert.deepEqual(clusterCfgFindings({ ...c, numHosts: 1 }, hosts).map((f) => f.code), ['single-host']);
  assert.ok(!clusterCfgFindings({ ...c, evc: 'intel-skylake' }, hosts).some((f) => f.code === 'evc-off-mixed'));
  assert.ok(!clusterCfgFindings({ ...c, evc: null }, hosts).some((f) => f.code === 'evc-off-mixed'), 'EVC 를 모르면 판정하지 않는다');
  assert.ok(!clusterCfgFindings(c, [hosts[0], hosts[2]]).some((f) => f.code === 'evc-off-mixed'), '끊긴 호스트의 CPU 는 비교하지 않는다');
  assert.deepEqual(clusterCfgFindings({ ...c, ha: { enabled: null, admission: false, hostMon: 'disabled' }, drs: null, rules: [], numHosts: null, numEffectiveHosts: null, evc: null }, hosts), [], 'HA 를 켰는지 모르면 수용 제어·모니터링도 판정하지 않는다');
  assert.deepEqual(clusterCfgFindings({ ...c, ha: null, drs: null, rules: [], numHosts: null, numEffectiveHosts: null, evc: null }, hosts), [], '못 읽은 값은 판정하지 않는다');
});

test('③ 수집 — 오래된 것부터 상한·청크 5·prune·InvalidProperty 면 그 주기만큼 쉼', async () => {
  _resetClusterCfg();
  const calls = [];
  const c = { retrieveManyObjectProps: async (type, refs, paths) => { calls.push({ type, refs: [...refs], paths }); return refs.map((r) => ({ ref: r, props: { name: r, configurationEx: CFG, summary: SUM } })); } };
  const S = { clusterCfgScan: true, clusterCfgRefreshMs: 1_800_000, clusterCfgPerCycle: 7 };
  const refs = Array.from({ length: 9 }, (_, i) => `domain-c${i}`);
  const r = await refreshClusterCfg(c, 'vc1', refs, { now: NOW, settings: S });
  assert.equal(r.fetched, 7);
  assert.deepEqual(calls.map((x) => x.refs.length), [5, 2]);
  assert.equal(calls[0].type, 'ClusterComputeResource');
  await refreshClusterCfg(c, 'vc1', refs, { now: NOW + 1000, settings: S });
  assert.deepEqual(calls.slice(2).map((x) => x.refs), [['domain-c7', 'domain-c8']], '남은 것만');
  await refreshClusterCfg(c, 'vc1', ['domain-c1'], { now: NOW + 2000, settings: S });
  assert.equal(getClusterCfg('vc1', 'domain-c0'), null, '인벤토리에서 사라진 클러스터는 지운다');
  assert.ok(getClusterCfg('vc1', 'domain-c1'));
  _resetClusterCfg();
  const bad = { retrieveManyObjectProps: async () => { throw new Error('InvalidProperty: configurationEx'); } };
  assert.match((await refreshClusterCfg(bad, 'vc2', ['domain-c1'], { now: NOW, settings: S })).error, /InvalidProperty/);
  assert.equal((await refreshClusterCfg(bad, 'vc2', ['domain-c1'], { now: NOW + 1000, settings: S })).skipped, 'backoff');
  assert.equal((await refreshClusterCfg(bad, 'vc2', ['domain-c1'], { now: NOW, settings: { ...S, clusterCfgScan: false } })).skipped, 'off');
});

test('④ 분석 — 미수집 클러스터는 판정 없이 센다 · vCenter 이름 · VM 이 든 규칙(콜론 있는 vCenter id)', () => {
  const cfg = parseClusterCfgProps('domain-c7', { name: 'CL1', configurationEx: CFG, summary: SUM }, NOW);
  const vcs = [{ id: 'vc:a', name: 'VC A', clusterCfg: [cfg] }, { id: 'vc-b', name: 'VC B' }];
  const hosts = [{ vcenterId: 'vc:a', cluster: 'CL1' }, { vcenterId: 'vc:a', cluster: 'cl1' }, { vcenterId: 'vc-b', cluster: 'X' }, { vcenterId: 'vc-b', cluster: 'standalone' }];
  const r = analyzeClusters(vcs, hosts);
  assert.deepEqual(r.coverage, { clusters: 2, cfg: 1, notCollected: 1 });
  const x = r.rows.find((z) => z.name === 'X');
  assert.equal(x.collected, false); assert.deepEqual(x.findings, []); assert.equal(x.sev, null);
  const a = r.rows.find((z) => z.name === 'CL1');
  assert.equal(a.hosts, 2, '대소문자만 다른 클러스터 이름은 같은 클러스터');
  assert.equal(r.byCode['rule-violation'].clusters, 1);
  assert.equal(r.totals.rulesViolated, 1);
  assert.equal(r.rows[0].name, 'CL1', '판정 있는 클러스터가 먼저');
  const of = clusterOf(vcs, hosts, 'vc:a', 'CL1', 'vc:a:vm-2');
  assert.deepEqual(of.vmRules.map((z) => z.name), ['db & anti']);
  assert.equal(clusterOf(vcs, hosts, 'vc:a', 'CL1', null).vmRules, null);
  assert.equal(clusterOf(vcs, hosts, 'vc-b', 'X').reason, 'not-collected');
  assert.equal(clusterOf(vcs, hosts, 'vc-b', 'standalone').reason, 'standalone');
  assert.equal(analyzeClusters(vcs, hosts, { code: 'ha-off' }).rows.length, 0);
});

test('⑤ 엣지 정제 — 아는 필드만·상한·비객체 원소는 버리고 센다', () => {
  const cfg = parseClusterCfgProps('domain-c7', { name: 'CL1', configurationEx: CFG, summary: SUM }, NOW);
  const r = sanitizeClusterCfgList([{ ...cfg, evil: { x: 1 }, rules: [...cfg.rules, null, 'x'] }, null, 'str', { name: 'noref' }]);
  assert.equal(r.value.length, 1); assert.equal(r.dropped, 3);
  assert.equal(r.value[0].evil, undefined);
  assert.equal(r.value[0].rules.length, 2);
  assert.deepEqual(sanitizeClusterCfgList({ a: 1 }), { value: null, dropped: 1 });
  const big = sanitizeClusterCfgList([{ ref: 'r', ha: { enabled: 'true' }, rules: [{ name: 'n', type: 'evil', vms: [1, 'vm-1'] }] }]);
  assert.equal(big.value[0].ha.enabled, null, '문자열 true 는 불리언이 아니다');
  assert.equal(big.value[0].rules[0].type, 'other');
  assert.deepEqual(big.value[0].rules[0].vms, ['vm-1']);
});

const VSW = (name, pnics, pgs) => `<HostVirtualSwitch xsi:type="HostVirtualSwitch"><name>${name}</name>${pgs.map((p) => `<portgroup>key-vim.host.PortGroup-${p}</portgroup>`).join('')}${pnics.map((n) => `<pnic>key-vim.host.PhysicalNic-${n}</pnic>`).join('')}<spec><numPorts>128</numPorts><bridge xsi:type="HostVirtualSwitchBondBridge"><nicDevice>vmnic9</nicDevice></bridge></spec></HostVirtualSwitch>`;
const PG = (name, vlan, sw, promisc) => `<HostPortGroup xsi:type="HostPortGroup"><key>key-vim.host.PortGroup-${name}</key><port><key>p</key><mac>00:50</mac></port><vswitch>key-vim.host.VirtualSwitch-${sw}</vswitch><computedPolicy><security><allowPromiscuous>${promisc}</allowPromiscuous><macChanges>true</macChanges><forgedTransmits>true</forgedTransmits></security></computedPolicy><spec><name>${name}</name><vlanId>${vlan}</vlanId><vswitchName>${sw}</vswitchName><policy/></spec></HostPortGroup>`;
const PROXY = '<HostProxySwitch xsi:type="HostProxySwitch"><dvsUuid>u</dvsUuid><dvsName>DS-Prod</dvsName><key>k</key><pnic>key-vim.host.PhysicalNic-vmnic2</pnic><spec><backing><pnicSpec><pnicDevice>vmnic2</pnicDevice></pnicSpec></backing></spec></HostProxySwitch>';

test('⑥ 네트워크 파서 — 업링크는 스위치 직속 pnic(브리지 nicDevice 아님)·유효 정책의 무차별·분산 스위치 이름', () => {
  const n = parseNetwork(VSW('vSwitch0', ['vmnic0', 'vmnic1'], ['VM']) + VSW('vSwitch1', [], []), PG('VM', 10, 'vSwitch0', 'false') + PG('Mon', 4095, 'vSwitch0', 'true'), PROXY);
  assert.deepEqual(n.switches, [
    { name: 'vSwitch0', kind: 'vss', uplinks: ['vmnic0', 'vmnic1'], pgs: 1 },
    { name: 'vSwitch1', kind: 'vss', uplinks: [], pgs: 0 },
    { name: 'DS-Prod', kind: 'dvs', uplinks: ['vmnic2'], pgs: null },
  ]);
  assert.deepEqual(n.pgs, [{ name: 'VM', vlan: 10, sw: 'vSwitch0', promisc: false }, { name: 'Mon', vlan: 4095, sw: 'vSwitch0', promisc: true }]);
  assert.equal(n.pgsTotal, 2);
  assert.equal(parseNetwork(undefined, undefined, undefined), null);
  assert.equal(parseHostCfgProps({}, NOW).net, null, '경로를 읽지 않았으면 null(모름)');
  assert.ok(parseHostCfgProps({ [HOST_NET_PATHS[0]]: '' }, NOW).net, '빈 응답은 읽은 것(스위치 없음)');
});

test('⑦ 네트워크 판정 — 단일 업링크(쓰는 스위치만)·업링크 없음·링크 다운(NIC 를 알 때만)·무차별', () => {
  const n = parseNetwork(VSW('vSwitch0', ['vmnic0'], ['VM']) + VSW('vIdle', ['vmnic5'], []) + VSW('vInt', [], ['I']), PG('VM', 10, 'vSwitch0', 'true'), PROXY);
  const host = { connectionState: 'CONNECTED', nics: [{ device: 'vmnic2', link: false }], hcfg: { net: n } };
  const f = hostCfgFindings(host, NOW);
  assert.deepEqual(f.map((x) => x.code), ['net-single-uplink', 'net-no-uplink', 'net-uplink-down', 'net-promisc']);
  assert.deepEqual(f[0].facts.switches, ['vSwitch0', 'DS-Prod'], '포트그룹 없는 vIdle 은 빼고, 분산 스위치는 쓰는 것으로 본다');
  assert.deepEqual(f[2].facts.list, ['DS-Prod/vmnic2']);
  assert.ok(!hostCfgFindings({ ...host, nics: undefined }, NOW).some((x) => x.code === 'net-uplink-down'), 'NIC 상태를 모르면 판정하지 않는다');
});

test('⑧ 포트그룹 드리프트 — 잘린 목록끼리는 비교하지 않는다', () => {
  const mk = (id, pgs, total = pgs.length) => ({ id, vcenterId: 'v', cluster: 'C', hcfg: { net: { switches: [], pgs, pgsTotal: total } } });
  const a = [{ name: 'VM', vlan: 10 }]; const b = [{ name: 'VM', vlan: 20 }];
  const d = clusterDrift([mk('h1', a), mk('h2', a), mk('h3', b)]);
  assert.equal(d.perHost.get('h3')[0].field, 'portgroups');
  assert.equal(clusterDrift([mk('h1', a), mk('h2', a), mk('h3', b, 300)]).perHost.size, 0);
});

test('⑨ 호스트 수집 — 네트워크 선택 묶음이 InvalidProperty 면 그 묶음만 모름', async () => {
  _resetHostCfgCache();
  const c = {
    retrieveManyObjectProps: async (type, refs, paths) => {
      if (paths.includes(HOST_NET_PATHS[0])) throw new Error('InvalidProperty: config.network.proxySwitch');
      return refs.map((r) => ({ ref: r, props: {} }));
    },
    callRaw: async () => '',
  };
  const S = { hostCfgScan: true, hostCfgRefreshMs: 21_600_000, hostCfgPerCycle: 40 };
  await refreshHostCfg(c, 'vcN', ['host-1'], { now: NOW, settings: S });
  const h = hostGet('vcN', 'host-1');
  assert.ok(h); assert.equal(h.net, null);
  _resetHostCfgCache();
  const ok = {
    retrieveManyObjectProps: async (type, refs, paths) => refs.map((r) => ({ ref: r, props: paths.includes(HOST_NET_PATHS[0]) ? { [HOST_NET_PATHS[0]]: VSW('vs0', ['vmnic0'], ['VM']), [HOST_NET_PATHS[1]]: '', [HOST_NET_PATHS[2]]: '' } : {} })),
    callRaw: async () => '',
  };
  await refreshHostCfg(ok, 'vcN', ['host-1'], { now: NOW, settings: S });
  assert.deepEqual(hostGet('vcN', 'host-1').net.switches.map((x) => x.name), ['vs0'], '네트워크 묶음을 읽으면 net 이 채워진다');
});

test('⑩ 호스트 정제 — 네트워크 아는 필드만·NIC 이름 형식', () => {
  const s = sanitizeHostCfg({ net: { switches: [{ name: 'vs', kind: 'evil', uplinks: ['vmnic0', 'a b', 3], pgs: -1 }, null], pgs: [{ name: 'p', vlan: '10', promisc: 'true' }], pgsTotal: 1 } });
  assert.deepEqual(s.net, { switches: [{ name: 'vs', kind: 'vss', uplinks: ['vmnic0'], pgs: null }], pgs: [{ name: 'p', vlan: null, sw: null, promisc: null }], pgsTotal: 1 });
});

test('⑪ 엣지 수신 — routes/central.js 가 vcenter.clusterCfg 를 정제한다(소스)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/routes/central.js', import.meta.url), 'utf8');
  assert.match(src, /vcenter\.clusterCfg = cc\.value/);
  assert.match(src, /sanitizeClusterCfgList\(vcenter\.clusterCfg\)/);
});
