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
import path from 'node:path';
import { config } from '../config.js';

const DB_PATH = config.temp.dbPath; // reuse the temp/metrics DB path

let impl = null;
let ready = null;

function initSqlite() {
  // eslint-disable-next-line import/no-unresolved
  return import('node:sqlite').then(({ DatabaseSync }) => {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const db = new DatabaseSync(DB_PATH);
    // WAL + synchronous=NORMAL: 커밋당 fsync 2회(DELETE 저널) → 배치화(단건 insert 5ms→0.01ms 실측).
    // busy_timeout: 동시 접근 시 즉시 SQLITE_BUSY 실패 대신 대기.
    try { db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;'); } catch { /* 구버전 폴백 */ }
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
    try { fs.chmodSync(DB_PATH, 0o600); } catch { /* best effort */ }
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
    const prune = db.prepare('DELETE FROM samples WHERE ts < ?');
    const HOUR = 3600_000;
    const insHour = db.prepare(`INSERT INTO samples_hourly (metric, k, h, n, sum, mn, mx) VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(metric, k, h) DO UPDATE SET n=n+1, sum=sum+excluded.sum, mn=MIN(mn, excluded.mn), mx=MAX(mx, excluded.mx)`);
    const bucketHourly = db.prepare(`SELECT CAST(h/? AS INTEGER)*? AS b, SUM(sum)/SUM(n) AS avg, MIN(mn) AS min, MAX(mx) AS max
      FROM samples_hourly WHERE metric=? AND k=? AND h>=? GROUP BY b ORDER BY b DESC LIMIT ?`);
    const hourlyMin = db.prepare('SELECT MIN(h) AS mn FROM samples_hourly WHERE metric=? AND k=?');
    const pruneHourly = db.prepare('DELETE FROM samples_hourly WHERE h < ?');
    const bucketAll = db.prepare(`SELECT k, CAST(ts/? AS INTEGER)*? AS b, AVG(v) avg, MIN(v) min, MAX(v) max FROM samples
      WHERE metric=? AND ts>=? GROUP BY k, b ORDER BY k, b`);
    // latestAll 인메모리 캐시 — 원본은 (k, MAX(ts)) 풀 인덱스 스캔이라 보존기간이 길수록
    // 비싸진다(iDRAC 전력 withLatestCache 와 같은 문제·같은 처방). 최초 호출에 1회 시드 후
    // 쓰기 경로에서 O(1) 갱신. 캐시 갱신은 반드시 '커밋 성공 후'(실패분 유령 데이터 방지).
    const latestCache = new Map(); // metric -> Map<k, {v, ts}>
    return {
      kind: 'sqlite',
      insertMany: (rows, ts) => {
        db.exec('BEGIN');
        try {
          const h = Math.floor(ts / HOUR) * HOUR;
          for (const r of rows) { ins.run(r.metric, r.k, r.v, ts); insHour.run(r.metric, r.k, h, r.v, r.v, r.v); }
          db.exec('COMMIT');
        } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; }
        for (const r of rows) {
          const c = latestCache.get(r.metric);
          if (c) { const cur = c.get(r.k); if (!cur || ts >= cur.ts) c.set(r.k, { v: r.v, ts }); }
        }
      },
      latestAll: (metric) => {
        let c = latestCache.get(metric);
        if (!c) {
          c = new Map();
          for (const r of latestAll.all(metric, metric)) c.set(r.k, { v: r.v, ts: r.ts });
          latestCache.set(metric, c);
        }
        return new Map(c); // 기존 계약(매 호출 새 Map) 유지 — 호출부 변형이 캐시를 오염시키지 않게
      },
      history: (metric, k, sinceTs, bucketMs, limit) => {
        // 60분+ 정배수 버킷이고 롤업이 요청 창을 덮으면 시간당 롤업에서 집계(원본 스캔 제거).
        // 업그레이드 이전 데이터(롤업 없음)가 창에 걸리면 원본으로 폴백해 빈 결과를 만들지 않는다.
        if (bucketMs >= HOUR && bucketMs % HOUR === 0) {
          const mn = hourlyMin.get(metric, k)?.mn;
          if (mn != null && mn <= sinceTs) {
            return bucketHourly.all(bucketMs, bucketMs, metric, k, sinceTs, limit).reverse()
              .map((r) => ({ ts: r.b, avg: round1(r.avg), min: round1(r.min), max: round1(r.max) }));
          }
        }
        return bucket.all(bucketMs, bucketMs, metric, k, sinceTs, limit).reverse().map((r) => ({ ts: r.b, avg: round1(r.avg), min: round1(r.min), max: round1(r.max) }));
      },
      // 패밀리 전 키 일괄 버킷 — 이상탐지의 키별 N+1(키 수천 × 쿼리 1회)을 쿼리 1회로 대체.
      historyAll: (metric, sinceTs, bucketMs, limitPerKey) => {
        const out = new Map();
        for (const r of bucketAll.all(bucketMs, bucketMs, metric, sinceTs)) {
          let arr = out.get(r.k);
          if (!arr) { arr = []; out.set(r.k, arr); }
          arr.push({ ts: r.b, avg: round1(r.avg), min: round1(r.min), max: round1(r.max) });
        }
        if (limitPerKey) for (const [k, arr] of out) if (arr.length > limitPerKey) out.set(k, arr.slice(-limitPerKey));
        return out;
      },
      recentAvg: (metric, sinceTs) => { const map = new Map(); for (const r of recentAvgAll.all(metric, sinceTs)) map.set(r.k, { avg: round1(r.avg), max: round1(r.max) }); return map; },
      meta: (metric) => { const r = metaStmt.get(metric); return { firstTs: r?.mn ?? null, lastTs: r?.mx ?? null, count: Number(r?.n || 0) }; },
      dump: (metric, sinceTs, untilTs, limit) => dumpStmt.all(metric, sinceTs, untilTs, limit).map((r) => ({ k: r.k, v: r.v, ts: r.ts })),
      prune: (beforeTs) => {
        const r = prune.run(beforeTs);
        // 롤업도 함께 정리(원본만 지우면 집계가 영원히 남는다). 경계의 부분 시간대(1시간 미만)는
        // 남겨 롤업이 원본보다 먼저 비는 일이 없게 한다. 실패해도 원본 prune 결과는 유지.
        try { pruneHourly.run(beforeTs - HOUR); } catch (e) { console.warn(`[metrics] 롤업 prune 실패: ${e.message}`); }
        for (const c of latestCache.values()) {
          for (const [k, e] of c) if (e.ts < beforeTs) c.delete(k);
        }
        return r;
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
    insertMany: (recs, ts) => { const lines = recs.map((r) => ({ m: r.metric, k: r.k, v: r.v, t: ts })); rows.push(...lines); try { fs.appendFileSync(file, lines.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); } catch { /* */ } },
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
    dump: (metric, sinceTs, untilTs, limit) => rows.filter((r) => r.m === metric && r.t >= sinceTs && r.t <= untilTs).sort((a, b) => a.t - b.t).slice(0, limit).map((r) => ({ k: r.k, v: r.v, ts: r.t })),
    prune: (beforeTs) => { const n = rows.filter((r) => r.t >= beforeTs); if (n.length !== rows.length) { rows = n; try { fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); } catch { /* */ } } },
  };
}

const round1 = (x) => (x == null ? null : Number(x.toFixed(1)));

export async function getMetricsDb() {
  if (impl) return impl;
  if (!ready) ready = initSqlite().catch((err) => { console.warn(`[metrics] node:sqlite 불가(${err.code || err.message}); NDJSON 폴백.`); return initJson(); });
  impl = await ready;
  return impl;
}
