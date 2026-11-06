/**
 * usage/store.js — 기능 사용 추적의 수신 · 모으기 · 저장 · 집계(v2.912, 설계 docs/design/feature-usage §4).
 *
 * 수신(`recordUsage`) — 화면이 주소를 바꿀 때 열람 1회(hit), 보고 있는 동안 10초마다 머문 조각(ms)을 보낸다.
 *   · **계정은 인증된 사용자(req.user)로만** 적는다 — 본문의 계정명은 받지 않는다.
 *   · 꺼짐 · 설정 못 읽음 · 데모/제외 계정 · 모르는 키 · 분당 상한 초과는 조용히 버리고 사유별로 센다(상태 화면 '버린 신호').
 *   · 같은 키 열람이 2초 안에 다시 오면 한 번으로 센다(React 이펙트 · hashchange 가 같은 전환을 두 번 알리는 것).
 *   · 머문 조각은 한 번에 15초까지 · **계정당 벽시계를 넘지 않게**(창 두 개가 동시에 보내도 직전 조각 뒤 흐른 시간까지만 더한다).
 * 모으기 — 메모리 맵(날 × 계정 × 키)에 더했다가 60초마다 **한 트랜잭션**으로 DB 에 더한다(perf-db '대량 쓰기는 트랜잭션'). 종료 때는 동기로 한 번 더.
 *   DB 를 못 쓰면 버리지 않고 다음 주기에 다시 시도한다(상한 2만 칸 — 넘으면 새 칸은 버리고 센다).
 * 정리 — 저장 60번(약 1시간)마다 보관 기간 밖을 청크로(기동 첫 틱 금지 — `(++tick % N) === 0`).
 * 집계(`buildUsageReport`) — 날마다 그 날 행만 읽고(PK 첫 열 = day) 시간 기준으로 양보한다(createYielder). 아직 저장하지 않은 메모리 분도 더한다.
 *   기록이 꺼져 있던 날은 0 이 아니라 '꺼짐' 으로 표시하고 하루 평균의 분모에서 뺀다(numOrNull 원칙 — 못 센 것은 0 이 아니다).
 */
import { dayKey, dayIndex, dayLabel, dayStartMs, DAY_MS } from '../util/dayKey.js';
import { createYielder } from '../util/timeSlice.js';
import { registerExitFlush } from '../util/exitFlush.js';
import { listUsers, getUser } from '../auth/auth.js';
import { isDemoGuest } from '../auth/demoGuest.js';
import { scopedVcenterIds } from '../auth/scope.js';
import { store } from '../store.js';
import { validUsageKey } from './keys.js';
import { loadUsageSettings, usageSettingsLoadError, userKeyOf, onIntervals } from './settings.js';
import { writeBatch, writeBatchSync, dayRows, knownUsers, pruneUsage, purgeUsage, usageDbInfo } from './db.js';

export const FLUSH_MS = 60_000;
export const BEAT_MAX_MS = 15_000;
export const HIT_DEDUP_MS = 2_000;
export const RATE_PER_MIN = 120;
export const PENDING_MAX = 20_000;
export const PRUNE_EVERY = 60;
export const REPORT_MAX_DAYS = 366;

const SEP = '\u0000';
let pending = new Map();        // `${day}\0${user}\0${k}` → { day, user, k, views, ms, last }
let pendingUsers = new Map();   // user → { user, name, role, scoped, src, last }
const lastHit = new Map();      // user → { k, at }
const lastBeat = new Map();     // user → at
const rate = new Map();         // user → { win, n }
let flushTimer = null;
let tick = 0;
let flushing = null;

const emptyStats = () => ({ since: Date.now(), received: 0, accepted: 0, dropped: Object.create(null), lastSignal: null, lastFlush: null, day: '', dayViews: 0, dayUsers: new Set() });
let stats = emptyStats();

function drop(reason) {
  stats.dropped[reason] = (stats.dropped[reason] || 0) + 1;
  return { ok: false, reason };
}

function ensureTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(() => { flushUsage().catch(() => {}); }, FLUSH_MS);
  flushTimer.unref?.();
}

