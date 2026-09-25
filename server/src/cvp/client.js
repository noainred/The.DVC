/**
 * cvp/client.js — CloudVision(CVP) 한 대에 로그인해 장비 정보를 읽는다(v2.608).
 *
 * ⚠⚠ 정직 기록 — **실장비 CVP 로 확인한 경로가 하나도 없다**(이 환경에 CVP 가 없다). 아래 경로·필드는 전부 추정이고
 *   그래서 **후보 체인**이다: 항목마다 경로 후보를 차례로 시도해 "2xx + 파서가 원하는 것을 읽었다" 일 때만 성공으로 본다
 *   (v2.545 '성공 조건은 오류가 없다가 아니라 원하는 것을 읽었다'). 무엇을 썼는지(`usedPaths`)·무엇을 못 읽었는지(`missing`)·
 *   응답에 어떤 필드가 있었는지(`seenFields`)를 결과에 싣는다 — 첫 실수집에서 그 셋을 보고 후보를 좁힐 것(docs/CVP.md).
 *
 * 인증: token → `Authorization: Bearer <token>` · password → `POST /cvpservice/login/authenticate.do`
 *   `{userId,password}` → 응답 쿠키 `access_token`(Set-Cookie) 또는 본문 `sessionId`/`cookie` → 이후 `Cookie: access_token=…`.
 *   끝나면 logout(실패 무시). **로그인(또는 토큰 모드의 첫 조회) 401/403 만 자격증명 거부**로 본다(`err.authFailed`) —
 *   장비별 텔레메트리 경로의 403 은 RBAC 거부일 수 있어 'forbidden' 사유로만 남긴다(주기 수집을 멈추지 않는다).
 *
 * 보안: undici Agent 는 `withSsrfLookup`(DNS 리바인딩 차단 — v2.537 스윕), verifyTls=false 면 **로컬** dispatcher 로만
 *   rejectUnauthorized:false(전역 금지). 모든 요청에 signal(호출자 시한이 세션을 실제로 끊는다 — v2.417).
 *   응답 본문은 상한(기본 8MB) 스트림 읽기 — 넘으면 그 항목만 실패로 기록한다(v2.583 readCapped).
 *
 * 예산(v2.528 규약): 장비별 조회가 장비 수 × 경로 수라 느린 회선에서 시한을 넘기기 쉽다. ① 세션 예산(`budgetMs` —
 *   폴러의 CVP 시한보다 작게) 안에서만 새 장비를 시작하고, 남은 시간이 모자라면 **시작하지 않고** `notTried` 로 밝힌다
 *   ② 한 종류가 처음 3대에서 연속 실패하면 그 주기의 나머지 장비는 그 종류를 시도하지 않는다(`missing` 이 사유를 말한다)
 *   ③ 성공한 후보를 CVP 별로 기억해 다음 주기 첫 시도로 쓴다(`prefer`).
 */
import { Agent } from 'undici';
import { withSsrfLookup } from '../util/ssrfLookup.js';
import { readTextCapped } from '../util/readCapped.js';
import { reqTimeoutMs } from '../agent/envTimeout.js';
import { poolSettled } from '../util/pool.js';
import { pushAll } from '../util/pushAll.js';
import { baseUrlOf } from './registry.js';
import * as P from './parse.js';

const dispVerify = new Agent({ connect: withSsrfLookup({}) });
const dispNoVerify = new Agent({ connect: withSsrfLookup({ rejectUnauthorized: false }) });
const REQ_TIMEOUT_MS = reqTimeoutMs(process.env.CVP_HTTP_TIMEOUT_MS, 30_000);
export const BODY_MAX_BYTES = Math.max(1_048_576, Number(process.env.CVP_BODY_MAX_BYTES) || 8 * 1_048_576);
const DEVICE_CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.CVP_DEVICE_CONCURRENCY) || 6));
const FAIL_STREAK_STOP = 3;
const MIN_SLICE_MS = 5_000;
const RE_HEADER = /^[\t\x20-\x7e]*$/; // eslint-disable-line no-control-regex

