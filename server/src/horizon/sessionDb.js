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
import { openSqlite, createLockRetry } from '../util/sqliteOpen.js'; // v2.613 PERSIST2613-03: open 코어는 하나
import { chunkedDelete, createPruneFlight } from '../util/chunkedPrune.js';
import { dayKey, DAY_MS } from '../util/dayKey.js';
import { createYielder } from '../util/timeSlice.js';

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
    -- v2.684 앱별 사용 누적: (날짜, 서버, 사용자, 서비스) 하루 1행. 날짜는 포탈 시각(KST) 'YYYY-MM-DD'.
    -- 행 수 = 하루 (사용자 × 사용 서비스) 쌍 — 2,000명 × 3 서비스면 하루 6천·연 약 220만 행(머리말 참고).
    -- PK 의 선행 열이 day 라 기간 조회·day < ? prune 이 인덱스를 탄다.
    CREATE TABLE IF NOT EXISTS hz_usage_daily (
      day TEXT NOT NULL, server_id TEXT NOT NULL, user_key TEXT NOT NULL, service_key TEXT NOT NULL,
      user_name TEXT NOT NULL DEFAULT '', service_name TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT '', basis TEXT NOT NULL DEFAULT '',
      first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL,
      samples INTEGER NOT NULL DEFAULT 0, connected_samples INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, server_id, user_key, service_key)
    );
    -- 그 날 몇 번 수집했는가(성공·실패) — '사용자 0명' 과 '그 날 수집 없음' 을 구분하는 근거.
    CREATE TABLE IF NOT EXISTS hz_usage_cover (
      day TEXT NOT NULL, server_id TEXT NOT NULL,
      cycles INTEGER NOT NULL DEFAULT 0, ok_cycles INTEGER NOT NULL DEFAULT 0,
      first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL,
      PRIMARY KEY (day, server_id)
    );
  `);
  // v2.684: latest 에 서비스 목록·해석 메타 열 추가 — 없는 열만 더한다(DB2603-01: 다른 오류를 '열 있음' 으로 삼키지 않는다).
  const cols = new Set(db.prepare('PRAGMA table_info(latest)').all().map((c) => c.name));
  for (const [c, ddl] of [['services', "services TEXT NOT NULL DEFAULT '[]'"], ['usage_meta', "usage_meta TEXT NOT NULL DEFAULT '{}'"]]) {
    if (cols.has(c)) continue;
    try { db.exec(`ALTER TABLE latest ADD COLUMN ${ddl}`); } catch (e) { if (!/duplicate column name/i.test(String(e?.message))) throw e; }
  }
  return {
    upLatest: db.prepare(`INSERT INTO latest
      (server_id, name, host, ts, ok, kind, error, users, users_connected, sessions, connected,
       disconnected, pending, state_unknown, pages, truncated, used_user_key, used_state_key,
       user_id_only, users_omitted, pools_omitted, names, pools, duration_ms, services, usage_meta)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(server_id) DO UPDATE SET name=excluded.name, host=excluded.host, ts=excluded.ts,
        ok=excluded.ok, kind=excluded.kind, error=excluded.error, users=excluded.users,
        users_connected=excluded.users_connected, sessions=excluded.sessions, connected=excluded.connected,
        disconnected=excluded.disconnected, pending=excluded.pending, state_unknown=excluded.state_unknown,
        pages=excluded.pages, truncated=excluded.truncated, used_user_key=excluded.used_user_key,
        used_state_key=excluded.used_state_key, user_id_only=excluded.user_id_only,
        users_omitted=excluded.users_omitted, pools_omitted=excluded.pools_omitted,
        names=excluded.names, pools=excluded.pools, duration_ms=excluded.duration_ms,
        services=excluded.services, usage_meta=excluded.usage_meta`),
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
    // 관측·수집 횟수는 **더 늦은 ts 일 때만** 1 늘린다 — 같은 주기 재적재가 횟수를 부풀리지 않게.
    //   폴러의 주기 ts 는 단조 증가라 정상 경로에서는 빠짐이 없다. 시계가 뒤로 간 주기는 세지 않는다
    //   (부풀리는 것보다 덜 세는 쪽 — 누적은 원래 하한이다).
    upUsage: db.prepare(`INSERT INTO hz_usage_daily
      (day, server_id, user_key, service_key, user_name, service_name, kind, basis, first_ts, last_ts, samples, connected_samples)
      VALUES (?,?,?,?,?,?,?,?,?,?,1,?)
      ON CONFLICT(day, server_id, user_key, service_key) DO UPDATE SET
        user_name=excluded.user_name, service_name=excluded.service_name, kind=excluded.kind, basis=excluded.basis,
        samples = hz_usage_daily.samples + CASE WHEN excluded.last_ts > hz_usage_daily.last_ts THEN 1 ELSE 0 END,
        connected_samples = hz_usage_daily.connected_samples + CASE WHEN excluded.last_ts > hz_usage_daily.last_ts THEN excluded.connected_samples ELSE 0 END,
        first_ts = MIN(hz_usage_daily.first_ts, excluded.first_ts),
        last_ts = MAX(hz_usage_daily.last_ts, excluded.last_ts)`),
    upCover: db.prepare(`INSERT INTO hz_usage_cover (day, server_id, cycles, ok_cycles, first_ts, last_ts) VALUES (?,?,1,?,?,?)
      ON CONFLICT(day, server_id) DO UPDATE SET
        cycles = hz_usage_cover.cycles + CASE WHEN excluded.last_ts > hz_usage_cover.last_ts THEN 1 ELSE 0 END,
        ok_cycles = hz_usage_cover.ok_cycles + CASE WHEN excluded.last_ts > hz_usage_cover.last_ts THEN excluded.ok_cycles ELSE 0 END,
        first_ts = MIN(hz_usage_cover.first_ts, excluded.first_ts), last_ts = MAX(hz_usage_cover.last_ts, excluded.last_ts)`),
    usagePairsAll: db.prepare(`SELECT user_key, service_key, MAX(user_name) AS user_name, MAX(service_name) AS service_name,
        MAX(kind) AS kind, MAX(basis) AS basis, COUNT(DISTINCT day) AS days, MIN(first_ts) AS first_ts, MAX(last_ts) AS last_ts,
        SUM(samples) AS samples, SUM(connected_samples) AS connected_samples
      FROM hz_usage_daily WHERE day >= ? AND day <= ? GROUP BY user_key, service_key`),
    usagePairsOne: db.prepare(`SELECT user_key, service_key, MAX(user_name) AS user_name, MAX(service_name) AS service_name,
        MAX(kind) AS kind, MAX(basis) AS basis, COUNT(DISTINCT day) AS days, MIN(first_ts) AS first_ts, MAX(last_ts) AS last_ts,
        SUM(samples) AS samples, SUM(connected_samples) AS connected_samples
      FROM hz_usage_daily WHERE day >= ? AND day <= ? AND server_id = ? GROUP BY user_key, service_key`),
    usageDailyAll: db.prepare(`SELECT day, COUNT(DISTINCT user_key) AS users, COUNT(DISTINCT service_key) AS services
      FROM hz_usage_daily WHERE day >= ? AND day <= ? GROUP BY day ORDER BY day`),
    usageDailyOne: db.prepare(`SELECT day, COUNT(DISTINCT user_key) AS users, COUNT(DISTINCT service_key) AS services
      FROM hz_usage_daily WHERE day >= ? AND day <= ? AND server_id = ? GROUP BY day ORDER BY day`),
    userDaysAll: db.prepare(`SELECT user_key, COUNT(DISTINCT day) AS days FROM hz_usage_daily WHERE day >= ? AND day <= ? GROUP BY user_key`),
    userDaysOne: db.prepare(`SELECT user_key, COUNT(DISTINCT day) AS days FROM hz_usage_daily WHERE day >= ? AND day <= ? AND server_id = ? GROUP BY user_key`),
    coverAll: db.prepare(`SELECT day, server_id, cycles, ok_cycles FROM hz_usage_cover WHERE day >= ? AND day <= ? ORDER BY day`),
    usageMinDay: db.prepare('SELECT MIN(day) AS d FROM hz_usage_cover'),
    pruneUsage: db.prepare('DELETE FROM hz_usage_daily WHERE rowid IN (SELECT rowid FROM hz_usage_daily WHERE day < ? LIMIT ?)'),
    pruneCover: db.prepare('DELETE FROM hz_usage_cover WHERE rowid IN (SELECT rowid FROM hz_usage_cover WHERE day < ? LIMIT ?)'),
    stats: db.prepare('SELECT (SELECT COUNT(*) FROM latest) AS latestRows, (SELECT COUNT(*) FROM hz_series) AS seriesRows'),
  };
}

// v2.599 DB2599-02: 첫 open 에서 다른 연결이 잠금을 쥐고 있으면('database is locked') 예전에는 initError 로 **래치**해
// 프로세스 수명 동안 Horizon 세션 이력이 꺼졌다. busy_timeout 이 journal_mode 와 같은 exec 안에 있어 기다리지도
// 않았다. 잠금 오류면 핸들을 닫고 래치하지 않은 채 30초 뒤 다시 연다. 그 밖의 오류(node:sqlite 없음·손상)만 래치한다.
// v2.613 PERSIST2613-03: 그 재시도 시각·잠금 판정·PRAGMA 순서가 여기 손 사본(lockError/retryAt/LOCK_RETRY_MS)이었다 —
//   util/sqliteOpen.js 의 createLockRetry + openSqlite 로 옮긴다(동작 동일 · 상태 문구는 lockRetry.note()).
const lockRetry = createLockRetry(30_000);

async function open() {
  if (x) return x;
  if (initError) return null;
  if (!ready && lockRetry.blocked()) return null;
  if (!ready) {
    ready = (async () => {
      // eslint-disable-next-line import/no-unresolved
      const { DatabaseSync } = await import('node:sqlite');
      const p = DB_PATH();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      // chmod(본체·기존 -wal/-shm 0600, DB2611-01) → busy_timeout → WAL/NORMAL 순서는 openSqlite 가 지킨다. 잠금이면 닫고 던진다.
      const db = openSqlite(new DatabaseSync(p));
      try { fs.chmodSync(p, 0o600); } catch { /* best effort — openSqlite 가 이미 했다(secAudit2535 스윕 규약 유지) */ }
      try {
        const st = prepare(db);
        x = { db, st, path: p };
        lockRetry.ok();
        return x;
      } catch (e) { try { db.close(); } catch { /* */ } throw e; }
    })().catch((e) => {
      if (lockRetry.onFail(e)) { ready = null; return null; }
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
    error: initError ? String(initError.message || initError).slice(0, 200) : (h ? '' : lockRetry.note()),
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
  if (!h) return { ok: false, reason: initError ? String(initError.message) : lockRetry.lastLock() ? `DB 잠금(다시 시도 예정): ${String(lockRetry.lastLock().message)}` : 'node:sqlite 없음' };
  const t = Date.now();
  h.db.exec('BEGIN');
  try {
    for (const r of records) {
      // v2.686 WEB2686-03: 쉬는 중(backoffUntil)인 주기는 조회하지 않았다 — 최신값을 덮으면 '마지막 조회' 가 방금으로 보이고
      //   포탈 문구가 '장비가 돌려준 사유' 칸에 들어가며, 사용 누적의 수집 횟수(cover)에도 시도한 것처럼 잡힌다.
      if (r.backoffUntil) continue;
      h.st.upLatest.run(
        String(r.serverId), String(r.name || ''), String(r.host || ''), Number(ts), r.ok ? 1 : 0,
        String(r.kind || 'error'), String(r.error || '').slice(0, 300),
        nOrNull(r.users), nOrNull(r.usersConnected), nOrNull(r.sessions), nOrNull(r.connected),
        nOrNull(r.disconnected), nOrNull(r.pending), nOrNull(r.stateUnknown),
        nOrNull(r.pages), r.truncated ? 1 : 0, String(r.usedUserKey || ''), String(r.usedStateKey || ''),
        r.userIdOnly ? 1 : 0, Number(r.usersOmitted) || 0, Number(r.poolsOmitted) || 0,
        JSON.stringify((r.names || []).slice(0, maxUsers)), JSON.stringify((r.pools || []).slice(0, 500)),
        nOrNull(r.ms),
        JSON.stringify((r.usage?.services || []).slice(0, 500)),
        JSON.stringify(usageMetaOf(r)),
      );
      // v2.684 앱별 사용 누적 — 수집 시도(성공·실패)는 cover 에, 관측한 (사용자, 서비스) 쌍은 daily 에.
      // ⚠ 일부 세션만 읽은 주기(truncated)의 쌍도 적재한다 — 관측은 '있었다' 는 양성 증거라 누적을 줄이지 않는다
      //   (누적은 원래 하한이다). 실패한 주기는 쌍이 없고 cover 의 ok_cycles 가 늘지 않는다.
      const day = dayKey(ts);
      if (day && r.kind !== 'auth-stopped' && r.kind !== 'mock') {
        h.st.upCover.run(day, String(r.serverId), r.ok ? 1 : 0, Number(ts), Number(ts));
        if (r.ok) {
          for (const p of r.usage?.pairs || []) {
            if (!p?.userKey || !p?.serviceKey) continue;
            h.st.upUsage.run(day, String(r.serverId), String(p.userKey).slice(0, 256), String(p.serviceKey).slice(0, 300),
              String(p.user || '').slice(0, 256), String(p.service || '').slice(0, 256), String(p.kind || ''), String(p.basis || ''),
              Number(ts), Number(ts), p.connected ? 1 : 0);
          }
        }
      }
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

/**
 * v2.708 데모(mock) 백필 — 지난 추이(hz_series)·누적(hz_usage_daily·hz_usage_cover)을 **한 트랜잭션**으로 채운다.
 * 호출부(sessionPoller)가 mock 이고 추이가 비어 있을 때만 부른다. 이미 있는 행은 건드리지 않는다(INSERT OR IGNORE) —
 * 실수집 행이 데모 행에 덮이지 않게. 값은 mock/demo/users.js demoHorizonBackfillRows 가 만든다.
 */
export async function backfillHzDemo({ series = [], usage = [], cover = [] } = {}) {
  const h = await open();
  if (!h) return { ok: false, reason: 'node:sqlite 없음' };
  const insS = h.db.prepare(`INSERT OR IGNORE INTO hz_series
    (server_id, ts, users, users_connected, sessions, connected, disconnected, pending, servers_ok, servers_failed) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const insU = h.db.prepare(`INSERT OR IGNORE INTO hz_usage_daily
    (day, server_id, user_key, service_key, user_name, service_name, kind, basis, first_ts, last_ts, samples, connected_samples) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insC = h.db.prepare('INSERT OR IGNORE INTO hz_usage_cover (day, server_id, cycles, ok_cycles, first_ts, last_ts) VALUES (?,?,?,?,?,?)');
  h.db.exec('BEGIN');
  try {
    for (const r of series) insS.run(String(r.serverId || ''), Number(r.ts), nOrNull(r.users), nOrNull(r.usersConnected), nOrNull(r.sessions), nOrNull(r.connected), nOrNull(r.disconnected), nOrNull(r.pending), nOrNull(r.serversOk), nOrNull(r.serversFailed));
    for (const u of usage) insU.run(String(u.day), String(u.serverId), String(u.userKey).slice(0, 256), String(u.serviceKey).slice(0, 300), String(u.user || '').slice(0, 256), String(u.service || '').slice(0, 256), String(u.kind || ''), String(u.basis || ''), Number(u.firstTs), Number(u.lastTs), Number(u.samples) || 0, Number(u.connectedSamples) || 0);
    for (const c of cover) insC.run(String(c.day), String(c.serverId), Number(c.cycles) || 0, Number(c.okCycles) || 0, Number(c.firstTs), Number(c.lastTs));
    h.db.exec('COMMIT');
  } catch (e) {
    try { h.db.exec('ROLLBACK'); } catch { /* */ }
    return { ok: false, reason: String(e.message || e).slice(0, 200) };
  }
  return { ok: true, series: series.length, usage: usage.length, cover: cover.length };
}

/** latest.usage_meta — 해석 근거·카탈로그 상태(화면이 '앱 이름을 어떻게 알았나' 를 말하는 근거). */
export function usageMetaOf(r) {
  const u = r?.usage;
  if (!u) return {};
  return {
    basisCounts: u.basisCounts || {}, appFieldKey: u.appFieldKey || null,
    pairs: Array.isArray(u.pairs) ? u.pairs.length : 0, pairsOmitted: Number(u.pairsOmitted) || 0,
    servicesOmitted: Number(u.servicesOmitted) || 0, sessionsNoUser: Number(u.sessionsNoUser) || 0,
    catalog: r.catalog ? { at: r.catalog.at || null, counts: r.catalog.counts || null, usedPaths: r.catalog.usedPaths || {}, errors: r.catalog.errors || {}, truncated: r.catalog.truncated || {} } : null,
  };
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
    services: j(r.services, []), usageMeta: j(r.usage_meta, {}),
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

/*
 * v2.741(DB-02): 앱별 사용 누적 조회를 **날 조각**으로 나눠 묻고 조각 사이에 시간 기준으로 양보한다.
 *  예전에는 GROUP BY·COUNT(DISTINCT) 문장 셋을 92일 전체에 한 번씩, 양보 없이 연달아 실행했다 — 이 모듈 머리말의 산정
 *  (2,000명 × 3 서비스, 하루 6천 행)이면 55만 행이라 1.1~1.8초 동기 정지였다(재현). 조각은 **겹치지 않는 날 범위**라
 *  · 쌍(사용자×서비스): COUNT(DISTINCT day)·SUM 은 더하고 MIN·MAX 는 다시 MIN·MAX 한다(MAX(text) 는 SQLite 와 같은 바이트 순서)
 *  · 날짜별 고유 수: 날 하나는 한 조각에만 있으므로 이어 붙이면 된다 · 사용자별 일수: 더한다
 *  결과(순서 포함)는 예전 한 문장과 같다(테스트가 같은 DB 에서 대조한다). 쌍·사용자별 일수의 순서는 SQLite 의 GROUP BY 출력
 *  (키의 바이트 순서)과 같게 다시 정렬한다 — 보고서(appUsageReport)의 표시 이름·동률 순서가 입력 순서에 기대기 때문이다.
 *  ⚠ 한 조각(하루) 문장 하나는 여전히 동기다 — 양보는 '사이' 에서만 가능하다(util/timeSlice.js 머리말).
 */
const USAGE_CHUNK_DAYS = 1;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** 'YYYY-MM-DD' 날 경계 조각 — 형식이 아니거나 거꾸로면 null(호출부가 한 문장으로 묻는다 — 예전 동작). */
function dayChunks(a, b, step = USAGE_CHUNK_DAYS) {
  const ma = DAY_RE.exec(a); const mb = DAY_RE.exec(b);
  if (!ma || !mb || a > b) return null;
  const t0 = Date.UTC(+ma[1], +ma[2] - 1, +ma[3]); const t1 = Date.UTC(+mb[1], +mb[2] - 1, +mb[3]);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return null;
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  if (iso(t0) !== a || iso(t1) !== b) return null;   // 2026-02-31 같은 날은 조각 계산을 믿지 않는다
  const out = [];
  for (let t = t0; t <= t1; t += step * DAY_MS) out.push([iso(t), iso(Math.min(t1, t + (step - 1) * DAY_MS))]);
  return out;
}
/** SQLite BINARY 정렬(= UTF-8 바이트 순서 = 코드 포인트 순서)과 같은 문자열 비교. JS 의 < 는 UTF-16 단위라 대리 쌍에서 다르다. */
function cmpBin(x, y) {
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const a = x.charCodeAt(i); const b = y.charCodeAt(i);
    if (a === b) continue;
    const sa = a >= 0xd800 && a <= 0xdfff; const sb = b >= 0xd800 && b <= 0xdfff;
    if (sa !== sb) return sa ? 1 : -1;   // 대리 쌍(U+10000 이상)이 BMP 의 어느 글자보다 크다
    return a < b ? -1 : 1;
  }
  return x.length - y.length;
}
/** SQLite MAX() 와 같은 규칙(NULL 무시 · 숫자 < 글자 · 글자는 바이트 순서). */
function sqlMax(a, b) {
  if (a == null) return b; if (b == null) return a;
  const ta = typeof a === 'string'; const tb = typeof b === 'string';
  if (ta !== tb) return ta ? a : b;
  if (ta) return cmpBin(a, b) >= 0 ? a : b;
  return a >= b ? a : b;
}
let _usageRangeStats = { runs: 0, lastMs: null, lastChunks: 0, lastYields: 0 };

/**
 * v2.684 앱별 사용 누적 조회 — 기간(포탈 날짜 'YYYY-MM-DD' 양끝 포함) · 서버('' = 전체).
 * 반환은 쌍(사용자×서비스) 행 + 날짜별 고유 수 + 날짜별 수집 횟수. 사용자·서비스 집계는 순수 모듈이 한다
 * (`appUsageReport.js`) — SQL 은 기간 안의 행을 묶기만 한다.
 * v2.741(DB-02): 날 조각 + 시간 기준 양보(위 머리말). `sliceMs` 는 양보 간격(테스트가 줄인다).
 */
export async function hzUsageRange({ fromDay, toDay, serverId = '', sliceMs = 15 } = {}) {
  const h = await open();
  if (!h) return { available: false, pairs: [], daily: [], userDays: [], cover: [], firstDay: null };
  const t0 = Date.now();
  const a = String(fromDay); const b = String(toDay);
  const sid = String(serverId || '');
  const q = (one, all, x, y) => (sid ? one.all(x, y, sid) : all.all(x, y));
  const chunks = dayChunks(a, b) || [[a, b]];
  const maybeYield = createYielder(sliceMs);
  const pairMap = new Map();   // user_key \0 service_key → 합친 행
  const userMap = new Map();   // user_key → 일수 합
  const dailyRows = [];
  for (const [x, y] of chunks) {
    for (const r of q(h.st.usagePairsOne, h.st.usagePairsAll, x, y)) {
      const k = `${r.user_key}\u0000${r.service_key}`;
      const p = pairMap.get(k);
      if (!p) { pairMap.set(k, { ...r }); continue; }
      p.user_name = sqlMax(p.user_name, r.user_name); p.service_name = sqlMax(p.service_name, r.service_name);
      p.kind = sqlMax(p.kind, r.kind); p.basis = sqlMax(p.basis, r.basis);
      p.days = (Number(p.days) || 0) + (Number(r.days) || 0);
      p.first_ts = p.first_ts == null ? r.first_ts : (r.first_ts == null ? p.first_ts : Math.min(p.first_ts, r.first_ts));
      p.last_ts = sqlMax(p.last_ts, r.last_ts);
      p.samples = (Number(p.samples) || 0) + (Number(r.samples) || 0);
      p.connected_samples = (Number(p.connected_samples) || 0) + (Number(r.connected_samples) || 0);
    }
    await maybeYield();
    for (const r of q(h.st.usageDailyOne, h.st.usageDailyAll, x, y)) dailyRows.push(r);
    for (const r of q(h.st.userDaysOne, h.st.userDaysAll, x, y)) userMap.set(r.user_key, (userMap.get(r.user_key) || 0) + (Number(r.days) || 0));
    await maybeYield();
  }
  const pairs = [...pairMap.values()]
    .sort((p1, p2) => cmpBin(p1.user_key, p2.user_key) || cmpBin(p1.service_key, p2.service_key))
    .map((r) => ({
      userKey: r.user_key, serviceKey: r.service_key, user: r.user_name, service: r.service_name, kind: r.kind, basis: r.basis,
      days: Number(r.days) || 0, firstTs: nOrNull(r.first_ts), lastTs: nOrNull(r.last_ts),
      samples: Number(r.samples) || 0, connectedSamples: Number(r.connected_samples) || 0,
    }));
  const daily = dailyRows.map((r) => ({ day: r.day, users: Number(r.users) || 0, services: Number(r.services) || 0 }));
  const userDays = [...userMap.entries()].sort((e1, e2) => cmpBin(e1[0], e2[0])).map(([userKey, days]) => ({ userKey, days }));
  // 수집 횟수는 (날 × 서버) 행이라 작다 — 한 문장이다.
  const cover = h.st.coverAll.all(a, b).filter((r) => !sid || r.server_id === sid)
    .map((r) => ({ day: r.day, serverId: r.server_id, cycles: Number(r.cycles) || 0, okCycles: Number(r.ok_cycles) || 0 }));
  _usageRangeStats = { runs: _usageRangeStats.runs + 1, lastMs: Date.now() - t0, lastChunks: chunks.length, lastYields: maybeYield.count() };
  return { available: true, pairs, daily, userDays, cover, firstDay: h.st.usageMinDay.get()?.d || null };
}
/** v2.741(DB-02): 조회 계측 — 몇 번 계산했는가(라우트 합류·기억이 실제로 계산을 줄이는지 테스트·진단이 본다). */
export function hzUsageRangeStats() { return { ..._usageRangeStats }; }

/** 앱별 사용 누적 prune — 일 단위(보존일 0 이하 = 무제한). 청크 + 양보. */
const _usagePruneFlight = createPruneFlight();
export async function pruneHzUsage(retentionDays, now = Date.now()) {
  const days = Number(retentionDays) || 0;
  if (days <= 0) return { skipped: true, reason: '무제한' };
  const h = await open();
  if (!h) return { skipped: true, reason: 'DB 없음' };
  return _usagePruneFlight.run(days, async () => {
    const before = dayKey(now - days * DAY_MS);
    let n = 0; let done = true;
    try {
      const r1 = await chunkedDelete(h.st.pruneUsage, [before], { label: 'horizon.hz_usage_daily' });
      const r2 = await chunkedDelete(h.st.pruneCover, [before], { label: 'horizon.hz_usage_cover' });
      n = r1.deleted + r2.deleted; done = r1.done && r2.done;
    } catch (e) { done = false; console.warn(`[horizon-sessions] 사용 누적 prune 실패: ${e?.message || e}`); }
    return { skipped: false, deleted: n, before, done };
  });
}

/**
 * 보존기간 prune — **N주기에 1회만**.
 * ⚠ `(++tick % N) === 0` 으로 쓸 것(`tick++ % N === 0` 은 첫 폴에서 즉시 참 — v2.453).
 */
const _pruneFlight = createPruneFlight();   // 진행 중인 정리(util/chunkedPrune.js)
export async function pruneHzSessions(retentionDays, { every = 12 } = {}) {
  if ((++tick % Math.max(1, every)) !== 0) return { skipped: true };
  const days = Number(retentionDays) || 0;
  if (days <= 0) return { skipped: true, reason: '무제한' };
  const h = await open();
  if (!h) return { skipped: true, reason: 'DB 없음' };
  // v2.603(감사 DB2603-02·RECENT2603-06): 청크 삭제 + 청크 사이 양보. 같은 보존일이면 진행 중인 것을 공유하고,
  //   바뀌었으면 끝난 뒤 새 경계로 한 번 더 돈다.
  return _pruneFlight.run(days, async () => {
    const before = Date.now() - days * 86_400_000;
    let s = 0; let done = true;
    try { const r = await chunkedDelete(h.st.pruneSeries, [before], { label: 'horizon.hz_series' }); s = r.deleted; done = r.done; } catch (e) { done = false; console.warn(`[horizon-sessions] prune 실패: ${e?.message || e}`); }
    return { skipped: false, series: s, before, done };
  });
}

/** 테스트 전용 — 잠금 재시도 대기(30초)를 건너뛴다. */
export function _expireLockRetryForTest() { lockRetry._expire(); }

export function _resetForTest() {
  try { x?.db?.close?.(); } catch { /* */ }
  x = null; ready = null; initError = null; lockRetry.ok(); tick = 0; _pruneFlight.reset(); _usagePruneFlight.reset();
}
