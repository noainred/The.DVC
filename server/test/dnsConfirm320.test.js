// v3.2.0 — DNS 정합성(역DNS 이름의 정방향 확인 · 시안 docs/design/ipam-alerts-mac-dns ④ ⑦ · 컨펌 7 '역DNS 이름만' · 8 '기록만').
//   ① 판정 코어(dnsConfirm.js — 묻기 계획 · 답 꼴 · 판정 · 기억) ② 스캔(scanRanges — 남은 예산 · 차단기 · 기억 재사용) ③ 실행기(잡에 기억 싣기)
//   ④ 중앙 정제 · 저장 · 리비전 · 변화 기록(dns-mismatch — 알던 판정에서 바뀔 때만) ⑤ 요약 정제 · 설정 ⑥ 대장 · 추천 카드 · CSV · 범위 계정(자식 프로세스)
//   ⑦ 엣지 — 실제 워커가 결과 본문에 dnsFwd 요약을 싣는다(목 중앙).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOKEN = 't'.repeat(48);
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-320-'));
process.env.CONFIG_DIR = CFG;
process.env.CENTRAL_TOKEN = TOKEN;
process.env.DATA_SOURCE = 'live';
process.env.IPAM_WRITE_DEBOUNCE_MS = '60000';
process.env.IPAM_FPING = '0';
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

const dc = await import('../src/ipam/dnsConfirm.js');
const scan = await import('../src/ipam/scan.js');
const runner = await import('../src/ipam/scanRunner.js');
const ss = await import('../src/ipam/scanStore.js');
const { CHANGE_TYPES, cleanChange } = await import('../src/ipam/changeLog.js');
const { planBatch } = await import('../src/ipam/changeNotify.js');
const quiet = async (fn) => { const w = console.warn; const l = console.log; console.warn = () => {}; console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; } };
const H = 3_600_000;

// ── ① 판정 코어 ──────────────────────────────────────────────────────────────
test('① 판정 — 주소 목록에 이 IP 가 있으면 일치 · 다른 IP 만이면 다른 IP(최대 4) · 주소 없음은 정방향 없음 · 답이 없으면 확인 못 함', () => {
  assert.deepEqual(dc.verdictOf('10.0.0.1', { addrs: ['10.0.0.9', '10.0.0.1'], at: 5 }), { v: 'match', at: 5 });
  assert.deepEqual(dc.verdictOf('10.0.0.1', { addrs: ['1.1.1.1', '1.1.1.2', '1.1.1.3', '1.1.1.4', '1.1.1.5'], at: 5 }), { v: 'other', at: 5, addrs: ['1.1.1.1', '1.1.1.2', '1.1.1.3', '1.1.1.4'] });
  assert.deepEqual(dc.verdictOf('10.0.0.1', { addrs: [], at: 5 }), { v: 'none', at: 5 });
  assert.deepEqual(dc.verdictOf('10.0.0.1', null), { v: 'unknown' });
  // 답 꼴 — 그런 이름 없음(ENOTFOUND · ENODATA · EAI_NONAME)만 '없음', 일시 실패 · 서버 실패는 기억하지 않는다(다음 스캔이 다시 묻는다)
  assert.deepEqual(dc.answerOf({ addrs: ['10.0.0.1'] }, 7), { addrs: ['10.0.0.1'], at: 7 });
  for (const code of ['ENOTFOUND', 'ENODATA', 'EAI_NONAME']) assert.deepEqual(dc.answerOf({ err: code }, 7), { addrs: [], at: 7 }, code);
  for (const code of ['EAI_AGAIN', 'ESERVFAIL', 'ECONNREFUSED', 'error']) assert.equal(dc.answerOf({ err: code }, 7), null, code);
  assert.equal(dc.answerOf(null, 7), null);
  assert.deepEqual(dc.DNS_FWD_STATES, ['match', 'other', 'none', 'unknown']);
});

