/**
 * horizon/sessionDb.js — Horizon 실시간 사용자 전용 DB(v2.525).
 *
 * 파일: `config.dbDir || config.configDir` 아래 `horizon-sessions.db`(0600).
 * node:sqlite 가 없으면 **비활성 사유를 그대로 보고**한다(NDJSON 폴백을 두지 않는다 —
 * 조회가 전부 집계라 파일 스캔 폴백은 실익 없이 복잡도만 키운다. `curuser/db.js` 와 같은 판단).
 *
 * ── 계열 수를 먼저 계산했다(CLAUDE.md v2.504 규칙) ─────────────────────────────
 *  · `hz_series` : (Connection Server 수 + 전체 1) × 12회/시간(5분 주기).
 *    서버 1대면 24행/시간 = **연 21만행**, 10대면 연 116만행. 보존 기본 180일.
 *  · `latest`    : 서버당 1행. 계정 목록·풀 목록은 **여기에만** JSON 으로 둔다 —
 *    시계열에 계정명을 쌓으면 (사용자 수 × 주기) 행이 되고 개인정보가 장기 보존된다.
 *    목록은 `maxUsers` 상한으로 자르고 **잘린 개수를 함께 저장**한다(조용한 상한 금지).
 *  · 원시 세션 객체는 **저장하지 않는다** — 1만 세션 × 수백 바이트가 매 주기 직렬화된다.
 *    화면이 필요한 것은 '누가 몇 세션' 이라는 집계이고 그것만 보관한다.
 *
 * PRAGMA 는 저장소 규칙대로 WAL + synchronous=NORMAL + busy_timeout=3000. 적재는 주기당
 * 트랜잭션 1회.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { isSqliteLockError } from '../util/sqliteOpen.js';
import { chunkedDelete } from '../util/chunkedPrune.js';

const DB_PATH = () => process.env.HZSESS_DB_PATH
  || path.join(config.dbDir || config.configDir, 'horizon-sessions.db');

let x = null;
let ready = null;
let initError = null;
let tick = 0;

function prepare(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS latest (
      server_id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      host TEXT NOT NULL DEFAULT '',
      ts INTEGER NOT NULL,                 -- 포탈이 조회한 시각(ms)
      ok INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'error',  -- sessionCollect.KIND_LABEL 의 키
      error TEXT NOT NULL DEFAULT '',
      users INTEGER, users_connected INTEGER,
      sessions INTEGER, connected INTEGER, disconnected INTEGER, pending INTEGER,
      state_unknown INTEGER,
      pages INTEGER, truncated INTEGER NOT NULL DEFAULT 0,
      used_user_key TEXT NOT NULL DEFAULT '',
      used_state_key TEXT NOT NULL DEFAULT '',
      user_id_only INTEGER NOT NULL DEFAULT 0,
      users_omitted INTEGER NOT NULL DEFAULT 0,
      pools_omitted INTEGER NOT NULL DEFAULT 0,
      names TEXT NOT NULL DEFAULT '[]',    -- JSON [{name,connected,sessions,pools,…}] — 최신 1건만
      pools TEXT NOT NULL DEFAULT '[]',
      duration_ms INTEGER
    );
    CREATE TABLE IF NOT EXISTS hz_series (
      server_id TEXT NOT NULL,             -- '' = 전체(고유 계정 합집합)
      ts INTEGER NOT NULL,
      users INTEGER, users_connected INTEGER,
      sessions INTEGER, connected INTEGER, disconnected INTEGER, pending INTEGER,
      servers_ok INTEGER, servers_failed INTEGER,
      PRIMARY KEY (server_id, ts)
    );
    -- prune 은 \`DELETE WHERE ts<?\` 다 — **ts 단독 인덱스**가 있어야 풀스캔을 피한다
    -- (복합 PK (server_id, ts) 로는 탈 수 없다. CLAUDE.md 성능 불변조건).
    CREATE INDEX IF NOT EXISTS idx_hz_series_ts ON hz_series (ts);
  `);
  return {
    upLatest: db.prepare(`INSERT INTO latest
      (server_id, name, host, ts, ok, kind, error, users, users_connected, sessions, connected,
       disconnected, pending, state_unknown, pages, truncated, used_user_key, used_state_key,
       user_id_only, users_omitted, pools_omitted, names, pools, duration_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(server_id) DO UPDATE SET name=excluded.name, host=excluded.host, ts=excluded.ts,
        ok=excluded.ok, kind=excluded.kind, error=excluded.error, users=excluded.users,
        users_connected=excluded.users_connected, sessions=excluded.sessions, connected=excluded.connected,
        disconnected=excluded.disconnected, pending=excluded.pending, state_unknown=excluded.state_unknown,
        pages=excluded.pages, truncated=excluded.truncated, used_user_key=excluded.used_user_key,
        used_state_key=excluded.used_state_key, user_id_only=excluded.user_id_only,
        users_omitted=excluded.users_omitted, pools_omitted=excluded.pools_omitted,
        names=excluded.names, pools=excluded.pools, duration_ms=excluded.duration_ms`),
    delLatest: db.prepare('DELETE FROM latest WHERE server_id=?'),
    allLatest: db.prepare('SELECT * FROM latest ORDER BY name, server_id'),
    upSeries: db.prepare(`INSERT INTO hz_series
      (server_id, ts, users, users_connected, sessions, connected, disconnected, pending, servers_ok, servers_failed)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(server_id, ts) DO UPDATE SET users=excluded.users, users_connected=excluded.users_connected,
        sessions=excluded.sessions, connected=excluded.connected, disconnected=excluded.disconnected,
        pending=excluded.pending, servers_ok=excluded.servers_ok, servers_failed=excluded.servers_failed`),
    seriesOf: db.prepare('SELECT * FROM hz_series WHERE server_id=? AND ts>=? AND ts<=? ORDER BY ts'),
    seriesSpan: db.prepare('SELECT MIN(ts) AS mn, MAX(ts) AS mx, COUNT(*) AS n FROM hz_series WHERE server_id=?'),
    // v2.603(감사 DB2603-02): 청크 DELETE 형태(LIMIT 은 chunkedDelete 가 붙인다) — ts 단독 인덱스가 서브쿼리를 받친다.
    pruneSeries: db.prepare('DELETE FROM hz_series WHERE rowid IN (SELECT rowid FROM hz_series WHERE ts < ? LIMIT ?)'),
    stats: db.prepare('SELECT (SELECT COUNT(*) FROM latest) AS latestRows, (SELECT COUNT(*) FROM hz_series) AS seriesRows'),
  };
}

// v2.599 DB2599-02: 첫 open 에서 다른 연결이 잠금을 쥐고 있으면('database is locked') 예전에는 initError 로 **래치**해
// 프로세스 수명 동안 Horizon 세션 이력이 꺼졌다. busy_timeout 이 journal_mode 와 같은 exec 안에 있어 기다리지도
// 않았다. storage/db.js(v2.597 L2597-02)와 같게 — busy_timeout 을 **먼저 따로** 걸고, 잠금 오류면 핸들을 닫고
// 래치하지 않은 채 30초 뒤 다시 연다. 그 밖의 오류(node:sqlite 없음·손상)만 래치한다.
let lockError = null;
let retryAt = 0;
const LOCK_RETRY_MS = 30_000;
const isLockError = isSqliteLockError;   // 판정은 util/sqliteOpen.js 하나

async function open() {
  if (x) return x;
  if (initError) return null;
  if (!ready && retryAt && Date.now() < retryAt) return null;
  if (!ready) {
    ready = (async () => {
      // eslint-disable-next-line import/no-unresolved
      const { DatabaseSync } = await import('node:sqlite');
      const p = DB_PATH();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const db = new DatabaseSync(p);
      try {
        db.exec('PRAGMA busy_timeout=3000;');   // 먼저 — journal_mode 전환·스키마 생성도 잠금을 기다리게
        try { db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;'); } catch (e) { if (isLockError(e)) throw e; /* 구버전 폴백 */ }
        const st = prepare(db);
        try { fs.chmodSync(p, 0o600); } catch { /* best effort */ }
        x = { db, st, path: p };
        lockError = null; retryAt = 0;
        return x;
      } catch (e) { try { db.close(); } catch { /* */ } throw e; }
    })().catch((e) => {
      if (isLockError(e)) { lockError = e; retryAt = Date.now() + LOCK_RETRY_MS; ready = null; return null; }
      initError = e; return null;
    });
  }
  return ready;
}

