/**
 * bmusage/peakPlan.js — 피크 A 안(같은 세션 1초 창)의 **주기 예산 자동 맞춤**(v2.922 · 3a 반증 전 수정 — 메인 지시). 순수 모듈.
 *
 * 왜: 창은 서버마다 수집 시간에 창 길이(기본 10초)만큼을 더한다. 1,000대 · 동시 32 · 서버당 약 5초면 한 주기가
 *   1,000 ÷ 32 × (5 + 10)초 ≈ 469초로 주기(300초)를 넘는다. 타이머는 실행이 끝난 뒤 재무장하므로(util/adaptiveTimer) 틱을 건너뛰는 것이 아니라
 *   **실제 간격 = 실행 + 주기**(≈ 769초)로 늘어나고, 추이(trendWindow.gapsOf)는 주기 × 2(600초)를 넘는 빈틈을 결측으로 끊어
 *   **기존 다섯 지표의 5분 추이까지 결측**이 된다(반증 D2 정정 — 예전 주석의 ‘재진입 가드가 건너뛴다’ 는 틀렸다).
 *   실행 ≤ 주기 × ratio(< 1) 이면 간격 ≤ 주기 × (1 + ratio) < 주기 × 2 — 결측 경계 안이다(expectedPeriodMs 로 밝힌다).
 *   사용자가 동시성 32 를 고른 이유가 ‘한 주기 안에 끝내기’ 라, 피크 때문에 그것을 깨는 기본값은 둘 수 없다.
 *
 * 규칙(매 주기 시작):
 *   예상 주기 소요 = max(1, 대상 ÷ 동시성) × (서버당 기본 소요 + 창 길이) — 창은 OS(SSH) 경로가 있는 대상에만 붙으므로
 *     그 비율(osShare)만큼만 더한다(전부 OS 면 지시의 식과 같다).
 *   예산 = 주기 × peakCycleRatio(기본 0.7 — 설정). 예상이 예산을 넘으면 창을 사다리(10 → 5 → 3 → 0초)로 줄인다.
 *   사다리의 첫 칸은 설정 `peakWindowS`(상한 — 자동 맞춤은 줄이기만 하고 늘리지 않는다 · 0 이면 끔).
 *   창 0 이면 피크는 PSI 보조(C)만 — 행의 peak_src 는 psi | none, peak_window_s 0.
 *   창 0 으로도 예산을 넘으면 0 을 고르고 사유 'base-over-budget'(기본 소요 자체가 넘는다 — 동시성·주기를 볼 일이다).
 *   서버당 기본 소요 = 직전 주기 실측(서버별 소요 − 그 서버가 실제로 쓴 창)의 평균. 실측이 없으면 보수적 기본값(BASE_DEFAULT_MS — 추정).
 */
import { numOrNull } from '../util/numOrNull.js';

const n = numOrNull;
/** 창 사다리(초) — 설정 상한 아래 칸만 쓴다. */
export const PEAK_LADDER = Object.freeze([10, 5, 3, 0]);
/**
 * 실측이 없을 때의 서버당 기본 소요(ms) — **보수적 추정값**. 설계 README §4.4 는 ‘서버당 ~5초’(추정)로 계산했다.
 *   그보다 크게 잡아(8초) 첫 주기가 창 때문에 주기를 넘기지 않게 한다 — 다음 주기부터는 실측이 이것을 대신한다.
 */
export const BASE_DEFAULT_MS = 8_000;
export const CYCLE_RATIO_DEFAULT = 0.7;

/**
 * 직전 주기 서버별 소요 → 서버당 기본 소요(창 제외). 표본: `[{ ms, windowS }]`(ms 는 그 서버 수집 전체 · windowS 는 실제로 쓴 창).
 * 평균이다(풀 처리량은 합 ÷ 동시성이라 평균이 맞다). 표본이 없으면 기본값.
 * @returns {{baseMs:number, n:number, source:'measured'|'default'}}
 */
export function estimateBaseMs(samples = [], { fallbackMs = BASE_DEFAULT_MS } = {}) {
  let sum = 0; let cnt = 0;
  for (const s of Array.isArray(samples) ? samples : []) {
    const ms = n(s?.ms);
    if (ms == null || ms < 0) continue;
    const w = Math.max(0, n(s?.windowS) ?? 0) * 1000;
    sum += Math.max(0, ms - w); cnt += 1;
  }
  if (!cnt) return { baseMs: fallbackMs, n: 0, source: 'default' };
  return { baseMs: Math.max(100, Math.round(sum / cnt)), n: cnt, source: 'measured' };
}

