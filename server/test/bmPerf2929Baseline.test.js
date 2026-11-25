/**
 * v2.929(리눅스 성능 5단계) — 베이스라인 이탈(지난 N주 같은 요일 · 시각 1시간 롤업 평균 ± 띠) · 구간 비교(A/B — 같은 길이 · 같은 롤업 · 결측 양쪽 제외).
 *   ① 4주 미만 · 결측 많음 → 띠 없음(reason) ② 평균 0 이면 배수 null(0 으로 나누지 않는다) ③ 요청 경로 블로킹 없음(시간 기준 양보 · 10분 메모)
 *   ④ 슬롯 평균은 시간당 한 번(실제 시간 단위 파일 · h IN 한 문장) ⑤ 비교: 길이 맞춤 · 거친 해상도 · 결측 제외 수 · 차이 % · ±diffPct 표시 · 프로세스는 스냅샷 있을 때만
 * 기준 시각: 정시 −30분(v2.517 규약).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm2929bl-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = '';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HOUR = 3_600_000; const WEEK = 7 * 86_400_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }

const B = await import('../src/bmusage/baseline.js');
const CMP = await import('../src/bmusage/compare.js');
const CFG = { bandPct: 40, minWeeks: 4, maxMissingPct: 25, weeks: 4, expectedPerHour: 12 };

test('① 띠 — 같은 요일 · 시각(정확히 7일 배수) · 4주 미만이면 없음 · 결측 많으면 없음 · ±40%', () => {
  const hs = B.slotHours(NOW, 4);
  assert.deepEqual(hs, [1, 2, 3, 4].map((i) => B.hourStart(NOW) - i * WEEK));
  const full = (avg) => hs.map((h) => ({ h, avg, samples: 12 }));
  const b = B.bandOf(full(10), CFG);
  assert.deepEqual([b.mean, b.lo, b.hi, b.weeks], [10, 6, 14, 4]);
  assert.equal(B.bandOf(full(10).slice(0, 3), CFG).reason, 'few-weeks', '3주 = 띠 없음');
  assert.equal(B.bandOf([], CFG).reason, 'no-history');
  const thin = hs.map((h, i) => ({ h, avg: 10, samples: i === 0 ? 3 : 12 }));
  assert.equal(B.bandOf(thin, CFG).reason, 'few-weeks', '그 시간 표본이 절반 미만이면 그 주는 결측');
  const holes = hs.map((h) => ({ h, avg: 10, samples: 8 }));
  assert.equal(B.bandOf(holes, { ...CFG, maxMissingPct: 25 }).reason, 'missing', '결측 33% > 25%');
  // ② 이탈 배수
  assert.deepEqual(B.deviationOf(29, b), { value: 29, ratio: 2.9, out: 'above', mean: 10, lo: 6, hi: 14 });
  assert.equal(B.deviationOf(9, b).out, 'in');
  assert.equal(B.deviationOf(null, b), null, '못 읽음 = 판정 없음');
  assert.equal(B.deviationOf(5, { mean: 0, lo: 0, hi: 0 }).ratio, null, '평균 0 이면 배수 null');
  assert.equal(B.deviationOf(5, { reason: 'few-weeks' }), null);
});

test('③ 띠 계열 — 시간 수만큼 돌며 시간 기준 양보 · 10분 메모 · 지표 화이트리스트 · 최대 14일', async () => {
  B._resetBaselineForTest();
  let reads = 0;
  const rows = [];
  for (let w = 1; w <= 6; w++) for (let h = 0; h < 30 * 24; h++) rows.push({ h: B.hourStart(NOW) - w * WEEK - h * HOUR, cpu_sum: 12 * 20, cpu_n: 12 });
  const deps = { readHourlyRange: async () => { reads += 1; return { rows, missingPeriods: [] }; } };
  const r = await B.readBandSeries({ key: 'S1', metric: 'cpu_pct', from: NOW - 3 * 86_400_000, to: NOW, cfg: CFG, now: NOW, deps });
  assert.equal(r.ok, true); assert.ok(r.series.length >= 72);
  assert.ok(r.series.every((x) => x.mean === 20 && x.lo === 12 && x.hi === 28), '같은 요일 · 시각 평균 20 · ±40%');
  const again = await B.readBandSeries({ key: 'S1', metric: 'cpu_pct', from: NOW - 3 * 86_400_000, to: NOW, cfg: CFG, now: NOW + 60_000, deps });
  assert.equal(again.cached, true); assert.equal(reads, 1, '10분 메모');
  assert.equal((await B.readBandSeries({ key: 'S1', metric: 'evil; drop', cfg: CFG, now: NOW, deps })).__status, 400);
  const long = await B.readBandSeries({ key: 'S2', metric: 'cpu_pct', from: NOW - 60 * 86_400_000, to: NOW, cfg: CFG, now: NOW, deps });
  assert.equal(long.capped, true); assert.ok(long.to - long.from <= B.BAND_MAX_SPAN_MS);
  // 양보 — 띠 계산 중 이벤트 루프가 다른 일을 한다(setImmediate 가 끼어든다)
  let ticks = 0; const iv = setInterval(() => { ticks += 1; }, 0);
  const slow = async () => { const t0 = performance.now(); while (performance.now() - t0 < 2) { /* 바쁜 시간 흉내 */ } };
  await B.bandSeries(new Map(), { from: NOW - 14 * 86_400_000, to: NOW, cfg: CFG, yieldFn: async () => { await slow(); await new Promise((res) => setImmediate(res)); } });
  clearInterval(iv);
  assert.ok(ticks > 0, '요청 경로를 막지 않는다(양보 지점이 있다)');
});

