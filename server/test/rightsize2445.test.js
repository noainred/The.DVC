/**
 * v2.445 — VM 자원 축소 근거 리포트 판정(tools/rightsize.js, 순수).
 *
 * 사용자 요구: '줄여도 되는 구체적 근거 — 추이·기간·벌룬/스왑·설명·공식 문서. 근거가 충분해야
 * 자원을 줄일 수 있다'. 그래서 이 테스트는 (a) 근거가 부족하면 권고하지 않는지, (b) 벌룬·스왑·
 * Ready 가 보이면 보류하는지, (c) 권고 산식과 50% 상한이 문서대로인지, (d) 추정하지 않는지를 고정한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRightsize, percentile, stats, windowInfo, CITATIONS, DEFAULT_POLICY } from '../src/tools/rightsize.js';

const NOW = Date.parse('2026-09-09T00:00:00Z');
/** days 일 동안 intervalSec 간격의 계열을 만든다. fn(i) 가 값. */
const mk = (days, intervalSec, fn) => {
  const n = Math.floor((days * 86_400) / intervalSec);
  return Array.from({ length: n }, (_, i) => ({ t: new Date(NOW - (n - i) * intervalSec * 1000).toISOString(), v: fn(i) }));
};
const flat = (days, v, iv = 1800) => mk(days, iv, () => v);

// 사용자 화면의 실제 사례 — LESASHP07: 256 GB 할당 · 2.6 GB 사용 · 1% (호스트 코어 2.4 GHz, 8 vCPU 가정)
const VM = { id: 'oc2:vm-1', name: 'LESASHP07', vcenterId: 'oc2', host: 'leshdvcps54', cpuCount: 8, memMB: 256 * 1024, powerState: 'POWERED_ON', storageGB: 300, uncommittedGB: 0, thin: false, toolsStatus: 'RUNNING' };
const MHZ = 2400;

test('percentile / stats — 결측(null·음수)은 버리고 p95 는 상위 5% 를 제외한 최대', () => {
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 100], 95), 19);
  const s = stats([{ v: 10 }, { v: null }, { v: -1 }, { v: 30 }]);
  assert.deepEqual([s.n, s.avg, s.max, s.min], [2, 20, 30, 10]);
});

test('관측 창 — 커버리지는 기대 샘플 대비 실제 샘플', () => {
  const w = windowInfo(flat(7, 1), 1800, 7, NOW);
  assert.equal(w.samples, 336);
  assert.equal(w.expectedSamples, 336);
  assert.equal(w.coveragePct, 100);
  assert.ok(w.coverageDays >= 6.9);
});

test('근거 불충분 ① — 관측 기간이 정책 하한(7일) 미만이면 권고하지 않는다', () => {
  const series = { cpuUsageMhz: flat(2, 500), memActiveMB: flat(2, 2600), memConsumedMB: flat(2, 6000), memBalloonMB: flat(2, 0), memSwappedMB: flat(2, 0) };
  const r = analyzeRightsize({ vm: VM, hostMhzPerCore: MHZ, intervalSec: 1800, days: 7, series, now: NOW });
  assert.equal(r.evidence.sufficient, false);
  assert.equal(r.verdict.state, 'insufficient');
  assert.equal(r.cpu.recommendedVcpu, null);   // 추정하지 않는다
  assert.equal(r.mem.recommendedMB, null);
  assert.match(r.evidence.reasons.join(' '), /정책 하한 7일 미만/);
});

