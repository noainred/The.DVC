// v2.991 — IP 스캔 호스트명 확인(역DNS · mDNS · NetBIOS). 사용자 요청 "Angry IP Scanner 처럼 ip scan 에 hostname 도 보이게" ·
//   시안 docs/design/ip-scan-hostname · 컨펌(방식 3가지 · 새 방식 기본 켜짐 · NetBIOS MAC 수집 · 표준 + 변이 검증 1회).
// 실제 모듈을 호출해 값으로 본다: 패킷 파서(정상 · 잘림 · 포인터 순환 · 무작위 입력) · UDP 왕복(루프백 실제 소켓 + 위조 응답 걸러내기) ·
//   scanRanges 마지막 단계 · scanStore 정제/저장 규칙(miss · 묻지 않음 · 이름 변경 · 옛 엣지) · 중앙 /ip-scan-result · 엣지 보고 본문 ·
//   대장 /tools/ipam · /tools/ipam/history · scan-report.csv(자식 프로세스 — 목 데이터).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOKEN = 'tok-2991-shared';
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2991-'));
process.env.CONFIG_DIR = CFG;
process.env.CENTRAL_TOKEN = TOKEN;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'true';
process.env.IPAM_WRITE_DEBOUNCE_MS = '60000';
process.env.IPAM_FPING = '0';
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

const np = await import('../src/ipam/nameProbe.js');
const hn = await import('../src/ipam/hostNames.js');
const scan = await import('../src/ipam/scan.js');
const ss = await import('../src/ipam/scanStore.js');
const { ipToNum } = await import('../src/util/ipv4.js');
const quiet = async (fn) => { const w = console.warn; const l = console.log; console.warn = () => {}; console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; } };

// ── 패킷 만들기(테스트용 응답자) ─────────────────────────────────────────────
function nbEntry(name, suffix, flags) { const b = Buffer.alloc(18, 0x20); b.write(name.slice(0, 15), 0, 'latin1'); b[15] = suffix; b.writeUInt16BE(flags, 16); return b; }
function nbResponse(txid, entries, { mac = [0x00, 0x50, 0x56, 0xab, 0xcd, 0xef], flags = 0x8400, qd = 0, an = 1, type = 0x21, stats = 40, count = null } = {}) {
  const hdr = Buffer.alloc(12); hdr.writeUInt16BE(txid & 0xffff, 0); hdr.writeUInt16BE(flags, 2); hdr.writeUInt16BE(qd, 4); hdr.writeUInt16BE(an, 6);
  const name = Buffer.concat([Buffer.from([0x20]), Buffer.from(`CK${'A'.repeat(30)}`, 'latin1'), Buffer.from([0])]);
  const rdata = Buffer.concat([Buffer.from([count ?? entries.length]), ...entries.map(([n, s, f]) => nbEntry(n, s, f)), Buffer.from(mac), Buffer.alloc(stats)]);
  const rr = Buffer.alloc(10); rr.writeUInt16BE(type, 0); rr.writeUInt16BE(1, 2); rr.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([hdr, name, rr, rdata]);
}
const WIN = [['WIN-APP01', 0x00, 0x0400], ['CORP', 0x00, 0x8400], ['WIN-APP01', 0x20, 0x0400], ['ALICE', 0x03, 0x0400]];
function encName(n) { return Buffer.concat([...n.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, 'ascii')])), Buffer.from([0])]); }
function ptrResponse(txid, ip, target, { owner = null, type = 12, flags = 0x8400 } = {}) {
  const hdr = Buffer.alloc(12); hdr.writeUInt16BE(txid & 0xffff, 0); hdr.writeUInt16BE(flags, 2); hdr.writeUInt16BE(1, 4); hdr.writeUInt16BE(1, 6);
  const q = Buffer.concat([encName(np.reverseName(ip)), Buffer.from([0, 12, 0, 1])]);
  const ownerBuf = owner ? encName(owner) : Buffer.from([0xc0, 0x0c]); // 질문의 이름을 가리키는 압축 포인터
  const rdata = encName(target);
  const rr = Buffer.alloc(10); rr.writeUInt16BE(type, 0); rr.writeUInt16BE(0x8001, 2); rr.writeUInt32BE(120, 4); rr.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([hdr, q, ownerBuf, rr, rdata]);
}

// ── ① NetBIOS ────────────────────────────────────────────────────────────────
test('① NBSTAT 요청은 50바이트 · 와일드카드 이름 · NBSTAT/IN', () => {
  const b = np.nbstatRequest(0x1234);
  assert.equal(b.length, 50);
  assert.equal(b.readUInt16BE(0), 0x1234);
  assert.equal(b.readUInt16BE(4), 1);
  assert.equal(b[12], 0x20);
  assert.equal(b.toString('latin1', 13, 45), `CK${'A'.repeat(30)}`);
  assert.equal(b[45], 0);
  assert.equal(b.readUInt16BE(46), 0x21);
  assert.equal(b.readUInt16BE(48), 1);
});

