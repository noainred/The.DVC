/**
 * bmstor/ioDb.js — 베어메탈 디스크 I/O **시계열 전용 DB**(v2.915 — 설계 docs/design/bm-san-compare §4.5).
 *
 * 파일: `config.dbDir || CONFIG_DIR` 아래 `bmstor-io.db`(`insights/dbLocation.js MIGRATABLE` 등재). 12시간 용량 이력(`bmstor-history.db`)과
 * 따로 두는 이유 — 보존 · 정리 주기가 다르다(하루 2회 · 5년 vs 수집 주기마다 · 수 일~2년 + 집계 표).
 *
 * ── 행 수를 먼저 계산했다(CLAUDE.md 규칙) ──────────────────────────────────────────
 *  원시: 서버 1,000대 × 주기 1분(최악) × 3일 = 432만 행 · 기본 주기 10분이면 43만 행.
 *  15분 표: 1,000대 × 96/일 × 31일 = 298만 행. 1시간 표: 1,000대 × 24 × 730일 = 1,752만 행 — SAN 포트 사용량 DB(운영 약 1억 행 추정)보다 작다.
 *
 * 표
 *  io_raw  : 서버 × 수집 1회. avg_* = 직전 행과의 **카운터 차분 평균**(구간 전체의 진짜 평균 · 첫 행 · 재부팅 · 공백 > 주기×2 는 null),
 *            inst_* = 수집 시점 2초 표본(피크의 하한), 누적 카운터 원본.
 *  io_last : 서버별 마지막 카운터(차분용 — '키별 최신값' 을 GROUP BY + MAX 로 만들지 않는다 · 재시작 뒤 되살린다).
 *  io_r15 / io_r1h : 적재 때 바로 올리는 집계(n · n_avg · sum_avg · sum_rd · sum_wr · max_inst · max_rd · max_wr · max_busy). 백필 없음 — 새 DB.
 *
 * v2.962(비교 세트): IOPS · 응답 시간 열을 더했다 — 원시 avg_iops · inst_iops · inst_lat · d_ios · d_ticks(구간 차분 — 응답 시간 = d_ticks ÷ d_ios 를
 *   **합으로** 내야 여러 칸 · 여러 서버를 묶을 때 I/O 가중 평균이 된다) · 누적 rd_ios · wr_ios · rw_ticks, 집계 n_iops · sum_iops · max_iops · sum_dios · sum_dticks · max_lat ·
 *   n_abusy · sum_abusy(구간 평균 바쁨). **v2.956 으로 만든 DB 는 열을 덧붙인다**(ensureColumns — ALTER TABLE ADD COLUMN · 이미 있으면 건너뜀 · 기본값 0/NULL).
 *   예전 행의 새 열은 비어 있고(n_* = 0) 화면은 그 칸을 '—' 로 둔다(0 이 아니다).
 *
 * v2.971(사용자 질문 2026-11-11 — 화면의 피크 < 평균에서 찾은 결함):
 *  · io_last.disks_json — **디스크별 누적 카운터**(diskstats.intervalAvg 가 두 수집 모두에 있는 디스크끼리만 뺀다 · 합계 하나로 빼면 디스크 구성이 바뀐 구간이 튀었다).
 *  · 구간 평균 바쁨은 이제 **가장 바쁜 디스크**(원시 avg_busy_disk · 집계 n_dbusy · sum_dbusy). 예전 avg_busy · n_abusy · sum_abusy 는 ‘모든 디스크 io_ms 합 ÷ 경과’
 *    (디스크 수만큼 부푼 값)라 **읽지 않는다** — 예전 행의 바쁨 평균은 '—'.
 *  · 집계 표의 피크(max_*)는 **2초 표본과 그 구간 평균 중 큰 값**으로 올린다 — 구간의 실제 최고치는 그 구간 평균보다 작을 수 없다(2초 표본만으로는
 *    한가한 순간에 걸려 피크 < 평균이 나왔다). 예전 행은 읽을 때(compareSet · ioSeries) 같은 규칙으로 올린다.
 *
 * perf-db.md 규약: 결과 묶음 하나 = 트랜잭션 1개 · `ts`/`b` 단독 인덱스 · prune 은 `(++tick % N) === 0`(첫 호출 금지) + 청크 ·
 *   open 은 진행 중인 시도 공유 · MIN·MAX 한 문장에 둘 금지 · 집계 함수는 한 문장에 하나.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { openSqlite, withOpenCleanup, createLockRetry } from '../util/sqliteOpen.js';
import { chunkedDelete, createPruneFlight } from '../util/chunkedPrune.js';
import { numOrNull } from '../util/numOrNull.js';
import { G15, G1H } from '../sanswitch/perfRollup.js';
import { intervalAvg } from './diskstats.js';
import { sanitizeDiskMap } from './diskMap.js';

const DB_PATH = () => process.env.BMSTOR_IO_DB_PATH || path.join(config.dbDir || config.configDir, 'bmstor-io.db');
const DAY = 86_400_000;
const days = (raw, dflt, { min = 1, max = 3650 } = {}) => {
  const n = numOrNull(raw);
  return n == null ? dflt : Math.max(min, Math.min(max, Math.round(n)));
};
/** 보존(일) — env(부를 때 읽는다 — 테스트가 바꿀 수 있게). 원시 3일 · 15분 집계 31일 · 1시간 집계 730일. */
export function ioRetention() {
  return {
    rawDays: days(process.env.BMSTOR_IO_RAW_DAYS, 3),      // 원시 표(서버 × 수집 1회) 보존 일수
    r15Days: days(process.env.BMSTOR_IO_R15_DAYS, 31),     // 15분 집계 표 보존 일수
    r1hDays: days(process.env.BMSTOR_IO_R1H_DAYS, 730),    // 1시간 집계 표 보존 일수
  };
}