test('① 묻기 계획 — 기간 안의 답은 다시 쓰고, 나머지는 오래된 답부터(한 번도 묻지 않은 이름이 맨 앞) · 같은 이름은 한 번 · 미래 시각 답은 믿지 않는다', () => {
  const now = 100 * H;
  const cache = dc.cacheFromWire([
    ['fresh.corp', ['10.0.0.1'], now - 2 * H],
    ['old.corp', ['10.0.0.2'], now - 30 * H],
    ['older.corp', [], now - 50 * H],
    ['future.corp', ['10.0.0.4'], now + H],
    ['bad', 'x', 1], [1, [], 1], ['neg.corp', [], -1],
  ]);
  assert.equal(cache.size, 4, '꼴이 틀린 줄은 버린다');
  const pairs = [{ ip: '10.0.0.2', name: 'old.corp' }, { ip: '10.0.0.1', name: 'Fresh.Corp.' }, { ip: '10.0.0.9', name: 'new.corp' },
    { ip: '10.0.0.3', name: 'older.corp' }, { ip: '10.0.0.8', name: 'OLD.corp' }, { ip: '10.0.0.4', name: 'future.corp' }, { ip: '10.0.0.5', name: '' }];
  const p = dc.planConfirm(pairs, cache, { now, ttlMs: 24 * H });
  assert.deepEqual([...p.fresh.keys()], ['fresh.corp']);
  assert.deepEqual(p.ask, ['new.corp', 'older.corp', 'old.corp', 'future.corp']);
  // 기간을 줄이면 2시간 전 답도 다시 묻는다
  assert.ok(dc.planConfirm(pairs, cache, { now, ttlMs: H }).ask.includes('Fresh.Corp'));
  // 기간 정리
  assert.deepEqual([dc.confirmHoursOf(undefined), dc.confirmHoursOf(''), dc.confirmHoursOf('x'), dc.confirmHoursOf(0), dc.confirmHoursOf(99999), dc.confirmHoursOf(6.4)], [24, 24, 24, 1, 720, 6]);
});

test('① 기억 — 새 답은 같은 이름을 덮고 · 상한을 넘으면 오래된 답부터 버린다 · 잡에 실을 때는 오래된 답도 싣는다', () => {
  dc._resetDnsCacheForTest();
  dc.absorbLearned([['a.corp', ['10.0.0.1'], 10], ['b.corp', [], 20]]);
  dc.absorbLearned([['A.corp', ['10.0.0.7'], 30]]);
  const w = dc.cacheToWire();
  assert.deepEqual(w.find((x) => x[0] === 'a.corp'), ['a.corp', ['10.0.0.7'], 30]);
  assert.equal(w.length, 2);
  const many = Array.from({ length: dc.DNS_CACHE_MAX + 5 }, (_, i) => [`h${i}.corp`, [], 1000 + i]);
  dc.absorbLearned(many);
  assert.equal(dc._dnsCacheSizeForTest(), dc.DNS_CACHE_MAX);
  assert.ok(!dc.cacheToWire().some((x) => x[0] === 'a.corp'), '가장 오래된 답(시각 30)이 먼저 빠진다');
  dc._resetDnsCacheForTest();
});

// ── ② 스캔 ───────────────────────────────────────────────────────────────────
const tcpServer = () => new Promise((r) => { const s = net.createServer((c) => c.end()); s.listen(0, '127.0.0.1', () => r(s)); });
const baseScan = (port) => ({ ports: [port], ping: false, reverseDns: true, mdns: false, netbios: false, timeoutMs: 300, arp: false });

