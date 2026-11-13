// v2.999 — IP 스캔 MAC · 제조사(설계 docs/design/ipam-alerts-mac-dns ② · 보드 ④ ⑥ · 컨펌 2026-11-13 '전부 기본값').
// 실제 모듈을 호출해 값으로 본다: 이웃 표 파서(완성 · 미완성 · 0 MAC · 게시 항목 · 깨진 줄 · 선형) · 표 읽기(리눅스 아님 · 실패) ·
//   주기 읽기(모으기 · 멈춤) · 제조사 판정(6 · 7 · 9자리 접두 · 임의 지정 · 이중화 · 가상 NIC) · scanRanges(같은 서브넷 · 자기 주소 · 요약) ·
//   scanStore(엣지 정제 · 지난 MAC 유지 규칙 · MAC 이력 · 같은 MAC 색인 · 상세) · 중앙 /ip-scan-result · 엣지 보고 본문 ·
//   대장 /tools/ipam · /history · scan-report.csv · 범위 계정(자식 프로세스 — 목 데이터) · 디스크 로드 정제.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOKEN = 'tok-2999-shared';
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2999-'));
process.env.CONFIG_DIR = CFG;
process.env.CENTRAL_TOKEN = TOKEN;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'true';
process.env.IPAM_WRITE_DEBOUNCE_MS = '60000';
process.env.IPAM_FPING = '0';
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

const nb = await import('../src/ipam/neighbors.js');
const mv = await import('../src/ipam/macVendor.js');
const scan = await import('../src/ipam/scan.js');
const ss = await import('../src/ipam/scanStore.js');
const { NAME_MISS_MAX } = await import('../src/ipam/hostNames.js');
const quiet = async (fn) => { const w = console.warn; const l = console.log; console.warn = () => {}; console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; } };

const HEAD = 'IP address       HW type     Flags       HW address            Mask     Device';
const line = (ip, mac, flags = '0x2', hw = '0x1', dev = 'eth0') => `${ip.padEnd(17)}${hw.padEnd(12)}${flags.padEnd(12)}${mac.padEnd(22)}*        ${dev}`;

// ── ① 이웃 표 파서 ────────────────────────────────────────────────────────────
test('① /proc/net/arp — 완성된 이더넷 항목만 · 대문자 · 0 MAC · 미완성 · 게시 항목 · 이더넷 아님 · 깨진 줄은 버린다', () => {
  const text = [HEAD,
    line('10.0.0.1', 'f4:8e:38:2a:91:0c'),
    line('10.0.0.2', '00:00:00:00:00:00', '0x0'),            // 미완성(ARP 응답 없음)
    line('10.0.0.3', '00:00:00:00:00:00'),                   // 0 MAC
    line('10.0.0.4', '02:fc:00:00:00:05', '0xe'),            // 게시(proxy ARP — 이 장비의 MAC · 완성 + 영구 + 게시)
    line('10.0.0.5', '3c:ec:ef:12:9b:e2', '0x2', '0x20'),    // 이더넷 아님(InfiniBand 등)
    line('10.0.0.6', 'zz:zz:zz:zz:zz:zz'),                   // 꼴이 틀림
    '10.0.0.7 0x1',                                           // 깨진 줄
    line('10.0.0.1', '00:11:22:33:44:55', '0x2', '0x1', 'eth1'), // 같은 IP 다른 인터페이스 — 처음 것
    line('999.0.0.1', 'aa:bb:cc:dd:ee:ff'),                  // IP 가 아님
    line('10.0.0.8', 'AA-BB-CC-DD-EE-FF'),                   // 하이픈 꼴은 커널이 쓰지 않는다 — 버린다
    line('10.0.0.9', '00:1b:21:7a:44:10', '0x6'),            // 완성 + 영구(0x4) — 받는다
    line('10.0.0.10', 'aa:bb:cc:dd:ee:01', '0x0'),           // 미완성인데 MAC 칸이 남은 항목 — 완성 표지가 없으면 받지 않는다
  ].join('\n');
  const m = nb.parseProcArp(text);
  assert.deepEqual([...m.entries()], [['10.0.0.1', 'F4:8E:38:2A:91:0C'], ['10.0.0.9', '00:1B:21:7A:44:10']]);
  assert.deepEqual([...nb.parseProcArp(text, new Set(['10.0.0.9'])).keys()], ['10.0.0.9'], 'wanted 밖의 IP 는 모으지 않는다');
  assert.equal(nb.parseProcArp('').size, 0);
  assert.equal(nb.parseProcArp(null).size, 0);
  assert.equal(nb.parseProcArp(`${HEAD}\n${'x'.repeat(10_000)}\n${line('10.0.0.1', 'f4:8e:38:2a:91:0c')}`).get('10.0.0.1'), 'F4:8E:38:2A:91:0C', '긴 줄 하나가 뒤 줄을 막지 않는다');
});

