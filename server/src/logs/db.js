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
import path from 'node:path';
import { config } from '../config.js';
import { loadLogSettings } from './settings.js';
import { openSqlite, retryOnLock } from '../util/sqliteOpen.js';
import { chunkedDelete, PRUNE_CHUNK_ROWS } from '../util/chunkedPrune.js';   // v2.599 DB2599-02: 첫 open 잠금 → 기다렸다 재시도(NDJSON 폴백 래치 금지)

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

let impl = null;
let ready = null;

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
    const ins = db.prepare('INSERT OR IGNORE INTO events (vcenterId,k,ts,severity,type,user,entity,message) VALUES (?,?,?,?,?,?,?,?)');
    const lastTsStmt = db.prepare('SELECT MAX(ts) mx FROM events WHERE vcenterId=?');
    // v2.601(감사 DB2601-03 — 재현): 예전 `DELETE FROM events WHERE ts < ?` 한 방은 183만 행에서 이벤트 루프를 4.8초 멈췄다
    // (metrics·idrac·pdu·dirusage 는 v2.453 chunkedPrune 를 쓰는데 logs 만 빠져 있었다). rowid 서브쿼리 + idx_events_ts_only.
    const pruneChunkStmt = db.prepare('DELETE FROM events WHERE rowid IN (SELECT rowid FROM events WHERE ts < ? LIMIT ?)');
    let pruneBg = null;                          // 진행 중인 백그라운드 청크 정리(단일 비행)
    // v2.606(DB2606-01): MIN·MAX 를 한 쿼리에 두면 aggregate 2개라 인덱스를 통째로 훑는다(v2.550.3) — 단독으로 나눈다.
    const minTsStmt = db.prepare('SELECT MIN(ts) mn FROM events');
    const maxTsStmt = db.prepare('SELECT MAX(ts) mx FROM events');
    const rowCountStmt = db.prepare('SELECT COUNT(*) n FROM events');
    let metaCache = null;                       // { at, v } — 아래 meta() 주석 참조(v2.503)
    const vcStmt = db.prepare('SELECT vcenterId, COUNT(*) n, MAX(ts) mx FROM events GROUP BY vcenterId');
    // 용량 정리 루프가 반복 호출한다 — 매 회 prepare 하면 파싱·계획 수립이 반복된다(v2.503).
    const pruneOldestStmt = db.prepare('DELETE FROM events WHERE rowid IN (SELECT rowid FROM events ORDER BY ts ASC LIMIT ?)');
    /**
     * 보관기간 초과분 청크 삭제(비동기, 청크 사이 setImmediate 양보). 상한(PRUNE_MAX_ROWS)에 걸리면 다음 주기가 잇는다.
     * @returns {Promise<{deleted:number, done:boolean, chunks:number}>}
     */
    const pruneAsync = async (beforeTs) => {
      try { return await chunkedDelete(pruneChunkStmt, [beforeTs], { label: 'vclogs' }); }
      finally { metaCache = null; }
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
      if (f.severity) { w.push('severity=?'); p.push(f.severity); }
      if (f.since) { w.push('ts>=?'); p.push(f.since); }
      if (f.until) { w.push('ts<=?'); p.push(f.until); }
      if (f.q) { w.push('(message LIKE ? OR entity LIKE ? OR user LIKE ? OR type LIKE ?)'); const like = `%${f.q}%`; p.push(like, like, like, like); }
      return build(w.length ? `WHERE ${w.join(' AND ')}` : '', p);
    }
    return {
      kind: 'sqlite',
      insertMany: (rows) => { db.exec('BEGIN'); try { for (const r of rows) ins.run(r.vcenterId, r.key || `${r.ts}:${(r.message || '').slice(0, 40)}`, r.ts, r.severity, r.type, r.user, r.entity, r.message); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; } },
      lastTs: (vc) => Number(lastTsStmt.get(vc)?.mx || 0),
      lastPowerEvents: (vc) => powerStmt.all(String(vc)),   // v2.483: [{entity,type,ts}]
      // rowid 타이브레이커: ts 동률 행이 많은 로그 특성상 ORDER BY ts 만으로는 OFFSET 페이징이
      // 청크 간 중복/누락될 수 있다(정렬이 비결정적) — CSV 청크 내보내기·UI 페이징 안정성용.
      query: (f = {}, limit = 200, offset = 0) => { const { where, params } = filterSql(f); return db.prepare(`SELECT vcenterId,ts,severity,type,user,entity,message FROM events ${where} ORDER BY ts DESC, rowid DESC LIMIT ? OFFSET ?`).all(...params, ...clampPage(limit, offset)); },
      count: (f = {}) => { const { where, params } = filterSql(f); return Number(db.prepare(`SELECT COUNT(*) n FROM events ${where}`).get(...params)?.n || 0); },
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
          const n = Number(rowCountStmt.get()?.n || 0);
          const vcs = vcStmt.all().map((x) => ({ vcenterId: x.vcenterId, count: Number(x.n), lastTs: Number(x.mx) }));
          metaCache = { at: now, n, vcs };
        }
        return { count: metaCache.n, firstTs, lastTs, vcenters: metaCache.vcs, countsAt: metaCache.at };
      },
      /**
       * 호출부(poller)는 반환값을 **숫자로** 쓴다(동기 계약). 그래서 첫 청크만 동기로 지우고(≤ PRUNE_CHUNK_ROWS — 한 청크 수십 ms)
       * 남으면 나머지를 백그라운드 청크 정리로 넘긴다(단일 비행 — 겹쳐 돌지 않는다). 나머지 건수는 끝날 때 여기서 로그로 밝힌다.
       * 반환값은 **이번 호출이 동기로 지운 행 수**다(전체가 아니다 — 나머지는 로그 줄).
       */
      prune: (beforeTs) => {
        if (pruneBg) return 0;                   // 이미 정리 중 — 같은 조건이므로 그쪽이 이어서 지운다
        const r = pruneChunkStmt.run(beforeTs, PRUNE_CHUNK_ROWS);
        metaCache = null;
        const first = Number(r?.changes || 0);
        if (first >= PRUNE_CHUNK_ROWS) {
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
      pruneOldest: (n) => { const r = pruneOldestStmt.run(Math.min(PRUNE_CHUNK_ROWS, Math.max(1, n))); metaCache = null; return Number(r?.changes || 0); },
      vacuum: () => { try { db.exec('VACUUM'); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* */ } },
      path: DB_PATH,
      close: () => { try { db.close(); } catch { /* */ } },
    };
  });
}