/** 경로 후보(추정 — docs/CVP.md). `{serial}` 은 장비 키로 치환된다. */
export const CANDIDATES = Object.freeze({
  inventory: ['/api/resources/inventory/v1/Device/all', '/cvpservice/inventory/devices'],
  cvpVersion: ['/cvpservice/cvpInfo/getCvpInfo.do'],
  interfaces: ['/api/v1/rest/{serial}/Sysdb/interface/status/eth/phy/slice/1/intfStatus/all'],
  counters: ['/api/v1/rest/{serial}/Smash/counters/ethIntf/FastCounters/current'],
  bgp: ['/api/v1/rest/{serial}/Sysdb/routing/bgp/export/vrfBgpPeerInfoStatusEntryTable'],
  power: ['/api/v1/rest/{serial}/Sysdb/environment/power/status'],
  cooling: ['/api/v1/rest/{serial}/Sysdb/environment/cooling/status'],
  temperature: ['/api/v1/rest/{serial}/Sysdb/environment/temperature/status'],
  xcvr: ['/api/v1/rest/{serial}/Sysdb/hardware/archer/xcvr/status'],
});
/** 부품 종류 → 표시 kind. */
export const PART_KINDS = Object.freeze({ power: 'psu', cooling: 'fan', temperature: 'temp', xcvr: 'xcvr' });

export class CvpAuthError extends Error {
  constructor(msg) { super(msg); this.authFailed = true; }
}

/**
 * 요청 하나의 신호. v2.611(TIM2611-01): 건별 시한은 min(REQ_TIMEOUT, 남은 세션 예산) — 30초 요청이 10초 남은 예산을 넘어
 *   CVP 당 시한(withDeadline)에 먼저 걸리면 그 주기 결과가 통째로 조용히 잘렸다(v2.528 '시작해 놓고 잘림').
 */
export const reqMsFor = (leftMs) => {
  const l = typeof leftMs === 'function' ? Number(leftMs()) : NaN;
  return Number.isFinite(l) ? Math.max(1_000, Math.min(REQ_TIMEOUT_MS, l)) : REQ_TIMEOUT_MS;
};
const sig = (outer, leftMs) => {
  const t = AbortSignal.timeout(reqMsFor(leftMs));
  return outer ? AbortSignal.any([outer, t]) : t;
};

/*
 * v2.612 SEC2612-02: 리다이렉트를 따라가지 않는다. fetch 기본 'follow' 는 307/308 이면 **로그인 본문(계정·비밀번호)을 그대로
 *   다른 주소로 다시 POST** 하고, 세션 쿠키·Bearer 도 같은 출처면 따라간다. 게다가 IP 리터럴 대상은 SSRF lookup 을 거치지 않는다.
 *   CVP API 는 리다이렉트를 쓸 이유가 없으므로 3xx 는 실패로 보고, 사유에는 상태와 Location 의 **origin 만** 싣는다(경로·쿼리에
 *   토큰이 있을 수 있다).
 */
export const isRedirect = (status) => status >= 300 && status < 400;
export function redirectReason(res, base) {
  let origin = '';
  try { const loc = res.headers.get('location'); if (loc) origin = new URL(loc, base).origin; } catch { origin = ''; }
  return `CVP 가 리다이렉트로 응답했습니다(HTTP ${res.status}${origin ? ` → ${origin}` : ''}) — 따라가지 않았습니다. 등록 주소(스킴·호스트·포트)를 확인하세요`;
}

/** Set-Cookie 에서 access_token 값(없으면 ''). */
export function accessTokenFromSetCookie(values) {
  const list = Array.isArray(values) ? values : values ? [values] : [];
  for (const v of list) {
    const m = /(?:^|[;,\s])access_token=([^;,\s]+)/.exec(String(v));
    if (m) return m[1];
  }
  return '';
}

/**
 * 세션을 연다. 반환: { get(path) → {ok,status,text?,reason?}, logout(), base }.
 * @throws CvpAuthError 로그인 401/403
 */
