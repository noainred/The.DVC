/**
 * v2.682 3회차 점검 — 그룹 C(bmusage/corpusage · curuser · SAN 트래픽 · 스토리지 증가량 공개 API).
 *
 *  R3S-01 엣지 사용률 행은 담당 엣지일 때만 · 미래 ts 는 '신선' 이 아니다 · 수신 시각 clamp
 *  R3E-06 배포 인출 기록 Map 키·값 길이(capStr — SlicedString 원문 보유 방지)
 *  R3A-03 같은 사유로 연속 N주기 실패한 VM 은 추이 부분 합 판정에서 뺀다(개수는 밝힌다)
 *  R3A-02 등록·사용 중 스위치가 보고를 멈추면 그 시리즈를 '없어진 것' 으로 빼지 않는다(heldSeries) · 응답에 retiredSeries
 *  R3A-07 공개 API storage-growth 행 단위 excludedFromTotals · meta 기준 명시
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2682c-'));
process.env.CONFIG_DIR = process.env.CONFIG_DIR || path.join(tmp, 'config');
fs.mkdirSync(process.env.CONFIG_DIR, { recursive: true });

const { buildCorpUsage, judgeServer, ownedRowOf, FUTURE_SKEW_MS } = await import('../src/corpusage/build.js');
const { rowsByAgentKeyOf, mergeLatestRows, clampEdgeTs } = await import('../src/routes/api/corpUsage.js');
const settings = await import('../src/bmusage/settings.js');
const { aggregateAll, seriesRow, advanceFailState, persistentFailKeys, PERSISTENT_FAIL_CYCLES } = await import('../src/curuser/aggregate.js');
const { sumArrayTraffic } = await import('../src/sanswitch/trafficTotal.js');
const { ENDPOINT_BY_PATH } = await import('../src/publicapi/allowlist.js');

const SRC = path.resolve(import.meta.dirname, '../src');
const NOW = Math.floor(Date.UTC(2026, 9, 1) / 3_600_000) * 3_600_000 - 30 * 60_000;
const FRESH = 30 * 60_000;
const VCS = [{ id: 'vcA', name: 'Corp A' }];

/* ── R3S-01 ─────────────────────────────────────────────────────────────── */

test('R3S-01 ① 중앙 직접 수집 서버의 값을 남의 엣지 행(미래 ts)이 덮지 못한다', () => {
  const central = [{ key: 'TAG-A1', ts: NOW - 60_000, cpu_pct: 10, mem_pct: 20, src: 'idrac' }];
  const edgeRows = [{ key: 'TAG-A1', ts: NOW + 365 * 86_400_000, cpu_pct: 99, mem_pct: 99, src: 'idrac', _agent: 'edge-evil', _freshMs: FRESH }];
  const out = buildCorpUsage({
    vcenters: VCS,
    bareMetal: [{ vcenterId: 'vcA', serviceTag: 'TAG-A1', serverId: 'srv1', name: 's1' }],   // remoteAgent 없음 = 중앙 직접
    rowsByKey: mergeLatestRows(central), rowsByAgentKey: rowsByAgentKeyOf(edgeRows),
    capOf: () => ({ cores: 10, memGB: 100 }), now: NOW, freshMs: FRESH,
  });
  assert.equal(out.totals.all.bm.cpu.pct, 10, '중앙 행이어야 한다');
  // 예전처럼 엣지 행이 rowsByKey 로 섞여 들어와도 담당이 아니면 쓰지 않는다.
  //   (미래 ts 가 아니라 정상 시각이어도 — 담당 판정이 신선도 판정과 별개로 막아야 한다)
  const edgeNow = [{ ...edgeRows[0], ts: NOW - 1_000 }];
  for (const p of [{ rowsByKey: mergeLatestRows(central, edgeNow) }, { rowsByKey: mergeLatestRows(central), rowsByAgentKey: rowsByAgentKeyOf(edgeNow) }]) {
    const out2 = buildCorpUsage({
      vcenters: VCS, bareMetal: [{ vcenterId: 'vcA', serviceTag: 'TAG-A1', serverId: 'srv1', name: 's1' }],
      ...p, capOf: () => ({ cores: 10, memGB: 100 }), now: NOW, freshMs: FRESH,
    });
    assert.notEqual(out2.totals.all.bm.cpu.pct, 99, '담당 아닌 엣지 행을 쓰면 안 된다');
  }
});