/** 기능 가용성 — 화면이 '비활성' 사유를 그대로 말한다(조용히 빈 화면을 만들지 않는다). */
export async function hzSessionDbStatus() {
  const h = await open();
  return {
    available: !!h,
    path: h ? h.path : DB_PATH(),
    error: initError ? String(initError.message || initError).slice(0, 200)
      : (!h && lockError ? `DB 파일이 잠겨 있어 열지 못했습니다(잠시 뒤 다시 시도합니다): ${String(lockError.message || lockError).slice(0, 160)}` : ''),
    ...(h ? h.st.stats.get() : { latestRows: null, seriesRows: null }),
  };
}

// ⚠ `Number(null) === 0` 이다 — `Number.isFinite(Number(v))` 만 보면 **null 이 0 으로 바뀐다**.
//   그러면 조회 실패한 서버가 화면에서 '사용자 0명' 으로 보인다(이 기능이 만들 수 있는 가장
//   위험한 거짓). v2.525 의 자체 테스트가 실제로 이 결함을 잡았다 — null/''/undefined 를 먼저 걸러낼 것.
const nOrNull = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 한 주기 결과 적재(트랜잭션 1회).
 *
 * @param {number} ts        이 주기의 기준 시각(ms) — 모든 행이 같은 ts 를 쓴다
 * @param {object[]} records `collectServerSessions()` 결과 + `{serverId, name, host}`
 * @param {object[]} series  `[{ serverId, ...seriesRow() , serversOk, serversFailed}]` (''=전체)
 */
