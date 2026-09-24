/**
 * linkcheck/db.js — 통신 점검 로그 **3단 DB**(v2.552). 파일: `<dbDir>/link-check.db`
 *
 * 사용자 요청: "점검하는 **로그를 최대한 많이 기록**해서 이슈가 있을때 분석하는 자료로".
 * 선택: **3단 구조**.
 *
 * ── 왜 3단인가(실제 계산) ────────────────────────────────────────────────────
 * 운영 규모는 링크 **약 140개**(중앙 측정 56 + 엣지 측정 84)다. 5분 주기면 288회/일 →
 * **4.0만 행/일**.
 *   · 요약만(행 60B)      : 90일 363만 행 **208MB** · 365일 1,470만 행 0.82GB  ← 감당 가능
 *   · **상세 전량**(1.5KB) : 90일 **5.1GB**                                    ← 과하다
 * 그래서 이렇게 나눈다:
 *   ① `link_sample`  주기 요약(단계별 ms·상태코드·phase)      — 기본 **90일**
 *   ② `link_event`   **실패·상태변화 때만** 상세 원문(JSON)    — 기본 **30일**
 *   ③ `link_daily`   일 롤업(성공률·p95·phase별 실패 수)       — 기본 **5년**
 *   + `link_latest`  링크별 최신 1건(화면 표 전용)
 * 이슈 분석에 필요한 것은 **실패 순간의 상세**이므로 ②가 목적을 만족하고, ①이 그 전후 맥락을,
 * ③이 장기 추세를 준다. **전량 상세는 14일도 0.8GB** 라 그보다 지난 이슈를 못 본다.
 *
 * ── v2.550.3 에서 **실측으로** 배운 것을 처음부터 적용한다 ───────────────────
 *  · ⚠ `MIN(ts)` 과 `MAX(ts)` 를 **한 쿼리에 쓰지 않는다**(518만 행에서 400ms vs 0.01ms).
 *  · ⚠ '최신 1건씩' 을 `GROUP BY`+`MAX(ts)` 로 만들지 않는다(702ms vs 0.53ms) → `link_latest`.
 *  · 롤업은 `ON CONFLICT DO UPDATE`(행당 2쿼리보다 2배 빠르다).
 *  · 원시는 `INSERT OR IGNORE` + `changes` 검사(같은 ts 재삽입이 롤업을 이중 계수하지 않게).
 *  · `COUNT(*)` 는 짧게 캐시하고 **캐시임을 밝힌다**(`countsAt`).
 *  · prune 은 `ts` 단독 인덱스 + `(++tick % N)===0` 스로틀.
 *  · DB 파일은 **열자마자 0600**, open 은 **진행 중인 시도를 공유**한다.
 *
 * ⚠ 하루 경계는 **한국 시각(UTC+9)** 이다(v2.531·v2.550 과 같은 값·같은 이유).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { numOrNull } from '../util/numOrNull.js';

const FILE = () => path.join(config.dbDir || config.configDir, 'link-check.db');
// 날짜 경계 코어는 `util/dayKey.js` 하나다(v2.582 ARCH-2). import 뒤 export(v2.575 재수출 규약).
import { DAY_OFFSET_MIN, dayKey } from "../util/dayKey.js";
import { openSqlite, createLockRetry } from '../util/sqliteOpen.js';
import { chunkedDelete, createPruneFlight } from '../util/chunkedPrune.js';
const lockRetry = createLockRetry();
export { DAY_OFFSET_MIN, dayKey };
const COUNT_CACHE_MS = Math.max(0, Number(process.env.LINKCHECK_COUNT_CACHE_MS) || 60_000);
/** 상세 원문 1건의 상한 — 넘으면 자르고 **잘렸다고 밝힌다**(조용한 상한 금지). */
export const DETAIL_MAX_BYTES = Math.max(1_000, Number(process.env.LINKCHECK_DETAIL_MAX) || 8_000);

let _db = null; let _tried = false; let _opening = null; let _tick = 0; let _counts = null;

