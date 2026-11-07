/**
 * v2.922(리눅스 성능 3a — 메인 지시 수정) — 피크 A 안 **주기 예산 자동 맞춤**(bmusage/peakPlan.js + poller 연결).
 *   예상 주기 소요 = max(1, 대상 ÷ 동시성) × (서버당 기본 소요 + OS 비율 × 창 길이) 가 주기 × 0.7 을 넘으면 창을 10 → 5 → 3 → 0초로 줄인다.
 *   설정 peakWindowS 는 상한(줄이기만) · 직전 실측이 없으면 보수적 기본값 · 결정은 _last·bmUsageStatus 에 · 행 peak_window_s 는 실제 값.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'bm2921plan-'));
process.env.CONFIG_DIR = DIR;
const listener = net.createServer((s) => { s.destroy(); });   // 접속 즉시 끊는 가짜 iDRAC — 수집은 빨리 실패한다
await new Promise((r) => listener.listen(0, '127.0.0.1', r));
const PORT = listener.address().port;
test.after(() => { listener.close(); fs.rmSync(DIR, { recursive: true, force: true }); });

const IV = 300_000;

test('작은 법인(17대 · 동시 32) — 창 10초 유지(fits) · 실측이 없으면 보수적 기본값', async () => {
  const P = await import('../src/bmusage/peakPlan.js');
  const est = P.estimateBaseMs([]);
  assert.deepEqual(est, { baseMs: P.BASE_DEFAULT_MS, n: 0, source: 'default' });
  assert.ok(P.BASE_DEFAULT_MS >= 5_000, '설계 추정(서버당 ~5초)보다 작으면 보수적이 아니다');
  const r = P.planCycleWindow({ targets: 17, osTargets: 17, concurrency: 32, intervalMs: IV, ratio: 0.7, capS: 10, baseMs: est.baseMs, baseSource: est.source });
  assert.equal(r.windowS, 10); assert.equal(r.reason, 'fits'); assert.equal(r.baseSource, 'default');
  assert.equal(r.expectedMs, P.BASE_DEFAULT_MS + 10_000, '한 바퀴(대상 < 동시성)는 서버당 소요 그대로');
  assert.equal(r.budgetMs, 210_000);
});

test('큰 법인(1,000대 · 동시 32) — 창을 줄여 예상 주기 ≤ 주기 × 0.7 · 서버당 3초 실측이면 3초 · 5초면 0(PSI 만)', async () => {
  const P = await import('../src/bmusage/peakPlan.js');
  const base3 = P.estimateBaseMs(Array.from({ length: 50 }, () => ({ ms: 13_000, windowS: 10 })));   // 13초 중 창 10초 → 기본 3초
  assert.deepEqual(base3, { baseMs: 3_000, n: 50, source: 'measured' });
  const r3 = P.planCycleWindow({ targets: 1000, osTargets: 1000, concurrency: 32, intervalMs: IV, capS: 10, baseMs: base3.baseMs, baseSource: 'measured' });
  assert.equal(r3.windowS, 3); assert.equal(r3.reason, 'reduced');
  assert.ok(r3.expectedMs <= r3.budgetMs, JSON.stringify(r3));
  assert.deepEqual(r3.steps.map((x) => x.s), [10, 5, 3], '10 → 5 → 3 순서로 내려간다');
  assert.ok(r3.steps[0].expectedMs > IV, '창 10초 그대로면 주기(300초)를 넘었다 — 재진입 가드가 다음 틱을 건너뛴다');
  const r5 = P.planCycleWindow({ targets: 1000, concurrency: 32, intervalMs: IV, capS: 10, baseMs: 5_000 });
  assert.equal(r5.windowS, 0); assert.equal(r5.reason, 'reduced'); assert.ok(r5.expectedMs <= r5.budgetMs);
  // 창 0 으로도 넘으면 0 + 사유(기본 소요 자체가 넘는다)
  const over = P.planCycleWindow({ targets: 3000, concurrency: 32, intervalMs: IV, capS: 10, baseMs: 8_000 });
  assert.equal(over.windowS, 0); assert.equal(over.reason, 'base-over-budget'); assert.ok(over.expectedMs > over.budgetMs);
  // OS 경로가 절반이면 창은 그 비율만큼만 더한다
  assert.equal(P.expectedCycleMs({ targets: 64, osTargets: 32, concurrency: 32, baseMs: 4_000, windowS: 10 }), 2 * (4_000 + 5_000));
});

test('설정 peakWindowS 는 상한 — 자동 맞춤은 줄이기만(늘리지 않음) · 0 이면 끔 · 비율은 설정값', async () => {
  const P = await import('../src/bmusage/peakPlan.js');
  assert.deepEqual(P.ladderFor(10), [10, 5, 3, 0]);
  assert.deepEqual(P.ladderFor(4), [4, 3, 0]);
  assert.deepEqual(P.ladderFor(0), [0]);
  const small = P.planCycleWindow({ targets: 5, concurrency: 32, intervalMs: IV, capS: 4, baseMs: 1_000 });
  assert.equal(small.windowS, 4, '예산이 남아도 상한 4초를 넘지 않는다');
  assert.equal(P.planCycleWindow({ targets: 5, concurrency: 32, intervalMs: IV, capS: 0, baseMs: 1_000 }).reason, 'off');
  const tight = P.planCycleWindow({ targets: 1000, concurrency: 32, intervalMs: IV, ratio: 0.5, capS: 10, baseMs: 3_000 });
  assert.equal(tight.budgetMs, 150_000); assert.equal(tight.windowS, 0, '비율 0.5 면 3초도 못 넣는다(187.5초 > 150초)');
  const S = await import('../src/bmusage/settings.js');
  assert.equal(S.normalizeSettings({}).store.peakCycleRatio, 0.7);
  assert.equal(S.normalizeStoreSettings({ peakCycleRatio: 5 }).peakCycleRatio, 0.95);
  const Pl = await import('../src/bmusage/poller.js');
  const st = { ...S.normalizeSettings({}).store, peakWindowS: 6 };
  const o = Pl.osStoreOpts(st, { windowS: 10, capS: 6, reason: 'fits' });
  assert.equal(o.peakWindowS, 6, '결정이 상한보다 커도 설정 상한을 넘지 않는다');
  assert.equal(Pl.osStoreOpts(st, { windowS: 3, capS: 6, reason: 'reduced' }).peakWindowS, 3);
  assert.deepEqual(Pl.osStoreOpts(st, { windowS: 3, capS: 6, reason: 'reduced' }).peakCycle, { capS: 6, plannedS: 3, reason: 'reduced' });
});

test('폴러: planPeakForCycle 이 대상·OS 비율·직전 실측으로 결정한다', async () => {
  const Pl = await import('../src/bmusage/poller.js');
  const S = await import('../src/bmusage/settings.js');
  const st = S.normalizeSettings({}).store;
  const many = Array.from({ length: 1000 }, (_, i) => ({ key: `k${i}`, paths: ['os', 'idrac'] }));
  const d = Pl.planPeakForCycle(many, { intervalMs: IV, st, samples: [], concurrency: 32 });
  assert.equal(d.baseSource, 'default'); assert.equal(d.windowS, 0, '기본값 8초 × 31.25 = 250초 > 210초 → 창을 다 줄여도 넘는다');
  assert.equal(d.reason, 'base-over-budget');
  const m = Pl.planPeakForCycle(many, { intervalMs: IV, st, samples: Array.from({ length: 10 }, () => ({ ms: 12_500, windowS: 10 })), concurrency: 32 });
  assert.equal(m.baseSource, 'measured'); assert.equal(m.baseMs, 2_500); assert.equal(m.windowS, 3);
  assert.ok(m.expectedMs <= m.budgetMs);
  assert.equal(Pl.planPeakForCycle(many.slice(0, 17), { intervalMs: IV, st, samples: [], concurrency: 32 }).windowS, 10);
});

test('폴러 실제 한 주기: 결정이 _last.peakPlan · bmUsageStatus().peakPlan 에 실리고, 다음 주기는 이번 실측을 쓴다', async () => {
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [{ id: 'srv-1', name: 'bm-1', host: `127.0.0.1:${PORT}`, username: 'root', password: 'p' }] }));
  const Pl = await import('../src/bmusage/poller.js');
  const { saveBmUsageSettings } = await import('../src/bmusage/settings.js');
  saveBmUsageSettings({ enabled: true, includeUnassigned: true, idracTelemetry: true, osSsh: true });
  Pl._resetForTest();
  Pl._setFleetForTest(async () => ({ bareMetal: [{ serverId: 'srv-1', name: 'bm-1', serviceTag: 'TAG1' }], virtualizationHosts: [] }));
  try {
    const r1 = await Pl.pollBmUsageOnce({ trigger: 'manual' });
    assert.equal(r1.servers, 1, JSON.stringify(r1));
    assert.ok(r1.peakPlan, '결정이 _last 에 없다');
    assert.equal(r1.peakPlan.targets, 1); assert.equal(r1.peakPlan.baseSource, 'default'); assert.equal(r1.peakPlan.windowS, 10);
    assert.ok(!('steps' in r1.peakPlan), '_last 에는 요약만');
    const st = Pl.bmUsageStatus();
    assert.equal(st.peakPlan.reason, 'fits'); assert.equal(st.last.peakPlan.budgetMs, 210_000);
    const r2 = await Pl.pollBmUsageOnce({ trigger: 'manual' });
    assert.equal(r2.peakPlan.baseSource, 'measured', '직전 주기 실측을 쓴다');
    assert.equal(r2.peakPlan.baseSamples, 1);
  } finally { Pl._setFleetForTest(null); Pl._resetForTest(); }
});

test('행: 주기 맞춤으로 창이 줄면 노트로 밝히고 peak_window_s 는 실제 값(0 이면 PSI 보조만 — peak_src psi|none)', async () => {
  const U = await import('../src/bmusage/usage.js');
  const os = { ok: true, osKind: 'linux', counters: { cpu: { total: 1, idle: 1 }, disks: [], nets: [] }, mounts: [], perf: { psi: { value: { cpu: {} } } },
    peak: { windowS: 0, wantS: 0, reason: 'off', cycle: { capS: 10, plannedS: 0, reason: 'reduced' } } };
  const b = U.buildUsage({ target: { key: 'K' }, os, now: 5_000 });
  assert.equal(b.row.peak_window_s, 0); assert.equal(b.row.peak_src, 'psi'); assert.equal(b.row.cpu_pct_peak, null);
  assert.ok(b.notes.some((x) => x.includes('10초에서 0초로') && x.includes('PSI')), b.notes.join(' | '));
  const b3 = U.buildUsage({ target: { key: 'K' }, os: { ...os, peak: { windowS: 3, wantS: 3, server: {}, devices: {}, cycle: { capS: 10, plannedS: 3, reason: 'reduced' } } }, now: 5_000 });
  assert.equal(b3.row.peak_window_s, 3); assert.equal(b3.row.peak_src, 'window10');
  const src = fs.readFileSync(path.join(import.meta.dirname, '../src/bmusage/poller.js'), 'utf8');
  assert.match(src, /collectOne\(tg, \{ trigger, intervalMs, prevRunMs, runT0: t0, peakPlan \}\)/, '결정을 수집에 넘긴다');
  assert.match(src, /osStoreOpts\(storeOf\(\), peakPlan\)/);
});
