// v2.498 — 서버 성능 측정 회귀 고정.
// (1) 순수 통계: 버킷·백분위 근사·라우트 키 마스킹·랭킹·다운샘플,
// (2) 모니터: 느린 요청만 기록·expectSlow 제외·루프 창/hang·진행 중 요청 추적 누수 없음·유계,
// (3) hang 로그: 파일 append·분당 상한·tail 읽기·보존일 정리, (4) 설정: 클램프·영속.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-'));
process.env.CONFIG_DIR = tmp;
process.env.PERF_HANG_LOG_MAX_PER_MIN = '5';

const S = await import('../src/perf/stats.js');
const SET = await import('../src/perf/settings.js');
const HL = await import('../src/perf/hangLog.js');
const M = await import('../src/perf/monitor.js');

/* ── 순수 통계 ───────────────────────────────────────────────────── */
/** 경계값 → 그 경계가 상한인 버킷 인덱스(테스트가 배열 위치를 굳히지 않게). */
const idxOf = (boundaryMs) => S.BUCKETS_MS.indexOf(boundaryMs);

test('bucketIndex/percentileFromBuckets — 경계와 ∞ 버킷', () => {
  assert.equal(S.bucketIndex(0), 0);
  // 첫 경계는 '가장 빠른 버킷의 상한' 이다 — 값을 굳히지 않고 배열에서 읽는다.
  assert.equal(S.bucketIndex(S.BUCKETS_MS[0]), 0);
  assert.equal(S.bucketIndex(S.BUCKETS_MS[0] + 0.5), 1);
  assert.equal(S.bucketIndex(60_000), S.BUCKETS_MS.length - 1);
  assert.equal(S.bucketIndex(60_001), S.BUCKETS_MS.length);
  assert.equal(S.bucketIndex(NaN), 0);
  assert.equal(S.percentileFromBuckets(new Array(S.BUCKET_N).fill(0), 95), null, '표본 0 이면 null(0 으로 채우지 않는다)');
  const counts = new Array(S.BUCKET_N).fill(0);
  counts[idxOf(50)] = 90; counts[idxOf(2000)] = 10; // 90건 25~50ms, 10건 1000~2000ms
  const p50 = S.percentileFromBuckets(counts, 50);
  const p95 = S.percentileFromBuckets(counts, 95);
  assert.ok(p50 <= 50, `p50=${p50}`);
  assert.ok(p95 > 1000 && p95 <= 2000, `p95=${p95}`);
  const inf = new Array(S.BUCKET_N).fill(0); inf[S.BUCKET_N - 1] = 3;
  assert.equal(S.percentileFromBuckets(inf, 99), 60_000, '∞ 버킷은 마지막 경계를 하한으로 돌려준다');
});

/**
 * v2.503 회귀 고정 — **50ms 미만 구간의 해상도**.
 *
 * v2.498 의 첫 경계는 50ms 였다. 이 서버의 API 는 거의 전부 스냅샷 집계라 50ms 미만이므로
 * 모든 표본이 0번 버킷에 몰렸고, `summarizeRoute` 의 '관측 최댓값 상한' 때문에 p50·p95·p99 가
 * 전부 maxMs 로 같아졌다 — 표가 '측정하고 있다' 는 착시만 주고 튜닝 정보를 주지 않았다.
 * 아래 두 검사는 그 상태로 되돌아가면 실패한다.
 */
