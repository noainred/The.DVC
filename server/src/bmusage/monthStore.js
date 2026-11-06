/**
 * bmusage/monthStore.js — 베어메탈 사용률 **시간 단위 파일**(v2.922 · 3a 단계). 설계 `docs/design/linux-bm-perf/README.md` §4.4
 * (사용자 확정 2026-11-06 "DB 에 데이터 저장은 추천하는대로 구성").
 *
 * ── 왜 파일을 나누나 ──────────────────────────────────────────────────────────
 * 1,000대 법인이면 5분 원시만 한 달 860만 행이다. 보존을 `DELETE WHERE ts<?` 로 집행하면 수천만 행을 지워야 하고(청크로 나눠도
 * WAL·I/O 가 그만큼 돈다) 지운 자리는 파일이 줄지 않는다. 그래서 **보존을 파일 삭제로** 한다 — 기간이 지난 파일을 통째로 지운다.
 *
 * ── 단계(가족)마다 파일을 따로 둔다(설계와 다른 결정 · 이유) ──────────────────────
 * 설계 문장은 ‘원시·롤업은 월 파일 bm-usage-YYYY-MM.db’ 다. 한 파일에 5분(30일)·1시간(1년)·1일(5년)을 함께 두면 그 파일은 5년 뒤에야
 * 지울 수 있고, 그 사이 5분 원시 860만 행/월을 파일 안에서 DELETE 해야 한다(설계가 피하려던 바로 그것). 그래서 **보존이 같은 것끼리**
 * 파일을 나눴다 — 파일마다 보존이 하나라 ‘기간이 지난 파일 삭제’ 하나로 끝나고, 파일 안 잔여(경계 달의 앞부분)만 청크로 지운다.
 *   · 5분 원시     `bm-usage-YYYY-MM.db`      (usage_history — 설계 이름 그대로)          보존 rawDays(30)
 *   · 1시간 롤업   `bm-usage-1h-YYYY-MM.db`   (usage_hourly — 평균(합·개수)·최대·피크)    보존 hourlyDays(365)
 *   · 1일 롤업     `bm-usage-1d-YYYY.db`      (usage_daily · usage_daily_mig · usage_mount_daily) 보존 dailyRetentionDays(5년)
 *     ⚠ 1일은 **연 파일**이다 — 5년 창이 6개 파일이라 조회당 파일 상한(10) 안에 든다(월 파일이면 60개).
 *   · 장치 5분     `bm-usage-dev-YYYY-MM.db`  (usage_device_history)                    보존 devRawDays(14)
 *   · 장치 1시간   `bm-usage-dev1h-YYYY-MM.db`(usage_device_hourly)                      보존 devHourlyDays(90)
 * 메인 `bm-usage.db`(db.js)는 최신값(usage_latest — 튜닝 JSON 포함)·장치 목록(usage_devices)·마이그레이션 상태(bm_meta)만 둔다.
 * 달·해의 경계는 **포탈 시각**(util/dayKey — 기본 KST)이다: 하루가 두 파일에 갈라지지 않는다(일 롤업과 같은 경계).
 *
 * ── ATTACH 대신 파일별 핸들(설계와 다른 결정 · 이유) ─────────────────────────────
 * 조회는 창에 걸리는 파일만 연다(보통 1~3개). ATTACH 는 연결 상태라 조회가 양보(await)하는 사이 다른 조회·적재와 같은 연결을 공유하고
 * DETACH 실패가 연결을 붙잡는다. 대신 파일마다 핸들을 두고(진행 중인 open 공유 — v2.580 규약 · LRU 상한 · 쓰는 중인 핸들은 닫지 않는다)
 * 결과를 JS 에서 잇는다. ATTACH 상한(10)은 **조회당 파일 상한**(MONTH_FILES_PER_QUERY)으로 지킨다 — 넘으면 최근 쪽 10개만 읽고
 * `filesCapped` 로 밝힌다. 열지 못한 파일(없음·손상·잠김)은 `missingPeriods` 로 ‘그 기간 없음’ 을 밝히고 나머지로 계속한다.
 *
 * ── 규약(perf-db.md) ─────────────────────────────────────────────────────────
 *  · 적재는 파일마다 **트랜잭션 1회**이고 트랜잭션 안에 await 가 없다(양보 사이에 다른 흐름이 같은 핸들로 BEGIN 하지 않게).
 *  · 원시는 `INSERT OR IGNORE` + `changes` 가 1 일 때만 롤업을 갱신한다(이중 계수 금지 — v2.550.3).
 *  · 롤업 최대는 `NULLIF(MAX(IFNULL(a,-1e308),IFNULL(b,-1e308)),-1e308)`(스칼라 MAX — 인자 하나가 NULL 이면 NULL 을 주는 함정).
 *  · **집계 함수(인자 하나짜리 MIN·MAX·SUM·COUNT·AVG)는 한 문장에 하나**만(v2.550.3 — 둘이면 인덱스를 통째로 훑는다). 롤업 계산은 JS 또는
 *    upsert 누적이다(테스트가 소스를 훑는다).
 *  · null 은 평균의 분모(n)에 넣지 않는다. 피크 시각은 `<열>_peak` 가 바뀔 때만 바뀐다(SET 의 우변은 갱신 전 값 — SQLite 규칙).
 *  · **1초 샘플은 여기 들어오지 않는다**(설계 §4.4 — 피크 창의 1초 표본은 집계 뒤 버린다. 이 모듈에는 1초 해상도 표가 없다).
 * node:sqlite 가 없으면 전부 no-op(수집·화면은 살고 이력만 없다 — db.js 와 같은 관행).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { numOrNull } from '../util/numOrNull.js';
import { DAY_OFFSET_MIN, dayKey } from '../util/dayKey.js';
import { openSqlite, isSqliteLockError } from '../util/sqliteOpen.js';
import { chunkedDelete } from '../util/chunkedPrune.js';
import { createYielder } from '../util/timeSlice.js';
import { PERF_COL_NAMES, PEAK_COLS, PEAK_META_COLS, PEAK_SQL_COLS, DEVICE_COL_NAMES, DEVICE_PEAK_COLS, DEVICE_COLS, MOUNT_DAILY_COLS } from './perfCols.js';

const n = numOrNull;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const OFF_MS = DAY_OFFSET_MIN * 60_000;

/** 조회 한 번에 여는 파일 상한 — SQLite ATTACH 기본 상한(SQLITE_MAX_ATTACHED 10)과 같은 값(설계 ‘상한 10 안’). */
export const MONTH_FILES_PER_QUERY = 10;
/** 동시에 열어 두는 핸들 상한(LRU). 쓰는 파일 5종(이번 달) + 조회 10 + 여유. 쓰는 중(pin)인 핸들은 닫지 않는다. */
export const MONTH_MAX_OPEN = Math.max(8, Number(process.env.BMUSAGE_MONTH_MAX_OPEN) || 24);

