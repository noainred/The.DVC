/**
 * bmusage/capacity.js — 리눅스 성능 8a단계 **용량 소진 예측**(설계 PROFILES §20 ⑱ · 아트보드 Capacity). 판정이 아니라 ‘참고’ 다(ML 없음 · 선형만).
 *
 * 입력(새 수집 없음 — ##DFI 는 1단계부터 같은 SSH 1회에 있다):
 *   · 파일시스템 · inode — 마운트 일 롤업 `usage_mount_daily`(1d 연 파일 · 등록 마운트만 · `used_pct_max` · `inode_pct_max` — 일 최대).
 *     ⚠ 설계 문구 ‘장치별 표(마운트별 1시간 90일)’ 와 다르다: 마운트는 3a 부터 **일 롤업만** 저장한다(설계 §9 B) — 그 표를 쓴다(정직 기록).
 *   · 메모리 — `usage_daily.mem_max`(일 최대 · MemAvailable 기준 사용률 — **‘참고’ 등급**: 캐시 회수로 과대할 수 있다 · 재부팅 리셋형은 주기 추정까지만).
 * 방법(전부 설정값 · 근거 ○ 관행):
 *   ① 결측 일(값 없음)과 정비 창(⑤ exclude 를 켠 창)이 걸친 날은 뺀다 — 0 으로 메우지 않는다. 단 창 **합집합**이 기간의 절반 넘는 날을 덮으면(매일 백업 창)
 *      날마다 같은 몫(중앙값)은 일상이라 빼지 않고 그보다 1시간 넘게 더 덮인 날만 뺀다(dayExclusion — 창을 나눠 등록해도 같은 결과: 반증 F3).
 *   ② 리셋: 하루에 resetDropPp(10%p) 이상 떨어지면(정리 · 재부팅) **그 뒤부터** 창을 다시 잡는다(‘리셋형’ 표시).
 *   ③ 14일 창 최소제곱 선형(일 최대) — 점이 minDays(7) 미만이면 ‘데이터 부족’(0일 · 안전으로 적지 않는다).
 *   ④ R² < minR2(0.5) 또는 30일 창 기울기와 ±unstablePct(30%) 넘게 다르면 ‘불안정 · 예측 안 함’(값을 쓰지 않는다 — 최근 30일 최대만).
 *   ⑤ 기울기 ≤ 0(또는 0.01%p/일 미만) = ‘증가 없음’(도달 예측 없음 — ‘안전’ 이라 하지 않는다).
 *   ⑥ 도달일 = **마지막 관측일** + (목표 − 그 값) ÷ 하루 증가(올림 — 반증 F11: 관측이 며칠 전이면 오늘부터 세지 않는다 · staleAfterDays(2일) 넘게 오래되면 stale 표지) ·
 *      horizonDays(365) 넘으면 ‘1년 넘음’. **지금 ≥ 목표면 ‘도달’ 이 관문(③ 부족 · ④ 불안정 · ⑤ 증가 없음)보다 먼저다**(반증 F2 — 97% 로 머무는 디스크가
 *      ‘증가 없음’ 으로 알림 · KPI 에서 빠지지 않게).
 *   ⑦ 신뢰 = R² 글자(≥0.8 높음 · 0.5~0.8 보통) — 색만이 아니라 글자로.
 * 계산 위치(결정 — idrac-server.md 8a 항목): **수집 노드가 하루 1회 미리 계산**(포탈 날 경계 + 01:10 뒤 첫 틱 · 시간 기준 양보 createYielder)하고
 *   결과 행만 `bm-capacity.json`(원자 쓰기 · 손상 보존)에 둔다. 함대 표 · 보드 KPI · 알림 규칙은 이 결과를 쓴다(요청 경로에서 90일 × 1,000대를 읽지 않는다).
 *   서버 1대 상세(추이 · 맞춤선)는 볼 때 그 서버만 계산한다(엣지 서버는 엣지 대행 — collector /bm-usage/capacity).
 * 씬 프로비저닝 · LVM 여유는 범위 밖(df 는 파일시스템 기준) · xfs · btrfs inode 는 동적이라 ‘상한 없음’(값은 참고) · 읽기 전용 마운트 판별 원천 없음(등록 마운트만 본다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { numOrNull } from '../util/numOrNull.js';
import { dayKey, DAY_MS, DAY_OFFSET_MIN } from '../util/dayKey.js';
import { createYielder } from '../util/timeSlice.js';
import { maintJudge, localTargets } from './maint/runtime.js';
import { targetIdOf } from './maint/judge.js';
import { loadPerfRules } from './perfRules.js';

const n = numOrNull;
const FILE = () => path.join(config.configDir, 'bm-capacity.json');
export const CAP_DEFAULTS = Object.freeze({ targetPct: 90, minDays: 7, win: 14, cmpWin: 30, unstablePct: 30, minR2: 0.5, resetDropPp: 10, horizonDays: 365, flatPpPerDay: 0.01, staleAfterDays: 2 });
export const CAP_KINDS = Object.freeze(['fs', 'inode', 'mem']);
export const CAP_STATUS = Object.freeze(['forecast', 'reached', 'no-growth', 'unstable', 'insufficient', 'no-limit']);
/** 상태 사유(웹 문구 · 중앙 정제가 같은 목록). */
export const CAP_REASONS = Object.freeze(['few-days', 'flat', 'r2', 'slope-diff', 'declining', 'periodic-reset', 'xfs-dynamic', 'no-inode-limit']);
export const CAP_ROWS_MAX = 20_000;
/** 서버당 행 최소 몫(마운트 1개 fs · inode + 메모리) — 행 상한은 서버마다 공정하게 나눈다(반증 F4 — 뒤쪽 서버가 통째로 빠지지 않게). */
export const CAP_ROWS_PER_SERVER_MIN = 3;
/** 반복 정비 창 보정 — 날마다 같은 몫보다 이만큼(분) 넘게 더 덮인 날만 뺀다. */
export const ROUTINE_SLACK_MIN = 60;
/** 재계산 시각(포탈 날 기준 분) — 01:10 뒤 첫 틱(설계 ‘매일 01:10 재계산’). */
export const RECOMPUTE_AFTER_MIN = 70;
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);

