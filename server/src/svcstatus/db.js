/**
 * svcstatus/db.js — 포탈 서비스 상태 모니터링 측정 저장소(v3.54). 파일: `svc-status.db`(dbDir 또는 configDir).
 *
 * 표 다섯(규모 — 150대상 · 60초 주기 기준 산수):
 *   · `sv_target` — (id, 주소, 포트) 한 벌 = 감시 단위(tid). 주소 · 포트가 바뀌면 **다른 단위**다(평소 · 이력이 옛 주소와 섞이지 않게).
 *   · `sv_sample` — 원시 표본(측정 1회 = 1행 · `RAW_DAYS` 일 보관 — 24시간 상세 + 7일 평소 중앙값을 덮는 최소). 150 × 1,440 × 8 ≈ 173만 행(행 약 50B).
 *   · `sv_bucket` — 30분 칸 롤업(n · 성공 · 연결 시간 합/개수/최대 · 칸 안 최악 표본 코드). 보관은 설정 `retentionDays`.
 *   · `sv_latest` — 대상별 최신 1행 + 판정(상태 · 언제부터 · 연속 실패) + 평소(base_ms) + 알린 상태 커서(notified).
 *     ⚠ '키별 최신값' 을 GROUP BY + MAX(ts) 로 만들지 말 것(perf-db.md — 최신 전용 표 · 적재 트랜잭션 안 upsert · ts 가 클 때만).
 *   · `sv_event` — 상태가 바뀐 때만(첫 판정 포함). 보관은 `retentionDays`.
 * 규약(perf-db.md): open 은 진행 중 시도 공유 · 잠금은 래치하지 않고 다시 · 적재는 **트랜잭션 하나** · 원시는 INSERT OR IGNORE + changes 0 이면 롤업을 건드리지 않음
 *   (엣지 재전송 이중 계수 금지) · 롤업은 ON CONFLICT DO UPDATE + NULL 안전 MAX · 실패 표본의 연결 시간은 0 이 아니라 NULL(평균 분모 ms_n 따로) ·
 *   prune 은 ts 단독 인덱스 + 청크 삭제 + 양보 · 집계 둘을 한 문장에 쓰지 않는다 · 평소(중앙값)는 응답 경로에서 계산하지 않는다(주기 틱이 저장).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { numOrNull } from '../util/numOrNull.js';
import { openSqlite, createLockRetry } from '../util/sqliteOpen.js';
import { chunkedDelete, createPruneFlight } from '../util/chunkedPrune.js';
import { judgeSample, median, SAMPLE, BASELINE_MIN_SAMPLES, BASELINE_DAYS, slowAtOf } from './judge.js';

const FILE = () => path.join(config.dbDir || config.configDir, 'svc-status.db');
/** 원시 표본 보관(일) — 24시간 상세 + 평소(최근 `BASELINE_DAYS` 일 중앙값)를 덮는다. 화면은 API 값으로 말한다. */
export const RAW_DAYS = BASELINE_DAYS + 1;
/** 띠 · 장기 추이 칸 폭. */
export const BUCKET_MS = 30 * 60_000;
/** 평소를 다시 계산하는 간격(대상마다). */
export const BASELINE_REFRESH_MS = 60 * 60_000;
const SAMPLE_READ_MAX = 20_000;
const n = numOrNull;

