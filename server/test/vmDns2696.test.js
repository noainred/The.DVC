// v2.696 — 특수 기능 'VM DNS 설정 확인'(도구 키 vm-dns) 서버 쪽 회귀.
//  ① 정체 판정(VM → ESXi 호스트 → 잘 알려진 공인 → 대장 분류기 → unknown, 특수 주소)
//  ② 정책 판정(명시 승인 우선 · 공인 비승인 · 목록 없음 = none · 서버 단위 mixed)
//  ③ NIC≠OS · DHCP · DNS 1개 · 다른 법인 DNS
//  ④ 미수집(키 없음) vs 모름(null) vs 템플릿 제외
//  ⑤ 범위 가림(범위 밖 소유 VM 이름 · 범위 밖 서버 · omittedOutOfScope)
//  ⑥ 매트릭스 · 도메인 · 도달성 점검 대상(엣지 위임·목·특수 주소 건너뜀)
//  ⑦ 정책 검증(정규형·CIDR 경계·빈 마스크·stale·손상 보존)
//  ⑧ 도달성 점검 — 로컬 가짜 DNS 서버(UDP·TCP): 응답(rcode 무관) · 무응답 시한 · 닫힌 포트 · ID 불일치 무시 · 동시 실행 busy
//  ⑨ 변경 이력 — 첫 관측(변경 행 없음) · 변경 · 모름/미수집 건너뜀 · 첫 병합 전 건너뜀 · 범위 필터
//  ⑩ 실제 api 라우터 — 상태코드(viewer PUT/probe 403 · 범위 admin PUT 403 · CSV 권한) · 범위 계정 가림 · 400 형식 오류
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vmdns2696-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'mock';
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

const A = await import('../src/vmdns/analyze.js');
const P = await import('../src/vmdns/policy.js');
const PR = await import('../src/vmdns/probe.js');
const DB = await import('../src/vmdns/db.js');
const PO = await import('../src/vmdns/poller.js');

const dns = (servers, extra = {}) => ({ servers, stack: { servers, domain: extra.domain ?? 'a.corp', search: extra.search ?? ['a.corp'], dhcp: extra.dhcp ?? false, hostName: 'h' },
  nics: [{ network: 'VM Network', mac: '00:50:56:00:00:01', servers: extra.nic ?? servers, domain: extra.domain ?? 'a.corp', search: [], dhcp: extra.dhcp ?? false }] });

function snapBase() {
  return {
    generatedAt: '2026-10-05T00:00:00.000Z',
    vcenters: [
      { id: 'vc-a', name: 'Alpha' }, { id: 'vc-b', name: 'Beta' },
      { id: 'vc-s', name: 'Site', collectSource: 'site' },
    ],
    hosts: [{ id: 'h1', name: 'esx1', vcenterId: 'vc-a', mgmtIp: '10.1.0.9' }],
    vms: [
      // DNS 서버 VM(소유자) — vc-a 와 vc-b 에 하나씩
      { id: 'vc-a:dc1', name: 'A-DC01', vcenterId: 'vc-a', powerState: 'POWERED_ON', ipAddresses: ['10.1.0.53'], dns: dns(['10.1.0.53']) },
      { id: 'vc-b:dc1', name: 'B-DC01', vcenterId: 'vc-b', powerState: 'POWERED_ON', ipAddresses: ['10.2.0.53'], dns: dns(['10.2.0.53']) },
      // vc-a 의 사용자 VM들
      { id: 'vc-a:app1', name: 'A-APP1', vcenterId: 'vc-a', powerState: 'POWERED_ON', ipAddresses: ['10.1.1.1'], dns: dns(['10.1.0.53', '8.8.8.8']) },
      { id: 'vc-a:app2', name: 'A-APP2', vcenterId: 'vc-a', powerState: 'POWERED_ON', ipAddresses: ['10.1.1.2'], dns: dns(['10.2.0.53'], { dhcp: true, domain: 'b.corp' }) }, // 다른 법인 DNS · 1개
      { id: 'vc-a:app3', name: 'A-APP3', vcenterId: 'vc-a', powerState: 'POWERED_ON', ipAddresses: ['10.1.1.3'], dns: dns(['10.1.0.53', '10.1.0.9'], { nic: ['10.1.0.53', '1.1.1.1'] }) }, // NIC≠OS · 호스트 DNS
      { id: 'vc-a:app4', name: 'A-APP4', vcenterId: 'vc-a', powerState: 'POWERED_ON', ipAddresses: ['10.1.1.4'], dns: dns(['10.99.0.53', '127.0.0.53', '203.0.113.7']) }, // 대장에 없음 · 루프백 · 분류기 공인
      { id: 'vc-a:unk', name: 'A-UNK', vcenterId: 'vc-a', powerState: 'POWERED_OFF', ipAddresses: [], dns: null },          // 모름
      { id: 'vc-a:old', name: 'A-OLD', vcenterId: 'vc-a', powerState: 'POWERED_ON', ipAddresses: ['10.1.1.9'] },              // 미수집(키 없음)
      { id: 'vc-a:tpl', name: 'A-TPL', vcenterId: 'vc-a', template: true, dns: dns(['9.9.9.9']) },                             // 템플릿 — 제외
      // 엣지 위임 vCenter 만 쓰는 서버
      { id: 'vc-s:app1', name: 'S-APP1', vcenterId: 'vc-s', powerState: 'POWERED_ON', ipAddresses: ['10.3.1.1'], dns: dns(['10.3.0.53']) },
    ],
  };
}
const byIp = (out) => new Map(out.servers.map((s) => [s.ip, s]));

