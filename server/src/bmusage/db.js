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
import { numOrNull } from '../util/numOrNull.js';

const FILE = () => path.join(config.dbDir || config.configDir, 'bm-usage.db');

// 날짜 경계 코어는 `util/dayKey.js` 하나다(v2.582 ARCH-2 — 세 벌이던 것을 합쳤다). 여기서는 재수출만.
// ⚠ `export { x } from` 은 이 모듈 스코프에 이름을 만들지 않는다(v2.575 실제 사고) — import 뒤 export.
import { DAY_OFFSET_MIN, dayKey } from "../util/dayKey.js";
import { openSqlite, createLockRetry } from '../util/sqliteOpen.js';
import { chunkedDelete } from '../util/chunkedPrune.js';
import { PERF_COL_NAMES, PEAK_SQL_COLS, PEAK_META_COLS } from './perfCols.js';
import * as month from './monthStore.js'; // v2.922: 5분 원시·롤업·장치별 이력은 시간 단위 파일(이 파일은 최신값·장치 목록·마이그레이션 상태)
const lockRetry = createLockRetry();
export { DAY_OFFSET_MIN, dayKey };

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
let _counts = null;    // { raw, daily, at } — dbStatus 의 COUNT(*) 캐시(아래 주석 참조)
const COUNT_CACHE_MS = Math.max(0, Number(process.env.BMUSAGE_COUNT_CACHE_MS) || 60_000);

/**
 * ⚠⚠ **진행 중인 open 을 공유한다**(v2.550 실화면 검증에서 잡은 결함): 예전에는 `_tried = true` 를
 *   `await import('node:sqlite')` **앞에** 세워, 부팅 중 동시 호출이 들어오면 두 번째 호출이
 *   `_tried=true · _db=null` 을 보고 **`available:false`** 를 받았다. 그러면 화면이
 *   "이 서버의 Node 가 SQLite 를 지원하지 않습니다" 라는 **틀린 원인**을 말한다(v2.493 규약 위반 —
 *   실제로는 아직 열리는 중이었다). 새 DB 모듈에도 같은 패턴을 쓸 것.
 */
async function getDb() {
  if (_db) return _db;
  if (lockRetry.blocked()) return null;   // 잠금 뒤 재시도 대기(매 호출 3초 busy_timeout 을 태우지 않게)
  if (_opening) return _opening;
  if (_tried) return _db;          // 열기를 시도했고 실패한 것 — 매 호출 재시도하지 않는다
  _opening = openDb().finally(() => { _opening = null; });
  return _opening;
}

async function openDb() {
  let conn = null;   // v2.599 DB2599-02: 실패하면 닫는다(잠금이면 래치하지 않고 다시 연다)
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    const { DatabaseSync } = await import('node:sqlite');
    conn = openSqlite(new DatabaseSync(FILE()));   // busy_timeout 먼저 · 잠금이면 닫고 던진다
    // ⚠ 새 DB 모듈은 **열자마자 0600**(v2.535 규약 — 워커까지 포함).
    try { fs.chmodSync(FILE(), 0o600); } catch { /* best effort */ }
    conn.exec(`CREATE TABLE IF NOT EXISTS usage_history (
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
      CREATE INDEX IF NOT EXISTS idx_bmusage_daily_day ON usage_daily(day);
      /* 최신값 전용 테이블(v2.550.3) — 근거는 latestUsage() 의 JSDoc 에 적었다.
         SQL 주석에는 백틱을 쓰지 않는다(이 문자열 자체가 템플릿 리터럴이다). */
      CREATE TABLE IF NOT EXISTS usage_latest (
        agent TEXT NOT NULL DEFAULT '', key TEXT NOT NULL, ts INTEGER NOT NULL,
        name TEXT, vcenter_id TEXT, src TEXT,
        cpu_pct REAL, mem_pct REAL, disk_busy_pct REAL, disk_used_pct REAL,
        net_pct REAL, net_bps REAL, hba_pct REAL, hba_bps REAL, io_pct REAL,
        PRIMARY KEY (agent, key)
      );
      /* v2.922: 장치 목록(종류별 · 처음 본 순서 ord 가 색 고정 순서다 — 필터로 색이 바뀌지 않게) · 마이그레이션 상태(키·JSON). */
      CREATE TABLE IF NOT EXISTS usage_devices (
        agent TEXT NOT NULL DEFAULT '', key TEXT NOT NULL, kind TEXT NOT NULL, dev TEXT NOT NULL,
        ord INTEGER NOT NULL, first_ts INTEGER, last_ts INTEGER, info TEXT,
        PRIMARY KEY (agent, key, kind, dev)
      );
      CREATE TABLE IF NOT EXISTS bm_meta (k TEXT PRIMARY KEY, v TEXT, at INTEGER);`);
    // v2.919(리눅스 성능 1단계): 새 열은 CREATE 문이 아니라 **ALTER 마이그레이션**으로 더한다 — 기존 DB(v2.918 이하)와 새 DB 가
    //   같은 경로를 탄다(두 벌 스키마가 갈라지지 않게). ADD COLUMN 은 표를 다시 쓰지 않는다(O(1)).
    const mig = migratePerfColumns(conn);
    _perfCols = mig.have;
    _migrateError = mig.failed.length ? { at: Date.now(), count: mig.failed.length, reasons: mig.failed.slice(0, 8) } : null;
    // 기존 DB 마이그레이션 — 비어 있을 때만 1회(실측 747ms. 기동 1회이고 이후는 upsert 가 유지한다).
    try {
      const has = conn.prepare('SELECT COUNT(*) c FROM usage_latest').get()?.c ?? 0;
      if (!has) {
        const any = conn.prepare('SELECT 1 FROM usage_history LIMIT 1').get();
        if (any) {
          conn.exec('BEGIN');
          conn.prepare(`INSERT OR REPLACE INTO usage_latest
            (agent,key,ts,name,vcenter_id,src,cpu_pct,mem_pct,disk_busy_pct,disk_used_pct,net_pct,net_bps,hba_pct,hba_bps,io_pct)
            SELECT h.agent,h.key,h.ts,h.name,h.vcenter_id,h.src,h.cpu_pct,h.mem_pct,h.disk_busy_pct,h.disk_used_pct,
                   h.net_pct,h.net_bps,h.hba_pct,h.hba_bps,h.io_pct
              FROM usage_history h
              JOIN (SELECT agent,key,MAX(ts) ts FROM usage_history GROUP BY agent,key) m
                ON m.agent=h.agent AND m.key=h.key AND m.ts=h.ts`).run();
          conn.exec('COMMIT');
        }
      }
    } catch (e) {
      try { conn.exec('ROLLBACK'); } catch { /* */ }
      console.warn('[bmusage-db] usage_latest 시드 실패(다음 수집부터 채워집니다):', e?.message);
    }
    // v2.922: 시간 단위 파일 마이그레이션 상태를 **여는 순간** 정한다 — 읽기 규칙(readRule)이 첫 조회부터 예전 표를 원본으로 보게.
    //   (상태가 없으면 'none' 으로 읽혀 예전 표의 90일이 화면에서 사라진다.) 예전 표에 행이 있으면 copy-raw 로 시작한다.
    try { initMigrationState(conn); } catch (e) { console.warn('[bmusage-db] 마이그레이션 상태 초기화 실패(예전 표를 계속 씁니다):', e?.message); }
    _db = conn;
  } catch (e) {
    try { conn?.close(); } catch { /* 이미 닫힘 */ }
    if (lockRetry.onFail(e)) { console.warn(`[bmusage-db] ${lockRetry.note()}`); return null; }
    console.warn('[bmusage-db] 사용 불가(DB 없이 동작):', e?.message);
    _db = null;
  }
  _tried = true;                   // 성패가 확정된 뒤에 세운다
  return _db;
}