/** 'YYYY-MM-DD' → 날짜 번호(1970-01-01 = 0 · 시간대 무관 달력). */
export const dayNum = (d) => Math.floor(Date.parse(`${d}T00:00:00Z`) / DAY_MS);
const dayStr = (num) => new Date(num * DAY_MS).toISOString().slice(0, 10);

/** 최소제곱 선형(순수) — points [{x, y}] · 점 2개 미만이면 null · 값이 전부 같으면 r2 null(추세 없음 — 0 도 1 도 아니다). */
export function linFit(points = []) {
  const p = points.filter((q) => Number.isFinite(q?.x) && Number.isFinite(q?.y));
  const k = p.length;
  if (k < 2) return null;
  const mx = p.reduce((a, q) => a + q.x, 0) / k; const my = p.reduce((a, q) => a + q.y, 0) / k;
  let sxx = 0; let sxy = 0; let syy = 0;
  for (const q of p) { sxx += (q.x - mx) ** 2; sxy += (q.x - mx) * (q.y - my); syy += (q.y - my) ** 2; }
  if (sxx === 0) return null;
  const slope = sxy / sxx; const intercept = my - slope * mx;
  let ssRes = 0;
  for (const q of p) ssRes += (q.y - (intercept + slope * q.x)) ** 2;
  const r2 = syy === 0 ? null : Math.max(0, 1 - ssRes / syy);
  return { slope, intercept, r2, n: k };
}

/**
 * 한 자원의 일 계열 → 예측(순수).
 * @param {Array<{day:string, v:number|null, excluded?:boolean}>} daily  일 최대(오름차순 아니어도 된다)
 * @param {{today:string, targetPct?:number}} o  today = 오늘(포탈 날 'YYYY-MM-DD')
 * @returns {{status, current, slope, r2, conf, daysToTarget, daysTo100, dateToTarget, dateTo100, win, n, reset, resetDay, max30, excluded, missing, reason?}}
 */
