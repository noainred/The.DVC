/**
 * isidu/report.js — 아이실론 디렉터리 사용량 보고서(v2.736, 화면·CSV 공용). 장비에 접속하지 않는다(DB 만 읽는다).
 *
 * ── 비교의 규칙 ──────────────────────────────────────────────────────────────
 *  · '7일 변화' 의 기준은 **최신 성공 스캔 시각 − 7일 이전(포함)의 마지막 성공 스캔**이다. 그런 스캔이 없으면 증감은 null('—')이고
 *    이유(관측 기간 부족)를 말한다 — 관측 2일로 7일 변화를 만들지 않는다. 실제 비교 간격은 `spanDays` 로 밝힌다.
 *  · 기준 스캔에 없던 폴더는 '신규', 기준에 있었는데 지금 없는 폴더는 '사라짐' — 기준이 없으면 둘 다 판정하지 않는다(null).
 *  · `-h` 표기는 반올림 값이다. 두 관측의 차이가 두 해상도의 반을 더한 것 이하이면 `withinRes`(변화라고 단정하지 않는다).
 *  · du 가 권한 오류 줄을 냈으면(errLines) 그 스캔의 크기는 실제보다 작을 수 있다 — 숫자를 지우지 않고 그 사실을 싣는다.
 *  · 같은 스캔 조합의 계산은 기억한다(최신 스캔 id 가 바뀌면 새로 — 폴링 화면이 매번 수천 행을 다시 비교하지 않게).
 */
import * as db from './db.js';
import { deltaOf, sortBySize } from './parse.js';
import { HISTORY_AGENT } from './targets.js';

const DAY = 86_400_000;
const CACHE_MAX = 8;
const _cache = new Map(); // key → { at, value }

/** 그 스캔의 비중 분모 — 루트 합계 우선, 없으면 폴더 합. */
function denomOf(scan) {
  const t = scan?.total?.bytes;
  if (Number.isFinite(t) && t > 0) return t;
  const s = scan?.sumBytes;
  return Number.isFinite(s) && s > 0 ? s : null;
}

function baseInfo(base, okScan) {
  if (!base) return null;
  return { scanId: base.id, ts: base.ts, spanDays: Math.round(((okScan.ts - base.ts) / DAY) * 10) / 10, errLines: base.errLines || 0 };
}

/**
 * 비교 묶음(최신·7일 전·30일 전) — 기억한다.
 * @returns {Promise<null|{latest, okScan, base7, base30, rows:object[], removed7:object[], denom:number|null}>}
 */
async function comparison(targetId) {
  const latest = await db.latestOf(HISTORY_AGENT, targetId);
  if (latest == null) return { unavailable: true };
  const okScan = latest.okScan;
  if (!okScan) return { latest, okScan: null };
  const [base7, base30] = await Promise.all([
    db.okScanAtOrBefore(HISTORY_AGENT, targetId, okScan.ts - 7 * DAY),
    db.okScanAtOrBefore(HISTORY_AGENT, targetId, okScan.ts - 30 * DAY),
  ]);
  const key = `${targetId}|${okScan.id}|${base7?.id ?? '-'}|${base30?.id ?? '-'}`;
  const hit = _cache.get(key);
  if (hit) { _cache.delete(key); _cache.set(key, hit); return { ...hit.value, latest }; }
  const cur = await db.entriesOf(okScan.id);
  const b7 = base7 ? await db.entriesOf(base7.id) : null;
  const b30 = base30 ? await db.entriesOf(base30.id) : null;
  const denom = denomOf(okScan);
  const rows = sortBySize([...cur.entries()].map(([name, v]) => ({ name, bytes: v.bytes, res: v.res })));
  rows.forEach((r, i) => {
    r.rank = i + 1;
    r.share = denom ? r.bytes / denom : null;
    const p7 = b7 ? b7.get(r.name) : undefined;
    const p30 = b30 ? b30.get(r.name) : undefined;
    r.d7 = p7 ? deltaOf(r, p7) : null;
    r.d30 = p30 ? deltaOf(r, p30) : null;
    // 신규: 기준이 있을 때만 판정한다(기준이 없으면 null — 신규라 단정하지 않는다).
    r.new7 = b7 ? !b7.has(r.name) : null;
    r.new30 = b30 ? !b30.has(r.name) : null;
  });
  const removed7 = b7 ? sortBySize([...b7.entries()].filter(([name]) => !cur.has(name)).map(([name, v]) => ({ name, bytes: v.bytes, res: v.res }))) : null;
  const value = { okScan, base7, base30, rows, removed7, denom };
  _cache.set(key, { at: Date.now(), value });
  while (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value);
  return { ...value, latest };
}

