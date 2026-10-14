/**
 * xferspeed/analyze.js — 법인 간 전송 속도 판정·요약(순수, v2.735). 라우트가 DB 행·등록부·설정을 넘긴다.
 *
 * 판정 규칙(화면이 이 결과만 읽는다 — 웹에서 다시 판정하지 않는다):
 *  · 상태는 여섯이다 — `ok` / `slow` / `fail` / `stale` / `no-data` / `excluded`.
 *    ⚠ '측정이 없다' 를 정상으로 칠하지 않는다(`no-data`·`stale` 은 회색). 이 화면 최악의 거짓이다.
 *  · `slow` 는 **그 법인 자신의 평소**(최근 7일 성공 측정의 중앙값)와 비교한다 — 법인마다 회선이 달라 절대 임계를 정하지 않는다.
 *    평소를 정할 표본이 `MIN_BASELINE` 미만이면 판정하지 않는다(`vsPct:null`).
 *  · 경계(오래됨)는 **설정 주기**에서 계산한다 — 숫자를 박지 않는다(간격 실행 `max(간격×3, 2시간)`,
 *    예약만 쓰면 `max(실행 시각 사이 가장 긴 간격×1.5, 2시간)`, 반복 예약도 없으면 판정하지 않는다 — 정해진 주기가 없다).
 *  · 결측은 null 이다 — 실패 측정의 속도를 0 으로 세지 않는다(평균·중앙값 분모에 넣지 않는다).
 *  · 시간대 히트맵의 칸은 '그 법인 평소 대비' 비율이다(절대 색이면 빠른 법인만 밝고 나머지는 전부 어둡다).
 *    하루 경계·시각은 포탈 시각(`util/dayKey.js` 오프셋 — 기본 한국 시각).
 */
import { numOrNull } from '../util/numOrNull.js';
import { DAY_OFFSET_MIN } from '../util/dayKey.js';
import { cadenceMs, runsPerDay } from './schedule.js';

export const STATES = Object.freeze(['ok', 'slow', 'fail', 'stale', 'no-data', 'excluded']);
export const MIN_BASELINE = 6;
export const BASELINE_DAYS = 7;
export const SPARK_HOURS = 24;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const t = (v) => String(v ?? '').trim();
const lc = (v) => t(v).toLowerCase();

