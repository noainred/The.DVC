/**
 * isidu/db.js — 아이실론 디렉터리 사용량 이력 DB(v2.736). 파일: `<dbDir>/isidu.db`
 *
 * ── 행 수를 먼저 계산했다 ────────────────────────────────────────────────────
 * 사용자 폴더 2,000개 · 하루 1회 · 400일 = 대상 하나에 80만 행(행 약 40B → 약 32MB). 대상 10개면 800만 행.
 * 사용자 요청이 "주기적으로 트래킹" 이라 **사용자별 추이**가 필요하다 — Top-N 만 남기면(예전 dirusage) 순위 밖 사용자의
 * 과거를 볼 수 없다. 그래서 스캔마다 전체 폴더를 남기고 보존일(기본 400일)로 자른다.
 *   ① `isidu_scan`   스캔 1회 = 1행(성공·실패 모두 — 실패 사유가 수집 상태 화면의 근거다)
 *   ② `isidu_entry`  스캔의 폴더(사용자) 하나 = 1행 · PK (scan_id, name) WITHOUT ROWID — 사용자 추이는 스캔마다 PK 선탐색
 *   ③ `isidu_latest` 대상별 마지막 성공·마지막 시도(화면 표 전용 — ⚠ GROUP BY+MAX(ts) 로 대체하지 말 것, v2.550.3)
 * 이력 키(agent 열)는 언제나 '' 다 — 대상 id 는 중앙 설정이 발급해 전 함대에서 하나이고, 담당 노드가 중앙↔엣지로 바뀌어도 사용자 추이가
 * 이어져야 한다(엣지 push 는 그 엣지에 배정된 대상만 받으므로 남의 대상을 덮을 수 없다). 누가 조사했는지는 `node` 열('' = 이 노드).
 *
 * ── 규칙(이 저장소가 실측으로 배운 것) ─────────────────────────────────────────
 *  · open 은 진행 중인 시도를 공유하고 잠금은 래치하지 않는다(`createLockRetry` — v2.597) · busy_timeout 먼저 · 0600(`openSqlite`).
 *  · 같은 (agent, 대상, 시각) 재적재는 무시한다(엣지 재전송 멱등). 폴더 적재는 5,000행마다 COMMIT 뒤 양보(v2.611 — 트랜잭션을 연 채
 *    양보하지 않는다). 다 넣은 뒤에야 `complete=1` 과 최신 표를 바꾼다 — 중간에 끊긴 스캔은 조회되지 않고, 재전송이 다시 채운다.
 *  · 보존 정리는 스캔 단위로 끊어서 하고 대상별 마지막 성공 스캔은 지우지 않는다(지우면 '지금 크기' 가 사라진다).
 *  · 못 읽은 값은 NULL(0 은 '빈 폴더' 라는 거짓).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { numOrNull } from '../util/numOrNull.js';
import { openSqlite, createLockRetry } from '../util/sqliteOpen.js';
import { bySizeThenName } from './parse.js';

const FILE = () => path.join(config.dbDir || config.configDir, 'isidu.db');
const lockRetry = createLockRetry();
const ENTRY_COMMIT_ROWS = 5_000;

let _db = null; let _tried = false; let _opening = null;

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
      CREATE TABLE IF NOT EXISTS isidu_scan (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL, target_id TEXT NOT NULL, ts INTEGER NOT NULL,
        ok INTEGER NOT NULL, complete INTEGER NOT NULL DEFAULT 0,
        path TEXT, host TEXT, size_mode TEXT, duration_ms INTEGER,
        total_bytes INTEGER, total_res INTEGER, sum_bytes INTEGER, sum_res INTEGER, count INTEGER,
        skipped INTEGER, err_lines INTEGER, err_sample TEXT, truncated INTEGER,
        kind TEXT, err TEXT, trig TEXT, edge_scan_id INTEGER, node TEXT,
        UNIQUE (agent, target_id, ts)
      );
      CREATE INDEX IF NOT EXISTS idx_isidu_scan_ts ON isidu_scan(ts);
      CREATE INDEX IF NOT EXISTS idx_isidu_scan_tgt ON isidu_scan(agent, target_id, ts);
      CREATE TABLE IF NOT EXISTS isidu_entry (
        scan_id INTEGER NOT NULL, name TEXT NOT NULL, bytes INTEGER NOT NULL, res INTEGER NOT NULL,
        PRIMARY KEY (scan_id, name)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS isidu_latest (
        agent TEXT NOT NULL, target_id TEXT NOT NULL,
        ok_scan_id INTEGER, ok_ts INTEGER, try_scan_id INTEGER, try_ts INTEGER, fail_streak INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent, target_id)
      );
    `);
    _db = conn;
  } catch (e) {
    try { conn?.close(); } catch { /* 이미 닫힘 */ }
    if (lockRetry.onFail(e)) { console.warn(`[isidu-db] ${lockRetry.note()}`); return null; }
    console.warn('[isidu-db] 사용 불가(DB 없이 동작 — 디렉터리 사용량 이력이 남지 않습니다):', e?.message);
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
const yieldNow = () => new Promise((r) => setImmediate(r));
/**
 * 쓰기 줄 — 적재·정리·삭제는 한 연결에서 트랜잭션을 열고 닫으며 사이사이 양보한다. 두 쓰기가 섞이면 한쪽의 BEGIN 이
 * 다른 쪽의 열린 트랜잭션 안에서 실패하므로 한 줄로 세운다(읽기는 양보 지점 — 트랜잭션이 닫힌 때 — 에만 돈다).
 */
