/**
 * Ping 모니터링 시계열 저장소 — 등록 대상별 RTT/도달성 샘플을 별도 SQLite에 보관한다.
 * iDRAC 전력/온도 DB와 동일하게 node:sqlite(--experimental-sqlite) 사용, 불가 시 NDJSON 폴백.
 *
 * 스키마: samples(target TEXT, ts INTEGER, rtt REAL, ok INTEGER, n, fail, rn, mn, mx). `target`은 대상 id,
 * `rtt`는 응답 지연(ms, 무응답이면 NULL), `ok`는 도달 여부(1/0). 장기 범위는 쿼리에서
 * 시간 버킷 집계(avg/min/max/loss)로 다운샘플한다.
 *
 * v2.963(사용자 요청 "ping 은 중단없이 계속 ping"): 모니터가 대상마다 쉬지 않고 재고(기본 1초) **요약 주기마다 한 줄**을 쓴다 —
 * 그 줄은 n(잰 횟수)·fail(실패 수)·rn(RTT 가 있는 성공 수)·rtt(그 평균)·mn·mx(최저·최고)를 싣는다. 예전 줄(측정 1회 = 1줄)은 이 열이
 * NULL 이고 n=1 · fail=ok?0:1 · rn=(ok∧rtt)?1:0 · mn=mx=rtt 로 읽는다(W_* 식 — 모든 집계가 같은 식을 쓴다). 그래서 손실률은
 * 'NULL 아닌 줄 수' 가 아니라 **SUM(fail)/SUM(n)** 이고, 평균은 **rn 가중**이다. 열 추가는 ALTER TABLE ADD COLUMN(파일을 다시 쓰지 않는다).
 *
 * 성능: WAL + synchronous=NORMAL + busy_timeout(단건 insert 가속), (target,ts)·(ts) 인덱스.
 * prune(ts<?)는 ts 단독 인덱스로 풀스캔을 피한다(복합 (target,ts)로는 못 탐).
 */