test('④ 슬롯 평균 — 실제 시간 단위 파일(1시간 롤업)에서 시간당 한 번 · 서버별 · 지표별 · 띠 없는 서버는 reason', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  B._resetBaselineForTest();
  const M = await import('../src/bmusage/monthStore.js');
  const rows = [];
  for (const h of B.slotHours(NOW, 4)) {
    for (let i = 0; i < 12; i++) rows.push({ key: 'S1', ts: h + i * 300_000, name: 's1', vcenter_id: 'vcA', cpu_pct: 20, mem_pct: 50, disk_busy_pct: 10, net_pct: 5 });
  }
  for (const h of B.slotHours(NOW, 4).slice(0, 2)) for (let i = 0; i < 12; i++) rows.push({ key: 'S2', ts: h + i * 300_000, cpu_pct: 30 });
  const w = await M.writeServerRows(rows, '');
  assert.equal(w.ok !== false, true, JSON.stringify(w));
  const bands = await B.slotBands({ agent: '', cfg: CFG, intervalMs: 300_000, now: NOW });
  const s1 = bands.get('S1');
  assert.equal(s1.get('cpu_pct').mean, 20); assert.equal(s1.get('cpu_pct').weeks, 4);
  assert.equal(bands.get('S2').get('cpu_pct').reason, 'few-weeks', '2주뿐 — 띠 없음 · 규칙 안 걸림');
  const dev = B.deviationsFor(bands, 'S1', { cpu_pct: 58, mem_pct: 50, disk_busy_pct: null });
  assert.equal(dev.cpu_pct.out, 'above'); assert.equal(dev.cpu_pct.ratio, 2.9); assert.equal(dev.mem_pct.out, 'in'); assert.equal(dev.disk_busy_pct, null);
  assert.equal(B.deviationsFor(bands, 'NONE', {}).cpu_pct.reason, 'no-history');
  // 같은 시간 안 — 다시 읽지 않는다(캐시)
  assert.equal(await B.slotBands({ agent: '', cfg: CFG, intervalMs: 300_000, now: NOW + 60_000 }), bands);
});

