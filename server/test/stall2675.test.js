/**
 * v2.675 — 운영 멈춤 후보(사용자 요청 "코드개선" · 범위 '운영 멈춤 후보 우선').
 * 합성 대용량 DB(지표 3,168만 행 · 전력 2,160만 행)에서 잰 멈춤 지점을 고친 것을 고정한다.
 *  ① 최신값 시드(metrics latestAll)는 키를 인덱스로 건너뛴다 — 옛 GROUP BY MAX 와 결과가 같고 훨씬 빠르다
 *  ② historyAllSliced 는 historyAll 과 결과가 같다(버킷 10·7·1·60분·1일 · 상한 · 미래 시각 · 경계 아닌 since) · 조각 사이 양보
 *  ③ metaRange·countAsync 는 meta 와 같다 · keysOf 는 DISTINCT 와 같다(인덱스로 건너뛴다)
 *  ④ 롤업 백필: 시간당 집계 정확 · 중간에 멈춰도 이어진다 · minTs 존중 · 멱등 · 완료 표지 · 이후 history() 가 롤업을 쓴다
 *  ⑤ 백필은 양보한다(setImmediate 프로브 — v2.581 규약) · 디스크 여유 가드 · 빈 env 지연은 미지정
 *  ⑥ iDRAC 최신값 시드 = 옛 GROUP BY MAX · 구버전 DB(롤업 없음) 마이그레이션은 EXISTS 로도 그대로 돈다
 *  ⑦ 이상 탐지는 조각 집계를 쓰고 결과가 예전 경로와 같다
 *  ⑧ 로그인 실패: 대상 판정이 옛 O(n²) 와 같다 · scan 에 rowsMax·days · 라우트는 같은 조건을 기억하고 '지금 분석' 이 비운다
 *  ⑨ 첫 병합 전 골격 · /overview initial · /metrics 생략 · GPU series-meta(meta 0회) · 샘플러 상태 범위 가림
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2675-'));
const IDRAC_DB = path.join(CFG, 'idrac-power-2675.db');
Object.assign(process.env, {
  CONFIG_DIR: CFG, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', IPAM_WRITE_WORKER: '0',
  IDRAC_DB_PATH: IDRAC_DB, METRICS_ALLOW_ANON: 'true', METRICS_ROLLUP_BACKFILL: '0',
});
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
// 경계에서 떨어진 고정 기준(v2.517 규약) — 정시 −30분.
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * MIN;
const { DatabaseSync } = await import('node:sqlite');
const SRC_DIR = new URL('../src/', import.meta.url);
const readSrc = (rel) => fs.readFileSync(new URL(rel, SRC_DIR), 'utf8');

// ⑥ 이 DB 는 어떤 모듈이 먼저 열기 전에 만들어 둔다(구버전 DB: 원본만 있고 롤업이 비어 있다).
{
  const raw = new DatabaseSync(IDRAC_DB);
  raw.exec(`CREATE TABLE power_samples (server_id TEXT NOT NULL, watts INTEGER NOT NULL, ts INTEGER NOT NULL);
    CREATE INDEX idx_power_server_ts ON power_samples (server_id, ts);`);
  const ins = raw.prepare('INSERT INTO power_samples (server_id, watts, ts) VALUES (?, ?, ?)');
  raw.exec('BEGIN');
  for (let i = 0; i < 30; i++) {
    const n = 1 + (i % 7);
    for (let j = 0; j < n; j++) ins.run(`srv-${String(i).padStart(2, '0')}`, 200 + i * 3 + j, NOW - (i * 1_013 + j * 5 * MIN));
  }
  raw.exec('COMMIT');
  raw.close();
}

const { getMetricsDb } = await import('../src/metrics/db.js');
const { config } = await import('../src/config.js');

/** 소스에서 `const <name> = db.prepare(\`…\`)` 의 SQL 을 꺼낸다(실행 계획·시간 비교용). */
function preparedSql(src, name) {
  const m = src.match(new RegExp(`const ${name} = db\\.prepare\\(\`([\\s\\S]*?)\`\\)`));
  assert.ok(m, `${name} 준비문을 찾지 못했다`);
  return m[1];
}
const median3 = (f) => { const t = []; for (let i = 0; i < 3; i++) { const a = performance.now(); f(); t.push(performance.now() - a); } return t.sort((a, b) => a - b)[1]; };
const OLD_LATEST_SQL = `SELECT s.k AS k, s.v AS v, s.ts AS ts FROM samples s
  JOIN (SELECT k, MAX(ts) mts FROM samples WHERE metric=? GROUP BY k) m ON s.k=m.k AND s.ts=m.mts WHERE s.metric=?`;