/** 정렬된 배열의 분위수(선형 보간). 빈 배열이면 null. */
export function quantile(sorted, q) {
  if (!Array.isArray(sorted) || !sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos); const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

/**
 * 지연(연결 + 왕복, ms) — 측정 행 하나(DB 행·화면 행 모두).
 *  · ↓ 엣지 → 메인: 저장된 `ttfb`(요청 → 응답 머리).
 *  · ↑ 메인 → 엣지: 응답 머리는 업로드가 끝나야 오므로 `ttfb` 가 뜻이 없다 — **전체 − 엣지 수신 구간**(받는 쪽 기준일 때만)이
 *    같은 뜻(데이터가 흐르기 전·후의 연결·왕복)이다. 2.735.2 이전 ↑ 행은 `ttfb` 가 비어 있으므로 읽을 때 같은 식으로 구한다.
 *    보내는 쪽 전체 시간 기준(`sender-total` — 버퍼링 프록시)이면 수신 구간이 LAN 구간이라 구하지 않는다(null).
 */
export function latencyMsOf(r) {
  const tb = numOrNull(r?.ttfb_ms ?? r?.ttfbMs);
  if (tb != null && tb >= 0) return Math.round(tb);
  if (r?.dir !== 'up' || r?.basis !== 'receiver') return null;
  const total = numOrNull(r?.total_ms ?? r?.totalMs);
  const xfer = numOrNull(r?.xfer_ms ?? r?.xferMs);
  if (total == null || xfer == null) return null;
  const d = Math.round(total - xfer);
  return d >= 0 ? d : null;
}

/** 측정 행 묶음 → 통계(성공 측정만 속도 통계에, 성공률은 전부). */
export function statsOf(rows = []) {
  const okVals = [];
  const ttfb = [];
  let total = 0; let ok = 0;
  for (const r of rows) {
    total += 1;
    if (Number(r?.ok) === 1 || r?.ok === true) {
      const v = numOrNull(r.mbps);
      if (v != null && v > 0) { okVals.push(v); ok += 1; }
      const tb = latencyMsOf(r);
      if (tb != null) ttfb.push(tb);
    }
  }
  okVals.sort((a, b) => a - b);
  ttfb.sort((a, b) => a - b);
  const sum = okVals.reduce((a, b) => a + b, 0);
  return {
    n: total, ok, okRate: total ? round2((ok / total) * 100) : null,
    avg: okVals.length ? round2(sum / okVals.length) : null,
    median: round2(quantile(okVals, 0.5)), p10: round2(quantile(okVals, 0.1)),
    min: okVals.length ? round2(okVals[0]) : null, max: okVals.length ? round2(okVals[okVals.length - 1]) : null,
    ttfbMedian: ttfb.length ? Math.round(quantile(ttfb, 0.5)) : null,
  };
}

/**
 * 오래됨 경계(ms) — 설정에서. 숫자(간격)를 주면 예전 규칙 그대로다.
 * 설정 객체면: 간격 실행 켬 → `max(간격×3, 2시간)` · 예약만 → `max(가장 긴 실행 간격×1.5, 2시간)` · 반복 예약도 없음 → null(판정 안 함).
 */
export function staleMsOf(arg, opts = {}) {
  if (arg && typeof arg === 'object') {
    if (arg.intervalOn !== false) return Math.max((numOrNull(arg.intervalMs) ?? 30 * 60_000) * 3, 2 * HOUR);
    const cad = cadenceMs(arg, opts);
    return cad == null ? null : Math.max(Math.round(cad * 1.5), 2 * HOUR);
  }
  const iv = numOrNull(arg) ?? 30 * 60_000;
  return Math.max(iv * 3, 2 * HOUR);
}

/** 최신 행(DB) → 화면 모양. */
function latestView(r) {
  if (!r) return null;
  return {
    ts: numOrNull(r.ts), ok: Number(r.ok) === 1,
    mbps: Number(r.ok) === 1 ? numOrNull(r.mbps) : null,
    ttfbMs: latencyMsOf(r), totalMs: numOrNull(r.total_ms), xferMs: numOrNull(r.xfer_ms), bytes: numOrNull(r.bytes),
    basis: r.basis || null, kind: r.kind || null, error: r.err || '',
    failStreak: numOrNull(r.fail_streak) ?? 0, lastOkTs: numOrNull(r.last_ok_ts), lastOkMbps: numOrNull(r.last_ok_mbps),
  };
}

/**
 * 법인(엣지)별 요약.
 * @param {object} p
 * @param {Array} p.collectors   수집 서버 등록부(토큰 없는 공개 모양이면 충분 — id·name·datacenter·url·enabled)
 * @param {Array} p.latest       DB xfer_latest 행
 * @param {Array} p.recent       DB 최근 7일 원시 행(agent·dir·ts·ok·mbps·ttfb_ms)
 * @param {object} p.settings    정규화된 설정(intervalMs·slowPct·excluded)
 * @param {number} [p.now]
 */
export function edgeRows({ collectors = [], latest = [], recent = [], settings = {}, now = Date.now(), originOf = null } = {}) {
  const staleMs = staleMsOf(settings, { now });
  const slowPct = numOrNull(settings.slowPct) ?? 70;
  const excl = new Set((settings.excluded || []).map(lc));
  const latestBy = new Map();
  for (const r of latest) latestBy.set(`${lc(r.agent)}|${r.dir}`, r);
  const recentBy = new Map();
  const sparkFrom = now - SPARK_HOURS * HOUR;
  const baseFrom = now - BASELINE_DAYS * DAY;
  for (const r of recent) {
    const ts = numOrNull(r.ts);
    if (ts == null || ts < baseFrom) continue;
    const k = `${lc(r.agent)}|${r.dir}`;
    if (!recentBy.has(k)) recentBy.set(k, []);
    recentBy.get(k).push(r);
  }

  // 등록부에 없는데 기록만 있는 엣지(삭제·이름 변경)도 행으로 남긴다 — 이름이 바뀐 것 자체가 진단이다.
  const known = new Map();
  for (const c of collectors) {
    const id = t(c?.id || c?.name);
    if (!id) continue;
    known.set(lc(id), { id, name: t(c.name) || id, datacenter: t(c.datacenter), enabled: c.enabled !== false, hasUrl: !!t(c.url), registered: true, origin: originOf ? originOf(c) : null });
  }
  for (const r of latest) {
    const k = lc(r.agent);
    if (!known.has(k)) known.set(k, { id: t(r.agent), name: t(r.agent), datacenter: '', enabled: false, hasUrl: false, registered: false, origin: null });
  }

  const rows = [];
  for (const [k, e] of known) {
    const dirs = {};
    for (const dir of ['down', 'up']) {
      const lat = latestView(latestBy.get(`${k}|${dir}`));
      const rec = recentBy.get(`${k}|${dir}`) || [];
      const base = statsOf(rec);
      const last24 = statsOf(rec.filter((r) => numOrNull(r.ts) >= sparkFrom));
      const spark = rec.filter((r) => numOrNull(r.ts) >= sparkFrom).map((r) => [numOrNull(r.ts), Number(r.ok) === 1 ? numOrNull(r.mbps) : null]);
      const baseOk = base.ok >= MIN_BASELINE && base.median != null && base.median > 0;
      const vsPct = lat?.ok && lat.mbps != null && baseOk ? Math.round((lat.mbps / base.median) * 100) : null;
      dirs[dir] = { latest: lat, baseline: baseOk ? base.median : null, baselineN: base.ok, week: base, day: last24, spark, vsPct };
    }
    const lats = [dirs.down.latest, dirs.up.latest].filter(Boolean);
    const newest = lats.length ? Math.max(...lats.map((l) => l.ts || 0)) : null;
    const vsList = [dirs.down.vsPct, dirs.up.vsPct].filter((v) => v != null);
    const vsPct = vsList.length ? Math.min(...vsList) : null;
    let state; let reason = '';
    if (excl.has(k) || excl.has(lc(e.name))) { state = 'excluded'; reason = 'excluded'; }
    else if (!lats.length) { state = 'no-data'; reason = !e.registered ? 'unregistered' : !e.enabled ? 'disabled-central' : !e.hasUrl ? 'no-url' : 'never'; }
    else if (newest != null && staleMs != null && now - newest > staleMs) { state = 'stale'; reason = !e.registered ? 'unregistered' : 'old'; }
    else if (lats.some((l) => !l.ok)) { state = 'fail'; reason = (lats.find((l) => !l.ok)?.kind) || 'http'; }   // 사유 = 실패 종류(XFER_FAIL_KINDS)
    else if (vsPct != null && vsPct < slowPct) { state = 'slow'; reason = 'below-baseline'; }
    else {
      state = 'ok';
      // 평소 기준이 없는 방향이 있으면 그 사실을 남긴다 — '정상' 이 두 방향 모두 평소와 비교한 결과라고 읽히지 않게.
      reason = vsPct == null ? 'no-baseline' : vsList.length < 2 ? 'partial-baseline' : '';
    }
    rows.push({ ...e, state, reason, vsPct, newestTs: newest, down: dirs.down, up: dirs.up });
  }
  return rows;
}

/** 머리 KPI — 겹치지 않게 센다: 합계 = 정상 + 느림 + 실패 + 오래됨 + 측정 없음 (+ 제외는 따로). */
export function kpisOf(rows = []) {
  const count = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const r of rows) count[r.state] = (count[r.state] || 0) + 1;
  const active = rows.filter((r) => r.state !== 'excluded');
  const fresh = active.filter((r) => r.state === 'ok' || r.state === 'slow' || r.state === 'fail');
  const vals = (dir) => fresh.map((r) => r[dir].latest).filter((l) => l?.ok && l.mbps != null).map((l) => l.mbps).sort((a, b) => a - b);
  const down = vals('down'); const up = vals('up');
  let slowest = null;
  for (const r of fresh) for (const dir of ['down', 'up']) {
    const l = r[dir].latest;
    if (l?.ok && l.mbps != null && (!slowest || l.mbps < slowest.mbps)) slowest = { id: r.id, name: r.name, dir, mbps: l.mbps };
  }
  return {
    total: active.length, ...count,
    measured: fresh.length,
    downMedian: round2(quantile(down, 0.5)), upMedian: round2(quantile(up, 0.5)),
    slowest,
  };
}