test('버킷 해상도 — 50ms 미만에서도 백분위가 구분된다(v2.503)', () => {
  assert.ok(S.BUCKETS_MS[0] <= 1, `첫 경계가 ${S.BUCKETS_MS[0]}ms — 1ms 이하여야 한다`);
  for (const b of [2, 5, 10, 25]) {
    assert.ok(S.BUCKETS_MS.includes(b), `${b}ms 경계가 없으면 밀리초대 구분이 무너진다`);
  }

  // 2ms 짜리 라우트와 25ms 짜리 라우트가 서로 다른 버킷에 들어가야 한다.
  assert.notEqual(S.bucketIndex(2), S.bucketIndex(25));

  // ① 라우트끼리 구분된다 — 2ms 라우트와 25ms 라우트의 p50 이 같으면 표가 쓸모없다.
  const fast = S.newRouteEntry(); for (let i = 0; i < 100; i++) S.addSample(fast, { ms: 2 });
  const slow = S.newRouteEntry(); for (let i = 0; i < 100; i++) S.addSample(slow, { ms: 25 });
  const f = S.summarizeRoute('/datastores', fast);
  const w = S.summarizeRoute('/vms', slow);
  assert.ok(f.p50Ms < w.p50Ms, `p50 이 구분되지 않는다(${f.p50Ms} vs ${w.p50Ms})`);

  // ② 한 라우트 안에서 꼬리가 보인다 — 90건 2ms + 10건 40ms 면 p50 과 p95 가 달라야 한다.
  //    v2.498 버킷에서는 둘 다 40(=maxMs)으로 붕괴했다.
  const e = S.newRouteEntry();
  for (let i = 0; i < 90; i++) S.addSample(e, { ms: 2 });
  for (let i = 0; i < 10; i++) S.addSample(e, { ms: 40 });
  const sum = S.summarizeRoute('/hosts', e);
  assert.ok(sum.p50Ms <= 2, `p50=${sum.p50Ms} — 대다수가 2ms 인데 더 크면 안 된다`);
  assert.ok(sum.p95Ms > sum.p50Ms, `p95(${sum.p95Ms}) 가 p50(${sum.p50Ms}) 과 같으면 붕괴 상태다`);
  assert.ok(sum.p95Ms <= sum.maxMs, '백분위는 관측 최댓값을 넘지 않는다');
});

test('routeKeyOf — 템플릿 우선, 없으면 식별자 마스킹(카디널리티 유계)', () => {
  assert.equal(S.routeKeyOf({ baseUrl: '/api', routePath: '/vcenters/:id/usage-history' }), '/api/vcenters/:id/usage-history');
  assert.equal(S.routeKeyOf({ baseUrl: '/api', routePath: '/' }), '/api');
  assert.equal(S.routeKeyOf({ path: '/api/vms/12345/spark' }), '/api/vms/:id/spark');
  assert.equal(S.routeKeyOf({ path: '/api/idrac/550e8400-e29b-41d4-a716-446655440000/sensors' }), '/api/idrac/:id/sensors');
  assert.equal(S.routeKeyOf({ path: '/api/vms/vc1:vm-42' }), '/api/vms/:id', 'vCenter 복합 id(콜론)도 마스킹');
  assert.equal(S.routeKeyOf({ path: '/api/hosts/host-99' }), '/api/hosts/:id');
  assert.equal(S.routeKeyOf({ path: '/api/tools/waste' }), '/api/tools/waste', '고정 경로는 그대로');
});

test('addSample/summarizeRoute/rankRoutes — 누계와 정렬(자주 느린 것 우선)', () => {
  const e = S.newRouteEntry();
  S.addSample(e, { ms: 10, status: 200, ts: 1 });
  S.addSample(e, { ms: 5_000, status: 500, ts: 2, slow: true });
  const r = S.summarizeRoute('/api/x', e);
  assert.equal(r.n, 2); assert.equal(r.slowN, 1); assert.equal(r.errN, 1);
  assert.equal(r.maxMs, 5_000); assert.equal(r.avgMs, 2_505);
  // 백분위는 관측 최댓값을 넘지 않는다 — 4ms 1건인 라우트가 'p95 50ms'(버킷 상한)로 보이면 오정보다.
  const one = S.newRouteEntry();
  S.addSample(one, { ms: 4, status: 200, ts: 1 });
  const r1 = S.summarizeRoute('/api/one', one);
  assert.equal(r1.p95Ms, 4, `p95=${r1.p95Ms} — 최댓값 4ms 를 넘으면 안 된다`);
  assert.equal(r1.p50Ms, 4);
  const ranked = S.rankRoutes([
    { route: 'a', slowN: 0, p95Ms: 900, n: 100 },
    { route: 'b', slowN: 5, p95Ms: 100, n: 10 },
  ]);
  assert.equal(ranked[0].route, 'b');
});

