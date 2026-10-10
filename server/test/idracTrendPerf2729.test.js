// v2.729 — iDRAC 통합 추이 7일 조회가 운영에서 24초 넘게 걸리고 그동안 포탈 전체가 멈췄다(사용자 캡처: /api/health 14초 대기).
// 원인: ① 7일 = 30분 버킷이라 시간당 롤업을 못 쓰고 **분 단위 원본**을 계열마다 약 1만 행 읽었다(원본 인덱스에 값이 없어 행마다
// 표 본체를 따로 읽는다 — 흩어진 임의 읽기) ② '첫 수집 시각' 을 MIN·MAX 한 문장으로 물어 그 키의 전체 이력을 훑었다
// ③ 계열 읽기 사이에 양보가 없었다 ④ 같은 조회를 되풀이해도 매번 다시 읽었다.
// 합성 813만 행(1분마다 807키 섞임) 실측: 7일 처음 1,328ms → 74ms · 다시 217ms → 13ms · 최장 멈춤 1,288ms → 27ms.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'idractrend2729-'));
process.env.CONFIG_DIR = DIR;
process.env.TEMP_DB_PATH = path.join(DIR, 'host-temp.db');
process.env.IDRAC_DB_PATH = path.join(DIR, 'idrac-power.db');
process.env.AUTH_ENABLED = 'false';
process.env.DATA_SOURCE = 'mock';

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * MIN; // 경계에서 떨어뜨린 기준 시각(v2.517 규약)
const SRC = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');

const { bucketOf, BUCKETS, PRESETS, trendMemoStats, _resetTrendMemo, trendMemoKey } = await import('../src/routes/admin/idracTrend.js');
const { getMetricsDb } = await import('../src/metrics/db.js');

// 결정적 난수(테스트가 시각에 따라 달라지지 않게).
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

let seeded = null;
async function seed() {
  if (seeded) return seeded;
  const db = await getMetricsDb();
  const r = rng(2729);
  const t0 = NOW - 2 * DAY;
  let cpu = 30, temp = 50;
  for (let t = t0; t < NOW; t += MIN) {
    cpu = Math.max(0, Math.min(100, cpu + (r() - 0.5) * 8));
    if (r() < 0.08) temp += (r() - 0.5) * 6; // 가끔만 크게 바뀐다 — dead-band 가 대부분을 저장하지 않는다
    if (r() < 0.002) continue;                 // 가끔 수집이 빠진다
    db.insertMany([
      { metric: 'idracusage_cpu', k: 's1', v: Math.round(cpu * 10) / 10 },
      { metric: 'idractemp_cpu', k: 's1', v: Math.round(temp * 10) / 10 },
      { metric: 'fill_x', k: 'other', v: r() * 100 },
    ], t);
  }
  seeded = { db, t0 };
  return seeded;
}

test('① 1시간보다 잔 버킷은 원본을 읽는다 — 그래서 약 33시간을 넘는 기간은 전부 1시간 정배수 버킷이다(30분 버킷 없음)', () => {
  assert.ok(!BUCKETS.includes(30 * MIN), '30분 버킷을 되살리지 말 것 — 7일이 원본을 읽는다');
  assert.equal(bucketOf(7 * DAY), HOUR);
  assert.equal(bucketOf(DAY), 5 * MIN, '24시간은 그대로 5분(원본 1,440행)');
  for (const span of Object.values(PRESETS)) {
    const b = bucketOf(span);
    assert.ok(span / b <= 400, `${span} 은 400점 이내`);
    if (span > 400 * 5 * MIN) assert.equal(b % HOUR, 0, `${span / HOUR}시간 창은 롤업을 읽는 버킷이어야 한다(지금 ${b / MIN}분)`);
  }
  // 기간 지정(custom)도 같은 규칙 — 2일·3일 창이 원본으로 떨어지지 않는다.
  for (const days of [2, 3, 5]) assert.equal(bucketOf(days * DAY) % HOUR, 0, `${days}일`);
});