/**
 * v2.919 — 표마다 없는 열만 ALTER TABLE ADD COLUMN(멱등). 이력: 새 지표 열(REAL) · 일 롤업: `<열>_max`(REAL — 포화·오류는 피크가 뜻이다) ·
 *   최신값: 새 지표 열 + 두 경로 읽은 시각(INTEGER) + 장치별·튜닝 현재값 JSON(TEXT — 이력 적재는 3단계).
 * ⚠ 한 열이 실패해도 나머지는 계속한다(실패는 콘솔 1줄 — 그 열은 적재에서 빠지지 않고 insert 가 실패를 돌려준다).
 * @returns {{added:number}} 이번에 더한 열 수(테스트가 기존 DB 호환을 확인한다)
 */
export const PERF_TABLE_COLS = Object.freeze({
  usage_history: PERF_COL_NAMES.map((c) => [c, 'REAL']),
  usage_daily: PERF_COL_NAMES.map((c) => [`${c}_max`, 'REAL']),
  usage_latest: [...PERF_COL_NAMES.map((c) => [c, 'REAL']), ['os_at', 'INTEGER'], ['idrac_at', 'INTEGER'], ['detail_json', 'TEXT'], ['tuning_json', 'TEXT'],
    // v2.922: 피크(<열>_peak · _peak_at) · 피크 출처·창 · 장치 상한 초과 수 — 최신값에도 둔다(보드가 이 파일만 읽는다).
    ...PEAK_SQL_COLS, ...PEAK_META_COLS, ['dev_over', 'INTEGER']],
});
/** v2.922 — 최신값 전용 추가 열(지표 열 뒤에 붙는다). os_at·idrac_at 만 ‘그 경로의 마지막 성공’ 이라 COALESCE 로 지킨다. */
export const LATEST_EXTRA_COLS = Object.freeze(['os_at', 'idrac_at', 'detail_json', 'tuning_json', ...PEAK_SQL_COLS.map(([c]) => c), ...PEAK_META_COLS.map(([c]) => c), 'dev_over']);
const TEXT_EXTRA = new Set(['detail_json', 'tuning_json', 'peak_src']);
export function migratePerfColumns(conn) {
  let added = 0; const failed = []; const have = {};
  for (const [table, cols] of Object.entries(PERF_TABLE_COLS)) {
    let set;
    try { set = new Set(conn.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name)); }
    catch (e) { failed.push(`${table}: 열 목록을 읽지 못함 — ${String(e?.message || e).slice(0, 120)}`); continue; }
    for (const [col, type] of cols) {
      if (set.has(col)) continue;
      try { conn.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); set.add(col); added += 1; }
      catch (e) {
        const msg = String(e?.message || e);
        // 다른 open 이 먼저 더했으면(duplicate column) 무해 — 있는 것으로 센다.
        if (/duplicate column/i.test(msg)) { set.add(col); continue; }
        failed.push(`${table}.${col}: ${msg.slice(0, 120)}`);
      }
    }
    have[table] = set;
  }
  if (added) console.log(`[bmusage-db] 리눅스 성능 열 ${added}개를 더했습니다(v2.919 마이그레이션 — 기존 행은 null).`);
  // v2.919(반증 D6): 무음 실패 금지 — 콘솔에 오류로 남기고 반환값(→ _migrateError → dbStatus·insertUsage 결과 → 폴러 _last)으로 올린다.
  if (failed.length) console.error(`[bmusage-db] 리눅스 성능 열 ${failed.length}개를 더하지 못했습니다 — 그 열은 적재에서 빠지고 기존 지표는 계속 적재합니다: ${failed.slice(0, 3).join(' · ')}`);
  return { added, failed, have };
}
/** v2.919(D6): 마지막 마이그레이션 결과 — 표별 실제 열 · 실패 사유(없으면 null). */
let _perfCols = null;
let _migrateError = null;
export function perfMigrateError() { return _migrateError; }
/** 테스트 전용 — ALTER 가 일부 실패한 상태를 재현한다(표별 실제 열 · 실패 사유). */
export function _setPerfColsForTest(have, err = null) { _perfCols = have; _migrateError = err; }