import fs from 'node:fs';
import { atomicWriteFileSync } from '../util/atomicWrite.js';   // v2.741(LEFT-13): NDJSON 폴백 재기록은 tmp → rename
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
    // v2.963: 요약 줄 열 — 없으면 추가(예전 DB). ADD COLUMN 은 기존 행을 다시 쓰지 않는다(NULL = 예전 줄).
    const have = new Set(db.prepare('PRAGMA table_info(samples)').all().map((c) => String(c.name)));
    for (const [col, type] of [['n', 'INTEGER'], ['fail', 'INTEGER'], ['rn', 'INTEGER'], ['mn', 'REAL'], ['mx', 'REAL']]) {
      if (!have.has(col)) db.exec(`ALTER TABLE samples ADD COLUMN ${col} ${type}`);
    }
    try { fs.chmodSync(DB_PATH, 0o600); } catch { /* best effort */ }
    const ins = db.prepare('INSERT INTO samples (target, ts, rtt, ok, n, fail, rn, mn, mx) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    // 롤업 upsert — 표본 1건을 그 시간 칸에 더한다. ⚠ SQL MIN/MAX 는 인자 하나가 NULL 이면 NULL 이므로 IFNULL 로 감싼다.
    const hourUp = db.prepare(`INSERT INTO samples_hourly (target, h, n, fail, rtt_sum, rtt_n, mn, mx) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target, h) DO UPDATE SET n = n + excluded.n, fail = fail + excluded.fail,
        rtt_sum = rtt_sum + excluded.rtt_sum, rtt_n = rtt_n + excluded.rtt_n,
        mn = CASE WHEN excluded.mn IS NULL THEN mn WHEN mn IS NULL THEN excluded.mn ELSE MIN(mn, excluded.mn) END,
        mx = CASE WHEN excluded.mx IS NULL THEN mx WHEN mx IS NULL THEN excluded.mx ELSE MAX(mx, excluded.mx) END`);
    // 롤업에 한 줄을 더한다 — 요약 줄(n·fail·rn·mn·mx)은 그 값 그대로, 예전 줄(측정 1회)은 W_* 와 같은 규칙으로.
    const addHour = (r) => {
      const w = weightOf(r);
      hourUp.run(r.target, Math.floor(r.ts / HOUR_MS) * HOUR_MS, w.n, w.fail, w.rn ? w.rtt * w.rn : 0, w.rn, w.mn, w.mx);
    };
    // 롤업에서 원시와 같은 모양의 버킷을 만든다(bucketMs 는 HOUR_MS 의 배수여야 한다 — 호출부가 맞춘다).
    const hourBucket = db.prepare(`SELECT CAST(h/? AS INTEGER)*? AS b,
        SUM(rtt_sum) s, SUM(rtt_n) rn, MIN(mn) min, MAX(mx) max, SUM(fail) fail, SUM(n) n
      FROM samples_hourly WHERE target=? AND h>=? GROUP BY b ORDER BY b DESC LIMIT ?`);
    // v2.890: 끝이 닫힌 창(전송 속도 상세의 '이전 구간') — h < 끝(시간 경계로 내림). 이웃한 두 창이 같은 시간 칸을 두 번 세지 않는다.
    const hourBucketUntil = db.prepare(`SELECT CAST(h/? AS INTEGER)*? AS b,
        SUM(rtt_sum) s, SUM(rtt_n) rn, MIN(mn) min, MAX(mx) max, SUM(fail) fail, SUM(n) n
      FROM samples_hourly WHERE target=? AND h>=? AND h<? GROUP BY b ORDER BY b DESC LIMIT ?`);
    const metaGet = db.prepare('SELECT v FROM ping_meta WHERE k=?');
    const metaSet = db.prepare('INSERT INTO ping_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
    // 롤업 시드(구버전 DB) — 여는 시점의 원시 행(rowid ≤ upto)만 청크로 더한다. 그 뒤 적재분은 insertMany 가 이미 더했으므로
    // rowid 경계로 이중 계수를 막는다(시각 경계로는 못 막는다 — 목 시드처럼 옛 시각 표본이 나중에 들어올 수 있다).
    // 진행 위치를 같은 트랜잭션에 남겨 재시작하면 이어서 돈다. 끝나기 전에는 장기 범위도 원시를 읽는다(rollupReady=false).
    const seedChunk = db.prepare(`INSERT INTO samples_hourly (target, h, n, fail, rtt_sum, rtt_n, mn, mx)
      SELECT target, CAST(ts/${HOUR_MS} AS INTEGER)*${HOUR_MS} AS hh, SUM(${W_N}),
        SUM(${W_F}),
        IFNULL(SUM(CASE WHEN rtt IS NOT NULL THEN rtt * ${W_RN} END), 0), SUM(${W_RN}),
        MIN(${W_MN}), MAX(${W_MX})
      FROM samples WHERE rowid > ? AND rowid <= ? GROUP BY target, hh
      ON CONFLICT(target, h) DO UPDATE SET n = n + excluded.n, fail = fail + excluded.fail,
        rtt_sum = rtt_sum + excluded.rtt_sum, rtt_n = rtt_n + excluded.rtt_n,
        mn = CASE WHEN excluded.mn IS NULL THEN mn WHEN mn IS NULL THEN excluded.mn ELSE MIN(mn, excluded.mn) END,
        mx = CASE WHEN excluded.mx IS NULL THEN mx WHEN mx IS NULL THEN excluded.mx ELSE MAX(mx, excluded.mx) END`);
    let rollupReady = metaGet.get('rollup_v1')?.v === 'done';
    let rollupSeed = null;   // 진행 중 시드 Promise(테스트·진단용)
    // v2.612 DB2612-02: 시드 경계(rowid). samples 는 AUTOINCREMENT 가 아니라 **최대 rowid 행이 지워지면 새 행이 그 rowid 를
    //   재사용**한다 — 시드 중 대상 삭제·정리가 최상위 행을 지운 뒤 적재된 행이 경계 안으로 들어와, addHour 로 한 번·시드로 한 번
    //   더 세였다. 새 행의 rowid 가 경계 이하면 그 위의 원래 행은 전부 지워진 것이므로(rowid = MAX+1) 경계를 rowid−1 로 낮춘다
    //   (insertMany 가 한다 — 삭제 경로가 무엇이든 막힌다).
    let seedUpto = null;
    if (!rollupReady) {
      let upto = Number(metaGet.get('rollup_v1_upto')?.v);
      if (!Number.isFinite(upto)) {
        upto = Number(db.prepare('SELECT MAX(rowid) m FROM samples').get()?.m || 0);
        metaSet.run('rollup_v1_upto', String(upto));
      }
      seedUpto = upto;
      rollupSeed = (async () => {
        let at = Number(metaGet.get('rollup_v1_progress')?.v) || 0;
        while (at < seedUpto) {
          const next = Math.min(seedUpto, at + SEED_CHUNK_ROWS);
          db.exec('BEGIN');
          try { seedChunk.run(at, next); metaSet.run('rollup_v1_progress', String(next)); db.exec('COMMIT'); }
          catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; }
          at = next;
          await new Promise((r) => setImmediate(r));   // 청크 사이 양보 — 시드도 루프를 막지 않는다
        }
        metaSet.run('rollup_v1', 'done');
        rollupReady = true;
        seedUpto = null;
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
    // v2.963: 요약 줄을 가중해 묶는다 — 평균은 rn 가중(s/rn), 손실은 SUM(fail)/SUM(n). 예전 줄은 W_* 가 측정 1회로 읽는다.
    const BUCKET_COLS = `CAST(ts/? AS INTEGER)*? AS b,
        SUM(CASE WHEN rtt IS NOT NULL THEN rtt * ${W_RN} ELSE 0 END) s, SUM(${W_RN}) rn,
        MIN(${W_MN}) min, MAX(${W_MX}) max, SUM(${W_F}) fail, SUM(${W_N}) n`;
    const bucket = db.prepare(`SELECT ${BUCKET_COLS}
      FROM samples WHERE target=? AND ts>=? GROUP BY b ORDER BY b DESC LIMIT ?`);
    // v2.890: 끝이 닫힌 창 [since, until) — (target, ts) 인덱스 범위 하나. 반개구간이라 이웃 창이 경계 표본을 두 번 세지 않는다.
    const bucketUntil = db.prepare(`SELECT ${BUCKET_COLS}
      FROM samples WHERE target=? AND ts>=? AND ts<? GROUP BY b ORDER BY b DESC LIMIT ?`);
    // v2.890: 창 안 성공 RTT(중앙값용 — 호출부가 짧은 창(원시 칸)에서만 부른다: 7일 1분 주기 ≈ 1만 행).
    const okRttWindow = db.prepare('SELECT rtt FROM samples WHERE target=? AND ts>=? AND ts<? AND ok=1 AND rtt IS NOT NULL');
    // 진단·테스트용 건수 포함 meta — 파티션 전체를 훑는다(52만 행 약 40ms). 조회 응답 경로에서 쓰지 말 것.
    const metaStmt = db.prepare('SELECT MIN(ts) mn, MAX(ts) mx, COUNT(*) n FROM samples WHERE target=?');
    // v2.612 LEFT2612-05: 조회 응답(seriesOf)은 bounds 를 쓴다 — aggregate 하나씩은 인덱스 끝만 본다(0.0x ms, v2.550.3 규칙).
    //   건수는 화면이 쓰지 않아(web PingMonitor 가 meta 를 읽지 않는다) 응답에서 null 이다.
    const metaMin = db.prepare('SELECT MIN(ts) mn FROM samples WHERE target=?');
    const metaMax = db.prepare('SELECT MAX(ts) mx FROM samples WHERE target=?');
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
      SELECT target, ?, SUM(${W_N}), SUM(${W_F}),
        IFNULL(SUM(CASE WHEN rtt IS NOT NULL THEN rtt * ${W_RN} END), 0), SUM(${W_RN}),
        MIN(${W_MN}), MAX(${W_MX})
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
      insertMany: (rows) => {
        db.exec('BEGIN');
        try {
          for (const r of rows) {
            const sum = summaryCols(r);
            const info = ins.run(r.target, r.ts, r.rtt == null ? null : r.rtt, r.ok ? 1 : 0, sum.n, sum.fail, sum.rn, sum.mn, sum.mx);
            addHour(r);
            // v2.612 DB2612-02: 재사용된 rowid 가 시드 경계 안이면 경계를 낮춘다(시드가 이 행을 다시 세지 않게).
            if (seedUpto != null) {
              const rid = Number(info?.lastInsertRowid);
              if (Number.isFinite(rid) && rid <= seedUpto) { seedUpto = rid - 1; metaSet.run('rollup_v1_upto', String(seedUpto)); }
            }
          }
          db.exec('COMMIT');
        } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; }
      },
      latest: (target) => { const r = latestOne.get(target); return r ? { rtt: r.rtt, ok: !!r.ok, ts: r.ts } : null; },
      recentOkRtt: (target, limit, sinceTs = 0) => recentOk.all(target, Number.isFinite(Number(sinceTs)) ? Number(sinceTs) : 0, limit).map((r) => r.rtt).filter((v) => v != null),
      // untilTs(v2.890): 주면 [sinceTs, untilTs) — 없으면 예전처럼 끝이 열려 있다. fail(실패 표본 수)은 창 통계가 손실을 정확히 세게 싣는다.
      history: (target, sinceTs, bucketMs, limit, untilTs = null) => (untilOf(untilTs) == null
        ? bucket.all(bucketMs, bucketMs, target, sinceTs, limit)
        : bucketUntil.all(bucketMs, bucketMs, target, sinceTs, untilOf(untilTs), limit)).reverse()
        .map((r) => ({ ts: r.b, avg: r.rn ? round2(r.s / r.rn) : null, min: round2(r.min), max: round2(r.max), loss: r.n ? Number((r.fail / r.n).toFixed(3)) : 0, n: Number(r.n), fail: Number(r.fail) })),
      /** 롤업에서 읽는 버킷 — rollupReady 가 아니면 null(호출부가 원시로 떨어진다). bucketMs 는 HOUR_MS 의 배수. untilTs 는 시간 경계로 내린다. */
      historyHourly: (target, sinceTs, bucketMs, limit, untilTs = null) => {
        if (!rollupReady || bucketMs < HOUR_MS || bucketMs % HOUR_MS) return null;
        const from = Math.floor(sinceTs / HOUR_MS) * HOUR_MS;
        const to = untilOf(untilTs);
        return (to == null
          ? hourBucket.all(bucketMs, bucketMs, target, from, limit)
          : hourBucketUntil.all(bucketMs, bucketMs, target, from, Math.floor(to / HOUR_MS) * HOUR_MS, limit)).reverse()
          .map((r) => ({ ts: r.b, avg: r.rn ? round2(r.s / r.rn) : null, min: round2(r.min), max: round2(r.max), loss: r.n ? Number((r.fail / r.n).toFixed(3)) : 0, n: Number(r.n), fail: Number(r.fail) }));
      },
      /** v2.890: 창 [sinceTs, untilTs) 안 성공 RTT 목록(중앙값 계산용). 호출부가 창 길이를 제한한다. */
      okRttIn: (target, sinceTs, untilTs) => okRttWindow.all(target, sinceTs, untilTs).map((r) => Number(r.rtt)).filter((v) => Number.isFinite(v)),
      rollupState: () => ({ ready: rollupReady }),
      _rollupSeed: () => rollupSeed,
      meta: (target) => { const r = metaStmt.get(target); return { firstTs: r?.mn ?? null, lastTs: r?.mx ?? null, count: Number(r?.n || 0) }; },
      bounds: (target) => ({ firstTs: metaMin.get(target)?.mn ?? null, lastTs: metaMax.get(target)?.mx ?? null, count: null }),
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
  const rewrite = () => { try { atomicWriteFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); } catch (e) { console.warn(`[ping] NDJSON 폴백 재기록 실패(메모리는 정리됨 — 다음 정리 때 다시 씁니다): ${e.message}`); } };
  return {
    kind: 'json',
    insertMany: (recs) => {
      const lines = recs.map((r) => { const c = summaryCols(r); const o = { g: r.target, t: r.ts, v: r.rtt == null ? null : r.rtt, o: r.ok ? 1 : 0 }; if (c.n != null) Object.assign(o, { n: c.n, f: c.fail, rn: c.rn, mn: c.mn, mx: c.mx }); return o; });
      rows.push(...lines);
      try { fs.appendFileSync(file, lines.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); } catch { /* */ }
    },
    latest: (target) => { let best = null; for (const r of rows) if (r.g === target && (!best || r.t > best.t)) best = r; return best ? { rtt: best.v, ok: !!best.o, ts: best.t } : null; },
    recentOkRtt: (target, limit, sinceTs = 0) => rows.filter((r) => r.g === target && r.o && r.v != null && r.t >= (Number(sinceTs) || 0)).sort((a, b) => b.t - a.t).slice(0, limit).map((r) => r.v),
    history: (target, sinceTs, bucketMs, limit, untilTs = null) => {
      const buckets = new Map();
      const to = untilOf(untilTs);
      for (const r of rows) if (r.g === target && r.t >= sinceTs && (to == null || r.t < to)) {
        const b = Math.floor(r.t / bucketMs) * bucketMs; const g = buckets.get(b) || { sum: 0, n: 0, fail: 0, rn: 0, min: Infinity, max: -Infinity };
        const w = weightOf({ rtt: r.v, ok: r.o, n: r.n, fail: r.f, rn: r.rn, mn: r.mn, mx: r.mx });
        g.n += w.n; g.fail += w.fail;
        if (w.rn) { g.rn += w.rn; g.sum += w.rtt * w.rn; }
        if (w.mn != null) g.min = Math.min(g.min, w.mn);
        if (w.mx != null) g.max = Math.max(g.max, w.mx);
        buckets.set(b, g);
      }
      return [...buckets.entries()].sort((a, b) => a[0] - b[0]).slice(-limit).map(([b, g]) => ({
        ts: b, avg: g.rn ? round2(g.sum / g.rn) : null, min: Number.isFinite(g.min) ? round2(g.min) : null, max: Number.isFinite(g.max) ? round2(g.max) : null,
        loss: g.n ? Number((g.fail / g.n).toFixed(3)) : 0, n: g.n, fail: g.fail,
      }));
    },
    okRttIn: (target, sinceTs, untilTs) => rows.filter((r) => r.g === target && r.o && r.v != null && r.t >= sinceTs && r.t < untilTs).map((r) => Number(r.v)),
    bounds: (target) => { let mn = null, mx = null; for (const r of rows) if (r.g === target) { if (mn == null || r.t < mn) mn = r.t; if (mx == null || r.t > mx) mx = r.t; } return { firstTs: mn, lastTs: mx, count: null }; },
    meta: (target) => { let mn = null, mx = null, n = 0; for (const r of rows) if (r.g === target) { n++; if (mn == null || r.t < mn) mn = r.t; if (mx == null || r.t > mx) mx = r.t; } return { firstTs: mn, lastTs: mx, count: n }; },
    // v2.741(감사 LEFT-13): 재기록은 원자적으로(tmp → fsync → rename) — writeFileSync 는 먼저 0바이트로 자르므로 그 사이 종료면 이력을 잃는다.
    prune: (beforeTs) => { const n = rows.filter((r) => r.t >= beforeTs); if (n.length !== rows.length) { rows = n; rewrite(); } },
    historyHourly: () => null,   // 폴백은 롤업이 없다 — 호출부가 history 로 떨어진다
    rollupState: () => ({ ready: false }),
    dropTarget: async (target, untilTs = null) => { const n = rows.filter((r) => r.g !== target || (untilTs != null && r.t > untilTs)); const deleted = rows.length - n.length; if (deleted) { rows = n; rewrite(); } return { deleted, done: true, chunks: 1 }; },
  };
}

/** 롤업 칸 크기 — 1시간. 장기 범위의 버킷은 이것의 배수로 맞춘다(ping/service.js). */
export const HOUR_MS = 3_600_000;
const SEED_CHUNK_ROWS = 50_000;   // 청크당 GROUP BY 가 수십 ms 안에 끝나게

const round2 = (x) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(2)));

