/**
 * storage/collectors/isilonPower.js — Isilon/PowerScale 소비 전력(v2.667, REST·SSH 공용 판정 — 순수 + 키 캐시).
 *
 * OneFS 는 전원 값을 통계 키(`isi statistics`)로 준다고 알려져 있지만 **키 이름을 실장비로 확인하지 못했다**(정직 기록).
 * 그래서 이름을 굳히지 않고 ① 통계 키 목록에서 전원 이름을 **탐색**해 ② 그 키 **하나**의 현재값을 노드별로 더한다.
 * 서로 다른 전원 키를 더하지 않는다(합계 키와 PSU 키가 같이 있으면 이중 계수). 탐색 결과는 장비별로 6시간 캐시한다 —
 * 키 목록은 수천 줄이라 매 주기 받으면 그 자체가 부하다. 못 찾은 것도 캐시한다(없는 키를 매 주기 찾지 않게).
 */
import { wattsOf } from '../power.js';

export const ISI_POWER_KEY_TTL_MS = 6 * 3_600_000;
const _keyCache = new Map();   // host → { key: string|null, seen: string[], at }
const KEY_CACHE_MAX = 512;

const EXCLUDE = /percent|pct|status|state|count|fault|fail|type|limit|max|min|avg|average|peak|rated|threshold|capacity|volt|amp|energy|kwh/i;

/** 키 이름 목록 → 전원 키 하나(순수). 순위: 소비·입력 > `power.items` > 그 밖의 power. 없으면 null. */
export function pickIsiPowerKey(names) {
  const cand = [...new Set((names || []).map((x) => String(x || '').trim()).filter((k) => /^[\w.]+$/.test(k) && k.length <= 120))]
    .filter((k) => /(^|\.)power(\.|$)|watt/i.test(k) && !EXCLUDE.test(k));
  if (!cand.length) return { key: null, seen: [] };
  const rank = (k) => (/consum|input|watt/i.test(k) ? 0 : /\.power\.items$/i.test(k) ? 1 : 2);
  cand.sort((a, b) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b));
  return { key: cand[0], seen: cand.slice(0, 12) };
}

/** REST `statistics/keys` 응답 → 키 이름 배열(순수). */
export function keyNamesOfRest(body) {
  const list = Array.isArray(body?.keys) ? body.keys : Array.isArray(body) ? body : [];
  return list.map((x) => (typeof x === 'string' ? x : x?.key)).filter((x) => typeof x === 'string').slice(0, 20_000);
}

/** SSH `isi statistics list keys | grep -i power` 출력 → 키 이름 배열(순수). 줄마다 첫 토큰. */
export function keyNamesOfText(text) {
  return String(text || '').split('\n').slice(0, 2000).map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
}

/** 값 하나 → W 합(순수). items 키는 `[{desc, value}]` 배열로 올 수 있다 — 원소 값을 더한다. */
function valueWatts(v) {
  if (Array.isArray(v)) {
    let sum = 0; let n = 0;
    for (const it of v.slice(0, 64)) {
      const w = wattsOf(it && typeof it === 'object' ? it.value : it);
      if (w != null) { sum += w; n += 1; }
    }
    return n ? { w: sum, n } : null;
  }
  const w = wattsOf(v);
  return w != null ? { w, n: 1 } : null;
}

/**
 * 통계 응답 → { watts, nodes, parts } | null(순수). REST(`{stats:[{key,devid,value}]}`)·SSH JSON 둘 다 받는다.
 * 노드 행(devid ≥ 1)이 있으면 노드 합, 없고 클러스터 행(devid 0)만 있으면 그것을 쓴다(둘을 더하지 않는다).
 */
export function isiPowerFromStats(body, key) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.stats) ? body.stats : null;
  if (!list || !key) return null;
  const node = new Map(); let cluster = null;
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    let v; let dev;
    if (typeof r.key === 'string') { if (r.key !== key) continue; v = r.value; dev = r.devid ?? r.node; }
    else if (Object.hasOwn(r, key)) { v = r[key]; dev = r.node ?? r.Node ?? r.devid; }
    else continue;
    const got = valueWatts(v);
    if (!got) continue;
    const d = String(dev ?? '').toLowerCase();
    if (d === '0' || d === 'cluster' || d === '') cluster = got;
    else if (!node.has(d)) node.set(d, got);
  }
  if (node.size) {
    let w = 0; let parts = 0;
    for (const g of node.values()) { w += g.w; parts += g.n; }
    return { watts: Math.round(w), nodes: node.size, parts };
  }
  return cluster ? { watts: Math.round(cluster.w), nodes: null, parts: cluster.n } : null;
}

export function cachedIsiPowerKey(host, now = Date.now()) {
  const c = _keyCache.get(String(host || ''));
  return c && now - c.at < ISI_POWER_KEY_TTL_MS ? c : null;
}
export function rememberIsiPowerKey(host, picked, now = Date.now()) {
  const h = String(host || '');
  _keyCache.delete(h);
  _keyCache.set(h, { key: picked.key || null, seen: picked.seen || [], at: now });
  if (_keyCache.size > KEY_CACHE_MAX) _keyCache.delete(_keyCache.keys().next().value);
}
export function _resetIsiPowerCache() { _keyCache.clear(); }

/** SSH — 키 탐색 명령(목록에서 power 줄만). 목록은 수천 줄이라 grep 으로 줄인다. */
export const ISI_POWER_KEYS_CMD = 'isi statistics list keys 2>/dev/null | grep -i -E "power|watt" | head -200';
export const isiPowerQueryCmd = (key) => `isi statistics query current --keys ${key} --nodes all --format json`;