test('① 파서는 선형이다 — 줄 수 4배에 시간이 16배로 늘지 않는다(공백만 가득한 줄 포함)', () => {
  const mk = (n) => [HEAD, ...Array.from({ length: n }, (_, i) => (i % 3 ? line(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, 'f4:8e:38:2a:91:0c') : ' '.repeat(250)))].join('\n');
  const small = mk(5_000); const big = mk(20_000);
  const t = (s) => { const a = performance.now(); for (let k = 0; k < 3; k++) nb.parseProcArp(s); return performance.now() - a; };
  t(small);
  const r = t(big) / Math.max(0.5, t(small));
  assert.ok(r < 12, `4배 입력에 ${r.toFixed(1)}배`);
});

test('① 표 읽기 — 리눅스가 아니면 읽지 않음(unsupported) · 읽기 실패는 unreadable · 성공은 지도', async () => {
  assert.deepEqual(await nb.readNeighborTable({ platform: 'win32' }).then((r) => [r.ok, r.reason]), [false, 'unsupported']);
  assert.deepEqual(await nb.readNeighborTable({ platform: 'linux', readFile: async () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } }).then((r) => [r.ok, r.reason]), [false, 'unreadable']);
  const r = await nb.readNeighborTable({ platform: 'linux', readFile: async (f) => { assert.equal(f, nb.ARP_FILE); return `${HEAD}\n${line('10.1.1.1', '00:50:56:9a:11:04')}`; } });
  assert.equal(r.ok, true); assert.equal(r.map.get('10.1.1.1'), '00:50:56:9A:11:04');
});

test('① 주기 읽기 — 여러 번 읽은 것을 모으고(밀려난 항목도 남는다) · 한 번이라도 읽으면 ok · 멈춘 뒤에는 읽지 않는다', async () => {
  let n = 0;
  const seq = [new Map([['10.2.0.1', 'AA:00:00:00:00:01']]), new Map([['10.2.0.2', 'AA:00:00:00:00:02']]), null];
  const read = async ({ wanted }) => { const m = seq[Math.min(n, seq.length - 1)]; n += 1; if (!m) return { ok: false, reason: 'unreadable', map: new Map() }; assert.ok(wanted.has('10.2.0.1')); return { ok: true, map: m, reason: null }; };
  const s = nb.createNeighborSampler(new Set(['10.2.0.1', '10.2.0.2']), { read, intervalMs: 200 });
  await s.sample(); await s.sample(); await s.sample();
  const r = s.result();
  assert.equal(r.ok, true); assert.equal(r.reason, null);
  assert.deepEqual([...r.map.keys()].sort(), ['10.2.0.1', '10.2.0.2']);
  s.start(); await new Promise((res) => setTimeout(res, 450)); s.stop();
  const after1 = n; await new Promise((res) => setTimeout(res, 450));
  assert.equal(n, after1, '멈춘 뒤 읽기가 없다(타이머 누수 없음)');
  const bad = nb.createNeighborSampler(new Set(), { read: async () => ({ ok: false, reason: 'unsupported', map: new Map() }) });
  await bad.sample();
  assert.deepEqual([bad.result().ok, bad.result().reason], [false, 'unsupported']);
});

// ── ② 제조사 · 종류 ──────────────────────────────────────────────────────────
test('② 제조사 표 — 실린 표를 읽는다(5만 건 이상 · 출처 줄) · 6 · 7 · 9자리 접두 중 긴 것이 먼저', () => {
  const st = mv.ouiStatus();
  assert.equal(st.loaded, true, st.error);
  assert.ok(st.count > 50_000, String(st.count));
  assert.match(st.source, /^oui-data@\d/);
  assert.equal(mv.macInfo('3c:ec:ef:12:9b:e2').vendor, 'Super Micro Computer, Inc.');
  assert.equal(mv.macInfo('F4-8E-38-2A-91-0C').vendor, 'Dell Inc.');
  // 표에서 7 · 9자리 항목을 하나씩 골라 — 같은 6자리 접두의 이름(대개 'IEEE Registration Authority')보다 먼저인가
  const rows = zlib.gunzipSync(fs.readFileSync(path.join(SRC, 'ipam/vendor/oui.tsv.gz'))).toString('utf8').split('\n').filter((l) => /^[0-9A-F]{7}\t|^[0-9A-F]{9}\t/.test(l));
  const m7 = rows.find((l) => l.indexOf('\t') === 7); const m9 = rows.find((l) => l.indexOf('\t') === 9);
  for (const l of [m7, m9]) {
    const [p, name] = l.split('\t');
    const hex = (p + '0'.repeat(12)).slice(0, 12);
    const mac = hex.match(/../g).join(':');
    if (Number.parseInt(hex.slice(0, 2), 16) & 2) continue; // 로컬 관리 비트 대역은 임의 지정으로 본다(아래 시험)
    assert.equal(mv.macInfo(mac).vendor, name, `${p} → ${name}`);
  }
});

