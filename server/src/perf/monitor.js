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
import { appendHang, hangLogStatus, trimHangLog, setHangRetentionProvider } from './hangLog.js';
import { newRouteEntry, addSample, summarizeRoute, rankRoutes, routeKeyOf, downsampleMax, stallWindows } from './stats.js';
import { sanitizeRid } from './requestId.js';

const MAX_ROUTES = 400;          // 넘으면 가장 오래 안 쓴 키를 퇴출한다(아래 routeEntryFor)
const MAX_INFLIGHT = 5_000;      // 동시 요청 추적 상한(넘으면 추적만 생략 — 집계는 계속)
// 끝나지 않은 요청을 수확하는 나이 상한. 정상 장기 요청(롱폴 55초·데이터스토어 탐색 90초)보다
// 충분히 크게 둔다 — 이 값을 넘긴 것은 '응답이 버려졌다' 로 보는 쪽이 실제에 가깝다.
const INFLIGHT_MAX_AGE_MS = Math.max(60_000, Math.min(3_600_000, Number(process.env.PERF_INFLIGHT_MAX_AGE_MS) || 600_000));
const LOOP_WINDOWS = 2_880;      // 30초 창 × 2,880 = 24시간
const STALL_RING = 512;          // 스톨 에피소드(요청 구간 대조용)
const MAX_JOB_NAMES = 64;

const routes = new Map();        // routeKey -> entry(stats.newRouteEntry)
const inflight = new Map();      // id -> { t0, method, path, rid, userOf }
// 최근 끝난 요청(요청 ID → 결과, v2.583). 로딩 화면이 '서버는 이미 응답했다' 와 '서버에 기록이 없다' 를
// 구분하는 근거다. 유계(삽입 순서 Map — 넘치면 가장 오래된 것부터 버린다).
const RECENT_DONE_MAX = 2_000;
const recentDone = new Map();    // rid -> { method, route, status, ms, endedAt, user }
let slowRing = [];               // 최근 느린 요청(설정 keepSlow)
let hangRing = [];               // 최근 hang 이벤트(설정 keepHangs)
let loopWindows = [];            // [{ts, maxMs, p99Ms, meanMs, windowMs, eluPct}]
let stalls = [];                 // [{ts, ms, windowMs, jobs:[]}] — 요청 구간과 대조
const activeJobs = new Map();    // 작업명 -> 진입 수(지금 진행 중)
// **이번 창에서 한 번이라도 실행된 작업 이름.** 스톨 이벤트는 창이 닫힐 때 기록되므로 그 순간의
// activeJobs 만 보면 이미 끝난 작업이 빠진다 — 실제로 루프를 막은 작업이 바로 그 '이미 끝난' 것이다
// (v2.498 개발 중, 엑셀 내보내기가 873ms 를 막았는데 jobs 가 빈 배열로 기록되는 것을 관측).
// 그래서 창 단위로 누적하고 창을 닫을 때 비운다. 정직한 해석: '이 창에서 돌았던 작업' 이며
// 그중 무엇이 막았는지는 단정하지 않는다.
let windowJobs = new Set();

let reqSeq = 0;
let totals = { requests: 0, slow: 0, err: 0, hangs: 0, clientStalls: 0, reaped: 0, untracked: 0, routesEvicted: 0, startedAt: Date.now() };
let lastLoopWindow = null;

/* ── 활성 작업 마킹 ─────────────────────────────────────────────── */
/** 폴러·무거운 잡 진입/이탈 표시(try/finally 1줄). 스톨 이벤트에 '그때 무엇이 돌고 있었나' 를 남긴다. */
export function beginJob(name) {
  const k = String(name || '').slice(0, 60) || 'job';
  if (!activeJobs.has(k) && activeJobs.size >= MAX_JOB_NAMES) return null;
  activeJobs.set(k, (activeJobs.get(k) || 0) + 1);
  if (windowJobs.size < MAX_JOB_NAMES) windowJobs.add(k);
  return k;
}
export function endJob(k) {
  if (!k) return;
  const n = (activeJobs.get(k) || 0) - 1;
  if (n > 0) activeJobs.set(k, n); else activeJobs.delete(k);
}
export const activeJobNames = () => [...activeJobs.keys()];
/** 이번 창에서 실행된 작업 이름(진행 중 + 이미 끝난 것 모두). */
export const windowJobNames = () => [...windowJobs];
/** 잡을 감싸 실행(비동기). 실패해도 endJob 을 보장한다. */
export async function withJob(name, fn) {
  const k = beginJob(name);
  try { return await fn(); } finally { endJob(k); }
}

