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
import crypto from 'node:crypto';
import path from 'node:path';
import { config } from '../config.js';
import { dbFileName } from '../metrics/vmperfDb.js';
import { openSqlite } from '../util/sqliteOpen.js';
import { chunkedDelete, createPruneFlight } from '../util/chunkedPrune.js';
import { pageArgs } from '../util/pageArgs.js'; // v2.605 LEFT2605-07: 소수 limit 은 SQLite 바인드 datatype mismatch(500)

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
    CREATE TABLE IF NOT EXISTS cover_batch (hash TEXT PRIMARY KEY, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_cover_batch_at ON cover_batch (at);
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
    // v2.603(감사 DB2603-02): 청크 DELETE 형태(LIMIT 은 chunkedDelete 가 붙인다) — 한 방 DELETE 는 보존일을 줄이면
    //   BLOB 행 수십만 개를 동기로 지워 이벤트 루프를 멈췄다. 서브쿼리는 idx_spikes_t0·idx_cover_h 를 탄다(바깥의 같은
    //   조건은 결과가 같고 v2.596 DB-4 의 't0 인덱스' 형태를 남긴다 — 인자는 경계 4개 + LIMIT).
    pruneSpikes: db.prepare('DELETE FROM spikes WHERE t0 < ? AND t1 < ? AND rowid IN (SELECT rowid FROM spikes WHERE t0 < ? AND t1 < ? LIMIT ?)'),
    pruneCover: db.prepare('DELETE FROM cover WHERE rowid IN (SELECT rowid FROM cover WHERE h < ? LIMIT ?)'),
    getMeta: db.prepare('SELECT v FROM meta WHERE k=?'),
    setMeta: db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
    // v2.600(EDGE2600-03): 같은 엣지 청크의 재전송 표식 — cover 는 가산(upsert samples+=)이라 재전송이 두 번 센다.
    insBatch: db.prepare('INSERT OR IGNORE INTO cover_batch (hash, at) VALUES (?, ?)'),
    pruneBatch: db.prepare('DELETE FROM cover_batch WHERE at < ?'),
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
/** 재전송 판정 보관 기간 — 엣지 재시도(resilientFetch)는 분 단위이고 수집 주기는 20~60분이라 하루면 충분하다. */
const BATCH_KEEP_MS = 2 * 86_400_000;
/**
 * cover 배치 지문(v2.600 EDGE2600-03) — 엣지 한 청크의 cover 내용 + (있으면) 엣지가 붙인 식별(generatedAt·chunk).
 * 서로 다른 주기는 커서로 창이 겹치지 않아 (ref, h, samples) 집합이 같을 수 없다 — 같으면 **같은 청크의 재전송**이다.
 */
export function coverBatchHash(cover, tag = '') {
  return crypto.createHash('sha1').update(String(tag)).update('\n').update(JSON.stringify(cover || [])).digest('hex');
}

/**
 * @param opts.dedupeTag 주면(중앙 수신 경로) 같은 tag+cover 의 재적재에서 cover 가산을 건너뛴다 — spikes(INSERT OR REPLACE)·
 *   cursor(MAX)는 원래 멱등이라 그대로 적재한다. 로컬 폴러는 재전송이 없으므로 주지 않는다(예전 동작).
 */
export async function commitVmSeries(vcenterId, rows, { dedupeTag = null } = {}) {
  const x = await getVmSeriesDb(vcenterId);
  if (!x) return { ok: false, reason: 'node:sqlite 없음' };
  const t = Date.now();
  let coverDuplicate = false;
  x.db.exec('BEGIN');
  try {
    for (const s of rows.spikes || []) x.st.insSpike.run(s.kind, s.ref, s.t0, s.t1, s.n, JSON.stringify(s.cols), s.buf, Number.isFinite(s.mxcpu) ? s.mxcpu : -1, Number.isFinite(s.mxmem) ? s.mxmem : -1);
    const cover = rows.cover || [];
    if (dedupeTag != null && cover.length) {
      x.st.pruneBatch.run(t - BATCH_KEEP_MS);
      coverDuplicate = (x.st.insBatch.run(coverBatchHash(cover, dedupeTag), t)?.changes ?? 1) === 0;
    }
    if (!coverDuplicate) for (const c of cover) x.st.upCover.run(c.kind, c.ref, c.h, c.samples);
    for (const c of rows.cursors || []) x.st.upCursor.run(c.kind, c.ref, c.lastTs);
    x.db.exec('COMMIT');
  } catch (e) {
    try { x.db.exec('ROLLBACK'); } catch { /* */ }
    throw e;
  }
  return { ok: true, spikes: (rows.spikes || []).length, cover: coverDuplicate ? 0 : (rows.cover || []).length, ...(coverDuplicate ? { coverDuplicate: true } : {}), ms: Date.now() - t };
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
  return x.st.topInWindow.all(fromTs, toTs, pageArgs({ limit }, { def: 200, max: 2000 }).limit).map((r) => ({
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

/**
 * 보존기간 prune(0 = 무제한). 지운 스파이크 행 수를 돌려준다.
 * v2.603(감사 DB2603-02·RECENT2603-06): 청크 삭제 + 청크 사이 양보(util/chunkedPrune.js). 파일(vCenter)마다 정리끼리
 * 겹치지 않는다 — 같은 보존일이면 진행 중인 것을 공유하고, 바뀌었으면 끝난 뒤 새 경계로 한 번 더 돈다.
 */
const pruneFlights = new Map();   // file -> createPruneFlight() (파일=vCenter 마다 하나)
export async function pruneVmSeries(vcenterId, retentionDays) {
  const days = Number(retentionDays) || 0;
  if (days <= 0) return 0;
  const x = await getVmSeriesDb(vcenterId, { create: false });
  if (!x) return 0;
  const file = dbFileName(vcenterId);
  let flight = pruneFlights.get(file);
  if (!flight) { flight = createPruneFlight(); pruneFlights.set(file, flight); }
  return flight.run(days, async () => {
    const before = Date.now() - days * 86_400_000;
    let n = 0;
    try { n = (await chunkedDelete(x.st.pruneSpikes, [before, before, before, before], { label: `vmseries.${vcenterId}.spikes` })).deleted; } catch (e) { console.warn(`[vmseries] ${vcenterId} prune 실패: ${e?.message || e}`); }
    try { await chunkedDelete(x.st.pruneCover, [before - HOUR], { label: `vmseries.${vcenterId}.cover` }); } catch (e) { console.warn(`[vmseries] ${vcenterId} cover prune 실패: ${e?.message || e}`); }
    return n;
  }).finally(() => { if (!flight.active) pruneFlights.delete(file); });
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
