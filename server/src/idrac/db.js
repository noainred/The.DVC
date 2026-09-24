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
import { shouldStore, policyFromEnv } from '../metrics/deadband.js';   // v2.451: 변화분만 저장
import path from 'node:path';
import { config } from '../config.js';
import { chunkedDelete } from '../util/chunkedPrune.js';
import { openSqlite, retryOnLock } from '../util/sqliteOpen.js';   // v2.599 DB2599-02: 첫 open 잠금 → 기다렸다 재시도(NDJSON 폴백 래치 금지)

const DB_PATH = config.idrac.dbPath;
const deadbandPolicy = policyFromEnv();

let impl = null; // chosen backend

function initSqlite() {
  // node:sqlite import throws if the experimental flag is missing — caught below.
  // eslint-disable-next-line import/no-unresolved
  return import('node:sqlite').then(({ DatabaseSync }) => {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const db = openSqlite(new DatabaseSync(DB_PATH));   // busy_timeout 먼저 · 잠금이면 닫고 던진다
    // WAL + synchronous=NORMAL: 커밋당 fsync 2회(DELETE 저널) → 배치화(단건 insert 5ms→0.01ms 실측).
    // busy_timeout: 동시 접근 시 즉시 SQLITE_BUSY 실패 대신 대기.
    db.exec(`
      CREATE TABLE IF NOT EXISTS power_samples (
        server_id TEXT NOT NULL,
        watts INTEGER NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_power_server_ts ON power_samples (server_id, ts);
      CREATE INDEX IF NOT EXISTS idx_power_ts ON power_samples (ts);
      -- 시간당 롤업(전력 대시보드 집계 가속): 원시 power_samples 24h 스캔(90일 수렴 시 수억 행,
      -- 캐시 미스 첫 요청이 초 단위 블로킹) 대신, (server_id, 시간버킷)별 합/개수/최대/최소/최근ts를
      -- 증분 유지해 24h 통계를 ~24행 스캔으로 계산한다. 원시 테이블은 상세 차트(history)용으로 유지.
      CREATE TABLE IF NOT EXISTS power_hourly (
        server_id TEXT NOT NULL,
        hb INTEGER NOT NULL,        -- floor(ts / 3600000) 시간 버킷
        sumw INTEGER NOT NULL,
        cnt INTEGER NOT NULL,
        maxw INTEGER NOT NULL,
        minw INTEGER NOT NULL,
        last_ts INTEGER NOT NULL,
        PRIMARY KEY (server_id, hb)
      );
      CREATE INDEX IF NOT EXISTS idx_power_hourly_hb ON power_hourly (hb);
    `);
    // 구버전 DB(원시 샘플만 있고 롤업이 비어 있음) 최초 마이그레이션: 기존 원시 데이터를 1회 백필.
    // (풀스캔 1회 — 신규 설치는 원시가 비어 즉시 통과, 기존 설치는 기동 시 1회만 수행.)
    try {
      const hh = db.prepare('SELECT COUNT(*) AS n FROM power_hourly').get();
      if (!hh.n) {
        const ps = db.prepare('SELECT COUNT(*) AS n FROM power_samples').get();
        if (ps.n) {
          db.exec(`INSERT INTO power_hourly (server_id, hb, sumw, cnt, maxw, minw, last_ts)
            SELECT server_id, CAST(ts / 3600000 AS INTEGER) AS hb, SUM(watts), COUNT(*), MAX(watts), MIN(watts), MAX(ts)
            FROM power_samples GROUP BY server_id, hb`);
          console.log('[idrac] power_hourly 롤업 백필 완료(구버전 원시 데이터 → 시간당 집계).');
        }
      }
    } catch (e) { console.warn('[idrac] power_hourly 백필 실패(무시, 이후 증분으로 채워짐):', e.message); }
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
    // 청크 DELETE (v2.453) — metrics/db.js 와 같은 이유. idrac-power.db 도 운영 실측 26.9GB 라
    // 한 방 DELETE 는 이벤트 루프를 수 분 멈춘다. rowid 서브쿼리 + LIMIT 으로 끊는다.
    const pruneStmt = db.prepare('DELETE FROM power_samples WHERE rowid IN (SELECT rowid FROM power_samples WHERE ts < ? LIMIT ?)');
    // 집계(전력 대시보드): 서버별 24h 피크/평균/최소/마지막 + 시간버킷 평균 — SQL GROUP BY로 효율 계산.
    // 비-시간 버킷(예외적)만 원시 테이블에서 계산 — 현재 대시보드는 항상 1시간 버킷이라 롤업 사용.
    const bucketStmt = db.prepare('SELECT server_id, CAST(ts / ? AS INTEGER) AS bk, AVG(watts) AS avgw FROM power_samples WHERE ts >= ? GROUP BY server_id, bk');
    const idsStmt = db.prepare('SELECT DISTINCT server_id AS id FROM power_samples');
    const delOneStmt = db.prepare('DELETE FROM power_samples WHERE server_id = ?');
    // ── 시간당 롤업 문장 ──
    const HOUR_MS = 3_600_000;
    // 증분 upsert: 같은 (server_id, 시간버킷)이면 합/개수 누적, 최대/최소/최근ts 갱신.
    const rollupStmt = db.prepare(`
      INSERT INTO power_hourly (server_id, hb, sumw, cnt, maxw, minw, last_ts)
      VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(server_id, hb) DO UPDATE SET
        sumw = sumw + excluded.sumw,
        cnt = cnt + 1,
        maxw = CASE WHEN excluded.maxw > maxw THEN excluded.maxw ELSE maxw END,
        minw = CASE WHEN excluded.minw < minw THEN excluded.minw ELSE minw END,
        last_ts = CASE WHEN excluded.last_ts > last_ts THEN excluded.last_ts ELSE last_ts END`);
    const rollupOne = (serverId, watts, ts) => rollupStmt.run(serverId, Math.floor(ts / HOUR_MS), watts, watts, watts, ts);
    // 24h 통계를 시간당 롤업에서 계산: peak=MAX(maxw), min=MIN(minw), avg=SUM(sumw)/SUM(cnt), last=MAX(last_ts).
    const statsHourlyStmt = db.prepare('SELECT server_id, MAX(maxw) AS peak, MIN(minw) AS minw, SUM(sumw) AS sumw, SUM(cnt) AS cnt, MAX(last_ts) AS last FROM power_hourly WHERE hb >= ? GROUP BY server_id');
    const bucketsHourlyStmt = db.prepare('SELECT server_id, hb, sumw, cnt FROM power_hourly WHERE hb >= ?');
    const pruneHourlyStmt = db.prepare('DELETE FROM power_hourly WHERE rowid IN (SELECT rowid FROM power_hourly WHERE hb < ? LIMIT ?)');
    const delOneHourlyStmt = db.prepare('DELETE FROM power_hourly WHERE server_id = ?');
    // v2.599 DB2599-01: 롤업의 서버별 마지막 관측 시각 — dead-band 로 원시 저장을 건너뛴 표본도 롤업에는 들어가므로
    // power_samples 의 MAX(ts) 보다 늦을 수 있다. 기동 시드(withLatestCache)가 이 값을 함께 봐야 재시작 직후
    // 엣지가 같은 ts 로 다시 주는 표본(puller 의 sTs <= prevTs 중복 검사)을 걸러낸다. 최근 구간만 본다(기동 1회).
    const lastTsHourlyStmt = db.prepare('SELECT server_id, MAX(last_ts) AS ts FROM power_hourly WHERE hb >= ? GROUP BY server_id');
    // dead-band 상태(v2.451): serverId -> 마지막으로 **원본에 저장한** 샘플. 메모리 전용이라
    // 재시작하면 서버당 1행이 한 번 더 저장될 뿐이다. 크기는 등록 서버 수로 유계.
    const lastKeptW = new Map();
    let _skippedW = 0;
    return {
      kind: 'sqlite',
      insert: (serverId, watts, ts) => { const r = insertStmt.run(serverId, watts, ts); rollupOne(serverId, watts, ts); return r; },
      // 다수 샘플을 한 트랜잭션으로 적재(매 폴 590+ 호스트 기록이 이벤트 루프를 막지 않게).
      // 원시 + 시간당 롤업을 같은 트랜잭션에서 갱신해 항상 정합(원시와 집계가 어긋나지 않음).
      insertMany: (samples) => {
        if (!samples || !samples.length) return 0;
        // v2.451 — **변화분만 원본에 저장**(dead-band, metrics/deadband.js 와 같은 규약).
        // 유휴 서버의 소비전력은 몇 W 안에서만 진동하는데 매 폴마다 전량 적재돼
        // idrac-power.db 가 26.9GB 까지 자랐다(운영 실측).
        // 시간당 롤업(power_hourly)은 **생략분까지 전부** 갱신하므로 대시보드의 24h 피크·평균·
        // 최소는 정확히 유지된다(집계는 롤업에서 계산한다 — statsHourlyStmt 참조).
        db.exec('BEGIN');
        try {
          for (const s of samples) {
            const prev = lastKeptW.get(s.serverId) || null;
            if (shouldStore(prev, { v: s.watts, ts: s.ts }, deadbandPolicy.power)) {
              insertStmt.run(s.serverId, s.watts, s.ts);
              lastKeptW.set(s.serverId, { v: s.watts, ts: s.ts });
            } else { _skippedW++; }
            rollupOne(s.serverId, s.watts, s.ts);   // 롤업은 전량
          }
          db.exec('COMMIT');
        } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; }
        return samples.length;
      },
      /** 진단용 — dead-band 로 생략한 누적 샘플 수. */
      deadbandSkipped: () => _skippedW,
      serverIds: () => idsStmt.all().map((r) => r.id),
      deleteServers: (ids) => { let n = 0; db.exec('BEGIN'); try { for (const id of ids) { n += delOneStmt.run(id).changes || 0; delOneHourlyStmt.run(id); } db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; } return n; },
      latest: (serverId) => latestStmt.get(serverId) || null,
      latestAll: () => {
        const map = new Map();
        for (const r of latestAllStmt.all()) map.set(r.server_id, { watts: r.watts, ts: r.ts });
        return map;
      },
      /** 롤업 기준 서버별 마지막 관측 ts(dead-band 생략분 포함) — withLatestCache 시드 보정용. */
      lastSeenTsAll: (nowMs = Date.now()) => {
        const windowMs = Math.max(48 * HOUR_MS, (deadbandPolicy.power?.maxGapMs || 0) + 2 * HOUR_MS);
        const map = new Map();
        for (const r of lastTsHourlyStmt.all(Math.floor((nowMs - windowMs) / HOUR_MS))) if (r.ts != null) map.set(r.server_id, r.ts);
        return map;
      },
      history: (serverId, sinceTs, limit) => historyStmt.all(serverId, sinceTs, limit).reverse(),
      // 시간당 롤업에서 계산(24h 윈도우 ≈ 24 시간버킷 스캔). 윈도우는 시간 단위로 정렬됨(대시보드 집계엔 무해).
      statsSince: (sinceTs) => {
        const hbSince = Math.floor(sinceTs / HOUR_MS);
        const m = new Map();
        for (const r of statsHourlyStmt.all(hbSince)) m.set(r.server_id, { peak: Math.round(r.peak), min: Math.round(r.minw), avg: Math.round(r.sumw / r.cnt), last: r.last, count: r.cnt });
        return m;
      },
      bucketsSince: (sinceTs, bucketMs) => {
        if (bucketMs === HOUR_MS) {
          const hbSince = Math.floor(sinceTs / HOUR_MS);
          return bucketsHourlyStmt.all(hbSince).map((r) => ({ serverId: r.server_id, bucket: r.hb * HOUR_MS, avg: r.sumw / r.cnt }));
        }
        // 비-시간 버킷은 원시 테이블에서(현재 대시보드는 항상 1시간이라 이 경로는 예외적).
        return bucketStmt.all(bucketMs, sinceTs).map((r) => ({ serverId: r.server_id, bucket: r.bk * bucketMs, avg: r.avgw }));
      },
      // v2.451: 원본과 롤업의 보존기간 분리(metrics/db.js 와 같은 규약).
      // rollupBeforeTs 생략 시 기존 동작(둘 다 같은 기준).
      prune: async (beforeTs, rollupBeforeTs = null) => {
        const r = await chunkedDelete(pruneStmt, [beforeTs], { label: 'idrac.power_samples' });
        if (r.deleted > 0) console.log(`[idrac] 전력 원본 prune ${r.deleted.toLocaleString()}행 삭제(${r.chunks}청크)${r.done ? '' : ' — 상한 도달, 다음 주기에 계속'}`);
        const rb = rollupBeforeTs == null ? beforeTs : rollupBeforeTs;
        try { await chunkedDelete(pruneHourlyStmt, [Math.floor(rb / HOUR_MS)], { label: 'idrac.power_hourly' }); }
        catch (e) { console.warn(`[idrac] 롤업 prune 실패: ${e.message}`); }
        return r.deleted;
      },
    };
  });
}

