// v2.785 점검 GN 회귀 — VM DNS 설정 확인(vm-dns) 판정 코어 server/src/vmdns/analyze.js · probe.js.
//  ① N-B1 — 2.695 이전 엣지(dns 키 없음 = 미수집)의 오염된 ipAddresses(dnsConfig 의 DNS 주소가 섞임)가 공인 DNS·사내 주소를
//          'VM 소유' 로 만들지 않는다: 공인 DNS 표가 VM·호스트 소유보다 먼저 · 미수집 VM 은 대표 IP(ipAddress)만 소유 색인에.
//          보고한 VM 의 다중 IP 소유 · 구 엣지 DC 의 대표 IP 소유는 그대로.
//  ② N-B2 — IPv6 DNS 서버는 정책 판정 'unsupported'(위반으로 세지 않음) — 정책 항목에 IPv6 를 넣을 수 없으므로.
//  ③ N-B3 — 매트릭스 행마다 칸별 otherCorp 불리언(서버 소유 vCenter 집합 판정) · VM 행의 otherCorpIps.
//          같은 사설 주소를 두 법인이 각각 가진 경우 그 두 법인 칸은 '다른 법인' 이 아니다.
//  ④ N-B4 — IPv4 사상·비축약 IPv6 루프백 · ff00::/8 멀티캐스트도 특수 주소 → 도달성 점검 'local' 건너뜀 ·
//          중앙에 IPv6 스택이 없으면(EAFNOSUPPORT) '응답 없음' 이 아니라 건너뜀('no-ipv6').
//  ⑤ N-I2 — 루프백 스텁(127.0.0.53 등)만 보이는 VM 은 'local-stub' 으로 따로 센다(DNS 1개·비승인·매트릭스에서 제외) · CSV 문구.
//  ⑥ 특수 주소(루프백·링크 로컬)는 소유 색인에 넣지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2785a-'));
process.env.DATA_SOURCE = 'mock';

const A = await import('../src/vmdns/analyze.js');
const PR = await import('../src/vmdns/probe.js');

const dns = (servers) => ({ servers, stack: { servers, domain: 'corp.a', search: [], dhcp: false }, nics: [] });
const byIp = (out) => new Map(out.servers.map((s) => [s.ip, s]));

// ── ① N-B1 ──────────────────────────────────────────────────────────────────
function snapB1(oldEdge) {
  return {
    vcenters: [{ id: 'vc-a', name: 'A' }, { id: 'vc-e', name: 'EDGE', collectMode: 'site' }],
    hosts: [],
    vms: [
      { id: 'vc-a:app', name: 'A-APP', vcenterId: 'vc-a', powerState: 'POWERED_ON', ipAddress: '10.1.1.1', ipAddresses: ['10.1.1.1'], dns: dns(['8.8.8.8']) },
      { id: 'vc-a:app2', name: 'A-APP2', vcenterId: 'vc-a', powerState: 'POWERED_ON', ipAddress: '10.1.1.2', ipAddresses: ['10.1.1.2'], dns: dns(['10.5.0.10', '10.9.0.53']) },
      oldEdge
        // 2.695 이전 엣지: dns 키 없음 + dnsConfig 의 DNS 서버 주소(8.8.8.8 · 사내 물리 AD 10.5.0.10)까지 VM IP 로 실려 옴
        ? { id: 'vc-e:web', name: 'E-WEB', vcenterId: 'vc-e', powerState: 'POWERED_ON', ipAddress: '10.9.0.5', ipAddresses: ['10.9.0.5', '8.8.8.8', '10.5.0.10'] }
        : { id: 'vc-e:web', name: 'E-WEB', vcenterId: 'vc-e', powerState: 'POWERED_ON', ipAddress: '10.9.0.5', ipAddresses: ['10.9.0.5'], dns: dns(['8.8.8.8']) },
      // 구 엣지의 정당한 DNS VM(DC) — 대표 IP 로는 계속 소유한다
      { id: 'vc-e:dc', name: 'E-DC', vcenterId: 'vc-e', powerState: 'POWERED_ON', ipAddress: '10.9.0.53', ipAddresses: ['10.9.0.53'] },
    ],
  };
}

