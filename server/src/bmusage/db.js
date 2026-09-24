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
      );`);
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

export async function available() { return !!(await getDb()); }
export async function dbStatus() {
  const db = await getDb();
  if (!db) return { available: false, path: FILE() };
  try {
    /*
     * ⚠ 행 수는 **짧게 캐시한다**(v2.550.3 실측): `COUNT(*)` 는 커버링 인덱스를 타지만 518만 행에서
     *   **27ms** 이고 이 함수는 화면 로드마다 돈다. 이 값은 진단·참고용("현재 원시 N행")이라 초
     *   단위로 정확할 이유가 없다. **캐시라는 사실은 숨기지 않는다** — `countsAt` 을 함께 싣는다.
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
    return { available: true, path: FILE(), rawRows: raw, dailyRows: daily, countsAt: _counts?.at ?? null, firstTs: span.a ?? null, lastTs: span.b ?? null, bytes };
  } catch (e) { return { available: true, path: FILE(), error: String(e?.message || e).slice(0, 200) }; }
}

const n = numOrNull;   // v2.561: 공용 판정

/**
 * 한 주기의 행들을 적재하고 일 롤업을 갱신한다. **트랜잭션 1회**로 묶는다
 * (CLAUDE.md: 무트랜잭션 대량 write 가 과거 25초 블로킹을 만들었다).
 * @param {Array} rows  `[{ key, ts, name, vcenterId, src, cpu_pct, … }]`
 * @param {string} agent
 */
export async function insertUsage(rows = [], agent = '') {
  const db = await getDb();
  if (!db || !rows.length) return { ok: !!db, inserted: 0 };
  /*
   * ⚠ **`INSERT OR IGNORE`** 다(예전에는 `OR REPLACE`). 같은 `(agent,key,ts)` 가 두 번 오면
   *   history 는 덮어써도 **일 롤업은 두 번 누적**돼 평균·표본수가 틀어진다. IGNORE 로 두고
   *   `changes` 가 1일 때만 롤업을 갱신하면 그 이중 계수가 **구조적으로 없다**(쿼리 수는 같다).
   */
  const ins = db.prepare(`INSERT OR IGNORE INTO usage_history
    (agent,key,ts,name,vcenter_id,src,cpu_pct,mem_pct,disk_busy_pct,disk_used_pct,net_pct,net_bps,hba_pct,hba_bps,io_pct)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  /*
   * ⚠ 일 롤업은 **`ON CONFLICT DO UPDATE`** 다(예전에는 `SELECT` + `OR REPLACE` 로 행당 2쿼리).
   *   200행/주기 실측 **14.5ms → 7.4ms**. SQL 안에서 누적하므로 읽기 왕복이 사라진다.
   *   ⚠ `MAX()` 는 인자 중 하나가 NULL 이면 NULL 을 준다 — `IFNULL(...,-1e308)` 로 감싸고
   *     결과가 그 하한이면 NULL 로 되돌린다(첫 관측이 null 인 지표를 0 으로 만들지 않기 위해).
   *   ⚠ `cpu_n` 은 **값이 있을 때만** 1 을 더한다(호출부가 0/1 을 넘긴다) — null 을 분모에 넣으면
   *     '못 읽은 주기' 가 평균을 0 쪽으로 끌어내린다.
   */
  const upDay = db.prepare(`INSERT INTO usage_daily
    (agent,key,day,name,vcenter_id,cpu_sum,cpu_n,cpu_max,mem_sum,mem_n,mem_max,
     disk_busy_max,disk_used_max,net_max,net_bps_max,hba_max,hba_bps_max,io_max,samples,last_ts)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(agent,key,day) DO UPDATE SET
      name=excluded.name, vcenter_id=excluded.vcenter_id,
      cpu_sum=cpu_sum+excluded.cpu_sum, cpu_n=cpu_n+excluded.cpu_n,
      cpu_max=NULLIF(MAX(IFNULL(cpu_max,-1e308),IFNULL(excluded.cpu_max,-1e308)),-1e308),
      mem_sum=mem_sum+excluded.mem_sum, mem_n=mem_n+excluded.mem_n,
      mem_max=NULLIF(MAX(IFNULL(mem_max,-1e308),IFNULL(excluded.mem_max,-1e308)),-1e308),
      disk_busy_max=NULLIF(MAX(IFNULL(disk_busy_max,-1e308),IFNULL(excluded.disk_busy_max,-1e308)),-1e308),
      disk_used_max=NULLIF(MAX(IFNULL(disk_used_max,-1e308),IFNULL(excluded.disk_used_max,-1e308)),-1e308),
      net_max=NULLIF(MAX(IFNULL(net_max,-1e308),IFNULL(excluded.net_max,-1e308)),-1e308),
      net_bps_max=NULLIF(MAX(IFNULL(net_bps_max,-1e308),IFNULL(excluded.net_bps_max,-1e308)),-1e308),
      hba_max=NULLIF(MAX(IFNULL(hba_max,-1e308),IFNULL(excluded.hba_max,-1e308)),-1e308),
      hba_bps_max=NULLIF(MAX(IFNULL(hba_bps_max,-1e308),IFNULL(excluded.hba_bps_max,-1e308)),-1e308),
      io_max=NULLIF(MAX(IFNULL(io_max,-1e308),IFNULL(excluded.io_max,-1e308)),-1e308),
      samples=samples+1, last_ts=MAX(IFNULL(last_ts,0),excluded.last_ts)`);
  /* 최신값 테이블 — ⚠ **`ts` 가 더 클 때만** 갱신한다(엣지 push 는 순서대로 오지 않는다 — v2.531 규약). */
  const upLatest = db.prepare(`INSERT INTO usage_latest
    (agent,key,ts,name,vcenter_id,src,cpu_pct,mem_pct,disk_busy_pct,disk_used_pct,net_pct,net_bps,hba_pct,hba_bps,io_pct)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(agent,key) DO UPDATE SET
      ts=excluded.ts, name=excluded.name, vcenter_id=excluded.vcenter_id, src=excluded.src,
      cpu_pct=excluded.cpu_pct, mem_pct=excluded.mem_pct,
      disk_busy_pct=excluded.disk_busy_pct, disk_used_pct=excluded.disk_used_pct,
      net_pct=excluded.net_pct, net_bps=excluded.net_bps,
      hba_pct=excluded.hba_pct, hba_bps=excluded.hba_bps, io_pct=excluded.io_pct
      WHERE excluded.ts > usage_latest.ts`);
  let inserted = 0; let duplicates = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const key = String(r.key || '').trim();
      const ts = Number(r.ts);
      if (!key || !Number.isFinite(ts)) continue;
      const name = String(r.name || ''); const vc = String(r.vcenterId || '');
      const cpu = n(r.cpu_pct); const mem = n(r.mem_pct);
      const vals = [n(r.disk_busy_pct), n(r.disk_used_pct), n(r.net_pct), n(r.net_bps), n(r.hba_pct), n(r.hba_bps), n(r.io_pct)];
      const res = ins.run(agent, key, ts, name, vc, String(r.src || ''), cpu, mem, ...vals);
      // ⚠ 같은 ts 가 이미 있으면(changes 0) 롤업을 **건드리지 않는다** — 이중 계수 방지.
      if (!Number(res?.changes)) { duplicates += 1; continue; }
      inserted += 1;

      upDay.run(
        agent, key, dayKey(ts), name, vc,
        // ⚠ null 은 합·개수에 넣지 않는다 — 넣으면 '못 읽은 주기' 가 평균을 끌어내린다.
        cpu ?? 0, cpu == null ? 0 : 1, cpu,
        mem ?? 0, mem == null ? 0 : 1, mem,
        ...vals, 1, ts,
      );
      upLatest.run(agent, key, ts, name, vc, String(r.src || ''), cpu, mem, ...vals);
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* */ }
    return { ok: false, inserted: 0, error: String(e?.message || e).slice(0, 200) };
  }
  if (inserted) _counts = null;
  return { ok: true, inserted, duplicates };
}

