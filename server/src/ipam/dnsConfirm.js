/**
 * dnsConfirm.js — v3.2.0 DNS 정합성(시안 docs/design/ipam-alerts-mac-dns ④ · 컨펌 7 '역DNS 이름의 정방향 확인만' · 8 '기록만').
 *
 * 역DNS 가 답한 이름(names.dns)을 정방향으로 다시 물어 그 이름이 정말 이 IP 를 가리키는지 본다(Forward-Confirmed reverse DNS).
 *   결과 넷 — match(주소 목록에 이 IP 가 있다) · other(다른 IP 만) · none(그런 이름 없음 — NXDOMAIN · 주소 없음) ·
 *   unknown(시한 · 예산 · 차단기 · 그 밖의 DNS 오류 — **일치에도 불일치에도 넣지 않는다**).
 *
 * 묻는 곳은 스캔을 돌린 쪽(법인 엣지 → 법인 DNS)이다. 묻는 함수 · 시한 · 동시 수 · 차단기는 v2.993 정방향 DNS 와 같은 것(scan.js lookupMany)이고,
 *   물리서버 이름을 먼저 물은 뒤 **남은 예산**으로 묻는다. 한 번 얻은 답은 설정 기간(기본 24시간) 동안 다시 쓰고, 묻는 순서는 오래된 답부터(한 번도 묻지 않은 이름이 맨 앞) —
 *   예산에 걸린 이름은 '확인 못 함' 으로 남고 다음 스캔이 이어 간다.
 *
 * 답 기억(캐시)은 스캔을 부르는 프로세스(scanRunner — 중앙 포탈 · 엣지 에이전트)의 메모리에 둔다. 스캔은 자식 프로세스에서 돌므로 잡에 실어 보내고
 *   새로 얻은 답만 돌려받는다. 재시작하면 비어서 다시 묻는다(예산 안에서 — 파일로 남기지 않는다).
 */

export const DNS_FWD_STATES = Object.freeze(['match', 'other', 'none', 'unknown']);
export const DNS_CONFIRM_HOURS_DEFAULT = 24;
export const DNS_CONFIRM_HOURS_MIN = 1;
export const DNS_CONFIRM_HOURS_MAX = 720;
/** 기억하는 이름 수 상한(넘치면 오래된 답부터 버린다) · 한 이름에 기억하는 주소 수 · 결과에 싣는 다른 IP 수. */
export const DNS_CACHE_MAX = 20_000;
export const DNS_ADDRS_MAX = 8;
export const DNS_OTHER_MAX = 4;
/** '그런 이름 없음' 으로 보는 오류 코드(getaddrinfo · c-ares). 그 밖의 오류(일시 실패 · 서버 실패 · 거부)는 unknown. */
const NO_NAME = new Set(['ENOTFOUND', 'ENODATA', 'EAI_NONAME', 'EAI_NODATA', 'NXDOMAIN']);

/** 이름 비교 열쇠 — 앞뒤 공백 · 끝의 점을 떼고 소문자. */
export const dnsKey = (name) => String(name || '').trim().replace(/\.$/, '').toLowerCase();

/** 기간(시간) 정리 — 숫자가 아니면 기본값. */
export function confirmHoursOf(v) {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n)) return DNS_CONFIRM_HOURS_DEFAULT;
  return Math.min(DNS_CONFIRM_HOURS_MAX, Math.max(DNS_CONFIRM_HOURS_MIN, Math.round(n)));
}

/**
 * 잡에 실린 기억(배열 [[이름, 주소[], 시각], ...])을 Map 으로(순수 — 꼴이 틀린 줄은 버린다). 주소 [] = 그런 이름 없음.
 * @returns {Map<string, {addrs:string[], at:number}>}
 */
export function cacheFromWire(list) {
  const m = new Map();
  for (const x of Array.isArray(list) ? list : []) {
    if (!Array.isArray(x) || typeof x[0] !== 'string' || !Array.isArray(x[1])) continue;
    const at = Number(x[2]);
    if (!Number.isFinite(at) || at <= 0) continue;
    const k = dnsKey(x[0]);
    if (!k || k.length > 253) continue;
    m.set(k, { addrs: x[1].filter((a) => typeof a === 'string').slice(0, DNS_ADDRS_MAX), at });
  }
  return m;
}

/**
 * 묻기 계획(순수). pairs = [{ ip, name }](역DNS 이름이 있는 생존 IP). 기간 안의 답이 있는 이름은 다시 묻지 않고(reuse),
 *   나머지는 오래된 답부터(답이 없던 이름이 맨 앞 — 같은 나이는 이름 순) 묻는다. 같은 이름은 한 번만 묻는다.
 * @returns {{ ask: string[], fresh: Map<string,{addrs:string[],at:number}> }}  ask 는 원래 글자의 이름(묻는 데 쓴다)
 */