test('② scanRanges — 역DNS 이름을 정방향으로 물어 행에 dnsFwd · 요약 nameStats.dnsFwd · 새 답(dnsLearned) · 기억이 있으면 묻지 않는다', async () => {
  const srv = await tcpServer();
  try {
    const asked = [];
    const lookup = async (name) => { asked.push(name); if (name === 'loop.corp') return [{ address: '10.9.9.9', family: 4 }]; throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); };
    const reverse = async () => new Map([['127.0.0.1', 'loop.corp']]);
    const a = await scan.scanRanges(['127.0.0.1'], { ...baseScan(srv.address().port), lookup, nameOpts: { probes: { reverse } }, dnsConfirm: { on: true, cache: [], hours: 24 } });
    assert.deepEqual(asked, ['loop.corp']);
    assert.equal(a.alive[0].dnsFwd.v, 'other');
    assert.deepEqual(a.alive[0].dnsFwd.addrs, ['10.9.9.9']);
    assert.equal(a.nameStats.dnsFwd.other, 1);
    assert.equal(a.nameStats.dnsFwd.asked, 1);
    assert.equal(a.dnsLearned.length, 1);
    assert.equal(a.dnsLearned[0][0], 'loop.corp');
    // 기억(기간 안)이 있으면 묻지 않고 그 답으로 판정한다
    asked.length = 0;
    const b = await scan.scanRanges(['127.0.0.1'], { ...baseScan(srv.address().port), lookup, nameOpts: { probes: { reverse } }, dnsConfirm: { on: true, cache: [['loop.corp', ['127.0.0.1'], Date.now() - H]], hours: 24 } });
    assert.deepEqual(asked, []);
    assert.equal(b.alive[0].dnsFwd.v, 'match');
    assert.deepEqual([b.nameStats.dnsFwd.reused, b.nameStats.dnsFwd.asked, b.nameStats.dnsFwd.match], [1, 0, 1]);
    assert.deepEqual(b.dnsLearned, []);
    // 확인을 끄면(없으면) 묻지도 칸을 두지도 않는다 · 역DNS 를 끄면 묻지 않는다
    const c = await scan.scanRanges(['127.0.0.1'], { ...baseScan(srv.address().port), lookup, nameOpts: { probes: { reverse } } });
    assert.equal(c.alive[0].dnsFwd, undefined); assert.equal(c.nameStats.dnsFwd, undefined); assert.equal(c.dnsLearned, undefined);
    const d = await scan.scanRanges(['127.0.0.1'], { ...baseScan(srv.address().port), reverseDns: false, lookup, nameOpts: { probes: { reverse } }, dnsConfirm: { on: true, cache: [] } });
    assert.equal(d.alive[0].dnsFwd, undefined);
    assert.deepEqual(asked, []);
  } finally { srv.close(); }
});

test('② 물리서버 이름 다음 남은 예산 — 물리서버 단계가 DNS 닿지 않음(차단기)으로 멈췄으면 역DNS 이름은 묻지 않고 확인 못 함(unknown · stopped)', { timeout: 30_000 }, async () => {
  const srv = await tcpServer();
  try {
    const asked = [];
    const hang = (name) => { asked.push(name); return new Promise(() => {}); };
    const reverse = async () => new Map([['127.0.0.1', 'loop.corp']]);
    // 물리서버 이름 12개 · 동시 4 · 시한 2.5초(그 단계 기본값) — 8개가 시한을 넘긴 뒤 시작하는 이름에서 차단기가 선다(약 7.5초)
    const fwdNames = Array.from({ length: 12 }, (_, i) => `phys-${String(i).padStart(2, '0')}`);
    const out = await scan.scanRanges(['127.0.0.1'], { ...baseScan(srv.address().port), lookup: hang, fwdNames, nameOpts: { probes: { reverse } }, dnsConfirm: { on: true, cache: [] } });
    assert.equal(out.fwd.stopped, 'unreachable', JSON.stringify(out.fwd));
    assert.equal(out.alive[0].dnsFwd.v, 'unknown');
    assert.equal(out.nameStats.dnsFwd.stopped, 'unreachable');
    assert.equal(out.nameStats.dnsFwd.asked, 0);
    assert.ok(!asked.includes('loop.corp'), '역DNS 이름은 묻지 않았다');
  } finally { srv.close(); }
});

test('② lookupMany — 차단기 · 예산(공용 코어): 처음 N 개가 전부 시한 초과면 멈추고 · 예산 0 이면 하나도 묻지 않는다(확인 단계)', async () => {
  const hang = () => new Promise(() => {});
  const a = await scan.lookupMany(Array.from({ length: 12 }, (_, i) => `n${i}`), { lookup: hang, timeoutMs: 10, limit: 4, breakAfter: 4 });
  assert.equal(a.stats.stop, 'unreachable');
  assert.ok(a.stats.skipped >= 4, JSON.stringify(a.stats));
  assert.equal(a.res.size, 0);
  let clock = 0;
  const b = await scan.lookupMany(['x', 'y', 'z'], { lookup: async () => { clock += 3000; return [{ address: '10.0.0.1' }]; }, limit: 1, budgetMs: 5000, now: () => clock });
  assert.equal(b.stats.stop, 'budget');
  assert.equal(b.res.size, 2);
  const c = await scan.lookupMany(['x'], { lookup: async () => { throw Object.assign(new Error('n'), { code: 'ENOTFOUND' }); } });
  assert.deepEqual(c.res.get('x'), { err: 'ENOTFOUND' });
  assert.equal(c.stats.failed, 1);
});

