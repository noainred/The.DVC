/**
 * auth/addressMask.js — 비-admin 응답에서 장비 관리 주소·계정명을 가린다(v2.599 AUTHZ-2599-03).
 *
 * 스토리지·SAN 스위치·PDU 조회는 `tools` 권한(operator 기본 보유) + 전체 범위 계정이면 열린다
 * (v2.555 '스토리지 엔지니어에게 스토리지만' 은 그 조회 권한에 기대는 설계다 — 조회 자체는 막지 않는다).
 * 그런데 목록이 등록부를 `...d` 로 펼쳐 **관리 IP·SSH/REST 계정명**을 그대로 줬다. v2.593 AUTHZ-01
 * (중계 토폴로지 `maskTopology`)이 고친 것과 같은 계열의 형제 누락이다. 등록·수정·삭제·연결 테스트는
 * 전부 adminOnly 라 비-admin 화면은 이 값을 **보여 주는 데만** 쓴다 — 가려도 기능이 깨지지 않는다.
 *
 * 규칙(relaytopo 와 같다):
 *  - admin 판정은 `req.user?.role === 'admin'` 하나(거부 기본값 — user 가 없으면 가린다).
 *  - 키를 지우지 않고 빈 문자열로 둔다(화면이 '—' 로 그린다). 가렸다는 사실은 응답의 `addressHidden` 이 말한다.
 *  - 이름이 비어 주소로 떨어진 경우(`name === host`)도 같은 값이므로 함께 가린다 — 빈 문자열이 아니라
 *    `maskedNameLabel`(타입 + 내부 id)로 둔다(v2.600 — 빈 이름은 화면에서 라벨 없는 행이 된다).
 *  - 엣지가 실제로 쓴 자격증명 지문(`extra.credFp`)의 **계정명**도 비운다(길이·해시는 비밀번호를
 *    복원할 수 없는 16비트 지문이라 남긴다 — 인증 실패 진단 문구가 그 값으로 '바뀌었는지' 를 말한다).
 */

import crypto from 'node:crypto';
import { isIP } from 'node:net';

export const isAdminReq = (req) => req?.user?.role === 'admin';

const HIDDEN = '(주소 가림)';

/**
 * 주소 하나의 표기 변형 — URL 로 저장하는 등록부(Horizon·iDRAC: 'https://cs01.corp:443/')의 오류
 * 문구는 스킴 없는 호스트명만 싣는다('getaddrinfo ENOTFOUND cs01.corp'). 원문과 호스트 부분을 함께 준다.
 */
export function hostVariants(h) {
  const raw = typeof h === 'string' ? h.trim() : '';
  if (!raw) return [];
  const bare = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return [...new Set([raw, bare].filter(Boolean))];
}

/*
 * v2.602 RECENT2602-01: 가림 비용은 '행 수 × 등록 주소 수' 였다. `scrubHosts` 가 부를 때마다 주소 전부의
 * 표기 변형을 만들고 Set·정렬까지 다시 해, 파트 장애 2,000행 × 주소 1,200개가 **5.6초** 이벤트 루프를
 * 막았다(비-admin 조회 경로). 이제 변형 목록·정렬·색인은 **주소 목록당 한 번**(`makeScrubber`) 만들고,
 * 문자열마다 '실제로 들어 있는 주소' 만 색인으로 찾아 예전과 **같은 순서**(긴 것 먼저, 같은 길이는 목록 순)로
 * 바꾼다 — 결과는 예전 구현과 같다(테스트가 대조한다). 같은 배열을 넘기는 호출은 WeakMap 캐시가 재사용한다.
 */
function variantsOf(hosts) { return [...new Set((hosts || []).flatMap(hostVariants))]; }
function byLengthDesc(list) { return list.sort((a, b) => b.length - a.length); }

/**
 * 주소 목록 → 치환기 `(v, extraHosts?) => string`. `extraHosts` 는 행마다 다른 소수의 주소(자기 host·식별자
 * 원문)이고, 예전 `scrubHosts(v, [...extra, ...hosts])` 와 같은 결과를 준다.
 * 색인은 글자 트라이 하나다 — 접두 몇 글자로 묶으면 'https://' 나 '10.0.' 처럼 공통 접두가 긴 주소가
 * 한 칸에 수백 개 몰려 다시 느려진다(초판 실측 2,000행 250ms). 트라이는 위치마다 실제로 이어지는 만큼만 걷는다.
 */
