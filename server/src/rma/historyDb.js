/**
 * RMA 실행 이력 DB(v2.417) — `<dbDir|configDir>/rma-history.db`, node:sqlite.
 * 예전(v2.416)에는 인메모리 링(300건)이라 재시작 시 소실됐다 — 감사로그에는 '누가 무엇을' 만 남고
 * 출력은 없었다. 성능 규약(CLAUDE.md): WAL + synchronous=NORMAL + busy_timeout, prune 은 N회마다 1회 +
 * ts 단독 인덱스, node:sqlite 미지원 환경은 no-op(호출자가 메모리 링으로 폴백).
 */
import path from 'node:path';
import { config } from '../config.js';

const FILE = () => path.join(config.dbDir || config.configDir, 'rma-history.db');
const RETENTION_DAYS = Math.max(1, Number(process.env.RMA_HISTORY_DAYS) || 90);
const PRUNE_EVERY = 20;
const OUTPUT_MAX = 64 * 1024; // 행당 stdout/stderr 저장 상한(64KB × 수천 행 ≈ 수백 MB 상한선)
let _db = null;
let _tick = 0;

async function open() {
  if (_db) return _db === 'unavailable' ? null : _db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const conn = new DatabaseSync(FILE());
    conn.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS rma_history (
        req_id TEXT PRIMARY KEY, agent TEXT NOT NULL, instance TEXT, cmd TEXT, args TEXT, label TEXT, user TEXT,
        created_at INTEGER, taken_at INTEGER, done_at INTEGER NOT NULL,
        ok INTEGER, exit_code INTEGER, timed_out INTEGER, duration_ms INTEGER, reason TEXT,
        stdout TEXT, stderr TEXT, truncated INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_rma_done ON rma_history (done_at);
      CREATE INDEX IF NOT EXISTS idx_rma_agent_done ON rma_history (agent, done_at);`);
    _db = {
      conn,
      ins: conn.prepare(`INSERT OR REPLACE INTO rma_history (req_id, agent, instance, cmd, args, label, user, created_at, taken_at, done_at, ok, exit_code, timed_out, duration_ms, reason, stdout, stderr, truncated)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      byAgent: conn.prepare('SELECT * FROM rma_history WHERE agent = ? COLLATE NOCASE ORDER BY done_at DESC LIMIT ?'),
      all: conn.prepare('SELECT * FROM rma_history ORDER BY done_at DESC LIMIT ?'),
      prune: conn.prepare('DELETE FROM rma_history WHERE done_at < ?'),
    };
    return _db;
  } catch (e) {
    console.warn(`[rma] 이력 DB 비활성(node:sqlite 없음 또는 열기 실패: ${e.message}) — 메모리 링으로 대체`);
    _db = 'unavailable';
    return null;
  }
}

export async function historyAvailable() { return !!(await open()); }

/** 이력 1행 저장. 실패는 조용히 false(폴러 경로를 막지 않는다). */
export async function saveHistoryRow(h) {
  const db = await open();
  if (!db) return false;
  try {
    db.ins.run(h.reqId, h.agent, h.instance || '', h.cmd || '', JSON.stringify(h.args || {}), h.label || '', h.user || '',
      h.createdAt || null, h.takenAt || null, h.doneAt || Date.now(), h.ok ? 1 : 0, h.exitCode ?? null, h.timedOut ? 1 : 0,
      h.durationMs ?? null, h.reason || '', String(h.stdout || '').slice(0, OUTPUT_MAX), String(h.stderr || '').slice(0, OUTPUT_MAX),
      (h.truncated || String(h.stdout || '').length > OUTPUT_MAX) ? 1 : 0);
    if (++_tick % PRUNE_EVERY === 0) db.prune.run(Date.now() - RETENTION_DAYS * 86400e3);
    return true;
  } catch { return false; }
}

const rowOut = (r) => ({
  reqId: r.req_id, agent: r.agent, instance: r.instance || '', cmd: r.cmd, args: (() => { try { return JSON.parse(r.args || '{}'); } catch { return {}; } })(),
  label: r.label || '', user: r.user || '', createdAt: r.created_at, takenAt: r.taken_at, doneAt: r.done_at,
  ok: !!r.ok, exitCode: r.exit_code, timedOut: !!r.timed_out, durationMs: r.duration_ms, reason: r.reason || '',
  stdout: r.stdout || '', stderr: r.stderr || '', truncated: !!r.truncated,
});

/** 이력 조회 — DB 가 없으면 null(호출자가 메모리 링 사용). */
export async function listHistoryRows({ agent = '', limit = 100 } = {}) {
  const db = await open();
  if (!db) return null;
  const n = Math.max(1, Math.min(1000, limit));
  const rows = agent ? db.byAgent.all(String(agent), n) : db.all.all(n);
  return rows.map(rowOut);
}

export function _resetHistoryDb() { try { _db?.conn?.close?.(); } catch { /* */ } _db = null; _tick = 0; }
