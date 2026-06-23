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
    db.exec(`
      CREATE TABLE IF NOT EXISTS samples (
        metric TEXT NOT NULL, k TEXT NOT NULL, v REAL NOT NULL, ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_samples_mkt ON samples (metric, k, ts);
    `);
    try { fs.chmodSync(DB_PATH, 0o600); } catch { /* best effort */ }
    const ins = db.prepare('INSERT INTO samples (metric, k, v, ts) VALUES (?, ?, ?, ?)');
    const latestAll = db.prepare(`SELECT s.k AS k, s.v AS v, s.ts AS ts FROM samples s
      JOIN (SELECT k, MAX(ts) mts FROM samples WHERE metric=? GROUP BY k) m ON s.k=m.k AND s.ts=m.mts WHERE s.metric=?`);
    const bucket = db.prepare(`SELECT (ts/?)*? AS b, AVG(v) avg, MIN(v) min, MAX(v) max FROM samples
      WHERE metric=? AND k=? AND ts>=? GROUP BY b ORDER BY b LIMIT ?`);
    const recentAvgAll = db.prepare(`SELECT k, AVG(v) avg, MAX(v) max FROM samples WHERE metric=? AND ts>=? GROUP BY k`);
    const metaStmt = db.prepare('SELECT MIN(ts) AS mn, MAX(ts) AS mx, COUNT(*) AS n FROM samples WHERE metric=?');
    const dumpStmt = db.prepare('SELECT k, v, ts FROM samples WHERE metric=? AND ts>=? AND ts<=? ORDER BY ts, k LIMIT ?');
    const prune = db.prepare('DELETE FROM samples WHERE ts < ?');
    return {
      kind: 'sqlite',
      insertMany: (rows, ts) => { db.exec('BEGIN'); try { for (const r of rows) ins.run(r.metric, r.k, r.v, ts); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; } },
      latestAll: (metric) => { const map = new Map(); for (const r of latestAll.all(metric, metric)) map.set(r.k, { v: r.v, ts: r.ts }); return map; },
      history: (metric, k, sinceTs, bucketMs, limit) => bucket.all(bucketMs, bucketMs, metric, k, sinceTs, limit).map((r) => ({ ts: r.b, avg: round1(r.avg), min: round1(r.min), max: round1(r.max) })),
      recentAvg: (metric, sinceTs) => { const map = new Map(); for (const r of recentAvgAll.all(metric, sinceTs)) map.set(r.k, { avg: round1(r.avg), max: round1(r.max) }); return map; },
      meta: (metric) => { const r = metaStmt.get(metric); return { firstTs: r?.mn ?? null, lastTs: r?.mx ?? null, count: Number(r?.n || 0) }; },
      dump: (metric, sinceTs, untilTs, limit) => dumpStmt.all(metric, sinceTs, untilTs, limit).map((r) => ({ k: r.k, v: r.v, ts: r.ts })),
      prune: (beforeTs) => prune.run(beforeTs),
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
