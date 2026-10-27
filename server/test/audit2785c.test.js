/**
 * v2.785(점검 GI) — SAN 포트 사용량 순수 코어·라우트.
 *  I-B1: 엣지 축약(문제 포트만) 스냅샷이면 스냅샷에 없는 포트는 상태가 'unknown' 이다 — '사용 중이 아닌 포트(off)' 로 단정하지 않고
 *        따로 센다(정상 online 포트 7개가 '꺼짐' 으로, 유휴 0개로 보였다).
 *  I-B3: 유휴 판정 30일 '하루 칸' 은 한국 하루여야 한다 — 하루(DAY) 버킷은 epoch 정배수라 UTC 하루(한국 09:00 경계)로 묶여
 *        첫 한국 아침(00~09시) 표본이 버려지고 데이터 일수가 +1 됐다. 3시간 칸(한국 자정이 3시간 정배수)으로 읽어 한국 하루로 접는다.
 *  I-B4: SANSW_PERF_ROLLUP_15M_DAYS < 31 이면 15분 표가 없는 날의 1일 차트가 1시간 칸으로 오는데 라우트가 15분·96칸으로 단정해
 *        96칸 중 72칸이 비었다 — 칸 폭·칸 수는 응답의 bucketMs 로 만든다(앞 기간도).
 * 실제 perfDb 를 쓰는 검사는 실제 시각을 한국 자정 경계로 떨어뜨린 기준을 쓴다(docs/rules/common.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2785c-'));
process.env.SANSW_PERF_ROLLUP_15M_DAYS = '14';   // I-B4 재현 조건(모듈 로드 전에)
const pu = await import('../src/sanswitch/portUsage.js');
const db = await import('../src/sanswitch/perfDb.js');
const { slimSnapshot } = await import('../src/sanswitch/push.js');
const H = 3_600_000, D = 86_400_000, Q = 900_000;
const ROUTE = stripComments(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/routes/api/sanSwitch.js'), 'utf8'));
const BODY = ROUTE.slice(ROUTE.indexOf('async function portUsageFor('), ROUTE.indexOf("api.get('/tools/sanswitch/devices/:id/port-usage'"));

// ── I-B1 ─────────────────────────────────────────────────────────────
function eightPorts() {
  const list = [];
  for (let i = 0; i < 8; i++) list.push({ index: i, slotPort: `1/${i}`, state: 'online', speed: '16G', attachedName: `host${i}` });
  list[3].state = 'faulty';
  const meta = new Map(list.map((p) => [p.index, { name: p.attachedName, speed: '16G' }]));
  const daily30 = new Map(list.map((p) => [p.index, { peak: new Array(30).fill(1000), avg: new Array(30).fill(500) }]));
  return { list, meta, daily30 };
}

test('I-B1: 축약 스냅샷에서 스냅샷에 없는 포트는 상태 모름(unknown)으로 따로 — 꺼짐(off)으로 세지 않는다', () => {
  const { list, meta, daily30 } = eightPorts();
  const slim = slimSnapshot({ ports: { list } });
  assert.deepEqual(slim.ports.list.map((p) => p.index), [3], '전제: 축약은 문제 포트만 싣는다');
  const r = pu.idleOf(pu.portList(slim.ports.list, meta), daily30);
  assert.deepEqual(r.off.map((x) => x.port), [3], '실제로 상태가 보고된 포트만 꺼짐');
  assert.deepEqual(r.unknown.map((x) => x.port), [0, 1, 2, 4, 5, 6, 7]);
  assert.equal(r.idle.length, 0, '상태를 모르는 포트를 유휴로 단정하지 않는다');
  assert.equal(r.pending.length, 0);
  // 한 포트는 한 묶음에만
  const all = [...r.idle, ...r.pending, ...r.off, ...r.unknown].map((x) => x.port).sort((a, b) => a - b);
  assert.deepEqual(all, [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('I-B1: 전체 스냅샷은 전과 같다(unknown 0) · 스냅샷이 없으면 전부 상태 모름', () => {
  const { list, meta, daily30 } = eightPorts();
  const full = pu.idleOf(pu.portList(list, meta), daily30);
  assert.equal(full.idle.length, 7);
  assert.deepEqual(full.off.map((x) => x.port), [3]);
  assert.deepEqual(full.unknown, []);
  const none = pu.idleOf(pu.portList([], meta), daily30);
  assert.equal(none.unknown.length, 8);
  assert.equal(none.off.length, 0);
  // 스냅샷에 있지만 state 가 빈 포트도 portList 가 'unknown' 으로 채운다 → 상태 모름
  const blank = pu.idleOf(pu.portList([{ index: 9, slotPort: '1/9', state: '', speed: '16G' }], new Map()), new Map());
  assert.deepEqual(blank.unknown.map((x) => x.port), [9]);
  assert.equal(blank.unknown[0].slotPort, '1/9');
});

// ── I-B3 ─────────────────────────────────────────────────────────────
test('I-B3: 유휴 창은 한국 자정부터 30일 · 칸은 지역 자정의 정배수(3시간 — 1시간 칸은 비용이 커서 쓰지 않는다)', () => {
  const now = Date.UTC(2026, 9, 21, 2, 30);           // 2026-10-21 11:30 KST
  const w = pu.idleWindow(now, 540);
  assert.equal(w.bucketMs, 3 * H);
  assert.equal(w.since, Date.UTC(2026, 9, 20, 15) - 29 * D);
  assert.equal(w.until - w.since, 30 * D);
  assert.equal((w.until - w.since) / w.bucketMs, 240);
  assert.equal(w.since % w.bucketMs, 0, 'epoch 정배수 버킷의 경계가 한국 자정과 맞는다');
  // 지역 자정이 3시간 정배수가 아니면 1시간(+1h·−5h), UTC 는 3시간
  assert.equal(pu.idleBucketMs(60), H);
  assert.equal(pu.idleBucketMs(-300), H);
  assert.equal(pu.idleBucketMs(0), 3 * H);
  assert.equal(pu.idleBucketMs(-180), 3 * H);
  assert.equal(pu.idleWindow(now, 60).since % H, 0);
});

test('I-B3: 3시간 칸을 한국 하루로 접는다 — 첫날 03시 피크를 지키고, 같은 한국 날의 칸은 하루로 센다', () => {
  const now = Date.UTC(2026, 9, 21, 2, 30);
  const w = pu.idleWindow(now, 540);
  const b = [w.since + 0 * H, w.since + 3 * H, w.since + 21 * H, w.since + D + 6 * H, w.since + D + 21 * H, now + 3 * H];
  const res = { bucketMs: 3 * H, buckets: b, series: [{ port: 1, avg: [10, 20, 30, 40, 50, 60], peak: [11, 5e8, 31, 41, 51, 9e9] }] };
  const daily = pu.idleDailyOf(res, { ...w, now });
  const s = daily.get(1);
  assert.equal(s.peak.length, 30);
  assert.equal(s.peak[0], 5e8);
  assert.equal(s.avg[0], 20);
  assert.equal(s.peak[1], 51);
  assert.equal(s.peak.filter((v) => v != null).length, 2, '미래 칸은 넣지 않는다');
  // 응답 칸 폭이 요청과 달라도(1시간) 실제 폭으로 접는다
  const res1 = { bucketMs: H, buckets: [w.since + 23 * H, w.since + 24 * H], series: [{ port: 2, avg: [1, 2], peak: [1, 2] }] };
  const d1 = pu.idleDailyOf(res1, { ...w, now }).get(2);
  assert.deepEqual([d1.peak[0], d1.peak[1]], [1, 2]);
});

test('hoursToDays: 하루 칸 수(perDay)를 받는다 — 기본 24(1시간 칸)는 전과 같다', () => {
  const avg = [1, null, 3, 4, 7, null, null, null], peak = [2, null, 9, 5, 8, null, null, null];
  assert.deepEqual(pu.hoursToDays(avg, peak, 2, 4), [[3, 9, 3], [7, 8, 1]]);
  assert.deepEqual(pu.hoursToDays(avg, peak, 2), [[4, 9, 4], null]);
  const a24 = Array.from({ length: 48 }, (_, i) => (i < 24 ? i : null));
  assert.deepEqual(pu.hoursToDays(a24, a24, 2), [[12, 23, 24], null]);
});

test('I-B3: 실제 perfDb — 첫 한국 아침 피크가 남고, 한국 6일치 데이터는 6일(판단 보류)', async () => {
  const now = Date.now();
  const w = pu.idleWindow(now);
  const today = pu.dayStartOf(now);
  await db.savePerfSample('swI', w.since + 3 * H, { 1: 5e8 }, [{ port: 1, speed: '16G' }, { port: 2, speed: '16G' }]);
  for (let d = 1; d < 29; d++) await db.savePerfSample('swI', w.since + d * D + 12 * H, { 1: 100 }, []);
  // 포트 2: 한국 날로 6일(어제까지 — 실행 시각과 무관하게 모두 과거), 각 날 00:30·23:30(KST) — UTC 로는 7일에 걸친다
  for (let d = 1; d <= 6; d++) for (const t of [today - d * D + 30 * 60_000, today - d * D + 23.5 * H]) await db.savePerfSample('swI', t, { 2: 100 }, []);
  // 라우트와 같은 인자(points = 창 / 칸)
  const res = await db.portSeries('swI', { from: w.since, to: w.until, points: Math.round((w.until - w.since) / w.bucketMs) });
  assert.equal(res.bucketMs, w.bucketMs);
  const daily = pu.idleDailyOf(res, { ...w, now });
  assert.equal(Math.max(...daily.get(1).peak.filter((v) => v != null)), 5e8, '창 첫날 03시(KST) 피크');
  assert.equal(daily.get(2).peak.filter((v) => v != null).length, 6);
  const ports = [{ port: 2, slotPort: '0/2', state: 'online', speed: '16G', name: 'h' }];
  assert.equal(pu.idleOf(ports, daily).pending[0]?.why, '데이터 6일');
});

test('I-B3: 라우트는 유휴 창·칸·접기를 portUsage 코어로 한다(하루 버킷으로 직접 조회하지 않는다)', () => {
  assert.match(BODY, /pu\.idleWindow\(now\)/);
  assert.match(BODY, /pu\.idleDailyOf\(/);
  assert.doesNotMatch(BODY, /IDLE_DAYS\s*\*\s*DAY\s*,\s*DAY\)/);
  assert.doesNotMatch(BODY, /bucketMs:\s*DAY\s*,\s*n:\s*pu\.IDLE_DAYS/);
});

// ── I-B4 ─────────────────────────────────────────────────────────────
test('I-B4: seriesFrame — 칸 폭은 응답의 bucketMs, 없으면(0·빈 응답) 요청 폭', () => {
  assert.deepEqual(pu.seriesFrame({ bucketMs: H }, { since: 1000, end: 1000 + D, wantMs: Q }), { since: 1000, bucketMs: H, n: 24 });
  assert.deepEqual(pu.seriesFrame({ bucketMs: Q }, { since: 0, end: D, wantMs: Q }), { since: 0, bucketMs: Q, n: 96 });
  assert.deepEqual(pu.seriesFrame({ bucketMs: 0, unavailable: true }, { since: 0, end: D, wantMs: Q }), { since: 0, bucketMs: Q, n: 96 });
  assert.deepEqual(pu.seriesFrame(null, { since: 0, end: 7 * D, wantMs: H }), { since: 0, bucketMs: H, n: 168 });
});

test('I-B4: 실제 perfDb(15분 보관 14일) — 20일 전 하루는 1시간 칸으로 오고, 차트는 24칸이 다 찬다', async () => {
  const now = Date.now();
  const period = pu.periodOf('d', -20, { now });
  assert.equal(period.fine, true, '전제: 라우트의 periodOf 는 31일 기준이라 15분 차트를 요청한다');
  for (let t = period.start; t < period.end; t += 5 * 60_000) await db.savePerfSample('swR', t, { 1: 1e8 }, [{ port: 1, speed: '16G' }]);
  const res = await db.portSeries('swR', { from: period.start, to: period.end, points: 96, ports: [1] });
  assert.equal(res.bucketMs, H);
  const frame = pu.seriesFrame(res, { since: period.start, end: period.end, wantMs: Q });
  const histSince = period.start - 6 * D;
  const hist = await db.portSeries('swR', { from: histSince, to: period.end, points: 7 * 24 });
  const ports = [{ port: 1, slotPort: '0/1', state: 'online', speed: '16G', name: 'h' }];
  const r = pu.buildPortUsage({ period, ports, hist, histSince, chart: { res, ...frame }, view: 'port', target: 1, now });
  const c = r.target.chart;
  assert.equal(c.bucketMs, H);
  assert.equal(c.avg.length, 24);
  assert.equal(c.avg.filter((v) => v != null).length, 24);
  assert.equal(c.avgMean, 1e8);
});

test('I-B4: 라우트는 차트·앞 기간의 칸 폭·칸 수를 응답에서 만든다(15분·96칸 단정 금지)', () => {
  assert.doesNotMatch(BODY, /n:\s*96\b/);
  assert.doesNotMatch(BODY, /bucketMs:\s*900_000/);
  assert.equal((BODY.match(/pu\.seriesFrame\(/g) || []).length, 2, '차트·앞 기간 둘 다');
  assert.doesNotMatch(BODY, /bucketMs:\s*bm\b/);
});
