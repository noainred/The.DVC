// v2.731 점검 1회차 G5a — IP 스캔 저장·IP 원장 재구성이 이벤트 루프를 길게 막던 것(A6-01 · A6-02).
//  A6-01: 엣지 보고마다 결과 맵 + 이력 맵 전체를 들여쓰기 JSON 으로 메인 스레드에서 직렬화·fsync 했다(5만 IP 336~480ms,
//         이벤트 5개면 640~1,005ms). 이제 조각 직렬화 + 시간 기준 양보 + 비동기 tmp→fsync→rename, 종료 flush 는 동기.
//  A6-02: 원장 재구성(buildIpamRows) + 행 서명이 스캔 IP 수에 비례하는 동기 작업이었다(5만 365~437ms, 20만 2~2.9초).
//         이제 같은 생성기를 양보하며 돌리는 buildIpamRowsAsync · ledgerSignatureAsync 를 store.syncLedger 가 큰 원장에서 쓴다.
//  ⚠ CONFIG_DIR 은 import 전에 고정한다(config.js 가 import 시점에 굳는다) — 그래서 모듈은 before() 에서 동적으로 읽는다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2731g5a-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.IPAM_WRITE_DEBOUNCE_MS = '100';

const RES = path.join(tmp, 'ipam-scan-results.json');
const HIST = path.join(tmp, 'ipam-scan-history.json');
const STALE_TMP = path.join(tmp, '.ipam-scan-results.json.atmp-999-1');
const N = 40_000;
const EV = 5;
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * 60_000; // 정시 -30분(경계에서 떨어뜨린 고정 기준 — v2.517 규약)
const ipOf = (i) => `10.${50 + ((i >> 16) & 15)}.${(i >> 8) & 255}.${i & 255}`;

// 미리 심는다: 결과·이력 4만 IP(이력은 이벤트 5개) + 이전 프로세스가 남긴 비동기 쓰기 임시 파일.
(function seed() {
  const results = {}; const history = {};
  for (let i = 0; i < N; i++) {
    const ip = ipOf(i); const agent = `edge-${i % 28}`;
    results[ip] = { ip, openPorts: [22, 443], services: ['ssh', 'https'], hostname: `host-${i}.corp.example.local`, lastSeen: NOW - 60_000, agent };
    const events = [];
    for (let e = 0; e < EV; e++) events.push({ ts: NOW - 86_400_000 * (30 - e), type: e % 2 ? 'down' : 'up', hostname: `host-${i}.corp.example.local`, ports: [22, 443], agent });
    history[ip] = { ip, firstSeen: NOW - 86_400_000 * 30, lastSeen: NOW - 60_000, status: i % 10 === 0 ? 'down' : 'up', agent, events };
  }
  fs.writeFileSync(RES, JSON.stringify(results));
  fs.writeFileSync(HIST, JSON.stringify(history));
  fs.writeFileSync(STALE_TMP, '{"partial":');
})();

