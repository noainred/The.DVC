/**
 * Ping 모니터링 시계열 저장소 — 등록 대상별 RTT/도달성 샘플을 별도 SQLite에 보관한다.
 * iDRAC 전력/온도 DB와 동일하게 node:sqlite(--experimental-sqlite) 사용, 불가 시 NDJSON 폴백.
 *
 * 스키마: samples(target TEXT, ts INTEGER, rtt REAL, ok INTEGER). `target`은 대상 id,
 * `rtt`는 응답 지연(ms, 무응답이면 NULL), `ok`는 도달 여부(1/0). 장기 범위는 쿼리에서
 * 시간 버킷 집계(avg/min/max/loss)로 다운샘플한다.
 *
 * 성능: WAL + synchronous=NORMAL + busy_timeout(단건 insert 가속), (target,ts)·(ts) 인덱스.
 * prune(ts<?)는 ts 단독 인덱스로 풀스캔을 피한다(복합 (target,ts)로는 못 탐).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const DB_PATH = config.ping.dbPath;

let impl = null;
let ready = null;

function initSqlite() {
  // eslint-disable-next-line import/no-unresolved
  return import('node:sqlite').then(({ DatabaseSync }) => {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const db = new DatabaseSync(DB_PATH);
    try { db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;'); } catch { /* 구버전 폴백 */ }
    db.exec(`
      CREATE TABLE IF NOT EXISTS samples (
        target TEXT NOT NULL, ts INTEGER NOT NULL, rtt REAL, ok INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ping_tgt_ts ON samples (target, ts);
      CREATE INDEX IF NOT EXISTS idx_ping_ts ON samples (ts); -- prune(ts<?)가 풀스캔 없이 타도록
    `);
    try { fs.chmodSync(DB_PATH, 0o600); } catch { /* best effort */ }
    const ins = db.prepare('INSERT INTO samples (target, ts, rtt, ok) VALUES (?, ?, ?, ?)');
    // 최신 샘플(대상별 1건)
    const latestOne = db.prepare('SELECT rtt, ok, ts FROM samples WHERE target=? ORDER BY ts DESC LIMIT 1');
    // baseline 산출용: 최근 OK 샘플 rtt N개(중앙값은 JS에서)
    const recentOk = db.prepare('SELECT rtt FROM samples WHERE target=? AND ok=1 AND rtt IS NOT NULL ORDER BY ts DESC LIMIT ?');
    // 시간 버킷 다운샘플: avg/min/max rtt + 손실률(무응답 비율). DESC+LIMIT로 최근 버킷 우선 후 JS에서 되돌림.
    const bucket = db.prepare(`SELECT (ts/?)*? AS b,
        AVG(CASE WHEN ok=1 THEN rtt END) avg, MIN(CASE WHEN ok=1 THEN rtt END) min, MAX(CASE WHEN ok=1 THEN rtt END) max,
        SUM(CASE WHEN ok=1 THEN 0 ELSE 1 END) fail, COUNT(*) n
      FROM samples WHERE target=? AND ts>=? GROUP BY b ORDER BY b DESC LIMIT ?`);
    const metaStmt = db.prepare('SELECT MIN(ts) mn, MAX(ts) mx, COUNT(*) n FROM samples WHERE target=?');
    const prune = db.prepare('DELETE FROM samples WHERE ts < ?');
    const dropTarget = db.prepare('DELETE FROM samples WHERE target=?');
    return {
      kind: 'sqlite',
      insertMany: (rows) => { db.exec('BEGIN'); try { for (const r of rows) ins.run(r.target, r.ts, r.rtt == null ? null : r.rtt, r.ok ? 1 : 0); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; } },
      latest: (target) => { const r = latestOne.get(target); return r ? { rtt: r.rtt, ok: !!r.ok, ts: r.ts } : null; },
      recentOkRtt: (target, limit) => recentOk.all(target, limit).map((r) => r.rtt).filter((v) => v != null),
      history: (target, sinceTs, bucketMs, limit) => bucket.all(bucketMs, bucketMs, target, sinceTs, limit).reverse()
        .map((r) => ({ ts: r.b, avg: round2(r.avg), min: round2(r.min), max: round2(r.max), loss: r.n ? Number((r.fail / r.n).toFixed(3)) : 0, n: Number(r.n) })),
      meta: (target) => { const r = metaStmt.get(target); return { firstTs: r?.mn ?? null, lastTs: r?.mx ?? null, count: Number(r?.n || 0) }; },
      prune: (beforeTs) => prune.run(beforeTs),
      dropTarget: (target) => dropTarget.run(target),
    };
  });
}

function initJson() {
  const file = DB_PATH.replace(/\.db$/, '') + '.ndjson';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let rows = [];
  try { for (const l of fs.readFileSync(file, 'utf8').split('\n')) { if (l.trim()) rows.push(JSON.parse(l)); } } catch { /* */ }
  return {
    kind: 'json',
    insertMany: (recs) => { const lines = recs.map((r) => ({ g: r.target, t: r.ts, v: r.rtt == null ? null : r.rtt, o: r.ok ? 1 : 0 })); rows.push(...lines); try { fs.appendFileSync(file, lines.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); } catch { /* */ } },
    latest: (target) => { let best = null; for (const r of rows) if (r.g === target && (!best || r.t > best.t)) best = r; return best ? { rtt: best.v, ok: !!best.o, ts: best.t } : null; },
    recentOkRtt: (target, limit) => rows.filter((r) => r.g === target && r.o && r.v != null).sort((a, b) => b.t - a.t).slice(0, limit).map((r) => r.v),
    history: (target, sinceTs, bucketMs, limit) => {
      const buckets = new Map();
      for (const r of rows) if (r.g === target && r.t >= sinceTs) {
        const b = Math.floor(r.t / bucketMs) * bucketMs; const g = buckets.get(b) || { sum: 0, n: 0, ok: 0, min: Infinity, max: -Infinity };
        g.n++; if (r.o && r.v != null) { g.ok++; g.sum += r.v; g.min = Math.min(g.min, r.v); g.max = Math.max(g.max, r.v); } buckets.set(b, g);
      }
      return [...buckets.entries()].sort((a, b) => a[0] - b[0]).slice(-limit).map(([b, g]) => ({
        ts: b, avg: g.ok ? round2(g.sum / g.ok) : null, min: g.ok ? round2(g.min) : null, max: g.ok ? round2(g.max) : null,
        loss: g.n ? Number(((g.n - g.ok) / g.n).toFixed(3)) : 0, n: g.n,
      }));
    },
    meta: (target) => { let mn = null, mx = null, n = 0; for (const r of rows) if (r.g === target) { n++; if (mn == null || r.t < mn) mn = r.t; if (mx == null || r.t > mx) mx = r.t; } return { firstTs: mn, lastTs: mx, count: n }; },
    prune: (beforeTs) => { const n = rows.filter((r) => r.t >= beforeTs); if (n.length !== rows.length) { rows = n; try { fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); } catch { /* */ } } },
    dropTarget: (target) => { const n = rows.filter((r) => r.g !== target); if (n.length !== rows.length) { rows = n; try { fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); } catch { /* */ } } },
  };
}

const round2 = (x) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(2)));

export async function getPingDb() {
  if (impl) return impl;
  if (!ready) ready = initSqlite().catch((err) => { console.warn(`[ping] node:sqlite 불가(${err.code || err.message}); NDJSON 폴백.`); return initJson(); });
  impl = await ready;
  return impl;
}
