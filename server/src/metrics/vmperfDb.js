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
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { chunkedDelete } from '../util/chunkedPrune.js';
import { openSqlite } from '../util/sqliteOpen.js';

// DB 저장 경로 설정(v2.379)을 따른다 — config.dbDir 이 있으면 그 아래 vmperf/.
// VMPERF_DB_DIR env 가 있으면 그것이 최우선(명시 설정을 덮지 않는다).
const DIR = process.env.VMPERF_DB_DIR || path.join(config.dbDir || config.configDir, 'vmperf');
// v2.581(TUNE-D): 기본 8 → 48. 이 파일은 **vCenter 마다 하나**인데 운영은 28개(30+ 예정) + 합계 파일이라
// 상한 8 이면 매 샘플 주기마다 LRU 가 스래싱한다 — 런타임 계측(MOCK_SCALE=3 · 33 vCenter)에서 `openFile`
// (mkdir + 인덱스 파일 읽기 + 마이그레이션 검사 + open + PRAGMA + prepare)이 **분당 68회** 돌고 있었다.
// 핸들 하나는 fd 3개(db·wal·shm)와 페이지 캐시(기본 최대 2MB)뿐이다. v2.503 snapCache 의 '상한은 vCenter
// 수보다 커야 한다' 와 같은 판단이고 테스트가 기본값 하한을 고정한다.
export const VMPERF_MAX_OPEN_DEFAULT = 48;
const MAX_OPEN = Math.max(2, Math.min(256, Number(process.env.VMPERF_MAX_OPEN_DB) || VMPERF_MAX_OPEN_DEFAULT));
const HOUR = 3_600_000;
const TOTAL_KEY = '';           // 전체 합계 계열의 k
const TOTAL_FILE = '_all';      // 그 계열이 사는 파일명

const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

/**
 * vCenter id → 안전한 파일명. 경로 조작·OS 금지문자 차단(id 는 설정 파일에서 오지만 방어).
 *
 * v2.447(감사 B3): 예전에는 sanitize 결과만 썼는데 그 매핑이 **단사가 아니었다** —
 * `apac:vc01` 과 `apac_vc01` 이 똑같이 `apac_vc01.db` 가 되어
 *  ① 두 vCenter 의 시계열이 한 파일에 섞이고
 *  ② `DELETE /tools/waste/settings/data?vcenterId=apac:vc01` 이 **다른 vCenter 데이터까지 파일째 삭제**했다(복구 불가).
 * 이제 원본 id 의 해시 8자를 접미사로 붙여 충돌을 없앤다. 파일명에서 원본 id 를 되돌릴 수 없으므로
 * 역산이 필요한 곳(vmperfDiskUsage)은 사이드카 인덱스(_index.json)를 쓴다.
 * 구버전 파일(해시 없는 이름)은 getVmperfDb 가 처음 열 때 1회 리네임한다.
 */
export function dbFileName(vcenterId) {
  const raw = String(vcenterId ?? '');
  if (raw === TOTAL_KEY) return TOTAL_FILE;
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
  const h = createHash('sha1').update(raw, 'utf8').digest('hex').slice(0, 8);
  return `${safe || '_unknown'}-${h}`;
}

/** 구버전(해시 접미사 없는) 파일명 — 마이그레이션 판정에만 쓴다. */
function legacyDbFileName(vcenterId) {
  const raw = String(vcenterId ?? '');
  if (raw === TOTAL_KEY) return TOTAL_FILE;
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return safe || '_unknown';
}

const INDEX_FILE = () => path.join(DIR, '_index.json');

/** 파일명(base) → 원본 vcenterId 매핑. 파일명이 비가역이라 역산은 이 인덱스로만 한다. */
function readIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_FILE(), 'utf8')) || {}; } catch { return {}; }
}
function rememberIndex(file, vcenterId) {
  try {
    const idx = readIndex();
    if (idx[file] === vcenterId) return;
    idx[file] = vcenterId;
    fs.writeFileSync(INDEX_FILE(), JSON.stringify(idx, null, 2), { mode: 0o600 });
  } catch { /* 인덱스는 표시·정리 편의용 — 실패해도 수집은 계속한다 */ }
}