export async function commitHzSessions({ ts, records = [], series = [], maxUsers = 2000 }) {
  const h = await open();
  if (!h) return { ok: false, reason: initError ? String(initError.message) : lockError ? `DB 잠금(다시 시도 예정): ${String(lockError.message)}` : 'node:sqlite 없음' };
  const t = Date.now();
  h.db.exec('BEGIN');
  try {
    for (const r of records) {
      h.st.upLatest.run(
        String(r.serverId), String(r.name || ''), String(r.host || ''), Number(ts), r.ok ? 1 : 0,
        String(r.kind || 'error'), String(r.error || '').slice(0, 300),
        nOrNull(r.users), nOrNull(r.usersConnected), nOrNull(r.sessions), nOrNull(r.connected),
        nOrNull(r.disconnected), nOrNull(r.pending), nOrNull(r.stateUnknown),
        nOrNull(r.pages), r.truncated ? 1 : 0, String(r.usedUserKey || ''), String(r.usedStateKey || ''),
        r.userIdOnly ? 1 : 0, Number(r.usersOmitted) || 0, Number(r.poolsOmitted) || 0,
        JSON.stringify((r.names || []).slice(0, maxUsers)), JSON.stringify((r.pools || []).slice(0, 500)),
        nOrNull(r.ms),
      );
    }
    for (const s of series) {
      h.st.upSeries.run(String(s.serverId || ''), Number(ts), nOrNull(s.users), nOrNull(s.usersConnected),
        nOrNull(s.sessions), nOrNull(s.connected), nOrNull(s.disconnected), nOrNull(s.pending),
        nOrNull(s.serversOk), nOrNull(s.serversFailed));
    }
    h.db.exec('COMMIT');
  } catch (e) {
    try { h.db.exec('ROLLBACK'); } catch { /* */ }
    return { ok: false, reason: String(e.message || e).slice(0, 200) };
  }
  return { ok: true, records: records.length, series: series.length, ms: Date.now() - t };
}

/** 등록이 사라진 서버의 낡은 최신값을 지운다(화면에 유령 행이 남지 않게). */
export async function dropHzLatest(serverId) {
  const h = await open();
  if (!h) return false;
  try { h.st.delLatest.run(String(serverId)); return true; } catch { return false; }
}