// ── ③ 실행기 ─────────────────────────────────────────────────────────────────
test('③ 실행기 — 역DNS 켬 · 확인 끄지 않음이면 기억을 잡에 싣는다(옛 설정 · 옛 중앙 배정 = 켜짐) · 끄면 null', () => {
  const cache = [['a.corp', [], 1]];
  assert.deepEqual(runner.withDnsConfirm({ ranges: [] }, cache).dnsConfirm, { on: true, hours: undefined, cache });
  assert.deepEqual(runner.withDnsConfirm({ reverseDns: true, dnsConfirmHours: 6 }, cache).dnsConfirm, { on: true, hours: 6, cache });
  assert.equal(runner.withDnsConfirm({ reverseDns: false }, cache).dnsConfirm, null);
  assert.equal(runner.withDnsConfirm({ dnsConfirm: false }, cache).dnsConfirm, null);
  // 워커 · 인라인 경로가 잡을 넘긴다(소스 — 자식 프로세스 메시지에 dnsLearned 를 돌려받는다)
  const w = fs.readFileSync(path.join(SRC, 'ipam/scanWorker.js'), 'utf8');
  assert.match(w, /dnsConfirm: j\.dnsConfirm/);
  assert.match(w, /dnsLearned \? \{ dnsLearned \}/);
});