function initJson() {
  const file = dbPath().replace(/\.db$/, '') + '.ndjson';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let rows = [];
  const seen = new Set();
  try { for (const l of fs.readFileSync(file, 'utf8').split('\n')) { if (l.trim()) { const r = JSON.parse(l); rows.push(r); seen.add(`${r.vcenterId}|${r.k}`); } } } catch { /* */ }
  const match = (r, f) => (!f.vcenterId || r.vcenterId === f.vcenterId) && (!f.severity || r.severity === f.severity)
    && (!Array.isArray(f.vcenterIds) || f.vcenterIds.includes(r.vcenterId)) // scope 화이트리스트(빈 배열=결과 없음)
    && (!f.since || r.ts >= f.since) && (!f.until || r.ts <= f.until)
    && (!f.q || `${r.message} ${r.entity} ${r.user} ${r.type}`.toLowerCase().includes(String(f.q).toLowerCase()));
  return {
    kind: 'json',
    insertMany: (recs) => {
      const fresh = [];
      for (const r of recs) { const k = r.key || `${r.ts}:${(r.message || '').slice(0, 40)}`; const id = `${r.vcenterId}|${k}`; if (seen.has(id)) continue; seen.add(id); const row = { vcenterId: r.vcenterId, k, ts: r.ts, severity: r.severity, type: r.type, user: r.user, entity: r.entity, message: r.message }; rows.push(row); fresh.push(row); }
      if (fresh.length) try { fs.appendFileSync(file, fresh.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); } catch { /* */ }
    },
    lastTs: (vc) => rows.reduce((mx, r) => (r.vcenterId === vc && r.ts > mx ? r.ts : mx), 0),
    lastPowerEvents: (vc) => { const m = new Map(); for (const r of rows) { if (r.vcenterId !== vc || (r.type !== 'VmPoweredOffEvent' && r.type !== 'VmPoweredOnEvent')) continue; const k = `${r.entity}|${r.type}`; if (!m.has(k) || m.get(k).ts < r.ts) m.set(k, { entity: r.entity, type: r.type, ts: r.ts }); } return [...m.values()]; },
    query: (f = {}, limit = 200, offset = 0) => rows.filter((r) => match(r, f)).sort((a, b) => b.ts - a.ts).slice(...((a) => [a[1], a[1] + a[0]])(clampPage(limit, offset))),
    count: (f = {}) => rows.filter((r) => match(r, f)).length,
    meta: () => { const vc = new Map(); let mn = null, mx = null; for (const r of rows) { if (mn == null || r.ts < mn) mn = r.ts; if (mx == null || r.ts > mx) mx = r.ts; const g = vc.get(r.vcenterId) || { vcenterId: r.vcenterId, count: 0, lastTs: 0 }; g.count++; g.lastTs = Math.max(g.lastTs, r.ts); vc.set(r.vcenterId, g); } return { count: rows.length, firstTs: mn, lastTs: mx, vcenters: [...vc.values()] }; },
    prune: (beforeTs) => { const before = rows.length; rows = rows.filter((r) => r.ts >= beforeTs); const removed = before - rows.length; if (removed) rewrite(); return removed; },
    sizeBytes: () => { try { return fs.statSync(file).size; } catch { return 0; } },
    pruneOldest: (n) => { const sorted = [...rows].sort((a, b) => a.ts - b.ts); const cut = new Set(sorted.slice(0, Math.max(1, n))); const before = rows.length; rows = rows.filter((r) => !cut.has(r)); const removed = before - rows.length; if (removed) rewrite(); return removed; },
    vacuum: () => {},
    path: file,
    close: () => {},
  };
  function rewrite() { try { fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); } catch { /* */ } }
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
