// v3.6.0 IP 관리 재설계 묶음 다 — 서버 보기(서비스 태그) · 호스트명 대조 · vmk 전체 파싱 · 스캔 대역 후보(ESXi).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseVmks, hostDnsName } from '../src/vcenter/soapClient.js';
import { hostVmks, buildServerIndex, serverViewFor, compareNames, hostNameRows, hostNameSummary } from '../src/ipam/serverView.js';
import { serverInputs } from '../src/routes/api/ipamServer.js';
import { stripComments } from './_stripComments.js';

test('v3.6.0 parseVmks — IPv4 만 · ipV6Config 안 주소는 읽지 않음 · 포트그룹은 vnic 의 것(spec 안 것 아님)', () => {
  const x = '<HostVirtualNic><device>vmk0</device><portgroup>Management Network</portgroup><spec><ip><ipAddress>10.1.2.3</ipAddress><subnetMask>255.255.255.0</subnetMask>'
    + '<ipV6Config><ipV6Address><ipAddress>fe80::1</ipAddress></ipV6Address></ipV6Config></ip><portgroup>X</portgroup></spec></HostVirtualNic>'
    + '<HostVirtualNic><device>vmk1</device><spec><ip><dhcp>true</dhcp><ipV6Config><ipV6Address><ipAddress>10.9.9.9</ipAddress></ipV6Address></ipV6Config></ip></spec></HostVirtualNic>'
    + '<HostVirtualNic><device>vmk2</device><spec><ip><ipAddress>172.16.0.9</ipAddress><subnetMask>bad</subnetMask></ip></spec></HostVirtualNic>';
  assert.deepEqual(parseVmks(x), [
    { dev: 'vmk0', ip: '10.1.2.3', mask: '255.255.255.0', pg: 'Management Network' },
    { dev: 'vmk2', ip: '172.16.0.9', mask: '', pg: '' },
  ]);
  assert.deepEqual(parseVmks(''), []);
  assert.deepEqual(hostDnsName('<hostName>esx01</hostName><domainName>corp.local</domainName>'), { osHostName: 'esx01', osDomain: 'corp.local' });
  assert.deepEqual(hostDnsName(null), { osHostName: null, osDomain: null }, '못 읽음은 null(빈 이름을 지어내지 않는다)');
});

test('v3.6.0 수집기 — vmks · ESXi 호스트명은 같은 조회의 속성(왕복 추가 없음)', () => {
  const src = fs.readFileSync(new URL('../src/vcenter/soapClient.js', import.meta.url), 'utf8');
  const paths = src.slice(src.indexOf("{ type: 'HostSystem', paths: ["), src.indexOf("{ type: 'ResourcePool'"));
  assert.match(paths, /'config\.network\.vnic'/); assert.match(paths, /'config\.network\.dnsConfig'/);
  assert.match(src, /vmks: parseVmks\(p\['config\.network\.vnic'\]\)/);
  assert.match(src, /\.\.\.hostDnsName\(p\['config\.network\.dnsConfig'\]\)/);
});

test('v3.6.0 hostVmks — 엣지 값 다시 자르기 · 옛 수집기는 관리 IP 하나로 대신(fromMgmt)', () => {
  assert.deepEqual(hostVmks({ vmks: [{ dev: 'vmk0', ip: '10.0.0.1' }, { ip: '10.0.0.1' }, { ip: 'x' }, null, 'str'] }), [{ dev: 'vmk0', ip: '10.0.0.1', mask: '', pg: '' }]);
  assert.deepEqual(hostVmks({ mgmtIp: '10.0.0.7' }), [{ dev: '', ip: '10.0.0.7', mask: '', pg: '', fromMgmt: true }]);
  assert.deepEqual(hostVmks({ mgmtIp: 'esx01.corp' }), []);
  assert.equal(hostVmks({ vmks: Array.from({ length: 80 }, (_, i) => ({ ip: `10.0.${i}.1` })) }).length, 32, '상한');
});