test('② 종류 — 이중화 가상 MAC(VRRP · HSRP v1/v2 · GLBP) · 가상 NIC(QEMU 의 로컬 관리 대역 포함) · 임의 지정 · 꼴이 틀리면 null', () => {
  assert.deepEqual(mv.macInfo('00:00:5E:00:01:0A'), { vendor: null, kind: 'gateway', platform: 'VRRP' });
  assert.deepEqual(mv.macInfo('00:00:0c:07:ac:01'), { vendor: null, kind: 'gateway', platform: 'HSRP' });
  assert.deepEqual(mv.macInfo('00:00:0C:9F:F0:01'), { vendor: null, kind: 'gateway', platform: 'HSRP' });
  assert.deepEqual(mv.macInfo('00:07:B4:00:01:02'), { vendor: null, kind: 'gateway', platform: 'GLBP' });
  assert.equal(mv.macInfo('00:00:5E:00:03:01').kind, null, 'VRRP 대역 밖(00:00:5E:00:03)은 이중화가 아니다');
  assert.deepEqual(mv.macInfo('00:50:56:9a:11:04'), { vendor: 'VMware, Inc.', kind: 'virtual', platform: 'VMware' });
  assert.deepEqual(mv.macInfo('52:54:00:12:34:56'), { vendor: null, kind: 'virtual', platform: 'QEMU/KVM' });
  assert.deepEqual(mv.macInfo('7A:3F:11:C0:5D:08'), { vendor: null, kind: 'random' });
  assert.equal(mv.macInfo('02:00:00:00:00:01').kind, 'random');
  for (const bad of ['', 'zz', '00:00:00:00:00:00', null, 5, { v: 1 }, 'AA:BB:CC:DD:EE', 'AA:BB:CC:DD:EE:FF:00']) assert.equal(mv.macInfo(bad), null, String(bad));
  assert.equal(mv.normMac(' aa-bb-cc-dd-ee-ff '), 'AA:BB:CC:DD:EE:FF');
});

test('② 대장 칸 netMacFields — ARP 가 먼저 · 없으면 NetBIOS · 오래됨(표에 없었음 · 마지막 보고가 못 봄) · 같은 MAC 의 IP 수(2 이상만)', () => {
  assert.deepEqual(mv.netMacFields(null), {});
  assert.deepEqual(mv.netMacFields({ ip: '1.1.1.1' }), {});
  const nbOnly = mv.netMacFields({ mac: '00:1B:21:7A:44:10', lastSeen: 10 });
  assert.deepEqual(nbOnly, { mac: '00:1B:21:7A:44:10', macSrc: 'netbios', macVendor: 'Intel Corporate' });
  const arp = mv.netMacFields({ mac: '00:1B:21:7A:44:10', arp: { v: '3C:EC:EF:12:9B:E2', at: 10, miss: 0 }, lastSeen: 10 }, () => 3);
  assert.deepEqual(arp, { mac: '3C:EC:EF:12:9B:E2', macSrc: 'arp', macVendor: 'Super Micro Computer, Inc.', macShared: 3 });
  assert.equal(mv.netMacFields({ arp: { v: '3C:EC:EF:12:9B:E2', at: 10, miss: 1 }, lastSeen: 10 }).macStale, true);
  assert.equal(mv.netMacFields({ arp: { v: '3C:EC:EF:12:9B:E2', at: 5, miss: 0 }, lastSeen: 10 }).macStale, true);
  assert.equal(mv.netMacFields({ arp: { v: '3C:EC:EF:12:9B:E2', at: 10, miss: 0 }, lastSeen: 10 }, () => 1).macShared, undefined);
  const v = mv.netMacFields({ arp: { v: '00:50:56:9A:11:04', at: 1, miss: 0 }, lastSeen: 1 });
  assert.equal(v.macKind, 'virtual'); assert.equal(v.macPlatform, 'VMware');
});

