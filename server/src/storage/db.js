/**
 * storage/db.js — 스토리지 수집 DB(v2.308, 사용자 요구 '수집한 모든 정보는 DB 에 저장').
 *
 * SQLite(node:sqlite — idrac/db.js 와 동일 백엔드) 파일: CONFIG_DIR/storage-history.db
 *  - api_latest  : OneFS API 영역별 응답 **원문(JSON)** 최신본 — (device, endpoint) 당 1행 갱신.
 *  - api_history : 영역별 수집 성공/실패 이력(원문 아님 — 상태·크기만. 원문 이력까지 쌓으면
 *                  40영역×주기로 DB 가 GB 단위로 폭주한다. 원문은 최신본만, 이력은 메타만 —
 *                  정직 표기: 릴리스 노트에 명시).
 *  - capacity_history : 용량 시계열(전체/HDD/SSD) — 추이 그래프용. 폴링마다 1점.
 *
 * CLAUDE.md 성능 규칙 준수: WAL + synchronous=NORMAL + busy_timeout(단건 insert 실측 최적화),
 * prune 는 매 저장이 아니라 N회마다 1회(스로틀) + ts 단독 인덱스(DELETE WHERE ts<? 풀스캔 방지).
 * node:sqlite 미지원 환경(구버전 Node)은 no-op 폴백 — 수집/화면은 살아있고 DB 만 비활성
 * (available() 로 UI 에 정직하게 표시).
 */

import path from 'node:path';
import { config } from '../config.js';

const FILE = () => path.join(config.configDir, 'storage-history.db');
const KEEP_MS = (Number(process.env.STORAGE_HISTORY_KEEP_DAYS) || 400) * 86400e3;
const MAX_JSON_BYTES = 512 * 1024; // 엔드포인트당 원문 상한 — 512KB 초과는 절단 표기(폭주 방지)

let _db = null;      // { conn, stmts } | 'unavailable'
let _pruneTick = 0;

async function open() {
  if (_db) return _db === 'unavailable' ? null : _db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const conn = new DatabaseSync(FILE());
    conn.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS api_latest (
        device_id TEXT NOT NULL, area TEXT NOT NULL, endpoint TEXT NOT NULL,
        ts INTEGER NOT NULL, ok INTEGER NOT NULL, bytes INTEGER NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0, json TEXT, error TEXT,
        PRIMARY KEY (device_id, endpoint)
      );
      CREATE TABLE IF NOT EXISTS api_history (
        device_id TEXT NOT NULL, area TEXT NOT NULL, ts INTEGER NOT NULL,
        ok INTEGER NOT NULL, bytes INTEGER NOT NULL, error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_apih_ts ON api_history (ts);
      CREATE TABLE IF NOT EXISTS capacity_history (
        device_id TEXT NOT NULL, ts INTEGER NOT NULL,
        total_bytes INTEGER, used_bytes INTEGER,
        hdd_total INTEGER, hdd_used INTEGER, ssd_total INTEGER, ssd_used INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_caph_ts ON capacity_history (ts);
      CREATE INDEX IF NOT EXISTS idx_caph_dev_ts ON capacity_history (device_id, ts);`);
    _db = {
      conn,
      upLatest: conn.prepare(`INSERT INTO api_latest (device_id, area, endpoint, ts, ok, bytes, truncated, json, error)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(device_id, endpoint) DO UPDATE SET area=excluded.area, ts=excluded.ts, ok=excluded.ok,
          bytes=excluded.bytes, truncated=excluded.truncated, json=excluded.json, error=excluded.error`),
      insHist: conn.prepare('INSERT INTO api_history (device_id, area, ts, ok, bytes, error) VALUES (?,?,?,?,?,?)'),
      insCap: conn.prepare('INSERT INTO capacity_history (device_id, ts, total_bytes, used_bytes, hdd_total, hdd_used, ssd_total, ssd_used) VALUES (?,?,?,?,?,?,?,?)'),
      selAreas: conn.prepare('SELECT area, endpoint, ts, ok, bytes, truncated, error FROM api_latest WHERE device_id = ? ORDER BY area, endpoint'),
      selOne: conn.prepare('SELECT json, ts, ok, truncated, error FROM api_latest WHERE device_id = ? AND endpoint = ?'),
      selCap: conn.prepare('SELECT ts, total_bytes, used_bytes, hdd_total, hdd_used, ssd_total, ssd_used FROM capacity_history WHERE device_id = ? AND ts >= ? ORDER BY ts LIMIT 5000'),
      prune1: conn.prepare('DELETE FROM api_history WHERE ts < ?'),
      prune2: conn.prepare('DELETE FROM capacity_history WHERE ts < ?'),
    };
    return _db;
  } catch (e) {
    console.warn(`[storage-db] SQLite 비활성(${e.message}) — API 원문/시계열 DB 저장 없이 동작(최신 스냅샷만)`);
    _db = 'unavailable';
    return null;
  }
}

export async function dbAvailable() { return !!(await open()); }

/** 영역 수집 결과 일괄 저장 — 트랜잭션으로 묶어 fsync 1회(CLAUDE.md 대량 write 규칙). */
export async function saveAreaResults(deviceId, results) {
  const db = await open();
  if (!db) return false;
  const ts = Date.now();
  db.conn.exec('BEGIN');
  try {
    for (const r of results) {
      let json = null, truncated = 0, bytes = 0;
      if (r.ok && r.data !== undefined) {
        json = JSON.stringify(r.data);
        bytes = Buffer.byteLength(json);
        if (bytes > MAX_JSON_BYTES) { json = json.slice(0, MAX_JSON_BYTES); truncated = 1; } // 절단 명시
      }
      db.upLatest.run(deviceId, r.area, r.endpoint, ts, r.ok ? 1 : 0, bytes, truncated, json, r.error || null);
      db.insHist.run(deviceId, r.area, ts, r.ok ? 1 : 0, bytes, r.error || null);
    }
    db.conn.exec('COMMIT');
  } catch (e) { db.conn.exec('ROLLBACK'); throw e; }
  // prune 스로틀 — 매 저장이 아니라 10회마다 1회(CLAUDE.md 시계열 prune 규칙).
  if (++_pruneTick % 10 === 0) { const cut = Date.now() - KEEP_MS; db.prune1.run(cut); db.prune2.run(cut); }
  return true;
}

/** 용량 시계열 1점 — 정규화 스냅샷에서(수집 성공분만: 실패 0 값이 그래프를 오염시키지 않게). */
export async function saveCapacityPoint(snap) {
  const db = await open();
  if (!db || !snap?.ok) return false;
  db.insCap.run(snap.deviceId, snap.collectedAt || Date.now(),
    snap.capacity?.totalBytes ?? null, snap.capacity?.usedBytes ?? null,
    snap.media?.hdd?.totalBytes ?? null, snap.media?.hdd?.usedBytes ?? null,
    snap.media?.ssd?.totalBytes ?? null, snap.media?.ssd?.usedBytes ?? null);
  return true;
}

export async function areaSummary(deviceId) {
  const db = await open();
  return db ? db.selAreas.all(deviceId) : [];
}
export async function areaJson(deviceId, endpoint) {
  const db = await open();
  return db ? (db.selOne.get(deviceId, endpoint) || null) : null;
}
export async function capacityHistory(deviceId, sinceMs) {
  const db = await open();
  return db ? db.selCap.all(deviceId, sinceMs) : [];
}
export function _resetForTest() { try { _db?.conn?.close?.(); } catch { /* */ } _db = null; _pruneTick = 0; }
