/**
 * audit2629d.test.js — v2.629 감사 그룹 d(법인별 사용량 · 배포 인출 기록 · 상태 범위 가림 · vmperf LRU).
 *
 *  ① A1-2629-01: 서비스태그가 같은 가상화 호스트를 두 vCenter 에서 만나면 한 대로 센다(연결된 쪽 · 뺀 수 dupSameBox)
 *                 · 이름 키 충돌은 예전처럼 keyConflict(두 대)
 *  ② A1-2629-03: 일부 지표를 vCenter 값으로 채운 서버를 filledCpu·filledMem 으로 센다
 *  ③ A6-03:      서비스태그 없는 엣지 물리 서버를 `에이전트|fleetId` 로 찾는다(다른 엣지의 같은 fleetId 는 섞지 않는다)
 *  ④ A1-2629-04: 검증 인출 기록은 1시간 안에는 미검증이 덮지 못하고, 넘으면 덮는다(lapsedVerifiedAt)
 *  ⑤ A6-04·A6-05: 범위 계정에는 샘플러·베어메탈 폴러 상태의 전 함대 개수를 null 로(fleetCountsHidden)
 *  ⑥ A6-08: prune 중(busy) 인 vmperf 핸들은 LRU 가 닫지 않는다
 * 기준 시각은 고정값(Date.now() 를 기준으로 쓰지 않는다 — CLAUDE.md v2.517).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2629d-'));
process.env.CONFIG_DIR = process.env.CONFIG_DIR || path.join(tmp, 'config');
fs.mkdirSync(process.env.CONFIG_DIR, { recursive: true });
process.env.VMPERF_DB_DIR = path.join(tmp, 'vmperf');
process.env.VMPERF_MAX_OPEN_DB = '2';

const { buildCorpUsage } = await import('../src/corpusage/build.js');
const { rowsByAgentKeyOf } = await import('../src/routes/api/corpUsage.js');
const settings = await import('../src/bmusage/settings.js');

const NOW = 1_800_000_000_000;
const FRESH = 30 * 60_000;
const VCS = [{ id: 'vcA', name: 'Alpha' }, { id: 'vcB', name: 'Beta' }];

test('① 서비스태그가 같은 호스트는 한 대 — 연결된 쪽을 남기고 뺀 수를 밝힌다', () => {
  const virtHosts = [
    // 옛 vCenter(끊김)가 먼저 나와도 연결된 쪽을 남긴다(반복 순서 의존 제거)
    { name: 'esx01', vcenterId: 'vcB', serviceTag: 'ABC1234', fleetId: 'abc1234', cpuCores: 32, memGB: 512 },
    { name: 'esx01', vcenterId: 'vcA', serviceTag: 'ABC1234', fleetId: 'abc1234', cpuCores: 32, memGB: 512 },
  ];
  const hostByKey = new Map([
    ['vcA|esx01', { connectionState: 'CONNECTED', cpuUsagePct: 50, memUsagePct: 40 }],
    ['vcB|esx01', { connectionState: 'DISCONNECTED' }],
  ]);
  const rowsByKey = new Map([['ABC1234', { key: 'ABC1234', ts: NOW - 60_000, cpu_pct: 70, mem_pct: 60, src: 'idrac' }]]);
  const out = buildCorpUsage({ vcenters: VCS, virtHosts, hostByKey, rowsByKey, now: NOW, freshMs: FRESH });
  const all = out.totals.all.virt;
  assert.equal(all.servers, 1, '같은 박스를 두 번 세지 않는다');
  assert.equal(all.capCores, 32);
  assert.equal(all.dupSameBox, 1, '뺀 중복은 개수로 밝힌다');
  assert.equal(all.keyConflict, 0);
  const a = out.corps.find((c) => c.vcenterId === 'vcA').virt;
  assert.equal(a.servers, 1, '연결된 vCenter 쪽이 남는다');
  assert.equal(a.cpu.pct, 70, 'iDRAC 행은 남긴 쪽에 붙는다');
  const b = out.corps.find((c) => c.vcenterId === 'vcB').virt;
  assert.equal(b.servers, 0); assert.equal(b.dupSameBox, 1);
});

test('① 이름 키 충돌(서비스태그 없음)은 다른 서버 — 예전처럼 둘 다 세고 keyConflict', () => {
  const virtHosts = [
    { name: 'esxi-01', fleetId: 'esxi-01', vcenterId: 'vcA', cpuCores: 16, memGB: 256 },
    { name: 'esxi-01', fleetId: 'esxi-01', vcenterId: 'vcB', cpuCores: 16, memGB: 256 },
  ];
  const out = buildCorpUsage({ vcenters: VCS, virtHosts, now: NOW, freshMs: FRESH });
  assert.equal(out.totals.all.virt.servers, 2);
  assert.equal(out.totals.all.virt.keyConflict, 1);
  assert.equal(out.totals.all.virt.dupSameBox, 0);
});

test('② vCenter 로 채운 지표를 filledCpu·filledMem 으로 센다', () => {
  const virtHosts = [{ name: 'esx9', vcenterId: 'vcA', serviceTag: 'Z9', fleetId: 'z9', cpuCores: 10, memGB: 100 }];
  const hostByKey = new Map([['vcA|esx9', { connectionState: 'CONNECTED', cpuUsagePct: 20, memUsagePct: 40 }]]);
  const rowsByKey = new Map([['Z9', { key: 'Z9', ts: NOW - 1000, cpu_pct: 50, src: 'idrac' }]]);
  const v = buildCorpUsage({ vcenters: VCS, virtHosts, hostByKey, rowsByKey, now: NOW, freshMs: FRESH }).totals.all.virt;
  assert.equal(v.src.idrac, 1);
  assert.equal(v.filledMem, 1, '메모리는 vCenter 값');
  assert.equal(v.filledCpu, 0);
  assert.equal(v.mem.pct, 40);
});

test('③ 서비스태그 없는 엣지 물리 서버는 에이전트|fleetId 로 찾는다', () => {
  const bareMetal = [
    { serverId: 'edge:Edge-Seoul:idrac-7', fleetId: 'edge:edge-seoul:idrac-7', name: 'bm7', serviceTag: '', vcenterId: 'vcA', remoteAgent: 'Edge-Seoul', source: 'edge' },
  ];
  const edgeRows = [
    { key: 'idrac-7', ts: NOW - 1000, cpu_pct: 30, mem_pct: 20, src: 'idrac', _agent: 'Edge-Seoul' },
    { key: 'idrac-7', ts: NOW - 500, cpu_pct: 99, mem_pct: 99, src: 'idrac', _agent: 'Edge-Busan' },   // 다른 엣지 — 섞이면 안 된다
  ];
  const out = buildCorpUsage({
    vcenters: VCS, bareMetal, rowsByAgentKey: rowsByAgentKeyOf(edgeRows),
    capOf: () => ({ cores: 8, memGB: 64 }), now: NOW, freshMs: FRESH,
  });
  const bm = out.totals.all.bm;
  assert.equal(bm.unread, 0, '예전엔 늘 못 읽음이었다');
  assert.equal(bm.cpu.pct, 30, '그 엣지의 행');
  // 맵이 없으면(예전 동작) 못 읽음
  const old = buildCorpUsage({ vcenters: VCS, bareMetal, capOf: () => ({ cores: 8, memGB: 64 }), now: NOW, freshMs: FRESH });
  assert.equal(old.totals.all.bm.unread, 1);
});

test('④ 검증 기록은 1시간 안에는 미검증이 덮지 못하고, 넘으면 덮는다', () => {
  settings._resetForTest();
  settings.recordBmUsagePull('Edge-A', { appliedSig: 's1', verified: true, now: NOW });
  settings.recordBmUsagePull('Edge-A', { appliedSig: 's2', verified: false, now: NOW + 10 * 60_000 });
  let row = settings.distributionStatus(['Edge-A']).rows.find((r) => r.agent === 'Edge-A');
  assert.equal(row.appliedSig, 's1'); assert.equal(row.verified, true);
  settings.recordBmUsagePull('Edge-A', { appliedSig: 's2', verified: false, now: NOW + settings.VERIFIED_HOLD_MS + 60_000 });
  row = settings.distributionStatus(['Edge-A']).rows.find((r) => r.agent === 'Edge-A');
  assert.equal(row.appliedSig, 's2', '오래된 검증 기록은 미검증 인출이 덮는다');
  assert.equal(row.verified, false, '덮은 기록은 미검증으로 표시');
  assert.equal(row.lapsedVerifiedAt, NOW, '옛 검증 시각을 남긴다');
  settings._resetForTest();
});

test('⑤ 범위 계정에는 샘플러·폴러 상태의 함대 개수를 싣지 않는다', async () => {
  const { scopeSamplerStatus } = await import('../src/routes/admin/gpuGuest.js');
  const st = { intervalMs: 60_000, retentionDays: 30, lastRun: { at: NOW, rows: 900, hostsWithTemp: 40, staleSkipped: { vcenters: 3 }, vmperfStale: { totalWithheld: true } } };
  const allowed = new Set(['vcA']);
  const s = scopeSamplerStatus(st, allowed);
  assert.deepEqual(s.lastRun, { at: NOW, rows: null, hostsWithTemp: null });
  assert.equal(s.fleetCountsHidden, true);
  assert.equal(s.intervalMs, 60_000);
  assert.equal(scopeSamplerStatus(st, null), st, '전체 범위는 원본');

  const { scopeBmStatus } = await import('../src/routes/api/bmUsage.js');
  const bst = { enabled: true, intervalMs: 300_000, authStopCount: 4, entDeferred: 2, prevKeys: 50, alertState: { tracked: 3, notified: 1 },
    last: { at: NOW, ms: 1200, trigger: 'timer', servers: 120, okCount: 100, failCount: 20, inserted: 100, sourceErrors: ['x'], ent: { tried: 3 } } };
  const b = scopeBmStatus(bst, allowed);
  assert.equal(b.fleetCountsHidden, true);
  assert.deepEqual(b.last, { at: NOW, ms: 1200, trigger: 'timer', servers: null, okCount: null, failCount: null, inserted: null });
  for (const k of ['authStopCount', 'entDeferred', 'prevKeys', 'alertState']) assert.equal(b[k], null, k);
  assert.equal(b.intervalMs, 300_000);
  assert.equal(scopeBmStatus(bst, null), bst);
});

test('⑥ prune 중인 vmperf 핸들은 LRU 가 닫지 않는다', { skip: await import('node:sqlite').then(() => false).catch(() => 'node:sqlite 미지원') }, async () => {
  const db = await import('../src/metrics/vmperfDb.js');
  const open = db._openForTest();
  const a = await db.getVmperfDb('vc-a');
  let release = false; let calls = 0;
  const realPrune = a.st.prune; const realHourly = a.st.pruneHourly;
  // 청크를 계속 '가득' 돌려 prune 이 양보하며 머물게 한다(release 뒤 0).
  a.st.prune = { run: (...args) => { calls += 1; return { changes: release ? 0 : args[args.length - 1] }; } };
  a.st.pruneHourly = { run: () => ({ changes: 0 }) };
  const p = db.pruneVmperf('vc-a', 1);
  while (calls < 2) await new Promise((r) => setImmediate(r));
  await db.getVmperfDb('vc-b');
  await db.getVmperfDb('vc-c');   // 상한 2 초과 — 가장 오래된 vc-a 는 사용 중이라 건너뛴다
  assert.ok(open.has(db.dbFileName('vc-a')), 'prune 중인 핸들을 닫으면 안 된다');
  assert.ok(!open.has(db.dbFileName('vc-b')), '사용 중이 아닌 가장 오래된 핸들을 닫는다');
  release = true;
  await p;
  a.st.prune = realPrune; a.st.pruneHourly = realHourly;
  assert.equal(a.busy, 0);
  db.evictIfNeeded();
  assert.ok(open.size <= 2, '사용이 끝나면 상한으로 돌아온다');
});