test('① NBSTAT 응답 → 컴퓨터 이름 · 작업 그룹 · MAC(사용자 이름은 읽지 않는다)', () => {
  assert.deepEqual(np.parseNbstat(nbResponse(7, WIN), 7), { name: 'WIN-APP01', group: 'CORP', mac: '00:50:56:AB:CD:EF' });
  // 접미 0x00 unique 가 없으면 0x20(파일 서버) 이름
  assert.equal(np.parseNbstat(nbResponse(7, [['CORP', 0x00, 0x8400], ['NAS01', 0x20, 0x0400]]), 7).name, 'NAS01');
  // Samba 는 MAC 을 0 으로 보낸다 → ''
  assert.equal(np.parseNbstat(nbResponse(7, WIN, { mac: [0, 0, 0, 0, 0, 0] }), 7).mac, '');
  // 제어 문자는 버리고 비 ASCII 는 '?'
  assert.equal(np.parseNbstat(nbResponse(7, [['A\u0001BéC', 0x00, 0x0400]]), 7).name, 'AB?C');
  // 거래 ID 가 다르면 · 응답 표지 없음 · 오류 코드 · 답 0개 · 형식이 NBSTAT 아님 → null
  assert.equal(np.parseNbstat(nbResponse(7, WIN), 8), null);
  assert.equal(np.parseNbstat(nbResponse(7, WIN, { flags: 0x0000 }), 7), null);
  assert.equal(np.parseNbstat(nbResponse(7, WIN, { flags: 0x8403 }), 7), null);
  assert.equal(np.parseNbstat(nbResponse(7, WIN, { an: 0 }), 7), null);
  assert.equal(np.parseNbstat(nbResponse(7, WIN, { type: 0x20 }), 7), null);
  // 이름 개수가 버퍼보다 크면(잘린 응답) null — 버퍼 밖을 읽지 않는다
  assert.equal(np.parseNbstat(nbResponse(7, WIN, { count: 200, stats: 0 }), 7), null);
  const full = nbResponse(7, WIN);
  for (const n of [0, 11, 12, 30, 46, 55, 57, 60, 57 + 18 * 2]) assert.equal(np.parseNbstat(full.subarray(0, n), 7), null, `잘린 길이 ${n}`);
  // 이름 표까지만 오고 MAC 이 없으면 이름만
  const noMac = nbResponse(7, WIN, { mac: [], stats: 0 });
  assert.deepEqual(np.parseNbstat(noMac, 7), { name: 'WIN-APP01', group: 'CORP', mac: '' });
  assert.equal(np.parseNbstat('nope', 7), null);
});

// ── ② mDNS(역방향 PTR) ────────────────────────────────────────────────────────
test('② PTR 질의 · 응답 — 물어본 역이름의 PTR 만 · 압축 포인터 · 순환 포인터는 null', () => {
  assert.equal(np.reverseName('10.210.5.22'), '22.5.210.10.in-addr.arpa');
  assert.equal(np.reverseName('010.0.0.5'), '', '비정규 표기는 묻지 않는다');
  assert.equal(np.ptrQuery(1, '010.0.0.5'), null);
  const q = np.ptrQuery(0xbeef, '10.210.5.22');
  assert.equal(q.readUInt16BE(0), 0xbeef);
  assert.equal(np.readDnsName(q, 12), '22.5.210.10.in-addr.arpa');
  assert.equal(q.readUInt16BE(q.length - 4), 12);
  assert.equal(np.parsePtrAnswer(ptrResponse(5, '10.210.5.22', 'web-stg-02.local'), 5, '10.210.5.22'), 'web-stg-02.local');
  assert.equal(np.parsePtrAnswer(ptrResponse(5, '10.210.5.22', 'web-stg-02.local'), 6, '10.210.5.22'), null, '거래 ID');
  assert.equal(np.parsePtrAnswer(ptrResponse(5, '10.210.5.22', 'x.local'), 5, '10.210.5.23'), null, '다른 IP 의 답');
  assert.equal(np.parsePtrAnswer(ptrResponse(5, '10.210.5.22', 'x.local', { owner: '99.5.210.10.in-addr.arpa' }), 5, '10.210.5.22'), null, '다른 역이름의 PTR');
  assert.equal(np.parsePtrAnswer(ptrResponse(5, '10.210.5.22', 'x.local', { type: 1 }), 5, '10.210.5.22'), null, 'PTR 아님');
  assert.equal(np.parsePtrAnswer(ptrResponse(5, '10.210.5.22', 'x.local', { flags: 0x0000 }), 5, '10.210.5.22'), null, '응답 아님');
  // 자기 자신을 가리키는 포인터 — 끝나지 않는 루프 대신 null
  const loop = Buffer.concat([Buffer.alloc(12), Buffer.from([0xc0, 0x0c])]);
  assert.equal(np.readDnsName(loop, 12), null);
  // 두 포인터가 서로 가리킨다
  const ping = Buffer.concat([Buffer.alloc(12), Buffer.from([0xc0, 0x0e, 0xc0, 0x0c])]);
  assert.equal(np.readDnsName(ping, 12), null);
});

test('② 무작위 입력 · 비트 뒤집기 4,000회 — 파서는 던지지 않고 결과는 상한 · 인쇄 가능한 글자만', () => {
  let seed = 2991;
  const R = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const okName = (v, max) => v == null || (typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v));
  const nb = nbResponse(9, WIN); const pr = ptrResponse(9, '10.0.0.9', 'host-a.local');
  for (let i = 0; i < 2000; i++) {
    const rnd = Buffer.alloc(Math.floor(R() * 600)); for (let j = 0; j < rnd.length; j++) rnd[j] = Math.floor(R() * 256);
    const a = Buffer.from(nb); const b = Buffer.from(pr);
    for (let k = 0; k < 4; k++) { a[Math.floor(R() * a.length)] ^= 1 << Math.floor(R() * 8); b[Math.floor(R() * b.length)] ^= 1 << Math.floor(R() * 8); }
    for (const buf of [rnd, a]) {
      const r = np.parseNbstat(buf, 9);
      assert.ok(r == null || (okName(r.name, 15) && okName(r.group, 15) && /^$|^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(r.mac)), JSON.stringify(r));
    }
    for (const buf of [rnd, b]) assert.ok(okName(np.parsePtrAnswer(buf, 9, '10.0.0.9'), 253));
  }
});