/** 최신 스냅샷 전량. JSON 컬럼을 푼다. */
export async function hzLatestRecords() {
  const h = await open();
  if (!h) return [];
  const j = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
  return h.st.allLatest.all().map((r) => ({
    serverId: r.server_id, name: r.name, host: r.host, ts: Number(r.ts), ok: !!r.ok,
    kind: r.kind, error: r.error || '',
    users: nOrNull(r.users), usersConnected: nOrNull(r.users_connected),
    sessions: nOrNull(r.sessions), connected: nOrNull(r.connected),
    disconnected: nOrNull(r.disconnected), pending: nOrNull(r.pending),
    stateUnknown: nOrNull(r.state_unknown), pages: nOrNull(r.pages), truncated: !!r.truncated,
    usedUserKey: r.used_user_key || '', usedStateKey: r.used_state_key || '', userIdOnly: !!r.user_id_only,
    usersOmitted: Number(r.users_omitted) || 0, poolsOmitted: Number(r.pools_omitted) || 0,
    names: j(r.names, []), pools: j(r.pools, []), ms: nOrNull(r.duration_ms),
  }));
}

/** 추이 조회. `serverId: ''` 는 전체(합집합) 계열. */
export async function hzSeriesRange(serverId, fromTs, toTs) {
  const h = await open();
  if (!h) return { available: false, rows: [], span: null };
  const rows = h.st.seriesOf.all(String(serverId ?? ''), Number(fromTs), Number(toTs)).map((r) => ({
    ts: Number(r.ts), users: nOrNull(r.users), usersConnected: nOrNull(r.users_connected),
    sessions: nOrNull(r.sessions), connected: nOrNull(r.connected),
    disconnected: nOrNull(r.disconnected), pending: nOrNull(r.pending),
    serversOk: nOrNull(r.servers_ok), serversFailed: nOrNull(r.servers_failed),
  }));
  const sp = h.st.seriesSpan.get(String(serverId ?? ''));
  return {
    available: true,
    rows,
    // ⚠ `first` 는 '수집 시작' 이 아니라 **max(수집 시작, 보존 경계)** 다 — prune 된 테이블의
    //   MIN(ts) 이므로 화면이 '기다리면 채워진다' 고 단정하면 거짓이 될 수 있다.
    span: sp && sp.n ? { first: Number(sp.mn), last: Number(sp.mx), rows: Number(sp.n) } : null,
  };
}

/**
 * 보존기간 prune — **N주기에 1회만**.
 * ⚠ `(++tick % N) === 0` 으로 쓸 것(`tick++ % N === 0` 은 첫 폴에서 즉시 참 — v2.453).
 */
let _pruneFlight = null;   // { days, p } — 진행 중인 정리
export async function pruneHzSessions(retentionDays, { every = 12 } = {}) {
  if ((++tick % Math.max(1, every)) !== 0) return { skipped: true };
  const days = Number(retentionDays) || 0;
  if (days <= 0) return { skipped: true, reason: '무제한' };
  const h = await open();
  if (!h) return { skipped: true, reason: 'DB 없음' };
  // v2.603(감사 DB2603-02·RECENT2603-06): 청크 삭제 + 청크 사이 양보. 같은 보존일이면 진행 중인 것을 공유하고,
  //   바뀌었으면 끝난 뒤 새 경계로 한 번 더 돈다.
  if (_pruneFlight && _pruneFlight.days === days) return _pruneFlight.p;
  const prev = _pruneFlight ? _pruneFlight.p : Promise.resolve();
  const flight = { days, p: null };
  flight.p = prev.then(async () => {
    const before = Date.now() - days * 86_400_000;
    let s = 0; let done = true;
    try { const r = await chunkedDelete(h.st.pruneSeries, [before], { label: 'horizon.hz_series' }); s = r.deleted; done = r.done; } catch (e) { done = false; console.warn(`[horizon-sessions] prune 실패: ${e?.message || e}`); }
    return { skipped: false, series: s, before, done };
  }).finally(() => { if (_pruneFlight === flight) _pruneFlight = null; });
  _pruneFlight = flight;
  return flight.p;
}

/** 테스트 전용 — 잠금 재시도 대기(30초)를 건너뛴다. */
export function _expireLockRetryForTest() { retryAt = 0; }

export function _resetForTest() {
  try { x?.db?.close?.(); } catch { /* */ }
  x = null; ready = null; initError = null; lockError = null; retryAt = 0; tick = 0; _pruneFlight = null;
}