test('① N-B1 — 구 엣지 오염 ipAddresses 가 섞여도 공인·비승인 판정이 사라지지 않고 거짓 다른 법인도 없다', () => {
  const pol = { corps: {}, publicUnapproved: true };
  const ok = A.analyzeVmDns({ snap: snapB1(false), policy: pol });
  const old = A.analyzeVmDns({ snap: snapB1(true), policy: pol });
  const s = byIp(old).get('8.8.8.8');
  assert.equal(s.kind, 'public', '8.8.8.8 은 VM 이 아니라 공인 DNS');
  assert.equal(s.publicName, 'Google Public DNS');
  assert.equal(s.who, null);
  assert.equal(s.otherCorpVms, 0);
  assert.equal(s.policy, 'unapproved');
  assert.equal(old.kpis.publicVms, 1, 'A-APP(구 엣지 VM 은 미수집이라 세지 않음)');
  assert.equal(ok.kpis.publicVms, 2);
  assert.equal(old.kpis.unapprovedVms, 1);
  // 사내 물리 AD 10.5.0.10 — 구 엣지 VM 이 '소유' 하지 않는다(대장에 없음 · 다른 법인 아님)
  const ad = byIp(old).get('10.5.0.10');
  assert.equal(ad.kind, 'unknown');
  assert.equal(ad.otherCorpVms, 0);
  // 구 엣지 DC 의 대표 IP 소유는 남는다(다른 법인 판정을 잃지 않는다)
  const dc = byIp(old).get('10.9.0.53');
  assert.equal(dc.kind, 'vm');
  assert.equal(dc.who.name, 'E-DC');
  assert.equal(dc.otherCorpVms, 1);
  assert.equal(old.kpis.otherCorpVms, 1, 'A-APP2 만(10.9.0.53) — 8.8.8.8·10.5.0.10 거짓 양성 없음');
});

test('① N-B1 — 보고한 VM 의 두 번째 IP 소유는 그대로 · 공인 표 주소는 VM 이 가져도 공인', () => {
  const snap = {
    vcenters: [{ id: 'vc-a', name: 'A' }, { id: 'vc-b', name: 'B' }],
    hosts: [{ id: 'h', name: '8.8.4.4', vcenterId: 'vc-b', mgmtIp: '8.8.4.4' }],
    vms: [
      { id: 'b:dc', name: 'B-DC', vcenterId: 'vc-b', powerState: 'POWERED_ON', ipAddress: '10.2.0.5', ipAddresses: ['10.2.0.5', '10.2.0.53', '1.1.1.1'], dns: dns(['10.2.0.53']) },
      { id: 'a:app', name: 'A-APP', vcenterId: 'vc-a', powerState: 'POWERED_ON', ipAddress: '10.1.0.5', ipAddresses: ['10.1.0.5'], dns: dns(['10.2.0.53', '1.1.1.1', '8.8.4.4']) },
    ],
  };
  const out = A.analyzeVmDns({ snap, policy: {} });
  const m = byIp(out);
  assert.equal(m.get('10.2.0.53').kind, 'vm', '보고한 VM 은 모든 IP 를 소유');
  assert.equal(m.get('10.2.0.53').otherCorpVms, 1);
  assert.equal(m.get('1.1.1.1').kind, 'public');
  assert.equal(m.get('1.1.1.1').publicName, 'Cloudflare');
  assert.equal(m.get('1.1.1.1').otherCorpVms, 0, '공인 resolver 는 법인 소유가 아니다');
  assert.equal(m.get('8.8.4.4').kind, 'public', '호스트 이름이 공인 DNS 주소여도 공인 표가 먼저');
  assert.equal(m.get('8.8.4.4').otherCorpVms, 0);
});

// ── ② N-B2 ──────────────────────────────────────────────────────────────────
test('② N-B2 — IPv6 DNS 서버는 정책 미지원(unsupported) · 위반으로 세지 않는다', () => {
  const pol = { corps: { 'vc-a': ['10.1.0.0/24'] }, publicUnapproved: true };
  assert.equal(A.policyVerdict(pol, 'vc-a', { ip: '2001:db8::53', kind: 'unknown' }), 'unsupported');
  assert.equal(A.policyVerdict(pol, 'vc-a', { ip: 'fec0:0:0:ffff::1', kind: 'unknown' }), 'unsupported');
  assert.equal(A.policyVerdict({ corps: {} }, 'vc-a', { ip: '2001:db8::53', kind: 'unknown' }), 'unsupported');
  assert.equal(A.policyVerdict(pol, 'vc-a', { ip: '10.1.0.53', kind: 'vm' }), 'approved', 'IPv4 판정은 그대로');
  assert.equal(A.policyVerdict(pol, 'vc-a', { ip: '10.2.0.53', kind: 'vm' }), 'unapproved');
  const snap = {
    vcenters: [{ id: 'vc-a', name: 'A' }],
    hosts: [],
    vms: [
      { id: 'a:dc', name: 'A-DC', vcenterId: 'vc-a', powerState: 'POWERED_ON', ipAddress: '10.1.0.53', ipAddresses: ['10.1.0.53'], dns: dns(['10.1.0.53']) },
      { id: 'a:v6', name: 'A-V6', vcenterId: 'vc-a', powerState: 'POWERED_ON', ipAddress: '10.1.1.6', ipAddresses: ['10.1.1.6'], dns: dns(['10.1.0.53', '2001:db8::53']) },
    ],
  };
  const out = A.analyzeVmDns({ snap, policy: pol });
  const s = byIp(out).get('2001:db8::53');
  assert.equal(s.policy, 'unsupported');
  assert.equal(s.unapprovedVms, 0);
  assert.equal(out.kpis.unapprovedVms, 0, '승인 DNS + IPv6 DNS VM 은 비승인이 아니다');
  assert.equal(out.vcenters.find((v) => v.id === 'vc-a').unapprovedVms, 0);
  const vm = A.vmDetail({ snap, policy: pol }, 'a:v6');
  assert.equal(vm.serverInfo.find((x) => x.ip === '2001:db8::53').policy, 'unsupported');
  assert.ok(!vm.flags.includes('unapproved'));
});