// ── ③ scanRanges ────────────────────────────────────────────────────────────────
async function withTcp(fn) {
  const srv = await new Promise((r) => { const s = net.createServer((c) => c.end()); s.listen(0, '127.0.0.1', () => r(s)); });
  try { return await fn(srv.address().port); } finally { srv.close(); }
}
const LOOPNET = [{ address: '127.0.0.2', net: 0x7f000000, mask: 0xff000000 }];   // 127.0.0.1 은 같은 서브넷 · 이 장비 주소는 127.0.0.2 로 둔다
test('③ scanRanges — 같은 서브넷 · 응답한 IP 에만 arpMac · arpTried · 요약 nameStats.mac', async () => {
  await withTcp(async (port) => {
    const read = async () => ({ ok: true, reason: null, map: new Map([['127.0.0.1', 'F4:8E:38:2A:91:0C'], ['127.0.0.3', 'AA:BB:CC:00:00:03']]) });
    const out = await scan.scanRanges(['127.0.0.1'], { ports: [port], ping: false, reverseDns: false, mdns: false, netbios: false, timeoutMs: 300, macOpts: { read, subnets: LOOPNET, intervalMs: 200 } });
    assert.equal(out.alive.length, 1);
    assert.equal(out.alive[0].arpMac, 'F4:8E:38:2A:91:0C');
    assert.equal(out.alive[0].arpTried, true);
    assert.equal(out.alive[0].mac, undefined, 'mac 칸은 예전처럼 NetBIOS MAC 이다(ARP 값을 싣지 않는다 — 옛 중앙이 NetBIOS 로 읽지 않게)');
    assert.deepEqual(out.nameStats.mac, { onLink: 1, found: 1, reason: null });
  });
});
test('③ scanRanges — 표에 없으면 arpTried 만 · 다른 서브넷 · 이 장비 자신의 주소 · 표를 못 읽으면 arpTried 없음 + 사유', async () => {
  await withTcp(async (port) => {
    const base = { ports: [port], ping: false, reverseDns: false, mdns: false, netbios: false, timeoutMs: 300 };
    const empty = async () => ({ ok: true, reason: null, map: new Map() });
    const a = await scan.scanRanges(['127.0.0.1'], { ...base, macOpts: { read: empty, subnets: LOOPNET } });
    assert.deepEqual([a.alive[0].arpTried, a.alive[0].arpMac], [true, undefined]);
    assert.deepEqual(a.nameStats.mac, { onLink: 1, found: 0, reason: null });
    const b = await scan.scanRanges(['127.0.0.1'], { ...base, macOpts: { read: empty, subnets: [{ address: '10.0.0.2', net: 0x0a000000, mask: 0xffffff00 }] } });
    assert.equal(b.alive[0].arpTried, undefined, '다른 서브넷은 표로 볼 수 없다 — 시도로 세지 않는다');
    assert.deepEqual(b.nameStats.mac, { onLink: 0, found: 0, reason: null });
    const c = await scan.scanRanges(['127.0.0.1'], { ...base, macOpts: { read: empty, subnets: [{ address: '127.0.0.1', net: 0x7f000000, mask: 0xff000000 }] } });
    assert.equal(c.alive[0].arpTried, undefined, '이 장비 자신의 주소는 표에 없다 — 놓친 것으로 세지 않는다');
    const d = await scan.scanRanges(['127.0.0.1'], { ...base, macOpts: { read: async () => ({ ok: false, reason: 'unreadable', map: new Map() }), subnets: LOOPNET } });
    assert.equal(d.alive[0].arpTried, undefined);
    assert.deepEqual(d.nameStats.mac, { onLink: 0, found: 0, reason: 'unreadable' });
    const e = await scan.scanRanges(['127.0.0.1'], { ...base, arp: false, macOpts: { subnets: LOOPNET } });
    assert.equal(e.nameStats.mac.reason, 'off');
  });
});

// ── ④ 저장(scanStore) ────────────────────────────────────────────────────────
const T0 = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 7_200_000;   // 정시 경계로 떨어뜨린 기준 시각(docs/rules/common.md)
test('④ 엣지가 보낸 arpMac · arpTried 는 아는 꼴만(꼴이 틀리면 버림 · arpTried 는 참일 때만)', () => {
  ss.mergeScanResults([
    { ip: '10.98.0.1', openPorts: [22], services: ['SSH'], arpMac: 'f4-8e-38-2a-91-0c', arpTried: true },
    { ip: '10.98.0.2', openPorts: [22], services: ['SSH'], arpMac: { x: 1 }, arpTried: 'true' },
    { ip: '10.98.0.3', openPorts: [22], services: ['SSH'], arpMac: '00:00:00:00:00:00', arpTried: true },
    { ip: '10.98.0.4', openPorts: [22], services: ['SSH'], arpMac: `${'AA:'.repeat(20)}FF`, arpTried: 1 },
  ], T0, 'e-a');
  const r = ss.getScanResults();
  assert.deepEqual(r['10.98.0.1'].arp, { v: 'F4:8E:38:2A:91:0C', at: T0, miss: 0, n: 1 });
  for (const ip of ['10.98.0.2', '10.98.0.3', '10.98.0.4']) assert.equal(r[ip].arp, undefined, ip);
  assert.equal(r['10.98.0.1'].arpMac, undefined, '보고 칸(arpMac · arpTried)을 저장 항목에 그대로 두지 않는다');
  assert.equal(r['10.98.0.1'].arpTried, undefined);
  // arpTried 는 불리언 참일 때만 — 글자 'true' · 1 은 '볼 수 없었던 보고' 로 읽어 지난 MAC 의 miss 를 올리지 않는다
  ss.mergeScanResults([{ ip: '10.98.0.1', openPorts: [22], services: ['SSH'], arpTried: 'true' }], T0 + 1, 'e-a');
  ss.mergeScanResults([{ ip: '10.98.0.1', openPorts: [22], services: ['SSH'], arpTried: 1 }], T0 + 2, 'e-a');
  assert.equal(r['10.98.0.1'].arp.miss, 0);
  ss.mergeScanResults([{ ip: '10.98.0.1', openPorts: [22], services: ['SSH'], arpTried: true }], T0 + 3, 'e-a');
  assert.equal(ss.getScanResults()['10.98.0.1'].arp.miss, 1);
});