test('① 최신값 시드 — 옛 GROUP BY MAX 와 같다 · 소스에 GROUP BY 가 없다 · 원본이 많아도 빠르다', async () => {
  const db = await getMetricsDb();
  assert.equal(db.kind, 'sqlite');
  const raw = new DatabaseSync(config.temp.dbPath);
  const M = 'seed_2675';
  try {
    const ins = raw.prepare('INSERT INTO samples (metric, k, v, ts) VALUES (?, ?, ?, ?)');
    raw.exec('BEGIN');
    let x = 7;
    // 키 40개 · 키마다 표본 수와 시각이 다르다(같은 키 안에서 ts 는 겹치지 않게 — 옛 JOIN 은 동률이면 두 행을 준다)
    for (let i = 0; i < 40; i++) {
      const k = `k${String(i).padStart(2, '0')}`;
      for (let j = 0, n = 1 + (i % 9); j < n; j++) { x = (x * 48271) % 2147483647; ins.run(M, k, x % 997, NOW - (i * 997 + j * MIN)); }
    }
    ins.run('other_2675', 'k00', 1, NOW + 5);   // 다른 지표의 키가 섞이지 않는지
    // 시간 비교용: 키 4개 × 원본 5만 행(옛 형태는 지표 원본 전부를 훑는다)
    for (let i = 0; i < 4; i++) for (let j = 0; j < 50_000; j++) ins.run('seedbig_2675', `b${i}`, j % 100, NOW - j * 1_000 - i);
    raw.exec('COMMIT');

    const old = new Map();
    for (const r of raw.prepare(OLD_LATEST_SQL).all(M, M)) old.set(r.k, { v: r.v, ts: r.ts });
    const got = db.latestAll(M);
    assert.equal(got.size, 40);
    assert.deepEqual(got, old);
    assert.equal(db.latestAll('none_2675').size, 0, '없는 지표는 빈 맵(ts=null 행을 싣지 않는다)');

    // 소스 — 시드 준비문에 GROUP BY 가 없다(되돌리면 행 수에 비례한다)
    const src = stripComments(readSrc('metrics/db.js'));
    const newSql = preparedSql(src, 'latestAll');
    assert.doesNotMatch(newSql, /GROUP BY/i, '최신값 시드가 GROUP BY 로 되돌아갔다');
    assert.match(newSql, /WITH RECURSIVE/i);
    // 같은 결과 · 원본 20만 행에서 옛 형태보다 확실히 빠르다(절대 시간이 아니라 비율 — CPU 에 따라 깨지지 않게)
    const stNew = raw.prepare(newSql); const stOld = raw.prepare(OLD_LATEST_SQL);
    const big = (rows) => new Map(rows.filter((r) => r.ts != null).map((r) => [r.k, { v: r.v, ts: r.ts }]));
    assert.deepEqual(big(stNew.all('seedbig_2675')), big(stOld.all('seedbig_2675', 'seedbig_2675')));
    const tOld = median3(() => stOld.all('seedbig_2675', 'seedbig_2675'));
    const tNew = median3(() => stNew.all('seedbig_2675'));
    assert.ok(tOld > tNew * 10, `인덱스 건너뛰기가 옛 형태보다 충분히 빠르지 않다: 옛 ${tOld.toFixed(2)}ms · 새 ${tNew.toFixed(2)}ms`);
  } finally { raw.close(); }
});

test('② historyAllSliced = historyAll — 버킷·상한·미래 시각·경계 아닌 since · 키 순서 · 조각 사이 양보', async () => {
  const db = await getMetricsDb();
  const raw = new DatabaseSync(config.temp.dbPath);
  const M = 'slice_2675';
  try {
    const ins = raw.prepare('INSERT INTO samples (metric, k, v, ts) VALUES (?, ?, ?, ?)');
    raw.exec('BEGIN');
    let x = 11;
    for (let i = 0; i < 25; i++) {
      const k = `h-${String(25 - i).padStart(2, '0')}`;   // 삽입 순서와 정렬 순서가 다르게
      // 30시간 · 불규칙 간격(37~173초) · 정수 값(합이 정확해야 평균 비교가 순서와 무관하다)
      for (let t = NOW - 30 * HOUR + i * 7_001; t < NOW; ) { x = (x * 48271) % 2147483647; ins.run(M, k, x % 100, t); t += 37_000 + (x % 136_000); }
      if (i % 5 === 0) ins.run(M, k, 999, NOW + 3 * HOUR + i);   // 시계가 앞선 표본(미래)
    }
    raw.exec('COMMIT');
    const cases = [
      [10 * MIN, 5000, NOW - 24 * HOUR],
      [7 * MIN, 5000, NOW - 24 * HOUR + 123_457],     // 1시간을 나누지 못하는 버킷 + 경계 아닌 since
      [MIN, 50, NOW - 6 * HOUR],                      // 상한이 실제로 걸린다(키당 50개)
      [60 * MIN, 3, NOW - 30 * HOUR],
      [1440 * MIN, 5000, NOW - 7 * DAY],
      [10 * MIN, 0, NOW - 2 * HOUR],                  // 상한 없음
    ];
    for (const [B, limit, since] of cases) {
      const a = db.historyAll(M, since, B, limit);
      let yields = 0;
      const b = await db.historyAllSliced(M, since, B, limit, { nowTs: NOW, maybeYield: async () => { yields++; } });
      assert.deepEqual(b, a, `버킷 ${B / MIN}분 · 상한 ${limit}: 조각 집계가 한 문장 집계와 다르다`);
      assert.deepEqual([...b.keys()], [...b.keys()].sort(), '키 순서는 historyAll(ORDER BY k)과 같아야 한다');
      if (limit === 50) assert.ok([...b.values()].every((arr) => arr.length === 50), '상한 50 이 걸려야 하는 경우인데 걸리지 않았다(시험 조건)');
      if (NOW - since >= 6 * HOUR && B < HOUR) assert.ok(yields >= 5, `조각 사이에 양보하지 않았다(${yields}회)`);
    }
    // 실제 시계(nowTs 생략)로도 같다 — 미래 표본은 위가 열린 첫 조각에 들어간다
    assert.deepEqual(await db.historyAllSliced(M, NOW - 24 * HOUR, 10 * MIN, 5000), db.historyAll(M, NOW - 24 * HOUR, 10 * MIN, 5000));
  } finally { raw.close(); }
});

