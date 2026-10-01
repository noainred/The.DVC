/**
 * v2.672 — 운영 장애(2026-10-01): /tools/capacity-forecast 가 이벤트 루프를 64~70초씩 반복해서 멈췄다.
 * 원인: 데이터스토어마다 history('ds_usedgb', 120일) 가 롤업 도입 이전 원본으로 폴백(원본 보존 기본 5년 · 분마다 저장)
 *       + 개수 기준 양보(100개마다) + 스냅샷 시각 memo 키(30초마다 새 계산이 겹쳐 시작).
 *  ① historyRollup 은 원본으로 떨어지지 않는다(같은 데이터에서 history() 는 떨어진다 — 재현 조건을 함께 고정)
 *  ② 실제 라우트: history() 호출 0 · 스냅샷이 바뀌어도 다시 세지 않는다(스냅샷 무관 캐시) · 응답에 근거(source·at)
 *  ③ 동시 요청은 계산 1건으로 합친다(single-flight)
 *  ④ 시간 기준 양보 — 계산 중에도 다른 일이 돈다(setImmediate 프로브 — v2.581 규약: 벽시계 타이머로 재지 않는다)
 *  ⑤ 오래된 캐시는 옛 값을 바로 주고 뒤에서 한 번 다시 센다 · DB 를 못 열면 짧게만 기억한다
 *  ⑥ 인사이트 예측(forecastCapacity)도 롤업만 — history() 호출 0 · 버킷은 1시간 정배수
 *  ⑦ 소스 — 세 곳 어디에도 history( 호출이 없다(주석 제거 뒤)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2672-'));
Object.assign(process.env, { CONFIG_DIR: CFG, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', IPAM_WRITE_WORKER: '0' });

const { getMetricsDb } = await import('../src/metrics/db.js');
const { config } = await import('../src/config.js');
const G = await import('../src/tools/dsGrowth.js');
const DAY = 86_400_000;
const HOUR = 3_600_000;
// 경계에서 떨어진 고정 기준(v2.517 규약) — 이 테스트의 점들은 '지금' 기준 과거 일수로만 쓴다.
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;

test('① historyRollup 은 원본으로 떨어지지 않는다 — 같은 데이터에서 history() 는 떨어진다', async () => {
  const db = await getMetricsDb();
  assert.equal(db.kind, 'sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(config.temp.dbPath);
  const k = 'ds-old-raw';
  try {
    // 롤업 도입 이전 원본: 100일 전 ~ 40일 전, 하루 4점(롤업 없음 — 운영 DB 의 상태)
    const ins = raw.prepare('INSERT INTO samples (metric, k, v, ts) VALUES (?, ?, ?, ?)');
    raw.exec('BEGIN');
    for (let d = 100; d > 40; d--) for (let h = 0; h < 4; h++) ins.run('ds_usedgb', k, 1000 + (100 - d), NOW - d * DAY + h * 6 * HOUR);
    raw.exec('COMMIT');
  } finally { raw.close(); }
  // 롤업 도입 이후: 최근 10일은 insertMany(원본 + 롤업)
  for (let d = 10; d >= 1; d--) db.insertMany([{ metric: 'ds_usedgb', k, v: 2000 + d }], NOW - d * DAY);
  const since = NOW - 120 * DAY;
  const viaHistory = db.history('ds_usedgb', k, since, DAY, 200);
  const viaRollup = db.historyRollup('ds_usedgb', k, since, DAY, 200);
  // 재현 조건: history() 는 원본으로 폴백해 100일 전 점까지 준다(운영에서 원본 17만 행을 훑던 경로)
  assert.ok(viaHistory.length >= 60, `history() 가 원본으로 폴백하지 않았다(재현 조건 실패): ${viaHistory.length}`);
  assert.ok(viaHistory[0].ts <= NOW - 90 * DAY);
  // 롤업 전용: 롤업이 있는 최근 10일만
  assert.equal(viaRollup.length, 10);
  assert.ok(viaRollup.every((p) => p.ts >= NOW - 11 * DAY), JSON.stringify(viaRollup[0]));
  // 버킷은 1시간 정배수(90분 → 2시간)
  const b90 = db.historyRollup('ds_usedgb', k, NOW - 2 * DAY, 90 * 60_000, 200);
  assert.ok(b90.every((p) => p.ts % (2 * HOUR) === 0), '90분 버킷이 2시간 정배수로 맞춰지지 않았다');
});

test('② 실제 라우트 — history() 0회 · 스냅샷이 바뀌어도 다시 세지 않는다 · 근거를 싣는다', async () => {
  G._resetDsGrowthForTest();
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { store } = await import('../src/store.js');
  await store.refresh();
  const db = await getMetricsDb();
  const origH = db.history; const origR = db.historyRollup;
  let hCalls = 0; let rCalls = 0;
  db.history = (...a) => { hCalls++; return origH(...a); };
  db.historyRollup = (...a) => { rCalls++; return origR(...a); };
  const app = express(); app.use(express.json());
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  try {
    const dsN = (store.get().datastores || []).length;
    assert.ok(dsN > 5, `목 데이터스토어가 너무 적다: ${dsN}`);
    const r1 = await (await fetch(`${base}/tools/capacity-forecast`)).json();
    assert.equal(r1.items.length, dsN);
    assert.equal(hCalls, 0, '용량 예측이 history()(원본 폴백 가능 경로)를 불렀다');
    assert.equal(rCalls, dsN, '데이터스토어마다 롤업 조회 1회');
    assert.equal(r1.growth.source, 'rollup');
    assert.equal(r1.growth.windowDays, 120);
    assert.ok(Number.isFinite(r1.growth.at));
    assert.ok('growthPoints' in r1.items[0] && 'growthSince' in r1.items[0]);
    // 스냅샷이 바뀌면 memo 키는 바뀐다 — 그래도 증가율은 다시 세지 않는다(사고 원인 ③)
    const gen1 = store.get().generatedAt;
    await new Promise((r) => { setTimeout(r, 15); });
    await store.refresh();
    assert.notEqual(store.get().generatedAt, gen1, '스냅샷이 바뀌지 않았다(테스트 전제)');
    const r2 = await (await fetch(`${base}/tools/capacity-forecast`)).json();
    assert.equal(r2.items.length, (store.get().datastores || []).length);
    assert.equal(rCalls, dsN, '스냅샷이 바뀌었다고 증가율을 다시 셌다');
    assert.equal(hCalls, 0);
    // 범위 계정: 범위 밖 데이터스토어는 나가지 않는다(계산은 한 벌 — 고를 때 거른다)
    const vc = store.get().vcenters[0].id;
    const app2 = express();
    app2.use((req, _res, next) => { req.user = { username: 's', role: 'viewer', scope: { vcenters: [vc] } }; next(); });
    app2.use('/api', api);
    const srv2 = await new Promise((r) => { const s = app2.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const r3 = await (await fetch(`http://127.0.0.1:${srv2.address().port}/api/tools/capacity-forecast`)).json();
      assert.ok(r3.items.length > 0 && r3.items.every((it) => it.vcenterId === vc), '범위 밖 데이터스토어가 나갔다');
      assert.equal(rCalls, dsN, '범위 계정 요청이 증가율을 다시 셌다');
    } finally { srv2.close(); }
  } finally { db.history = origH; db.historyRollup = origR; srv.close(); }
});

/** 가짜 db — 호출 수를 세고, 원하면 한 건마다 바쁜 대기(동기 SQL 흉내). history 는 부르면 실패한다. */
function fakeDb({ busyMs = 0 } = {}) {
  const calls = { rollup: 0, history: 0 };
  return {
    calls,
    history() { calls.history++; throw new Error('history() 를 부르면 안 된다'); },
    historyRollup(_m, k) {
      calls.rollup++;
      if (busyMs > 0) { const t = performance.now(); while (performance.now() - t < busyMs) { /* 동기 SQL 흉내 */ } }
      const n = Number(String(k).replace(/\D/g, '')) || 1;
      return [0, 1, 2, 3].map((i) => ({ ts: NOW - (4 - i) * DAY, avg: 100 + i * n }));
    },
  };
}