export async function available() { return !!(await getDb()); }
export async function dbStatus() {
  const db = await getDb();
  if (!db) return { available: false, path: FILE() };
  try {
    /*
     * ⚠ 행 수는 **짧게 캐시한다**(v2.550.3 실측): `COUNT(*)` 는 커버링 인덱스를 타지만 518만 행에서
     *   **27ms** 이고 이 함수는 화면 로드마다 돈다. 이 값은 진단·참고용("현재 원시 N행")이라 초
     *   단위로 정확할 이유가 없다. **캐시라는 사실은 숨기지 않는다** — `countsAt` 을 함께 싣는다.
     * v2.922: 5분 원시·롤업은 시간 단위 파일(monthStore)이다 — 행 수는 예전 표(마이그레이션 전 잔여) + 파일 합이다.
     */
    let raw = _counts?.raw; let daily = _counts?.daily;
    if (!_counts || Date.now() - _counts.at > COUNT_CACHE_MS) {
      raw = db.prepare('SELECT COUNT(*) c FROM usage_history').get()?.c ?? 0;
      daily = db.prepare('SELECT COUNT(*) c FROM usage_daily').get()?.c ?? 0;
      _counts = { raw, daily, at: Date.now() };
    }
    /*
     * ⚠⚠ **`MIN(ts)` 과 `MAX(ts)` 를 한 쿼리에 쓰지 말 것**(v2.550.3 실측): SQLite 는 aggregate 가
     *   **하나뿐일 때만** 인덱스 양끝 조회로 최적화한다. 둘을 같이 쓰면 인덱스를 통째로 훑어
     *   518만 행에서 **400ms** 였다(나누면 **0.01ms** — 4만 배). 이 함수는 화면 로드마다 돈다.
     *   `metrics/db.js` 의 `metaKey`(v2.504)가 기록한 것과 같은 계열의 함정이다.
     */
    const span = {
      a: db.prepare('SELECT MIN(ts) v FROM usage_history').get()?.v ?? null,
      b: db.prepare('SELECT MAX(ts) v FROM usage_history').get()?.v ?? null,
    };
    let bytes = null;
    try { bytes = fs.statSync(FILE()).size; } catch { /* 없으면 null */ }
    const files = await month.monthStoreStatus().catch((e) => ({ error: String(e?.message || e).slice(0, 200) }));
    const mig = readMeta(db, MIGRATE_KEY);
    const rawRows = Number(raw) + Number(files?.raw?.rows || 0);
    const dailyRows = Number(daily) + Number(files?.d1?.rows || 0);
    return {
      available: true, path: FILE(), rawRows, dailyRows, countsAt: _counts?.at ?? null, firstTs: span.a ?? null, lastTs: span.b ?? null, bytes,
      // v2.922: 시간 단위 파일(가족별 파일 수·행 수·바이트) · 예전 표 잔여 행 · 마이그레이션 상태
      legacyRows: { raw: Number(raw), daily: Number(daily) }, files, migration: mig ? migrationView(mig) : null,
      ...(_migrateError ? { migrateError: _migrateError } : {}),
    };
  } catch (e) { return { available: true, path: FILE(), error: String(e?.message || e).slice(0, 200) }; }
}

const n = numOrNull;   // v2.561: 공용 판정

/** JSON 열 값 — 문자열만(객체는 직렬화하지 않고 버린다: usage.js jsonCol 이 상한을 이미 적용한다). */
const jsonText = (v) => (typeof v === 'string' && v ? v : null);

/* ════════════════════════ v2.922 메인 파일 메타(마이그레이션 상태) ════════════════════════ */
export const MIGRATE_KEY = 'migrate.v2922';
export function readMeta(db, k) {
  try { const r = db.prepare('SELECT v FROM bm_meta WHERE k=?').get(k); return r?.v ? JSON.parse(r.v) : null; } catch { return null; }
}
export function writeMeta(db, k, v) {
  db.prepare('INSERT INTO bm_meta (k,v,at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, at=excluded.at').run(k, JSON.stringify(v), Date.now());
}
/** 마이그레이션 상태의 응답용 요약(커서 등 내부 값은 줄인다). */
export function migrationView(m) {
  if (!m) return null;
  return { phase: m.phase, startedAt: m.startedAt ?? null, updatedAt: m.updatedAt ?? null, doneAt: m.doneAt ?? null, attempts: m.attempts ?? 0, failedAt: m.failedAt ?? null,
    legacyMaxTs: m.legacyMaxTs ?? null, copied: m.copied || null, verify: m.verify || null, deleted: m.deleted || null, error: m.error || null, failedPhase: m.failedPhase || null };
}
/**
 * 마이그레이션 상태가 없을 때 1회 — 예전 표에 행이 있으면 경계(최대 ts · 최대 rowid)를 고정하고 copy-raw 로 시작한다.
 *   집계는 문장마다 하나(MAX 단독 — 인덱스 양끝 조회). 새 코드는 예전 표에 쓰지 않으므로 경계는 이후 바뀌지 않는다.
 */