export function forecastSeries(daily = [], o = {}) {
  const c = { ...CAP_DEFAULTS, ...Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)) };
  const today = dayNum(c.today);
  const all = (Array.isArray(daily) ? daily : []).filter((d) => d && /^\d{4}-\d{2}-\d{2}$/.test(String(d.day))).map((d) => ({ x: dayNum(d.day), y: n(d.v), ex: !!d.excluded }))
    .filter((d) => d.x <= today && d.x > today - 90).sort((a, b) => a.x - b.x);
  const excluded = all.filter((d) => d.ex).length;
  const pts = all.filter((d) => !d.ex && d.y != null);
  const missing = all.filter((d) => !d.ex && d.y == null).length;
  // ② 리셋 — 직전 값 대비 하루 resetDropPp 이상 하락(마지막 리셋 뒤부터 창을 잡는다)
  let start = 0; let resetDay = null; let resets30 = 0;
  for (let i = 1; i < pts.length; i += 1) if (pts[i].y <= pts[i - 1].y - c.resetDropPp) { start = i; resetDay = dayStr(pts[i].x); if (pts[i].x > today - c.cmpWin) resets30 += 1; }
  const use = pts.slice(start);
  const last = use.length ? use[use.length - 1] : (pts.length ? pts[pts.length - 1] : null);
  const current = last ? r1(last.y) : null;
  const lastX = last ? last.x : null;
  const staleDays = lastX == null ? null : today - lastX;
  const in30 = pts.filter((d) => d.x > today - c.cmpWin);
  const max30 = in30.length ? r1(Math.max(...in30.map((d) => d.y))) : null;
  const base = { current, max30, excluded, missing, reset: resetDay != null, resetDay, win: c.win, targetPct: c.targetPct,
    lastDay: lastX == null ? null : dayStr(lastX), staleDays, ...(staleDays != null && staleDays > c.staleAfterDays ? { stale: true } : {}) };
  const w14 = use.filter((d) => d.x > today - c.win);
  const NONE = { conf: null, daysToTarget: null, daysTo100: null, dateToTarget: null, dateTo100: null };
  // 관문(예측할 수 없는 사유) — 도달 판정보다 **뒤**에 쓴다(F2).
  let gate = null; let f14 = null; const out = { ...base, n: w14.length, slope: null, r2: null };
  // 30일 안 리셋이 두 번 이상이면 주기 정리형(로그 로테이션 · 배치 적재 뒤 정리) — ‘데이터 부족’ 이 아니라 ‘불안정 · 예측 안 함’ 이다(점은 충분히 있다).
  if (w14.length < c.minDays) gate = resets30 >= 2 ? { resets30, status: 'unstable', reason: 'periodic-reset' } : { status: 'insufficient', reason: 'few-days' };
  else {
    f14 = linFit(w14);
    if (!f14) gate = { status: 'insufficient', reason: 'few-days' };
    else {
      Object.assign(out, { n: f14.n, slope: r3(f14.slope), r2: f14.r2 == null ? null : r3(f14.r2) });
      if (Math.abs(f14.slope) < c.flatPpPerDay || f14.r2 == null) gate = { status: 'no-growth', reason: 'flat' };
      else if (f14.r2 < c.minR2) gate = { status: 'unstable', reason: 'r2' };
      else {
        const w30 = use.filter((d) => d.x > today - c.cmpWin);
        const f30 = w30.length > w14.length && w30.length >= c.minDays ? linFit(w30) : null;
        if (f30) {
          out.slope30 = r3(f30.slope);
          const rel = Math.abs(f14.slope - f30.slope) / Math.max(Math.abs(f30.slope), c.flatPpPerDay);
          if (rel > c.unstablePct / 100) gate = { status: 'unstable', reason: 'slope-diff' };
        }
        if (!gate && f14.slope < 0) gate = { status: 'no-growth', reason: 'declining' };
      }
    }
  }
  // 도달일 — 마지막 관측일부터 센다(F11). 추세로 이미 지났으면 0일(날짜는 그 날).
  const reach = (target) => {
    if (current == null || lastX == null) return { d: null, date: null };
    if (current >= target) return { d: 0, date: dayStr(lastX) };
    const k = Math.ceil((target - current) / f14.slope);
    const d = lastX + k - today;
    if (d > c.horizonDays) return { d: null, date: null, beyond: true };
    return { d: Math.max(0, d), date: dayStr(lastX + k) };
  };
  const conf = !gate && f14 ? (f14.r2 >= 0.8 ? 'high' : 'mid') : null;
  const fit = !gate && f14 ? { fit: { slope: f14.slope, intercept: f14.intercept, x0: w14[0].x } } : {};
  if (current != null && current >= c.targetPct) {
    // 이미 목표선 위 — 추세(증가 없음 · 불안정 · 부족)와 무관하게 ‘도달’. 100% 예측은 추세를 쓸 수 있을 때만.
    const h = !gate ? reach(100) : { d: current >= 100 ? 0 : null, date: current >= 100 ? dayStr(lastX) : null };
    return { ...out, status: 'reached', conf, daysToTarget: 0, dateToTarget: dayStr(lastX), daysTo100: h.d, dateTo100: h.date, ...(h.beyond ? { beyond100: true } : {}), ...fit };
  }
  if (gate) return { ...out, ...NONE, ...gate };
  const t = reach(c.targetPct); const h = reach(100);
  return { ...out, status: 'forecast', conf,
    daysToTarget: t.d, dateToTarget: t.date, daysTo100: h.d, dateTo100: h.date, ...(t.beyond ? { beyondTarget: true } : {}), ...(h.beyond ? { beyond100: true } : {}), ...fit };
}