export function makeScrubber(hosts = []) {
  const list = byLengthDesc(variantsOf(hosts));
  const rank = new Map(list.map((h, i) => [h, i]));
  const root = new Map();
  for (const h of list) {
    let node = root;
    for (let k = 0; k < h.length; k++) {   // UTF-16 단위 — found() 가 v[i] 로 걷는 것과 같은 단위
      const ch = h[k];
      let next = node.get(ch);
      if (!next) { next = new Map(); node.set(ch, next); }
      node = next;
    }
    node.end = h;
  }
  /** 문자열에 실제로 들어 있는 목록 주소(목록 순서 그대로). */
  const found = (v) => {
    if (!list.length) return [];
    const hit = new Set();
    for (let i = 0; i < v.length; i++) {
      let node = root.get(v[i]);
      for (let j = i + 1; node; j++) {
        if (node.end !== undefined) hit.add(node.end);
        if (j >= v.length) break;
        node = node.get(v[j]);
      }
    }
    return hit.size ? [...hit].sort((a, b) => rank.get(a) - rank.get(b)) : [];
  };
  const fn = (v, extraHosts) => {
    if (typeof v !== 'string') return v;
    let hs = found(v);
    if (extraHosts && extraHosts.length) {
      // 예전 순서: Set([...extra 변형, ...hosts 변형]) 을 길이 내림차순 안정 정렬 — extra 가 같은 길이에서 앞선다.
      const ex = variantsOf(extraHosts).filter((h) => v.includes(h));
      if (ex.length) { const exSet = new Set(ex); hs = byLengthDesc([...ex, ...hs.filter((h) => !exSet.has(h))]); }
    }
    return hs.reduce((acc, h) => scrub(acc, h), v);
  };
  return fn;
}

/* 같은 배열을 여러 번 넘기는 호출(행마다 scrubHosts(x, hosts))을 위한 캐시 — 배열 정체성 + 길이로 본다.
 * ⚠ 호출부가 넘긴 뒤 배열 내용을 바꾸면(같은 길이로) 캐시가 낡는다 — 요청마다 새로 만든 배열만 넘길 것. */
const SCRUBBER_CACHE = new WeakMap();
export function scrubberFor(hosts) {
  if (!Array.isArray(hosts)) return makeScrubber(hosts);
  const c = SCRUBBER_CACHE.get(hosts);
  if (c && c.len === hosts.length) return c.fn;
  const fn = makeScrubber(hosts);
  SCRUBBER_CACHE.set(hosts, { len: hosts.length, fn });
  return fn;
}

/** 문자열 안의 주소 원문 여러 개를 표식으로(긴 것 먼저 — '10.0.0.50' 이 '10.0.0.5' 에 먹히지 않게). */
export function scrubHosts(v, hosts = []) {
  if (typeof v !== 'string') return v;
  return scrubberFor(hosts || [])(v);
}

/**
 * 이름이 주소와 같아 가린 행의 대체 라벨(v2.600 RECENT2600-04). 빈 문자열로 두면 화면의
 * `reported || name || host` 가 전부 비어 **이름 없는 행·라벨 없는 버튼**이 된다. 식별자가 아닌
 * 라벨(타입 + 포탈 내부 id — id 는 무작위 생성이라 주소를 담지 않는다)을 쓴다. 둘 다 없으면 고정 표식.
 */
export function maskedNameLabel(d) {
  const type = typeof d?.type === 'string' ? d.type : '';
  const id = [d?.id, d?.deviceId].find((v) => typeof v === 'string' && v) || '';
  const lab = [type, id].filter(Boolean).join(' ');
  return lab ? `${lab} (이름 가림)` : '(이름 가림)';
}

/* ── 식별자 자체가 주소인 행(v2.601 AUTHZ-2601-01~04) ─────────────────────────────────────
 * iDRAC 등록부는 IP 로 대량 등록하면 id = name = IP 로 발급한다(`idrac/registry.js` bulk·scan).
 * 그래서 host 칸만 비우면 serverId·fleetId·key·deviceId·partKey·name 에 같은 IP 가 그대로 남는다
 * (v2.600 까지 베어메탈 사용률·파트 장애·인사이트 전력·서버 온도가 모두 그랬다 — addressHidden:true 옆에서).
 * 식별자는 화면이 행 매칭·상세 조회에 쓰므로 비우지 않고 **불투명 토큰**으로 바꾼다:
 *   · 같은 값 → 같은 토큰(행 매칭·React key 가 유지된다) · 다른 값 → 다른 토큰.
 *   · HMAC 키는 **프로세스마다 새로 뽑는다** — 단순 해시면 IPv4 공간(2^32)을 전수해 되돌릴 수 있다.
 *     그 대가로 토큰은 재시작하면 바뀐다(화면은 매번 새로 받아 쓰므로 영향이 없다 — 정직 기록).
 *   · 토큰을 받은 라우트는 `resolveMaskedToken` 으로 원래 행을 찾는다(상세 조회가 깨지지 않게).
 */
