/**
 * VM 성능 시계열 — **vCenter 별 독립 DB**(v2.376).
 *
 * 왜 분리하나: 6,000 VM 규모에서 이 계열은 용량이 빠르게 늘고(실측 행당 ~308B, 인덱스·롤업 포함),
 * 운영자가 vCenter 단위로 '수집할지/얼마나 보관할지'를 끄고 켤 수 있어야 한다. 공용 metrics.db
 * 에 섞어두면 DELETE 로 행만 지워져 **파일 크기가 줄지 않는다**(SQLite 특성). vCenter 마다
 * 파일이 따로면 제외 즉시 파일을 삭제해 용량을 회수할 수 있다.
 *
 * 분리 범위는 **VM 사용률/할당 4계열만**이다:
 *   vm_cpu_alloc_mhz · vm_cpu_used_mhz · vm_mem_alloc_mb · vm_mem_used_mb
 * 온도·GPU·데이터스토어·포탈 자체 메모리는 공용 metrics.db 에 그대로 둔다 — 이상탐지의
 * historyAll(1쿼리) 최적화, 전력 latestAll 인메모리 캐시, prune 스로틀 등 확립된 성능
 * 불변조건을 건드리지 않기 위한 의도적 축소다(전면 분리는 8개 파일·20곳 재설계가 필요).
 *
 * 파일 배치: CONFIG_DIR/vmperf/<sanitized-vcenterId>.db  (전체 합계는 `_all.db`)
 * 핸들 관리: LRU 로 동시 오픈 상한(기본 8) — 28개 vCenter × (db+wal+shm) 를 상시 열지 않는다.
 * 스키마/조회는 metrics/db.js 와 동일 규약(samples + samples_hourly, 60분+ 버킷은 롤업 사용).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

// DB 저장 경로 설정(v2.379)을 따른다 — config.dbDir 이 있으면 그 아래 vmperf/.
// VMPERF_DB_DIR env 가 있으면 그것이 최우선(명시 설정을 덮지 않는다).
const DIR = process.env.VMPERF_DB_DIR || path.join(config.dbDir || config.configDir, 'vmperf');
const MAX_OPEN = Math.max(2, Math.min(32, Number(process.env.VMPERF_MAX_OPEN_DB) || 8));
const HOUR = 3_600_000;
const TOTAL_KEY = '';           // 전체 합계 계열의 k
const TOTAL_FILE = '_all';      // 그 계열이 사는 파일명

const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

/** vCenter id → 안전한 파일명. 경로 조작·OS 금지문자 차단(id 는 설정 파일에서 오지만 방어). */
export function dbFileName(vcenterId) {
  const raw = String(vcenterId ?? '');
  if (raw === TOTAL_KEY) return TOTAL_FILE;
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return safe || '_unknown';
}

const open = new Map(); // fileName -> { db, st, usedAt }
let sqliteMod = null;

async function loadSqlite() {
  if (sqliteMod) return sqliteMod;
  try {
    // eslint-disable-next-line import/no-unresolved
    sqliteMod = await import('node:sqlite');
  } catch {
    sqliteMod = null; // 구버전 런타임 — 기능 비활성(호출부가 null 처리)
  }
  return sqliteMod;
}

/** LRU: 상한 초과분 중 가장 오래 안 쓴 핸들을 닫는다. */
function evictIfNeeded() {
  while (open.size > MAX_OPEN) {
    let oldestKey = null; let oldestAt = Infinity;
    for (const [k, e] of open) if (e.usedAt < oldestAt) { oldestAt = e.usedAt; oldestKey = k; }
    if (oldestKey == null) break;
    const e = open.get(oldestKey);
    open.delete(oldestKey);
    try { e.db.close(); } catch { /* 이미 닫힘 */ }
  }
}