const lockRetry = createLockRetry();
let _db = null; let _tried = false; let _opening = null;
let _rev = 0;                 // 적재 · 평소 · 커서가 바뀔 때마다 — 화면 응답 캐시 열쇠
const _tidCache = new Map();  // `${id}\u0001${host}\u0001${port}` → tid

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
      CREATE TABLE IF NOT EXISTS sv_target (
        tid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, kind TEXT,
        first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL,
        UNIQUE (id, host, port)
      );
      CREATE INDEX IF NOT EXISTS idx_sv_target_last ON sv_target(last_ts);
      CREATE TABLE IF NOT EXISTS sv_sample (
        tid INTEGER NOT NULL, ts INTEGER NOT NULL,
        ok INTEGER NOT NULL, ms INTEGER, st INTEGER NOT NULL, fk TEXT,
        PRIMARY KEY (tid, ts)
      );
      /* prune 은 'ts < ?' 라 ts 단독 인덱스가 필요하다(복합 PK 로는 못 탄다). */
      CREATE INDEX IF NOT EXISTS idx_sv_sample_ts ON sv_sample(ts);
      CREATE TABLE IF NOT EXISTS sv_bucket (
        tid INTEGER NOT NULL, b INTEGER NOT NULL,
        n INTEGER NOT NULL DEFAULT 0, ok_n INTEGER NOT NULL DEFAULT 0,
        ms_sum INTEGER NOT NULL DEFAULT 0, ms_n INTEGER NOT NULL DEFAULT 0, ms_max INTEGER,
        worst INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tid, b)
      );
      CREATE INDEX IF NOT EXISTS idx_sv_bucket_b ON sv_bucket(b);
      CREATE TABLE IF NOT EXISTS sv_latest (
        tid INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL, ok INTEGER NOT NULL, ms INTEGER, fk TEXT,
        state TEXT NOT NULL, since_ts INTEGER NOT NULL, fail_streak INTEGER NOT NULL DEFAULT 0,
        by_node TEXT, last_ok_ts INTEGER, local_port INTEGER,
        base_ms REAL, base_n INTEGER, base_at INTEGER,
        notified TEXT, notified_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_sv_latest_ts ON sv_latest(ts);
      CREATE TABLE IF NOT EXISTS sv_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tid INTEGER NOT NULL, ts INTEGER NOT NULL,
        from_state TEXT, to_state TEXT NOT NULL, ms INTEGER, fk TEXT, by_node TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sv_event_ts ON sv_event(ts);
      CREATE INDEX IF NOT EXISTS idx_sv_event_tid ON sv_event(tid, ts);`);
    _db = conn;
  } catch (e) {
    try { conn?.close(); } catch { /* 이미 닫힘 */ }
    if (lockRetry.onFail(e)) { console.warn(`[svc-status-db] ${lockRetry.note()}`); return null; }
    console.warn('[svc-status-db] 사용 불가(DB 없이 동작):', String(e?.message || e).slice(0, 200));
    _db = null;
  }
  _tried = true;
  return _db;
}
export async function available() { return !!(await getDb()); }
/** 화면 응답 캐시 열쇠 조각 — 적재 · 평소 · 커서가 바뀌면 오른다. */
export function dataRev() { return _rev; }

function tidOf(db, r, ts) {
  const key = `${r.id}\u0001${r.host}\u0001${r.port}`;
  let tid = _tidCache.get(key);
  if (tid == null) {
    const row = db.prepare('SELECT tid FROM sv_target WHERE id=? AND host=? AND port=?').get(r.id, r.host, r.port);
    if (row) tid = Number(row.tid);
    else {
      const ins = db.prepare('INSERT INTO sv_target (id, host, port, kind, first_ts, last_ts) VALUES (?,?,?,?,?,?)').run(r.id, r.host, r.port, String(r.kind || ''), ts, ts);
      tid = Number(ins.lastInsertRowid);
    }
    _tidCache.set(key, tid);
  }
  return tid;
}

/**
 * 측정 결과 적재 — **트랜잭션 하나**(중앙 폴러 · 엣지 수신 두 자리에서만 부른다).
 * 행: `{ id, host, port, kind, ts, ok, ms, fk, by, localPort? }` — 같은 대상의 행은 시각 순으로 넣을 것(판정이 그 순서를 따른다).
 * @returns {Promise<{ok:boolean, stored:number, dup:number, events:number, dbUnavailable?:boolean}>}
 */
export async function recordResults(rows, { settings = {} } = {}) {
  const db = await getDb();
  if (!db) return { ok: false, stored: 0, dup: 0, events: 0, dbUnavailable: true };
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.id && r.host && Number.isInteger(r.port) && n(r.ts) != null);
  if (!list.length) return { ok: true, stored: 0, dup: 0, events: 0 };
  const q = {
    latest: db.prepare('SELECT * FROM sv_latest WHERE tid=?'),
    touch: db.prepare('UPDATE sv_target SET last_ts = MAX(last_ts, ?) WHERE tid=?'),
    sample: db.prepare('INSERT OR IGNORE INTO sv_sample (tid, ts, ok, ms, st, fk) VALUES (?,?,?,?,?,?)'),
    bucket: db.prepare(`INSERT INTO sv_bucket (tid, b, n, ok_n, ms_sum, ms_n, ms_max, worst) VALUES (?,?,1,?,?,?,?,?)
      ON CONFLICT(tid, b) DO UPDATE SET n = n + 1, ok_n = ok_n + excluded.ok_n, ms_sum = ms_sum + excluded.ms_sum, ms_n = ms_n + excluded.ms_n,
        ms_max = NULLIF(MAX(IFNULL(ms_max, -1), IFNULL(excluded.ms_max, -1)), -1), worst = MAX(worst, excluded.worst)`),
    upLatest: db.prepare(`INSERT INTO sv_latest (tid, ts, ok, ms, fk, state, since_ts, fail_streak, by_node, last_ok_ts, local_port)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tid) DO UPDATE SET ts = excluded.ts, ok = excluded.ok, ms = excluded.ms, fk = excluded.fk, state = excluded.state,
        since_ts = excluded.since_ts, fail_streak = excluded.fail_streak, by_node = excluded.by_node,
        last_ok_ts = COALESCE(excluded.last_ok_ts, sv_latest.last_ok_ts), local_port = excluded.local_port
      WHERE excluded.ts >= sv_latest.ts`),
    event: db.prepare('INSERT INTO sv_event (tid, ts, from_state, to_state, ms, fk, by_node) VALUES (?,?,?,?,?,?,?)'),
  };
  let stored = 0; let dup = 0; let events = 0;
  db.exec('BEGIN');
  try {
    for (const r of list) {
      const ts = Math.round(n(r.ts));
      const ok = r.ok === true;
      const ms = ok ? n(r.ms) : null;
      const msInt = ms == null ? null : Math.max(0, Math.round(ms));
      const fk = ok ? null : String(r.fk || 'unknown').slice(0, 24);
      const tid = tidOf(db, r, ts);
      q.touch.run(ts, tid);
      const prev = q.latest.get(tid) || null;
      const prevState = prev ? String(prev.state) : null;
      const baseMs = prev ? n(prev.base_ms) : null;
      let st; let next = null;
      if (prev && ts <= n(prev.ts)) {
        // 늦게 온(또는 같은 시각) 행 — 표본 · 칸만. 판정 · 최신값은 이미 더 새 측정이 정했다.
        st = ok ? (slowAtOf(baseMs, settings) != null && msInt > slowAtOf(baseMs, settings) ? SAMPLE.slow : SAMPLE.ok) : SAMPLE.fail;
      } else {
        next = judgeSample(prev ? { state: prevState, failStreak: n(prev.fail_streak) } : null, { ok, ms: msInt }, settings, baseMs);
        st = next.st;
      }
      const ins = q.sample.run(tid, ts, ok ? 1 : 0, msInt, st, fk);
      if (!(Number(ins?.changes) > 0)) { dup += 1; continue; }   // 재전송 — 롤업 · 판정을 두 번 세지 않는다
      stored += 1;
      const b = Math.floor(ts / BUCKET_MS) * BUCKET_MS;
      q.bucket.run(tid, b, ok ? 1 : 0, msInt ?? 0, msInt == null ? 0 : 1, msInt, st);
      if (!next) continue;
      const changed = next.state !== prevState;
      const since = changed ? ts : (n(prev?.since_ts) ?? ts);
      q.upLatest.run(tid, ts, ok ? 1 : 0, msInt, fk, next.state, since, next.failStreak, String(r.by || '').slice(0, 128),
        ok ? ts : null, Number.isInteger(r.localPort) ? r.localPort : null);
      // 이벤트는 '판정이 바뀐 때' 만 — 판정 중(pending)은 이벤트가 아니다. 판정 중에서 처음 판정된 것은 첫 판정(from null).
      if (changed && next.state !== 'pending') {
        const from = prevState === 'ok' || prevState === 'slow' || prevState === 'down' ? prevState : null;
        q.event.run(tid, ts, from, next.state, msInt, fk, String(r.by || '').slice(0, 128));
        events += 1;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 이미 끝남 */ }
    _tidCache.clear();   // 되돌린 INSERT 의 tid 를 기억하지 않게
    throw e;
  }
  if (stored) _rev += 1;
  return { ok: true, stored, dup, events };
}

/** 대상별 최신 행 전부(최신 전용 표 — GROUP BY 로 되돌리지 말 것). */
export async function latestRows() {
  const db = await getDb();
  if (!db) return null;
  return db.prepare(`SELECT t.tid, t.id, t.host, t.port, t.kind, t.first_ts, l.ts, l.ok, l.ms, l.fk, l.state, l.since_ts, l.fail_streak, l.by_node,
      l.last_ok_ts, l.local_port, l.base_ms, l.base_n, l.base_at, l.notified, l.notified_at
    FROM sv_target t JOIN sv_latest l ON l.tid = t.tid`).all();
}
/** (id, 주소, 포트) 행 → tid 를 모르면 null(측정한 적 없음). */
export async function tidFor(id, host, port) {
  const db = await getDb();
  if (!db) return null;
  const r = db.prepare('SELECT tid FROM sv_target WHERE id=? AND host=? AND port=?').get(String(id), String(host), Number(port));
  return r ? Number(r.tid) : null;
}
/** 전 대상의 칸(b ≥ since) — 24시간 띠 · 성공률. `b` 인덱스 한 번(실측 7,350행 7.7ms — 조사 6 §5.3). */
export async function bucketsSince(sinceB) {
  const db = await getDb();
  if (!db) return null;
  return db.prepare('SELECT tid, b, n, ok_n, ms_sum, ms_n, ms_max, worst FROM sv_bucket WHERE b >= ?').all(Math.floor(sinceB));
}
export async function bucketsRange(tid, since, until) {
  const db = await getDb();
  if (!db) return null;
  return db.prepare('SELECT b, n, ok_n, ms_sum, ms_n, ms_max, worst FROM sv_bucket WHERE tid=? AND b >= ? AND b < ? ORDER BY b').all(tid, since, until);
}
export async function samplesRange(tid, since, until) {
  const db = await getDb();
  if (!db) return null;
  const rows = db.prepare('SELECT ts, ok, ms, st FROM sv_sample WHERE tid=? AND ts >= ? AND ts < ? ORDER BY ts LIMIT ?').all(tid, since, until, SAMPLE_READ_MAX + 1);
  const truncated = rows.length > SAMPLE_READ_MAX;
  return { rows: truncated ? rows.slice(0, SAMPLE_READ_MAX) : rows, truncated };
}
/** 같은 대상 id 의 사건(주소가 바뀐 이전 단위 포함) — 최신 → 오래된. */
export async function eventsForId(id, limit = 50) {
  const db = await getDb();
  if (!db) return null;
  return db.prepare(`SELECT e.ts, e.from_state, e.to_state, e.ms, e.fk, e.by_node, t.host, t.port FROM sv_event e JOIN sv_target t ON t.tid = e.tid
    WHERE t.id = ? ORDER BY e.ts DESC LIMIT ?`).all(String(id), Math.max(1, Math.min(500, Math.round(limit))));
}
/** 같은 대상 id 의 감시 단위(주소 · 포트 변경 이력) — 처음 본 시각 순. */
export async function unitsForId(id) {
  const db = await getDb();
  if (!db) return null;
  return db.prepare('SELECT tid, host, port, first_ts, last_ts FROM sv_target WHERE id = ? ORDER BY first_ts').all(String(id));
}

/** 알린 상태 커서를 옮긴다(발송 성공 · 기준점 · 조용한 정상화). */
export async function setNotified(pairs, at = Date.now()) {
  const db = await getDb();
  if (!db) return { ok: false };
  const st = db.prepare('UPDATE sv_latest SET notified = ?, notified_at = ? WHERE tid = ?');
  db.exec('BEGIN');
  try { for (const [tid, level] of pairs) st.run(level == null ? null : String(level), at, tid); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; }
  if (pairs.length) _rev += 1;
  return { ok: true };
}

/**
 * 평소(최근 `BASELINE_DAYS` 일 성공 표본 중앙값)를 다시 계산해 최신 표에 저장한다 — 대상 사이 양보.
 * 대상당 한 문장이 원시 약 1만 행 범위 읽기 + JS 정렬(실측 대상당 최장 19.7ms — 조사 6 §5.3 ①). 응답 경로가 아니라 주기 틱에서만 부른다.
 * @param {{now?:number, yieldFn?:Function, force?:boolean}} o
 */
export async function refreshBaselines({ now = Date.now(), yieldFn = () => new Promise((r) => setImmediate(r)), force = false } = {}) {
  const db = await getDb();
  if (!db) return { ok: false, updated: 0 };
  const due = db.prepare('SELECT tid, base_at FROM sv_latest WHERE ts >= ?').all(now - RAW_DAYS * 86_400_000)
    .filter((r) => force || n(r.base_at) == null || now - n(r.base_at) >= BASELINE_REFRESH_MS);
  const read = db.prepare('SELECT ms FROM sv_sample WHERE tid = ? AND ts >= ? AND ok = 1 AND ms IS NOT NULL');
  const up = db.prepare('UPDATE sv_latest SET base_ms = ?, base_n = ?, base_at = ? WHERE tid = ?');
  const since = now - BASELINE_DAYS * 86_400_000;
  let updated = 0;
  for (const r of due) {
    const vals = read.all(r.tid, since).map((x) => x.ms);
    const enough = vals.length >= BASELINE_MIN_SAMPLES;
    const m = enough ? median(vals) : null;
    up.run(m == null ? null : Math.round(m * 10) / 10, vals.length, now, r.tid);
    updated += 1;
    await yieldFn();
  }
  if (updated) _rev += 1;
  return { ok: true, updated };
}

const _pruneFlight = createPruneFlight();
/** 보존 집행 — 원시는 `RAW_DAYS`, 칸 · 사건 · 오래 안 본 단위는 `retentionDays`. 청크 삭제 + 양보. */
export async function pruneSvcStatus({ retentionDays = 90, now = Date.now() } = {}) {
  const db = await getDb();
  if (!db) return { ok: false };
  const keepMs = Math.max(RAW_DAYS, Math.round(retentionDays)) * 86_400_000;
  return _pruneFlight.run(String(retentionDays), async () => {
    const st = {
      sample: db.prepare('DELETE FROM sv_sample WHERE rowid IN (SELECT rowid FROM sv_sample WHERE ts < ? LIMIT ?)'),
      bucket: db.prepare('DELETE FROM sv_bucket WHERE rowid IN (SELECT rowid FROM sv_bucket WHERE b < ? LIMIT ?)'),
      event: db.prepare('DELETE FROM sv_event WHERE rowid IN (SELECT rowid FROM sv_event WHERE ts < ? LIMIT ?)'),
    };
    const a = await chunkedDelete(st.sample, [now - RAW_DAYS * 86_400_000], { label: 'svcstatus.sv_sample' });
    const b = await chunkedDelete(st.bucket, [now - keepMs], { label: 'svcstatus.sv_bucket' });
    const c = await chunkedDelete(st.event, [now - keepMs], { label: 'svcstatus.sv_event' });
    // 보관 기간 동안 한 번도 측정하지 않은 단위(등록부에서 지웠거나 주소를 바꾼 옛 단위)는 최신 행과 함께 지운다.
    let units = 0;
    try {
      const old = db.prepare('SELECT tid FROM sv_target WHERE last_ts < ?').all(now - keepMs).map((r) => r.tid);
      const dl = db.prepare('DELETE FROM sv_latest WHERE tid = ?');
      const dt = db.prepare('DELETE FROM sv_target WHERE tid = ?');
      for (const tid of old) { dl.run(tid); dt.run(tid); units += 1; }
      if (units) _tidCache.clear();
    } catch { /* 진단성 정리 — 실패해도 보존 집행은 계속 */ }
    if (a.deleted || b.deleted || c.deleted || units) _rev += 1;
    return { ok: true, sample: a.deleted, bucket: b.deleted, event: c.deleted, units, done: a.done && b.done && c.done };
  }).catch((e) => ({ ok: false, error: String(e?.message || e).slice(0, 200) }));
}

/** 진단 — 집계는 한 문장에 하나씩(perf-db.md). */
export async function svcStatusDbStatus() {
  const db = await getDb();
  if (!db) return { ok: false, file: path.basename(FILE()) };
  const one = (sql) => { try { return db.prepare(sql).get()?.v ?? null; } catch { return null; } };
  return {
    ok: true, file: path.basename(FILE()),
    units: one('SELECT COUNT(*) AS v FROM sv_target'),
    oldestSample: one('SELECT MIN(ts) AS v FROM sv_sample'),
    newestSample: one('SELECT MAX(ts) AS v FROM sv_sample'),
  };
}

export async function _resetSvcStatusDbForTest() {
  try { _db?.close(); } catch { /* */ }
  _db = null; _tried = false; _opening = null; _rev = 0; _tidCache.clear(); lockRetry.ok();
}
