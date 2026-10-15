/**
 * xferspeed/db.js — 법인 간 전송 속도 기록 DB(v2.735). 파일: `<dbDir>/xfer-speed.db`
 *
 * ── 행 수를 먼저 계산했다 ────────────────────────────────────────────────────
 * 엣지 28곳 × 2방향 × 48회/일 = **2,688행/일**(행 약 90B). 원시 기본 180일 = 48만 행 ≈ 45MB,
 * 일 요약 5년 = 28 × 2 × 1,825 = 10만 행. 그래서 2단이다:
 *   ① `xfer_sample` 원시(측정 1회 = 방향당 1행) — 기본 180일
 *   ② `xfer_daily`  일 요약(평균·최저·최고·성공 수) — 기본 5년
 *   + `xfer_latest` 엣지·방향별 최신 1건(화면 표 전용 — ⚠ GROUP BY+MAX(ts) 로 대체하지 말 것, v2.550.3 702ms vs 0.53ms)
 *
 * ── 이 저장소가 실측으로 배운 것을 처음부터 적용 ──────────────────────────────
 *  · open 은 진행 중인 시도를 공유하고(`_opening`), 잠금은 래치하지 않는다(`createLockRetry` — v2.597).
 *  · busy_timeout 먼저 · 파일 0600(`openSqlite` — v2.611 DB2611-01).
 *  · 원시는 `INSERT OR IGNORE` + `changes` — 같은 ts 재적재가 일 요약을 두 번 세지 않는다(v2.550.3).
 *  · 최신값은 **더 늦은 ts 일 때만** 갱신한다(`WHERE excluded.ts > xfer_latest.ts`).
 *  · 보존 정리는 rowid 청크 + 양보(`chunkedDelete`) · 진행 공유(`createPruneFlight`) · `ts` 단독 인덱스.
 *  · MIN/MAX 는 단독 문장으로(한 문장에 둘이면 인덱스를 통째로 훑는다 — v2.550.3).
 *  · 하루 경계는 포탈 시각(`util/dayKey.js` — 기본 한국 시각).
 *  · 못 읽은 값은 NULL 이다 — 실패 행의 mbps 를 0 으로 채우지 않는다(0 은 '트래픽 없음' 이라는 거짓).
 *  · v2.740 B-09: 최신 표에 **지금보다 앞선 시각**(시계를 되돌리기 전 측정)이 남아 있으면 새 측정이 그것을 바꾼다 —
 *    '더 늦은 ts 일 때만' 규칙만 두면 시계가 따라잡을 때까지(수 시간) 최신 표가 굳는다.
 *  · v2.740 B-13: 최신 표는 **일 요약 보존일**로 정리한다(원시 보존일이 아니다) — 원시 보존일로 지우면 오래 꺼 둔 엣지가
 *    '한 번도 재지 않았다' 로 보이고, 일 요약(5년)에는 기록이 남아 화면끼리 어긋난다.
 *  · v2.740 E-01·E-02·E-04: 넓은 기간 읽기는 조각(`readDescChunked`) + 시간 기준 양보 — 한 문장 판과 결과가 같다(테스트 대조).
 *    `dataMark()` 는 기억 키(적재·정리 세대 + MAX(rowid) — O(1))다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { numOrNull } from '../util/numOrNull.js';
import { DAY_OFFSET_MIN, dayKey } from '../util/dayKey.js';
import { openSqlite, createLockRetry } from '../util/sqliteOpen.js';
import { chunkedDelete, createPruneFlight } from '../util/chunkedPrune.js';

export const DB_FILE_NAME = 'xfer-speed.db';
// ⚠ 파일 이름은 리터럴로 둔다 — scripts/config-doc.mjs 가 path.join(…, '<이름>.db') 모양으로 찾는다(변수면 문서에서 빠진다).
const FILE = () => path.join(config.dbDir || config.configDir, 'xfer-speed.db');
const lockRetry = createLockRetry();
export { DAY_OFFSET_MIN };

let _db = null; let _tried = false; let _opening = null;
/** 쓰기 세대 — 적재·정리가 실제로 행을 바꾸면 오른다(화면 기억 키 — v2.740 E-02·E-04). */
let _rev = 0;
/** 최신 표의 '지금보다 앞선 시각' 허용폭 — 넘으면 시계를 되돌린 흔적으로 보고 새 측정으로 바꾼다(schedule.js CLOCK_TOL_MS 와 같은 값). */
export const LATEST_FUTURE_TOL_MS = 2 * 60_000;

