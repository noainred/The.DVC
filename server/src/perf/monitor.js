/**
 * perf/monitor.js — 서버 성능 측정기(v2.498). 요청 지연·이벤트 루프 정체·진행 중 요청을 **상시 O(1)**
 * 로 계측하고, 임계를 넘은 것만 남긴다. 설정 › 서버 성능 측정 화면(/api/admin/perf)이 이 값을 읽는다.
 *
 * 사용자 요청: "'불러오는 중…' 이 3분 이상 지속될 때가 있다. 설정에 서버 성능 측정 메뉴를 만들고,
 * 이런 hang 현상이 발생할 때 로그를 찍어 나중에 튜닝할 때 쓰게 하자."
 *
 * 설계 원칙(loopLag.js 와 동일 — 계측이 서비스를 방해하지 않는다):
 *  - 핫패스(요청 시작·종료)는 Map set/delete + 카운터 증가뿐. 디스크 I/O·직렬화 없음.
 *  - 임계 초과 이벤트만 링 버퍼에 담고, hang 은 파일(perf-hangs.ndjson)에 **비동기 append**.
 *  - 모든 저장소는 유계(라우트 400개·링 keepSlow/keepHangs·루프창 2,880개 = 24시간).
 *  - 실패는 조용히 무시(try/catch). 설정 enabled=false 면 기록을 멈춘다(진행 중 요청 추적은 유지 —
 *    hang 진단의 근거라 비용이 Map 1건이다).
 *
 * 왜 '월타임' 과 '루프 정체' 를 나누는가: vCenter 왕복을 기다리는 8초 요청은 정상이고(고RTT),
 * 동기 CPU 로 루프를 막은 800ms 요청이 진짜 문제다. 느린 요청 레코드에 그 구간의 루프 정체
 * (stallMs)를 함께 붙여 **기다림과 막힘을 구분**한다. 이 구분이 없으면 튜닝 대상을 잘못 고른다.
 */
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { loadPerfSettings } from './settings.js';
import { appendHang, hangLogStatus, trimHangLog } from './hangLog.js';
import { newRouteEntry, addSample, summarizeRoute, rankRoutes, routeKeyOf, downsampleMax, stallWindows } from './stats.js';

const MAX_ROUTES = 400;          // 초과분은 '__other__' 로 합산(카디널리티 폭발 방지)
const MAX_INFLIGHT = 5_000;      // 동시 요청 추적 상한(넘으면 추적만 생략 — 집계는 계속)
const LOOP_WINDOWS = 2_880;      // 30초 창 × 2,880 = 24시간
const STALL_RING = 512;          // 스톨 에피소드(요청 구간 대조용)
const MAX_JOB_NAMES = 64;

const routes = new Map();        // routeKey -> entry(stats.newRouteEntry)
const inflight = new Map();      // id -> { t0, method, path, route, user }
let slowRing = [];               // 최근 느린 요청(설정 keepSlow)
let hangRing = [];               // 최근 hang 이벤트(설정 keepHangs)
let loopWindows = [];            // [{ts, maxMs, p99Ms, meanMs, windowMs, eluPct}]
let stalls = [];                 // [{ts, ms, windowMs, jobs:[]}] — 요청 구간과 대조
const activeJobs = new Map();    // 작업명 -> 진입 수(스톨 '누가' 의 근거)

let reqSeq = 0;
let totals = { requests: 0, slow: 0, err: 0, hangs: 0, clientStalls: 0, startedAt: Date.now() };
let lastLoopWindow = null;

/* ── 활성 작업 마킹 ─────────────────────────────────────────────── */
/** 폴러·무거운 잡 진입/이탈 표시(try/finally 1줄). 스톨 이벤트에 '그때 무엇이 돌고 있었나' 를 남긴다. */
export function beginJob(name) {
  const k = String(name || '').slice(0, 60) || 'job';
  if (!activeJobs.has(k) && activeJobs.size >= MAX_JOB_NAMES) return null;
  activeJobs.set(k, (activeJobs.get(k) || 0) + 1);
  return k;
}
export function endJob(k) {
  if (!k) return;
  const n = (activeJobs.get(k) || 0) - 1;
  if (n > 0) activeJobs.set(k, n); else activeJobs.delete(k);
}
export const activeJobNames = () => [...activeJobs.keys()];
/** 잡을 감싸 실행(동기·비동기 모두). 실패해도 endJob 을 보장한다. */
export async function withJob(name, fn) {
  const k = beginJob(name);
  try { return await fn(); } finally { endJob(k); }
}

