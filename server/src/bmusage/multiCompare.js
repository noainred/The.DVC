/**
 * bmusage/multiCompare.js — 리눅스 성능 6단계 **서버 비교(2~5대 한 화면)** 의 계산 모듈(설계 PROFILES §15 · 아트보드 Multi).
 *
 *  · 지표 카탈로그 · 묶음(사용률 6종 · USE 전부 · 큐/버퍼 · 하드웨어) · 눈금은 **서버가 소유**한다(웹은 그리기만 — 판정 복제 금지).
 *  · 서버 1대의 계열 통계(`compareSeriesFor`)는 그 서버를 수집하는 노드가 만든다 — 이 노드 서버는 라우트가, 엣지 위임 서버는 그 엣지의
 *    collector 대행(`GET /api/collector/bm-usage/compare-series`)이 같은 함수로 만든다(요청은 서버당 1개 — 지표마다 WAN 왕복하지 않는다).
 *    계열은 3a 추이(trendFor — 시간 단위 파일 · 해상도 자동 · 결측은 끊는다)를 그대로 쓴다.
 *  · 표(`buildCompareTable`) — 편차(max ÷ min)는 **결측을 뺀 서버만**으로 내고 2대 미만 · 최소가 0 이하이면 null(0 으로 나누지 않는다) ·
 *    최고 서버 · 같은 용도 그룹에서 한 대만 높으면 ‘스큐 후보’(그룹 3대 이상 · 1위 ≥ 2위 × SKEW_RATIO) · 판정 행(USE · 베이스라인)은 편차를 내지 않는다.
 *  · 결측은 0 이 아니다 — 값이 없으면 null 이고 화면은 ‘—’(numOrNull).
 */
import { numOrNull } from '../util/numOrNull.js';
import { normalizeWindow, RES_MS } from './trendWindow.js';

const n = numOrNull;
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