test('downsampleMax — 최댓값을 보존하며 점 수를 줄인다', () => {
  const w = Array.from({ length: 1000 }, (_, i) => ({ ts: i, maxMs: i === 500 ? 9_999 : 1 }));
  const out = S.downsampleMax(w, 100);
  assert.equal(out.length, 100);
  assert.ok(out.some((x) => x.maxMs === 9_999), '피크가 사라지면 스톨을 놓친다');
  assert.equal(S.downsampleMax(w.slice(0, 50), 100).length, 50);
});

/* ── 설정 ───────────────────────────────────────────────────────── */
test('설정 — 범위 클램프 + 파일 영속 + 잘못된 값 무시', () => {
  SET._resetPerfSettingsCache();
  const d = SET.loadPerfSettings();
  assert.equal(d.enabled, true);
  assert.equal(d.slowRequestMs, SET.DEFAULTS.slowRequestMs);
  const s1 = SET.savePerfSettings({ slowRequestMs: 5, hangLagMs: 999_999, keepSlow: 10, retentionDays: 999, enabled: false });
  assert.equal(s1.slowRequestMs, SET.LIMITS.slowRequestMs.min);
  assert.equal(s1.hangLagMs, SET.LIMITS.hangLagMs.max);
  assert.equal(s1.keepSlow, SET.LIMITS.keep.min);
  assert.equal(s1.retentionDays, SET.LIMITS.retentionDays.max);
  assert.equal(s1.enabled, false);
  SET._resetPerfSettingsCache();
  assert.equal(SET.loadPerfSettings().slowRequestMs, SET.LIMITS.slowRequestMs.min, '파일에서 다시 읽어도 유지');
  const s2 = SET.savePerfSettings({ slowRequestMs: 'abc' });
  assert.equal(s2.slowRequestMs, SET.LIMITS.slowRequestMs.min, '숫자가 아니면 직전 값 유지');
  SET.savePerfSettings({ ...SET.DEFAULTS });
});

/* ── 모니터 ─────────────────────────────────────────────────────── */
test('요청 계측 — 임계 초과만 기록하고 진행 중 요청은 누수 없이 정리된다', () => {
  SET._resetPerfSettingsCache(); SET.savePerfSettings({ ...SET.DEFAULTS, slowRequestMs: 1_000 });
  M._resetPerfMonitorForTest();
  const fast = M.beginRequest({ method: 'GET', path: '/api/tools/waste' });
  assert.equal(M.inflightSnapshot().length, 1, '진행 중 요청이 보인다(hang 진단 근거)');
  M.endRequest(fast, { method: 'GET', path: '/api/tools/waste', route: '/api/tools/waste', status: 200, ms: 120 });
  const slow = M.beginRequest({ method: 'GET', path: '/api/insights/finops' });
  M.endRequest(slow, { method: 'GET', path: '/api/insights/finops', route: '/api/insights/finops', status: 200, ms: 4_000, user: 'kim' });
  const snap = M.perfSnapshot();
  assert.equal(snap.inflight.length, 0, '끝난 요청이 남으면 진행 중 목록이 거짓이 된다');
  assert.equal(snap.totals.requests, 2);
  assert.equal(snap.totals.slow, 1);
  assert.equal(snap.slow.length, 1);
  assert.equal(snap.slow[0].route, '/api/insights/finops');
  assert.equal(snap.slow[0].reason, 'wall');
  assert.equal(snap.slow[0].user, 'kim');
  const byRoute = new Map(snap.routes.map((r) => [r.route, r]));
  assert.equal(byRoute.get('/api/tools/waste').n, 1);
  assert.equal(byRoute.get('/api/insights/finops').slowN, 1);
});