/**
 * 동기 구간용 — await 를 넣지 않는다. 동기 코드를 withJob(async) 로 감싸면 마이크로태스크가 끼어
 * 호출부의 동기 흐름이 바뀌므로, 값이 즉시 필요한 곳은 이것을 쓴다.
 */
export function withJobSync(name, fn) {
  const k = beginJob(name);
  try { return fn(); } finally { endJob(k); }
}

/* ── 요청 계측 ──────────────────────────────────────────────────── */
/**
 * 요청 시작. 반환 id(종료 때 넘긴다) 또는 null(추적 상한 초과 — 그 횟수는 totals.untracked).
 * path 는 200자로 절단한다 — 이 미들웨어는 인증보다 앞이라 미인증으로도 도달하고, URL 경로만
 * 수 KB 를 보낼 수 있다. 다른 싱크(느린 요청 200자·라우트 키 120자)와 같은 규약을 지켜
 * hang 이벤트·ndjson 이 긴 경로로 증폭되지 않게 한다.
 * 라우트 템플릿은 여기서 알 수 없다(라우터 dispatch 전) — 진행 중 목록에는 경로만 보인다.
 */
export function beginRequest({ method = '', path = '', rid = '', userOf = null } = {}) {
  if (inflight.size >= MAX_INFLIGHT) { totals.untracked += 1; return null; }
  const id = ++reqSeq;
  // userOf: 인증은 이 미들웨어보다 뒤라 시작 시점에는 사용자를 모른다 — 조회할 때 읽는 함수로 둔다.
  inflight.set(id, {
    t0: performance.now(), ts: Date.now(), method: String(method || '').slice(0, 10), path: String(path || '').slice(0, 200),
    rid: sanitizeRid(rid), userOf: typeof userOf === 'function' ? userOf : null,
  });
  return id;
}

/**
 * 응답이 끝나지 않은(finish·close 둘 다 오지 않은) 요청을 나이로 수확한다.
 * 왜 필요한가: express 4 는 async 핸들러의 rejection 을 잡지 않고 이 프로세스는 unhandledRejection
 * 을 로그만 남기고 계속 돈다 — 그 응답은 그냥 버려지고 이벤트가 오지 않는다. 수확이 없으면
 * '진행 중 요청' 패널이 조용히 거짓이 되고(영구 잔류) Map 도 자란다. 저빈도 경로(스냅샷·루프 창)
 * 에서만 부른다. 수확한 수는 숨기지 않고 totals.reaped 로 보인다.
 */
export function reapInflight(maxAgeMs = INFLIGHT_MAX_AGE_MS) {
  if (!inflight.size) return 0;
  const now = performance.now();
  let n = 0;
  for (const [id, r] of inflight) if (now - r.t0 > maxAgeMs) { inflight.delete(id); n += 1; }
  if (n) totals.reaped += n;
  return n;
}

/**
 * 요청 종료. ms 는 호출부가 재는 월타임(전송 완료까지).
 * expectSlow=true 인 라우트(롱폴·vCenter 태스크 대기)는 월타임 기준 '느린 요청' 기록에서 제외하고
 * 루프 정체 기준만 적용한다 — 정상 대기를 느린 요청으로 채우면 목록이 쓸모없어진다.
 */
