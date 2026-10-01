/**
 * Generic metrics time-series store (host temperature, datastore usage, GPU
 * utilization …). Mirrors the iDRAC power DB: Node built-in SQLite when the
 * --experimental-sqlite flag is present, else an append-only NDJSON fallback.
 *
 * Schema: samples(metric, k, v, ts). `metric` is the series family
 * (e.g. 'temp_host','temp_cluster','temp_vc','ds_usedgb','gpu_util'); `k` is the
 * entity key within that family. Long ranges are downsampled via bucketed
 * aggregation in the query (avg/min/max per time bucket).
 */

import fs from 'node:fs';
import { splitByDeadband, policyFromEnv, policyKeyFor } from './deadband.js';
import { chunkedDelete } from '../util/chunkedPrune.js';
import path from 'node:path';
import { config } from '../config.js';
import { openSqlite, retryOnLock } from '../util/sqliteOpen.js'; // v2.613 PERSIST2613-03: open 코어는 하나
import { pushAll } from '../util/pushAll.js';
import { createYielder } from '../util/timeSlice.js';

const DB_PATH = config.temp.dbPath; // reuse the temp/metrics DB path

let impl = null;
let ready = null;

function initSqlite() {
  // eslint-disable-next-line import/no-unresolved
  return import('node:sqlite').then(({ DatabaseSync }) => {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    // WAL + synchronous=NORMAL: 커밋당 fsync 2회(DELETE 저널) → 배치화(단건 insert 5ms→0.01ms 실측).
    // busy_timeout: 동시 접근 시 즉시 SQLITE_BUSY 실패 대신 대기 — journal_mode 보다 **먼저**(v2.597 L2597-02).
    // v2.613 PERSIST2613-03: chmod(DB2611-01) → busy_timeout → WAL/NORMAL 을 openSqlite 가 한다. 예전 손 사본은 busy_timeout 을
    //   두 번 걸고 journal_mode 의 잠금 오류를 삼켰다(규칙 2 위반 — 바로 뒤 CREATE 가 같은 잠금으로 던져 실효는 없었다).
    const db = openSqlite(new DatabaseSync(DB_PATH));
    try { fs.chmodSync(DB_PATH, 0o600); } catch { /* best effort — openSqlite 가 이미 했다(secAudit2535 스윕 규약 유지) */ }
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS samples (
          metric TEXT NOT NULL, k TEXT NOT NULL, v REAL NOT NULL, ts INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_samples_mkt ON samples (metric, k, ts);
        CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples (ts); -- prune(ts<?)가 풀스캔 없이 타도록
        -- historyAll(패밀리 전 키 일괄 버킷)이 '해당 패밀리의 창 구간'만 읽도록.
        -- (metric,k,ts)로는 ts 선탐색이 안 돼 패밀리 전체(보존기간 전부)를 스캔하게 된다.
        -- 기존 대형 DB는 업그레이드 후 첫 기동에서 1회 생성 비용(규모에 따라 수십 초)이 든다.
        CREATE INDEX IF NOT EXISTS idx_samples_mt ON samples (metric, ts);
        -- 시간당 롤업: 60분+ 버킷 조회(용량예측 등 장기 윈도우)가 원본 대신 시간당 1행을 읽는다.
        -- 적재와 '같은 트랜잭션'에서 upsert 해 원본과 어긋나지 않게 한다. prune 도 함께 지운다.
        CREATE TABLE IF NOT EXISTS samples_hourly (
          metric TEXT NOT NULL, k TEXT NOT NULL, h INTEGER NOT NULL,
          n INTEGER NOT NULL, sum REAL NOT NULL, mn REAL NOT NULL, mx REAL NOT NULL,
          PRIMARY KEY (metric, k, h)
        );
        CREATE INDEX IF NOT EXISTS idx_hourly_h ON samples_hourly (h); -- prune(h<?)용
        -- v2.675: 작은 상태 표(롤업 백필 완료 표지 등). 행 수 몇 개.
        CREATE TABLE IF NOT EXISTS samples_meta (key TEXT PRIMARY KEY, v TEXT);
      `);
    } catch (e) { try { db.close(); } catch { /* */ } throw e; } // 잠금으로 실패하면 핸들을 닫고 재시도(L2597-02)
    const ins = db.prepare('INSERT INTO samples (metric, k, v, ts) VALUES (?, ?, ?, ?)');
    // v2.675(운영 멈춤 후보 — 합성 3,168만 행 실측): 키별 최신값 시드는 **인덱스를 건너뛰며** 키를 찾는다(loose index scan).
    //   예전 `JOIN (SELECT k, MAX(ts) … GROUP BY k)` 는 그 지표의 원본 전부(분 단위 × 보존 5년)를 훑어 14.7초 동안 포탈을 멈췄다
    //   (/insights/anomalies 첫 요청 — stallwatch 스택 latestAllCached ← detectAnomalies). 이 형태는 키 수 × 인덱스 탐색 2회라 11ms 다.
    //   ⚠ GROUP BY + MAX 로 되돌리지 말 것 — 행 수에 비례한다(키 수가 아니라).
    const latestAll = db.prepare(`WITH RECURSIVE ks(k) AS (
        SELECT (SELECT MIN(k) FROM samples WHERE metric=?1)
        UNION ALL
        SELECT (SELECT MIN(k) FROM samples WHERE metric=?1 AND k>ks.k) FROM ks WHERE ks.k IS NOT NULL)
      SELECT ks.k AS k,
        (SELECT v FROM samples WHERE metric=?1 AND k=ks.k ORDER BY ts DESC LIMIT 1) AS v,
        (SELECT MAX(ts) FROM samples WHERE metric=?1 AND k=ks.k) AS ts
      FROM ks WHERE ks.k IS NOT NULL`);
    // 최신 limit개 버킷을 선택(ASC+LIMIT은 오래된 것부터 잘라 최근 데이터가 사라짐 — 현재
    // 호출부는 limit이 커서 미발현이나 idrac.history와 정책을 통일). DESC로 뽑아 JS에서 되돌린다.
    const bucket = db.prepare(`SELECT CAST(ts/? AS INTEGER)*? AS b, AVG(v) avg, MIN(v) min, MAX(v) max FROM samples
      WHERE metric=? AND k=? AND ts>=? GROUP BY b ORDER BY b DESC LIMIT ?`);
    const recentAvgAll = db.prepare(`SELECT k, AVG(v) avg, MAX(v) max FROM samples WHERE metric=? AND ts>=? GROUP BY k`);
    const metaStmt = db.prepare('SELECT MIN(ts) AS mn, MAX(ts) AS mx, COUNT(*) AS n FROM samples WHERE metric=?');
    const dumpStmt = db.prepare('SELECT k, v, ts FROM samples WHERE metric=? AND ts>=? AND ts<=? ORDER BY ts, k LIMIT ?');
    // ⚠ 청크 DELETE (v2.453). 한 방 `DELETE ... WHERE ts < ?` 는 삭제 대상이 수억 행이면
    // 프로세스 전체를 수 분 이상 멈춘다(v2.451 에서 실제 장애 — accept 큐가 차서 웹 타임아웃).
    // rowid 서브쿼리 + LIMIT 으로 끊고 청크 사이에 이벤트 루프를 양보한다(util/chunkedPrune.js).
    const prune = db.prepare('DELETE FROM samples WHERE rowid IN (SELECT rowid FROM samples WHERE ts < ? LIMIT ?)');
    const HOUR = 3600_000;
    const insHour = db.prepare(`INSERT INTO samples_hourly (metric, k, h, n, sum, mn, mx) VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(metric, k, h) DO UPDATE SET n=n+1, sum=sum+excluded.sum, mn=MIN(mn, excluded.mn), mx=MAX(mx, excluded.mx)`);
    const bucketHourly = db.prepare(`SELECT CAST(h/? AS INTEGER)*? AS b, SUM(sum)/SUM(n) AS avg, MIN(mn) AS min, MAX(mx) AS max
      FROM samples_hourly WHERE metric=? AND k=? AND h>=? GROUP BY b ORDER BY b DESC LIMIT ?`);
    const hourlyMin = db.prepare('SELECT MIN(h) AS mn FROM samples_hourly WHERE metric=? AND k=?');
    // v2.663: 한 지표의 전 키 요약(시간당 롤업 — 생략분까지 정확). 서버 표·조건 검색이 한 번에 읽는다(서버마다 조회하지 않게).
    const statsHourlyAll = db.prepare(`SELECT k, SUM(sum)/SUM(n) AS avg, MIN(mn) AS min, MAX(mx) AS max, SUM(n) AS n
      FROM samples_hourly WHERE metric=? AND h>=? GROUP BY k`);
    // 키 하나의 첫/마지막 관측 시각(v2.504). **COUNT 를 넣지 않는다** — `meta(metric)` 의 COUNT(*) 는
    // 그 metric 파티션 전체를 훑는다(감사 P2 #11). MIN/MAX 만이면 PK/인덱스 양끝 seek 로 끝난다.
    // 용도: '수집 시작 이전' 을 화면이 소급 표시하지 않게 하는 기준선(v2.351 '+2만 TB' 오표시 교훈).
    const keyMinMax = db.prepare('SELECT MIN(ts) AS mn, MAX(ts) AS mx FROM samples WHERE metric=? AND k=?');
    // v2.600 DB2600-02: history() 의 롤업 선택용 — 원본의 첫 표본. aggregate 하나라 인덱스 끝점 탐색이다(v2.550.3).
    const rawMin = db.prepare('SELECT MIN(ts) AS mn FROM samples WHERE metric=? AND k=?');
    const keyHourMinMax = db.prepare('SELECT MIN(h) AS mn, MAX(h) AS mx FROM samples_hourly WHERE metric=? AND k=?');
    const pruneHourly = db.prepare('DELETE FROM samples_hourly WHERE rowid IN (SELECT rowid FROM samples_hourly WHERE h < ? LIMIT ?)');
    // ⚠ 키별 상한을 **SQL 에서** 적용한다(2026-08-13 감사 '성능 잔여 A'). 과거에는 창 전체를
    //   전량 읽어 JS 에서 arr.slice(-limitPerKey) 로 잘랐다 — 창이 클램프(최대 7일)돼도
    //   1분 버킷이면 키당 10,080 버킷 × 키 수천 개의 행 객체를 모두 할당한 뒤 대부분 버렸다.
    //   ROW_NUMBER() 로 키별 최근 N 버킷만 가져오면 결과는 동일하고(JS 후절단과 동등함을 실측
    //   확인) 할당이 상한 이내로 유계된다. limitPerKey 가 없으면 상한 없이 전량(기존 동작).
    const bucketAll = db.prepare(`SELECT k, CAST(ts/? AS INTEGER)*? AS b, AVG(v) avg, MIN(v) min, MAX(v) max FROM samples
      WHERE metric=? AND ts>=? GROUP BY k, b ORDER BY k, b`);
    const bucketAllTop = db.prepare(`SELECT k, b, avg, min, max FROM (
        SELECT k, CAST(ts/? AS INTEGER)*? AS b, AVG(v) avg, MIN(v) min, MAX(v) max,
               ROW_NUMBER() OVER (PARTITION BY k ORDER BY CAST(ts/? AS INTEGER) DESC) rn
        FROM samples WHERE metric=? AND ts>=? GROUP BY k, b
      ) WHERE rn <= ? ORDER BY k, b`);
    // latestAll 인메모리 캐시 — 원본은 (k, MAX(ts)) 풀 인덱스 스캔이라 보존기간이 길수록
    // 비싸진다(iDRAC 전력 withLatestCache 와 같은 문제·같은 처방). 최초 호출에 1회 시드 후
    // 쓰기 경로에서 O(1) 갱신. 캐시 갱신은 반드시 '커밋 성공 후'(실패분 유령 데이터 방지).
    const latestCache = new Map(); // metric -> Map<k, {v, ts}>
    // v2.620(SRV2620-02): dead-band 계열의 짧은 창 조회용 — 창 시작 직전 마지막 **저장** 행(이월 값)과 창 안 원본.
    //   bare column(v, ts) + MAX(ts) 는 SQLite 가 MAX 행의 값을 준다. 하한(ts>=?)으로 idx_samples_mt 범위를 탄다.
    const carryAll = db.prepare('SELECT k, v, MAX(ts) AS ts FROM samples WHERE metric=? AND ts<? AND ts>=? GROUP BY k');
    const rawAll = db.prepare('SELECT k, v, ts FROM samples WHERE metric=? AND ts>=? ORDER BY k, ts');
    const carryOne = db.prepare('SELECT v, MAX(ts) AS ts FROM samples WHERE metric=? AND k=? AND ts<? AND ts>=?');
    const rawOne = db.prepare('SELECT v, ts FROM samples WHERE metric=? AND k=? AND ts>=? ORDER BY ts');
    // v2.660: 끝이 있는 기간 조회(iDRAC 통합 추이의 '기간 지정'). history() 는 '지금까지' 만 받아 과거 구간을 보려면
    //   지금까지 전부 읽어야 했다. 버킷 수는 호출부가 제한한다(≈400).
    const bucketRange = db.prepare(`SELECT CAST(ts/? AS INTEGER)*? AS b, AVG(v) avg, MIN(v) min, MAX(v) max FROM samples
      WHERE metric=? AND k=? AND ts>=? AND ts<? GROUP BY b ORDER BY b`);
    const bucketHourlyRange = db.prepare(`SELECT CAST(h/? AS INTEGER)*? AS b, SUM(sum)/SUM(n) AS avg, MIN(mn) AS min, MAX(mx) AS max
      FROM samples_hourly WHERE metric=? AND k=? AND h>=? AND h<? GROUP BY b ORDER BY b`);
    const rawRange = db.prepare('SELECT v, ts FROM samples WHERE metric=? AND k=? AND ts>=? AND ts<? ORDER BY ts');
    // v2.675(운영 멈춤 후보 — 합성 3,168만 행 실측): historyAllSliced 의 한 조각([lo, hi)). 한 문장으로 24시간 × 키 1,100 을
    //   집계하면 1.9초 동안 포탈이 멈췄다(/insights/anomalies 60초마다). 조각은 최장 44ms 이고 합계도 929ms 로 줄었다.
    const bucketAllRange = db.prepare(`SELECT k, CAST(ts/? AS INTEGER)*? AS b, AVG(v) avg, MIN(v) min, MAX(v) max FROM samples
      WHERE metric=? AND ts>=? AND ts<? GROUP BY k, b`);
    // v2.675: meta() 의 COUNT(*) 는 그 지표의 원본 전부를 훑는다(2.3초 — v2.550.3 'aggregate 를 한 쿼리에 여럿 두지 말 것').
    //   기간은 단독 집계(인덱스 끝점 0.1ms), 개수는 조각으로 나눠 세는 countAsync 가 맡는다.
    const firstTsStmt = db.prepare('SELECT MIN(ts) AS mn FROM samples WHERE metric=?');
    const lastTsStmt = db.prepare('SELECT MAX(ts) AS mx FROM samples WHERE metric=?');
    const countRange = db.prepare('SELECT COUNT(*) AS n FROM samples WHERE metric=? AND ts>=? AND ts<?');
    // v2.675: keysOf 의 DISTINCT 도 원본 전부를 훑었다(1.7초) — 키를 인덱스로 건너뛴다(원본·롤업 각각, loose index scan).
    const rawKeysStmt = db.prepare(`WITH RECURSIVE ks(k) AS (
        SELECT (SELECT MIN(k) FROM samples WHERE metric=?1)
        UNION ALL SELECT (SELECT MIN(k) FROM samples WHERE metric=?1 AND k>ks.k) FROM ks WHERE ks.k IS NOT NULL)
      SELECT k FROM ks WHERE k IS NOT NULL`);
    const hourlyKeysStmt = db.prepare(`WITH RECURSIVE ks(k) AS (
        SELECT (SELECT MIN(k) FROM samples_hourly WHERE metric=?1)
        UNION ALL SELECT (SELECT MIN(k) FROM samples_hourly WHERE metric=?1 AND k>ks.k) FROM ks WHERE ks.k IS NOT NULL)
      SELECT k FROM ks WHERE k IS NOT NULL`);
    const metricsStmt = db.prepare(`WITH RECURSIVE ms(m) AS (
        SELECT (SELECT MIN(metric) FROM samples)
        UNION ALL SELECT (SELECT MIN(metric) FROM samples WHERE metric>ms.m) FROM ms WHERE ms.m IS NOT NULL)
      SELECT m FROM ms WHERE m IS NOT NULL`);
    // v2.675 롤업 백필 — 롤업 도입(v2.252) 이전 원본을 시간당 롤업으로 옮긴다(history() 의 원본 폴백을 없애는 근본 해법, v2.672 남은 일).
    const rawMaxBefore = db.prepare('SELECT MAX(ts) AS t FROM samples WHERE metric=? AND k=? AND ts<?');
    const rawHourAgg = db.prepare(`SELECT CAST(ts/3600000 AS INTEGER)*3600000 AS h, COUNT(*) AS n, SUM(v) AS s, MIN(v) AS mn, MAX(v) AS mx
      FROM samples WHERE metric=? AND k=? AND ts>=? AND ts<? GROUP BY h`);
    const insHourIgnore = db.prepare('INSERT OR IGNORE INTO samples_hourly (metric, k, h, n, sum, mn, mx) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const metaGet = db.prepare('SELECT v FROM samples_meta WHERE key=?');
    const metaSet = db.prepare('INSERT INTO samples_meta (key, v) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET v=excluded.v');
    // dead-band 상태(v2.451): `${metric} ${k}` -> 마지막으로 **원본에 저장한** 샘플.
    // 프로세스 메모리에만 둔다 — 재시작하면 각 계열의 첫 샘플이 한 번 더 저장될 뿐이라 안전하다.
    // 크기는 (계열 x 키) 로 유계(호스트 658 + 클러스터/vCenter 집계 수준).
    const lastKept = new Map();
    const deadbandPolicy = policyFromEnv();
    let _skippedTotal = 0;
    const latestAllCached = (metric) => {  // v2.620: 내부용(복사 없음) — 공개 latestAll 은 사본을 준다
      let c = latestCache.get(metric);
      if (!c) {
        c = new Map();
        for (const r of latestAll.all(metric)) if (r.ts != null) c.set(r.k, { v: r.v, ts: r.ts });
        latestCache.set(metric, c);
      }
      return c;
    };
    // v2.620(SRV2620-02): dead-band 계열의 '실제 마지막 샘플'(저장 생략분 포함). latestCache 는 누가 latestAll 을 부르기 전에는
    //   시드되지 않고, 시드는 **저장 행**만 보므로 생략 구간의 최신 시각을 모른다 — 적재 경로에서 직접 기록한다(키 수로 유계).
    const lastSeen = new Map();
    const latestOf = (metric, k) => lastSeen.get(`${metric} ${k}`) || latestCache.get(metric)?.get(k) || null;
    const implHistory = (metric, k, sinceTs, bucketMs, limit) => {
      // 60분+ 정배수 버킷이고 롤업이 요청 창을 덮으면 시간당 롤업에서 집계(원본 스캔 제거).
      // 업그레이드 이전 데이터(롤업 없음)가 창에 걸리면 원본으로 폴백해 빈 결과를 만들지 않는다.
      if (bucketMs >= HOUR && bucketMs % HOUR === 0) {
        // v2.600 DB2600-02: '롤업이 sinceTs 를 덮을 때만' 이면, 원본 보존(기본 90일)이 롤업 보존(5년)보다 짧을 때
        // 데이터 나이보다 긴 창(365일)이 원본으로 떨어져 **긴 창이 더 적게**(90일) 보였다. 롤업이 원본만큼
        // 거슬러 올라가면(롤업 첫 시간 ≤ 원본 첫 표본) 롤업을 쓴다. 원본이 더 이르면(업그레이드 이전) 원본 폴백.
        const mn = hourlyMin.get(metric, k)?.mn;
        const rawFirst = mn != null && mn > sinceTs ? rawMin.get(metric, k)?.mn : null;
        if (mn != null && (mn <= sinceTs || rawFirst == null || mn <= rawFirst)) {
          return bucketHourly.all(bucketMs, bucketMs, metric, k, sinceTs, limit).reverse()
            .map((r) => ({ ts: r.b, avg: round1(r.avg), min: round1(r.min), max: round1(r.max) }));
        }
      }
      return bucket.all(bucketMs, bucketMs, metric, k, sinceTs, limit).reverse().map((r) => ({ ts: r.b, avg: round1(r.avg), min: round1(r.min), max: round1(r.max) }));
    };
    const implRecentAvg = (metric, sinceTs) => { const map = new Map(); for (const r of recentAvgAll.all(metric, sinceTs)) map.set(r.k, { avg: round1(r.avg), max: round1(r.max) }); return map; };
    const deadbandPolicyOf = (metric) => { const pk = policyKeyFor(metric); const p = pk ? deadbandPolicy[pk] : null; return p && p.eps > 0 ? p : null; };
    return {
      kind: 'sqlite',
      insertMany: (rows, ts) => {
        // v2.451 — **변화분만 원본에 저장**(dead-band). 온도처럼 값이 거의 그대로인 계열이
        // 1분마다 전량 적재되며 host-temp.db 가 34.3GB 까지 자랐다(운영 실측).
        // 롤업(samples_hourly)은 **생략분까지 전부** 갱신하므로 시간당 평균·최소·최대는 정확하다.
        // latestCache(최신값)도 생략분으로 갱신한다 — 화면의 '현재 온도' 는 저장 여부와 무관하다.
        const { store, skipped } = splitByDeadband(rows, ts, lastKept, deadbandPolicy);
        _skippedTotal += skipped;
        db.exec('BEGIN');
        try {
          const h = Math.floor(ts / HOUR) * HOUR;
          for (const r of store) ins.run(r.metric, r.k, r.v, ts);
          for (const r of rows) insHour.run(r.metric, r.k, h, r.v, r.v, r.v);  // 롤업은 전량
          db.exec('COMMIT');
        } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; }
        for (const r of rows) {
          if (policyKeyFor(r.metric)) { const sk = `${r.metric} ${r.k}`; const cur = lastSeen.get(sk); if (!cur || ts >= cur.ts) lastSeen.set(sk, { v: r.v, ts }); }
          const c = latestCache.get(r.metric);
          if (c) { const cur = c.get(r.k); if (!cur || ts >= cur.ts) c.set(r.k, { v: r.v, ts }); }
        }
      },
      /** 진단용 — dead-band 로 생략한 누적 행 수(설정 화면·로그에서 효과 확인). */
      deadbandSkipped: () => _skippedTotal,
      latestAll: (metric) => new Map(latestAllCached(metric)), // 기존 계약(매 호출 새 Map) 유지 — 호출부 변형이 캐시를 오염시키지 않게
      history: implHistory,
      /**
       * v2.672(운영 장애 — 이벤트 루프 64~70초 정지 반복): 시간당 롤업**만** 읽는 장기 버킷 조회. 원본(samples)으로 절대 떨어지지 않는다.
       * history() 는 원본이 롤업보다 오래됐으면(롤업 도입 이전 데이터) 원본으로 폴백한다(v2.600 DB2600-02 — 한 계열 차트용 판단).
       * 그런데 원본 보존 기본은 롤업과 같은 5년(rawRetentionDays 0)이고 ds_usedgb 는 변화분 저장 대상이 아니라 분마다 쌓인다 —
       * 키 하나에 120일이면 원본 17만 행이고, 그것을 키 수천 개 루프에서 돌면 포탈 전체가 수 분씩 멈춘다(capacity-forecast 실사고).
       * **여러 키를 도는 루프는 이것을 쓴다.** 대가: 롤업 도입 이전 구간은 결과에 없다(첫 점 시각으로 밝힌다).
       * bucketMs 는 1시간 정배수로 맞춘다(최소 1시간) — 롤업보다 잘게 나눌 수 없다.
       */
      historyRollup: (metric, k, sinceTs, bucketMs, limit) => {
        const b = Math.max(HOUR, Math.round((Number(bucketMs) || HOUR) / HOUR) * HOUR);
        return bucketHourly.all(b, b, metric, k, sinceTs, limit).reverse()
          .map((r) => ({ ts: r.b, avg: round1(r.avg), min: round1(r.min), max: round1(r.max) }));
      },
      /**
       * v2.660: [startTs, endTs) 버킷 조회(오름차순). 규칙은 history()·historyStep() 과 같다 —
       * 1시간 정배수 버킷은 롤업(롤업이 원본만큼 거슬러 올라갈 때), 짧은 버킷의 dead-band 계열은 step 채움.
       * 끝이 과거면 그 뒤의 실제 샘플로 선을 잇지 않는다(lastActualTs 는 창 안에서만 쓴다).
       */
      historyRange: (metric, k, startTs, endTs, bucketMs) => {
        const mapRow = (r) => ({ ts: r.b, avg: round1(r.avg), min: round1(r.min), max: round1(r.max) });
        if (bucketMs >= HOUR && bucketMs % HOUR === 0) {
          const mn = hourlyMin.get(metric, k)?.mn;
          const rawFirst = mn != null && mn > startTs ? rawMin.get(metric, k)?.mn : null;
          if (mn != null && (mn <= startTs || rawFirst == null || mn <= rawFirst)) {
            return bucketHourlyRange.all(bucketMs, bucketMs, metric, k, startTs, endTs).map(mapRow);
          }
        }
        const p = deadbandPolicyOf(metric);
        if (p && bucketMs < HOUR) {
          const c = carryOne.get(metric, k, startTs, startTs - p.maxGapMs - STEP_SLACK_MS);
          const carry = c && c.ts != null ? { v: c.v, ts: c.ts } : null;
          const rows = rawRange.all(metric, k, startTs, endTs).map((r) => ({ v: r.v, ts: r.ts }));
          const last = latestOf(metric, k)?.ts ?? null;
          const lastActualTs = last != null && last < endTs ? last : null;
          return stepBuckets({ carry, rows, start: startTs, nowTs: endTs - 1, bucketMs, maxGapMs: p.maxGapMs, lastActualTs }).points;
        }
        return bucketRange.all(bucketMs, bucketMs, metric, k, startTs, endTs).map(mapRow);
      },
      /**
       * v2.620(SRV2620-02): dead-band 를 아는 짧은 버킷 조회. 온도 계열은 0.5℃ 미만 변화면 원본을 건너뛰므로
       * (최대 간격 maxGapMs — 기본 30분) 1시간 미만 버킷을 원본에서 그대로 집계하면 안정 구간이 **점 없음**이 된다.
       * 창 직전 마지막 저장 행을 이월하고 빈 버킷을 직전 값으로 채운다(step). 채운 점은 `carried:true`.
       * 60분 이상 버킷·dead-band 가 없는 계열은 history() 와 같다(롤업이 생략분까지 전량 갖고 있다).
       * @returns {{points:object[], carried:number, stepped:boolean, maxGapMs:number|null}}
       */
      historyStep: (metric, k, sinceTs, bucketMs, limit, opts = {}) => {
        const p = deadbandPolicyOf(metric);
        // v2.621(감사 RECENT-02 — 재현: 1주·분 버킷 → 3.47일만): 상한(limit)에 걸려 요청 기간의 앞부분을 못 덮으면
        //   **잘렸다고 밝힌다**(truncated·coveredSince). 예전엔 days:7 을 그대로 되돌려 조용히 짧은 기간을 그렸다.
        const sinceB = Math.floor(sinceTs / bucketMs) * bucketMs;
        if (!p || bucketMs >= HOUR) {
          const points = implHistory(metric, k, sinceTs, bucketMs, limit);
          return { points, carried: 0, stepped: false, maxGapMs: p ? p.maxGapMs : null, ...historyCut(points, limit, sinceB) };
        }
        const nowTs = Number.isFinite(opts.nowTs) ? opts.nowTs : Date.now();
        const start = Math.max(sinceB, Math.floor(nowTs / bucketMs) * bucketMs - (Math.max(1, limit) - 1) * bucketMs);
        const c = carryOne.get(metric, k, start, start - p.maxGapMs - STEP_SLACK_MS);
        const carry = c && c.ts != null ? { v: c.v, ts: c.ts } : null;
        const rows = rawOne.all(metric, k, start).map((r) => ({ v: r.v, ts: r.ts }));
        const lastActualTs = latestOf(metric, k)?.ts ?? null;
        // step 채움은 빈 버킷도 점이 되므로 '상한 = 덮는 버킷 수' 다 — 시작이 요청 시작보다 뒤면 잘린 것이다.
        const cut = start > sinceB ? { truncated: true, coveredSince: start, requestedSince: sinceB } : { truncated: false, coveredSince: null, requestedSince: sinceB };
        return { ...stepBuckets({ carry, rows, start, nowTs, bucketMs, maxGapMs: p.maxGapMs, lastActualTs, slackMs: Number.isFinite(opts.slackMs) ? opts.slackMs : STEP_SLACK_MS, limit }), stepped: true, maxGapMs: p.maxGapMs, ...cut };
      },
      /**
       * v2.620(SRV2620-02): dead-band 를 아는 짧은 창 평균. recentAvg() 는 창 안 **저장** 행만 평균하므로 온도가 안정된
       * 호스트는 창 안 행이 0 이라 빠지고('—'), 흔들리는 호스트는 '변한 표본만의 평균' 이 됐다. 창 직전 저장 행을 이월해
       * **시간 가중 step 평균**을 낸다. 창 안에 실제 샘플(최신값 캐시 기준)이 없는 키는 내지 않는다(죽은 호스트를 되살리지 않는다).
       * 값: Map<k, {avg, max, carried}> — carried 는 이월 값을 썼는지.
       */
      recentAvgStep: (metric, sinceTs, opts = {}) => {
        const p = deadbandPolicyOf(metric);
        if (!p) { const m = new Map(); for (const [k, a] of implRecentAvg(metric, sinceTs)) m.set(k, { ...a, carried: false }); return m; }
        const nowTs = Number.isFinite(opts.nowTs) ? opts.nowTs : Date.now();
        const carries = new Map();
        for (const r of carryAll.all(metric, sinceTs, sinceTs - p.maxGapMs - STEP_SLACK_MS)) carries.set(r.k, { v: r.v, ts: r.ts });
        const inWin = new Map();
        for (const r of rawAll.all(metric, sinceTs)) { let a = inWin.get(r.k); if (!a) { a = []; inWin.set(r.k, a); } a.push({ v: r.v, ts: r.ts }); }
        const out = new Map();
        const keys = new Set([...carries.keys(), ...inWin.keys()]);
        for (const k of keys) {
          const last = latestOf(metric, k);
          const r = stepWindowAvg({ carry: carries.get(k) || null, rows: inWin.get(k) || [], sinceTs, nowTs, last });
          if (r) out.set(k, r);
        }
        return out;
      },
      // 패밀리 전 키 일괄 버킷 — 이상탐지의 키별 N+1(키 수천 × 쿼리 1회)을 쿼리 1회로 대체.
      historyAll: (metric, sinceTs, bucketMs, limitPerKey) => {
        const out = new Map();
        // 상한이 있으면 SQL 에서 키별 최근 N 버킷만 — 윈도 함수 미지원 등 실패 시 전량 경로로 폴백
        // (정확도가 같으므로 결과는 동일하고, 폴백은 예전과 같은 비용).
        let rows = null;
        if (limitPerKey > 0) {
          try { rows = bucketAllTop.all(bucketMs, bucketMs, bucketMs, metric, sinceTs, limitPerKey); }
          catch { rows = null; }
        }
        if (!rows) rows = bucketAll.all(bucketMs, bucketMs, metric, sinceTs);
        for (const r of rows) {
          let arr = out.get(r.k);
          if (!arr) { arr = []; out.set(r.k, arr); }
          arr.push({ ts: r.b, avg: round1(r.avg), min: round1(r.min), max: round1(r.max) });
        }
        // 폴백 경로(또는 상한 초과 잔여)를 위해 JS 절단도 유지 — SQL 절단이 성공했으면 무동작.
        if (limitPerKey) for (const [k, arr] of out) if (arr.length > limitPerKey) out.set(k, arr.slice(-limitPerKey));
        return out;
      },
      /**
       * v2.675: historyAll 의 조각판(비동기 — 이상 탐지용). 결과는 historyAll 과 같다(테스트가 대조): 키별 [since, ∞) 의
       * 최근 limitPerKey 개 버킷, 오름차순. [since, ∞) 를 **버킷 경계에 맞춘 약 1시간 조각**으로 나눠 최근 조각부터 집계하고
       * 조각 사이에 양보한다 — 버킷이 조각 경계를 걸치지 않으므로 집계가 정확하다. 맨 위 조각은 위가 열려 있다(시계가 앞선 표본).
       * 키당 보관은 상한 + 한 조각분으로 묶인다(예전 ROW_NUMBER 와 같은 메모리 상한 — 1분 버킷 7일 × 키 수천에서도).
       */
      historyAllSliced: async (metric, sinceTs, bucketMs, limitPerKey, opts = {}) => {
        const B = Math.max(1, Math.round(Number(bucketMs) || 60_000));
        const sliceMs = B * Math.max(1, Math.round(HOUR / B));
        const nowTs = Number.isFinite(opts.nowTs) ? opts.nowTs : Date.now();
        const maybeYield = typeof opts.maybeYield === 'function' ? opts.maybeYield : createYielder(15);
        const cap = limitPerKey > 0 ? limitPerKey : Infinity;
        const acc = new Map();
        let hi = 8.64e15; // 위가 열린 첫 조각(Date 상한)
        let lo = Math.floor(nowTs / sliceMs) * sliceMs;
        for (;;) {
          const lower = Math.max(sinceTs, lo);
          if (lower < hi) {
            // 이 조각 전에 이미 상한만큼 찬 키는 더 오래된 버킷이 필요 없다(최근부터 모은다).
            const rows = bucketAllRange.all(B, B, metric, lower, hi);
            const full = new Set();
            for (const [k, arr] of acc) if (arr.length >= cap) full.add(k);
            for (const r of rows) {
              if (full.has(r.k)) continue;
              let arr = acc.get(r.k);
              if (!arr) { arr = []; acc.set(r.k, arr); }
              arr.push(r);
            }
          }
          if (lower <= sinceTs) break;
          hi = lower; lo -= sliceMs;
          await maybeYield();
        }
        const out = new Map();
        // 키 순서는 historyAll(ORDER BY k)과 맞춘다 — 조각마다 처음 본 순서로 두면 호출마다 순서가 흔들린다.
        for (const k of [...acc.keys()].sort()) {
          const arr = acc.get(k);
          arr.sort((a, b) => a.b - b.b);
          const kept = arr.length > cap ? arr.slice(-cap) : arr;
          out.set(k, kept.map((r) => ({ ts: r.b, avg: round1(r.avg), min: round1(r.min), max: round1(r.max) })));
          // 마지막 조립(키 1,100 × 버킷 144 = 약 16만 개 · round1)도 한 덩어리면 약 200ms 다(합성 실측) — 키 사이에도 양보한다.
          await maybeYield();
        }
        return out;
      },
      /** v2.675: 지표의 첫/마지막 관측 시각만(단독 집계 둘 — 인덱스 끝점). meta() 의 COUNT 없이 기간이 필요한 곳용. */
      metaRange: (metric) => ({ firstTs: firstTsStmt.get(metric)?.mn ?? null, lastTs: lastTsStmt.get(metric)?.mx ?? null }),
      /**
       * v2.675: 지표의 원본 행 수를 시간 조각(기본 6시간)으로 나눠 센다(비동기 — 조각 사이 양보). 한 번에 세면 지표 원본 전부를
       * 동기로 훑는다(합성 3,168만 행 2.3초). 세는 동안 들어온 행은 들어갈 수도 빠질 수도 있다(표시용 근사).
       */
      countAsync: async (metric, opts = {}) => {
        const mn = firstTsStmt.get(metric)?.mn;
        const mx = lastTsStmt.get(metric)?.mx;
        if (mn == null || mx == null) return 0;
        const step = Number.isFinite(opts.sliceMs) && opts.sliceMs > 0 ? opts.sliceMs : 6 * HOUR;
        const maybeYield = typeof opts.maybeYield === 'function' ? opts.maybeYield : createYielder(15);
        let n = 0;
        for (let lo = mn; lo <= mx; lo += step) {
          n += Number(countRange.get(metric, lo, lo + step)?.n || 0);
          await maybeYield();
        }
        return n;
      },
      /** v2.675 롤업 백필 — 원본이 있는 지표 목록(인덱스로 건너뛰며 찾는다). */
      rollupBackfillMetrics: () => metricsStmt.all().map((r) => r.m),
      /** v2.675 롤업 백필 — 그 지표의 원본 키 목록(인덱스로 건너뛰며 찾는다). */
      rollupBackfillKeys: (metric) => rawKeysStmt.all(metric).map((r) => r.k),
      /**
       * v2.675 롤업 백필 한 걸음: 키 하나의 '롤업 첫 시각보다 이른 원본' 을 **최근 쪽부터** chunkHours 만큼 시간당으로 묶어
       * 롤업에 넣는다(INSERT OR IGNORE — 있는 시간은 건드리지 않는다. 롤업은 MIN(h) 이전에 행이 없으므로 겹치지 않는다).
       * ⚠ 최근 쪽부터 가는 이유: 중간에 멈추면 롤업의 첫 시각(MIN(h))이 '여기까지 채웠다' 는 표지가 된다. 오래된 쪽부터 가면
       *   멈춘 뒤 가운데 구간이 영영 빈다(다음 실행은 MIN(h) 이전만 본다). 그래서 진행 상태를 따로 저장하지 않아도 이어진다.
       * 롤업 도입(v2.252) 이전 원본은 dead-band(v2.451) 이전이라 전량 원본이다 — 시간당 n·합·최소·최대가 정확하다.
       * @param {{minTs?:number, chunkHours?:number, capTs?:number}} opts minTs: 이보다 오래된 원본은 옮기지 않는다(롤업 보존 밖).
       *   capTs: 롤업이 아예 없는 키의 상한(실행 시작 시각의 정시 — 적재 경로가 그 뒤 시간을 쓴다).
       * @returns {{done:boolean, rows:number, hours:number}}
       */
      rollupBackfillStep: (metric, k, opts = {}) => {
        const minTs = Number.isFinite(opts.minTs) ? opts.minTs : 0;
        const chunkHours = Math.max(1, Math.round(Number(opts.chunkHours) || 24));
        const first = hourlyMin.get(metric, k)?.mn;
        const boundary = first != null ? first : (Number.isFinite(opts.capTs) ? opts.capTs : Math.floor(Date.now() / HOUR) * HOUR);
        const prev = rawMaxBefore.get(metric, k, boundary)?.t;
        if (prev == null || prev < minTs) return { done: true, rows: 0, hours: 0 };
        const hi = Math.min(boundary, Math.floor(prev / HOUR) * HOUR + HOUR);
        const lo = Math.max(Math.floor(minTs / HOUR) * HOUR, hi - chunkHours * HOUR);
        const agg = rawHourAgg.all(metric, k, lo, hi);
        let rows = 0, hours = 0;
        db.exec('BEGIN');
        try {
          for (const a of agg) { rows += Number(a.n); hours += Number(insHourIgnore.run(metric, k, a.h, a.n, a.s, a.mn, a.mx).changes || 0); }
          db.exec('COMMIT');
        } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; }
        return { done: false, rows, hours };
      },
      /** v2.675: 작은 상태 표(samples_meta) 읽기/쓰기 — 롤업 백필 완료 표지. 값은 JSON. */
      metaValue: (key) => { const r = metaGet.get(String(key)); if (!r) return null; try { return JSON.parse(r.v); } catch { return null; } },
      setMetaValue: (key, value) => { metaSet.run(String(key), JSON.stringify(value)); },
      recentAvg: implRecentAvg,
      meta: (metric) => { const r = metaStmt.get(metric); return { firstTs: r?.mn ?? null, lastTs: r?.mx ?? null, count: Number(r?.n || 0) }; },
      /**
       * 키 하나의 첫/마지막 관측 시각(v2.504). 원본이 prune 으로 잘려 나가도 롤업에 남아 있을 수
       * 있으므로 **둘 중 더 이른 첫 관측·더 늦은 마지막 관측**을 돌려준다. 건수는 세지 않는다
       * (파티션 풀스캔을 유발한다 — `meta()` 주석 참조).
       */
      /** 그 지표에 계열이 있는 키 집합(v2.661 — iDRAC 통합 추이 'GPU 서버만'). PK 선행열(metric,k) 인덱스로 읽는다. */
      /** v2.663: sinceTs 가 속한 시간부터의 키별 {avg,min,max,n}(시간당 롤업 기준 — 창 앞쪽으로 최대 1시간 넓다). */
      statsSinceAll: (metric, sinceTs) => {
        const m = new Map();
        for (const r of statsHourlyAll.all(metric, Math.floor(sinceTs / HOUR) * HOUR)) m.set(r.k, { avg: round1(r.avg), min: round1(r.min), max: round1(r.max), n: r.n });
        return m;
      },
      keysOf: (metric) => {
        // v2.675: DISTINCT 는 원본 전부를 훑었다(합성 3,168만 행 1.7초) — 키를 인덱스로 건너뛴다(키 수 × 인덱스 탐색).
        const out = new Set();
        try { for (const r of hourlyKeysStmt.all(metric)) out.add(r.k); } catch { /* 구버전 */ }
        try { for (const r of rawKeysStmt.all(metric)) out.add(r.k); } catch { /* */ }
        return out;
      },
      metaKey: (metric, k) => {
        const a = keyMinMax.get(metric, k) || {};
        let b = {};
        try { b = keyHourMinMax.get(metric, k) || {}; } catch { /* 롤업 테이블이 없는 구버전 */ }
        const mins = [a.mn, b.mn].filter((x) => x != null);
        const maxs = [a.mx, b.mx].filter((x) => x != null);
        return { firstTs: mins.length ? Math.min(...mins) : null, lastTs: maxs.length ? Math.max(...maxs) : null };
      },
      dump: (metric, sinceTs, untilTs, limit) => dumpStmt.all(metric, sinceTs, untilTs, limit).map((r) => ({ k: r.k, v: r.v, ts: r.ts })),
      /**
       * @param beforeTs        이 시각 이전의 **원본**을 지운다.
       * @param rollupBeforeTs  이 시각 이전의 **롤업**을 지운다(생략 시 원본과 같은 기준 — 기존 동작).
       *
       * v2.451: 원본과 롤업의 보존기간을 분리했다. 원본은 분 단위라 용량의 대부분을 차지하지만
       * 오래된 구간을 분 단위로 볼 일은 드물고, 60분+ 버킷 조회는 이미 롤업을 쓴다(위 history 참조).
       * 그래서 원본은 짧게(기본 90일), 롤업은 길게(기존 보존기간, 기본 5년) 둘 수 있다.
       */
      prune: async (beforeTs, rollupBeforeTs = null) => {
        // v2.453: 청크 + 이벤트 루프 양보. 상한에 걸리면 남은 것을 다음 주기가 이어서 지운다 —
        // 한 주기에 다 지우려다 포탈을 멈추지 않는다.
        const r = await chunkedDelete(prune, [beforeTs], { label: 'metrics.samples' });
        if (r.deleted > 0) console.log(`[metrics] 원본 prune ${r.deleted.toLocaleString()}행 삭제(${r.chunks}청크)${r.done ? '' : ' — 상한 도달, 다음 주기에 계속'}`);
        // 롤업도 정리한다(원본만 지우면 집계가 영원히 남는다). 경계의 부분 시간대(1시간 미만)는
        // 남겨 롤업이 원본보다 먼저 비는 일이 없게 한다. 실패해도 원본 prune 결과는 유지.
        const rb = (rollupBeforeTs == null ? beforeTs : rollupBeforeTs) - HOUR;
        try { await chunkedDelete(pruneHourly, [rb], { label: 'metrics.hourly' }); }
        catch (e) { console.warn(`[metrics] 롤업 prune 실패: ${e.message}`); }
        for (const c of latestCache.values()) {
          for (const [k, e] of c) if (e.ts < beforeTs) c.delete(k);
        }
        for (const [k, e] of lastSeen) if (e.ts < beforeTs) lastSeen.delete(k);
        return r.deleted;
      },
    };
  });
}

function initJson() {
  const file = DB_PATH.replace(/\.db$/, '') + '.ndjson';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let rows = [];
  try { for (const l of fs.readFileSync(file, 'utf8').split('\n')) { if (l.trim()) { const r = JSON.parse(l); rows.push(r); } } } catch { /* */ }
  return {
    kind: 'json',
    insertMany: (recs, ts) => { const lines = recs.map((r) => ({ m: r.metric, k: r.k, v: r.v, t: ts })); pushAll(rows, lines); try { fs.appendFileSync(file, lines.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); } catch { /* */ } },
    latestAll: (metric) => { const map = new Map(); for (const r of rows) if (r.m === metric) { const c = map.get(r.k); if (!c || r.t > c.ts) map.set(r.k, { v: r.v, ts: r.t }); } return map; },
    history: (metric, k, sinceTs, bucketMs, limit) => {
      const buckets = new Map();
      for (const r of rows) if (r.m === metric && r.k === k && r.t >= sinceTs) {
        const b = Math.floor(r.t / bucketMs) * bucketMs; const g = buckets.get(b) || { sum: 0, n: 0, min: Infinity, max: -Infinity };
        g.sum += r.v; g.n++; g.min = Math.min(g.min, r.v); g.max = Math.max(g.max, r.v); buckets.set(b, g);
      }
      return [...buckets.entries()].sort((a, b) => a[0] - b[0]).slice(-limit).map(([b, g]) => ({ ts: b, avg: round1(g.sum / g.n), min: round1(g.min), max: round1(g.max) }));
    },
    historyAll: (metric, sinceTs, bucketMs, limitPerKey) => {
      const perKey = new Map(); // k -> Map<b, agg>
      for (const r of rows) if (r.m === metric && r.t >= sinceTs) {
        let buckets = perKey.get(r.k);
        if (!buckets) { buckets = new Map(); perKey.set(r.k, buckets); }
        const b = Math.floor(r.t / bucketMs) * bucketMs;
        const g = buckets.get(b) || { sum: 0, n: 0, min: Infinity, max: -Infinity };
        g.sum += r.v; g.n++; g.min = Math.min(g.min, r.v); g.max = Math.max(g.max, r.v); buckets.set(b, g);
      }
      const out = new Map();
      for (const [k, buckets] of perKey) {
        const arr = [...buckets.entries()].sort((a, b) => a[0] - b[0])
          .map(([b, g]) => ({ ts: b, avg: round1(g.sum / g.n), min: round1(g.min), max: round1(g.max) }));
        out.set(k, limitPerKey && arr.length > limitPerKey ? arr.slice(-limitPerKey) : arr);
      }
      return out;
    },
    recentAvg: (metric, sinceTs) => {
      const agg = new Map();
      for (const r of rows) if (r.m === metric && r.t >= sinceTs) { const g = agg.get(r.k) || { sum: 0, n: 0, max: -Infinity }; g.sum += r.v; g.n++; g.max = Math.max(g.max, r.v); agg.set(r.k, g); }
      const map = new Map(); for (const [k, g] of agg) map.set(k, { avg: round1(g.sum / g.n), max: round1(g.max) }); return map;
    },
    meta: (metric) => { let mn = null, mx = null, n = 0; for (const r of rows) if (r.m === metric) { n++; if (mn == null || r.t < mn) mn = r.t; if (mx == null || r.t > mx) mx = r.t; } return { firstTs: mn, lastTs: mx, count: n }; },
    // v2.675: SQLite 판과 같은 API 만 맞춘다(NDJSON 은 개발용 소규모 — 조각·양보가 필요 없다).
    async historyAllSliced(metric, sinceTs, bucketMs, limitPerKey) { return this.historyAll(metric, sinceTs, bucketMs, limitPerKey); },
    metaRange(metric) { const m = this.meta(metric); return { firstTs: m.firstTs, lastTs: m.lastTs }; },
    async countAsync(metric) { return this.meta(metric).count; },
    // SQLite 구현과 같은 API(v2.504) — 호출부가 폴백 여부를 몰라도 되게 한다.
    // v2.620(SRV2620-02): NDJSON 폴백은 dead-band 를 쓰지 않아(전량 저장) step 조회가 곧 일반 조회다 — 같은 API 만 맞춘다.
    historyRange(metric, k, startTs, endTs, bucketMs) {
      const acc = new Map();
      for (const r of rows) if (r.m === metric && r.k === k && r.t >= startTs && r.t < endTs) {
        const b = Math.floor(r.t / bucketMs) * bucketMs;
        const g = acc.get(b) || { sum: 0, n: 0, min: Infinity, max: -Infinity };
        g.sum += r.v; g.n++; g.min = Math.min(g.min, r.v); g.max = Math.max(g.max, r.v); acc.set(b, g);
      }
      return [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([b, g]) => ({ ts: b, avg: round1(g.sum / g.n), min: round1(g.min), max: round1(g.max) }));
    },
    // v2.672: NDJSON 폴백에는 롤업이 없다(전량 원본 · 개발용 소규모) — 같은 API 만 맞춘다. 버킷은 SQLite 판과 같이 1시간 정배수.
    historyRollup(metric, k, sinceTs, bucketMs, limit) { return this.history(metric, k, sinceTs, Math.max(3_600_000, Math.round((Number(bucketMs) || 3_600_000) / 3_600_000) * 3_600_000), limit); },
    historyStep(metric, k, sinceTs, bucketMs, limit) { const points = this.history(metric, k, sinceTs, bucketMs, limit); return { points, carried: 0, stepped: false, maxGapMs: null, ...historyCut(points, limit, Math.floor(sinceTs / bucketMs) * bucketMs) }; },
    recentAvgStep(metric, sinceTs) { const m = new Map(); for (const [k, a] of this.recentAvg(metric, sinceTs)) m.set(k, { ...a, carried: false }); return m; },
    keysOf: (metric) => { const out = new Set(); for (const r of rows) if (r.m === metric) out.add(r.k); return out; },
    statsSinceAll: (metric, sinceTs) => {
      const since = Math.floor(sinceTs / 3_600_000) * 3_600_000; const agg = new Map();
      for (const r of rows) if (r.m === metric && r.t >= since) { const g = agg.get(r.k) || { sum: 0, n: 0, min: Infinity, max: -Infinity }; g.sum += r.v; g.n++; g.min = Math.min(g.min, r.v); g.max = Math.max(g.max, r.v); agg.set(r.k, g); }
      const m = new Map(); for (const [k, g] of agg) m.set(k, { avg: round1(g.sum / g.n), min: round1(g.min), max: round1(g.max), n: g.n }); return m;
    },
    metaKey: (metric, k) => { let mn = null, mx = null; for (const r of rows) if (r.m === metric && r.k === k) { if (mn == null || r.t < mn) mn = r.t; if (mx == null || r.t > mx) mx = r.t; } return { firstTs: mn, lastTs: mx }; },
    dump: (metric, sinceTs, untilTs, limit) => rows.filter((r) => r.m === metric && r.t >= sinceTs && r.t <= untilTs).sort((a, b) => a.t - b.t).slice(0, limit).map((r) => ({ k: r.k, v: r.v, ts: r.t })),
    prune: (beforeTs) => { const n = rows.filter((r) => r.t >= beforeTs); if (n.length !== rows.length) { rows = n; try { fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); } catch { /* */ } } },
  };
}

const round1 = (x) => (x == null ? null : Number(x.toFixed(1)));

/**
 * v2.621(감사 RECENT-02): 버킷 조회(LIMIT = '값이 있는 버킷' 개수)가 상한에 걸려 요청 시작을 못 덮었는지(순수).
 * 꽉 찼고(points.length >= limit) 첫 점이 요청 시작 버킷보다 뒤면 잘린 것이다 — 조용히 짧은 기간을 그리지 않게 밝힌다.
 * @returns {{truncated:boolean, coveredSince:number|null, requestedSince:number}}
 */
export function historyCut(points, limit, requestedSince) {
  const n = Array.isArray(points) ? points.length : 0;
  const first = n ? Number(points[0]?.ts) : null;
  const truncated = n > 0 && Number.isFinite(limit) && n >= limit && Number.isFinite(first) && first > requestedSince;
  return { truncated, coveredSince: truncated ? first : null, requestedSince };
}

/*
 * v2.620(SRV2620-02) — dead-band 계열의 step 조회(순수 함수, 테스트가 직접 부른다).
 * 원본(samples)은 '변한 값 + 최대 간격(maxGapMs)마다 1행' 만 담는다(metrics/deadband.js). 그래서 원본을 그대로
 * 집계하는 짧은 창·짧은 버킷은 안정 구간을 '표본 없음' 으로 읽었다. 저장 행 사이는 직전 값이 유지된 구간이다
 * (생략된 표본은 전부 직전 저장값과 eps 미만 차이). 단 **수집이 멈춘 구간**까지 잇지 않도록 이월은
 * 직전 저장 행 + maxGapMs + 여유(STEP_SLACK_MS) 까지만, 마지막 저장 행 이후는 실제 마지막 샘플 시각(최신값 캐시)까지만이다.
 */
export const STEP_SLACK_MS = 5 * 60_000;

/**
 * 창 [sinceTs, nowTs] 의 시간 가중 step 평균. 창 안에 실제 샘플이 없으면(last.ts < sinceTs) null — 죽은 대상을 되살리지 않는다.
 * @param {{carry:{v,ts}|null, rows:{v,ts}[], sinceTs:number, nowTs:number, last:{v,ts}|null}} a
 * @returns {{avg:number, max:number, carried:boolean}|null}
 */
export function stepWindowAvg({ carry, rows, sinceTs, nowTs, last }) {
  const rs = (rows || []).filter((r) => Number.isFinite(r?.v) && Number.isFinite(r?.ts) && r.ts >= sinceTs);
  if (last && Number.isFinite(last.ts) && last.ts < sinceTs && !rs.length) return null; // 창 안에 샘플 자체가 없었다
  if (!last && !rs.length) return null; // 최신값을 모르면 이월만으로 '지금 값' 을 만들지 않는다
  const pts = [];
  const carried = !!(carry && Number.isFinite(carry.v) && (!rs.length || rs[0].ts > sinceTs));
  if (carried) pts.push({ v: carry.v, ts: sinceTs });
  for (const r of rs) pts.push(r);
  if (last && Number.isFinite(last.v) && Number.isFinite(last.ts) && last.ts >= sinceTs && (!pts.length || last.ts > pts[pts.length - 1].ts)) pts.push({ v: last.v, ts: last.ts });
  if (!pts.length) return null;
  const lastPt = pts[pts.length - 1];
  const end = Math.max(lastPt.ts, Number.isFinite(nowTs) ? nowTs : lastPt.ts); // 마지막 값은 지금까지 유지된다
  let wsum = 0; let wtot = 0; let max = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    max = Math.max(max, pts[i].v);
    const t1 = i + 1 < pts.length ? pts[i + 1].ts : end;
    const w = Math.max(0, t1 - pts[i].ts);
    wsum += pts[i].v * w; wtot += w;
  }
  const avg = wtot > 0 ? wsum / wtot : pts.reduce((a, p) => a + p.v, 0) / pts.length;
  return { avg: round1(avg), max: round1(max), carried };
}

/**
 * 짧은 버킷 step 채움. 빈 버킷은 직전 값으로 채우고 `carried:true` 로 표시한다. 저장 행이 있는 버킷도 버킷 시작부터
 * 첫 행 전까지 직전 값이 유지됐으므로 그 값을 함께 집계한다.
 * @returns {{points:{ts,avg,min,max,carried?}[], carried:number}}
 */
export function stepBuckets({ carry, rows, start, nowTs, bucketMs, maxGapMs, lastActualTs = null, slackMs = STEP_SLACK_MS, limit = Infinity }) {
  const out = [];
  if (!(bucketMs > 0)) return { points: out, carried: 0 };
  const rs = (rows || []).filter((r) => Number.isFinite(r?.v) && Number.isFinite(r?.ts)).sort((a, b) => a.ts - b.ts);
  let cur = carry && Number.isFinite(carry.v) && Number.isFinite(carry.ts) ? carry : null;
  let i = 0;
  while (i < rs.length && rs[i].ts < start) { cur = rs[i]; i++; }
  const endB = Math.floor(nowTs / bucketMs) * bucketMs;
  let nCarried = 0;
  for (let b = start; b <= endB; b += bucketMs) {
    const vals = [];
    const firstInBucket = i < rs.length && rs[i].ts < b + bucketMs ? rs[i] : null;
    if (cur && (!firstInBucket || firstInBucket.ts > b)) {
      const tail = !(i < rs.length); // 이후 저장 행이 없다 — 실제 마지막 샘플까지만 잇는다
      let until = cur.ts + maxGapMs + slackMs;
      if (tail && Number.isFinite(lastActualTs) && lastActualTs >= cur.ts) until = Math.min(until, lastActualTs);
      if (b <= until) vals.push(cur.v);
    }
    let own = 0;
    while (i < rs.length && rs[i].ts < b + bucketMs) { vals.push(rs[i].v); cur = rs[i]; i++; own++; }
    if (!vals.length) continue;
    const pt = { ts: b, avg: round1(vals.reduce((a, v) => a + v, 0) / vals.length), min: round1(Math.min(...vals)), max: round1(Math.max(...vals)) };
    if (!own) { pt.carried = true; nCarried++; }
    out.push(pt);
  }
  const cut = Number.isFinite(limit) && out.length > limit ? out.slice(-limit) : out;
  return { points: cut, carried: cut === out ? nCarried : cut.filter((p) => p.carried).length };
}

/*
 * v2.597(감사 L2597-02 — 재현): 첫 open 이 일시 잠금('database is locked')에 걸리면 예전에는 곧바로 NDJSON 으로 폴백해
 * 프로세스 수명 동안 SQLite 이력을 쓰지 않았다(두 저장소가 갈라진다). 잠금이면 몇 번 기다렸다 다시 연다.
 * NDJSON 폴백은 node:sqlite 자체가 없거나 잠금이 아닌 오류일 때만이다.
 */
// v2.613 PERSIST2613-03: 잠금 판정·대기 루프는 util/sqliteOpen.js retryOnLock 하나(예전 LOCK_RE 손 사본 제거 — 동작 동일).
const initSqliteRetrying = (tries = 5, waitMs = 3_000) => retryOnLock(initSqlite, { tries, waitMs, tag: 'metrics' });

export async function getMetricsDb() {
  if (impl) return impl;
  if (!ready) ready = initSqliteRetrying().catch((err) => { console.warn(`[metrics] node:sqlite 불가(${err.code || err.message}); NDJSON 폴백.`); return initJson(); });
  impl = await ready;
  return impl;
}