let ss, led, st, ov, rp, exitFlush;
before(async () => {
  ss = await import('../src/ipam/scanStore.js');
  led = await import('../src/ipam/ledger.js');
  st = await import('../src/store.js');
  ov = await import('../src/ipam/overrides.js');
  rp = await import('../src/ipam/rangePolicies.js');
  exitFlush = await import('../src/util/exitFlush.js');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const inode = (f) => { try { return fs.statSync(f).ino; } catch { return null; } };
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
/** 이벤트 루프 최장 정지를 재는 탐침(1ms 타이머 사슬). */
function gapProbe() {
  let max = 0; let last = performance.now(); let on = true;
  const tick = () => { const t = performance.now(); if (t - last > max) max = t - last; last = t; if (on) setTimeout(tick, 1); };
  setTimeout(tick, 1);
  return { stop: async () => { await sleep(20); on = false; return max; } };
}

// ── A6-01 ────────────────────────────────────────────────────────────────────
test('A6-01 ⓪ 이전 프로세스가 남긴 비동기 쓰기 임시 파일(.atmp-)은 로드 때 치운다', () => {
  assert.equal(fs.existsSync(STALE_TMP), false, '남은 임시 파일이 그대로다');
  assert.equal(Object.keys(ss.getScanResults()).length, N);
});

test('A6-01 ① 엣지 보고 1건의 디바운스 저장이 이벤트 루프를 길게 막지 않는다(4만 IP · 이벤트 5개)', async () => {
  // 비교 기준: 같은 맵을 이 프로세스에서 한 번에 직렬화하는 시간(예전 저장의 하한 — 들여쓰기·fsync 는 빼고)
  const t0 = performance.now(); JSON.stringify(ss.getScanResults()); const base = performance.now() - t0;
  const r0 = mtime(RES); const h0 = mtime(HIST);
  const agent = 'edge-3';
  const alive = [];
  for (let i = 3; i < N; i += 28) alive.push({ ip: ipOf(i), openPorts: i === 3 ? [22] : [22, 443], services: ['ssh', 'https'], hostname: `host-${i}.corp.example.local` });
  alive.push({ ip: '10.99.0.1', openPorts: [80], services: ['http'], hostname: 'new-host' }); // 새 IP — 결과·이력 모두 내용 변화(짧은 디바운스)
  await sleep(30);
  const probe = gapProbe();
  ss.mergeScanResults(alive, NOW, agent);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && (mtime(RES) === r0 || mtime(HIST) === h0)) await sleep(5);
  const maxGap = await probe.stop();
  assert.notEqual(mtime(RES), r0, '결과 파일이 저장되지 않았다');
  assert.notEqual(mtime(HIST), h0, '이력 파일이 저장되지 않았다');
  const limit = Math.max(150, base * 0.6);
  console.log(`[A6-01] 저장 중 최장 정지 ${Math.round(maxGap)}ms · 한 번 직렬화 ${Math.round(base)}ms · 한도 ${Math.round(limit)}ms(단언은 한도)`);
  assert.ok(maxGap < limit, `저장 중 이벤트 루프 최장 정지 ${Math.round(maxGap)}ms ≥ ${Math.round(limit)}ms(한 번 직렬화 ${Math.round(base)}ms) — 수정 전 실측 4~5만 IP 336~1,005ms`);
  const back = JSON.parse(fs.readFileSync(RES, 'utf8'));
  assert.deepEqual(back[ipOf(3)].openPorts, [22]);
  assert.ok(back['10.99.0.1']);
  assert.ok(JSON.parse(fs.readFileSync(HIST, 'utf8'))['10.99.0.1']);
});

test('A6-01 ② 조각 직렬화 결과는 들여쓰기 없는 JSON.stringify(맵) 과 바이트 단위로 같다', async () => {
  ss.mergeScanResults([{ ip: '10.99.0.2', openPorts: [22], services: ['ssh'], hostname: 'eq' }], NOW + 1000, 'edge-1');
  await ss.flushScanStoreAsync();
  assert.equal(fs.readFileSync(RES, 'utf8'), JSON.stringify(ss.getScanResults()), '결과 파일 본문이 맵 직렬화와 다르다');
  const hist = JSON.parse(fs.readFileSync(HIST, 'utf8'));
  assert.equal(Object.keys(hist).length, N + 2);
  for (const ip of [ipOf(0), ipOf(3), ipOf(39_999), '10.99.0.1', '10.99.0.2']) assert.deepEqual(hist[ip], ss.getIpHistory(ip), ip);
  assert.ok(!fs.readFileSync(HIST, 'utf8').includes('\n  '), '들여쓰기가 남아 있다');
  const w = ss.scanStoreWriteStatus();
  assert.equal(w['ipam-scan-results.json'].failures, 0);
  assert.ok(!('message' in (w['ipam-scan-results.json'].lastError || {})), '상태에 오류 원문(경로)을 싣지 않는다');
});

test('A6-01 ③ 바뀐 것이 없는 보고(살아 있는 IP 0개)는 파일을 다시 쓰지 않는다', async () => {
  await ss.flushScanStoreAsync();
  const i0 = inode(RES); const m0 = mtime(RES);
  ss.mergeScanResults([], NOW + 2000, 'edge-1');
  ss.mergeScanResults([{ ip: '10.99.0.2', openPorts: [22], services: ['ssh'], hostname: 'eq' }], NOW - 999_999, 'edge-1'); // 더 오래된 보고 — 결과 불변
  const w = ss.scanStoreWriteStatus();
  assert.equal(w['ipam-scan-results.json'].dirty, false, '바뀐 것이 없는데 결과 저장을 예약했다');
  assert.equal(w['ipam-scan-results.json'].pending, false);
  assert.equal(w['ipam-scan-history.json'].dirty, false, '바뀐 것이 없는데 이력 저장을 예약했다');
  await sleep(400);
  assert.equal(inode(RES), i0, '바뀐 것이 없는데 결과 파일을 다시 썼다');
  assert.equal(mtime(RES), m0);
});

test('A6-01 ④ lastSeen 만 바뀐 보고는 긴 디바운스로 묶고, 종료 flush(동기)는 그것까지 쓴다', async () => {
  await ss.flushScanStoreAsync();
  const i0 = inode(RES); const h0 = inode(HIST);
  const ts = NOW + 60_000;
  ss.mergeScanResults([{ ip: ipOf(5), openPorts: [22, 443], services: ['ssh', 'https'], hostname: 'host-5.corp.example.local' }], ts, 'edge-5');
  await sleep(400);
  assert.equal(inode(RES), i0, 'lastSeen 만 바뀐 결과를 짧은 디바운스로 썼다');
  assert.equal(inode(HIST), h0, 'lastSeen 만 바뀐 이력을 짧은 디바운스로 썼다');
  const w = ss.scanStoreWriteStatus();
  assert.equal(w['ipam-scan-results.json'].dirty, true);
  assert.equal(w['ipam-scan-results.json'].pending, true, '긴 디바운스가 예약돼 있어야 한다');
  ss.flushAllNow();
  assert.equal(JSON.parse(fs.readFileSync(RES, 'utf8'))[ipOf(5)].lastSeen, ts);
  assert.equal(JSON.parse(fs.readFileSync(HIST, 'utf8'))[ipOf(5)].lastSeen, ts);
  assert.equal(ss.scanStoreWriteStatus()['ipam-scan-results.json'].pending, false);
});

test('A6-01 ⑤ 진행 중인 비동기 쓰기를 동기 flush 가 대체하면 그 쓰기는 rename 하지 않는다(옛 본문이 새 본문을 덮지 않는다)', async () => {
  // 내용 변화로 결과 쓰기를 시작하고(조각 쓰기 도중까지 진행) → 이미 쓴 앞쪽 항목을 바꾸고 동기 flush → 비동기 쓰기가 끝난 뒤에도 새 값이어야 한다.
  ss.mergeScanResults([{ ip: '10.99.0.3', openPorts: [1], services: [], hostname: 'a' }], NOW + 3000, 'edge-1');
  const p = ss.flushScanStoreAsync();
  for (let i = 0; i < 400 && !ss.scanStoreWriteStatus()['ipam-scan-results.json'].writing; i++) await new Promise((r) => { setImmediate(r); });
  assert.equal(ss.scanStoreWriteStatus()['ipam-scan-results.json'].writing, true, '테스트 전제: 비동기 쓰기가 진행 중이어야 한다');
  await sleep(3);
  const firstIp = Object.keys(ss.getScanResults())[0];
  ss.mergeScanResults([{ ip: firstIp, openPorts: [9999], services: ['late'], hostname: 'late' }], NOW + 4000, 'edge-9');
  ss.flushAllNow();
  await p;
  await sleep(50);
  const back = JSON.parse(fs.readFileSync(RES, 'utf8'));
  assert.deepEqual(back[firstIp].openPorts, [9999], '늦게 끝난 비동기 쓰기가 동기 flush 의 새 본문을 덮었다');
  assert.ok(back['10.99.0.3']);
  assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.includes('.atmp-')), [], '대체된 쓰기의 임시 파일이 남았다');
});

