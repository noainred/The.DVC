/**
 * horizon/appUsage.js — Horizon '어떤 사용자가 어떤 서비스(앱·데스크톱)를 쓰는가' 해석(v2.684, **순수 모듈**).
 *
 * 사용자 요청(2026-10-02): "VMware Horizon 으로 vApp 서비스를 제공하는데 실시간·누적 사용자를 집계하고 싶어 —
 * 커넥션 서버나 UAG API 로 어떤 사용자가 어떤 서비스를 사용하는지" → 1단계(커넥션 서버 API 만) 진행.
 *
 * ── 근거와 그 한계(정직 기록 — 반드시 유지) ────────────────────────────────────
 * 공식 문서(developer.broadcom.com)는 이 환경에서 여전히 차단이다. 읽을 수 있었던 1차 자료는
 * `matt-coppinger/horizon-mcp`(Horizon 2512~2606 검증이라 밝힌다) `src/horizon_mcp/tools/inventory.py` 다:
 *  · 앱 풀 목록 `/inventory/v1/application-pools` — 필드 `id`·`name`·`display_name`·`farm_id`(생성 본문·테스트로 확인)
 *  · 데스크톱 풀 `/inventory/v13/desktop-pools` · 팜 `/inventory/v10/farms` — **경로에 버전이 붙는다**.
 *    그래서 v1 을 먼저, 그 자료의 버전을 다음으로 시도한다(`CATALOG_PATHS`). 어느 것으로 읽었는지 보고한다.
 *  ⚠ **앱 세션이 실행한 앱 이름을 담는 세션 필드는 확인하지 못했다.** 후보 체인(`APP_NAME_KEYS`)으로 읽고,
 *    없으면 풀·팜 ID 로 되돌린다. 팜에 앱이 여럿이면 **어느 앱인지 알 수 없다** — 그때는 지어내지 않고
 *    `팜 단위(앱 미구분)` 서비스로 센다(`kind:'farm'`). 팜에 앱이 하나뿐이면 그 앱이다(`farm-single-app`).
 *
 * ── 정직성 규칙 ────────────────────────────────────────────────────────────────
 * 1. 해석 근거(`basis`)를 서비스마다 싣고 개수를 센다(`basisCounts`) — 화면이 '앱 이름을 세션에서 읽었다 /
 *    풀로 되돌렸다 / 팜까지만 안다' 를 구분해 말한다.
 * 2. 카탈로그에 없는 ID 는 **ID 그대로** 이름으로 쓰고 `basis` 에 `-id` 를 붙인다(이름을 지어내지 않는다).
 * 3. 서비스 키는 `종류:이름(소문자)` 다 — 같은 이름의 앱이 두 팟(커넥션 서버)에 있으면 같은 서비스로 센다
 *    (사용자가 묻는 것은 '어떤 서비스' 이지 '어느 팟의 풀 ID' 가 아니다). 풀 ID 는 `ids` 로 남긴다.
 * 4. 상한으로 자른 것은 개수를 밝힌다(`pairsOmitted`·`servicesOmitted`).
 */
import { pickKey, POOL_KEYS, STATE_KEYS, STATE_OF, TYPE_KEYS } from './sessions.js';
import { userKey } from '../curuser/aggregate.js';

/** 카탈로그 경로 후보 — 순서가 시도 순서다(첫 2xx 배열에서 멈춘다). */
export const CATALOG_PATHS = Object.freeze({
  app: Object.freeze(['/rest/inventory/v1/application-pools']),
  desktop: Object.freeze(['/rest/inventory/v1/desktop-pools', '/rest/inventory/v13/desktop-pools']),
  farm: Object.freeze(['/rest/inventory/v1/farms', '/rest/inventory/v10/farms']),
});

/** 세션 안의 '실행한 앱 이름' 후보 — **확인된 것이 없다**(위 머리말). 배열(문자열 또는 {name}) 또는 문자열. */
export const APP_NAME_KEYS = Object.freeze(['application_names', 'applications', 'application_name', 'app_names']);
export const APP_POOL_KEYS = Object.freeze(['application_pool_id', 'app_pool_id']);
export const DESKTOP_POOL_KEYS = Object.freeze(['desktop_pool_id']);
export const FARM_KEYS = Object.freeze(['farm_id']);

