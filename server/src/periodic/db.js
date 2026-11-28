/**
 * periodic/db.js — 정기 점검 보고 보관 DB. 파일: `<dbDir>/periodic.db`(설계 §4.4).
 *
 *  · `pr_runs` — 회차 한 줄: 요약 열(주기 · 기간 · 종합 · 판정별 수 · 법인 수) + `matrix`(법인 × 항목 판정 부호 — 범위 계정 목록을 문서 없이 다시 센다)
 *    + `doc`(회차 문서 JSON — 항목 · 법인 행 · 근거). 회차 문서는 수십~수백 KB 라 목록은 doc 을 읽지 않는다.
 *  · `pr_deliveries` — 전달 기록(메일 · 채널 · 공지 · 이슈) — 실패는 재시도 시각(next_at)을 두고 틱이 다시 보낸다(생성과 분리).
 *  · 인덱스: 생성 시각 단독 · (주기, 생성 시각) — 정리는 주기별 보관 일수로(perf-db '시계열 prune 은 ts 인덱스 + 청크').
 * 규약: 회차 적재는 한 트랜잭션 · 파일 0600 · open 은 진행 중인 시도를 공유하고 잠금이면 래치하지 않는다(util/sqliteOpen.js) · 정리는 청크(util/chunkedPrune.js).
 * DB 를 못 열면 null 을 돌려준다(빈 목록과 구분 — 라우트가 503).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { openSqlite, createLockRetry } from '../util/sqliteOpen.js';
import { chunkedDelete, createPruneFlight } from '../util/chunkedPrune.js';
import { KINDS } from './rules.js';

const FILE = () => path.join(config.dbDir || config.configDir, 'periodic.db');
/**
 * v3.59 백업 적재(3절 — backupLedger.js · backupStore.js). 날은 포탈 시각의 dayIndex(util/dayKey.js) — 정리는 날 단독 인덱스 + 청크.
 *  · pr_bk_obs    끝난 실행 관측(백업 · VM · 끝난 시각이 키 — 같은 실행을 두 번 넣지 않는다) — RAW_KEEP_DAYS 보관
 *  · pr_bk_seen   법인 · 백업 · 날의 관측 범위(신선한 관측 첫 · 마지막 데이터 시각 · 그날에 걸친 가장 긴 틈 · 그날 걸친 틈이 잃은 것이 있는가(lossy) · 그날 대상 목록) — RAW_KEEP_DAYS
 *  · pr_bk_cursor 법인 · 백업의 마지막 데이터 시각 · 적재 시작 날 · 확정한 마지막 날 · 마지막으로 본 시각 · 결과 출처(복제 — 바뀌면 그 틈은 잃은 틈)
 *  · pr_bk_day    날의 확정 결과(법인 · 백업 한 줄 — 확인 불가면 수 칸은 NULL) — 설정 보관 일수
 *  · pr_bk_vmday  그날 마지막 결과가 실패인 VM(목록 · 되풀이 실패) — 설정 보관 일수
 *  pr_bk_day · pr_bk_vmday 는 기본 키가 day 로 시작해 정리 · 기간 조회가 그 키를 탄다(따로 날 인덱스를 두지 않는다 — 성능 축 P8 EXPLAIN 확인).
 */
const BACKUP_SCHEMA = `CREATE TABLE IF NOT EXISTS pr_bk_obs (
    product TEXT NOT NULL, vm TEXT NOT NULL, ended_at INTEGER NOT NULL, vc TEXT NOT NULL, day INTEGER NOT NULL, state TEXT NOT NULL,
    started_at INTEGER, name TEXT, reason TEXT, reason_pub TEXT, run_id TEXT, seen_at INTEGER NOT NULL, PRIMARY KEY (product, vm, ended_at)
  );
  CREATE INDEX IF NOT EXISTS pr_bk_obs_day ON pr_bk_obs(day);
  CREATE INDEX IF NOT EXISTS pr_bk_obs_pvd ON pr_bk_obs(product, vc, day);
  CREATE TABLE IF NOT EXISTS pr_bk_seen (
    product TEXT NOT NULL, vc TEXT NOT NULL, day INTEGER NOT NULL, first_at INTEGER, last_at INTEGER, max_gap INTEGER NOT NULL DEFAULT 0, lossy INTEGER NOT NULL DEFAULT 0,
    n_fresh INTEGER NOT NULL DEFAULT 0, n_stale INTEGER NOT NULL DEFAULT 0, targets TEXT, PRIMARY KEY (product, vc, day)
  );
  CREATE INDEX IF NOT EXISTS pr_bk_seen_day ON pr_bk_seen(day);
  CREATE TABLE IF NOT EXISTS pr_bk_cursor (
    product TEXT NOT NULL, vc TEXT NOT NULL, last_at INTEGER, first_day INTEGER, sealed_to INTEGER, active_at INTEGER, src TEXT, PRIMARY KEY (product, vc)
  );
  CREATE TABLE IF NOT EXISTS pr_bk_day (
    day INTEGER NOT NULL, product TEXT NOT NULL, vc TEXT NOT NULL, status TEXT NOT NULL, targets INTEGER, ended INTEGER, ok INTEGER, warn INTEGER,
    fail INTEGER, norun INTEGER, sealed_at INTEGER NOT NULL, late INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, product, vc)
  );
  CREATE TABLE IF NOT EXISTS pr_bk_vmday (
    day INTEGER NOT NULL, product TEXT NOT NULL, vm TEXT NOT NULL, vc TEXT NOT NULL, state TEXT NOT NULL, name TEXT, ended_at INTEGER,
    reason TEXT, reason_pub TEXT, PRIMARY KEY (day, product, vm)
  );
`;
const lockRetry = createLockRetry();
const DAY = 86_400_000;

