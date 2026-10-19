/**
 * vCenter 이벤트 로그 장기 보관 DB. vCenter는 이벤트를 단기간만 보관하므로, 포탈이 주기적으로
 * 수집해 여기 누적한다. Node 내장 SQLite(--experimental-sqlite) 우선, 없으면 NDJSON 폴백.
 * 중복은 (vcenterId, key)로 제거. 보관기간 초과분은 poller가 prune한다.
 */

// v2.594(감사 SEC-2594-01): 호출부가 무엇을 넘기든 LIMIT 는 1~5만·정수, OFFSET 은 0 이상 정수 — 음수 LIMIT 는 SQLite 에서 '무제한'.
const clampPage = (l, o) => {
  const li = Math.trunc(Number(l)); const oi = Math.trunc(Number(o));
  return [Number.isFinite(li) && li > 0 ? Math.min(li, 50_000) : 200, Number.isFinite(oi) && oi > 0 ? Math.min(oi, Number.MAX_SAFE_INTEGER) : 0];
};
import fs from 'node:fs';
import { atomicWriteFileSync } from '../util/atomicWrite.js';   // v2.741(LEFT-13): NDJSON 폴백 재기록은 tmp → rename
import path from 'node:path';
import { config } from '../config.js';
import { loadLogSettings } from './settings.js';
import { openSqlite, retryOnLock } from '../util/sqliteOpen.js';
import { chunkedDelete, nextAdaptiveChunk, PRUNE_CHUNK_ROWS } from '../util/chunkedPrune.js';
import { TRACKED_TYPES, TRACKED_SQL, OPS_TYPES, OPS_SQL } from '../vmchanges/eventDetail.js'; // v2.702(A7·A8): 이동·구성 변경·권한 이벤트 상세
import { createYielder } from '../util/timeSlice.js';
import { LOGIN_FAIL_SQL, isLoginFailRow } from './loginFailPattern.js'; // v2.673: 로그인 실패 후보 조건(정규식과 같은 뜻 — 단일 소스)   // v2.599 DB2599-02: 첫 open 잠금 → 기다렸다 재시도(NDJSON 폴백 래치 금지)

// 저장 위치: 설정의 storagePath(빈값=CONFIG_DIR). 각 포탈이 자기 데이터만 로컬 보관.
function dbPath() {
  const s = loadLogSettings();
  const dir = s.storagePath && s.storagePath.trim() ? s.storagePath.trim() : config.configDir;
  return path.join(dir, 'vcenter-logs.db');
}

// `meta()`(수집 기간·vCenter별 건수) memo 수명. 이 호출은 풀스캔 2회라 행 수에 비례하고,
// 로그 화면이 페이지를 넘길 때마다 반복된다(v2.503). 헤더 한 줄이 최대 이만큼 낡을 수 있다.
// v2.606(DB2606-01): 기본 30초가 설정 화면 상태 폴링(30초)과 같아 다음 요청이 거의 항상 miss 였다(4.5M 행이면 30초마다
//   약 0.9초 정지). 이제 memo 는 **건수(COUNT·vCenter별 GROUP BY)** 만 들고 기본 5분(상한 30분)이며, 기간(MIN·MAX)은
//   단독 aggregate(인덱스 끝점 조회 — v2.550.3)로 매번 새로 읽는다.
const META_TTL_MS = Math.max(1_000, Math.min(1_800_000, Number(process.env.LOGS_META_TTL_MS) || 300_000));

/**
 * v2.742(감사 DB-04 — 재현): 이 표의 prune 청크. 전역 PRUNE_CHUNK_ROWS(2만 행)는 '한 청크 수십 ms' 를 전제로 정했는데, events 는
 *   인덱스가 7개(uniq·(vc,ts)·ts·전원·추적·운영·추적 엔티티)이고 메시지 열이 길어 2만 행 한 청크가 0.2~0.5초 동기였다(합성 70만 행 실측
 *   318~580ms — 용량 상한 루프는 그런 정지를 연달아 만든다). 그래서 **작게 시작해 시간 기준으로 맞춘다**(util/chunkedPrune.js targetMs —
 *   목표를 넘으면 줄이고, 절반도 안 걸리면 두 배로 늘린다. 상한은 전역 청크). 지우는 조건·행은 같다 — 청크 크기만 바뀐다.
 *   전역 청크를 env 로 더 작게 잡았으면 그것을 따른다(테스트가 500 으로 잡는다).
 */
const LOGS_PRUNE_TARGET_MS = 40;
const LOGS_PRUNE_CHUNK_START = Math.min(PRUNE_CHUNK_ROWS, 2_000);
const LOGS_PRUNE_CHUNK_MIN = Math.min(PRUNE_CHUNK_ROWS, 500);
/** 직전 청크 소요로 다음 청크 크기를 정한다 — chunkedDelete 의 targetMs 와 같은 함수(util/chunkedPrune.js nextAdaptiveChunk). */
const nextPruneChunk = (chunk, want, tookMs) => nextAdaptiveChunk(chunk, want, tookMs, { targetMs: LOGS_PRUNE_TARGET_MS, minChunk: LOGS_PRUNE_CHUNK_MIN, maxChunk: PRUNE_CHUNK_ROWS });

/** v2.607 DB2607-02: 필터 조회의 total 상한(맞는 행을 이만큼까지만 센다). */
export const COUNT_CAP = 10_000;
const capOf = (cap) => { const n = Math.trunc(Number(cap)); return Number.isFinite(n) && n >= 1 ? Math.min(n, 1_000_000) : COUNT_CAP; };
/** v2.607 DB2607-03: LIKE 패턴 이스케이프(\ % _) — ESCAPE '\' 와 짝이다. */
export const likeEscape = (q) => String(q).replace(/[\\%_]/g, (c) => `\\${c}`);
/**
 * v2.732(점검 2회차 B6-01): 적재를 조각 트랜잭션으로 나눌 때의 **안전한 자르기 지점**(순수 — 테스트가 성질을 고정한다).
 *
 * 왜 아무 데서나 자르면 안 되나: 조각 하나를 COMMIT 한 직후 프로세스가 죽으면, 다음 수집은 `sinceTs = MAX(ts)+1` 부터 읽는다
 * (logs/poller.js — db.lastTs). 그때 아직 적재하지 못한 행 중 ts 가 그 MAX 이하인 것(같은 ts 묶음의 나머지·순서가 어긋난 행)은
 * **영영 건너뛴다**. 그래서 자르는 지점은 '앞에서 이미 넣은 행의 최대 ts < 남은 행의 최소 ts' 를 만족하는 곳뿐이다.
 * 행 순서는 바꾸지 않는다(INSERT OR IGNORE 의 첫 행 우선·같은 ts 안의 rowid 순서가 한 트랜잭션 판과 같아야 한다).
 * 그런 지점이 없으면(같은 ts 가 끝까지 이어지거나 순서가 뒤섞였으면) 한 조각 = 예전 한 트랜잭션이다. ts 를 숫자로 읽지 못한 행이
 * 있으면 그 행을 넘어서는 자르지 않는다(판정 불가 — 안전한 쪽).
 * @param {{ts:any}[]} rows
 * @param {number} chunkRows 조각의 최소 행 수(이만큼 모은 뒤 첫 안전 지점에서 자른다)
 * @returns {[number, number][]} [시작, 끝) 구간들 — 이어 붙이면 원래 배열 전체
 */
export function tsSafeChunks(rows, chunkRows = 1000) {
  const n = Array.isArray(rows) ? rows.length : 0;
  const lim = Math.trunc(Number(chunkRows));
  const per = Number.isFinite(lim) && lim >= 1 ? lim : 1000;
  if (n <= per) return n ? [[0, n]] : [];
  const tsOf = (r) => { const t = r?.ts == null || r?.ts === '' ? NaN : Number(r.ts); return Number.isFinite(t) ? t : null; };
  // 남은 행의 최소 ts(뒤에서부터) — 숫자가 아닌 ts 가 있으면 -Infinity(그 앞에서는 자르지 않는다)
  const sufMin = new Array(n + 1);
  sufMin[n] = Infinity;
  for (let i = n - 1; i >= 0; i--) { const t = tsOf(rows[i]); sufMin[i] = t == null ? -Infinity : Math.min(t, sufMin[i + 1]); }
  const out = [];
  let start = 0;
  let preMax = -Infinity;   // 지금까지 넣은(앞) 행 전체의 최대 ts — 숫자가 아니면 +Infinity(그 뒤로는 자르지 않는다)
  for (let i = 0; i < n; i++) {
    const t = tsOf(rows[i]);
    preMax = t == null ? Infinity : Math.max(preMax, t);
    if (i + 1 - start >= per && i + 1 < n && preMax < sufMin[i + 1]) { out.push([start, i + 1]); start = i + 1; }
  }
  out.push([start, n]);
  return out;
}

let impl = null;
let ready = null;
/** v2.632(A6-2632-02): 키셋 커서 검증 — 숫자가 아니면 커서 없음으로 두지 않고 던진다(조용히 처음부터 다시 내보내면 중복이다). */
function keysetCursor(c) {
  if (c == null) return null;
  const ts = Number(c.ts); const rid = Number(c.rid);
  if (!Number.isFinite(ts) || !Number.isFinite(rid)) throw new Error('잘못된 페이지 커서');
  return { ts, rid };
}