test('① 정체 — VM → 호스트 → 공인 표 → 분류기 → unknown · 특수 주소', () => {
  const out = A.analyzeVmDns({ snap: snapBase(), policy: {} });
  const m = byIp(out);
  assert.equal(m.get('10.1.0.53').kind, 'vm');
  assert.equal(m.get('10.1.0.53').who.name, 'A-DC01');
  assert.equal(m.get('10.1.0.53').who.label, 'VM');
  assert.equal(m.get('10.1.0.9').kind, 'host');
  assert.equal(m.get('10.1.0.9').who.label, 'ESXi 호스트');
  assert.equal(m.get('8.8.8.8').kind, 'public');
  assert.equal(m.get('8.8.8.8').publicName, 'Google Public DNS');
  assert.equal(m.get('203.0.113.7').kind, 'public', '분류기가 공인이라 하면 표에 없어도 공인');
  assert.equal(m.get('203.0.113.7').publicName, null, '이름을 지어내지 않는다');
  assert.equal(m.get('10.99.0.53').kind, 'unknown');
  assert.equal(m.get('10.99.0.53').who, null);
  assert.equal(m.get('10.99.0.53').cls, 'private');
  assert.equal(m.get('127.0.0.53').special, 'loopback');
  assert.equal(m.get('127.0.0.53').cls, 'other');
  assert.equal(m.get('127.0.0.53').kind, 'unknown', '루프백은 공인으로 세지 않는다');
  assert.ok(!m.has('9.9.9.9'), '템플릿의 DNS 는 세지 않는다');
  // NIC 에만 있는 1.1.1.1 은 OS 가 쓰는 목록이 아니다 — 서버로 세지 않는다
  assert.ok(!m.has('1.1.1.1'));
  // 주어진 분류기를 쓴다(IP 대장 분류)
  const out2 = A.analyzeVmDns({ snap: snapBase(), policy: {}, classify: (ip) => (ip === '10.99.0.53' ? 'public' : 'private') });
  assert.equal(byIp(out2).get('10.99.0.53').kind, 'public');
  assert.equal(byIp(out2).get('203.0.113.7').kind, 'unknown');
  assert.equal(A.canonAddr('010.001.0.53'), '10.1.0.53');
  assert.equal(A.canonAddr('FE80::1'), 'fe80::1');
  assert.equal(A.specialOf('fe80::1'), 'link-local');
  assert.equal(A.specialOf('2001:db8::1'), 'ipv6');
});

test('② 정책 — 명시 승인 우선 · 공인 비승인 · 목록 없음 none · 서버 단위 mixed', () => {
  const s = { kind: 'public', ip: '8.8.8.8' };
  assert.equal(A.policyVerdict({ corps: {}, publicUnapproved: true }, 'vc-a', s), 'unapproved');
  assert.equal(A.policyVerdict({ corps: {}, publicUnapproved: false }, 'vc-a', s), 'none');
  assert.equal(A.policyVerdict({ corps: { 'vc-a': ['8.8.8.8'] }, publicUnapproved: true }, 'vc-a', s), 'approved', '관리자가 그 법인에 넣은 공인 주소는 승인');
  const priv = { kind: 'vm', ip: '10.1.0.53' };
  assert.equal(A.policyVerdict({ corps: { 'vc-a': ['10.1.0.0/24'] } }, 'vc-a', priv), 'approved');
  assert.equal(A.policyVerdict({ corps: { 'vc-a': ['10.2.0.0/24'] } }, 'vc-a', priv), 'unapproved');
  assert.equal(A.policyVerdict({ corps: { 'vc-b': ['10.1.0.0/24'] } }, 'vc-a', priv), 'none', '다른 법인의 목록은 이 법인을 판정하지 않는다');
  assert.equal(A.policyVerdict({ corps: Object.create({ 'vc-a': ['10.1.0.53'] }) }, 'vc-a', priv), 'none', '상속 속성은 정책이 아니다');

  const pol = { corps: { 'vc-a': ['10.1.0.53'], 'vc-b': ['10.2.0.53'] }, publicUnapproved: true };
  const out = A.analyzeVmDns({ snap: snapBase(), policy: pol });
  const m = byIp(out);
  assert.equal(m.get('10.1.0.53').policy, 'approved');
  assert.equal(m.get('8.8.8.8').policy, 'unapproved');
  // 10.2.0.53: vc-b(승인) + vc-a(목록 있음·불일치 → 비승인) → mixed
  assert.equal(m.get('10.2.0.53').policy, 'mixed');
  assert.equal(m.get('10.2.0.53').unapprovedVms, 1);
  assert.equal(m.get('10.3.0.53').policy, 'none', '정책 없는 법인만 쓰는 서버는 none');
  assert.equal(out.kpis.policyCorps, 2);
  // 비승인 VM = A-APP1(8.8.8.8) · A-APP2(10.2.0.53) · A-APP3(10.1.0.9) · A-APP4(셋 다)
  assert.equal(out.kpis.unapprovedVms, 4);
  assert.equal(out.kpis.publicVms, 2, 'A-APP1(8.8.8.8) · A-APP4(203.0.113.7)');
});