/** 회선 사용 산수 — 화면이 숫자를 박지 않게 서버가 계산한다. */
export function trafficOf(settings = {}, targetCount = 0) {
  const sizeMB = numOrNull(settings.sizeMB) ?? 10;
  const iv = numOrNull(settings.intervalMs) ?? 30 * 60_000;
  const intervalOn = settings.intervalOn !== false;
  const intervalRuns = intervalOn ? Math.floor(DAY / Math.max(60_000, iv)) : 0;
  // 하루 평균 실행 = 간격 + 반복 예약(매주·매월은 하루 평균으로 나눈다). 예약 실행이 간격을 다시 세게 하므로 **최대치**다.
  const cycles = runsPerDay({ ...settings, intervalOn, intervalMs: iv });
  const scheds = Array.isArray(settings.schedules) ? settings.schedules.filter((x) => x?.enabled) : [];
  const perEdgeCycle = sizeMB * 1_048_576 * 2;
  return {
    sizeMB, intervalMs: iv, intervalOn, cyclesPerDay: cycles, targets: targetCount,
    intervalRunsPerDay: intervalRuns, scheduleRunsPerDay: Math.round((cycles - intervalRuns) * 100) / 100,
    onceSchedules: scheds.filter((x) => x.kind === 'once').length,
    bytesPerCycle: perEdgeCycle * targetCount,
    bytesPerDayCentral: Math.round(perEdgeCycle * targetCount * cycles),
    bytesPerDayEdge: Math.round(perEdgeCycle * cycles),
  };
}