const TOKEN_KEY = crypto.randomBytes(32);
export const MASK_TOKEN_PREFIX = 'masked-';
/** 주소처럼 보이는 식별자 → 불투명 토큰(같은 입력은 같은 토큰). 문자열이 아니거나 비면 그대로. */
export function maskedIdToken(v) {
  if (typeof v !== 'string' || !v) return v;
  if (v.startsWith(MASK_TOKEN_PREFIX)) return v;
  return MASK_TOKEN_PREFIX + crypto.createHmac('sha256', TOKEN_KEY).update(v).digest('hex').slice(0, 12);
}
/** 토큰 하나를 후보 원문 목록에서 되찾는다(없으면 null). 원문을 그대로 받으면 그 원문을 돌려준다. */
export function resolveMaskedToken(token, candidates = []) {
  if (typeof token !== 'string' || !token) return null;
  for (const c of candidates) {
    if (typeof c !== 'string' || !c) continue;
    if (c === token || maskedIdToken(c) === token) return c;
  }
  return null;
}
/** 문자열 안 어디든 IPv4 가 있으면 주소로 본다(`host:<vc>:10.0.0.5` 같은 합성 id 도 잡는다). */
const IPV4_ANY = /(?:^|[^\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d])/;
/** 콜론 2개 이상 + 16진·점만 — IPv6 리터럴(대괄호 허용). `host:vc:name` 은 16진이 아니라 걸리지 않는다. */
const IPV6_LIT = /^\[?[0-9a-f]*:[0-9a-f:.]*:[0-9a-f:.]*\]?$/i;
/**
 * 주소 판정기 — `hosts`(등록부 주소 원문)의 표기 변형과 대소문자 무시로 같은지 + IPv4/IPv6 리터럴.
 * 대상이 수천 행이라 호출마다 변형을 다시 만들지 않도록 집합을 한 번 만든다.
 * @returns {(v:any)=>boolean}
 */
export function addressMatcher(hosts = []) {
  const set = new Set((hosts || []).flatMap(hostVariants).map((h) => h.toLowerCase()));
  const fn = (v) => {
    if (typeof v !== 'string') return false;
    const s = v.trim();
    if (!s) return false;
    if (IPV4_ANY.test(s) || IPV6_LIT.test(s)) return true;
    return set.has(s.toLowerCase());
  };
  fn.addressSet = set;
  return fn;
}
/**
 * 미리 만든 판정기 + 행마다 다른 소수의 주소(v2.602 RECENT2602-01) — `addressMatcher([...extra, ...hosts])` 와
 * 같은 판정을 주소 목록 재구성 없이 한다(행마다 1,200개 변형을 다시 만들던 것).
 */
export function extendMatcher(base, extraHosts = []) {
  const extra = new Set((extraHosts || []).flatMap(hostVariants).map((h) => h.toLowerCase()));
  if (!extra.size) return base;
  return (v) => base(v) || (typeof v === 'string' && extra.has(v.trim().toLowerCase()));
}
/** 가린 이름의 대체 라벨 — 원문마다 다른 토큰을 붙여 행끼리 구분된다. */
export function maskedAddressName(v) {
  return `${maskedIdToken(v)} (이름 가림)`;
}
/**
 * 객체 하나의 식별 필드를 가린다(원본을 바꾸지 않는다). `idFields` 는 토큰으로, `nameFields` 는 라벨로.
 * 주소가 아닌 값(서비스태그·무작위 id)은 그대로 둔다 — 화면 식별을 불필요하게 깨지 않는다.
 */
export function maskIdentityFields(obj, match, { idFields = [], nameFields = [] } = {}) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const f of idFields) if (match(out[f])) out[f] = maskedIdToken(out[f]);
  for (const f of nameFields) if (match(out[f])) out[f] = maskedAddressName(out[f]);
  return out;
}

/** 문자열 안의 주소 원문을 표식으로 바꾼다(오류 문구가 'connect ECONNREFUSED 10.0.0.5:22' 처럼 주소를 싣는다). */
function scrub(v, host) {
  if (!host || typeof v !== 'string' || !v.includes(host)) return v;
  return v.split(host).join(HIDDEN);
}