test('근거 게이트 — 7일 요청에서 롤업 지연으로 관측 6.9일이어도 하한을 통과한다(v2.471 회귀)', () => {
  // 사용자 신고: 30/90일은 되는데 '최근 7일' 만 '근거 불충분(관측 6.9일 < 하한 7일)'. 실제 vCenter
  // 주간 롤업은 가장 최근 점이 몇 시간 지연돼 7일을 요청해도 span 이 ~6.9일 → 딱 하한을 못 넘었다.
  const iv = 1800; const lagMs = 3.5 * 3600 * 1000; const n = 334;
  const gen = (v) => Array.from({ length: n }, (_, i) => ({ t: new Date(NOW - lagMs - (n - 1 - i) * iv * 1000).toISOString(), v }));
  const series = { cpuUsageMhz: gen(500), cpuReadyMs: gen(100), memActiveMB: gen(2600), memConsumedMB: gen(6000), memBalloonMB: gen(0), memSwappedMB: gen(0) };
  const w = windowInfo(series.cpuUsageMhz, iv, 7, NOW);
  assert.ok(w.coverageDays <= 7 && w.coverageDays >= 6.8, `데이터 범위는 7일 근처여야(실제=${w.coverageDays})`);
  assert.equal(w.days, 7); assert.equal(w.end, NOW); assert.equal(w.start, NOW - 7 * 86_400_000); // v2.481: 요청 창은 그대로 7일
  const r = analyzeRightsize({ vm: VM, hostMhzPerCore: MHZ, intervalSec: iv, days: 7, series, now: NOW });
  assert.equal(r.evidence.sufficient, true, '롤업 경계 손실(6.9일)만으로 근거 불충분이 되면 안 된다');
  assert.notEqual(r.verdict.state, 'insufficient');
  // 진짜로 짧은 이력(5일)은 여전히 걸러진다 — 경계 허용이 정책을 무력화하지 않는다.
  const short = { cpuUsageMhz: flat(5, 500), memConsumedMB: flat(5, 6000), memBalloonMB: flat(5, 0), memSwappedMB: flat(5, 0) };
  const rs = analyzeRightsize({ vm: VM, hostMhzPerCore: MHZ, intervalSec: iv, days: 7, series: short, now: NOW });
  assert.equal(rs.evidence.sufficient, false);
  assert.match(rs.evidence.reasons.join(' '), /정책 하한 7일 미만/);
});

test('근거 불충분 ② — 샘플 커버리지가 낮으면(수집 공백) 권고하지 않는다', () => {
  // 7일 창인데 하루치만 있는 경우 → 커버리지 ~14%
  const sparse = mk(7, 1800, (i) => (i % 7 === 0 ? 500 : null));
  const r = analyzeRightsize({ vm: VM, hostMhzPerCore: MHZ, intervalSec: 1800, days: 7, series: { cpuUsageMhz: sparse, memActiveMB: sparse, memConsumedMB: sparse }, now: NOW });
  assert.equal(r.evidence.sufficient, false);
  assert.match(r.evidence.reasons.join(' '), /커버리지/);
});

test('근거 불충분 ③ — 전원 꺼진 VM · 이력 없음', () => {
  const off = analyzeRightsize({ vm: { ...VM, powerState: 'POWERED_OFF' }, hostMhzPerCore: MHZ, days: 7, series: {}, now: NOW });
  assert.equal(off.verdict.state, 'insufficient');
  assert.match(off.evidence.reasons[0], /전원이 꺼진/);
  const none = analyzeRightsize({ vm: VM, hostMhzPerCore: MHZ, days: 7, series: {}, now: NOW });
  assert.match(none.evidence.reasons.join(' '), /성능 이력을 받지 못했습니다/);
});

test('감축 가능 — 사용자 사례(256GB 중 2.6GB) : 산식과 50% 상한이 문서대로', () => {
  const series = {
    cpuUsageMhz: mk(7, 1800, (i) => 400 + (i % 10) * 20),        // p95 ≈ 580 MHz, 8 vCPU × 2.4GHz = 19.2 GHz 할당
    cpuUsagePct: flat(7, 3), cpuReadyMs: flat(7, 100),           // ready 100ms/1800s/8vCPU = 0.0007% → 정상
    memActiveMB: flat(7, 2600), memConsumedMB: flat(7, 6000),
    memBalloonMB: flat(7, 0), memSwappedMB: flat(7, 0), memUsagePct: flat(7, 1),
  };
  const r = analyzeRightsize({ vm: VM, hostMhzPerCore: MHZ, intervalSec: 1800, days: 7, series, now: NOW });
  assert.equal(r.evidence.sufficient, true);
  assert.equal(r.verdict.state, 'reduce');
  // CPU: ⌈580×1.2 / 2400⌉ = 1 → 하지만 50% 상한으로 8 의 절반 = 4 까지만 감축 → 권장 4, capped
  assert.equal(r.cpu.recommendedVcpu, 4);
  assert.equal(r.cpu.capped, true);
  assert.equal(r.cpu.reductionVcpu, 4);
  assert.equal(r.cpu.reductionPct, 50);
  // 메모리(v2.481): 워킹셋(active 최대 2600) ×1.2 = 3120 → 1GB 올림 4096 MB… 상한 128 GB 가 더 크다 → 128 GB, capped
  assert.equal(r.mem.recommendedMB, 128 * 1024);
  assert.equal(r.mem.capped, true);
  assert.equal(r.mem.reductionPct, 50);
  assert.match(r.verdict.summary, /vCPU 8 → 4/);
  assert.match(r.verdict.summary, /256 GB → 128 GB/);
  // 근거 문구가 산식을 그대로 보여준다
  assert.match(r.mem.basisNote, /워킹셋 최대 2600 MB\(active 이력 최대\)/);
  assert.doesNotMatch(r.mem.basisNote, /consumed/); // v2.481: consumed 는 하한이 아니다
  assert.match(r.mem.consumedNote, /consumed p95 6000 MB 는 워킹셋 2600 MB/);
});

