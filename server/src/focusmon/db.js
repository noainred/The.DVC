/**
 * focusmon/db.js — 집중 모니터링 기록 DB(`focusmon.db` — 30일 보관 · v2.976 · 사용자 결정 2026-11-11 ‘뒤로 30일 · DB 에 저장 · 프로세스 목록도’).
 *
 * 표:
 *  · fm_metric(target, minute, n, data BLOB)  — 서버 1대 · 1분 = 한 줄(codec.js 압축 묶음 · 열 이름표 포함)
 *  · fm_proc(target, minute, data BLOB)       — 그 1분의 프로세스 상위 30 표본들(comm 만 · 사용자 이름 · 인자 0)
 *  · fm_run(id, started, ended, by, mode, interval, targets) — 수집 기록(누가 · 언제 · 어느 서버 · 방식) — ‘기록이 있는 시간’ 띠와 감사용
 * 규약(docs/rules/perf-db.md):
 *  · open 은 진행 중인 시도를 공유하고(`_opening`) 잠금은 래치하지 않는다(`createLockRetry`) · busy_timeout 먼저 · 파일 0600(`openSqlite`).
 *  · 쓰기는 한 트랜잭션 · 한 번에 최대 수십 줄(recorder.js 가 10초 틱으로 모은다 — 측정 중앙값 0.37ms).
 *  · 정리는 `minute` **단독 인덱스**를 타는 조각 삭제(500줄) — 복합 기본 키로는 `minute < ?` 가 풀스캔이 된다.
 *  · 집계 함수 2개를 한 문장에 쓰지 않는다(MIN · MAX 단독 — v2.597 규약).
 *  · 못 열면 null — 호출부는 ‘기록 안 됨’ 을 상태로 말한다(수집 · 실시간 화면은 계속 — 메모리).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { openSqlite, createLockRetry } from '../util/sqliteOpen.js';

// ⚠ 파일 이름은 리터럴로 둔다 — scripts/config-doc.mjs 가 path.join(…, '<이름>.db') 모양으로 찾는다.
const FILE = () => path.join(config.dbDir || config.configDir, 'focusmon.db');
const lockRetry = createLockRetry();
export const PRUNE_CHUNK = 500;

let _db = null; let _tried = false; let _opening = null; let _err = '';

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
      CREATE TABLE IF NOT EXISTS fm_metric (target TEXT NOT NULL, minute INTEGER NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (target, minute));
      CREATE INDEX IF NOT EXISTS idx_fm_metric_minute ON fm_metric(minute);
      CREATE TABLE IF NOT EXISTS fm_proc (target TEXT NOT NULL, minute INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (target, minute));
      CREATE INDEX IF NOT EXISTS idx_fm_proc_minute ON fm_proc(minute);
      CREATE TABLE IF NOT EXISTS fm_run (id TEXT PRIMARY KEY, started INTEGER NOT NULL, ended INTEGER, by TEXT, mode TEXT, interval INTEGER, targets TEXT);
      CREATE INDEX IF NOT EXISTS idx_fm_run_started ON fm_run(started);
      CREATE TABLE IF NOT EXISTS fm_load (target TEXT NOT NULL, minute INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (target, minute));
      CREATE INDEX IF NOT EXISTS idx_fm_load_minute ON fm_load(minute);
      CREATE TABLE IF NOT EXISTS fm_node (node TEXT NOT NULL, minute INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (node, minute));
      CREATE INDEX IF NOT EXISTS idx_fm_node_minute ON fm_node(minute);
    `);
    _db = conn; _err = '';
    lockRetry.ok();
  } catch (e) {
    try { conn?.close(); } catch { /* 이미 닫힘 */ }
    if (lockRetry.onFail(e)) { _err = lockRetry.note(); console.warn(`[focusmon-db] ${_err}`); return null; }
    _err = String(e?.message || e).slice(0, 200);
    console.warn('[focusmon-db] 사용 불가(기록 없이 동작 — 실시간 화면은 그대로):', _err);
    _db = null;
  }
  _tried = true;
  return _db;
}

export async function available() { return !!(await getDb()); }
export function dbPath() { return FILE(); }
export function dbError() { return _err; }

/** 파일 크기(바이트 — 본체 + WAL). 못 읽으면 null. */
export function dbBytes() {
  let n = 0; let any = false;
  for (const f of [FILE(), `${FILE()}-wal`]) { try { n += fs.statSync(f).size; any = true; } catch { /* 없음 */ } }
  return any ? n : null;
}