/** 스파크라인(30일) — 고른 이름만. */
async function sparksFor(targetId, names, sinceTs) {
  if (!names.length) return { ts: [], series: new Map() };
  return (await db.seriesOfNames(HISTORY_AGENT, targetId, names, sinceTs, 30)) || { ts: [], series: new Map() };
}

const rowView = (r, sp) => ({
  rank: r.rank, name: r.name, bytes: r.bytes, res: r.res, share: r.share,
  d7: r.d7, d30: r.d30, new7: r.new7, new30: r.new30, ...(sp ? { spark: sp } : {}),
});

/**
 * 대상 하나의 요약 보고서(KPI · Top N · 7일 증가 상위).
 * @param {string} targetId
 * @param {{topN?:number, now?:number}} [opts]
 */
export async function buildReport(targetId, { topN = 10 } = {}) {
  const c = await comparison(targetId);
  if (c.unavailable) return { state: 'db-unavailable' };
  const { latest } = c;
  if (!c.okScan) return { state: latest?.lastTry ? 'failed-only' : 'no-data', lastTry: latest?.lastTry || null, failStreak: latest?.failStreak || 0 };
  const { okScan, base7, base30, rows, removed7, denom } = c;
  const n = Math.max(5, Math.min(50, Math.round(Number(topN) || 10)));
  const top = rows.slice(0, n);
  let topBytes = 0; for (const r of top) topBytes += r.bytes;
  // 7일 증가 상위 — 해상도 안의 흔들림은 뺀다. 신규 폴더는 기준 크기 0 으로 세지 않고 따로 표시(신규).
  const growth = rows.filter((r) => r.d7 && r.d7.bytes > 0 && !r.d7.withinRes).sort((a, b) => b.d7.bytes - a.d7.bytes).slice(0, 8);
  const newTop = rows.filter((r) => r.new7 === true).slice(0, 8);
  const sinceSpark = okScan.ts - 30 * DAY;
  const sp = await sparksFor(targetId, [...new Set([...top, ...growth].map((r) => r.name))], sinceSpark);
  const sparkOf = (name) => sp.series.get(name) || null;
  const totalDelta7 = base7 ? deltaOf({ bytes: denom, res: okScan.total?.res ?? okScan.sumRes ?? 1 }, { bytes: denomOf(base7), res: base7.total?.res ?? base7.sumRes ?? 1 }) : null;
  const totalDelta30 = base30 ? deltaOf({ bytes: denom, res: okScan.total?.res ?? okScan.sumRes ?? 1 }, { bytes: denomOf(base30), res: base30.total?.res ?? base30.sumRes ?? 1 }) : null;
  const lastTry = latest.lastTry && latest.lastTry.id !== okScan.id ? latest.lastTry : null;
  return {
    state: 'ok',
    scan: {
      id: okScan.id, ts: okScan.ts, durationMs: okScan.durationMs, trig: okScan.trig, node: okScan.node || '', path: okScan.path, host: okScan.host,
      sizeMode: okScan.sizeMode, total: okScan.total, sumBytes: okScan.sumBytes, sumRes: okScan.sumRes, count: okScan.count,
      errLines: okScan.errLines || 0, errSample: okScan.errSample || [], skipped: okScan.skipped || 0, truncated: !!okScan.truncated,
    },
    // 최신 시도가 실패면(성공 스캔보다 뒤) 그 사실 — 화면이 '보이는 값은 N시간 전 것' 이라 말한다.
    lastFailure: lastTry && !lastTry.ok ? { ts: lastTry.ts, kind: lastTry.kind, error: lastTry.error, node: lastTry.node || '' } : null,
    failStreak: latest.failStreak || 0,
    base7: baseInfo(base7, okScan), base30: baseInfo(base30, okScan),
    kpi: {
      denomBytes: denom,
      totalDelta7, totalDelta30,
      users: rows.length,
      new7: base7 ? rows.filter((r) => r.new7 === true).length : null,
      removed7: removed7 ? removed7.length : null,
      topN: top.length, topBytes, topShare: denom ? topBytes / denom : null,
    },
    sparkTs: sp.ts,
    top: top.map((r) => rowView(r, sparkOf(r.name))),
    growth: growth.map((r) => rowView(r, sparkOf(r.name))),
    newTop: newTop.map((r) => rowView(r, null)),
    removedTop: (removed7 || []).slice(0, 8),
  };
}

const SORTS = Object.freeze(['size', 'name', 'd7', 'd30']);
const FILTERS = Object.freeze(['all', 'new', 'removed', 'grow', 'shrink']);
export const USERS_LIMIT_MAX = 500;

/**
 * 전체 사용자 표 — 검색·필터·정렬·페이지. 사라진 폴더(filter=removed)는 7일 전 크기를 보여 준다.
 * @returns {Promise<object>}
 */