test('A6-01 ⑥ 종료 flush 는 공용 레지스트리(util/exitFlush.js)에 등록돼 있다', () => {
  assert.ok(exitFlush.exitFlushNames().includes('ipam/scanStore'));
});

// ── A6-02 ────────────────────────────────────────────────────────────────────
function bigSnap(gen) {
  const vcenters = []; for (let i = 0; i < 11; i++) vcenters.push({ id: `vc-${i}`, name: `VC${i}` });
  // 같은 IP 를 두 VM 이 주장 — dupA 는 맨 앞, dupB 는 맨 뒤라 VM 행(8,192 초과)의 서로 다른 정렬 조각에 들어간다.
  //   안정 정렬이면 VM 순서(A → B)가 유지된다(조각 병합에서 같은 키는 왼쪽 먼저).
  const vms = [{ id: 'vm-dupA', name: 'dupA', vcenterId: 'vc-1', powerState: 'POWERED_ON', guestOS: 'x', ipAddresses: ['10.3.0.7'] }];
  for (let i = 0; i < 7_500; i++) {
    const vc = `vc-${i % 11}`;
    const ips = [`10.1.${(i >> 8) & 255}.${i & 255}`];
    if (i % 7 === 0) ips.push(`10.2.${(i >> 8) & 255}.${i & 255}`);
    if (i % 13 === 0) ips.push('fe80::1'); // ipNum null — 정렬 비교가 NaN(같음)인 행
    vms.push({ id: `vm-${i}`, name: `vm${i}`, vcenterId: vc, powerState: i % 5 ? 'POWERED_ON' : 'POWERED_OFF', guestOS: i % 2 ? 'CentOS 7 (64-bit)' : 'Windows Server 2019', host: `esx${i % 40}`, cluster: `cl${i % 5}`, ipAddresses: ips, ipAddress: ips[0] });
  }
  vms.push({ id: 'vm-scan', name: 'scanned-vm', vcenterId: 'vc-3', powerState: 'POWERED_ON', guestOS: 'x', ipAddresses: [ipOf(11)] }); // 스캔에도 있는 IP → both
  vms.push({ id: 'vm-dupB', name: 'dupB', vcenterId: 'vc-2', powerState: 'POWERED_ON', guestOS: 'x', ipAddresses: ['10.3.0.7'] });
  const hosts = [];
  for (let i = 0; i < 200; i++) hosts.push({ id: `h-${i}`, name: i % 3 ? `10.4.0.${i}` : `esx${i}.corp.local`, vcenterId: `vc-${i % 11}`, version: '8.0.2', powerState: 'POWERED_ON', cluster: `cl${i % 5}` });
  return { generatedAt: gen, vcenters, vms, hosts, datastores: [], networks: [], alarms: [] };
}