/**
 * 서버 하나의 자원 행(순수) — 마운트 일 롤업 행 · 일 롤업(메모리) · 제외 날짜 · xfs/btrfs 마운트 → 자원별 예측.
 * @param {{key, mountRows:Array, dailyRows:Array, excludedDays:Set<string>, dynInodeMounts:Set<string>, today:string, cfg:object}} p
 */
export function forecastServer({ key, mountRows = [], dailyRows = [], excludedDays = new Set(), dynInodeMounts = new Set(), today, cfg = {} } = {}) {
  const byMount = new Map();
  for (const r of mountRows) { const m = String(r.mount || ''); if (!m) continue; if (!byMount.has(m)) byMount.set(m, []); byMount.get(m).push(r); }
  const out = [];
  const series = (rows, col) => rows.map((r) => ({ day: r.day, v: n(r[col]), excluded: excludedDays.has(r.day) }));
  for (const [mount, rows] of [...byMount.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, 32)) {
    const lastRow = rows.reduce((a, b) => (String(b.day) > String(a.day) ? b : a), rows[0]);
    out.push({ key, kind: 'fs', res: mount, sizeBytes: n(lastRow?.size_bytes), ...strip(forecastSeries(series(rows, 'used_pct_max'), { ...cfg, today })) });
    const ino = series(rows, 'inode_pct_max');
    if (dynInodeMounts.has(mount) || !ino.some((d) => d.v != null)) {
      const last = [...ino].reverse().find((d) => d.v != null);
      out.push({ key, kind: 'inode', res: mount, status: 'no-limit', current: last ? r1(last.v) : null, reason: dynInodeMounts.has(mount) ? 'xfs-dynamic' : 'no-inode-limit' });
    } else out.push({ key, kind: 'inode', res: mount, ...strip(forecastSeries(ino, { ...cfg, today })) });
  }
  const mem = (dailyRows || []).map((r) => ({ day: r.day, v: n(r.mem_max), excluded: excludedDays.has(r.day) }));
  if (mem.length) out.push({ key, kind: 'mem', res: 'mem', grade: 'ref', ...strip(forecastSeries(mem, { ...cfg, today })) });
  return out;
}
const strip = ({ fit: _f, ...x }) => x;