export function endRequest(id, { method = '', path = '', route = '', status = 0, ms = 0, user = '', bytes = null, expectSlow = false, rid = '' } = {}) {
  let rec = null;
  if (id != null) { rec = inflight.get(id) || null; inflight.delete(id); }
  const reqId = sanitizeRid(rid) || rec?.rid || '';
  // 계측이 꺼져 있어도 '끝났다' 는 사실은 남긴다 — 로딩 화면의 상태 조회가 그것에 기댄다(비용 Map 1건).
  if (reqId) {
    try {
      if (recentDone.has(reqId)) recentDone.delete(reqId);
      recentDone.set(reqId, {
        method: String(method || '').slice(0, 10), route: String(route || routeKeyOf({ path })).slice(0, 120),
        status: Number(status) || 0, ms: Math.round(Number(ms) || 0), endedAt: Date.now(), user: String(user || '').slice(0, 60),
      });
      while (recentDone.size > RECENT_DONE_MAX) recentDone.delete(recentDone.keys().next().value);
    } catch { /* 계측 실패는 무시 */ }
  }
  try {
    const st = loadPerfSettings();
    if (!st.enabled) return;
    const now = Date.now();
    // 요청 구간은 [now-ms, now] 로 본다 — ms 는 호출부가 실제로 측정한 월타임이고, 추적 상한으로
    // rec 가 없을 수도 있다(그때도 같은 기준이어야 판정이 흔들리지 않는다).
    const startedAt = now - Math.max(0, ms);
    const key = route || routeKeyOf({ path });
    const stall = stallsBetween(startedAt, now);
    const slowByWall = !expectSlow && ms >= st.slowRequestMs;
    const slowByStall = stall.ms >= Math.max(200, Math.round(st.hangLagMs / 2));
    const slow = slowByWall || slowByStall;

    addSample(routeEntryFor(key), { ms, status, ts: now, slow });

    totals.requests += 1;
    if (slow) totals.slow += 1;
    if (Number(status) >= 500) totals.err += 1;
    if (!slow) return;
    slowRing.push({
      ts: now, rid: reqId, method, path: String(path || '').slice(0, 200), route: key, status: Number(status) || 0,
      ms: Math.round(ms), user: String(user || '').slice(0, 60), bytes: bytes == null ? null : Number(bytes),
      stallMs: Math.round(stall.ms), stallN: stall.n, jobs: stall.jobs.slice(0, 6),
      rssMb: Math.round(process.memoryUsage.rss() / 1048576),
      inflightN: inflight.size,
      reason: slowByStall ? (slowByWall ? 'wall+stall' : 'stall') : 'wall',
    });
    if (slowRing.length > st.keepSlow) slowRing = slowRing.slice(-st.keepSlow);
  } catch { /* 계측 실패는 무시 */ }
}

/**
 * 라우트 키의 누계 엔트리. 상한에 닿으면 **가장 오래 안 쓴 키를 퇴출**한다.
 * 왜 __other__ 합산이 아닌가: 이 미들웨어는 인증보다 앞이라, 로그인하지 않은 클라이언트가 서로 다른
 * /api 경로 400개를 보내면 표가 쓰레기 키로 가득 차고 **그 뒤의 진짜 라우트가 재시작까지 영원히
 * __other__ 로 접힌다**(레이트리밋 분당 1800 이면 15초면 채운다). 퇴출이면 쓰레기 키는 곧 밀려나고
 * 실제 트래픽이 표를 되찾는다. 퇴출 횟수는 totals.routesEvicted 로 보인다.
 */
function routeEntryFor(key) {
  const hit = routes.get(key);
  if (hit) return hit;
  if (routes.size >= MAX_ROUTES) {
    let oldestKey = null; let oldestTs = Infinity;
    for (const [k, e] of routes) if ((e.lastTs || 0) < oldestTs) { oldestTs = e.lastTs || 0; oldestKey = k; }
    if (oldestKey != null) { routes.delete(oldestKey); totals.routesEvicted += 1; }
  }
  const entry = newRouteEntry();
  routes.set(key, entry);
  return entry;
}

/* ── 이벤트 루프 창·스톨 ────────────────────────────────────────── */
/**
 * 30초 창 요약 기록(util/loopLag.js 가 호출). max 가 임계를 넘으면 hang 이벤트로 남긴다.
 * 이 함수는 창이 닫히는 시점에만(30초마다 1회) 불린다.
 */
