/**
 * bmusage/baseline.js — **베이스라인 이탈**(v2.929 예정 · 리눅스 성능 5단계 · 설계 PROFILES §14 ② · 아트보드 Alerts).
 *
 * 베이스라인 = 지난 N주(설정 4) **같은 요일 · 같은 시각**의 1시간 롤업 평균. 띠 = 평균 × (1 ± bandPct%)(설정 40). ML 없음.
 *   · 표본(주)이 minWeeks 미만이거나 그 시간들의 결측 비율이 maxMissingPct 를 넘으면 **띠 없음**(reason) — 규칙도 걸리지 않는다.
 *   · 휴일 · 월말 같은 달력 효과는 모른다(화면이 말한다). ‘원래 높은’ 새벽 백업 창은 띠도 같이 높아 이탈로 세지 않는다.
 *   · 한 시간의 기대 표본 수 = 1시간 ÷ 수집 주기(5분이면 12) — 그 시간 롤업의 samples 가 절반 미만이면 그 주는 결측으로 센다(추정 기준 — 설정 아님).
 *
 * 순수 함수(slotHours · bandOf · bandSeries · deviationOf)와 읽기(readSlotMeans · readBandSeries — 시간 단위 파일 monthStore)를 나눈다.
 * ⚠ 요청 경로 블로킹 금지: 띠 계산은 시간 수만큼 돌고 createYielder 로 양보한다 · 결과는 10분 메모(같은 서버 · 지표 · 시간 창) ·
 *   슬롯 평균(전 서버 · 현재 시간)은 **한 시간에 한 번** 파일마다 `h IN (…)` 한 문장(usage_hourly h 인덱스)으로 읽는다.
 */
import { numOrNull } from '../util/numOrNull.js';
import { createYielder } from '../util/timeSlice.js';
import { prefixOf } from './trendWindow.js';
import { BASELINE_METRICS } from './perfRules.js';

const n = numOrNull;
const HOUR = 3_600_000;
const WEEK = 7 * 86_400_000;
export const hourStart = (t) => Math.floor(Number(t) / HOUR) * HOUR;

/** 그 시각이 속한 시간의 지난 weeks 주 같은 요일 · 같은 시각(시간 시작 ms, 가까운 주부터). 시간대와 무관하다(정확히 7일 배수). */
export function slotHours(at, weeks = 4) {
  const h = hourStart(at);
  return Array.from({ length: Math.max(0, Math.floor(weeks)) }, (_, i) => h - (i + 1) * WEEK);
}

/**
 * 한 슬롯의 띠(순수).
 * @param {Array<{h:number, avg:number|null, samples:number|null}>} weekly  slotHours 의 각 주(없는 주는 avg null)
 * @param {{bandPct:number, minWeeks:number, maxMissingPct:number, expectedPerHour:number}} cfg
 * @returns {{mean:number, lo:number, hi:number, weeks:number, missingPct:number}|{reason:string, weeks:number, missingPct:number}}
 */
export function bandOf(weekly = [], { bandPct = 40, minWeeks = 4, maxMissingPct = 25, expectedPerHour = 12 } = {}) {
  const exp = Math.max(1, Number(expectedPerHour) || 12);
  let have = 0; let got = 0; const vals = [];
  for (const w of weekly) {
    const s = n(w?.samples) ?? 0;
    got += Math.min(exp, s);
    if (n(w?.avg) != null && s >= exp / 2) { vals.push(n(w.avg)); have += 1; }
  }
  const total = weekly.length * exp;
  const missingPct = total > 0 ? Math.round(((total - got) / total) * 1000) / 10 : 100;
  if (have < minWeeks) return { reason: have === 0 ? 'no-history' : 'few-weeks', weeks: have, missingPct };
  if (missingPct > maxMissingPct) return { reason: 'missing', weeks: have, missingPct };
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const p = Math.max(0, Number(bandPct) || 0) / 100;
  const r2 = (v) => Math.round(v * 100) / 100;
  return { mean: r2(mean), lo: r2(mean * (1 - p)), hi: r2(mean * (1 + p)), weeks: have, missingPct };
}