/**
 * 스냅샷 한 개 — host 와 지문 계정명을 비우고, 오류 문구(`error`·`errors{}`) 안의 주소 원문을 표식으로 바꾼다.
 * `hostHint` 는 스냅샷에 host 가 없는 수집기(스토리지)를 위해 등록부 주소를 넘겨받는다. 원본을 바꾸지 않는다.
 * ⚠ 한계(정직 기록): CLI 원문(`extra.cliRaw` 등) 속 주소·배너까지 훑지는 않는다 — 알려진 필드만 가린다.
 */
export function maskSnapAddress(s, hostHint = '') {
  if (!s || typeof s !== 'object') return s;
  const host = s.host || hostHint;
  const out = { ...s };
  if (typeof out.error === 'string') out.error = scrub(out.error, host);
  if (out.errors && typeof out.errors === 'object' && !Array.isArray(out.errors)) {
    out.errors = Object.fromEntries(Object.entries(out.errors).map(([k, v]) => [k, scrub(v, host)]));
  }
  // v2.605 AUTHZ2605-04: REST 수집기는 부분 실패를 `sections.<키> = '오류: <host>:<port> 응답이 없습니다…'` 로
  //   남긴다(netError.js describeFetchError · fosRest sections[key]=e.message) — error 만 가리면 옆 칸에서 샌다.
  //   스킴·포트가 붙은 표기까지 가리도록 변형 치환기를 쓴다.
  if (out.sections && typeof out.sections === 'object' && !Array.isArray(out.sections) && host) {
    const sc = makeScrubber([host]);
    out.sections = Object.fromEntries(Object.entries(out.sections).map(([k, v]) => [k, typeof v === 'string' ? sc(v) : v]));
  }
  // v2.603 AUTHZ-2603-02: 점검 결과(SAN 월간 점검 `checkDevice`)는 수집 실패 시 snap.error 원문
  //   ('getaddrinfo ENOTFOUND <host>')을 항목마다 `items[].detail` 에 싣는다 — error 만 가리면 그 옆에서 샌다.
  if (Array.isArray(out.items) && host) {
    const sc = makeScrubber([host]);
    out.items = out.items.map((it) => (it && typeof it === 'object' && typeof it.detail === 'string' ? { ...it, detail: sc(it.detail) } : it));
  }
  if ('host' in out) out.host = '';
  if (host && out.name === host) out.name = maskedNameLabel(out);
  // v2.615(SF2-08 — 기존 결함): 스토리지 노드 목록의 **노드 IP**(클러스터 내부·관리 주소)도 가린다. 형제 host 는 가리고
  //   노드 IP 는 그대로여서 노드 장애 팝업·장애 장비 화면의 IP 열로 샜다(v2.599 AUTHZ-2599-03 '관리 주소 가림' 계열).
  //   노드 이름이 주소 그 자체인 경우도 라벨로 바꾼다. 비운 칸은 화면이 '—' 로 그리고 addressHidden 안내가 이유를 말한다.
  if (out.nodes && typeof out.nodes === 'object' && !Array.isArray(out.nodes) && Array.isArray(out.nodes.list)) {
    const ipLike = (v) => typeof v === 'string' && v !== '' && (isIP(v.trim()) !== 0 || v.trim() === host);
    out.nodes = {
      ...out.nodes,
      list: out.nodes.list.map((n) => {
        if (!n || typeof n !== 'object' || Array.isArray(n)) return n;
        const m = { ...n };
        if (typeof m.ip === 'string' && m.ip !== '') m.ip = '';
        if (ipLike(m.name)) m.name = maskedAddressName(m.name);
        return m;
      }),
    };
  }
  const fp = out.extra?.credFp;
  if (fp && typeof fp === 'object') out.extra = { ...out.extra, credFp: { ...fp, user: '' } };
  return out;
}

/**
 * 등록부 행(+ 붙은 스냅샷) — host·username 을 비우고 `snap`/`snapshot` 도 같은 규칙으로.
 * 그 밖의 필드(이름·타입·법인·담당 엣지·수집 결과)는 그대로 둔다.
 */
export function maskDeviceAddress(d) {
  if (!d || typeof d !== 'object') return d;
  const host = d.host;
  const out = { ...d, host: '', username: '' };
  if (host && out.name === host) out.name = maskedNameLabel(out);
  if (out.snap) out.snap = maskSnapAddress(out.snap, host);
  if (out.snapshot) out.snapshot = maskSnapAddress(out.snapshot, host);
  return out;
}

/**
 * 수집 작업 로그 이벤트(`util/activityLog.js` — 공통 필드 at·deviceId·name·host·source·ok·error) —
 * 목록과 같은 기준으로 host 를 비우고 오류 문구 속 주소를 가린다. v2.599 Chromium 판독에서 목록만 가렸을 때
 * 화면 하단 '수집 작업' 표가 같은 IP 를 그대로 보여 주는 것을 발견했다(형제 경로가 우회로 — v2.550.3 규약).
 */