export function recordLoopWindow({ maxMs = 0, p99Ms = 0, meanMs = 0, windowMs = 30_000, eluPct = null } = {}) {
  try {
    reapInflight();   // 30초마다 1회 — 버려진 응답을 진행 중 목록에서 치운다
    const st = loadPerfSettings();
    const now = Date.now();
    const w = { ts: now, maxMs: Math.round(maxMs), p99Ms: Math.round(p99Ms), meanMs: Math.round(meanMs * 10) / 10, windowMs, eluPct };
    lastLoopWindow = w;
    if (!st.enabled) return w;
    loopWindows.push(w);
    if (loopWindows.length > LOOP_WINDOWS) loopWindows = loopWindows.slice(-LOOP_WINDOWS);
    const ranJobs = windowJobNames();
    windowJobs = new Set(activeJobNames());   // 다음 창의 시작점 = 지금도 돌고 있는 작업
    if (maxMs >= st.hangLagMs) {
      stalls.push({ ts: now, ms: Math.round(maxMs), windowMs, jobs: ranJobs });
      if (stalls.length > STALL_RING) stalls = stalls.slice(-STALL_RING);
      pushHang({
        kind: 'loop', at: now, maxMs: Math.round(maxMs), p99Ms: Math.round(p99Ms), meanMs: Math.round(meanMs * 10) / 10,
        windowMs, jobs: ranJobs, activeJobs: activeJobNames(), inflight: inflightSnapshot(10), inflightN: inflight.size,
        rssMb: Math.round(process.memoryUsage.rss() / 1048576), heapMb: Math.round(process.memoryUsage().heapUsed / 1048576),
        uptimeSec: Math.round(process.uptime()),
      });
    }
    return w;
  } catch { return null; }
}

/**
 * 요청 구간 [t0,t1] 과 **겹친** 루프 정체 창의 합계. 뒤에서부터 스캔한다(창은 시간순).
 *
 * 정직한 한계(중요): 스톨 레코드는 30초 창의 '닫힌 시각 + 그 창의 최대 지연' 뿐이고 **정체가 창
 * 안 어디서 났는지는 모른다.** 그래서 겹침은 '이 요청이 정체 구간과 같은 30초 안에 있었다' 는
 * 뜻이고 '이 요청이 그만큼 막혔다' 는 증명이 아니다. 두 가지로 과대 귀속을 막는다:
 *  · 창을 한 점(ts)이 아니라 [ts-windowMs, ts] 구간으로 보고 **겹칠 때만** 센다.
 *    (이전 구현은 ts 한 점이 요청 수명 안에 드는지만 봐서, 1초 요청은 30초 중 약 6% 확률로만
 *     귀속되고(거짓음성) 창이 닫히는 순간 열려 있던 5ms 요청은 창 전체를 뒤집어썼다(거짓양성).)
 *  · 더하는 값을 min(창 최대, 겹친 시간, 요청 길이) 로 깎는다 — 요청보다 긴 정체를 그 요청에
 *    돌리는 것은 물리적으로 불가능하다. 이 상한 덕분에 5ms 요청은 5ms 밖에 못 받아 승격되지 않는다.
 */
export function stallsBetween(t0, t1) {
  let ms = 0; let n = 0; const jobs = new Set();
  const dur = Math.max(0, t1 - t0);
  for (let i = stalls.length - 1; i >= 0; i--) {
    const s = stalls[i];
    const wEnd = s.ts;
    const wStart = s.ts - (s.windowMs || 30_000);
    if (wEnd < t0) break;                               // 이보다 과거 창은 겹칠 수 없다
    const overlap = Math.min(wEnd, t1) - Math.max(wStart, t0);
    if (overlap <= 0) continue;
    ms += Math.min(s.ms, overlap, dur);
    n += 1;
    for (const j of s.jobs || []) jobs.add(j);
  }
  return { ms, n, jobs: [...jobs] };
}

/** 진행 중 요청 스냅샷(오래 기다린 것 먼저). */
export function inflightSnapshot(limit = 20) {
  const now = performance.now();
  const rows = [];
  for (const [id, r] of inflight) {
    rows.push({ id, rid: r.rid || '', method: r.method, path: r.path, ageMs: Math.round(now - r.t0) });
    if (rows.length >= 500) break;                      // 스냅샷 자체가 비싸지 않게
  }
  rows.sort((a, b) => b.ageMs - a.ageMs);
  return rows.slice(0, Math.max(1, limit));
}

/* ── hang 이벤트 ────────────────────────────────────────────────── */
/**
 * hang 링에 넣고 파일에 남긴다. **종류별 최소 보장 슬롯**을 둔다 — 예전에는 하나의 링을
 * 'loop'(서버 루프 정체)와 'client'(브라우저 보고)가 공유해서, 저권한 계정 하나가 쿨다운대로
 * 보고만 해도 몇 시간 뒤 링이 전부 client 이벤트가 되어 **서버 정체 기록이 화면에서 사라졌다**
 * (적대적 리뷰 지적). 링을 넘길 때 같은 종류의 가장 오래된 항목부터 버려 서로를 밀어내지 못하게 한다.
 */