let _db = null; let _tried = false; let _opening = null; let _err = '';

export function periodicDbFile() { return FILE(); }
export function periodicDbError() { return _db ? '' : (lockRetry.note() || _err); }

export async function getPeriodicDb() {
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
    try { fs.chmodSync(FILE(), 0o600); } catch { /* best effort — openSqlite 가 이미 걸었다 */ }
    conn.exec(`CREATE TABLE IF NOT EXISTS pr_runs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, slot INTEGER, period_from INTEGER, period_to INTEGER, generated_at INTEGER NOT NULL,
        by_user TEXT, manual INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, overall TEXT,
        n_ok INTEGER, n_warn INTEGER, n_crit INTEGER, n_unknown INTEGER, n_info INTEGER,
        corps_total INTEGER, corps_reported INTEGER, duration_ms INTEGER, error TEXT, matrix TEXT, doc TEXT
      );
      CREATE INDEX IF NOT EXISTS pr_runs_gen ON pr_runs(generated_at);
      CREATE INDEX IF NOT EXISTS pr_runs_kind_gen ON pr_runs(kind, generated_at);
      CREATE TABLE IF NOT EXISTS pr_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, kind TEXT NOT NULL, channel TEXT NOT NULL, target TEXT,
        state TEXT NOT NULL, at INTEGER NOT NULL, reason TEXT, attempt INTEGER NOT NULL DEFAULT 1, next_at INTEGER, recipients INTEGER
      );
      CREATE INDEX IF NOT EXISTS pr_deliv_run ON pr_deliveries(run_id);
      CREATE INDEX IF NOT EXISTS pr_deliv_next ON pr_deliveries(state, next_at);
      CREATE INDEX IF NOT EXISTS pr_deliv_kind_at ON pr_deliveries(kind, at);`);
    conn.exec(BACKUP_SCHEMA);
    lockRetry.ok();
    _db = conn; _err = '';
  } catch (e) {
    try { conn?.close(); } catch { /* 이미 닫힘 */ }
    if (lockRetry.onFail(e)) { console.warn(`[periodic-db] ${lockRetry.note()}`); return null; }
    _err = String(e?.message || e).slice(0, 200);
    console.warn('[periodic-db] 사용 불가(정기 점검 보고를 보관하지 못합니다):', _err);
    _db = null;
  }
  _tried = true;
  return _db;
}

