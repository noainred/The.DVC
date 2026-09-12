/**
 * perfClient.js — 진행 중 요청 레지스트리 + 장기 로딩 보고(v2.498).
 *
 * 두 가지를 한다:
 *  1) api.js 의 요청 깔때기(fetchJson·pollFetch·postJson/sendJson)가 시작/종료를 알려주면
 *     '지금 무엇을 몇 초째 기다리는지' 를 들고 있는다 → Loading 표시와 hang 보고의 근거.
 *  2) 화면이 임계(기본 60초, 서버 설정값) 이상 '불러오는 중' 이면 서버에 1회 보고한다
 *     (POST /api/perf/client-stall). 설정 › 서버 성능 측정에서 그 기록을 본다.
 *
 * 원칙: **실패해도 화면에 영향이 없어야 한다.** 보고는 재시도 0·타임아웃 10초·예외 무시이며
 * postJson 을 쓰지 않는다(180초 백스톱·예외 전파가 있어 화면 흐름에 개입한다). 서버가 404/401/
 * 403/429 를 주면 그 세션 동안 보고를 멈춘다(구버전 서버·권한 없음). sendBeacon 은 Authorization
 * 헤더를 못 붙여 쓰지 않는다(Bearer 규약).
 */
import { allowReport, newReportState, stallPayload } from './perfClientLogic.js';

const inflight = new Map();     // id -> { path, method, t0 }
let seq = 0;
const listeners = new Set();
const reportState = newReportState();
let disabled = false;           // 서버가 거부했거나 계측이 꺼져 있으면 true
let stuckMs = 60_000;           // 서버 설정값으로 갱신(화면에 하드코딩하지 않는다)
let configLoaded = false;

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/** 요청 시작 알림. 반환 id 를 endReq 에 넘긴다. */
export function startReq(path, method = 'GET') {
  // 자기 자신(보고·설정 조회)은 추적하지 않는다 — 재귀와 '보고 때문에 항상 대기 중' 오표시 방지.
  if (String(path || '').startsWith('/perf/')) return null;
  if (inflight.size >= 200) return null;              // 유계(비정상 누수 방어)
  const id = ++seq;
  inflight.set(id, { path: String(path || ''), method, t0: now() });
  emit();
  return id;
}

/** 요청 종료 알림(성공·실패 모두). */
export function endReq(id) {
  if (id == null) return;
  if (inflight.delete(id)) emit();
}

/** 진행 중 요청 스냅샷(오래 기다린 것 먼저). */
export function inflightSnapshot(limit = 10) {
  const t = now();
  const rows = [...inflight.values()].map((r) => ({ path: r.path, method: r.method, ms: Math.round(t - r.t0) }));
  rows.sort((a, b) => b.ms - a.ms);
  return rows.slice(0, Math.max(1, limit));
}

/** 가장 오래 기다린 요청의 경과(ms). 없으면 0. */
export function oldestInflightMs() {
  const rows = inflightSnapshot(1);
  return rows.length ? rows[0].ms : 0;
}

function emit() { for (const fn of listeners) { try { fn(); } catch { /* 구독자 오류 무시 */ } } }
/** useSyncExternalStore 용 구독. */
export function subscribeInflight(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** 보고 임계(ms) — 서버 설정값. 화면이 이 값을 쓴다. */
export const stuckThresholdMs = () => stuckMs;

/** 서버에서 임계·활성 여부를 한 번 받아온다(실패하면 기본값 유지). */
export async function loadPerfClientConfig(fetchJson) {
  if (configLoaded) return;
  configLoaded = true;
  try {
    const r = await fetchJson('/perf/client-config', {}, undefined, { retries: 0, timeoutMs: 10_000 });
    if (r && typeof r.clientStuckMs === 'number') stuckMs = Math.max(10_000, r.clientStuckMs);
    if (r && r.enabled === false) disabled = true;
  } catch { /* 구버전 서버·일시 오류 — 기본값으로 동작 */ }
}

/**
 * '화면이 오래 불러오는 중' 보고. 같은 (화면, 경로)는 쿨다운 5분, 세션당 시간당 50건 상한.
 * @returns {boolean} 보고를 실제로 보냈는지(테스트·표시용)
 */
export function reportStall({ view = '', path = '', ms = 0, base = '/api', headers = null } = {}) {
  if (disabled) return false;
  const body = stallPayload({ view, path, ms, inflight: inflightSnapshot(10) });
  const key = `${body.view}|${body.path}`;
  if (!allowReport(reportState, key, Date.now())) return false;
  try {
    const h = { 'Content-Type': 'application/json', ...(headers || {}) };
    fetch(`${base}/perf/client-stall`, {
      method: 'POST', headers: h, body: JSON.stringify(body), keepalive: true,
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(10_000) : undefined,
    }).then((res) => {
      // 401 은 세션 만료라 **끄지 않는다** — 다시 로그인하면 보고가 되살아나야 한다.
      // 403(권한 없음)·404(구버전 서버)·429(레이트리밋)는 이 세션에서 재시도할 가치가 없다.
      if (res && [403, 404, 429].includes(res.status)) disabled = true;
    }).catch(() => { /* 보고 실패는 무시 — 화면에 영향 없음 */ });
  } catch { return false; }
  return true;
}

/** 테스트·진단용. */
export function _perfClientState() {
  return { inflightN: inflight.size, disabled, stuckMs, dropped: reportState.dropped, keys: reportState.keys.size };
}
export function _resetPerfClient() {
  inflight.clear(); seq = 0; disabled = false; stuckMs = 60_000; configLoaded = false;
  reportState.keys.clear(); reportState.hourBucket = 0; reportState.hourCount = 0; reportState.dropped = 0;
}