export function planConfirm(pairs, cache, { now = Date.now(), ttlMs = DNS_CONFIRM_HOURS_DEFAULT * 3_600_000 } = {}) {
  const fresh = new Map(); const stale = new Map();   // key → 원래 이름
  for (const p of Array.isArray(pairs) ? pairs : []) {
    const k = dnsKey(p?.name);
    if (!k || fresh.has(k) || stale.has(k)) continue;
    const c = cache instanceof Map ? cache.get(k) : null;
    if (c && now - c.at < ttlMs && c.at <= now) fresh.set(k, c);
    else stale.set(k, String(p.name).trim().replace(/\.$/, ''));
  }
  const age = (k) => (cache instanceof Map && cache.get(k)?.at) || 0;
  const ask = [...stale.entries()].sort((a, b) => (age(a[0]) - age(b[0])) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, n]) => n);
  return { ask, fresh };
}

/** 묻기 결과 한 건(lookupMany 의 값)을 기억 꼴로(순수). 그런 이름 없음 → 주소 []. 그 밖의 오류 → null(기억하지 않는다 — 다음 스캔이 다시 묻는다). */
export function answerOf(r, at) {
  if (!r || typeof r !== 'object') return null;
  if (Array.isArray(r.addrs)) return { addrs: r.addrs.slice(0, DNS_ADDRS_MAX), at };
  if (NO_NAME.has(String(r.err || ''))) return { addrs: [], at };
  return null;
}

/**
 * 한 IP 의 판정(순수). entry = 기억 꼴({addrs, at}) 또는 없음.
 * @returns {{ v:'match'|'other'|'none'|'unknown', at?:number, addrs?:string[] }}  addrs 는 other 일 때만(최대 DNS_OTHER_MAX)
 */
export function verdictOf(ip, entry) {
  if (!entry || !Array.isArray(entry.addrs)) return { v: 'unknown' };
  if (!entry.addrs.length) return { v: 'none', at: entry.at };
  if (entry.addrs.includes(ip)) return { v: 'match', at: entry.at };
  return { v: 'other', at: entry.at, addrs: entry.addrs.slice(0, DNS_OTHER_MAX) };
}

/**
 * 대장 행 칸(순수 — ledger 가 전 범위 계정에만 붙인다). 일치 · 확인 못 함은 판정만(행 수만큼 실리므로 짧게 — 화면의 요약 줄이 센다),
 *   어긋난 것(other · none)은 역DNS 이름 · 확인 시각 · 다른 IP 를 함께(배지 · 칩 · 툴팁).
 */
export function dnsFwdFields(sc) {
  const d = sc?.dnsFwd; const ptr = sc?.names?.dns?.v;
  if (!d || typeof d !== 'object' || !ptr || !DNS_FWD_STATES.includes(d.v)) return {};
  if (d.v === 'match' || d.v === 'unknown') return { dnsFwd: d.v };
  return { dnsFwd: d.v, dnsPtr: String(ptr), ...(d.at ? { dnsFwdAt: d.at } : {}), ...(d.v === 'other' && Array.isArray(d.addrs) ? { dnsFwdAddrs: d.addrs.slice(0, DNS_OTHER_MAX) } : {}),
    ...(sc.agent ? { dnsAgent: String(sc.agent) } : {}) };
}

/*
 * 기억(부모 프로세스 — scanRunner 가 쓴다). 이름(소문자) → { addrs, at }.
 */
const _cache = new Map();
/** 잡에 실을 기억(배열). 오래된 답도 싣는다 — 기간이 지난 답은 다시 묻지만 묻는 순서(오래된 것부터)에 쓴다. */
export function cacheToWire() { return [..._cache.entries()].map(([k, v]) => [k, v.addrs, v.at]); }
/** 스캔이 새로 얻은 답을 기억에 넣는다(같은 이름은 새 답으로) · 상한을 넘으면 오래된 답부터 버린다. */
export function absorbLearned(list) {
  const m = cacheFromWire(list);
  for (const [k, v] of m) { _cache.delete(k); _cache.set(k, v); }
  if (_cache.size > DNS_CACHE_MAX) {
    const old = [..._cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, _cache.size - DNS_CACHE_MAX);
    for (const [k] of old) _cache.delete(k);
  }
  return m.size;
}
export function _resetDnsCacheForTest() { _cache.clear(); }
export function _dnsCacheSizeForTest() { return _cache.size; }