test('③ metaRange·countAsync = meta · keysOf = DISTINCT(원본 ∪ 롤업)', async () => {
  const db = await getMetricsDb();
  const raw = new DatabaseSync(config.temp.dbPath);
  try {
    const M = 'slice_2675';
    const m = db.meta(M);
    assert.ok(m.count > 1000);
    assert.deepEqual(db.metaRange(M), { firstTs: m.firstTs, lastTs: m.lastTs });
    for (const sliceMs of [37 * MIN, 6 * HOUR, 999 * DAY]) assert.equal(await db.countAsync(M, { sliceMs, maybeYield: async () => {} }), m.count, `조각 ${sliceMs}ms`);
    assert.equal(await db.countAsync(M), m.count);
    assert.deepEqual(db.metaRange('none_2675'), { firstTs: null, lastTs: null });
    assert.equal(await db.countAsync('none_2675'), 0);
    // keysOf — 롤업에만 있는 키(원본 보존이 더 짧아 원본이 지워진 경우)도 포함한다
    raw.prepare('INSERT INTO samples_hourly (metric, k, h, n, sum, mn, mx) VALUES (?, ?, ?, 1, 1, 1, 1)').run(M, 'only-hourly', NOW - 40 * DAY - 30 * MIN);
    const want = new Set([
      ...raw.prepare('SELECT DISTINCT k FROM samples WHERE metric=?').all(M).map((r) => r.k),
      ...raw.prepare('SELECT DISTINCT k FROM samples_hourly WHERE metric=?').all(M).map((r) => r.k),
    ]);
    assert.ok(want.has('only-hourly'));
    assert.deepEqual(db.keysOf(M), want);
    assert.deepEqual(db.keysOf('none_2675'), new Set());
    // 소스 — keysOf 는 DISTINCT 를 쓰지 않는다 · GPU 표본 수는 meta() 가 아니다
    const src = stripComments(readSrc('metrics/db.js'));
    const keysOfBody = src.slice(src.indexOf('keysOf: (metric) => {'), src.indexOf('metaKey: (metric, k) =>'));
    assert.doesNotMatch(keysOfBody, /DISTINCT/i, 'keysOf 가 DISTINCT(원본 전부)로 되돌아갔다');
  } finally { raw.close(); }
});

/** 원본 행에서 시간당 집계를 직접 계산(기대값). */
function hourlyFromRaw(rows) {
  const m = new Map();
  for (const { v, ts } of rows) {
    const h = Math.floor(ts / HOUR) * HOUR;
    const g = m.get(h) || { n: 0, sum: 0, mn: Infinity, mx: -Infinity };
    g.n++; g.sum += v; g.mn = Math.min(g.mn, v); g.mx = Math.max(g.mx, v); m.set(h, g);
  }
  return m;
}