/* ── 요청 계측 ──────────────────────────────────────────────────── */
/** 요청 시작. 반환 id(종료 때 넘긴다) 또는 null(추적 상한 초과). */
export function beginRequest({ method = '', path = '', route = '' } = {}) {
  if (inflight.size >= MAX_INFLIGHT) return null;
  const id = ++reqSeq;
  inflight.set(id, { t0: performance.now(), ts: Date.now(), method, path, route, user: '' });
  return id;
}

/**
 * 요청 종료. ms 는 호출부가 재는 월타임(전송 완료까지).
 * expectSlow=true 인 라우트(롱폴·vCenter 태스크 대기)는 월타임 기준 '느린 요청' 기록에서 제외하고
 * 루프 정체 기준만 적용한다 — 정상 대기를 느린 요청으로 채우면 목록이 쓸모없어진다.
 */
export function endRequest(id, { method = '', path = '', route = '', status = 0, ms = 0, user = '', bytes = null, expectSlow = false } = {}) {
  let rec = null;
  if (id != null) { rec = inflight.get(id) || null; inflight.delete(id); }
  try {
    const st = loadPerfSettings();
    if (!st.enabled) return;
    const now = Date.now();
    const startedAt = rec?.ts || (now - ms);
    const key = route || rec?.route || routeKeyOf({ path });
    const stall = stallsBetween(startedAt, now);
    const slowByWall = !expectSlow && ms >= st.slowRequestMs;
    const slowByStall = stall.ms >= Math.max(200, Math.round(st.hangLagMs / 2));
    const slow = slowByWall || slowByStall;

    let entry = routes.get(key);
    if (!entry) {
      if (routes.size >= MAX_ROUTES) { entry = routes.get('__other__') || newRouteEntry(); routes.set('__other__', entry); }
      else { entry = newRouteEntry(); routes.set(key, entry); }
    }
    addSample(entry, { ms, status, ts: now, slow });

    totals.requests += 1;
    if (slow) totals.slow += 1;
    if (Number(status) >= 500) totals.err += 1;
    if (!slow) return;
    slowRing.push({
      ts: now, method, path: String(path || '').slice(0, 200), route: key, status: Number(status) || 0,
      ms: Math.round(ms), user: String(user || '').slice(0, 60), bytes: bytes == null ? null : Number(bytes),
      stallMs: Math.round(stall.ms), stallN: stall.n, jobs: stall.jobs.slice(0, 6),
      rssMb: Math.round(process.memoryUsage.rss() / 1048576),
      inflightN: inflight.size,
      reason: slowByStall ? (slowByWall ? 'wall+stall' : 'stall') : 'wall',
    });
    if (slowRing.length > st.keepSlow) slowRing = slowRing.slice(-st.keepSlow);
  } catch { /* 계측 실패는 무시 */ }
}

/* ── 이벤트 루프 창·스톨 ────────────────────────────────────────── */
/**
 * 30초 창 요약 기록(util/loopLag.js 가 호출). max 가 임계를 넘으면 hang 이벤트로 남긴다.
 * 이 함수는 창이 닫히는 시점에만(30초마다 1회) 불린다.
 */