test('R3S-01 ② 담당 엣지(remoteAgent·site vCenter collectedBy)의 행은 쓴다 — 더 최신이면 중앙 행보다 우선', () => {
  const central = [{ key: 'TAG-B1', ts: NOW - 20 * 60_000, cpu_pct: 10, mem_pct: 10, src: 'idrac' }];
  const edgeRows = [{ key: 'tag-b1', ts: NOW - 60_000, cpu_pct: 40, mem_pct: 40, src: 'idrac', _agent: 'Edge-Seoul', _freshMs: FRESH }];
  const p = { vcenters: VCS, rowsByKey: mergeLatestRows(central), rowsByAgentKey: rowsByAgentKeyOf(edgeRows), capOf: () => ({ cores: 10, memGB: 100 }), now: NOW, freshMs: FRESH };
  const bm = buildCorpUsage({ ...p, bareMetal: [{ vcenterId: 'vcA', serviceTag: 'TAG-B1', serverId: 'edge:x', name: 'b', remoteAgent: 'edge-seoul' }] });
  assert.equal(bm.totals.all.bm.cpu.pct, 40);
  const virt = buildCorpUsage({ ...p, virtHosts: [{ vcenterId: 'vcA', name: 'esx1', serviceTag: 'TAG-B1', cpuCores: 10, memGB: 100 }], vcOwner: new Map([['vcA', 'Edge-Seoul']]) });
  assert.equal(virt.totals.all.virt.cpu.pct, 40);
  const virtOther = buildCorpUsage({ ...p, virtHosts: [{ vcenterId: 'vcA', name: 'esx1', serviceTag: 'TAG-B1', cpuCores: 10, memGB: 100 }], vcOwner: new Map([['vcA', 'Edge-Busan']]) });
  assert.equal(virtOther.totals.all.virt.cpu.pct, 10, '다른 엣지가 담당이면 중앙 행');
  assert.equal(ownedRowOf('TAG-B1', '', mergeLatestRows(central), rowsByAgentKeyOf(edgeRows)).cpu_pct, 10);
});

test('R3S-01 ③ 미래 ts 는 신선하지 않다 · 엣지 행 ts 는 수신 시각으로 clamp', () => {
  const j = judgeServer({ role: 'bm', row: { ts: NOW + FUTURE_SKEW_MS + 60_000, cpu_pct: 50 }, now: NOW, freshMs: FRESH });
  assert.equal(j.state, 'stale');
  const ok = judgeServer({ role: 'bm', row: { ts: NOW + 60_000, cpu_pct: 50 }, now: NOW, freshMs: FRESH });
  assert.equal(ok.state, 'ok', '작은 시계 오차는 허용');
  assert.equal(clampEdgeTs(NOW + 1e10, NOW), NOW);
  assert.equal(clampEdgeTs(NOW - 5, NOW), NOW - 5);
  assert.equal(clampEdgeTs(null, NOW), null);
  assert.equal(clampEdgeTs(NOW + 5, null), NOW + 5);
  const route = fs.readFileSync(path.join(SRC, 'routes/api/corpUsage.js'), 'utf8');
  assert.match(route, /ts:\s*clampEdgeTs\(r\.ts,\s*at\)/, '라우트가 엣지 행을 clamp 해야 한다');
  assert.match(route, /mergeLatestRows\(central\)/, '엣지 행을 key 하나로 합치지 않는다');
});

/* ── R3E-06 ─────────────────────────────────────────────────────────────── */