test('④ mergeArp — 새 값 · 표에 없으면 miss(NAME_MISS_MAX 에 지움) · 볼 수 없었던 보고는 그대로 · 바뀌면 changed', () => {
  const p = { v: 'AA:00:00:00:00:01', at: 1, miss: 0 };
  assert.deepEqual(ss.mergeArp(null, { arpMac: 'AA:00:00:00:00:01' }, 5), { arp: { v: 'AA:00:00:00:00:01', at: 5, miss: 0, n: 1 }, changed: null });
  assert.deepEqual(ss.mergeArp(p, { arpMac: 'AA:00:00:00:00:02' }, 5).changed, { from: 'AA:00:00:00:00:01', to: 'AA:00:00:00:00:02' });
  let cur = p;
  for (let i = 1; i < NAME_MISS_MAX; i++) { cur = ss.mergeArp(cur, { arpTried: true }, 5 + i).arp; assert.equal(cur.miss, i); assert.equal(cur.at, 1, '확인 시각은 마지막으로 본 때'); }
  assert.equal(ss.mergeArp(cur, { arpTried: true }, 99).arp, null, `${NAME_MISS_MAX}회째 지운다`);
  assert.deepEqual(ss.mergeArp(p, {}, 9).arp, p, '옛 엣지 · 다른 서브넷 · 표 못 읽음 — 보지 못한 것을 없어졌다고 세지 않는다');
  assert.equal(ss.mergeArp(null, { arpTried: true }, 9).arp, null);
});

test('④ scanRev — MAC 이 바뀌거나 표에 없었다는 표지가 생길 때만 오르고 · 같은 MAC 의 확인 시각만이면 오르지 않는다', () => {
  const ip = '10.98.1.1';
  ss.mergeScanResults([{ ip, openPorts: [22], services: ['SSH'], arpMac: 'AA:00:00:00:01:01', arpTried: true }], T0, 'e-a');
  let rev = ss.scanRev();
  ss.mergeScanResults([{ ip, openPorts: [22], services: ['SSH'], arpMac: 'AA:00:00:00:01:01', arpTried: true }], T0 + 1000, 'e-a');
  assert.equal(ss.scanRev(), rev, '같은 MAC — 대장 재계산 없음(이어 본 횟수 n 이 올라도 — v3.1.0)');
  ss.mergeScanResults([{ ip, openPorts: [22], services: ['SSH'], arpTried: true }], T0 + 2000, 'e-a');
  assert.ok(ss.scanRev() > rev, '표에 없었다(지난 확인) — 표시가 바뀐다'); rev = ss.scanRev();
  ss.mergeScanResults([{ ip, openPorts: [22], services: ['SSH'], arpTried: true }], T0 + 3000, 'e-a');
  assert.equal(ss.scanRev(), rev, 'miss 1→2 는 표시가 같다');
  ss.mergeScanResults([{ ip, openPorts: [22], services: ['SSH'], arpMac: 'AA:00:00:00:01:02', arpTried: true }], T0 + 4000, 'e-a');
  assert.ok(ss.scanRev() > rev, 'MAC 이 바뀌었다');
});

test('④ MAC 이력 — 같은 MAC 은 마지막 확인만 · 다른 MAC 은 새 줄 · 상한 MAX_MACS · 오래된 보고는 넣지 않음 · NetBIOS MAC 은 넣지 않음', () => {
  const ip = '10.98.2.1';
  const rep = (mac, ts, extra = {}) => ss.mergeScanResults([{ ip, openPorts: [22], services: ['SSH'], arpMac: mac, arpTried: true, ...extra }], ts, 'e-a');
  rep('AA:00:00:00:02:01', T0); rep('AA:00:00:00:02:01', T0 + 10);
  let h = ss.getIpHistory(ip);
  assert.deepEqual(h.macs, [{ mac: 'AA:00:00:00:02:01', first: T0, last: T0 + 10, agent: 'e-a' }]);
  rep('AA:00:00:00:02:02', T0 + 20);
  h = ss.getIpHistory(ip);
  assert.deepEqual(h.macs.map((x) => x.mac), ['AA:00:00:00:02:01', 'AA:00:00:00:02:02']);
  assert.deepEqual(h.events.map((e) => e.type), ['up'], 'up/down events 에 섞지 않는다');
  for (let i = 0; i < ss.MAX_MACS + 3; i++) rep(`AA:00:00:00:03:${String(i).padStart(2, '0')}`, T0 + 100 + i);
  h = ss.getIpHistory(ip);
  assert.equal(h.macs.length, ss.MAX_MACS);
  const ip2 = '10.98.2.2';
  ss.mergeScanResults([{ ip: ip2, openPorts: [445], services: ['SMB'], names: { netbios: 'W' }, tried: ['netbios'], mac: '00:1B:21:7A:44:10' }], T0, 'e-a');
  assert.equal(ss.getIpHistory(ip2).macs, undefined, 'NetBIOS 가 말한 MAC 은 이력(다음 묶음의 MAC 변경 근거)에 넣지 않는다');
});