/* ── 기존 다섯 지표 열(+ HBA·I/O) — db.js METRICS 와 같은 9개. 롤업 이름은 예전 일 롤업 규약(cpu_sum·net_max …)을 따른다. ── */
export const BASE_COLS = Object.freeze(['cpu_pct', 'mem_pct', 'disk_busy_pct', 'disk_used_pct', 'net_pct', 'net_bps', 'hba_pct', 'hba_bps', 'io_pct']);
const BASE_PREFIX = Object.freeze({ cpu_pct: 'cpu', mem_pct: 'mem', disk_busy_pct: 'disk_busy', disk_used_pct: 'disk_used', net_pct: 'net', net_bps: 'net_bps', hba_pct: 'hba', hba_bps: 'hba_bps', io_pct: 'io' });
/** 롤업할 열과 그 접두사(`<p>_sum · <p>_n · <p>_max`). 성능 열은 열 이름 그대로가 접두사다. */
export const ROLL = Object.freeze([...BASE_COLS.map((col) => ({ col, p: BASE_PREFIX[col] })), ...PERF_COL_NAMES.map((col) => ({ col, p: col }))]);
export const rollPrefix = (col) => BASE_PREFIX[col] || col;
/** 장치 롤업 열 — 속도는 마지막 값(평균이 뜻이 없다), 나머지는 합·개수·최대. */
const DEV_ROLL = Object.freeze(DEVICE_COLS.filter((c) => c.roll !== 'last').map((c) => c.col));

/** 가족(단계) 정의 — 파일 접두사 · 기간 단위 · 주 표 · 보존 설정 이름. */
export const FAMILIES = Object.freeze({
  raw: { prefix: 'bm-usage-', period: 'month', table: 'usage_history', keep: 'raw' },
  h1: { prefix: 'bm-usage-1h-', period: 'month', table: 'usage_hourly', keep: 'h1' },
  d1: { prefix: 'bm-usage-1d-', period: 'year', table: 'usage_daily', keep: 'd1' },
  dev: { prefix: 'bm-usage-dev-', period: 'month', table: 'usage_device_history', keep: 'dev' },
  dev1h: { prefix: 'bm-usage-dev1h-', period: 'month', table: 'usage_device_hourly', keep: 'dev1h' },
});
const FILE_RE = /^bm-usage-(?:(1h|1d|dev|dev1h)-)?(\d{4})(?:-(\d{2}))?\.db$/;

export const dbDir = () => config.dbDir || config.configDir;

