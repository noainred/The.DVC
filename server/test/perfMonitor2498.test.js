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
test('bucketIndex/percentileFromBuckets — 경계와 ∞ 버킷', () => {
  assert.equal(S.bucketIndex(0), 0);
  assert.equal(S.bucketIndex(50), 0);
  assert.equal(S.bucketIndex(51), 1);
  assert.equal(S.bucketIndex(60_000), S.BUCKETS_MS.length - 1);
  assert.equal(S.bucketIndex(60_001), S.BUCKETS_MS.length);
  assert.equal(S.bucketIndex(NaN), 0);
  assert.equal(S.percentileFromBuckets(new Array(S.BUCKET_N).fill(0), 95), null, '표본 0 이면 null(0 으로 채우지 않는다)');
  const counts = new Array(S.BUCKET_N).fill(0);
  counts[0] = 90; counts[5] = 10; // 90건 ≤50ms, 10건 1000~2000ms
  const p50 = S.percentileFromBuckets(counts, 50);
  const p95 = S.percentileFromBuckets(counts, 95);
  assert.ok(p50 <= 50, `p50=${p50}`);
  assert.ok(p95 > 1000 && p95 <= 2000, `p95=${p95}`);
  const inf = new Array(S.BUCKET_N).fill(0); inf[S.BUCKET_N - 1] = 3;
  assert.equal(S.percentileFromBuckets(inf, 99), 60_000, '∞ 버킷은 마지막 경계를 하한으로 돌려준다');
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

test('스톨 구간에 걸친 요청은 wall 이 짧아도 stall 사유로 기록된다(기다림과 막힘을 구분)', () => {
  M._resetPerfMonitorForTest();
  SET.savePerfSettings({ ...SET.DEFAULTS, slowRequestMs: 10_000, hangLagMs: 500 });
  const id = M.beginRequest({ method: 'GET', path: '/api/overview' });
  M.recordLoopWindow({ maxMs: 1_200, p99Ms: 800, meanMs: 30 });  // 요청 도중 루프가 막혔다
  M.endRequest(id, { method: 'GET', path: '/api/overview', route: '/api/overview', status: 200, ms: 900 });
  const snap = M.perfSnapshot();
  assert.equal(snap.slow.length, 1);
  assert.equal(snap.slow[0].reason, 'stall');
  assert.ok(snap.slow[0].stallMs >= 1_200);
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

test('유계 — 라우트 키·링 버퍼가 무한히 자라지 않는다', () => {
  M._resetPerfMonitorForTest();
  SET.savePerfSettings({ ...SET.DEFAULTS, slowRequestMs: 200, keepSlow: 50 });
  for (let i = 0; i < 500; i++) {
    const id = M.beginRequest({ method: 'GET', path: `/api/x/${i}` });
    M.endRequest(id, { method: 'GET', path: `/api/x/${i}`, route: `/api/uniq-${i}`, status: 200, ms: 300 });
  }
  const snap = M.perfSnapshot({ routeLimit: 400 });
  assert.ok(snap.totals.routeKeys <= 401, `라우트 키 ${snap.totals.routeKeys} — 상한(400+__other__)을 넘으면 메모리 누수`);
  assert.ok(snap.routes.some((r) => r.route === '__other__'), '초과분은 __other__ 로 합산');
  assert.equal(snap.slow.length, 50, 'keepSlow 상한이 지켜져야 한다');
  assert.equal(snap.totals.requests, 500);
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

test('hang 로그 — 보존일 지난 줄은 정리되고, 없는 파일 조회는 exists:false', () => {
  HL.clearHangs(); HL._resetHangLogCounters();
  assert.equal(HL.readHangs().exists, false);
  const old = Date.now() - 40 * 86_400_000;
  fs.writeFileSync(HL.hangLogFile(), `${JSON.stringify({ kind: 'loop', at: old })}\n${JSON.stringify({ kind: 'loop', at: Date.now() })}\n`);
  const t = HL.trimHangLog(7);
  assert.equal(t.trimmed, 1);
  assert.equal(HL.readHangs().rows.length, 1);
});