test('③ NIC≠OS · DHCP · DNS 1개 · 다른 법인 DNS', () => {
  const out = A.analyzeVmDns({ snap: snapBase(), policy: {} });
  assert.equal(out.kpis.mismatchVms, 1, 'A-APP3 만 NIC 와 OS 값이 다르다');
  assert.equal(out.kpis.otherCorpVms, 1, 'A-APP2 가 vc-b 소유 DNS 를 쓴다');
  assert.equal(byIp(out).get('10.2.0.53').otherCorpVms, 1);
  assert.equal(out.kpis.dhcpVms, 1);
  assert.equal(out.kpis.singleDnsVms, 4, 'A-DC01 · B-DC01 · A-APP2 · S-APP1');
  assert.deepEqual(out.checks, { mismatch: 1, otherCorp: 1, singleDns: 4 });
  // DHCP 판정: 스택 값 없으면 NIC 중 하나라도 true · 전부 false 면 false · 모르면 null
  assert.equal(A.vmDnsInfo({ dns: { servers: ['10.0.0.1'], stack: null, nics: [{ servers: ['10.0.0.1'], dhcp: false }, { servers: [], dhcp: true }] } }).dhcp, true);
  assert.equal(A.vmDnsInfo({ dns: { servers: ['10.0.0.1'], stack: null, nics: [{ servers: ['10.0.0.1'], dhcp: false }] } }).dhcp, false);
  assert.equal(A.vmDnsInfo({ dns: { servers: ['10.0.0.1'], stack: null, nics: [{ servers: ['10.0.0.1'] }] } }).dhcp, null);
  // 스택이 없으면 dns.servers 를 쓴다 · 불일치는 둘 다 있을 때만
  const i = A.vmDnsInfo({ dns: { servers: ['10.0.0.1', '10.0.0.2'], stack: null, nics: [{ servers: ['10.0.0.1'] }] } });
  assert.deepEqual(i.servers, ['10.0.0.1', '10.0.0.2']);
  assert.equal(i.mismatch, false);
});

test('④ 미수집(키 없음) · 모름(null) · 템플릿 제외 — 서로 다른 칸', () => {
  assert.equal(A.vmDnsInfo({ id: 'x' }).state, 'notCollected');
  assert.equal(A.vmDnsInfo({ id: 'x', dns: null }).state, 'unknown');
  assert.equal(A.vmDnsInfo({ id: 'x', dns: 'garbage' }).state, 'unknown', '모양이 아니면 모름(빈 DNS 아님)');
  assert.equal(A.vmDnsInfo({ id: 'x', dns: { servers: [], stack: null, nics: [] } }).state, 'reported');
  const out = A.analyzeVmDns({ snap: snapBase(), policy: {} });
  const a = out.vcenters.find((v) => v.id === 'vc-a');
  assert.deepEqual([a.vms, a.reported, a.unknown, a.notCollected], [7, 5, 1, 1], '템플릿은 VM 수에 없다');
  assert.equal(out.kpis.vms, 9);
  assert.equal(out.kpis.unknown, 1);
  assert.equal(out.kpis.notCollected, 1);
  assert.equal(A.effectiveServers({ dns: null }), null, '모름은 변경 이력 비교 대상이 아니다');
  assert.equal(A.effectiveServers({}), null);
});

test('⑤ 범위 가림 — 범위 밖 소유 VM 이름 · 범위 밖 사용자 VM · omittedOutOfScope', () => {
  const allowed = new Set(['vc-a']);
  const out = A.analyzeVmDns({ snap: snapBase(), policy: {}, allowed });
  const m = byIp(out);
  assert.deepEqual(m.get('10.2.0.53').who, { name: null, vcenterId: null, vcenterName: null, label: '다른 법인 VM' }, 'vc-b 소유 VM 의 이름을 가린다');
  assert.equal(m.get('10.2.0.53').otherCorpVms, 1, '가려도 다른 법인 판정은 한다');
  assert.ok(!m.has('10.3.0.53'), '범위 밖 VM 만 쓰는 서버는 목록에 없다');
  assert.equal(m.get('10.2.0.53').vms, 1, 'B-DC01 자신은 범위 밖이라 세지 않는다');
  assert.deepEqual(out.vcenters.map((v) => v.id), ['vc-a']);
  assert.deepEqual(out.scope, { scoped: true, omittedOutOfScope: 2 });
  const text = JSON.stringify(out);
  for (const n of ['B-DC01', 'S-APP1', 'Beta']) assert.ok(!text.includes(n), `범위 밖 이름 ${n} 이 응답에 있다`);
  // 서버 상세·VM 상세도 같은 범위
  assert.equal(A.serverDetail({ snap: snapBase(), policy: {}, allowed }, { ip: '10.3.0.53' }), null);
  assert.equal(A.vmDetail({ snap: snapBase(), policy: {}, allowed }, 'vc-b:dc1'), null);
  const d = A.serverDetail({ snap: snapBase(), policy: {}, allowed }, { ip: '10.2.0.53' });
  assert.deepEqual(d.vms.map((v) => v.name), ['A-APP2']);
  assert.deepEqual(d.vms[0].flags, ['other-corp', 'single']);
  assert.equal(d.vms[0].position, 1);
  // vcenterId 필터는 범위 안에서만
  const f = A.analyzeVmDns({ snap: snapBase(), policy: {}, allowed, vcenterId: 'vc-b' });
  assert.equal(f.kpis.vms, 0);
});