async function getDb() {
  if (_db) return _db;
  if (lockRetry.blocked()) return null;   // 잠금 뒤 재시도 대기(매 호출 3초 busy_timeout 을 태우지 않게)
  if (_opening) return _opening;
  if (_tried) return _db;
  _opening = openDb().finally(() => { _opening = null; });
  return _opening;
}
/** link_daily.ms_n 이 없을 때만 추가 + 구 행 합 비우기(한 트랜잭션). @returns {boolean} 추가했으면 true */
export function migrateLinkDailyMsN(conn) {
  const have = conn.prepare('PRAGMA table_info(link_daily)').all().some((r) => r.name === 'ms_n');
  if (have) return false;
  conn.exec('BEGIN IMMEDIATE');
  try {
    conn.exec('ALTER TABLE link_daily ADD COLUMN ms_n INTEGER NOT NULL DEFAULT 0');
    try { conn.exec('UPDATE link_daily SET ms_sum = 0 WHERE ms_n = 0'); } catch (e) { e.message = `구 행 합 비우기 실패(열 추가도 되돌린다): ${e.message}`; throw e; }
    conn.exec('COMMIT');
    return true;
  } catch (e) {
    try { conn.exec('ROLLBACK'); } catch { /* 이미 끝남 */ }
    if (/duplicate column name/i.test(String(e?.message || ''))) return false;
    throw e;
  }
}
async function openDb() {
  let conn = null;   // v2.599 DB2599-02: 실패하면 닫는다(잠금이면 래치하지 않고 다시 연다)
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    const { DatabaseSync } = await import('node:sqlite');
    conn = openSqlite(new DatabaseSync(FILE()));   // busy_timeout 먼저 · 잠금이면 닫고 던진다
    try { fs.chmodSync(FILE(), 0o600); } catch { /* best effort */ }
    conn.exec(`/* ① 주기 요약 — 이 테이블이 가장 크다. 열은 짧게(행 60B 목표). */
      CREATE TABLE IF NOT EXISTS link_sample (
        link_id TEXT NOT NULL, ts INTEGER NOT NULL,
        ok INTEGER NOT NULL, phase TEXT, fail_kind TEXT, reached TEXT,
        total_ms INTEGER, dns_ms INTEGER, tcp_ms INTEGER, tls_ms INTEGER, http_ms INTEGER,
        status INTEGER, cert_days INTEGER, by_node TEXT,
        PRIMARY KEY (link_id, ts)
      );
      /* prune 은 'DELETE WHERE ts<?' 라 ts 단독 인덱스가 필요하다(복합 PK 로는 못 탄다). */
      CREATE INDEX IF NOT EXISTS idx_lc_sample_ts ON link_sample(ts);
      /* ② 상세 — 실패·상태변화 때만. detail 은 JSON 원문(단계별 전체·오류·본문조각·인증서). */
      CREATE TABLE IF NOT EXISTS link_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        link_id TEXT NOT NULL, ts INTEGER NOT NULL,
        event TEXT NOT NULL, ok INTEGER, phase TEXT, fail_kind TEXT,
        prev_ok INTEGER, prev_phase TEXT,
        summary TEXT, detail TEXT, truncated INTEGER DEFAULT 0, by_node TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_lc_event_ts ON link_event(ts);
      CREATE INDEX IF NOT EXISTS idx_lc_event_link ON link_event(link_id, ts);
      /* ③ 일 롤업 — 장기 추세. p95 는 저장할 수 없으니(스트리밍) 합·개수·최대와 버킷을 둔다. */
      CREATE TABLE IF NOT EXISTS link_daily (
        link_id TEXT NOT NULL, day TEXT NOT NULL,
        n INTEGER NOT NULL DEFAULT 0, ok_n INTEGER NOT NULL DEFAULT 0,
        ms_sum INTEGER NOT NULL DEFAULT 0, ms_max INTEGER, ms_n INTEGER NOT NULL DEFAULT 0,
        f_dns INTEGER DEFAULT 0, f_tcp INTEGER DEFAULT 0, f_tls INTEGER DEFAULT 0,
        f_http INTEGER DEFAULT 0, f_auth INTEGER DEFAULT 0, f_identity INTEGER DEFAULT 0,
        last_ts INTEGER,
        PRIMARY KEY (link_id, day)
      );
      CREATE INDEX IF NOT EXISTS idx_lc_daily_day ON link_daily(day);
      /* 최신 1건 — ⚠ GROUP BY+MAX(ts) 로 대체하지 말 것(v2.550.3 실측 702ms vs 0.53ms). */
      CREATE TABLE IF NOT EXISTS link_latest (
        link_id TEXT PRIMARY KEY, ts INTEGER NOT NULL,
        ok INTEGER NOT NULL, phase TEXT, fail_kind TEXT, reached TEXT,
        total_ms INTEGER, dns_ms INTEGER, tcp_ms INTEGER, tls_ms INTEGER, http_ms INTEGER,
        status INTEGER, cert_days INTEGER, by_node TEXT, summary TEXT,
        since_ts INTEGER, streak INTEGER DEFAULT 1
      );`);
    /*
     * ⚠⚠ v2.574 BUG-05 — 구버전 DB 에 `ms_n` 을 더한다(있으면 조용히 실패하고 넘어간다).
     *   `CREATE TABLE IF NOT EXISTS` 는 **이미 있는 표의 열을 늘리지 않는다** — 이 한 줄이
     *   없으면 업그레이드한 현장에서 `no such column: ms_n` 으로 적재가 통째로 죽는다.
     */
    // v2.596(감사 DB-3 — 재현): 열이 **새로 생긴** 경우 구 행의 ms_sum 은 ms_n=0 과 짝이 맞지 않는다 — 전환일에 새 표본이
    //   더해지면 옛 합(수십~수백 표본분)을 새 개수로 나눠 평균이 수십~수백 배로 부푼다. 새로 만든 경우에만 구 행의 합을 비운다
    //   (구 행은 이미 평균을 내지 않는다 — 표시가 바뀌지 않는다).
    // v2.603(감사 — ipam DB2603-01 과 같은 패턴): 예전 `try { ALTER } catch { /* 이미 있는 열 */ }` 는 잠금(SQLITE_BUSY)도
    //   '이미 있음' 으로 삼켰다 — 열 없이 열려 적재가 'no such column: ms_n' 으로 죽었다. 이제 table_info 로 없을 때만 추가하고,
    //   열 추가와 구 행 합 비우기를 **한 트랜잭션**으로 묶는다(추가만 되고 비우기가 실패하면 다음 open 은 열이 있다고 보고
    //   비우기를 영영 건너뛴다 — 평균이 부푼다). 'duplicate column name'(경합)만 삼키고 잠금은 던져 lockRetry 가 다시 연다.
    migrateLinkDailyMsN(conn);
    _db = conn;
  } catch (e) {
    try { conn?.close(); } catch { /* 이미 닫힘 */ }
    if (lockRetry.onFail(e)) { console.warn(`[linkcheck-db] ${lockRetry.note()}`); return null; }
    console.warn('[linkcheck-db] 사용 불가(DB 없이 동작):', e?.message);
    _db = null;
  }
  _tried = true;
  return _db;
}
export async function available() { return !!(await getDb()); }