export const KIND_LABEL = Object.freeze({ app: '앱', desktop: '데스크톱', farm: '팜(앱 미구분)', unknown: '미확인' });
/** 해석 근거 — 화면 문구는 웹 `horizonUsageText.BASIS_TEXT` 가 소유하고 키 집합은 테스트가 대조한다. */
export const BASES = Object.freeze([
  'session-field', 'app-pool', 'app-pool-id', 'farm-single-app', 'farm', 'farm-id', 'desktop-pool', 'desktop-pool-id', 'unknown',
]);

const str = (v) => (v == null ? '' : String(v).trim());
const nameOf = (o) => str(o?.display_name) || str(o?.name) || str(o?.id);

/**
 * 카탈로그 원시 배열 → 조회용 맵.
 * @param {{apps?:object[], desktops?:object[], farms?:object[]}} raw
 */
export function normalizeCatalog(raw = {}) {
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && str(x.id)) : []);
  const apps = new Map(); const desktops = new Map(); const farms = new Map(); const appsByFarm = new Map();
  for (const a of arr(raw.apps)) {
    const id = str(a.id);
    const farmId = str(a.farm_id) || str(a.farmId);
    apps.set(id, { id, name: nameOf(a), farmId, desktopPoolId: str(a.desktop_pool_id) });
    if (farmId) { const l = appsByFarm.get(farmId) || []; l.push(id); appsByFarm.set(farmId, l); }
  }
  for (const d of arr(raw.desktops)) desktops.set(str(d.id), { id: str(d.id), name: nameOf(d) });
  for (const f of arr(raw.farms)) farms.set(str(f.id), { id: str(f.id), name: nameOf(f) });
  return { apps, desktops, farms, appsByFarm, counts: { apps: apps.size, desktops: desktops.size, farms: farms.size } };
}

const EMPTY_CATALOG = normalizeCatalog({});

/** 세션 필드에서 앱 이름 목록을 읽는다. `[usedKey, names[]]`. */
export function appNamesOf(s) {
  if (!s || typeof s !== 'object') return [null, []];
  for (const k of APP_NAME_KEYS) {
    const v = s[k];
    if (v == null) continue;
    const list = (Array.isArray(v) ? v : [v])
      .map((x) => (x && typeof x === 'object' ? str(x.display_name) || str(x.name) : str(x)))
      .filter(Boolean);
    if (list.length) return [k, [...new Set(list)].slice(0, 20)];
  }
  return [null, []];
}

const svc = (kind, name, id, basis) => ({ key: `${kind}:${name.toLowerCase()}`, kind, name, id: id || '', basis });

/**
 * 세션 하나 → 서비스 목록(대개 1개, 세션 필드가 앱 여러 개를 주면 여럿).
 * 판정 순서가 계약이다: 세션의 앱 이름 → 앱 풀 ID → (앱 세션이면) 팜 → 데스크톱 풀 → 팜 → 미확인.
 */
export function resolveServices(s, catalog = EMPTY_CATALOG) {
  const cat = catalog || EMPTY_CATALOG;
  const [, names] = appNamesOf(s);
  if (names.length) return names.map((n) => svc('app', n, '', 'session-field'));
  const [, appPool] = pickKey(s, APP_POOL_KEYS);
  if (appPool) {
    const a = cat.apps.get(appPool);
    return [a ? svc('app', a.name, appPool, 'app-pool') : svc('app', appPool, appPool, 'app-pool-id')];
  }
  const [, typeRaw] = pickKey(s, TYPE_KEYS);
  const type = str(typeRaw).toUpperCase();
  const [, farm] = pickKey(s, FARM_KEYS);
  const [, desk] = pickKey(s, DESKTOP_POOL_KEYS);
  const viaFarm = () => {
    const ids = cat.appsByFarm.get(farm) || [];
    if (ids.length === 1) { const a = cat.apps.get(ids[0]); return [svc('app', a.name, a.id, 'farm-single-app')]; }
    const f = cat.farms.get(farm);
    return [f ? svc('farm', f.name, farm, 'farm') : svc('farm', farm, farm, 'farm-id')];
  };
  if (type === 'APPLICATION' && farm) return viaFarm();
  if (desk) {
    const d = cat.desktops.get(desk);
    return [d ? svc('desktop', d.name, desk, 'desktop-pool') : svc('desktop', desk, desk, 'desktop-pool-id')];
  }
  if (farm) return viaFarm();
  // 그 밖의 풀 키(기존 POOL_KEYS 의 pool_id 등)는 종류를 모른다 — 지어내지 않고 미확인으로 센다.
  const [, other] = pickKey(s, POOL_KEYS);
  return [svc('unknown', other || '(풀 정보 없음)', other || '', 'unknown')];
}

