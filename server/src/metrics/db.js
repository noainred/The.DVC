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
      `);
    } catch (e) { try { db.close(); } catch { /* */ } throw e; } // 잠금으로 실패하면 핸들을 닫고 재시도(L2597-02)
    const ins = db.prepare('INSERT INTO samples (metric, k, v, ts) VALUES (?, ?, ?, ?)');
    const latestAll = db.prepare(`SELECT s.k AS k, s.v AS v, s.ts AS ts FROM samples s
      JOIN (SELECT k, MAX(ts) mts FROM samples WHERE metric=? GROUP BY k) m ON s.k=m.k AND s.ts=m.mts WHERE s.metric=?`);
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
        for (const r of latestAll.all(metric, metric)) c.set(r.k, { v: r.v, ts: r.ts });
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
       * v2.620(SRV2620-02): dead-band 를 아는 짧은 버킷 조회. 온도 계열은 0.5℃ 미만 변화면 원본을 건너뛰므로
       * (최대 간격 maxGapMs — 기본 30분) 1시간 미만 버킷을 원본에서 그대로 집계하면 안정 구간이 **점 없음**이 된다.
       * 창 직전 마지막 저장 행을 이월하고 빈 버킷을 직전 값으로 채운다(step). 채운 점은 `carried:true`.
       * 60분 이상 버킷·dead-band 가 없는 계열은 history() 와 같다(롤업이 생략분까지 전량 갖고 있다).
       * @returns {{points:object[], carried:number, stepped:boolean, maxGapMs:number|null}}
       */
      historyStep: (metric, k, sinceTs, bucketMs, limit, opts = {}) => {
        const p = deadbandPolicyOf(metric);
        if (!p || bucketMs >= HOUR) return { points: implHistory(metric, k, sinceTs, bucketMs, limit), carried: 0, stepped: false, maxGapMs: p ? p.maxGapMs : null };
        const nowTs = Number.isFinite(opts.nowTs) ? opts.nowTs : Date.now();
        const start = Math.max(Math.floor(sinceTs / bucketMs) * bucketMs, Math.floor(nowTs / bucketMs) * bucketMs - (Math.max(1, limit) - 1) * bucketMs);
        const c = carryOne.get(metric, k, start, start - p.maxGapMs - STEP_SLACK_MS);
        const carry = c && c.ts != null ? { v: c.v, ts: c.ts } : null;
        const rows = rawOne.all(metric, k, start).map((r) => ({ v: r.v, ts: r.ts }));
        const lastActualTs = latestOf(metric, k)?.ts ?? null;
        return { ...stepBuckets({ carry, rows, start, nowTs, bucketMs, maxGapMs: p.maxGapMs, lastActualTs, slackMs: Number.isFinite(opts.slackMs) ? opts.slackMs : STEP_SLACK_MS, limit }), stepped: true, maxGapMs: p.maxGapMs };
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
      recentAvg: implRecentAvg,
      meta: (metric) => { const r = metaStmt.get(metric); return { firstTs: r?.mn ?? null, lastTs: r?.mx ?? null, count: Number(r?.n || 0) }; },
      /**
       * 키 하나의 첫/마지막 관측 시각(v2.504). 원본이 prune 으로 잘려 나가도 롤업에 남아 있을 수
       * 있으므로 **둘 중 더 이른 첫 관측·더 늦은 마지막 관측**을 돌려준다. 건수는 세지 않는다
       * (파티션 풀스캔을 유발한다 — `meta()` 주석 참조).
       */
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
    // SQLite 구현과 같은 API(v2.504) — 호출부가 폴백 여부를 몰라도 되게 한다.
    // v2.620(SRV2620-02): NDJSON 폴백은 dead-band 를 쓰지 않아(전량 저장) step 조회가 곧 일반 조회다 — 같은 API 만 맞춘다.
    historyStep(metric, k, sinceTs, bucketMs, limit) { return { points: this.history(metric, k, sinceTs, bucketMs, limit), carried: 0, stepped: false, maxGapMs: null }; },
    recentAvgStep(metric, sinceTs) { const m = new Map(); for (const [k, a] of this.recentAvg(metric, sinceTs)) m.set(k, { ...a, carried: false }); return m; },
    metaKey: (metric, k) => { let mn = null, mx = null; for (const r of rows) if (r.m === metric && r.k === k) { if (mn == null || r.t < mn) mn = r.t; if (mx == null || r.t > mx) mx = r.t; } return { firstTs: mn, lastTs: mx }; },
    dump: (metric, sinceTs, untilTs, limit) => rows.filter((r) => r.m === metric && r.t >= sinceTs && r.t <= untilTs).sort((a, b) => a.t - b.t).slice(0, limit).map((r) => ({ k: r.k, v: r.v, ts: r.t })),
    prune: (beforeTs) => { const n = rows.filter((r) => r.t >= beforeTs); if (n.length !== rows.length) { rows = n; try { fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); } catch { /* */ } } },
  };
}

const round1 = (x) => (x == null ? null : Number(x.toFixed(1)));

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
