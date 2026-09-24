/**
 * vmseries/db.js — 실시간 스파이크 저장소. **vCenter 마다 독립 파일**(v2.510, 사용자 요구
 * "DB 분리하는거 꼭 기억해").
 *
 * 파일: CONFIG_DIR(또는 dbDir)/vmseries/<sanitized-id>-<sha1 8자>.db — metrics/vmperfDb.js 와 같은
 * 이름 규약(dbFileName 재사용 — 단사 매핑, 특수문자 id 충돌 없음) + _index.json 역산 인덱스.
 * 한 vCenter 의 행이 다른 파일에 들어갈 길이 없다 — 키가 아니라 **파일**이 분리 단위다.
 * 대상에서 빼면 파일째 삭제해 용량을 즉시 회수한다(공용 DB 의 DELETE 는 파일을 줄이지 않는다).
 *
 * 스키마
 *  spikes  (kind, ref, t0) → n, t1, cols(JSON), data(BLOB)  — 스파이크 순간 패킹(spikes.js packMoments)
 *  cover   (kind, ref, h)  → samples                          — 엔티티·시간별 관측 표본 수('0' 과 '미측정' 구분)
 *  cursor  (kind, ref)     → last_ts                           — 겹침 구간 중복 저장 방지(재시작에도 유지)
 *  meta    (k)             → v                                 — vcenterId·name·historicalInterval 등
 *
 * PRAGMA: WAL + synchronous=NORMAL + busy_timeout(공용 규약). 파일 0600(v2.503 S-5).
 * 쓰기는 vCenter 별 트랜잭션 1회 — 행 수는 대상 수 × 2 정도(수백~천)라 메인 스레드에서 수 ms.
 * 5,850 행 이상이 한 트랜잭션에 몰리지 않는다(vCenter 별 파일이므로 구조적으로 그렇다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { dbFileName } from '../metrics/vmperfDb.js';
import { openSqlite } from '../util/sqliteOpen.js';

const DIR = process.env.VMSERIES_DB_DIR || path.join(config.dbDir || config.configDir, 'vmseries');
// v2.582 TUNE-4: 파일은 vCenter 마다 하나(운영 28 · 30+ 예정)라 상한이 그보다 작으면 주기마다 LRU 스래싱이다
// (v2.581 TUNE-D `metrics/vmperfDb.js` 와 같은 구조 — 거기서 실측 openFile 68회/분). 예전 기본 8 · 하드캡 32 는
// 33 vCenter 현장에서 env 로도 넘을 수 없었다. 기본 48 · 상한 256. 이 수집은 50분 주기라 비용은 vmperf 보다 작다.
export const VMSERIES_MAX_OPEN_DEFAULT = 48;
const MAX_OPEN = Math.max(2, Math.min(256, Number(process.env.VMSERIES_MAX_OPEN_DB) || 48)); // = VMSERIES_MAX_OPEN_DEFAULT(env-doc 가 숫자를 읽게 풀어 씀)
const HOUR = 3_600_000;

const open = new Map(); // file -> { db, st, usedAt, file }
let sqliteMod = null;
async function loadSqlite() {
  if (sqliteMod) return sqliteMod;
  try { sqliteMod = await import('node:sqlite'); } catch { sqliteMod = null; } // eslint-disable-line import/no-unresolved
  return sqliteMod;
}

const INDEX_FILE = () => path.join(DIR, '_index.json');
function readIndex() { try { return JSON.parse(fs.readFileSync(INDEX_FILE(), 'utf8')) || {}; } catch { return {}; } }
function rememberIndex(file, vcenterId) {
  try {
    const idx = readIndex();
    if (idx[file] === vcenterId) return;
    idx[file] = vcenterId;
    fs.writeFileSync(INDEX_FILE(), JSON.stringify(idx, null, 2), { mode: 0o600 });
  } catch { /* 표시용 인덱스 — 실패해도 수집은 계속 */ }
}

function evictIfNeeded() {
  while (open.size > MAX_OPEN) {
    let oldestKey = null; let oldestAt = Infinity;
    for (const [k, e] of open) if (e.usedAt < oldestAt) { oldestAt = e.usedAt; oldestKey = k; }
    if (oldestKey == null) break;
    const e = open.get(oldestKey); open.delete(oldestKey);
    try { e.db.close(); } catch { /* */ }
  }
}

