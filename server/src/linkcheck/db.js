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
export const DAY_OFFSET_MIN = Number(process.env.LINKCHECK_TZ_OFFSET_MIN) || 9 * 60;
const COUNT_CACHE_MS = Math.max(0, Number(process.env.LINKCHECK_COUNT_CACHE_MS) || 60_000);
/** 상세 원문 1건의 상한 — 넘으면 자르고 **잘렸다고 밝힌다**(조용한 상한 금지). */
export const DETAIL_MAX_BYTES = Math.max(1_000, Number(process.env.LINKCHECK_DETAIL_MAX) || 8_000);

export function dayKey(ts, offsetMin = DAY_OFFSET_MIN) {
  return new Date(Number(ts) + offsetMin * 60_000).toISOString().slice(0, 10);
}

let _db = null; let _tried = false; let _opening = null; let _tick = 0; let _counts = null;

async function getDb() {
  if (_db) return _db;
  if (_opening) return _opening;
  if (_tried) return _db;
  _opening = openDb().finally(() => { _opening = null; });
  return _opening;
}
async function openDb() {
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    const { DatabaseSync } = await import('node:sqlite');
    const conn = new DatabaseSync(FILE());
    try { fs.chmodSync(FILE(), 0o600); } catch { /* best effort */ }
    conn.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;
      /* ① 주기 요약 — 이 테이블이 가장 크다. 열은 짧게(행 60B 목표). */
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
        ms_sum INTEGER NOT NULL DEFAULT 0, ms_max INTEGER,
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
    _db = conn;
  } catch (e) {
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
  const upDaily = db.prepare(`INSERT INTO link_daily
    (link_id,day,n,ok_n,ms_sum,ms_max,f_dns,f_tcp,f_tls,f_http,f_auth,f_identity,last_ts)
    VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(link_id,day) DO UPDATE SET
      n=n+1, ok_n=ok_n+excluded.ok_n, ms_sum=ms_sum+excluded.ms_sum,
      ms_max=MAX(IFNULL(ms_max,0), IFNULL(excluded.ms_max,0)),
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
      upDaily.run(id, dayKey(ts), ok, iOr(v.totalMs, 0), iOr(v.totalMs, 0),
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

/** 보존 집행. ⚠ 스로틀은 `(++tick % N) === 0`(기동 첫 틱 즉발 금지 — v2.453). */
export async function pruneLinkCheck({ sampleDays = 90, eventDays = 30, dailyDays = 365 * 5, every = 12, force = false } = {}) {
  const db = await getDb();
  if (!db) return { ok: false };
  if (!force && (++_tick % every) !== 0) return { ok: true, skipped: true };
  try {
    const a = db.prepare('DELETE FROM link_sample WHERE ts < ?').run(Date.now() - sampleDays * 86_400_000);
    const b = db.prepare('DELETE FROM link_event WHERE ts < ?').run(Date.now() - eventDays * 86_400_000);
    const c = db.prepare('DELETE FROM link_daily WHERE day < ?').run(dayKey(Date.now() - dailyDays * 86_400_000));
    const del = { sample: Number(a?.changes) || 0, event: Number(b?.changes) || 0, daily: Number(c?.changes) || 0 };
    if (del.sample || del.event || del.daily) _counts = null;
    return { ok: true, ...del };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) }; }
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
export async function eventsOf({ linkId = '', hours = 24 * 7, failKind = '', event = '', limit = 300, withDetail = false } = {}) {
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
      ms_avg: r.n > 0 ? Math.round(r.ms_sum / r.n) : null,
      ok_pct: r.n > 0 ? Math.round((r.ok_n / r.n) * 1000) / 10 : null,
    }));
  } catch { return []; }
}

export function _resetForTest() {
  try { _db?.close?.(); } catch { /* */ }
  _db = null; _tried = false; _opening = null; _tick = 0; _counts = null;
}