/**
 * 정비 창 제외 구간(합집합) → 제외 날짜(순수 — 반증 F3). 날마다 덮인 시간을 세고:
 *   · 덮인 날이 기간의 절반 이하 → 덮인 날 전부 뺀다(드문 정비).
 *   · 절반 넘음(매일 백업 창 같은 반복) → 날마다 같은 몫(전 기간 중앙값 — 덮이지 않은 날은 0)은 일상이라 빼지 않고, 그보다 slackMin 넘게 더 덮인 날만 뺀다.
 *   창을 몇 개로 나눠 등록해도 합집합이 같으면 결과가 같다.
 * @returns {{ excludedDays:Set<string>, routineMin:number }}  routineMin = 일상으로 본 하루 몫(분 · 0 이면 보정 없음)
 */
export function dayExclusion(intervals = [], from, to, { slackMin = ROUTINE_SLACK_MIN } = {}) {
  const off = DAY_OFFSET_MIN * 60_000;
  const nextDay = (t) => Math.floor((t + off) / DAY_MS) * DAY_MS - off + DAY_MS;
  const per = new Map();
  for (const x of intervals || []) {
    const a = Math.max(from, x.from); const b = Math.min(to, x.to);
    for (let t = a; t < b;) { const e = Math.min(b, nextDay(t)); const d = dayKey(t); per.set(d, (per.get(d) || 0) + (e - t)); t = e; }
  }
  const spanDays = Math.max(1, Math.ceil((to - from) / DAY_MS));
  if (per.size <= spanDays / 2) return { excludedDays: new Set(per.keys()), routineMin: 0 };
  const vals = [...per.values(), ...Array(Math.max(0, spanDays - per.size)).fill(0)].sort((p, q) => p - q);
  const routine = vals[Math.floor(vals.length / 2)];
  const out = new Set();
  for (const [d, ms] of per) if (ms > routine + slackMin * 60_000) out.add(d);
  return { excludedDays: out, routineMin: Math.round(routine / 60_000) };
}

/** 정비 창 제외 구간 → 제외 날짜(포탈 날 기준 — 창이 걸친 날 전부). */
export function excludedDaysOf(intervals = [], from, to) {
  const out = new Set();
  for (const x of intervals || []) {
    const a = Math.max(from, x.from); const b = Math.min(to, x.to);
    for (let t = a; t < b; t += 3_600_000) out.add(dayKey(t));
    if (b > a) out.add(dayKey(b - 1));
  }
  return out;
}

/** 함대 요약(순수) — 서버 수로 센다(서버마다 가장 이른 도달 자원 · 서버 = (법인, 키) 쌍 — judge.targetIdOf 와 같은 규칙: 반증 F1).
 *  데이터 부족 · 불안정 · 상한 없음은 따로(0일로 적지 않는다). */
export function summarize(rows = [], { soonDays = 7, monthDays = 30 } = {}) {
  const byKey = new Map();
  for (const r of rows) { const id = targetIdOf(r); if (!byKey.has(id)) byKey.set(id, []); byKey.get(id).push(r); }
  const s = { servers: byKey.size, soon: 0, month: 0, reached: 0, unstable: 0, insufficient: 0, noGrowth: 0, noLimit: 0, soonByKind: { fs: 0, inode: 0, mem: 0 }, monthByKind: { fs: 0, inode: 0, mem: 0 } };
  for (const list of byKey.values()) {
    const fc = list.filter((r) => r.status === 'forecast' || r.status === 'reached');
    const best = fc.reduce((a, r) => (a == null || (r.daysToTarget ?? Infinity) < (a.daysToTarget ?? Infinity) ? r : a), null);
    if (best && best.daysToTarget != null && best.daysToTarget <= soonDays) { s.soon += 1; s.soonByKind[best.kind] += 1; }
    if (best && best.daysToTarget != null && best.daysToTarget <= monthDays) { s.month += 1; s.monthByKind[best.kind] += 1; }
    if (list.some((r) => r.status === 'reached')) s.reached += 1;
    if (!fc.length && list.some((r) => r.status === 'unstable')) s.unstable += 1;
    if (!fc.length && list.every((r) => r.status === 'insufficient' || r.status === 'no-limit')) s.insufficient += 1;
  }
  for (const r of rows) { if (r.status === 'no-growth') s.noGrowth += 1; if (r.status === 'no-limit') s.noLimit += 1; }
  return s;
}

