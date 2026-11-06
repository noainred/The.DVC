/**
 * usage/db.js — 기능 사용 일 집계 DB(v2.913). 파일: `<dbDir>/usage.db`.
 *
 * 원본 이벤트는 남기지 않는다 — **사용자 × 화면 키 × 날(KST)** 한 줄에 열람 수 · 머문 시간을 더한다(설계 §4.3).
 *   · `fu_daily(day, user, k, views, active_ms, last_ts)` — PK (day, user, k). PK 의 첫 열이 day 라 하루 조회(`WHERE day=?`)와
 *     정리(`DELETE … WHERE day < ?`)가 그 인덱스를 탄다(perf-db '복합 (id, ts) 로는 못 탄다' 의 반대 순서 — 날이 앞이다).
 *   · `fu_user(user, name, role, scoped, src, last_ts)` — 계정마다 마지막으로 본 이름 · 역할(최신 전용 표 — 'GROUP BY + MAX(ts)' 금지 규약).
 *     AD 계정은 계정 목록에 없어서 기록 시점 값이 이것뿐이다.
 * 규모(추정 — 설계 §4.3): 50명 × 하루 20화면 = 1,000행/일 → 180일 18만 행 · 10MB 안팎.
 *
 * 규약: 쓰기는 한 트랜잭션(store.js 가 60초마다 모아서) · 적재는 `ON CONFLICT DO UPDATE` · 파일은 0600 · open 은 진행 중인 시도를 공유하고
 * 잠금이면 래치하지 않는다(util/sqliteOpen.js) · 정리는 청크(util/chunkedPrune.js). 하루 경계는 util/dayKey.js(KST).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { openSqlite, createLockRetry } from '../util/sqliteOpen.js';
import { chunkedDelete, createPruneFlight } from '../util/chunkedPrune.js';

const FILE = () => path.join(config.dbDir || config.configDir, 'usage.db');
const lockRetry = createLockRetry();

let _db = null; let _tried = false; let _opening = null; let _err = '';

export function usageDbFile() { return FILE(); }
export function usageDbError() { return _db ? '' : (lockRetry.note() || _err); }

export async function getUsageDb() {
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
    conn = openSqlite(new DatabaseSync(FILE()));   // busy_timeout 먼저 · 파일 0600(첫 쓰기 전) · 잠금이면 닫고 던진다
    try { fs.chmodSync(FILE(), 0o600); } catch { /* best effort — openSqlite 가 이미 걸었다(v2.503 S-5 규칙 — 모듈마다 명시) */ }
    conn.exec(`CREATE TABLE IF NOT EXISTS fu_daily (
        day TEXT NOT NULL, user TEXT NOT NULL, k TEXT NOT NULL,
        views INTEGER NOT NULL DEFAULT 0, active_ms INTEGER NOT NULL DEFAULT 0, last_ts INTEGER,
        PRIMARY KEY (day, user, k)
      );
      CREATE TABLE IF NOT EXISTS fu_user (
        user TEXT PRIMARY KEY, name TEXT, role TEXT, scoped INTEGER, src TEXT, last_ts INTEGER
      );`);
    lockRetry.ok();
    _db = conn; _err = '';
  } catch (e) {
    try { conn?.close(); } catch { /* 이미 닫힘 */ }
    if (lockRetry.onFail(e)) { console.warn(`[usage-db] ${lockRetry.note()}`); return null; }
    _err = String(e?.message || e).slice(0, 200);
    console.warn('[usage-db] 사용 불가(기능 사용 기록을 저장하지 못합니다):', _err);
    _db = null;
  }
  _tried = true;
  return _db;
}

let _stmts = null; let _stmtsFor = null;
function stmts(db) {
  if (_stmtsFor === db && _stmts) return _stmts;
  _stmts = {
    upDaily: db.prepare(`INSERT INTO fu_daily(day, user, k, views, active_ms, last_ts) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(day, user, k) DO UPDATE SET views = views + excluded.views, active_ms = active_ms + excluded.active_ms,
        last_ts = CASE WHEN last_ts IS NULL OR excluded.last_ts > last_ts THEN excluded.last_ts ELSE last_ts END`),
    upUser: db.prepare(`INSERT INTO fu_user(user, name, role, scoped, src, last_ts) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user) DO UPDATE SET name = excluded.name, role = excluded.role, scoped = excluded.scoped, src = excluded.src,
        last_ts = CASE WHEN last_ts IS NULL OR excluded.last_ts > last_ts THEN excluded.last_ts ELSE last_ts END`),
    dayRows: db.prepare('SELECT user, k, views, active_ms, last_ts FROM fu_daily WHERE day = ?'),
    dayRowsUser: db.prepare('SELECT user, k, views, active_ms, last_ts FROM fu_daily WHERE day = ? AND user = ?'),
    users: db.prepare('SELECT user, name, role, scoped, src, last_ts FROM fu_user'),
    oldest: db.prepare('SELECT MIN(day) AS d FROM fu_daily'),
    pruneDaily: db.prepare('DELETE FROM fu_daily WHERE rowid IN (SELECT rowid FROM fu_daily WHERE day < ? LIMIT ?)'),
    purgeUserDaily: db.prepare('DELETE FROM fu_daily WHERE rowid IN (SELECT rowid FROM fu_daily WHERE user = ? LIMIT ?)'),
    purgeAllDaily: db.prepare('DELETE FROM fu_daily WHERE rowid IN (SELECT rowid FROM fu_daily LIMIT ?)'),
    delUser: db.prepare('DELETE FROM fu_user WHERE user = ?'),
    delAllUsers: db.prepare('DELETE FROM fu_user'),
  };
  _stmtsFor = db;
  return _stmts;
}