/** 포탈 시각의 시(0~23). */
export function localHour(ts, offsetMin = DAY_OFFSET_MIN) {
  return Math.floor((((Number(ts) + offsetMin * 60_000) % DAY) + DAY) % DAY / HOUR);
}

/**
 * 시간대 히트맵 — 엣지 × 24시간(포탈 시각) × 방향. 칸 값 = 그 시간 성공 측정 평균 ÷ 그 엣지 기간 중앙값.
 * 측정이 없는 칸은 null(빈 칸 — 0 이 아니다).
 */
export function heatOf(samples = [], { offsetMin = DAY_OFFSET_MIN } = {}) {
  const by = new Map();
  for (const r of samples) {
    if (!(Number(r?.ok) === 1)) continue;
    const v = numOrNull(r.mbps);
    const ts = numOrNull(r.ts);
    if (v == null || v <= 0 || ts == null) continue;
    const k = `${t(r.agent)}|${r.dir}`;
    if (!by.has(k)) by.set(k, { agent: t(r.agent), dir: r.dir, all: [], hours: Array.from({ length: 24 }, () => ({ sum: 0, n: 0 })) });
    const e = by.get(k);
    e.all.push(v);
    const h = localHour(ts, offsetMin);
    e.hours[h].sum += v; e.hours[h].n += 1;
  }
  const out = [];
  for (const e of by.values()) {
    e.all.sort((a, b) => a - b);
    const med = quantile(e.all, 0.5);
    out.push({
      agent: e.agent, dir: e.dir, median: round2(med), n: e.all.length,
      hours: e.hours.map((h) => (h.n ? { avg: round2(h.sum / h.n), n: h.n, ratio: med ? round2(h.sum / h.n / med) : null } : null)),
    });
  }
  return out;
}

/** 원시 행 → 차트 점(성공은 값, 실패는 null + fail 표지). */
export function seriesOf(rows = []) {
  const down = []; const up = [];
  for (const r of rows) {
    const p = { ts: numOrNull(r.ts), mbps: Number(r.ok) === 1 ? numOrNull(r.mbps) : null, ok: Number(r.ok) === 1, kind: r.kind || null };
    if (r.dir === 'down') down.push(p); else if (r.dir === 'up') up.push(p);
  }
  return { down, up };
}

/** 일 요약 행 → 차트 점(하루 평균·최저·최고 + 성공률). 평균은 성공 측정만의 평균이다. */
export function dailySeriesOf(rows = []) {
  const down = []; const up = [];
  for (const r of rows) {
    const okN = numOrNull(r.ok_n) ?? 0;
    const p = {
      day: r.day, n: numOrNull(r.n) ?? 0, okN,
      avg: okN > 0 ? round2((numOrNull(r.mbps_sum) ?? 0) / okN) : null,
      min: okN > 0 ? numOrNull(r.mbps_min) : null, max: okN > 0 ? numOrNull(r.mbps_max) : null,
      ttfbAvg: numOrNull(r.ttfb_n) ? Math.round((numOrNull(r.ttfb_sum) ?? 0) / numOrNull(r.ttfb_n)) : null,
    };
    if (r.dir === 'down') down.push(p); else if (r.dir === 'up') up.push(p);
  }
  return { down, up };
}
