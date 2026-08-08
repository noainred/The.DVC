/**
 * Capacity Advisor 시계열 저장소 — metrics/db.js 와 같은 정책(WAL·ts 인덱스·시간당 롤업·prune).
 *
 * 스키마: samples(metric, k, v, ts) — metric = 수집기 키(cpu_system…), k = 호스트 정체성
 * (중앙 자신 = 'local', 엣지 = agent 이름). 중앙+엣지가 **한 스키마**에 들어가 화면이 호스트
 * 셀렉터 하나로 전체를 본다.
 *
 * 보존 정책(이중):
 *  - 원본 30초 샘플: rawRetentionHours(기본 72h) — '1일' 창의 정밀 p95 계산용.
 *  - 시간당 롤업: rollupRetentionDays(기본 400d) — '1주/1달' 창은 롤업으로 본다.
 *    롤업에 n/sum/mn/mx 만 있으므로 장기 창의 p95 는 **시간당 max 들의 p95** 로 근사한다
 *    (원본 p95 보다 보수적으로 높게 나온다 — 증설 판단에는 안전한 방향. 화면에 근사임을 표기).
 *
 * windowStats() 가 권고 엔진의 유일한 데이터 소스다 — 평가·화면·API 가 같은 통계를 본다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const DB_PATH = config.capacity.dbPath;
const HOUR = 3600_000;

let impl = null;
let ready = null;

const round2 = (x) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(2)));

/** 정렬된 배열의 p분위(선형 보간 없이 최근접 — 표본 수천 개 규모에 충분). */
function percentileSorted(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function initSqlite() {
  // eslint-disable-next-line import/no-unresolved
  return import('node:sqlite').then(({ DatabaseSync }) => {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const db = new DatabaseSync(DB_PATH);
    try { db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;'); } catch { /* 구버전 폴백 */ }
    db.exec(`
      CREATE TABLE IF NOT EXISTS samples (
        metric TEXT NOT NULL, k TEXT NOT NULL, v REAL NOT NULL, ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cap_mkt ON samples (metric, k, ts);
      CREATE INDEX IF NOT EXISTS idx_cap_ts ON samples (ts); -- prune(ts<?)가 풀스캔 없이 타도록
      CREATE TABLE IF NOT EXISTS samples_hourly (
        metric TEXT NOT NULL, k TEXT NOT NULL, h INTEGER NOT NULL,
        n INTEGER NOT NULL, sum REAL NOT NULL, mn REAL NOT NULL, mx REAL NOT NULL,
        PRIMARY KEY (metric, k, h)
      );
      CREATE INDEX IF NOT EXISTS idx_cap_hourly_h ON samples_hourly (h);
      -- 호스트(k)별 마지막 보고·메타(코어수 등) — 화면 호스트 목록·신선도 판정용.
      CREATE TABLE IF NOT EXISTS hosts (
        k TEXT PRIMARY KEY, lastTs INTEGER NOT NULL, meta TEXT NOT NULL DEFAULT '{}'
      );
    `);
    try { fs.chmodSync(DB_PATH, 0o600); } catch { /* best effort */ }

    const ins = db.prepare('INSERT INTO samples (metric, k, v, ts) VALUES (?, ?, ?, ?)');
    const insHour = db.prepare(`INSERT INTO samples_hourly (metric, k, h, n, sum, mn, mx) VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(metric, k, h) DO UPDATE SET n=n+1, sum=sum+excluded.sum, mn=MIN(mn, excluded.mn), mx=MAX(mx, excluded.mx)`);
    const upHost = db.prepare(`INSERT INTO hosts (k, lastTs, meta) VALUES (?, ?, ?)
      ON CONFLICT(k) DO UPDATE SET lastTs=excluded.lastTs, meta=excluded.meta`);
    const rawVals = db.prepare('SELECT v FROM samples WHERE metric=? AND k=? AND ts>=? AND ts<=? ORDER BY v');
    const rawBucket = db.prepare(`SELECT CAST(ts/? AS INTEGER)*? AS b, AVG(v) avg, MIN(v) min, MAX(v) max FROM samples
      WHERE metric=? AND k=? AND ts>=? GROUP BY b ORDER BY b DESC LIMIT ?`);
    const hourRows = db.prepare('SELECT h, n, sum, mn, mx FROM samples_hourly WHERE metric=? AND k=? AND h>=? AND h<=? ORDER BY h');
    const hourBucket = db.prepare(`SELECT CAST(h/? AS INTEGER)*? AS b, SUM(sum)/SUM(n) AS avg, MIN(mn) AS min, MAX(mx) AS max
      FROM samples_hourly WHERE metric=? AND k=? AND h>=? GROUP BY b ORDER BY b DESC LIMIT ?`);
    const hostsAll = db.prepare('SELECT k, lastTs, meta FROM hosts ORDER BY k');
    const pruneRaw = db.prepare('DELETE FROM samples WHERE ts < ?');
    const pruneHour = db.prepare('DELETE FROM samples_hourly WHERE h < ?');

    return {
      kind: 'sqlite',
      /**
       * 한 호스트의 스냅샷 1회분을 트랜잭션으로 적재(원본 + 시간당 롤업 동시 — 별도 커밋 금지).
       * rows: [{metric, v}], meta: 호스트 메타(JSON 직렬화 가능 객체).
       */
      insertSnapshot: (k, rows, ts, meta) => {
        db.exec('BEGIN');
        try {
          const h = Math.floor(ts / HOUR) * HOUR;
          for (const r of rows) { ins.run(r.metric, k, r.v, ts); insHour.run(r.metric, k, h, r.v, r.v, r.v); }
          upHost.run(k, ts, JSON.stringify(meta || {}));
          db.exec('COMMIT');
        } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; }
      },
      /** 호스트 목록(마지막 보고 시각·메타). */
      hosts: () => hostsAll.all().map((r) => {
        let meta = {};
        try { meta = JSON.parse(r.meta); } catch { /* 손상 메타는 빈 값 */ }
        return { k: r.k, lastTs: r.lastTs, meta };
      }),
      /**
       * 창 통계 — 권고의 근거. 창이 원본 보존 안이면 원본에서 정확한 p50/p95,
       * 넘으면 시간당 롤업으로 근사(p95 ≈ 시간당 max 들의 p95, approx:true 표기).
       */
      windowStats: (metric, k, sinceTs, untilTs) => {
        const rawFloor = Date.now() - config.capacity.rawRetentionHours * HOUR;
        if (sinceTs >= rawFloor) {
          const vals = rawVals.all(metric, k, sinceTs, untilTs).map((r) => r.v);
          if (!vals.length) return null;
          let sum = 0; for (const v of vals) sum += v;
          return {
            n: vals.length, approx: false,
            avg: round2(sum / vals.length),
            p50: round2(percentileSorted(vals, 50)),
            p95: round2(percentileSorted(vals, 95)),
            max: round2(vals[vals.length - 1]),
          };
        }
        const rows = hourRows.all(metric, k, Math.floor(sinceTs / HOUR) * HOUR, untilTs);
        if (!rows.length) return null;
        let n = 0; let sum = 0; let mx = -Infinity;
        const maxes = [];
        for (const r of rows) { n += r.n; sum += r.sum; if (r.mx > mx) mx = r.mx; maxes.push(r.mx); }
        maxes.sort((a, b) => a - b);
        return {
          n, approx: true,
          avg: round2(sum / n),
          p50: round2(percentileSorted(maxes, 50)),   // 시간당 max 의 중앙값 — 보수적 근사
          p95: round2(percentileSorted(maxes, 95)),
          max: round2(mx),
        };
      },
      /** 추세 차트용 버킷 — 원본 창이면 원본, 장기 창이면 롤업(60분 정배수 버킷). */
      history: (metric, k, sinceTs, bucketMs, limit) => {
        const rawFloor = Date.now() - config.capacity.rawRetentionHours * HOUR;
        if (sinceTs >= rawFloor && bucketMs < HOUR) {
          return rawBucket.all(bucketMs, bucketMs, metric, k, sinceTs, limit).reverse()
            .map((r) => ({ ts: r.b, avg: round2(r.avg), min: round2(r.min), max: round2(r.max) }));
        }
        const b = Math.max(HOUR, Math.round(bucketMs / HOUR) * HOUR);
        return hourBucket.all(b, b, metric, k, Math.floor(sinceTs / HOUR) * HOUR, limit).reverse()
          .map((r) => ({ ts: r.b, avg: round2(r.avg), min: round2(r.min), max: round2(r.max) }));
      },
      prune: (now) => {
        pruneRaw.run(now - config.capacity.rawRetentionHours * HOUR);
        try { pruneHour.run(now - config.capacity.rollupRetentionDays * 24 * HOUR); }
        catch (e) { console.warn(`[capacity] 롤업 prune 실패: ${e.message}`); }
      },
    };
  });
}

/** node:sqlite 불가 시 인메모리 폴백 — 진단 기능이 포탈 기동을 막으면 안 된다(재시작 시 소실 감수). */
function initMemory() {
  const rows = [];                              // {metric, k, v, ts}
  const hosts = new Map();                      // k -> {lastTs, meta}
  return {
    kind: 'memory',
    insertSnapshot: (k, rs, ts, meta) => {
      for (const r of rs) rows.push({ metric: r.metric, k, v: r.v, ts });
      hosts.set(k, { lastTs: ts, meta: meta || {} });
    },
    hosts: () => [...hosts.entries()].map(([k, h]) => ({ k, lastTs: h.lastTs, meta: h.meta })).sort((a, b) => a.k.localeCompare(b.k)),
    windowStats: (metric, k, sinceTs, untilTs) => {
      const vals = rows.filter((r) => r.metric === metric && r.k === k && r.ts >= sinceTs && r.ts <= untilTs)
        .map((r) => r.v).sort((a, b) => a - b);
      if (!vals.length) return null;
      let sum = 0; for (const v of vals) sum += v;
      return {
        n: vals.length, approx: false, avg: round2(sum / vals.length),
        p50: round2(percentileSorted(vals, 50)), p95: round2(percentileSorted(vals, 95)),
        max: round2(vals[vals.length - 1]),
      };
    },
    history: (metric, k, sinceTs, bucketMs, limit) => {
      const buckets = new Map();
      for (const r of rows) {
        if (r.metric !== metric || r.k !== k || r.ts < sinceTs) continue;
        const b = Math.floor(r.ts / bucketMs) * bucketMs;
        const g = buckets.get(b) || { sum: 0, n: 0, min: Infinity, max: -Infinity };
        g.sum += r.v; g.n++; g.min = Math.min(g.min, r.v); g.max = Math.max(g.max, r.v); buckets.set(b, g);
      }
      return [...buckets.entries()].sort((a, b) => a[0] - b[0]).slice(-limit)
        .map(([b, g]) => ({ ts: b, avg: round2(g.sum / g.n), min: round2(g.min), max: round2(g.max) }));
    },
    prune: (now) => {
      const floor = now - config.capacity.rawRetentionHours * HOUR;
      let i = 0;
      while (i < rows.length && rows.length > 0) { if (rows[i].ts < floor) rows.splice(i, 1); else i += 1; }
    },
  };
}

export async function getCapacityDb() {
  if (impl) return impl;
  if (!ready) {
    ready = initSqlite().catch((err) => {
      console.warn(`[capacity] node:sqlite 불가(${err.code || err.message}); 인메모리 폴백(재시작 시 이력 소실).`);
      return initMemory();
    });
  }
  impl = await ready;
  return impl;
}