test('② historyRangeAsync 는 historyRange 와 같은 결과다 — 조각 경계가 버킷 경계라 한 버킷이 두 조각에 나뉘지 않는다', async () => {
  const { db, t0 } = await seed();
  assert.equal(typeof db.historyRangeAsync, 'function');
  const cases = [];
  for (const metric of ['idracusage_cpu', 'idractemp_cpu']) {
    for (const bucketMs of [MIN, 5 * MIN]) {
      for (const start of [t0 + 7 * MIN + 13_000, t0 + 3 * HOUR, NOW - DAY]) {         // 버킷 경계가 아닌 시작 포함
        for (const sliceMs of [undefined, 17 * MIN, 45 * MIN]) cases.push({ metric, bucketMs, start, end: Math.min(NOW + MIN, start + 30 * HOUR), sliceMs, off: 0 });
      }
    }
    cases.push({ metric, bucketMs: HOUR, start: t0, end: NOW, off: 0 });               // 롤업 경로
    cases.push({ metric, bucketMs: DAY, start: t0 - 9 * HOUR, end: NOW, off: 9 * HOUR }); // 1일 버킷 · 한국 날짜 오프셋
  }
  for (const c of cases) {
    const sync = db.historyRange(c.metric, 's1', c.start, c.end, c.bucketMs, c.off);
    const asy = await db.historyRangeAsync(c.metric, 's1', c.start, c.end, c.bucketMs, c.off, { sliceMs: c.sliceMs });
    assert.ok(sync.length > 0, `${c.metric} ${c.bucketMs / MIN}분 표본이 있어야 비교가 뜻이 있다`);
    assert.deepEqual(asy, sync, `${c.metric} · 버킷 ${c.bucketMs / MIN}분 · 조각 ${c.sliceMs ? c.sliceMs / MIN : 360}분 · 시작 +${(c.start - t0) / MIN}분`);
  }
});