/* ════════════════════════ 기간 · 파일 이름(순수) ════════════════════════ */
/** 포탈 시각 기준 기간 키 — month: 'YYYY-MM' · year: 'YYYY'. */
export function periodKeyOf(family, ts) {
  const d = dayKey(ts);
  if (!d) return null;
  return FAMILIES[family].period === 'year' ? d.slice(0, 4) : d.slice(0, 7);
}
/** 기간 [시작, 끝) ms(포탈 시각 경계). */
export function periodRange(family, key) {
  const y = Number(key.slice(0, 4));
  if (FAMILIES[family].period === 'year') return [Date.UTC(y, 0, 1) - OFF_MS, Date.UTC(y + 1, 0, 1) - OFF_MS];
  const m = Number(key.slice(5, 7)) - 1;
  return [Date.UTC(y, m, 1) - OFF_MS, Date.UTC(y, m + 1, 1) - OFF_MS];
}
export const fileNameOf = (family, key) => `${FAMILIES[family].prefix}${key}.db`;
/** 파일 이름 → { family, key } · 이 모듈의 파일이 아니면 null(메인 bm-usage.db 는 null). */
export function parseFileName(name) {
  const m = FILE_RE.exec(String(name || ''));
  if (!m) return null;
  const family = m[1] === '1h' ? 'h1' : m[1] === '1d' ? 'd1' : m[1] === 'dev' ? 'dev' : m[1] === 'dev1h' ? 'dev1h' : 'raw';
  const per = FAMILIES[family].period;
  if (per === 'year' && m[3]) return null;
  if (per === 'month' && !m[3]) return null;
  return { family, key: m[3] ? `${m[2]}-${m[3]}` : m[2] };
}
/** 창 [from, to] 에 걸리는 기간 키(오래된 것부터). */
export function periodsInWindow(family, from, to) {
  const out = [];
  const a = n(from); const b = n(to);
  if (a == null || b == null || b < a) return out;
  let k = periodKeyOf(family, a);
  for (let guard = 0; k && guard < 400; guard++) {
    out.push(k);
    const [, end] = periodRange(family, k);
    if (end > b) break;
    k = periodKeyOf(family, end);
  }
  return out;
}
/** 디렉터리에 있는 이 모듈의 파일들(가족별, 오래된 것부터). */
export function listFamilyFiles(family) {
  let names = [];
  try { names = fs.readdirSync(dbDir()); } catch { return []; }
  return names.map((f) => ({ f, p: parseFileName(f) })).filter((x) => x.p && x.p.family === family)
    .map((x) => ({ name: x.f, key: x.p.key })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/* ════════════════════════ 스키마 ════════════════════════ */
const rollColsSql = (rolls) => rolls.map(({ p }) => `${p}_sum REAL, ${p}_n INTEGER NOT NULL DEFAULT 0, ${p}_max REAL`).join(',\n  ');
const peakColsSql = (cols) => cols.map((c) => `${c}_peak REAL, ${c}_peak_at INTEGER`).join(', ');
/** 예전 메인 파일 usage_daily 와 같은 열(+ 성능 _max) — 마이그레이션 사본 표(usage_daily_mig)와 1일 롤업이 이 모양을 공유한다. */
export const LEGACY_DAILY_COLS = Object.freeze([
  'name', 'vcenter_id', 'cpu_sum', 'cpu_n', 'cpu_max', 'mem_sum', 'mem_n', 'mem_max',
  'disk_busy_max', 'disk_used_max', 'net_max', 'net_bps_max', 'hba_max', 'hba_bps_max', 'io_max', 'samples', 'last_ts',
  ...PERF_COL_NAMES.map((c) => `${c}_max`),
]);
const LEGACY_DAILY_SQL = `name TEXT, vcenter_id TEXT, cpu_sum REAL DEFAULT 0, cpu_n INTEGER DEFAULT 0, cpu_max REAL, mem_sum REAL DEFAULT 0, mem_n INTEGER DEFAULT 0, mem_max REAL,
  disk_busy_max REAL, disk_used_max REAL, net_max REAL, net_bps_max REAL, hba_max REAL, hba_bps_max REAL, io_max REAL,
  samples INTEGER NOT NULL DEFAULT 0, last_ts INTEGER, ${PERF_COL_NAMES.map((c) => `${c}_max REAL`).join(', ')}`;
/** 1일 롤업에서 예전 모양에 없던 합·개수(cpu·mem 은 이미 있다) — 새로 쌓는 날은 모든 지표의 평균이 나온다. */
const D1_EXTRA_ROLL = ROLL.filter(({ col }) => col !== 'cpu_pct' && col !== 'mem_pct');
/** 1일 표의 추가 열 — 합·개수는 전부 새 열, 최대는 예전 모양에 없는 것만(예전 이름 net_max 등은 이미 있다). */
const D1_EXTRA_SQL = D1_EXTRA_ROLL.map(({ p }) => `${p}_sum REAL, ${p}_n INTEGER NOT NULL DEFAULT 0${LEGACY_DAILY_COLS.includes(`${p}_max`) ? '' : `, ${p}_max REAL`}`).join(', ');

export const SCHEMA = Object.freeze({
  raw: `CREATE TABLE IF NOT EXISTS usage_history (
    agent TEXT NOT NULL DEFAULT '', key TEXT NOT NULL, ts INTEGER NOT NULL, name TEXT, vcenter_id TEXT, src TEXT,
    ${BASE_COLS.map((c) => `${c} REAL`).join(', ')}, ${PERF_COL_NAMES.map((c) => `${c} REAL`).join(', ')},
    ${PEAK_SQL_COLS.map(([c, t]) => `${c} ${t}`).join(', ')}, ${PEAK_META_COLS.map(([c, t]) => `${c} ${t}`).join(', ')},
    PRIMARY KEY (agent, key, ts));
    CREATE INDEX IF NOT EXISTS idx_bmm_raw_ts ON usage_history(ts);`,
  h1: `CREATE TABLE IF NOT EXISTS usage_hourly (
    agent TEXT NOT NULL DEFAULT '', key TEXT NOT NULL, h INTEGER NOT NULL, name TEXT, vcenter_id TEXT,
    samples INTEGER NOT NULL DEFAULT 0, last_ts INTEGER, peak_samples INTEGER NOT NULL DEFAULT 0, peak_src TEXT,
    ${rollColsSql(ROLL)}, ${peakColsSql(PEAK_COLS)},
    PRIMARY KEY (agent, key, h));
    CREATE INDEX IF NOT EXISTS idx_bmm_h1_h ON usage_hourly(h);
    CREATE TABLE IF NOT EXISTS _mig (k TEXT PRIMARY KEY, v INTEGER);`,
  d1: `CREATE TABLE IF NOT EXISTS usage_daily (
    agent TEXT NOT NULL DEFAULT '', key TEXT NOT NULL, day TEXT NOT NULL, ${LEGACY_DAILY_SQL},
    peak_samples INTEGER NOT NULL DEFAULT 0, peak_src TEXT,
    ${D1_EXTRA_SQL}, ${peakColsSql(PEAK_COLS)},
    PRIMARY KEY (agent, key, day));
    CREATE INDEX IF NOT EXISTS idx_bmm_d1_day ON usage_daily(day);
    CREATE TABLE IF NOT EXISTS usage_daily_mig (agent TEXT NOT NULL DEFAULT '', key TEXT NOT NULL, day TEXT NOT NULL, ${LEGACY_DAILY_SQL}, PRIMARY KEY (agent, key, day));
    CREATE INDEX IF NOT EXISTS idx_bmm_d1m_day ON usage_daily_mig(day);
    CREATE TABLE IF NOT EXISTS usage_mount_daily (agent TEXT NOT NULL DEFAULT '', key TEXT NOT NULL, day TEXT NOT NULL, mount TEXT NOT NULL,
      ${MOUNT_DAILY_COLS.map((c) => `${c}_sum REAL, ${c}_n INTEGER NOT NULL DEFAULT 0, ${c}_max REAL`).join(', ')},
      size_bytes REAL, used_bytes REAL, last_ts INTEGER, PRIMARY KEY (agent, key, day, mount));
    CREATE INDEX IF NOT EXISTS idx_bmm_mount_day ON usage_mount_daily(day);
    CREATE TABLE IF NOT EXISTS _mig (k TEXT PRIMARY KEY, v INTEGER);`,
  dev: `CREATE TABLE IF NOT EXISTS usage_device_history (
    agent TEXT NOT NULL DEFAULT '', key TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, dev TEXT NOT NULL,
    ${DEVICE_COL_NAMES.map((c) => `${c} REAL`).join(', ')}, oper TEXT, ${peakColsSql(DEVICE_PEAK_COLS)},
    PRIMARY KEY (agent, key, kind, dev, ts));
    CREATE INDEX IF NOT EXISTS idx_bmm_dev_ts ON usage_device_history(ts);`,
  dev1h: `CREATE TABLE IF NOT EXISTS usage_device_hourly (
    agent TEXT NOT NULL DEFAULT '', key TEXT NOT NULL, kind TEXT NOT NULL, dev TEXT NOT NULL, h INTEGER NOT NULL,
    samples INTEGER NOT NULL DEFAULT 0, last_ts INTEGER, oper TEXT, speed_bps REAL,
    ${DEV_ROLL.map((c) => `${c}_sum REAL, ${c}_n INTEGER NOT NULL DEFAULT 0, ${c}_max REAL`).join(', ')}, ${peakColsSql(DEVICE_PEAK_COLS)},
    PRIMARY KEY (agent, key, kind, dev, h));
    CREATE INDEX IF NOT EXISTS idx_bmm_dev1h_h ON usage_device_hourly(h);`,
});

/* ════════════════════════ 핸들(진행 중인 open 공유 · LRU · pin) ════════════════════════ */
const _open = new Map();     // name → { db, family, key, pins, used }
const opening = new Map();   // name → Promise<db|null>  (v2.580 BUG-A: 파일별 Map 모듈은 opening Map)
let _sqlite = null;
let _unavailable = false;
const _failed = new Map();   // name → { at, reason } — 열지 못한 파일(조회 응답의 missingPeriods 근거)

async function sqliteMod() {
  if (_sqlite || _unavailable) return _sqlite;
  try { _sqlite = await import('node:sqlite'); } catch { _unavailable = true; }
  return _sqlite;
}
export async function monthStoreAvailable() { return !!(await sqliteMod()); }

const dropPrep = (name) => { for (const k of _prepCache.keys()) if (k.startsWith(`${name}|`)) _prepCache.delete(k); };
function evict() {
  if (_open.size <= MONTH_MAX_OPEN) return;
  const idle = [..._open.entries()].filter(([, h]) => !h.pins).sort((a, b) => a[1].used - b[1].used);
  for (const [name, h] of idle) {
    if (_open.size <= MONTH_MAX_OPEN) break;
    try { h.db.close(); } catch { /* 이미 닫힘 */ }
    _open.delete(name); dropPrep(name);
  }
}

/**
 * 파일 핸들. `create:false` 면 없는 파일을 만들지 않는다(조회 — ‘그 기간 없음’). 실패는 null + _failed 기록(던지지 않는다).
 * ⚠ 같은 파일에 동시 호출이 오면 진행 중인 시도를 공유한다(v2.580 — 핸들 2개 · fd 누수 방지).
 */
export async function openPeriodFile(family, key, { create = false } = {}) {
  const name = fileNameOf(family, key);
  const h = _open.get(name);
  if (h) { h.used = Date.now(); return h.db; }
  if (opening.has(name)) return opening.get(name);
  const file = path.join(dbDir(), name);
  if (!create && !fs.existsSync(file)) return null;
  const p = (async () => {
    const mod = await sqliteMod();
    if (!mod) return null;
    let conn = null;
    try {
      fs.mkdirSync(dbDir(), { recursive: true });
      conn = openSqlite(new mod.DatabaseSync(file));   // busy_timeout 먼저 · 0600(DB2611-01)
      conn.exec(SCHEMA[family]);
      _open.set(name, { db: conn, family, key, pins: 0, used: Date.now() });
      _failed.delete(name);
      evict();
      return conn;
    } catch (e) {
      try { conn?.close(); } catch { /* */ }
      _failed.set(name, { at: Date.now(), reason: `${isSqliteLockError(e) ? '잠김' : '열기 실패'}: ${String(e?.message || e).slice(0, 160)}` });
      return null;
    }
  })().finally(() => { opening.delete(name); });
  opening.set(name, p);
  return p;
}
/** 쓰는 동안(양보를 사이에 두는 흐름) 핸들이 LRU 로 닫히지 않게 고정한다. */
export async function withPeriodFile(family, key, opts, fn) {
  const db = await openPeriodFile(family, key, opts);
  if (!db) return fn(null);
  const h = _open.get(fileNameOf(family, key));
  if (h) h.pins += 1;
  try { return await fn(db); } finally { if (h) { h.pins -= 1; h.used = Date.now(); } evict(); }
}
export function closePeriodFile(family, key) {
  const name = fileNameOf(family, key);
  const h = _open.get(name);
  if (!h) return true;
  if (h.pins) return false;
  try { h.db.close(); } catch { /* */ }
  _open.delete(name); dropPrep(name);
  return true;
}
export function openFileNames() { return [..._open.keys()].sort(); }
export function failedFiles() { return [..._failed.entries()].map(([name, v]) => ({ name, ...v })); }
export function _resetMonthStoreForTest() {
  for (const h of _open.values()) { try { h.db.close(); } catch { /* */ } }
  _open.clear(); opening.clear(); _failed.clear(); _prepCache.clear(); _pruning = null; _counts = null;
}

/* ════════════════════════ 적재 ════════════════════════ */
const _prepCache = new Map();   // `${name}|${sqlKey}` → statement (핸들이 닫히면 버린다)
function prep(db, name, sqlKey, sql) {
  const h = _open.get(name);
  const k = `${name}|${sqlKey}`;
  const c = _prepCache.get(k);
  if (c && c.db === db) return c.st;
  const st = db.prepare(sql);
  if (h) _prepCache.set(k, { db, st });
  return st;
}
const maxSql = (c, src = 'excluded') => `${c}=NULLIF(MAX(IFNULL(${c},-1e308),IFNULL(${src}.${c},-1e308)),-1e308)`;
/** 피크 갱신 — 새 피크가 더 클 때만 값과 시각을 함께 바꾼다(SET 우변은 갱신 전 값). 순서: 시각 먼저(같은 조건). */
const peakSql = (c) => `${c}_peak_at=CASE WHEN excluded.${c}_peak IS NOT NULL AND (${c}_peak IS NULL OR excluded.${c}_peak > ${c}_peak) THEN excluded.${c}_peak_at ELSE ${c}_peak_at END,
      ${c}_peak=CASE WHEN excluded.${c}_peak IS NOT NULL AND (${c}_peak IS NULL OR excluded.${c}_peak > ${c}_peak) THEN excluded.${c}_peak ELSE ${c}_peak END`;
const sumSql = (p) => `${p}_sum=IFNULL(${p}_sum,0)+IFNULL(excluded.${p}_sum,0), ${p}_n=${p}_n+excluded.${p}_n`;

const RAW_COLS = Object.freeze(['agent', 'key', 'ts', 'name', 'vcenter_id', 'src', ...BASE_COLS, ...PERF_COL_NAMES, ...PEAK_SQL_COLS.map(([c]) => c), ...PEAK_META_COLS.map(([c]) => c)]);
const RAW_INS = `INSERT OR IGNORE INTO usage_history (${RAW_COLS.join(',')}) VALUES (${RAW_COLS.map(() => '?').join(',')})`;
const H1_COLS = Object.freeze(['agent', 'key', 'h', 'name', 'vcenter_id', 'samples', 'last_ts', 'peak_samples', 'peak_src',
  ...ROLL.flatMap(({ p }) => [`${p}_sum`, `${p}_n`, `${p}_max`]), ...PEAK_COLS.flatMap((c) => [`${c}_peak`, `${c}_peak_at`])]);
const H1_UPSERT = `INSERT INTO usage_hourly (${H1_COLS.join(',')}) VALUES (${H1_COLS.map(() => '?').join(',')})
  ON CONFLICT(agent,key,h) DO UPDATE SET name=excluded.name, vcenter_id=excluded.vcenter_id, samples=samples+excluded.samples,
    last_ts=MAX(IFNULL(last_ts,0),excluded.last_ts), peak_samples=peak_samples+excluded.peak_samples, peak_src=COALESCE(excluded.peak_src, peak_src),
    ${ROLL.map(({ p }) => `${sumSql(p)}, ${maxSql(`${p}_max`)}`).join(',\n    ')},
    ${PEAK_COLS.map(peakSql).join(',\n    ')}`;
const D1_ROLL_ALL = Object.freeze([{ col: 'cpu_pct', p: 'cpu' }, { col: 'mem_pct', p: 'mem' }, ...D1_EXTRA_ROLL]);
const D1_COLS = Object.freeze(['agent', 'key', 'day', 'name', 'vcenter_id', 'samples', 'last_ts', 'peak_samples', 'peak_src',
  ...D1_ROLL_ALL.flatMap(({ p }) => [`${p}_sum`, `${p}_n`, `${p}_max`]), ...PEAK_COLS.flatMap((c) => [`${c}_peak`, `${c}_peak_at`])]);
const D1_UPSERT = `INSERT INTO usage_daily (${D1_COLS.join(',')}) VALUES (${D1_COLS.map(() => '?').join(',')})
  ON CONFLICT(agent,key,day) DO UPDATE SET name=excluded.name, vcenter_id=excluded.vcenter_id, samples=samples+excluded.samples,
    last_ts=MAX(IFNULL(last_ts,0),excluded.last_ts), peak_samples=peak_samples+excluded.peak_samples, peak_src=COALESCE(excluded.peak_src, peak_src),
    ${D1_ROLL_ALL.map(({ p }) => `${sumSql(p)}, ${maxSql(`${p}_max`)}`).join(',\n    ')},
    ${PEAK_COLS.map(peakSql).join(',\n    ')}`;
const DEV_COLS = Object.freeze(['agent', 'key', 'ts', 'kind', 'dev', ...DEVICE_COL_NAMES, 'oper', ...DEVICE_PEAK_COLS.flatMap((c) => [`${c}_peak`, `${c}_peak_at`])]);
const DEV_INS = `INSERT OR IGNORE INTO usage_device_history (${DEV_COLS.join(',')}) VALUES (${DEV_COLS.map(() => '?').join(',')})`;
const DEV1H_COLS = Object.freeze(['agent', 'key', 'kind', 'dev', 'h', 'samples', 'last_ts', 'oper', 'speed_bps',
  ...DEV_ROLL.flatMap((c) => [`${c}_sum`, `${c}_n`, `${c}_max`]), ...DEVICE_PEAK_COLS.flatMap((c) => [`${c}_peak`, `${c}_peak_at`])]);
const DEV1H_UPSERT = `INSERT INTO usage_device_hourly (${DEV1H_COLS.join(',')}) VALUES (${DEV1H_COLS.map(() => '?').join(',')})
  ON CONFLICT(agent,key,kind,dev,h) DO UPDATE SET samples=samples+excluded.samples, last_ts=MAX(IFNULL(last_ts,0),excluded.last_ts),
    oper=CASE WHEN excluded.last_ts >= IFNULL(last_ts,0) THEN COALESCE(excluded.oper, oper) ELSE oper END,
    speed_bps=CASE WHEN excluded.last_ts >= IFNULL(last_ts,0) THEN COALESCE(excluded.speed_bps, speed_bps) ELSE speed_bps END,
    ${DEV_ROLL.map((c) => `${sumSql(c)}, ${maxSql(`${c}_max`)}`).join(',\n    ')},
    ${DEVICE_PEAK_COLS.map(peakSql).join(',\n    ')}`;
const MOUNT_COLS = Object.freeze(['agent', 'key', 'day', 'mount', ...MOUNT_DAILY_COLS.flatMap((c) => [`${c}_sum`, `${c}_n`, `${c}_max`]), 'size_bytes', 'used_bytes', 'last_ts']);
const MOUNT_UPSERT = `INSERT INTO usage_mount_daily (${MOUNT_COLS.join(',')}) VALUES (${MOUNT_COLS.map(() => '?').join(',')})
  ON CONFLICT(agent,key,day,mount) DO UPDATE SET ${MOUNT_DAILY_COLS.map((c) => `${sumSql(c)}, ${maxSql(`${c}_max`)}`).join(', ')},
    size_bytes=CASE WHEN excluded.last_ts >= IFNULL(last_ts,0) THEN excluded.size_bytes ELSE size_bytes END,
    used_bytes=CASE WHEN excluded.last_ts >= IFNULL(last_ts,0) THEN excluded.used_bytes ELSE used_bytes END,
    last_ts=MAX(IFNULL(last_ts,0),excluded.last_ts)`;

/** 시간 버킷(포탈 시각 기준 — 시간대 오프셋이 정시 단위라 UTC 정시와 같다) */
export const hourOf = (ts) => Math.floor((ts + OFF_MS) / HOUR_MS) * HOUR_MS - OFF_MS;

/** 5분 행 하나 → 롤업 한 줄의 값(합·개수·최대 · 피크). null 은 n 에 넣지 않는다. */
function rollVals(r, rolls) {
  const out = [];
  for (const { col } of rolls) { const v = n(r[col]); out.push(v ?? 0, v == null ? 0 : 1, v); }
  return out;
}
function peakVals(r, cols) {
  const out = [];
  for (const c of cols) { const v = n(r[`${c}_peak`]); out.push(v, v == null ? null : n(r[`${c}_peak_at`])); }
  return out;
}
const hasPeak = (r) => PEAK_COLS.some((c) => n(r[`${c}_peak`]) != null);

/** 행들을 기간 파일별로 나눈다. */
function groupBy(rows, family, tsOf) {
  const m = new Map();
  for (const r of rows) {
    const k = periodKeyOf(family, tsOf(r));
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}
/** 한 파일에 한 트랜잭션 — ⚠ 안에 await 가 없다. */
function txn(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; }
}

/**
 * 서버 행 적재(5분 원시 → 1시간 → 1일). 원시가 새로 들어간 행만 롤업한다(이중 계수 금지).
 * @param {Array} rows   usage.js 행(키·ts·지표·피크) — 이미 검증된 것
 * @param {string} agent
 * @param {{rollupFrom?:Set<number>}} [opt]
 * @returns {Promise<{ok:boolean, inserted:number, duplicates:number, errors:string[], insertedRows:Array}>}
 */
export async function writeServerRows(rows = [], agent = '', { rollup = true } = {}) {
  const res = { ok: true, inserted: 0, duplicates: 0, errors: [], insertedRows: [] };
  const valid = rows.filter((r) => String(r?.key || '').trim() && Number.isFinite(Number(r?.ts)));
  if (!valid.length) return res;
  for (const [k, list] of groupBy(valid, 'raw', (r) => Number(r.ts))) {
    await withPeriodFile('raw', k, { create: true }, (db) => {
      if (!db) { res.ok = false; res.errors.push(`${fileNameOf('raw', k)}: ${_failed.get(fileNameOf('raw', k))?.reason || '열기 실패'}`); return; }
      try {
        txn(db, () => {
          const st = prep(db, fileNameOf('raw', k), 'ins', RAW_INS);
          for (const r of list) {
            const vals = RAW_COLS.map((c) => {
              if (c === 'agent') return agent;
              if (c === 'key') return String(r.key).trim();
              if (c === 'ts') return Number(r.ts);
              if (c === 'name' || c === 'vcenter_id' || c === 'src' || c === 'peak_src') {
                const v = c === 'vcenter_id' ? r.vcenterId ?? r.vcenter_id : r[c];
                return c === 'peak_src' ? (v ? String(v) : null) : String(v ?? '');
              }
              return n(r[c]);
            });
            const out = st.run(...vals);
            if (Number(out?.changes)) { res.inserted += 1; res.insertedRows.push(r); } else res.duplicates += 1;
          }
        });
      } catch (e) { res.ok = false; res.errors.push(`${fileNameOf('raw', k)}: ${String(e?.message || e).slice(0, 160)}`); }
    });
  }
  if (rollup && res.insertedRows.length) await rollupServerRows(res.insertedRows, agent, res);
  return res;
}

/**
 * 마이그레이션 전용 — 예전 일 롤업 행을 연 파일의 사본 표(usage_daily_mig)로 옮긴다(INSERT OR IGNORE — 다시 돌려도 한 번만 들어간다).
 *   실시간 표(usage_daily)와 섞지 않는다: 두 표는 서로 다른 표본이라 읽을 때 같은 날끼리 더한다(db.js usageDaily).
 */
export async function writeDailyMigRows(rows = []) {
  const res = { ok: true, inserted: 0, duplicates: 0, errors: [] };
  const byYear = new Map();
  for (const r of rows) {
    const day = String(r?.day || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !String(r?.key || '').trim()) continue;
    const y = day.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(r);
  }
  const cols = ['agent', 'key', 'day', ...LEGACY_DAILY_COLS];
  const sql = `INSERT OR IGNORE INTO usage_daily_mig (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  for (const [y, list] of byYear) {
    await withPeriodFile('d1', y, { create: true }, (db) => {
      if (!db) { res.ok = false; res.errors.push(`${fileNameOf('d1', y)}: ${_failed.get(fileNameOf('d1', y))?.reason || '열기 실패'}`); return; }
      try {
        txn(db, () => {
          const st = prep(db, fileNameOf('d1', y), 'mig', sql);
          for (const r of list) {
            const out = st.run(...cols.map((c) => (c === 'agent' ? String(r.agent ?? '') : c === 'key' || c === 'day' || c === 'name' || c === 'vcenter_id' ? (r[c] == null ? (c === 'name' || c === 'vcenter_id' ? null : '') : String(r[c])) : r[c] === undefined ? null : r[c])));
            if (Number(out?.changes)) res.inserted += 1; else res.duplicates += 1;
          }
        });
      } catch (e) { res.ok = false; res.errors.push(`${fileNameOf('d1', y)}: ${String(e?.message || e).slice(0, 160)}`); }
    });
  }
  return res;
}

/** 한 기간 파일의 표 행 수(집계 하나 · 시간 조건) — 마이그레이션 대조용. 파일이 없으면 null. */
export async function countInPeriod(family, key, table, col, lo, hi) {
  return withPeriodFile(family, key, { create: false }, (db) => {
    if (!db) return null;
    return Number(db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${col} >= ? AND ${col} < ?`).get(lo, hi)?.c ?? 0);
  });
}

