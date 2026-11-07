/**
 * bmusage/compare.js — **구간 비교**(A/B · v2.929 예정 · 리눅스 성능 5단계 · 설계 PROFILES §14 ④ · 아트보드 Compare).
 *
 * 규칙(아트보드 · 되돌리지 말 것):
 *   · **같은 길이 · 같은 롤업만** — 길이가 다르면 짧은 쪽에 맞추고(lengthAdjusted) 해상도는 두 구간 중 거친 쪽 하나(5분 < 1시간 < 1일)로 둘 다 읽는다.
 *   · **결측은 양쪽에서 뺀다** — 같은 상대 위치(구간 시작으로부터의 칸)에 두 쪽 다 값이 있을 때만 쓴다. 뺀 칸 수를 지표마다 밝힌다(0 으로 채우지 않는다).
 *   · 차이 % = (B − A) ÷ A × 100 — A 가 0 이거나 없으면 null(0 으로 나누지 않는다). ±diffPct(설정 20) 밖이면 표시(out).
 *   · 프로세스 상위 차이는 **스냅샷이 있는 구간만**(진단 스냅샷 보관분 · 집중 모니터링 경량 스냅샷) — 없으면 ‘스냅샷 없음’.
 *   · 튜닝 값 차이는 change_event(전이 기록)에서 A 끝 ~ B 끝 사이에 바뀐 것만 — 그 시점 값을 다시 읽지 않는다(내용 보관 금지 · 전이만).
 *   · USE 판정의 과거 값은 저장하지 않는다(5분 원시에 판정 칸이 없다) — 판정 행은 만들지 않았다(정직 기록 — 아트보드와 다른 점).
 */
import { numOrNull } from '../util/numOrNull.js';
import { createYielder } from '../util/timeSlice.js';
import { toPoints, pickRes, RES_MS } from './trendWindow.js';
import { STORE_DEFAULTS, effectiveRawDays } from './settings.js';
import { PEAK_COLS } from './perfCols.js';
import { DAY_OFFSET_MIN } from '../util/dayKey.js';

const n = numOrNull;
export const COMPARE_METRICS = Object.freeze(['cpu_pct', 'cpu_iowait_pct', 'runq_per_core', 'disk_busy_pct', 'disk_await_ms', 'disk_aqu', 'mem_pct', 'swap_out_ps', 'net_pct']);
export const COMPARE_MAX_SPAN_MS = 31 * 86_400_000;
const RES_ORDER = ['5m', '1h', '1d'];
const TUNING_KINDS = new Set(['sysctl', 'sysctl-file', 'sysctl-all', 'tuned', 'kernel', 'cron', 'selinux', 'firewalld', 'reboot', 'package', 'needs-restart']);
const dayStart = (day) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) - DAY_OFFSET_MIN * 60_000;

/** 요청 → 두 구간(순수). 실패면 { error }. */
export function normalizePair({ aFrom, aTo, bFrom, bTo } = {}, now = Date.now()) {
  const a0 = n(aFrom); let a1 = n(aTo); const b0 = n(bFrom); let b1 = n(bTo);
  if ([a0, a1, b0, b1].some((x) => x == null)) return { error: 'aFrom · aTo · bFrom · bTo 가 모두 필요합니다(ms).' };
  if (a1 > now) a1 = now; if (b1 > now) b1 = now;
  if (!(a0 < a1) || !(b0 < b1)) return { error: '각 구간의 시작이 끝보다 앞이어야 합니다.' };
  const la = a1 - a0; const lb = b1 - b0;
  const len = Math.min(la, lb, COMPARE_MAX_SPAN_MS);
  return { a: { from: a0, to: a0 + len }, b: { from: b0, to: b0 + len }, len, lengthAdjusted: la !== lb || Math.max(la, lb) > COMPARE_MAX_SPAN_MS, origLen: { a: la, b: lb } };
}

/**
 * 지표 하나의 비교(순수) — 두 점 열을 같은 상대 칸으로 짝지어 양쪽 다 값이 있는 칸만 쓴다.
 * @returns {{a:{avg,peak,n}, b:{avg,peak,n}, diffAvgPct, diffPeakPct, out:{avg:boolean,peak:boolean}, missingA, missingB, pairs}}
 */