test('⑥ 매트릭스 · 도메인 · 도달성 점검 대상', () => {
  const out = A.analyzeVmDns({ snap: snapBase(), policy: {} });
  assert.ok(out.matrix.cols.length <= A.MATRIX_COLS);
  const rowA = out.matrix.rows.find((r) => r.vcenterId === 'vc-a');
  assert.equal(rowA.total, 5);
  const col = out.matrix.cols.findIndex((c) => c.ip === '10.1.0.53');
  assert.equal(rowA.cells[col], 3, 'A-DC01 · A-APP1 · A-APP3');
  assert.deepEqual(out.domains[0], { name: 'a.corp', vms: 6 });
  assert.ok(out.domains.some((d) => d.name === 'b.corp'));
  const t = new Map(A.probeTargets(snapBase()).map((x) => [x.ip, x]));
  assert.equal(t.get('10.3.0.53').skip, 'edge-only', '엣지 위임 vCenter 만 쓰면 중앙에서 점검하지 않는다');
  assert.equal(t.get('127.0.0.53').skip, 'local');
  assert.equal(t.get('10.1.0.53').skip, null);
  assert.equal(t.get('10.1.0.53').qname, 'a.corp');
  assert.ok(!t.has('9.9.9.9'));
  const tm = new Map(A.probeTargets(snapBase(), { isMockVc: (v) => v.id === 'vc-a' }).map((x) => [x.ip, x]));
  assert.equal(tm.get('10.1.0.53').skip, 'mock');
  assert.equal(tm.get('10.2.0.53').skip, null, 'vc-b(목 아님) VM 도 쓰므로 점검한다');
  assert.equal(A.queryNameOf('bad name'), null);
  assert.equal(A.queryNameOf('a.corp.'), 'a.corp');
});

test('⑦ 정책 검증 — 정규형 · CIDR 경계 · 빈 마스크 · stale · 손상 보존', () => {
  const ok = (v) => P.checkPolicyEntry(v).ok;
  assert.ok(ok('10.20.0.53'));
  assert.ok(ok('10.20.0.0/24'));
  assert.ok(ok(' 8.8.8.8 '));
  for (const bad of ['010.20.0.53', '10.20.0.0/', '10.20.0.5/24', '10.0.0.0/7', '10.0.0.0/33', '10.0.0.0/08', 'abc', '10..0.1', '', '10.0.0.0/24/1']) {
    assert.equal(ok(bad), false, `받으면 안 된다: ${bad}`);
  }
  const n = P.normalizeCorps({ 'vc-a': ['10.1.0.53', '10.1.0.53', 'x'], __proto__: ['1.1.1.1'], 'vc-z': [] });
  assert.deepEqual(n.corps, { 'vc-a': ['10.1.0.53'] }, '중복 제거 · 빈 목록 저장 안 함');
  assert.equal(n.invalid.length, 1);
  P.invalidateVmDnsPolicy();
  const r0 = P.loadVmDnsPolicy();
  assert.equal(r0.publicUnapproved, true, '기본은 공인 비승인');
  const bad = P.saveVmDnsPolicy({ corps: { 'vc-a': ['10.1.0.0/'] } }, 't');
  assert.equal(bad.ok, false); assert.equal(bad.code, 'invalid');
  const s1 = P.saveVmDnsPolicy({ corps: { 'vc-a': ['10.1.0.0/24'] }, rev: r0.rev }, 't');
  assert.equal(s1.ok, true);
  const stale = P.saveVmDnsPolicy({ publicUnapproved: false, rev: r0.rev }, 't');
  assert.equal(stale.ok, false); assert.equal(stale.code, 'stale', '옛 rev 로는 덮지 않는다');
  P.invalidateVmDnsPolicy();
  assert.deepEqual(P.loadVmDnsPolicy().corps, { 'vc-a': ['10.1.0.0/24'] }, '재시작 뒤에도 같은 값');
  assert.equal(P.loadVmDnsPolicy().rev, s1.policy.rev, 'rev 는 내용 해시 — 재시작해도 같다');
  // 손상 파일 → .corrupt 보존 + 기본값
  fs.writeFileSync(path.join(TMP, P.POLICY_FILE_NAME), '{ broken');
  P.invalidateVmDnsPolicy();
  const r2 = P.loadVmDnsPolicy();
  assert.deepEqual(r2.corps, {});
  assert.ok(fs.readdirSync(TMP).some((f) => f.startsWith(`${P.POLICY_FILE_NAME}.corrupt.`)), '손상본을 보존한다');
  // 손으로 넣은 틀린 항목은 판정에서 빼고 invalid 로 밝힌다
  fs.writeFileSync(path.join(TMP, P.POLICY_FILE_NAME), JSON.stringify({ corps: { 'vc-a': ['10.1.0.53', '010.1.0.54'] } }));
  P.invalidateVmDnsPolicy();
  const r3 = P.loadVmDnsPolicy();
  assert.deepEqual(r3.corps, { 'vc-a': ['10.1.0.53'] });
  assert.equal(r3.invalid.length, 1);
  fs.rmSync(path.join(TMP, P.POLICY_FILE_NAME));
  P.invalidateVmDnsPolicy();
});