async function getDb() {
  if (_db) return _db;
  if (lockRetry.blocked()) return null;
  if (_opening) return _opening;
  if (_tried) return _db;
  _opening = openDb().finally(() => { _opening = null; });
  return _opening;
}

async function openDb() {
  let conn = null;
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    const { DatabaseSync } = await import('node:sqlite');
    conn = openSqlite(new DatabaseSync(FILE()));
    try { fs.chmodSync(FILE(), 0o600); } catch { /* best effort */ }
    conn.exec(`
      CREATE TABLE IF NOT EXISTS xfer_sample (
        agent TEXT NOT NULL, dir TEXT NOT NULL, ts INTEGER NOT NULL,
        ok INTEGER NOT NULL, bytes INTEGER, mbps REAL,
        xfer_ms REAL, total_ms INTEGER, ttfb_ms INTEGER,
        basis TEXT, kind TEXT, err TEXT, trig TEXT,
        PRIMARY KEY (agent, dir, ts)
      );
      CREATE INDEX IF NOT EXISTS idx_xs_sample_ts ON xfer_sample(ts);
      CREATE TABLE IF NOT EXISTS xfer_latest (
        agent TEXT NOT NULL, dir TEXT NOT NULL, ts INTEGER NOT NULL,
        ok INTEGER NOT NULL, bytes INTEGER, mbps REAL,
        xfer_ms REAL, total_ms INTEGER, ttfb_ms INTEGER,
        basis TEXT, kind TEXT, err TEXT,
        fail_streak INTEGER NOT NULL DEFAULT 0, last_ok_ts INTEGER, last_ok_mbps REAL,
        PRIMARY KEY (agent, dir)
      );
      CREATE TABLE IF NOT EXISTS xfer_daily (
        agent TEXT NOT NULL, dir TEXT NOT NULL, day TEXT NOT NULL,
        n INTEGER NOT NULL DEFAULT 0, ok_n INTEGER NOT NULL DEFAULT 0,
        mbps_sum REAL NOT NULL DEFAULT 0, mbps_min REAL, mbps_max REAL,
        ttfb_sum INTEGER NOT NULL DEFAULT 0, ttfb_n INTEGER NOT NULL DEFAULT 0,
        last_ts INTEGER,
        PRIMARY KEY (agent, dir, day)
      );
      CREATE INDEX IF NOT EXISTS idx_xs_daily_day ON xfer_daily(day);
    `);
    _db = conn;
  } catch (e) {
    try { conn?.close(); } catch { /* 이미 닫힘 */ }
    if (lockRetry.onFail(e)) { console.warn(`[xferspeed-db] ${lockRetry.note()}`); return null; }
    console.warn('[xferspeed-db] 사용 불가(DB 없이 동작 — 측정 기록이 남지 않습니다):', e?.message);
    _db = null;
  }
  _tried = true;
  return _db;
}

export async function available() { return !!(await getDb()); }
export function dbPath() { return FILE(); }

const n = numOrNull;
const iOr = (v) => { const x = n(v); return x == null ? null : Math.round(x); };
const s = (v, max) => (v == null || v === '' ? null : String(v).slice(0, max));

/**
 * 측정 행 적재 — 한 트랜잭션. `rows` 는 probe.js 의 측정 행에 `agent`·`trig` 를 붙인 것.
 * @returns {Promise<{ok:boolean, inserted?:number, duplicates?:number, error?:string}>}
 */