// ── ③ N-B3 ──────────────────────────────────────────────────────────────────
test('③ N-B3 — 매트릭스 칸별 otherCorp 는 서버 소유 vCenter 집합으로 판정(대표 소유자 1명이 아님)', () => {
  const snap = {
    vcenters: [{ id: 'vc-a', name: 'A' }, { id: 'vc-b', name: 'B' }, { id: 'vc-c', name: 'C' }],
    hosts: [],
    vms: [
      { id: 'a:dns', name: 'A-DNS', vcenterId: 'vc-a', powerState: 'POWERED_ON', ipAddress: '10.0.0.53', ipAddresses: ['10.0.0.53'], dns: dns(['10.0.0.53']) },
      { id: 'b:dns', name: 'B-DNS', vcenterId: 'vc-b', powerState: 'POWERED_ON', ipAddress: '10.0.0.53', ipAddresses: ['10.0.0.53'], dns: dns(['10.0.0.53']) },
      { id: 'b:app', name: 'B-APP', vcenterId: 'vc-b', powerState: 'POWERED_ON', ipAddress: '10.2.1.1', ipAddresses: ['10.2.1.1'], dns: dns(['10.0.0.53']) },
      { id: 'c:app', name: 'C-APP', vcenterId: 'vc-c', powerState: 'POWERED_ON', ipAddress: '10.3.1.1', ipAddresses: ['10.3.1.1'], dns: dns(['10.0.0.53', '8.8.8.8']) },
    ],
  };
  const out = A.analyzeVmDns({ snap, policy: {} });
  assert.equal(out.checks.otherCorp, 1, 'C-APP 만');
  const col = out.matrix.cols.findIndex((c) => c.ip === '10.0.0.53');
  const pub = out.matrix.cols.findIndex((c) => c.ip === '8.8.8.8');
  assert.ok(col >= 0 && pub >= 0);
  const row = (id) => out.matrix.rows.find((r) => r.vcenterId === id);
  for (const id of ['vc-a', 'vc-b', 'vc-c']) {
    assert.ok(Array.isArray(row(id).otherCorp), `${id} 행에 otherCorp 배열`);
    assert.equal(row(id).otherCorp.length, out.matrix.cols.length);
  }
  assert.equal(row('vc-a').otherCorp[col], false);
  assert.equal(row('vc-b').otherCorp[col], false, '대표 소유자가 A-DNS 여도 B 도 그 주소를 가진다');
  assert.equal(row('vc-c').otherCorp[col], true);
  assert.equal(row('vc-c').otherCorp[pub], false, '공인은 소유자가 없다');
  // 행 합(otherCorp 칸 VM 수)과 KPI 가 같은 판정
  // VM 행의 otherCorpIps — 웹 주소 칩 색도 서버 판정만 쓴다
  const det = A.serverDetail({ snap, policy: {} }, { ip: '10.0.0.53' });
  const by = new Map(det.vms.map((v) => [v.name, v]));
  assert.deepEqual(by.get('B-APP').otherCorpIps, []);
  assert.deepEqual(by.get('C-APP').otherCorpIps, ['10.0.0.53']);
});

