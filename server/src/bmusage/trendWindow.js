/**
 * bmusage/trendWindow.js — 추이(평균 · 피크 두 계열) 창 계산 **순수 모듈**(v2.922 · 3a · 설계 PROFILES §8·§11·§12).
 *
 *  · 해상도 자동 선택 · 창 정규화 · 계열 만들기(평균·최대·피크·피크 시각) · 결측 구간 · 기준선(설정값)을 한 곳에서 한다 —
 *    라우트(이 노드 서버)와 엣지 대행 응답(collector)이 같은 함수를 쓴다(코어는 하나).
 *  · vm-perf 의 창 계산은 웹 쪽 `components/vmperf/vmPerfText.js`(화면 구간 이동 — windowOf/maxBackOf)이고 서버 쪽 같은 역할 모듈은 없다
 *    (확인: server/src 에 해상도·결측 계산 모듈 없음). 이 모듈은 **서버 응답** 쪽이라 복제가 아니다 — 3b 화면의 구간 이동은 vmPerfText 를 공용으로 쓴다.
 *  · 규약: 결측은 **끊는다**(값을 지어내지 않는다 — gaps) · 롤업 평균은 합 ÷ 개수(개수 0 이면 null) · 롤업에 평균이 없는 지표(예전 일 롤업의
 *    디스크·네트워크 등)는 평균을 지어내지 않는다(null) · 기준선이 없는 지표는 null(화면에 숫자를 박지 않는다).
 */
import { numOrNull } from '../util/numOrNull.js';
import { PERF_COL_NAMES, DEVICE_COL_NAMES, PEAK_COLS, DEVICE_PEAK_COLS, MOUNT_DAILY_COLS } from './perfCols.js';

const n = numOrNull;
export const RES_MS = Object.freeze({ '5m': 300_000, '1h': 3_600_000, '1d': 86_400_000 });
const DAY = 86_400_000;
/** 응답 점 상한 — 넘으면 앞(오래된 쪽)을 잘라 truncated. 5분 × 14일 = 4,032 · 1시간 × 1년 = 8,760 이라 1시간 1년은 잘린다(자동 선택은 1일). */
export const TREND_MAX_POINTS = 6_000;
/** 창 최대 길이 — 1일 롤업 보존(최대 10년 설정)보다 길게 받지 않는다. */
export const TREND_MAX_SPAN_MS = 3_660 * DAY;

export const BASE_TREND = Object.freeze(['cpu_pct', 'mem_pct', 'disk_busy_pct', 'disk_used_pct', 'net_pct', 'net_bps', 'hba_pct', 'hba_bps', 'io_pct']);
/** 서버 지표 화이트리스트(열 이름 — SQL 에 들어가는 이름은 이 표에서만 온다). */
export const SERVER_METRICS = Object.freeze([...BASE_TREND, ...PERF_COL_NAMES]);
export const DEVICE_METRICS = Object.freeze({ disk: DEVICE_COL_NAMES.filter((c) => !['rx_bps', 'tx_bps', 'util_pct', 'drop_delta', 'speed_bps'].includes(c)), nic: ['rx_bps', 'tx_bps', 'util_pct', 'err_delta', 'drop_delta', 'speed_bps'], mount: [...MOUNT_DAILY_COLS] });

/** 창 정규화 — 없으면 최근 24시간 · 미래는 지금으로 · 뒤집혔으면 null · 최대 길이. */
export function normalizeWindow({ from, to, now = Date.now() } = {}) {
  let b = n(to); let a = n(from);
  if (b == null || b > now) b = now;
  if (a == null) a = b - DAY;
  if (!(a < b)) return null;
  if (b - a > TREND_MAX_SPAN_MS) a = b - TREND_MAX_SPAN_MS;
  return { from: Math.floor(a), to: Math.floor(b) };
}

/**
 * 해상도 고르기. auto: 2일 이하 → 5분 · 60일 이하 → 1시간 · 그 위 → 1일. 단 창 시작이 그 해상도의 보존 밖이면 한 단계 위로(보존 안에 데이터가 없다).
 *   장치: 5분 → 1시간(1일 단은 없다 — 1h 로 내리고 사유). 마운트: 1일만.
 * @param {{span:number, from:number, now:number, req?:string, kind?:string, keepDays:{raw:number,h1:number,d1:number,dev:number,dev1h:number}}} p
 * @returns {{res:string, reason:string}}
 */
export function pickRes({ from, to, now = Date.now(), req = 'auto', kind = 'server', keepDays = {} } = {}) {
  const span = to - from;
  if (kind === 'mount') return { res: '1d', reason: req !== 'auto' && req !== '1d' ? 'mount-daily-only' : '' };
  const keep = kind === 'server' ? { '5m': keepDays.raw, '1h': keepDays.h1, '1d': keepDays.d1 } : { '5m': keepDays.dev, '1h': keepDays.dev1h };
  const inKeep = (r) => keep[r] == null || from >= now - keep[r] * DAY;
  if (req && req !== 'auto' && RES_MS[req]) {
    if (kind !== 'server' && req === '1d') return { res: '1h', reason: 'device-no-daily' };
    return { res: req, reason: inKeep(req) ? '' : 'beyond-retention' };
  }
  const order = kind === 'server' ? ['5m', '1h', '1d'] : ['5m', '1h'];
  let want = span <= 2 * DAY ? '5m' : span <= 60 * DAY ? '1h' : '1d';
  if (!order.includes(want)) want = order.at(-1);
  for (let i = order.indexOf(want); i < order.length; i++) if (inKeep(order[i])) return { res: order[i], reason: order[i] === want ? '' : 'retention' };
  return { res: order.at(-1), reason: 'beyond-retention' };
}