/** 가짜 DNS 서버 — mode: 'reply'(REFUSED) · 'silent' · 'wrong-id'. */
async function fakeDns(mode) {
  const udp = dgram.createSocket('udp4');
  udp.on('message', (msg, rinfo) => {
    if (mode === 'silent') return;
    const r = Buffer.from(msg);
    r.writeUInt16BE(0x8105, 2);   // QR + RD + RCODE 5(REFUSED)
    if (mode === 'wrong-id') r.writeUInt16BE((msg.readUInt16BE(0) + 1) & 0xffff, 0);
    udp.send(r, rinfo.port, rinfo.address);
  });
  await new Promise((res) => udp.bind(0, '127.0.0.1', res));
  const port = udp.address().port;
  const tcp = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length < 2 || buf.length < 2 + buf.readUInt16BE(0)) return;
      if (mode === 'silent') return;
      const q = Buffer.from(buf.subarray(2));
      q.writeUInt16BE(0x8105, 2);
      if (mode === 'wrong-id') q.writeUInt16BE((q.readUInt16BE(0) + 1) & 0xffff, 0);
      const len = Buffer.alloc(2); len.writeUInt16BE(q.length, 0);
      sock.write(Buffer.concat([len, q]));
    });
    sock.on('error', () => {});
  });
  await new Promise((res, rej) => { tcp.once('error', rej); tcp.listen(port, '127.0.0.1', res); });
  return { port, close: () => { try { udp.close(); } catch { /* */ } tcp.close(); } };
}
async function fakeDnsAnyPort(mode) {
  for (let i = 0; i < 10; i++) { try { return await fakeDns(mode); } catch { /* TCP 포트 충돌 — 다시 */ } }
  throw new Error('가짜 DNS 서버를 띄우지 못했습니다');
}

test('⑧ 도달성 점검 — 응답(rcode 무관) · 무응답 시한 · ID 불일치 무시 · 닫힌 포트 · busy', async () => {
  const ok = await fakeDnsAnyPort('reply');
  const silent = await fakeDnsAnyPort('silent');
  const wrong = await fakeDnsAnyPort('wrong-id');
  try {
    const u = await PR.probeUdp('127.0.0.1', { port: ok.port, qname: 'a.corp', timeoutMs: 1000 });
    assert.equal(u.ok, true, 'REFUSED 도 DNS 가 살아 있다는 응답이다');
    assert.equal(u.rcode, 'REFUSED');
    assert.ok(u.ms >= 0);
    const t = await PR.probeTcp('127.0.0.1', { port: ok.port, qname: '.', timeoutMs: 1000 });
    assert.equal(t.ok, true); assert.equal(t.rcode, 'REFUSED');
    const s1 = await PR.probeUdp('127.0.0.1', { port: silent.port, timeoutMs: 300 });
    assert.deepEqual([s1.ok, s1.error, s1.rcode], [false, 'timeout', null]);
    const s2 = await PR.probeTcp('127.0.0.1', { port: silent.port, timeoutMs: 300 });
    assert.deepEqual([s2.ok, s2.error], [false, 'timeout']);
    const w = await PR.probeUdp('127.0.0.1', { port: wrong.port, timeoutMs: 300 });
    assert.equal(w.ok, false, 'ID 가 다른 패킷은 응답이 아니다');
    // 닫힌 포트: 서버를 닫은 뒤 같은 포트로
    const closed = await fakeDnsAnyPort('reply');
    closed.close();
    await new Promise((r) => setTimeout(r, 50));
    const c = await PR.probeTcp('127.0.0.1', { port: closed.port, timeoutMs: 1000 });
    assert.equal(c.ok, false); assert.equal(c.error, 'refused');

    // 실행 — 대상 주입·포트 주입(라우트는 53 고정)
    PR._resetVmDnsProbeForTest();
    const targets = [{ ip: '127.0.0.1', qname: 'a.corp', skip: null }, { ip: '10.9.9.9', skip: 'edge-only' }, { ip: '10.8.8.8', skip: 'mock' }];
    const p1 = PR.runVmDnsProbe(targets, { port: ok.port, timeoutMs: 1000 });
    const p2 = await PR.runVmDnsProbe(targets, { port: ok.port });
    assert.equal(p2.busy, true, '진행 중이면 두 번째 실행은 busy');
    const r = await p1;
    assert.equal(r.ok, true);
    assert.deepEqual([r.summary.answered, r.summary.failed, r.summary.edgeOnly, r.summary.skipped], [1, 0, 1, 1]);
    assert.equal(PR.probeResultOf('127.0.0.1').udp.ok, true);
    assert.equal(PR.probeResultOf('10.9.9.9').where, 'edge-only', '엣지 위임은 실패로 세지 않는다');
    assert.equal(PR.probeResultOf('10.8.8.8').skipped, 'mock');
    assert.equal(PR.vmDnsProbeState().running, false);
    // 예산 0 → 시도하지 않고 budget 으로 밝힌다
    const rb = await PR.runVmDnsProbe([{ ip: '127.0.0.1' }], { port: ok.port, budgetMs: -1 });
    assert.equal(rb.summary.skippedBy.budget, 1);
  } finally { ok.close(); silent.close(); wrong.close(); }
  // 패킷 조립
  const q = PR.buildQuery(0x1234, 'a.corp', 6);
  assert.equal(q.readUInt16BE(0), 0x1234);
  assert.equal(q.readUInt16BE(4), 1);
  assert.equal(PR.encodeName('a b.corp'), null);
  assert.equal(PR.parseHeader(Buffer.alloc(5)), null);
});