test('A6-02 ① scanResultListAsync 는 scanResultList 와 같은 순서·같은 객체를 주고 중간에 양보한다', async () => {
  const { createYielder } = await import('../src/util/timeSlice.js');
  const y = createYielder(1);
  const a = await ss.scanResultListAsync(y);
  const b = ss.scanResultList();
  assert.equal(a.length, b.length);
  assert.ok(a.length > 3 * 8192, `조각 병합 경로를 타야 한다(${a.length})`);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) assert.fail(`${i} 번째가 다르다: ${a[i]?.ip} ≠ ${b[i]?.ip}`);
  assert.ok(y.count() > 0, '양보하지 않았다');
  assert.ok((await ss.scanResultListAsync(createYielder(0.0001), () => true)) === null, '취소되면 null');
});

test('A6-02 ② buildIpamRowsAsync 결과는 buildIpamRows 와 깊이 같다(스캔 4만 · 무시 규칙 · override · 대역 정책 · 같은 IP · 비 IPv4)', async () => {
  const settings = await import('../src/ipam/settings.js');
  settings.saveSettings({ global: ['10.1.0.0/26'], vcenters: { 'vc-3': ['10.2.0.0/24'] }, publicRanges: ['10.4.0.0/24'], privateRanges: [] });
  ov.setOverride('10.1.1.5', { status: 'static', owner: 'net', label: 'core' }, { username: 't' });
  ov.setOverride('10.1.1.6', { status: 'ignored' }, { username: 't' });
  ov.setOverride('10.9.9.9', { status: 'reserved', label: 'plan' }, { username: 't' }); // 어디에도 없는 IP → manual 행
  const pol = rp.setPolicy({ spec: '10.50.3.0/24', status: 'dhcp', label: 'dhcp-pool' }, { username: 't' });
  assert.ok(pol.ok, JSON.stringify(pol));
  const base = bigSnap('g-a');
  const snapB = { ...base, generatedAt: 'g-b' }; // 같은 내용 · 다른 세대(캐시 적중 없이 각자 계산)
  const stats = {};
  const asy = await led.buildIpamRowsAsync(base, '', null, { stats });
  const syn = led.buildIpamRows(snapB);
  assert.ok(asy, `양보판이 결과를 내지 않았다(${JSON.stringify(stats)})`);
  assert.ok(stats.yields > 0, '양보하지 않았다');
  assert.ok(syn.rows.length > 3 * 8192, `조각 정렬 + 병합 경로를 타야 한다(${syn.rows.length})`);
  assert.ok(isDeepStrictEqual(asy, syn), '양보판과 동기판의 결과가 다르다');
  // 정렬 불변식(독립 확인): ipNum 오름차순(null 은 뒤) · 같은 IP 는 VM 순서 그대로(안정 정렬)
  const key = (r) => (r.ipNum ?? Infinity);
  for (let i = 1; i < syn.rows.length; i++) assert.ok(!(key(syn.rows[i - 1]) > key(syn.rows[i])), `${i} 번째 정렬이 깨졌다`);
  const dups = syn.rows.filter((r) => r.ip === '10.3.0.7').map((r) => r.ownerName);
  assert.ok(syn.rows.filter((r) => r.ownerType === 'vm').length > 8192, '테스트 전제: dupA(첫 VM 행)와 dupB(마지막 VM 행)가 다른 정렬 조각에 있어야 한다');
  assert.deepEqual(dups, ['dupA', 'dupB'], '같은 IP 행의 순서가 바뀌었다(안정 정렬이 아니다)');
  assert.ok(syn.rows.some((r) => r.ip === 'fe80::1' && r.ipNum == null), '비 IPv4 행');
  assert.ok(syn.rows.some((r) => r.ip === '10.9.9.9' && r.ownerType === 'manual'));
  assert.ok(syn.rows.some((r) => r.ip === ipOf(11) && r.discovery === 'both'));
  assert.ok(syn.rows.some((r) => r.ownerType === 'scanned' && r.usageStatus === 'down' && r.released === true), '이력 down 이 행에 반영되지 않았다');
  assert.ok(syn.rows.some((r) => r.mgmtStatus === 'dhcp' && r.appliedBy === 'range-policy'));
  assert.ok(!syn.rows.some((r) => r.ip === '10.1.1.6'), 'override ignored 행이 남았다');
  assert.equal(st.ledgerSignature(syn.rows), await st.ledgerSignatureAsync(asy.rows), '양보판 서명이 다르다');
  // 범위 계정·vCenter 필터도 같은 코드
  assert.ok(isDeepStrictEqual(await led.buildIpamRowsAsync({ ...base, generatedAt: 'g-c' }, 'vc-3', null), led.buildIpamRows({ ...base, generatedAt: 'g-d' }, 'vc-3', null)), 'vCenter 필터 결과가 다르다');
  const allowed = new Set(['vc-1', 'vc-2']);
  assert.ok(isDeepStrictEqual(await led.buildIpamRowsAsync({ ...base, generatedAt: 'g-e' }, '', allowed), led.buildIpamRows({ ...base, generatedAt: 'g-f' }, '', allowed)), '범위 계정 결과가 다르다');
});