let _wq = Promise.resolve();
function serial(fn) { const p = _wq.then(fn, fn); _wq = p.catch(() => {}); return p; }

/**
 * 스캔 1건 적재(폴더 포함). 같은 (agent, 대상, ts) 가 이미 온전히 있으면 duplicate.
 * @param {object} rec { agent, targetId, ts, ok, path, host, sizeMode, durationMs, total:{bytes,res}|null, sumBytes, sumRes, count,
 *                       skipped, errLines, errSample[], truncated, kind, error, trig, edgeScanId, entries:[{name,bytes,res}] }
 * @returns {Promise<{ok:boolean, id?:number, duplicate?:boolean, error?:string}>}
 */
export function insertScan(rec) { return serial(() => insertScanInner(rec)); }
async function insertScanInner(rec) {
  const db = await getDb();
  if (!db) return { ok: false, error: lockRetry.note() || 'DB 를 열지 못했습니다' };
  const agent = String(rec?.agent ?? '').slice(0, 128);
  const targetId = String(rec?.targetId ?? '').slice(0, 64);
  const ts = iOr(rec?.ts);
  if (!targetId || ts == null) return { ok: false, error: '대상·시각이 없습니다' };
  const ok = rec.ok === true ? 1 : 0;
  const entries = ok && Array.isArray(rec.entries) ? rec.entries : [];
  let id = null;
  try {
    db.exec('BEGIN');
    const prev = db.prepare('SELECT id, complete FROM isidu_scan WHERE agent=? AND target_id=? AND ts=?').get(agent, targetId, ts);
    if (prev && prev.complete) { db.exec('COMMIT'); return { ok: true, id: prev.id, duplicate: true }; }
    if (prev) { // 중간에 끊긴 적재 — 폴더를 지우고 다시 넣는다
      db.prepare('DELETE FROM isidu_entry WHERE scan_id=?').run(prev.id);
      id = prev.id;
    } else {
      const r = db.prepare(`INSERT INTO isidu_scan
        (agent, target_id, ts, ok, complete, path, host, size_mode, duration_ms, total_bytes, total_res, sum_bytes, sum_res, count,
         skipped, err_lines, err_sample, truncated, kind, err, trig, edge_scan_id, node)
        VALUES (?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        agent, targetId, ts, ok, s(rec.path, 1024), s(rec.host, 256), s(rec.sizeMode, 4), iOr(rec.durationMs),
        ok ? iOr(rec.total?.bytes) : null, ok ? iOr(rec.total?.res) : null,
        ok ? iOr(rec.sumBytes) : null, ok ? iOr(rec.sumRes) : null, ok ? iOr(rec.count) : null,
        iOr(rec.skipped), iOr(rec.errLines), Array.isArray(rec.errSample) && rec.errSample.length ? JSON.stringify(rec.errSample.slice(0, 5).map((x) => String(x).slice(0, 200))) : null,
        rec.truncated ? 1 : 0, ok ? null : s(rec.kind || 'error', 32), ok ? null : s(rec.error, 600), s(rec.trig, 16), iOr(rec.edgeScanId),
        s(rec.node, 128));
      id = Number(r.lastInsertRowid);
    }
    const insE = db.prepare('INSERT OR IGNORE INTO isidu_entry (scan_id, name, bytes, res) VALUES (?,?,?,?)');
    let inTx = 0;
    for (const e of entries) {
      if (!e || typeof e.name !== 'string' || !e.name || e.name.length > 512) continue;
      const b = iOr(e.bytes); if (b == null || b < 0) continue;
      insE.run(id, e.name, b, Math.max(1, iOr(e.res) || 1));
      if (++inTx >= ENTRY_COMMIT_ROWS) { db.exec('COMMIT'); inTx = 0; await yieldNow(); db.exec('BEGIN'); }
    }
    db.prepare('UPDATE isidu_scan SET complete=1 WHERE id=?').run(id);
    db.prepare(`INSERT INTO isidu_latest (agent, target_id, ok_scan_id, ok_ts, try_scan_id, try_ts, fail_streak)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(agent, target_id) DO UPDATE SET
        ok_scan_id = CASE WHEN excluded.ok_scan_id IS NOT NULL AND (isidu_latest.ok_ts IS NULL OR excluded.ok_ts > isidu_latest.ok_ts) THEN excluded.ok_scan_id ELSE isidu_latest.ok_scan_id END,
        ok_ts = CASE WHEN excluded.ok_scan_id IS NOT NULL AND (isidu_latest.ok_ts IS NULL OR excluded.ok_ts > isidu_latest.ok_ts) THEN excluded.ok_ts ELSE isidu_latest.ok_ts END,
        fail_streak = CASE WHEN excluded.try_ts > IFNULL(isidu_latest.try_ts, 0) THEN (CASE WHEN excluded.ok_scan_id IS NOT NULL THEN 0 ELSE isidu_latest.fail_streak + 1 END) ELSE isidu_latest.fail_streak END,
        try_scan_id = CASE WHEN excluded.try_ts > IFNULL(isidu_latest.try_ts, 0) THEN excluded.try_scan_id ELSE isidu_latest.try_scan_id END,
        try_ts = MAX(IFNULL(isidu_latest.try_ts, 0), excluded.try_ts)`).run(
      agent, targetId, ok ? id : null, ok ? ts : null, id, ts, ok ? 0 : 1);
    db.exec('COMMIT');
    return { ok: true, id, duplicate: false };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 열린 트랜잭션 없음 */ }
    return { ok: false, error: e.message };
  }
}

const scanRow = (r) => (r ? {
  id: r.id, agent: r.agent, targetId: r.target_id, ts: r.ts, ok: !!r.ok, complete: !!r.complete, path: r.path, host: r.host,
  sizeMode: r.size_mode, durationMs: r.duration_ms, total: r.total_bytes == null ? null : { bytes: r.total_bytes, res: r.total_res ?? 1 },
  sumBytes: r.sum_bytes, sumRes: r.sum_res, count: r.count, skipped: r.skipped, errLines: r.err_lines,
  errSample: (() => { try { return r.err_sample ? JSON.parse(r.err_sample) : []; } catch { return []; } })(),
  truncated: !!r.truncated, kind: r.kind, error: r.err, trig: r.trig, edgeScanId: r.edge_scan_id, node: r.node ?? '',
} : null);

/** 대상별 최신(성공·시도) — 표 전용. */
export async function latestAll() {
  const db = await getDb();
  if (!db) return null;
  const rows = db.prepare('SELECT * FROM isidu_latest').all();
  const byId = db.prepare('SELECT * FROM isidu_scan WHERE id=?');
  return rows.map((r) => ({
    agent: r.agent, targetId: r.target_id, failStreak: r.fail_streak,
    okScan: r.ok_scan_id != null ? scanRow(byId.get(r.ok_scan_id)) : null,
    lastTry: r.try_scan_id != null ? scanRow(byId.get(r.try_scan_id)) : null,
  }));
}

export async function latestOf(agent, targetId) {
  const db = await getDb();
  if (!db) return null;
  const r = db.prepare('SELECT * FROM isidu_latest WHERE agent=? AND target_id=?').get(String(agent ?? ''), String(targetId));
  if (!r) return { okScan: null, lastTry: null, failStreak: 0 };
  const byId = db.prepare('SELECT * FROM isidu_scan WHERE id=?');
  return { okScan: r.ok_scan_id != null ? scanRow(byId.get(r.ok_scan_id)) : null, lastTry: r.try_scan_id != null ? scanRow(byId.get(r.try_scan_id)) : null, failStreak: r.fail_streak };
}

/** 그 시각 이전(포함)의 마지막 성공 스캔. */
export async function okScanAtOrBefore(agent, targetId, ts) {
  const db = await getDb();
  if (!db) return null;
  return scanRow(db.prepare(`SELECT * FROM isidu_scan WHERE agent=? AND target_id=? AND ok=1 AND complete=1 AND ts<=?
    ORDER BY ts DESC LIMIT 1`).get(String(agent ?? ''), String(targetId), Math.round(ts)));
}

/** 그 스캔 직전의 성공 스캔. */
export async function okScanBefore(agent, targetId, ts) {
  const db = await getDb();
  if (!db) return null;
  return scanRow(db.prepare(`SELECT * FROM isidu_scan WHERE agent=? AND target_id=? AND ok=1 AND complete=1 AND ts<?
    ORDER BY ts DESC LIMIT 1`).get(String(agent ?? ''), String(targetId), Math.round(ts)));
}

/** 스캔의 폴더 전체 → Map(name → {bytes,res}). */
export async function entriesOf(scanId) {
  const db = await getDb();
  if (!db || scanId == null) return new Map();
  const m = new Map();
  // v2.740 E-03: .iterate() 는 행마다 JS↔SQLite 왕복이라 .all() 보다 3.4배 느렸다(5만 행 182ms 대 53ms).
  for (const r of db.prepare('SELECT name, bytes, res FROM isidu_entry WHERE scan_id=?').all(Number(scanId))) m.set(r.name, { bytes: r.bytes, res: r.res });
  return m;
}

/** 기간 안의 스캔(성공·실패 모두, 오래된 것부터). */
export async function scansIn(agent, targetId, sinceTs, limit = 2000) {
  const db = await getDb();
  if (!db) return null;
  return db.prepare(`SELECT * FROM isidu_scan WHERE agent=? AND target_id=? AND ts>=? AND complete=1 ORDER BY ts LIMIT ?`)
    .all(String(agent ?? ''), String(targetId), Math.round(sinceTs), Math.max(1, Math.min(5000, Math.round(limit)))).map(scanRow);
}

/** 사용자(폴더) 하나의 기간 추이 — 성공 스캔마다 1점(그 스캔에 폴더가 없으면 점이 없다). */
export async function seriesOfName(agent, targetId, name, sinceTs) {
  const db = await getDb();
  if (!db) return null;
  return db.prepare(`SELECT s.ts AS ts, e.bytes AS bytes, e.res AS res FROM isidu_scan s
    JOIN isidu_entry e ON e.scan_id = s.id AND e.name = ?
    WHERE s.agent=? AND s.target_id=? AND s.ok=1 AND s.complete=1 AND s.ts>=? ORDER BY s.ts`)
    .all(String(name), String(agent ?? ''), String(targetId), Math.round(sinceTs));
}

/**
 * 여러 사용자(폴더)의 추이를 한 번에 — 스파크라인 전용. 기간 안의 성공 스캔을 최대 maxPoints 개로 고르게 뽑고(마지막 스캔은 항상 포함)
 * 이름마다 PK 선탐색(scan_id, name). 그 스캔에 폴더가 없으면 null(0 이 아니다 — '그때는 없던 폴더'). 50명마다 양보.
 * @returns {Promise<{ts:number[], series:Map<string,(number|null)[]>}|null>}
 */
export async function seriesOfNames(agent, targetId, names, sinceTs, maxPoints = 40) {
  const db = await getDb();
  if (!db) return null;
  let scans = db.prepare(`SELECT id, ts FROM isidu_scan WHERE agent=? AND target_id=? AND ok=1 AND complete=1 AND ts>=? ORDER BY ts`)
    .all(String(agent ?? ''), String(targetId), Math.round(sinceTs));
  const cap = Math.max(2, Math.round(maxPoints));
  if (scans.length > cap) {
    const step = (scans.length - 1) / (cap - 1);
    const picked = [];
    for (let i = 0; i < cap; i++) picked.push(scans[Math.round(i * step)]);
    scans = picked;
  }
  const one = db.prepare('SELECT bytes FROM isidu_entry WHERE scan_id=? AND name=?');
  const series = new Map();
  let k = 0;
  for (const name of names || []) {
    if (typeof name !== 'string' || series.has(name)) continue;
    series.set(name, scans.map((sc) => one.get(sc.id, name)?.bytes ?? null));
    if (++k % 50 === 0) await yieldNow();
  }
  return { ts: scans.map((sc) => sc.ts), series };
}

/**
 * v2.739 개요·전 법인 Top 10 — 스캔의 큰 폴더 상위 n 개. 순서는 parse.sortBySize(크기 내림차순 → 이름 localeCompare)와 같아야 한다
 * (보고서의 순위와 어긋나지 않게). SQL 의 이름 정렬은 바이트 순이라, n 번째 크기 이상인 행을 **같은 크기까지 전부** 받아 JS 에서 정렬한다
 * (-h 표기는 같은 크기가 흔하다 — 경계에서 SQL 이 고른 10개가 보고서의 10개와 달라진다).
 * @returns {Promise<{name:string, bytes:number, res:number, rank:number}[]|null>}
 */
export async function topEntriesOf(scanId, n = 10) {
  const db = await getDb();
  if (!db) return null;
  if (scanId == null) return [];
  const lim = Math.max(1, Math.min(50, Math.round(Number(n) || 10)));
  const cut = db.prepare('SELECT bytes FROM isidu_entry WHERE scan_id=? ORDER BY bytes DESC LIMIT 1 OFFSET ?').get(Number(scanId), lim - 1);
  const rows = cut
    ? db.prepare('SELECT name, bytes, res FROM isidu_entry WHERE scan_id=? AND bytes>=?').all(Number(scanId), cut.bytes)
    : db.prepare('SELECT name, bytes, res FROM isidu_entry WHERE scan_id=?').all(Number(scanId));
  rows.sort(bySizeThenName);
  return rows.slice(0, lim).map((r, i) => ({ name: r.name, bytes: r.bytes, res: r.res, rank: i + 1 }));
}

/** 그 스캔에서 고른 이름들의 크기 → Map(name → {bytes,res}). 이름마다 PK 선탐색 — 그 스캔에 없는 이름은 Map 에 없다. */
export async function entriesByNames(scanId, names) {
  const db = await getDb();
  if (!db) return null;
  const m = new Map();
  if (scanId == null) return m;
  const one = db.prepare('SELECT bytes, res FROM isidu_entry WHERE scan_id=? AND name=?');
  for (const name of names || []) {
    if (typeof name !== 'string' || m.has(name)) continue;
    const r = one.get(Number(scanId), name);
    if (r) m.set(name, { bytes: r.bytes, res: r.res });
  }
  return m;
}

/** v2.739 수집 상태 — 최근 스캔(전 대상, 최신부터, 성공·실패 모두). ts 인덱스를 거꾸로 읽는다. */
export async function recentScans(agent, limit = 30) {
  const db = await getDb();
  if (!db) return null;
  // v2.740 E-07: `+agent` 로 (agent,target_id,ts) 인덱스를 피해 ts 인덱스를 거꾸로 읽는다 — 예전엔 agent 인덱스로 전 행을 고른 뒤
  // 임시 B-tree 로 정렬했다(스캔 96만 행 155~165ms → 0.8ms 실측). 결과는 같다(조건이 같다).
  return db.prepare('SELECT * FROM isidu_scan WHERE +agent=? AND complete=1 ORDER BY ts DESC LIMIT ?')
    .all(String(agent ?? ''), Math.max(1, Math.min(500, Math.round(Number(limit) || 30)))).map(scanRow);
}

/** 엣지 push 용 — 로컬(agent '') 스캔 중 id 가 cursor 보다 큰 것(오래된 것부터). */
export async function localScansAfter(cursor, limit = 20) {
  const db = await getDb();
  if (!db) return null;
  // v2.740 E-07: `+agent` 로 rowid(id) 순서를 그대로 읽는다(예전엔 agent 인덱스 → 임시 정렬, 96만 행 140~159ms → 0.2ms).
  const rows = db.prepare(`SELECT * FROM isidu_scan WHERE +agent='' AND complete=1 AND id>? ORDER BY id LIMIT ?`).all(Math.max(0, Math.round(n(cursor) || 0)), Math.max(1, Math.round(limit)));
  return rows.map(scanRow);
}
export async function maxLocalScanId() {
  const db = await getDb();
  if (!db) return null;
  // v2.740 E-07: MAX(id)+agent 조건은 커버링 인덱스 전체를 훑었다(96만 행 52ms) — id 를 거꾸로 읽어 첫 행에서 멈춘다(0.1ms).
  return db.prepare("SELECT id AS m FROM isidu_scan WHERE +agent='' ORDER BY id DESC LIMIT 1").get()?.m ?? 0;
}

/**
 * 보존 정리 — cutoff 보다 오래된 스캔을 스캔 단위로 지운다(대상별 마지막 성공 스캔 제외). 스캔 50개마다 양보.
 * @returns {Promise<{scans:number, entries:number}>}
 */
let _pruning = null;
export function prune(cutoffTs) {
  if (_pruning) return _pruning;
  _pruning = serial(async () => {
    const db = await getDb();
    if (!db) return { scans: 0, entries: 0 };
    let scans = 0; let entries = 0;
    for (;;) {
      const ids = db.prepare(`SELECT id FROM isidu_scan WHERE ts < ?
        AND id NOT IN (SELECT ok_scan_id FROM isidu_latest WHERE ok_scan_id IS NOT NULL)
        AND id NOT IN (SELECT try_scan_id FROM isidu_latest WHERE try_scan_id IS NOT NULL) LIMIT 50`).all(Math.round(cutoffTs)).map((r) => r.id);
      if (!ids.length) break;
      for (const id of ids) {
        try {
          db.exec('BEGIN');
          entries += Number(db.prepare('DELETE FROM isidu_entry WHERE scan_id=?').run(id).changes || 0);
          scans += Number(db.prepare('DELETE FROM isidu_scan WHERE id=?').run(id).changes || 0);
          db.exec('COMMIT');
        } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } console.warn(`[isidu-db] 정리 실패: ${e.message}`); return { scans, entries }; }
        await yieldNow();
      }
    }
    if (scans) console.log(`[isidu-db] 보존 정리 — 스캔 ${scans}건 · 폴더 행 ${entries.toLocaleString()}건 삭제`);
    return { scans, entries };
  }).finally(() => { _pruning = null; });
  return _pruning;
}

/** 대상 삭제 — 그 대상의 이력 전부(관리자가 설정에서 뺐을 때는 남긴다; 이 함수는 명시 요청에만). */
export function dropTarget(agent, targetId) { return serial(() => dropTargetInner(agent, targetId)); }
async function dropTargetInner(agent, targetId) {
  const db = await getDb();
  if (!db) return { ok: false };
  const ids = db.prepare('SELECT id FROM isidu_scan WHERE agent=? AND target_id=?').all(String(agent ?? ''), String(targetId)).map((r) => r.id);
  for (const id of ids) {
    db.exec('BEGIN');
    db.prepare('DELETE FROM isidu_entry WHERE scan_id=?').run(id);
    db.prepare('DELETE FROM isidu_scan WHERE id=?').run(id);
    db.exec('COMMIT');
    await yieldNow();
  }
  db.prepare('DELETE FROM isidu_latest WHERE agent=? AND target_id=?').run(String(agent ?? ''), String(targetId));
  return { ok: true, scans: ids.length };
}

/** 진단(행 수는 세지 않는다 — rowid 끝값만). */
export async function dbStats() {
  const db = await getDb();
  if (!db) return { available: false, path: FILE() };
  const scans = db.prepare('SELECT MAX(id) AS m FROM isidu_scan').get()?.m ?? 0;
  let size = null; try { size = fs.statSync(FILE()).size; } catch { size = null; }
  return { available: true, path: FILE(), scansApprox: scans, bytes: size };
}

export async function _closeForTest() { try { _db?.close(); } catch { /* */ } _db = null; _tried = false; _opening = null; }