const RUN_COLS = 'id, kind, slot, period_from, period_to, generated_at, by_user, manual, status, overall, n_ok, n_warn, n_crit, n_unknown, n_info, corps_total, corps_reported, duration_ms, error';
let _stmts = null; let _stmtsFor = null;
function stmts(db) {
  if (_stmtsFor === db && _stmts) return _stmts;
  _stmts = {
    putRun: db.prepare(`INSERT INTO pr_runs(${RUN_COLS}, matrix, doc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, slot = excluded.slot, period_from = excluded.period_from, period_to = excluded.period_to,
        generated_at = excluded.generated_at, by_user = excluded.by_user, manual = excluded.manual, status = excluded.status, overall = excluded.overall,
        n_ok = excluded.n_ok, n_warn = excluded.n_warn, n_crit = excluded.n_crit, n_unknown = excluded.n_unknown, n_info = excluded.n_info,
        corps_total = excluded.corps_total, corps_reported = excluded.corps_reported, duration_ms = excluded.duration_ms, error = excluded.error,
        matrix = excluded.matrix, doc = excluded.doc`),
    getRun: db.prepare(`SELECT ${RUN_COLS}, matrix, doc FROM pr_runs WHERE id = ?`),
    hasRun: db.prepare('SELECT 1 AS x FROM pr_runs WHERE id = ?'),
    listAll: db.prepare(`SELECT ${RUN_COLS}, matrix FROM pr_runs WHERE generated_at >= ? AND generated_at < ? ORDER BY generated_at DESC LIMIT ? OFFSET ?`),
    listKind: db.prepare(`SELECT ${RUN_COLS}, matrix FROM pr_runs WHERE kind = ? AND generated_at >= ? AND generated_at < ? ORDER BY generated_at DESC LIMIT ? OFFSET ?`),
    countAll: db.prepare('SELECT COUNT(*) AS n FROM pr_runs WHERE generated_at >= ? AND generated_at < ?'),
    countKind: db.prepare('SELECT COUNT(*) AS n FROM pr_runs WHERE kind = ? AND generated_at >= ? AND generated_at < ?'),
    prevRun: db.prepare(`SELECT ${RUN_COLS}, matrix, doc FROM pr_runs WHERE kind = ? AND manual = 0 AND status = 'done' AND period_from < ? ORDER BY period_from DESC LIMIT 1`),
    lastOfKind: db.prepare(`SELECT ${RUN_COLS} FROM pr_runs WHERE kind = ? ORDER BY generated_at DESC LIMIT 1`),
    addDeliv: db.prepare('INSERT INTO pr_deliveries(run_id, kind, channel, target, state, at, reason, attempt, next_at, recipients) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    updDeliv: db.prepare('UPDATE pr_deliveries SET state = ?, at = ?, reason = ?, attempt = ?, next_at = ?, recipients = ? WHERE id = ?'),
    delivOfRun: db.prepare('SELECT id, run_id, kind, channel, target, state, at, reason, attempt, next_at, recipients FROM pr_deliveries WHERE run_id = ? ORDER BY id'),
    delivDue: db.prepare("SELECT id, run_id, kind, channel, target, state, at, reason, attempt, next_at, recipients FROM pr_deliveries WHERE state = 'retry' AND next_at <= ? ORDER BY next_at LIMIT ?"),
    delivRetryCount: db.prepare("SELECT COUNT(*) AS n FROM pr_deliveries WHERE state = 'retry'"),
    pruneRuns: db.prepare('DELETE FROM pr_runs WHERE rowid IN (SELECT rowid FROM pr_runs WHERE kind = ? AND generated_at < ? LIMIT ?)'),
    pruneDeliv: db.prepare('DELETE FROM pr_deliveries WHERE rowid IN (SELECT rowid FROM pr_deliveries WHERE kind = ? AND at < ? LIMIT ?)'),
    countRuns: db.prepare('SELECT COUNT(*) AS n FROM pr_runs'),
  };
  _stmtsFor = db;
  return _stmts;
}

const jsonOr = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const rowOf = (r) => (r ? {
  id: r.id, kind: r.kind, slot: r.slot, periodFrom: r.period_from, periodTo: r.period_to, generatedAt: r.generated_at, by: r.by_user, manual: !!r.manual,
  status: r.status, overall: r.overall, counts: { ok: r.n_ok ?? 0, warn: r.n_warn ?? 0, crit: r.n_crit ?? 0, unknown: r.n_unknown ?? 0, info: r.n_info ?? 0 },
  corpsTotal: r.corps_total, corpsReported: r.corps_reported, durationMs: r.duration_ms, error: r.error || null,
  ...(r.matrix != null ? { matrix: jsonOr(r.matrix, null) } : {}),
} : null);

/**
 * 회차 하나를 한 트랜잭션으로 넣는다(같은 ID 면 덮어쓴다 — 실패한 회차를 다시 만들 때).
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function putRun(run, matrix) {
  const db = await getPeriodicDb();
  if (!db) return { ok: false, reason: periodicDbError() || 'db-unavailable' };
  const st = stmts(db);
  const c = run.counts || {};
  db.exec('BEGIN IMMEDIATE');
  try {
    st.putRun.run(run.id, run.kind, run.slot ?? null, run.periodFrom ?? null, run.periodTo ?? null, run.generatedAt, run.by ?? null, run.manual ? 1 : 0,
      run.status, run.overall ?? null, c.ok ?? 0, c.warn ?? 0, c.crit ?? 0, c.unknown ?? 0, c.info ?? 0, run.corpsTotal ?? null, run.corpsReported ?? null,
      run.durationMs ?? null, run.error ?? null, matrix ? JSON.stringify(matrix) : null, run.status === 'done' ? JSON.stringify(run) : null);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 이미 끝남 */ }
    return { ok: false, reason: String(e?.message || e).slice(0, 200) };
  }
  return { ok: true };
}