test('A6-02 ③ 양보판은 계산 도중 이벤트 루프를 길게 막지 않는다(동기판 한 번과 비교)', async () => {
  const s1 = bigSnap('g-p1'); const s2 = bigSnap('g-p2');
  const t0 = performance.now(); led.buildIpamRows(s1); const syncMs = performance.now() - t0;
  await sleep(20);
  const probe = gapProbe();
  const out = await led.buildIpamRowsAsync(s2, '', null);
  const maxGap = await probe.stop();
  assert.ok(out != null, '양보판이 결과를 내지 않았다');
  const limit = Math.max(60, syncMs * 0.5);
  console.log(`[A6-02] 양보판 최장 정지 ${Math.round(maxGap)}ms · 동기판 ${Math.round(syncMs)}ms · 한도 ${Math.round(limit)}ms(단언은 한도)`);
  assert.ok(maxGap < limit, `양보판 최장 정지 ${Math.round(maxGap)}ms ≥ ${Math.round(limit)}ms(동기판 한 번 ${Math.round(syncMs)}ms)`);
});

test('A6-02 ④ 계산 도중 관리 입력이 바뀌면 섞인 결과를 내지 않고(null · changed) 캐시에도 넣지 않는다 · 취소는 cancelled', async () => {
  const snap = bigSnap('g-chg');
  const stats = {};
  const p = led.buildIpamRowsAsync(snap, '', null, { stats, sliceMs: 2 });
  await sleep(1); // 첫 양보 뒤에 실행된다
  ov.setOverride('10.1.2.3', { status: 'static', owner: 'mid-build' }, { username: 't' });
  assert.ok((await p) === null, '도중에 입력이 바뀌었는데 결과를 냈다');
  assert.equal(stats.aborted, 'changed');
  const fresh = led.buildIpamRows(snap);
  assert.equal(fresh.rows.find((r) => r.ip === '10.1.2.3')?.owner_, 'mid-build', '바뀐 입력이 다음 계산에 반영되지 않았다(섞인 결과가 캐시에 남았다)');
  const s2 = {};
  assert.ok((await led.buildIpamRowsAsync(bigSnap('g-cancel'), '', null, { stats: s2, isCancelled: () => true, sliceMs: 1 })) === null, '취소됐는데 결과를 냈다');
  assert.equal(s2.aborted, 'cancelled');
});