export function recordLoopWindow({ maxMs = 0, p99Ms = 0, meanMs = 0, windowMs = 30_000, eluPct = null } = {}) {
  try {
    const st = loadPerfSettings();
    const now = Date.now();
    const w = { ts: now, maxMs: Math.round(maxMs), p99Ms: Math.round(p99Ms), meanMs: Math.round(meanMs * 10) / 10, windowMs, eluPct };
    lastLoopWindow = w;
    if (!st.enabled) return w;
    loopWindows.push(w);
    if (loopWindows.length > LOOP_WINDOWS) loopWindows = loopWindows.slice(-LOOP_WINDOWS);
    if (maxMs >= st.hangLagMs) {
      stalls.push({ ts: now, ms: Math.round(maxMs), windowMs, jobs: activeJobNames() });
      if (stalls.length > STALL_RING) stalls = stalls.slice(-STALL_RING);
      pushHang({
        kind: 'loop', at: now, maxMs: Math.round(maxMs), p99Ms: Math.round(p99Ms), meanMs: Math.round(meanMs * 10) / 10,
        windowMs, jobs: activeJobNames(), inflight: inflightSnapshot(10), inflightN: inflight.size,
        rssMb: Math.round(process.memoryUsage.rss() / 1048576), heapMb: Math.round(process.memoryUsage().heapUsed / 1048576),
        uptimeSec: Math.round(process.uptime()),
      });
    }
    return w;
  } catch { return null; }
}

/** [t0,t1] 구간에 걸친 스톨 합계(요청이 느릴 때만 호출 — 뒤에서부터 스캔). */
export function stallsBetween(t0, t1) {
  let ms = 0; let n = 0; const jobs = new Set();
  for (let i = stalls.length - 1; i >= 0; i--) {
    const s = stalls[i];
    if (s.ts < t0 - (s.windowMs || 30_000)) break;     // 창 시작이 요청보다 앞 → 더 과거는 볼 필요 없음
    if (s.ts >= t0 && s.ts <= t1 + 1000) { ms += s.ms; n += 1; for (const j of s.jobs || []) jobs.add(j); }
  }
  return { ms, n, jobs: [...jobs] };
}

/** 진행 중 요청 스냅샷(오래 기다린 것 먼저). */
export function inflightSnapshot(limit = 20) {
  const now = performance.now();
  const rows = [];
  for (const [id, r] of inflight) {
    rows.push({ id, method: r.method, path: r.path, route: r.route, ageMs: Math.round(now - r.t0) });
    if (rows.length >= 500) break;                      // 스냅샷 자체가 비싸지 않게
  }
  rows.sort((a, b) => b.ageMs - a.ageMs);
  return rows.slice(0, Math.max(1, limit));
}

/* ── hang 이벤트 ────────────────────────────────────────────────── */
function pushHang(ev) {
  const st = loadPerfSettings();
  hangRing.push(ev);
  if (hangRing.length > st.keepHangs) hangRing = hangRing.slice(-st.keepHangs);
  totals.hangs += 1;
  appendHang(ev);
}

/**
 * 브라우저가 보고한 '화면이 오래 불러오는 중' — 서버가 멈춘 것이 아닐 수 있으므로(뷰 로직 결함,
 * 반열림 연결) 진행 중 요청·루프 상태를 **그 시각의 서버 사실**과 함께 남긴다. 이것이 없으면
 * 3분 로딩 신고를 재현·귀속할 수 없다. 사용자·IP 는 서버가 채운다(본문으로 받지 않는다).
 */