test('상한을 끄면(정책) 실제 산식대로 권고한다 — 메모리 4 GB(워킹셋 기준), vCPU 1', () => {
  const series = { cpuUsageMhz: flat(7, 500), memActiveMB: flat(7, 2600), memConsumedMB: flat(7, 6000), memBalloonMB: flat(7, 0), memSwappedMB: flat(7, 0) };
  const r = analyzeRightsize({ vm: VM, hostMhzPerCore: MHZ, intervalSec: 1800, days: 7, series, policy: { capReductionPct: 100 }, now: NOW });
  assert.equal(r.cpu.recommendedVcpu, 1);   // ⌈500×1.2/2400⌉ = 1
  assert.equal(r.mem.recommendedMB, 4 * 1024);   // 2600×1.2 = 3120 → 4096
  assert.equal(r.cpu.capped, false);
  assert.equal(r.mem.capped, false);
  // 구 산식은 정책으로 선택 가능(RIGHTSIZE_MEM_BASIS=consumed): max(6000, 2600)×1.2 = 7200 → 8192
  const old = analyzeRightsize({ vm: VM, hostMhzPerCore: MHZ, intervalSec: 1800, days: 7, series, policy: { capReductionPct: 100, memBasis: 'consumed' }, now: NOW });
  assert.equal(old.mem.recommendedMB, 8 * 1024);
  assert.match(old.mem.basisNote, /consumed p95 6000 MB/);
});

test('v2.481 사용자 사례 — 512 GB 할당·active 5 GB·consumed 511 GB: consumed 는 하한이 아니므로 감축 가능(50% 상한)', () => {
  // 낭비 리소스 탭은 이 VM 을 '절감 99%' 로 보여주는데 리포트는 consumed 하한 때문에 '권장 512 GB(변경 없음)' 이었다.
  // 실제 vCenter 레벨 1: 주간 롤업에 mem.active 표본 없음(empty) · mem.usage(%) 는 있음 · 실시간 active 5.1 GB.
  const vm = { ...VM, cpuCount: 64, memMB: 512 * 1024 };
  const series = { cpuUsageMhz: flat(7, 500), cpuReadyMs: flat(7, 100), memActiveMB: [], memConsumedMB: flat(7, 523300), memBalloonMB: flat(7, 0), memSwappedMB: [], memUsagePct: mk(7, 1800, (i) => (i === 10 ? 1.2 : 1)) };
  const r = analyzeRightsize({ vm, hostMhzPerCore: MHZ, intervalSec: 1800, days: 7, series, realtime: { memActiveMB: { latest: 5222, max: 5222, avg: 5200, samples: 180 } }, empty: ['memActiveMB(mem.active.average)', 'memSwappedMB(mem.swapped.average)'], now: NOW });
  assert.equal(r.evidence.sufficient, true);
  // 워킹셋: usage 최대 1.2% × 524288 = 6291 MB > 실시간 5222 → usagePct 출처
  assert.equal(r.mem.workingSetMB, 6291);
  assert.equal(r.mem.workingSetSource, 'usagePct');
  assert.equal(r.mem.capped, true);
  assert.equal(r.mem.recommendedMB, 256 * 1024);   // 6291×1.2 = 7549 → 8192 이지만 50% 상한 → 256 GB
  assert.equal(r.mem.reductionPct, 50);
  assert.equal(r.mem.ok, true);
  assert.equal(r.verdict.state, 'reduce');
  assert.match(r.verdict.summary, /512 GB → 256 GB/);
  assert.match(r.mem.basisNote, /mem\.usage 최대 × 할당/);
  assert.match(r.mem.consumedNote, /할당에 수렴/);
  // 실시간 active 가 복원값보다 크면 그쪽을 쓴다(하한을 올리는 방향)
  const r2 = analyzeRightsize({ vm, hostMhzPerCore: MHZ, intervalSec: 1800, days: 7, series, realtime: { memActiveMB: { max: 9000 } }, now: NOW });
  assert.equal(r2.mem.workingSetMB, 9000);
  assert.equal(r2.mem.workingSetSource, 'usagePct+realtime');
  // 워킹셋 출처가 전혀 없으면 추정하지 않는다
  const r3 = analyzeRightsize({ vm, hostMhzPerCore: MHZ, intervalSec: 1800, days: 7, series: { ...series, memUsagePct: [] }, now: NOW });
  assert.equal(r3.mem.recommendedMB, null);
  assert.match(r3.mem.skipReason, /워킹셋.*모두 없어/);
  assert.equal(r3.mem.blockers.length, 0);              // 산정 불가는 압박 신호(보류)가 아니다
  assert.notEqual(r3.verdict.state, 'hold');
});