test('③ 동시 요청은 계산 1건으로 합친다', async () => {
  G._resetDsGrowthForTest();
  const db = fakeDb();
  const ids = Array.from({ length: 50 }, (_, i) => `ds-${i + 1}`);
  const rs = await Promise.all(Array.from({ length: 6 }, () => G.dsGrowthFor(ids, { db })));
  assert.equal(db.calls.rollup, 50, `동시 6건이 계산을 겹쳐 시작했다: ${db.calls.rollup}`);
  assert.equal(db.calls.history, 0);
  for (const r of rs) assert.equal(r.byId.size, 50);
  assert.equal(rs[0].byId.get('ds-3').slope, 3);   // 하루 3GB 씩(점 4개)
  assert.equal(G.dsGrowthStatus().computes, 1);
});

test('④ 시간 기준 양보 — 계산 중에도 다른 일이 돈다', async () => {
  G._resetDsGrowthForTest();
  const db = fakeDb({ busyMs: 1 });
  const ids = Array.from({ length: 300 }, (_, i) => `ds-${i + 1}`);
  let ticks = 0; let stop = false;
  const probe = () => { if (stop) return; ticks++; setImmediate(probe); };
  setImmediate(probe);
  try { await G.dsGrowthFor(ids, { db, sliceMs: 15 }); } finally { stop = true; }
  const st = G.dsGrowthStatus();
  // 약 300ms 동기 일 → 15ms 마다 양보면 약 20회. 개수 기준(100개마다)이면 2회, 양보가 없으면 0회다.
  assert.ok(st.lastYields >= 10, `양보가 너무 적다: ${st.lastYields}`);
  assert.ok(ticks >= 10, `계산 중 프로브가 거의 돌지 못했다: ${ticks}`);
});