export function compareMetric(ptsA = [], ptsB = [], { fromA, fromB, stepMs, slots, diffPct = 20 } = {}) {
  const idx = (t, from) => Math.round((t - from) / stepMs);
  const mapOf = (pts, from) => { const m = new Map(); for (const p of pts) { if (p.avg == null && p.max == null && p.peak == null) continue; m.set(idx(p.t, from), p); } return m; };
  const A = mapOf(ptsA, fromA); const B = mapOf(ptsB, fromB);
  const both = [...A.keys()].filter((k) => B.has(k) && k >= 0 && k < slots);
  const avg = (list) => (list.length ? Math.round((list.reduce((s, v) => s + v, 0) / list.length) * 100) / 100 : null);
  const side = (M) => {
    const av = both.map((k) => n(M.get(k).avg)).filter((v) => v != null);
    const pk = both.map((k) => n(M.get(k).peak) ?? n(M.get(k).max)).filter((v) => v != null);
    return { avg: avg(av), peak: pk.length ? Math.max(...pk) : null, n: av.length };
  };
  const a = side(A); const b = side(B);
  const pct = (x, y) => (x == null || y == null || x === 0 ? null : Math.round(((y - x) / Math.abs(x)) * 1000) / 10);
  const dA = pct(a.avg, b.avg); const dP = pct(a.peak, b.peak);
  return {
    a, b, diffAvgPct: dA, diffPeakPct: dP, out: { avg: dA != null && Math.abs(dA) > diffPct, peak: dP != null && Math.abs(dP) > diffPct },
    missingA: slots - [...A.keys()].filter((k) => k >= 0 && k < slots).length, missingB: slots - [...B.keys()].filter((k) => k >= 0 && k < slots).length,
    excluded: slots - both.length, pairs: both.length,
  };
}

/** 프로세스 상위 합치기(순수) — 스냅샷 목록 → 이름별 I/O(읽기+쓰기 B/s 최대) · CPU(% 최대). */
export function procsOf(snaps = []) {
  const m = new Map();
  for (const s of snaps) {
    for (const x of s?.ioTop || []) { const k = String(x?.name || ''); if (!k) continue; const v = (n(x.readBps) ?? 0) + (n(x.writeBps) ?? 0); const c = m.get(k) || { name: k.slice(0, 32), ioBps: null, cpuPct: null }; c.ioBps = Math.max(c.ioBps ?? 0, v); m.set(k, c); }
    for (const x of s?.cpuTop || []) { const k = String(x?.name || ''); if (!k) continue; const v = n(x.cpuPct); const c = m.get(k) || { name: k.slice(0, 32), ioBps: null, cpuPct: null }; if (v != null) c.cpuPct = Math.max(c.cpuPct ?? 0, v); m.set(k, c); }
  }
  return m;
}
export function procDiff(snapsA = [], snapsB = [], max = 10) {
  if (!snapsA.length || !snapsB.length) return { available: false, a: snapsA.length, b: snapsB.length, rows: [] };
  const A = procsOf(snapsA); const B = procsOf(snapsB);
  const names = [...new Set([...A.keys(), ...B.keys()])];
  const score = (k) => Math.max(B.get(k)?.ioBps ?? 0, A.get(k)?.ioBps ?? 0) + (Math.max(B.get(k)?.cpuPct ?? 0, A.get(k)?.cpuPct ?? 0) * 1e6);
  const rows = names.sort((x, y) => score(y) - score(x)).slice(0, max).map((k) => ({
    name: k.slice(0, 32), aIoBps: A.get(k)?.ioBps ?? null, bIoBps: B.get(k)?.ioBps ?? null, aCpuPct: A.get(k)?.cpuPct ?? null, bCpuPct: B.get(k)?.cpuPct ?? null,
    only: !A.has(k) ? 'b' : !B.has(k) ? 'a' : null,
  }));
  return { available: true, a: snapsA.length, b: snapsB.length, rows };
}

/**
 * 한 서버의 A/B 비교(이 노드 데이터 — 라우트 · 엣지 대행 공용).
 */