// ── ④ 중앙 정제 · 저장 · 변화 ─────────────────────────────────────────────────
test('④ 정제 — 아는 판정만 · 받은 시각으로 자름 · 다른 IP 는 IPv4 정규형(없으면 버림) · 역DNS 이름이 없으면 받지 않는다', () => {
  const now = 1_000_000;
  assert.deepEqual(ss.cleanDnsFwd({ v: 'match', at: now + 999 }, now), { v: 'match', at: now });
  assert.deepEqual(ss.cleanDnsFwd({ v: 'other', at: 5, addrs: ['010.0.0.1', '10.0.0.1', 'x', '<b>', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5'] }, now), { v: 'other', at: 5, addrs: ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'] });
  assert.equal(ss.cleanDnsFwd({ v: 'other', addrs: ['x'] }, now), null);
  assert.deepEqual(ss.cleanDnsFwd({ v: 'unknown', at: 5, addrs: ['10.0.0.1'] }, now), { v: 'unknown' });
  assert.deepEqual(ss.cleanDnsFwd({ v: 'none', at: 'x' }, now), { v: 'none' });
  for (const bad of [null, 'match', [], { v: 'MATCH' }, { v: 'bogus' }]) assert.equal(ss.cleanDnsFwd(bad, now), null);
  ss.mergeScanResults([
    { ip: '10.32.0.1', openPorts: [22], services: ['SSH'], names: { dns: 'a.corp' }, tried: ['dns'], dnsFwd: { v: 'none', at: 1 } },
    { ip: '10.32.0.2', openPorts: [22], services: ['SSH'], names: { netbios: 'B' }, tried: ['netbios'], dnsFwd: { v: 'none', at: 1 } },
    { ip: '10.32.0.3', openPorts: [22], services: ['SSH'], names: { dns: 'c.corp' }, tried: ['dns'], dnsFwd: { v: 'evil' } },
  ], Date.now(), 'e-320-clean');
  const r = ss.getScanResults();
  assert.deepEqual(r['10.32.0.1'].dnsFwd, { v: 'none', at: 1 });
  assert.equal(r['10.32.0.2'].dnsFwd, undefined, '역DNS 이름이 없는 결과는 받지 않는다');
  assert.equal(r['10.32.0.3'].dnsFwd, undefined);
  assert.deepEqual(ss.scanDetailOf('10.32.0.1').dnsFwd, { v: 'none', at: 1 });
});

test('④ 리비전 · 변화 — 판정 · 다른 IP 가 바뀔 때만 리비전 · 알던 판정에서 어긋날 때만 dns-mismatch(첫 확인 · 확인 못 함 · 이름 변경은 아님)', async () => {
  const batches = [];
  const off = ss.onScanChanges((b) => { batches.push(b); });
  const ip = '10.32.1.1';
  const rep = (dnsFwd, name = 'web.corp') => ss.mergeScanResults([{ ip, openPorts: [80], services: ['HTTP'], names: { dns: name }, tried: ['dns'], ...(dnsFwd ? { dnsFwd } : {}) }], Date.now(), 'e-320-rev');
  const flush = () => new Promise((r) => setImmediate(() => setImmediate(r)));
  const mism = () => batches.flatMap((b) => b.changes).filter((c) => c.type === 'dns-mismatch');
  try {
    rep({ v: 'other', at: 1, addrs: ['10.0.0.9'] });   // 첫 확인 — 어긋나도 변화가 아니다(카드가 보인다)
    await flush();
    assert.equal(mism().length, 0);
    let rev = ss.scanRev();
    rep({ v: 'other', at: 2, addrs: ['10.0.0.9'] });   // 확인 시각만 — 리비전 그대로
    assert.equal(ss.scanRev(), rev);
    rep({ v: 'match', at: 3 });                          // 바로잡힘 — 리비전 오름 · 변화 기록 없음(기록은 어긋남만)
    assert.ok(ss.scanRev() > rev);
    await flush();
    assert.equal(mism().length, 0);
    rep({ v: 'none', at: 4 });                           // 알던 판정(일치)에서 정방향 없음 — 기록
    await flush();
    assert.deepEqual(mism().map((c) => [c.ip, c.name, c.status, c.from]), [[ip, 'web.corp', 'none', 'match']]);
    rep({ v: 'unknown' });                               // 확인 못 함 — 변화 아님
    rep({ v: 'other', at: 6, addrs: ['10.0.0.8'] });    // 확인 못 함 다음 — 알던 판정이 아니다
    await flush();
    assert.equal(mism().length, 1);
    rep({ v: 'other', at: 7, addrs: ['10.0.0.7'] });    // 다른 IP 가 바뀜 — 기록
    await flush();
    assert.deepEqual(mism().slice(-1).map((c) => [c.status, c.from, c.addrs]), [['other', 'other', ['10.0.0.7']]]);
    rep({ v: 'none', at: 8 }, 'web2.corp');              // 이름이 바뀌었다 — rename 이 말한다
    await flush();
    assert.equal(mism().length, 2);
    rep(null, 'web2.corp');                              // 이번 보고에 없으면(옛 엣지 · 확인 끔) 칸을 비운다
    assert.equal(ss.getScanResults()[ip].dnsFwd, undefined);
  } finally { off(); }
});

test('④ 변화 기록 — dns-mismatch 는 아는 종류 · 이름 · 주소를 남기고 알림 규칙이 없어 기록만(notify none)', () => {
  assert.ok(CHANGE_TYPES.includes('dns-mismatch'));
  const e = cleanChange({ type: 'dns-mismatch', ip: '10.0.0.1', name: 'web.corp', status: 'other', from: 'match', addrs: ['10.0.0.9', '<x>'.repeat(20)] }, 5);
  assert.equal(e.name, 'web.corp');
  assert.equal(e.addrs[0], '10.0.0.9');
  assert.ok(e.addrs[1].length <= 32);
  const plan = planBatch({ agent: 'e', changes: [{ type: 'dns-mismatch', ip: '10.0.0.1', name: 'web.corp', status: 'none', from: 'match' }] },
    { cfg: { rules: { ipamConflict: { enabled: true }, ipamNewIp: { enabled: true }, ipamMacChange: { enabled: true }, ipamRename: { enabled: true }, ipamReservedUp: { enabled: true } } } });
  assert.equal(plan.entries[0].notify, 'none');
  assert.equal(plan.groups.size, 0, '알림 묶음에 들어가지 않는다');
});

// ── ⑤ 요약 · 설정 ────────────────────────────────────────────────────────────
test('⑤ 요약 정제 — 수치만(못 읽음 null) · 멈춘 사유는 아는 값만 · 없으면 칸을 두지 않는다 · 설정 기본 켜짐 · 기간 1~720시간', () => {
  const ns = ss.cleanNameStats({ named: 1, alive: 2, dnsFwd: { names: 3, reused: '1', asked: 'x', match: -1, other: 2, none: 0, unknown: 1, stopped: 'evil', extra: 9 } });
  assert.deepEqual(ns.dnsFwd, { names: 3, reused: 1, asked: null, match: null, other: 2, none: 0, unknown: 1 });
  assert.equal(ss.cleanNameStats({ named: 1, dnsFwd: { stopped: 'budget' } }).dnsFwd.stopped, 'budget');
  assert.equal(ss.cleanNameStats({ named: 1 }).dnsFwd, undefined);
  const a = ss.loadScanSettings('edge-320-new');
  assert.deepEqual([a.dnsConfirm, a.dnsConfirmHours], [true, 24]);
  const b = ss.saveScanSettings('edge-320-new', { dnsConfirm: false, dnsConfirmHours: 6 });
  assert.deepEqual([b.dnsConfirm, b.dnsConfirmHours], [false, 6]);
  assert.equal(ss.saveScanSettings('edge-320-new', { dnsConfirmHours: '' }).dnsConfirmHours, 6, '빈 값은 미지정(이전 값 유지)');
  assert.equal(ss.saveScanSettings('edge-320-new', { dnsConfirmHours: 99999 }).dnsConfirmHours, 720);
});

// ── ⑥ 대장 · 추천 카드 · CSV · 범위 계정 · 디스크 로드(자식 프로세스) ──────────────
test('⑥ /tools/ipam dnsFwd 칸(일치는 판정만 · 어긋남은 이름 · 주소) · 범위 계정에는 없음 · 추천 카드 16 · scan-report.csv dns_forward · 디스크 로드', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-320-route-'));
  fs.writeFileSync(path.join(dir, 'ipam-scan-results.json'), JSON.stringify({
    '10.250.9.5': { ip: '10.250.9.5', openPorts: [22], services: ['SSH'], lastSeen: Date.now(), agent: '__local__', names: { dns: { v: 'stale.corp', at: 1, miss: 0 } }, dnsFwd: { v: 'other', at: 2, addrs: ['10.250.9.99'] } },
    '10.250.9.6': { ip: '10.250.9.6', openPorts: [22], services: ['SSH'], lastSeen: Date.now(), agent: '__local__', names: { dns: { v: 'ok.corp', at: 1, miss: 0 } }, dnsFwd: { v: 'match', at: 2 } },
    '10.250.9.7': { ip: '10.250.9.7', openPorts: [22], services: ['SSH'], lastSeen: Date.now(), agent: '__local__', names: { dns: { v: 'gone.corp', at: 1, miss: 0 } }, dnsFwd: { v: 'none', at: 2 } },
    '10.250.9.8': { ip: '10.250.9.8', openPorts: [22], services: ['SSH'], lastSeen: Date.now(), agent: '__local__', names: { dns: { v: 'slow.corp', at: 1, miss: 0 } }, dnsFwd: { v: 'unknown' } },
    '10.250.9.9': { ip: '10.250.9.9', openPorts: [22], services: ['SSH'], lastSeen: Date.now(), agent: '__local__', dnsFwd: { v: 'none', at: 2 } },
    // 디스크의 꼴이 틀린 값 — 로드 정제(모르는 판정 · 주소 꼴 · 미래 시각)
    '10.250.9.10': { ip: '10.250.9.10', openPorts: [22], services: ['SSH'], lastSeen: Date.now(), agent: '__local__', names: { dns: { v: 'evil.corp', at: 1, miss: 0 } }, dnsFwd: { v: 'evil' } },
    '10.250.9.11': { ip: '10.250.9.11', openPorts: [22], services: ['SSH'], lastSeen: Date.now(), agent: '__local__', names: { dns: { v: 'odd.corp', at: 1, miss: 0 } }, dnsFwd: { v: 'other', at: 9e15, addrs: ['<b>', '10.250.9.98'] } },
  }));
  const script = `
    const SRC = ${JSON.stringify(SRC + '/')};
    const express = (await import('express')).default;
    const { store } = await import(SRC + 'store.js');
    await store.refresh?.();
    const { api } = await import(SRC + 'routes/api.js');
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
      const ss = await import(SRC + 'ipam/scanStore.js');
      ss.mergeScanResults([{ ip: vm.ip, openPorts: [22], services: ['SSH'], names: { dns: 'vm-old.corp' }, tried: ['dns'], dnsFwd: { v: 'none', at: 3 } }], Date.now(), '__local__');
      const led = await call('/tools/ipam');
      out.vmRow = led.j.rows.find((r) => r.ip === vm.ip && r.ownerType === 'vm');
      out.rows = Object.fromEntries(led.j.rows.filter((r) => r.ip.startsWith('10.250.9.')).map((r) => [r.ip, { dnsFwd: r.dnsFwd, dnsPtr: r.dnsPtr, dnsFwdAddrs: r.dnsFwdAddrs, dnsFwdAt: r.dnsFwdAt }]));
      out.loaded11 = ss.getScanResults()['10.250.9.11']?.dnsFwd;
      const vc = vm.vcenterId;
      const sled = await call('/tools/ipam', { 'x-scope': vc });
      out.scopedAny = sled.j.rows.some((r) => r.dnsFwd);
      out.scopedVm = sled.j.rows.find((r) => r.ip === vm.ip && r.ownerType === 'vm');
      const ins = await call('/tools/ipam/insights');
      out.card = ins.j.features.find((f) => f.key === 'ptr');
      out.cards = ins.j.features.length;
      const sins = await call('/tools/ipam/insights', { 'x-scope': vc });
      out.scopedCard = sins.j.features.find((f) => f.key === 'ptr');
      out.hist = (await call('/tools/ipam/history?ip=10.250.9.5')).j;
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
  assert.deepEqual(o.rows['10.250.9.5'], { dnsFwd: 'other', dnsPtr: 'stale.corp', dnsFwdAddrs: ['10.250.9.99'], dnsFwdAt: 2 });
  assert.deepEqual(o.rows['10.250.9.6'], { dnsFwd: 'match' }, '일치는 판정만(행마다 실리므로 짧게)');
  assert.deepEqual(o.rows['10.250.9.7'], { dnsFwd: 'none', dnsPtr: 'gone.corp', dnsFwdAt: 2 });
  assert.deepEqual(o.rows['10.250.9.8'], { dnsFwd: 'unknown' });
  assert.deepEqual(o.rows['10.250.9.9'], {}, '역DNS 이름 없는 저장본의 결과는 로드에서 버린다');
  assert.deepEqual(o.rows['10.250.9.10'], {}, '모르는 판정은 로드에서 버린다');
  assert.ok(o.loaded11.at <= Date.now(), '미래 시각은 로드 시각으로 자른다');
  assert.deepEqual(o.loaded11.addrs, ['10.250.9.98']);
  assert.equal(o.vmRow.dnsFwd, 'none', 'VM 행에도 스캔이 확인한 정방향 결과');
  assert.equal(o.vmRow.dnsPtr, 'vm-old.corp');
  assert.ok(o.scopedVm, '범위 계정도 자기 VM 행은 본다');
  assert.equal(o.scopedVm.dnsFwd, undefined, '범위 계정의 VM 행에는 싣지 않는다(스캔 결과는 vCenter 귀속이 없다)');
  assert.equal(o.scopedAny, false);
  assert.equal(o.cards, 30, '추천 기능 30선 — 개수는 그대로');
  assert.equal(o.card.title, 'DNS 정합성 · 레코드 초안');
  assert.equal(o.card.value, '불일치 4');
  assert.equal(o.card.severity, 'warn');
  assert.deepEqual(o.card.dnsCheck.counts, { match: 1, other: 2, none: 2, unknown: 1 });
  const cr = o.card.dnsCheck.rows.filter((x) => x.ip.startsWith('10.250.9.'));
  assert.deepEqual(cr.map((x) => [x.ip, x.v, x.ptr, x.addrs.join(' ')]), [['10.250.9.5', 'other', 'stale.corp', '10.250.9.99'], ['10.250.9.7', 'none', 'gone.corp', ''], ['10.250.9.11', 'other', 'odd.corp', '10.250.9.98']]);
  const vmCard = o.card.dnsCheck.rows.find((x) => x.ip === o.vmRow.ip);
  assert.equal(vmCard.knownSrc, 'vm', '대장이 아는 이름 — VM 이름');
  assert.equal(o.scopedCard.dnsCheck, undefined, '범위 계정은 예전 카드(레코드 초안)');
  assert.equal(o.scopedCard.title, 'DNS 레코드 제안(정방향/PTR)');
  assert.deepEqual(o.hist.scan.dnsFwd, { v: 'other', at: 2, addrs: ['10.250.9.99'] });
  const lines = String(o.csv).trim().split('\n');
  assert.ok(lines[0].endsWith(',mac_vendor,dns_forward,dns_forward_addrs'));
  assert.ok(lines.find((l) => l.startsWith('10.250.9.5,')).endsWith(',other,10.250.9.99'));
  assert.ok(lines.find((l) => l.startsWith('10.250.9.6,')).endsWith(',match,'));
  assert.ok(lines.find((l) => l.startsWith('10.250.9.8,')).endsWith(',,'), '확인 못 함은 빈칸');
});

// ── ⑦ 엣지 — 실제 워커 ────────────────────────────────────────────────────────
test('⑦ 엣지 — 실제 워커(자식 프로세스 스캔)가 결과 본문에 nameStats.dnsFwd 를 싣고 · 역DNS 이름이 있는 행에는 dnsFwd 판정을 단다(목 중앙)', { timeout: 90_000 }, async () => {
  const tcp = await tcpServer();
  const posted = [];
  const central = await new Promise((r) => {
    const s = http.createServer((q, res) => {
      const ch = []; q.on('data', (c) => ch.push(c));
      q.on('end', () => {
        const p = q.url.split('?')[0];
        let json = { ok: true };
        if (p === '/api/central/ip-scan-assignment') json = { ok: true, assigned: true, ranges: ['127.0.0.1'], ports: [tcp.address().port], concurrency: 2, timeoutMs: 300, reverseDns: true, ping: false, mdns: false, netbios: false, dnsConfirmHours: 6, intervalMs: 3_600_000 };
        if (p === '/api/central/ip-scan-result') { posted.push(JSON.parse(Buffer.concat(ch).toString() || '{}')); json = { ok: true, merged: 1 }; }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(json));
      });
    });
    s.listen(0, '127.0.0.1', () => r(s));
  });
  const { config } = await import('../src/config.js');
  config.agent.centralUrl = `http://127.0.0.1:${central.address().port}`;
  config.agent.centralToken = TOKEN;
  config.agent.name = 'edge-320';
  const w = await import('../src/agent/ipScanWorker.js');
  try {
    w._resetIpScanAgentForTest();
    const r1 = await quiet(() => w.runIpScanAgentOnce());
    assert.equal(r1.error, undefined, JSON.stringify(r1));
    assert.equal(posted.length, 1);
    const b = posted[0];
    const st = b.nameStats?.dnsFwd;
    assert.ok(st && typeof st === 'object', JSON.stringify(b.nameStats));
    for (const k of ['names', 'reused', 'asked', 'match', 'other', 'none', 'unknown']) assert.equal(typeof st[k], 'number', k);
    // 루프백의 역DNS 이름은 환경마다 다르다(없을 수도 있다) — 이름이 있으면 판정이 붙고, 없으면 칸이 없다
    for (const row of b.alive) {
      if (row.names?.dns) assert.ok(dc.DNS_FWD_STATES.includes(row.dnsFwd?.v), JSON.stringify(row));
      else assert.equal(row.dnsFwd, undefined);
    }
    assert.equal(st.match + st.other + st.none + st.unknown, b.alive.filter((x) => x.names?.dns).length);
  } finally {
    central.close(); tcp.close();
    config.agent.centralUrl = '';
  }
});