export function initMigrationState(conn, now = Date.now()) {
  if (readMeta(conn, MIGRATE_KEY)) return;
  const anyRaw = conn.prepare('SELECT 1 FROM usage_history LIMIT 1').get();
  const anyDaily = conn.prepare('SELECT 1 FROM usage_daily LIMIT 1').get();
  if (!anyRaw && !anyDaily) { writeMeta(conn, MIGRATE_KEY, { v: 1, phase: 'none', at: now }); return; }
  writeMeta(conn, MIGRATE_KEY, {
    v: 1, phase: 'copy-raw', startedAt: now, updatedAt: now, attempts: 0,
    legacyMaxTs: n(conn.prepare('SELECT MAX(ts) v FROM usage_history').get()?.v),
    legacyMinTs: n(conn.prepare('SELECT MIN(ts) v FROM usage_history').get()?.v),
    rawMaxRowid: Number(conn.prepare('SELECT MAX(rowid) v FROM usage_history').get()?.v || 0),
    dailyMaxRowid: Number(conn.prepare('SELECT MAX(rowid) v FROM usage_daily').get()?.v || 0),
    rawCursor: 0, dailyCursor: 0,
    copied: { raw: 0, rawDup: 0, rawOld: 0, hourly: 0, daily: 0, dailyDup: 0 },
  });
}
/**
 * v2.922(반증 D5): 롤업 보정 — 원시는 들어갔는데 1시간·1일 롤업이 실패한(또는 두 커밋 사이에 끊긴) 버킷을 원시에서 다시 집계한다(monthStore.repairPending).
 *   1일 재집계는 마이그레이션이 옮긴 예전 원시(ts ≤ legacyMaxTs)를 세지 않는다 — 그 날들은 1일 사본 표가 갖는다.
 */
export async function repairRollups({ rawKeepFrom = null } = {}) {
  const db = await getDb();
  if (!db) return { ok: false, reason: 'db-unavailable' };
  const m = readMeta(db, MIGRATE_KEY);
  const r = await month.repairPending({ dailyLiveAfter: m && m.phase !== 'none' ? n(m.legacyMaxTs) : null, rawKeepFrom });
  return { ok: !r.errors.length, ...r };
}
/** 메인 파일 핸들(마이그레이션 모듈 전용 — 같은 연결을 쓴다: 두 연결이 같은 파일에 쓰면 SQLITE_BUSY). */
export async function mainDbForMigration() { return getDb(); }
/**
 * 읽기 규칙(마이그레이션 진행 중) — **예전 표를 읽는 것은 폴백이 아니라 정상 경로다**:
 *   옮기는 중·대조 전·실패한 동안에는 예전 표가 그 구간의 원본이고(아직 아무것도 지우지 않았다) 월 파일의 사본은 대조 전이라 쓰지 않는다.
 *   ⚠ historyRollup 의 ‘원본 폴백 금지’ 는 **롤업 대신 원시를 읽는 것**을 금지하는 규약이라 이것과 다르다 — 여기서는 해상도를 바꾸지 않는다
 *   (1시간 롤업이 아직 안 만들어진 구간은 원시로 메우지 않고 ‘마이그레이션 중’ 결측으로 밝힌다 — trendWindow).
 * @returns {{legacyRaw:boolean, legacyDaily:boolean, legacyMaxTs:number|null, hourlyPending:boolean, phase:string}}
 */
export function readRule(m) {
  const phase = m?.phase || 'none';
  const legacyAuth = ['copy-raw', 'copy-daily', 'verify', 'failed'].includes(phase);
  return {
    phase,
    legacyRaw: legacyAuth,
    legacyDaily: legacyAuth,
    legacyMaxTs: n(m?.legacyMaxTs),
    hourlyPending: phase === 'copy-raw' || (phase === 'failed' && (m?.failedPhase === 'copy-raw' || !m?.rawCopied)),
  };
}
export async function migrationReadRule() {
  const db = await getDb();
  return readRule(db ? readMeta(db, MIGRATE_KEY) : null);
}

/**
 * 한 주기의 행들을 적재한다(v2.922): 5분 원시·1시간·1일 롤업은 **시간 단위 파일**(monthStore — 원시가 새로 들어간 행만 롤업),
 * 최신값·장치 목록은 이 메인 파일. 장치별 행(devices)·마운트(mounts)는 있으면 함께.
 * @param {Array} rows  `[{ key, ts, name, vcenterId, src, cpu_pct, … , <열>_peak, peak_src … }]`
 * @param {string} agent
 * @param {{devices?:Array, mounts?:Array}} [extra]
 */