let x = null;          // { db, st, path }
let ready = null;
let initError = null;
const lockRetry = createLockRetry();
let tick = 0;
const _last = new Map();   // server_id → { ts, counters } (차분용 캐시 — io_last 표의 사본)

const ROLLUP_COLS = 'server_id, b, n, n_avg, sum_avg, sum_rd, sum_wr, max_inst, max_rd, max_wr, max_busy, last_ts, n_iops, sum_iops, max_iops, sum_dios, sum_dticks, max_lat, n_abusy, sum_abusy, n_dbusy, sum_dbusy';
const rollupUpsert = (table) => `INSERT INTO ${table} (${ROLLUP_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(server_id, b) DO UPDATE SET
    n = ${table}.n + excluded.n, n_avg = ${table}.n_avg + excluded.n_avg, sum_avg = ${table}.sum_avg + excluded.sum_avg,
    sum_rd = ${table}.sum_rd + excluded.sum_rd, sum_wr = ${table}.sum_wr + excluded.sum_wr,
    max_inst = MAX(COALESCE(${table}.max_inst, -1), COALESCE(excluded.max_inst, -1)),
    max_rd = MAX(COALESCE(${table}.max_rd, -1), COALESCE(excluded.max_rd, -1)),
    max_wr = MAX(COALESCE(${table}.max_wr, -1), COALESCE(excluded.max_wr, -1)),
    max_busy = MAX(COALESCE(${table}.max_busy, -1), COALESCE(excluded.max_busy, -1)),
    last_ts = MAX(${table}.last_ts, excluded.last_ts),
    n_iops = ${table}.n_iops + excluded.n_iops, sum_iops = ${table}.sum_iops + excluded.sum_iops,
    max_iops = MAX(COALESCE(${table}.max_iops, -1), COALESCE(excluded.max_iops, -1)),
    sum_dios = ${table}.sum_dios + excluded.sum_dios, sum_dticks = ${table}.sum_dticks + excluded.sum_dticks,
    max_lat = MAX(COALESCE(${table}.max_lat, -1), COALESCE(excluded.max_lat, -1)),
    n_abusy = ${table}.n_abusy + excluded.n_abusy, sum_abusy = ${table}.sum_abusy + excluded.sum_abusy,
    n_dbusy = ${table}.n_dbusy + excluded.n_dbusy, sum_dbusy = ${table}.sum_dbusy + excluded.sum_dbusy`;