test('⑨ 변경 이력 — 첫 관측(변경 없음) · 변경 · 모름/미수집 건너뜀 · 첫 병합 전 건너뜀 · 범위 필터', async () => {
  DB._resetVmDnsDbForTest(); PO._resetVmDnsHistoryForTest();
  const T0 = 1_790_000_000_000;
  const snap = snapBase();
  const s0 = await PO.runVmDnsHistoryOnce({ snap: { ...snap, initial: true }, now: T0 });
  assert.equal(s0.reason, 'initial', '첫 병합 전 골격은 비교하지 않는다');
  const r1 = await PO.runVmDnsHistoryOnce({ snap, now: T0 });
  assert.equal(r1.ok, true);
  assert.equal(r1.first, 7, '보고한 VM 7대(템플릿 제외)');
  assert.equal(r1.changed, 0, '첫 관측은 변경 행을 만들지 않는다');
  assert.equal(r1.unknown, 1); assert.equal(r1.notCollected, 1);
  // 변경: A-APP1 의 1·2차 순서가 바뀜 · A-APP2 가 모름이 됨(건너뜀) · A-OLD 는 여전히 미수집
  const snap2 = structuredClone(snap);
  snap2.vms.find((v) => v.id === 'vc-a:app1').dns = dns(['8.8.8.8', '10.1.0.53']);
  snap2.vms.find((v) => v.id === 'vc-a:app2').dns = null;
  const r2 = await PO.runVmDnsHistoryOnce({ snap: snap2, now: T0 + 600_000 });
  assert.equal(r2.changed, 1, '순서 변경도 설정 변경이다 · 모름은 변경이 아니다');
  // 모름이었다가 같은 값으로 돌아오면 변경이 아니다
  const r3 = await PO.runVmDnsHistoryOnce({ snap, now: T0 + 1_200_000 });
  assert.equal(r3.changed, 1, 'A-APP1 만 다시 바뀜(A-APP2 는 원래 값)');
  const all = await DB.listChanges({ since: 0, limit: 50 });
  assert.equal(all.available, true);
  assert.equal(all.changes.length, 2);
  assert.deepEqual(all.changes[1].before, ['10.1.0.53', '8.8.8.8']);
  assert.deepEqual(all.changes[1].after, ['8.8.8.8', '10.1.0.53']);
  assert.equal(all.changes[0].first, false);
  const scoped = await DB.listChanges({ since: 0, limit: 50, vcenterIds: new Set(['vc-b']) });
  assert.equal(scoped.changes.length, 0, '범위 밖 vCenter 의 변경은 주지 않는다');
  const h = await DB.vmHistory('vc-a:app1');
  assert.equal(h.history.length, 3, '변경 2 + 첫 관측 1');
  assert.equal(h.history[2].first, true);
  assert.deepEqual(h.history[2].after, ['10.1.0.53', '8.8.8.8']);
  // 재시작(메모리 비움) 뒤에도 DB 의 최신값으로 비교 — 같은 값이면 변경 없음
  PO._resetVmDnsHistoryForTest();
  const r4 = await PO.runVmDnsHistoryOnce({ snap, now: T0 + 1_800_000 });
  assert.equal(r4.changed, 0); assert.equal(r4.first, 0);
  // 보존·주기 env 의 빈 값 = 기본
  assert.equal(PO.vmDnsRetentionDays(''), 365);
  assert.equal(PO.vmDnsRetentionDays('0'), 0);
  assert.equal(PO.vmDnsRetentionDays('-5'), 365, '음수를 무제한으로 읽지 않는다');
  assert.equal(PO.vmDnsHistoryIntervalMs(''), 600000);
  assert.equal(PO.vmDnsHistoryIntervalMs('1000'), 60_000, '하한 1분');
});