/* ── 계산(수집 노드 · 하루 1회) ───────────────────────────────────────── */
/** xfs · btrfs(동적 inode) 마운트 — 최신값 표에서 이 노드 · 필요한 열(key · tuning_json)만 조각으로(반증 의심 — SELECT * 한 번에 동기로 읽지 않는다). */
async function xfsMountsOf(agent, { yieldFn = null } = {}) {
  const out = new Map();
  try {
    const rows = await (await import('./db.js')).latestTuningRows({ agent: String(agent || ''), yieldFn });
    for (const r of rows || []) {
      let tu = null; try { tu = r.tuning_json ? JSON.parse(r.tuning_json) : null; } catch { tu = null; }
      const xs = Array.isArray(tu?.xfs) ? tu.xfs.map((x) => String(x?.mount || '')).filter(Boolean) : [];
      out.set(String(r.key), new Set(xs));
    }
  } catch { /* 모르면 비운다(상한 있음으로 본다 — 값이 있으면 예측한다) */ }
  return out;
}

/**
 * 서버 하나 계산(상세 · 엣지 대행 · 하루 계산이 같은 함수). series=true 면 자원마다 일 계열 · 맞춤선을 싣는다(상세 차트).
 * @returns {Promise<{ok:boolean, rows:Array, series?:object}>}
 */
export async function computeServer({ agent = '', target, now = Date.now(), cfg = {}, judge = null, series = false, xfs = null, deps = {} } = {}) {
  const M = deps.monthStore || await import('./monthStore.js');
  const from = now - 31 * DAY_MS;
  const [mr, dr] = await Promise.all([
    M.readMountDaily({ agent, key: target.key, from, to: now }).catch(() => ({ rows: [] })),
    M.readDailyRange({ agent, key: target.key, from, to: now }).catch(() => ({ live: [], mig: [] })),
  ]);
  const daily = new Map();
  for (const r of dr.live || []) daily.set(r.day, r);
  for (const r of dr.mig || []) daily.set(r.day, M.mergeDailyRows ? M.mergeDailyRows(daily.get(r.day), r) : (daily.get(r.day) || r));
  // ⑤ 정비 창 날 제외 — 창 **합집합**의 날별 덮임으로(dayExclusion — 매일 반복 창은 일상 몫을 빼지 않는다 · 창을 나눠도 같은 결과: 반증 F3).
  //   빼면 날이 남지 않아 예측 자체가 사라지는 일을 막는다(Chromium 판독 r1 — 매일 2시간 창이 30일을 전부 지웠다). 일상 몫(분)을 행에 적는다.
  const { excludedDays, routineMin } = dayExclusion(judge ? judge.cover(target, from, now, 'exclude') : [], from, now);
  const dailyKept = routineMin;
  const xs = xfs || (await xfsMountsOf(agent)).get(String(target.key)) || new Set();
  const today = dayKey(now);
  // 메모리 ‘소진’ 은 OS(MemAvailable) 값일 때만 — iDRAC 만 있는 서버의 mem_pct 는 다른 정의라 예측 행을 만들지 않는다.
  const osPath = !Array.isArray(target.paths) || target.paths.includes('os');
  const rows0 = forecastServer({ key: target.key, mountRows: mr.rows || [], dailyRows: osPath ? [...daily.values()] : [], excludedDays, dynInodeMounts: xs, today, cfg });
  const rows = dailyKept ? rows0.map((r) => ({ ...r, dailyWin: dailyKept })) : rows0;
  if (!series) return { ok: true, rows };
  // 상세 — 자원별 일 계열(최근 30일) + 14일 맞춤선(예측 상태일 때만)
  const ser = {};
  const byMount = new Map();
  for (const r of mr.rows || []) { if (!byMount.has(r.mount)) byMount.set(r.mount, []); byMount.get(r.mount).push(r); }
  for (const [m, list] of byMount) {
    ser[`fs:${m}`] = list.map((r) => ({ day: r.day, v: n(r.used_pct_max), ex: excludedDays.has(r.day) }));
    ser[`inode:${m}`] = list.map((r) => ({ day: r.day, v: n(r.inode_pct_max), ex: excludedDays.has(r.day) }));
  }
  ser.mem = [...daily.values()].sort((a, b) => String(a.day).localeCompare(String(b.day))).map((r) => ({ day: r.day, v: n(r.mem_max), ex: excludedDays.has(r.day) }));
  const fits = {};
  for (const [k, list] of Object.entries(ser)) {
    const f = forecastSeries(list.map((d) => ({ day: d.day, v: d.v, excluded: d.ex })), { ...cfg, today });
    if (f.fit) fits[k] = { slope: r3(f.fit.slope), intercept: r3(f.fit.intercept), fromDay: dayStr(f.fit.x0) };
  }
  return { ok: true, rows, series: ser, fits, excludedDays: [...excludedDays].sort().slice(-60), today };
}