/** v2.962 덧붙일 열(표 → [열, 정의]) — v2.956 DB 에 ALTER TABLE ADD COLUMN(이미 있으면 건너뜀). NOT NULL 열은 기본값이 있어야 한다(SQLite 규칙). */
const ADD_ROLLUP = [['n_iops', 'INTEGER NOT NULL DEFAULT 0'], ['sum_iops', 'REAL NOT NULL DEFAULT 0'], ['max_iops', 'REAL'], ['sum_dios', 'REAL NOT NULL DEFAULT 0'],
  ['sum_dticks', 'REAL NOT NULL DEFAULT 0'], ['max_lat', 'REAL'], ['n_abusy', 'INTEGER NOT NULL DEFAULT 0'], ['sum_abusy', 'REAL NOT NULL DEFAULT 0'],
  // v2.971 — 구간 평균 바쁨(가장 바쁜 디스크). n_abusy · sum_abusy(모든 디스크 합)는 더 쓰지 않는다.
  ['n_dbusy', 'INTEGER NOT NULL DEFAULT 0'], ['sum_dbusy', 'REAL NOT NULL DEFAULT 0']];
export const ADD_COLUMNS = Object.freeze({
  io_raw: [['avg_iops', 'REAL'], ['inst_iops', 'REAL'], ['inst_lat', 'REAL'], ['d_ios', 'INTEGER'], ['d_ticks', 'INTEGER'], ['rd_ios', 'INTEGER'], ['wr_ios', 'INTEGER'], ['rw_ticks', 'INTEGER'],
    ['avg_busy_disk', 'REAL']],                       // v2.971 — 구간 평균 바쁨(가장 바쁜 디스크)
  io_last: [['rd_ios', 'INTEGER'], ['wr_ios', 'INTEGER'], ['rw_ticks', 'INTEGER'], ['disks_json', 'TEXT'], ['disks_ts', 'INTEGER'], ['n_disks', 'INTEGER']],   // v2.971 — 디스크별 누적 카운터(JSON) · 그 맵을 쓴 수집 ts(낡은 맵 판정) · 합계가 더한 디스크 수
  io_r15: ADD_ROLLUP, io_r1h: ADD_ROLLUP,
});
/** 없는 열만 덧붙인다(PRAGMA table_info 로 확인 — 순수하게 이름만 본다). 되돌림: 덧붙인 열 수. */
export function ensureColumns(db, spec = ADD_COLUMNS) {
  let added = 0;
  for (const [table, cols] of Object.entries(spec)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name)));
    for (const [name, def] of cols) {
      if (have.has(name)) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
      added += 1;
    }
  }
  return added;
}
const rollupTable = (table) => `
  CREATE TABLE IF NOT EXISTS ${table} (
    server_id TEXT NOT NULL, b INTEGER NOT NULL,          -- b = 버킷 시작 시각(ms)
    n INTEGER NOT NULL, n_avg INTEGER NOT NULL, sum_avg REAL NOT NULL, sum_rd REAL NOT NULL, sum_wr REAL NOT NULL,
    max_inst INTEGER, max_rd INTEGER, max_wr INTEGER, max_busy REAL, last_ts INTEGER NOT NULL,
    PRIMARY KEY (server_id, b)
  );
  CREATE INDEX IF NOT EXISTS idx_${table}_b ON ${table} (b);`;

