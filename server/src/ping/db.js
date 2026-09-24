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
import { openSqlite, retryOnLock } from '../util/sqliteOpen.js';
import { chunkedDelete, createPruneFlight } from '../util/chunkedPrune.js';   // v2.599 DB2599-02: 첫 open 잠금 → 기다렸다 재시도(NDJSON 폴백 래치 금지)

const DB_PATH = config.ping.dbPath;

let impl = null;
let ready = null;

function initSqlite() {
  // eslint-disable-next-line import/no-unresolved
  return import('node:sqlite').then(({ DatabaseSync }) => {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const db = openSqlite(new DatabaseSync(DB_PATH));   // busy_timeout 먼저 · 잠금이면 닫고 던진다
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
    // ⚠ node:sqlite 는 JS number 를 REAL 로 바인딩한다 — (ts/?)*? 는 실수 나눗셈이라 버킷이 묶이지 않고
    // 표본 1건 = 1버킷이 되어 LIMIT 이 최근 몇 시간만 남기고 손실률도 0/1 로 떨어졌다(v2.598 DB2598-01).
    // metrics/db.js 와 같은 CAST(… AS INTEGER) 형태로 정수 버킷을 만든다.
    const bucket = db.prepare(`SELECT CAST(ts/? AS INTEGER)*? AS b,
        AVG(CASE WHEN ok=1 THEN rtt END) avg, MIN(CASE WHEN ok=1 THEN rtt END) min, MAX(CASE WHEN ok=1 THEN rtt END) max,
        SUM(CASE WHEN ok=1 THEN 0 ELSE 1 END) fail, COUNT(*) n
      FROM samples WHERE target=? AND ts>=? GROUP BY b ORDER BY b DESC LIMIT ?`);
    const metaStmt = db.prepare('SELECT MIN(ts) mn, MAX(ts) mx, COUNT(*) n FROM samples WHERE target=?');
    // v2.603(감사 DB2603-02 — 재현): 예전 `DELETE FROM samples WHERE ts < ?` 한 방은 보존일을 줄인 뒤 첫 정리에서
    // 515만 행을 동기로 지워 이벤트 루프를 5.6초 멈췄다(ping 은 가장 큰 테이블이다). rowid 서브쿼리 청크 DELETE +
    // 청크 사이 양보(util/chunkedPrune.js, v2.453·v2.601 규약) — idx_ping_ts 가 서브쿼리의 풀스캔을 막는다.
    const pruneChunk = db.prepare('DELETE FROM samples WHERE rowid IN (SELECT rowid FROM samples WHERE ts < ? LIMIT ?)');
    // 정리끼리는 겹치지 않는다. 같은 경계면 진행 중인 것을 공유하고, 경계가 더 늦으면(보존일을 줄였으면) 끝난 뒤
    // 새 경계로 한 번 더 돈다(RECENT2603-06 과 같은 판단). 호출부(monitor.js)는 기다리지 않으므로 실패는 여기서 남긴다.
    const pruneFlight = createPruneFlight({ covers: (running, next) => running >= next });   // 키 = 경계(ms)
    const prune = (beforeTs) => {
      const cut = Number(beforeTs);
      if (!Number.isFinite(cut)) return Promise.resolve({ deleted: 0, done: true, chunks: 0 });
      return pruneFlight.run(cut, () => chunkedDelete(pruneChunk, [cut], { label: 'ping.samples' })
        .catch((e) => { console.warn(`[ping] prune 실패: ${e?.message || e}`); return { deleted: 0, done: false, chunks: 0, error: String(e?.message || e) }; }));
    };
    const dropTarget = db.prepare('DELETE FROM samples WHERE target=?');
    return {
      kind: 'sqlite',
      insertMany: (rows) => { db.exec('BEGIN'); try { for (const r of rows) ins.run(r.target, r.ts, r.rtt == null ? null : r.rtt, r.ok ? 1 : 0); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; } },
      latest: (target) => { const r = latestOne.get(target); return r ? { rtt: r.rtt, ok: !!r.ok, ts: r.ts } : null; },
      recentOkRtt: (target, limit) => recentOk.all(target, limit).map((r) => r.rtt).filter((v) => v != null),
      history: (target, sinceTs, bucketMs, limit) => bucket.all(bucketMs, bucketMs, target, sinceTs, limit).reverse()
        .map((r) => ({ ts: r.b, avg: round2(r.avg), min: round2(r.min), max: round2(r.max), loss: r.n ? Number((r.fail / r.n).toFixed(3)) : 0, n: Number(r.n) })),
      meta: (target) => { const r = metaStmt.get(target); return { firstTs: r?.mn ?? null, lastTs: r?.mx ?? null, count: Number(r?.n || 0) }; },
      prune,   // Promise<{deleted, done, chunks}> — 청크 사이에 양보한다
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
  if (!ready) ready = retryOnLock(initSqlite, { tag: 'ping' }).catch((err) => { console.warn(`[ping] node:sqlite 불가(${err.code || err.message}); NDJSON 폴백.`); return initJson(); });
  impl = await ready;
  return impl;
}