const H = (o) => ({ id: `vc1:${o.name}`, vcenterId: 'vc1', powerState: 'POWERED_ON', ...o });
function fixture() {
  const hosts = [
    H({ name: 'esx01.corp', serviceTag: 'TAG1', vmks: [{ dev: 'vmk0', ip: '10.0.0.11', pg: 'Mgmt' }, { dev: 'vmk1', ip: '172.20.0.11', pg: 'vMotion' }], osHostName: 'esx01', osDomain: 'corp' }),
    H({ name: 'esx02', serviceTag: 'DUP', vmks: [{ dev: 'vmk0', ip: '10.0.0.12' }] }),
    H({ name: 'esx03', serviceTag: 'DUP', vmks: [{ dev: 'vmk0', ip: '10.0.0.13' }] }),
    H({ name: 'esx04', serviceTag: '', vmks: [{ dev: 'vmk0', ip: '10.0.0.14' }], osHostName: 'esx04-old' }),
  ];
  const vms = [
    { id: 'vm-1', vcenterId: 'vc1', host: 'esx01.corp', name: 'APP01', ipAddresses: ['10.1.0.5', '10.1.0.6'], dns: { stack: { hostName: 'app01' } } },
    { id: 'vm-2', vcenterId: 'vc1', host: 'esx01.corp', name: 'DB01', ipAddress: '10.1.0.7', dns: null },
    { id: 'vm-3', vcenterId: 'vc2', host: 'esx01.corp', name: 'OTHERVC', ipAddresses: ['10.9.0.1'] }, // 다른 vCenter 의 같은 이름 호스트 — 잇지 않는다
  ];
  const servers = [
    { id: 's1', host: 'https://10.0.100.11', serviceTag: 'tag1', hostName: 'esx01.corp' },
    { id: 's2', host: '10.0.100.12', serviceTag: 'DUP', hostName: 'esx02' },
    { id: 's4', host: '10.0.100.14', serviceTag: '', name: 'esx04' },                 // 태그 없는 호스트 ↔ 이름 하나로 연결
    { id: 'b1', host: '10.0.100.50', serviceTag: 'BM1', hostName: 'web-bm01' },        // 물리 서버
  ];
  return { hosts, vms, servers };
}

test('v3.6.0 buildServerIndex — 태그 연결 · 겹친 태그는 묶지 않음 · 태그 없는 호스트는 이름이 하나일 때만 · 물리 서버 OS 주소', () => {
  const f = fixture();
  const idx = buildServerIndex({ ...f, osEntryOf: (s) => (s.id === 'b1' ? { host: '10.0.200.50' } : null), vcName: { vc1: 'VC-KR1' } });
  const e1 = idx.recs.get('st:TAG1');
  assert.equal(e1.kind, 'esxi'); assert.equal(e1.idrac.ip, '10.0.100.11'); assert.equal(e1.linkBy, 'tag'); assert.equal(e1.vcenterName, 'VC-KR1');
  assert.deepEqual(e1.vms.map((v) => v.name), ['APP01', 'DB01'], '다른 vCenter 의 같은 이름 호스트 VM 은 넣지 않는다');
  assert.equal(idx.recs.has('st:DUP'), false, '호스트 둘이 같은 태그 — 그 태그로 묶지 않는다');
  assert.ok(idx.recs.get('h:vc1:esx02').tagShared);
  assert.equal(idx.recs.get('h:vc1:esx02').idrac.id, 's2', '겹친 태그 — 그 태그의 iDRAC 중 이름이 같은 하나로만 잇는다');
  assert.equal(idx.recs.get('h:vc1:esx02').linkBy, 'name');
  assert.equal(idx.recs.get('h:vc1:esx03').idrac, null);
  assert.equal(idx.recs.get('h:vc1:esx04').idrac.id, 's4'); assert.equal(idx.recs.get('h:vc1:esx04').linkBy, 'name');
  const bm = idx.recs.get('st:BM1');
  assert.equal(bm.kind, 'bm'); assert.equal(bm.osAddr.ip, '10.0.200.50'); assert.equal(bm.name, 'web-bm01');
  assert.equal(idx.recs.has('i:s2'), false, '호스트가 보고한 태그의 iDRAC 은 물리 서버로 세지 않는다');
  const lone = buildServerIndex({ ...f, servers: [...f.servers, { id: 's9', host: '10.0.100.19', serviceTag: 'DUP', hostName: 'zzz' }] });
  assert.equal(lone.recs.has('i:s9'), false, '이름이 안 맞는 겹친 태그 iDRAC 도 물리 서버가 아니다');
  assert.deepEqual(idx.byIp.get('10.1.0.6'), [{ key: 'st:TAG1', role: 'vm', vm: 'APP01' }]);
  assert.deepEqual(idx.byIp.get('172.20.0.11'), [{ key: 'st:TAG1', role: 'vmk' }]);
  const noBm = buildServerIndex({ ...f, bareMetal: false });
  assert.equal([...noBm.recs.values()].some((r) => r.kind === 'bm'), false, '범위 계정 — 물리 서버를 넣지 않는다');
});