test('expectSlow 라우트(롱폴·vCenter 태스크)는 월타임 기준으로 느린 요청에 넣지 않는다', () => {
  M._resetPerfMonitorForTest();
  const id = M.beginRequest({ method: 'POST', path: '/api/central/rma-poll' });
  M.endRequest(id, { method: 'POST', path: '/api/central/rma-poll', route: '/api/central/rma-poll', status: 200, ms: 55_000, expectSlow: true });
  const snap = M.perfSnapshot();
  assert.equal(snap.slow.length, 0, '정상 대기를 느린 요청으로 채우면 목록이 쓸모없어진다');
  assert.equal(snap.totals.requests, 1, '집계에는 들어간다');
  assert.equal(snap.routes.find((r) => r.route === '/api/central/rma-poll').maxMs, 55_000);
});

test('이벤트 루프 창 — 임계 초과면 hang 이벤트 + 활성 작업 이름이 남는다', () => {
  M._resetPerfMonitorForTest(); HL._resetHangLogCounters();
  SET.savePerfSettings({ ...SET.DEFAULTS, hangLagMs: 500 });
  M.recordLoopWindow({ maxMs: 80, p99Ms: 20, meanMs: 3 });
  assert.equal(M.perfSnapshot().hangs.length, 0, '조용한 창은 이벤트가 아니다');
  const job = M.beginJob('store.refresh');
  M.recordLoopWindow({ maxMs: 2_500, p99Ms: 900, meanMs: 40, eluPct: 91.2 });
  M.endJob(job);
  const snap = M.perfSnapshot();
  assert.equal(snap.hangs.length, 1);
  assert.equal(snap.hangs[0].kind, 'loop');
  assert.equal(snap.hangs[0].maxMs, 2_500);
  assert.deepEqual(snap.hangs[0].jobs, ['store.refresh'], '무엇이 돌던 중인지가 튜닝의 출발점이다');
  assert.equal(snap.loop.windows.length, 2);
  assert.equal(snap.loop.stallWindowCount, 1);
  assert.equal(snap.loop.last.eluPct, 91.2);
  assert.equal(M.activeJobNames().length, 0, 'endJob 후 활성 작업이 남으면 안 된다');
});

test('루프 정체 창과 겹친 요청은 wall 이 짧아도 stall 사유로 기록된다(기다림과 막힘을 구분)', () => {
  M._resetPerfMonitorForTest();
  SET.savePerfSettings({ ...SET.DEFAULTS, slowRequestMs: 10_000, hangLagMs: 500 });
  M.recordLoopWindow({ maxMs: 1_200, p99Ms: 800, meanMs: 30 });   // 30초 창에서 1.2초 정체가 관측됐다
  const id = M.beginRequest({ method: 'GET', path: '/api/overview' });
  M.endRequest(id, { method: 'GET', path: '/api/overview', route: '/api/overview', status: 200, ms: 900 });
  const snap = M.perfSnapshot();
  assert.equal(snap.slow.length, 1, '임계(10초) 미만이지만 정체 창과 겹쳐 기록돼야 한다');
  assert.equal(snap.slow[0].reason, 'stall');
  // 귀속량은 '요청 구간 ∩ 정체 창' 이다. 창은 recordLoopWindow 시점에 닫히므로 이 테스트가 다음 줄로
  // 넘어가는 데 걸린 시간(CI 에서 1~수 ms)만큼 겹침이 줄어든다 — 정확히 900 을 단정하면 실측 시간에
  // 따라 깨진다(실제로 CI 에서 899 로 실패). 고정할 사실은 두 가지: ① 요청 길이를 넘지 않는다
  // (창 자체는 1,200ms 지만 900ms 요청에 1,200 을 씌우지 않는다) ② 창이 구간을 덮으므로 거의 전 구간이다.
  const { stallMs } = snap.slow[0];
  assert.ok(stallMs <= 900, `귀속은 요청 길이를 넘지 못한다(물리적 상한) — ${stallMs}`);
  assert.ok(stallMs >= 800, `창이 요청 구간을 덮으므로 거의 전 구간이 귀속돼야 한다 — ${stallMs}`);
});