// ── ③ 같은 서브넷 판정 ────────────────────────────────────────────────────────
test('③ mDNS 대상 — 이 장비의 IPv4 인터페이스와 같은 서브넷만(내부 · /0 제외)', () => {
  const nets = np.localSubnets({
    eth0: [{ family: 'IPv4', address: '10.210.5.7', netmask: '255.255.255.0', internal: false }, { family: 'IPv6', address: 'fe80::1', netmask: 'ffff::', internal: false }],
    lo: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
    odd: [{ family: 4, address: '192.168.9.9', netmask: '0.0.0.0', internal: false }],
  });
  assert.equal(nets.length, 1);
  assert.equal(np.onLink('10.210.5.40', nets), true);
  assert.equal(np.onLink('10.210.6.1', nets), false);
  assert.equal(np.onLink('127.0.0.1', nets), false);
  assert.equal(np.onLink('192.168.9.10', nets), false, '/0 은 모든 주소를 같은 구간으로 만든다 — 버린다');
  assert.equal(np.onLink('bogus', nets), false);
});

// ── ④ UDP 묶음 질의 ──────────────────────────────────────────────────────────
function fakeSockets(reply) {
  const sent = [];
  const createSocket = () => {
    const s = new EventEmitter();
    s.bind = (_p, cb) => { setImmediate(cb); };
    s.send = (buf, port, ip, cb) => { sent.push({ buf, port, ip }); setImmediate(() => { cb?.(); reply(buf, port, ip, s); }); };
    s.close = () => { s.closed = true; };
    return s;
  };
  return { createSocket, sent };
}