export async function insertSamples(rows = []) {
  const db = await getDb();
  if (!db) return { ok: false, error: lockRetry.note() || 'DB 를 열지 못했습니다' };
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === 'object' && r.agent && (r.dir === 'down' || r.dir === 'up') && n(r.ts) != null);
  if (!list.length) return { ok: true, inserted: 0, duplicates: 0 };
  const ins = db.prepare(`INSERT OR IGNORE INTO xfer_sample
    (agent, dir, ts, ok, bytes, mbps, xfer_ms, total_ms, ttfb_ms, basis, kind, err, trig)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const daily = db.prepare(`INSERT INTO xfer_daily (agent, dir, day, n, ok_n, mbps_sum, mbps_min, mbps_max, ttfb_sum, ttfb_n, last_ts)
    VALUES (?,?,?,1,?,?,?,?,?,?,?)
    ON CONFLICT(agent, dir, day) DO UPDATE SET
      n = n + 1, ok_n = ok_n + excluded.ok_n,
      mbps_sum = mbps_sum + excluded.mbps_sum,
      mbps_min = CASE WHEN excluded.mbps_min IS NULL THEN mbps_min WHEN mbps_min IS NULL OR excluded.mbps_min < mbps_min THEN excluded.mbps_min ELSE mbps_min END,
      mbps_max = CASE WHEN excluded.mbps_max IS NULL THEN mbps_max WHEN mbps_max IS NULL OR excluded.mbps_max > mbps_max THEN excluded.mbps_max ELSE mbps_max END,
      ttfb_sum = ttfb_sum + excluded.ttfb_sum, ttfb_n = ttfb_n + excluded.ttfb_n,
      last_ts = MAX(IFNULL(last_ts, 0), excluded.last_ts)`);
  const latest = db.prepare(`INSERT INTO xfer_latest
    (agent, dir, ts, ok, bytes, mbps, xfer_ms, total_ms, ttfb_ms, basis, kind, err, fail_streak, last_ok_ts, last_ok_mbps)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(agent, dir) DO UPDATE SET
      ts = excluded.ts, ok = excluded.ok, bytes = excluded.bytes, mbps = excluded.mbps,
      xfer_ms = excluded.xfer_ms, total_ms = excluded.total_ms, ttfb_ms = excluded.ttfb_ms,
      basis = excluded.basis, kind = excluded.kind, err = excluded.err,
      fail_streak = CASE WHEN excluded.ok = 1 THEN 0 ELSE xfer_latest.fail_streak + 1 END,
      last_ok_ts = CASE WHEN excluded.ok = 1 THEN excluded.ts ELSE xfer_latest.last_ok_ts END,
      last_ok_mbps = CASE WHEN excluded.ok = 1 THEN excluded.mbps ELSE xfer_latest.last_ok_mbps END
    WHERE excluded.ts > xfer_latest.ts OR xfer_latest.ts > ?`);
  const futureCut = Date.now() + LATEST_FUTURE_TOL_MS;
  let inserted = 0; let duplicates = 0;
  try {
    db.exec('BEGIN');
    for (const r of list) {
      const ok = r.ok === true ? 1 : 0;
      const mbps = ok ? n(r.mbps) : null;
      const ttfb = iOr(r.ttfbMs);
      const ts = Math.round(n(r.ts));
      const agent = String(r.agent).slice(0, 128);
      const res = ins.run(agent, r.dir, ts, ok, iOr(r.bytes), mbps, n(r.xferMs), iOr(r.totalMs), ttfb,
        s(r.basis, 20), ok ? null : s(r.kind || 'http', 20), ok ? null : s(r.error, 400), s(r.trig, 12));
      if (!Number(res?.changes)) { duplicates += 1; continue; }
      inserted += 1;
      daily.run(agent, r.dir, dayKey(ts), ok, mbps ?? 0, mbps, mbps, ok && ttfb != null ? ttfb : 0, ok && ttfb != null ? 1 : 0, ts);
      latest.run(agent, r.dir, ts, ok, iOr(r.bytes), mbps, n(r.xferMs), iOr(r.totalMs), ttfb,
        s(r.basis, 20), ok ? null : s(r.kind || 'http', 20), ok ? null : s(r.error, 400), ok ? 0 : 1, ok ? ts : null, ok ? mbps : null, futureCut);
    }
    db.exec('COMMIT');
    if (inserted) _rev += 1;
    return { ok: true, inserted, duplicates };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 이미 끝남 */ }
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/** 엣지·방향별 최신 1건 전부. */
export async function latestAll() {
  const db = await getDb();
  if (!db) return [];
  try { return db.prepare('SELECT * FROM xfer_latest').all(); } catch { return []; }
}

/**
 * 기간 안의 원시 행(가벼운 열만) — 화면 요약(7일 기준선·24시간 스파크라인·시간대 히트맵)이 쓴다.
 * `until`(포함, ms)을 주면 그 시각까지만 — 법인 상세의 '이전 구간' 보기(v2.735.3). 없으면 예전처럼 끝이 열려 있다.
 */
export async function samplesSince(sinceTs, { agent = '', limit = 200_000, until = null } = {}) {
  const db = await getDb();
  if (!db) return { rows: [], truncated: false, available: false };
  const lim = Math.max(1, Math.min(500_000, Math.floor(n(limit) ?? 200_000)));
  const to = n(until);
  try {
    const rows = agent
      ? (to == null
        ? db.prepare('SELECT agent, dir, ts, ok, mbps, ttfb_ms, xfer_ms, total_ms, bytes, basis, kind, err FROM xfer_sample WHERE agent = ? AND ts >= ? ORDER BY ts DESC LIMIT ?').all(agent, sinceTs, lim + 1)
        : db.prepare('SELECT agent, dir, ts, ok, mbps, ttfb_ms, xfer_ms, total_ms, bytes, basis, kind, err FROM xfer_sample WHERE agent = ? AND ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?').all(agent, sinceTs, to, lim + 1))
      : (to == null
        ? db.prepare('SELECT agent, dir, ts, ok, mbps, ttfb_ms, xfer_ms, total_ms, basis FROM xfer_sample WHERE ts >= ? ORDER BY ts DESC LIMIT ?').all(sinceTs, lim + 1)
        : db.prepare('SELECT agent, dir, ts, ok, mbps, ttfb_ms, xfer_ms, total_ms, basis FROM xfer_sample WHERE ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?').all(sinceTs, to, lim + 1));
    // 상한에 걸리면 **오래된 쪽**을 버린다(v2.735.3 — 예전엔 ORDER BY ts LIMIT 이라 가장 최근 행이 빠졌다). 돌려줄 때는 시각 순.
    const truncated = rows.length > lim;
    const kept = truncated ? rows.slice(0, lim) : rows;
    kept.reverse();
    return { rows: kept, truncated, available: true };
  } catch (e) { return { rows: [], truncated: false, available: true, error: String(e?.message || e).slice(0, 200) }; }
}

/** 기간 안의 최근 실패(모든 엣지) — 화면 '최근 실패' 목록. */
export async function recentFailures(sinceTs, limit = 12) {
  const db = await getDb();
  if (!db) return [];
  try {
    return db.prepare('SELECT agent, dir, ts, kind, err, total_ms, bytes FROM xfer_sample WHERE ts >= ? AND ok = 0 ORDER BY ts DESC LIMIT ?')
      .all(sinceTs, Math.max(1, Math.min(200, Math.floor(n(limit) ?? 12))));
  } catch { return []; }
}

/** 한 엣지의 일 요약(장기 보기). `sinceDay`·`untilDay`(포함) 는 'YYYY-MM-DD'. untilDay 가 없으면 끝이 열려 있다. */
export async function dailyOf(agent, sinceDay, untilDay = '') {
  const db = await getDb();
  if (!db) return [];
  try {
    return untilDay
      ? db.prepare('SELECT agent, dir, day, n, ok_n, mbps_sum, mbps_min, mbps_max, ttfb_sum, ttfb_n FROM xfer_daily WHERE agent = ? AND day >= ? AND day <= ? ORDER BY day')
        .all(agent, sinceDay, untilDay)
      : db.prepare('SELECT agent, dir, day, n, ok_n, mbps_sum, mbps_min, mbps_max, ttfb_sum, ttfb_n FROM xfer_daily WHERE agent = ? AND day >= ? ORDER BY day')
        .all(agent, sinceDay);
  } catch { return []; }
}

/**
 * 한 엣지의 가장 오래된 기록 — 원시 표본 시각(ms)과 일 요약 날짜. '이전 구간' 을 어디까지 갈 수 있는지 화면이 정한다(v2.735.3).
 * PK (agent, dir, ts)·(agent, dir, day) 의 앞부분으로 찾으므로 방향마다 단독 MIN 문장 하나씩(v2.550.3 — 집계 둘을 한 문장에 두지 않는다).
 * 못 읽으면 null(기록 없음과 같게 다룬다 — 화면은 스크롤을 숨긴다).
 */
export async function oldestOf(agent) {
  const db = await getDb();
  if (!db || !agent) return { sampleTs: null, day: null };
  try {
    const mins = (sql) => ['down', 'up'].map((d) => db.prepare(sql).get(agent, d)?.v ?? null).filter((v) => v != null);
    const ts = mins('SELECT MIN(ts) v FROM xfer_sample WHERE agent = ? AND dir = ?');
    const days = mins('SELECT MIN(day) v FROM xfer_daily WHERE agent = ? AND dir = ?');
    return { sampleTs: ts.length ? Math.min(...ts.map(Number)) : null, day: days.length ? days.sort()[0] : null };
  } catch { return { sampleTs: null, day: null }; }
}

const SAMPLE_COLS_ALL = 'agent, dir, ts, ok, mbps, ttfb_ms, xfer_ms, total_ms, basis';
const SAMPLE_COLS_AGENT = 'agent, dir, ts, ok, mbps, ttfb_ms, xfer_ms, total_ms, bytes, basis, kind, err';
const EXPORT_COLS = 'agent, dir, ts, ok, bytes, mbps, xfer_ms, total_ms, ttfb_ms, basis, kind, err, trig';
export const READ_CHUNK = 2000;

/**
 * 기간 안 원시 행을 **최근 → 과거** 조각으로 읽는다(v2.740 E-01·E-02·E-04). 조각 사이에 `yielder` 로 양보한다.
 * 돌려주는 순서·내용은 한 문장 판(`… ORDER BY ts DESC LIMIT want`)과 같다:
 *  · 전체: ts 색인 — 같은 ts 는 rowid 내림차순(색인 순서). 조각 경계에 걸친 마지막 ts 의 행은 떼어 내고 그 ts 를 통째로 읽는다
 *    (같은 ts 는 엣지 수 × 2 행이 상한 — PK 가 (agent, dir, ts) 다).
 *  · 한 엣지: 방향마다 PK 범위(정렬 없이) 두 줄을 ts 내림차순으로 합친다(같은 ts 는 down 먼저 — 한 문장 판은 이 순서를 정하지 않는다).
 * @returns {Promise<Array>} 최대 want 행
 */
async function readDescChunked(db, { cols, sinceTs, until = null, agent = '', want, chunk = READ_CHUNK, yielder = null }) {
  const out = [];
  const step = Math.max(2, Math.floor(n(chunk) ?? READ_CHUNK));
  const pace = async () => { if (yielder) await yielder(); };
  if (!agent) {
    const qOpen = db.prepare(`SELECT ${cols} FROM xfer_sample WHERE ts >= ? ORDER BY ts DESC, rowid DESC LIMIT ?`);
    const qTo = db.prepare(`SELECT ${cols} FROM xfer_sample WHERE ts >= ? AND ts <= ? ORDER BY ts DESC, rowid DESC LIMIT ?`);
    const qLt = db.prepare(`SELECT ${cols} FROM xfer_sample WHERE ts >= ? AND ts < ? ORDER BY ts DESC, rowid DESC LIMIT ?`);
    const qEq = db.prepare(`SELECT ${cols} FROM xfer_sample WHERE ts = ? ORDER BY rowid DESC`);
    let cursor = null;   // 다음 조각의 ts 상한(미포함). 첫 조각은 until(포함) 또는 열림.
    while (out.length < want) {
      const rows = cursor != null ? qLt.all(sinceTs, cursor, step) : (until != null ? qTo.all(sinceTs, until, step) : qOpen.all(sinceTs, step));
      if (rows.length < step) { for (const r of rows) out.push(r); break; }
      const T = rows[rows.length - 1].ts;
      let k = rows.length;
      while (k > 0 && rows[k - 1].ts === T) k -= 1;
      for (let i = 0; i < k; i += 1) out.push(rows[i]);
      for (const r of qEq.all(T)) out.push(r);
      cursor = T;
      await pace();
    }
    return out.length > want ? out.slice(0, want) : out;
  }
  const qA = db.prepare(`SELECT ${cols} FROM xfer_sample WHERE agent = ? AND dir = ? AND ts >= ? ORDER BY ts DESC LIMIT ?`);
  const qAto = db.prepare(`SELECT ${cols} FROM xfer_sample WHERE agent = ? AND dir = ? AND ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?`);
  const qAlt = db.prepare(`SELECT ${cols} FROM xfer_sample WHERE agent = ? AND dir = ? AND ts >= ? AND ts < ? ORDER BY ts DESC LIMIT ?`);
  const streams = ['down', 'up'].map((dir) => ({ dir, buf: [], pos: 0, cursor: null, first: true, done: false }));
  const refill = (st) => {
    const rows = st.first
      ? (until != null ? qAto.all(agent, st.dir, sinceTs, until, step) : qA.all(agent, st.dir, sinceTs, step))
      : qAlt.all(agent, st.dir, sinceTs, st.cursor, step);
    st.first = false;
    st.buf = rows; st.pos = 0;
    if (rows.length < step) st.done = true;
    if (rows.length) st.cursor = rows[rows.length - 1].ts;   // (agent, dir, ts) 가 PK — 같은 방향에서 ts 는 겹치지 않는다
  };
  while (out.length < want) {
    let refilled = false;
    for (const st of streams) if (st.pos >= st.buf.length && !st.done) { refill(st); refilled = true; }
    let best = null;
    for (const st of streams) {
      if (st.pos >= st.buf.length) continue;
      if (!best || st.buf[st.pos].ts > best.buf[best.pos].ts) best = st;
    }
    if (!best) break;
    out.push(best.buf[best.pos]); best.pos += 1;
    if (refilled) await pace();
  }
  return out;
}

/**
 * `samplesSince` 의 조각판(v2.740 E-02·E-04) — 같은 열·같은 결과, 조각 사이에 양보. 화면 요약·히트맵이 쓴다.
 * @returns {Promise<{rows:Array, truncated:boolean, available:boolean, error?:string}>}
 */
export async function samplesSinceChunked(sinceTs, { agent = '', limit = 200_000, until = null, yielder = null, chunk = READ_CHUNK } = {}) {
  const db = await getDb();
  if (!db) return { rows: [], truncated: false, available: false };
  const lim = Math.max(1, Math.min(500_000, Math.floor(n(limit) ?? 200_000)));
  try {
    const rows = await readDescChunked(db, { cols: agent ? SAMPLE_COLS_AGENT : SAMPLE_COLS_ALL, sinceTs, until: n(until), agent, want: lim + 1, chunk, yielder });
    const truncated = rows.length > lim;
    const kept = truncated ? rows.slice(0, lim) : rows;
    kept.reverse();
    return { rows: kept, truncated, available: true };
  } catch (e) { return { rows: [], truncated: false, available: true, error: String(e?.message || e).slice(0, 200) }; }
}

/**
 * CSV 내보내기용 — 기간 안 원시 행 전체 열(상한 — 넘으면 가장 최근 행을 남긴다). `until`(포함)이 있으면 그 시각까지(v2.735.3 이전 구간).
 * v2.740 E-01: 조각으로 읽고 사이에 양보한다(예전 한 문장 판은 20만 행에 1.5~2초 동안 포탈 전체를 멈췄다). 결과는 같다(테스트 대조).
 */
export async function exportRows(sinceTs, { agent = '', limit = 200_000, until = null, yielder = null, chunk = READ_CHUNK } = {}) {
  const db = await getDb();
  if (!db) return { rows: [], truncated: false };
  const lim = Math.max(1, Math.min(500_000, Math.floor(n(limit) ?? 200_000)));
  try {
    const rows = await readDescChunked(db, { cols: EXPORT_COLS, sinceTs, until: n(until), agent, want: lim + 1, chunk, yielder });
    const kept = rows.slice(0, lim).reverse();
    return { rows: kept, truncated: rows.length > lim };
  } catch { return { rows: [], truncated: false }; }
}

/** 화면 기억 키 — 쓰기 세대 + 원시 MAX(rowid)(O(1)). DB 를 못 열면 null(기억하지 않는다). */
export async function dataMark() {
  const db = await getDb();
  if (!db) return null;
  try { return `${_rev}|${db.prepare('SELECT MAX(rowid) v FROM xfer_sample').get()?.v ?? 0}`; } catch { return null; }
}

/** DB 상태 — 행 수는 세지 않는다(rowid 끝값 어림 — v2.728 규약). MIN/MAX 는 단독 문장. */
export async function dbStatus() {
  const db = await getDb();
  if (!db) return { available: false, path: FILE(), note: lockRetry.note() };
  try {
    const firstTs = db.prepare('SELECT MIN(ts) v FROM xfer_sample').get()?.v ?? null;
    const lastTs = db.prepare('SELECT MAX(ts) v FROM xfer_sample').get()?.v ?? null;
    const maxRow = db.prepare('SELECT MAX(rowid) v FROM xfer_sample').get()?.v ?? null;
    const minRow = db.prepare('SELECT MIN(rowid) v FROM xfer_sample').get()?.v ?? null;
    let bytes = null;
    try { bytes = fs.statSync(FILE()).size; } catch { /* */ }
    return { available: true, path: FILE(), firstTs, lastTs, rowsApprox: maxRow == null ? 0 : (maxRow - (minRow ?? maxRow) + 1), bytes };
  } catch (e) { return { available: true, path: FILE(), error: String(e?.message || e).slice(0, 200) }; }
}

/* 보존 정리 — rowid 청크 + 양보. 정리끼리는 겹치지 않는다(같은 보존일이면 공유). */
const _pruneFlight = createPruneFlight();
export async function pruneXferSpeed({ sampleDays = 180, dailyDays = 365 * 5, now = Date.now() } = {}) {
  const db = await getDb();
  if (!db) return { ok: false };
  const sd = Math.max(1, Math.floor(n(sampleDays) ?? 180));
  const dd = Math.max(1, Math.floor(n(dailyDays) ?? 1825));
  return _pruneFlight.run(`${sd}|${dd}`, async () => {
    try {
      const sample = db.prepare('DELETE FROM xfer_sample WHERE rowid IN (SELECT rowid FROM xfer_sample WHERE ts < ? LIMIT ?)');
      const latest = db.prepare('DELETE FROM xfer_latest WHERE rowid IN (SELECT rowid FROM xfer_latest WHERE ts < ? LIMIT ?)');
      const daily = db.prepare('DELETE FROM xfer_daily WHERE rowid IN (SELECT rowid FROM xfer_daily WHERE day < ? LIMIT ?)');
      const a = await chunkedDelete(sample, [now - sd * 86_400_000], { label: 'xferspeed.xfer_sample' });
      // v2.740 B-13: 최신 표는 일 요약 보존일로 — 원시 보존일로 지우면 오래 꺼 둔 엣지가 '한 번도 재지 않았다' 가 된다.
      const l = await chunkedDelete(latest, [now - dd * 86_400_000], { label: 'xferspeed.xfer_latest' });
      const c = await chunkedDelete(daily, [dayKey(now - dd * 86_400_000)], { label: 'xferspeed.xfer_daily' });
      if (a.deleted || l.deleted || c.deleted) _rev += 1;
      return { ok: true, sample: a.deleted, latest: l.deleted, daily: c.deleted, done: a.done && l.done && c.done };
    } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) }; }
  });
}

export function _resetForTest() {
  lockRetry.ok();
  try { _db?.close(); } catch { /* */ }
  _db = null; _tried = false; _opening = null;
  _rev += 1;
  _pruneFlight.reset();
}