/** 구버전 파일명이 있고 새 이름이 없으면 1회 리네임(-wal/-shm 포함). */
function migrateLegacyFile(vcenterId, file) {
  const legacy = legacyDbFileName(vcenterId);
  if (legacy === file) return;
  const newPath = path.join(DIR, `${file}.db`);
  const oldPath = path.join(DIR, `${legacy}.db`);
  try {
    if (fs.existsSync(newPath) || !fs.existsSync(oldPath)) return;
    for (const suffix of ['.db', '.db-wal', '.db-shm']) {
      const from = path.join(DIR, `${legacy}${suffix}`);
      const to = path.join(DIR, `${file}${suffix}`);
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    console.log(`[vmperf] DB 파일명 마이그레이션: ${legacy}.db → ${file}.db (id 충돌 방지, v2.447)`);
  } catch (e) { console.warn(`[vmperf] 파일명 마이그레이션 실패(${legacy}): ${e.message}`); }
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
    rawMin: db.prepare('SELECT MIN(ts) AS mn FROM samples WHERE metric=? AND k=?'), // v2.600 DB2600-02 — aggregate 하나(인덱스 끝점)
    // v2.447(감사 B3): k 필터 추가 — 파일이 한 vCenter 전용이라도, 구버전 충돌 파일이 남아 있으면
    // 남의 행까지 세어 '수집 시작' 이 틀리게 표시됐다.
    meta: db.prepare('SELECT MIN(ts) AS mn, MAX(ts) AS mx, COUNT(*) AS n FROM samples WHERE metric=? AND k=?'),
    // v2.583(검증 에이전트 권고): 청크 삭제용 — 공용 metrics/db.js 와 같은 형태(LIMIT 은 chunkedDelete 가 붙인다)
    prune: db.prepare('DELETE FROM samples WHERE rowid IN (SELECT rowid FROM samples WHERE ts < ? LIMIT ?)'),
    pruneHourly: db.prepare('DELETE FROM samples_hourly WHERE rowid IN (SELECT rowid FROM samples_hourly WHERE h < ? LIMIT ?)'),
  };
}

/** vCenter 의 DB 핸들(없으면 생성). node:sqlite 미지원이면 null. */
// v2.580(BUG-A): 파일별 **진행 중 open 을 공유한다** — `open.get(file)` 검사와 핸들 생성 사이에 같은
// vCenter 의 두 번째 호출이 들어오면 같은 파일에 `DatabaseSync` 가 둘 생기고(`open.set` 이 덮어써) 첫
// 핸들이 새어 나갔다(단일 파일 모듈의 v2.580 재현과 같은 유형). 파일 단위로 in-flight 를 공유한다.
const opening = new Map(); // file -> Promise<entry>
export async function getVmperfDb(vcenterId) {
  const mod = await loadSqlite();
  if (!mod) return null;
  const file = dbFileName(vcenterId);
  const hit = open.get(file);
  if (hit) { hit.usedAt = Date.now(); return hit; }
  if (opening.has(file)) return opening.get(file);
  const p = openFile(vcenterId, file, mod).finally(() => { opening.delete(file); });
  opening.set(file, p);
  return p;
}
async function openFile(vcenterId, file, mod) {
  fs.mkdirSync(DIR, { recursive: true });
  migrateLegacyFile(vcenterId, file);          // v2.447: 구버전 파일명 → 해시 접미사 이름
  const p = path.join(DIR, `${file}.db`);
  // v2.599 DB2599-02: busy_timeout 먼저(첫 생성 중 다른 연결의 잠금을 기다린다) · 실패하면 핸들을 닫는다(fd 누수 방지 —
  //   파일별 핸들이라 다음 호출이 다시 연다. 래치 없음).
  const db = openSqlite(new mod.DatabaseSync(p));
  // v2.618(메모리 점검): vCenter 마다 파일·핸들이 하나라 페이지 캐시(기본 약 2MB/연결)가 33곳이면 ~66MB 까지 네이티브 메모리를
  //   차지한다(추정 — 핸들 수 × SQLite 기본값). 이 DB 는 시계열 append + 기간 조회라 큰 캐시 이득이 적어 512KB 로 묶는다.
  try { db.exec('PRAGMA cache_size=-512'); } catch { /* 캐시 크기 설정 실패는 동작에 영향 없음 */ }
  // 공용 metrics DB 와 같은 PRAGMA — WAL 로 읽기/쓰기 병행, fsync 완화(단건 insert 5ms→0.01ms 실측).
  let st;
  try { st = prepare(db); } catch (e) { try { db.close(); } catch { /* */ } throw e; }
  try { fs.chmodSync(p, 0o600); } catch { /* best effort */ }
  rememberIndex(file, String(vcenterId ?? ''));  // 파일명 역산용(비가역 해시라 인덱스 필요)
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
    // 롤업이 요청 창을 덮거나 **원본만큼 거슬러 올라가면** 사용한다(v2.600 DB2600-02 — metrics/db.js 와 같은 조건).
    // 예전 '창을 덮을 때만' 이면 원본 보존이 롤업보다 짧을 때 긴 창이 원본으로 떨어져 더 적게 보였다.
    // 원본이 롤업보다 이르면(업그레이드 이전 데이터) 원본으로 폴백해 빈 결과를 만들지 않는다.
    const rawFirst = mn != null && mn > sinceTs ? x.st.rawMin.get(metric, k)?.mn : null;
    if (mn != null && (mn <= sinceTs || rawFirst == null || mn <= rawFirst)) return map(x.st.bucketHourly.all(bucketMs, bucketMs, metric, k, sinceTs, limit));
  }
  return map(x.st.bucket.all(bucketMs, bucketMs, metric, k, sinceTs, limit));
}