const srcOf = (username) => { try { return getUser(username) ? 'local' : 'ad'; } catch { return 'unknown'; } };
const scopedOf = (user) => { try { return !!scopedVcenterIds(user, store.get()); } catch { return true; } };

/**
 * 신호 하나를 받는다. 라우트는 결과를 그대로 200 으로 돌려준다(화면은 결과를 보지 않는다 — 조용한 전송).
 * @param {{ user: object, k: unknown, hit?: unknown, ms?: unknown, now?: number }} a
 */
export function recordUsage({ user, k, hit, ms, now = Date.now() }) {
  const s = loadUsageSettings();
  if (!s.enabled) return { ok: false, reason: 'disabled' };   // 꺼짐은 세지 않는다(사용자 활동을 남기지 않는다)
  stats.received += 1;
  if (usageSettingsLoadError()) return drop('settings-unreadable');
  const username = typeof user?.username === 'string' ? user.username : '';
  const uk = userKeyOf(username);
  if (!uk || uk.length > 64) return drop('no-user');
  if (isDemoGuest(user)) return drop('excluded');
  if ((s.excluded || []).some((e) => userKeyOf(e) === uk)) return drop('excluded');
  if (!validUsageKey(k)) return drop('unknown-key');
  const win = Math.floor(now / 60_000);
  const r = rate.get(uk);
  if (r && r.win === win) { if (r.n >= RATE_PER_MIN) return drop('rate-limited'); r.n += 1; } else rate.set(uk, { win, n: 1 });

  let views = 0;
  if (hit === true) {
    const lh = lastHit.get(uk);
    // 기준은 '마지막으로 센 열람' — 거른 신호로 창을 늘리지 않는다(2초마다 오는 신호가 영영 안 세지는 일이 없게).
    if (!(lh && lh.k === k && now - lh.at < HIT_DEDUP_MS)) { views = 1; lastHit.set(uk, { k, at: now }); }
  }
  let credited = 0;
  const m = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.min(ms, BEAT_MAX_MS) : 0;
  if (m > 0) {
    const lb = lastBeat.get(uk);
    credited = lb == null ? m : Math.min(m, Math.max(0, now - lb));
    lastBeat.set(uk, now);
  }
  if (!views && !credited) return { ok: true, counted: false };

  const day = dayKey(now);
  const key = `${day}${SEP}${uk}${SEP}${k}`;
  let row = pending.get(key);
  if (!row) {
    if (pending.size >= PENDING_MAX) return drop('buffer-full');
    row = { day, user: uk, k, views: 0, ms: 0, last: now };
    pending.set(key, row);
  }
  row.views += views; row.ms += credited; row.last = now;
  const pu = pendingUsers.get(uk);
  if (pu) pu.last = now;
  else pendingUsers.set(uk, { user: uk, name: String(user?.name || username).slice(0, 80), role: String(user?.role || '').slice(0, 20), scoped: scopedOf(user), src: srcOf(username), last: now });

  stats.accepted += 1;
  stats.lastSignal = { at: now, user: uk, k };
  if (stats.day !== day) { stats.day = day; stats.dayViews = 0; stats.dayUsers = new Set(); }
  stats.dayViews += views; stats.dayUsers.add(uk);
  ensureTimer();
  return { ok: true, counted: true };
}

function takePending() {
  const rows = [...pending.values()];
  const users = [...pendingUsers.values()];
  pending = new Map(); pendingUsers = new Map();
  return { rows, users };
}
function restorePending(rows, users) {
  for (const r of rows) {
    const key = `${r.day}${SEP}${r.user}${SEP}${r.k}`;
    const cur = pending.get(key);
    if (cur) { cur.views += r.views; cur.ms += r.ms; cur.last = Math.max(cur.last, r.last); }
    else if (pending.size < PENDING_MAX) pending.set(key, r);
    else drop('buffer-full');
  }
  for (const u of users) if (!pendingUsers.has(u.user)) pendingUsers.set(u.user, u);
}