test('④ 롤업 백필 — 집계 정확 · 중간에 멈춰도 이어진다 · minTs · 멱등 · 완료 표지 · 이후 history() 는 롤업', async () => {
  const db = await getMetricsDb();
  const BF = await import('../src/metrics/rollupBackfill.js');
  BF._resetRollupBackfillForTest();
  const raw = new DatabaseSync(config.temp.dbPath);
  const M = 'bf_2675';
  try {
    const ins = raw.prepare('INSERT INTO samples (metric, k, v, ts) VALUES (?, ?, ?, ?)');
    raw.exec('BEGIN');
    let x = 3;
    const rnd = () => { x = (x * 48271) % 2147483647; return x; };
    // K1: 롤업 도입 이전 원본(10일 전 ~ 3일 전, 2~4분 간격) — 롤업 없음
    for (let t = NOW - 10 * DAY + 17_000; t < NOW - 3 * DAY; t += 120_000 + (rnd() % 120_000)) ins.run(M, 'K1', rnd() % 500, t);
    // K2: 원본만 있고 롤업이 아예 없다(5일 전 ~ 1일 전)
    for (let t = NOW - 5 * DAY + 3_000; t < NOW - DAY; t += 300_000) ins.run(M, 'K2', rnd() % 50, t);
    // K3: 보존 밖(40일 전) + 보존 안(20일 전) — minTs 30일이면 뒤만 옮긴다
    for (let t = NOW - 40 * DAY; t < NOW - 39 * DAY; t += 600_000) ins.run(M, 'K3', 7, t);
    for (let t = NOW - 20 * DAY; t < NOW - 19 * DAY; t += 600_000) ins.run(M, 'K3', 9, t);
    // K5: minTs(30일 전) 를 가로지르는 원본 — 한 걸음(24시간)이 경계를 덮어도 그 시간 이전은 옮기지 않는다
    for (let t = NOW - 30 * DAY - 5 * HOUR; t < NOW - 30 * DAY + 5 * HOUR; t += 600_000) ins.run(M, 'K5', 4, t);
    raw.exec('COMMIT');
    // K1 의 롤업 도입 이후(최근 2일) — insertMany 는 원본과 롤업을 함께 쓴다
    for (let d = 2; d >= 1; d--) db.insertMany([{ metric: M, k: 'K1', v: 600 + d }, { metric: M, k: 'K4', v: 5 }], NOW - d * DAY);
    const hMin = (k) => raw.prepare('SELECT MIN(h) AS mn FROM samples_hourly WHERE metric=? AND k=?').get(M, k)?.mn ?? null;
    const rMin = (k) => raw.prepare('SELECT MIN(ts) AS mn FROM samples WHERE metric=? AND k=?').get(M, k)?.mn ?? null;
    const boundaryK1 = hMin('K1');
    assert.ok(boundaryK1 != null && boundaryK1 > rMin('K1'), '재현 조건: K1 은 롤업이 원본보다 늦게 시작해야 한다(history() 원본 폴백)');
    const expK1 = hourlyFromRaw(raw.prepare('SELECT v, ts FROM samples WHERE metric=? AND k=? AND ts<?').all(M, 'K1', boundaryK1));

    // 중간에 멈춘 실행 흉내 — 직접 두 걸음만(5시간씩)
    const capTs = Math.floor(NOW / HOUR) * HOUR;
    const s1 = db.rollupBackfillStep(M, 'K1', { minTs: 0, chunkHours: 5, capTs });
    const s2 = db.rollupBackfillStep(M, 'K1', { minTs: 0, chunkHours: 5, capTs });
    assert.equal(s1.done, false); assert.equal(s2.done, false);
    assert.ok(hMin('K1') < boundaryK1, '걸음이 롤업의 첫 시각을 앞당기지 않았다');
    // K3·K5 — minTs 30일: 보존 밖은 옮기지 않는다(걸음 수는 묶는다 — 진행하지 못하는 변이가 시험을 매달지 않게)
    const minTs30 = NOW - 30 * DAY;
    const drain = (k) => { let r; let i = 0; do { r = db.rollupBackfillStep(M, k, { minTs: minTs30, chunkHours: 24, capTs }); } while (!r.done && ++i < 100); return i; };
    assert.ok(drain('K3') < 100); assert.ok(drain('K5') < 100);
    const cut = Math.floor(minTs30 / HOUR) * HOUR;
    for (const k of ['K3', 'K5']) {
      assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM samples_hourly WHERE metric=? AND k=? AND h<?').get(M, k, cut).n, 0, `${k}: 보존 밖 원본을 옮겼다`);
      assert.ok(raw.prepare('SELECT COUNT(*) AS n FROM samples_hourly WHERE metric=? AND k=? AND h>=?').get(M, k, cut).n > 0, `${k}: 보존 안 원본을 옮기지 않았다`);
    }

    // 끝까지(양보는 setImmediate — 프로브가 그 사이에 돈다)
    let probes = 0; let stop = false;
    const probe = () => { probes++; if (!stop) setImmediate(probe); };
    setImmediate(probe);
    const st = await BF.runRollupBackfill({ db, workMs: 0.001, restMs: 0, nowTs: NOW, chunkHours: 24 });
    stop = true;
    assert.equal(st.state, 'done', JSON.stringify(st));
    assert.ok(st.keysFilled >= 2 && st.rows > 0 && st.hours > 0, JSON.stringify(st));
    assert.ok(probes >= 5, `백필이 이벤트 루프에 양보하지 않았다(프로브 ${probes}회)`);

    // K1: 롤업 이전 시간 전부가 원본에서 계산한 값과 정확히 같다(멈췄다 이어도 빈 구간·중복 없음)
    const gotK1 = new Map(raw.prepare('SELECT h, n, sum, mn, mx FROM samples_hourly WHERE metric=? AND k=? AND h<?').all(M, 'K1', boundaryK1)
      .map((r) => [r.h, { n: r.n, sum: r.sum, mn: r.mn, mx: r.mx }]));
    assert.equal(gotK1.size, expK1.size, `시간 수가 다르다: ${gotK1.size} vs ${expK1.size}`);
    for (const [h, e] of expK1) assert.deepEqual(gotK1.get(h), e, `시간 ${new Date(h).toISOString()} 집계가 다르다`);
    // K2: 롤업이 아예 없던 키 — 원본 전부가 옮겨졌다(실행 시작 정시 이전만)
    const expK2 = hourlyFromRaw(raw.prepare('SELECT v, ts FROM samples WHERE metric=? AND k=?').all(M, 'K2'));
    const gotK2 = raw.prepare('SELECT h, n, sum, mn, mx FROM samples_hourly WHERE metric=? AND k=?').all(M, 'K2');
    assert.equal(gotK2.length, expK2.size);
    for (const r of gotK2) { assert.ok(r.h < capTs); assert.deepEqual({ n: r.n, sum: r.sum, mn: r.mn, mx: r.mx }, expK2.get(r.h)); }
    // 이후 history() 는 롤업을 쓴다 — implHistory 의 조건(롤업 첫 시간 ≤ 원본 첫 표본)이 참이 됐다
    assert.ok(hMin('K1') <= rMin('K1') && hMin('K2') <= rMin('K2'));
    const since = NOW - 15 * DAY;
    assert.deepEqual(db.history(M, 'K1', since, DAY, 100), db.historyRollup(M, 'K1', since, DAY, 100));
    assert.ok(db.historyRollup(M, 'K1', since, DAY, 100)[0].ts <= NOW - 9 * DAY, '롤업이 옛 구간을 덮지 못했다');

    // 완료 표지 — 다음 실행은 훑지 않는다
    const marker = db.metaValue(BF.BACKFILL_MARKER);
    assert.ok(marker && marker.doneAt && marker.keysFilled === st.keysFilled, JSON.stringify(marker));
    BF._resetRollupBackfillForTest();
    const again = await BF.runRollupBackfill({ db, nowTs: NOW });
    assert.equal(again.state, 'done'); assert.equal(again.steps, 0, '완료 표지가 있는데 다시 훑었다');
    // 멱등 — 강제로 다시 훑어도 아무것도 바뀌지 않는다
    const before = raw.prepare('SELECT COUNT(*) AS n, SUM(n) AS s FROM samples_hourly WHERE metric=?').get(M);
    BF._resetRollupBackfillForTest();
    const forced = await BF.runRollupBackfill({ db, nowTs: NOW, force: true, workMs: 1e9 });
    assert.equal(forced.state, 'done'); assert.equal(forced.rows, 0); assert.equal(forced.hours, 0);
    assert.deepEqual(raw.prepare('SELECT COUNT(*) AS n, SUM(n) AS s FROM samples_hourly WHERE metric=?').get(M), before);
  } finally { raw.close(); BF._resetRollupBackfillForTest(); }
});