test('짧은 요청은 정체 창 전체를 뒤집어쓰지 않는다(거짓양성 차단)', () => {
  M._resetPerfMonitorForTest();
  SET.savePerfSettings({ ...SET.DEFAULTS, slowRequestMs: 10_000, hangLagMs: 500 });
  M.recordLoopWindow({ maxMs: 25_000, p99Ms: 20_000, meanMs: 900 }); // 25초 정체가 있던 창
  const id = M.beginRequest({ method: 'GET', path: '/api/health' });
  M.endRequest(id, { method: 'GET', path: '/api/health', route: '/api/health', status: 200, ms: 5 });
  const snap = M.perfSnapshot();
  assert.equal(snap.slow.length, 0, '5ms 요청이 25초 정체를 뒤집어쓰면 느린 요청 목록이 쓰레기가 된다');
  assert.equal(M.stallsBetween(Date.now() - 5, Date.now()).ms <= 5, true);
});

test('요청보다 과거에 닫힌 창은 귀속되지 않는다', () => {
  M._resetPerfMonitorForTest();
  SET.savePerfSettings({ ...SET.DEFAULTS, slowRequestMs: 10_000, hangLagMs: 500 });
  M.recordLoopWindow({ maxMs: 2_000, p99Ms: 1_500, meanMs: 50, windowMs: 1 }); // 창 길이 1ms(먼 과거로 취급)
  const now = Date.now();
  const r = M.stallsBetween(now + 1_000, now + 2_000);  // 창보다 미래 구간
  assert.equal(r.ms, 0);
  assert.equal(r.n, 0);
});

test('브라우저 장기 로딩 보고 — 서버 사실(진행 중 요청·루프·활성 작업)과 함께 남는다', () => {
  M._resetPerfMonitorForTest(); HL._resetHangLogCounters();
  SET.savePerfSettings({ ...SET.DEFAULTS });
  const pending = M.beginRequest({ method: 'GET', path: '/api/insights/finops' });
  M.recordLoopWindow({ maxMs: 10, p99Ms: 5, meanMs: 1 });
  const r = M.recordClientStall({
    user: 'lee', ip: '10.0.0.9', view: '#/insights/finops', path: '/insights/finops', ms: 187_000,
    inflight: [{ path: '/insights/finops/config', ms: 120_000 }], userAgent: 'Mozilla/5.0',
  });
  assert.equal(r.ok, true);
  const snap = M.perfSnapshot();
  const ev = snap.hangs[0];
  assert.equal(ev.kind, 'client');
  assert.equal(ev.user, 'lee');
  assert.equal(ev.ms, 187_000);
  assert.equal(ev.clientInflight[0].path, '/insights/finops/config');
  assert.equal(ev.serverInflightN, 1, '서버가 그때 무엇을 처리 중이었는지가 귀속의 핵심');
  assert.equal(ev.serverInflight[0].path, '/api/insights/finops');
  assert.ok(ev.loop, '그 시각 루프 창을 함께 남긴다');
  assert.equal(snap.totals.clientStalls, 1);
  M.endRequest(pending, { status: 200, ms: 1 });
});

test('유계 — 라우트 키는 상한에서 가장 오래된 것을 퇴출하고(합산이 아니라) 링 버퍼도 유계다', () => {
  M._resetPerfMonitorForTest();
  SET.savePerfSettings({ ...SET.DEFAULTS, slowRequestMs: 200, keepSlow: 50 });
  for (let i = 0; i < 500; i++) {
    const id = M.beginRequest({ method: 'GET', path: `/api/x/${i}` });
    M.endRequest(id, { method: 'GET', path: `/api/x/${i}`, route: `/api/uniq-${i}`, status: 200, ms: 300 });
  }
  const snap = M.perfSnapshot({ routeLimit: 400 });
  assert.ok(snap.totals.routeKeys <= 400, `라우트 키 ${snap.totals.routeKeys} — 상한을 넘으면 메모리 누수`);
  assert.ok(snap.totals.routesEvicted >= 100, `퇴출 ${snap.totals.routesEvicted}건 — 합산(__other__)으로 접으면 쓰레기 키가 실제 라우트를 재시작까지 가린다`);
  const keys = new Set(snap.routes.map((r) => r.route));
  assert.ok(keys.has('/api/uniq-499'), '최신 키는 남아야 한다');
  assert.ok(!keys.has('/api/uniq-0'), '가장 오래된 키가 퇴출돼야 한다');
  assert.equal(snap.slow.length, 50, 'keepSlow 상한이 지켜져야 한다');
  assert.equal(snap.totals.requests, 500);
});