export async function compareFor({ agent = '', key, q = {}, settings = {}, rules = {}, now = Date.now(), deps = {} } = {}) {
  const D = {
    rawRange: async (o) => (await import('./db.js')).rawRangeMerged(o),
    hourly: async (o) => (await import('./monthStore.js')).readHourlyRange(o),
    daily: async (o) => (await import('./db.js')).dailyRangeMergedMeta(o),
    snapshots: async (o) => (await import('./db.js')).snapshotList(o),
    snapshotGet: async (id, o) => (await import('./db.js')).snapshotGet(id, o),
    focusRange: async (o) => (await import('./opsDb.js')).focusSamplesInRange(o),
    changes: async (o) => (await import('./opsDb.js')).changeEventsRange(o),
    ...deps,
  };
  const pair = normalizePair(q, now);
  if (pair.error) return { __status: 400, ok: false, reason: pair.error };
  const st = settings.store || STORE_DEFAULTS;
  const keepDays = { raw: effectiveRawDays(settings), h1: st.hourlyDays, d1: settings.dailyRetentionDays };
  const ra = pickRes({ from: pair.a.from, to: pair.a.to, now, req: q.res || 'auto', kind: 'server', keepDays });
  const rb = pickRes({ from: pair.b.from, to: pair.b.to, now, req: q.res || 'auto', kind: 'server', keepDays });
  const res = RES_ORDER[Math.max(RES_ORDER.indexOf(ra.res), RES_ORDER.indexOf(rb.res))];
  const stepMs = res === '5m' ? Math.max(RES_MS['5m'], Number(settings.intervalMs) || RES_MS['5m']) : RES_MS[res];
  const slots = Math.max(1, Math.floor(pair.len / stepMs));
  const read = async (w) => {
    if (res === '5m') {
      const cols = [...COMPARE_METRICS, ...COMPARE_METRICS.filter((c) => PEAK_COLS.includes(c)).map((c) => `${c}_peak`)];
      return (await D.rawRange({ key, agent, from: w.from, to: w.to - 1, limit: 20_000, cols })).rows || [];
    }
    if (res === '1h') return (await D.hourly({ agent, key, from: w.from, to: w.to - 1 })).rows || [];
    return (await D.daily({ key, agent, from: w.from, to: w.to - 1 })).rows || [];
  };
  const [rowsA, rowsB] = [await read(pair.a), await read(pair.b)];
  const diffPct = n(rules.compare?.diffPct) ?? 20;
  const y = createYielder(15);
  const metrics = [];
  for (const m of COMPARE_METRICS) {
    const pa = toPoints(rowsA, { metric: m, res, kind: 'server', dayStart });
    const pb = toPoints(rowsB, { metric: m, res, kind: 'server', dayStart });
    metrics.push({ metric: m, ...compareMetric(pa, pb, { fromA: pair.a.from, fromB: pair.b.from, stepMs, slots, diffPct }) });
    await y();
  }
  // 프로세스 — 진단 스냅샷 보관분 + 집중 경량 스냅샷(구간 안).
  const snapsIn = async (w) => {
    const out = [];
    try {
      const list = (await D.snapshots({ key, agent, limit: 50, since: w.from })) || [];
      for (const s of list.filter((x) => x.ok && x.at >= w.from && x.at <= w.to).slice(0, 3)) {
        const full = await D.snapshotGet(s.id, { since: w.from }).catch(() => null);
        if (full?.result) out.push({ src: 'snapshot', at: s.at, ioTop: full.result.ioTop || [], cpuTop: full.result.cpuTop || [] });
      }
    } catch { /* 보관분이 없으면 빈 목록 */ }
    try {
      for (const f of ((await D.focusRange({ key, agent, from: w.from, to: w.to, limit: 120 })) || [])) if (f.snap && !f.snap.error) out.push({ src: 'focus', at: f.minuteTs, ioTop: f.snap.ioTop || [], cpuTop: f.snap.cpuTop || [] });
    } catch { /* */ }
    return out;
  };
  const [sA, sB] = [await snapsIn(pair.a), await snapsIn(pair.b)];
  const procs = procDiff(sA, sB);
  // 변경 이벤트(두 구간을 덮는 범위) · 튜닝 값 차이(A 끝 ~ B 끝 사이 전이)
  const lo = Math.min(pair.a.from, pair.b.from); const hi = Math.max(pair.a.to, pair.b.to);
  const ch = (await D.changes({ key, agent, from: lo, to: hi, limit: 500 }).catch(() => null)) || { rows: [], truncated: false };
  const [t0, t1] = pair.a.to <= pair.b.to ? [pair.a.to, pair.b.to] : [pair.b.to, pair.a.to];
  const tuning = (ch.rows || []).filter((e) => TUNING_KINDS.has(e.kind) && e.ts > t0 && e.ts <= t1);
  return {
    ok: true, key, res, stepMs, slots, a: pair.a, b: pair.b, lengthAdjusted: pair.lengthAdjusted, origLen: pair.origLen, diffPct,
    resReason: ra.res !== rb.res ? 'coarser-of-two' : (ra.reason || rb.reason || ''),
    metrics, procs: { ...procs, snapsA: sA.map((x) => ({ src: x.src, at: x.at })), snapsB: sB.map((x) => ({ src: x.src, at: x.at })) },
    tuning, changes: ch.rows || [], ...(ch.truncated ? { changesTruncated: true } : {}),
  };
}