test('⑤ 백필 — 디스크 여유 가드(표지 없이 멈춘다) · 빈 env 지연은 미지정 · 끄기 · 샘플러 상태에 실린다', async () => {
  const db = await getMetricsDb();
  const BF = await import('../src/metrics/rollupBackfill.js');
  BF._resetRollupBackfillForTest();
  const markerBefore = db.metaValue(BF.BACKFILL_MARKER);
  const st = await BF.runRollupBackfill({ db, force: true, nowTs: NOW, minFreeBytes: 10 * 1024 ** 3, freeBytes: () => 1024 ** 3 });
  assert.equal(st.state, 'disk-low');
  assert.match(st.lastError, /디스크 여유/);
  assert.equal(st.steps, 0, '여유가 부족한데 걸음을 시작했다');
  assert.deepEqual(db.metaValue(BF.BACKFILL_MARKER), markerBefore, '멈췄는데 완료 표지를 바꿨다');
  // 모르는 여유(statfs 실패 = null)는 막지 않는다
  BF._resetRollupBackfillForTest();
  const st2 = await BF.runRollupBackfill({ db, force: true, nowTs: NOW, minFreeBytes: 10 * 1024 ** 3, freeBytes: () => null, workMs: 1e9 });
  assert.equal(st2.state, 'done');

  // 진행하지 못하는 키(롤업 첫 시각을 앞당기지 못한 걸음)는 영원히 되풀이하지 않고 건너뛰며 센다
  BF._resetRollupBackfillForTest();
  let calls = 0;
  const fake = {
    kind: 'sqlite', metaValue: () => null, setMetaValue: () => {},
    rollupBackfillMetrics: () => ['m'], rollupBackfillKeys: () => ['stuck', 'ok'],
    rollupBackfillStep: (_m, k) => {
      if (++calls > 1000) throw new Error('같은 걸음을 끝없이 되풀이했다');
      if (k === 'stuck') return { done: false, rows: 0, hours: 0 };
      return calls % 2 ? { done: false, rows: 10, hours: 1 } : { done: true, rows: 0, hours: 0 };
    },
  };
  const st3 = await BF.runRollupBackfill({ db: fake, workMs: 1e9 });
  assert.equal(st3.state, 'done', JSON.stringify(st3));
  assert.equal(st3.stuckKeys, 1); assert.equal(st3.keysDone, 2); assert.ok(calls < 10);

  // 끄기 · 빈 지연 env 는 기본(5분)이다 — '지연 0'(기동 직후 첫 수집과 겹침)이 아니다
  BF._resetRollupBackfillForTest();
  const prevOff = process.env.METRICS_ROLLUP_BACKFILL; const prevDelay = process.env.METRICS_ROLLUP_BACKFILL_DELAY_MS;
  try {
    process.env.METRICS_ROLLUP_BACKFILL = '0';
    BF.scheduleRollupBackfill();
    assert.equal(BF.rollupBackfillStatus().state, 'off');
    BF._resetRollupBackfillForTest();
    process.env.METRICS_ROLLUP_BACKFILL = '';
    process.env.METRICS_ROLLUP_BACKFILL_DELAY_MS = '';
    BF.scheduleRollupBackfill();
    assert.equal(BF.rollupBackfillStatus().state, 'waiting');
    await new Promise((r) => { setTimeout(r, 30); });
    assert.equal(BF.rollupBackfillStatus().state, 'waiting', '빈 지연 env 가 0 으로 읽혀 바로 시작했다');
  } finally {
    BF._resetRollupBackfillForTest();
    if (prevOff == null) delete process.env.METRICS_ROLLUP_BACKFILL; else process.env.METRICS_ROLLUP_BACKFILL = prevOff;
    if (prevDelay == null) delete process.env.METRICS_ROLLUP_BACKFILL_DELAY_MS; else process.env.METRICS_ROLLUP_BACKFILL_DELAY_MS = prevDelay;
  }
  // 샘플러 상태에 실리고, 범위 관리자에게는 진행 상태·시각만(키·행 수는 전 함대 집계)
  const { metricsSamplerStatus } = await import('../src/metrics/sampler.js');
  assert.ok('rollupBackfill' in metricsSamplerStatus());
  const { scopeSamplerStatus } = await import('../src/routes/admin/gpuGuest.js');
  const scoped = scopeSamplerStatus({ lastRun: { at: 1, rows: 9 }, rollupBackfill: { state: 'running', startedAt: 5, finishedAt: null, keysTotal: 900, rows: 123456 } }, new Set(['vc-x']));
  assert.deepEqual(scoped.rollupBackfill, { state: 'running', startedAt: 5, finishedAt: null, lastError: null });
  assert.equal(scopeSamplerStatus({ rollupBackfill: { state: 'done', rows: 5 } }, null).rollupBackfill.rows, 5, '전체 범위는 그대로');
});