test('R3E-06 인출 기록은 거대 이름 원문을 붙잡지 않는다', () => {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  settings._resetForTest();
  gc(); gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 20; i++) {
    const big = `agent-${i}-` + 'x'.repeat(2_000_000);
    settings.recordBmUsagePull(big, { appliedSig: 's' + 'y'.repeat(100), reason: 'r'.repeat(50), now: NOW + i });
  }
  gc(); gc();
  const grew = process.memoryUsage().heapUsed - before;
  assert.ok(grew < 12 * 1024 * 1024, `힙 증가 ${(grew / 1048576).toFixed(1)}MB — 원문이 붙잡혀 있다`);
  const rows = settings.distributionStatus([]).rows;
  assert.ok(rows.length >= 1);
  for (const r of rows) assert.ok(String(r.agent).length <= 128);
  settings._resetForTest();
});

/* ── R3A-03 ─────────────────────────────────────────────────────────────── */

function recs(failKind = 'guest-error') {
  const out = [];
  for (let i = 0; i < 40; i++) out.push({ vmId: `vm-${i}`, vcenterId: 'vcA', ok: true, users: [{ name: `u${i}`, kind: 'active' }] });
  out.push({ vmId: 'vm-core', vcenterId: 'vcA', ok: false, kind: failKind });
  return out;
}

test('R3A-03 ① 같은 사유로 연속 N주기 실패하면 추이 부분 합 판정에서 빠진다(개수는 밝힌다)', () => {
  let st = new Map();
  for (let c = 1; c <= PERSISTENT_FAIL_CYCLES; c++) {
    st = advanceFailState(recs(), st);
    const agg = aggregateAll(recs(), { persistent: persistentFailKeys(recs(), st) });
    const row = seriesRow(agg.total);
    const vrow = seriesRow(agg.vcenters[0]);
    if (c < PERSISTENT_FAIL_CYCLES) {
      assert.equal(row.partial, true, `주기 ${c}: 막 실패한 VM 은 아직 일시 실패`);
      assert.equal(row.users, null);
    } else {
      assert.equal(row.partial, false, '영구 실패 VM 1대가 전체 추이를 영원히 비우면 안 된다');
      assert.equal(row.users, 40);
      assert.equal(vrow.users, 40);
      assert.equal(agg.total.vmsPersistent, 1);
      assert.equal(agg.total.vmsTransient, 0);
      assert.equal(agg.total.vmsFailed, 1);
    }
  }
});

test('R3A-03 ② 사유가 바뀌거나 한 번 읽히면 처음부터 · 영구 집합이 없으면 예전 판정', () => {
  let st = new Map();
  st = advanceFailState(recs('stale'), st);
  st = advanceFailState(recs('stale'), st);
  st = advanceFailState(recs('clock-skew'), st);   // 사유 변경 → 1
  assert.equal(persistentFailKeys(recs('clock-skew'), st).size, 0);
  const okAll = recs().map((r) => (r.vmId === 'vm-core' ? { ...r, ok: true, users: [] } : r));
  st = advanceFailState(okAll, st);
  assert.equal(st.size, 0, '읽히면 카운터가 사라진다');
  const agg = aggregateAll(recs());
  assert.equal(seriesRow(agg.total).partial, true, '옵션이 없으면 예전처럼 부분 합');
  // no-agent 는 원래 대상 아님(카운터에 넣지 않는다)
  assert.equal(advanceFailState(recs('no-agent'), new Map()).size, 0);
});

test('R3A-03 ③ poller 는 주 수집 주기에서만 카운터를 진행하고 결과에 개수를 싣는다', () => {
  const src = fs.readFileSync(path.join(SRC, 'curuser/poller.js'), 'utf8');
  assert.match(src, /writeSeries\(ts, s, vcNameOf, \{ advance: true \}\)/);
  assert.match(src, /persistentFailKeys\(all, _failState\)/);
  assert.match(src, /persistentFailures: ser\.persistentFailures/);
});

/* ── R3A-02 ─────────────────────────────────────────────────────────────── */