test('보류 — 벌룬이 한 번이라도 0 을 넘으면 메모리 감축을 권고하지 않는다', () => {
  const series = { cpuUsageMhz: flat(7, 500), memActiveMB: flat(7, 2600), memConsumedMB: flat(7, 6000),
    memBalloonMB: mk(7, 1800, (i) => (i === 100 ? 512 : 0)), memSwappedMB: flat(7, 0) };
  const r = analyzeRightsize({ vm: VM, hostMhzPerCore: MHZ, intervalSec: 1800, days: 7, series, now: NOW });
  assert.equal(r.mem.ok, false);
  assert.equal(r.mem.blockers.length, 1);
  assert.match(r.mem.blockers[0], /벌룬 관측 — 최대 512 MB/);
  assert.equal(r.mem.balloon.samplesAbove0, 1);
  assert.equal(r.verdict.state, 'hold');
  // 권장 수치 자체는 계산해 보여준다(보류 이유와 함께) — 숨기지 않는다
  assert.ok(r.mem.recommendedMB != null);
});

test('보류 — 호스트 스왑은 감축 금지 신호', () => {
  const series = { cpuUsageMhz: flat(7, 500), memActiveMB: flat(7, 2600), memConsumedMB: flat(7, 6000),
    memBalloonMB: flat(7, 0), memSwappedMB: mk(7, 1800, (i) => (i > 300 ? 2048 : 0)) };
  const r = analyzeRightsize({ vm: VM, hostMhzPerCore: MHZ, intervalSec: 1800, days: 7, series, now: NOW });
  assert.match(r.mem.blockers.join(' '), /호스트 스왑 관측 — 최대 2048 MB/);
  assert.equal(r.verdict.state, 'hold');
});

test('보류 — CPU Ready p95 가 vCPU 당 5% 를 넘으면 CPU 감축을 권고하지 않는다', () => {
  // 1800초 간격 · 8 vCPU: 5% 는 ready 720,000 ms. 그 이상을 넣는다.
  const series = { cpuUsageMhz: flat(7, 500), cpuReadyMs: flat(7, 900_000), memActiveMB: flat(7, 2600), memConsumedMB: flat(7, 6000), memBalloonMB: flat(7, 0), memSwappedMB: flat(7, 0) };
  const r = analyzeRightsize({ vm: VM, hostMhzPerCore: MHZ, intervalSec: 1800, days: 7, series, now: NOW });
  assert.ok(r.cpu.readyPct.p95 > 5);
  assert.equal(r.cpu.ok, false);
  assert.match(r.cpu.blockers[0], /CPU Ready p95/);
  assert.equal(r.verdict.state, 'hold');
});

