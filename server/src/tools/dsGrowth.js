/**
 * tools/dsGrowth.js — 데이터스토어 사용량 증가율(GB/일) 계산 · 캐시(v2.672, 운영 장애 대응).
 *
 * 사고(2026-10-01, v2.671 운영): Overview 가 열리지 않고 ERR_CONNECTION_TIMED_OUT. stallwatch 가 이벤트 루프 64~70초 정지를
 * **반복해서** 기록했고 스택은 매번 `metrics/db.js implHistory(원본 폴백)` ← `/tools/capacity-forecast` 였다. 힙은 4,144MB 중
 * 643~758MB(16~18%) — 메모리가 아니라 동기 SQL 이었다. 원인 셋이 겹쳤다:
 *   ① 그 라우트는 데이터스토어마다 `history('ds_usedgb', 120일, 1일 버킷)` 을 불렀고, 롤업 도입 이전 원본이 남아 있으면 history() 가
 *      원본으로 폴백한다(v2.600 DB2600-02). 원본 보존 기본은 5년이고 ds_usedgb 는 변화분 저장 대상이 아니라 분마다 쌓인다 —
 *      키 하나 120일이면 원본 약 17만 행이다.
 *   ② 양보가 '100개마다' 라 100개 사이가 64~70초였다(한 건이 느리면 개수 기준 양보는 아무것도 못 막는다).
 *   ③ memo 키가 스냅샷 시각이라 30초마다 새 계산이 **겹쳐** 시작됐다(한 바퀴가 10분을 넘으니 계속 쌓였다).
 *   그리고 v2.670 경영 보기 Overview(관리자 기본 화면)가 열릴 때마다 이 라우트를 불러, 예전엔 가끔이던 일이 늘 일어났다.
 *
 * 규칙(셋 다 지킬 것):
 *  ① 롤업만 읽는다(`historyRollup`) — 원본으로 절대 떨어지지 않는다. 롤업 도입 이전 구간은 쓰지 않는다(points·firstTs 로 밝힌다).
 *     구버전 db 객체(historyRollup 없음)면 계산하지 않고 그 사실을 error 로 밝힌다 — history() 로 되돌리지 말 것.
 *  ② 결과는 스냅샷과 무관한 캐시(기본 15분)에 둔다 — 사용량 추세는 1일 버킷이라 30초마다 다시 셀 이유가 없다.
 *     오래되면 옛 값을 주고 뒤에서 **한 번만** 다시 센다(stale-while-revalidate · 동시 계산 1건).
 *  ③ 계산 루프는 시간 기준으로 양보한다(util/timeSlice.js).
 *
 * 전 데이터스토어를 한 벌로 센다(범위와 무관) — 범위는 호출부가 결과를 고를 때 적용한다. 범위마다 따로 세면 같은 계산을
 * 계정 수만큼 한다. 결과에는 이름·주소가 없고 id → 수치뿐이다.
 */
import { getMetricsDb } from '../metrics/db.js';
import { linregSlope } from '../util/linreg.js';
import { createYielder } from '../util/timeSlice.js';

export const DS_GROWTH_METRIC = 'ds_usedgb';
export const DS_GROWTH_WINDOW_DAYS = 120;
export const DS_GROWTH_TTL_MS = 15 * 60_000;
const ERROR_TTL_MS = 60_000;      // DB 를 못 연 결과는 짧게만 들고 있는다(기동 직후 일시 잠금이 15분 공백이 되지 않게)
const DAY = 86_400_000;

let _cache = null;     // { at, byId: Map<id, growth>, ms, failed, error, ttlMs? }
let _inflight = null;  // Promise — 동시 계산 1건
let _computes = 0;
let _lastStart = null;

/**
 * 일 버킷 점들 → 증가율. 점 3개 미만이면 기울기를 내지 않는다(예전 라우트와 같은 기준).
 * @param {{ts:number, avg:number|null}[]} points
 * @returns {{slope:number|null, points:number, firstTs:number|null, lastTs:number|null}}
 */
export function growthOf(points) {
  const pts = (Array.isArray(points) ? points : []).filter((p) => Number.isFinite(p?.ts) && Number.isFinite(p?.avg));
  const firstTs = pts.length ? pts[0].ts : null;
  const lastTs = pts.length ? pts[pts.length - 1].ts : null;
  if (pts.length < 3) return { slope: null, points: pts.length, firstTs, lastTs };
  const slope = linregSlope(pts.map((p) => p.ts / DAY), pts.map((p) => p.avg));
  return { slope: Number.isFinite(slope) ? slope : null, points: pts.length, firstTs, lastTs };
}

