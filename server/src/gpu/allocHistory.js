/**
 * gpu/allocHistory.js — GPU 할당율 **일 단위 이력**(v2.937 개선 7 · gpu-alloc.db).
 *
 * 왜: 'GPU 할당율' 은 지금 값만 보여 줬다 — 증가 추세와 소진 예상 시점은 지난 값이 있어야 그린다. 법인(vCenter)마다 하루 한 점
 *   (그날의 마지막 값으로 덮는다)을 쌓는다. 28법인 × 800일 ≈ 2.2만 행이라 작다.
 *
 * 표: alloc_daily(vc, day, ts, cap, alloc, gpus, hosts) — 기본 키 (vc, day) · ON CONFLICT DO UPDATE(같은 날 다시 쓰면 갱신 · 이중 계수 없음).
 * 무엇을 쌓나(부분 합 금지 — 루트 CLAUDE.md '부분 합은 추이에 적재하지 않는다'):
 *   · 용량·할당을 **모두 아는** 법인만(capUnknown 0 · allocUnknown 0 · 용량 > 0). 모르는 값이 섞인 날은 그 법인의 점을 쓰지 않는다
 *     (그날 앞서 쓴 온전한 값이 남는다).
 *   · 지금 값을 읽지 못한 법인(연결 불가 · 첫 수집 중 · 점검 중 · 낡은 위임 보고 — metrics/unreadVcenters.js)은 쓰지 않는다.
 * 보관: 800일(KEEP_DAYS) — prune 은 쓰기 N회마다 1회(기동 첫 회 금지) · day 단독 인덱스 · 청크 삭제(util/chunkedPrune.js).
 * 한 번의 기록은 한 트랜잭션. node:sqlite 를 못 쓰면 기록은 건너뛰고(경고 1회) 조회는 null — 화면은 '이력 없음' 으로 말한다.
 * 수집 주기: 1시간(startGpuAllocHistory — 재진입 가드 · 기동 2분 뒤 첫 회). 엣지에서도 돈다(자기 법인 화면용 — 비용은 무시할 만하다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { openSqlite, withOpenCleanup, createLockRetry } from '../util/sqliteOpen.js';
import { chunkedDelete } from '../util/chunkedPrune.js';
import { dayIndex, dayStartMs, dayLabel } from '../util/dayKey.js';
import { numOrNull } from '../util/numOrNull.js';
import { linearTrend } from '../system/memtrack.js';
import { unreadVcenterReasons } from '../metrics/unreadVcenters.js';
import { buildGpuAllocTree } from './allocTree.js';

export const KEEP_DAYS = 800;
export const HISTORY_DAYS_MAX = 400;
const PRUNE_EVERY = 24;
export const SAMPLE_EVERY_MS = 3_600_000;
const dbPath = () => config.gpuAllocHistory?.dbPath || path.join(config.configDir, 'gpu-alloc.db');

let _db = null;
let _opening = null;
let unavailable = false;
let _warned = false;
let _writes = 0;
const _lock = createLockRetry(30_000);

function initSqlite(file) {
  // eslint-disable-next-line import/no-unresolved
  return import('node:sqlite').then(({ DatabaseSync }) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = openSqlite(new DatabaseSync(file));
    try { fs.chmodSync(file, 0o600); } catch { /* best effort — v2.503 S-5 */ }
    db.exec(`
      CREATE TABLE IF NOT EXISTS alloc_daily (
        vc TEXT NOT NULL, day INTEGER NOT NULL, ts INTEGER NOT NULL,
        cap REAL, alloc REAL, gpus INTEGER, hosts INTEGER,
        PRIMARY KEY (vc, day)
      );
      CREATE INDEX IF NOT EXISTS idx_gpualloc_day ON alloc_daily (day);
    `);
    return {
      raw: db,
      up: db.prepare(`INSERT INTO alloc_daily (vc, day, ts, cap, alloc, gpus, hosts) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(vc, day) DO UPDATE SET ts=excluded.ts, cap=excluded.cap, alloc=excluded.alloc, gpus=excluded.gpus, hosts=excluded.hosts
        WHERE excluded.ts >= alloc_daily.ts`),
      since: db.prepare('SELECT vc, day, cap, alloc, gpus, hosts FROM alloc_daily WHERE day >= ? ORDER BY vc, day'),
      del: db.prepare('DELETE FROM alloc_daily WHERE rowid IN (SELECT rowid FROM alloc_daily WHERE day < ? LIMIT ?)'),
    };
  });
}