export function recordClientStall({ user = '', ip = '', view = '', path = '', ms = 0, inflight: clientInflight = [], userAgent = '' } = {}) {
  try {
    const now = Date.now();
    const ev = {
      kind: 'client', at: now, user: String(user || '').slice(0, 60), ip: String(ip || '').slice(0, 60),
      view: String(view || '').slice(0, 120), path: String(path || '').slice(0, 200), ms: Math.round(Number(ms) || 0),
      clientInflight: (Array.isArray(clientInflight) ? clientInflight : []).slice(0, 10)
        .map((x) => ({ path: String(x?.path || '').slice(0, 200), ms: Math.round(Number(x?.ms) || 0) })),
      userAgent: String(userAgent || '').slice(0, 160),
      serverInflight: inflightSnapshot(10), serverInflightN: inflight.size,
      loop: lastLoopWindow, jobs: activeJobNames(),
      rssMb: Math.round(process.memoryUsage.rss() / 1048576), uptimeSec: Math.round(process.uptime()),
    };
    totals.clientStalls += 1;
    pushHang(ev);
    return { ok: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}

/* ── 즉시 측정(수동) ────────────────────────────────────────────── */
let measuring = false;
/**
 * '지금 측정' — setImmediate 왕복 지연 표본으로 **현재** 루프 응답성을 잰다(30초 창을 기다리지 않게).
 * 재진입 가드(폴러 규약과 동일). 표본 수는 작게(기본 60) — 측정 자체가 부하가 되지 않게.
 */
export async function measureNow({ samples = 60 } = {}) {
  if (measuring) return { ok: false, busy: true, reason: '이미 측정 중입니다.' };
  measuring = true;
  const t0 = Date.now();
  try {
    const n = Math.max(10, Math.min(500, Number(samples) || 60));
    const lags = [];
    for (let i = 0; i < n; i++) {
      const s = performance.now();
      await new Promise((r) => setImmediate(r));
      lags.push(performance.now() - s);
    }
    lags.sort((a, b) => a - b);
    const at = (p) => lags[Math.min(lags.length - 1, Math.floor((p / 100) * lags.length))];
    const h = monitorEventLoopDelay({ resolution: 10 });
    h.enable();
    await new Promise((r) => setTimeout(r, 1000));
    h.disable();
    const mem = process.memoryUsage();
    return {
      ok: true, samples: n, ms: Date.now() - t0,
      immediate: { p50Ms: round2(at(50)), p95Ms: round2(at(95)), maxMs: round2(lags[lags.length - 1]) },
      histogram1s: { maxMs: round2(h.max / 1e6), p99Ms: round2(h.percentile(99) / 1e6), meanMs: round2(h.mean / 1e6) },
      mem: { rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576), heapTotalMb: Math.round(mem.heapTotal / 1048576), externalMb: Math.round(mem.external / 1048576) },
      inflight: inflightSnapshot(10), inflightN: inflight.size, jobs: activeJobNames(),
    };
  } catch (e) {
    return { ok: false, reason: e.message };
  } finally { measuring = false; }
}
const round2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

/* ── 화면용 스냅샷 ──────────────────────────────────────────────── */
export function perfSnapshot({ routeLimit = 60, slowLimit = 100, hangLimit = 100 } = {}) {
  const st = loadPerfSettings();
  const rows = [];
  for (const [k, e] of routes) rows.push(summarizeRoute(k, e));
  const mem = process.memoryUsage();
  return {
    ok: true,
    settings: st,
    totals: { ...totals, uptimeSec: Math.round(process.uptime()), inflightN: inflight.size, routeKeys: routes.size },
    routes: rankRoutes(rows, routeLimit),
    routesTruncated: rows.length > routeLimit,
    slow: slowRing.slice(-slowLimit).reverse(),
    hangs: hangRing.slice(-hangLimit).reverse(),
    loop: {
      last: lastLoopWindow,
      windows: downsampleMax(loopWindows, 240),
      windowCount: loopWindows.length,
      stallWindowCount: stallWindows(loopWindows, st.hangLagMs).length,
      // loopLag 모니터가 꺼져 있으면 창이 안 들어온다 — '데이터 없음' 의 이유를 단정하지 않고 그대로 알린다.
      monitorEnabled: process.env.LOOP_LAG_MONITOR !== '0',
      recentStalls: stalls.slice(-40).reverse(),
    },
    inflight: inflightSnapshot(20),
    jobs: activeJobNames(),
    mem: { rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576), heapTotalMb: Math.round(mem.heapTotal / 1048576), externalMb: Math.round(mem.external / 1048576) },
    hangLog: hangLogStatus(),
  };
}

/** 보존일 정리(관리자 저장 시·기동 시 1회). */
export function pruneHangLog() { return trimHangLog(loadPerfSettings().retentionDays); }

export function _resetPerfMonitorForTest() {
  routes.clear(); inflight.clear(); activeJobs.clear();
  slowRing = []; hangRing = []; loopWindows = []; stalls = [];
  reqSeq = 0; lastLoopWindow = null;
  totals = { requests: 0, slow: 0, err: 0, hangs: 0, clientStalls: 0, startedAt: Date.now() };
}