/**
 * 보존기간 집행. ⚠ **스로틀은 `(++tick % N) === 0`** — `% N === 1` 이나 `tick++` 는 기동 첫 틱에
 * 즉시 참이 되어, 보존기간을 줄이고 재시작하면 첫 틱이 차액을 한 번에 지운다(v2.453 규칙).
 */
export async function pruneUsage({ rawDays = 90, dailyDays = 365 * 5, every = 12, force = false } = {}) {
  const db = await getDb();
  if (!db) return { ok: false };
  if (!force && (++_tick % every) !== 0) return { ok: true, skipped: true };
  // v2.602(감사 DB2602-01): 청크 DELETE + 청크 사이 양보(util/chunkedPrune.js, v2.453 규약). 예전 단일 DELETE 는 보존일을
  //   줄이면 수백만 행을 동기로 지워 이벤트 루프가 멈췄다(감사 재현: 184만 행 3.2초). prune 끼리는 겹치지 않게 진행 중인
  //   작업을 공유한다(청크 사이에 다음 주기·수동 호출이 끼어들 수 있다). 상한에 걸린 나머지는 다음 주기가 잇는다(done:false).
  if (_pruning) return _pruning;
  const rawCut = Date.now() - rawDays * 86_400_000;
  const dayCut = dayKey(Date.now() - dailyDays * 86_400_000);
  _pruning = (async () => {
    try {
      const a = await chunkedDelete(db.prepare('DELETE FROM usage_history WHERE rowid IN (SELECT rowid FROM usage_history WHERE ts < ? LIMIT ?)'), [rawCut], { label: 'bmusage.usage_history' });
      const b = await chunkedDelete(db.prepare('DELETE FROM usage_daily WHERE rowid IN (SELECT rowid FROM usage_daily WHERE day < ? LIMIT ?)'), [dayCut], { label: 'bmusage.usage_daily' });
      if (a.deleted || b.deleted) _counts = null;
      return { ok: true, rawDeleted: a.deleted, dailyDeleted: b.deleted, done: a.done && b.done };
    } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) }; }
  })().finally(() => { _pruning = null; });
  return _pruning;
}
let _pruning = null;

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
 */
