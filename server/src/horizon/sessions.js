/**
 * horizon/sessions.js — Horizon 세션 목록 정규화·집계(v2.525, **순수 모듈**).
 *
 * 사용자 요청(2026-09-16): **"Horizon 솔루션 사용중인데 실시간 사용자를 뽑고 싶어"**.
 *
 * ── 근거와 그 한계(정직 기록 — 반드시 유지) ────────────────────────────────────
 * 이 환경의 egress 정책에서 **공식 문서를 읽지 못했다**: `developer.broadcom.com`(Horizon
 * Server API 레퍼런스)·`retouw.nl`·`digitalworkspace.one`·`evengooder.com`·`glama.ai` 가 모두
 * 차단(CONNECT 거부)이다. 그래서 경로·필드명은 **읽을 수 있었던 1차 자료**에서만 가져왔다:
 *
 *  · 경로 `GET /rest/inventory/v1/sessions` (+ `page`·`size`·`filter`·`sort_by`·`order_by`)
 *    — `matt-coppinger/horizon-mcp` `src/horizon_mcp/tools/inventory.py:556`(직접 받아 읽었다).
 *      그 저장소 머리말은 "verified against the Horizon Server REST API for versions 2512
 *      through 2606" 이라고 밝힌다. `size` 최대 1000.
 *  · 필터·정렬 필드명 `user_name`·`desktop_pool_id`·`machine_name`·`client_name`·`state`,
 *    세션 상태 `CONNECTED`·`DISCONNECTED`·`PENDING` — 같은 파일의 docstring.
 *  · 응답 필드 `session_state`·`session_type`(DESKTOP|APPLICATION)·`desktop_pool_id`·
 *    `start_time`·`user_id`(SID 형식) — 검색 결과 요약으로만 확인했다(원문 페이지는 차단).
 *
 * ⚠ 즉 **응답 객체의 계정명 필드가 `user_name` 인지 확인하지 못했다.** 한 검색 결과 요약은
 *   문서 발췌에 `user_name` 이 보이지 않는다고 했고, 다른 요약은 필터 이름으로 존재한다고 했다.
 *   그래서 이 모듈은 **후보 키 체인**으로 읽고 **무엇으로 읽었는지(`usedUserKey`)를 보고**한다
 *   (v2.522 의 `usedCmds` 와 같은 규약). 실장비 응답을 받으면 체인을 좁히고 이 고지를 지울 것.
 *
 * ── 이 모듈이 지켜야 하는 정직성 규칙 ───────────────────────────────────────────
 * 1. **'실시간 사용자' 는 CONNECTED 세션의 고유 계정이다.** 상태 필드를 읽지 못하면
 *    `connected` 를 **0 이 아니라 null** 로 둔다 — 0 으로 채우면 '지금 아무도 없다' 는 거짓이 된다.
 * 2. **계정명이 없고 SID 만 있으면 그대로 밝힌다**(`userIdOnly`). SID 로도 고유 인원 수는
 *    정확하지만 **이름을 보여줄 수 없다**. SID 를 이름인 척 표시하지 않는다.
 * 3. **아무 필드도 못 읽으면 `unparsed`** 다(수치 null). '세션 0건' 이라 말하지 않는다.
 * 4. **상한으로 자른 것은 개수를 밝힌다**(`usersOmitted`·`poolsOmitted`).
 * 5. 사용자 지시(v2.520) **"aaa 가 여러 서버에 로그인해 있으면 1명"** 이 여기도 그대로 적용된다 —
 *    세는 것은 세션이 아니라 **고유 계정**이고, 두 값을 함께 낸다.
 */

import { userKey, splitAccount } from '../curuser/aggregate.js';

/** 세션 목록 경로 — 위 머리말의 1차 자료. 버전 접두(v1)는 Horizon 이 경로에 박는다. */
export const SESSION_PATH = '/rest/inventory/v1/sessions';
/** `size` 상한(문서화된 최대 1000). */
export const PAGE_SIZE_MAX = 1000;

/** 계정명 후보 — **순서가 판정 순서**다. 확인된 것은 없고 `user_name` 이 가장 유력하다. */
export const USER_NAME_KEYS = Object.freeze(['user_name', 'username', 'userName', 'user_principal_name', 'user']);
/** 계정명이 없을 때의 폴백(SID). 이름이 아니므로 표시 정책이 다르다. */
export const USER_ID_KEYS = Object.freeze(['user_id', 'userId', 'user_sid', 'sid']);
export const STATE_KEYS = Object.freeze(['session_state', 'state', 'status']);
export const TYPE_KEYS = Object.freeze(['session_type', 'type']);
export const POOL_KEYS = Object.freeze(['desktop_pool_id', 'farm_id', 'application_pool_id', 'pool_id']);
export const MACHINE_KEYS = Object.freeze(['machine_name', 'machine_id', 'rds_server_id', 'machine']);
export const CLIENT_KEYS = Object.freeze(['client_name', 'client_address', 'client_id']);
export const START_KEYS = Object.freeze(['start_time', 'session_start_time', 'startTime', 'logon_time']);
export const ID_KEYS = Object.freeze(['id', 'session_id']);