/** 저장(원자 쓰기) · 읽기(손상 보존 — 못 읽으면 null + unreadable). */
export function saveCapacity(obj) { atomicWriteFileSync(FILE(), JSON.stringify(obj), { mode: 0o600 }); _cache = null; }
let _cache = null;
export function loadCapacity() {
  let st = null;
  try { st = fs.statSync(FILE()); } catch { return null; }
  if (_cache && _cache.m === st.mtimeMs && _cache.s === st.size) return _cache.data;
  try {
    const o = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (!o || typeof o !== 'object' || !Array.isArray(o.rows)) throw new Error('형식이 다릅니다');
    _cache = { m: st.mtimeMs, s: st.size, data: o };
    return o;
  } catch (e) { preserveCorrupt(FILE(), String(e?.message || e)); _cache = null; return { unreadable: true, rows: [], at: 0 }; }
}

/**
 * 서버 하나의 행을 몫(share)에 맞춘다(순수 — F4): 메모리 행은 남기고, 마운트는 급한 순(도달 → 도달 예측 이른 순 → 지금 값 높은 순)으로 fs · inode 묶음째 남긴다.
 * @returns {{ rows:Array, trimmedMounts:number }}
 */
export function fairRows(rows = [], share = Infinity) {
  if (rows.length <= share) return { rows, trimmedMounts: 0 };
  const mem = rows.filter((r) => r.kind === 'mem');
  const byMount = new Map();
  for (const r of rows) if (r.kind !== 'mem') { if (!byMount.has(r.res)) byMount.set(r.res, []); byMount.get(r.res).push(r); }
  const score = (list) => Math.min(...list.map((r) => (r.status === 'reached' ? -1 : r.status === 'forecast' && r.daysToTarget != null ? r.daysToTarget : 100_000 - (Number(r.current) || 0))));
  const mounts = [...byMount.entries()].sort((a, b) => score(a[1]) - score(b[1]) || String(a[0]).localeCompare(String(b[0])));
  const out = [...mem.slice(0, Math.max(0, share))];
  let kept = 0;
  for (const [, list] of mounts) { if (out.length + list.length > share) break; out.push(...list); kept += 1; }
  return { rows: out, trimmedMounts: mounts.length - kept };
}

let _running = null;
/** 다시 계산할 때인가(순수) — 결과가 없거나 · 못 읽었거나 · 포탈 날이 바뀌고 01:10 이 지났거나 · 25시간이 넘었으면. */
export function dueForRecompute(cur, now = Date.now()) {
  if (!cur || cur.unreadable || !cur.day) return true;
  const today = dayKey(now);
  const minOfDay = Math.floor((((now + DAY_OFFSET_MIN * 60_000) % DAY_MS) + DAY_MS) % DAY_MS / 60_000);
  if (cur.day !== today && minOfDay >= RECOMPUTE_AFTER_MIN) return true;
  return now - (Number(cur.at) || 0) > 25 * 3_600_000;
}
/**
 * 이 노드의 대상 전부를 계산해 저장(하루 1회 — 폴러 틱이 부른다 · 진행 중이면 그 프라미스를 공유). 대상 사이 시간 기준 양보.
 * @returns {Promise<{ok:boolean, rows?:number, ms?:number, skipped?:string}>}
 */