export async function openSession(server, { signal, leftMs = null } = {}) {
  const b = baseUrlOf(server?.host);
  if (b.issue) throw new Error(b.issue);
  const base = b.base;
  const dispatcher = server.verifyTls === true ? dispVerify : dispNoVerify;
  let headers = { Accept: 'application/json' };
  let loggedIn = false;
  if (server.authMode === 'password') {
    const body = JSON.stringify({ userId: String(server.username || ''), password: String(server.password || '') });
    let res;
    try {
      res = await fetch(`${base}/cvpservice/login/authenticate.do`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body, dispatcher, signal: sig(signal, leftMs), redirect: 'manual',
      });
    } catch (e) { throw new Error(`로그인 요청 실패: ${e?.cause?.code || e?.message || e}`); }
    if (isRedirect(res.status)) { try { await res.body?.cancel?.(); } catch { /* */ } throw new Error(`로그인 ${redirectReason(res, base)}`); }
    if (res.status === 401 || res.status === 403) {
      try { await res.body?.cancel?.(); } catch { /* */ }
      throw new CvpAuthError(`인증 실패(${res.status}) — CVP 계정·비밀번호를 확인하세요`);
    }
    if (!res.ok) { try { await res.body?.cancel?.(); } catch { /* */ } throw new Error(`로그인 HTTP ${res.status}`); }
    let tok = accessTokenFromSetCookie(typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : res.headers.get('set-cookie'));
    let j = null;
    try { j = JSON.parse(await readTextCapped(res, 1_048_576, '로그인 응답')); } catch { j = null; }
    if (!tok && j && typeof j === 'object') tok = String(j.sessionId || j.cookie || j.access_token || '');
    if (!tok) throw new Error('로그인 응답에 세션 토큰(access_token)이 없습니다 — CVP 버전별 로그인 방식이 다를 수 있습니다');
    if (!RE_HEADER.test(tok)) throw new Error('세션 토큰에 사용 불가 문자가 있습니다');
    headers = { ...headers, Cookie: `access_token=${tok}` };
    loggedIn = true;
  } else {
    const t = String(server.token || '').trim();
    if (!t) throw new CvpAuthError('인증 실패 — 서비스 계정 토큰이 없습니다');
    if (!RE_HEADER.test(t)) throw new Error('토큰에 사용 불가 문자가 있습니다');
    headers = { ...headers, Authorization: `Bearer ${t}` };
  }
  return {
    base,
    async get(p) {
      let res;
      try { res = await fetch(`${base}${p}`, { headers, dispatcher, signal: sig(signal, leftMs), redirect: 'manual' }); }
      catch (e) {
        if (signal?.aborted) throw e;
        return { ok: false, status: 0, reason: `연결 실패: ${e?.cause?.code || e?.message || e}` };
      }
      if (isRedirect(res.status)) { try { await res.body?.cancel?.(); } catch { /* */ } return { ok: false, status: res.status, reason: redirectReason(res, base), redirect: true }; }
      if (!res.ok) { try { await res.body?.cancel?.(); } catch { /* */ } return { ok: false, status: res.status, reason: `HTTP ${res.status}` }; }
      try { return { ok: true, status: res.status, text: await readTextCapped(res, BODY_MAX_BYTES, '응답') }; }
      catch (e) { return { ok: false, status: res.status, reason: e?.message || String(e), tooLarge: true }; }
    },
    async logout() {
      if (!loggedIn) return;
      try {
        const r = await fetch(`${base}/cvpservice/login/logout.do`, { method: 'POST', headers, dispatcher, signal: AbortSignal.timeout(10_000), redirect: 'manual' });
        try { await r.body?.cancel?.(); } catch { /* */ }
      } catch { /* 반납 실패는 무시 — 세션은 CVP 타임아웃으로도 회수된다 */ }
    },
  };
}

/** 경로 후보 순서 — 지난 주기에 성공한 후보를 앞으로. */
function ordered(kind, prefer) {
  const list = CANDIDATES[kind] || [];
  const p = prefer?.get?.(kind);
  return p && list.includes(p) ? [p, ...list.filter((x) => x !== p)] : list;
}
const fill = (tpl, serial) => tpl.replaceAll('{serial}', encodeURIComponent(serial));

/**
 * 한 CVP 를 수집한다(순수에 가깝다 — 상태는 인자로 받는다).
 * @param {object} server 비밀 포함 등록 항목
 * @param {{ signal?:AbortSignal, budgetMs?:number, partsDue?:boolean, prefer?:Map, now?:()=>number }} opts
 * @returns {Promise<object>} 결과(아래 머리말) — 자격증명 거부는 CvpAuthError 로 던진다.
 */