/** 롤업 접두사 — 서버 기본 지표는 예전 일 롤업 이름(cpu·net …), 나머지는 열 이름 그대로. */
const BASE_PREFIX = Object.freeze({ cpu_pct: 'cpu', mem_pct: 'mem', disk_busy_pct: 'disk_busy', disk_used_pct: 'disk_used', net_pct: 'net', net_bps: 'net_bps', hba_pct: 'hba', hba_bps: 'hba_bps', io_pct: 'io' });
export const prefixOf = (col) => BASE_PREFIX[col] || col;

/**
 * 행 → 점(순수). 원시(5분)는 평균=최대=값, 롤업은 평균=합÷개수 · 최대=<p>_max · 피크=<열>_peak(+시각). 시각 열: ts | h | day(→ 그 날 시작 ms).
 * @param {Array} rows
 * @param {{metric:string, res:string, kind?:string, dayStart?:(day:string)=>number}} o
 */
export function toPoints(rows = [], { metric, res, kind = 'server', dayStart = null } = {}) {
  const hasPeak = kind === 'server' ? PEAK_COLS.includes(metric) : DEVICE_PEAK_COLS.includes(metric);
  const p = kind === 'server' ? prefixOf(metric) : metric;
  const out = [];
  for (const r of rows) {
    const t = r.ts != null ? n(r.ts) : r.h != null ? n(r.h) : (r.day && dayStart ? dayStart(r.day) : null);
    if (t == null) continue;
    let avg; let max;
    if (res === '5m') { avg = n(r[metric]); max = avg; }
    else {
      const cnt = n(r[`${p}_n`]);
      avg = cnt != null && cnt > 0 && n(r[`${p}_sum`]) != null ? Math.round((n(r[`${p}_sum`]) / cnt) * 100) / 100 : null;
      max = n(r[`${p}_max`]);
      if (metric === 'speed_bps') { avg = n(r.speed_bps); max = avg; }
    }
    const peak = hasPeak ? n(r[`${metric}_peak`]) : null;
    out.push({ t, avg, max, peak, peakAt: peak == null ? null : n(r[`${metric}_peak_at`]), n: res === '5m' ? 1 : n(r.samples) });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * 결측 구간(순수) — 기대 간격의 tol 배를 넘는 빈틈과 창 앞뒤의 빈틈. 값이 전부 null 인 점도 빈틈으로 센다(점이 있어도 그리지 않는다).
 * @returns {Array<{from:number,to:number,reason:string}>}
 */
export function gapsOf(points = [], { from, to, stepMs, tol = 2, reason = 'no-data' } = {}) {
  const gaps = [];
  const pts = points.filter((x) => x.avg != null || x.max != null || x.peak != null);
  const lim = stepMs * tol;
  if (!pts.length) return [{ from, to, reason }];
  if (pts[0].t - from > lim) gaps.push({ from, to: pts[0].t, reason });
  for (let i = 1; i < pts.length; i++) if (pts[i].t - pts[i - 1].t > lim) gaps.push({ from: pts[i - 1].t, to: pts[i].t, reason });
  if (to - pts.at(-1).t > lim + stepMs) gaps.push({ from: pts.at(-1).t, to, reason });
  return gaps;
}

/** 기준선(설정값 — settings.perf). 지표 ↔ 기준 키. 없으면 null(화면이 숫자를 박지 않는다). */
const BASELINE_KEY = Object.freeze({
  cpu_pct: 'util', mem_pct: 'util', disk_busy_pct: 'util', disk_used_pct: 'util', net_pct: 'util', hba_pct: 'util', io_pct: 'util', busy_pct: 'util', util_pct: 'util', used_pct: 'util', inode_pct: 'util',
  runq_per_core: 'runq', disk_aqu: 'queue', aqu: 'queue', psi_mem_full10: 'psiFull', psi_mem_full60: 'psiFull', psi_io_full10: 'psiFull', psi_io_full60: 'psiFull',
  psi_cpu_some10: 'psiCpuSome', psi_cpu_some60: 'psiCpuSome', swap_out_ps: 'swapOut', tcp_retrans_pct: 'retrans',
});
export function baselineOf(metric, th = {}) {
  const k = BASELINE_KEY[metric];
  if (!k || !th) return null;
  const warn = n(th[`${k}Warn`]); const bad = n(th[`${k}Bad`]);
  return warn == null && bad == null ? null : { warn, bad, key: k };
}

/** 점 상한 — 넘으면 오래된 쪽을 자르고 몇 개를 잘랐는지(조용한 상한 금지). */
export function capPoints(points, max = TREND_MAX_POINTS) {
  if (points.length <= max) return { points, truncated: 0 };
  return { points: points.slice(-max), truncated: points.length - max };
}
