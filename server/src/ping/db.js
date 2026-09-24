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
      -- v2.604(감사 DB2604-01): 대상별 시간당 롤업. 30일·365일 개요가 원시 표본(대상당 1년 ≈ 52만 행)을
      -- GROUP BY 해 28대상에 10초 동안 루프를 막았다. 적재 트랜잭션 안에서 upsert 하고, 장기 범위는 이것을 읽는다.
      -- rtt_sum/rtt_n 은 ok=1 이고 rtt 가 있는 표본만 — 원시 쿼리의 AVG(CASE WHEN ok=1 THEN rtt END) 와 같은 값이다.
      CREATE TABLE IF NOT EXISTS samples_hourly (
        target TEXT NOT NULL, h INTEGER NOT NULL, n INTEGER NOT NULL, fail INTEGER NOT NULL,
        rtt_sum REAL NOT NULL, rtt_n INTEGER NOT NULL, mn REAL, mx REAL, PRIMARY KEY (target, h)
      );
      CREATE INDEX IF NOT EXISTS idx_ping_hourly_h ON samples_hourly (h); -- 롤업 prune(h<?)
      CREATE TABLE IF NOT EXISTS ping_meta (k TEXT PRIMARY KEY, v TEXT);
    `);
    try { fs.chmodSync(DB_PATH, 0o600); } catch { /* best effort */ }
    const ins = db.prepare('INSERT INTO samples (target, ts, rtt, ok) VALUES (?, ?, ?, ?)');
    // 롤업 upsert — 표본 1건을 그 시간 칸에 더한다. ⚠ SQL MIN/MAX 는 인자 하나가 NULL 이면 NULL 이므로 IFNULL 로 감싼다.
    const hourUp = db.prepare(`INSERT INTO samples_hourly (target, h, n, fail, rtt_sum, rtt_n, mn, mx) VALUES (?, ?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(target, h) DO UPDATE SET n = n + 1, fail = fail + excluded.fail,
        rtt_sum = rtt_sum + excluded.rtt_sum, rtt_n = rtt_n + excluded.rtt_n,
        mn = CASE WHEN excluded.mn IS NULL THEN mn WHEN mn IS NULL THEN excluded.mn ELSE MIN(mn, excluded.mn) END,
        mx = CASE WHEN excluded.mx IS NULL THEN mx WHEN mx IS NULL THEN excluded.mx ELSE MAX(mx, excluded.mx) END`);
    const addHour = (target, ts, rtt, ok) => {
      const good = ok && rtt != null && Number.isFinite(Number(rtt));
      const v = good ? Number(rtt) : null;
      hourUp.run(target, Math.floor(ts / HOUR_MS) * HOUR_MS, ok ? 0 : 1, good ? v : 0, good ? 1 : 0, v, v);
    };
    // 롤업에서 원시와 같은 모양의 버킷을 만든다(bucketMs 는 HOUR_MS 의 배수여야 한다 — 호출부가 맞춘다).
    const hourBucket = db.prepare(`SELECT CAST(h/? AS INTEGER)*? AS b,
        SUM(rtt_sum) s, SUM(rtt_n) rn, MIN(mn) min, MAX(mx) max, SUM(fail) fail, SUM(n) n
      FROM samples_hourly WHERE target=? AND h>=? GROUP BY b ORDER BY b DESC LIMIT ?`);
    const metaGet = db.prepare('SELECT v FROM ping_meta WHERE k=?');
    const metaSet = db.prepare('INSERT INTO ping_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
    // 롤업 시드(구버전 DB) — 여는 시점의 원시 행(rowid ≤ upto)만 청크로 더한다. 그 뒤 적재분은 insertMany 가 이미 더했으므로
    // rowid 경계로 이중 계수를 막는다(시각 경계로는 못 막는다 — 목 시드처럼 옛 시각 표본이 나중에 들어올 수 있다).
    // 진행 위치를 같은 트랜잭션에 남겨 재시작하면 이어서 돈다. 끝나기 전에는 장기 범위도 원시를 읽는다(rollupReady=false).
    const seedChunk = db.prepare(`INSERT INTO samples_hourly (target, h, n, fail, rtt_sum, rtt_n, mn, mx)
      SELECT target, CAST(ts/${HOUR_MS} AS INTEGER)*${HOUR_MS} AS hh, COUNT(*),
        SUM(CASE WHEN ok=1 THEN 0 ELSE 1 END),
        IFNULL(SUM(CASE WHEN ok=1 AND rtt IS NOT NULL THEN rtt END), 0), SUM(CASE WHEN ok=1 AND rtt IS NOT NULL THEN 1 ELSE 0 END),
        MIN(CASE WHEN ok=1 THEN rtt END), MAX(CASE WHEN ok=1 THEN rtt END)
      FROM samples WHERE rowid > ? AND rowid <= ? GROUP BY target, hh
      ON CONFLICT(target, h) DO UPDATE SET n = n + excluded.n, fail = fail + excluded.fail,
        rtt_sum = rtt_sum + excluded.rtt_sum, rtt_n = rtt_n + excluded.rtt_n,
        mn = CASE WHEN excluded.mn IS NULL THEN mn WHEN mn IS NULL THEN excluded.mn ELSE MIN(mn, excluded.mn) END,
        mx = CASE WHEN excluded.mx IS NULL THEN mx WHEN mx IS NULL THEN excluded.mx ELSE MAX(mx, excluded.mx) END`);
    let rollupReady = metaGet.get('rollup_v1')?.v === 'done';
    let rollupSeed = null;   // 진행 중 시드 Promise(테스트·진단용)
    if (!rollupReady) {
      let upto = Number(metaGet.get('rollup_v1_upto')?.v);
      if (!Number.isFinite(upto)) {
        upto = Number(db.prepare('SELECT MAX(rowid) m FROM samples').get()?.m || 0);
        metaSet.run('rollup_v1_upto', String(upto));
      }
      rollupSeed = (async () => {
        let at = Number(metaGet.get('rollup_v1_progress')?.v) || 0;
        while (at < upto) {
          const next = Math.min(upto, at + SEED_CHUNK_ROWS);
          db.exec('BEGIN');
          try { seedChunk.run(at, next); metaSet.run('rollup_v1_progress', String(next)); db.exec('COMMIT'); }
          catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; }
          at = next;
          await new Promise((r) => setImmediate(r));   // 청크 사이 양보 — 시드도 루프를 막지 않는다
        }
        metaSet.run('rollup_v1', 'done');
        rollupReady = true;
      })().catch((e) => { console.warn(`[ping] 시간당 롤업 시드 실패(장기 범위는 원시 표본을 읽는다): ${e?.message || e}`); });
    }
    // 최신 샘플(대상별 1건)
    const latestOne = db.prepare('SELECT rtt, ok, ts FROM samples WHERE target=? ORDER BY ts DESC LIMIT 1');
    // baseline 산출용: 최근 OK 샘플 rtt N개(중앙값은 JS에서)
    // v2.605(감사 DB2605-01 — 재현): ok·rtt 는 인덱스 밖 필터라 OK 가 한 번도 없던 대상(ICMP 차단·폐기)은 LIMIT 이
    //   끝내지 못하고 (target,ts) 인덱스를 이력 끝까지(1년 ≈ 52만 행, 대상당 60~105ms) 훑었다 — /ping/status 15초 폴링마다.
    //   ts 하한(sinceTs)으로 스캔을 유계로 둔다(호출부 service.js BASELINE_LOOKBACK_MS). 하한이 없으면 예전 동작.
    const recentOk = db.prepare('SELECT rtt FROM samples WHERE target=? AND ts>=? AND ok=1 AND rtt IS NOT NULL ORDER BY ts DESC LIMIT ?');
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
    // 롤업은 그 시간 칸 전체가 경계보다 앞일 때만 지운다(h + 1시간 ≤ 경계 — 경계가 걸친 칸은 원시에 표본이 남아 있다).
    const pruneHourChunk = db.prepare('DELETE FROM samples_hourly WHERE rowid IN (SELECT rowid FROM samples_hourly WHERE h < ? LIMIT ?)');
    // 정리끼리는 겹치지 않는다. 같은 경계면 진행 중인 것을 공유하고, 경계가 더 늦으면(보존일을 줄였으면) 끝난 뒤
    // 새 경계로 한 번 더 돈다(RECENT2603-06 과 같은 판단). 호출부(monitor.js)는 기다리지 않으므로 실패는 여기서 남긴다.
    const pruneFlight = createPruneFlight({ covers: (running, next) => running >= next });   // 키 = 경계(ms)
    const prune = (beforeTs) => {
      const cut = Number(beforeTs);
      if (!Number.isFinite(cut)) return Promise.resolve({ deleted: 0, done: true, chunks: 0 });
      return pruneFlight.run(cut, () => chunkedDelete(pruneChunk, [cut], { label: 'ping.samples' })
        .then(async (r) => { await chunkedDelete(pruneHourChunk, [cut - HOUR_MS + 1], { label: 'ping.samples_hourly' }); return r; })
        .catch((e) => { console.warn(`[ping] prune 실패: ${e?.message || e}`); return { deleted: 0, done: false, chunks: 0, error: String(e?.message || e) }; }));
    };
    // v2.603(감사 DB2603-02 후속): 대상 삭제도 그 대상의 전 이력(1분 주기 1년 ≈ 52만 행)을 한 방에 지우면 루프가 멈춘다 —
    // 청크 삭제 + 양보(idx_ping_tgt_ts 가 서브쿼리를 받친다). 대상 하나는 끝까지 지운다(상한 0 — 남기면 고아 이력이 된다).
    // v2.604(감사 RECENT2604-02 — 재현): 삭제는 백그라운드에서 돌므로, 그 사이 **같은 id 로 다시 만든 대상**의 새 표본까지
    //   지웠다(대상 id 는 요청 본문에서 오고 목록에서 빠지면 다시 쓸 수 있다). 삭제 시각을 경계로 둔다(ts ≤ 삭제 시각).
    const dropTargetChunk = db.prepare('DELETE FROM samples WHERE rowid IN (SELECT rowid FROM samples WHERE target=? AND ts<=? LIMIT ?)');
    const dropTargetAllChunk = db.prepare('DELETE FROM samples WHERE rowid IN (SELECT rowid FROM samples WHERE target=? LIMIT ?)');
    const dropHourBefore = db.prepare('DELETE FROM samples_hourly WHERE target=? AND h<?');
    const dropHourAt = db.prepare('DELETE FROM samples_hourly WHERE target=? AND h=?');
    const rebuildHour = db.prepare(`INSERT INTO samples_hourly (target, h, n, fail, rtt_sum, rtt_n, mn, mx)
      SELECT target, ?, COUNT(*), SUM(CASE WHEN ok=1 THEN 0 ELSE 1 END),
        IFNULL(SUM(CASE WHEN ok=1 AND rtt IS NOT NULL THEN rtt END), 0), SUM(CASE WHEN ok=1 AND rtt IS NOT NULL THEN 1 ELSE 0 END),
        MIN(CASE WHEN ok=1 THEN rtt END), MAX(CASE WHEN ok=1 THEN rtt END)
      FROM samples WHERE target=? AND ts>=? AND ts<? GROUP BY target`);
    const dropHourAll = db.prepare('DELETE FROM samples_hourly WHERE target=?');
    // untilTs 를 주지 않으면 그 대상 전부(예전 동작). 라우트는 삭제 시각을 넘긴다.
    const dropTarget = async (target, untilTs = null) => {
      const id = String(target);
      const until = untilTs == null ? null : Number(untilTs);
      const bounded = until != null && Number.isFinite(until);
      const r = bounded
        ? await chunkedDelete(dropTargetChunk, [id, until], { label: 'ping.dropTarget', maxRows: 0 })
        : await chunkedDelete(dropTargetAllChunk, [id], { label: 'ping.dropTarget', maxRows: 0 });
      // 롤업: 경계 이전 칸은 통째로 지우고, 경계가 걸친 칸은 남은 원시(새 대상의 표본)로 다시 만든다 — 동기 한 번이라
      // 그 사이 적재가 끼어들 수 없다.
      db.exec('BEGIN');
      try {
        if (!bounded) dropHourAll.run(id);
        else {
          const hb = Math.floor(until / HOUR_MS) * HOUR_MS;
          dropHourBefore.run(id, hb); dropHourAt.run(id, hb); rebuildHour.run(hb, id, hb, hb + HOUR_MS);
        }
        db.exec('COMMIT');
      } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; }
      return r;
    };
    return {
      kind: 'sqlite',
      insertMany: (rows) => { db.exec('BEGIN'); try { for (const r of rows) { ins.run(r.target, r.ts, r.rtt == null ? null : r.rtt, r.ok ? 1 : 0); addHour(r.target, r.ts, r.rtt, r.ok); } db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; } },
      latest: (target) => { const r = latestOne.get(target); return r ? { rtt: r.rtt, ok: !!r.ok, ts: r.ts } : null; },
      recentOkRtt: (target, limit, sinceTs = 0) => recentOk.all(target, Number.isFinite(Number(sinceTs)) ? Number(sinceTs) : 0, limit).map((r) => r.rtt).filter((v) => v != null),
      history: (target, sinceTs, bucketMs, limit) => bucket.all(bucketMs, bucketMs, target, sinceTs, limit).reverse()
        .map((r) => ({ ts: r.b, avg: round2(r.avg), min: round2(r.min), max: round2(r.max), loss: r.n ? Number((r.fail / r.n).toFixed(3)) : 0, n: Number(r.n) })),
      /** 롤업에서 읽는 버킷 — rollupReady 가 아니면 null(호출부가 원시로 떨어진다). bucketMs 는 HOUR_MS 의 배수. */
      historyHourly: (target, sinceTs, bucketMs, limit) => {
        if (!rollupReady || bucketMs < HOUR_MS || bucketMs % HOUR_MS) return null;
        return hourBucket.all(bucketMs, bucketMs, target, Math.floor(sinceTs / HOUR_MS) * HOUR_MS, limit).reverse()
          .map((r) => ({ ts: r.b, avg: r.rn ? round2(r.s / r.rn) : null, min: round2(r.min), max: round2(r.max), loss: r.n ? Number((r.fail / r.n).toFixed(3)) : 0, n: Number(r.n) }));
      },
      rollupState: () => ({ ready: rollupReady }),
      _rollupSeed: () => rollupSeed,
      meta: (target) => { const r = metaStmt.get(target); return { firstTs: r?.mn ?? null, lastTs: r?.mx ?? null, count: Number(r?.n || 0) }; },
      prune,   // Promise<{deleted, done, chunks}> — 청크 사이에 양보한다
      dropTarget,   // (target, untilTs?) → Promise<{deleted, done, chunks}> — untilTs 를 주면 그 뒤 표본은 남긴다
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
    recentOkRtt: (target, limit, sinceTs = 0) => rows.filter((r) => r.g === target && r.o && r.v != null && r.t >= (Number(sinceTs) || 0)).sort((a, b) => b.t - a.t).slice(0, limit).map((r) => r.v),
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
    historyHourly: () => null,   // 폴백은 롤업이 없다 — 호출부가 history 로 떨어진다
    rollupState: () => ({ ready: false }),
    dropTarget: async (target, untilTs = null) => { const n = rows.filter((r) => r.g !== target || (untilTs != null && r.t > untilTs)); const deleted = rows.length - n.length; if (deleted) { rows = n; try { fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); } catch { /* */ } } return { deleted, done: true, chunks: 1 }; },
  };
}

/** 롤업 칸 크기 — 1시간. 장기 범위의 버킷은 이것의 배수로 맞춘다(ping/service.js). */
export const HOUR_MS = 3_600_000;
const SEED_CHUNK_ROWS = 50_000;   // 청크당 GROUP BY 가 수십 ms 안에 끝나게

const round2 = (x) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(2)));

export async function getPingDb() {
  if (impl) return impl;
  if (!ready) ready = retryOnLock(initSqlite, { tag: 'ping' }).catch((err) => { console.warn(`[ping] node:sqlite 불가(${err.code || err.message}); NDJSON 폴백.`); return initJson(); });
  impl = await ready;
  return impl;
}
