/**
 * Time-series storage for iDRAC power samples.
 *
 * Primary backend is Node 22's built-in SQLite (node:sqlite) — zero external
 * dependencies, ideal for the air-gapped Rocky 9 deployment. It requires the
 * --experimental-sqlite flag (set via NODE_OPTIONS in the systemd unit). When
 * the flag/module is unavailable we transparently fall back to an append-only
 * NDJSON file so the feature still works (with reduced query efficiency).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const DB_PATH = config.idrac.dbPath;

let impl = null; // chosen backend

function initSqlite() {
  // node:sqlite import throws if the experimental flag is missing — caught below.
  // eslint-disable-next-line import/no-unresolved
  return import('node:sqlite').then(({ DatabaseSync }) => {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const db = new DatabaseSync(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS power_samples (
        server_id TEXT NOT NULL,
        watts INTEGER NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_power_server_ts ON power_samples (server_id, ts);
    `);
    try { fs.chmodSync(DB_PATH, 0o600); } catch { /* best effort */ }
    const insertStmt = db.prepare('INSERT INTO power_samples (server_id, watts, ts) VALUES (?, ?, ?)');
    const latestStmt = db.prepare('SELECT watts, ts FROM power_samples WHERE server_id = ? ORDER BY ts DESC LIMIT 1');
    const latestAllStmt = db.prepare(`
      SELECT s.server_id AS server_id, s.watts AS watts, s.ts AS ts FROM power_samples s
      JOIN (SELECT server_id, MAX(ts) AS mts FROM power_samples GROUP BY server_id) m
        ON s.server_id = m.server_id AND s.ts = m.mts`);
    const historyStmt = db.prepare('SELECT ts, watts FROM power_samples WHERE server_id = ? AND ts >= ? ORDER BY ts ASC LIMIT ?');
    const pruneStmt = db.prepare('DELETE FROM power_samples WHERE ts < ?');
    // 집계(전력 대시보드): 서버별 24h 피크/평균/최소/마지막 + 시간버킷 평균 — SQL GROUP BY로 효율 계산.
    const statsStmt = db.prepare('SELECT server_id, MAX(watts) AS peak, MIN(watts) AS minw, AVG(watts) AS avgw, MAX(ts) AS last, COUNT(*) AS n FROM power_samples WHERE ts >= ? GROUP BY server_id');
    const bucketStmt = db.prepare('SELECT server_id, CAST(ts / ? AS INTEGER) AS bk, AVG(watts) AS avgw FROM power_samples WHERE ts >= ? GROUP BY server_id, bk');
    return {
      kind: 'sqlite',
      insert: (serverId, watts, ts) => insertStmt.run(serverId, watts, ts),
      latest: (serverId) => latestStmt.get(serverId) || null,
      latestAll: () => {
        const map = new Map();
        for (const r of latestAllStmt.all()) map.set(r.server_id, { watts: r.watts, ts: r.ts });
        return map;
      },
      history: (serverId, sinceTs, limit) => historyStmt.all(serverId, sinceTs, limit),
      statsSince: (sinceTs) => {
        const m = new Map();
        for (const r of statsStmt.all(sinceTs)) m.set(r.server_id, { peak: Math.round(r.peak), min: Math.round(r.minw), avg: Math.round(r.avgw), last: r.last, count: r.n });
        return m;
      },
      bucketsSince: (sinceTs, bucketMs) => bucketStmt.all(bucketMs, sinceTs).map((r) => ({ serverId: r.server_id, bucket: r.bk * bucketMs, avg: r.avgw })),
      prune: (beforeTs) => pruneStmt.run(beforeTs),
    };
  });
}

function initJsonFallback() {
  const file = DB_PATH.replace(/\.db$/, '') + '.ndjson';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let rows = [];
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r && r.s) rows.push(r); } catch { /* skip */ }
    }
  }
  return {
    kind: 'json',
    insert: (serverId, watts, ts) => {
      const r = { s: serverId, w: watts, t: ts };
      rows.push(r);
      try { fs.appendFileSync(file, JSON.stringify(r) + '\n', { mode: 0o600 }); } catch { /* best effort */ }
    },
    latest: (serverId) => {
      let best = null;
      for (const r of rows) if (r.s === serverId && (!best || r.t > best.ts)) best = { watts: r.w, ts: r.t };
      return best;
    },
    latestAll: () => {
      const map = new Map();
      for (const r of rows) {
        const cur = map.get(r.s);
        if (!cur || r.t > cur.ts) map.set(r.s, { watts: r.w, ts: r.t });
      }
      return map;
    },
    history: (serverId, sinceTs, limit) =>
      rows.filter((r) => r.s === serverId && r.t >= sinceTs).sort((a, b) => a.t - b.t).slice(-limit)
        .map((r) => ({ ts: r.t, watts: r.w })),
    statsSince: (sinceTs) => {
      const acc = new Map(); // s -> {peak,min,sum,n,last}
      for (const r of rows) {
        if (r.t < sinceTs) continue;
        const a = acc.get(r.s) || { peak: -Infinity, min: Infinity, sum: 0, n: 0, last: 0 };
        a.peak = Math.max(a.peak, r.w); a.min = Math.min(a.min, r.w); a.sum += r.w; a.n++; a.last = Math.max(a.last, r.t);
        acc.set(r.s, a);
      }
      const m = new Map();
      for (const [s, a] of acc) m.set(s, { peak: a.peak, min: a.min, avg: Math.round(a.sum / a.n), last: a.last, count: a.n });
      return m;
    },
    bucketsSince: (sinceTs, bucketMs) => {
      const acc = new Map(); // `${s}|${bk}` -> {sum,n}
      for (const r of rows) {
        if (r.t < sinceTs) continue;
        const bk = Math.floor(r.t / bucketMs);
        const k = `${r.s}|${bk}`;
        const a = acc.get(k) || { s: r.s, bucket: bk * bucketMs, sum: 0, n: 0 };
        a.sum += r.w; a.n++; acc.set(k, a);
      }
      return [...acc.values()].map((a) => ({ serverId: a.s, bucket: a.bucket, avg: a.sum / a.n }));
    },
    prune: (beforeTs) => {
      const next = rows.filter((r) => r.t >= beforeTs);
      if (next.length !== rows.length) {
        rows = next;
        try { fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); } catch { /* best effort */ }
      }
    },
  };
}

/** Lazily initialize and memoize the storage backend. */
export async function getDb() {
  if (impl) return impl;
  try {
    impl = await initSqlite();
    console.log(`[idrac] power DB: SQLite (${DB_PATH})`);
  } catch (err) {
    impl = initJsonFallback();
    console.warn(`[idrac] node:sqlite 사용 불가(${err.code || err.message}); NDJSON 폴백 사용. ` +
      `SQLite를 쓰려면 NODE_OPTIONS=--experimental-sqlite 로 실행하세요.`);
  }
  return impl;
}