export async function insertUsage(rows = [], agent = '', { devices = [], mounts = [] } = {}) {
  const db = await getDb();
  if (!db || !rows.length) return { ok: !!db, inserted: 0 };
  // v2.919(반증 D6): 열 목록은 **실제로 있는 열만** — ALTER 가 일부 실패한 DB 에서도 기존 다섯 지표 적재가 통째로 실패하지 않게 한다.
  const has = (table, col) => !_perfCols || !_perfCols[table] || _perfCols[table].has(col);
  const LC = PERF_COL_NAMES.filter((c) => has('usage_latest', c));
  const LX = LATEST_EXTRA_COLS.filter((c) => has('usage_latest', c));
  // ① 5분 원시 → 1시간 → 1일(시간 단위 파일). INSERT OR IGNORE + 새로 들어간 행만 롤업(이중 계수 금지 — monthStore).
  const valid = rows.filter((r) => String(r?.key || '').trim() && Number.isFinite(Number(r?.ts)));
  const w = await month.writeServerRows(valid, agent).catch((e) => ({ ok: false, inserted: 0, duplicates: 0, errors: [String(e?.message || e).slice(0, 200)] }));
  /* 최신값 테이블 — ⚠ **`ts` 가 더 클 때만** 갱신한다(엣지 push 는 순서대로 오지 않는다 — v2.531 규약). */
  /*
   * v2.919: 최신값에는 새 지표 열 + 두 경로 읽은 시각 + 장치별·튜닝 JSON 도 둔다. 읽은 시각은 **그 경로를 마지막으로 읽은 시각**이라
   *   이번 주기에 그 경로가 실패했으면(null) 직전 값을 지키고(COALESCE), 지표·JSON·피크는 이번 표본 그대로다(최신값 = 마지막 표본).
   */
  const LSET = LC.map((c) => `, ${c}=excluded.${c}`).join('');
  const LCOLS = [...LC, ...LX].map((c) => `,${c}`).join('');
  const LQ = ',?'.repeat(LC.length + LX.length);
  const LXSET = LX.map((c) => (c === 'os_at' || c === 'idrac_at' ? `, ${c}=COALESCE(excluded.${c}, usage_latest.${c})` : `, ${c}=excluded.${c}`)).join('');
  const upLatest = db.prepare(`INSERT INTO usage_latest
    (agent,key,ts,name,vcenter_id,src,cpu_pct,mem_pct,disk_busy_pct,disk_used_pct,net_pct,net_bps,hba_pct,hba_bps,io_pct${LCOLS})
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?${LQ})
    ON CONFLICT(agent,key) DO UPDATE SET
      ts=excluded.ts, name=excluded.name, vcenter_id=excluded.vcenter_id, src=excluded.src,
      cpu_pct=excluded.cpu_pct, mem_pct=excluded.mem_pct,
      disk_busy_pct=excluded.disk_busy_pct, disk_used_pct=excluded.disk_used_pct,
      net_pct=excluded.net_pct, net_bps=excluded.net_bps,
      hba_pct=excluded.hba_pct, hba_bps=excluded.hba_bps, io_pct=excluded.io_pct${LSET}${LXSET}
      WHERE excluded.ts > usage_latest.ts`);
  const insertedSet = new Set((w.insertedRows || []).map((r) => r));
  db.exec('BEGIN');
  try {
    for (const r of valid) {
      // 원시가 이미 있던 행(같은 ts 재전송)은 최신값도 건드리지 않는다(예전과 같은 동작 — 원시 IGNORE 면 롤업·최신값 모두 그대로).
      if (w.ok !== false && !insertedSet.has(r) && w.insertedRows) continue;
      const key = String(r.key).trim(); const ts = Number(r.ts);
      const vals = [n(r.cpu_pct), n(r.mem_pct), n(r.disk_busy_pct), n(r.disk_used_pct), n(r.net_pct), n(r.net_bps), n(r.hba_pct), n(r.hba_bps), n(r.io_pct)];
      const lx = (c) => (c === 'detail_json' || c === 'tuning_json' ? jsonText(r[c]) : TEXT_EXTRA.has(c) ? (r[c] ? String(r[c]).slice(0, 16) : null) : n(r[c]));
      upLatest.run(agent, key, ts, String(r.name || ''), String(r.vcenterId || ''), String(r.src || ''), ...vals, ...LC.map((c) => n(r[c])), ...LX.map(lx));
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* */ }
    return { ok: false, inserted: 0, error: String(e?.message || e).slice(0, 200) };
  }
  // ② 장치별(5분 → 1시간) · 마운트(일 롤업) · 장치 목록(메인 — 처음 본 순서가 색 순서).
  let dev = null; let mnt = null;
  if (devices.length) {
    dev = await month.writeDeviceRows(devices, agent).catch((e) => ({ ok: false, errors: [String(e?.message || e).slice(0, 200)] }));
    upsertDeviceList(db, agent, devices);
  }
  if (mounts.length) {
    mnt = await month.writeMountRows(mounts, agent).catch((e) => ({ ok: false, errors: [String(e?.message || e).slice(0, 200)] }));
    upsertDeviceList(db, agent, mounts.map((m) => ({ ...m, kind: 'mount', dev: m.mount })));
  }
  if (w.inserted) { _counts = null; month.invalidateMonthCounts(); }
  const errors = [...(w.errors || []), ...(dev?.errors || []), ...(mnt?.errors || [])];
  return {
    ok: w.ok !== false, inserted: w.inserted || 0, duplicates: w.duplicates || 0,
    ...(devices.length ? { devicesInserted: dev?.inserted ?? 0 } : {}),
    ...(errors.length ? { error: errors.slice(0, 3).join(' · ').slice(0, 300) } : {}),
    ...(_migrateError ? { migrateError: _migrateError } : {}),
  };
}

/**
 * 장치 목록(메인 파일) — 처음 보면 종류 안 순번(ord)을 받는다. ord 는 **바뀌지 않는다**(장치 색이 필터·추가로 바뀌지 않게 — 설계 §12).
 *   ord 는 `MAX(ord)+1`(집계 하나 · PK 선행열로 좁힌다). 이미 있으면 last_ts 만 올린다.
 */
function upsertDeviceList(db, agent, list) {
  try {
    const nextOrd = db.prepare('SELECT IFNULL(MAX(ord),0)+1 AS o FROM usage_devices WHERE agent=? AND key=? AND kind=?');
    const ins = db.prepare(`INSERT INTO usage_devices (agent,key,kind,dev,ord,first_ts,last_ts,info) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(agent,key,kind,dev) DO UPDATE SET last_ts=MAX(IFNULL(last_ts,0),excluded.last_ts), info=COALESCE(excluded.info, info)`);
    const seen = db.prepare('SELECT 1 FROM usage_devices WHERE agent=? AND key=? AND kind=? AND dev=?');
    db.exec('BEGIN');
    try {
      for (const d of list) {
        const key = String(d.key || '').trim(); const kind = String(d.kind || ''); const dv = String(d.dev || '').slice(0, 256);
        if (!key || !kind || !dv) continue;
        const ord = seen.get(agent, key, kind, dv) ? 0 : Number(nextOrd.get(agent, key, kind)?.o || 1);
        ins.run(agent, key, kind, dv, ord, Number(d.ts) || null, Number(d.ts) || null, d.info ? String(d.info).slice(0, 512) : null);
      }
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; }
  } catch (e) { console.warn('[bmusage-db] 장치 목록 갱신 실패:', String(e?.message || e).slice(0, 160)); }
}
/** 장치 목록(한 서버) — 종류별, 처음 본 순서(ord). 색 고정용 안정 순서. */
export async function deviceList(key, { agent = '' } = {}) {
  const db = await getDb();
  if (!db) return [];
  try {
    return db.prepare('SELECT kind, dev, ord, first_ts, last_ts, info FROM usage_devices WHERE agent=? AND key=? ORDER BY kind, ord').all(String(agent), String(key));
  } catch { return []; }
}