export async function recomputeCapacity({ targets = null, now = Date.now(), force = false, deps = {} } = {}) {
  if (_running) return _running;
  _running = (async () => {
    const t0 = Date.now();
    try {
      const cur = loadCapacity();
      if (!force && !dueForRecompute(cur, now)) return { ok: true, skipped: 'not-due' };
      const agent = config.agent?.name || '';
      // 대상은 호출부(폴러 틱 · 라우트)가 준다 — 없으면 폴러가 등록한 공급자(runtime.localTargets).
      const tg = targets || await localTargets();
      const rules = deps.rules || loadPerfRules();
      const cfg = { targetPct: rules.capacity?.targetPct ?? CAP_DEFAULTS.targetPct, minDays: rules.capacity?.minDays ?? CAP_DEFAULTS.minDays };
      const judge = deps.judge || await maintJudge({ now }).catch(() => null);
      const y = createYielder(15);
      const xfs = await xfsMountsOf(agent, { yieldFn: y });
      const rows = [];
      // 행 상한은 서버마다 공정하게(반증 F4) — 서버당 몫 = 상한 ÷ 대상 수(최소 CAP_ROWS_PER_SERVER_MIN) · 넘치는 서버는 급한 마운트부터 남긴다.
      const list = tg.filter((x) => x?.key);   // 마운트는 OS 경로가 있어야 쌓인다 — 행이 없으면 자원 행도 없다(메모리는 OS 경로일 때만 — 아래)
      const ROWS_MAX = Number.isInteger(deps.rowsMax) && deps.rowsMax > 0 ? deps.rowsMax : CAP_ROWS_MAX;   // 시험 이음매(기본 = 상한)
      const share = Math.max(CAP_ROWS_PER_SERVER_MIN, Math.floor(ROWS_MAX / Math.max(1, list.length)));
      const cap = { servers: list.length, computed: 0, skippedServers: 0, trimmedServers: 0, trimmedMounts: 0, perServerRows: share };
      for (const target of list) {
        if (rows.length + CAP_ROWS_PER_SERVER_MIN > ROWS_MAX) { cap.skippedServers = list.length - cap.computed; break; }
        const r = await computeServer({ agent, target, now, cfg, judge, xfs: xfs.get(String(target.key)) || new Set(), deps });
        const mine = r.rows.filter((x) => x.kind !== 'mem' || (target.paths || []).includes('os'));
        const kept = fairRows(mine, Math.min(share, ROWS_MAX - rows.length));
        if (kept.trimmedMounts) { cap.trimmedServers += 1; cap.trimmedMounts += kept.trimmedMounts; }
        for (const x of kept.rows) rows.push({ ...x, name: String(target.name || target.key).slice(0, 256), vcenterId: String(target.vcenterId || '') });
        cap.computed += 1;
        await y();
      }
      const out = { v: 1, at: Date.now(), day: dayKey(now), cfg, rows: rows.slice(0, ROWS_MAX), truncated: cap.skippedServers > 0 || cap.trimmedServers > 0, cap, ms: Date.now() - t0 };
      saveCapacity(out);
      console.log(`[bmusage] 용량 소진 예측 다시 계산 — 서버 ${list.length}대 · 자원 ${out.rows.length}행 · ${out.ms}ms${out.truncated ? ` · 상한: 계산 안 한 서버 ${cap.skippedServers}대 · 마운트 일부만 ${cap.trimmedServers}대(${cap.trimmedMounts}개 뺌)` : ''}`);
      return { ok: true, rows: out.rows.length, ms: out.ms };
    } catch (e) {
      console.warn(`[bmusage] 용량 소진 예측 계산 실패(지난 결과 유지): ${String(e?.message || e).slice(0, 200)}`);
      return { ok: false, error: String(e?.message || e).slice(0, 200) };
    } finally { _running = null; }
  })();
  return _running;
}
export function capacityRunning() { return !!_running; }
export function _resetCapacityForTest() { _cache = null; _running = null; try { fs.unlinkSync(FILE()); } catch { /* */ } }
