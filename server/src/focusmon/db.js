/**
 * focusmon/db.js — 집중 모니터링 기록 DB(`focusmon.db` — 30일 보관 · v2.976 · 사용자 결정 2026-11-11 ‘뒤로 30일 · DB 에 저장 · 프로세스 목록도’).
 *
 * 표:
 *  · fm_metric(target, minute, n, data BLOB)  — 서버 1대 · 1분 = 한 줄(codec.js 압축 묶음 · 열 이름표 포함)
 *  · fm_proc(target, minute, data BLOB)       — 그 1분의 프로세스 상위 30 표본들(comm 만 · 사용자 이름 · 인자 0)
 *  · fm_run(id, started, ended, by, mode, interval, targets) — 수집 기록(누가 · 언제 · 어느 서버 · 방식) — ‘기록이 있는 시간’ 띠와 감사용
 *  · fm_audit(id, target, at, …, summary, report BLOB) — v3.11.0 디스크 점검 실행 한 번 = 한 줄(요약 JSON + 보고서 원문 gzip). 대상마다 최근 10회 · 90일.
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
      CREATE TABLE IF NOT EXISTS fm_audit (id TEXT PRIMARY KEY, target TEXT NOT NULL, at INTEGER NOT NULL, ended INTEGER, node TEXT, by TEXT, outcome TEXT, rc INTEGER, ver TEXT, summary TEXT, ready TEXT, report BLOB);
      CREATE INDEX IF NOT EXISTS idx_fm_audit_target_at ON fm_audit(target, at);
      CREATE INDEX IF NOT EXISTS idx_fm_audit_at ON fm_audit(at);
      CREATE TABLE IF NOT EXISTS fm_sum1 (target TEXT NOT NULL, minute INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (target, minute));
      CREATE INDEX IF NOT EXISTS idx_fm_sum1_minute ON fm_sum1(minute);
      CREATE TABLE IF NOT EXISTS fm_sum60 (target TEXT NOT NULL, hour INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (target, hour));
      CREATE INDEX IF NOT EXISTS idx_fm_sum60_hour ON fm_sum60(hour);
      CREATE TABLE IF NOT EXISTS fm_event (id TEXT NOT NULL, target TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, by TEXT, scope TEXT, PRIMARY KEY (id, target));
      CREATE INDEX IF NOT EXISTS idx_fm_event_target_at ON fm_event(target, at);
      CREATE INDEX IF NOT EXISTS idx_fm_event_at ON fm_event(at);
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
/**
 * 기록 대기열 줄 → 표(비동기 · 종료 직전 동기 경로가 같은 분기를 쓴다 — v3.13.0: 따로 두면 새 종류(요약 · 사건)가 종료 때 원본 표에 잘못 들어간다).
 * 모르는 종류는 쓰지 않는다(예전에는 원본 묶음으로 썼다).
 */
function runRows(db, rows) {
  const m = db.prepare('INSERT OR REPLACE INTO fm_metric (target, minute, n, data) VALUES (?, ?, ?, ?)');
  const p = db.prepare('INSERT OR REPLACE INTO fm_proc (target, minute, data) VALUES (?, ?, ?)');
  const ld = db.prepare('INSERT OR REPLACE INTO fm_load (target, minute, data) VALUES (?, ?, ?)');
  const nd = db.prepare('INSERT OR REPLACE INTO fm_node (node, minute, data) VALUES (?, ?, ?)');
  // v3.13.0(⑭): 1분 · 1시간 요약 · 사건(자동) — 같은 트랜잭션
  const s1 = db.prepare('INSERT OR REPLACE INTO fm_sum1 (target, minute, data) VALUES (?, ?, ?)');
  const s60 = db.prepare('INSERT OR REPLACE INTO fm_sum60 (target, hour, data) VALUES (?, ?, ?)');
  const ev = db.prepare('INSERT OR REPLACE INTO fm_event (id, target, at, kind, text, by, scope) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const r of rows) {
    if (r.kind === 'm' || r.kind == null) m.run(String(r.target), r.minute, r.n | 0, r.data);
    else if (r.kind === 's1') s1.run(String(r.target), r.minute, r.data);
    else if (r.kind === 's60') s60.run(String(r.target), r.hour, r.data);
    else if (r.kind === 'e') ev.run(String(r.id), String(r.target), r.at, String(r.ekind), String(r.text).slice(0, 300), String(r.by || '').slice(0, 64), String(r.scope || 'server'));
    else if (r.kind === 'p') p.run(String(r.target), r.minute, r.data);
    else if (r.kind === 'l') ld.run(String(r.target), r.minute, String(r.data));
    else if (r.kind === 'n') nd.run(String(r.target), r.minute, String(r.data));
  }
}