test('v3.6.0 serverViewFor — VM IP 로 그 서버 · 서버 IP 목록 · VM 목록 · 못 찾으면 found:false', () => {
  const f = fixture();
  const idx = buildServerIndex(f);
  const v = serverViewFor(idx, { ip: '10.1.0.7', scanOf: (ip) => (ip === '10.0.0.11' ? { names: { dns: { v: 'esx01.corp' } } } : null),
    overrideOf: (ip) => (ip === '10.1.0.5' ? { purpose: '웹', hostnameOverride: 'app01' } : null), purposeOf: () => '서비스망' });
  assert.equal(v.found, true); assert.equal(v.server.key, 'st:TAG1'); assert.deepEqual(v.clicked, { ip: '10.1.0.7', role: 'vm', vm: 'DB01' });
  assert.deepEqual(v.ips.map((x) => `${x.role}:${x.ip}`), ['idrac:10.0.100.11', 'vmk:10.0.0.11', 'vmk:172.20.0.11']);
  assert.equal(v.ips[1].dns, 'esx01.corp'); assert.equal(v.ips[1].subnetPurpose, '서비스망');
  assert.equal(v.ips[1].nameCheck, 'same', '설정한 이름(호스트 이름) ↔ 역DNS — 첫 마디 비교');
  assert.equal(v.ips[2].nameCheck, 'unscanned');
  assert.equal(v.vms[0].ips[0].setNameSrc, 'manual');
  assert.equal(v.vms[0].name, 'APP01'); assert.equal(v.vms[0].ips[0].purpose, '웹'); assert.equal(v.vms[0].ips[0].setName, 'app01');
  assert.equal(v.server.vmCount, 2); assert.equal('vms' in v.server, false);
  assert.deepEqual(serverViewFor(idx, { ip: '192.0.2.1' }), { found: false, ip: '192.0.2.1', key: '' });
  assert.equal(serverViewFor(idx, { key: 'st:TAG1' }).server.name, 'esx01.corp');
});

test('v3.6.0 compareNames — 여럿과 다른 곳 · 2:2 는 전부 · 해당 없음 · 못 읽음 · 주소는 다름으로 세지 않음', () => {
  const ok = (v) => ({ state: 'ok', v });
  assert.deepEqual(compareNames({ idrac: ok('web01'), vcenter: ok('WEB01.corp'), os: ok('web01'), dns: ok('web01.corp.example') }), { verdict: 'same', odd: [], partial: false, readN: 4 });
  assert.deepEqual(compareNames({ idrac: ok('web01'), vcenter: ok('web01'), os: ok('web01'), dns: ok('web99') }).odd, ['dns']);
  assert.deepEqual(compareNames({ idrac: ok('a'), vcenter: ok('a'), os: ok('b'), dns: ok('b') }).odd, ['idrac', 'vcenter', 'os', 'dns'], '2:2 — 어느 쪽이 맞는지 정하지 않는다');
  const r = compareNames({ idrac: { state: 'na' }, vcenter: ok('vm1'), os: { state: 'unread' }, dns: ok('vm1.x') });
  assert.deepEqual(r, { verdict: 'same', odd: [], partial: true, readN: 2 }, "못 읽은 곳이 있으면 '읽은 n곳은 같음'(partial)");
  assert.equal(compareNames({ idrac: { state: 'na' }, vcenter: { state: 'addr', v: '10.0.0.1' }, os: ok('x'), dns: { state: 'hidden' } }).verdict, 'cmp-none');
  // 첫 마디 · 15자 비교(NetBIOS 잘림)
  assert.equal(compareNames({ idrac: { state: 'na' }, vcenter: ok('very-long-hostname-01.corp'), os: ok('VERY-LONG-HOSTN'), dns: { state: 'unread' } }).verdict, 'same');
});