function pushHang(ev) {
  const st = loadPerfSettings();
  hangRing.push(ev);
  if (hangRing.length > st.keepHangs) {
    const kind = ev?.kind;
    // 같은 종류가 절반을 넘겼으면 그 종류의 가장 오래된 것을, 아니면 전체에서 가장 오래된 것을 버린다.
    const sameKind = hangRing.filter((x) => x.kind === kind).length;
    const dropIdx = sameKind > Math.floor(st.keepHangs / 2)
      ? hangRing.findIndex((x) => x.kind === kind)
      : 0;
    hangRing.splice(dropIdx < 0 ? 0 : dropIdx, 1);
  }
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
        .map((x) => ({ path: String(x?.path || '').slice(0, 200), ms: Math.round(Number(x?.ms) || 0), rid: sanitizeRid(x?.rid) })),
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

/* ── 요청 ID 상태 조회(v2.583) ─────────────────────────────────── */
/**
 * 로딩 화면이 오래 기다리는 요청의 **서버 쪽 사실**을 묻는다. 세 가지를 구분하는 것이 목적이다 —
 *  · processing — 서버가 받아서 아직 응답하지 않았다(지연의 주체는 서버 처리: 그 라우트·외부 왕복).
 *  · done       — 서버는 이미 응답을 끝냈다(지연은 전송·브라우저 처리 쪽).
 *  · unknown    — 서버에 기록이 없다. 요청이 서버에 도달하지 않았거나(프록시·네트워크), 서버가
 *                 재시작됐거나, 최근 완료 기록(2,000건)에서 밀려났다. **셋을 구분할 수 없으므로 단정하지 않는다.**
 * 소유자만 본다 — 남의 요청 ID 를 알아도 그 사람의 경로·시간을 볼 수 없다(관리자는 전부).
 * 경로는 식별자를 가린 라우트 키만 준다.
 */
export function requestStatus(rids = [], { user = '', isAdmin = false } = {}) {
  const want = [...new Set((Array.isArray(rids) ? rids : []).map(sanitizeRid).filter(Boolean))].slice(0, 20);
  const out = {};
  if (!want.length) return out;
  const me = String(user || '');
  const mine = (owner) => isAdmin || (owner !== '' && owner === me);
  const now = performance.now();
  const live = new Map();
  for (const r of inflight.values()) {
    if (!r.rid || !want.includes(r.rid)) continue;
    let owner = '';
    try { owner = r.userOf ? String(r.userOf() || '') : ''; } catch { owner = ''; }
    if (!mine(owner)) continue;
    const ageMs = Math.round(now - r.t0);
    const prev = live.get(r.rid);
    if (!prev || prev.serverMs < ageMs) live.set(r.rid, { state: 'processing', serverMs: ageMs, method: r.method, route: routeKeyOf({ path: r.path }) });
  }
  for (const rid of want) {
    if (live.has(rid)) { out[rid] = live.get(rid); continue; }
    const d = recentDone.get(rid);
    if (d && mine(d.user)) {
      out[rid] = { state: 'done', serverMs: d.ms, status: d.status, method: d.method, route: d.route, endedAgoMs: Math.max(0, Date.now() - d.endedAt) };
      continue;
    }
    out[rid] = { state: 'unknown' };
  }
  return out;
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
  reapInflight();
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

/** 보존일 정리(관리자 저장 시·기동 시 1회). 쓰기 중이면 hangLog 가 알아서 미룬다. */
export function pruneHangLog() { return trimHangLog(loadPerfSettings().retentionDays); }

// 자동 트림(200건마다)도 보존일을 적용하도록 주입한다 — 예전에는 자동 경로가 인자 없이 불려
// 보존일이 사실상 적용되지 않았고, 사용자명·IP 가 설정 기간을 넘겨 남았다(적대적 리뷰 지적).
setHangRetentionProvider(() => loadPerfSettings().retentionDays);

export function _resetPerfMonitorForTest() {
  routes.clear(); inflight.clear(); activeJobs.clear();
  slowRing = []; hangRing = []; loopWindows = []; stalls = []; windowJobs = new Set(); recentDone.clear();
  reqSeq = 0; lastLoopWindow = null;
  totals = { requests: 0, slow: 0, err: 0, hangs: 0, clientStalls: 0, reaped: 0, untracked: 0, routesEvicted: 0, startedAt: Date.now() };
}