test('⑩ 실제 api 라우터 — 상태코드 · 범위 가림 · 형식 오류 · CSV', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmdns2696r-'));
  // viewer 에게 tools 는 주되 data.csv 는 줄 수 없다(관리 그룹 키).
  fs.writeFileSync(path.join(dir, 'permissions.json'), JSON.stringify({ schemaVersion: 3, matrix: {
    operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
  const script = `
    const express = (await import('express')).default;
    const { store } = await import(${JSON.stringify(path.join(SRC, 'store.js'))});
    await store.refresh?.();
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const snap = store.get();
    const vcs = (snap.vcenters || []).map((v) => v.id);
    const first = vcs[0];
    const firstNames = new Set((snap.vms || []).filter((v) => v.vcenterId === first).map((v) => v.name));
    const otherVmNames = (snap.vms || []).filter((v) => v.vcenterId !== first && !firstNames.has(v.name)).slice(0, 300).map((v) => v.name);
    const users = {
      admin: { username: 'a', role: 'admin', scope: null },
      viewer: { username: 'v', role: 'viewer', scope: null },
      scopedAdmin: { username: 'sa', role: 'admin', scope: { vcenters: [first] } },
      scopedViewer: { username: 'sv', role: 'viewer', scope: { vcenters: [first] } },
    };
    const out = { vcs: vcs.length };
    const app = express(); app.use(express.json());
    let who = 'admin';
    app.use((req, _r, n) => { req.user = users[who]; n(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port + '/api';
    const call = async (u, m, p, b) => { who = u; const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { s: r.status, j, t }; };
    const g = await call('admin', 'GET', '/tools/vm-dns');
    out.adminGet = { s: g.s, vms: g.j?.kpis?.vms, servers: g.j?.serversTotal, scoped: g.j?.scope?.scoped, keys: Object.keys(g.j || {}).sort() };
    const top = g.j?.servers?.[0]?.ip;
    out.server = (await call('admin', 'GET', '/tools/vm-dns/server?ip=' + top + '&limit=3')).s;
    const srvRes = await call('admin', 'GET', '/tools/vm-dns/server?ip=' + top + '&limit=3');
    out.serverRows = srvRes.j?.vms?.length; out.serverTrunc = srvRes.j?.truncated;
    out.server404 = (await call('admin', 'GET', '/tools/vm-dns/server?ip=192.0.2.250')).s;
    out.server400 = (await call('admin', 'GET', '/tools/vm-dns/server?ip=not-an-ip')).s;
    out.vm404 = (await call('admin', 'GET', '/tools/vm-dns/vm?id=nope')).s;
    const someVm = (snap.vms || []).find((v) => v.vcenterId !== first && v.template !== true);
    out.vmAdmin = (await call('admin', 'GET', '/tools/vm-dns/vm?id=' + encodeURIComponent(someVm.id))).s;
    out.vmScoped = (await call('scopedViewer', 'GET', '/tools/vm-dns/vm?id=' + encodeURIComponent(someVm.id))).s;
    out.viewerGet = (await call('viewer', 'GET', '/tools/vm-dns')).s;
    out.viewerPut = await call('viewer', 'PUT', '/tools/vm-dns/policy', { corps: {} });
    out.viewerProbe = (await call('viewer', 'POST', '/tools/vm-dns/probe', {})).s;
    out.scopedAdminPut = (await call('scopedAdmin', 'PUT', '/tools/vm-dns/policy', { corps: {} })).s;
    out.scopedAdminProbe = (await call('scopedAdmin', 'POST', '/tools/vm-dns/probe', {})).s;
    out.badPut = await call('admin', 'PUT', '/tools/vm-dns/policy', { corps: { [first]: ['010.0.0.1', '10.0.0.0/'] } });
    out.okPut = await call('admin', 'PUT', '/tools/vm-dns/policy', { corps: { [first]: ['10.0.0.0/8'], 'vc-gone': ['10.1.0.53'] } });
    out.stalePut = (await call('admin', 'PUT', '/tools/vm-dns/policy', { publicUnapproved: false, rev: 'old' })).s;
    const sg = await call('scopedViewer', 'GET', '/tools/vm-dns');
    out.scoped = { s: sg.s, scoped: sg.j?.scope?.scoped, omitted: sg.j?.scope?.omittedOutOfScope, vcs: (sg.j?.vcenters || []).map((v) => v.id),
      leak: otherVmNames.filter((n) => n && sg.t.includes('"' + n + '"')).length, policyCorps: sg.j?.kpis?.policyCorps };
    const sp = await call('scopedViewer', 'GET', '/tools/vm-dns/policy');
    out.scopedPolicy = Object.keys(sp.j?.corps || {});
    const pr = await call('admin', 'POST', '/tools/vm-dns/probe', {});
    out.probe = { s: pr.s, skipped: pr.j?.summary?.skipped, mock: pr.j?.summary?.skippedBy?.mock, failed: pr.j?.summary?.failed };
    out.changes = (await call('admin', 'GET', '/tools/vm-dns/changes?days=9999&limit=-5')).j;
    who = 'admin';
    const c = await fetch(base + '/tools/vm-dns.csv');
    const buf = Buffer.from(await c.arrayBuffer());
    out.csv = { s: c.status, bom: buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, head: buf.subarray(3).toString('utf8').slice(0, 60) };
    out.viewerCsv = (await call('viewer', 'GET', '/tools/vm-dns.csv')).s;
    srv.close();
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true' }, encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  assert.equal(r.status, 0, (r.stderr || '').slice(-2000));
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, r.stdout.slice(-800));
  const o = JSON.parse(line.slice(2));
  assert.equal(o.adminGet.s, 200);
  assert.ok(o.adminGet.vms > 100 && o.adminGet.servers > 3, JSON.stringify(o.adminGet));
  for (const k of ['changes', 'checks', 'domains', 'generatedAt', 'kpis', 'matrix', 'probe', 'scope', 'search', 'servers', 'serversOmitted', 'serversTotal', 'vcenters']) {
    assert.ok(o.adminGet.keys.includes(k), `계약 필드 ${k}`);
  }
  assert.equal(o.server, 200); assert.equal(o.serverRows, 3); assert.equal(o.serverTrunc, true);
  assert.equal(o.server404, 404); assert.equal(o.server400, 400); assert.equal(o.vm404, 404);
  assert.equal(o.vmAdmin, 200); assert.equal(o.vmScoped, 404, '범위 밖 VM 은 404(존재 은닉)');
  assert.equal(o.viewerGet, 200);
  assert.equal(o.viewerPut.s, 403); assert.ok(o.viewerPut.j?.requiredRole, 'viewer 정책 저장은 역할 403');
  assert.equal(o.viewerProbe, 403);
  assert.equal(o.scopedAdminPut, 403, '범위 관리자는 전 법인 공통 정책을 바꾸지 못한다');
  assert.equal(o.scopedAdminProbe, 403);
  assert.equal(o.badPut.s, 400); assert.equal(o.badPut.j.invalid.length, 2);
  assert.equal(o.okPut.s, 200); assert.deepEqual(o.okPut.j.orphan, ['vc-gone']);
  assert.equal(o.stalePut, 409);
  assert.equal(o.scoped.s, 200); assert.equal(o.scoped.scoped, true);
  assert.equal(o.scoped.vcs.length, 1); assert.equal(o.scoped.omitted, o.vcs - 1);
  assert.equal(o.scoped.leak, 0, '범위 밖 VM 이름이 응답에 있다');
  assert.equal(o.scoped.policyCorps, 1);
  assert.equal(o.scopedPolicy.length, 1, '범위 계정은 자기 법인 정책만 본다');
  assert.equal(o.probe.s, 200); assert.ok(o.probe.mock > 0, '목 vCenter DNS 는 점검하지 않는다(지어내지 않는다)'); assert.equal(o.probe.failed, 0);
  assert.equal(o.changes.days, 90, 'days 1~90 클램프');
  assert.equal(o.csv.s, 200); assert.equal(o.csv.bom, true); assert.match(o.csv.head, /^vCenter,VM,전원/);
  assert.equal(o.viewerCsv, 403, 'CSV 는 data.csv 권한');
  // 감사 로그 — 옵션 객체 호출(작업 이름이 남는다)
  const audit = fs.readFileSync(path.join(dir, 'audit.ndjson'), 'utf8');
  assert.match(audit, /"action":"VM DNS 정책 저장"/);
  assert.match(audit, /"action":"VM DNS CSV 내보내기"/);
  assert.match(audit, /"user":"a"/);
});

test('⑪ 등록 — 도구 매핑 · 엣지 로그 표 · 서비스 점검 · DB 이전 대상 · 설정 파일 분류', async () => {
  const TA = await import('../src/auth/toolAccess.js');
  assert.equal(TA.toolKeyForPath('/vm-dns'), 'vm-dns');
  assert.equal(TA.toolKeyForPath('/vm-dns.csv'), 'vm-dns');
  assert.equal(TA.toolKeyForPath('/VM-DNS/server'), 'vm-dns');
  const { STATUS_SPEC } = await import('../src/edgelog/spec.js');
  assert.ok(STATUS_SPEC.some((s) => s.key === 'collect.vmDns' && s.fn === 'vmDnsHistoryStatus'));
  const { MIGRATABLE } = await import('../src/insights/dbLocation.js');
  assert.ok(MIGRATABLE.some((m) => m.file === 'vm-dns.db'));
  const { isRuntimeStateFile } = await import('../src/backup/service.js');
  assert.equal(isRuntimeStateFile('vm-dns-policy.json'), false, '정책은 설정이다(백업 변경 감시 대상)');
  const { PRESET } = await import('../src/toolcats/catalog.js');
  const netTools = PRESET.find((c) => c.id === 'network').tools;
  assert.equal(netTools.indexOf('vm-dns'), netTools.indexOf('ipam') + 1, 'ipam 옆');
  const st = PO.vmDnsHistoryStatus();
  assert.ok(st.intervalMs >= 60_000 && 'lastRunAt' in st);
});