/** 상태 정규화 — 알 수 없는 값은 `other` 로 두고 원문을 보존한다(지어내지 않는다). */
export const STATE_OF = Object.freeze({
  CONNECTED: 'connected', DISCONNECTED: 'disconnected', PENDING: 'pending',
});
export const STATE_LABEL = Object.freeze({
  connected: '접속 중', disconnected: '연결 끊김', pending: '연결 중', other: '알 수 없는 상태',
});

/** 첫 번째로 값이 있는 키를 고른다. 반환 `[key, value]`, 없으면 `[null, null]`. */
export function pickKey(obj, keys) {
  if (!obj || typeof obj !== 'object') return [null, null];
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    const s = typeof v === 'object' ? '' : String(v).trim();
    if (s) return [k, s];
  }
  return [null, null];
}

/** SID 형태인가(`S-1-5-21-…`). 계정명 칸에 SID 가 들어온 경우를 화면이 구분하게. */
export const looksLikeSid = (v) => /^S-\d-\d+(-\d+)+$/i.test(String(v || '').trim());

const epochMs = (v) => {
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? Math.round(n * 1000) : Math.round(n); // 초/밀리초 모두 수용
  const t = Date.parse(String(v || ''));
  return Number.isFinite(t) ? t : null;
};

/**
 * 원시 세션 배열 → 화면·DB 가 쓰는 형태.
 *
 * @param {object[]} raw  Horizon 응답(배열). 페이지를 이어붙인 전체를 넘긴다.
 * @param {object} [p]
 * @param {number} [p.maxUsers=2000]  계정 목록 상한(초과분은 개수만 밝힌다)
 * @param {number} [p.maxPools=200]   풀 목록 상한
 */
export function normalizeSessions(raw, { maxUsers = 2000, maxPools = 200 } = {}) {
  const list = (Array.isArray(raw) ? raw : []).filter((x) => x && typeof x === 'object');
  const sampleKeys = list.length ? Object.keys(list[0]).slice(0, 40) : [];

  // 어떤 키로 읽을지 **전체를 보고** 한 번 정한다 — 세션마다 다른 키를 고르면 같은 사람이
  // 두 계정으로 세어질 수 있다(한 응답 안에서 스키마가 섞이는 일은 없다).
  let usedUserKey = null;
  let userIdOnly = false;
  for (const k of USER_NAME_KEYS) { if (list.some((r) => pickKey(r, [k])[0])) { usedUserKey = k; break; } }
  if (!usedUserKey) {
    for (const k of USER_ID_KEYS) { if (list.some((r) => pickKey(r, [k])[0])) { usedUserKey = k; userIdOnly = true; break; } }
  }
  let usedStateKey = null;
  for (const k of STATE_KEYS) { if (list.some((r) => pickKey(r, [k])[0])) { usedStateKey = k; break; } }

  // 계정명 필드를 전혀 못 찾았다 → '형식 미인식'. 수치를 만들지 않는다(규칙 3).
  if (list.length && !usedUserKey) {
    return {
      parsed: false, sessions: list.length, connected: null, disconnected: null, pending: null, other: null,
      users: null, usersConnected: null, names: [], pools: [], usersOmitted: 0, poolsOmitted: 0,
      usedUserKey: null, usedStateKey, userIdOnly: false, stateUnknown: null, sampleKeys,
    };
  }

  const byUser = new Map();
  const byPool = new Map();
  let connected = 0; let disconnected = 0; let pending = 0; let other = 0; let stateUnknown = 0;

  for (const r of list) {
    const [, uRaw] = pickKey(r, [usedUserKey]);
    const name = String(uRaw || '').trim();
    const [, stRaw] = usedStateKey ? pickKey(r, [usedStateKey]) : [null, null];
    const st = stRaw ? (STATE_OF[String(stRaw).trim().toUpperCase()] || 'other') : null;
    if (st === 'connected') connected++;
    else if (st === 'disconnected') disconnected++;
    else if (st === 'pending') pending++;
    else if (st === 'other') other++;
    else stateUnknown++;
    const [, pool] = pickKey(r, POOL_KEYS);
    const [, machine] = pickKey(r, MACHINE_KEYS);
    const [, client] = pickKey(r, CLIENT_KEYS);
    const [, typeRaw] = pickKey(r, TYPE_KEYS);
    const [, startRaw] = pickKey(r, START_KEYS);
    const startedAt = epochMs(startRaw);

    if (pool) {
      const pe = byPool.get(pool) || { pool, sessions: 0, connected: 0, users: new Set() };
      pe.sessions++; if (st === 'connected') pe.connected++;
      if (name) pe.users.add(userKey(name));
      byPool.set(pool, pe);
    }

    if (!name) continue;
    const key = userKey(name);
    let e = byUser.get(key);
    if (!e) {
      const { domain, user } = splitAccount(name);
      e = {
        name, domain, user, isSid: looksLikeSid(name),
        sessions: 0, connected: 0, disconnected: 0, pending: 0, other: 0, unknown: 0,
        pools: [], machines: [], clients: [], types: [], firstStartedAt: null,
      };
      byUser.set(key, e);
    }
    e.sessions++;
    if (st === 'connected') e.connected++;
    else if (st === 'disconnected') e.disconnected++;
    else if (st === 'pending') e.pending++;
    else if (st === 'other') e.other++;
    else e.unknown++;
    for (const [arr, v] of [[e.pools, pool], [e.machines, machine], [e.clients, client], [e.types, typeRaw]]) {
      if (v && !arr.includes(v) && arr.length < 40) arr.push(v);
    }
    if (startedAt != null && (e.firstStartedAt == null || startedAt < e.firstStartedAt)) e.firstStartedAt = startedAt;
  }

  const names = [...byUser.values()].sort((a, b) => b.connected - a.connected || b.sessions - a.sessions
    || String(a.name).localeCompare(String(b.name), 'ko'));
  const pools = [...byPool.values()].map((p) => ({ pool: p.pool, sessions: p.sessions, connected: p.connected, users: p.users.size }))
    .sort((a, b) => b.connected - a.connected || b.sessions - a.sessions);

  return {
    parsed: true,
    sessions: list.length,
    // ⚠ 상태 필드를 못 읽었으면 **null** — 0 은 '지금 아무도 없다' 는 거짓이 된다(규칙 1).
    connected: usedStateKey ? connected : null,
    disconnected: usedStateKey ? disconnected : null,
    pending: usedStateKey ? pending : null,
    other: usedStateKey ? other : null,
    stateUnknown,
    users: names.length,
    usersConnected: usedStateKey ? names.filter((u) => u.connected > 0).length : null,
    names: names.slice(0, maxUsers),
    usersOmitted: Math.max(0, names.length - maxUsers),
    pools: pools.slice(0, maxPools),
    poolsOmitted: Math.max(0, pools.length - maxPools),
    usedUserKey, usedStateKey, userIdOnly, sampleKeys,
  };
}