test('⑤ 구간 비교 — 같은 길이(짧은 쪽) · 거친 해상도 · 결측 양쪽 제외 · 차이 % · ±20% 표시 · A=0 이면 null', async () => {
  const p = CMP.normalizePair({ aFrom: NOW - 2 * 86_400_000, aTo: NOW - 2 * 86_400_000 + HOUR, bFrom: NOW - HOUR * 2, bTo: NOW }, NOW);
  assert.equal(p.len, HOUR); assert.equal(p.lengthAdjusted, true, '길이가 다르면 짧은 쪽에 맞추고 밝힌다');
  assert.ok(CMP.normalizePair({ aFrom: 1 }).error);
  const step = 300_000; const slots = 12;
  const pts = (from, vals) => vals.map((v, i) => ({ t: from + i * step, avg: v, max: v, peak: v == null ? null : v + 1 }));
  const A = pts(0, [10, 10, null, 10, 10, 10, 10, 10, 10, 10, 10, 10]);
  const Bp = pts(1_000_000, [20, 20, 20, null, 20, 20, 20, 20, 20, 20, 20, 20]);
  const m = CMP.compareMetric(A, Bp, { fromA: 0, fromB: 1_000_000, stepMs: step, slots, diffPct: 20 });
  assert.equal(m.pairs, 10); assert.equal(m.excluded, 2, '어느 한쪽이라도 결측인 칸은 양쪽에서 뺀다');
  assert.equal(m.missingA, 1); assert.equal(m.missingB, 1);
  assert.equal(m.a.avg, 10); assert.equal(m.b.avg, 20); assert.equal(m.diffAvgPct, 100); assert.equal(m.out.avg, true);
  assert.equal(CMP.compareMetric(pts(0, [0, 0]), pts(1_000_000, [5, 5]), { fromA: 0, fromB: 1_000_000, stepMs: step, slots: 2 }).diffAvgPct, null, 'A=0 → null');
  const near = CMP.compareMetric(pts(0, [10, 10]), pts(1_000_000, [11, 11]), { fromA: 0, fromB: 1_000_000, stepMs: step, slots: 2, diffPct: 20 });
  assert.equal(near.out.avg, false, '±20% 안');
  // 프로세스 — 스냅샷이 있는 구간만
  assert.equal(CMP.procDiff([], [{ ioTop: [{ name: 'x', readBps: 1 }] }]).available, false);
  const pd = CMP.procDiff([{ ioTop: [{ name: 'postgres', readBps: 1e6, writeBps: 0 }], cpuTop: [{ name: 'postgres', cpuPct: 38 }] }],
    [{ ioTop: [{ name: 'pg_dump', readBps: 2e8, writeBps: 0 }, { name: 'postgres', readBps: 2e6 }], cpuTop: [{ name: 'postgres', cpuPct: 51 }] }]);
  assert.equal(pd.available, true);
  assert.deepEqual(pd.rows.find((r) => r.name === 'pg_dump').only, 'b', 'B 에만');
  // compareFor — 해상도는 두 구간 중 거친 쪽(A 가 원시 보존 밖이면 둘 다 1시간)
  const calls = [];
  const deps = {
    rawRange: async (o) => { calls.push(['5m', o.from]); return { rows: [] }; }, hourly: async (o) => { calls.push(['1h', o.from]); return { rows: [] }; },
    daily: async () => ({ rows: [] }), snapshots: async () => [], snapshotGet: async () => null, focusRange: async () => [],
    changes: async () => ({ rows: [{ ts: NOW - HOUR / 2, kind: 'sysctl', item: 'vm.dirty_ratio', before: '20', after: '10' }, { ts: NOW - 40 * 86_400_000, kind: 'kernel', item: 'k', before: 'a', after: 'b' }] }),
  };
  const r = await CMP.compareFor({ key: 'S1', q: { aFrom: NOW - 40 * 86_400_000, aTo: NOW - 40 * 86_400_000 + 3 * HOUR, bFrom: NOW - 3 * HOUR, bTo: NOW }, settings: { rawRetentionDays: 30, dailyRetentionDays: 1825, intervalMs: 300_000, store: { hourlyDays: 365 } }, rules: {}, now: NOW, deps });
  assert.equal(r.res, '1h'); assert.ok(calls.every(([res]) => res === '1h'), '두 구간 같은 롤업');
  assert.deepEqual(r.tuning.map((e) => e.item), ['vm.dirty_ratio'], 'A 끝 ~ B 끝 사이 전이만');
  assert.equal(r.procs.available, false);
});