const n = numOrNull;   // v2.561: 공용 판정
const iOr = (v, d = null) => { const x = n(v); return x == null ? d : Math.round(x); };

export async function dbStatus() {
  const db = await getDb();
  if (!db) return { available: false, path: FILE() };
  try {
    let s = _counts;
    if (!s || Date.now() - s.at > COUNT_CACHE_MS) {
      s = {
        sample: db.prepare('SELECT COUNT(*) c FROM link_sample').get()?.c ?? 0,
        event: db.prepare('SELECT COUNT(*) c FROM link_event').get()?.c ?? 0,
        daily: db.prepare('SELECT COUNT(*) c FROM link_daily').get()?.c ?? 0,
        at: Date.now(),
      };
      _counts = s;
    }
    // ⚠ MIN/MAX 를 **각각** 단독 쿼리로(한 쿼리에 두 aggregate 면 인덱스 최적화가 죽는다 — v2.550.3 실측).
    const firstTs = db.prepare('SELECT MIN(ts) v FROM link_sample').get()?.v ?? null;
    const lastTs = db.prepare('SELECT MAX(ts) v FROM link_sample').get()?.v ?? null;
    let bytes = null;
    try { bytes = fs.statSync(FILE()).size; } catch { /* */ }
    return {
      available: true, path: FILE(),
      sampleRows: s.sample, eventRows: s.event, dailyRows: s.daily, countsAt: s.at,
      firstTs, lastTs, bytes, detailMaxBytes: DETAIL_MAX_BYTES,
    };
  } catch (e) { return { available: true, path: FILE(), error: String(e?.message || e).slice(0, 200) }; }
}