/** DB 핸들(없으면 null). 진행 중인 open 을 공유한다(test/arch2580 규약). 잠금이면 래치하지 않고 30초 뒤 다시. */
export async function getAllocHistoryDb() {
  if (_db) return _db;
  if (unavailable || _lock.blocked()) return null;
  if (!_opening) {
    _opening = withOpenCleanup(() => initSqlite(dbPath()))
      .then((db) => { _lock.ok(); return db; })
      .catch((e) => {
        if (!_lock.onFail(e)) unavailable = true;
        if (!_warned) { _warned = true; console.warn(`[gpu-alloc-history] 이력 DB 를 열지 못했습니다 — GPU 할당 추이를 쌓지 않습니다: ${String(e?.message || e).slice(0, 200)}`); }
        return null;
      });
  }
  const p = _opening;
  const db = await p;
  if (db) _db = db; else if (_opening === p) _opening = null;
  return db;
}

async function maybePrune(db) {
  if ((++_writes % PRUNE_EVERY) !== 0) return;   // 기동 첫 쓰기에서는 돌지 않는다
  try { await chunkedDelete(db.del, [dayIndex(Date.now()) - KEEP_DAYS]); }
  catch (e) { console.warn(`[gpu-alloc-history] 오래된 이력 정리 실패(다음에 다시): ${String(e?.message || e).slice(0, 200)}`); }
}

/**
 * 스냅샷 → 쌓을 행(순수). 용량·할당을 모두 아는 법인만, 지금 값을 읽지 못한 법인은 뺀다(위 머리말).
 * @returns {{ vc: string, cap: number, alloc: number, gpus: number, hosts: number }[]}
 */
export function allocDailyRows(snap) {
  const unread = unreadVcenterReasons(snap || {});
  const tree = buildGpuAllocTree(snap || {});
  const out = [];
  for (const vc of tree.vcenters) {
    const t = vc.totals;
    if (unread.has(String(vc.id))) continue;
    if (t.capUnknown || t.allocUnknown || !(numOrNull(t.capGB) > 0) || numOrNull(t.allocGB) == null) continue;
    out.push({ vc: String(vc.id).slice(0, 200), cap: t.capGB, alloc: t.allocGB, gpus: t.gpus, hosts: t.hosts });
  }
  // 계층이 상한으로 잘렸으면(ALLOC_TREE_HOSTS_MAX) 어느 법인이 덜 셌는지 모른다 — 그 시각에는 아무것도 쓰지 않는다.
  return tree.truncated ? [] : out;
}

/** 한 시각의 행들을 한 트랜잭션으로. @returns {Promise<number>} 쓴 행 수(DB 없음 = 0) */
export async function recordAllocDaily(rows, ts = Date.now()) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.vc === 'string' && r.vc).slice(0, 2000);
  if (!list.length) return 0;
  const db = await getAllocHistoryDb();
  if (!db) return 0;
  const day = dayIndex(ts);
  db.raw.exec('BEGIN');
  try {
    for (const r of list) db.up.run(r.vc, day, ts, numOrNull(r.cap), numOrNull(r.alloc), numOrNull(r.gpus), numOrNull(r.hosts));
    db.raw.exec('COMMIT');
  } catch (e) { try { db.raw.exec('ROLLBACK'); } catch { /* */ } throw e; }
  await maybePrune(db);
  return list.length;
}

/** 최근 N일 — vc → [[day, cap, alloc]]. DB 가 없으면 null(모름 — 빈 이력과 구분). */
export async function allocHistoryRows(days = 90, now = Date.now()) {
  const db = await getAllocHistoryDb();
  if (!db) return null;
  const out = new Map();
  for (const r of db.since.all(dayIndex(now) - Math.max(1, Math.min(HISTORY_DAYS_MAX, Number(days) || 90)))) {
    (out.get(r.vc) || out.set(r.vc, []).get(r.vc)).push([r.day, r.cap, r.alloc]);
  }
  return out;
}

/**
 * 추세 · 소진 예상(순수). 최근 30일 안 점이 7개 이상이고 할당이 늘며(기울기 > 0) 결정계수가 0.3 이상일 때만 남은 일수를 낸다 —
 * 아니면 null(모름 — '소진 안 함' 이 아니다). 남은 일수 = (지금 용량 − 지금 할당) / 하루 증가량. 용량이 바뀌면 지금 용량 기준이다.
 * @param {number[][]} series [[day, cap, alloc]] 날짜 순
 */