/**
 * 모아 둔 행을 한 트랜잭션으로 더한다.
 * @param {{day:string,user:string,k:string,views:number,ms:number,last:number}[]} rows
 * @param {{user:string,name:string,role:string,scoped:boolean,src:string,last:number}[]} users
 * @returns {Promise<{ok:boolean, rows:number, ms?:number, reason?:string}>}
 */
export async function writeBatch(rows, users) {
  const db = await getUsageDb();
  if (!db) return { ok: false, rows: 0, reason: usageDbError() || 'db-unavailable' };
  return writeRows(db, rows, users);
}

/** 종료 때(registerExitFlush) — 이미 열린 핸들이 있을 때만 동기로 쓴다(종료 중에 새로 열지 않는다). */
export function writeBatchSync(rows, users) {
  if (!_db) return { ok: false, rows: 0, reason: 'db-not-open' };
  return writeRows(_db, rows, users);
}

function writeRows(db, rows, users) {
  const st = stmts(db);
  const t0 = performance.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of rows) st.upDaily.run(r.day, r.user, r.k, r.views, Math.round(r.ms), r.last);
    for (const u of users) st.upUser.run(u.user, u.name, u.role, u.scoped ? 1 : 0, u.src, u.last);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 이미 끝남 */ }
    return { ok: false, rows: 0, reason: String(e?.message || e).slice(0, 200) };
  }
  return { ok: true, rows: rows.length, ms: Math.round((performance.now() - t0) * 10) / 10 };
}

/** 하루치 행(사용자 지정 시 그 사용자만). DB 를 못 열면 null(빈 배열과 구분 — 0 으로 세지 않는다). */
export async function dayRows(day, user = null) {
  const db = await getUsageDb();
  if (!db) return null;
  const st = stmts(db);
  return user ? st.dayRowsUser.all(day, user) : st.dayRows.all(day);
}

export async function knownUsers() {
  const db = await getUsageDb();
  if (!db) return null;
  return stmts(db).users.all();
}

/** 가장 오래된 날(MIN 단독 — perf-db 규약) · 파일 크기. */
export async function usageDbInfo() {
  const db = await getUsageDb();
  let size = null;
  try { size = fs.statSync(FILE()).size; } catch { size = null; }
  if (!db) return { ok: false, size, oldest: null, error: usageDbError() || 'db-unavailable' };
  let oldest = null;
  try { oldest = stmts(db).oldest.get()?.d || null; } catch { oldest = null; }
  return { ok: true, size, oldest, error: '' };
}

const _pruneFlight = createPruneFlight();
/** 보관 기간 밖(day < cutoffDay)을 청크로 지운다. */
export async function pruneUsage(cutoffDay) {
  const db = await getUsageDb();
  if (!db || !cutoffDay) return { deleted: 0, done: true };
  return _pruneFlight.run(cutoffDay, () => chunkedDelete(stmts(db).pruneDaily, [cutoffDay], { label: 'usage.fu_daily' }));
}

/**
 * 기록 지우기(설정 소유자 + OTP — 라우트가 막는다). scope: all | user | before.
 * @returns {Promise<{ok:boolean, deleted:number, reason?:string}>}
 */
export async function purgeUsage({ scope, user = '', before = '' }) {
  const db = await getUsageDb();
  if (!db) return { ok: false, deleted: 0, reason: usageDbError() || 'db-unavailable' };
  const st = stmts(db);
  let r;
  if (scope === 'all') {
    r = await chunkedDelete(st.purgeAllDaily, [], { label: 'usage.purge-all', maxRows: 0 });
    st.delAllUsers.run();
  } else if (scope === 'user') {
    r = await chunkedDelete(st.purgeUserDaily, [user], { label: 'usage.purge-user', maxRows: 0 });
    st.delUser.run(user);
  } else if (scope === 'before') {
    r = await chunkedDelete(st.pruneDaily, [before], { label: 'usage.purge-before', maxRows: 0 });
  } else return { ok: false, deleted: 0, reason: 'bad-scope' };
  return { ok: true, deleted: r.deleted };
}

/** 테스트용 — 핸들을 닫고 처음 상태로. */
export function _closeUsageDb() {
  try { _db?.close(); } catch { /* */ }
  _db = null; _tried = false; _opening = null; _stmts = null; _stmtsFor = null; _err = ''; lockRetry.ok();
}
