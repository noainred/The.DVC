/**
 * util/outboundStats.js — 이 노드가 **다른 포탈로 나가는** 호출의 기록(v2.587, 데이터 흐름 지도).
 *
 * 대상은 경로가 `/api/collector/`(중앙 → 엣지) 또는 `/api/central/`(엣지 → 중앙) 으로 시작하는 요청뿐이다.
 * 중앙 → 엣지 호출(export pull · edge-log · bm-usage · token-check · idrac-scan · bmstor-collect · upgrade …)은
 * 모듈마다 자기 상태를 따로 들고 있어(일부는 아무것도 남기지 않는다) 한 화면에서 볼 길이 없었다.
 * `resilientFetch` 한 곳에서 기록하므로 새 호출 경로가 생겨도 **자동으로** 잡힌다.
 *
 * 규칙:
 *  · 키는 `origin + pathname` — **쿼리를 버린다**(토큰·필터가 쿼리에 실릴 수 있고, 키가 무한히 는다).
 *  · 요청 헤더·본문을 저장하지 않는다(토큰이 실린다). 남기는 것은 상태코드·바이트·소요·오류 문구(200자)뿐.
 *  · util 은 도메인을 모른다(v2.579 규칙) — 어느 엣지인지 해석(origin → 수집 서버)은 호출하는 쪽이 한다.
 *  · 인메모리. 상한(키 2,000)을 넘으면 가장 오래된 것부터 버린다.
 *
 * ⚠ v2.601(감사 WEB2601-01·02):
 *  · 수집 서버 URL 에 **경로 접두**가 있을 수 있다(`https://gw/siteA` — 등록부가 받는다). 예전엔 pathname 이
 *    `/api/collector/` 로 **시작할 때만** 기록해 그 엣지의 호출이 전부 조용히 버려졌다(지도에 영원히 '기록 없음').
 *    이제 경로 **안의** 첫 추적 접두를 찾고, 그 앞부분을 `base`(= origin + 경로 접두)로 따로 싣는다.
 *    `path` 는 예전처럼 `/api/…` 부터다(소비처 호환).
 *  · 같은 주소(base)를 두 수집 서버가 쓰면 기록이 섞인다. 호출부가 **어느 수집 서버인지 아는 경우**
 *    `withOutboundTag(id, fn)` 로 감싸면 그 id 가 행의 `tag` 로 실리고 키에도 들어간다(AsyncLocalStorage —
 *    `resilientFetch` 를 고치지 않고 await 너머까지 전달된다). 태그가 없는 행을 어느 엣지에 붙일지는
 *    호출하는 쪽(dataflow/build.js)이 정하고, 모호하면 붙이지 않는다.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const MAX_KEYS = 2000;
const PREFIXES = ['/api/collector/', '/api/central/'];
const map = new Map();
const startedAt = Date.now();
const tagStore = new AsyncLocalStorage();

/** 경로 안의 첫 추적 접두 위치(없으면 -1). */
function trackedIndex(pathname) {
  const s = String(pathname || '');
  let best = -1;
  for (const p of PREFIXES) { const i = s.indexOf(p); if (i >= 0 && (best < 0 || i < best)) best = i; }
  return best;
}

function split(url) {
  try {
    const u = new URL(String(url));
    const i = trackedIndex(u.pathname);
    if (i < 0) return { origin: u.origin, base: u.origin, path: u.pathname, tracked: false };
    return { origin: u.origin, base: `${u.origin}${u.pathname.slice(0, i)}`, path: u.pathname.slice(i), tracked: true };
  } catch { return null; }
}

/** 경로 어딘가에 추적 접두(`/api/collector/`·`/api/central/`)가 있으면 참 — 경로 접두가 붙은 수집 서버 포함. */
export function isTrackedPath(pathname) { return trackedIndex(pathname) >= 0; }

/**
 * fn 안에서 나가는 추적 호출에 수집 서버 id 를 붙인다(같은 주소를 쓰는 두 엣지를 구분하려고).
 * @template T @param {string} tag @param {() => T} fn @returns {T}
 */
export function withOutboundTag(tag, fn) { return tagStore.run(String(tag || '').slice(0, 128), fn); }

/** @param url 요청 URL, @param r { status, bytes, ms, error } — error 가 있으면 실패 */
export function recordOutbound(url, { status = 0, bytes = 0, ms = 0, error = '', method = 'GET', now = Date.now(), tag } = {}) {
  const u = split(url);
  if (!u || !u.tracked) return;
  const tg = String(tag ?? tagStore.getStore() ?? '').slice(0, 128);
  const key = `${u.base}${u.path}${tg ? `#${tg}` : ''}`;
  let e = map.get(key);
  if (!e) {
    if (map.size >= MAX_KEYS) {
      let oldest = null;
      for (const [k, v] of map) if (!oldest || v.lastAt < oldest[1].lastAt) oldest = [k, v];
      if (oldest) map.delete(oldest[0]);
    }
    e = { origin: u.origin, base: u.base, path: u.path, tag: tg, method: String(method || 'GET').toUpperCase(), count: 0, okCount: 0, failCount: 0,
      firstAt: now, lastAt: 0, lastOkAt: 0, lastFailAt: 0, lastStatus: 0, lastBytes: 0, lastMs: 0, lastError: '' };
    map.set(key, e);
  }
  e.count++; e.lastAt = now; e.lastStatus = Number(status) || 0; e.lastBytes = Number(bytes) || 0; e.lastMs = Math.round(Number(ms) || 0);
  const failed = !!error || !e.lastStatus || e.lastStatus >= 400;
  if (failed) { e.failCount++; e.lastFailAt = now; e.lastError = String(error || `HTTP ${e.lastStatus}`).slice(0, 200); }
  else { e.okCount++; e.lastOkAt = now; }
}

export function outboundStats() { return { rows: [...map.values()].map((e) => ({ ...e })), since: startedAt }; }
export function resetOutboundStats() { map.clear(); }