function initSqlite() {
  const DB_PATH = dbPath();
  // eslint-disable-next-line import/no-unresolved
  return import('node:sqlite').then(({ DatabaseSync }) => {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const db = openSqlite(new DatabaseSync(DB_PATH));   // busy_timeout 먼저 · 잠금이면 닫고 던진다
    // WAL + synchronous=NORMAL: 커밋당 fsync 2회(DELETE 저널) → 배치화(단건 insert 5ms→0.01ms 실측).
    // busy_timeout: 동시 접근 시 즉시 SQLITE_BUSY 실패 대신 대기.
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        vcenterId TEXT NOT NULL, k TEXT, ts INTEGER NOT NULL,
        severity TEXT, type TEXT, user TEXT, entity TEXT, message TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_uniq ON events (vcenterId, k);
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events (vcenterId, ts);
      -- prune(DELETE WHERE ts<?)·pruneOldest(ORDER BY ts)는 ts 단독 인덱스가 있어야 풀스캔/
      -- 풀정렬을 피한다(복합 (vcenterId,ts)로는 선행열 없는 ts 조건을 못 탐 — CLAUDE.md 규칙).
      CREATE INDEX IF NOT EXISTS idx_events_ts_only ON events (ts);
      -- v2.483 '꺼진 지 N일': 전원 이벤트만 담는 **부분 인덱스** — 전체 이벤트(수백만 행)를 인덱싱하지 않고
      -- 전원 on/off 행만 담아 작다. 최초 생성 시 테이블 1회 스캔(수백만 행이면 수 초, 기동 시 1회).
      -- 조회는 반드시 같은 WHERE type IN (...) 리터럴을 써야 이 인덱스를 탄다.
      CREATE INDEX IF NOT EXISTS idx_events_power ON events (vcenterId, type, entity, ts)
        WHERE type IN ('VmPoweredOffEvent','VmPoweredOnEvent');
    `);
    try { fs.chmodSync(DB_PATH, 0o600); } catch { /* */ }
    // v2.702(A7·A8): 이동·구성 변경·권한 이벤트의 상세(JSON) 열. 옛 DB 에는 없다 — table_info 로 없을 때만 더하고
    //   'duplicate column name' 만 삼킨다(v2.603 DB2603-01 — 잠금을 '열 있음' 으로 삼키면 프로세스 끝까지 폴백한다).
    if (!db.prepare('PRAGMA table_info(events)').all().some((c) => c.name === 'detail')) {
      try { db.exec('ALTER TABLE events ADD COLUMN detail TEXT'); } catch (e) { if (!/duplicate column name/i.test(String(e?.message))) throw e; }
    }
    // 추적 종류만 담는 부분 인덱스(전원 인덱스와 같은 판단 — 전체 이벤트를 인덱싱하지 않는다). 조회는 같은 리터럴을 써야 탄다.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_events_tracked ON events (vcenterId, type, ts) WHERE type IN ${TRACKED_SQL}`);
    // v2.706(C5·C4·C6): 운영 이벤트(VM 생성·삭제·전원·HA 재시작 · 호스트 유지보수·연결 끊김) 전용 부분 인덱스.
    //   추적 인덱스에 종류를 더하지 않은 이유: 옛 DB 의 idx_events_tracked 조건이 새 IN 목록을 덮지 못해 INDEXED BY 가 실패한다.
    //   최초 생성 시 테이블 1회 스캔(기동 1회 — 전원·추적 인덱스와 같은 비용).
    db.exec(`CREATE INDEX IF NOT EXISTS idx_events_ops ON events (vcenterId, type, ts) WHERE type IN ${OPS_SQL}`);
    // v2.719(감사 S1-05): VM 상세 '변경 이력'(entity 한 개) 전용 — idx_events_tracked 에는 entity 가 없어 그 vCenter 기간 내
    //   추적 이벤트를 전부 훑었다(30만 행 실측 ~200ms/창). 새 이름의 부분 인덱스라 옛 DB 에도 IF NOT EXISTS 로 더해진다(기동 1회 스캔).
    db.exec(`CREATE INDEX IF NOT EXISTS idx_events_tracked_entity ON events (vcenterId, entity, ts) WHERE type IN ${TRACKED_SQL}`);
    const ins = db.prepare('INSERT OR IGNORE INTO events (vcenterId,k,ts,severity,type,user,entity,message,detail) VALUES (?,?,?,?,?,?,?,?,?)');
    const lastTsStmt = db.prepare('SELECT MAX(ts) mx FROM events WHERE vcenterId=?');
    const firstTsStmt = db.prepare('SELECT MIN(ts) mn FROM events WHERE vcenterId=?'); // v2.706(C4): aggregate 하나 + (vcenterId,ts) 인덱스 — 선탐색
    // v2.601(감사 DB2601-03 — 재현): 예전 `DELETE FROM events WHERE ts < ?` 한 방은 183만 행에서 이벤트 루프를 4.8초 멈췄다
    // (metrics·idrac·pdu·dirusage 는 v2.453 chunkedPrune 를 쓰는데 logs 만 빠져 있었다). rowid 서브쿼리 + idx_events_ts_only.
    const pruneChunkStmt = db.prepare('DELETE FROM events WHERE rowid IN (SELECT rowid FROM events WHERE ts < ? LIMIT ?)');
    let pruneBg = null;                          // 진행 중인 백그라운드 청크 정리(단일 비행)
    // v2.742(DB-04): 동기로 지우는 첫 청크(prune)와 pruneOldest 의 청크 — 작게 시작해 직전 청크 소요로 맞춘다(nextPruneChunk).
    let pruneChunk = LOGS_PRUNE_CHUNK_START;
    let oldestChunk = LOGS_PRUNE_CHUNK_START;
    // v2.606(DB2606-01): MIN·MAX 를 한 쿼리에 두면 aggregate 2개라 인덱스를 통째로 훑는다(v2.550.3) — 단독으로 나눈다.
    const minTsStmt = db.prepare('SELECT MIN(ts) mn FROM events');
    const maxTsStmt = db.prepare('SELECT MAX(ts) mx FROM events');
    // v2.741(DB-01): 검색 개수를 rowid 구간 조각으로 셀 때의 끝점 — 단독 aggregate(rowid 끝점 조회).
    const minRowidStmt = db.prepare('SELECT MIN(rowid) m FROM events');
    const maxRowidStmt = db.prepare('SELECT MAX(rowid) m FROM events');
    // v2.741(DB-03): 사용 중 크기 판정 — 헤더 필드라 즉시 읽힌다.
    const pageCountStmt = db.prepare('PRAGMA page_count');
    const freelistStmt = db.prepare('PRAGMA freelist_count');
    const pageSizeStmt = db.prepare('PRAGMA page_size');
    const rowCountStmt = db.prepare('SELECT COUNT(*) n FROM events');
    let metaCache = null;                       // { at, n, vcs } — 아래 meta() 주석 참조(v2.503)
    // v2.744(감사 DB-03): vCenter 별 건수·마지막 시각. 예전 한 문장 'SELECT vcenterId, COUNT(*), MAX(ts) FROM events GROUP BY vcenterId'
    //   는 idx_events_ts 를 통째로 훑어(합성 150만 행 147ms · 250만 행 262ms) 캐시가 지날 때마다(5분) 한 번 동기 정지였다. 이제
    //   ① vCenter 목록은 재귀 CTE 로 인덱스를 건너뛰며(loose index scan — v2.675 metrics keysOf 와 같은 모양, (vcenterId, ts) 선행열)
    //   ② 건수는 vCenter 마다 'COUNT WHERE vcenterId=?'(같은 인덱스 SEARCH) ③ 마지막 시각은 vCenter 마다 MAX(ts) 단독 문장(lastTsStmt —
    //   인덱스 끝점). 전체 건수는 vCenter 별 건수의 합이다(vcenterId 는 NOT NULL 이라 COUNT(*) 와 같다 — 같은 값을 두 번 세지 않는다).
    //   결과(순서 포함 — 둘 다 vcenterId BINARY 오름차순)는 예전 GROUP BY 와 같다(audit2744e 가 대조). metaAsync 는 vCenter 사이에 양보한다.
    //   ⚠ 남는 한계: vCenter 하나의 COUNT 는 여전히 한 문장이다(그 vCenter 행 수에 비례 — 합성 150만 행 28대에서 최대 4.2ms).
    const vcIdsStmt = db.prepare(`WITH RECURSIVE vs(v) AS (
        SELECT (SELECT MIN(vcenterId) FROM events)
        UNION ALL SELECT (SELECT MIN(vcenterId) FROM events WHERE vcenterId>vs.v) FROM vs WHERE vs.v IS NOT NULL)
      SELECT v FROM vs WHERE v IS NOT NULL`);
    const vcCountStmt = db.prepare('SELECT COUNT(*) n FROM events WHERE vcenterId=?');
    let metaGen = 0;                            // 무효화 세대 — 계산 도중 지워졌으면(prune) 그 결과를 캐시에 넣지 않는다
    let metaInflight = null;                    // metaAsync 진행 중 계산(같은 계산을 겹쳐 돌리지 않는다)
    const invalidateMeta = () => { metaCache = null; metaGen++; };
    /** vCenter 하나씩 세는 단계 — 동기 meta() 는 끝까지 한 번에, metaAsync 는 단계 사이에 양보하며 돈다(판정은 이 생성기 하나). */
    function* metaCountSteps() {
      const vcs = []; let n = 0;
      for (const row of vcIdsStmt.all()) {
        const id = row.v;
        const c = Number(vcCountStmt.get(id)?.n || 0);
        vcs.push({ vcenterId: id, count: c, lastTs: Number(lastTsStmt.get(id)?.mx) });
        n += c;
        yield;
      }
      return { n, vcs };
    }
    // 용량 정리 루프가 반복 호출한다 — 매 회 prepare 하면 파싱·계획 수립이 반복된다(v2.503).
    const pruneOldestStmt = db.prepare('DELETE FROM events WHERE rowid IN (SELECT rowid FROM events ORDER BY ts ASC LIMIT ?)');
    /**
     * 보관기간 초과분 청크 삭제(비동기, 청크 사이 setImmediate 양보). 상한(PRUNE_MAX_ROWS)에 걸리면 다음 주기가 잇는다.
     * @returns {Promise<{deleted:number, done:boolean, chunks:number}>}
     */
    const pruneAsync = async (beforeTs) => {
      try { return await chunkedDelete(pruneChunkStmt, [beforeTs], { label: 'vclogs', chunk: pruneChunk, targetMs: LOGS_PRUNE_TARGET_MS, minChunk: LOGS_PRUNE_CHUNK_MIN, maxChunk: PRUNE_CHUNK_ROWS }); }
      finally { invalidateMeta(); }
    };
    const powerStmt = db.prepare("SELECT entity, type, MAX(ts) AS ts FROM events WHERE vcenterId=? AND type IN ('VmPoweredOffEvent','VmPoweredOnEvent') GROUP BY entity, type"); // idx_events_power
    const build = (where, params) => ({ where, params });
    function filterSql(f) {
      const w = []; const p = [];
      if (f.vcenterId) { w.push('vcenterId=?'); p.push(f.vcenterId); }
      // vcenterIds: 사용자 scope 강제용 화이트리스트. 빈 배열=허용 vCenter 없음 → 결과 없음(1=0).
      if (Array.isArray(f.vcenterIds)) {
        if (f.vcenterIds.length) { w.push(`vcenterId IN (${f.vcenterIds.map(() => '?').join(',')})`); p.push(...f.vcenterIds); }
        else { w.push('1=0'); }
      }
      // v2.742(감사 DB-02): 제외 목록 — 로그 이슈 분석이 '이 포탈이 지금 수집하지 않는 vCenter' 를 SQL 에서 바로 뺀다(예전에는 그 vCenter 만
      //   정확 COUNT 로 따로 세어 빼고, 뺀 만큼 더 읽어 거르느라 기간 전체를 몇 번 더 훑었다). 빈 배열은 아무것도 빼지 않는다.
      if (Array.isArray(f.excludeVcenterIds) && f.excludeVcenterIds.length) { w.push(`vcenterId NOT IN (${f.excludeVcenterIds.map(() => '?').join(',')})`); p.push(...f.excludeVcenterIds); }
      if (f.severity) { w.push('severity=?'); p.push(f.severity); }
      if (f.since) { w.push('ts>=?'); p.push(f.since); }
      if (f.until) { w.push('ts<=?'); p.push(f.until); }
      // v2.607 DB2607-03: 검색어는 부분 문자열이다 — '_'·'%' 를 LIKE 와일드카드로 두면 'vm_100' 이 'vm-100' 까지
      // 맞아 결과·total 이 오류 없이 부풀었다. 이스케이프 + ESCAPE 로 인메모리 폴백(includes)과 같은 뜻으로 맞춘다.
      if (f.q) { w.push("(message LIKE ? ESCAPE '\\' OR entity LIKE ? ESCAPE '\\' OR user LIKE ? ESCAPE '\\' OR type LIKE ? ESCAPE '\\')"); const like = `%${likeEscape(f.q)}%`; p.push(like, like, like, like); }
      return build(w.length ? `WHERE ${w.join(' AND ')}` : '', p);
    }
    /**
     * v2.727(감사 F-01): trackedEvents 공통 조건(type·vCenter·types·entity) — 결과가 없을 것이 확정이면 null.
     *   동기 판과 조각 판이 **같은 WHERE** 를 쓰게 하나로 뺐다(두 벌이면 조건 하나가 한쪽에만 들어가 결과가 갈린다).
     */
    function trackedBase(f) {
      const w = [`type IN ${TRACKED_SQL}`]; const p = [];
      if (Array.isArray(f.vcenterIds)) { if (!f.vcenterIds.length) return null; w.push(`vcenterId IN (${f.vcenterIds.map(() => '?').join(',')})`); p.push(...f.vcenterIds); }
      if (Array.isArray(f.types) && f.types.length) { const ts = f.types.filter((t) => TRACKED_TYPES.includes(t)); if (!ts.length) return null; w.push(`type IN (${ts.map(() => '?').join(',')})`); p.push(...ts); }
      const byEntity = typeof f.entity === 'string' && f.entity;
      if (byEntity) { w.push('entity=?'); p.push(f.entity); }
      return { w, p, byEntity: !!byEntity };
    }
    /** opsEvents 공통 조건(type·vCenter·entity) — 결과가 없을 것이 확정이면 null. */
    function opsBase(f) {
      const w = [`type IN ${OPS_SQL}`]; const p = [];
      if (Array.isArray(f.vcenterIds)) { if (!f.vcenterIds.length) return null; w.push(`vcenterId IN (${f.vcenterIds.map(() => '?').join(',')})`); p.push(...f.vcenterIds); }
      if (Array.isArray(f.types) && f.types.length) { const ts = f.types.filter((t) => OPS_TYPES.includes(t)); if (!ts.length) return null; w.push(`type IN (${ts.map(() => '?').join(',')})`); p.push(...ts); }
      if (typeof f.entity === 'string' && f.entity) { w.push('entity=?'); p.push(f.entity); }
      return { w, p };
    }
    // 행 [a, b) 를 한 트랜잭션으로(동기) — insertMany(한 번에 전부)와 insertManyAsync(조각)가 같은 본문을 쓴다.
    const insertRange = (rows, a, b) => {
      db.exec('BEGIN');
      try {
        for (let i = a; i < b; i++) { const r = rows[i]; ins.run(r.vcenterId, r.key || `${r.ts}:${(r.message || '').slice(0, 40)}`, r.ts, r.severity, r.type, r.user, r.entity, r.message, typeof r.detail === 'string' ? r.detail : null); }
        db.exec('COMMIT');
      } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; }
    };
    const api = {
      kind: 'sqlite',
      insertMany: (rows) => insertRange(rows, 0, rows.length),
      /**
       * v2.732(점검 2회차 B6-01): insertMany 와 같은 결과를 **조각 트랜잭션 + 조각 사이 시간 기준 양보**로 적재한다.
       * 예전 폴러는 vCenter 마다 한 트랜잭션(최대 5,000행 — 설정 상한 5만)을 양보 없이 이어 붙여, 첫 수집·긴 정지 뒤 따라잡기에서
       * 28곳 × 5,000행이 한 번에 약 2.4초 이벤트 루프를 멈췄다(재현). 조각은 tsSafeChunks 의 안전 지점에서만 자른다(그 함수 머리말 —
       * 조각 COMMIT 뒤 크래시해도 다음 수집이 같은 ts 묶음의 나머지를 건너뛰지 않게). 양보는 COMMIT 뒤에만 한다(v2.611 — 트랜잭션을
       * 연 채 양보하면 같은 연결의 다른 BEGIN 이 실패한다). 조각 하나가 실패하면 그 조각만 되돌리고 던진다 — 앞 조각은 이미 들어가
       * 있고, 안전 지점이라 다음 수집이 나머지를 다시 읽는다.
       * @returns {Promise<{chunks:number}>}
       */
      insertManyAsync: async (rows, { chunkRows = 1000, yieldMs = 15 } = {}) => {
        const list = Array.isArray(rows) ? rows : [];
        const parts = tsSafeChunks(list, chunkRows);
        const maybeYield = createYielder(yieldMs);
        for (let k = 0; k < parts.length; k++) {
          if (k) await maybeYield();
          insertRange(list, parts[k][0], parts[k][1]);
        }
        return { chunks: parts.length };
      },
      lastTs: (vc) => Number(lastTsStmt.get(vc)?.mx || 0),
      firstTs: (vc) => { const v = firstTsStmt.get(vc)?.mn; return Number.isFinite(Number(v)) && v != null ? Number(v) : 0; },
      lastPowerEvents: (vc) => powerStmt.all(String(vc)),   // v2.483: [{entity,type,ts}]
      /**
       * v2.702(A7·A8): 이동·구성 변경·권한 이벤트 — 부분 인덱스(idx_events_tracked)를 타도록 같은 IN 리터럴을 쓴다.
       * f: { vcenterIds:[]|null, since, entity?, types?:[] } · 반환은 최신 먼저, 상한 limit(+1 행으로 잘림 판정).
       */
      trackedEvents: (f = {}, limit = 5000) => {
        const b = trackedBase(f); if (!b) return [];
        const { w, p, byEntity } = b;
        if (Number.isFinite(f.since)) { w.push('ts>=?'); p.push(f.since); }
        // INDEXED BY: 통계가 없으면 플래너가 (vcenterId,ts) 인덱스로 그 기간의 모든 이벤트를 훑는다(실측 — 테스트가 계획을 고정).
        // v2.719(감사 S1-05): entity 를 주면 (vcenterId, entity, ts) 부분 인덱스로 그 VM 행만 읽는다.
        const sql = byEntity
          ? `SELECT vcenterId,ts,type,user,entity,message,detail FROM events INDEXED BY idx_events_tracked_entity WHERE ${w.join(' AND ')} ORDER BY ts DESC, rowid DESC LIMIT ?`
          : `SELECT vcenterId,ts,type,user,entity,message,detail FROM events INDEXED BY idx_events_tracked WHERE ${w.join(' AND ')} ORDER BY ts DESC, rowid DESC LIMIT ?`;
        return db.prepare(sql).all(...p, clampPage(limit, 0)[0]);
      },
      /**
       * v2.727(감사 F-01): trackedEvents 와 같은 결과(최신 먼저 · `ts DESC, rowid DESC` · 상한 limit)를 **시간 조각**으로 나눠 읽는다 —
       *   형제 opsEventsAsync(v2.719 S1-04)와 같은 모양. `vcenterId IN (28개) AND type IN (10종)` 다중 조건은 idx_events_tracked 로 ts 순서를
       *   얻지 못해 기간 안 일치 행 전부를 TEMP B-TREE 로 흘린 뒤 LIMIT 했다(합성 150만 행 · 90일 조회 한 문장 약 0.3초 동기 정지 —
       *   화면 조회·CSV 내보내기마다, 30초 memo 가 사용자·필터 조합마다 다시). 최신 1일 조각부터 거꾸로 읽고 조각 사이 시간 기준 양보
       *   (createYielder), 상한에 닿으면 멈춘다. 조각은 ts 로 겹치지 않으므로 순서·내용은 한 문장 판과 같다(테스트가 deepStrictEqual 로 대조).
       *   since 가 없거나 entity 조회(전용 인덱스 — 행이 적다)면 한 문장 판 그대로.
       */
      trackedEventsAsync: async (f = {}, limit = 5000, { sliceMs = 86_400_000, now = Date.now(), yieldMs = 15 } = {}) => {
        const lim = clampPage(limit, 0)[0];
        if (!Number.isFinite(f.since)) return api.trackedEvents(f, limit);
        const b = trackedBase(f); if (!b) return [];
        if (b.byEntity) return api.trackedEvents(f, limit);
        const step = Number.isFinite(sliceMs) && sliceMs >= 60_000 ? sliceMs : 86_400_000;
        const sel = 'SELECT vcenterId,ts,type,user,entity,message,detail FROM events INDEXED BY idx_events_tracked WHERE';
        // 맨 위 조각은 위가 열려 있다(vCenter 시계가 앞선 이벤트도 한 문장 판처럼 포함).
        const topSt = db.prepare(`${sel} ${[...b.w, 'ts>=?'].join(' AND ')} ORDER BY ts DESC, rowid DESC LIMIT ?`);
        const lowSt = db.prepare(`${sel} ${[...b.w, 'ts>=?', 'ts<?'].join(' AND ')} ORDER BY ts DESC, rowid DESC LIMIT ?`);
        const maybeYield = createYielder(yieldMs);
        const out = [];
        let lo = Math.max(f.since, now - step);
        for (const r of topSt.all(...b.p, lo, lim)) out.push(r);
        let hiExcl = lo;
        while (out.length < lim && hiExcl > f.since) {
          await maybeYield();
          lo = Math.max(f.since, hiExcl - step);
          for (const r of lowSt.all(...b.p, lo, hiExcl, lim - out.length)) out.push(r);
          hiExcl = lo;
        }
        return out.length > lim ? out.slice(0, lim) : out;
      },
      /**
       * v2.706(C5·C4·C6): 운영 이벤트 — 부분 인덱스(idx_events_ops)를 타도록 같은 IN 리터럴을 쓴다.
       * f: { vcenterIds:[]|null, since, until?, entity?, types?:[] } · 최신 먼저, 상한 limit.
       */
      opsEvents: (f = {}, limit = 5000) => {
        const b = opsBase(f); if (!b) return [];
        const { w, p } = b;
        if (Number.isFinite(f.since)) { w.push('ts>=?'); p.push(f.since); }
        if (Number.isFinite(f.until)) { w.push('ts<=?'); p.push(f.until); }
        return db.prepare(`SELECT vcenterId,ts,type,user,entity,message,detail FROM events INDEXED BY idx_events_ops WHERE ${w.join(' AND ')} ORDER BY ts DESC, rowid DESC LIMIT ?`).all(...p, clampPage(limit, 0)[0]);
      },
      /**
       * v2.719(감사 S1-04): opsEvents 와 같은 결과(최신 먼저 · 상한 limit)를 **시간 조각**으로 나눠 읽는다.
       * vcenterId IN · type IN 다중 조건은 idx_events_ops 로 ts 순서를 얻지 못해 기간 내 일치 행 전부를 TEMP B-TREE 로
       * 정렬한 뒤 LIMIT 했다(합성 60만 행 1.2초 동기 정지). 최신 조각부터 거꾸로 읽고 조각 사이 시간 기준 양보(v2.673·v2.693),
       * 상한에 닿으면 멈춘다. 조각은 ts 로 겹치지 않으므로 순서·내용은 한 문장 판과 같다. since 가 없으면 한 문장 판.
       */
      opsEventsAsync: async (f = {}, limit = 5000, { sliceMs = 86_400_000, now = Date.now(), yieldMs = 15 } = {}) => {
        const lim = clampPage(limit, 0)[0];
        if (!Number.isFinite(f.since)) return api.opsEvents(f, limit);
        const b = opsBase(f); if (!b) return [];
        const step = Number.isFinite(sliceMs) && sliceMs >= 60_000 ? sliceMs : 86_400_000;
        const sel = 'SELECT vcenterId,ts,type,user,entity,message,detail FROM events INDEXED BY idx_events_ops WHERE';
        const hasUntil = Number.isFinite(f.until);
        // 맨 위 조각은 위가 열려 있다(until 이 없으면 — vCenter 시계가 앞선 이벤트도 한 문장 판처럼 포함).
        const topSt = db.prepare(`${sel} ${[...b.w, 'ts>=?', ...(hasUntil ? ['ts<=?'] : [])].join(' AND ')} ORDER BY ts DESC, rowid DESC LIMIT ?`);
        const lowSt = db.prepare(`${sel} ${[...b.w, 'ts>=?', 'ts<?'].join(' AND ')} ORDER BY ts DESC, rowid DESC LIMIT ?`);
        const maybeYield = createYielder(yieldMs);
        const out = [];
        const top = hasUntil ? f.until : now;
        let lo = Math.max(f.since, top - step);
        for (const r of topSt.all(...b.p, lo, ...(hasUntil ? [f.until] : []), lim)) out.push(r);
        let hiExcl = lo;
        while (out.length < lim && hiExcl > f.since) {
          await maybeYield();
          lo = Math.max(f.since, hiExcl - step);
          for (const r of lowSt.all(...b.p, lo, hiExcl, lim - out.length)) out.push(r);
          hiExcl = lo;
        }
        return out.length > lim ? out.slice(0, lim) : out;
      },
      // rowid 타이브레이커: ts 동률 행이 많은 로그 특성상 ORDER BY ts 만으로는 OFFSET 페이징이
      // 청크 간 중복/누락될 수 있다(정렬이 비결정적) — CSV 청크 내보내기·UI 페이징 안정성용.
      query: (f = {}, limit = 200, offset = 0) => { const { where, params } = filterSql(f); return db.prepare(`SELECT vcenterId,ts,severity,type,user,entity,message FROM events ${where} ORDER BY ts DESC, rowid DESC LIMIT ? OFFSET ?`).all(...params, ...clampPage(limit, offset)); },
      /**
       * v2.732(점검 2회차 B6-03): query(f, limit, 0) 과 **같은 결과**(최신 먼저 · `ts DESC, rowid DESC` · 상한 limit)를 **시간 조각**으로
       *   나눠 읽는다 — trackedEventsAsync·opsEventsAsync(v2.719·v2.727)와 같은 골격. 미보호 VM 리포트는 검색어(4열 LIKE)로 조회 창 전체를
       *   한 문장으로 훑어(합성 7일 80만 행 · 431ms, 범위 계정 693ms 정지 — 재현) 60초 폴링·사용자마다 다시 돌았다.
       *   최신 조각부터 거꾸로 읽고 조각 사이 시간 기준 양보(createYielder), 상한에 닿으면 멈춘다. 조각은 ts 로 겹치지 않으므로 순서·내용은
       *   한 문장 판과 같다(테스트가 deepStrictEqual 로 대조). 맨 위 조각은 위가 열려 있다(until 이 없으면 — vCenter 시계가 앞선 이벤트도
       *   한 문장 판처럼 포함). since 가 없으면(창 하한 없음) 한 문장 판 그대로.
       */
      queryAsync: async (f = {}, limit = 200, { sliceMs = 3_600_000, now = Date.now(), yieldMs = 15 } = {}) => {
        const since = Number(f.since);
        if (!f.since || !Number.isFinite(since) || since <= 0) return api.query(f, limit, 0);
        const lim = clampPage(limit, 0)[0];
        const until = Number(f.until);
        const hasUntil = !!f.until && Number.isFinite(until);
        const top = hasUntil ? until : (Number.isFinite(Number(now)) ? Number(now) : Date.now());
        // 조각 수 상한(2,000) — 창이 길면 조각을 넓힌다(조각은 겹치지 않으므로 결과는 같다. 5년 창이 1시간 조각 4만 개가 되지 않게).
        const base = Number.isFinite(sliceMs) && sliceMs >= 60_000 ? sliceMs : 3_600_000;
        const step = Math.max(base, Math.ceil((top - since) / 2000));
        const { where, params } = filterSql({ ...f, since: 0, until: 0 });   // 시각 조건만 빼고 같은 WHERE(검색어·심각도·범위)
        const w = (extra) => (where ? `${where} AND ${extra}` : `WHERE ${extra}`);
        const sel = 'SELECT vcenterId,ts,severity,type,user,entity,message FROM events';
        const topSt = db.prepare(`${sel} ${w(hasUntil ? 'ts>=? AND ts<=?' : 'ts>=?')} ORDER BY ts DESC, rowid DESC LIMIT ?`);
        const lowSt = db.prepare(`${sel} ${w('ts>=? AND ts<?')} ORDER BY ts DESC, rowid DESC LIMIT ?`);
        const maybeYield = createYielder(yieldMs);
        const out = [];
        let lo = Math.max(since, top - step);
        for (const r of topSt.all(...params, lo, ...(hasUntil ? [until] : []), lim)) out.push(r);
        let hiExcl = lo;
        while (out.length < lim && hiExcl > since) {
          await maybeYield();
          lo = Math.max(since, hiExcl - step);
          for (const r of lowSt.all(...params, lo, hiExcl, lim - out.length)) out.push(r);
          hiExcl = lo;
        }
        return out.length > lim ? out.slice(0, lim) : out;
      },
      /**
       * v2.741(감사 DB-01): 로그 화면 검색(검색어·심각도) — `query(f, limit, offset)` + `countCapped(f, cap)` 와 **같은 결과**
       *   ({rows, total, capped})를 **조각 + 조각 사이 시간 기준 양보**로 만든다.
       *   예전 라우트는 상한 COUNT 와 정렬 조회 두 문장을 기간 하한 없이 차례로 동기 실행했다 — 일치하는 행이 없는 검색어 한 번이
       *   합성 180만 행에서 이벤트 루프를 7.3초 멈췄다(재현 — 무일치면 상한 COUNT 도 정렬 조회도 끝까지 훑는다).
       *   ① 개수: 기간 하한이 없으면(또는 하한이 표의 첫 시각 이하면) **rowid 구간**(NOT INDEXED — 표를 순서대로 읽는다) 조각으로 상한까지
       *      센다. 기간 하한이 있으면 그 기간만 ts 조각으로 센다(인덱스 범위 — 기간 밖은 읽지 않는다).
       *   ② 행: ts 조각을 최신부터 거꾸로 읽는다 — 조각마다 상한 COUNT 로 OFFSET 을 건너뛰고, **보여 줄 행이 있는 조각에서만** 행을 읽는다.
       *      정확한 개수를 알면(상한 미만) 그만큼 지나간 뒤 멈추고, 개수가 OFFSET 이하이면 행 조회를 하지 않는다(무일치 검색은 한 번만 훑는다).
       *   조각은 겹치지 않고 최신부터 읽으므로 순서(ts DESC, rowid DESC)·내용은 한 문장 판과 같다(테스트가 대조). 맨 위 ts 조각은 위가
       *   열려 있다(until 이 없으면 — vCenter 시계가 앞선 이벤트도 한 문장 판처럼 포함). ts 조각 수는 2,000 을 넘지 않게 넓힌다(queryAsync 규칙).
       *   ⚠ 조각 사이에 수집이 행을 더하면 한 문장 판(스냅샷 하나)과 달리 조각마다 그 순간의 행을 읽는다 — OFFSET 페이징이 원래 요청마다
       *   그런 것과 같은 수준이다.
       * @returns {Promise<{rows:object[], total:number, capped:boolean, slices:number}>}
       */
      searchAsync: async (f = {}, limit = 200, offset = 0, { cap = COUNT_CAP, sliceMs = 3_600_000, rowidChunk = 20_000, now = Date.now(), yieldMs = 15, countOnly = false } = {}) => {
        const [lim0, off] = clampPage(limit, offset);
        // v2.742(감사 DB-02): countOnly — 행은 읽지 않고 상한 있는 개수만(countCappedAsync). 같은 조각·같은 판정을 쓰려고 이 함수에 둔다.
        const lim = countOnly ? 0 : lim0;
        const c = capOf(cap);
        const since = Number(f.since); const until = Number(f.until);
        const sinceOn = !!f.since; const untilOn = !!f.until;
        // 숫자가 아닌 기간 값(Infinity 등)은 조각을 만들 수 없다 — 한 문장 판 그대로(같은 뜻).
        if ((sinceOn && !Number.isFinite(since)) || (untilOn && !Number.isFinite(until))) {
          const cnt = api.countCapped(f, c);
          return { rows: countOnly ? [] : api.query(f, lim, off), total: cnt.total, capped: cnt.capped, slices: 0 };
        }
        const empty = { rows: [], total: 0, capped: false, slices: 0 };
        if (Array.isArray(f.vcenterIds) && !f.vcenterIds.length) return empty;   // 범위 화이트리스트가 비었다 = 결과 없음(filterSql 의 1=0)
        const mn = minTsStmt.get()?.mn;
        if (mn == null) return empty;                                             // 빈 표
        const windowed = sinceOn && since > Number(mn);                           // 기간 하한이 표의 일부만 덮는다
        const lo0 = windowed ? since : Number(mn);
        const top = untilOn ? until : (Number.isFinite(Number(now)) ? Number(now) : Date.now());
        const base = Number.isFinite(sliceMs) && sliceMs >= 60_000 ? sliceMs : 3_600_000;
        const step = Math.max(base, Math.ceil((top - lo0) / 2000));
        const maybeYield = createYielder(yieldMs);
        let total = 0; let capped = false; let slices = 0;
        const addCount = (n) => { if (capped) return; total += n; if (total > c) { capped = true; total = c; } };
        // ① 개수 — 기간 하한이 없으면 rowid 구간 조각(표를 순서대로). NOT INDEXED: 단일 vCenter 조건이 (vcenterId,ts) 인덱스로
        //    조각마다 그 vCenter 행 전체를 다시 훑지 않게(rowid 조회는 NOT INDEXED 에서도 쓴다 — 테스트가 계획을 고정).
        if (!windowed) {
          const { where: fw, params: fp } = filterSql(f);
          const cw = fw ? `${fw} AND rowid > ? AND rowid <= ?` : 'WHERE rowid > ? AND rowid <= ?';
          const cntSt = db.prepare(`SELECT COUNT(*) n FROM (SELECT 1 FROM events NOT INDEXED ${cw} LIMIT ?)`);
          const r0 = Number(minRowidStmt.get()?.m); const r1 = Number(maxRowidStmt.get()?.m);
          const chunk = Number.isFinite(rowidChunk) && rowidChunk >= 1000 ? Math.trunc(rowidChunk) : 20_000;
          if (Number.isFinite(r0) && Number.isFinite(r1)) {
            for (let a = r0 - 1; a < r1 && !capped; a += chunk) {
              if (slices) await maybeYield();
              slices++;
              addCount(Number(cntSt.get(...fp, a, Math.min(r1, a + chunk), c + 1 - total)?.n || 0));
            }
          }
          if (countOnly || (!capped && total <= off)) return { rows: [], total, capped, slices };   // 보여 줄 행이 없다 — 행 조회를 하지 않는다
        }
        // ② 행(기간 하한이 있으면 개수도 같은 조각에서) — ts 조각을 최신부터.
        const { where, params } = filterSql({ ...f, since: 0, until: 0 });      // 시각 조건만 빼고 같은 WHERE(검색어·심각도·범위)
        const w = (extra) => (where ? `${where} AND ${extra}` : `WHERE ${extra}`);
        const topCond = untilOn ? 'ts>=? AND ts<=?' : 'ts>=?';
        const lowCond = 'ts>=? AND ts<?';
        const cntTop = db.prepare(`SELECT COUNT(*) n FROM (SELECT 1 FROM events ${w(topCond)} LIMIT ?)`);
        const cntLow = db.prepare(`SELECT COUNT(*) n FROM (SELECT 1 FROM events ${w(lowCond)} LIMIT ?)`);
        const sel = 'SELECT vcenterId,ts,severity,type,user,entity,message FROM events';
        const rowTop = db.prepare(`${sel} ${w(topCond)} ORDER BY ts DESC, rowid DESC LIMIT ? OFFSET ?`);
        const rowLow = db.prepare(`${sel} ${w(lowCond)} ORDER BY ts DESC, rowid DESC LIMIT ? OFFSET ?`);
        const exactKnown = () => !windowed && !capped;                           // ①에서 정확한 개수를 알았다
        const rows = [];
        let need = lim; let skip = off; let seen = 0;
        // 한 조각: [a, b) — 맨 위 조각은 b 가 없다(위가 열림 · until 이 있으면 ts<=until).
        const runSlice = (isTop, a, b) => {
          slices++;
          // 이 조각에서 세어야 할 상한 — 전체 상한 판정(c+1 까지 — 기간 하한이 있을 때만)과 OFFSET 건너뛰기(skip+need) 중 큰 쪽.
          const L = Math.max(windowed && !capped ? c + 1 - total : 0, need > 0 ? skip + need : 0);
          if (L <= 0) return;
          const bounds = isTop ? (untilOn ? [a, until] : [a]) : [a, b];
          const n = Number((isTop ? cntTop : cntLow).get(...params, ...bounds, L)?.n || 0);
          if (windowed) addCount(n);
          if (need > 0) {
            // n <= skip 이면 n < L(=skip+need 이상)이라 정확한 개수다 — 조각 통째로 건너뛴다.
            if (n <= skip) { skip -= n; seen += n; return; }
            const got = (isTop ? rowTop : rowLow).all(...params, ...bounds, need, skip);
            for (const r of got) rows.push(r);
            seen += skip + got.length; need -= got.length; skip = 0;
          }
        };
        const more = () => (windowed ? (need > 0 || !capped) : (need > 0 && !(exactKnown() && seen >= total)));
        let lo = Math.max(lo0, top - step);
        runSlice(true, lo, null);
        let hiExcl = lo;
        while (hiExcl > lo0 && more()) {
          await maybeYield();
          lo = Math.max(lo0, hiExcl - step);
          runSlice(false, lo, hiExcl);
          hiExcl = lo;
        }
        return { rows, total, capped, slices };
      },
      /**
       * v2.742(감사 DB-02): countCapped(f, cap) 와 **같은 결과**({total, capped})를 조각 + 조각 사이 시간 기준 양보로 센다 — searchAsync 의
       *   개수 단계 그대로(기간 하한이 있으면 그 기간만 ts 조각, 없으면 rowid 구간 조각). 기간 전체를 한 문장으로 세던 정확 COUNT 의 대체다.
       * @returns {Promise<{total:number, capped:boolean, slices:number}>}
       */
      countCappedAsync: async (f = {}, cap = COUNT_CAP, opts = {}) => {
        const r = await api.searchAsync(f, 1, 0, { ...opts, cap, countOnly: true });
        return { total: r.total, capped: r.capped, slices: r.slices };
      },
      /**
       * v2.742(감사 DB-02·DB-03): 표 전체의 첫·마지막 이벤트 시각 — **단독 aggregate 두 문장**(인덱스 끝점 조회 — v2.550.3. 한 문장에 둘을 두면
       *   인덱스를 통째로 훑는다). meta() 와 달리 COUNT·GROUP BY 를 하지 않는다. 빈 표면 둘 다 null.
       */
      tsRange: () => { const mn = minTsStmt.get()?.mn; const mx = maxTsStmt.get()?.mx; return { min: mn == null ? null : Number(mn), max: mx == null ? null : Number(mx) }; },
      /** v2.742(DB-02): 마지막으로 들어간 행의 rowid(단독 aggregate) — 새 이벤트가 적재됐는지 보는 표지(늦게 수집된 옛 시각 이벤트도 바뀐다). 빈 표면 0. */
      lastRowid: () => { const m = Number(maxRowidStmt.get()?.m); return Number.isFinite(m) ? m : 0; },
      /**
       * v2.673(운영 장애): 로그인 실패 **후보**만 — 검색어(q)를 쓰지 않고 logs/loginFailPattern.js 의 좁은 조건 하나로 범위를 1회 훑는다.
       * 예전 분석은 이 범위를 단어 4개로 4번 훑었다(드문 단어는 매번 전 범위). 최종 판정은 호출부가 정규식으로 다시 한다.
       */
      loginFailCandidates: (f = {}, limit = 5000) => {
        const { where, params } = filterSql({ ...f, q: '' });
        const w = where ? `${where} AND ${LOGIN_FAIL_SQL}` : `WHERE ${LOGIN_FAIL_SQL}`;
        return db.prepare(`SELECT vcenterId,ts,severity,type,user,entity,message FROM events ${w} ORDER BY ts DESC, rowid DESC LIMIT ?`).all(...params, clampPage(limit, 0)[0]);
      },
      /**
       * v2.632(A6-2632-02): 키셋 페이지 — 커서 (ts, rid) 보다 **오래된** 행만(ORDER BY ts DESC, rowid DESC). OFFSET 을 쓰지 않으므로
       * 청크 사이에 커서와 같은 ts 로 행이 들어와도 결과가 밀리지 않는다(예전 OFFSET 경로는 '중복 1 + 누락 1' 이었다).
       * 반환 행에 rid(rowid)가 실린다 — 다음 커서용이다. cursor 가 null 이면 처음부터.
       * v2.742(감사 DB-03): bounds `{lo, hiExcl}` 를 주면 ts 구간(lo 이상 · hiExcl 미만 — 둘 다 선택)으로도 묶는다. CSV 내보내기가 검색어·심각도
       *   필터를 ts 조각 안에서 키셋으로 읽을 때 쓴다(구간이 없으면 드문 검색어 한 문장이 표 전체를 훑는다). 숫자가 아닌 경계는 무시한다.
       */
      queryPage: (f = {}, limit = 200, cursor = null, bounds = null) => {
        const { where, params } = filterSql(f);
        const c = keysetCursor(cursor);
        const conds = []; const p = [...params];
        if (bounds && Number.isFinite(bounds.lo)) { conds.push('ts >= ?'); p.push(bounds.lo); }
        if (bounds && Number.isFinite(bounds.hiExcl)) { conds.push('ts < ?'); p.push(bounds.hiExcl); }
        if (c) { conds.push('(ts < ? OR (ts = ? AND rowid < ?))'); p.push(c.ts, c.ts, c.rid); }
        const w = conds.length ? (where ? `${where} AND ${conds.join(' AND ')}` : `WHERE ${conds.join(' AND ')}`) : where;
        return db.prepare(`SELECT rowid AS rid,vcenterId,ts,severity,type,user,entity,message FROM events ${w} ORDER BY ts DESC, rowid DESC LIMIT ?`).all(...p, clampPage(limit, 0)[0]);
      },
      count: (f = {}) => { const { where, params } = filterSql(f); return Number(db.prepare(`SELECT COUNT(*) n FROM events ${where}`).get(...params)?.n || 0); },
      // v2.607 DB2607-02: 상한 COUNT — 맞는 행을 cap+1 개까지만 센다. 검색어·심각도 필터는 인덱스 밖이라 정확 COUNT 가
      // 페이지마다 events 전체를 훑었다. 상한에 닿으면 capped:true 로 밝힌다(조용한 상한 금지).
      countCapped: (f = {}, cap = COUNT_CAP) => { const c = capOf(cap); const { where, params } = filterSql(f); const n = Number(db.prepare(`SELECT COUNT(*) n FROM (SELECT 1 FROM events ${where} LIMIT ?)`).get(...params, c + 1)?.n || 0); return n > c ? { total: c, capped: true } : { total: n, capped: false }; },
      // 행 수만 — `meta()` 는 GROUP BY vcenterId 까지 돌아 **풀스캔이 2회**다. 용량 정리 루프처럼
      // 개수만 필요한 곳이 meta() 를 부르면 그 절반이 순수 낭비다(v2.503).
      rowCount: () => Number(rowCountStmt.get()?.n || 0),
      /**
       * 수집 기간·vCenter별 건수. **풀스캔 2회**(COUNT/MIN/MAX + GROUP BY)라 호출 비용이 행 수에 비례한다.
       * v2.503: 로그 화면이 페이지를 넘길 때마다 이것을 다시 불러(필터와 무관하게 항상 전체 스캔)
       * 4.5M행 기준 페이지마다 수백 ms 가 들었다. 화면 헤더의 '수집 기간' 한 줄은 초 단위로 최신일
       * 이유가 없으므로 짧은 TTL 로 memo 한다. 쓰기 시 무효화하지 않는 것은 의도다 — 30초 폴러가
       * 매 주기 insert 하므로 무효화하면 캐시가 사실상 없는 것과 같다. 최대 `META_TTL_MS` 만큼
       * 낡을 수 있고 그 오차는 '방금 들어온 로그가 헤더 건수에 늦게 반영된다' 뿐이다.
       */
      meta: () => {
        const now = Date.now();
        // 기간(첫·마지막 시각)은 단독 MIN/MAX — 인덱스 끝점 조회라 매번 읽어도 0.01ms 수준이다.
        const firstTs = minTsStmt.get()?.mn ?? null;
        const lastTs = maxTsStmt.get()?.mx ?? null;
        if (!metaCache || now - metaCache.at >= META_TTL_MS) {
          const it = metaCountSteps(); let r;
          while (!(r = it.next()).done) { /* 동기 — 끝까지 */ }
          metaCache = { at: now, n: r.value.n, vcs: r.value.vcs };
        }
        return { count: metaCache.n, firstTs, lastTs, vcenters: metaCache.vcs, countsAt: metaCache.at };
      },
      /**
       * v2.744(감사 DB-03): meta() 와 **같은 결과**를 vCenter 사이 시간 기준 양보(createYielder)로 계산한다 — 설정 › vCenter 로그 상태
       *   (/admin/vclogs/status — 화면이 30초마다)·로그 뷰어 조회(/tools/vclogs)가 쓴다. 캐시가 신선하면 즉시 돌려준다. 같은 계산이
       *   진행 중이면 합류한다(겹쳐 돌리지 않는다). 계산 도중 prune 이 캐시를 지웠으면(세대가 바뀜) 결과는 돌려주되 캐시에 넣지 않는다.
       */
      metaAsync: async ({ yieldMs = 15 } = {}) => {
        const now = Date.now();
        const firstTs = minTsStmt.get()?.mn ?? null;
        const lastTs = maxTsStmt.get()?.mx ?? null;
        if (!metaCache || now - metaCache.at >= META_TTL_MS) {
          if (!metaInflight) {
            const gen = metaGen;
            metaInflight = (async () => {
              const maybeYield = createYielder(yieldMs);
              const it = metaCountSteps(); let r;
              while (!(r = it.next()).done) await maybeYield();
              const v = { at: now, n: r.value.n, vcs: r.value.vcs };
              if (gen === metaGen) metaCache = v;
              return v;
            })().finally(() => { metaInflight = null; });
          }
          const v = await metaInflight;
          return { count: v.n, firstTs, lastTs, vcenters: v.vcs, countsAt: v.at };
        }
        return { count: metaCache.n, firstTs, lastTs, vcenters: metaCache.vcs, countsAt: metaCache.at };
      },
      /**
       * 호출부(poller)는 반환값을 **숫자로** 쓴다(동기 계약). 그래서 첫 청크만 동기로 지우고(v2.742 DB-04: 작게 시작해 시간 기준으로
       * 맞춘 청크 — nextPruneChunk) 남으면 나머지를 백그라운드 청크 정리로 넘긴다(단일 비행 — 겹쳐 돌지 않는다). 나머지 건수는 끝날 때
       * 여기서 로그로 밝힌다. 반환값은 **이번 호출이 동기로 지운 행 수**다(전체가 아니다 — 나머지는 로그 줄).
       */
      prune: (beforeTs) => {
        if (pruneBg) return 0;                   // 이미 정리 중 — 같은 조건이므로 그쪽이 이어서 지운다
        const want = pruneChunk;
        const t0 = performance.now();
        const r = pruneChunkStmt.run(beforeTs, want);
        pruneChunk = nextPruneChunk(pruneChunk, want, performance.now() - t0);
        invalidateMeta();
        const first = Number(r?.changes || 0);
        if (first >= want) {
          pruneBg = pruneAsync(beforeTs)
            .then((x) => { if (x.deleted) console.log(`[vclogs] 보관기간 초과 추가 정리 ${x.deleted}건(청크 ${x.chunks}회${x.done ? '' : ' · 상한에 걸려 다음 주기에 계속'})`); })
            .catch((e) => console.warn(`[vclogs] 보관기간 정리 실패: ${e.message}`))
            .finally(() => { pruneBg = null; });
        }
        return first;
      },
      pruneAsync,
      pruneInFlight: () => pruneBg,
      // v2.590 P10: 디스크 사용은 본 파일 + -wal 이다. VACUUM 은 WAL 모드에서 새 페이지를 WAL 로 쓰고 체크포인트 뒤에도
      // -wal 파일은 줄지 않아, 본 파일만 재면 상한 1GB 현장의 실제 점유가 약 2GB 였다.
      sizeBytes: () => { let n = 0; for (const f of [DB_PATH, `${DB_PATH}-wal`]) { try { n += fs.statSync(f).size; } catch { /* 없으면 0 */ } } return n; },
      // v2.601(DB2601-03): 한 번에 지우는 양을 청크 크기로 묶는다 — 예전에는 전체 행의 10% 를 한 문장으로 지웠다(수십만 행 동기).
      // v2.742(DB-04): 그 청크도 작게 시작해 직전 청크 소요로 맞춘다(2만 행 고정은 이 표에서 청크당 0.2~0.5초). 호출부(용량 상한 루프)는
      //   요청한 수를 다 지울 때까지 양보하며 다시 부르므로 지우는 행은 같다.
      pruneOldest: (n) => {
        const want = Math.min(oldestChunk, Math.max(1, Math.trunc(Number(n)) || 1));
        const t0 = performance.now();
        const r = pruneOldestStmt.run(want);
        oldestChunk = nextPruneChunk(oldestChunk, want, performance.now() - t0);
        invalidateMeta();
        return Number(r?.changes || 0);
      },
      /**
       * v2.741(감사 DB-03): **사용 중 크기** — (page_count − freelist_count) × page_size. 용량 상한은 이것으로 판정한다.
       *   지운 행의 페이지는 freelist 로 돌아가 다음 INSERT 가 다시 쓰므로, 이 값이 상한 아래면 파일은 그 이상 커지지 않는다.
       *   예전에는 파일 크기(sizeBytes)로 판정해 삭제만으로는 줄지 않았고, 그래서 상한에 닿을 때마다 VACUUM(파일 전체 재작성 —
       *   합성 534MB 에서 수 초 동기 정지)을 돌렸다. 이 값은 헤더 두 필드라 즉시 읽힌다. WAL 은 넣지 않는다(체크포인트 전 사본이고
       *   자동 체크포인트가 재사용한다 — 넣으면 WAL 크기만큼 로그를 더 지운다). 못 읽으면 파일 크기(예전 판정).
       */
      usedBytes: () => {
        try {
          const pc = Number(pageCountStmt.get()?.page_count); const fl = Number(freelistStmt.get()?.freelist_count); const ps = Number(pageSizeStmt.get()?.page_size);
          if (Number.isFinite(pc) && Number.isFinite(fl) && Number.isFinite(ps) && ps > 0) return Math.max(0, pc - fl) * ps;
        } catch { /* 아래 */ }
        return api.sizeBytes();
      },
      /** v2.741(DB-03): 파일 안의 빈 페이지(다시 쓰일 자리) 바이트 — 화면이 '파일은 줄지 않는다' 를 말할 때 쓴다. 못 읽으면 null. */
      freeBytes: () => {
        try { const fl = Number(freelistStmt.get()?.freelist_count); const ps = Number(pageSizeStmt.get()?.page_size); return Number.isFinite(fl) && Number.isFinite(ps) ? fl * ps : null; } catch { return null; }
      },
      // 수동 정리용으로만 남긴다 — 폴러의 용량 상한 처리는 v2.741(DB-03)부터 VACUUM 을 부르지 않는다(usedBytes 판정).
      vacuum: () => { try { db.exec('VACUUM'); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* */ } },
      path: DB_PATH,
      close: () => { try { db.close(); } catch { /* */ } },
    };
    return api;
  });
}