test('v3.6.0 hostNameRows — 비관리자는 iDRAC 가림 · 범위 계정은 DNS 가림 · VM 은 iDRAC 해당 없음 · 주소 이름은 addr', () => {
  const f = fixture();
  f.hosts.push(H({ name: '10.0.0.15', serviceTag: 'IPNAME', vmks: [{ dev: 'vmk0', ip: '10.0.0.15' }] }));
  const idx = buildServerIndex(f);
  const scanOf = (ip) => (ip === '10.0.0.11' ? { names: { dns: { v: 'esx01.corp.example' } } } : ip === '10.1.0.5' ? { names: { dns: { v: 'app01-web' } } } : null);
  const rows = hostNameRows(idx, { admin: true, scanOf });
  const e1 = rows.find((r) => r.kind === 'esxi' && r.name === 'esx01.corp');
  assert.equal(e1.cells.os.v, 'esx01.corp'); assert.equal(e1.verdict, 'same'); assert.equal(e1.ip, '10.0.0.11');
  const app = rows.find((r) => r.name === 'APP01');
  assert.equal(app.cells.idrac.state, 'na'); assert.equal(app.verdict, 'diff'); assert.deepEqual(app.odd, ['dns']);
  assert.equal(rows.find((r) => r.name === 'esx04').verdict, 'diff', 'ESXi 의 옛 이름(esx04-old)');
  assert.equal(rows.find((r) => r.name === '10.0.0.15').cells.vcenter.state, 'addr');
  const nonAdmin = hostNameRows(idx, { admin: false, scanOf });
  assert.ok(nonAdmin.filter((r) => r.kind !== 'vm').every((r) => r.cells.idrac.state === 'hidden'));
  const scoped = hostNameRows(idx, { admin: true, scoped: true, scanOf });
  assert.ok(scoped.every((r) => r.cells.dns.state === 'hidden'));
  const s = hostNameSummary(rows);
  assert.equal(s.total, rows.length); assert.equal(s.same + s.diff + s.cmpNone, s.total);
  assert.ok(s.oddBy.dns >= 1);
});

test('v3.6.0 라우트 입력 — 비관리자는 iDRAC 등록부를 읽지 않고 태그를 지움 · 범위 계정은 물리 서버 · 스캔 이름 · 범위 밖 override 없음', () => {
  const f = fixture();
  const snap = { generatedAt: 1, vcenters: [{ id: 'vc1', name: 'VC-KR1' }, { id: 'vc2', name: 'VC-US' }], hosts: f.hosts, vms: f.vms };
  let serverCalls = 0;
  const D = { snap: () => snap, servers: () => { serverCalls += 1; return f.servers; }, invOf: () => null, getScanResults: () => ({ '10.0.0.11': { names: { dns: { v: 'esx01' } } } }),
    bmRegistryLoadError: () => null, listBmServersRaw: () => [], getOverride: (ip) => (ip === '10.9.0.1' ? { purpose: 'x', claimedVcenterId: 'vc2' } : null) };
  const op = serverInputs({ user: { role: 'operator' } }, D);
  assert.equal(serverCalls, 0, '비관리자 — iDRAC 등록부를 읽지 않는다');
  assert.equal([...op.index.recs.keys()].some((k) => k.startsWith('st:')), false, '비관리자 — 키에 태그가 실리지 않는다');
  assert.ok([...op.index.recs.values()].every((r) => r.tag === ''));
  const adm = serverInputs({ user: { role: 'admin' } }, D);
  assert.equal(serverCalls, 1); assert.ok(adm.index.recs.has('st:TAG1')); assert.ok(adm.index.recs.has('st:BM1'));
  assert.equal(adm.scanOf('10.0.0.11').names.dns.v, 'esx01'); assert.equal(adm.scanOf('__proto__'), null);
  const sc = serverInputs({ user: { role: 'admin', scope: { vcenters: ['vc1'] } } }, D);
  assert.equal([...sc.index.recs.values()].some((r) => r.kind === 'bm'), false, '범위 계정 — 물리 서버 없음');
  assert.equal(sc.scanOf('10.0.0.11'), null, '범위 계정 — 스캔 이름 없음');
  assert.equal(sc.overrideOf('10.9.0.1'), null, '범위 밖 IP 의 관리상태는 싣지 않는다');
  assert.equal(sc.scoped, true);
});

