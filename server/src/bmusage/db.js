/**
 * bmusage/db.js — 베어메탈 사용률 DB(v2.550). 파일: `<dbDir>/bm-usage.db`
 *
 * 사용자 선택: **5분 주기 · 원시 90일 + 일 롤업 5년**.
 *
 * ── 왜 '지표마다 한 행' 이 아니라 '지표를 열로' 인가(실제 계산) ─────────────────
 * 베어메탈 200대 · 5분 주기(288회/일)를 가정하면
 *   · 지표마다 한 행:  200 × 9지표 × 288 = **51.8만 행/일** → 원시 90일 4,670만 행
 *   · 지표를 열로   :  200 × 288       = **5.76만 행/일** → 원시 90일 **518만 행**
 * 9배 차이다. 지표 종류는 고정(사용자가 지정한 5개 + 처리량·IO)이라 열로 두는 것이 맞다
 * (`metrics/db.js` 의 `(metric,k,h)` 구조는 **지표가 동적**이라 그쪽이 맞는 것이고, 여기는 다르다).
 *
 * ── 2단 보존(v2.531 스토리지 증가량과 같은 판단) ─────────────────────────────
 *   `usage_history` 원시(기본 90일) + `usage_daily` 일 롤업(기본 5년).
 *   ⚠ 일 롤업은 **평균과 최대를 같이** 보관한다 — 평균만 두면 피크가 사라지고(사용률의 핵심은
 *   피크다), 최대만 두면 평소 부하를 모른다. 평균은 `sum/n` 으로 되돌려 계산하므로 합·개수를 둔다.
 *   ⚠ **`null` 지표는 n 에 세지 않는다** — 세면 '못 읽은 주기' 가 평균을 0 쪽으로 끌어내린다.
 *
 * ── 하루 경계는 한국 시각(UTC+9) ────────────────────────────────────────────
 * UTC 로 자르면 한국 기준 오전 9시에 날이 바뀌어 '어제 평균' 이 사람이 세는 하루와 어긋난다
 * (v2.531 `DAY_OFFSET_MIN` 과 **같은 값·같은 이유**).
 *
 * node:sqlite 미지원 환경은 no-op 폴백 — 수집·화면은 살고 DB 만 비활성(`available()` 이 밝힌다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const FILE = () => path.join(config.dbDir || config.configDir, 'bm-usage.db');

export const DAY_OFFSET_MIN = Number(process.env.BMUSAGE_TZ_OFFSET_MIN) || 9 * 60;

/** `ts` → 한국 기준 `YYYY-MM-DD`(순수 — 테스트가 경계를 고정한다). */
export function dayKey(ts, offsetMin = DAY_OFFSET_MIN) {
  const d = new Date(Number(ts) + offsetMin * 60_000);
  return d.toISOString().slice(0, 10);
}

/** 우리가 적재하는 지표 열 — 이 목록이 계약이다(화면·롤업·테스트가 같이 쓴다). */
export const METRICS = Object.freeze([
  { col: 'cpu_pct', label: 'CPU', unit: '%', roll: 'avgmax' },
  { col: 'mem_pct', label: '메모리', unit: '%', roll: 'avgmax' },
  { col: 'disk_busy_pct', label: '디스크 busy', unit: '%', roll: 'max' },
  { col: 'disk_used_pct', label: '디스크 사용', unit: '%', roll: 'max' },
  { col: 'net_pct', label: '네트워크', unit: '%', roll: 'max' },
  { col: 'net_bps', label: '네트워크 처리량', unit: 'B/s', roll: 'max' },
  { col: 'hba_pct', label: 'HBA', unit: '%', roll: 'max' },
  { col: 'hba_bps', label: 'HBA 처리량', unit: 'B/s', roll: 'max' },
  { col: 'io_pct', label: 'I/O(iDRAC 집계)', unit: '%', roll: 'max' },
]);

let _db = null;
let _tried = false;
let _opening = null;   // 진행 중인 open 프라미스
let _tick = 0;

/**
 * ⚠⚠ **진행 중인 open 을 공유한다**(v2.550 실화면 검증에서 잡은 결함): 예전에는 `_tried = true` 를
 *   `await import('node:sqlite')` **앞에** 세워, 부팅 중 동시 호출이 들어오면 두 번째 호출이
 *   `_tried=true · _db=null` 을 보고 **`available:false`** 를 받았다. 그러면 화면이
 *   "이 서버의 Node 가 SQLite 를 지원하지 않습니다" 라는 **틀린 원인**을 말한다(v2.493 규약 위반 —
 *   실제로는 아직 열리는 중이었다). 새 DB 모듈에도 같은 패턴을 쓸 것.
 */
async function getDb() {
  if (_db) return _db;
  if (_opening) return _opening;
  if (_tried) return _db;          // 열기를 시도했고 실패한 것 — 매 호출 재시도하지 않는다
  _opening = openDb().finally(() => { _opening = null; });
  return _opening;
}