export async function collectCvp(server, { signal, budgetMs = 110_000, partsDue = true, prefer = new Map(), now = Date.now } = {}) {
  const t0 = now();
  const left = () => budgetMs - (now() - t0);
  const usedPaths = {}; const missing = {}; const seenFields = {};
  const truncated = { devices: 0, ports: 0, peers: 0, notTried: 0, aborted: 0 };
  const sess = await openSession(server, { signal, leftMs: left });
  try {
    // ① 인벤토리 — 이것이 없으면 아무것도 없다.
    let inv = null; let invReason = '';
    for (const p of ordered('inventory', prefer)) {
      const r = await sess.get(p);
      if (!r.ok) {
        if ((r.status === 401 || r.status === 403) && server.authMode !== 'password') throw new CvpAuthError(`인증 실패(${r.status}) — 서비스 계정 토큰을 확인하세요`);
        invReason = `${p}: ${r.reason}`;
        continue;
      }
      const parsed = P.parseInventory(r.text);
      seenFields.inventory = parsed.keys;
      if (!parsed.devices) { invReason = `${p}: 장비 목록 형식을 읽지 못했습니다`; continue; }
      inv = parsed; usedPaths.inventory = p; prefer.set('inventory', p);
      break;
    }
    if (!inv) {
      missing.inventory = invReason || '후보 경로가 없습니다';
      return { ok: false, error: `장비 인벤토리를 읽지 못했습니다 — ${missing.inventory}`, devices: [], usedPaths, missing, seenFields, truncated, inventoryComplete: false, cvpVersion: '' };
    }
    truncated.devices = inv.truncated;

    // ② CVP 자체 버전(참고) — 실패해도 진행.
    let cvpVersion = '';
    for (const p of ordered('cvpVersion', prefer)) {
      const r = await sess.get(p);
      if (!r.ok) { missing.cvpVersion = `${p}: ${r.reason}`; continue; }
      const { values } = P.splitJsonStream(r.text);
      const v = values[0] && typeof values[0] === 'object' ? String(values[0].version || values[0].appVersion || '') : '';
      if (v) { cvpVersion = v.slice(0, 64); usedPaths.cvpVersion = p; delete missing.cvpVersion; break; }
      missing.cvpVersion = `${p}: 버전 필드가 없습니다`;
    }

    // ③ 장비별 텔레메트리 — 종류마다 후보 체인 + 연속 실패 차단.
    const kinds = ['interfaces', 'counters', 'bgp', ...(partsDue ? Object.keys(PART_KINDS) : [])];
    const ks = Object.fromEntries(kinds.map((k) => [k, { ok: 0, fail: 0, streak: 0, stopped: false, last: '' }]));
    const readKind = async (kind, serial, parse) => {
      const st = ks[kind];
      if (st.stopped) return { skipped: true };
      let lastReason = '';
      for (const tpl of ordered(kind, prefer)) {
        const r = await sess.get(fill(tpl, serial));
        if (!r.ok) { lastReason = r.status === 403 ? 'forbidden(403)' : r.status === 404 ? '없음(404)' : r.reason; continue; }
        const out = parse(r.text);
        if (out && out.value != null) {
          st.ok++; st.streak = 0;
          if (!usedPaths[kind]) usedPaths[kind] = tpl;
          prefer.set(kind, tpl);
          if (!seenFields[kind] && out.keys) seenFields[kind] = out.keys.slice(0, 40);
          return { value: out.value, extra: out };
        }
        lastReason = '응답은 왔지만 형식을 읽지 못했습니다';
        if (!seenFields[kind] && out?.keys) seenFields[kind] = out.keys.slice(0, 40);
      }
      st.fail++; st.streak++; st.last = lastReason;
      if (st.ok === 0 && st.streak >= FAIL_STREAK_STOP) st.stopped = true;
      return { failed: true, reason: lastReason };
    };

    const devices = inv.devices.map((d) => ({ ...d, parts: undefined, partsAt: null, bgp: null, ports: null, counters: null, countersAt: null, telemetry: 'pending' }));
    await poolSettled(devices, DEVICE_CONCURRENCY, async (dev) => {
      if (signal?.aborted) { dev.telemetry = 'aborted'; truncated.notTried++; return; }
      if (left() < MIN_SLICE_MS) { dev.telemetry = 'budget'; truncated.notTried++; return; }
      if (dev.streaming === false) { dev.telemetry = 'not-streaming'; return; }
      const serial = dev.serial || dev.key;
      const intf = await readKind('interfaces', serial, (t) => { const x = P.parseInterfaces(t); return { value: x.ports, keys: x.keys, truncated: x.truncated }; });
      if (intf.value) { dev.ports = intf.value; truncated.ports += intf.extra.truncated || 0; }
      if (left() < MIN_SLICE_MS) { dev.telemetry = 'budget-partial'; return; }
      const cnt = await readKind('counters', serial, (t) => { const x = P.parseCounters(t); return { value: x.counters, keys: x.keys }; });
      if (cnt.value) { dev.counters = cnt.value; dev.countersAt = now(); }
      // v2.611(TIM2611-01): counters·bgp 앞에도 예산을 본다 — 시작해 놓고 잘리면 결과가 버려진다.
      if (left() < MIN_SLICE_MS) { dev.telemetry = intf.value || cnt.value ? 'budget-partial' : 'budget'; return; }
      const bgp = await readKind('bgp', serial, (t) => { const x = P.parseBgp(t); return { value: x.peers, keys: x.keys, truncated: x.truncated }; });
      if (bgp.value) { dev.bgp = bgp.value; truncated.peers += bgp.extra.truncated || 0; }
      if (partsDue) {
        const parts = []; let anyRead = false; let attempted = false; const failedKinds = [];
        for (const k of Object.keys(PART_KINDS)) {
          if (left() < MIN_SLICE_MS) { failedKinds.push(k); continue; }
          attempted = true;
          const r = await readKind(k, serial, (t) => { const x = P.parseParts(t, PART_KINDS[k]); return { value: x.parts, keys: x.keys }; });
          if (r.value) { anyRead = true; pushAll(parts, r.value); } else failedKinds.push(k);
        }
        // 한 종류도 시도하지 못했으면(예산) 이번에 안 읽은 것 — undefined 로 두어 DB 의 이전 파트 값을 지우지 않는다.
        dev.parts = anyRead ? parts.slice(0, P.PART_MAX) : attempted ? null : undefined;
        dev.partsAt = attempted ? now() : null;
        // v2.612 RECENT2612-01: 파트 조회를 **시도했는가**(경로가 전부 404 여도 시도다). 폴러가 이것으로 조회 시각을 올린다 —
        //   '읽었을 때만' 올리면 파트 경로가 없는 CVP 에 매 주기 4종 × 장비 수만큼 헛조회가 나간다.
        dev.partsAttempted = attempted;
        if (failedKinds.length && anyRead) dev.partsMissingKinds = failedKinds;
      }
      dev.telemetry = intf.value || cnt.value || bgp.value ? 'ok' : 'failed';
    });
    // v2.611(TIM2611-01): 시한(외부 신호)에 걸려 끝나지 못한 장비는 'pending' 으로 남는다 — '조회 중단' 으로 바꾸고 개수를 밝힌다.
    for (const dev of devices) if (dev.telemetry === 'pending') { dev.telemetry = 'aborted'; truncated.aborted++; }
    if (truncated.aborted) missing.deadline = `CVP 수집 시한에 걸려 ${truncated.aborted}대는 조회를 끝내지 못했습니다(값이 비어 있는 것은 '없음' 이 아니라 '못 읽음')`;
    for (const [k, st] of Object.entries(ks)) {
      if (st.fail === 0 && !st.stopped) continue;
      missing[k] = st.stopped
        ? `처음 ${FAIL_STREAK_STOP}대에서 모든 후보 경로가 실패해 이번 주기 나머지 장비는 시도하지 않았습니다(${st.last})`
        : `${st.fail}대 실패(${st.last})`;
    }
    if (truncated.notTried) missing.budget = `시간 예산이 모자라 ${truncated.notTried}대는 이번 주기에 조회하지 않았습니다`;
    return {
      ok: true, error: null, devices, usedPaths, missing, seenFields, truncated, cvpVersion,
      inventoryComplete: inv.truncated === 0,
    };
  } finally { await sess.logout(); }
}