/**
 * 묶음 적재 — 한 트랜잭션. rows: [{kind:'m'|'p', target, minute, n?, data}]. 같은 (target, minute) 은 덮는다(늦게 온 표본으로 다시 만든 묶음).
 * @returns {Promise<{ok:boolean, written?:number, ms?:number, error?:string}>}
 */
export async function writeBlocks(rows = []) {
  const db = await getDb();
  if (!db) return { ok: false, error: _err || lockRetry.note() || 'DB 를 열지 못했습니다' };
  if (!rows.length) return { ok: true, written: 0, ms: 0 };
  const t0 = performance.now();
  const m = db.prepare('INSERT OR REPLACE INTO fm_metric (target, minute, n, data) VALUES (?, ?, ?, ?)');
  const p = db.prepare('INSERT OR REPLACE INTO fm_proc (target, minute, data) VALUES (?, ?, ?)');
  const ld = db.prepare('INSERT OR REPLACE INTO fm_load (target, minute, data) VALUES (?, ?, ?)');
  const nd = db.prepare('INSERT OR REPLACE INTO fm_node (node, minute, data) VALUES (?, ?, ?)');
  try {
    db.exec('BEGIN');
    for (const r of rows) {
      if (r.kind === 'p') p.run(String(r.target), r.minute, r.data);
      else if (r.kind === 'l') ld.run(String(r.target), r.minute, String(r.data));
      else if (r.kind === 'n') nd.run(String(r.target), r.minute, String(r.data));
      else m.run(String(r.target), r.minute, r.n | 0, r.data);
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* */ }
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
  return { ok: true, written: rows.length, ms: performance.now() - t0 };
}

/** 범위 조회 — [fromMinute, toMinute] 의 묶음들(시각 순). 한 번에 읽는 줄 수 상한 `limit`. */
export async function readMetric(target, fromMinute, toMinute, limit = 2000) {
  const db = await getDb();
  if (!db) return null;
  return db.prepare('SELECT minute, n, data FROM fm_metric WHERE target = ? AND minute >= ? AND minute <= ? ORDER BY minute LIMIT ?')
    .all(String(target), fromMinute, toMinute, limit);
}
export async function readProc(target, fromMinute, toMinute, limit = 120) {
  const db = await getDb();
  if (!db) return null;
  return db.prepare('SELECT minute, data FROM fm_proc WHERE target = ? AND minute >= ? AND minute <= ? ORDER BY minute LIMIT ?')
    .all(String(target), fromMinute, toMinute, limit);
}

/**
 * v2.983 수집 부하 기록 — [fromMinute, toMinute] 의 모든 대상(분 순 · minute 인덱스). 화면의 시간 띠 구간(최대 30분 × 대상 40)이 쓴다.
 * data 는 이 노드가 정제해 쓴 JSON(대상 · 노드 표본) — 읽을 때도 깨진 줄은 버린다.
 */
export async function readLoads(fromMinute, toMinute, limit = 5000) {
  const db = await getDb();
  if (!db) return null;
  return db.prepare('SELECT target, minute, data FROM fm_load WHERE minute >= ? AND minute <= ? ORDER BY minute LIMIT ?').all(fromMinute, toMinute, limit)
    .map((r) => { try { return { target: r.target, minute: r.minute, v: JSON.parse(r.data) }; } catch { return null; } }).filter(Boolean);
}
export async function readNodeLoads(fromMinute, toMinute, limit = 2000) {
  const db = await getDb();
  if (!db) return null;
  return db.prepare('SELECT node, minute, data FROM fm_node WHERE minute >= ? AND minute <= ? ORDER BY minute LIMIT ?').all(fromMinute, toMinute, limit)
    .map((r) => { try { return { node: r.node, minute: r.minute, v: JSON.parse(r.data) }; } catch { return null; } }).filter(Boolean);
}

/** 기록이 있는 분 목록(그 날 · 그 대상) — ‘기록이 있는 시간’ 띠. 기본 키 앞부분(target)으로 범위를 탄다. */
export async function coverage(target, fromMinute, toMinute) {
  const db = await getDb();
  if (!db) return null;
  return db.prepare('SELECT minute FROM fm_metric WHERE target = ? AND minute >= ? AND minute <= ? ORDER BY minute LIMIT 2000')
    .all(String(target), fromMinute, toMinute).map((r) => r.minute);
}

/** 가장 오래된 기록 분(MIN 단독). 없으면 null. */
export async function oldestMinute() {
  const db = await getDb();
  if (!db) return null;
  const r = db.prepare('SELECT MIN(minute) AS m FROM fm_metric').get();
  return r?.m ?? null;
}

/** 수집 기록. */
export async function writeRun(run) {
  const db = await getDb();
  if (!db) return false;
  db.prepare('INSERT OR REPLACE INTO fm_run (id, started, ended, by, mode, interval, targets) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(String(run.id), run.started, run.ended ?? null, String(run.by || '').slice(0, 64), String(run.mode || ''), run.interval | 0, JSON.stringify((run.targets || []).slice(0, 40)));
  return true;
}
export async function listRuns(sinceTs, limit = 200) {
  const db = await getDb();
  if (!db) return null;
  return db.prepare('SELECT id, started, ended, by, mode, interval, targets FROM fm_run WHERE started >= ? ORDER BY started DESC LIMIT ?').all(sinceTs, limit)
    .map((r) => { let t = []; try { t = JSON.parse(r.targets); } catch { t = []; } return { ...r, targets: Array.isArray(t) ? t : [] }; });
}

/**
 * 정리 한 조각 — 보관 기간 밖(minute < cutMinute)을 표마다 최대 PRUNE_CHUNK 줄 지운다. 지운 줄 수.
 * `minute` 단독 인덱스를 타는 rowid 하위 질의(실행 계획 테스트가 고정).
 */
export async function pruneChunk(cutMinute) {
  const db = await getDb();
  if (!db) return 0;
  let n = 0;
  n += db.prepare('DELETE FROM fm_metric WHERE rowid IN (SELECT rowid FROM fm_metric WHERE minute < ? LIMIT ?)').run(cutMinute, PRUNE_CHUNK).changes;
  n += db.prepare('DELETE FROM fm_proc WHERE rowid IN (SELECT rowid FROM fm_proc WHERE minute < ? LIMIT ?)').run(cutMinute, PRUNE_CHUNK).changes;
  db.prepare('DELETE FROM fm_run WHERE rowid IN (SELECT rowid FROM fm_run WHERE started < ? LIMIT ?)').run(cutMinute * 60_000, PRUNE_CHUNK);
  n += db.prepare('DELETE FROM fm_load WHERE rowid IN (SELECT rowid FROM fm_load WHERE minute < ? LIMIT ?)').run(cutMinute, PRUNE_CHUNK).changes;
  n += db.prepare('DELETE FROM fm_node WHERE rowid IN (SELECT rowid FROM fm_node WHERE minute < ? LIMIT ?)').run(cutMinute, PRUNE_CHUNK).changes;
  return n;
}

/** 용량 상한을 넘었을 때 가장 오래된 분부터 한 조각 지운다(보관 기간 안이라도). 지운 줄 수. */
export async function pruneOldestChunk() {
  const m = await oldestMinute();
  if (m == null) return 0;
  return pruneChunk(m + 1);
}

export function _planForTest(sql) { return _db ? _db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(0, 1).map((r) => r.detail).join(' | ') : ''; }
export function _resetForTest() { try { _db?.close(); } catch { /* */ } _db = null; _tried = false; _opening = null; _err = ''; lockRetry.ok(); }

/** 종료 직전 동기 적재 — 이미 열린 DB 가 있을 때만(새로 열지 않는다). 쓴 줄 수. */
export function writeBlocksSync(rows = []) {
  if (!_db || !rows.length) return 0;
  const m = _db.prepare('INSERT OR REPLACE INTO fm_metric (target, minute, n, data) VALUES (?, ?, ?, ?)');
  const p = _db.prepare('INSERT OR REPLACE INTO fm_proc (target, minute, data) VALUES (?, ?, ?)');
  const ld = _db.prepare('INSERT OR REPLACE INTO fm_load (target, minute, data) VALUES (?, ?, ?)');
  const nd = _db.prepare('INSERT OR REPLACE INTO fm_node (node, minute, data) VALUES (?, ?, ?)');
  try {
    _db.exec('BEGIN');
    for (const r of rows) {
      if (r.kind === 'p') p.run(String(r.target), r.minute, r.data);
      else if (r.kind === 'l') ld.run(String(r.target), r.minute, String(r.data));
      else if (r.kind === 'n') nd.run(String(r.target), r.minute, String(r.data));
      else m.run(String(r.target), r.minute, r.n | 0, r.data);
    }
    _db.exec('COMMIT');
    return rows.length;
  } catch { try { _db.exec('ROLLBACK'); } catch { /* */ } return 0; }
}