export function allocTrend(series, { windowDays = 30, minPoints = 7, minR2 = 0.3 } = {}) {
  const s = (Array.isArray(series) ? series : []).filter((x) => Array.isArray(x) && Number.isFinite(x[0]) && Number.isFinite(x[1]) && Number.isFinite(x[2]))
    .sort((a, b) => a[0] - b[0]);
  if (!s.length) return { points: 0, gbPerDay: null, change30: null, daysLeft: null, r2: null, over: false };
  const last = s[s.length - 1];
  const win = s.filter((x) => x[0] > last[0] - windowDays);
  const first = win[0];
  const change30 = win.length >= 2 ? Math.round((last[2] - first[2]) * 10) / 10 : null;
  const over = last[2] > last[1];   // 이미 할당이 용량을 넘음 — 남은 일수가 아니라 '넘음' 으로 말한다
  if (win.length < minPoints) return { points: win.length, gbPerDay: null, change30, daysLeft: null, r2: null, over };
  const tr = linearTrend(win.map((x) => ({ ts: dayStartMs(x[0]), v: x[2] })));
  if (!tr) return { points: win.length, gbPerDay: null, change30, daysLeft: null, r2: null, over };
  const gbPerDay = tr.mbPerDay;   // linearTrend 는 단위를 모른다 — 여기서는 GB/일
  const spare = last[1] - last[2];
  const daysLeft = gbPerDay > 0 && tr.r2 >= minR2 && spare >= 0 ? Math.floor(spare / gbPerDay) : null;
  return { points: win.length, gbPerDay, change30, daysLeft, r2: tr.r2, over };
}

/**
 * 화면 응답(순수). byVc = allocHistoryRows 결과(이미 범위로 자른 것). 합계 줄은 **그날 모든 법인의 점이 있을 때만** 낸다
 * (어느 법인이 빠진 날의 합은 부분 합 — 그 날은 null 로 두어 선이 끊긴다).
 */
export function allocHistoryView(byVc, { names = new Map(), now = Date.now() } = {}) {
  if (!byVc) return { available: false, corps: [], total: [], totalTrend: null };
  const corps = [...byVc.entries()].map(([id, pts]) => {
    const last = pts[pts.length - 1];
    return { id, name: names.get(id) || id, points: pts, lastDay: last ? dayLabel(last[0]) : null,
      pct: last && last[1] > 0 ? Math.round((last[2] / last[1]) * 100) : null, trend: allocTrend(pts) };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const days = [...new Set(corps.flatMap((c) => c.points.map((p) => p[0])))].sort((a, b) => a - b);
  const byDay = corps.map((c) => new Map(c.points.map((p) => [p[0], p])));
  const total = days.map((d) => {
    let cap = 0; let alloc = 0;
    for (const m of byDay) { const p = m.get(d); if (!p) return [d, null, null]; cap += p[1]; alloc += p[2]; }
    return [d, Math.round(cap * 10) / 10, Math.round(alloc * 10) / 10];
  });
  const full = total.filter((x) => x[1] != null);
  return { available: true, today: dayIndex(now), corps, total, totalTrend: full.length ? allocTrend(full) : null,
    labels: Object.fromEntries(days.map((d) => [d, dayLabel(d)])) };
}

let _timer = null;
let _boot = null;
let _running = false;
/** 한 번 쌓기(재진입 가드 — perf-db 규약). @returns {Promise<number>} */
export async function sampleAllocHistoryOnce(getSnap) {
  if (_running) return 0;
  _running = true;
  try { return await recordAllocDaily(allocDailyRows(getSnap())); }
  catch (e) { console.warn(`[gpu-alloc-history] 기록 실패(다음 주기에 다시): ${String(e?.message || e).slice(0, 200)}`); return 0; }
  finally { _running = false; }
}
/** 1시간마다 쌓는다 — 기동 2분 뒤 첫 회(첫 수집 전 빈 스냅샷을 쓰지 않게 · 그래도 unread 는 위에서 거른다). */
export function startGpuAllocHistory(getSnap) {
  if (_timer || _boot) return;
  _boot = setTimeout(() => { _boot = null; sampleAllocHistoryOnce(getSnap); _timer = setInterval(() => sampleAllocHistoryOnce(getSnap), SAMPLE_EVERY_MS); _timer.unref?.(); }, 120_000);
  _boot.unref?.();
}

export function _resetAllocHistoryForTest() {
  try { _db?.raw.close(); } catch { /* */ }
  _db = null; _opening = null; unavailable = false; _warned = false; _writes = 0; _lock.ok();
  clearTimeout(_boot); clearInterval(_timer); _boot = null; _timer = null; _running = false;
}
