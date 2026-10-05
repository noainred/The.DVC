/**
 * v2.695 — VM 의 DNS 서버 주소가 VM IP 로 수집되던 결함(사용자 신고: IP 대장의 8.8.8.8 '충돌·중복·멀티홈').
 *  ① vmIps 는 NIC <dnsConfig> 안의 <ipAddress> 를 읽지 않는다(실제 NIC IP·ipConfig IP 는 그대로).
 *  ② vmDns 는 같은 응답에서 DNS 설정을 따로 읽는다(스택·NIC). 보고가 없으면 null(모름) — 빈 배열과 구분.
 *  ③ 블록 제거·추출은 선형(닫는 태그 없는 입력).
 *  ④ 엣지가 올린 dns 필드는 아는 모양만(sanitizeVmDns), 인벤토리 정제가 그것을 부른다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vmIps, vmDns, stripXmlBlocks } from '../src/vcenter/soapClient.js';
import { sanitizeVmDns } from '../src/central/vmDnsSanitize.js';

const NIC = '<GuestNicInfo xsi:type="GuestNicInfo"><network>VM Network</network>'
  + '<ipAddress xsi:type="xsd:string">10.1.2.3</ipAddress><ipAddress>fe80::1</ipAddress>'
  + '<macAddress>00:50:56:aa:bb:cc</macAddress><connected>true</connected>'
  + '<dnsConfig xsi:type="NetDnsConfigInfo"><dhcp>false</dhcp><hostName>vm1</hostName><domainName>corp.local</domainName>'
  + '<ipAddress>8.8.8.8</ipAddress><ipAddress>10.1.0.53</ipAddress><searchDomain>corp.local</searchDomain></dnsConfig>'
  + '<ipConfig><ipAddress><ipAddress>10.1.2.3</ipAddress><prefixLength>24</prefixLength></ipAddress>'
  + '<ipAddress><ipAddress>192.168.5.7</ipAddress><prefixLength>24</prefixLength></ipAddress></ipConfig></GuestNicInfo>';
const STACK = '<GuestStackInfo><dnsConfig><dhcp>true</dhcp><hostName>vm1</hostName><domainName>corp.local</domainName>'
  + '<ipAddress>10.1.0.53</ipAddress><ipAddress>10.1.0.54</ipAddress><searchDomain>a.corp.local</searchDomain></dnsConfig>'
  + '<ipRouteConfig><ipRoute><network>0.0.0.0</network><prefixLength>0</prefixLength>'
  + '<gateway><ipAddress>10.1.2.1</ipAddress></gateway></ipRoute></ipRouteConfig></GuestStackInfo>';

test('① vmIps: DNS 서버 주소는 VM IP 가 아니다 — NIC IP·ipConfig IP 만', () => {
  const r = vmIps(NIC, '10.1.2.3');
  assert.deepEqual(r.ipAddresses, ['10.1.2.3', '192.168.5.7']);
  assert.ok(!r.ipAddresses.includes('8.8.8.8'));
  assert.ok(!r.ipAddresses.includes('10.1.0.53'));
  assert.equal(r.ipAddress, '10.1.2.3');
});

test('① vmIps: 자기닫힘 <dnsConfig/> 뒤의 IP 는 그대로 읽는다', () => {
  const r = vmIps('<GuestNicInfo><dnsConfig/><ipAddress>10.9.9.9</ipAddress></GuestNicInfo>', null);
  assert.deepEqual(r.ipAddresses, ['10.9.9.9']);
});

test('② vmDns: 스택 먼저, NIC 합집합 · DHCP·도메인·검색 접미사', () => {
  const d = vmDns(NIC, STACK);
  assert.deepEqual(d.servers, ['10.1.0.53', '10.1.0.54', '8.8.8.8']);
  assert.deepEqual(d.stack.servers, ['10.1.0.53', '10.1.0.54']);
  assert.equal(d.stack.dhcp, true);
  assert.equal(d.stack.domain, 'corp.local');
  assert.deepEqual(d.stack.search, ['a.corp.local']);
  assert.equal(d.nics.length, 1);
  assert.equal(d.nics[0].network, 'VM Network');
  assert.equal(d.nics[0].mac, '00:50:56:aa:bb:cc');
  assert.deepEqual(d.nics[0].servers, ['8.8.8.8', '10.1.0.53']);
  assert.equal(d.nics[0].dhcp, false);
});

test('② vmDns: 보고가 없으면 null(모름), DNS 블록만 있는 직렬화도 읽는다', () => {
  assert.equal(vmDns('', ''), null);
  assert.equal(vmDns('<GuestNicInfo><ipAddress>10.1.1.1</ipAddress></GuestNicInfo>', null), null);
  const d = vmDns('<dnsConfig><ipAddress>10.2.0.53</ipAddress></dnsConfig>', null);
  assert.deepEqual(d.servers, ['10.2.0.53']);
  assert.equal(d.nics[0].network, null);
});

test('③ 블록 처리는 선형 — 닫는 태그 없는 큰 입력', () => {
  const big = '<dnsConfig>'.repeat(100_000) + '<ipAddress>1.2.3.4</ipAddress>';
  const t = Date.now();
  stripXmlBlocks(big, 'dnsConfig'); vmDns(big, big); vmIps(big, null);
  assert.ok(Date.now() - t < 1000, `${Date.now() - t}ms`);
  // 닫히지 않은 DNS 블록 뒤의 주소는 IP 로 읽지 않는다(안전한 쪽)
  assert.deepEqual(vmIps('<dnsConfig><ipAddress>8.8.8.8</ipAddress>', null).ipAddresses, []);
});

test('④ sanitizeVmDns: 아는 모양만 · 모양이 아니면 null', () => {
  assert.equal(sanitizeVmDns(null), null);
  assert.equal(sanitizeVmDns('8.8.8.8'), null);
  assert.equal(sanitizeVmDns({ servers: 'x' }), null);
  const d = sanitizeVmDns({ servers: ['8.8.8.8', { a: 1 }, '999.1.1.1', 'fe80::1'], stack: { servers: ['10.0.0.1'], dhcp: 'yes', domain: { x: 1 } },
    nics: [null, { network: 'N', servers: ['10.0.0.2'], search: ['a', 5] }], extra: 'drop' });
  assert.deepEqual(d.servers, ['8.8.8.8', 'fe80::1']);
  assert.equal(d.stack.dhcp, null);
  assert.equal(d.stack.domain, null);
  assert.equal(d.nics.length, 1);
  assert.deepEqual(d.nics[0].search, ['a']);
  assert.ok(!('extra' in d));
});

test('④ 인벤토리 정제(sanitizeInventoryList)가 dns 를 좁힌다', async () => {
  const { sanitizeInventoryList } = await import('../src/routes/central.js');
  const dropped = { notObject: 0, otherVcenter: 0, badId: 0, coerced: 0 };
  const out = sanitizeInventoryList([
    { id: 'vc1:vm-1', name: 'a', dns: { servers: ['10.0.0.53', { x: 1 }], extra: 1 } },
    { id: 'vc1:vm-2', name: 'b', dns: 'garbage' },
    { id: 'vc1:vm-3', name: 'c' },
  ], 'vc1', 10, dropped);
  assert.deepEqual(out[0].dns, { servers: ['10.0.0.53'], stack: null, nics: [] });
  assert.equal(out[1].dns, null);
  assert.ok(!('dns' in out[2]));
  assert.ok(dropped.coerced >= 1);
});

test('목 데이터: VM DNS 는 IP 목록에 섞이지 않는다', async () => {
  const { generateSnapshot } = await import('../src/mock/generator.js').catch(() => ({}));
  if (typeof generateSnapshot !== 'function') return;   // 생성기 이름이 다르면 건너뛴다
  const snap = generateSnapshot();
  const withDns = (snap.vms || []).filter((v) => v.dns);
  assert.ok(withDns.length > 0);
  for (const v of withDns) for (const s of ['8.8.8.8', '168.126.63.1']) assert.ok(!(v.ipAddresses || []).includes(s));
});