test('끝나지 않은 요청은 나이로 수확되고 그 수를 숨기지 않는다', () => {
  M._resetPerfMonitorForTest();
  SET.savePerfSettings({ ...SET.DEFAULTS });
  M.beginRequest({ method: 'GET', path: '/api/abandoned' });   // endRequest 가 영원히 안 온다(버려진 응답)
  assert.equal(M.inflightSnapshot().length, 1);
  assert.equal(M.reapInflight(0), 1, '나이 상한 0 이면 즉시 수확');
  assert.equal(M.inflightSnapshot().length, 0);
  assert.equal(M.perfSnapshot().totals.reaped, 1);
});

test('진행 중 요청의 경로는 절단된다(긴 URL 이 hang 기록으로 증폭되지 않게)', () => {
  M._resetPerfMonitorForTest();
  const long = `/api/${'a'.repeat(5_000)}`;
  M.beginRequest({ method: 'GET', path: long });
  const row = M.inflightSnapshot()[0];
  assert.equal(row.path.length, 200);
  assert.equal(row.route, undefined, '진행 중 항목에는 라우트 템플릿이 없다(없는 값을 열로 만들지 않는다)');
});

test('설정 enabled=false 면 기록을 멈추지만 진행 중 요청 추적은 유지된다', () => {
  M._resetPerfMonitorForTest();
  SET.savePerfSettings({ ...SET.DEFAULTS, enabled: false, slowRequestMs: 200 });
  const id = M.beginRequest({ method: 'GET', path: '/api/off' });
  assert.equal(M.inflightSnapshot().length, 1);
  M.endRequest(id, { method: 'GET', path: '/api/off', route: '/api/off', status: 200, ms: 9_000 });
  const snap = M.perfSnapshot();
  assert.equal(snap.totals.requests, 0);
  assert.equal(snap.slow.length, 0);
  assert.equal(snap.inflight.length, 0, '추적은 계속하되 집계만 멈춘다');
  SET.savePerfSettings({ ...SET.DEFAULTS });
});

test('withJob — 예외가 나도 활성 작업이 남지 않는다', async () => {
  M._resetPerfMonitorForTest();
  await assert.rejects(M.withJob('boom', async () => { throw new Error('x'); }));
  assert.deepEqual(M.activeJobNames(), []);
  await M.withJob('ok', async () => {});
  assert.deepEqual(M.activeJobNames(), []);
});

/* ── hang 로그 파일 ─────────────────────────────────────────────── */
test('hang 로그 — 파일에 append 되고 최신 먼저 읽히며 분당 상한을 넘으면 버리고 정직하게 센다', async () => {
  HL.clearHangs(); HL._resetHangLogCounters();
  // at 을 1ms 씩 벌려 둔다 — 조회는 파일 순서가 아니라 at 기준 최신 먼저여야 한다.
  const base = Date.now();
  for (let i = 0; i < 8; i++) HL.appendHang({ kind: 'loop', maxMs: 1_000 + i, at: base + i });
  await HL.flushHangLog();
  const st = HL.hangLogStatus();
  assert.equal(st.maxPerMin, 5, 'PERF_HANG_LOG_MAX_PER_MIN 이 반영돼야 한다');
  assert.equal(st.dropped, 3, '상한 초과분은 버리고 카운터로 남긴다(조용히 삼키지 않는다)');
  const r = HL.readHangs({ limit: 10 });
  assert.equal(r.rows.length, 5);
  assert.equal(r.rows[0].maxMs, 1_004, '최신(at 최대) 먼저');
  assert.deepEqual(r.rows.map((x) => x.maxMs), [1_004, 1_003, 1_002, 1_001, 1_000], 'at 내림차순');
  assert.equal(HL.readHangs({ kind: 'client' }).rows.length, 0, 'kind 필터');
  assert.ok(fs.readFileSync(HL.hangLogFile(), 'utf8').trim().split('\n').length === 5);
});