/** 실패 phase → 롤업 열. 미분류는 어디에도 세지 않는다(없는 것을 만들지 않는다). */
const F_COL = { dns: 'f_dns', tcp: 'f_tcp', tls: 'f_tls', http: 'f_http', auth: 'f_auth', identity: 'f_identity' };

/**
 * 한 주기 적재. **트랜잭션 1회**로 묶는다(무트랜잭션 대량 write 가 과거 25초 블로킹을 만들었다).
 * @param {Array} results `[{ link, verdict, steps, summary, detail, byNode }]`
 */
export async function insertResults(results = [], { byNode = '' } = {}) {
  const db = await getDb();
  if (!db) return { ok: false, inserted: 0 };
  if (!results.length) return { ok: true, inserted: 0, events: 0 };

  const insSample = db.prepare(`INSERT OR IGNORE INTO link_sample
    (link_id,ts,ok,phase,fail_kind,reached,total_ms,dns_ms,tcp_ms,tls_ms,http_ms,status,cert_days,by_node)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insEvent = db.prepare(`INSERT INTO link_event
    (link_id,ts,event,ok,phase,fail_kind,prev_ok,prev_phase,summary,detail,truncated,by_node)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const selLatest = db.prepare('SELECT ok, phase, since_ts, streak FROM link_latest WHERE link_id=?');
  const upLatest = db.prepare(`INSERT INTO link_latest
    (link_id,ts,ok,phase,fail_kind,reached,total_ms,dns_ms,tcp_ms,tls_ms,http_ms,status,cert_days,by_node,summary,since_ts,streak)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(link_id) DO UPDATE SET
      ts=excluded.ts, ok=excluded.ok, phase=excluded.phase, fail_kind=excluded.fail_kind,
      reached=excluded.reached, total_ms=excluded.total_ms, dns_ms=excluded.dns_ms, tcp_ms=excluded.tcp_ms,
      tls_ms=excluded.tls_ms, http_ms=excluded.http_ms, status=excluded.status, cert_days=excluded.cert_days,
      by_node=excluded.by_node, summary=excluded.summary, since_ts=excluded.since_ts, streak=excluded.streak
      WHERE excluded.ts >= link_latest.ts`);
  /*
   * ⚠⚠ v2.574 BUG-05 — **실패 표본을 응답시간 평균의 분모에 넣지 말 것.**
   *   예전에는 `n` 하나가 '표본 수' 와 '응답시간 표본 수' 를 겸했고 실패 표본도
   *   `ms_sum += 0` 을 더했다. 그래서 하루 종일 다운된 링크가 `n=288, ms_sum=0` 이 되어
   *   **`ms_avg = 0ms`(= 즉시 응답)** 라는 거짓을 냈고, 절반만 다운이면 실제 40ms 가 20ms 로
   *   보였다(실행 재현). v2.552 가 **화면에서** 고친 `0ms` 거짓이 DB 층에 남아 있던 것이다.
   *   `bmusage/db.js:96·199` 는 같은 함정을 `cpu_n` 분모 분리로 이미 피하고 있었다
   *   ("값이 있을 때만 1 을 더한다 — null 을 분모에 넣으면…"). 여기에도 `ms_n` 을 둔다.
   * ⚠ `n`(전체 표본)·`ok_n`(성공 수)은 그대로다 — 가용률 계산이 그 둘을 쓴다.
   */
  const upDaily = db.prepare(`INSERT INTO link_daily
    (link_id,day,n,ok_n,ms_sum,ms_max,ms_n,f_dns,f_tcp,f_tls,f_http,f_auth,f_identity,last_ts)
    VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(link_id,day) DO UPDATE SET
      n=n+1, ok_n=ok_n+excluded.ok_n, ms_sum=ms_sum+excluded.ms_sum, ms_n=ms_n+excluded.ms_n,
      ms_max=NULLIF(MAX(IFNULL(ms_max,-1), IFNULL(excluded.ms_max,-1)), -1),
      f_dns=f_dns+excluded.f_dns, f_tcp=f_tcp+excluded.f_tcp, f_tls=f_tls+excluded.f_tls,
      f_http=f_http+excluded.f_http, f_auth=f_auth+excluded.f_auth, f_identity=f_identity+excluded.f_identity,
      last_ts=MAX(IFNULL(last_ts,0), excluded.last_ts)`);

  let inserted = 0; let events = 0; let duplicates = 0; let truncatedN = 0;
  db.exec('BEGIN');
  try {
    for (const r of results) {
      const id = String(r?.link?.id || '').trim();
      const ts = iOr(r?.ts ?? Date.now());
      if (!id || ts == null) continue;
      const v = r.verdict || {};
      const st = r.steps || {};
      const node = String(r.byNode || byNode || '').slice(0, 64);
      const ok = v.ok ? 1 : 0;
      const row = [
        id, ts, ok, String(v.phase || ''), String(v.failKind || ''), String(v.reached || ''),
        iOr(v.totalMs), iOr(st.dns?.ms), iOr(st.tcp?.ms), iOr(st.tls?.ms), iOr(st.http?.ms),
        iOr(st.http?.status), iOr(st.tls?.certDaysLeft), node,
      ];
      const res = insSample.run(...row);
      if (!Number(res?.changes)) { duplicates += 1; continue; }
      inserted += 1;

      // 롤업
      const fcol = ok ? null : F_COL[String(v.phase || '')];
      const f = { f_dns: 0, f_tcp: 0, f_tls: 0, f_http: 0, f_auth: 0, f_identity: 0 };
      if (fcol) f[fcol] = 1;
      /*
       * ⚠ 응답시간은 **측정된 주기만** 더한다. `totalMs` 가 없거나(도달 0단계) 실패면
       *   합에도 개수에도 넣지 않는다 — 0 을 더하면 그것이 곧 '0ms 응답' 이라는 거짓이다.
       * ⚠ `ms_max` 도 측정분만(없으면 NULL → 위 upsert 의 센티널이 되돌린다).
       */
      const measured = ok ? n(v.totalMs) : null;
      upDaily.run(id, dayKey(ts), ok, measured == null ? 0 : Math.round(measured),
        measured == null ? null : Math.round(measured), measured == null ? 0 : 1,
        f.f_dns, f.f_tcp, f.f_tls, f.f_http, f.f_auth, f.f_identity, ts);

      // 최신값 + 연속 횟수(같은 상태가 몇 번째인가 — 이슈 분석에서 '언제부터' 를 준다)
      const prev = selLatest.get(id) || null;
      const sameState = prev && Number(prev.ok) === ok;
      const sinceTs = sameState ? (iOr(prev.since_ts) ?? ts) : ts;
      const streak = sameState ? (iOr(prev.streak) ?? 1) + 1 : 1;
      upLatest.run(...row, String(r.summary || '').slice(0, 300), sinceTs, streak);

      /*
       * ⚠⚠ 상세는 **실패이거나 상태가 바뀔 때만** 남긴다(사용자 선택 3단 구조의 핵심).
       *   성공이 이어지는 주기까지 원문을 남기면 90일 5.1GB 다. 상태 변화는 **정상 복귀도 포함**
       *   한다 — '언제 돌아왔나' 가 없으면 장애 구간을 못 잡는다.
       */
      const changed = !prev || Number(prev.ok) !== ok || String(prev.phase || '') !== String(v.phase || '');
      if (!ok || changed) {
        let detail = '';
        let trunc = 0;
        try { detail = JSON.stringify(r.detail ?? { steps: st, link: r.link }); } catch { detail = '"(직렬화 실패)"'; }
        if (detail.length > DETAIL_MAX_BYTES) { detail = detail.slice(0, DETAIL_MAX_BYTES); trunc = 1; truncatedN += 1; }
        /*
         * ⚠ **첫 점검을 'recovered'(복구됨) 라 하지 않는다**(v2.552 자체 검증에서 잡은 결함):
         *   이전 상태가 없으면 무엇에서 복구된 것이 아니다 — 그것은 `first` 다. 장애 구간을
         *   세는 화면이 없는 복구를 하나 더 세게 된다.
         */
        const evName = !ok ? (changed ? 'fail-start' : 'fail') : (prev ? 'recovered' : 'first');
        insEvent.run(
          id, ts, evName, ok,
          String(v.phase || ''), String(v.failKind || ''),
          prev ? Number(prev.ok) : null, prev ? String(prev.phase || '') : null,
          String(r.summary || '').slice(0, 300), detail, trunc, node,
        );
        events += 1;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* */ }
    return { ok: false, inserted: 0, error: String(e?.message || e).slice(0, 200) };
  }
  if (inserted || events) _counts = null;
  return { ok: true, inserted, events, duplicates, truncated: truncatedN };
}

/**
 * 보존 집행. ⚠ 스로틀은 `(++tick % N) === 0`(기동 첫 틱 즉발 금지 — v2.453).
 *
 * v2.603(감사 DB2603-02 — 재현): 예전 `DELETE FROM link_sample WHERE ts < ?` 한 방은 보존일을 설정 화면에서 줄이면
 * 수백만 행을 동기로 지워 이벤트 루프를 멈췄다(감사 재현: 300만 행 3.9초 · 최대 루프 공백 3.9초). logs(v2.601)·metrics 와
 * 같은 규약 — rowid 서브쿼리 청크 DELETE + 청크 사이 setImmediate 양보(util/chunkedPrune.js). 상한에 걸리면 `done:false`
 * 이고 다음 주기가 잇는다. 정리끼리는 겹치지 않는다 — 같은 보존일이면 진행 중인 것을 공유하고, 보존일이 바뀌었으면
 * 그것이 끝난 뒤 **새 경계로 한 번 더** 돈다(RECENT2603-06 과 같은 판단: 공유만 하면 새 보존일이 그 호출에 안 먹는다).
 */
const _pruneFlight = createPruneFlight();   // 같은 보존일이면 공유, 다르면 끝난 뒤 한 번 더(util/chunkedPrune.js)
function prunePrepared(db) {
  // 인덱스: idx_lc_sample_ts · idx_lc_event_ts · idx_lc_daily_day 가 서브쿼리의 풀스캔을 막는다.
  return {
    sample: db.prepare('DELETE FROM link_sample WHERE rowid IN (SELECT rowid FROM link_sample WHERE ts < ? LIMIT ?)'),
    event: db.prepare('DELETE FROM link_event WHERE rowid IN (SELECT rowid FROM link_event WHERE ts < ? LIMIT ?)'),
    daily: db.prepare('DELETE FROM link_daily WHERE rowid IN (SELECT rowid FROM link_daily WHERE day < ? LIMIT ?)'),
    // v2.606(감사 CEN2606-01): link_latest 는 예전에 정리 대상이 아니었다 — 없어진 링크(엣지 삭제·vCenter 이관)와
    //   예전에 받던 임의 id 행이 영구히 남아 latestAll(전량) 에 실렸다. 원시 표본 보존일보다 오래 갱신되지 않은 행은
    //   그 링크의 이력도 이미 지워졌으므로 함께 지운다.
    latest: db.prepare('DELETE FROM link_latest WHERE rowid IN (SELECT rowid FROM link_latest WHERE ts < ? LIMIT ?)'),
  };
}
/** 최신값 행 중 **현재 링크 집합에 없고** 오래된(기본 1일) 것 — 호출자가 현재 링크 id 목록을 줄 때만(v2.606 CEN2606-01). */
export const LATEST_ORPHAN_MS = 24 * 3_600_000;
function pruneOrphanLatest(db, currentIds, olderThanMs = LATEST_ORPHAN_MS, now = Date.now()) {
  if (!currentIds) return 0;
  const keep = new Set([...currentIds].map((x) => String(x).toLowerCase()));
  const cutoff = now - olderThanMs;
  const del = db.prepare('DELETE FROM link_latest WHERE link_id=?');
  let n = 0;
  for (const r of db.prepare('SELECT link_id, ts FROM link_latest WHERE ts < ?').all(cutoff)) {
    if (keep.has(String(r.link_id).toLowerCase())) continue;
    n += Number(del.run(r.link_id)?.changes) || 0;
  }
  return n;
}
async function runPrune(db, { sampleDays, eventDays, dailyDays, currentIds = null }) {
  const st = prunePrepared(db);
  const a = await chunkedDelete(st.sample, [Date.now() - sampleDays * 86_400_000], { label: 'linkcheck.link_sample' });
  const l = await chunkedDelete(st.latest, [Date.now() - sampleDays * 86_400_000], { label: 'linkcheck.link_latest' });
  let orphan = 0;
  try { orphan = pruneOrphanLatest(db, currentIds); } catch { /* 진단성 정리 — 실패해도 보존 집행은 계속 */ }
  const b = await chunkedDelete(st.event, [Date.now() - eventDays * 86_400_000], { label: 'linkcheck.link_event' });
  const c = await chunkedDelete(st.daily, [dayKey(Date.now() - dailyDays * 86_400_000)], { label: 'linkcheck.link_daily' });
  const del = { sample: a.deleted, event: b.deleted, daily: c.deleted, latest: l.deleted + orphan };
  if (del.sample || del.event || del.daily || del.latest) _counts = null;
  // 상한에 걸려 남은 것이 있으면 밝힌다(조용한 상한 금지) — 다음 주기가 이어서 지운다.
  const done = a.done && b.done && c.done && l.done;
  return { ok: true, ...del, done };
}
export async function pruneLinkCheck({ sampleDays = 90, eventDays = 30, dailyDays = 365 * 5, every = 12, force = false, currentIds = null } = {}) {
  const db = await getDb();
  if (!db) return { ok: false };
  if (!force && (++_tick % every) !== 0) return { ok: true, skipped: true };
  const days = { sampleDays, eventDays, dailyDays, currentIds };
  const key = `${sampleDays}|${eventDays}|${dailyDays}|${currentIds ? 'ids' : ''}`;
  return _pruneFlight.run(key, () => runPrune(db, days)
    .catch((e) => ({ ok: false, error: String(e?.message || e).slice(0, 200) })));
}

/** 화면 표 — 링크별 최신 1건. ⚠ 전용 테이블을 읽는다(GROUP BY 로 되돌리지 말 것). */
export async function latestAll() {
  const db = await getDb();
  if (!db) return [];
  try { return db.prepare('SELECT * FROM link_latest').all(); } catch { return []; }
}

/** 한 링크의 요약 추이. 상한으로 잘렸으면 **밝힌다**. */
export async function samplesOf(linkId, { hours = 24, limit = 3_000 } = {}) {
  const db = await getDb();
  if (!db) return { rows: [], truncated: false };
  const since = Date.now() - Math.max(1, n(hours) || 24) * 3_600_000;
  try {
    const rows = db.prepare('SELECT * FROM link_sample WHERE link_id=? AND ts>=? ORDER BY ts DESC LIMIT ?')
      .all(String(linkId), since, limit + 1);
    return { rows: rows.slice(0, limit).reverse(), truncated: rows.length > limit };
  } catch { return { rows: [], truncated: false }; }
}

/**
 * 상세 로그 조회 — **이슈 분석의 본체**. 링크·기간·실패종류로 좁힌다.
 * ⚠ `detail` 은 크므로 목록에서는 기본 제외하고(`withDetail`) 단건에서만 준다.
 */
export async function eventsOf({ linkId = '', hours = 24 * 7, failKind = '', event = '', limit: limitIn = 300, withDetail = false } = {}) {
  // v2.606(DB2606-06): 정수로 — 소수가 'LIMIT ?' 에 바인딩되면 datatype mismatch 다(라우트도 pageArgs 로 좁힌다).
  const limit = Math.max(1, Math.min(10_000, Math.trunc(Number(limitIn)) || 300));
  const db = await getDb();
  if (!db) return { rows: [], truncated: false };
  const since = Date.now() - Math.max(1, n(hours) || 168) * 3_600_000;
  const cols = withDetail
    ? '*'
    : 'id, link_id, ts, event, ok, phase, fail_kind, prev_ok, prev_phase, summary, truncated, by_node, LENGTH(detail) AS detail_bytes';
  const where = ['ts>=?']; const args = [since];
  if (linkId) { where.push('link_id=?'); args.push(String(linkId)); }
  if (failKind) { where.push('fail_kind=?'); args.push(String(failKind)); }
  if (event) { where.push('event=?'); args.push(String(event)); }
  try {
    const rows = db.prepare(`SELECT ${cols} FROM link_event WHERE ${where.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT ?`)
      .all(...args, limit + 1);
    return { rows: rows.slice(0, limit), truncated: rows.length > limit };
  } catch (e) { return { rows: [], truncated: false, error: String(e?.message || e).slice(0, 200) }; }
}

/** 상세 1건(원문). */
export async function eventDetail(id) {
  const db = await getDb();
  if (!db) return null;
  try { return db.prepare('SELECT * FROM link_event WHERE id=?').get(Number(id)) || null; } catch { return null; }
}

/** 일 롤업. 평균은 `ms_sum/n` 으로 되돌린다 — **n 이 0 이면 `null`**(0 이 아니다). */
export async function dailyOf({ linkId = '', days = 90 } = {}) {
  const db = await getDb();
  if (!db) return [];
  const from = dayKey(Date.now() - Math.max(1, n(days) || 90) * 86_400_000);
  try {
    const rows = linkId
      ? db.prepare('SELECT * FROM link_daily WHERE link_id=? AND day>=? ORDER BY day').all(String(linkId), from)
      : db.prepare('SELECT * FROM link_daily WHERE day>=? ORDER BY day, link_id').all(from);
    return rows.map((r) => ({
      ...r,
      // ⚠ 분모는 **응답시간을 측정한 주기 수**(`ms_n`)다. 구버전 행은 `ms_n=0` 이라
      //   평균을 **null** 로 준다 — 0ms 라고 거짓말하지 않는다(마이그레이션 전 데이터).
      ms_avg: r.ms_n > 0 ? Math.round(r.ms_sum / r.ms_n) : null,
      msSamples: r.ms_n ?? 0,
      ok_pct: r.n > 0 ? Math.round((r.ok_n / r.n) * 1000) / 10 : null,
    }));
  } catch { return []; }
}

export function _resetForTest() {
  lockRetry.ok();
  try { _db?.close?.(); } catch { /* */ }
  _db = null; _tried = false; _opening = null; _tick = 0; _counts = null;
}