function initJson() {
  const file = dbPath().replace(/\.db$/, '') + '.ndjson';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let rows = [];
  const seen = new Set();
  // v2.632(A6-2632-02): 키셋 페이지용 삽입 순번(sqlite rowid 대응) — 파일에는 쓰지 않는다(WeakMap).
  const seqOf = new WeakMap();
  let seq = 0;
  try { for (const l of fs.readFileSync(file, 'utf8').split('\n')) { if (l.trim()) { const r = JSON.parse(l); rows.push(r); seqOf.set(r, ++seq); seen.add(`${r.vcenterId}|${r.k}`); } } } catch { /* */ }
  const match = (r, f) => (!f.vcenterId || r.vcenterId === f.vcenterId) && (!f.severity || r.severity === f.severity)
    && (!Array.isArray(f.vcenterIds) || f.vcenterIds.includes(r.vcenterId)) // scope 화이트리스트(빈 배열=결과 없음)
    && (!Array.isArray(f.excludeVcenterIds) || !f.excludeVcenterIds.includes(r.vcenterId)) // v2.742(DB-02): 제외 목록(SQLite 판과 같은 뜻)
    && (!f.since || r.ts >= f.since) && (!f.until || r.ts <= f.until)
    && (!f.q || `${r.message} ${r.entity} ${r.user} ${r.type}`.toLowerCase().includes(String(f.q).toLowerCase()));
  const api = {
    kind: 'json',
    insertMany: (recs) => {
      const fresh = [];
      for (const r of recs) { const k = r.key || `${r.ts}:${(r.message || '').slice(0, 40)}`; const id = `${r.vcenterId}|${k}`; if (seen.has(id)) continue; seen.add(id); const row = { vcenterId: r.vcenterId, k, ts: r.ts, severity: r.severity, type: r.type, user: r.user, entity: r.entity, message: r.message, detail: typeof r.detail === 'string' ? r.detail : null }; rows.push(row); seqOf.set(row, ++seq); fresh.push(row); }
      if (fresh.length) try { fs.appendFileSync(file, fresh.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); } catch { /* */ }
    },
    lastTs: (vc) => rows.reduce((mx, r) => (r.vcenterId === vc && r.ts > mx ? r.ts : mx), 0),
    firstTs: (vc) => rows.reduce((mn, r) => (r.vcenterId === vc && (!mn || r.ts < mn) ? r.ts : mn), 0),
    trackedEvents: (f = {}, limit = 5000) => rows.filter((r) => TRACKED_TYPES.includes(r.type)
        && (!Array.isArray(f.vcenterIds) || f.vcenterIds.includes(r.vcenterId))
        && (!Array.isArray(f.types) || !f.types.length || f.types.includes(r.type))
        && (!Number.isFinite(f.since) || r.ts >= f.since) && (!f.entity || r.entity === f.entity))
      .sort((a, b) => b.ts - a.ts).slice(0, clampPage(limit, 0)[0])
      .map((r) => ({ vcenterId: r.vcenterId, ts: r.ts, type: r.type, user: r.user, entity: r.entity, message: r.message, detail: r.detail ?? null })),
    opsEvents: (f = {}, limit = 5000) => rows.filter((r) => OPS_TYPES.includes(r.type)
        && (!Array.isArray(f.vcenterIds) || f.vcenterIds.includes(r.vcenterId))
        && (!Array.isArray(f.types) || !f.types.length || f.types.includes(r.type))
        && (!Number.isFinite(f.since) || r.ts >= f.since) && (!Number.isFinite(f.until) || r.ts <= f.until) && (!f.entity || r.entity === f.entity))
      .sort((a, b) => b.ts - a.ts).slice(0, clampPage(limit, 0)[0])
      .map((r) => ({ vcenterId: r.vcenterId, ts: r.ts, type: r.type, user: r.user, entity: r.entity, message: r.message, detail: r.detail ?? null })),
    opsEventsAsync: async (f = {}, limit = 5000) => api.opsEvents(f, limit),   // v2.719(S1-04): SQLite 판과 같은 API
    trackedEventsAsync: async (f = {}, limit = 5000) => api.trackedEvents(f, limit),   // v2.727(F-01): SQLite 판과 같은 API
    lastPowerEvents: (vc) => { const m = new Map(); for (const r of rows) { if (r.vcenterId !== vc || (r.type !== 'VmPoweredOffEvent' && r.type !== 'VmPoweredOnEvent')) continue; const k = `${r.entity}|${r.type}`; if (!m.has(k) || m.get(k).ts < r.ts) m.set(k, { entity: r.entity, type: r.type, ts: r.ts }); } return [...m.values()]; },
    query: (f = {}, limit = 200, offset = 0) => rows.filter((r) => match(r, f)).sort((a, b) => b.ts - a.ts).slice(...((a) => [a[1], a[1] + a[0]])(clampPage(limit, offset))),
    queryAsync: async (f = {}, limit = 200) => api.query(f, limit, 0),   // v2.732(B6-03): SQLite 판과 같은 API
    // v2.741(DB-01): SQLite 판과 같은 API — 폴백은 메모리 배열이라 한 번에 거른다.
    searchAsync: async (f = {}, limit = 200, offset = 0, { cap = COUNT_CAP } = {}) => { const cnt = api.countCapped(f, cap); return { rows: api.query(f, limit, offset), total: cnt.total, capped: cnt.capped, slices: 0 }; },
    insertManyAsync: async (recs) => { api.insertMany(recs); return { chunks: 1 }; },   // v2.732(B6-01): SQLite 판과 같은 API
    // v2.673: SQLite 판과 같은 API — 폴백은 정규식으로 바로 거른다.
    loginFailCandidates: (f = {}, limit = 5000) => rows.filter((r) => match(r, { ...f, q: '' }) && isLoginFailRow(r)).sort((a, b) => b.ts - a.ts).slice(0, clampPage(limit, 0)[0]),
    queryPage: (f = {}, limit = 200, cursor = null, bounds = null) => {
      const c = keysetCursor(cursor);
      const [lim] = clampPage(limit, 0);
      const lo = bounds && Number.isFinite(bounds.lo) ? bounds.lo : null; const hi = bounds && Number.isFinite(bounds.hiExcl) ? bounds.hiExcl : null;   // v2.742(DB-03)
      return rows.filter((r) => match(r, f) && (lo == null || r.ts >= lo) && (hi == null || r.ts < hi) && (!c || r.ts < c.ts || (r.ts === c.ts && seqOf.get(r) < c.rid)))
        .sort((a, b) => b.ts - a.ts || seqOf.get(b) - seqOf.get(a)).slice(0, lim)
        .map((r) => ({ rid: seqOf.get(r), vcenterId: r.vcenterId, ts: r.ts, severity: r.severity, type: r.type, user: r.user, entity: r.entity, message: r.message }));
    },
    count: (f = {}) => rows.filter((r) => match(r, f)).length,
    countCapped: (f = {}, cap = COUNT_CAP) => { const c = capOf(cap); let n = 0; for (const r of rows) { if (match(r, f) && ++n > c) return { total: c, capped: true }; } return { total: n, capped: false }; },
    countCappedAsync: async (f = {}, cap = COUNT_CAP) => ({ ...api.countCapped(f, cap), slices: 0 }),   // v2.742(DB-02): SQLite 판과 같은 API
    tsRange: () => { let mn = null, mx = null; for (const r of rows) { if (mn == null || r.ts < mn) mn = r.ts; if (mx == null || r.ts > mx) mx = r.ts; } return { min: mn, max: mx }; },   // v2.742(DB-03)
    lastRowid: () => seq,   // v2.742(DB-02): 삽입 순번(SQLite 판 rowid 대응)
    metaAsync: async () => api.meta(),   // v2.744(감사 DB-03): SQLite 판과 같은 API — 폴백은 메모리 배열이라 한 번에 센다
    meta: () => { const vc = new Map(); let mn = null, mx = null; for (const r of rows) { if (mn == null || r.ts < mn) mn = r.ts; if (mx == null || r.ts > mx) mx = r.ts; const g = vc.get(r.vcenterId) || { vcenterId: r.vcenterId, count: 0, lastTs: 0 }; g.count++; g.lastTs = Math.max(g.lastTs, r.ts); vc.set(r.vcenterId, g); } return { count: rows.length, firstTs: mn, lastTs: mx, vcenters: [...vc.values()] }; },
    prune: (beforeTs) => { const before = rows.length; rows = rows.filter((r) => r.ts >= beforeTs); const removed = before - rows.length; if (removed) rewrite(); return removed; },
    sizeBytes: () => { try { return fs.statSync(file).size; } catch { return 0; } },
    usedBytes: () => api.sizeBytes(),   // v2.741(DB-03): 폴백은 재기록으로 파일이 곧 줄어든다 — 파일 크기가 곧 사용 중 크기
    freeBytes: () => 0,
    pruneOldest: (n) => { const sorted = [...rows].sort((a, b) => a.ts - b.ts); const cut = new Set(sorted.slice(0, Math.max(1, n))); const before = rows.length; rows = rows.filter((r) => !cut.has(r)); const removed = before - rows.length; if (removed) rewrite(); return removed; },
    vacuum: () => {},
    path: file,
    close: () => {},
  };
  return api;
  // v2.741(감사 LEFT-13): 재기록은 원자적으로(tmp → fsync → rename) — writeFileSync 는 먼저 0바이트로 자르므로 그 사이 종료(업그레이드 재시작)면 로그 이력을 잃는다.
  function rewrite() { try { atomicWriteFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); } catch (e) { console.warn(`[vclogs] NDJSON 폴백 재기록 실패(메모리는 정리됨 — 다음 정리 때 다시 씁니다): ${e.message}`); } }
}

export async function getLogsDb() {
  if (impl) return impl;
  if (!ready) ready = retryOnLock(initSqlite, { tag: 'vclogs' }).catch((err) => { console.warn(`[vclogs] node:sqlite 불가(${err.code || err.message}); NDJSON 폴백.`); return initJson(); });
  impl = await ready;
  return impl;
}

/** 저장 경로 변경 시 DB 핸들을 닫고 다음 getLogsDb()에서 새 경로로 재오픈. */
export function resetLogsDb() {
  try { impl?.close?.(); } catch { /* */ }
  impl = null; ready = null;
}