function initJsonFallback() {
  const file = DB_PATH.replace(/\.db$/, '') + '.ndjson';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // SQLite 없이 동작하는 폴백이라 prune만으로는 상한이 없다(90일 보존·다수 서버면 수백만 행이
  // 전부 RAM 상주 → OOM 위험). ts 오름차순 append 특성을 이용해 상한 초과 시 가장 오래된 행을
  // 잘라내고 파일도 재기록한다(newest 우선 보존). SQLite가 정상이면 이 경로는 애초에 안 탄다.
  const MAX_ROWS = Number(process.env.POWER_NDJSON_MAX_ROWS) || 2_000_000;
  let rows = [];
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r && r.s) rows.push(r); } catch { /* skip */ }
    }
  }
  const rewrite = () => { try { fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); } catch { /* best effort */ } };
  // 상한 초과 시 오래된 앞부분을 10% 잘라 파일 재기록(잦은 재기록 방지 위해 여유분을 남긴다).
  const capRows = () => { if (rows.length > MAX_ROWS) { rows = rows.slice(rows.length - Math.floor(MAX_ROWS * 0.9)); rewrite(); } };
  return {
    kind: 'json',
    insert: (serverId, watts, ts) => {
      const r = { s: serverId, w: watts, t: ts };
      rows.push(r);
      try { fs.appendFileSync(file, JSON.stringify(r) + '\n', { mode: 0o600 }); } catch { /* best effort */ }
      capRows();
    },
    insertMany: (samples) => {
      if (!samples || !samples.length) return 0;
      const lines = [];
      for (const s of samples) { const r = { s: s.serverId, w: s.watts, t: s.ts }; rows.push(r); lines.push(JSON.stringify(r)); }
      try { fs.appendFileSync(file, lines.join('\n') + '\n', { mode: 0o600 }); } catch { /* best effort */ }
      capRows();
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
  // v2.599 DB2599-01: 시드는 power_samples 만 보므로 dead-band 로 원시 저장을 건너뛴 마지막 표본의 ts 를 모른다.
  // 재시작 직후 puller 가 엣지의 같은 표본을 '새 것' 으로 받아 롤업(power_hourly)에 한 번 더 더했다(재현: cnt 2→3).
  // 롤업의 마지막 관측 ts 가 더 늦으면 ts 만 앞당긴다 — 값(watts)은 생략 판정상 저장값과 dead-band 이내다.
  try {
    const seen = typeof db.lastSeenTsAll === 'function' ? db.lastSeenTsAll() : null;
    if (seen) for (const [id, ts] of seen) { const cur = cache.get(id); if (cur && ts > cur.ts) cache.set(id, { watts: cur.watts, ts }); }
  } catch (e) { console.warn('[idrac] 최신 캐시 롤업 보정 실패(무시):', e.message); }
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
    // prune으로 beforeTs 이전 행이 전부 지워진 서버(죽은 서버)는 캐시에서도 축출한다.
    // 안 그러면 latest/latestAll이 사라진 서버의 낡은 최신값을 영원히 반환한다.
    prune: async (beforeTs, rollupBeforeTs = null) => { const r = await db.prune(beforeTs, rollupBeforeTs); for (const [id, v] of cache) if (v.ts < beforeTs) cache.delete(id); return r; },
    latest: (serverId) => cache.get(serverId) || null,
    latestAll: () => new Map(cache),
  };
}

/** Lazily initialize and memoize the storage backend (single-flight — 동시 첫 호출 시 이중 커넥션 방지). */
let ready = null;
export async function getDb() {
  if (impl) return impl;
  if (!ready) {
    ready = retryOnLock(initSqlite, { tag: 'idrac' }).then((db) => {
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