/** 회차 하나(문서 포함). 없으면 { run: null } · DB 를 못 열면 null. */
export async function getRun(id) {
  const db = await getPeriodicDb();
  if (!db) return null;
  const r = stmts(db).getRun.get(String(id));
  if (!r) return { run: null };
  return { run: { ...rowOf(r), doc: jsonOr(r.doc, null) } };
}
export async function hasRun(id) {
  const db = await getPeriodicDb();
  if (!db) return null;
  return !!stmts(db).hasRun.get(String(id));
}
/** 같은 주기의 직전 예약 회차(완료) — 지난 회차 대비. */
export async function previousRun(kind, periodFrom) {
  const db = await getPeriodicDb();
  if (!db) return null;
  const r = stmts(db).prevRun.get(String(kind), Number(periodFrom));
  return r ? { ...rowOf(r), doc: jsonOr(r.doc, null) } : null;
}
export async function lastRunOfKind(kind) {
  const db = await getPeriodicDb();
  if (!db) return null;
  return rowOf(stmts(db).lastOfKind.get(String(kind)));
}

/** 목록(문서 없이 · 행렬 포함). DB 를 못 열면 null. */
export async function listRuns({ kind = '', from = 0, to = Date.now() + DAY, limit = 50, offset = 0 } = {}) {
  const db = await getPeriodicDb();
  if (!db) return null;
  const st = stmts(db);
  const lim = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)));
  const off = Math.max(0, Math.floor(Number(offset) || 0));
  const k = KINDS.includes(kind) ? kind : '';
  const rows = k ? st.listKind.all(k, from, to, lim, off) : st.listAll.all(from, to, lim, off);
  const total = (k ? st.countKind.get(k, from, to) : st.countAll.get(from, to))?.n ?? 0;
  return { runs: rows.map(rowOf), total };
}

/* ── 전달 기록 ── */
export async function addDelivery(d) {
  const db = await getPeriodicDb();
  if (!db) return null;
  const r = stmts(db).addDeliv.run(d.runId, d.kind, d.channel, d.target ?? null, d.state, d.at ?? Date.now(), d.reason ?? null, d.attempt ?? 1, d.nextAt ?? null, d.recipients ?? null);
  return Number(r.lastInsertRowid);
}
export async function updateDelivery(id, d) {
  const db = await getPeriodicDb();
  if (!db) return false;
  stmts(db).updDeliv.run(d.state, d.at ?? Date.now(), d.reason ?? null, d.attempt ?? 1, d.nextAt ?? null, d.recipients ?? null, Number(id));
  return true;
}
const delivOf = (r) => ({ id: r.id, runId: r.run_id, kind: r.kind, channel: r.channel, target: r.target, state: r.state, at: r.at, reason: r.reason, attempt: r.attempt, nextAt: r.next_at, recipients: r.recipients });
export async function deliveriesOfRun(runId) {
  const db = await getPeriodicDb();
  if (!db) return null;
  return stmts(db).delivOfRun.all(String(runId)).map(delivOf);
}
export async function dueDeliveries(now = Date.now(), limit = 20) {
  const db = await getPeriodicDb();
  if (!db) return [];
  return stmts(db).delivDue.all(now, limit).map(delivOf);
}
export async function retryCount() {
  const db = await getPeriodicDb();
  if (!db) return null;
  return stmts(db).delivRetryCount.get()?.n ?? 0;
}

const _pruneFlight = createPruneFlight();
/** 주기별 보관 일수 밖의 회차 · 전달 기록을 청크로 지운다. */
export async function prunePeriodic(retainDays, now = Date.now()) {
  const db = await getPeriodicDb();
  if (!db) return { deleted: 0 };
  return _pruneFlight.run('all', async () => {
    const st = stmts(db);
    let deleted = 0;
    for (const k of KINDS) {
      const days = Number(retainDays?.[k]);
      if (!Number.isFinite(days) || days <= 0) continue;
      const cut = now - days * DAY;
      deleted += Number((await chunkedDelete(st.pruneRuns, [k, cut], { label: `periodic.runs.${k}` }))?.deleted) || 0;
      await chunkedDelete(st.pruneDeliv, [k, cut], { label: `periodic.deliveries.${k}` });
    }
    return { deleted };
  });
}

/** 화면 '지금 상태' — 파일 크기 · 회차 수. */
export async function periodicDbInfo() {
  const db = await getPeriodicDb();
  let size = null;
  try { size = fs.statSync(FILE()).size; } catch { size = null; }
  if (!db) return { ok: false, size, runs: null, error: periodicDbError() || 'db-unavailable' };
  let runs = null;
  try { runs = stmts(db).countRuns.get()?.n ?? 0; } catch { runs = null; }
  return { ok: true, size, runs, error: '' };
}

export function _resetPeriodicDbForTest() { try { _db?.close(); } catch { /* 이미 닫힘 */ } _db = null; _tried = false; _opening = null; _err = ''; _stmts = null; _stmtsFor = null; }