test('hang 로그 — 동시 다발 기록이 유실·중복 없이 모두 들어간다(쓰기 직렬화)', async () => {
  HL._setHangLogMaxPerMinForTest(500);   // 이 테스트만 분당 상한을 올린다
  HL.clearHangs(); HL._resetHangLogCounters();
  // appendFile 을 동시에 여러 번 부르면 스레드풀 순서가 보장되지 않고, 그 사이 트림이 끼면
  // 줄이 사라진다(v2.498 개발 중 실측). 큐 + 동시 1건 쓰기로 그것을 막는다.
  const base = Date.now();
  const N = 120;
  for (let i = 0; i < N; i++) HL.appendHang({ kind: 'loop', maxMs: i, at: base + i });
  const f = await HL.flushHangLog();
  assert.equal(f.pending, 0);
  const r = HL.readHangs({ limit: 2_000 });
  assert.equal(r.total, N, `파일 줄 수 ${r.total} — 유실/중복 없이 ${N} 줄이어야 한다`);
  assert.equal(r.badLines || 0, 0, '줄이 섞여 JSON 이 깨지면 안 된다');
  assert.equal(new Set(r.rows.map((x) => x.maxMs)).size, N, '중복 없음');
  assert.equal(r.rows[0].maxMs, N - 1, '최신 먼저');
  assert.equal(HL.hangLogStatus().appended, N);
  HL._setHangLogMaxPerMinForTest(0);     // 원래 상한으로 복원
});

test('hang 로그 — 바이트 상한으로 파일이 실제로 줄어든다(줄 수만 보면 트림이 무력해진다)', () => {
  HL.clearHangs(); HL._resetHangLogCounters();
  // 이벤트 1건이 ~1KB 라, 줄 수 상한(기본 20,000)만 보면 꼬리 8MB 안에서 절대 도달하지 않아
  // 파일이 무한히 자란다(개발 중 20.8MB 파일에서 trimmed 0 으로 실측). 바이트 상한으로 판정한다.
  const line = JSON.stringify({ kind: 'loop', at: Date.now(), pad: 'x'.repeat(900) });
  const N = 3_000;                                  // 약 2.7MB
  fs.writeFileSync(HL.hangLogFile(), `${new Array(N).fill(line).join('\n')}\n`);
  const before = fs.statSync(HL.hangLogFile()).size;
  assert.ok(before > 2_000_000, `사전 조건: ${before} 바이트`);
  // 기본 상한(8MB) 아래에서는 줄어들지 않아야 한다(과도한 트림도 결함이다).
  assert.equal(HL.trimHangLog(0).trimmed, 0);
  assert.equal(fs.statSync(HL.hangLogFile()).size, before);
  // 상한을 1MB 로 낮추면 꼬리만 남기고 실제로 줄어든다.
  HL._setHangLogMaxBytesForTest(1_000_000);
  const t = HL.trimHangLog(0);
  const after = fs.statSync(HL.hangLogFile()).size;
  assert.ok(t.trimmed > 0, `trimmed=${t.trimmed}`);
  assert.ok(after <= 1_000_000, `${after} 바이트 — 상한 아래로 줄어야 한다`);
  assert.ok(after < before);
  assert.equal(HL.readHangs({ limit: 5 }).rows.length, 5, '트림 후에도 읽힌다(줄이 깨지지 않았다)');
  HL._setHangLogMaxBytesForTest(0);
});

test('hang 로그 — 브라우저 보고(client)가 서버 정체(loop) 기록의 분당 예산을 잠식하지 못한다', () => {
  HL._setHangLogMaxPerMinForTest(10);   // client 는 절반(5)까지만
  HL.clearHangs(); HL._resetHangLogCounters();
  let clientOk = 0;
  for (let i = 0; i < 10; i++) if (HL.appendHang({ kind: 'client', at: Date.now() })) clientOk += 1;
  assert.equal(clientOk, 5, 'client 는 전체 예산의 절반까지');
  let loopOk = 0;
  for (let i = 0; i < 10; i++) if (HL.appendHang({ kind: 'loop', at: Date.now() })) loopOk += 1;
  assert.equal(loopOk, 5, '남은 예산은 서버 정체 기록이 쓸 수 있어야 한다(증거가 밀려나면 안 된다)');
  HL._setHangLogMaxPerMinForTest(0);
});