test('⑤ 오래된 캐시는 옛 값을 주고 뒤에서 한 번 다시 센다 · 새 데이터스토어가 많으면 기다린다 · DB 실패는 짧게', async () => {
  G._resetDsGrowthForTest();
  const db = fakeDb();
  const ids = Array.from({ length: 30 }, (_, i) => `ds-${i + 1}`);
  await G.dsGrowthFor(ids, { db, ttlMs: 40 });
  assert.equal(db.calls.rollup, 30);
  await new Promise((r) => { setTimeout(r, 60); });
  const r = await G.dsGrowthFor(ids, { db, ttlMs: 40 });
  assert.equal(r.byId.size, 30, '오래된 캐시라고 빈 결과를 줬다');
  assert.equal(r.stale, true);
  assert.equal(r.refreshing, true, '뒤에서 다시 세지 않았다');
  await new Promise((r2) => { setTimeout(r2, 20); });
  assert.equal(db.calls.rollup, 60);
  // 새 데이터스토어가 많으면(20개 초과) 기다린다 — 비어 있는 추세를 '증가 없음' 으로 보이지 않게
  const more = [...ids, ...Array.from({ length: 40 }, (_, i) => `ds-n${i + 1}`)];
  const r3 = await G.dsGrowthFor(more, { db, ttlMs: 60_000 });
  assert.equal(r3.byId.size, 70);
  // DB 를 못 열면 오류를 밝히고 짧게만(60초) 기억한다 — 기존 값은 지우지 않는다
  const bad = { historyRollup() { throw new Error('x'); } };
  G._resetDsGrowthForTest();
  const r4 = await G.dsGrowthFor(ids, { db: bad });
  assert.equal(r4.byId.size, 0);
  assert.equal(G.dsGrowthStatus().failed, 30);
  // historyRollup 이 없는 구버전 db 객체 — history() 로 되돌리지 않고 오류로 밝힌다
  G._resetDsGrowthForTest();
  const old = { history() { throw new Error('history() 를 부르면 안 된다'); } };
  const r5 = await G.dsGrowthFor(ids, { db: old });
  assert.equal(r5.error, 'rollup-unavailable');
});

test('⑥ 인사이트 예측도 롤업만 — history() 0회 · 버킷 1시간 정배수', async () => {
  const { forecastCapacity } = await import('../src/insights/forecast.js');
  const db = await getMetricsDb();
  const origH = db.history; let hCalls = 0;
  db.history = (...a) => { hCalls++; return origH(...a); };
  try {
    const snap = { datastores: [{ id: 'ds-old-raw', name: 'old', vcenterId: 'vc-a', capacityGB: 5000, usedGB: 2010, usagePct: 40 }] };
    const r = await forecastCapacity(snap, { days: 120, bucketMin: 90, minR2: 0 });
    assert.equal(hCalls, 0, 'forecastCapacity 가 history() 를 불렀다');
    assert.equal(r.config.bucketMin, 120, '90분은 롤업 단위(1시간)로 맞춰 2시간이어야 한다');
    assert.equal(r.config.source, 'rollup');
    assert.equal(r.scannedDatastores, 1);
  } finally { db.history = origH; }
});

test('⑦ 소스 — 용량 예측 경로 세 곳에 history( 호출이 없다', () => {
  const read = (p) => stripComments(fs.readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8'));
  const route = read('routes/api/toolsCapacity.js');
  const body = route.slice(route.indexOf("api.get('/tools/capacity-forecast'"), route.indexOf("api.get('/tools/orphan-vmdk/datastores'"));
  assert.ok(body.length > 200, '라우트 본문을 찾지 못했다');
  assert.doesNotMatch(body, /\.history\(/);
  assert.match(body, /dsGrowthFor\(/);
  assert.doesNotMatch(read('tools/dsGrowth.js'), /\.history\(/);
  assert.doesNotMatch(read('insights/forecast.js'), /\.history\(/);
  assert.match(read('tools/dsGrowth.js'), /createYielder\(/);
});