/** 지금 값의 이탈(순수) — 띠가 없으면 null. ratio = 값 ÷ 평균(평균이 0 이면 null — 0 으로 나누지 않는다). */
export function deviationOf(value, band) {
  const v = n(value);
  if (v == null || !band || band.reason || n(band.mean) == null) return null;
  const ratio = band.mean > 0 ? Math.round((v / band.mean) * 100) / 100 : null;
  const out = v > band.hi ? 'above' : v < band.lo ? 'below' : 'in';
  return { value: v, ratio, out, mean: band.mean, lo: band.lo, hi: band.hi };
}

/** 1시간 롤업 행 → { h → { avg, samples } } (한 지표). 평균 = 합 ÷ 개수(개수 0 이면 null). */
export function hourlyAvgMap(rows = [], metric) {
  const p = prefixOf(metric);
  const m = new Map();
  for (const r of rows || []) {
    const h = n(r.h); if (h == null) continue;
    const cnt = n(r[`${p}_n`]); const sum = n(r[`${p}_sum`]);
    m.set(h, { avg: cnt != null && cnt > 0 && sum != null ? sum / cnt : null, samples: cnt ?? 0 });
  }
  return m;
}

/**
 * 시간 창의 띠 계열(순수 · 양보는 호출부 — yieldFn).
 * @param {Map} avgMap   hourlyAvgMap(창 시작 − weeks 주 ~ 창 끝)
 * @returns {Promise<Array<{t:number, mean?:number, lo?:number, hi?:number, reason?:string}>>}
 */
export async function bandSeries(avgMap, { from, to, cfg, yieldFn = async () => {} } = {}) {
  const out = [];
  for (let h = hourStart(from); h <= to; h += HOUR) {
    const weekly = slotHours(h + 1, cfg.weeks).map((x) => ({ h: x, ...(avgMap.get(x) || { avg: null, samples: 0 }) }));
    const b = bandOf(weekly, cfg);
    out.push({ t: h, ...(b.reason ? { reason: b.reason, weeks: b.weeks } : { mean: b.mean, lo: b.lo, hi: b.hi, weeks: b.weeks }) });
    await yieldFn();
  }
  return out;
}

/* ── 읽기(시간 단위 파일) ─────────────────────────────────────────────── */
const _memo = new Map();   // `${agent}|${key}|${metric}|${fromH}|${toH}|${cfgSig}` → { at, value }
const MEMO_MS = 10 * 60_000;
const MEMO_MAX = 500;
/** 띠 계열 하나(라우트 · 엣지 대행 공용). 창은 최대 14일(띠는 시간 단위라 그 이상은 1시간 점이 너무 많다 — 넘으면 끝에서 14일). */
export const BAND_MAX_SPAN_MS = 14 * 86_400_000;
export async function readBandSeries({ agent = '', key, metric, from, to, cfg, intervalMs = 300_000, now = Date.now(), deps = {} } = {}) {
  if (!BASELINE_METRICS.includes(metric)) return { ok: false, __status: 400, reason: `베이스라인 지표가 아닙니다(${BASELINE_METRICS.join('·')})` };
  let a = n(from); let b = n(to);
  if (b == null || b > now) b = now;
  if (a == null) a = b - 86_400_000;
  if (!(a < b)) return { ok: false, __status: 400, reason: 'from 이 to 보다 앞이어야 합니다.' };
  let capped = false;
  if (b - a > BAND_MAX_SPAN_MS) { a = b - BAND_MAX_SPAN_MS; capped = true; }
  const c = { ...cfg, expectedPerHour: Math.max(1, Math.round(HOUR / Math.max(60_000, Number(intervalMs) || 300_000))) };
  const memoKey = `${agent}|${key}|${metric}|${hourStart(a)}|${hourStart(b)}|${c.weeks}|${c.bandPct}|${c.minWeeks}|${c.maxMissingPct}|${c.expectedPerHour}`;
  const hit = _memo.get(memoKey);
  if (hit && now - hit.at < MEMO_MS) return { ...hit.value, cached: true };
  const read = deps.readHourlyRange || (async (o) => (await import('./monthStore.js')).readHourlyRange(o));
  const r = await read({ agent, key, from: hourStart(a) - c.weeks * WEEK, to: b });
  const avgMap = hourlyAvgMap(r.rows || [], metric);
  const y = createYielder(15);
  const series = await bandSeries(avgMap, { from: a, to: b, cfg: c, yieldFn: y });
  const value = { ok: true, key, metric, from: a, to: b, weeks: c.weeks, bandPct: c.bandPct, minWeeks: c.minWeeks, maxMissingPct: c.maxMissingPct, series,
    ...(capped ? { capped: true } : {}), ...((r.missingPeriods || []).length ? { missingPeriods: (r.missingPeriods || []).filter((x) => x.reason !== 'none').slice(0, 16) } : {}) };
  _memo.set(memoKey, { at: now, value });
  if (_memo.size > MEMO_MAX) _memo.delete(_memo.keys().next().value);
  return value;
}