/**
 * 여러 Connection Server 의 결과를 합친다.
 *
 * ⚠ **같은 계정이 두 서버에 있으면 1명이다**(v2.520 사용자 지시와 같은 축) — 그래서 합집합을
 *   쓴다. 단 서버별 고유의 **합**(`usersByServerSum`)도 함께 낸다: 두 값이 다르면 그 차이가
 *   '여러 팟에 걸친 사용자' 라는 정보다. 하나만 보여주면 그 전제가 감춰진다.
 * ⚠ **실패한 서버는 수치에서 빼고 개수를 밝힌다**(`serversFailed`) — 0 으로 세면 '사용자가
 *   줄었다' 는 거짓 추이가 DB 에 남는다.
 */
export function combineServers(results) {
  const list = (results || []).filter(Boolean);
  const ok = list.filter((r) => r.ok && r.parsed !== false);
  const union = new Map();       // userKey -> { name, connected, sessions, servers:[] }
  let sessions = 0; let connected = 0; let disconnected = 0; let pending = 0;
  let stateBlind = false;
  for (const r of ok) {
    sessions += Number(r.sessions) || 0;
    if (r.connected == null) stateBlind = true;
    else { connected += Number(r.connected) || 0; disconnected += Number(r.disconnected) || 0; pending += Number(r.pending) || 0; }
    for (const u of r.names || []) {
      const k = userKey(u.name);
      if (!k) continue;
      let e = union.get(k);
      if (!e) { e = { name: u.name, isSid: !!u.isSid, sessions: 0, connected: 0, servers: [] }; union.set(k, e); }
      e.sessions += Number(u.sessions) || 0;
      e.connected += Number(u.connected) || 0;
      if (r.serverId && !e.servers.includes(r.serverId)) e.servers.push(r.serverId);
    }
  }
  const names = [...union.values()].sort((a, b) => b.connected - a.connected || b.sessions - a.sessions);
  return {
    servers: list.length,
    serversOk: ok.length,
    serversFailed: list.length - ok.length,
    sessions,
    // 한 서버라도 상태를 못 읽었으면 합계도 단정하지 않는다(부분 합은 더 위험한 거짓이다).
    connected: stateBlind ? null : connected,
    disconnected: stateBlind ? null : disconnected,
    pending: stateBlind ? null : pending,
    stateBlind,
    users: names.length,
    usersConnected: stateBlind ? null : names.filter((u) => u.connected > 0).length,
    usersByServerSum: ok.reduce((a, r) => a + (Number(r.users) || 0), 0),
    names,
  };
}

/** 추이 적재용 수치만(계정명은 시계열에 넣지 않는다 — v2.520 `aggregate.seriesRow` 와 같은 규약). */
export function seriesRow(agg) {
  // ⚠ `Number(null) === 0` — null 을 그대로 통과시키면 '확인 불가' 가 '0명' 으로 DB 에 남는다.
  const n = (v) => {
    if (v == null || v === '') return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };
  return {
    users: n(agg.users), usersConnected: n(agg.usersConnected),
    sessions: n(agg.sessions), connected: n(agg.connected),
    disconnected: n(agg.disconnected), pending: n(agg.pending),
  };
}
