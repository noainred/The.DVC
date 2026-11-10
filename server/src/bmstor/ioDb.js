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

const ROLLUP_COLS = 'server_id, b, n, n_avg, sum_avg, sum_rd, sum_wr, max_inst, max_rd, max_wr, max_busy, last_ts';
const rollupUpsert = (table) => `INSERT INTO ${table} (${ROLLUP_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(server_id, b) DO UPDATE SET
    n = ${table}.n + excluded.n, n_avg = ${table}.n_avg + excluded.n_avg, sum_avg = ${table}.sum_avg + excluded.sum_avg,
    sum_rd = ${table}.sum_rd + excluded.sum_rd, sum_wr = ${table}.sum_wr + excluded.sum_wr,
    max_inst = MAX(COALESCE(${table}.max_inst, -1), COALESCE(excluded.max_inst, -1)),
    max_rd = MAX(COALESCE(${table}.max_rd, -1), COALESCE(excluded.max_rd, -1)),
    max_wr = MAX(COALESCE(${table}.max_wr, -1), COALESCE(excluded.max_wr, -1)),
    max_busy = MAX(COALESCE(${table}.max_busy, -1), COALESCE(excluded.max_busy, -1)),
    last_ts = MAX(${table}.last_ts, excluded.last_ts)`;
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
  const rollupSel = (table) => db.prepare(`SELECT b, n, n_avg, sum_avg, sum_rd, sum_wr, max_inst, max_rd, max_wr, max_busy FROM ${table} WHERE server_id = ? AND b >= ? AND b <= ? ORDER BY b`);
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
    insRaw: db.prepare(`INSERT OR IGNORE INTO io_raw (server_id, ts, name, avg_rd, avg_wr, avg_busy, inst_rd, inst_wr, busy, rd_sectors, wr_sectors, io_ms, uptime, disks)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    upLast: db.prepare(`INSERT INTO io_last (server_id, ts, rd_sectors, wr_sectors, io_ms, uptime) VALUES (?,?,?,?,?,?)
      ON CONFLICT(server_id) DO UPDATE SET ts=excluded.ts, rd_sectors=excluded.rd_sectors, wr_sectors=excluded.wr_sectors, io_ms=excluded.io_ms, uptime=excluded.uptime
      WHERE excluded.ts > io_last.ts`),
    getLast: db.prepare('SELECT ts, rd_sectors, wr_sectors, io_ms, uptime FROM io_last WHERE server_id = ?'),
    up15: db.prepare(rollupUpsert('io_r15')),
    up1h: db.prepare(rollupUpsert('io_r1h')),
    raw: db.prepare(`SELECT ts, avg_rd, avg_wr, avg_busy, inst_rd, inst_wr, busy FROM io_raw WHERE server_id = ? AND ts >= ? AND ts <= ? ORDER BY ts`),
    r15: rollupSel('io_r15'), r1h: rollupSel('io_r1h'),
    rank15: rankSel('io_r15'), rank1h: rankSel('io_r1h'),
    rankRaw: {
      sum: db.prepare('SELECT server_id, SUM(avg_rd + avg_wr) AS v FROM io_raw WHERE ts >= ? AND ts <= ? AND avg_rd IS NOT NULL GROUP BY server_id'),
      n: db.prepare('SELECT server_id, COUNT(*) AS v FROM io_raw WHERE ts >= ? AND ts <= ? AND avg_rd IS NOT NULL GROUP BY server_id'),
      peak: db.prepare('SELECT server_id, MAX(inst_rd + inst_wr) AS v FROM io_raw WHERE ts >= ? AND ts <= ? GROUP BY server_id'),
      sumRd: db.prepare('SELECT server_id, SUM(avg_rd) AS v FROM io_raw WHERE ts >= ? AND ts <= ? AND avg_rd IS NOT NULL GROUP BY server_id'),
      sumWr: db.prepare('SELECT server_id, SUM(avg_wr) AS v FROM io_raw WHERE ts >= ? AND ts <= ? AND avg_wr IS NOT NULL GROUP BY server_id'),
      peakRd: db.prepare('SELECT server_id, MAX(inst_rd) AS v FROM io_raw WHERE ts >= ? AND ts <= ? GROUP BY server_id'),
      peakWr: db.prepare('SELECT server_id, MAX(inst_wr) AS v FROM io_raw WHERE ts >= ? AND ts <= ? GROUP BY server_id'),
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

function lastOf(h, serverId) {
  if (_last.has(serverId)) return _last.get(serverId);
  const r = h.st.getLast.get(serverId);
  const v = r ? { ts: Number(r.ts), counters: { rdSectors: Number(r.rd_sectors), wrSectors: Number(r.wr_sectors), ioMs: Number(r.io_ms), uptimeSec: r.uptime == null ? null : Number(r.uptime) } } : null;
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
      const cur = { ts, counters: io.counters };
      const prev = lastOf(h, id);
      const avg = prev && prev.ts < ts ? intervalAvg(prev, cur, { maxGapMs }) : null;
      const instRd = int(io.readBps); const instWr = int(io.writeBps); const busy = real(io.busyPct);
      const res = h.st.insRaw.run(id, ts, String(r.name || '').slice(0, 200),
        avg ? avg.avgReadBps : null, avg ? avg.avgWriteBps : null, avg ? avg.avgBusyPct : null,
        instRd, instWr, busy,
        int(io.counters.rdSectors), int(io.counters.wrSectors), int(io.counters.ioMs), real(io.counters.uptimeSec), int(io.disks));
      if (!res || !res.changes) { skipped += 1; continue; }   // 같은 ts 재적재(중복 회신)는 무시
      h.st.upLast.run(id, ts, int(io.counters.rdSectors), int(io.counters.wrSectors), int(io.counters.ioMs), real(io.counters.uptimeSec));
      if (!prev || prev.ts < ts) _last.set(id, cur);
      const inst = instRd != null && instWr != null ? instRd + instWr : null;
      const args = (g) => [id, alignDown(ts, g), 1, avg ? 1 : 0, avg ? avg.avgReadBps + avg.avgWriteBps : 0, avg ? avg.avgReadBps : 0, avg ? avg.avgWriteBps : 0, inst, instRd, instWr, busy, ts];
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

/** 원시 행(한 서버 · 기간). 읽기 · 쓰기 · 합계를 모두 준다(지표 선택은 호출부). */
export async function ioRawRows(serverId, from, to) {
  const h = await open();
  if (!h) return null;
  return h.st.raw.all(String(serverId), int(from), int(to)).map((r) => ({
    ts: Number(r.ts),
    avgRead: clean(r.avg_rd), avgWrite: clean(r.avg_wr), avgTotal: r.avg_rd == null || r.avg_wr == null ? null : Number(r.avg_rd) + Number(r.avg_wr),
    instRead: clean(r.inst_rd), instWrite: clean(r.inst_wr), instTotal: r.inst_rd == null || r.inst_wr == null ? null : Number(r.inst_rd) + Number(r.inst_wr),
    busy: clean(r.busy), avgBusy: clean(r.avg_busy),
  }));
}

/** 집계 표 행(한 서버 · 기간 · 'r15'|'r1h'). b 는 버킷 시작 ts. */
export async function ioRollupRows(gran, serverId, from, to) {
  const h = await open();
  if (!h) return null;
  const st = gran === 'r1h' ? h.st.r1h : h.st.r15;
  return st.all(String(serverId), int(from), int(to)).map((r) => ({
    b: Number(r.b), n: Number(r.n), nAvg: Number(r.n_avg), sumAvg: Number(r.sum_avg), sumRd: Number(r.sum_rd), sumWr: Number(r.sum_wr),
    maxInst: clean(r.max_inst), maxRd: clean(r.max_rd), maxWr: clean(r.max_wr), maxBusy: clean(r.max_busy),
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
  for (const [id, v] of m) out.set(id, { avgBps: v.n > 0 ? Math.round(v.sum / v.n) : null, peakBps: v.peak, n: v.n });
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
  x = null; ready = null; initError = null; tick = 0; _last.clear(); _pruneFlight.reset();
}