function prepare(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS samples (
      metric TEXT NOT NULL, k TEXT NOT NULL, v REAL NOT NULL, ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_samples_mkt ON samples (metric, k, ts);
    CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples (ts);
    CREATE TABLE IF NOT EXISTS samples_hourly (
      metric TEXT NOT NULL, k TEXT NOT NULL, h INTEGER NOT NULL,
      n INTEGER NOT NULL, sum REAL NOT NULL, mn REAL NOT NULL, mx REAL NOT NULL,
      PRIMARY KEY (metric, k, h)
    );
    CREATE INDEX IF NOT EXISTS idx_hourly_h ON samples_hourly (h);
  `);
  return {
    ins: db.prepare('INSERT INTO samples (metric, k, v, ts) VALUES (?, ?, ?, ?)'),
    insHour: db.prepare(`INSERT INTO samples_hourly (metric, k, h, n, sum, mn, mx) VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(metric, k, h) DO UPDATE SET n = n + 1, sum = sum + excluded.sum,
        mn = MIN(mn, excluded.mn), mx = MAX(mx, excluded.mx)`),
    bucket: db.prepare(`SELECT CAST(ts/? AS INTEGER)*? AS b, AVG(v) avg, MIN(v) min, MAX(v) max FROM samples
      WHERE metric=? AND k=? AND ts>=? GROUP BY b ORDER BY b DESC LIMIT ?`),
    bucketHourly: db.prepare(`SELECT CAST(h/? AS INTEGER)*? AS b, SUM(sum)/SUM(n) AS avg, MIN(mn) AS min, MAX(mx) AS max
      FROM samples_hourly WHERE metric=? AND k=? AND h>=? GROUP BY b ORDER BY b DESC LIMIT ?`),
    hourlyMin: db.prepare('SELECT MIN(h) AS mn FROM samples_hourly WHERE metric=? AND k=?'),
    meta: db.prepare('SELECT MIN(ts) AS mn, MAX(ts) AS mx, COUNT(*) AS n FROM samples WHERE metric=?'),
    prune: db.prepare('DELETE FROM samples WHERE ts < ?'),
    pruneHourly: db.prepare('DELETE FROM samples_hourly WHERE h < ?'),
  };
}

/** vCenter 의 DB 핸들(없으면 생성). node:sqlite 미지원이면 null. */
export async function getVmperfDb(vcenterId) {
  const mod = await loadSqlite();
  if (!mod) return null;
  const file = dbFileName(vcenterId);
  const hit = open.get(file);
  if (hit) { hit.usedAt = Date.now(); return hit; }
  fs.mkdirSync(DIR, { recursive: true });
  const p = path.join(DIR, `${file}.db`);
  const db = new mod.DatabaseSync(p);
  // 공용 metrics DB 와 같은 PRAGMA — WAL 로 읽기/쓰기 병행, fsync 완화(단건 insert 5ms→0.01ms 실측).
  try { db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;'); } catch { /* 구버전 폴백 */ }
  const st = prepare(db);
  try { fs.chmodSync(p, 0o600); } catch { /* best effort */ }
  const entry = { db, st, usedAt: Date.now(), file };
  open.set(file, entry);
  evictIfNeeded();
  return entry;
}

/**
 * 한 vCenter 의 행 묶음을 그 vCenter DB 에 적재(트랜잭션 1회).
 * rows: [{ metric, k, v }] — k 는 vcenterId 또는 ''(전체). ts 는 호출자가 하나로 준다.
 */
export async function insertVmperf(vcenterId, rows, ts) {
  if (!rows?.length) return 0;
  const x = await getVmperfDb(vcenterId);
  if (!x) return 0;
  const h = Math.floor(ts / HOUR) * HOUR;
  x.db.exec('BEGIN');
  try {
    for (const r of rows) {
      x.st.ins.run(r.metric, r.k, r.v, ts);
      x.st.insHour.run(r.metric, r.k, h, r.v, r.v, r.v);
    }
    x.db.exec('COMMIT');
  } catch (e) {
    try { x.db.exec('ROLLBACK'); } catch { /* */ }
    throw e;
  }
  return rows.length;
}

/** 시계열 조회 — metrics/db.js history 와 동일 규약(60분+ 정배수면 롤업 사용). */
export async function vmperfHistory(vcenterId, metric, sinceTs, bucketMs, limit) {
  const x = await getVmperfDb(vcenterId);
  if (!x) return [];
  const k = String(vcenterId ?? '');
  const map = (rows) => rows.reverse().map((r) => ({ ts: r.b, avg: round1(r.avg), min: round1(r.min), max: round1(r.max) }));
  if (bucketMs >= HOUR && bucketMs % HOUR === 0) {
    const mn = x.st.hourlyMin.get(metric, k)?.mn;
    // 롤업이 요청 창을 덮을 때만 사용 — 덮지 못하면 원본으로 폴백해 빈 결과를 만들지 않는다.
    if (mn != null && mn <= sinceTs) return map(x.st.bucketHourly.all(bucketMs, bucketMs, metric, k, sinceTs, limit));
  }
  return map(x.st.bucket.all(bucketMs, bucketMs, metric, k, sinceTs, limit));
}

/** 관측 시작/종료·행 수. */
export async function vmperfMeta(vcenterId, metric = 'vm_cpu_alloc_mhz') {
  const x = await getVmperfDb(vcenterId);
  if (!x) return { firstTs: null, lastTs: null, count: 0 };
  const r = x.st.meta.get(metric);
  return { firstTs: r?.mn ?? null, lastTs: r?.mx ?? null, count: Number(r?.n || 0) };
}

/** 보존기간 prune(0 = 무제한이면 아무것도 하지 않음). 롤업도 함께 정리. */
export async function pruneVmperf(vcenterId, retentionDays) {
  const days = Number(retentionDays) || 0;
  if (days <= 0) return 0;
  const x = await getVmperfDb(vcenterId);
  if (!x) return 0;
  const before = Date.now() - days * 86_400_000;
  let n = 0;
  try { n = x.st.prune.run(before)?.changes ?? 0; } catch { /* */ }
  // 경계의 부분 시간대는 남겨 롤업이 원본보다 먼저 비지 않게(공용 DB prune 과 같은 규약).
  try { x.st.pruneHourly.run(before - HOUR); } catch { /* */ }
  return n;
}

/** 열린 핸들 닫기(파일 삭제 전 필수 — Windows 는 열린 파일을 지울 수 없다). */
export function closeVmperfDb(vcenterId) {
  const file = dbFileName(vcenterId);
  const e = open.get(file);
  if (!e) return false;
  open.delete(file);
  try { e.db.close(); } catch { /* */ }
  return true;
}

/**
 * vCenter 의 DB 파일 삭제 — 수집 대상에서 제외했을 때 **용량을 즉시 회수**한다
 * (공용 DB 라면 DELETE 로 행만 지워지고 파일은 줄지 않는다. 이게 분리의 실질 이점).
 * WAL/SHM 사이드카까지 함께 지운다.
 */
export function dropVmperfDb(vcenterId) {
  closeVmperfDb(vcenterId);
  const base = path.join(DIR, `${dbFileName(vcenterId)}.db`);
  let removed = 0;
  for (const p of [base, `${base}-wal`, `${base}-shm`]) {
    try { if (fs.existsSync(p)) { fs.rmSync(p); removed++; } } catch { /* 사용 중 등 — 무시하고 보고만 */ }
  }
  return removed;
}

/** 디스크 사용 현황(설정 화면 표시용) — [{ vcenterId, file, bytes }]. */
export function vmperfDiskUsage() {
  let files = [];
  try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.db')); } catch { return []; }
  return files.map((f) => {
    const base = f.replace(/\.db$/, '');
    let bytes = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      try { bytes += fs.statSync(path.join(DIR, `${f}${suffix}`)).size; } catch { /* 없으면 0 */ }
    }
    return { vcenterId: base === TOTAL_FILE ? TOTAL_KEY : base, file: f, bytes };
  }).sort((a, b) => b.bytes - a.bytes);
}

// 낭비 리소스 추이(할당 vs 사용) 4계열 + Platform 추이용 디스크 2계열(v2.377).
// 디스크는 vCenter 데이터스토어의 사용/용량 합계 — CPU·MEM 의 '사용/할당' 과 같은 형태로 본다.
export const VMPERF_METRICS = ['vm_cpu_alloc_mhz', 'vm_cpu_used_mhz', 'vm_mem_alloc_mb', 'vm_mem_used_mb'];
export const VMPERF_DISK_METRICS = ['ds_cap_gb_vc', 'ds_used_gb_vc'];
export const VMPERF_ALL_METRICS = [...VMPERF_METRICS, ...VMPERF_DISK_METRICS];
export const vmperfDir = () => DIR;