function prepare(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS spikes (
      kind TEXT NOT NULL, ref TEXT NOT NULL, t0 INTEGER NOT NULL, t1 INTEGER NOT NULL,
      n INTEGER NOT NULL, cols TEXT NOT NULL, data BLOB NOT NULL,
      mxcpu INTEGER NOT NULL DEFAULT -1, mxmem INTEGER NOT NULL DEFAULT -1,
      PRIMARY KEY (kind, ref, t0)
    );
    CREATE INDEX IF NOT EXISTS idx_spikes_t0 ON spikes (t0);
    CREATE TABLE IF NOT EXISTS cover (
      kind TEXT NOT NULL, ref TEXT NOT NULL, h INTEGER NOT NULL, samples INTEGER NOT NULL,
      PRIMARY KEY (kind, ref, h)
    );
    CREATE INDEX IF NOT EXISTS idx_cover_h ON cover (h);
    CREATE TABLE IF NOT EXISTS cursor (kind TEXT NOT NULL, ref TEXT NOT NULL, last_ts INTEGER NOT NULL, PRIMARY KEY (kind, ref));
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);
  return {
    insSpike: db.prepare('INSERT OR REPLACE INTO spikes (kind, ref, t0, t1, n, cols, data, mxcpu, mxmem) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    // 전 VM 순위용 — BLOB 을 풀지 않고 행 단위 집계만(창 안 행 수 × O(1)).
    topInWindow: db.prepare(`SELECT kind, ref, COUNT(*) AS rows, SUM(n) AS moments, MAX(mxcpu) AS mxcpu, MAX(mxmem) AS mxmem, MIN(t0) AS firstT, MAX(t1) AS lastT
      FROM spikes WHERE t1>=? AND t0<=? GROUP BY kind, ref ORDER BY moments DESC LIMIT ?`),
    upCover: db.prepare('INSERT INTO cover (kind, ref, h, samples) VALUES (?, ?, ?, ?) ON CONFLICT(kind, ref, h) DO UPDATE SET samples = samples + excluded.samples'),
    upCursor: db.prepare('INSERT INTO cursor (kind, ref, last_ts) VALUES (?, ?, ?) ON CONFLICT(kind, ref) DO UPDATE SET last_ts = MAX(last_ts, excluded.last_ts)'),
    getCursor: db.prepare('SELECT last_ts FROM cursor WHERE kind=? AND ref=?'),
    allCursors: db.prepare('SELECT kind, ref, last_ts FROM cursor'),
    spikesOf: db.prepare('SELECT t0, t1, n, cols, data FROM spikes WHERE kind=? AND ref=? AND t1>=? AND t0<=? ORDER BY t0'),
    spikesInWindow: db.prepare('SELECT kind, ref, t0, t1, n, cols, data FROM spikes WHERE t1>=? AND t0<=? ORDER BY t0'),
    coverOf: db.prepare('SELECT h, samples FROM cover WHERE kind=? AND ref=? AND h>=? AND h<=? ORDER BY h'),
    coverHours: db.prepare('SELECT h, COUNT(*) AS entities, SUM(samples) AS samples FROM cover WHERE kind=? AND h>=? AND h<=? GROUP BY h ORDER BY h'),
    firstCover: db.prepare('SELECT MIN(h) AS mn, MAX(h) AS mx FROM cover WHERE kind=? AND ref=?'),
    firstAny: db.prepare('SELECT MIN(h) AS mn, MAX(h) AS mx FROM cover'),
    stats: db.prepare('SELECT (SELECT COUNT(*) FROM spikes) AS spikeRows, (SELECT COALESCE(SUM(n),0) FROM spikes) AS moments, (SELECT COUNT(*) FROM cover) AS coverRows'),
    // v2.596(감사 DB-4): 인덱스는 t0 에만 있다 — t0 ≤ t1 이므로 't0 < before' 를 함께 걸어 idx_spikes_t0 를 타게 한다(결과 동일).
    pruneSpikes: db.prepare('DELETE FROM spikes WHERE t0 < ? AND t1 < ?'),
    pruneCover: db.prepare('DELETE FROM cover WHERE h < ?'),
    getMeta: db.prepare('SELECT v FROM meta WHERE k=?'),
    setMeta: db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
  };
}