export async function writeBlocks(rows = []) {
  const db = await getDb();
  if (!db) return { ok: false, error: _err || lockRetry.note() || 'DB 를 열지 못했습니다' };
  if (!rows.length) return { ok: true, written: 0, ms: 0 };
  const t0 = performance.now();
  try {
    db.exec('BEGIN');
    runRows(db, rows);
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
/**
 * v3.12.0(⑬ 가득 찰 때까지) — [from, to] 에서 step 분마다 한 묶음만(하루 144묶음 · (target, minute) 인덱스 범위 뒤 나머지 거르기).
 * 결과가 크지 않게 줄 수 상한 `limit`.
 */
export async function readMetricEvery(target, fromMinute, toMinute, step = 10, limit = 400) {
  const db = await getDb();
  if (!db) return null;
  return db.prepare('SELECT minute, data FROM fm_metric WHERE target = ? AND minute >= ? AND minute <= ? AND minute % ? = 0 ORDER BY minute LIMIT ?')
    .all(String(target), fromMinute, toMinute, Math.max(1, step | 0), limit);
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

/** 가장 오래된 1분 요약의 분(1시간 요약 할 일 찾기의 시작점 — 원본보다 요약이 앞설 수 있다). */
export async function oldestSumMinute() {
  const db = await getDb();
  if (!db) return null;
  const r = db.prepare('SELECT MIN(minute) AS m FROM fm_sum1').get();
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
  // v3.13.0(⑭) 요약 · 사건도 같은 보관 기간(컨펌 ② · ⑥ — 30일)
  n += db.prepare('DELETE FROM fm_sum1 WHERE rowid IN (SELECT rowid FROM fm_sum1 WHERE minute < ? LIMIT ?)').run(cutMinute, PRUNE_CHUNK).changes;
  n += db.prepare('DELETE FROM fm_sum60 WHERE rowid IN (SELECT rowid FROM fm_sum60 WHERE hour < ? LIMIT ?)').run(Math.floor(cutMinute / 60), PRUNE_CHUNK).changes;
  n += db.prepare('DELETE FROM fm_event WHERE rowid IN (SELECT rowid FROM fm_event WHERE at < ? LIMIT ?)').run(cutMinute * 60_000, PRUNE_CHUNK).changes;
  return n;
}

/* ── 요약 · 사건(v3.13.0 ⑭) ─────────────────────────────────────────────── */
/** 1분 요약 [fromMinute, toMinute] — (target, minute) 기본 키 범위. */
export async function readSum1(target, fromMinute, toMinute, limit = 2000) {
  const db = await getDb();
  if (!db) return null;
  return db.prepare('SELECT minute, data FROM fm_sum1 WHERE target = ? AND minute >= ? AND minute <= ? ORDER BY minute LIMIT ?').all(String(target), fromMinute, toMinute, limit);
}
/** 1시간 요약 [fromHour, toHour]. */
export async function readSum60(target, fromHour, toHour, limit = 1000) {
  const db = await getDb();
  if (!db) return null;
  return db.prepare('SELECT hour, data FROM fm_sum60 WHERE target = ? AND hour >= ? AND hour <= ? ORDER BY hour LIMIT ?').all(String(target), fromHour, toHour, limit);
}
/**
 * 요약이 아직 없는 원본 분(백필 — 컨펌 ③ '한 번 조각으로 · 쉬어 가며'). (afterMinute, beforeMinute) 를 minute 순으로 limit 줄.
 * minute 인덱스 범위 + 기본 키 존재 확인(NOT EXISTS). 부르는 쪽(rollup.backfillSlice)이 범위를 6시간씩 잘라 부른다 —
 * 범위를 열어 두면 다 만든 뒤에도 기동마다 원본 표 전체를 한 번에 훑었다(반증 F13 — 30일 × 20대 약 0.7초 추정).
 */
export async function metricsWithoutSum(afterMinute, beforeMinute, limit = 50) {
  const db = await getDb();
  if (!db) return null;
  return db.prepare('SELECT m.target AS target, m.minute AS minute, m.data AS data FROM fm_metric m WHERE m.minute > ? AND m.minute < ? AND NOT EXISTS (SELECT 1 FROM fm_sum1 s WHERE s.target = m.target AND s.minute = m.minute) ORDER BY m.minute LIMIT ?')
    .all(afterMinute, beforeMinute, limit);
}
/**
 * 1시간 요약이 없는 끝난 시간들 — [fromMinute, toMinute) 의 1분 요약 (대상, 시간) 가운데(조각으로 부른다 — rollup.seedDirty 가 보관 기간을 6시간씩 훑는다 · 반증 F4).
 * minute 인덱스 범위 + 1시간 요약 기본 키 존재 확인(NOT EXISTS). 정수 나눗셈으로 시간.
 */
export async function hoursWithoutSum60(fromMinute, toMinute, limit = 5000) {
  const db = await getDb();
  if (!db) return null;
  return db.prepare('SELECT DISTINCT s.target AS target, s.minute / 60 AS hour FROM fm_sum1 s WHERE s.minute >= ? AND s.minute < ? AND NOT EXISTS (SELECT 1 FROM fm_sum60 h WHERE h.target = s.target AND h.hour = s.minute / 60) LIMIT ?')
    .all(fromMinute, toMinute, limit).map((r) => ({ target: r.target, hour: Number(r.hour) }));
}
/** 직접 적은 사건 하나(같은 id 의 줄 전부)를 지운다 — 자동 사건은 지우지 않는다(kind 'user' 만). 지운 줄 수. */
export async function deleteUserEvent(id) {
  const db = await getDb();
  if (!db) return null;
  return db.prepare("DELETE FROM fm_event WHERE id = ? AND kind = 'user'").run(String(id)).changes;
}
/** 대상의 사건 [from, to](시각 순 · 상한). */
export async function readEvents(target, from, to, limit = 200) {
  const db = await getDb();
  if (!db) return null;
  // 최근 쪽을 남긴다(반증 F2 — 오래된 것부터 자르면 자동 사건이 많을 때 최근에 직접 적은 사건이 빠졌다) · 돌려줄 때는 시각 순
  return db.prepare('SELECT id, target, at, kind, text, by, scope FROM fm_event WHERE target = ? AND at >= ? AND at <= ? ORDER BY at DESC LIMIT ?').all(String(target), from, to, limit).reverse();
}
/** v3.16.0(⑯) 모든 대상의 사건 [from, to] 중 종류(알림 · OOM · 커널 오류 · 수집 조절) — 알림 탭 기록 · 표. at 인덱스 범위 · 최근 쪽 상한. */
export async function readEventsOfKinds(from, to, kinds = [], limit = 2000) {
  const db = await getDb();
  if (!db) return null;
  const ks = kinds.filter((k) => /^[a-z]{1,12}$/.test(k)).slice(0, 8);
  if (!ks.length) return [];
  return db.prepare(`SELECT id, target, at, kind, text FROM fm_event WHERE at >= ? AND at <= ? AND kind IN (${ks.map(() => '?').join(',')}) ORDER BY at DESC LIMIT ?`).all(from, to, ...ks, limit);
}
/** 사건(id 로) — 지우기 전 확인(직접 적은 것인지 · 누가 · 어느 서버들). null = DB 를 못 열었다 · [] = 없다. */
export async function eventById(id) {
  const db = await getDb();
  if (!db) return null;
  return db.prepare('SELECT id, target, at, kind, text, by, scope FROM fm_event WHERE id = ? LIMIT 250').all(String(id));
}

/** 용량 상한을 넘었을 때 가장 오래된 분부터 한 조각 지운다(보관 기간 안이라도). 지운 줄 수. */
export async function pruneOldestChunk() {
  const m = await oldestMinute();
  if (m == null) return 0;
  return pruneChunk(m + 1);
}

/* ── 디스크 점검(v3.11.0) ─────────────────────────────────────────────── */
export const AUDIT_KEEP = 10;
export const AUDIT_KEEP_DAYS = 90;
const auditRow = (r) => { if (!r) return null; let summary = null; try { summary = r.summary ? JSON.parse(r.summary) : null; } catch { summary = null; } return { id: r.id, target: r.target, at: r.at, ended: r.ended ?? null, node: r.node || '', by: r.by || '', outcome: r.outcome || '', rc: r.rc ?? null, ver: r.ver || '', summary }; };
/**
 * 실행 한 번 적재 + 그 대상의 오래된 회차 정리(최근 AUDIT_KEEP 회 · AUDIT_KEEP_DAYS 일) — 한 트랜잭션.
 * @returns {Promise<boolean>}
 */
export async function writeAudit(a, now = Date.now()) {
  const db = await getDb();
  if (!db) return false;
  try {
    db.exec('BEGIN');
    db.prepare('INSERT OR REPLACE INTO fm_audit (id, target, at, ended, node, by, outcome, rc, ver, summary, ready, report) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(String(a.id), String(a.target), a.at, a.ended ?? null, String(a.node || ''), String(a.by || '').slice(0, 64), String(a.outcome || ''), Number.isInteger(a.rc) ? a.rc : null, String(a.ver || '').slice(0, 64),
        JSON.stringify(a.summary ?? null), JSON.stringify(a.ready ?? []), a.report ?? null);
    db.prepare('DELETE FROM fm_audit WHERE target = ? AND id NOT IN (SELECT id FROM fm_audit WHERE target = ? ORDER BY at DESC LIMIT ?)').run(String(a.target), String(a.target), AUDIT_KEEP);
    db.prepare('DELETE FROM fm_audit WHERE rowid IN (SELECT rowid FROM fm_audit WHERE at < ? LIMIT 200)').run(now - AUDIT_KEEP_DAYS * 86_400_000);
    db.exec('COMMIT');
    return true;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* */ }
    console.warn('[focusmon-db] 디스크 점검 결과를 쓰지 못했습니다:', String(e?.message || e).slice(0, 200));
    return false;
  }
}
/**
 * 용량 상한을 넘었을 때(recorder housekeep) — 하루보다 오래된 회차의 **원문만** 한 조각 비운다(요약 · 판정은 남는다 · 반증 F9-b: 정리가 지표만 지웠다).
 * fm_audit 는 대상당 10회 · 90일이라 작다 — at 인덱스 없이 훑어도 된다. 비운 줄 수.
 */
export async function pruneAuditBlobs(olderThan, limit = 50) {
  const db = await getDb();
  if (!db) return 0;
  try { return db.prepare('UPDATE fm_audit SET report = NULL WHERE rowid IN (SELECT rowid FROM fm_audit WHERE report IS NOT NULL AND at < ? LIMIT ?)').run(olderThan, limit).changes; } catch { return 0; }
}
/** 한 대상의 회차(최근부터 · 원문 없이). */
export async function listAudits(target, limit = AUDIT_KEEP) {
  const db = await getDb();
  if (!db) return null;
  return db.prepare('SELECT id, target, at, ended, node, by, outcome, rc, ver, summary FROM fm_audit WHERE target = ? ORDER BY at DESC LIMIT ?').all(String(target), Math.max(1, Math.min(50, limit | 0))).map(auditRow);
}
/** 한 대상의 가장 최근 회차(원문 없이) — (target, at) 인덱스 · 대상마다 한 번(GROUP BY + MAX 금지 규약). */
export async function latestAudit(target) {
  const db = await getDb();
  if (!db) return null;
  return auditRow(db.prepare('SELECT id, target, at, ended, node, by, outcome, rc, ver, summary FROM fm_audit WHERE target = ? ORDER BY at DESC LIMIT 1').get(String(target)));
}
/** 회차 하나(원문 포함 — 보고서 보기 · 내려받기). */
export async function readAudit(id) {
  const db = await getDb();
  if (!db) return null;
  const r = db.prepare('SELECT * FROM fm_audit WHERE id = ?').get(String(id));
  if (!r) return null;
  let ready = []; try { ready = JSON.parse(r.ready || '[]'); } catch { ready = []; }
  return { ...auditRow(r), ready: Array.isArray(ready) ? ready : [], report: r.report ? Buffer.from(r.report) : null };
}

export function _planForTest(sql) { return _db ? _db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(0, 1).map((r) => r.detail).join(' | ') : ''; }
export function _resetForTest() { try { _db?.close(); } catch { /* */ } _db = null; _tried = false; _opening = null; _err = ''; lockRetry.ok(); }

/** 종료 직전 동기 적재 — 이미 열린 DB 가 있을 때만(새로 열지 않는다). 쓴 줄 수. */
export function writeBlocksSync(rows = []) {
  if (!_db || !rows.length) return 0;
  try {
    _db.exec('BEGIN');
    runRows(_db, rows);
    _db.exec('COMMIT');
    return rows.length;
  } catch { try { _db.exec('ROLLBACK'); } catch { /* */ } return 0; }
}