test('스파이크 워크로드 — 최대값이 p95 의 1.5배를 넘으면 최대값 기준으로 산정한다', () => {
  const series = { cpuUsageMhz: mk(7, 1800, (i) => (i % 50 === 0 ? 9000 : 500)), memActiveMB: flat(7, 2600), memConsumedMB: flat(7, 6000), memBalloonMB: flat(7, 0), memSwappedMB: flat(7, 0) };
  const r = analyzeRightsize({ vm: VM, hostMhzPerCore: MHZ, intervalSec: 1800, days: 7, series, policy: { capReductionPct: 100 }, now: NOW });
  assert.match(r.cpu.basisNote, /스파이크/);
  assert.equal(r.cpu.recommendedVcpu, Math.ceil((9000 * 1.2) / 2400));   // 5
});

test('추정 금지 — 코어당 MHz 를 모르면 vCPU 를 산정하지 않는다', () => {
  const series = { cpuUsageMhz: flat(7, 500), memActiveMB: flat(7, 2600), memConsumedMB: flat(7, 6000), memBalloonMB: flat(7, 0), memSwappedMB: flat(7, 0) };
  const r = analyzeRightsize({ vm: VM, hostMhzPerCore: null, intervalSec: 1800, days: 7, series, now: NOW });
  assert.equal(r.cpu.recommendedVcpu, null);
  assert.match(r.cpu.blockers[0], /코어당 MHz 를 알 수 없어/);
});

test('카운터가 없으면 이유에 남기고 그 판정만 생략한다', () => {
  const series = { cpuUsageMhz: flat(7, 500), memActiveMB: flat(7, 2600), memConsumedMB: flat(7, 6000) };
  const r = analyzeRightsize({ vm: VM, hostMhzPerCore: MHZ, intervalSec: 1800, days: 7, series, missing: ['memBalloonMB', 'memSwappedMB'], now: NOW });
  assert.equal(r.evidence.sufficient, true);
  assert.match(r.evidence.reasons.join(' '), /카운터 없음: memBalloonMB/);
});

test('참고 문서·방법론이 응답에 실린다(사용자 요구) — 링크와 용도가 비어 있지 않다', () => {
  assert.ok(CITATIONS.length >= 5);
  for (const c of CITATIONS) { assert.match(c.url, /^https:\/\//); assert.ok(c.title.length > 10); assert.ok(c.usedFor.length > 10); }
  const r = analyzeRightsize({ vm: VM, hostMhzPerCore: MHZ, days: 7, series: {}, now: NOW });
  assert.equal(r.citations.length, CITATIONS.length);
  assert.ok(r.methodology.length >= 4);
  assert.match(r.methodology.join(' '), new RegExp(`${DEFAULT_POLICY.capReductionPct}%`));
});

test('디스크는 이력이 없음을 명시한다(추정 금지)', () => {
  const r = analyzeRightsize({ vm: VM, hostMhzPerCore: MHZ, days: 7, series: {}, now: NOW });
  assert.equal(r.disk.storageGB, 300);
  assert.match(r.disk.note, /이력은 vCenter 기본 통계/);
});

test('정책에 undefined 키가 섞여도 기본값을 덮지 않는다(v2.445 e2e 에서 잡힌 버그 — 권고가 null 이 되던 회귀)', () => {
  const series = { cpuUsageMhz: flat(7, 500), memActiveMB: flat(7, 2600), memConsumedMB: flat(7, 6000), memBalloonMB: flat(7, 0), memSwappedMB: flat(7, 0) };
  const r = analyzeRightsize({ vm: VM, hostMhzPerCore: MHZ, intervalSec: 1800, days: 7, series,
    policy: { headroomPct: undefined, minDays: undefined, capReductionPct: null, readyWarnPct: 'x' }, now: NOW });
  assert.equal(r.policy.headroomPct, DEFAULT_POLICY.headroomPct);
  assert.equal(r.policy.capReductionPct, DEFAULT_POLICY.capReductionPct);
  assert.equal(r.policy.readyWarnPct, DEFAULT_POLICY.readyWarnPct);
  assert.ok(r.mem.recommendedMB != null && r.cpu.recommendedVcpu != null);
  assert.equal(r.verdict.state, 'reduce');
});