function trafficAgg() {
  const B = 60_000; const n = 90;
  const buckets = Array.from({ length: n }, (_, i) => NOW - (n - 1 - i) * B);
  const a = buckets.map(() => 100);
  const b = buckets.map((_, i) => (i < 30 ? 50 : null));   // 30분 뒤 멈춤
  return {
    agg: { buckets, bucketMs: B, series: [
      { key: 'ARR-A::x', group: 'g', deviceIds: ['d1'], sum: a, partial: [] },
      { key: 'ARR-B::y', group: 'g', deviceIds: ['d2'], sum: b, partial: [] },
    ] },
    stopTs: buckets[29], lastTs: buckets[n - 1],
  };
}

test('R3A-02 ① 등록·사용 중 스위치가 멈추면 시리즈를 퇴역시키지 않는다 — 마지막 버킷은 null', () => {
  const { agg, stopTs, lastTs } = trafficAgg();
  const t = sumArrayTraffic(agg, { carryMs: 2 * 60_000, activeDeviceIds: new Set(['d1', 'd2']), deviceLastTs: new Map([['d1', lastTs], ['d2', stopTs]]) });
  assert.equal(t.total[t.total.length - 1], null, '남은 시리즈만의 값을 온전한 합처럼 내면 안 된다');
  assert.equal(t.retiredSeries, 0);
  assert.equal(t.heldSeries, 1);
});

test('R3A-02 ② 장비는 다른 포트로 보고 중이면 예전처럼 퇴역 · 옵션 없으면 예전 동작', () => {
  const { agg, lastTs } = trafficAgg();
  const t = sumArrayTraffic(agg, { carryMs: 2 * 60_000, activeDeviceIds: new Set(['d1', 'd2']), deviceLastTs: new Map([['d1', lastTs], ['d2', lastTs]]) });
  assert.equal(t.total[t.total.length - 1], 100);
  assert.equal(t.retiredSeries, 1);
  assert.equal(t.heldSeries, 0);
  const old = sumArrayTraffic(agg, { carryMs: 2 * 60_000 });
  assert.equal(old.retiredSeries, 1);
  // 등록부에 없는 장비(비활성·삭제)는 퇴역 가능
  const t2 = sumArrayTraffic(agg, { carryMs: 2 * 60_000, activeDeviceIds: new Set(['d1']), deviceLastTs: new Map([['d1', lastTs]]) });
  assert.equal(t2.retiredSeries, 1);
});

test('R3A-02 ③ 라우트가 retiredSeries·heldSeries 를 싣는다', () => {
  const src = fs.readFileSync(path.join(SRC, 'routes/api/sanSwitch.js'), 'utf8');
  assert.match(src, /retiredSeries: t\.retiredSeries \?\? 0, heldSeries: t\.heldSeries \?\? 0/);
  assert.match(src, /activeDeviceIds: new Set\(ids\.map\(String\)\), deviceLastTs: lastTs/);
});

/* ── R3A-07 ─────────────────────────────────────────────────────────────── */

test('R3A-07 공개 API storage-growth — 행 단위 excludedFromTotals · meta 기준 명시 · 문서', () => {
  assert.ok(ENDPOINT_BY_PATH['/capacity/storage-growth'].fields.includes('excludedFromTotals'));
  const src = fs.readFileSync(path.join(SRC, 'routes/publicApi.js'), 'utf8');
  assert.match(src, /return d\.retired \? 'retired' : \(d\.stale \? 'stale' : null\)/);
  assert.match(src, /excludedFromTotals: excludedFromTotalsOf\(d\)/);
  assert.match(src, /\.\.\.storageGrowthCounts\(out, m, knownIds\)/);
  assert.match(src, /unknownUsedRows: out\.filter\(\(r\) => r\.unknownUsed\)\.length/);
  assert.match(src, /countsBasis: 'totals'/);
  const doc = fs.readFileSync(path.resolve(SRC, '../../docs/API-PUBLIC.md'), 'utf8');
  assert.match(doc, /excludedFromTotals/);
  assert.match(doc, /unknownUsedRows/);
});