test('④ 같은 MAC 색인 · 상세 hw — 표시 MAC · 제조사 · NetBIOS MAC(다를 때만) · 같은 MAC 의 다른 IP · 이력(최근 먼저) · 정리하면 색인에서 빠진다', () => {
  const mac = '3C:EC:EF:12:9B:E2';
  ss.mergeScanResults([
    { ip: '10.98.3.1', openPorts: [80], services: ['HTTP'], arpMac: mac, arpTried: true, names: { netbios: 'BMC' }, tried: ['netbios'], mac: '3C:EC:EF:12:9B:E3' },
    { ip: '10.98.3.2', openPorts: [80], services: ['HTTP'], arpMac: mac, arpTried: true },
    { ip: '10.98.3.3', openPorts: [80], services: ['HTTP'], names: { netbios: 'X' }, tried: ['netbios'], mac },
  ], T0, 'e-a');
  assert.equal(ss.macIpCount(mac), 3, 'NetBIOS 로만 아는 IP 도 표시 MAC 으로 센다');
  const d = ss.scanDetailOf('10.98.3.1');
  assert.equal(d.hw.mac, mac); assert.equal(d.hw.src, 'arp');
  assert.equal(d.hw.vendor, 'Super Micro Computer, Inc.');
  assert.equal(d.hw.nbMac, '3C:EC:EF:12:9B:E3');
  assert.deepEqual(d.hw.sameMac, { total: 2, ips: ['10.98.3.2', '10.98.3.3'] });
  assert.equal(d.hw.stale, false);
  assert.deepEqual(d.hw.history.map((x) => [x.mac, x.vendor]), [[mac, 'Super Micro Computer, Inc.']]);
  assert.equal(ss.scanDetailOf('10.98.3.2').hw.nbMac, '');
  // 교체 — 10.98.3.2 의 MAC 이 바뀌면 옛 MAC 에서 빠진다
  ss.mergeScanResults([{ ip: '10.98.3.2', openPorts: [80], services: ['HTTP'], arpMac: 'AA:00:00:00:04:01', arpTried: true }], T0 + 10, 'e-a');
  assert.equal(ss.macIpCount(mac), 2);
  assert.deepEqual(ss.scanDetailOf('10.98.3.2').hw.history.map((x) => x.mac), ['AA:00:00:00:04:01', mac], '최근이 먼저');
  // 오래된 결과 정리 — 색인에서도 빠진다(관리 IP 가 아니면)
  const before = ss.macIpCount('AA:00:00:00:04:01');
  ss.getScanResults()['10.98.3.2'].lastSeen = 1;
  ss.pruneScanResults(1);
  assert.equal(ss.macIpCount('AA:00:00:00:04:01'), before - 1);
  assert.equal(ss.scanDetailOf('10.98.3.9'), null);
});

test('④ 보고 요약 nameStats.mac — 수치만 · 사유는 아는 값만 · 없으면 칸 없음(옛 엣지) · 보고 기록 · 실행 이력', () => {
  assert.deepEqual(ss.cleanMacStats({ onLink: '12', found: 9.7, reason: 'x' }), { onLink: 12, found: 9, reason: null });
  assert.deepEqual(ss.cleanMacStats({ onLink: -1, found: null, reason: 'unreadable' }), { onLink: null, found: null, reason: 'unreadable' });
  assert.equal(ss.cleanMacStats([1]), null);
  assert.equal(ss.cleanNameStats({ named: 1 }).mac, undefined);
  ss.recordAgentReport('e-mac', { scanned: 3, alive: 2, nameStats: { named: 1, alive: 2, mac: { onLink: 2, found: 1, reason: null, extra: '<x>' } } });
  assert.deepEqual(ss.getAgentReports()['e-mac'].nameStats.mac, { onLink: 2, found: 1, reason: null });
  assert.deepEqual(ss.getScanRuns(1)[0].nameStats.mac, { onLink: 2, found: 1, reason: null });
});

// ── ⑤ 중앙 수신 · 엣지 보고 ──────────────────────────────────────────────────────
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