test('A6-02 ⑤ store.syncLedger — 큰 원장은 양보 경로로 만들고 쓴다 · 더 새 호출이 오면 옛 계산은 취소되고 마지막 내용이 기억된다', async () => {
  const S = st.store;
  const saved = S.snapshot;
  st._setLedgerAsyncMinForTest(0);
  try {
    S.snapshot = bigSnap('g-s1');
    S._ledgerFullAt = 0;
    const t0 = Date.now();
    const c0 = performance.now(); S.syncLedger(); const callMs = performance.now() - c0;
    for (let i = 0; i < 1500 && !(S.ledgerSync && S.ledgerSync.at >= t0 && S._lastLedgerSig); i++) await sleep(10);
    assert.equal(S.ledgerSync?.ok, true, `동기화 실패: ${JSON.stringify(S.ledgerSync)}`);
    const status = st.storeStatus().ledgerAsync;
    assert.ok(status && status.builds >= 1 && status.last?.result === 'ok', JSON.stringify(status));
    assert.equal(S._lastLedgerSig, st.ledgerSignature(led.buildIpamRows(S.snapshot).rows), '기억한 서명이 원장 내용과 다르다');
    assert.ok(callMs < 1000, `호출이 원장 계산을 기다렸다(${Math.round(callMs)}ms)`);
    // 연속 두 번: 첫 계산은 취소되고 두 번째(마지막 내용)가 기억된다
    const cancelledBefore = status.cancelled;
    S.snapshot = bigSnap('g-s2');
    ov.setOverride('10.1.3.3', { status: 'static', owner: 'first' }, { username: 't' });
    S.syncLedger();
    await new Promise((r) => { setImmediate(r); });
    ov.setOverride('10.1.3.3', { status: 'static', owner: 'second' }, { username: 't' });
    const t1 = Date.now();
    S.syncLedger();
    const seqNow = S._ledgerSeq;
    for (let i = 0; i < 1500 && !(S.ledgerSync && S.ledgerSync.at >= t1 && S._lastLedgerSig); i++) await sleep(10);
    await sleep(100);
    assert.equal(S._ledgerSeq, seqNow);
    const want = led.buildIpamRows(S.snapshot);
    assert.equal(want.rows.find((r) => r.ip === '10.1.3.3')?.owner_, 'second');
    assert.equal(S._lastLedgerSig, st.ledgerSignature(want.rows), '마지막 내용이 아니라 중간 내용이 기억됐다');
    assert.ok(st.storeStatus().ledgerAsync.cancelled > cancelledBefore, '옛 계산이 취소되지 않았다');
    // 진행 보장: 양보 경로가 '입력 변경' 으로 연달아 버려졌으면 다음 한 번은 동기로 만든다(관리 입력이 계산보다 자주 바뀌어도 ipam.db 가 낡지 않게)
    const la = st.storeStatus().ledgerAsync;
    la.changedStreak = 3;
    const builds0 = la.builds; const fb0 = la.syncFallbacks;
    S._ledgerFullAt = 0;
    S.syncLedger();
    assert.equal(la.syncFallbacks, fb0 + 1, '동기 대체 경로를 타지 않았다');
    assert.equal(la.builds, builds0, '양보 경로를 또 시작했다');
    assert.equal(la.changedStreak, 0);
  } finally {
    st._setLedgerAsyncMinForTest();
    S.snapshot = saved;
  }
});