/**
 * 보존기간 집행. ⚠ **스로틀은 `(++tick % N) === 0`** — `% N === 1` 이나 `tick++` 는 기동 첫 틱에
 * 즉시 참이 되어, 보존기간을 줄이고 재시작하면 첫 틱이 차액을 한 번에 지운다(v2.453 규칙).
 * v2.922: ① 시간 단위 파일 — 기간이 지난 파일은 **파일 삭제**, 경계 기간만 청크(monthStore.pruneMonthFiles) ② 메인 파일의 예전 표
 *   (마이그레이션 전 잔여) — 예전 규칙 그대로 청크 DELETE(rawDays·dailyDays). 마이그레이션이 옮기는 중이면 원시 파일 보존은 미룬다
 *   (대조 전에 사본을 지우지 않게 — keep.paused).
 */
export async function pruneUsage({ rawDays = 90, dailyDays = 365 * 5, every = 12, force = false, keep = null } = {}) {
  const db = await getDb();
  if (!db) return { ok: false };
  if (!force && (++_tick % every) !== 0) return { ok: true, skipped: true };
  // v2.602(감사 DB2602-01): 청크 DELETE + 청크 사이 양보(util/chunkedPrune.js, v2.453 규약). prune 끼리는 겹치지 않게 진행 중인 작업을 공유한다.
  if (_pruning) return _pruning;
  const rawCut = Date.now() - rawDays * 86_400_000;
  const dayCut = dayKey(Date.now() - dailyDays * 86_400_000);
  _pruning = (async () => {
    try {
      /*
       * v2.922(반증 D4·D6): 마이그레이션이 옮기는 중·대조 전·실패 대기 중에는 예전 표 정리와 원시·롤업 파일 보존을 **멈춘다** —
       *   예전 표를 지우면 대조(예전 행 수 = 사본 · 1시간 표본 합)가 어긋나고, 사본 파일을 지우면 재시도 대조가 다시 실패한다.
       */
      const rule = readRule(readMeta(db, MIGRATE_KEY));
      const migHold = ['copy-raw', 'copy-daily', 'verify', 'failed'].includes(rule.phase);
      const a = migHold ? { deleted: 0, done: true } : await chunkedDelete(db.prepare('DELETE FROM usage_history WHERE rowid IN (SELECT rowid FROM usage_history WHERE ts < ? LIMIT ?)'), [rawCut], { label: 'bmusage.usage_history' });
      const b = migHold ? { deleted: 0, done: true } : await chunkedDelete(db.prepare('DELETE FROM usage_daily WHERE rowid IN (SELECT rowid FROM usage_daily WHERE day < ? LIMIT ?)'), [dayCut], { label: 'bmusage.usage_daily' });
      if (a.deleted || b.deleted) _counts = null;
      const out = { ok: true, rawDeleted: a.deleted, dailyDeleted: b.deleted, done: a.done && b.done, ...(migHold ? { heldForMigration: rule.phase } : {}) };
      if (keep) {
        const paused = migHold ? ['raw', 'h1', 'd1'] : [];
        const f = await month.pruneMonthFiles({ keepDays: keep, paused });
        out.files = { deleted: f.filesDeleted, residualDeleted: f.residualDeleted, deferred: f.deferred, ...(f.errors.length ? { errors: f.errors.slice(0, 4) } : {}) };
        if (!f.ok) out.ok = false;
        if (!f.done) out.done = false;
      }
      return out;
    } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) }; }
  })().finally(() => { _pruning = null; });
  return _pruning;
}
let _pruning = null;

/** 최신값 표의 JSON 열 — 목록·이력이 필요 없는 소비처(corpUsage·svcInventory·cpuLatest)는 읽지 않는다(v2.922 · 1단계 반증 D13). */
const LATEST_JSON_COLS = Object.freeze(['detail_json', 'tuning_json']);
/**
 * 최신 1건씩(화면 표) — 서버별 마지막 관측.
 *
 * ⚠⚠ **`usage_latest` 전용 테이블을 읽는다**(v2.550.3 실측으로 도입). 예전에는
 *   `GROUP BY agent,key` + JOIN 이었고 그것은 **PK 인덱스 전체를 훑어** 518만 행에서 **702ms** 였다
 *   — 그게 화면 로드마다 돌았다. 전용 테이블은 **0.62ms**(1,130배). CLAUDE.md 의
 *   `idrac/db.js withLatestCache` 항목이 이미 같은 함정을 기록해 두었다
 *   ("latestAll(GROUP BY MAX)은 테이블 풀스캔이라 … 초 단위 블로킹이었음").
 * ⚠ **`WHERE ts>=?` 로 최근 구간만 좁히는 대안은 효과가 없다**(실측 303ms) — 옵티마이저가
 *   `GROUP BY agent,key` 때문에 여전히 PK 커버링 인덱스를 스캔한다. 그 방향으로 되돌리지 말 것.
 * v2.922(D13): 기본은 **JSON 열 없는 판본**(열 목록을 표에서 읽어 JSON 두 열만 뺀다). 성능 판정이 필요한 소비처(목록·상세·엣지 봉투)만
 *   `{ json: true }` 로 `SELECT * FROM usage_latest` 를 읽는다.
 */