export function maskActivityEvents(events, hosts = []) {
  if (!Array.isArray(events)) return events;
  // v2.602 RECENT2602-01: 목록 공통 주소로 판정기·치환기를 **한 번** 만들고, 이벤트마다 자기 host 만 더한다.
  const baseMatch = addressMatcher(hosts || []);
  const scrubber = makeScrubber(hosts || []);
  return events.map((e) => {
    if (!e || typeof e !== 'object') return e;
    const host = e.host;
    const out = { ...e, host: '' };
    // v2.601 AUTHZ-2601-01: 스킴이 붙은 host('https://10.0.0.5')는 오류 문구의 'connect … 10.0.0.5' 와
    //   글자가 달라 가려지지 않았다 — 표기 변형 전부로 가린다. 이름·deviceId 가 주소 자체인 행도 가린다.
    const own = host ? [host] : [];
    if (typeof out.error === 'string') out.error = scrubber(out.error, own);
    const match = extendMatcher(baseMatch, own);
    if (match(out.deviceId)) out.deviceId = maskedIdToken(out.deviceId);
    if (match(out.key)) out.key = maskedIdToken(out.key);
    if (host && out.name === host) out.name = maskedNameLabel(out);
    else if (match(out.name)) out.name = maskedAddressName(out.name);
    return out;
  });
}

/**
 * 폴러 상태 객체(`*PollerStatus()`) — v2.600 AUTHZ-2600-04. 작업 로그 이벤트만 가리고 같은 응답의
 * `poller` 를 그대로 두면, SAN 포트 사용량 폴러의 `inFlight[].host`(진행 중 장비의 관리 주소)와
 * `errors[]`('SW-A: connect ECONNREFUSED 10.0.0.5:22')가 `addressHidden:true` 옆에서 샌다
 * (v2.550.3 '상태 객체에 담긴 값' 규약의 재발). `hosts` 는 등록부의 주소 목록 — 오류 문구에는
 * 어느 장비의 주소인지 표식이 없어 전부 대조한다. 원본을 바꾸지 않는다.
 */
export function maskPollerStatus(poller, hosts = []) {
  if (!poller || typeof poller !== 'object') return poller;
  const hs = [...new Set((hosts || []).flatMap(hostVariants))];
  const hsSet = new Set(hs);
  const scrubAll = makeScrubber(hs);
  const out = { ...poller };
  if (Array.isArray(out.inFlight)) {
    out.inFlight = out.inFlight.map((e) => {
      if (!e || typeof e !== 'object') return e;
      const o = { ...e };
      if ('host' in o) o.host = '';
      // 이름이 주소와 같으면(자기 host 든, host 없는 폴러라 등록부 주소 목록이든) 라벨로 바꾼다.
      if ((e.host && o.name === e.host) || (typeof o.name === 'string' && hsSet.has(o.name))) o.name = maskedNameLabel(o);
      return o;
    });
  }
  if (Array.isArray(out.errors)) out.errors = out.errors.map((x) => (typeof x === 'string' ? scrubAll(x) : x));
  if (typeof out.error === 'string') out.error = scrubAll(out.error);
  if (typeof out.lastError === 'string') out.lastError = scrubAll(out.lastError);
  return out;
}

/**
 * 객체 트리 안의 **모든 문자열**에서 등록부 주소를 가린다(v2.603 AUTHZ-2603-02). SAN 점검 이력(`listRuns` ·
 * `compareRuns`)은 항목 detail 이 runs[].items[] · changes[] · newProblems[] 등 여러 곳에 복사돼 있어 필드를
 * 하나씩 고르면 다음 필드가 우회로가 된다(v2.550.3 규약). 원본을 바꾸지 않는다. 깊이 8·일반 객체/배열만 걷는다.
 */
export function scrubStringsDeep(v, hosts = []) {
  const sc = makeScrubber(hosts || []);
  const walk = (x, depth) => {
    if (typeof x === 'string') return sc(x);
    if (!x || typeof x !== 'object' || depth > 8) return x;
    if (Array.isArray(x)) return x.map((y) => walk(y, depth + 1));
    const proto = Object.getPrototypeOf(x);
    if (proto !== Object.prototype && proto !== null) return x;
    const out = {};
    for (const [k, y] of Object.entries(x)) out[k] = walk(y, depth + 1);
    return out;
  };
  return walk(v, 0);
}