async function openDb() {
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    const { DatabaseSync } = await import('node:sqlite');
    const conn = new DatabaseSync(FILE());
    // ⚠ 새 DB 모듈은 **열자마자 0600**(v2.535 규약 — 워커까지 포함).
    try { fs.chmodSync(FILE(), 0o600); } catch { /* best effort */ }
    conn.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS usage_history (
        agent TEXT NOT NULL DEFAULT '', key TEXT NOT NULL, ts INTEGER NOT NULL,
        name TEXT, vcenter_id TEXT, src TEXT,
        cpu_pct REAL, mem_pct REAL, disk_busy_pct REAL, disk_used_pct REAL,
        net_pct REAL, net_bps REAL, hba_pct REAL, hba_bps REAL, io_pct REAL,
        PRIMARY KEY (agent, key, ts)
      );
      /* prune 은 'DELETE WHERE ts<?' 라 **ts 단독 인덱스**가 있어야 풀스캔을 피한다
         (복합 (agent,key,ts) 로는 못 탄다 — CLAUDE.md 규약). */
      CREATE INDEX IF NOT EXISTS idx_bmusage_ts ON usage_history(ts);
      CREATE TABLE IF NOT EXISTS usage_daily (
        agent TEXT NOT NULL DEFAULT '', key TEXT NOT NULL, day TEXT NOT NULL,
        name TEXT, vcenter_id TEXT,
        cpu_sum REAL DEFAULT 0, cpu_n INTEGER DEFAULT 0, cpu_max REAL,
        mem_sum REAL DEFAULT 0, mem_n INTEGER DEFAULT 0, mem_max REAL,
        disk_busy_max REAL, disk_used_max REAL, net_max REAL, net_bps_max REAL,
        hba_max REAL, hba_bps_max REAL, io_max REAL,
        samples INTEGER NOT NULL DEFAULT 0, last_ts INTEGER,
        PRIMARY KEY (agent, key, day)
      );
      CREATE INDEX IF NOT EXISTS idx_bmusage_daily_day ON usage_daily(day);`);
    _db = conn;
  } catch (e) {
    console.warn('[bmusage-db] 사용 불가(DB 없이 동작):', e?.message);
    _db = null;
  }
  _tried = true;                   // 성패가 확정된 뒤에 세운다
  return _db;
}

export async function available() { return !!(await getDb()); }
export async function dbStatus() {
  const db = await getDb();
  if (!db) return { available: false, path: FILE() };
  try {
    const raw = db.prepare('SELECT COUNT(*) c FROM usage_history').get()?.c ?? 0;
    const daily = db.prepare('SELECT COUNT(*) c FROM usage_daily').get()?.c ?? 0;
    const span = db.prepare('SELECT MIN(ts) a, MAX(ts) b FROM usage_history').get() || {};
    let bytes = null;
    try { bytes = fs.statSync(FILE()).size; } catch { /* 없으면 null */ }
    return { available: true, path: FILE(), rawRows: raw, dailyRows: daily, firstTs: span.a ?? null, lastTs: span.b ?? null, bytes };
  } catch (e) { return { available: true, path: FILE(), error: String(e?.message || e).slice(0, 200) }; }
}

const n = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const maxOf = (a, b) => {
  const x = n(a); const y = n(b);
  if (x == null) return y;
  if (y == null) return x;
  return Math.max(x, y);
};

/**
 * 한 주기의 행들을 적재하고 일 롤업을 갱신한다. **트랜잭션 1회**로 묶는다
 * (CLAUDE.md: 무트랜잭션 대량 write 가 과거 25초 블로킹을 만들었다).
 * @param {Array} rows  `[{ key, ts, name, vcenterId, src, cpu_pct, … }]`
 * @param {string} agent
 */
export async function insertUsage(rows = [], agent = '') {
  const db = await getDb();
  if (!db || !rows.length) return { ok: !!db, inserted: 0 };
  const ins = db.prepare(`INSERT OR REPLACE INTO usage_history
    (agent,key,ts,name,vcenter_id,src,cpu_pct,mem_pct,disk_busy_pct,disk_used_pct,net_pct,net_bps,hba_pct,hba_bps,io_pct)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const selDay = db.prepare('SELECT * FROM usage_daily WHERE agent=? AND key=? AND day=?');
  const upDay = db.prepare(`INSERT OR REPLACE INTO usage_daily
    (agent,key,day,name,vcenter_id,cpu_sum,cpu_n,cpu_max,mem_sum,mem_n,mem_max,
     disk_busy_max,disk_used_max,net_max,net_bps_max,hba_max,hba_bps_max,io_max,samples,last_ts)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let inserted = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const key = String(r.key || '').trim();
      const ts = Number(r.ts);
      if (!key || !Number.isFinite(ts)) continue;
      ins.run(agent, key, ts, String(r.name || ''), String(r.vcenterId || ''), String(r.src || ''),
        n(r.cpu_pct), n(r.mem_pct), n(r.disk_busy_pct), n(r.disk_used_pct),
        n(r.net_pct), n(r.net_bps), n(r.hba_pct), n(r.hba_bps), n(r.io_pct));
      inserted += 1;

      const day = dayKey(ts);
      const cur = selDay.get(agent, key, day) || {};
      const cpu = n(r.cpu_pct); const mem = n(r.mem_pct);
      upDay.run(
        agent, key, day, String(r.name || ''), String(r.vcenterId || ''),
        // ⚠ null 은 합·개수에 넣지 않는다 — 넣으면 '못 읽은 주기' 가 평균을 끌어내린다.
        (cur.cpu_sum ?? 0) + (cpu ?? 0), (cur.cpu_n ?? 0) + (cpu == null ? 0 : 1), maxOf(cur.cpu_max, cpu),
        (cur.mem_sum ?? 0) + (mem ?? 0), (cur.mem_n ?? 0) + (mem == null ? 0 : 1), maxOf(cur.mem_max, mem),
        maxOf(cur.disk_busy_max, r.disk_busy_pct), maxOf(cur.disk_used_max, r.disk_used_pct),
        maxOf(cur.net_max, r.net_pct), maxOf(cur.net_bps_max, r.net_bps),
        maxOf(cur.hba_max, r.hba_pct), maxOf(cur.hba_bps_max, r.hba_bps), maxOf(cur.io_max, r.io_pct),
        (cur.samples ?? 0) + 1, Math.max(Number(cur.last_ts) || 0, ts),
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* */ }
    return { ok: false, inserted: 0, error: String(e?.message || e).slice(0, 200) };
  }
  return { ok: true, inserted };
}

/**
 * 보존기간 집행. ⚠ **스로틀은 `(++tick % N) === 0`** — `% N === 1` 이나 `tick++` 는 기동 첫 틱에
 * 즉시 참이 되어, 보존기간을 줄이고 재시작하면 첫 틱이 차액을 한 번에 지운다(v2.453 규칙).
 */
export async function pruneUsage({ rawDays = 90, dailyDays = 365 * 5, every = 12, force = false } = {}) {
  const db = await getDb();
  if (!db) return { ok: false };
  if (!force && (++_tick % every) !== 0) return { ok: true, skipped: true };
  const rawCut = Date.now() - rawDays * 86_400_000;
  const dayCut = dayKey(Date.now() - dailyDays * 86_400_000);
  try {
    const a = db.prepare('DELETE FROM usage_history WHERE ts < ?').run(rawCut);
    const b = db.prepare('DELETE FROM usage_daily WHERE day < ?').run(dayCut);
    return { ok: true, rawDeleted: Number(a?.changes) || 0, dailyDeleted: Number(b?.changes) || 0 };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) }; }
}

/** 최신 1건씩(화면 표) — 서버별 마지막 관측. */
export async function latestUsage() {
  const db = await getDb();
  if (!db) return [];
  try {
    return db.prepare(`SELECT h.* FROM usage_history h
      JOIN (SELECT agent, key, MAX(ts) ts FROM usage_history GROUP BY agent, key) m
        ON m.agent=h.agent AND m.key=h.key AND m.ts=h.ts`).all();
  } catch { return []; }
}

/** 원시 추이(한 서버). 상한을 두고 **잘렸으면 밝힌다**(조용한 상한 금지). */
export async function usageHistory(key, { agent = '', hours = 24, limit = 3_000 } = {}) {
  const db = await getDb();
  if (!db) return { rows: [], truncated: false };
  const since = Date.now() - Math.max(1, Number(hours) || 24) * 3_600_000;
  try {
    const rows = db.prepare(`SELECT * FROM usage_history WHERE key=? AND agent=? AND ts>=?
      ORDER BY ts DESC LIMIT ?`).all(String(key), String(agent), since, limit + 1);
    const truncated = rows.length > limit;
    return { rows: rows.slice(0, limit).reverse(), truncated };
  } catch { return { rows: [], truncated: false }; }
}

/** 일 롤업(한 서버 또는 전체). 평균은 `sum/n` 으로 되돌린다 — **n 이 0 이면 `null`**(0 이 아니다). */
export async function usageDaily({ key = '', agent = '', days = 90 } = {}) {
  const db = await getDb();
  if (!db) return [];
  const from = dayKey(Date.now() - Math.max(1, Number(days) || 90) * 86_400_000);
  try {
    const sql = key
      ? 'SELECT * FROM usage_daily WHERE key=? AND agent=? AND day>=? ORDER BY day'
      : 'SELECT * FROM usage_daily WHERE day>=? ORDER BY day';
    const rows = key ? db.prepare(sql).all(String(key), String(agent), from) : db.prepare(sql).all(from);
    return rows.map((r) => ({
      ...r,
      cpu_avg: r.cpu_n > 0 ? Math.round((r.cpu_sum / r.cpu_n) * 10) / 10 : null,
      mem_avg: r.mem_n > 0 ? Math.round((r.mem_sum / r.mem_n) * 10) / 10 : null,
    }));
  } catch { return []; }
}

export function _resetForTest() { try { _db?.close?.(); } catch { /* */ } _db = null; _tried = false; _opening = null; _tick = 0; }