/** 지표 카탈로그 — src: series(추이 열) · hw(iDRAC 사실 — 지금 값만 · 계열 없음). scaleMax 가 있으면 행 눈금 고정(넘으면 잘림), 없으면 그 행의 최대로 맞춘다. */
export const COMPARE_METRICS = Object.freeze([
  { col: 'cpu_pct', unit: '%', scaleMax: 100, src: 'series' },
  { col: 'disk_busy_pct', unit: '%', scaleMax: 100, src: 'series' },
  { col: 'disk_await_ms', unit: 'ms', scaleMax: 50, src: 'series' },
  { col: 'mem_pct', unit: '%', scaleMax: 100, src: 'series' },
  { col: 'swap_out_ps', unit: 'pages/s', scaleMax: null, src: 'series' },
  { col: 'net_pct', unit: '%', scaleMax: 100, src: 'series' },
  { col: 'runq_per_core', unit: '', scaleMax: null, src: 'series' },
  { col: 'psi_cpu_some10', unit: '%', scaleMax: 100, src: 'series' },
  { col: 'psi_mem_full10', unit: '%', scaleMax: 100, src: 'series' },
  { col: 'oom_kill_delta', unit: '건', scaleMax: null, src: 'series' },
  { col: 'disk_iops', unit: '/s', scaleMax: null, src: 'series' },
  { col: 'disk_aqu', unit: '', scaleMax: null, src: 'series' },
  { col: 'disk_inflight', unit: '', scaleMax: null, src: 'series' },
  { col: 'procs_blocked', unit: '', scaleMax: null, src: 'series' },
  { col: 'psi_io_full10', unit: '%', scaleMax: 100, src: 'series' },
  { col: 'ctxt_ps', unit: '/s', scaleMax: null, src: 'series' },
  { col: 'net_drop_delta', unit: '건', scaleMax: null, src: 'series' },
  { col: 'tcp_retrans_pct', unit: '%', scaleMax: null, src: 'series' },
  { col: 'net_err_delta', unit: '건', scaleMax: null, src: 'series' },
  { col: 'power_w', unit: 'W', scaleMax: null, src: 'hw' },
  { col: 'power_cap_pct', unit: '%', scaleMax: 100, src: 'hw' },
  { col: 'inlet_c', unit: '℃', scaleMax: null, src: 'hw' },
]);
export const COMPARE_COLS = Object.freeze(COMPARE_METRICS.map((m) => m.col));
export const SERIES_COLS = Object.freeze(COMPARE_METRICS.filter((m) => m.src === 'series').map((m) => m.col));
const META = new Map(COMPARE_METRICS.map((m) => [m.col, m]));
/** 지표 묶음(아트보드 ‘지표’ 칩). */
export const COMPARE_GROUPS = Object.freeze({
  util6: Object.freeze(['cpu_pct', 'disk_busy_pct', 'disk_await_ms', 'mem_pct', 'swap_out_ps', 'net_pct', 'power_w', 'inlet_c']),
  use: Object.freeze(['cpu_pct', 'runq_per_core', 'psi_cpu_some10', 'mem_pct', 'swap_out_ps', 'psi_mem_full10', 'oom_kill_delta', 'disk_busy_pct', 'disk_aqu', 'psi_io_full10', 'net_pct', 'net_drop_delta', 'tcp_retrans_pct', 'net_err_delta']),
  queue: Object.freeze(['runq_per_core', 'disk_aqu', 'disk_inflight', 'procs_blocked', 'ctxt_ps', 'net_drop_delta', 'tcp_retrans_pct']),
  hw: Object.freeze(['power_w', 'power_cap_pct', 'inlet_c']),
});
export const COMPARE_GROUP_IDS = Object.freeze(Object.keys(COMPARE_GROUPS));
/** 비교 창(아트보드 1시간 · 24시간 · 7일 + 직접). 직접 창은 normalizeWindow 의 상한을 그대로 따르되 이 기능은 14일까지만(계열 점 상한). */
export const COMPARE_RANGES = Object.freeze({ '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000 });
export const COMPARE_MAX_SPAN_MS = 14 * 86_400_000;
/** 편차 강조 기준(max ÷ min) · 스큐 후보 비율(같은 용도 그룹 1위 ÷ 2위). 화면은 이 값을 응답에서 받는다(숫자를 박지 않는다). */
export const DEV_HIGH_RATIO = 2;
export const SKEW_RATIO = 2;
export const SKEW_MIN_GROUP = 3;
/** 스파크 점 상한(서버당 · 지표당). */
export const SPARK_MAX = 96;

/** 비교 지표 목록 정규화(순수) — 화이트리스트만 · 묶음 이름이면 펼친다 · 상한 24. */
export function parseCompareMetrics(v, { group = '' } = {}) {
  const fromGroup = COMPARE_GROUPS[group] || null;
  const list = fromGroup ? [...fromGroup] : String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  const out = [...new Set(list.filter((c) => META.has(c)))].slice(0, 24);
  return out.length ? out : [...COMPARE_GROUPS.util6];
}
/** 비교 창(순수) — range 키 또는 from/to(최대 14일). */
export function compareWindow({ range = '24h', from = null, to = null, now = Date.now() } = {}) {
  if (from != null || to != null) {
    const w = normalizeWindow({ from: n(from), to: n(to), now });
    if (!w) return null;
    if (w.to - w.from > COMPARE_MAX_SPAN_MS) w.from = w.to - COMPARE_MAX_SPAN_MS;
    return { ...w, range: 'custom' };
  }
  const span = COMPARE_RANGES[range] || COMPARE_RANGES['24h'];
  return { from: now - span, to: now, range: COMPARE_RANGES[range] ? range : '24h' };
}

/**
 * 한 지표 계열 → 통계(순수). points 는 trendWindow.toPoints 모양({t, avg, max, peak, peakAt}).
 *  · avg = 점 평균의 평균(값 있는 점만) · peak = 점마다 (peak ?? max ?? avg) 의 최대 · last = 마지막 값 있는 점.
 *  · expected = 창 ÷ 간격 · missing = expected − 값 있는 점(음수면 0) — 결측을 0 으로 채우지 않고 개수를 센다.
 *  · spark = 창을 SPARK_MAX 칸으로 나눠 칸마다 평균 · 피크(값 없는 칸 null — 그리는 쪽이 끊는다).
 */
export function seriesStats(points = [], { from, to, stepMs, sparkMax = SPARK_MAX } = {}) {
  const pts = (Array.isArray(points) ? points : []).filter((p) => p && n(p.t) != null && (n(p.avg) != null || n(p.max) != null || n(p.peak) != null));
  const avgs = pts.map((p) => n(p.avg)).filter((v) => v != null);
  let peak = null; let peakAt = null;
  for (const p of pts) {
    const v = n(p.peak) ?? n(p.max) ?? n(p.avg);
    if (v != null && (peak == null || v > peak)) { peak = v; peakAt = n(p.peakAt) ?? n(p.t); }
  }
  const lastP = [...pts].reverse().find((p) => n(p.avg) != null || n(p.peak) != null) || null;
  const step = Math.max(1, n(stepMs) || RES_MS['5m']);
  const expected = from != null && to != null && to > from ? Math.max(1, Math.floor((to - from) / step)) : null;
  // 칸 수는 점 수를 넘지 않게(수집 주기가 칸보다 성기면 칸이 하나 걸러 비어 선이 점으로 끊긴다 — Chromium 판독 r1).
  const k = Math.max(1, Math.min(sparkMax, expected || sparkMax, Math.max(2, pts.length)));
  const spark = [];
  if (from != null && to != null && to > from) {
    const w = (to - from) / k;
    const buckets = Array.from({ length: k }, () => ({ s: 0, c: 0, pk: null }));
    for (const p of pts) {
      const i = Math.min(k - 1, Math.max(0, Math.floor((p.t - from) / w)));
      const a = n(p.avg); const pk = n(p.peak) ?? n(p.max) ?? a;
      if (a != null) { buckets[i].s += a; buckets[i].c += 1; }
      if (pk != null) buckets[i].pk = buckets[i].pk == null ? pk : Math.max(buckets[i].pk, pk);
    }
    for (let i = 0; i < k; i++) spark.push([Math.round(from + w * i), buckets[i].c ? r2(buckets[i].s / buckets[i].c) : null, r2(buckets[i].pk)]);
  }
  return {
    avg: avgs.length ? r2(avgs.reduce((a, b) => a + b, 0) / avgs.length) : null,
    peak: r2(peak), peakAt,
    last: lastP ? { t: n(lastP.t), avg: r2(n(lastP.avg)), peak: r2(n(lastP.peak) ?? n(lastP.max)) } : null,
    n: pts.length, expected, missing: expected == null ? null : Math.max(0, expected - pts.length),
    spark,
  };
}

/** 하드웨어 지금 값(iDRAC 사실 — hwFacts 모양) → 지표 값. 없으면 null(경로 없음 · 못 읽음은 칸 상태가 말한다). */
export function hwValuesOf(hw) {
  if (!hw || typeof hw !== 'object') return {};
  return { power_w: r2(n(hw.power?.watts)), power_cap_pct: r2(n(hw.power?.capPct)), inlet_c: r2(n(hw.inletC)) };
}

/**
 * 한 서버의 비교 계열(이 노드가 수집한 서버 — 엣지 대행도 같은 함수).
 * @param {{agent:string, key:string, metrics:string[], from:number, to:number, settings:object, trendFor:Function, latestRow?:object|null, bands?:object|null, deviationsFor?:Function, yieldFn?:Function}} p
 */
export async function compareSeriesFor({ agent = '', key, metrics = [], from, to, settings = {}, trendFor, latestRow = null, bands = null, deviationsFor = null, yieldFn = async () => {} } = {}) {
  const out = {};
  let res = null; let stepMs = null;
  for (const col of metrics.filter((c) => SERIES_COLS.includes(c))) {
    let r;
    try { r = await trendFor({ agent, key, q: { metric: col, from, to, res: 'auto' }, settings }); } catch (e) { r = { ok: false, reason: String(e?.message || e).slice(0, 160) }; }
    if (!r || !r.ok) { out[col] = { error: String(r?.reason || '읽지 못했습니다').slice(0, 160) }; await yieldFn(); continue; }
    res = res || r.res; stepMs = stepMs || r.stepMs;
    out[col] = { ...seriesStats(r.points, { from: r.from, to: r.to, stepMs: r.stepMs }), ...(r.truncated ? { truncated: r.truncated } : {}), ...(r.missingPeriods?.length ? { missingPeriods: r.missingPeriods.length } : {}) };
    await yieldFn();
  }
  const dev = bands && typeof deviationsFor === 'function' && latestRow ? deviationsFor(bands, key, latestRow) : null;
  return { ok: true, key, from, to, res, stepMs, metrics: out, ...(dev ? { dev } : {}) };
}

/** 베이스라인 이탈이 가장 큰 지표(순수) — |ratio − 1| 최대. 띠가 하나도 없으면 사유(첫 사유). */
export function worstDeviation(dev) {
  if (!dev || typeof dev !== 'object') return null;
  let best = null; let reason = null;
  for (const [m, d] of Object.entries(dev)) {
    if (!d || typeof d !== 'object') continue;
    if (d.reason) { reason = reason || d.reason; continue; }
    const ratio = n(d.ratio);
    if (ratio == null) continue;
    if (!best || Math.abs(ratio - 1) > Math.abs(best.ratio - 1)) best = { metric: m, ratio, out: d.out };
  }
  return best || (reason ? { reason } : null);
}

/** 행 눈금(순수) — 고정 눈금이 있으면 그것, 없으면 그 행 최대의 보기 좋은 올림(값이 하나도 없으면 null). */
export function niceCeil(v) {
  const x = n(v);
  if (x == null || x <= 0) return null;
  const p = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (x <= m * p) return r2(m * p);
  return r2(10 * p);
}

/**
 * 비교 표(순수). columns: [{ key, state, purposeGroup, series:{metrics}, hwValues, verdict, devWorst }] — state 가 'ok' 또는 'stale'(보관분) 인 열만 값을 낸다.
 *  · 행마다 셀 { key, now:{avg,peak}, win:{avg,peak}, clipped } · dev(max÷min — 결측 뺀 열 2개 이상 · 최소 > 0) · top(최고 열 key) · devHigh · skew.
 *  · value 모드(avgpeak · avg · peak)는 편차 · 최고 판정에 쓸 값을 고른다(avgpeak 이면 피크가 있으면 피크, 없으면 평균).
 */
export function buildCompareTable(columns = [], { metrics = [], value = 'avgpeak' } = {}) {
  const live = columns.filter((c) => c && (c.state === 'ok' || c.state === 'stale'));
  const pick = (cell) => {
    if (!cell) return null;
    if (value === 'avg') return n(cell.win?.avg);
    if (value === 'peak') return n(cell.win?.peak);
    return n(cell.win?.peak) ?? n(cell.win?.avg);
  };
  const rows = [];
  for (const col of metrics) {
    const meta = META.get(col);
    if (!meta) continue;
    const cells = live.map((c) => {
      if (meta.src === 'hw') {
        const v = n(c.hwValues?.[col]);
        return { key: c.key, now: { avg: v, peak: null }, win: { avg: v, peak: null }, hwOnly: true };
      }
      const s = c.series?.[col];
      if (!s || s.error) return { key: c.key, now: null, win: null, ...(s?.error ? { error: true } : {}) };
      return { key: c.key, now: s.last ? { avg: s.last.avg, peak: s.last.peak } : null, win: { avg: s.avg, peak: s.peak }, missing: s.missing ?? null, expected: s.expected ?? null };
    });
    const peaks = cells.map((x) => n(x.win?.peak) ?? n(x.win?.avg) ?? n(x.now?.peak) ?? n(x.now?.avg)).filter((v) => v != null);
    const scale = meta.scaleMax ?? niceCeil(peaks.length ? Math.max(...peaks) : null);
    for (const x of cells) {
      const top = n(x.win?.peak) ?? n(x.now?.peak);
      x.clipped = meta.scaleMax != null && top != null && top > meta.scaleMax;
    }
    const vals = cells.map((x) => ({ key: x.key, v: pick(x) })).filter((x) => x.v != null);
    let dev = null; let top = null;
    if (vals.length >= 2) {
      const max = Math.max(...vals.map((x) => x.v)); const min = Math.min(...vals.map((x) => x.v));
      dev = min > 0 ? r2(max / min) : null;
      top = vals.find((x) => x.v === max)?.key ?? null;
    }
    // 스큐 후보 — 같은 용도 그룹(3대 이상 값 있음)에서 1위가 2위의 SKEW_RATIO 배 이상.
    let skew = null;
    const groups = new Map();
    for (const x of vals) {
      const g = live.find((c) => c.key === x.key)?.purposeGroup;
      if (!g) continue;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(x);
    }
    for (const [g, arr] of groups) {
      if (arr.length < SKEW_MIN_GROUP) continue;
      const s = [...arr].sort((a, b) => b.v - a.v);
      if (s[1].v > 0 ? s[0].v >= s[1].v * SKEW_RATIO : s[0].v > 0) { skew = { group: g, key: s[0].key }; break; }
    }
    rows.push({ col, unit: meta.unit, src: meta.src, scale, cells, dev, devHigh: dev != null && dev >= DEV_HIGH_RATIO, top, skew });
  }
  const verdicts = live.map((c) => ({ key: c.key, verdict: c.verdict ?? null }));
  const baseline = live.map((c) => ({ key: c.key, worst: c.devWorst ?? null }));
  return { rows, verdicts, baseline, devHighRatio: DEV_HIGH_RATIO, skewRatio: SKEW_RATIO, skewMinGroup: SKEW_MIN_GROUP, value };
}