test('④ 물어본 IP · 그 포트 · 맞는 거래 ID 의 응답만 받는다(위조 · 다른 포트 · 묻지 않은 IP 는 버린다)', async () => {
  const { createSocket, sent } = fakeSockets((buf, port, ip, s) => {
    const id = buf.readUInt16BE(0);
    if (ip === '10.0.0.1') s.emit('message', nbResponse(id, WIN), { address: ip, port });                      // 정상
    if (ip === '10.0.0.2') s.emit('message', nbResponse(id, WIN), { address: ip, port: 138 });                 // 다른 포트
    if (ip === '10.0.0.3') s.emit('message', nbResponse(id + 1, WIN), { address: ip, port });                  // 거래 ID 다름
    if (ip === '10.0.0.4') s.emit('message', nbResponse(id, WIN), { address: '10.0.0.99', port });             // 묻지 않은 IP 가 답함
  });
  const out = await np.probeNetbios(['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.1', '010.0.0.5'], { timeoutMs: 80, createSocket });
  assert.deepEqual([...out.keys()], ['10.0.0.1']);
  assert.deepEqual(sent.map((x) => x.ip), ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'], '중복 · 비정규 표기는 보내지 않는다');
  assert.ok(sent.every((x) => x.port === 137 && x.buf.length === 50));
  // 대상이 하나일 때 다른 주소가 **같은 거래 ID** 로 답해도 받지 않는다(거래 ID 만 보면 통과한다 — 변이 M2 가 살아남던 빈틈)
  const one = fakeSockets((buf, port, _ip, s) => { s.emit('message', nbResponse(buf.readUInt16BE(0), WIN), { address: '10.0.0.99', port }); });
  const r2 = await np.probeNetbios(['10.0.0.4'], { timeoutMs: 60, createSocket: one.createSocket });
  assert.equal(r2.size, 0, JSON.stringify([...r2.keys()]));
});

test('④ 실제 UDP 왕복(루프백) — NetBIOS · mDNS 응답자에게 묻고 이름을 받는다', async () => {
  const listenUdp = (onMsg) => new Promise((r) => { const s = dgram.createSocket('udp4'); s.on('message', (m, ri) => onMsg(s, m, ri)); s.bind(0, '127.0.0.1', () => r(s)); });
  let nbReq = null;
  const nb = await listenUdp((s, m, ri) => { nbReq = Buffer.from(m); s.send(nbResponse(m.readUInt16BE(0), [['LOOPBOX', 0x00, 0x0400], ['WG', 0x00, 0x8400]]), ri.port, ri.address); });
  const md = await listenUdp((s, m, ri) => { s.send(ptrResponse(m.readUInt16BE(0), '127.0.0.1', 'loopbox.local'), ri.port, ri.address); });
  try {
    const a = await np.probeNetbios(['127.0.0.1'], { port: nb.address().port, timeoutMs: 1500 });
    assert.deepEqual(a.get('127.0.0.1'), { name: 'LOOPBOX', group: 'WG', mac: '00:50:56:AB:CD:EF' });
    assert.deepEqual(nbReq.subarray(2), np.nbstatRequest(0).subarray(2), '응답자가 받은 질의가 NBSTAT 요청 그대로');
    const b = await np.probeMdns(['127.0.0.1'], { port: md.address().port, timeoutMs: 1500 });
    assert.equal(b.get('127.0.0.1'), 'loopbox.local');
    // 아무도 답하지 않으면 빈 결과(시한 뒤 끝난다)
    const t0 = Date.now();
    const c = await np.probeNetbios(['127.0.0.1'], { port: md.address().port === 1 ? 2 : 9, timeoutMs: 120 });
    assert.equal(c.size, 0);
    assert.ok(Date.now() - t0 < 2000);
  } finally { nb.close(); md.close(); }
});

// ── ⑤ 표시 규칙(hostNames) ───────────────────────────────────────────────────
test('⑤ 표시 이름 = 역DNS > mDNS > NetBIOS · 이름 다름은 첫 라벨 · 소문자 · 15자로 비교 · 관리상태 이름이 먼저', () => {
  assert.deepEqual(hn.NAME_METHODS, ['dns', 'mdns', 'netbios']);
  assert.deepEqual(hn.displayName({ netbios: 'NB', mdns: 'm.local', dns: 'd.corp' }), { name: 'd.corp', src: 'dns' });
  assert.deepEqual(hn.displayName({ netbios: { v: 'NB' }, mdns: { v: '' } }), { name: 'NB', src: 'netbios' });
  assert.deepEqual(hn.displayName(null), { name: '', src: '' });
  assert.equal(hn.nameMismatch({ dns: 'win-app01.corp.example', netbios: 'WIN-APP01' }), null);
  assert.equal(hn.nameMismatch({ dns: 'averyveryverylongname01.corp', netbios: 'AVERYVERYVERYLO' }), null, 'NetBIOS 15자 절단');
  assert.deepEqual(hn.nameMismatch({ dns: 'fs-old.corp.example', netbios: 'NAS-BACKUP' }), [{ src: 'netbios', v: 'NAS-BACKUP' }]);
  const sc = { names: { dns: { v: 'fs-old.corp', at: 5, miss: 1 }, netbios: { v: 'NAS', at: 6, miss: 0 } }, tried: ['dns', 'netbios'] };
  assert.deepEqual(hn.netNameFields(sc, null), { netName: 'fs-old.corp', netNameSrc: 'dns', netNameStale: true, netNameAt: 5, nameMismatch: true, nameAlt: [{ src: 'netbios', v: 'NAS' }] });
  assert.equal(hn.netNameFields(sc, { hostnameOverride: ' idrac-b12 ' }).netName, 'idrac-b12');
  assert.equal(hn.netNameFields(sc, { hostnameOverride: 'x' }).netNameSrc, 'manual');
  assert.deepEqual(hn.netNameFields({ tried: [] }, null), { nameUnchecked: true });
  assert.deepEqual(hn.netNameFields({ tried: ['dns'] }, null), {}, '물었는데 답 없음 = 확인 안 함이 아니다');
  assert.deepEqual(hn.netNameFields(null, null), {});
});

// ── ⑥ 스캔 엔진 마지막 단계 ──────────────────────────────────────────────────
test('⑥ resolveNames — 세 방식을 함께 묻고 mDNS 는 같은 서브넷만 · 물어본 방식(tried) · 요약', async () => {
  let nbAsked = null; let mdAsked = null;
  const subnets = [{ net: ipToNum('10.0.0.0'), mask: ipToNum('255.255.255.0') }];
  const probes = {
    reverse: async () => new Map([['10.0.0.1', 'a.corp']]),
    netbios: async (ips) => { nbAsked = ips; return new Map([['10.0.0.1', { name: 'A', group: 'G', mac: '' }], ['10.9.9.9', { name: 'FAR', group: '', mac: '00:11:22:33:44:55' }]]); },
    mdns: async (ips) => { mdAsked = ips; return new Map([['10.0.0.2', 'b.local']]); },
  };
  const r = await scan.resolveNames(['10.0.0.1', '10.0.0.2', '10.9.9.9'], { subnets, timeoutMs: 50, probes });
  assert.deepEqual(nbAsked, ['10.0.0.1', '10.0.0.2', '10.9.9.9']);
  assert.deepEqual(mdAsked, ['10.0.0.1', '10.0.0.2']);
  assert.deepEqual(r.byIp.get('10.0.0.1').names, { dns: 'a.corp', netbios: 'A' });
  assert.deepEqual(r.byIp.get('10.0.0.1').tried, ['dns', 'mdns', 'netbios']);
  assert.deepEqual(r.byIp.get('10.9.9.9').tried, ['dns', 'netbios']);
  assert.equal(r.byIp.get('10.9.9.9').nb.mac, '00:11:22:33:44:55');
  assert.deepEqual(r.stats, { tried: { dns: 3, mdns: 2, netbios: 3 }, found: { dns: 1, mdns: 1, netbios: 2 }, named: 3 });
  // 모두 끄면 묻지 않는다
  let called = 0;
  const off = await scan.resolveNames(['10.0.0.1'], { reverseDns: false, mdns: false, netbios: false, subnets, probes: { reverse: async () => { called++; return new Map(); }, netbios: async () => { called++; return new Map(); }, mdns: async () => { called++; return new Map(); } } });
  assert.equal(called, 0);
  assert.deepEqual(off.byIp.get('10.0.0.1').tried, []);
});

test('⑥ scanRanges — 응답한 IP 에 이름 확인을 붙인다(표시 이름 · 방식별 이름 · 그룹 · MAC · tried · nameStats)', async () => {
  const srv = await new Promise((r) => { const s = net.createServer((c) => c.end()); s.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const out = await scan.scanRanges(['127.0.0.1'], {
      ports: [srv.address().port], ping: false, reverseDns: false, mdns: false, netbios: true, timeoutMs: 500,
      nameOpts: { probes: { netbios: async () => new Map([['127.0.0.1', { name: 'LOOPBOX', group: 'WG', mac: '00:11:22:33:44:55' }]]) } },
    });
    assert.equal(out.alive.length, 1);
    const row = out.alive[0];
    assert.equal(row.hostname, 'LOOPBOX');
    assert.deepEqual(row.names, { netbios: 'LOOPBOX' });
    assert.deepEqual(row.tried, ['netbios']);
    assert.equal(row.nbGroup, 'WG');
    assert.equal(row.mac, '00:11:22:33:44:55');
    assert.deepEqual(out.nameStats, { tried: { dns: 0, mdns: 0, netbios: 1 }, found: { dns: 0, mdns: 0, netbios: 1 }, named: 1, alive: 1 });
  } finally { srv.close(); }
});

// ── ⑦ 저장(scanStore) ────────────────────────────────────────────────────────
test('⑦ 설정 — mDNS · NetBIOS 는 기본 켜짐(키 없는 옛 설정 포함) · 에이전트별로 끈다', () => {
  const a = ss.loadScanSettings('edge-new-2991');
  assert.equal(a.mdns, true); assert.equal(a.netbios, true); assert.equal(a.reverseDns, true);
  const b = ss.saveScanSettings('edge-new-2991', { mdns: false });
  assert.equal(b.mdns, false); assert.equal(b.netbios, true);
  assert.equal(ss.saveScanSettings('edge-new-2991', { netbios: false, mdns: true }).netbios, false);
  assert.equal(ss.loadScanSettings('edge-new-2991').mdns, true);
});

test('⑦ 엣지가 보낸 새 칸은 아는 키 · 아는 모양만(names · tried · nbGroup · mac)', () => {
  ss.mergeScanResults([{
    ip: '10.91.0.1', openPorts: [445], services: ['SMB'], hostname: 'ignored-when-names',
    names: { dns: { x: 1 }, evil: 'a', netbios: 'A\u0000B', mdns: ['m'] }, tried: ['dns', 'bogus', 'dns', 'netbios', { a: 1 }],
    nbGroup: `G${'x'.repeat(40)}\u0007`, mac: 'zz:zz', extra: { big: 'x'.repeat(1000) },
  }, { ip: '10.91.0.2', names: 'str', tried: 'dns', mac: '00-50-56-aa-bb-cc', nbGroup: { g: 1 } }], 1_800_000_000_000, 'e-clean');
  const r = ss.getScanResults();
  assert.deepEqual(r['10.91.0.1'].names, { netbios: { v: 'AB', at: 1_800_000_000_000, miss: 0 } });
  assert.equal(r['10.91.0.1'].hostname, 'AB', '표시 이름은 방식별 이름에서 다시 고른다');
  assert.deepEqual(r['10.91.0.1'].tried, ['dns', 'netbios']);
  assert.equal(r['10.91.0.1'].nbGroup, `G${'x'.repeat(14)}`);
  assert.equal(r['10.91.0.1'].mac, undefined);
  assert.equal(r['10.91.0.1'].extra, undefined);
  // names 가 객체가 아니고 tried 도 배열이 아니다 = 옛 엣지 모양 — hostname 이 없으니 이름 없음 · MAC 은 NetBIOS 이름이 없으면 싣지 않는다
  assert.equal(r['10.91.0.2'].names, undefined);
  assert.equal(r['10.91.0.2'].mac, undefined);
});

test('⑦ 답 없음은 miss 로 센다(NAME_MISS_MAX 에 지움) · 묻지 않은 방식은 지운다 · 그룹/MAC 은 NetBIOS 를 따라간다', () => {
  const ip = '10.92.0.1'; let t = 1_800_000_100_000;
  const put = (row) => { t += 60_000; ss.mergeScanResults([{ ip, openPorts: [445], services: ['SMB'], ...row }], t, 'e-miss'); return ss.getScanResults()[ip]; };
  let e = put({ names: { dns: 'fs.corp', netbios: 'FS' }, tried: ['dns', 'netbios'], nbGroup: 'CORP', mac: '00:50:56:00:00:01' });
  assert.equal(e.hostname, 'fs.corp'); assert.equal(e.mac, '00:50:56:00:00:01');
  const rev0 = ss.scanRev();
  e = put({ names: { dns: 'fs.corp' }, tried: ['dns', 'netbios'] });   // NetBIOS 무응답 1
  assert.equal(e.names.netbios.miss, 1); assert.equal(e.names.netbios.v, 'FS'); assert.equal(e.mac, '00:50:56:00:00:01', '그룹/MAC 은 이름과 함께 남는다');
  assert.ok(ss.scanRev() > rev0, "'지난 스캔 무응답' 표지가 생기면 대장을 다시 만든다");
  const rev1 = ss.scanRev();
  e = put({ names: { dns: 'fs.corp' }, tried: ['dns', 'netbios'] });   // 무응답 2 — 표지는 그대로
  assert.equal(e.names.netbios.miss, 2);
  assert.equal(ss.scanRev(), rev1, 'miss 1→2 · 확인 시각만 바뀐 보고는 대장을 다시 만들지 않는다');
  e = put({ names: { dns: 'fs.corp' }, tried: ['dns', 'netbios'] });   // 무응답 3 = NAME_MISS_MAX → 지움
  assert.equal(hn.NAME_MISS_MAX, 3);
  assert.equal(e.names.netbios, undefined); assert.equal(e.nbGroup, undefined); assert.equal(e.mac, undefined);
  // 묻지 않은 방식은 지운다(그 방식을 끈 에이전트)
  e = put({ names: { dns: 'fs.corp', netbios: 'FS' }, tried: ['dns', 'netbios'], mac: '00:50:56:00:00:02' });
  e = put({ names: { dns: 'fs.corp' }, tried: ['dns'] });
  assert.equal(e.names.netbios, undefined); assert.equal(e.mac, undefined);
  // 방식이 모두 꺼짐 → 이름 없음 · tried []
  e = put({ tried: [] });
  assert.equal(e.names, undefined); assert.equal(e.hostname, ''); assert.deepEqual(e.tried, []);
});

test('⑦ 같은 방식이 다른 이름을 답하면 이력 renames 에(대소문자만 다르면 아님) · up/down events 에는 섞지 않는다', () => {
  const ip = '10.93.0.1'; let t = 1_800_000_200_000;
  const put = (names) => { t += 60_000; ss.mergeScanResults([{ ip, openPorts: [445], services: ['SMB'], names, tried: ['dns', 'netbios'] }], t, 'e-ren'); };
  put({ netbios: 'FS-OLD' });
  put({ netbios: 'fs-old' });
  put({ netbios: 'NAS-BACKUP' });
  const h = ss.getIpHistory(ip);
  assert.deepEqual(h.renames.map((x) => [x.src, x.from, x.to]), [['netbios', 'fs-old', 'NAS-BACKUP']]);
  assert.ok(h.events.every((e) => e.type === 'up' || e.type === 'down'));
});

test('⑦ 옛 엣지(tried 없음)는 역DNS 만 물은 것 · 부분 결과(seenOnly)는 이름을 건드리지 않는다', () => {
  const ip = '10.94.0.1';
  ss.mergeScanResults([{ ip, openPorts: [22], services: ['SSH'], hostname: 'old.corp' }], 1_800_000_300_000, 'e-old');
  assert.deepEqual(ss.getScanResults()[ip].names, { dns: { v: 'old.corp', at: 1_800_000_300_000, miss: 0 } });
  ss.mergeScanResults([{ ip, openPorts: [22], services: ['SSH'], hostname: '' }], 1_800_000_360_000, 'e-old', { seenOnly: true });
  assert.equal(ss.getScanResults()[ip].names.dns.miss, 0, '부분 결과는 이름 단계에 닿지 못했다');
  ss.mergeScanResults([{ ip, openPorts: [22], services: ['SSH'], hostname: '' }], 1_800_000_420_000, 'e-old');
  assert.equal(ss.getScanResults()[ip].names.dns.miss, 1, '옛 엣지의 빈 hostname = 역DNS 무응답');
});

test('⑦ 보고 요약 nameStats — 수치만 · 못 읽은 칸 null · 미완료 기록이 지우지 않는다 · 실행 이력에도', () => {
  ss.recordAgentReport('e-ns', { scanned: 10, alive: 4, nameStats: { tried: { dns: '4', mdns: { a: 1 }, netbios: -1 }, found: { dns: 2 }, named: 3, alive: 4, junk: 'x' } });
  const want = { tried: { dns: 4, mdns: null, netbios: null }, found: { dns: 2, mdns: null, netbios: null }, named: 3, alive: 4 };
  assert.deepEqual(ss.getAgentReports()['e-ns'].nameStats, want);
  assert.deepEqual(ss.getScanRuns(1)[0].nameStats, want);
  ss.recordAgentIncomplete('e-ns', { code: 'SCAN_DEADLINE', reason: 't' });
  assert.deepEqual(ss.getAgentReports()['e-ns'].nameStats, want);
  ss.recordAgentReport('e-ns2', { scanned: 1, alive: 1, nameStats: 'x' });
  assert.equal(ss.getAgentReports()['e-ns2'].nameStats, undefined, '요약이 없으면 = 방식 보고 없음(이전 버전 엣지)');
});

test('⑦ scanDetailOf — 방식별 이름 · 표시 이름 · 이름 다름 · 새 객체', () => {
  ss.mergeScanResults([{ ip: '10.95.0.1', openPorts: [445], services: ['SMB'], names: { dns: 'fs-old.corp', netbios: 'NAS-BACKUP' }, tried: ['dns', 'netbios'], nbGroup: 'CORP', mac: '00:50:56:AB:CD:EF' }], 1_800_000_500_000, 'e-d');
  const d = ss.scanDetailOf('10.95.0.1');
  assert.deepEqual(d.display, { name: 'fs-old.corp', src: 'dns' });
  assert.deepEqual(d.alt, [{ src: 'netbios', v: 'NAS-BACKUP' }]);
  assert.equal(d.nbGroup, 'CORP'); assert.equal(d.mac, '00:50:56:AB:CD:EF'); assert.equal(d.nameMissMax, 3);
  d.names.dns.v = 'mutated';
  assert.equal(ss.getScanResults()['10.95.0.1'].names.dns.v, 'fs-old.corp');
  assert.equal(ss.scanDetailOf('constructor'), null);
  assert.equal(ss.scanDetailOf('10.95.0.9'), null);
});

test('⑦ 디스크의 옛 결과 파일 — hostname 은 역DNS 이름으로 옮기고 오염된 새 칸은 정제한다(자식 프로세스)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2991-load-'));
  fs.writeFileSync(path.join(dir, 'ipam-scan-results.json'), JSON.stringify({
    '10.96.0.1': { ip: '10.96.0.1', openPorts: [22], services: ['SSH'], hostname: 'old.corp', lastSeen: 1_700_000_000_000, agent: 'e1' },
    '10.96.0.2': { ip: '10.96.0.2', hostname: 'x', names: { dns: { v: 'new.corp', at: 5, miss: 99 }, netbios: { v: { o: 1 } }, bad: { v: 'b' } }, tried: ['netbios', 'zz'], mac: 'nope', nbGroup: 'G', lastSeen: 1_700_000_000_000 },
  }));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `const ss = await import(${JSON.stringify(path.join(SRC, 'ipam/scanStore.js'))}); console.log('@@' + JSON.stringify(ss.getScanResults()));`], {
    env: { ...process.env, CONFIG_DIR: dir }, encoding: 'utf8', timeout: 60_000,
  });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, r.stderr);
  const res = JSON.parse(line.slice(2));
  assert.deepEqual(res['10.96.0.1'].names, { dns: { v: 'old.corp', at: 1_700_000_000_000, miss: 0 } });
  assert.equal(res['10.96.0.1'].hostname, 'old.corp');
  assert.deepEqual(res['10.96.0.2'].names, { dns: { v: 'new.corp', at: 5, miss: 3 } });
  assert.equal(res['10.96.0.2'].hostname, 'new.corp');
  assert.deepEqual(res['10.96.0.2'].tried, ['netbios']);
  assert.equal(res['10.96.0.2'].mac, undefined);
  assert.equal(res['10.96.0.2'].nbGroup, undefined, 'NetBIOS 이름이 없으면 그룹도 싣지 않는다');
});