test('③ 원본을 읽을 때는 조각마다 양보한다 — 한 계열 원본을 한 문장으로 읽지 않는다', async () => {
  const { db } = await seed();
  let turns = 0;
  const yieldFn = () => { turns += 1; return Promise.resolve(); };
  await db.historyRangeAsync('idracusage_cpu', 's1', NOW - DAY, NOW, 5 * MIN, 0, { yieldFn });
  assert.ok(turns >= 4, `24시간 · 6시간 조각이면 4번 이상 양보한다(지금 ${turns})`);
  turns = 0;
  await db.historyRangeAsync('idractemp_cpu', 's1', NOW - DAY, NOW, MIN, 0, { yieldFn, sliceMs: HOUR });
  assert.ok(turns >= 24, `dead-band 계열도 조각마다 양보한다(지금 ${turns})`);
  // 라우트가 동기판이 아니라 이것을 쓴다(주석 제거 뒤 소스 검사).
  const src = stripComments(fs.readFileSync(path.join(SRC, 'routes/admin/idracTrend.js'), 'utf8'));
  const body = src.slice(src.indexOf('async function seriesFor('), src.indexOf('export function rebucketMean'));
  assert.match(body, /historyRangeAsync/);
  assert.match(body, /await read\('cpuPct'/, '계열 읽기를 기다린다(그 사이 다른 요청이 끼어든다)');
});

test('④ 키 하나의 첫·마지막 시각은 MIN·MAX 를 따로 묻는다 — 한 문장이면 그 키의 전체 이력을 훑는다', async () => {
  const { db, t0 } = await seed();
  const m = db.metaKey('idracusage_cpu', 's1');
  assert.ok(m.firstTs <= t0 + MIN && m.firstTs >= Math.floor(t0 / HOUR) * HOUR, '첫 시각(원본·롤업 중 이른 것)');
  assert.ok(m.lastTs >= NOW - 2 * MIN, '마지막 시각');
  assert.deepEqual(db.metaKey('없는지표', 's1'), { firstTs: null, lastTs: null });
  // 소스 스윕: k=? 로 좁힌 준비문에 MIN(ts|h) 와 MAX(ts|h) 가 함께 있으면 안 된다(v2.550.3 함정의 키 단위판).
  // v2.733(점검 3회차 C6-05): 같은 모양이 metrics/vmperfDb.js(vmperfMeta — vCenter 상세 사용량 추이를 열 때마다 2회)에 남아 있었다 — 대상에 넣는다.
  for (const rel of ['metrics/db.js', 'metrics/vmperfDb.js']) {
    const src = stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
    const stmts = [...src.matchAll(/prepare\((['`])([\s\S]*?)\1/g)].map((x) => x[2]);
    assert.ok(stmts.length > 3, `${rel}: 준비문을 읽지 못했다(${stmts.length}개) — 스윕이 공허하다`);
    const bad = stmts.filter((q) => /\bk=\?/.test(q) && !/GROUP BY/i.test(q) && /MIN\((ts|h)\)/.test(q) && /MAX\((ts|h)\)/.test(q));
    assert.deepEqual(bad, [], `${rel}: 첫·마지막 시각을 한 문장으로 묻는 준비문`);
  }
});

test('⑤ 같은 서버·같은 기간 조회는 30초 기억하고, 진행 중인 같은 조회는 합류한다 — 키는 버킷에 맞춘 시작 시각', async () => {
  await seed();
  const { addServer } = await import('../src/idrac/registry.js');
  addServer({ id: 's1', name: 's1', host: '10.0.0.21', username: 'root', password: 'x' });
  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express(); app.use(express.json()); app.use('/api/admin', adminRouter);
  const srv = app.listen(0); await new Promise((ok) => srv.once('listening', ok));
  const base = `http://127.0.0.1:${srv.address().port}/api/admin`;
  try {
    // 라우트가 동기판(historyRange)이 아니라 조각 읽기(historyRangeAsync)를 실제로 부른다 — 호출을 센다.
    const db = await getMetricsDb();
    const orig = { a: db.historyRangeAsync, s: db.historyRange };
    let nAsync = 0, nSync = 0;
    db.historyRangeAsync = (...x) => { nAsync += 1; return orig.a(...x); };
    db.historyRange = (...x) => { nSync += 1; return orig.s(...x); };
    try {
      _resetTrendMemo();
      assert.equal((await fetch(`${base}/idrac/s1/trend?range=24h`)).status, 200);
    } finally { db.historyRangeAsync = orig.a; db.historyRange = orig.s; }
    assert.ok(nAsync >= 7, `계열 7개 이상을 조각 읽기로(지금 ${nAsync})`);
    assert.equal(nSync, 0, '동기판으로 한 계열을 통째로 읽지 않는다');
    _resetTrendMemo();
    const a = await (await fetch(`${base}/idrac/s1/trend?range=7d`)).json();
    assert.equal(a.ok, true); assert.equal(a.bucketMs, HOUR);
    assert.ok(a.points.some((p) => p.cpuPct != null), '7일에도 값이 나온다(롤업)');
    const b = await (await fetch(`${base}/idrac/s1/trend?range=7d`)).json();
    assert.deepEqual(b.points, a.points);
    let st = trendMemoStats();
    assert.equal(st.misses, 1); assert.equal(st.hits, 1, '두 번째는 기억한 결과');
    await fetch(`${base}/idrac/s1/trend?range=24h`);
    assert.equal(trendMemoStats().misses, 2, '다른 기간은 새로 읽는다');
    _resetTrendMemo();
    const both = await Promise.all([fetch(`${base}/idrac/s1/trend?range=30d`), fetch(`${base}/idrac/s1/trend?range=30d`)]);
    assert.deepEqual(both.map((r) => r.status), [200, 200]);
    st = trendMemoStats();
    assert.equal(st.misses, 1, '동시에 온 같은 조회는 한 번만 읽는다');
    assert.equal(st.joined + st.hits, 1);
  } finally { srv.close(); }
  // 키 — 같은 버킷 안의 두 프리셋 요청은 같은 키, 매칭 호스트가 다르면 다른 키, 기간 지정은 끝 시각까지 키에 든다.
  const w = { start: NOW - 7 * DAY, end: NOW, bucketMs: HOUR, offsetMs: 0, custom: false };
  assert.equal(trendMemoKey({ id: 's1' }, w, null), trendMemoKey({ id: 's1' }, { ...w, end: NOW + 20_000 }, null));
  assert.notEqual(trendMemoKey({ id: 's1' }, w, { id: 'host-1' }), trendMemoKey({ id: 's1' }, w, null));
  assert.notEqual(trendMemoKey({ id: 's1' }, { ...w, custom: true }, null), trendMemoKey({ id: 's1' }, { ...w, custom: true, end: NOW - HOUR }, null));
});