function prepare(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS io_raw (
      server_id TEXT NOT NULL, ts INTEGER NOT NULL, name TEXT NOT NULL DEFAULT '',
      avg_rd INTEGER, avg_wr INTEGER, avg_busy REAL,
      inst_rd INTEGER, inst_wr INTEGER, busy REAL,
      rd_sectors INTEGER, wr_sectors INTEGER, io_ms INTEGER, uptime REAL, disks INTEGER,
      PRIMARY KEY (server_id, ts)
    );
    CREATE INDEX IF NOT EXISTS idx_io_raw_ts ON io_raw (ts);
    CREATE TABLE IF NOT EXISTS io_last (
      server_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, rd_sectors INTEGER, wr_sectors INTEGER, io_ms INTEGER, uptime REAL
    );
    ${rollupTable('io_r15')}
    ${rollupTable('io_r1h')}
  `);
  ensureColumns(db);   // v2.962 — 새 DB 도 같은 경로로 열을 덧붙인다(CREATE 문은 v2.956 모양 그대로 — 두 갈래를 만들지 않는다)
  const rollupSel = (table) => db.prepare(`SELECT b, n, n_avg, sum_avg, sum_rd, sum_wr, max_inst, max_rd, max_wr, max_busy,
    n_iops, sum_iops, max_iops, sum_dios, sum_dticks, max_lat, n_dbusy, sum_dbusy FROM ${table} WHERE server_id = ? AND b >= ? AND b <= ? ORDER BY b`);
  // 순위(막대 비교)용 — 집계 함수는 **한 문장에 하나**(v2.550.3 규약). 세 문장을 같은 범위로 돈다.
  const rankSel = (table) => ({
    sum: db.prepare(`SELECT server_id, SUM(sum_avg) AS v FROM ${table} WHERE b >= ? AND b <= ? GROUP BY server_id`),
    n: db.prepare(`SELECT server_id, SUM(n_avg) AS v FROM ${table} WHERE b >= ? AND b <= ? GROUP BY server_id`),
    peak: db.prepare(`SELECT server_id, MAX(max_inst) AS v FROM ${table} WHERE b >= ? AND b <= ? GROUP BY server_id`),
    sumRd: db.prepare(`SELECT server_id, SUM(sum_rd) AS v FROM ${table} WHERE b >= ? AND b <= ? GROUP BY server_id`),
    sumWr: db.prepare(`SELECT server_id, SUM(sum_wr) AS v FROM ${table} WHERE b >= ? AND b <= ? GROUP BY server_id`),
    peakRd: db.prepare(`SELECT server_id, MAX(max_rd) AS v FROM ${table} WHERE b >= ? AND b <= ? GROUP BY server_id`),
    peakWr: db.prepare(`SELECT server_id, MAX(max_wr) AS v FROM ${table} WHERE b >= ? AND b <= ? GROUP BY server_id`),
  });
  return {
    insRaw: db.prepare(`INSERT OR IGNORE INTO io_raw (server_id, ts, name, avg_rd, avg_wr, avg_busy, inst_rd, inst_wr, busy, rd_sectors, wr_sectors, io_ms, uptime, disks,
        avg_iops, inst_iops, inst_lat, d_ios, d_ticks, rd_ios, wr_ios, rw_ticks, avg_busy_disk)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    upLast: db.prepare(`INSERT INTO io_last (server_id, ts, rd_sectors, wr_sectors, io_ms, uptime, rd_ios, wr_ios, rw_ticks, disks_json, disks_ts, n_disks) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(server_id) DO UPDATE SET ts=excluded.ts, rd_sectors=excluded.rd_sectors, wr_sectors=excluded.wr_sectors, io_ms=excluded.io_ms, uptime=excluded.uptime,
        rd_ios=excluded.rd_ios, wr_ios=excluded.wr_ios, rw_ticks=excluded.rw_ticks, disks_json=excluded.disks_json, disks_ts=excluded.disks_ts, n_disks=excluded.n_disks
      WHERE excluded.ts > io_last.ts`),
    getLast: db.prepare('SELECT ts, rd_sectors, wr_sectors, io_ms, uptime, rd_ios, wr_ios, rw_ticks, disks_json, disks_ts, n_disks FROM io_last WHERE server_id = ?'),
    up15: db.prepare(rollupUpsert('io_r15')),
    up1h: db.prepare(rollupUpsert('io_r1h')),
    raw: db.prepare(`SELECT ts, avg_rd, avg_wr, avg_busy_disk, inst_rd, inst_wr, busy, avg_iops, inst_iops, inst_lat, d_ios, d_ticks FROM io_raw WHERE server_id = ? AND ts >= ? AND ts <= ? ORDER BY ts`),
    r15: rollupSel('io_r15'), r1h: rollupSel('io_r1h'),
    rank15: rankSel('io_r15'), rank1h: rankSel('io_r1h'),
    rankRaw: {
      sum: db.prepare('SELECT server_id, SUM(avg_rd + avg_wr) AS v FROM io_raw WHERE ts >= ? AND ts <= ? AND avg_rd IS NOT NULL GROUP BY server_id'),
      n: db.prepare('SELECT server_id, COUNT(*) AS v FROM io_raw WHERE ts >= ? AND ts <= ? AND avg_rd IS NOT NULL GROUP BY server_id'),
      // v2.971(반증 F7): 원시 순위의 피크도 행마다 max(2초 표본, 구간 평균) — 선 차트 피크와 같은 규칙(스칼라 MAX 는 NULL 이면 NULL — -1 로 채운다 · 집계 함수는 하나).
      peak: db.prepare('SELECT server_id, MAX(MAX(COALESCE(inst_rd + inst_wr, -1), COALESCE(avg_rd + avg_wr, -1))) AS v FROM io_raw WHERE ts >= ? AND ts <= ? GROUP BY server_id'),
      sumRd: db.prepare('SELECT server_id, SUM(avg_rd) AS v FROM io_raw WHERE ts >= ? AND ts <= ? AND avg_rd IS NOT NULL GROUP BY server_id'),
      sumWr: db.prepare('SELECT server_id, SUM(avg_wr) AS v FROM io_raw WHERE ts >= ? AND ts <= ? AND avg_wr IS NOT NULL GROUP BY server_id'),
      peakRd: db.prepare('SELECT server_id, MAX(MAX(COALESCE(inst_rd, -1), COALESCE(avg_rd, -1))) AS v FROM io_raw WHERE ts >= ? AND ts <= ? GROUP BY server_id'),
      peakWr: db.prepare('SELECT server_id, MAX(MAX(COALESCE(inst_wr, -1), COALESCE(avg_wr, -1))) AS v FROM io_raw WHERE ts >= ? AND ts <= ? GROUP BY server_id'),
    },
    measured15: db.prepare('SELECT DISTINCT server_id FROM io_r15 WHERE b >= ? AND b <= ?'),
    measured1h: db.prepare('SELECT DISTINCT server_id FROM io_r1h WHERE b >= ? AND b <= ?'),
    measuredRaw: db.prepare('SELECT DISTINCT server_id FROM io_raw WHERE ts >= ? AND ts <= ?'),
    maxTs: db.prepare('SELECT MAX(ts) AS v FROM io_raw'),
    minTs: db.prepare('SELECT MIN(ts) AS v FROM io_raw'),
    pruneRaw: db.prepare('DELETE FROM io_raw WHERE rowid IN (SELECT rowid FROM io_raw WHERE ts < ? LIMIT ?)'),
    prune15: db.prepare('DELETE FROM io_r15 WHERE rowid IN (SELECT rowid FROM io_r15 WHERE b < ? LIMIT ?)'),
    prune1h: db.prepare('DELETE FROM io_r1h WHERE rowid IN (SELECT rowid FROM io_r1h WHERE b < ? LIMIT ?)'),
  };
}

