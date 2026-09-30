/**
 * v2.670 — 경영 보기 Overview 추이(/overview/trend, overview/trend.js).
 *  ① 격자: 7일=14칸(12시간) · 30일=30칸 · 90일=60칸, 모르는 기간은 7일
 *  ② VM: 버킷마다 마지막 슬롯 · 빠진 vCenter 가 있는 슬롯은 null(부분 합 금지)
 *  ③ 스토리지: 빠진 장비·사용량 미상 버킷은 null
 *  ④ 전력: 보고 서버 수가 창 안 최대의 90% 미만이면 null · 증감은 첫/마지막 유효 점
 *  ⑤ 실제 전력 DB(fleetBuckets) — 버킷마다 서버별 평균의 합
 *  ⑥ 실제 라우트 — 스토리지·전력은 범위 계정에 null + 사유, 물리 서버는 추이를 만들지 않는다
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2670-'));
Object.assign(process.env, { CONFIG_DIR: CFG, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', IPAM_WRITE_WORKER: '0' });

const T = await import('../src/overview/trend.js');
const H = 3_600_000;
// 경계에서 떨어진 고정 기준 시각(v2.517 규약 — Date.now() 를 기준으로 쓰지 않는다)
const NOW = Math.floor(1_790_000_000_000 / (36 * H)) * (36 * H) + 5 * H;

test('① 격자 크기', () => {
  assert.equal(T.trendGrid(7, NOW).length, 14);
  assert.equal(T.trendGrid(30, NOW).length, 30);
  assert.equal(T.trendGrid(90, NOW).length, 60);
  assert.equal(T.normTrendDays('45'), 7);
  const g = T.trendGrid(7, NOW);
  assert.ok(g[13] <= NOW && NOW < g[13] + 12 * H, '마지막 칸이 지금을 담는다');
});

test('② VM — 마지막 슬롯 · 부분 합은 null', () => {
  const g = T.trendGrid(7, NOW);
  const pts = [
    { ts: g[0] + H, total: 100, skipped: 0 },
    { ts: g[1] + H, total: 90, skipped: 1 },      // 빠진 vCenter 가 있는 슬롯 — '감소' 로 그리지 않는다
    { ts: g[2] + H, total: 105, skipped: 0 },
    { ts: g[2] + 2 * H, total: 106, skipped: 0 },  // 같은 버킷의 더 늦은 슬롯이 이긴다
  ];
  const s = T.vmTrend(pts, 7, NOW);
  assert.equal(s[0].v, 100);
  assert.equal(s[1].v, null); assert.equal(s[1].partial, true);
  assert.equal(s[2].v, 106);
  assert.equal(s[3].v, null);
  assert.deepEqual(T.deltaOf(s), { first: 100, last: 106, diff: 6, firstTs: g[0], lastTs: g[2], points: 2 });
  assert.equal(T.partialCount(s), 1);
  assert.equal(T.deltaOf([{ v: 1 }]), null);
});

test('③ 스토리지 — 빠진 장비·사용량 미상 버킷은 null', () => {
  const g = T.trendGrid(7, NOW);
  const s = T.storageTrend([
    { ts: g[0], used_bytes: 5e12, missing: 0, used_unknown: 0 },
    { ts: g[1], used_bytes: 3e12, missing: 1, used_unknown: 0 },
    { ts: g[2], used_bytes: null, missing: 0, used_unknown: 1 },
    { ts: g[3], used_bytes: 6e12, missing: 0, used_unknown: 0 },
  ], 7, NOW);
  assert.deepEqual(s.slice(0, 4).map((p) => p.v), [5e12, null, null, 6e12]);
  assert.equal(T.partialCount(s), 2);
});

test('④ 전력 — 표본 시간 · 90% 미만 시간은 버린다', () => {
  const g = T.trendGrid(7, NOW);
  const hbs = T.powerSampleHours(7, NOW);
  assert.ok(hbs.length <= 14 * 2 && hbs.every((hb) => hb * H <= NOW), '칸마다 2시간 · 미래 시간 없음');
  const hb = (t, i) => Math.floor(t / H) + i;
  const r = T.powerTrend([
    { hb: hb(g[0], 1), watts: 100_000, servers: 100 }, { hb: hb(g[0], 4), watts: 102_000, servers: 100 },
    { hb: hb(g[1], 1), watts: 50_000, servers: 50 },          // 서버 절반만 보고한 시간 — 칸 전체가 비면 partial
    { hb: hb(g[2], 1), watts: 99_000, servers: 90 }, { hb: hb(g[2], 4), watts: 40_000, servers: 40 }, // 90% 인 시간만 쓴다
    { hb: hb(g[0], 0) - 10 * 24, watts: 1, servers: 500 },   // 창 밖 — 최대 서버 수 판정에 넣지 않는다
  ], 7, NOW);
  assert.equal(r.maxServers, 100);
  assert.deepEqual(r.series.slice(0, 3).map((p) => p.v), [101_000, null, 99_000]);
  assert.equal(r.series[1].partial, true);
  assert.equal(r.fullRatio, 0.9);
  // 증설은 과거 칸을 지우지 않는다(창 전체 최대를 기준으로 두면 지워진다 — v2.670 재현)
  const grow = T.powerTrend(g.map((t, i) => ({ hb: hb(t, 1), watts: 1000 + i, servers: i < 7 ? 60 : 130 })), 7, NOW);
  assert.equal(grow.series.filter((p) => p.v != null).length, 14);
});

test('⑤ 실제 전력 DB — fleetHourSums 는 시간마다 서버별 평균의 합', async () => {
  const { getDb } = await import('../src/idrac/db.js');
  const db = await getDb();
  const hb0 = Math.floor(Date.now() / H) - 30;
  db.insertMany([
    { serverId: 'a', watts: 100, ts: hb0 * H + 10 * 60_000 }, { serverId: 'a', watts: 300, ts: hb0 * H + 20 * 60_000 },
    { serverId: 'b', watts: 50, ts: hb0 * H + 30 * 60_000 }, { serverId: 'b', watts: 70, ts: (hb0 + 1) * H + 60_000 },
  ]);
  const rows = db.fleetHourSums([hb0, hb0 + 1, hb0 + 2]);
  assert.deepEqual(rows.map((r) => [r.hb, Math.round(r.watts), r.servers]), [[hb0, 250, 2], [hb0 + 1, 70, 1]]);
});

test('⑥ 실제 라우트 — 범위 계정은 스토리지·전력 null + 사유 · 물리 서버는 추이 없음', async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { store } = await import('../src/store.js');
  await store.refresh();
  const app = express(); app.use(express.json());
  let asUser = null;
  app.use((req, _res, next) => { if (asUser) req.user = asUser; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  try {
    const full = await (await fetch(`${base}/overview/trend?days=30`)).json();
    assert.equal(full.ok, true); assert.equal(full.days, 30); assert.equal(full.points, 30); assert.equal(full.grid.length, 30);
    assert.equal(full.physical.series, null); assert.equal(full.physical.reason, 'no-series');
    assert.ok(Array.isArray(full.virtual.series) && full.virtual.series.length === 30);
    assert.ok(Array.isArray(full.power.series), JSON.stringify(full.power));
    assert.equal(full.power.scope, 'servers');
    const vc = store.get().vcenters[0].id;
    asUser = { username: 'r', role: 'viewer', scope: { vcenters: [vc] } };
    const sc = await (await fetch(`${base}/overview/trend?days=7`)).json();
    assert.equal(sc.scoped, true);
    assert.equal(sc.storage.series, null); assert.ok(sc.storage.reason);
    assert.equal(sc.power.series, null); assert.ok(sc.power.reason);
    const odd = await (await fetch(`${base}/overview/trend?days=999`)).json();
    assert.equal(odd.days, 7);
  } finally { srv.close(); }
});