test('⑤ 중앙 /ip-scan-result — arpMac 을 정제해 저장하고 nameStats.mac 을 보고에', async () => {
  const r = await fetch(`${base}/ip-scan-result`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': TOKEN },
    body: JSON.stringify({ agent: 'e-central-mac', scanned: 4, nameStats: { named: 0, alive: 2, mac: { onLink: 2, found: 1, reason: null } },
      alive: [{ ip: '10.97.5.1', openPorts: [22], services: ['SSH'], arpMac: '00:50:56:9a:11:04', arpTried: true },
        { ip: '10.97.5.2', openPorts: [22], services: ['SSH'], arpMac: '<script>', arpTried: true }] }),
  });
  assert.equal(r.status, 200);
  const res = ss.getScanResults();
  assert.equal(res['10.97.5.1'].arp.v, '00:50:56:9A:11:04');
  assert.equal(res['10.97.5.2'].arp, undefined);
  assert.deepEqual(ss.getAgentReports()['e-central-mac'].nameStats.mac, { onLink: 2, found: 1, reason: null });
});

test('⑤ 엣지 — 실제 워커가 결과 본문에 arpTried · nameStats.mac 을 싣는다(목 중앙 · 루프백은 이웃 표에 없다)', { timeout: 60_000 }, async () => {
  const tcp = await new Promise((r) => { const s = net.createServer((c) => c.end()); s.listen(0, '127.0.0.1', () => r(s)); });
  const posted = [];
  const central = await new Promise((r) => {
    const s = http.createServer((q, res) => {
      const ch = []; q.on('data', (c) => ch.push(c));
      q.on('end', () => {
        const p = q.url.split('?')[0];
        let json = { ok: true };
        if (p === '/api/central/ip-scan-assignment') json = { ok: true, assigned: true, ranges: ['127.0.0.1'], ports: [tcp.address().port], concurrency: 2, timeoutMs: 300, reverseDns: false, ping: false, mdns: false, netbios: false, intervalMs: 3_600_000 };
        if (p === '/api/central/ip-scan-result') { posted.push(JSON.parse(Buffer.concat(ch).toString() || '{}')); json = { ok: true, merged: 1 }; }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(json));
      });
    });
    s.listen(0, '127.0.0.1', () => r(s));
  });
  const { config } = await import('../src/config.js');
  config.agent.centralUrl = `http://127.0.0.1:${central.address().port}`;
  config.agent.centralToken = TOKEN;
  config.agent.name = 'edge-2999';
  const w = await import('../src/agent/ipScanWorker.js');
  try {
    w._resetIpScanAgentForTest();
    const r1 = await quiet(() => w.runIpScanAgentOnce());
    assert.equal(r1.error, undefined, JSON.stringify(r1));
    assert.equal(posted.length, 1);
    const b = posted[0];
    assert.ok(b.nameStats && typeof b.nameStats.mac === 'object', JSON.stringify(b.nameStats));
    // 루프백(lo)은 내부 인터페이스라 같은 서브넷 판정 대상이 아니다 — 리눅스면 onLink 0 · 사유 없음, 아니면 'unsupported'
    if (process.platform === 'linux') assert.deepEqual(b.nameStats.mac, { onLink: 0, found: 0, reason: null });
    else assert.equal(b.nameStats.mac.reason, 'unsupported');
  } finally {
    central.close(); tcp.close();
    config.agent.centralUrl = '';
  }
});