/**
 * 지금 시간의 슬롯 평균(전 서버 · 감시 지표) — 한 시간에 한 번 계산해 둔다(알림 규칙 · 이탈 배수가 매 주기 쓴다).
 *   파일마다 `SELECT … FROM usage_hourly WHERE agent=? AND h IN (?,?,?,?)` 한 문장(h 인덱스). 반환 Map(key → Map(metric → band)).
 */
let _slot = null;   // { h, cfgSig, at, bands: Map }
export async function slotBands({ agent = '', cfg, intervalMs = 300_000, now = Date.now(), deps = {} } = {}) {
  const h = hourStart(now);
  const c = { ...cfg, expectedPerHour: Math.max(1, Math.round(HOUR / Math.max(60_000, Number(intervalMs) || 300_000))) };
  const sig = `${agent}|${c.weeks}|${c.bandPct}|${c.minWeeks}|${c.maxMissingPct}|${c.expectedPerHour}`;
  if (_slot && _slot.h === h && _slot.cfgSig === sig) return _slot.bands;
  const hours = slotHours(now, c.weeks);
  const forEach = deps.forEachPeriod || (async (...a) => (await import('./monthStore.js')).forEachPeriod(...a));
  const rows = [];
  const cols = [...new Set(BASELINE_METRICS.flatMap((m) => [`${prefixOf(m)}_sum`, `${prefixOf(m)}_n`]))];
  if (hours.length) {
    await forEach('h1', Math.min(...hours), Math.max(...hours) + HOUR - 1, (db) => {
      const got = db.prepare(`SELECT key, h, ${cols.join(',')} FROM usage_hourly WHERE agent=? AND h IN (${hours.map(() => '?').join(',')})`).all(String(agent), ...hours);
      for (const r of got) rows.push(r);
    });
  }
  const byKey = new Map();
  for (const r of rows) { if (!byKey.has(r.key)) byKey.set(r.key, []); byKey.get(r.key).push(r); }
  const bands = new Map();
  for (const [key, list] of byKey) {
    const per = new Map();
    for (const m of BASELINE_METRICS) {
      const am = hourlyAvgMap(list, m);
      per.set(m, bandOf(hours.map((x) => ({ h: x, ...(am.get(x) || { avg: null, samples: 0 }) })), c));
    }
    bands.set(key, per);
  }
  _slot = { h, cfgSig: sig, at: now, bands };
  return bands;
}
/** 한 서버의 이탈(감시 지표마다) — 띠가 없으면 그 지표는 null. */
export function deviationsFor(bands, key, row = {}) {
  const per = bands?.get?.(key);
  const out = {};
  for (const m of BASELINE_METRICS) {
    const b = per?.get?.(m) || null;
    out[m] = b && !b.reason ? deviationOf(row[m], b) : (b ? { reason: b.reason, weeks: b.weeks } : { reason: 'no-history', weeks: 0 });
  }
  return out;
}
export function _resetBaselineForTest() { _memo.clear(); _slot = null; }