/** 사다리 — 상한(설정값)을 첫 칸으로, 그보다 작은 표준 칸, 마지막은 0. */
export function ladderFor(capS) {
  const cap = Math.max(0, Math.floor(n(capS) ?? 0));
  if (!cap) return [0];
  return [...new Set([cap, ...PEAK_LADDER.filter((x) => x < cap), 0])];
}

/** 예상 주기 소요(ms) — 한 창 길이에 대해. */
export function expectedCycleMs({ targets, osTargets = targets, concurrency, baseMs, windowS }) {
  const N = Math.max(0, n(targets) ?? 0);
  if (!N) return 0;
  const C = Math.max(1, n(concurrency) ?? 1);
  const osShare = Math.min(1, Math.max(0, (n(osTargets) ?? N) / N));
  return Math.round(Math.max(1, N / C) * ((n(baseMs) ?? BASE_DEFAULT_MS) + osShare * Math.max(0, n(windowS) ?? 0) * 1000));
}

/** 창 결정 사유 열거(화면 문구 표 · 수집 건강 정제가 같은 목록을 쓴다 — 6단계). */
export const PEAK_PLAN_REASONS = Object.freeze(['off', 'fits', 'reduced', 'base-over-budget', 'no-targets']);
/**
 * 이번 주기의 창 길이 결정(순수).
 * @param {{targets:number, osTargets?:number, concurrency:number, intervalMs:number, ratio?:number, capS:number, baseMs:number, baseSource?:string}} p
 * @returns {{windowS:number, capS:number, reason:'off'|'fits'|'reduced'|'base-over-budget'|'no-targets', expectedMs:number, expectedPeriodMs:number, budgetMs:number, baseMs:number, baseSource:string, steps:Array<{s:number, expectedMs:number}>}}
 *   expectedMs = 예상 실행 소요 · expectedPeriodMs = 예상 간격(실행 + 주기 — 타이머가 실행 뒤 재무장).
 */
export function planCycleWindow({ targets = 0, osTargets = targets, concurrency = 1, intervalMs, ratio = CYCLE_RATIO_DEFAULT, capS = 10, baseMs = BASE_DEFAULT_MS, baseSource = 'default' } = {}) {
  const cap = Math.max(0, Math.floor(n(capS) ?? 0));
  const r = Math.min(0.95, Math.max(0.1, n(ratio) ?? CYCLE_RATIO_DEFAULT));
  const budgetMs = Math.round(Math.max(0, n(intervalMs) ?? 0) * r);
  const base = { capS: cap, budgetMs, baseMs: n(baseMs) ?? BASE_DEFAULT_MS, baseSource, ratio: r, targets: n(targets) ?? 0, osTargets: n(osTargets) ?? 0, concurrency: n(concurrency) ?? 1 };
  const iv = Math.max(0, n(intervalMs) ?? 0);
  const per = (ms) => ms + iv;   // 타이머는 실행이 끝난 뒤 재무장 — 실제 간격 = 실행 + 주기
  if (!cap) { const e = expectedCycleMs({ targets, osTargets, concurrency, baseMs, windowS: 0 }); return { ...base, windowS: 0, reason: 'off', expectedMs: e, expectedPeriodMs: per(e), steps: [] }; }
  if (!(n(targets) > 0)) return { ...base, windowS: cap, reason: 'no-targets', expectedMs: 0, expectedPeriodMs: iv, steps: [] };
  const steps = [];
  for (const s of ladderFor(cap)) {
    const expectedMs = expectedCycleMs({ targets, osTargets, concurrency, baseMs, windowS: s });
    steps.push({ s, expectedMs });
    if (expectedMs <= budgetMs) return { ...base, windowS: s, reason: s === cap ? 'fits' : 'reduced', expectedMs, expectedPeriodMs: per(expectedMs), steps };
  }
  const last = steps.at(-1);
  return { ...base, windowS: 0, reason: 'base-over-budget', expectedMs: last.expectedMs, expectedPeriodMs: per(last.expectedMs), steps };
}