test('v3.6.0 라우트 — 게이트 · 등록', () => {
  const src = stripComments(fs.readFileSync(new URL('../src/routes/api/ipamServer.js', import.meta.url), 'utf8'));
  assert.match(src, /api\.get\('\/tools\/ipam\/server', requirePerm\('tools'\)/);
  assert.match(src, /api\.get\('\/tools\/ipam\/hostnames', requirePerm\('tools'\)/);
  assert.match(src, /isAdminDetailUser\(req\.user\)/);
  assert.match(src, /scopedVcenterIds\(req\.user, snap\)/);
  const api = fs.readFileSync(new URL('../src/routes/api.js', import.meta.url), 'utf8');
  assert.match(api, /registerIpamServer\(api\);/);
});

test('v3.6.0 스캔 대역 후보 — ESXi vmk 전체 주소 · 출처별 개수(VM · ESXi · iDRAC) · vcenterIps 는 VM + ESXi', async () => {
  const { suggestAgentSubnets } = await import('../src/ipam/scanDatacenter.js');
  const { hostVmks } = await import('../src/ipam/serverView.js');
  const hosts = [{ name: 'esx01.corp', vcenterId: 'vc1', mgmtIp: '10.0.0.11', vmks: [{ dev: 'vmk0', ip: '10.0.0.11' }, { dev: 'vmk1', ip: '172.20.0.11' }, { dev: 'vmk2', ip: '169.254.1.1' }] },
    { name: 'esx09', vcenterId: 'vc9', vmks: [{ dev: 'vmk0', ip: '10.9.9.9' }] }];
  const vms = [{ vcenterId: 'vc1', ipAddresses: ['10.0.0.50', '10.1.0.5'] }];
  const r = suggestAgentSubnets({ vcenterIds: ['vc1'], vms, hosts, idrac: [{ id: 'i1', host: 'https://10.0.0.200' }], vcName: { vc1: 'VC-KR1' },
    hostIp: (h) => ({ ip: h.mgmtIp }), hostIps: (h) => hostVmks(h).map((v) => v.ip).filter((ip) => !ip.startsWith('169.254.')) });
  const by = Object.fromEntries(r.subnets.map((s) => [s.cidr, s]));
  assert.deepEqual([by['10.0.0.0/24'].vmIps, by['10.0.0.0/24'].esxiIps, by['10.0.0.0/24'].idracIps, by['10.0.0.0/24'].vcenterIps], [1, 1, 1, 2], '관리 IP 는 한 번만(vmk0 = mgmtIp)');
  assert.equal(by['172.20.0.0/24'].esxiIps, 1, 'vMotion 대역도 후보');
  assert.equal(by['169.254.1.0/24'], undefined, '링크 로컬은 뺀다');
  assert.equal(by['10.9.9.0/24'], undefined, '이 에이전트의 vCenter 가 아닌 호스트');
  assert.equal(r.totals.hostVmkIps, 1);
  const src = fs.readFileSync(new URL('../src/routes/admin/centralIpam.js', import.meta.url), 'utf8');
  const i = src.indexOf("adminRouter.get('/ipam/scan/suggest', adminOnly, fleetOnly");
  assert.ok(i > 0, '게이트(관리자 + 전체 범위) 그대로');
  const body = src.slice(i, src.indexOf('adminRouter.', i + 10));
  assert.match(body, /hostIps/); assert.match(body, /annotateSubnets\(r0\.subnets, \{ \.\.\.ipmsCtx\(snap\), vcenterIds: vcIds \}\)/);
});