export async function latestUsage({ json = false } = {}) {
  const db = await getDb();
  if (!db) return [];
  try {
    if (json) return db.prepare('SELECT * FROM usage_latest').all();
    if (!_latestLiteSql) {
      const cols = db.prepare('PRAGMA table_info(usage_latest)').all().map((r) => r.name).filter((c) => !LATEST_JSON_COLS.includes(c));
      _latestLiteSql = `SELECT ${cols.join(',')} FROM usage_latest`;
    }
    return db.prepare(_latestLiteSql).all();
  } catch { return []; }
}
let _latestLiteSql = null;

/**
 * 원시 추이(한 서버). 상한을 두고 **잘렸으면 밝힌다**(조용한 상한 금지).
 * v2.922: 시간 단위 파일(월 파일)에서 읽는다. 마이그레이션 중에는 예전 표가 그 구간(≤ legacyMaxTs)의 원본이다(readRule — 정상 경로).
 */
export async function usageHistory(key, { agent = '', hours = 24, limit = 3_000 } = {}) {
  const db = await getDb();
  if (!db) return { rows: [], truncated: false };
  const now = Date.now();
  const since = now - Math.max(1, Number(hours) || 24) * 3_600_000;
  return rawRangeMerged({ db, key, agent, from: since, to: now, limit, newestFirst: true });
}

/**
 * 원시 구간(오래된 것부터) — 예전 표(마이그레이션 중 그 구간의 원본) + 월 파일. newestFirst 면 최근 limit 개(예전 usageHistory 계약).
 * @returns {{rows:Array, truncated:boolean, missingPeriods?:Array, filesCapped?:number, source:{legacy:boolean, files:boolean}}}
 */
export async function rawRangeMerged({ db = null, key, agent = '', from, to, limit = 3_000, newestFirst = false, cols = null } = {}) {
  db = db || await getDb();
  if (!db) return { rows: [], truncated: false };
  const rule = readRule(readMeta(db, MIGRATE_KEY));
  const out = []; const meta = { missingPeriods: [], filesCapped: 0 };
  let legacyTo = -Infinity;
  try {
    if (rule.legacyRaw && rule.legacyMaxTs != null && from <= rule.legacyMaxTs) {
      legacyTo = Math.min(to, rule.legacyMaxTs);
      // 예전 표는 열이 더 적다(피크 열 없음) — cols 를 주면 **예전 표에 있는 열만** 고르고(v2.922 반증 D11 — 140열 SELECT * 를 줄인다), 없는 열은 결과에 없다(= null).
      const sel = cols ? ['ts', ...cols.filter((c) => legacyCols(db).has(c) && c !== 'ts')].join(',') : '*';
      const q = newestFirst
        ? db.prepare(`SELECT ${sel} FROM usage_history WHERE key=? AND agent=? AND ts>=? AND ts<=? ORDER BY ts DESC LIMIT ?`).all(String(key), String(agent), from, legacyTo, limit + 1).reverse()
        : db.prepare(`SELECT ${sel} FROM usage_history WHERE key=? AND agent=? AND ts>=? AND ts<=? ORDER BY ts LIMIT ?`).all(String(key), String(agent), from, legacyTo, limit + 1);
      for (const x of (q)) out.push(x);   // 큰 배열 전개 push 금지(v2.603 — RangeError)
    }
  } catch { /* 예전 표가 없으면(새 설치) 건너뛴다 */ }
  const fFrom = legacyTo === -Infinity ? from : legacyTo + 1;
  if (fFrom <= to) {
    const r = await month.readRawRange({ agent, key, from: fFrom, to, cols, limit: newestFirst ? 1e7 : limit + 1 }).catch(() => ({ rows: [] }));
    for (const x of ((r.rows || []))) out.push(x);   // 큰 배열 전개 push 금지(v2.603 — RangeError)
    meta.missingPeriods = (r.missingPeriods || []).filter((x) => x.reason !== 'none');
    meta.filesCapped = r.filesCapped || 0;
  }
  let rows = out; let truncated = false;
  if (newestFirst) { truncated = rows.length > limit; rows = rows.slice(-limit); }
  else if (rows.length > limit) { truncated = true; rows = rows.slice(0, limit); }
  return { rows, truncated, ...meta, source: { legacy: legacyTo !== -Infinity, files: fFrom <= to } };
}

let _legacyCols = null;
/** 예전 표 열 이름(한 번 읽어 둔다 — 열 이름은 상수 표와 대조해서만 SQL 에 들어간다). */
function legacyCols(db) {
  if (!_legacyCols) { try { _legacyCols = new Set(db.prepare('PRAGMA table_info(usage_history)').all().map((r) => r.name)); } catch { _legacyCols = new Set(); } }
  return _legacyCols;
}
/**
 * v2.665: 출처가 iDRAC 뿐인 행만(serverTrendSeries.bmSrcIsIdrac 과 같은 판정 — 'os' 가 섞이면 CPU 가 OS 값일 수 있다,
 * 출처를 모르는 빈 src 도 쓰지 않는다). src 는 '+' 로 이은 토큰이라 양끝에 '+' 를 붙여 토큰 단위로 비교한다.
 */
export const IDRAC_ONLY_SQL = ` AND src IS NOT NULL AND src <> '' AND ('+' || src || '+') NOT LIKE '%+os+%' AND (('+' || src || '+') LIKE '%+idrac+%' OR ('+' || src || '+') LIKE '%+idrac-ent+%')`;
/** JS 판본(월 파일 행을 거를 때 — 같은 규칙). */
export function idracOnlySrc(src) {
  const s = `+${String(src || '')}+`;
  if (!src || s.includes('+os+')) return false;
  return s.includes('+idrac+') || s.includes('+idrac-ent+');
}