// ── ⑧ 중앙 수신 · 엣지 보고 ──────────────────────────────────────────────────
let srv; let base;
before(async () => {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use('/api/central', centralRouter);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api/central`;
});
after(() => { srv?.close(); });

test('⑧ 중앙 /ip-scan-result — 방식별 이름 · 그룹 · MAC · 요약을 정제해 저장', async () => {
  const r = await fetch(`${base}/ip-scan-result`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': TOKEN },
    body: JSON.stringify({ agent: 'e-central', scanned: 5, nameStats: { tried: { dns: 2, mdns: 1, netbios: 2 }, found: { dns: 1, mdns: 0, netbios: 1 }, named: 2, alive: 2 },
      alive: [{ ip: '10.97.0.1', openPorts: [445], services: ['SMB'], hostname: 'WIN-A', names: { netbios: 'WIN-A', x: 'y' }, tried: ['dns', 'mdns', 'netbios'], nbGroup: 'WG', mac: '00:50:56:01:02:03' },
        { ip: '10.97.0.2', openPorts: [22], services: ['SSH'], hostname: 'lnx.corp', names: { dns: 'lnx.corp' }, tried: ['dns', 'netbios'] }] }),
  });
  assert.equal(r.status, 200);
  const res = ss.getScanResults();
  assert.deepEqual(res['10.97.0.1'].names, { netbios: res['10.97.0.1'].names.netbios });
  assert.equal(res['10.97.0.1'].names.netbios.v, 'WIN-A');
  assert.equal(res['10.97.0.1'].mac, '00:50:56:01:02:03');
  assert.equal(res['10.97.0.2'].hostname, 'lnx.corp');
  assert.deepEqual(ss.getAgentReports()['e-central'].nameStats, { tried: { dns: 2, mdns: 1, netbios: 2 }, found: { dns: 1, mdns: 0, netbios: 1 }, named: 2, alive: 2 });
});

test('⑧ 엣지 — 배정의 mdns/netbios 를 따르고 결과 본문에 방식별 이름 · tried · nameStats 를 싣는다(실제 워커 · 목 중앙)', { timeout: 60_000 }, async () => {
  const tcp = await new Promise((r) => { const s = net.createServer((c) => c.end()); s.listen(0, '127.0.0.1', () => r(s)); });
  const posted = [];
  const central = await new Promise((r) => {
    const s = http.createServer((q, res) => {
      const ch = []; q.on('data', (c) => ch.push(c));
      q.on('end', () => {
        const p = q.url.split('?')[0];
        let json = { ok: true };
        if (p === '/api/central/ip-scan-assignment') json = { ok: true, assigned: true, ranges: ['127.0.0.1'], ports: [tcp.address().port], concurrency: 2, timeoutMs: 300, reverseDns: false, ping: false, mdns: false, intervalMs: 3_600_000 };
        if (p === '/api/central/ip-scan-result') { posted.push(JSON.parse(Buffer.concat(ch).toString() || '{}')); json = { ok: true, merged: 1 }; }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(json));
      });
    });
    s.listen(0, '127.0.0.1', () => r(s));
  });
  const { config } = await import('../src/config.js');
  config.agent.centralUrl = `http://127.0.0.1:${central.address().port}`;
  config.agent.centralToken = TOKEN;
  config.agent.name = 'edge-2991';
  const w = await import('../src/agent/ipScanWorker.js');
  try {
    w._resetIpScanAgentForTest();
    const r1 = await quiet(() => w.runIpScanAgentOnce());
    assert.equal(r1.error, undefined, JSON.stringify(r1));
    assert.equal(posted.length, 1);
    const b = posted[0];
    const row = b.alive.find((x) => x.ip === '127.0.0.1');
    assert.ok(row, JSON.stringify(b));
    assert.deepEqual(row.tried, ['netbios'], '배정이 mdns:false · reverseDns:false — NetBIOS 만 물었다(netbios 키가 없으면 켜짐)');
    assert.equal(b.nameStats?.tried?.netbios, 1, JSON.stringify(b.nameStats));
    assert.equal(r1.named, b.nameStats.named, '엣지 상태에도 이름 확인 수');
  } finally {
    central.close(); tcp.close();
    config.agent.centralUrl = '';
  }
});