/**
 * 원시 세션 배열 → (사용자, 서비스) 쌍 + 서비스별 집계.
 *
 * @param {object[]} raw
 * @param {object} p
 * @param {string|null} p.usedUserKey   normalizeSessions 가 고른 계정 키(같은 판정을 쓴다 — 두 번 고르지 않는다)
 * @param {string|null} p.usedStateKey
 * @param {object} [p.catalog]          normalizeCatalog() 결과
 */
export function usageFromSessions(raw, { usedUserKey = null, usedStateKey = null, catalog = EMPTY_CATALOG, maxPairs = 20_000, maxServices = 500 } = {}) {
  const list = (Array.isArray(raw) ? raw : []).filter((x) => x && typeof x === 'object');
  const pairs = new Map();
  const services = new Map();
  const basisCounts = Object.fromEntries(BASES.map((b) => [b, 0]));
  let appFieldKey = null;
  let noUser = 0;
  for (const s of list) {
    const [ak] = appNamesOf(s);
    if (ak && !appFieldKey) appFieldKey = ak;
    const [, uRaw] = usedUserKey ? pickKey(s, [usedUserKey]) : [null, null];
    const name = str(uRaw);
    const [, stRaw] = usedStateKey ? pickKey(s, [usedStateKey]) : pickKey(s, STATE_KEYS);
    const connected = stRaw ? STATE_OF[str(stRaw).toUpperCase()] === 'connected' : null;
    for (const v of resolveServices(s, catalog)) {
      basisCounts[v.basis] = (basisCounts[v.basis] || 0) + 1;
      let e = services.get(v.key);
      if (!e) { e = { key: v.key, kind: v.kind, name: v.name, basis: v.basis, ids: [], sessions: 0, connectedSessions: 0, users: new Set(), connectedUsers: new Set(), stateUnknown: 0 }; services.set(v.key, e); }
      if (v.id && !e.ids.includes(v.id) && e.ids.length < 20) e.ids.push(v.id);
      e.sessions++;
      if (connected === true) e.connectedSessions++;
      else if (connected == null) e.stateUnknown++;
      if (!name) { noUser++; continue; }
      const uk = userKey(name);
      e.users.add(uk);
      if (connected === true) e.connectedUsers.add(uk);
      const pk = `${uk}\u0001${v.key}`;
      let p = pairs.get(pk);
      if (!p) { p = { userKey: uk, user: name, serviceKey: v.key, service: v.name, kind: v.kind, basis: v.basis, sessions: 0, connected: false }; pairs.set(pk, p); }
      p.sessions++;
      if (connected === true) p.connected = true;
    }
  }
  const svcList = [...services.values()]
    .map((e) => ({ key: e.key, kind: e.kind, name: e.name, basis: e.basis, ids: e.ids, sessions: e.sessions,
      connectedSessions: usedStateKey ? e.connectedSessions : null, users: e.users.size,
      usersConnected: usedStateKey ? e.connectedUsers.size : null, stateUnknown: e.stateUnknown }))
    .sort((a, b) => (b.usersConnected ?? 0) - (a.usersConnected ?? 0) || b.users - a.users || a.name.localeCompare(b.name, 'ko'));
  const pairList = [...pairs.values()];
  return {
    pairs: pairList.slice(0, maxPairs),
    pairsOmitted: Math.max(0, pairList.length - maxPairs),
    services: svcList.slice(0, maxServices),
    servicesOmitted: Math.max(0, svcList.length - maxServices),
    basisCounts,
    appFieldKey,
    sessionsNoUser: noUser,
  };
}