/** vCenter 의 DB 핸들(없으면 생성). node:sqlite 미지원이면 null. */
// v2.580(BUG-A): 파일별 **진행 중 open 을 공유한다** — `open.get(file)` 검사와 핸들 생성 사이에 같은
// vCenter 의 두 번째 호출이 들어오면 같은 파일에 `DatabaseSync` 가 둘 생기고(`open.set` 이 덮어써) 첫
// 핸들이 새어 나갔다(단일 파일 모듈의 v2.580 재현과 같은 유형). 파일 단위로 in-flight 를 공유한다.
const opening = new Map(); // file -> Promise<entry>
export async function getVmSeriesDb(vcenterId, { create = true } = {}) {
  const mod = await loadSqlite();
  if (!mod) return null;
  const file = dbFileName(vcenterId);
  const hit = open.get(file);
  if (hit) { hit.usedAt = Date.now(); return hit; }
  if (opening.has(file)) return opening.get(file);
  const p = openFile(vcenterId, file, mod, create).finally(() => { opening.delete(file); });
  opening.set(file, p);
  return p;
}
async function openFile(vcenterId, file, mod, create) {
  const p = path.join(DIR, `${file}.db`);
  // 조회 경로가 없는 vCenter id 로 파일을 무한 생성하지 않게(toolsCapacity v2.447 교훈) — create=false 면 없으면 null.
  if (!create && !fs.existsSync(p)) return null;
  fs.mkdirSync(DIR, { recursive: true });
  // v2.599 DB2599-02: busy_timeout 먼저(첫 생성 중 다른 연결의 잠금을 기다린다) · 실패하면 핸들을 닫는다(fd 누수 방지 —
  //   파일별 핸들이라 다음 호출이 다시 연다. 래치 없음).
  const db = openSqlite(new mod.DatabaseSync(p));
  let st;
  try { st = prepare(db); } catch (e) { try { db.close(); } catch { /* */ } throw e; }
  try { fs.chmodSync(p, 0o600); } catch { /* best effort */ }
  rememberIndex(file, String(vcenterId ?? ''));
  const entry = { db, st, usedAt: Date.now(), file, path: p };
  open.set(file, entry);
  evictIfNeeded();
  return entry;
}

/**
 * 한 vCenter 의 한 주기 결과를 적재(트랜잭션 1회).
 * rows: { spikes:[{kind,ref,t0,t1,n,cols,buf}], cover:[{kind,ref,h,samples}], cursors:[{kind,ref,lastTs}] }
 */
export async function commitVmSeries(vcenterId, rows) {
  const x = await getVmSeriesDb(vcenterId);
  if (!x) return { ok: false, reason: 'node:sqlite 없음' };
  const t = Date.now();
  x.db.exec('BEGIN');
  try {
    for (const s of rows.spikes || []) x.st.insSpike.run(s.kind, s.ref, s.t0, s.t1, s.n, JSON.stringify(s.cols), s.buf, Number.isFinite(s.mxcpu) ? s.mxcpu : -1, Number.isFinite(s.mxmem) ? s.mxmem : -1);
    for (const c of rows.cover || []) x.st.upCover.run(c.kind, c.ref, c.h, c.samples);
    for (const c of rows.cursors || []) x.st.upCursor.run(c.kind, c.ref, c.lastTs);
    x.db.exec('COMMIT');
  } catch (e) {
    try { x.db.exec('ROLLBACK'); } catch { /* */ }
    throw e;
  }
  return { ok: true, spikes: (rows.spikes || []).length, cover: (rows.cover || []).length, ms: Date.now() - t };
}

/** 겹침 중복 방지 커서 전체(Map<`${kind}|${ref}`, lastTs>). */
export async function loadCursors(vcenterId) {
  const x = await getVmSeriesDb(vcenterId, { create: false });
  const m = new Map();
  if (!x) return m;
  for (const r of x.st.allCursors.all()) m.set(`${r.kind}|${r.ref}`, Number(r.last_ts) || 0);
  return m;
}

/** 엔티티의 창 안 스파이크 행(패킹된 상태 — 호출자가 unpack). */
export async function spikeRows(vcenterId, kind, ref, fromTs, toTs) {
  const x = await getVmSeriesDb(vcenterId, { create: false });
  if (!x) return null;              // null = 이 vCenter 의 DB 자체가 없음(수집 대상 아님/미수집)
  return x.st.spikesOf.all(kind, ref, fromTs, toTs);
}

/** 창 안 모든 엔티티의 스파이크 행(패킹 그대로). */
export async function spikeRowsInWindow(vcenterId, fromTs, toTs) {
  const x = await getVmSeriesDb(vcenterId, { create: false });
  if (!x) return null;
  return x.st.spikesInWindow.all(fromTs, toTs);
}

/** 창 안 엔티티별 행 집계(BLOB 미해제) — 전 VM 순위. */
export async function topInWindow(vcenterId, fromTs, toTs, limit = 200) {
  const x = await getVmSeriesDb(vcenterId, { create: false });
  if (!x) return null;
  return x.st.topInWindow.all(fromTs, toTs, Math.max(1, Math.min(2000, limit))).map((r) => ({
    kind: r.kind, ref: r.ref, rows: Number(r.rows), moments: Number(r.moments), mxcpu: Number(r.mxcpu), mxmem: Number(r.mxmem), firstT: Number(r.firstT), lastT: Number(r.lastT),
  }));
}