/**
 * 기간 버킷 평균 CPU %(한 서버의 여러 후보 키 — 서비스태그·id·fleetId). iDRAC 통합 추이(v2.661)가 **이미 쌓인** 원시 이력으로
 * 텔레메트리가 없던 과거 구간을 채울 때 쓴다. 값이 없는 버킷은 행이 없다(0 으로 채우지 않는다).
 * v2.922: 원시는 시간 단위 파일 · 집계는 JS(한 문장 집계 둘 금지 규약 — 월 경계를 넘는 버킷도 한 번에 평균). 원시 보존(기본 30일)보다
 *   오래된 구간은 비어 있다 — 호출부가 밝힌다(1시간 롤업으로 메우지 않는다: 그 롤업은 출처(src) 를 행마다 갖지 않아 iDRAC 전용 판정을 못 한다).
 */
export async function usageCpuRange(keys = [], { agent = '', start, end, bucketMs, idracOnly = false } = {}) {
  const db = await getDb();
  // PK(agent,key,ts) 선탐색을 쓰려고 대소문자 변형을 키로 늘린다(COLLATE NOCASE 는 인덱스를 못 탄다).
  const ks = [...new Set((keys || []).flatMap((k) => { const t = String(k || '').trim(); return t ? [t, t.toUpperCase(), t.toLowerCase()] : []; }))].slice(0, 9);
  if (!db || !ks.length || !(end > start) || !(bucketMs > 0)) return { rows: [], key: null };
  try {
    for (const key of ks) {
      const r = await rawRangeMerged({ db, key, agent, from: start, to: end - 1, limit: 200_000, cols: ['cpu_pct', 'src'] });
      const acc = new Map();
      for (const row of r.rows) {
        const v = n(row.cpu_pct);
        if (v == null || (idracOnly && !idracOnlySrc(row.src))) continue;
        const b = Math.floor(Number(row.ts) / bucketMs) * bucketMs;
        const a = acc.get(b) || { s: 0, c: 0 };
        a.s += v; a.c += 1; acc.set(b, a);
      }
      if (acc.size) return { rows: [...acc.entries()].sort((x, y) => x[0] - y[0]).map(([ts, a]) => ({ ts, v: a.s / a.c })), key };
    }
  } catch { /* 참고값 — 실패는 빈 결과 */ }
  return { rows: [], key: null };
}

/**
 * 일 롤업(한 서버 또는 전체). 평균은 `sum/n` 으로 되돌린다 — **n 이 0 이면 `null`**(0 이 아니다).
 * v2.922: 1일 연 파일의 실시간 표 + 예전 일 롤업(마이그레이션 전이면 메인 파일의 예전 표, 끝났으면 연 파일의 사본 표)을 **같은 날끼리 합친다**
 *   (두 쪽은 서로 다른 표본이라 합·개수를 더하는 것이 맞다 — 업그레이드 당일만 겹친다).
 */
export async function usageDaily({ key = '', agent = '', days = 90 } = {}) {
  const now = Date.now();
  return dailyRangeMerged({ key, agent, from: now - Math.max(1, Number(days) || 90) * 86_400_000, to: now });
}
/** 일 롤업 구간(같은 날 합치기 — usageDaily 의 본체 · 추이 API 1일 해상도도 이것). */
export async function dailyRangeMerged(opt = {}) { return (await dailyRangeMergedMeta(opt)).rows; }
/**
 * v2.922(반증 D8): 1일 구간 + **열기 실패·파일 상한** — 추이 API 가 그대로 밝힌다(조용한 상한·조용한 실패 금지). 오류는 [] 로 삼키지 않고 error 로.
 * @returns {Promise<{rows:Array, missingPeriods:Array, filesCapped:number, error?:string}>}
 */
export async function dailyRangeMergedMeta({ key = '', agent = '', from: fromMs, to: toMs } = {}) {
  const db = await getDb();
  if (!db) return { rows: [], missingPeriods: [], filesCapped: 0, error: 'db-unavailable' };
  const from = dayKey(fromMs); const to = dayKey(toMs);
  try {
    const rule = readRule(readMeta(db, MIGRATE_KEY));
    const files = await month.readDailyRange({ agent, key, from: fromMs, to: toMs, withMig: !rule.legacyDaily });
    let legacy = [];
    if (rule.legacyDaily) {
      /*
       * ⚠ 전체 조회도 **agent 로 걸러야 한다**(v2.550.3 에 고친 결함): 예전에는 `key` 가 없으면
       *   agent 조건이 사라져 중앙이 자기 행과 엣지 행을 섞어 돌려줬다(v2.548 `(agent, part_key)` 와 같은 판단).
       */
      legacy = key
        ? db.prepare('SELECT * FROM usage_daily WHERE key=? AND agent=? AND day>=? AND day<=? ORDER BY day').all(String(key), String(agent), from, to)
        : db.prepare('SELECT * FROM usage_daily WHERE agent=? AND day>=? AND day<=? ORDER BY day, key').all(String(agent), from, to);
    }
    const map = new Map();
    for (const r of [...legacy, ...files.mig, ...files.live]) {
      const k = `${r.agent}|${r.key}|${r.day}`;
      map.set(k, month.mergeDailyRows(map.get(k) || null, r));
    }
    const rows = [...map.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return {
      rows: rows.map((r) => ({
        ...r,
        cpu_avg: r.cpu_n > 0 ? Math.round((r.cpu_sum / r.cpu_n) * 10) / 10 : null,
        mem_avg: r.mem_n > 0 ? Math.round((r.mem_sum / r.mem_n) * 10) / 10 : null,
      })),
      missingPeriods: (files.missingPeriods || []).filter((x) => x.reason !== 'none'), filesCapped: files.filesCapped || 0,
    };
  } catch (e) { return { rows: [], missingPeriods: [], filesCapped: 0, error: String(e?.message || e).slice(0, 200) }; }
}

export function _resetForTest() { _legacyCols = null; _perfCols = null; _migrateError = null; _latestLiteSql = null; lockRetry.ok(); try { _db?.close?.(); } catch { /* */ } _db = null; _tried = false; _opening = null; _tick = 0; _counts = null; month._resetMonthStoreForTest(); }
