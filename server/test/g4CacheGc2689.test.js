/**
 * v2.689 G4 — 수집기 인메모리 캐시의 나이 제한(C-01)과 정리(C-05·C-06·C-07).
 *
 * 규칙(각 정리 함수 공통):
 *   ① 이번 주기의 live 키는 절대 지우지 않는다.
 *   ② live 집합에서 빠진 키는 다음 정리에서 사라진다.
 *   ③ vGPU 캐시는 max(주기 × 3, 15분)보다 오래된 값을 호스트에 적용하지 않는다(값 없음 — 0 으로 채우지 않는다).
 * 기준 시각은 고정한다(CLAUDE.md — Date.now() 를 기준 시각으로 쓰지 말 것).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { stripComments } from './_stripComments.js';
import os from 'node:os';

// 실제 폴러를 한 번 돌리는 테스트가 있으므로 빈 CONFIG_DIR 로 격리한다(개발 호스트의 등록 장비에 접속하지 않게).
// 모든 모듈은 아래에서 동적 import 하므로 이 대입이 먼저다.
process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'g4cache2689-'));

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const here = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => stripComments(fs.readFileSync(path.join(here, '..', 'src', p), 'utf8'));

// ── C-01 · C-05: vGPU 사용률 캐시 ─────────────────────────────────────────────
test('C-01: 최대 나이 = max(주기 × 3, 15분)', async () => {
  const { gpuCacheMaxAgeMs, GPU_CACHE_MIN_AGE_MS } = await import('../src/vcenter/soapClient.js');
  assert.equal(GPU_CACHE_MIN_AGE_MS, 15 * MIN);
  assert.equal(gpuCacheMaxAgeMs(60_000), 15 * MIN);           // 1분 주기 → 15분 하한
  assert.equal(gpuCacheMaxAgeMs(10 * MIN), 30 * MIN);         // 10분 주기 → 30분
  assert.equal(gpuCacheMaxAgeMs(null), 15 * MIN);             // Number(null)===0 함정 — 하한
  assert.equal(gpuCacheMaxAgeMs('abc'), 15 * MIN);
});

test('C-01: 낡은 캐시는 호스트에 적용하지 않고 센다(0 으로 채우지 않는다)', async () => {
  const { applyGpuUtilCache } = await import('../src/vcenter/soapClient.js');
  const store = new Map([['vc1', new Map([
    ['host-fresh', { pct: 40, memPct: 20, memUsedKB: 2048 * 1024, tempC: 55, at: NOW - 5 * MIN }],
    ['host-old', { pct: 90, memPct: 80, memUsedKB: 1024, tempC: 70, at: NOW - 16 * MIN }],
    ['host-noat', { pct: 10, memPct: null, memUsedKB: null, tempC: null }],
    ['host-null', { pct: null, memPct: null, memUsedKB: null, tempC: null, at: NOW - MIN }],
  ])]]);
  const g = [{ mode: 'vgpu' }];
  const hosts = {
    fresh: { gpus: g }, old: { gpus: g }, noat: { gpus: g }, nul: { gpus: g },
  };
  const hostByRef = new Map([['host-fresh', hosts.fresh], ['host-old', hosts.old], ['host-noat', hosts.noat], ['host-null', hosts.nul]]);
  const r = applyGpuUtilCache('vc1', hostByRef, NOW, 60_000, store);
  assert.deepEqual(r, { applied: 2, staleExcluded: 2 });
  assert.equal(hosts.fresh.gpuUtilPct, 40);
  assert.equal(hosts.fresh.gpuMemUsedPct, 20);
  assert.equal(hosts.fresh.gpuMemUsedMB, 2048);
  assert.equal(hosts.fresh.gpuTempC, 55);
  // 16분 지난 값 · 시각 없는 값은 적용하지 않는다(값 없음).
  for (const h of [hosts.old, hosts.noat]) {
    assert.equal(h.gpuUtilPct ?? null, null);
    assert.equal(h.gpuMemUsedPct ?? null, null);
    assert.equal(h.gpuTempC ?? null, null);
  }
  // 미수집(null)은 0 이 되지 않는다.
  assert.equal(hosts.nul.gpuUtilPct ?? null, null);
  // 주기가 길면 경계도 넓다 — 10분 주기에서 16분 된 값은 아직 유효(경계 30분).
  const h2 = { gpus: g };
  const r2 = applyGpuUtilCache('vc1', new Map([['host-old', h2]]), NOW, 10 * MIN, store);
  assert.deepEqual(r2, { applied: 1, staleExcluded: 0 });
  assert.equal(h2.gpuUtilPct, 90);
});

test('C-05: vGPU 캐시는 live ref 만 남기고, 다른 vCenter 는 건드리지 않는다', async () => {
  const { pruneGpuUtilCache } = await import('../src/vcenter/soapClient.js');
  const store = new Map([
    ['vc1', new Map([['host-1', { at: NOW }], ['host-2', { at: NOW }], ['host-gone', { at: NOW }]])],
    ['vc2', new Map([['host-gone', { at: NOW }]])],
  ]);
  const removed = pruneGpuUtilCache('vc1', new Set(['host-1', 'host-2']), store);
  assert.equal(removed, 1);
  assert.deepEqual([...store.get('vc1').keys()].sort(), ['host-1', 'host-2']);   // live 는 절대 지우지 않는다
  assert.ok(store.get('vc2').has('host-gone'));                                  // 다른 vCenter 의 같은 ref 는 그대로
  // live 가 비면 그 vCenter 항목 자체를 지운다.
  assert.equal(pruneGpuUtilCache('vc1', new Set(), store), 2);
  assert.equal(store.has('vc1'), false);
  assert.equal(pruneGpuUtilCache('nope', new Set(['x']), store), 0);
});

test('C-01·C-05: 수집 경로가 정리·나이 제한 적용을 쓰고, 로그 줄 뒤에 낡은 캐시 개수를 덧붙인다', () => {
  const s = src('vcenter/soapClient.js');
  assert.match(s, /pruneGpuUtilCache\(vc\.id, new Set\(gpuRefs\)\)/);
  assert.match(s, /applyGpuUtilCache\(vc\.id, hostByRef, now, intervalMs\)/);
  // 기존 로그 문구는 그대로이고 뒤에 덧붙인다(로그 분석 카탈로그 probe 보호).
  assert.match(s, /vGPU 사용률 수집: 대상 \$\{stale\.length\} · 값 \$\{map\.size\}/);
  assert.match(s, /console\.log\(`\$\{logLine\}\$\{staleNote\}`\)/);
  assert.match(s, /낡은 캐시 제외 \$\{staleExcluded\}/);
  // 평면 키 `${vc.id}:${ref}` 로 캐시를 직접 읽고 쓰지 않는다.
  assert.doesNotMatch(s, /_gpuUtilCache\.(get|set)\(`\$\{vc\.id\}:/);
});

// ── C-06: 스토리지 영역 수집 시각 ─────────────────────────────────────────────
test('C-06: storage _areasAt — live 장비는 남기고 빠진 장비는 지운다', async () => {
  const { pruneAreasAt } = await import('../src/storage/poller.js');
  const store = new Map([['dev-a', NOW], ['dev-b', NOW - MIN], ['dev-gone', NOW]]);
  assert.equal(pruneAreasAt(new Set(['dev-a', 'dev-b']), store), 1);
  assert.deepEqual([...store.keys()].sort(), ['dev-a', 'dev-b']);
  assert.equal(pruneAreasAt(['dev-a', 'dev-b'], store), 0);   // 같은 live 로 다시 불러도 그대로
  assert.equal(store.size, 2);
  const s = src('storage/poller.js');
  // 등록부를 못 읽은 주기(빈 목록)는 정리하지 않는다.
  assert.match(s, /if \(!registryLoadError\(\)\) pruneAreasAt\(new Set\(devs\.map\(\(d\) => d\.id\)\)\)/);
});

test('C-06: storage pollStorageOnce 가 모듈 캐시를 실제로 정리한다', async () => {
  const m = await import('../src/storage/poller.js');
  const store = m._peekAreasAt();
  store.set('__g4_gone__', NOW);
  // 이 테스트 환경의 등록부에는 그 id 가 없다 → 다음 주기에 사라진다.
  await m.pollStorageOnce();
  assert.equal(store.has('__g4_gone__'), false);
});

// ── C-06: SAN 스위치 명령 조사 캐시 ───────────────────────────────────────────
test('C-06: fosSsh _caps — 키 규칙 하나 · live 는 남기고 빠진 장비·바뀐 계정은 지운다', async () => {
  const { pruneCaps, capsKeyOf } = await import('../src/sanswitch/collectors/fosSsh.js');
  assert.equal(capsKeyOf({ host: '10.0.0.1', username: 'admin' }), '10.0.0.1|admin');
  const store = new Map([
    ['10.0.0.1|admin', { at: NOW }],
    ['10.0.0.1|root', { at: NOW }],      // 계정이 바뀐 뒤 남은 옛 키
    ['10.0.0.9|admin', { at: NOW }],     // 삭제된 장비
  ]);
  const live = new Set([capsKeyOf({ host: '10.0.0.1', username: 'admin' })]);
  assert.equal(pruneCaps(live, store), 2);
  assert.deepEqual([...store.keys()], ['10.0.0.1|admin']);
  const s = src('sanswitch/poller.js');
  assert.match(s, /if \(!registryLoadError\(\)\) fosSsh\.pruneCaps\(new Set\((?:devices|allDevs)\.map\(\(d\) => fosSsh\.capsKeyOf\(d\)\)\)\)/);
  assert.match(src('sanswitch/collectors/fosSsh.js'), /probeCommands\(sh, capsKeyOf\(device\)\)/);
});

test('C-06: pollSanSwitchOnce 가 모듈 캐시를 실제로 정리한다', async () => {
  const fos = await import('../src/sanswitch/collectors/fosSsh.js');
  const p = await import('../src/sanswitch/poller.js');
  const store = fos._peekCaps();
  store.set('__g4_gone__|x', { at: NOW });
  await p.pollSanSwitchOnce({ manual: true });
  assert.equal(store.has('__g4_gone__|x'), false);
});

// ── C-07: iDRAC 센서 경로 캐시 ────────────────────────────────────────────────
test('C-07: redfish _sensorPaths — TTL 안의 live 키는 남기고, 퇴역·만료는 지운다', async () => {
  const { pruneSensorPaths, sensorPathKeyOf, sensorPathCacheInfo } = await import('../src/idrac/redfish.js');
  const ttl = sensorPathCacheInfo().ttlMs;
  const live1 = sensorPathKeyOf({ host: 'https://10.1.1.1/', username: 'Root' });
  assert.equal(live1, 'https://10.1.1.1|root');                       // fetchUsageSensors 와 같은 키(끝 슬래시 제거·소문자)
  const live2 = sensorPathKeyOf({ host: 'https://10.1.1.2', username: 'root' });
  const store = new Map([
    [live1, { urls: { cpuPct: '/x' }, seen: [], at: NOW - MIN }],
    [live2, { urls: { cpuPct: '/y' }, seen: [], at: NOW - ttl - 1 }],   // live 지만 TTL 만료(이미 무효)
    ['https://10.9.9.9|root', { absent: true, at: NOW }],               // 퇴역
  ]);
  const r = pruneSensorPaths(new Set([live1, live2]), NOW, store);
  assert.deepEqual(r, { expired: 1, retired: 1 });
  assert.deepEqual([...store.keys()], [live1]);
  // 등록부를 못 읽었으면(null) 퇴역 판정을 하지 않는다 — 만료만 지운다.
  const store2 = new Map([['https://10.9.9.9|root', { absent: true, at: NOW }], ['old|u', { at: NOW - ttl - 1 }]]);
  assert.deepEqual(pruneSensorPaths(null, NOW, store2), { expired: 1, retired: 0 });
  assert.deepEqual([...store2.keys()], ['https://10.9.9.9|root']);
  assert.match(src('idrac/redfish.js'), /const key = sensorPathKeyOf\(entry\);/);
});

test('C-07: idrac 폴러의 정리 함수가 등록부 전체를 live 로 쓰고, 빈 등록부는 퇴역 판정을 하지 않는다', async () => {
  const rf = await import('../src/idrac/redfish.js');
  const { pruneSensorPathCache } = await import('../src/idrac/poller.js');
  rf._resetSensorPathsForTest();
  try {
    const store = rf._peekSensorPaths();
    const now = Date.now();   // 모듈 캐시의 at 은 실제 시각이라 같은 시계로 넣는다(경계와 무관한 상대 비교만 한다)
    const kA = rf.sensorPathKeyOf({ host: 'https://a', username: 'u' });
    const kDisabled = rf.sensorPathKeyOf({ host: 'https://b', username: 'u' });
    store.set(kA, { urls: {}, seen: [], at: now });
    store.set(kDisabled, { urls: {}, seen: [], at: now });
    store.set('https://gone|u', { urls: {}, seen: [], at: now });
    // 빈 등록부 — 못 읽었을 수도 있으니 아무것도 퇴역시키지 않는다.
    assert.deepEqual(pruneSensorPathCache([], now), { expired: 0, retired: 0 });
    assert.equal(store.size, 3);
    const reg = [{ host: 'https://a', username: 'u' }, { host: 'https://b/', username: 'U', enabled: false }];
    assert.deepEqual(pruneSensorPathCache(reg, now), { expired: 0, retired: 1 });
    assert.deepEqual([...store.keys()].sort(), [kA, kDisabled].sort());   // 비활성 서버도 live — 지우지 않는 쪽
    const s = src('idrac/poller.js');
    assert.match(s, /Date\.now\(\) - _sensorPathPruneAt >= INVENTORY_MAX_AGE_MS/);
    assert.match(s, /pruneSensorPathCache\(registry\)/);
  } finally { rf._resetSensorPathsForTest(); }
});
