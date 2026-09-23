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
 */

const MAX_KEYS = 2000;
const PREFIXES = ['/api/collector/', '/api/central/'];
const map = new Map();
const startedAt = Date.now();

function split(url) {
  try { const u = new URL(String(url)); return { origin: u.origin, path: u.pathname }; } catch { return null; }
}

export function isTrackedPath(pathname) { return PREFIXES.some((p) => String(pathname || '').startsWith(p)); }

/** @param url 요청 URL, @param r { status, bytes, ms, error } — error 가 있으면 실패 */
export function recordOutbound(url, { status = 0, bytes = 0, ms = 0, error = '', method = 'GET', now = Date.now() } = {}) {
  const u = split(url);
  if (!u || !isTrackedPath(u.path)) return;
  const key = `${u.origin}${u.path}`;
  let e = map.get(key);
  if (!e) {
    if (map.size >= MAX_KEYS) {
      let oldest = null;
      for (const [k, v] of map) if (!oldest || v.lastAt < oldest[1].lastAt) oldest = [k, v];
      if (oldest) map.delete(oldest[0]);
    }
    e = { origin: u.origin, path: u.path, method: String(method || 'GET').toUpperCase(), count: 0, okCount: 0, failCount: 0,
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