/** 모아 둔 것을 DB 에 더한다(겹쳐 부르면 진행 중인 것을 공유). */
export function flushUsage(now = Date.now()) {
  if (flushing) return flushing;
  flushing = (async () => {
    const { rows, users } = takePending();
    if (rows.length || users.length) {
      const res = await writeBatch(rows, users);
      stats.lastFlush = { at: now, rows: res.rows, ms: res.ms ?? null, ok: res.ok, reason: res.reason || '' };
      if (!res.ok) restorePending(rows, users);
    }
    // 오래된 속도 · 중복 판정 칸 정리(계정 수만큼만 자란다)
    for (const [u, v] of lastHit) if (now - v.at > 3_600_000) lastHit.delete(u);
    for (const [u, at] of lastBeat) if (now - at > 3_600_000) lastBeat.delete(u);
    for (const [u, v] of rate) if (v.win < Math.floor(now / 60_000) - 1) rate.delete(u);
    if ((++tick % PRUNE_EVERY) === 0) {
      const keep = loadUsageSettings().keepDays;
      await pruneUsage(dayKey(now - keep * DAY_MS)).catch(() => {});
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

registerExitFlush('usage', () => {
  if (!pending.size && !pendingUsers.size) return;
  const { rows, users } = takePending();
  writeBatchSync(rows, users);
});

/* ── 집계 ─────────────────────────────────────────────────────────────────── */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 기간 → 날 인덱스 [from, to]. days(1~366) 또는 from/to(YYYY-MM-DD). 틀리면 status 400 오류. */
export function resolveRange({ days, from, to, now = Date.now() } = {}) {
  const today = dayIndex(now);
  const bad = (msg) => { const e = new Error(msg); e.status = 400; return e; };
  if (from != null || to != null) {
    if (!DAY_RE.test(String(from || '')) || !DAY_RE.test(String(to || ''))) throw bad('from·to 는 YYYY-MM-DD 여야 합니다');
    const f = dayIndex(Date.parse(`${from}T00:00:00Z`), 0);
    const t = dayIndex(Date.parse(`${to}T00:00:00Z`), 0);
    if (!Number.isFinite(f) || !Number.isFinite(t) || f > t) throw bad('기간이 올바르지 않습니다');
    if (t - f + 1 > REPORT_MAX_DAYS) throw bad(`기간은 ${REPORT_MAX_DAYS}일까지입니다`);
    return { fromIdx: f, toIdx: Math.min(t, today), today };
  }
  const n = days == null || days === '' ? 30 : Number(days);
  if (!Number.isInteger(n) || n < 1 || n > REPORT_MAX_DAYS) throw bad(`days 는 1~${REPORT_MAX_DAYS} 정수여야 합니다`);
  return { fromIdx: today - n + 1, toIdx: today, today };
}

/** 하루가 기록 켜짐 구간과 얼마나 겹치는가: 'on' | 'part' | 'off'. 오늘은 지금까지만 본다. */
export function dayRecState(idx, intervals, now = Date.now()) {
  const a = dayStartMs(idx);
  const b = Math.min(a + DAY_MS, now);
  if (b <= a) return 'off';
  let covered = 0;
  for (const iv of intervals) {
    const lo = Math.max(a, iv.from); const hi = Math.min(b, iv.to);
    if (hi > lo) covered += hi - lo;
  }
  if (covered <= 0) return 'off';
  return covered >= b - a ? 'on' : 'part';
}

async function rowsOfDay(label, user) {
  const db = await dayRows(label, user);
  if (db == null) { const e = new Error('usage.db 를 열지 못했습니다'); e.status = 503; e.code = 'db-unavailable'; throw e; }
  const out = db.map((r) => ({ user: r.user, k: r.k, views: Number(r.views) || 0, ms: Number(r.active_ms) || 0, last: r.last_ts == null ? null : Number(r.last_ts) }));
  let idx = null;
  for (const p of pending.values()) {
    if (p.day !== label || (user && p.user !== user)) continue;
    if (!idx) { idx = new Map(); for (const r of out) idx.set(`${r.user}${SEP}${r.k}`, r); }
    const hit = idx.get(`${p.user}${SEP}${p.k}`);
    if (hit) { hit.views += p.views; hit.ms += p.ms; hit.last = Math.max(hit.last || 0, p.last); }
    else { const r = { user: p.user, k: p.k, views: p.views, ms: p.ms, last: p.last }; out.push(r); idx.set(`${p.user}${SEP}${p.k}`, r); }
  }
  return out;
}

const scopedFromList = (u) => !!(u?.scope && ((u.scope.vcenters || []).length || (u.scope.regions || []).length));

/** 계정 표(이름 · 역할 · 범위 · 출처) — 로컬 계정은 지금 값, 그 밖(AD)은 마지막 기록 값. */
async function accountTable() {
  const map = new Map();
  for (const r of (await knownUsers()) || []) map.set(r.user, { user: r.user, name: r.name || r.user, role: r.role || '', scoped: !!r.scoped, src: r.src || 'ad', last: r.last_ts == null ? null : Number(r.last_ts) });
  for (const u of pendingUsers.values()) map.set(u.user, { ...(map.get(u.user) || {}), ...u, last: Math.max(map.get(u.user)?.last || 0, u.last) });
  let local = [];
  try { local = listUsers(); } catch { local = []; }
  for (const u of local) {
    const k = userKeyOf(u.username);
    if (!k) continue;
    const prev = map.get(k);
    map.set(k, { user: k, name: u.name || u.username, role: u.role || '', scoped: scopedFromList(u), src: 'local', last: prev?.last ?? null, demo: !!u.demo });
  }
  return map;
}

/**
 * 기간 집계 — 설정 › 사용자 › 기능 사용 현황의 개요 · 기능별 · 사용자별 탭이 한 번에 쓴다.
 * @returns {Promise<object>}
 */
export async function buildUsageReport({ days, from, to, now = Date.now() } = {}) {
  const { fromIdx, toIdx, today } = resolveRange({ days, from, to, now });
  const s = loadUsageSettings();
  const iv = onIntervals(s);
  const yieldNow = createYielder(15);
  const n = toIdx - fromIdx + 1;

  const byKey = new Map(); const byUser = new Map(); const daily = [];
  for (let i = fromIdx; i <= toIdx; i++) {
    const label = dayLabel(i);
    const rows = await rowsOfDay(label, null);
    const dUsers = new Set(); let dv = 0; let dms = 0;
    for (const r of rows) {
      dv += r.views; dms += r.ms; dUsers.add(r.user);
      let a = byKey.get(r.k); if (!a) { a = { k: r.k, views: 0, ms: 0, users: new Set(), last: null }; byKey.set(r.k, a); }
      a.views += r.views; a.ms += r.ms; a.users.add(r.user); if (r.last && (!a.last || r.last > a.last)) a.last = r.last;
      let u = byUser.get(r.user); if (!u) { u = { user: r.user, views: 0, ms: 0, days: new Set(), keys: new Map(), spark: new Array(n).fill(0), last: null }; byUser.set(r.user, u); }
      u.views += r.views; u.ms += r.ms; u.days.add(i); u.keys.set(r.k, (u.keys.get(r.k) || 0) + r.views); u.spark[i - fromIdx] += r.views;
      if (r.last && (!u.last || r.last > u.last)) u.last = r.last;
    }
    daily.push({ day: label, views: dv, ms: dms, users: dUsers.size, rec: dayRecState(i, iv, now), today: i === today });
    await yieldNow();
  }

  // 직전 같은 길이 기간 — 기능별 '지난 기간 대비'. 그 기간에 기록이 하나도 켜져 있지 않았으면 비교값은 null(0% 가 아니다).
  const prev = new Map(); let prevViews = 0; let prevOnDays = 0;
  for (let i = fromIdx - n; i < fromIdx; i++) {
    if (dayRecState(i, iv, now) === 'off') continue;
    prevOnDays += 1;
    for (const r of await rowsOfDay(dayLabel(i), null)) { prev.set(r.k, (prev.get(r.k) || 0) + r.views); prevViews += r.views; }
    await yieldNow();
  }

  const accounts = await accountTable();
  const excluded = new Set((s.excluded || []).map(userKeyOf));
  const acct = (u) => accounts.get(u) || { user: u, name: u, role: '', scoped: false, src: 'ad', last: null };
  const users = [...byUser.values()].map((u) => {
    const a = acct(u.user);
    const top = [...u.keys.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, 3).map(([k, v]) => ({ k, views: v }));
    return { user: u.user, name: a.name, role: a.role, scoped: a.scoped, src: a.src, views: u.views, ms: u.ms, days: u.days.size, keys: u.keys.size, top, spark: u.spark, last: u.last };
  }).sort((a, b) => b.views - a.views || (a.user < b.user ? -1 : 1));
  const active = new Set(users.map((u) => u.user));
  const idle = [...accounts.values()].filter((a) => !active.has(a.user) && !excluded.has(a.user) && !a.demo)
    .map((a) => ({ user: a.user, name: a.name, role: a.role, scoped: a.scoped, src: a.src, last: a.last }))
    .sort((a, b) => (b.last || 0) - (a.last || 0) || (a.user < b.user ? -1 : 1));
  const userKeys = [];
  for (const u of byUser.values()) for (const [k, v] of u.keys) userKeys.push([u.user, k, v]);

  const tot = { views: 0, ms: 0 };
  for (const a of byKey.values()) { tot.views += a.views; tot.ms += a.ms; }
  const recDays = daily.filter((d) => d.rec !== 'off').length;
  return {
    ok: true,
    range: { from: dayLabel(fromIdx), to: dayLabel(toIdx), days: n, today: dayLabel(today), partialToday: toIdx === today },
    settings: { enabled: s.enabled, idleMin: s.idleMin, keepDays: s.keepDays },
    totals: { views: tot.views, ms: tot.ms, activeUsers: users.length, usedKeys: byKey.size, recDays },
    prev: { available: prevOnDays > 0, views: prevOnDays > 0 ? prevViews : null, onDays: prevOnDays },
    byKey: [...byKey.values()].map((a) => ({ k: a.k, views: a.views, ms: a.ms, users: a.users.size, last: a.last, prevViews: prevOnDays > 0 ? (prev.get(a.k) || 0) : null }))
      .sort((a, b) => b.views - a.views || (a.k < b.k ? -1 : 1)),
    prevKeys: prevOnDays > 0 ? [...prev.entries()].filter(([k]) => !byKey.has(k)).map(([k, v]) => ({ k, prevViews: v })) : [],
    users, idle, userKeys, daily,
    gaps: gapsIn(iv, dayStartMs(fromIdx), Math.min(dayStartMs(toIdx) + DAY_MS, now), s),
    generatedAt: now,
  };
}

/** 기간 안의 '꺼짐' 구간(누가 껐는지 함께). */
function gapsIn(iv, a, b, s) {
  const out = [];
  let cur = a;
  for (const x of [...iv].sort((p, q) => p.from - q.from)) {
    if (x.to <= a || x.from >= b) continue;
    if (x.from > cur) out.push({ from: cur, to: Math.min(x.from, b) });
    cur = Math.max(cur, x.to);
  }
  if (cur < b) out.push({ from: cur, to: b });
  const offBy = (t) => [...(s.toggles || [])].reverse().find((g) => !g.on && g.at <= t + 1)?.by || null;
  return out.map((g) => ({ ...g, by: offBy(g.from) }));
}

/** 한 계정의 기간 집계(개인 상세 드로어). */
export async function buildUserUsage({ user, days, from, to, now = Date.now() } = {}) {
  const uk = userKeyOf(user);
  if (!uk) { const e = new Error('계정 이름이 비었습니다'); e.status = 400; throw e; }
  const { fromIdx, toIdx, today } = resolveRange({ days, from, to, now });
  const iv = onIntervals(loadUsageSettings());
  const yieldNow = createYielder(15);
  const byKey = new Map(); const daily = []; let views = 0; let ms = 0; let last = null; let activeDays = 0;
  for (let i = fromIdx; i <= toIdx; i++) {
    const rows = await rowsOfDay(dayLabel(i), uk);
    let dv = 0; let dms = 0;
    for (const r of rows) {
      dv += r.views; dms += r.ms;
      let a = byKey.get(r.k); if (!a) { a = { k: r.k, views: 0, ms: 0, last: null }; byKey.set(r.k, a); }
      a.views += r.views; a.ms += r.ms; if (r.last && (!a.last || r.last > a.last)) a.last = r.last;
      if (r.last && (!last || r.last > last)) last = r.last;
    }
    if (rows.length) activeDays += 1;
    views += dv; ms += dms;
    daily.push({ day: dayLabel(i), views: dv, ms: dms, rec: dayRecState(i, iv, now), today: i === today });
    await yieldNow();
  }
  const accounts = await accountTable();
  const a = accounts.get(uk) || { user: uk, name: uk, role: '', scoped: false, src: 'ad', last: null };
  return {
    ok: true,
    range: { from: dayLabel(fromIdx), to: dayLabel(toIdx), days: toIdx - fromIdx + 1, today: dayLabel(today), partialToday: toIdx === today },
    account: { user: a.user, name: a.name, role: a.role, scoped: a.scoped, src: a.src, last: last || a.last || null },
    totals: { views, ms, days: activeDays, keys: byKey.size },
    byKey: [...byKey.values()].sort((x, y) => y.views - x.views || (x.k < y.k ? -1 : 1)),
    daily,
  };
}

/** CSV 행(일 집계 그대로) — 날 · 계정 · 이름 · 역할 · 키 · 열람 · 머문 초. */
export async function* usageCsvRows({ days, from, to, now = Date.now() } = {}) {
  const { fromIdx, toIdx } = resolveRange({ days, from, to, now });
  const accounts = await accountTable();
  const yieldNow = createYielder(15);
  for (let i = fromIdx; i <= toIdx; i++) {
    const label = dayLabel(i);
    const rows = (await rowsOfDay(label, null)).sort((a, b) => (a.user < b.user ? -1 : a.user > b.user ? 1 : (a.k < b.k ? -1 : 1)));
    for (const r of rows) {
      const a = accounts.get(r.user);
      yield [label, r.user, a?.name || '', a?.role || '', r.k, r.views, Math.round(r.ms / 1000)];
    }
    await yieldNow();
  }
}

/** 수집 설정 화면의 '지금 상태'. */
export async function usageStatus(now = Date.now()) {
  const s = loadUsageSettings();
  const db = await usageDbInfo();
  const today = dayKey(now);
  return {
    enabled: s.enabled,
    loadError: usageSettingsLoadError(),
    since: stats.since,
    received: stats.received,
    accepted: stats.accepted,
    dropped: { ...stats.dropped },
    lastSignal: stats.lastSignal,
    today: stats.day === today ? { views: stats.dayViews, users: stats.dayUsers.size } : { views: 0, users: 0 },
    pending: pending.size,
    lastFlush: stats.lastFlush,
    flushEveryMs: FLUSH_MS,
    db,
  };
}

/** 기록 지우기 — 메모리에 모아 둔 분도 같은 범위로 지운다. */
export async function purgeUsageRecords({ scope, user = '', before = '' }) {
  const uk = userKeyOf(user);
  for (const [key, r] of pending) {
    if (scope === 'all' || (scope === 'user' && r.user === uk) || (scope === 'before' && r.day < before)) pending.delete(key);
  }
  if (scope === 'all') pendingUsers.clear();
  if (scope === 'user') pendingUsers.delete(uk);
  return purgeUsage({ scope, user: uk, before });
}

/** 테스트용. */
export function _resetUsageStore() {
  pending = new Map(); pendingUsers = new Map(); lastHit.clear(); lastBeat.clear(); rate.clear();
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  tick = 0; flushing = null; stats = emptyStats();
}
export function _pendingSize() { return pending.size; }