async function open() {
  if (x) return x;
  if (initError) return null;
  if (!ready && lockRetry.blocked()) return null;
  if (!ready) {
    ready = (async () => withOpenCleanup(async () => {
      // eslint-disable-next-line import/no-unresolved
      const { DatabaseSync } = await import('node:sqlite');
      const p = DB_PATH();
      fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
      const db = openSqlite(new DatabaseSync(p));
      const st = prepare(db);
      try { fs.chmodSync(p, 0o600); } catch { /* best effort */ }
      lockRetry.ok();
      x = { db, st, path: p };
      return x;
    }))().catch((e) => { if (lockRetry.onFail(e)) { ready = null; return null; } initError = e; return null; });
  }
  return ready;
}

const int = (v) => { const n = numOrNull(v); return n == null ? null : Math.round(n); };
const real = (v) => { const n = numOrNull(v); return n == null ? null : n; };
const alignDown = (t, g) => Math.floor(t / g) * g;

/** io_last.disks_json → 디스크별 맵(못 읽으면 null — 다음 구간은 '모름'(합계 ↔ 디스크별 전환과 같은 처리)). 쓸 때와 같은 상한 · 같은 정제. */
const _diskMapCache = new Map();
function diskMapOf(json) {
  if (json == null || json === '') return null;
  const k = String(json);
  if (_diskMapCache.has(k)) return _diskMapCache.get(k);
  let m = null;
  try { m = sanitizeDiskMap(JSON.parse(k)); } catch { m = null; }
  _diskMapCache.clear(); _diskMapCache.set(k, m);   // 한 칸짜리 — 같은 행을 두 번 풀지 않으려는 것뿐(무한히 쌓지 않는다)
  return m;
}

function lastOf(h, serverId) {
  if (_last.has(serverId)) return _last.get(serverId);
  const r = h.st.getLast.get(serverId);
  const v = r ? { ts: Number(r.ts), counters: { rdSectors: Number(r.rd_sectors), wrSectors: Number(r.wr_sectors), ioMs: Number(r.io_ms), uptimeSec: r.uptime == null ? null : Number(r.uptime),
    ...(r.rd_ios != null && r.wr_ios != null && r.rw_ticks != null ? { rdIos: Number(r.rd_ios), wrIos: Number(r.wr_ios), rwTicks: Number(r.rw_ticks) } : {}),
    // v2.971(반증 F2): 맵은 그 맵을 쓴 수집(disks_ts)이 지금 행(ts)과 같을 때만 — 구판으로 내렸다 올리면 구판이 ts · 합계만 바꾸고 맵은 옛것으로 남는다.
    ...(r.disks_ts != null && Number(r.disks_ts) === Number(r.ts) && diskMapOf(r.disks_json) ? { disks: diskMapOf(r.disks_json) } : {}),
    ...(r.n_disks != null ? { nDisks: Number(r.n_disks) } : {}) } } : null;
  _last.set(serverId, v);
  return v;
}