/*
 * v2.963 요약 줄 가중 — SQL 과 JS 가 같은 규칙을 쓴다. 예전 줄(n 이 NULL)은 측정 1회:
 *   n=1 · fail=ok?0:1 · rn=(ok ∧ rtt 있음)?1:0 · mn=mx=(ok? rtt : NULL).
 */
const W_N = 'COALESCE(n, 1)';
const W_F = 'COALESCE(fail, CASE WHEN ok=1 THEN 0 ELSE 1 END)';
const W_RN = 'COALESCE(rn, CASE WHEN ok=1 AND rtt IS NOT NULL THEN 1 ELSE 0 END)';
const W_MN = 'COALESCE(mn, CASE WHEN ok=1 THEN rtt END)';
const W_MX = 'COALESCE(mx, CASE WHEN ok=1 THEN rtt END)';
const fin = (v) => { if (v == null) return null; const x = Number(v); return Number.isFinite(x) ? x : null; };
/** 적재할 요약 열 — 요약 줄이 아니면(n 없음) 전부 NULL(예전 줄로 쓴다). */
function summaryCols(r) {
  const n = fin(r?.n);
  if (n == null || n < 1) return { n: null, fail: null, rn: null, mn: null, mx: null };
  const fail = Math.max(0, Math.min(n, Math.floor(fin(r.fail) ?? 0)));
  const rn = Math.max(0, Math.min(n - fail, Math.floor(fin(r.rn) ?? 0)));
  return { n: Math.floor(n), fail, rn, mn: rn ? fin(r.mn) : null, mx: rn ? fin(r.mx) : null };
}
/** 한 줄의 가중값(SQL W_* 와 같은 규칙) — 롤업 적재·NDJSON 폴백이 쓴다. */
export function weightOf(r) {
  const c = summaryCols(r);
  const rtt = fin(r?.rtt);
  if (c.n != null) return { n: c.n, fail: c.fail, rn: rtt == null ? 0 : c.rn, rtt, mn: c.mn, mx: c.mx };
  const ok = !!r?.ok && r?.ok !== 0;
  const good = ok && rtt != null;
  return { n: 1, fail: ok ? 0 : 1, rn: good ? 1 : 0, rtt, mn: good ? rtt : null, mx: good ? rtt : null };
}
/** 창 끝(ms) — 숫자가 아니면 null(끝이 열린 예전 동작). */
const untilOf = (v) => { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

export async function getPingDb() {
  if (impl) return impl;
  if (!ready) ready = retryOnLock(initSqlite, { tag: 'ping' }).catch((err) => { console.warn(`[ping] node:sqlite 불가(${err.code || err.message}); NDJSON 폴백.`); return initJson(); });
  impl = await ready;
  return impl;
}