/** 관측 시작/종료·행 수. */
export async function vmperfMeta(vcenterId, metric = 'vm_cpu_alloc_mhz') {
  const x = await getVmperfDb(vcenterId);
  if (!x) return { firstTs: null, lastTs: null, count: 0 };
  const r = x.st.meta.get(metric, String(vcenterId ?? ''));
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
  // v2.583: 청크 + 이벤트 루프 양보(v2.453 규약). 한 방 DELETE 는 보존일을 줄인 첫 주기에 수백만 행을 동기로 지워
  //   포탈을 멈춘다(공용 metrics/db.js 는 이미 이 형태였다 — vCenter별 파일만 빠져 있었다).
  try { n = (await chunkedDelete(x.st.prune, [before], { label: `vmperf.${vcenterId}` })).deleted; } catch (e) { console.warn(`[vmperf] ${vcenterId} prune 실패: ${e?.message || e}`); }
  // 경계의 부분 시간대는 남겨 롤업이 원본보다 먼저 비지 않게(공용 DB prune 과 같은 규약).
  try { await chunkedDelete(x.st.pruneHourly, [before - HOUR], { label: `vmperf.${vcenterId}.hourly` }); } catch (e) { console.warn(`[vmperf] ${vcenterId} 롤업 prune 실패: ${e?.message || e}`); }
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
  const idx = readIndex();                       // v2.447: 파일명 → 원본 vcenterId
  return files.map((f) => {
    const base = f.replace(/\.db$/, '');
    let bytes = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      try { bytes += fs.statSync(path.join(DIR, `${f}${suffix}`)).size; } catch { /* 없으면 0 */ }
    }
    // 인덱스에 있으면 원본 id, 없으면(구버전 파일·인덱스 유실) 파일명 그대로 — 표시용 최선값.
    const vcId = base === TOTAL_FILE ? TOTAL_KEY : (idx[base] !== undefined ? idx[base] : base);
    return { vcenterId: vcId, file: f, bytes };
  }).sort((a, b) => b.bytes - a.bytes);
}

// 낭비 리소스 추이(할당 vs 사용) 4계열 + Platform 추이용 디스크 2계열(v2.377).
// 디스크는 vCenter 데이터스토어의 사용/용량 합계 — CPU·MEM 의 '사용/할당' 과 같은 형태로 본다.
export const VMPERF_METRICS = ['vm_cpu_alloc_mhz', 'vm_cpu_used_mhz', 'vm_mem_alloc_mb', 'vm_mem_used_mb'];
export const VMPERF_DISK_METRICS = ['ds_cap_gb_vc', 'ds_used_gb_vc'];
// VM 디스크 집계(v2.446): 할당(committed+uncommitted)·커밋·정지 VM 커밋·스냅샷 크기(GB). 키 규약 동일.
export const VMPERF_VMDISK_METRICS = ['vm_disk_prov_gb', 'vm_disk_used_gb', 'vm_disk_off_gb', 'vm_snap_gb'];
export const VMPERF_ALL_METRICS = [...VMPERF_METRICS, ...VMPERF_DISK_METRICS];
export const vmperfDir = () => DIR;