/**
 * 결과 묶음 적재(트랜잭션 1개). rows: [{ serverId, name, ts, io }] — io 는 diskstats.ioRate 의 모양(counters 포함).
 * intervalMs = 수집 주기(공백 판정 = ×2). 되돌림: { ok, written, skipped }.
 */
export async function recordIoSamples(rows, { intervalMs = 600_000 } = {}) {
  const h = await open();
  if (!h) return { ok: false, written: 0, reason: initError ? String(initError.message || initError).slice(0, 200) : (lockRetry.note() || 'node:sqlite 없음') };
  const maxGapMs = Math.max(120_000, (Number(intervalMs) || 600_000) * 2);
  let written = 0; let skipped = 0;
  h.db.exec('BEGIN');
  try {
    for (const r of Array.isArray(rows) ? rows : []) {
      const id = String(r?.serverId || '');
      const io = r?.io;
      const ts = int(r?.ts);
      if (!id || !io || ts == null || !io.counters) { skipped += 1; continue; }
      // nDisks — 합계 카운터가 더한 디스크 수(2초 표본이 비교한 수). 구버전 엣지(합계 기준)에서 디스크 집합이 바뀐 구간을 거른다(반증 F1).
      const cur = { ts, counters: { ...io.counters, ...(int(io.disks) != null ? { nDisks: int(io.disks) } : {}) } };
      const prev = lastOf(h, id);
      const avg = prev && prev.ts < ts ? intervalAvg(prev, cur, { maxGapMs }) : null;
      const instRd = int(io.readBps); const instWr = int(io.writeBps); const busy = real(io.busyPct);
      // v2.962: IOPS · 응답 시간 — 2초 표본(inst) · 구간 차분(avg · d_ios · d_ticks). 응답 시간 평균은 d_ticks ÷ d_ios 를 읽을 때 합으로 낸다.
      const instIops = real(io.iops); const instLat = real(io.latMs);
      const c = io.counters;
      const dIos = avg && avg.dIos != null ? int(avg.dIos) : null; const dTicks = avg && avg.dTicks != null ? int(avg.dTicks) : null;
      const busyDisk = avg ? real(avg.avgBusyPct) : null;   // v2.971 — 가장 바쁜 디스크의 구간 평균(합계 기준 구간이면 null)
      const res = h.st.insRaw.run(id, ts, String(r.name || '').slice(0, 200),
        avg ? avg.avgReadBps : null, avg ? avg.avgWriteBps : null, null,   // avg_busy(모든 디스크 합 — v2.970 까지)는 더 쓰지 않는다
        instRd, instWr, busy,
        int(c.rdSectors), int(c.wrSectors), int(c.ioMs), real(c.uptimeSec), int(io.disks),
        avg ? real(avg.avgIops) : null, instIops, instLat, dIos, dTicks, int(c.rdIos), int(c.wrIos), int(c.rwTicks), busyDisk);
      if (!res || !res.changes) { skipped += 1; continue; }   // 같은 ts 재적재(중복 회신)는 무시
      const diskJson = c.disks && typeof c.disks === 'object' ? JSON.stringify(c.disks) : null;
      h.st.upLast.run(id, ts, int(c.rdSectors), int(c.wrSectors), int(c.ioMs), real(c.uptimeSec), int(c.rdIos), int(c.wrIos), int(c.rwTicks), diskJson, diskJson ? ts : null, int(io.disks));
      if (!prev || prev.ts < ts) _last.set(id, cur);
      const inst = instRd != null && instWr != null ? instRd + instWr : null;
      const hasIops = !!(avg && avg.avgIops != null);
      const hasLat = dIos != null && dTicks != null && dIos > 0;
      // v2.971: 피크 = 2초 표본과 구간 평균 중 큰 값(구간의 실제 최고치는 구간 평균보다 작을 수 없다). 한쪽이 없으면 있는 쪽.
      const up = (a, b) => (a == null ? (b == null ? null : b) : b == null ? a : Math.max(a, b));
      const pkInst = up(inst, avg ? avg.avgReadBps + avg.avgWriteBps : null);
      const pkRd = up(instRd, avg ? avg.avgReadBps : null); const pkWr = up(instWr, avg ? avg.avgWriteBps : null);
      const pkIops = up(instIops, hasIops ? avg.avgIops : null);
      const pkLat = up(instLat, hasLat ? Math.round((dTicks / dIos) * 100) / 100 : null);
      const pkBusy = up(busy, busyDisk);
      const args = (g) => [id, alignDown(ts, g), 1, avg ? 1 : 0, avg ? avg.avgReadBps + avg.avgWriteBps : 0, avg ? avg.avgReadBps : 0, avg ? avg.avgWriteBps : 0, pkInst, pkRd, pkWr, pkBusy, ts,
        hasIops ? 1 : 0, hasIops ? avg.avgIops : 0, pkIops, hasLat ? dIos : 0, hasLat ? dTicks : 0, pkLat, 0, 0, busyDisk != null ? 1 : 0, busyDisk != null ? busyDisk : 0];
      h.st.up15.run(...args(G15));
      h.st.up1h.run(...args(G1H));
      written += 1;
    }
    h.db.exec('COMMIT');
  } catch (e) {
    try { h.db.exec('ROLLBACK'); } catch { /* */ }
    return { ok: false, written: 0, reason: String(e.message || e).slice(0, 200) };
  }
  return { ok: true, written, skipped };
}