/**
 * 연결 테스트 — 로그인 + 인벤토리만(장비별 조회 없음). 스냅샷·DB 에 저장하지 않는다.
 */
export async function testCvp(server, { signal } = {}) {
  const t0 = Date.now();
  try {
    const sess = await openSession(server, { signal });
    try {
      let redirected = '';
      for (const p of CANDIDATES.inventory) {
        const r = await sess.get(p);
        if (!r.ok) {
          if ((r.status === 401 || r.status === 403) && server.authMode !== 'password') throw new CvpAuthError(`인증 실패(${r.status}) — 서비스 계정 토큰을 확인하세요`);
          if (r.redirect && !redirected) redirected = r.reason; // v2.612 SEC2612-02: 리다이렉트는 사유를 그대로 보인다
          continue;
        }
        const x = P.parseInventory(r.text);
        if (x.devices) return { ok: true, ms: Date.now() - t0, deviceCount: x.devices.length, usedPath: p, seenFields: x.keys };
      }
      return { ok: false, ms: Date.now() - t0, reason: redirected || '로그인은 됐지만 장비 인벤토리 경로를 읽지 못했습니다(후보 경로 전부 실패)' };
    } finally { await sess.logout(); }
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, reason: e?.message || String(e), authFailed: !!e?.authFailed };
  }
}