async function computeAll(ids, { db, now, sliceMs }) {
  const t0 = performance.now();
  const maybeYield = createYielder(sliceMs);
  const byId = new Map();
  const since = now - DS_GROWTH_WINDOW_DAYS * DAY;
  // ⚠ history() 로 폴백하지 않는다 — 그것이 이 모듈이 막으려는 원본 집계 경로다.
  const read = typeof db?.historyRollup === 'function' ? (k) => db.historyRollup(DS_GROWTH_METRIC, k, since, DAY, 200) : null;
  if (!read) return { at: now, byId, ms: 0, failed: 0, yields: 0, error: 'rollup-unavailable', ttlMs: ERROR_TTL_MS };
  let failed = 0;
  for (const id of ids) {
    await maybeYield();
    try { byId.set(id, growthOf(read(id))); } catch { failed++; }
  }
  return { at: now, byId, ms: Math.round(performance.now() - t0), failed, yields: maybeYield.count(), error: null };
}

function refresh(list, opts) {
  if (_inflight) return _inflight;   // 동시 계산 1건 — 겹쳐 시작하지 않는다(사고 원인 ③)
  _lastStart = Date.now();
  _inflight = (async () => {
    let r;
    try {
      const db = opts.db || await getMetricsDb();
      r = await computeAll(list, { db, now: Date.now(), sliceMs: opts.sliceMs });
    } catch (e) {
      r = { at: Date.now(), byId: _cache?.byId || new Map(), ms: 0, failed: 0, yields: 0, error: String(e?.message || e).slice(0, 200), ttlMs: ERROR_TTL_MS };
    }
    _computes++;
    _cache = r;
    return r;
  })().finally(() => { _inflight = null; });
  return _inflight;
}

/**
 * 지금 데이터스토어 목록의 증가율.
 *  · 캐시가 없거나 목록의 상당 부분(20개 또는 20% 초과)이 캐시에 없으면 계산을 **기다린다** — 비어 있는 추세를
 *    '증가 없음' 으로 보이지 않게(첫 호출 · 첫 수집 직후).
 *  · 캐시가 오래됐거나 새 데이터스토어가 조금 있으면 옛 값을 바로 주고 뒤에서 한 번 다시 센다.
 * @param {string[]} ids
 * @param {{ttlMs?:number, sliceMs?:number, db?:object}} [opts]
 * @returns {Promise<{byId:Map, at:number|null, stale:boolean, refreshing:boolean, error:string|null, windowDays:number}>}
 */
export async function dsGrowthFor(ids, opts = {}) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && x))];
  const ttl = Number.isFinite(opts.ttlMs) ? opts.ttlMs : DS_GROWTH_TTL_MS;
  const ttlOf = (c) => (c && Number.isFinite(c.ttlMs) ? Math.min(c.ttlMs, ttl) : ttl);
  const missing = _cache ? list.filter((id) => !_cache.byId.has(id)).length : list.length;
  const mustWait = !_cache || (list.length > 0 && missing > Math.max(20, list.length * 0.2));
  if (mustWait) await refresh(list, opts);
  else if (Date.now() - _cache.at >= ttlOf(_cache) || missing > 0) refresh(list, opts).catch(() => { /* 결과는 다음 호출이 본다 */ });
  const c = _cache;
  return {
    byId: c?.byId || new Map(),
    at: c?.at ?? null,
    stale: !!c && Date.now() - c.at >= ttlOf(c),
    refreshing: !!_inflight,
    error: c?.error ?? null,
    windowDays: DS_GROWTH_WINDOW_DAYS,
  };
}

/** 진단(서비스 점검·테스트) — 계산 횟수·마지막 소요·양보 횟수. 이름·주소 없음. */
export function dsGrowthStatus() {
  return {
    computes: _computes,
    computing: !!_inflight,
    lastStartAt: _lastStart,
    at: _cache?.at ?? null,
    keys: _cache?.byId?.size ?? 0,
    lastMs: _cache?.ms ?? null,
    lastYields: _cache?.yields ?? null,
    failed: _cache?.failed ?? 0,
    error: _cache?.error ?? null,
    ttlMs: DS_GROWTH_TTL_MS,
    windowDays: DS_GROWTH_WINDOW_DAYS,
  };
}

/** 테스트 전용 — 캐시·진행 중 계산을 비운다. */
export function _resetDsGrowthForTest() { _cache = null; _inflight = null; _computes = 0; _lastStart = null; }