const clean = (v) => (v == null || Number(v) < 0 ? null : Number(v));   // 집계 표의 -1(없음) → null

/** 원시 행(한 서버 · 기간). 읽기 · 쓰기 · 합계를 모두 준다(지표 선택은 호출부). v2.962: IOPS · 응답 시간(d_ios · d_ticks 합으로) · 구간 평균 바쁨. */
export async function ioRawRows(serverId, from, to) {
  const h = await open();
  if (!h) return null;
  return h.st.raw.all(String(serverId), int(from), int(to)).map((r) => ({
    ts: Number(r.ts),
    avgRead: clean(r.avg_rd), avgWrite: clean(r.avg_wr), avgTotal: r.avg_rd == null || r.avg_wr == null ? null : Number(r.avg_rd) + Number(r.avg_wr),
    instRead: clean(r.inst_rd), instWrite: clean(r.inst_wr), instTotal: r.inst_rd == null || r.inst_wr == null ? null : Number(r.inst_rd) + Number(r.inst_wr),
    busy: clean(r.busy), avgBusy: clean(r.avg_busy_disk),   // v2.971 — 가장 바쁜 디스크(예전 avg_busy = 모든 디스크 합은 읽지 않는다)
    avgIops: clean(r.avg_iops), instIops: clean(r.inst_iops), instLat: clean(r.inst_lat),
    dIos: r.d_ios == null ? null : Number(r.d_ios), dTicks: r.d_ticks == null ? null : Number(r.d_ticks),
  }));
}

/** 집계 표 행(한 서버 · 기간 · 'r15'|'r1h'). b 는 버킷 시작 ts. v2.962 열은 예전 행이면 0/NULL(n_* = 0 → 소비처가 '—'). */
export async function ioRollupRows(gran, serverId, from, to) {
  const h = await open();
  if (!h) return null;
  const st = gran === 'r1h' ? h.st.r1h : h.st.r15;
  return st.all(String(serverId), int(from), int(to)).map((r) => ({
    b: Number(r.b), n: Number(r.n), nAvg: Number(r.n_avg), sumAvg: Number(r.sum_avg), sumRd: Number(r.sum_rd), sumWr: Number(r.sum_wr),
    maxInst: clean(r.max_inst), maxRd: clean(r.max_rd), maxWr: clean(r.max_wr), maxBusy: clean(r.max_busy),
    nIops: Number(r.n_iops) || 0, sumIops: Number(r.sum_iops) || 0, maxIops: clean(r.max_iops),
    sumDios: Number(r.sum_dios) || 0, sumDticks: Number(r.sum_dticks) || 0, maxLat: clean(r.max_lat),
    nAbusy: Number(r.n_dbusy) || 0, sumAbusy: Number(r.sum_dbusy) || 0,   // v2.971 — 가장 바쁜 디스크의 구간 평균(n_abusy · sum_abusy 는 읽지 않는다)
  }));
}