test('⑥ iDRAC 최신값 시드 = 옛 GROUP BY MAX · 구버전 DB 롤업 마이그레이션은 그대로 돈다 · 소스', async () => {
  const { getDb } = await import('../src/idrac/db.js');
  const db = await getDb();
  const raw = new DatabaseSync(IDRAC_DB);
  try {
    const old = new Map();
    for (const r of raw.prepare(`SELECT s.server_id AS server_id, s.watts AS watts, s.ts AS ts FROM power_samples s
      JOIN (SELECT server_id, MAX(ts) AS mts FROM power_samples GROUP BY server_id) m ON s.server_id = m.server_id AND s.ts = m.mts`).all()) old.set(r.server_id, { watts: r.watts, ts: r.ts });
    assert.equal(old.size, 30);
    assert.deepEqual(db.latestAll(), old);
    // 원본만 있고 롤업이 비어 있던 구버전 DB — EXISTS 로 바꾼 '비었나' 판정이 마이그레이션을 그대로 돌렸다
    const hh = raw.prepare('SELECT COUNT(*) AS n, SUM(cnt) AS c FROM power_hourly').get();
    assert.ok(hh.n > 0, '구버전 DB 의 롤업 마이그레이션이 돌지 않았다');
    assert.equal(hh.c, raw.prepare('SELECT COUNT(*) AS n FROM power_samples').get().n);
  } finally { raw.close(); }
  const src = stripComments(readSrc('idrac/db.js'));
  assert.doesNotMatch(preparedSql(src, 'latestAllStmt'), /GROUP BY/i, 'iDRAC 최신값 시드가 GROUP BY 로 되돌아갔다');
  assert.doesNotMatch(src, /SELECT COUNT\(\*\) AS n FROM power_hourly/, '기동마다 롤업 전부를 세는 COUNT 로 되돌아갔다');
});

test('⑦ 이상 탐지 — 조각 집계를 쓰고 결과가 예전 경로와 같다', async () => {
  const db = await getMetricsDb();
  const raw = new DatabaseSync(config.temp.dbPath);
  try {
    const ins = raw.prepare('INSERT INTO samples (metric, k, v, ts) VALUES (?, ?, ?, ?)');
    raw.exec('BEGIN');
    // temp_host: 24시간 · 10분 간격 · 평소 30±2℃, 'h-spike' 만 마지막 값 70℃
    let x = 5;
    for (const k of ['h-a', 'h-b', 'h-spike']) {
      for (let t = NOW - 23 * HOUR; t < NOW - 10 * MIN; t += 10 * MIN) { x = (x * 48271) % 2147483647; ins.run('temp_host', k, 28 + (x % 5), t); }
      ins.run('temp_host', k, k === 'h-spike' ? 70 : 30, NOW - 5 * MIN);
    }
    raw.exec('COMMIT');
  } finally { raw.close(); }
  const { detectAnomalies } = await import('../src/insights/anomaly.js');
  const origSliced = db.historyAllSliced; const origAll = db.historyAll;
  let sliced = 0; let all = 0;
  db.historyAllSliced = (...a) => { sliced++; return origSliced(...a); };
  db.historyAll = (...a) => { all++; return origAll(...a); };
  try {
    const r1 = await detectAnomalies({});
    assert.ok(sliced >= 4 && all === 0, `조각 집계를 쓰지 않았다(sliced ${sliced} · historyAll ${all})`);
    const fam = r1.families.find((f) => f.metric === 'temp_host');
    assert.ok(fam.items.some((i) => i.key === 'h-spike'), JSON.stringify(fam));
    // 구버전 db 객체(historyAllSliced 없음)면 예전 한 문장 경로 — 결과가 같다
    db.historyAllSliced = undefined;
    const r2 = await detectAnomalies({});
    const strip = (r) => ({ ...r, generatedAt: 0 });
    assert.deepEqual(strip(r2), strip(r1));
  } finally { db.historyAllSliced = origSliced; db.historyAll = origAll; }
});

/** 옛 브루트포스 판정(대상마다 전체 목록 filter·find — O(대상 × 실패)) — 새 한 번 훑기와 결과가 같아야 한다. */
function refOffenders(all, threshold, winCut) {
  const byUser = new Map(); const byIp = new Map();
  const bump = (m, k) => { if (!k) return; m.set(k, (m.get(k) || 0) + 1); };
  for (const f of all) { bump(byUser, f.user); if (f.ip) bump(byIp, f.ip); }
  const offenders = [];
  const offByKey = (label, m) => {
    for (const [key, count] of m) {
      if (count < threshold) continue;
      const recent = all.filter((f) => (label === 'user' ? f.user : f.ip) === key && f.ts >= winCut).length;
      const last = all.find((f) => (label === 'user' ? f.user : f.ip) === key)?.ts;
      offenders.push({ label, key, total: count, recent, active: recent >= threshold, lastTs: last });
    }
  };
  offByKey('user', byUser); offByKey('ip', byIp);
  offenders.sort((a, b) => (b.active - a.active) || (b.recent - a.recent) || (b.total - a.total));
  return offenders;
}