/** 엔티티의 시간별 관측 표본 수 + 첫/마지막 관측 시간. */
export async function coverageOf(vcenterId, kind, ref, fromTs, toTs) {
  const x = await getVmSeriesDb(vcenterId, { create: false });
  if (!x) return null;
  const hours = x.st.coverOf.all(kind, ref, fromTs, toTs).map((r) => ({ h: Number(r.h), samples: Number(r.samples) }));
  const fl = x.st.firstCover.get(kind, ref);
  return { hours, firstH: fl?.mn ?? null, lastH: fl?.mx ?? null };
}

/** vCenter 단위 시간별 관측(엔티티 수·표본 합) — 전 VM 순위 화면의 커버리지. */
export async function coverageHours(vcenterId, kind, fromTs, toTs) {
  const x = await getVmSeriesDb(vcenterId, { create: false });
  if (!x) return null;
  return x.st.coverHours.all(kind, fromTs, toTs).map((r) => ({ h: Number(r.h), entities: Number(r.entities), samples: Number(r.samples) }));
}

export async function vmSeriesMeta(vcenterId, key) {
  const x = await getVmSeriesDb(vcenterId, { create: false });
  if (!x) return null;
  const r = x.st.getMeta.get(key);
  if (!r) return null;
  try { return JSON.parse(r.v); } catch { return r.v; }
}
export async function setVmSeriesMeta(vcenterId, key, value) {
  const x = await getVmSeriesDb(vcenterId);
  if (!x) return false;
  x.st.setMeta.run(key, JSON.stringify(value));
  return true;
}

export async function vmSeriesDbStats(vcenterId) {
  const x = await getVmSeriesDb(vcenterId, { create: false });
  if (!x) return null;
  const s = x.st.stats.get();
  const fa = x.st.firstAny.get();
  return { spikeRows: Number(s?.spikeRows || 0), moments: Number(s?.moments || 0), coverRows: Number(s?.coverRows || 0), firstH: fa?.mn ?? null, lastH: fa?.mx ?? null };
}

/** 보존기간 prune(0 = 무제한). */
export async function pruneVmSeries(vcenterId, retentionDays) {
  const days = Number(retentionDays) || 0;
  if (days <= 0) return 0;
  const x = await getVmSeriesDb(vcenterId, { create: false });
  if (!x) return 0;
  const before = Date.now() - days * 86_400_000;
  let n = 0;
  try { n = x.st.pruneSpikes.run(before, before)?.changes ?? 0; } catch { /* */ }
  try { x.st.pruneCover.run(before - HOUR); } catch { /* */ }
  return n;
}

export function closeVmSeriesDb(vcenterId) {
  const file = dbFileName(vcenterId);
  const e = open.get(file);
  if (!e) return false;
  open.delete(file);
  try { e.db.close(); } catch { /* */ }
  return true;
}

/** 파일째 삭제(-wal/-shm 포함) — 대상 제외 시 용량 즉시 회수. */
export function dropVmSeriesDb(vcenterId) {
  closeVmSeriesDb(vcenterId);
  const base = path.join(DIR, `${dbFileName(vcenterId)}.db`);
  let removed = 0;
  for (const p of [base, `${base}-wal`, `${base}-shm`]) {
    try { if (fs.existsSync(p)) { fs.rmSync(p); removed++; } } catch { /* */ }
  }
  return removed;
}

/** 디스크 사용 현황 — [{ vcenterId, file, bytes }] (인덱스로 원본 id 역산). */
export function vmSeriesDiskUsage() {
  let files = [];
  try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.db')); } catch { return []; }
  const idx = readIndex();
  return files.map((f) => {
    const base = f.replace(/\.db$/, '');
    let bytes = 0;
    for (const suffix of ['', '-wal', '-shm']) { try { bytes += fs.statSync(path.join(DIR, `${f}${suffix}`)).size; } catch { /* */ } }
    return { vcenterId: idx[base] !== undefined ? idx[base] : base, file: f, bytes };
  }).sort((a, b) => b.bytes - a.bytes);
}

/** 여유 디스크(bytes). statfs 미지원/실패면 null(가드는 '모름' 을 막지 않는다 — 로그만). */
export function vmSeriesFreeBytes() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const s = fs.statfsSync(DIR);
    return Number(s.bavail) * Number(s.bsize);
  } catch { return null; }
}

export const vmSeriesDir = () => DIR;