/** 기간 안에 값이 있는 서버 id 목록(합계 선 · 순위 대상). */
export async function ioMeasuredServerIds(gran, from, to) {
  const h = await open();
  if (!h) return null;
  const st = gran === 'r1h' ? h.st.measured1h : gran === 'r15' ? h.st.measured15 : h.st.measuredRaw;
  return st.all(int(from), int(to)).map((r) => String(r.server_id));
}

/**
 * 순위(막대 비교) — 서버별 { avgBps, peakBps } (metric 'total'|'read'|'write'). 집계 함수 한 문장에 하나씩 세 번.
 * @returns {Map<string,{avgBps:number|null, peakBps:number|null, n:number}>|null}
 */
export async function ioRank(gran, from, to, { metric = 'total' } = {}) {
  const h = await open();
  if (!h) return null;
  const set = gran === 'r1h' ? h.st.rank1h : gran === 'r15' ? h.st.rank15 : h.st.rankRaw;
  const sumSt = metric === 'read' ? set.sumRd : metric === 'write' ? set.sumWr : set.sum;
  const peakSt = metric === 'read' ? set.peakRd : metric === 'write' ? set.peakWr : set.peak;
  const a = [int(from), int(to)];
  const m = new Map();
  const touch = (id) => { const k = String(id); if (!m.has(k)) m.set(k, { sum: 0, n: 0, peak: null }); return m.get(k); };
  for (const r of sumSt.all(...a)) touch(r.server_id).sum = Number(r.v) || 0;
  for (const r of set.n.all(...a)) touch(r.server_id).n = Number(r.v) || 0;
  for (const r of peakSt.all(...a)) { const p = clean(r.v); if (p != null) touch(r.server_id).peak = p; }
  const out = new Map();
  // v2.971: 피크는 평균보다 작을 수 없다 — 예전 행(2초 표본만)의 피크가 평균 아래면 평균으로 올린다(하한끼리의 최댓값).
  for (const [id, v] of m) {
    const avgBps = v.n > 0 ? Math.round(v.sum / v.n) : null;
    out.set(id, { avgBps, peakBps: v.peak == null ? avgBps : avgBps == null ? v.peak : Math.max(v.peak, avgBps), n: v.n });
  }
  return out;
}

/** 상태(화면 · 점검용). */
export async function bmIoDbStatus() {
  const h = await open();
  let span = null;
  if (h) { try { const mx = h.st.maxTs.get()?.v; const mn = h.st.minTs.get()?.v; span = mn == null ? null : { first: Number(mn), last: Number(mx) }; } catch { span = null; } }
  return {
    available: !!h, path: h ? h.path : DB_PATH(),
    error: initError ? String(initError.message || initError).slice(0, 200) : (h ? '' : lockRetry.note()),
    retention: ioRetention(), span,
  };
}

const _pruneFlight = createPruneFlight();
/** 보존 정리 — N회에 한 번(첫 호출은 건너뛴다). 원시는 ts, 집계는 b 기준. */
export async function pruneBmIo({ every = 20, now = Date.now() } = {}) {
  if ((++tick % Math.max(1, every)) !== 0) return { skipped: true };
  const h = await open();
  if (!h) return { skipped: true, reason: 'DB 없음' };
  const { rawDays, r15Days, r1hDays } = ioRetention();
  return _pruneFlight.run(`${rawDays}/${r15Days}/${r1hDays}`, async () => {
    const out = { skipped: false, deleted: 0, done: true };
    for (const [st, days, label] of [[h.st.pruneRaw, rawDays, 'bmstor.io.raw'], [h.st.prune15, r15Days, 'bmstor.io.r15'], [h.st.prune1h, r1hDays, 'bmstor.io.r1h']]) {
      try {
        const r = await chunkedDelete(st, [now - days * DAY], { label });
        out.deleted += r.deleted; out.done = out.done && r.done;
      } catch (e) {
        console.warn(`[bmstor-io] prune 실패(${label}): ${e?.message || e}`);
        out.done = false; out.error = String(e?.message || e).slice(0, 200);
      }
    }
    return out;
  });
}

export function _resetBmIoDbForTest() {
  lockRetry.ok();
  try { x?.db?.close?.(); } catch { /* */ }
  x = null; ready = null; initError = null; tick = 0; _last.clear(); _diskMapCache.clear(); _pruneFlight.reset();
}
