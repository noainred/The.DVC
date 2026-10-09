/**
 * v2.728 — SAN 포트 사용량 1·2차 개선(v2.727 이전 조사 보고의 ①~⑦).
 *  ① 집계 표 계획(순수): 버킷 정렬·원본/집계 구간 나누기
 *  ② 결과 동일성: 백필 전(원본) · 일부 백필 · 전체 백필 · 늦은 엣지 전송 · 중복 재전송 — 전부 예전 한 문장 집계와 같다
 *  ③ 보관: 원본 정리는 집계 표를 지우지 않고, 원본이 지워진 구간은 집계 표로 본다 · 집계 표는 자기 보관 기간으로 지운다
 *  ④ 조회 기억·취소: 요청한 화면이 모두 떠나면 줄에서 실행하지 않는다 · 다른 요청이 기다리면 멈추지 않는다 · 도는 중이면 멈춘다
 *  ⑤ 보관 현황은 전체 행을 세지 않는다(어림값 표지) · 숫자 배열 누적
 *  ⑥ 실제 라우트: 연결 대상 종류 필터 · 계산 시각·기억 시간·출처
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sanperf2728-'));
process.env.SANSW_PERF_ROLLUP_BACKFILL = '0';   // 백그라운드 타이머 대신 테스트가 직접 돌린다
Object.assign(process.env, { DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', IPAM_WRITE_WORKER: '0' });

const MIN = 60_000;
const HOUR = 3600_000;
const DAY = 86_400_000;
// 기준 시각은 정시에서 떨어뜨려 고정한다(CLAUDE.md — Date.now() 를 기준으로 쓰지 말 것).
const BASE = Math.floor(1_790_000_000_000 / HOUR) * HOUR + 17 * MIN;
const NOW = BASE + HOUR;   // 집계 표 가용성 판정용 '지금'(15분 표 보관 31일 안)

const OLD_SQL = (bucket) => `SELECT device_id, port, (ts / ${bucket}) AS b, AVG(bps) AS avg_bps, MAX(bps) AS max_bps, MAX(ts) AS last_ts
  FROM port_perf WHERE device_id IN (?,?,?) AND ts >= ? AND ts <= ? GROUP BY device_id, port, b`;
const key = (r) => `${r.device_id}|${r.port}|${r.b}`;
const norm = (rows) => new Map(rows.map((r) => [key(r), [Math.round(Number(r.avg_bps) * 1000), Number(r.max_bps), Number(r.last_ts)]]));
const IDS = ['swA', 'swB', 'swC'];

async function seedRaw() {
  const m = await import('../src/sanswitch/perfDb.js');
  const db = await m._dbForTest();
  const ins = db.conn.prepare('INSERT INTO port_perf (device_id, ts, port, bps) VALUES (?,?,?,?)');
  db.conn.exec('BEGIN');
  for (const dev of IDS) {
    for (let t = BASE - 4 * DAY; t <= BASE; t += 5 * MIN + 7_000) {   // 5분 7초 — 버킷 경계와 어긋나게
      for (let p = 0; p < 5; p++) ins.run(dev, t, p, ((t / 1000) % 997) * (p + 1) + dev.charCodeAt(2));
    }
  }
  db.conn.exec('COMMIT');
  return { m, db };
}

async function compareAll(m, db, label) {
  const ranges = [
    [BASE - 3 * DAY + 54_321, BASE - 1234],
    [BASE - 2 * DAY - 7 * MIN, BASE - DAY + 11 * MIN],
    [BASE - 30 * HOUR + 1, BASE - 5 * HOUR - 1],
  ];
  for (const bucket of [60_000, 720_000, 900_000, 1_800_000, 2_700_000, HOUR, 2 * HOUR, 6 * HOUR, 9 * HOUR]) {
    for (const [since, until] of ranges) {
      const old = db.conn.prepare(OLD_SQL(bucket)).all(...IDS, since, until);
      const neu = await m.bucketAgg(db, IDS, since, until, bucket, { lastTs: true, now: NOW });
      assert.deepEqual(norm(neu), norm(old), `${label} — bucket ${bucket} · ${since}~${until}`);
    }
  }
}

test('① 버킷 정렬과 구간 나누기(순수)', async () => {
  const { snapBucketMs, rollupGranularity, planSegments, G15, G1H } = await import('../src/sanswitch/perfRollup.js');
  assert.equal(snapBucketMs(60_000), 60_000, '10분 미만은 그대로(원본)');
  assert.equal(snapBucketMs(12 * MIN), 15 * MIN, '24시간 — 12분 → 15분');
  assert.equal(snapBucketMs(84 * MIN), 2 * HOUR, '7일 — 84분 → 2시간');
  assert.equal(snapBucketMs(36 * MIN), 45 * MIN);
  assert.equal(snapBucketMs(12 * MIN, { allow15: false }), HOUR, '15분 표가 없는 오래된 구간은 1시간 정배수');
  assert.equal(rollupGranularity(2 * HOUR), G1H);
  assert.equal(rollupGranularity(45 * MIN), G15);
  assert.equal(rollupGranularity(12 * MIN), 0);
  // 머리·꼬리 자투리는 원본, 가운데는 집계 표
  const p = planSegments({ since: BASE, until: BASE + 10 * HOUR, g: G1H, availFrom: 0, rawOldest: BASE - DAY });
  assert.deepEqual(p.rollup, [Math.ceil(BASE / G1H) * G1H, Math.floor((BASE + 10 * HOUR + 1) / G1H) * G1H]);
  assert.deepEqual(p.raw[0], [BASE, p.rollup[0]]);
  assert.deepEqual(p.raw[1], [p.rollup[1], BASE + 10 * HOUR + 1]);
  assert.equal(p.headApprox, false);
  // 집계 표가 완성되기 전 구간은 원본
  const q = planSegments({ since: BASE, until: BASE + 10 * HOUR, g: G1H, availFrom: BASE + 5 * HOUR, rawOldest: BASE - DAY });
  assert.equal(q.rollup[0], Math.ceil((BASE + 5 * HOUR) / G1H) * G1H);
  assert.deepEqual(q.raw[0], [BASE, q.rollup[0]]);
  // 원본이 지워진 머리 자투리는 집계 버킷 전체(근사)
  const r = planSegments({ since: BASE, until: BASE + 10 * HOUR, g: G1H, availFrom: 0, rawOldest: BASE + 3 * HOUR });
  assert.equal(r.rollup[0], Math.floor(BASE / G1H) * G1H); assert.equal(r.headApprox, true);
  assert.equal(r.raw.length, 1, '머리 원본 구간 없음');
  // 집계 표를 못 쓰면 전부 원본
  assert.deepEqual(planSegments({ since: BASE, until: BASE + HOUR, g: 0, availFrom: 0 }).raw, [[BASE, BASE + HOUR + 1]]);
  assert.equal(planSegments({ since: BASE, until: BASE + HOUR, g: G1H, availFrom: null }).rollup, null);
});

test('② 결과 동일성 — 백필 전 · 일부 백필 · 전체 백필 · 늦은 전송 · 중복 재전송', async () => {
  const { m, db } = await seedRaw();
  await compareAll(m, db, '백필 전(원본)');
  const r0 = await m.aggPorts(db, IDS, BASE - 2 * DAY, BASE, HOUR, { now: NOW });
  assert.equal(r0.plan?.rollup ?? null, null, '백필 전에는 그 구간에 집계 표를 쓰지 않는다');
  // 일부 백필 — 데이터 가운데까지
  let st = (await m.perfDbStats({ now: NOW })).rollup;
  let guard = 0;
  while (st.completeSince > BASE - 2 * DAY && guard++ < 400) {
    await m.runRollupBackfill({ workMs: 0, restMs: 0, maxMs: -1 });
    st = (await m.perfDbStats({ now: NOW })).rollup;
  }
  assert.ok(st.completeSince <= BASE - 2 * DAY && st.completeSince > BASE - 3 * DAY, `watermark ${st.completeSince}`);
  await compareAll(m, db, '일부 백필');
  const r1 = await m.aggPorts(db, IDS, BASE - 2 * DAY + 3 * MIN, BASE, HOUR, { now: NOW });
  assert.ok(r1.plan?.rollup, '완성된 구간은 집계 표를 쓴다');
  // 전체 백필
  await m.runRollupBackfill({ workMs: 0, restMs: 0 });
  st = (await m.perfDbStats({ now: NOW })).rollup;
  assert.equal(st.completeSince, 0); assert.equal(st.state, 'done'); assert.equal(st.pct, 100);
  await compareAll(m, db, '전체 백필');
  // 늦은 엣지 전송(이미 백필한 구간) + 같은 행 중복 재전송
  const late = [];
  for (let k = 0; k < 40; k++) late.push({ d: IDS[k % 3], ts: BASE - DAY - k * 61_000 + 333, p: 2, b: 900_000 + k });
  const i1 = await m.importSamples(late, [], 3650);
  const i2 = await m.importSamples(late, [], 3650);
  assert.equal(i1.inserted, 40); assert.equal(i2.inserted, 0, '중복은 원본에서 걸러진다');
  await compareAll(m, db, '늦은 전송 + 중복 재전송');
  // 새 주기 저장(실시간 upsert)
  await m.savePerfSample('swA', BASE - 2 * HOUR + 9_000, { 0: 123_456, 7: 5 }, [], 3650);
  await compareAll(m, db, '실시간 저장');
  // 행을 배열로 받는 기능(setReturnArrays)이 없는 런타임 — 객체 행을 같은 순서로 풀어도 결과가 같다.
  const { StatementSync } = await import('node:sqlite');
  const desc = Object.getOwnPropertyDescriptor(StatementSync.prototype, 'setReturnArrays');
  if (desc?.configurable) {
    delete StatementSync.prototype.setReturnArrays;
    try { await compareAll(m, db, '배열 행 미지원 런타임'); }
    finally { Object.defineProperty(StatementSync.prototype, 'setReturnArrays', desc); }
  }
});

test('③ 보관 — 원본 정리는 집계 표를 지우지 않고, 집계 표는 자기 보관 기간으로 지운다', async () => {
  const m = await import('../src/sanswitch/perfDb.js');
  const db = await m._dbForTest();
  const now = Date.now();
  const T = Math.floor((now - 200 * DAY) / HOUR) * HOUR + 20 * MIN;   // 원본 보관(90일) 밖 · 집계(730일) 안
  const T2 = now - 800 * DAY;                                           // 집계 보관 밖
  await m.savePerfSample('swOld', T, { 3: 1_000 }, [], 3650);
  await m.savePerfSample('swOld', T + 5 * MIN, { 3: 3_000 }, [], 3650);
  await m.savePerfSample('swOld', T2, { 3: 9 }, [], 3650);
  const has1h = (b) => db.conn.prepare('SELECT COUNT(*) AS n FROM pp_1h h JOIN pp_dev d ON d.id = h.dev WHERE d.device_id = ? AND h.b = ?').get('swOld', b).n;
  assert.equal(has1h(Math.floor(T / HOUR)), 1);
  assert.equal(has1h(Math.floor(T2 / HOUR)), 1);
  const r = await m.pruneNow(90);
  assert.ok(r.deleted >= 3, '원본 3행(보관 밖)');
  assert.ok(r.rollupDeleted >= 1, '집계 보관 밖 행');
  assert.equal(has1h(Math.floor(T / HOUR)), 1, '원본이 지워져도 집계 표는 남는다');
  assert.equal(has1h(Math.floor(T2 / HOUR)), 0, '집계 보관 기간 밖은 지운다');
  const n15 = db.conn.prepare('SELECT COUNT(*) AS n FROM pp_15m h JOIN pp_dev d ON d.id = h.dev WHERE d.device_id = ? AND h.b < ?').get('swOld', Math.floor((now - 40 * DAY) / (15 * MIN))).n;
  assert.equal(n15, 0, '15분 표는 31일 밖을 만들지 않는다');
  // 원본이 지워진 구간은 집계 표로 본다(평균 = (1000+3000)/2) — 백필이 끝나 집계 표가 전 구간 완성으로 표시된 뒤의 조회
  await m.runRollupBackfill({ workMs: 0, restMs: 0 });
  const rows = await m.bucketAgg(db, ['swOld'], T - 30 * MIN, T + 2 * HOUR, HOUR, { lastTs: true });
  const row = rows.find((x) => Number(x.port) === 3);
  assert.ok(row, '집계 표의 값이 있어야 한다');
  assert.equal(Math.round(row.avg_bps), 2000); assert.equal(Number(row.max_bps), 3000);
});

test('④ 조회 기억·취소 — 떠난 요청은 실행하지 않고, 남은 요청이 있으면 멈추지 않는다', async () => {
  const m = await import('../src/sanswitch/perfDb.js');
  m.invalidatePerfQueries();
  const args = { from: BASE - 2 * DAY, to: BASE };
  const s0 = m.perfQueryStats();
  const busy = m.storageSeriesMulti(['swA', 'swB', 'swC'], { ...args, points: 200 });   // 같은 줄을 잡아 둔다
  const ac = new AbortController();
  const p = m.storageSeriesMulti(['swB'], { ...args, signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (e) => e.code === 'abandoned');
  await busy;
  const s1 = m.perfQueryStats();
  assert.equal(s1.skipped, s0.skipped + 1, '줄에서 기다리던 버려진 조회는 건너뛴다');
  assert.equal(s1.runs, s0.runs + 1, '실제로 실행된 것은 줄을 잡은 조회 하나뿐');
  // 기억 비우기(지금 수집)는 **진행 중인** 같은 조회를 지우지 않는다 — 지우면 같은 조회가 두 번 돈다
  const q0 = m.storageSeriesMulti(['swA'], { ...args, points: 91 });
  m.invalidatePerfQueries();
  const q0b = m.storageSeriesMulti(['swA'], { ...args, points: 91 });
  await Promise.all([q0, q0b]);
  const s2 = m.perfQueryStats();
  assert.equal(s2.runs, s1.runs + 1, '진행 중 조회에 합류한다(두 번 돌지 않는다)');
  assert.equal(s2.joined, s1.joined + 1);
  // 두 요청이 기다리면 한쪽이 떠나도 멈추지 않는다
  const a1 = new AbortController(); const a2 = new AbortController();
  const q1 = m.storageSeriesMulti(['swC'], { ...args, points: 77, signal: a1.signal });
  const q2 = m.storageSeriesMulti(['swC'], { ...args, points: 77, signal: a2.signal });
  a1.abort();
  const r2 = await q2;
  assert.ok(Array.isArray(r2.series) && r2.series.length > 0, '남은 요청은 결과를 받는다');
  q1.catch(() => {});
  // 도는 중인 집계는 다음 양보 지점에서 멈춘다
  const db = await m._dbForTest();
  await assert.rejects(m.aggPorts(db, ['swA'], BASE - DAY, BASE, 60_000, { ctx: { entry: { abandoned: true } } }), (e) => e.code === 'abandoned');
  // 장비 하나 조회는 법인 단위 줄과 다른 줄이다(소스 계약)
  const src = fs.readFileSync(new URL('../src/sanswitch/perfDb.js', import.meta.url), 'utf8');
  assert.match(src, /storageSeriesMultiInner\([^)]*\), \{ lane: 'multi', signal \}/);
  assert.equal((src.match(/\{ lane: 'single', signal \}/g) || []).length, 2, 'portSeries·storageSeries');
});

test('⑤ 보관 현황은 전체 행을 세지 않는다 · 누적은 숫자 배열', async () => {
  const m = await import('../src/sanswitch/perfDb.js');
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fs.readFileSync(new URL('../src/sanswitch/perfDb.js', import.meta.url), 'utf8'));
  const body = src.slice(src.indexOf('export async function perfDbStats'), src.indexOf('const BF_SLICE_MS'));
  assert.doesNotMatch(body, /COUNT\(\*\)/, 'COUNT(*) 금지 — 운영 DB 에서 서버 전체를 멈췄다');
  assert.doesNotMatch(body, /COUNT\(DISTINCT device_id\) AS v FROM port_perf/);
  const st = await m.perfDbStats();
  assert.equal(st.rowsApprox, true); assert.ok(st.rows > 0); assert.ok(st.rollup && 'completeSince' in st.rollup);
  const db = await m._dbForTest();
  const r = await m.aggPorts(db, ['swA'], BASE - DAY, BASE, HOUR, { now: NOW });
  const one = r.ports.values().next().value;
  assert.ok(one.a instanceof Float64Array, '포트마다 Float64Array 하나');
  // 기억 시간 = 수집 주기(30초~5분)
  assert.equal(m.perfQueryTtlMs(), 5 * MIN);
});

test('⑥ 실제 라우트 — 연결 대상 종류 필터 · 계산 시각 · 출처', async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const reg = await import('../src/sanswitch/registry.js');
  const { SAN_SWITCH_TYPES } = await import('../src/sanswitch/types.js');
  const { savePerfSample } = await import('../src/sanswitch/perfDb.js');
  const swType = SAN_SWITCH_TYPES.find((t) => t.implemented)?.type || SAN_SWITCH_TYPES[0].type;
  reg.saveDevice({ type: swType, name: 'FAB-K', host: '10.72.0.1', username: 'u', password: 'p', datacenterId: 'dcK' });
  const dev = reg.listDevices().find((d) => d.name === 'FAB-K');
  const now = Date.now();
  const meta = [{ port: 1, attachedName: 'SYMMETRIX::000777' }, { port: 2, attachedName: 'Emulex PPN-k1' }, { port: 3, attachedName: 'QLE2692 FW:k2' }];
  for (let k = 6; k >= 1; k--) await savePerfSample(dev.id, now - k * 5 * MIN, { 1: 1_000_000, 2: 300_000, 3: 200_000 }, meta);
  const app = express(); app.use(express.json()); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  try {
    const a = await (await fetch(`${base}/tools/sanswitch/perf/storage-summary?hours=1&datacenterId=dcK&kind=array`)).json();
    assert.equal(a.ok, true, JSON.stringify(a).slice(0, 300));
    assert.deepEqual(a.series.map((s) => s.endpointKind), ['array']);
    assert.equal(a.kindFilter, 'array'); assert.equal(a.seriesOmitted, 2);
    assert.equal(a.counts.host, 2, '개수는 전 종류 기준');
    assert.ok(Number.isFinite(a.computedAt)); assert.ok(a.cacheTtlMs > 0); assert.ok(a.source?.kind);
    const all = await (await fetch(`${base}/tools/sanswitch/perf/storage-summary?hours=1&datacenterId=dcK`)).json();
    assert.equal(all.series.length, 3, 'kind 를 안 보내면(구버전 화면) 전부');
    assert.equal(all.kindFilter, null);
  } finally { srv.close(); }
});