// ── ⑨ 대장 · 이력 · CSV 라우트(목 데이터 · 자식 프로세스) ─────────────────────────
test('⑨ /tools/ipam 호스트명 칸 · VM 행에도 스캔 이름 · 범위 계정에는 붙이지 않음 · /history 의 scan · scan-report.csv 열', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2991-route-'));
  const script = `
    const SRC = ${JSON.stringify(SRC + '/')};
    const express = (await import('express')).default;
    const { store } = await import(SRC + 'store.js');
    await store.refresh?.();
    const { api } = await import(SRC + 'routes/api.js');
    const ss = await import(SRC + 'ipam/scanStore.js');
    const app = express(); app.use(express.json({ limit: '5mb' }));
    app.use((req, _r, n) => { const vc = req.headers['x-scope']; req.user = vc ? { username: 'scoped', role: 'admin', scope: { vcenters: [vc] } } : { username: 'full', role: 'admin', scope: null }; n(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const call = async (p, h = {}) => { const r = await fetch(base + '/api' + p, { headers: h }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; };
    const out = {};
    try {
      const led0 = await call('/tools/ipam');
      const vm = led0.j.rows.find((r) => r.ownerType === 'vm');
      out.vmIp = vm.ip; out.vc = vm.vcenterId;
      ss.mergeScanResults([
        { ip: '10.250.0.5', openPorts: [445], services: ['SMB'], names: { netbios: 'WIN-X' }, tried: ['dns', 'netbios'], nbGroup: 'WG', mac: '00:50:56:00:00:01' },
        { ip: '10.250.0.6', openPorts: [80], services: ['HTTP'], tried: ['dns', 'netbios'] },
        { ip: vm.ip, openPorts: [22], services: ['SSH'], names: { dns: 'vm-a.corp', netbios: 'OTHER' }, tried: ['dns', 'netbios'] },
      ], Date.now(), '__local__');
      const led = await call('/tools/ipam');
      out.scanRow = led.j.rows.find((r) => r.ip === '10.250.0.5');
      out.noName = led.j.rows.find((r) => r.ip === '10.250.0.6');
      out.vmRow = led.j.rows.find((r) => r.ip === vm.ip && r.ownerType === 'vm');
      const sled = await call('/tools/ipam', { 'x-scope': vm.vcenterId });
      out.scopedVm = sled.j.rows.find((r) => r.ip === vm.ip && r.ownerType === 'vm');
      out.scopedScanRows = sled.j.rows.filter((r) => r.ownerType === 'scanned').length;
      out.hist = (await call('/tools/ipam/history?ip=10.250.0.5')).j;
      out.scopedHist = (await call('/tools/ipam/history?ip=10.250.0.5', { 'x-scope': vm.vcenterId })).j;
      out.csv = (await call('/tools/ipam/scan-report.csv')).j;
    } catch (e) { out.err = String(e && e.stack || e); } finally { srv.close(); }
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' }, encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 180_000,
  });
  assert.equal(r.status, 0, (r.stderr || '').slice(-2000));
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `${r.stdout.slice(-800)} ${r.stderr.slice(-800)}`);
  const o = JSON.parse(line.slice(2));
  assert.equal(o.err, undefined, o.err);
  assert.equal(o.scanRow.netName, 'WIN-X'); assert.equal(o.scanRow.netNameSrc, 'netbios');
  assert.equal(o.scanRow.hostName, 'WIN-X', 'ipam.db 열의 뜻(hostName = 스캔 행의 호스트명)은 그대로');
  assert.equal(o.noName.netName, undefined);
  assert.equal(o.vmRow.netName, 'vm-a.corp'); assert.equal(o.vmRow.netNameSrc, 'dns');
  assert.equal(o.vmRow.nameMismatch, true); assert.deepEqual(o.vmRow.nameAlt, [{ src: 'netbios', v: 'OTHER' }]);
  assert.ok(o.scopedVm, '범위 계정도 자기 VM 행은 본다');
  assert.equal(o.scopedVm.netName, undefined, '범위 계정에는 스캔이 찾은 이름을 붙이지 않는다(스캔 결과는 vCenter 귀속이 없다)');
  assert.equal(o.scopedScanRows, 0);
  assert.equal(o.hist.scan.display.name, 'WIN-X');
  assert.equal(o.hist.scan.mac, '00:50:56:00:00:01');
  assert.equal(o.hist.scan.nbGroup, 'WG');
  assert.equal(o.scopedHist.scan, null);
  const lines = String(o.csv).trim().split('\n');
  assert.equal(lines[0], 'ip,hostname,status,open_ports,services,first_seen,last_seen,agent,hostname_source,name_dns,name_mdns,name_netbios,netbios_group,mac');
  const row = lines.find((l) => l.startsWith('10.250.0.5,'));
  assert.ok(row && row.endsWith(',netbios,,,WIN-X,WG,00:50:56:00:00:01'), row);
});