test('⑧ 로그인 실패 — 대상 판정이 옛 O(n²) 와 같다 · scan 에 rowsMax·days · 라우트는 기억하고 \'지금 분석\' 이 비운다', async () => {
  const LF = await import('../src/security/loginFails.js');
  LF._resetLoginFailIncForTest();
  // 계정명을 바꿔 가며 실패하는 스프레이 + 반복 실패 계정 + IP 없는 실패
  const events = [];
  let x = 9;
  for (let i = 0; i < 600; i++) {
    x = (x * 48271) % 2147483647;
    const user = i % 3 === 0 ? `spray${i}` : `user${x % 12}`;
    const ip = i % 7 === 0 ? '' : `10.0.${x % 4}.${(x >> 3) % 9}`;
    events.push({ vcenterId: 'vc-1', ts: NOW - (x % (3 * DAY)) - i, type: 'vim.event.BadUsernameSessionEvent', user, ip, message: `Cannot login ${user}@${ip}` });
  }
  // 활성 창 경계 바로 안쪽(분석 시각 기준) — 창의 기준 시각이 분석 시각(now)이어야 '최근' 으로 센다
  for (let j = 0; j < 4; j++) events.push({ vcenterId: 'vc-1', ts: NOW - 300 * MIN + MIN + j * 1000, type: 'vim.event.BadUsernameSessionEvent', user: 'edge-user', ip: '10.9.9.9', message: 'Cannot login edge-user@10.9.9.9' });
  const fakeDb = {
    loginFailCandidates: (q, lim) => events.filter((e) => e.ts >= q.since && (q.until == null || e.ts <= q.until)).sort((a, b) => b.ts - a.ts).slice(0, lim),
  };
  const res = await LF.analyzeLoginFails({ days: 7, threshold: 4, windowMin: 300 }, { db: fakeDb, now: NOW });
  const all = events.map((e) => ({ ts: e.ts, user: (e.user || '').trim() || '(unknown)', ip: e.ip })).sort((a, b) => b.ts - a.ts);
  const ref = refOffenders(all, 4, NOW - 300 * MIN);
  assert.ok(ref.length > 5 && ref.some((o) => o.active), `시험 조건: 대상이 충분하지 않다(${ref.length})`);
  assert.ok(ref.find((o) => o.key === 'edge-user')?.active, '시험 조건: 경계 안쪽 대상이 활성이어야 한다');
  assert.deepEqual(res.offenders, ref);
  assert.equal(res.scan.rowsMax, LF.LOGIN_FAIL_ROWS_MAX);
  assert.equal(res.scan.days, 7);
  assert.equal(res.summary.total, events.length);

  // 라우트: 같은 조건은 기억한다(같은 generatedAt) · '지금 분석' 이 비운다
  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express(); app.use(express.json());
  app.use((req, _r, n) => { req.user = { username: 'full', role: 'admin', scope: null }; n(); });
  app.use('/api/admin', adminRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api/admin/security/login-fails`;
  try {
    const g1 = await (await fetch(`${base}?days=3`)).json();
    await new Promise((r) => { setTimeout(r, 15); });
    const g2 = await (await fetch(`${base}?days=3`)).json();
    assert.ok(g1.generatedAt > 0);
    assert.equal(g2.generatedAt, g1.generatedAt, '같은 조건인데 다시 분석했다(기억하지 않았다)');
    const g3 = await (await fetch(`${base}?days=2`)).json();
    assert.notEqual(g3.generatedAt, undefined);
    const run = await fetch(`${base}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(run.status, 200);
    await new Promise((r) => { setTimeout(r, 15); });
    const g4 = await (await fetch(`${base}?days=3`)).json();
    assert.ok(g4.generatedAt > g1.generatedAt, "'지금 분석' 뒤에도 옛 결과를 줬다");
  } finally { srv.close(); }
  const src = stripComments(readSrc('routes/admin/backupNetSec.js'));
  assert.match(src, /snapMemo\('loginFails'/);
  assert.match(src, /snapCacheClear\('loginFails'\)/);
  const lfSrc = stripComments(readSrc('security/loginFails.js'));
  assert.doesNotMatch(lfSrc, /all\.filter\(\(f\) => \(label/, '대상마다 전체 목록을 다시 훑는 판정으로 되돌아갔다');
});

test('⑨ 첫 병합 전 골격 · /overview initial · /metrics 생략 · GPU series-meta · 병합 뒤에는 골격을 내지 않는다', async () => {
  const { store } = await import('../src/store.js');
  const { vcAuthGuard } = await import('../src/vcenter/restClient.js');
  assert.ok(!store._merged, '시험 조건: 아직 병합 전이어야 한다');
  const stopped = { id: 'vc-e', name: 'E', host: 'e.example', username: 'svc', password: 'pw' };
  vcAuthGuard.markAuthStopped('vc-e', stopped, 'InvalidLogin');
  const vcs = [
    { id: 'vc-a', name: 'A', location: { region: 'Asia' } },
    { id: 'vc-b', name: 'B', enabled: false },
    { id: 'vc-c', name: 'C', maintenance: true },
    { id: 'vc-d', name: 'D', collectMode: 'site', remoteAgent: 'edge1' },
    stopped,
    null, { name: 'no-id' },
  ];
  assert.equal(store.publishSkeleton(vcs, 'vcenter'), true);
  const snap = store.get();
  assert.equal(snap.initial, true);
  assert.deepEqual(snap.vcenters.map((v) => [v.id, v.status]), [['vc-a', 'pending'], ['vc-b', 'disabled'], ['vc-c', 'maintenance'], ['vc-d', 'pending'], ['vc-e', 'unreachable']]);
  assert.equal(snap.vcenters.find((v) => v.id === 'vc-d').collectSource, 'site');
  assert.ok(snap.vcenters.find((v) => v.id === 'vc-e').authStopped, '자격증명 거부로 멈춘 vCenter 는 기다리면 된다고 말하지 않는다');
  assert.equal(snap.hosts.length + snap.vms.length + snap.datastores.length, 0, '골격에 인벤토리를 실었다');
  const g = snap.rollups?.global || snap.global;
  assert.ok(g, '골격에도 롤업이 있어야 화면이 상태를 센다');
  assert.equal(g.vcentersPending, 2); assert.equal(g.vcentersUnreachable, 1); assert.equal(g.vcentersDisabled, 1); assert.equal(g.vcentersMaintenance, 1);
  assert.ok(!JSON.stringify(snap).includes('"pw"'), '골격에 비밀번호가 실렸다');

  // /overview 는 initial 을 싣는다 · /metrics 는 첫 수집 중 vCenter 를 0 으로 내보내지 않는다
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { metricsExportRouter } = await import('../src/routes/metricsExport.js');
  const app = express(); app.use(express.json());
  app.use((req, _r, n) => { req.user = { username: 'full', role: 'admin', scope: null }; n(); });
  app.use('/metrics', metricsExportRouter);
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const ov = await (await fetch(`${base}/api/overview`)).json();
    assert.equal(ov.initial, true);
    const prom = await (await fetch(`${base}/metrics`)).text();
    assert.doesNotMatch(prom, /vmware_vcenter_up\{vcenter="vc-a"/, '첫 수집 중 vCenter 를 0(다운)으로 내보냈다');
    assert.match(prom, /vmware_vcenter_up\{vcenter="vc-e"[^}]*\} 0/, '연결 실패(인증 정지)는 그대로 0 이다');

    // 병합 뒤: 골격을 다시 내지 않고 initial 도 없다
    await store.refresh();
    assert.equal(store._merged, true);
    assert.equal(store.publishSkeleton(vcs, 'vcenter'), false);
    assert.ok(!store.get().initial);
    const ov2 = await (await fetch(`${base}/api/overview`)).json();
    assert.equal(ov2.initial, undefined);
    const prom2 = await (await fetch(`${base}/metrics`)).text();
    assert.match(prom2, /vmware_vcenter_up\{/);

    // GPU series-meta — meta()(MIN·MAX·COUNT 한 문장)를 부르지 않고 같은 값을 준다 · 같은 값은 기억한다
    const db = await getMetricsDb();
    db.insertMany([{ metric: 'gpu_util', k: 'host-1', v: 10 }, { metric: 'gpu_util', k: 'host-2', v: 20 }], NOW - 2 * HOUR);
    db.insertMany([{ metric: 'gpu_util', k: 'host-1', v: 30 }], NOW - HOUR);
    const want = db.meta('gpu_util');
    const origMeta = db.meta; let metaCalls = 0;
    db.meta = (...a) => { metaCalls++; return origMeta(...a); };
    try {
      const sm = await (await fetch(`${base}/api/tools/gpu/series-meta`)).json();
      assert.deepEqual(sm, { collectedSince: want.firstTs, latestAt: want.lastTs, sampleCount: want.count });
      assert.equal(metaCalls, 0, 'series-meta 가 meta()(원본 전부를 세는 한 문장)를 불렀다');
    } finally { db.meta = origMeta; }
  } finally { srv.close(); vcAuthGuard.clearAuthStop('vc-e'); }
  // 소스 — GPU 내보내기·series-meta 의 meta('gpu_util') 은 구버전 db 폴백 갈래에만 남는다(같은 줄에 metaRange 가 먼저).
  // 소스 — 실제 수집 경로(refresh)는 첫 병합 전에 골격을 먼저 게시한다(목 데이터 경로는 바로 병합이라 위 호출로 시험했다).
  const storeSrc = stripComments(readSrc('store.js'));
  const iSkel = storeSrc.indexOf('if (!this._merged) this.publishSkeleton(vcenters, dataSource);');
  const iCollect = storeSrc.indexOf('const merged = emptySnapshot();');
  assert.ok(iSkel > 0 && iCollect > iSkel, 'refresh 가 첫 병합 전에 골격을 게시하지 않는다');
  const gpuSrc = stripComments(readSrc('routes/api/hardwareGpu.js'));
  const metaLines = gpuSrc.split('\n').filter((l) => l.includes("db.meta('gpu_util')"));
  assert.ok(metaLines.length >= 3, `시험 조건: 갈래 수 ${metaLines.length}`);
  assert.ok(metaLines.every((l) => /metaRange === 'function' \? db\.metaRange\('gpu_util'\) : db\.meta\('gpu_util'\)/.test(l)), "GPU 경로가 meta('gpu_util')(COUNT 포함)로 되돌아갔다");
});