test('hang 링 — client 이벤트가 절반을 넘기면 같은 종류를 밀어내고 loop 기록을 남긴다', () => {
  M._resetPerfMonitorForTest(); HL._resetHangLogCounters(); HL._setHangLogMaxPerMinForTest(600);
  SET.savePerfSettings({ ...SET.DEFAULTS, keepHangs: 50, hangLagMs: 100 });
  M.recordLoopWindow({ maxMs: 5_000, p99Ms: 900, meanMs: 50 });     // 서버 정체 1건
  for (let i = 0; i < 200; i++) M.recordClientStall({ user: `u${i}`, view: '#/x', ms: 90_000 });
  const hangs = M.perfSnapshot({ hangLimit: 100 }).hangs;
  assert.ok(hangs.length <= 50, `링 상한 ${hangs.length}`);
  assert.ok(hangs.some((h) => h.kind === 'loop'), '저권한 계정 보고가 서버 정체 기록을 밀어내면 진단이 불가능해진다');
  HL._setHangLogMaxPerMinForTest(0);
});

test('hang 로그 — 쓰기 중 트림 요청은 미뤄지고(유실 방지) 비우기는 대기 줄까지 버린다', async () => {
  HL._setHangLogMaxPerMinForTest(600);
  HL.clearHangs(); HL._resetHangLogCounters();
  for (let i = 0; i < 20; i++) HL.appendHang({ kind: 'loop', at: Date.now() + i });
  // 아직 쓰기가 진행 중인 이 시점의 트림은 반드시 미뤄져야 한다(rename 으로 줄이 사라진다).
  const t = HL.trimHangLog(7);
  assert.equal(t.deferred, true, '쓰기 중 트림은 함수가 스스로 미뤄야 한다(호출부 규약에 의존 금지)');
  await HL.flushHangLog();
  assert.equal(HL.readHangs({ limit: 100 }).total, 20, '유실 없음');
  // 비우기: 대기 줄이 남아 파일을 되살리면 '비웠다' 는 보고가 거짓이 된다.
  for (let i = 0; i < 30; i++) HL.appendHang({ kind: 'loop', at: Date.now() + i });
  HL.clearHangs();
  await HL.flushHangLog();
  const after = HL.readHangs({ limit: 100 });
  assert.equal(after.exists, false, '비운 뒤 파일이 다시 생기면 안 된다');
  HL._setHangLogMaxPerMinForTest(0);
});

test('설정 — 빈 문자열은 미지정으로 버린다(최소값 승격 금지)', () => {
  SET._resetPerfSettingsCache();
  SET.savePerfSettings({ ...SET.DEFAULTS, retentionDays: 30, hangLagMs: 2_000 });
  const r = SET.savePerfSettings({ retentionDays: '', hangLagMs: '   ', slowRequestMs: null });
  assert.equal(r.retentionDays, 30, "빈 칸이 최소값(1일)으로 굳으면 저장 즉시 hang 기록이 지워진다");
  assert.equal(r.hangLagMs, 2_000);
  assert.equal(r.slowRequestMs, SET.DEFAULTS.slowRequestMs);
  SET.savePerfSettings({ ...SET.DEFAULTS });
});

test('hang 로그 — 보존일 지난 줄은 정리되고, 없는 파일 조회는 exists:false', () => {
  HL.clearHangs(); HL._resetHangLogCounters();
  assert.equal(HL.readHangs().exists, false);
  const old = Date.now() - 40 * 86_400_000;
  fs.writeFileSync(HL.hangLogFile(), `${JSON.stringify({ kind: 'loop', at: old })}\n${JSON.stringify({ kind: 'loop', at: Date.now() })}\n`);
  const t = HL.trimHangLog(7);
  assert.equal(t.trimmed, 1);
  assert.equal(HL.readHangs().rows.length, 1);
});
