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
    // WAL + synchronous=NORMAL: 커밋당 fsync 2회(DELETE 저널) → 배치화(단건 insert 5ms→0.01ms 실측).
    // busy_timeout: 동시 접근 시 즉시 SQLITE_BUSY 실패 대신 대기.
    try { db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;'); } catch { /* 구버전 폴백 */ }
    db.exec(`
      CREATE TABLE IF NOT EXISTS power_samples (
        server_id TEXT NOT NULL,
        watts INTEGER NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_power_server_ts ON power_samples (server_id, ts);
      CREATE INDEX IF NOT EXISTS idx_power_ts ON power_samples (ts);
    `);
    try { fs.chmodSync(DB_PATH, 0o600); } catch { /* best effort */ }
    const insertStmt = db.prepare('INSERT INTO power_samples (server_id, watts, ts) VALUES (?, ?, ?)');
    const latestStmt = db.prepare('SELECT watts, ts FROM power_samples WHERE server_id = ? ORDER BY ts DESC LIMIT 1');
    const latestAllStmt = db.prepare(`
      SELECT s.server_id AS server_id, s.watts AS watts, s.ts AS ts FROM power_samples s
      JOIN (SELECT server_id, MAX(ts) AS mts FROM power_samples GROUP BY server_id) m
        ON s.server_id = m.server_id AND s.ts = m.mts`);
    // 최신 limit개를 뽑아야 한다(ASC+LIMIT은 '가장 오래된' limit개를 반환해 최근 데이터가 잘림
    // — 60s 폴×24h=1440 > limit 1000이면 최근 ~7h가 차트에서 사라짐). DESC로 최신 limit개를
    // 선택한 뒤 오름차순으로 되돌려 NDJSON 폴백(slice(-limit))과 순서·의미를 일치시킨다.
    const historyStmt = db.prepare('SELECT ts, watts FROM power_samples WHERE server_id = ? AND ts >= ? ORDER BY ts DESC LIMIT ?');
    const pruneStmt = db.prepare('DELETE FROM power_samples WHERE ts < ?');
    // 집계(전력 대시보드): 서버별 24h 피크/평균/최소/마지막 + 시간버킷 평균 — SQL GROUP BY로 효율 계산.
    const statsStmt = db.prepare('SELECT server_id, MAX(watts) AS peak, MIN(watts) AS minw, AVG(watts) AS avgw, MAX(ts) AS last, COUNT(*) AS n FROM power_samples WHERE ts >= ? GROUP BY server_id');
    const bucketStmt = db.prepare('SELECT server_id, CAST(ts / ? AS INTEGER) AS bk, AVG(watts) AS avgw FROM power_samples WHERE ts >= ? GROUP BY server_id, bk');
    const idsStmt = db.prepare('SELECT DISTINCT server_id AS id FROM power_samples');
    const delOneStmt = db.prepare('DELETE FROM power_samples WHERE server_id = ?');
    return {
      kind: 'sqlite',
      insert: (serverId, watts, ts) => insertStmt.run(serverId, watts, ts),
      // 다수 샘플을 한 트랜잭션으로 적재(매 폴 590+ 호스트 기록이 이벤트 루프를 막지 않게).
      insertMany: (samples) => {
        if (!samples || !samples.length) return 0;
        db.exec('BEGIN');
        try { for (const s of samples) insertStmt.run(s.serverId, s.watts, s.ts); db.exec('COMMIT'); }
        catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; }
        return samples.length;
      },
      serverIds: () => idsStmt.all().map((r) => r.id),
      deleteServers: (ids) => { let n = 0; db.exec('BEGIN'); try { for (const id of ids) n += delOneStmt.run(id).changes || 0; db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; } return n; },
      latest: (serverId) => latestStmt.get(serverId) || null,
      latestAll: () => {
        const map = new Map();
        for (const r of latestAllStmt.all()) map.set(r.server_id, { watts: r.watts, ts: r.ts });
        return map;
      },
      history: (serverId, sinceTs, limit) => historyStmt.all(serverId, sinceTs, limit).reverse(),
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
  const rewrite = () => { try { fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); } catch { /* best effort */ } };
  return {
    kind: 'json',
    insert: (serverId, watts, ts) => {
      const r = { s: serverId, w: watts, t: ts };
      rows.push(r);
      try { fs.appendFileSync(file, JSON.stringify(r) + '\n', { mode: 0o600 }); } catch { /* best effort */ }
    },
    insertMany: (samples) => {
      if (!samples || !samples.length) return 0;
      const lines = [];
      for (const s of samples) { const r = { s: s.serverId, w: s.watts, t: s.ts }; rows.push(r); lines.push(JSON.stringify(r)); }
      try { fs.appendFileSync(file, lines.join('\n') + '\n', { mode: 0o600 }); } catch { /* best effort */ }
      return samples.length;
    },
    serverIds: () => [...new Set(rows.map((r) => r.s))],
    deleteServers: (ids) => { const set = new Set(ids); const before = rows.length; rows = rows.filter((r) => !set.has(r.s)); const n = before - rows.length; if (n) rewrite(); return n; },
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

/**
 * '서버별 최신 샘플' 인메모리 캐시 래퍼 — latestAll의 GROUP BY MAX는 테이블 전체 인덱스
 * 스캔이라(90일 보존 수렴 시 수억 행) 매 refresh(30초)마다 3회 호출되며 이벤트 루프를
 * 초 단위로 블로킹했다. 기동 시 1회만 시드하고 이후 쓰기 경로에서 O(1) 갱신, 읽기는 O(서버수).
 */
function withLatestCache(db) {
  const cache = db.latestAll(); // 시드(기동 시 1회 풀스캔) — 이후 재스캔 없음
  const bump = (serverId, watts, ts) => {
    const cur = cache.get(serverId);
    if (!cur || ts >= cur.ts) cache.set(serverId, { watts, ts });
  };
  return {
    ...db,
    insert: (serverId, watts, ts) => { const r = db.insert(serverId, watts, ts); bump(serverId, watts, ts); return r; },
    insertMany: (samples) => {
      const n = db.insertMany(samples);
      for (const s of samples || []) bump(s.serverId, s.watts, s.ts);
      return n;
    },
    deleteServers: (ids) => { const n = db.deleteServers(ids); for (const id of ids) cache.delete(id); return n; },
    latest: (serverId) => cache.get(serverId) || null,
    latestAll: () => new Map(cache),
  };
}

/** Lazily initialize and memoize the storage backend (single-flight — 동시 첫 호출 시 이중 커넥션 방지). */
let ready = null;
export async function getDb() {
  if (impl) return impl;
  if (!ready) {
    ready = initSqlite().then((db) => {
      impl = withLatestCache(db);
      console.log(`[idrac] power DB: SQLite (${DB_PATH})`);
      return impl;
    }).catch((err) => {
      impl = withLatestCache(initJsonFallback());
      console.warn(`[idrac] node:sqlite 사용 불가(${err.code || err.message}); NDJSON 폴백 사용. ` +
        `SQLite를 쓰려면 NODE_OPTIONS=--experimental-sqlite 로 실행하세요.`);
      return impl;
    });
  }
  return ready;
}