// ── ⑥ 대장 · 이력 · CSV · 범위 계정(목 데이터 · 자식 프로세스) · 디스크 로드 ─────────────────
test('⑥ /tools/ipam 제조사 · MAC 칸(스캔 행 · VM 행) · 범위 계정에는 없음 · /history 의 hw · scan-report.csv mac · mac_src · mac_vendor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2999-route-'));
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
      ss.mergeScanResults([
        { ip: '10.250.7.5', openPorts: [22], services: ['SSH'], arpMac: '00:50:56:9a:11:04', arpTried: true },
        { ip: '10.250.7.6', openPorts: [445], services: ['SMB'], names: { netbios: 'WIN-N' }, tried: ['netbios'], mac: '00:1b:21:7a:44:10' },
        { ip: '10.250.7.7', openPorts: [80], services: ['HTTP'], arpMac: '7a:3f:11:c0:5d:08', arpTried: true },
        { ip: vm.ip, openPorts: [22], services: ['SSH'], arpMac: '3c:ec:ef:12:9b:e2', arpTried: true },
      ], Date.now(), '__local__');
      const led = await call('/tools/ipam');
      out.virt = led.j.rows.find((r) => r.ip === '10.250.7.5');
      out.nb = led.j.rows.find((r) => r.ip === '10.250.7.6');
      out.rnd = led.j.rows.find((r) => r.ip === '10.250.7.7');
      out.vmRow = led.j.rows.find((r) => r.ip === vm.ip && r.ownerType === 'vm');
      const sled = await call('/tools/ipam', { 'x-scope': vm.vcenterId });
      out.scopedVm = sled.j.rows.find((r) => r.ip === vm.ip && r.ownerType === 'vm');
      out.hist = (await call('/tools/ipam/history?ip=10.250.7.5')).j;
      out.csv = (await call('/tools/ipam/scan-report.csv')).j;
    } catch (e) { out.err = String(e && e.stack || e); } finally { srv.close(); }
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' }, encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 180_000,
  });
  assert.equal(r.status, 0, (r.stderr || '').slice(-2000));
  const ln = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(ln, `${r.stdout.slice(-800)} ${r.stderr.slice(-800)}`);
  const o = JSON.parse(ln.slice(2));
  assert.equal(o.err, undefined, o.err);
  assert.deepEqual([o.virt.mac, o.virt.macSrc, o.virt.macVendor, o.virt.macKind, o.virt.macPlatform], ['00:50:56:9A:11:04', 'arp', 'VMware, Inc.', 'virtual', 'VMware']);
  assert.equal(o.virt.ownerType, 'scanned');
  assert.deepEqual([o.nb.mac, o.nb.macSrc, o.nb.macVendor], ['00:1B:21:7A:44:10', 'netbios', 'Intel Corporate']);
  assert.deepEqual([o.rnd.macKind, o.rnd.macVendor], ['random', undefined]);
  assert.deepEqual([o.vmRow.mac, o.vmRow.macVendor], ['3C:EC:EF:12:9B:E2', 'Super Micro Computer, Inc.'], 'VM · 호스트 행에도 스캔이 본 MAC');
  assert.ok(o.scopedVm, '범위 계정도 자기 VM 행은 본다');
  assert.equal(o.scopedVm.mac, undefined, '범위 계정에는 스캔이 본 MAC 을 붙이지 않는다(스캔 결과는 vCenter 귀속이 없다)');
  assert.equal(o.hist.scan.hw.vendor, 'VMware, Inc.');
  assert.equal(o.hist.scan.hw.kind, 'virtual');
  assert.equal(o.hist.history.macs[0].mac, '00:50:56:9A:11:04');
  const lines = String(o.csv).trim().split('\n');
  // v3.2.0: 뒤에 dns_forward · dns_forward_addrs 가 더 붙었다(앞 열 순서 그대로 — 이 행들은 역DNS 이름이 없어 빈칸).
  assert.equal(lines[0], 'ip,hostname,status,open_ports,services,first_seen,last_seen,agent,hostname_source,name_dns,name_mdns,name_netbios,netbios_group,mac,mac_src,mac_vendor,dns_forward,dns_forward_addrs');
  assert.ok(lines.find((l) => l.startsWith('10.250.7.5,')).endsWith(',00:50:56:9A:11:04,arp,"VMware, Inc.",,'));
  assert.ok(lines.find((l) => l.startsWith('10.250.7.6,')).endsWith(',00:1B:21:7A:44:10,netbios,Intel Corporate,,'));
  assert.ok(lines.find((l) => l.startsWith('10.250.7.7,')).endsWith(',7A:3F:11:C0:5D:08,arp,,,'), '임의 지정 MAC 은 제조사를 쓰지 않는다');
});

test('⑥ 디스크의 결과 파일 — 저장된 arp 를 정제해 읽고(꼴이 틀리면 버림 · miss 상한) 같은 MAC 색인을 다시 만든다(자식 프로세스)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2999-load-'));
  fs.writeFileSync(path.join(dir, 'ipam-scan-results.json'), JSON.stringify({
    '10.1.0.1': { ip: '10.1.0.1', openPorts: [22], services: ['SSH'], lastSeen: 100, agent: 'e', arp: { v: 'aa:00:00:00:00:01', at: 90, miss: 99 } },
    '10.1.0.2': { ip: '10.1.0.2', openPorts: [22], services: ['SSH'], lastSeen: 100, agent: 'e', arp: { v: 'AA:00:00:00:00:01', at: 'x' } },
    '10.1.0.3': { ip: '10.1.0.3', openPorts: [22], services: ['SSH'], lastSeen: 100, agent: 'e', arp: { v: '<b>', at: 1 } },
    '10.1.0.4': { ip: '10.1.0.4', openPorts: [22], services: ['SSH'], lastSeen: 100, agent: 'e', arp: 'AA:00:00:00:00:01' },
  }));
  const script = `
    const ss = await import(${JSON.stringify(SRC + '/ipam/scanStore.js')});
    const r = ss.getScanResults();
    console.log('@@' + JSON.stringify({ a: r['10.1.0.1'].arp, b: r['10.1.0.2'].arp, c: r['10.1.0.3'].arp ?? null, d: r['10.1.0.4'].arp ?? null, n: ss.macIpCount('AA:00:00:00:00:01') }));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, CONFIG_DIR: dir }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr.slice(-1500));
  const o = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('@@')).slice(2));
  assert.deepEqual(o.a, { v: 'AA:00:00:00:00:01', at: 90, miss: NAME_MISS_MAX, n: 1 });
  assert.deepEqual(o.b, { v: 'AA:00:00:00:00:01', at: 0, miss: 0, n: 1 });
  assert.equal(o.c, null); assert.equal(o.d, null);
  assert.equal(o.n, 2);
});