export async function listUsers(targetId, { q = '', filter = 'all', sort = 'size', dir = 'desc', offset = 0, limit = 200, spark = true } = {}) {
  const c = await comparison(targetId);
  if (c.unavailable) return { state: 'db-unavailable' };
  if (!c.okScan) return { state: 'no-data', rows: [], total: 0 };
  const f = FILTERS.includes(filter) ? filter : 'all';
  const srt = SORTS.includes(sort) ? sort : 'size';
  const asc = dir === 'asc';
  const needle = String(q || '').trim().toLowerCase().slice(0, 100);
  let list;
  if (f === 'removed') {
    list = (c.removed7 || []).map((r) => ({ ...r, rank: null, share: null, d7: null, d30: null, new7: null, new30: null, removed: true }));
  } else {
    list = c.rows;
    if (f === 'new') list = list.filter((r) => r.new7 === true);
    else if (f === 'grow') list = list.filter((r) => r.d7 && r.d7.bytes > 0 && !r.d7.withinRes);
    else if (f === 'shrink') list = list.filter((r) => r.d7 && r.d7.bytes < 0 && !r.d7.withinRes);
  }
  if (needle) list = list.filter((r) => r.name.toLowerCase().includes(needle));
  const val = (r) => (srt === 'name' ? r.name : srt === 'd7' ? r.d7?.bytes : srt === 'd30' ? r.d30?.bytes : r.bytes);
  if (srt !== 'size' || asc || f === 'removed') {
    list = [...list].sort((a, b) => {
      const va = val(a); const vb = val(b);
      // 값이 없는 행은 방향과 무관하게 뒤로(STable 규약과 같다).
      if (va == null && vb == null) return a.name.localeCompare(b.name);
      if (va == null) return 1;
      if (vb == null) return -1;
      const d = srt === 'name' ? String(va).localeCompare(String(vb)) : va - vb;
      return (asc ? d : -d) || a.name.localeCompare(b.name);
    });
  }
  const total = list.length;
  const off = Math.max(0, Math.min(total, Math.floor(Number(offset) || 0)));
  const lim = Math.max(1, Math.min(USERS_LIMIT_MAX, Math.floor(Number(limit) || 200)));
  const page = list.slice(off, off + lim);
  const sp = spark && f !== 'removed' ? await sparksFor(targetId, page.map((r) => r.name), c.okScan.ts - 30 * DAY) : null;
  return {
    state: 'ok', scanId: c.okScan.id, scanTs: c.okScan.ts, total, offset: off, limit: lim, filter: f, sort: srt, dir: asc ? 'asc' : 'desc',
    hasBase7: !!c.base7, hasBase30: !!c.base30, sparkTs: sp ? sp.ts : [],
    rows: page.map((r) => (r.removed ? { name: r.name, bytes: r.bytes, res: r.res, removed: true } : rowView(r, sp ? (sp.series.get(r.name) || null) : null))),
  };
}

/** CSV 용 — 전체 행(사라진 폴더 포함). */
export async function allRows(targetId) {
  const c = await comparison(targetId);
  if (c.unavailable) return { state: 'db-unavailable' };
  if (!c.okScan) return { state: 'no-data', rows: [] };
  return { state: 'ok', scan: c.okScan, rows: c.rows, removed7: c.removed7 || [], hasBase7: !!c.base7, hasBase30: !!c.base30 };
}

export const TREND_DAYS = Object.freeze([7, 30, 90, 365]);

/**
 * 추이 — name 이 없으면 디렉터리 전체(루트 합계, 없으면 폴더 합), 있으면 그 사용자 폴더. 권한 오류가 있던 스캔은 partial 로 표시한다.
 */
export async function trend(targetId, { name = '', days = 30 } = {}) {
  const d = TREND_DAYS.includes(Number(days)) ? Number(days) : 30;
  const latest = await db.latestOf(HISTORY_AGENT, targetId);
  if (latest == null) return { state: 'db-unavailable' };
  const endTs = latest.okScan?.ts ?? Date.now();
  const since = endTs - d * DAY;
  if (name) {
    const pts = await db.seriesOfName(HISTORY_AGENT, targetId, String(name).slice(0, 512), since);
    if (pts == null) return { state: 'db-unavailable' };
    return { state: 'ok', name, days: d, points: pts.map((p) => ({ ts: p.ts, bytes: p.bytes, res: p.res })) };
  }
  const scans = await db.scansIn(HISTORY_AGENT, targetId, since, 5000);
  if (scans == null) return { state: 'db-unavailable' };
  const points = scans.filter((s) => s.ok).map((s) => ({ ts: s.ts, bytes: denomOf(s), res: s.total?.res ?? s.sumRes ?? null, count: s.count, partial: (s.errLines || 0) > 0 }));
  const failures = scans.filter((s) => !s.ok).map((s) => ({ ts: s.ts, kind: s.kind }));
  return { state: 'ok', name: '', days: d, points, failures };
}

export function _resetForTest() { _cache.clear(); }