// ── ④ N-B4 ──────────────────────────────────────────────────────────────────
test('④ N-B4 — IPv6 특수 주소 판정(사상 IPv4 · 비축약 루프백 · 멀티캐스트)', () => {
  const cases = {
    '::1': 'loopback', '0:0:0:0:0:0:0:1': 'loopback', '0::1': 'loopback',
    '::ffff:127.0.0.1': 'loopback', '::ffff:127.0.0.53': 'loopback', '::ffff:7f00:35': 'loopback',
    '::ffff:169.254.1.1': 'link-local', '::ffff:0.0.0.0': 'unspecified', '::ffff:224.0.0.1': 'multicast',
    '::ffff:8.8.8.8': 'ipv6', '::ffff:10.1.0.53': 'ipv6',
    '::': 'unspecified', '0:0:0:0:0:0:0:0': 'unspecified',
    'fe80::1': 'link-local', 'febf::1': 'link-local', 'fec0::1': 'ipv6',
    'ff02::1': 'multicast', 'ff05::1:3': 'multicast',
    '2001:db8::1': 'ipv6', '2001:4860:4860::8888': 'ipv6',
  };
  for (const [ip, want] of Object.entries(cases)) assert.equal(A.specialOf(ip), want, ip);
  // IPv4 판정은 그대로
  assert.equal(A.specialOf('127.0.0.53'), 'loopback');
  assert.equal(A.specialOf('10.1.0.53'), null);
});

test('④ N-B4 — 사상·비축약 루프백은 도달성 점검 대상에서 local 로 건너뛴다', () => {
  const snap = {
    vcenters: [{ id: 'vc-a', name: 'A' }],
    vms: [
      { id: 'a:1', name: 'A1', vcenterId: 'vc-a', ipAddresses: [], dns: dns(['::ffff:127.0.0.1', '0:0:0:0:0:0:0:1', 'ff02::1', '2001:db8::53']) },
    ],
  };
  const t = new Map(A.probeTargets(snap).map((x) => [x.ip, x.skip]));
  assert.equal(t.get('::ffff:127.0.0.1'), 'local');
  assert.equal(t.get('0:0:0:0:0:0:0:1'), 'local');
  assert.equal(t.get('ff02::1'), 'local');
  assert.equal(t.get('2001:db8::53'), null, '일반 IPv6 는 점검한다');
});

test('④ N-B4 — 중앙에 IPv6 스택이 없으면(EAFNOSUPPORT) 응답 없음이 아니라 건너뜀(no-ipv6)', async () => {
  PR._resetVmDnsProbeForTest();
  assert.equal(PR.isNoIpv6({ ok: false, error: 'error:EAFNOSUPPORT' }, { ok: false, error: 'error:EAFNOSUPPORT' }), true);
  assert.equal(PR.isNoIpv6({ ok: false, error: 'timeout' }, { ok: false, error: 'refused' }), false);
  assert.equal(PR.isNoIpv6({ ok: true, ms: 1 }, { ok: false, error: 'error:EAFNOSUPPORT' }), false, '한쪽이라도 응답하면 응답');
  const nof = async () => ({ ok: false, ms: null, rcode: null, error: 'error:EAFNOSUPPORT' });
  const r = await PR.runVmDnsProbe([{ ip: '2001:db8::53', qname: '.', skip: null }], { probeUdpFn: nof, probeTcpFn: nof });
  assert.equal(r.ok, true);
  assert.equal(r.summary.failed, 0);
  assert.equal(r.summary.skipped, 1);
  assert.equal(r.summary.skippedBy['no-ipv6'], 1);
  assert.equal(PR.probeResultOf('2001:db8::53').skipped, 'no-ipv6');
  PR._resetVmDnsProbeForTest();
});