export async function latestUsage() {
  const db = await getDb();
  if (!db) return [];
  try { return db.prepare('SELECT * FROM usage_latest').all(); } catch { return []; }
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
    /*
     * ⚠ 전체 조회도 **agent 로 걸러야 한다**(v2.550.3 에 고친 결함): 예전에는 `key` 가 없으면
     *   agent 조건이 사라져 중앙이 자기 행과 엣지 행을 섞어 돌려줬다. 두 노드의 같은 서비스태그
     *   서버가 한 계열로 합쳐지는 종류의 거짓이다(v2.548 `(agent, part_key)` 와 같은 판단).
     */
    const rows = key
      ? db.prepare('SELECT * FROM usage_daily WHERE key=? AND agent=? AND day>=? ORDER BY day').all(String(key), String(agent), from)
      : db.prepare('SELECT * FROM usage_daily WHERE agent=? AND day>=? ORDER BY day, key').all(String(agent), from);
    return rows.map((r) => ({
      ...r,
      cpu_avg: r.cpu_n > 0 ? Math.round((r.cpu_sum / r.cpu_n) * 10) / 10 : null,
      mem_avg: r.mem_n > 0 ? Math.round((r.mem_sum / r.mem_n) * 10) / 10 : null,
    }));
  } catch { return []; }
}

export function _resetForTest() { lockRetry.ok(); try { _db?.close?.(); } catch { /* */ } _db = null; _tried = false; _opening = null; _tick = 0; _counts = null; }