/** 5분 행 → 1시간·1일 롤업 upsert. 마이그레이션도 이 함수를 쓴다(같은 산수 — 코어는 하나). */
export async function rollupServerRows(rows, agent, res = { ok: true, errors: [] }, { hourly = true, daily = true, migKey = null, migRowid = null } = {}) {
  const fam = [];
  if (hourly) fam.push(['h1', H1_UPSERT, (r) => [agent, String(r.key).trim(), hourOf(Number(r.ts)), String(r.name || ''), String(r.vcenterId ?? r.vcenter_id ?? ''), 1, Number(r.ts),
    hasPeak(r) ? 1 : 0, r.peak_src ? String(r.peak_src) : null, ...rollVals(r, ROLL), ...peakVals(r, PEAK_COLS)]]);
  if (daily) fam.push(['d1', D1_UPSERT, (r) => [agent, String(r.key).trim(), dayKey(Number(r.ts)), String(r.name || ''), String(r.vcenterId ?? r.vcenter_id ?? ''), 1, Number(r.ts),
    hasPeak(r) ? 1 : 0, r.peak_src ? String(r.peak_src) : null, ...rollVals(r, D1_ROLL_ALL), ...peakVals(r, PEAK_COLS)]]);
  for (const [family, sql, valsOf] of fam) {
    for (const [k, list] of groupBy(rows, family, (r) => Number(r.ts))) {
      await withPeriodFile(family, k, { create: true }, (db) => {
        if (!db) { res.ok = false; res.errors.push(`${fileNameOf(family, k)}: ${_failed.get(fileNameOf(family, k))?.reason || '열기 실패'}`); return; }
        try {
          txn(db, () => {
            // 마이그레이션 경로: 이 파일의 커서보다 큰 원본 rowid 만(같은 트랜잭션에서 커서를 올린다 — 재개해도 한 번만 더한다).
            let cur = -1;
            if (migKey) cur = Number(db.prepare('SELECT v FROM _mig WHERE k=?').get(migKey)?.v ?? -1);
            const st = prep(db, fileNameOf(family, k), 'up', sql);
            let top = cur;
            for (const r of list) {
              if (migKey) { const rid = Number(r[migRowid]); if (!(rid > cur)) continue; if (rid > top) top = rid; }
              st.run(...valsOf(r));
            }
            if (migKey && top > cur) db.prepare('INSERT INTO _mig (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(migKey, top);
          });
        } catch (e) { res.ok = false; res.errors.push(`${fileNameOf(family, k)}: ${String(e?.message || e).slice(0, 160)}`); }
      });
    }
  }
  return res;
}

/**
 * 장치별 행 적재(5분 → 1시간). rows: `{ key, ts, kind:'disk'|'nic', dev, <DEVICE_COL>…, oper, <peak>_peak/_peak_at }`.
 * ⚠ 마운트는 여기 오지 않는다(일 1회 롤업만 — writeMountRows).
 */
export async function writeDeviceRows(rows = [], agent = '') {
  const res = { ok: true, inserted: 0, duplicates: 0, errors: [] };
  const valid = rows.filter((r) => r && String(r.key || '').trim() && Number.isFinite(Number(r.ts)) && (r.kind === 'disk' || r.kind === 'nic') && String(r.dev || '').trim());
  const ins = [];
  for (const [k, list] of groupBy(valid, 'dev', (r) => Number(r.ts))) {
    await withPeriodFile('dev', k, { create: true }, (db) => {
      if (!db) { res.ok = false; res.errors.push(`${fileNameOf('dev', k)}: ${_failed.get(fileNameOf('dev', k))?.reason || '열기 실패'}`); return; }
      try {
        txn(db, () => {
          const st = prep(db, fileNameOf('dev', k), 'ins', DEV_INS);
          for (const r of list) {
            const vals = DEV_COLS.map((c) => (c === 'agent' ? agent : c === 'key' ? String(r.key).trim() : c === 'ts' ? Number(r.ts)
              : c === 'kind' ? r.kind : c === 'dev' ? String(r.dev).slice(0, 64) : c === 'oper' ? (r.oper ? String(r.oper).slice(0, 16) : null) : n(r[c])));
            const out = st.run(...vals);
            if (Number(out?.changes)) { res.inserted += 1; ins.push(r); } else res.duplicates += 1;
          }
        });
      } catch (e) { res.ok = false; res.errors.push(`${fileNameOf('dev', k)}: ${String(e?.message || e).slice(0, 160)}`); }
    });
  }
  for (const [k, list] of groupBy(ins, 'dev1h', (r) => Number(r.ts))) {
    await withPeriodFile('dev1h', k, { create: true }, (db) => {
      if (!db) { res.ok = false; res.errors.push(`${fileNameOf('dev1h', k)}: 열기 실패`); return; }
      try {
        txn(db, () => {
          const st = prep(db, fileNameOf('dev1h', k), 'up', DEV1H_UPSERT);
          for (const r of list) {
            st.run(agent, String(r.key).trim(), r.kind, String(r.dev).slice(0, 64), hourOf(Number(r.ts)), 1, Number(r.ts),
              r.oper ? String(r.oper).slice(0, 16) : null, n(r.speed_bps),
              ...DEV_ROLL.flatMap((c) => { const v = n(r[c]); return [v ?? 0, v == null ? 0 : 1, v]; }), ...peakVals(r, DEVICE_PEAK_COLS));
          }
        });
      } catch (e) { res.ok = false; res.errors.push(`${fileNameOf('dev1h', k)}: ${String(e?.message || e).slice(0, 160)}`); }
    });
  }
  return res;
}

/** 마운트(공간·inode) — 일 롤업만(5분 원시 없음 · 설계 §9 B). rows: `{ key, ts, mount, used_pct, inode_pct, size_bytes, used_bytes }` */
export async function writeMountRows(rows = [], agent = '') {
  const res = { ok: true, upserted: 0, errors: [] };
  const valid = rows.filter((r) => r && String(r.key || '').trim() && Number.isFinite(Number(r.ts)) && String(r.mount || '').trim());
  for (const [k, list] of groupBy(valid, 'd1', (r) => Number(r.ts))) {
    await withPeriodFile('d1', k, { create: true }, (db) => {
      if (!db) { res.ok = false; res.errors.push(`${fileNameOf('d1', k)}: 열기 실패`); return; }
      try {
        txn(db, () => {
          const st = prep(db, fileNameOf('d1', k), 'mnt', MOUNT_UPSERT);
          for (const r of list) {
            st.run(agent, String(r.key).trim(), dayKey(Number(r.ts)), String(r.mount).slice(0, 256),
              ...MOUNT_DAILY_COLS.flatMap((c) => { const v = n(r[c]); return [v ?? 0, v == null ? 0 : 1, v]; }),
              n(r.size_bytes), n(r.used_bytes), Number(r.ts));
            res.upserted += 1;
          }
        });
      } catch (e) { res.ok = false; res.errors.push(`${fileNameOf('d1', k)}: ${String(e?.message || e).slice(0, 160)}`); }
    });
  }
  return res;
}

/* ════════════════════════ 조회 ════════════════════════ */
/**
 * 창에 걸리는 기간 파일을 차례로(오래된 것부터) 연다 — 상한(MONTH_FILES_PER_QUERY)을 넘으면 **최근 쪽**만 읽고 filesCapped.
 * 없는 파일·열기 실패는 missingPeriods(그 기간 없음) — 나머지로 계속한다.
 * @param {(db, key, range)=>any} fn  파일마다(동기 또는 async)
 */
export async function forEachPeriod(family, from, to, fn, { yieldMs = 15 } = {}) {
  let keys = periodsInWindow(family, from, to);
  const filesCapped = keys.length > MONTH_FILES_PER_QUERY ? keys.length - MONTH_FILES_PER_QUERY : 0;
  if (filesCapped) keys = keys.slice(-MONTH_FILES_PER_QUERY);
  const missingPeriods = [];
  const maybeYield = createYielder(yieldMs);
  for (const k of keys) {
    await withPeriodFile(family, k, { create: false }, async (db) => {
      if (!db) { const f = _failed.get(fileNameOf(family, k)); missingPeriods.push({ period: k, reason: f ? f.reason : 'none' }); return; }
      try { await fn(db, k, periodRange(family, k)); } catch (e) { missingPeriods.push({ period: k, reason: `조회 실패: ${String(e?.message || e).slice(0, 120)}` }); }
    });
    await maybeYield();
  }
  return { filesCapped, missingPeriods, periods: keys };
}

/** 5분 원시(서버). cols 는 상수 표 안의 이름만(외부 입력이 SQL 에 들어가지 않게 — 호출부가 화이트리스트로 거른다). */
export async function readRawRange({ agent = '', key, from, to, cols = null, limit = 20_000 } = {}) {
  const pick = cols ? ['ts', ...cols.filter((c) => RAW_COLS.includes(c) && c !== 'ts')] : null;
  const sel = pick ? pick.join(',') : '*';
  const rows = []; let truncated = false;
  const meta = await forEachPeriod('raw', from, to, (db) => {
    if (truncated) return;
    const got = db.prepare(`SELECT ${sel} FROM usage_history WHERE key=? AND agent=? AND ts>=? AND ts<=? ORDER BY ts LIMIT ?`).all(String(key), String(agent), from, to, limit + 1);
    for (const r of got) { if (rows.length >= limit) { truncated = true; break; } rows.push(r); }
  });
  return { rows, truncated, ...meta };
}
/** 1시간 롤업(서버). */
export async function readHourlyRange({ agent = '', key, from, to, limit = 20_000 } = {}) {
  const rows = []; let truncated = false;
  const meta = await forEachPeriod('h1', from, to, (db) => {
    if (truncated) return;
    const got = db.prepare('SELECT * FROM usage_hourly WHERE key=? AND agent=? AND h>=? AND h<=? ORDER BY h LIMIT ?').all(String(key), String(agent), hourOf(from), to, limit + 1);
    for (const r of got) { if (rows.length >= limit) { truncated = true; break; } rows.push(r); }
  });
  return { rows, truncated, ...meta };
}
/** 1일 롤업(서버) — 실시간 표(usage_daily)와 마이그레이션 사본(usage_daily_mig)을 따로 돌려준다(합치기는 호출부 — 출처 규칙이 다르다). */
export async function readDailyRange({ agent = '', key = '', from, to, withMig = true } = {}) {
  const live = []; const mig = [];
  const dFrom = dayKey(from); const dTo = dayKey(to);
  const meta = await forEachPeriod('d1', from, to, (db) => {
    const q = key
      ? ['SELECT * FROM usage_daily WHERE key=? AND agent=? AND day>=? AND day<=? ORDER BY day', [String(key), String(agent), dFrom, dTo]]
      : ['SELECT * FROM usage_daily WHERE agent=? AND day>=? AND day<=? ORDER BY day, key', [String(agent), dFrom, dTo]];
    for (const x of (db.prepare(q[0]).all(...q[1]))) live.push(x);   // 큰 배열 전개 push 금지(v2.603 — RangeError)
    if (withMig) {
      const qm = key
        ? ['SELECT * FROM usage_daily_mig WHERE key=? AND agent=? AND day>=? AND day<=? ORDER BY day', [String(key), String(agent), dFrom, dTo]]
        : ['SELECT * FROM usage_daily_mig WHERE agent=? AND day>=? AND day<=? ORDER BY day, key', [String(agent), dFrom, dTo]];
      for (const x of (db.prepare(qm[0]).all(...qm[1]))) mig.push(x);   // 큰 배열 전개 push 금지(v2.603 — RangeError)
    }
  });
  return { live, mig, ...meta };
}
/** 장치 5분 / 1시간. */
export async function readDeviceRange({ agent = '', key, kind, dev, from, to, res = '5m', limit = 20_000 } = {}) {
  const family = res === '1h' ? 'dev1h' : 'dev';
  const rows = []; let truncated = false;
  const meta = await forEachPeriod(family, from, to, (db) => {
    if (truncated) return;
    const sql = family === 'dev1h'
      ? 'SELECT * FROM usage_device_hourly WHERE agent=? AND key=? AND kind=? AND dev=? AND h>=? AND h<=? ORDER BY h LIMIT ?'
      : 'SELECT * FROM usage_device_history WHERE agent=? AND key=? AND kind=? AND dev=? AND ts>=? AND ts<=? ORDER BY ts LIMIT ?';
    const got = db.prepare(sql).all(String(agent), String(key), String(kind), String(dev), family === 'dev1h' ? hourOf(from) : from, to, limit + 1);
    for (const r of got) { if (rows.length >= limit) { truncated = true; break; } rows.push(r); }
  });
  return { rows, truncated, ...meta };
}
/** 마운트 일 롤업. */
export async function readMountDaily({ agent = '', key, mount = '', from, to } = {}) {
  const rows = [];
  const meta = await forEachPeriod('d1', from, to, (db) => {
    const q = mount
      ? ['SELECT * FROM usage_mount_daily WHERE agent=? AND key=? AND mount=? AND day>=? AND day<=? ORDER BY day', [String(agent), String(key), String(mount), dayKey(from), dayKey(to)]]
      : ['SELECT * FROM usage_mount_daily WHERE agent=? AND key=? AND day>=? AND day<=? ORDER BY day, mount', [String(agent), String(key), dayKey(from), dayKey(to)]];
    for (const x of (db.prepare(q[0]).all(...q[1]))) rows.push(x);   // 큰 배열 전개 push 금지(v2.603 — RangeError)
  });
  return { rows, ...meta };
}

/** 일 롤업 두 행(같은 agent·key·day — 서로 다른 표본 집합)을 합친다(순수). 평균은 합·개수로, 최대·피크는 큰 쪽. */
export function mergeDailyRows(a, b) {
  if (!a) return b; if (!b) return a;
  const out = { ...a };
  for (const k of Object.keys(b)) {
    if (k.endsWith('_sum')) out[k] = (n(a[k]) ?? 0) + (n(b[k]) ?? 0);
    else if (k.endsWith('_n') || k === 'samples' || k === 'peak_samples') out[k] = (n(a[k]) ?? 0) + (n(b[k]) ?? 0);
    else if (k.endsWith('_max')) { const x = n(a[k]); const y = n(b[k]); out[k] = x == null ? y : y == null ? x : Math.max(x, y); }
    else if (k.endsWith('_peak')) {
      const x = n(a[k]); const y = n(b[k]);
      if (y != null && (x == null || y > x)) { out[k] = y; out[`${k}_at`] = b[`${k}_at`] ?? null; }
    } else if (k === 'last_ts') out[k] = Math.max(n(a[k]) ?? 0, n(b[k]) ?? 0) || null;
    else if (k.endsWith('_peak_at')) { /* 위에서 함께 */ }
    else if (out[k] == null) out[k] = b[k];
  }
  // 이름·법인은 더 최근 표본 쪽
  if ((n(b.last_ts) ?? 0) > (n(a.last_ts) ?? 0)) { out.name = b.name ?? a.name; out.vcenter_id = b.vcenter_id ?? a.vcenter_id; }
  return out;
}

/* ════════════════════════ 행 수(진단) ════════════════════════ */
let _counts = null;
const COUNT_CACHE_MS = Math.max(0, Number(process.env.BMUSAGE_COUNT_CACHE_MS) || 60_000);
/**
 * 가족별 파일 수·행 수·바이트. COUNT 는 파일마다 **집계 하나짜리 문장**이고 짧게 캐시한다(캐시임을 숨기지 않는다 — countsAt).
 * ⚠ 화면 로드마다 돈다 — 파일이 많아도 각 COUNT 는 커버링 인덱스 하나다(db.js dbStatus 와 같은 판단).
 */
export async function monthStoreStatus({ force = false } = {}) {
  if (!force && _counts && Date.now() - _counts.at < COUNT_CACHE_MS) return _counts.v;
  const out = {};
  for (const fam of Object.keys(FAMILIES)) {
    const files = listFamilyFiles(fam);
    let rows = 0; let bytes = 0;
    for (const f of files) {
      try { bytes += fs.statSync(path.join(dbDir(), f.name)).size; } catch { /* */ }
      const db = await openPeriodFile(fam, f.key, { create: false });
      if (!db) continue;
      try { rows += Number(db.prepare(`SELECT COUNT(*) c FROM ${FAMILIES[fam].table}`).get()?.c ?? 0); } catch { /* */ }
    }
    out[fam] = { files: files.length, first: files[0]?.key ?? null, last: files.at(-1)?.key ?? null, rows, bytes };
  }
  _counts = { at: Date.now(), v: { ...out, countsAt: Date.now(), failed: failedFiles().slice(0, 8) } };
  return _counts.v;
}
export function invalidateMonthCounts() { _counts = null; }

/* ════════════════════════ 보존 — 파일 삭제 + 파일 안 잔여 청크 ════════════════════════ */
let _pruning = null;
/** 가족별 보존 표의 시간열(잔여 청크 DELETE 조건). */
const RESIDUAL = Object.freeze({
  raw: [['usage_history', 'ts']],
  h1: [['usage_hourly', 'h']],
  d1: [['usage_daily', 'day'], ['usage_daily_mig', 'day'], ['usage_mount_daily', 'day']],
  dev: [['usage_device_history', 'ts']],
  dev1h: [['usage_device_hourly', 'h']],
});
/**
 * 보존 집행. keepDays: { raw, h1, d1, dev, dev1h }(일). paused: 이 가족은 건너뛴다(마이그레이션 중 원시 — 대조 전에 지우지 않게).
 *  ① 기간 끝 ≤ 기준(now − 보존) 인 파일은 **통째로 지운다**(본체 + -wal/-shm). 쓰는 중(pin)인 파일은 다음 주기로 미룬다.
 *  ② 기준이 기간 안에 걸린 파일(경계 기간)만 그 앞부분을 청크로 지운다(util/chunkedPrune — 상한·양보).
 * 진행 중이면 같은 작업을 공유한다(겹치지 않게).
 */
export async function pruneMonthFiles({ keepDays = {}, now = Date.now(), paused = [] } = {}) {
  if (_pruning) return _pruning;
  _pruning = (async () => {
    const out = { ok: true, filesDeleted: [], residualDeleted: 0, deferred: [], errors: [], done: true };
    for (const fam of Object.keys(FAMILIES)) {
      if (paused.includes(fam)) { out.deferred.push(`${fam}:paused`); continue; }
      const days = n(keepDays[FAMILIES[fam].keep]);
      if (days == null || days <= 0) continue;
      const cut = now - days * DAY_MS;
      for (const f of listFamilyFiles(fam)) {
        const [start, end] = periodRange(fam, f.key);
        if (end <= cut) {
          if (!closePeriodFile(fam, f.key)) { out.deferred.push(f.name); continue; }
          try {
            for (const x of ['', '-wal', '-shm']) { try { fs.unlinkSync(path.join(dbDir(), `${f.name}${x}`)); } catch (e) { if (e?.code !== 'ENOENT') throw e; } }
            out.filesDeleted.push(f.name);
          } catch (e) { out.ok = false; out.errors.push(`${f.name}: ${String(e?.message || e).slice(0, 120)}`); }
        } else if (start < cut) {
          await withPeriodFile(fam, f.key, { create: false }, async (db) => {
            if (!db) return;
            for (const [table, col] of RESIDUAL[fam]) {
              const arg = col === 'day' ? dayKey(cut) : cut;
              try {
                const r = await chunkedDelete(db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${col} < ? LIMIT ?)`), [arg], { label: `bmusage.${table}` });
                out.residualDeleted += r.deleted;
                if (!r.done) out.done = false;
              } catch (e) { out.ok = false; out.errors.push(`${f.name}.${table}: ${String(e?.message || e).slice(0, 120)}`); }
            }
          });
        }
      }
    }
    if (out.filesDeleted.length || out.residualDeleted) _counts = null;
    return out;
  })().finally(() => { _pruning = null; });
  return _pruning;
}
