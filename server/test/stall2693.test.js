/**
 * v2.693 — 운영 멈춤 대응(2026-10-04: 이벤트 루프 701초 정지 뒤 엣지 pull 이 다시 돌지 않았다).
 * ① SAN 포트 사용량 집계는 장비·시간 조각 단위 + 양보이고 결과는 예전 한 문장과 같다.
 * ② 같은 조회는 합류하고 서로 다른 조회는 하나씩 돈다.
 * ③ pull 주기에 상한이 있고, 넘긴 주기는 버리고(abort) 가드를 풀어 새 주기가 돈다.
 * ④ 서비스 점검·iDRAC 배너가 'pull 이 멈췄다' 를 판정한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stall2693-'));
process.env.SSRF_ALLOW_LOOPBACK = 'true';

const HOUR = 3600_000;
// 기준 시각은 정시에서 떨어뜨려 고정한다(CLAUDE.md — 테스트에서 Date.now() 를 기준으로 쓰지 말 것).
const BASE = Math.floor(1_790_000_000_000 / HOUR) * HOUR + 17 * 60_000;

async function seed() {
  const m = await import('../src/sanswitch/perfDb.js');
  const db = await m._dbForTest();
  const ins = db.conn.prepare('INSERT INTO port_perf (device_id, ts, port, bps) VALUES (?,?,?,?)');
  db.conn.exec('BEGIN');
  for (const dev of ['swA', 'swB', 'swC']) {
    for (let t = BASE - 4 * 24 * HOUR; t <= BASE; t += 5 * 60_000 + 7_000) {   // 5분 7초 — 버킷 경계와 어긋나게
      for (let p = 0; p < 6; p++) ins.run(dev, t, p, ((t / 1000) % 997) * (p + 1) + dev.charCodeAt(2));
    }
  }
  db.conn.exec('COMMIT');
  return { m, db };
}

test('① 조각 경계: 이어지고 겹치지 않으며 첫 조각 뒤는 버킷 정배수에서 시작한다', async () => {
  const { sliceBounds } = await import('../src/sanswitch/perfDb.js');
  for (const bucket of [60_000, 720_000, 3 * HOUR, 9 * HOUR]) {
    const since = BASE - 3 * 24 * HOUR + 12_345; const until = BASE;
    const sl = sliceBounds(since, until, bucket);
    assert.equal(sl[0][0], since); assert.equal(sl.at(-1)[1], until);
    for (let i = 1; i < sl.length; i++) {
      assert.equal(sl[i][0], sl[i - 1][1] + 1, '빈틈·겹침 없음');
      assert.equal(sl[i][0] % bucket, 0, '버킷 경계에서 시작');
    }
    assert.ok(sl.length < 400, '조각 수가 폭주하지 않는다');
  }
});

test('② 조각 집계 = 예전 한 문장(전 장비·포트 필터·버킷 크기별)', async () => {
  const { m, db } = await seed();
  for (const bucket of [60_000, 720_000, 2_880_000, 9 * HOUR]) {
    const since = BASE - 3 * 24 * HOUR + 54_321; const until = BASE - 1234;
    const ids = ['swA', 'swB', 'swC'];
    const old = db.conn.prepare(
      `SELECT device_id, port, (ts / ${bucket}) AS b, AVG(bps) AS avg_bps, MAX(bps) AS max_bps, MAX(ts) AS last_ts
         FROM port_perf WHERE device_id IN (?,?,?) AND ts >= ? AND ts <= ? GROUP BY device_id, port, b`,
    ).all(...ids, since, until);
    const neu = await m.bucketAgg(db, ids, since, until, bucket, { lastTs: true });
    const key = (r) => `${r.device_id}|${r.port}|${r.b}`;
    const norm = (rows) => new Map(rows.map((r) => [key(r), [Number(r.avg_bps), Number(r.max_bps), Number(r.last_ts)]]));
    assert.deepEqual(norm(neu), norm(old), `bucket ${bucket}`);
    assert.equal(neu.length, old.length);
    for (let i = 1; i < neu.length; i++) assert.ok(Number(neu[i].b) >= Number(neu[i - 1].b), '버킷 오름차순');
    const oldP = db.conn.prepare(
      `SELECT device_id, port, (ts / ${bucket}) AS b, AVG(bps) AS avg_bps, MAX(bps) AS max_bps
         FROM port_perf WHERE device_id = ? AND ts >= ? AND ts <= ? AND port IN (1,4) GROUP BY port, b`,
    ).all('swB', since, until);
    const neuP = await m.bucketAgg(db, ['swB'], since, until, bucket, { ports: [1, 4] });
    assert.deepEqual(norm(neuP.map((r) => ({ ...r, last_ts: 0 }))), norm(oldP.map((r) => ({ ...r, last_ts: 0 }))));
  }
});

test('③ 조각 사이에 양보한다(장비 × 조각 수만큼 기회)', async () => {
  const m = await import('../src/sanswitch/perfDb.js');
  const db = await m._dbForTest();
  let asked = 0;
  const yielder = async () => { asked++; await new Promise((r) => setImmediate(r)); return true; };
  let ticks = 0; let stop = false;
  const spin = () => { if (stop) return; ticks++; setImmediate(spin); };
  setImmediate(spin);
  await m.bucketAgg(db, ['swA', 'swB', 'swC'], BASE - 4 * 24 * HOUR, BASE, 60_000, { yielder });
  stop = true;
  assert.equal(asked, 3 * m.sliceBounds(BASE - 4 * 24 * HOUR, BASE, 60_000).length);
  assert.ok(ticks >= asked / 2, `다른 작업이 사이사이 돌았다(${ticks})`);
});

test('④ 같은 조회는 합류 · 같은 줄의 다른 조회는 하나씩 · 적재는 기억을 버리지 않고 지금 수집·정리만 버린다(v2.728)', async () => {
  const m = await import('../src/sanswitch/perfDb.js');
  m.invalidatePerfQueries();
  const before = m.perfQueryStats();
  const args = { from: BASE - 2 * 24 * HOUR, to: BASE };
  const [a, b] = await Promise.all([m.storageSeriesMulti(['swA', 'swB'], args), m.storageSeriesMulti(['swA', 'swB'], args)]);
  assert.equal(a, b, '같은 결과 객체(합류)');
  const mid = m.perfQueryStats();
  assert.equal(mid.runs - before.runs, 1); assert.ok(mid.joined - before.joined >= 1);
  // 직렬: 같은 줄(법인 단위)의 서로 다른 조회 두 개는 줄을 선다(둘 다 대기열에 들어간 뒤 하나씩 실행된다)
  const q0 = m.perfQueryStats().maxQueue;
  await Promise.all([m.storageSeriesMulti(['swC'], args), m.storageSeriesMulti(['swA'], args)]);
  assert.ok(m.perfQueryStats().maxQueue >= Math.max(2, q0), '두 조회가 동시에 대기열에 있었다(한 번에 하나)');
  // v2.728(SAN 1차 ②): 적재는 기억을 버리지 않는다 — 기억 시간(수집 주기) 안에서는 같은 결과
  const c1 = await m.storageSeriesMulti(['swA', 'swB'], args);
  assert.equal(c1, a, 'TTL 안에서는 기억한 결과');
  await m.importSamples([{ d: 'swA', ts: BASE - 1000, p: 0, b: 1 }], [], 3650);
  const c2 = await m.storageSeriesMulti(['swA', 'swB'], args);
  assert.equal(c2, a, '적재만으로는 기억을 버리지 않는다(엣지 전송·스위치 1대 저장마다 다시 집계하던 것)');
  // 사람이 누른 '지금 수집'·'지금 정리' 는 버린다(라우트가 invalidatePerfQueries 를 부른다)
  m.invalidatePerfQueries();
  const c3 = await m.storageSeriesMulti(['swA', 'swB'], args);
  assert.notEqual(c3, a, '명시적으로 버리면 새로 계산');
});

test('⑤ pull 주기 상한·판정(순수)', async () => {
  const { pullCycleMaxMs, pullerHealth } = await import('../src/collector/puller.js');
  assert.equal(pullCycleMaxMs(60_000, ''), 5 * 60_000);
  assert.equal(pullCycleMaxMs(600_000, undefined), 1_800_000);
  assert.equal(pullCycleMaxMs(60_000, '1000'), 60_000, '하한 60초');
  assert.equal(pullCycleMaxMs(60_000, '0'), 5 * 60_000, '0 은 기본');
  const now = BASE;
  assert.equal(pullerHealth({ intervalMs: 0 }, now).status, 'off');
  const base = { intervalMs: 60_000, cycleMaxMs: 300_000, stuckReleases: 0 };
  assert.equal(pullerHealth({ ...base, running: true, runningForMs: 400_000 }, now).status, 'warn');
  assert.match(pullerHealth({ ...base, running: false, lastEndAt: now - 41 * 60_000 }, now).detail, /돌지 않고/);
  assert.equal(pullerHealth({ ...base, running: false, lastEndAt: now - 30_000, lastTookMs: 2000 }, now).status, 'ok');
  assert.equal(pullerHealth({ ...base, running: false, lastEndAt: now - 30_000, stuckReleases: 1, lastStuckAt: now - 600_000 }, now).status, 'warn');
});

test('⑥ 끝나지 않는 주기는 상한을 넘기면 버려지고(abort) 새 주기가 시작된다', async () => {
  // 응답하지 않는 엣지(헤더를 보내지 않는다)
  const sockets = new Set();
  const srv = http.createServer(() => { /* 응답하지 않는다 */ });
  srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const reg = await import('../src/collector/registry.js');
  const r = reg.addCollector({ id: 'hang-edge', name: 'hang-edge', url: `http://127.0.0.1:${port}`, token: 't' });
  assert.ok(r.ok, r.reason);
  const pl = await import('../src/collector/puller.js');
  pl._resetPullerForTest();
  const warns = []; const ow = console.warn; console.warn = (...a) => { warns.push(a.join(' ')); };
  try {
    const first = pl.pullNow();
    await new Promise((res) => setTimeout(res, 150));
    assert.equal(pl.pullerStatus().running, true, '첫 주기가 응답을 기다린다');
    assert.equal(pl.pullerStatus().busy, 1);
    // 상한 이내면 건너뛴다(예전 동작)
    await pl.pullNow();
    assert.equal(pl.pullerStatus().stuckReleases, 0);
    // 상한을 넘긴 것으로 만든다
    pl._ageCycleForTest(pl.pullCycleMaxMs() + 1000);
    const tAbort = Date.now();
    const second = pl.pullNow();
    await first;   // abort 로 첫 주기가 끝난다(영원히 매달리지 않는다)
    assert.ok(Date.now() - tAbort < 3000, `버린 주기는 abort 로 곧바로 끝난다(${Date.now() - tAbort}ms — 요청 시한 20초를 기다리면 abort 가 없는 것)`);
    const st = pl.pullerStatus();
    assert.equal(st.stuckReleases, 1);
    assert.ok(warns.some((w) => /끝나지 않아/.test(w) && /버리고/.test(w)), warns.join('\n'));
    assert.equal(st.cycles, 2, '새 주기가 시작됐다');
    pl._ageCycleForTest(pl.pullCycleMaxMs() + 1000);
    const third = pl.pullNow();
    await Promise.all([second, third]);
  } finally {
    console.warn = ow;
    for (const s of sockets) s.destroy();
    srv.close();
    reg.removeCollector('hang-edge');
    pl._resetPullerForTest();
  }
});

test('⑦ iDRAC 배너 판정: ok 로 남은 상태라도 정상 pull 이 오래되면 pullStale', async () => {
  const { pullStaleOf, idracStateOf } = await import('../src/routes/admin/idracTrend.js');
  const now = BASE;
  assert.equal(pullStaleOf(now - 41 * 60_000, { intervalMs: 60_000 }, now).pullStale, true);
  assert.equal(pullStaleOf(now - 2 * 60_000, { intervalMs: 60_000 }, now).pullStale, false);
  assert.equal(pullStaleOf(now - 41 * 60_000, null, now).pullStale, false, 'puller 를 모르면 판정하지 않는다');
  const st = idracStateOf({ remote: true, collectorId: 'gm1' }, {
    now, latest: { t: now - 50 * 60_000 }, collector: { ok: true, at: now - 41 * 60_000 }, puller: { intervalMs: 60_000, stuckReleases: 0, runningForMs: null },
  });
  assert.equal(st.collector.ok, true);
  assert.equal(st.collector.pullStale, true);
});