// ── ⑤ N-I2 ──────────────────────────────────────────────────────────────────
test('⑤ N-I2 — 루프백 스텁만 보이는 VM 은 local-stub(DNS 1개·비승인·매트릭스에서 제외) · CSV 문구', () => {
  const pol = { corps: { 'vc-a': ['10.1.0.0/24'] }, publicUnapproved: true };
  const snap = {
    vcenters: [{ id: 'vc-a', name: 'A' }, { id: 'vc-u', name: 'U' }],
    hosts: [],
    vms: [
      { id: 'a:dc', name: 'A-DC', vcenterId: 'vc-a', powerState: 'POWERED_ON', ipAddress: '10.1.0.53', ipAddresses: ['10.1.0.53'], dns: dns(['10.1.0.53', '10.1.0.54']) },
      { id: 'a:ub1', name: 'A-UB1', vcenterId: 'vc-a', powerState: 'POWERED_ON', ipAddress: '10.1.1.1', ipAddresses: ['10.1.1.1'], dns: dns(['127.0.0.53']) },
      { id: 'a:ub2', name: 'A-UB2', vcenterId: 'vc-a', powerState: 'POWERED_ON', ipAddress: '10.1.1.2', ipAddresses: ['10.1.1.2'], dns: dns(['127.0.0.53', '::1']) },
      // 스텁 + 실제 서버를 함께 쓰면 스텁이 아니다(예전 판정 그대로)
      { id: 'a:mix', name: 'A-MIX', vcenterId: 'vc-a', powerState: 'POWERED_ON', ipAddress: '10.1.1.3', ipAddresses: ['10.1.1.3'], dns: dns(['127.0.0.53', '10.1.0.53']) },
      // 스텁만 쓰는 법인
      { id: 'u:ub', name: 'U-UB', vcenterId: 'vc-u', powerState: 'POWERED_ON', ipAddress: '10.7.1.1', ipAddresses: ['10.7.1.1'], dns: dns(['127.0.0.53']) },
    ],
  };
  const out = A.analyzeVmDns({ snap, policy: pol });
  assert.equal(out.kpis.localStubVms, 3, 'A-UB1 · A-UB2 · U-UB');
  assert.equal(out.kpis.singleDnsVms, 0, '스텁 1개는 DNS 1개가 아니다');
  assert.equal(out.kpis.unapprovedVms, 1, 'A-MIX(127.0.0.53 이 정책 밖) 만 — 스텁 VM 은 판정하지 않는다');
  assert.equal(out.checks.singleDns, 0);
  const lo = byIp(out).get('127.0.0.53');
  assert.equal(lo.vms, 4, '서버 목록에는 쓰는 VM 수 그대로');
  assert.equal(lo.unapprovedVms, 1);
  assert.equal(lo.policy, 'unapproved', '판정하지 않은 스텁 VM 은 서버 정책 집계에서 빠진다');
  assert.equal(byIp(out).get('::1').policy, 'local');
  // 매트릭스 — 스텁 VM 은 행에 들어가지 않고, 스텁 VM 만 쓰는 주소는 열이 되지 않는다
  assert.ok(!out.matrix.cols.some((c) => c.ip === '::1'));
  assert.ok(!out.matrix.rows.some((r) => r.vcenterId === 'vc-u'), '스텁 VM 만 있는 법인은 행이 없다');
  assert.equal(out.matrix.rows.find((r) => r.vcenterId === 'vc-a').total, 2, 'A-DC · A-MIX');
  // VM 표지
  const vm = A.vmDetail({ snap, policy: pol }, 'a:ub1');
  assert.deepEqual(vm.flags, ['local-stub']);
  assert.equal(vm.serverInfo[0].policy, 'local');
  const mix = A.vmDetail({ snap, policy: pol }, 'a:mix');
  assert.ok(!mix.flags.includes('local-stub'));
  const det = A.serverDetail({ snap, policy: pol }, { ip: '127.0.0.53' });
  assert.deepEqual(det.vms.find((v) => v.name === 'U-UB').flags, ['local-stub']);
  // CSV
  const csv = A.csvRows({ snap, policy: pol });
  const r = csv.find((x) => x[1] === 'A-UB1');
  assert.match(r[7], /로컬 스텁/);
  assert.doesNotMatch(r[7], /DNS 1개|비승인/);
  assert.equal(A.FLAG_TEXT['local-stub'].includes('`'), false);
});

// ── ⑥ 특수 주소 소유 ────────────────────────────────────────────────────────
test('⑥ 루프백·링크 로컬 주소는 VM 소유 색인에 넣지 않는다(다른 법인 거짓 양성 방지)', () => {
  const snap = {
    vcenters: [{ id: 'vc-a', name: 'A' }, { id: 'vc-b', name: 'B' }],
    hosts: [],
    vms: [
      { id: 'b:x', name: 'B-X', vcenterId: 'vc-b', powerState: 'POWERED_ON', ipAddress: '10.2.1.1', ipAddresses: ['10.2.1.1', '127.0.0.53', '169.254.10.1'], dns: dns(['10.2.0.53']) },
      { id: 'a:x', name: 'A-X', vcenterId: 'vc-a', powerState: 'POWERED_ON', ipAddress: '10.1.1.1', ipAddresses: ['10.1.1.1'], dns: dns(['127.0.0.53', '169.254.10.1']) },
    ],
  };
  const out = A.analyzeVmDns({ snap, policy: {} });
  assert.equal(byIp(out).get('127.0.0.53').kind, 'unknown');
  assert.equal(byIp(out).get('169.254.10.1').kind, 'unknown');
  assert.equal(out.kpis.otherCorpVms, 0);
});
