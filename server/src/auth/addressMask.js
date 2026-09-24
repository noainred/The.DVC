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

/** 문자열 안의 주소 원문 여러 개를 표식으로(긴 것 먼저 — '10.0.0.50' 이 '10.0.0.5' 에 먹히지 않게). */
export function scrubHosts(v, hosts = []) {
  if (typeof v !== 'string') return v;
  const hs = [...new Set((hosts || []).flatMap(hostVariants))].sort((a, b) => b.length - a.length);
  return hs.reduce((acc, h) => scrub(acc, h), v);
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
  return (v) => {
    if (typeof v !== 'string') return false;
    const s = v.trim();
    if (!s) return false;
    if (IPV4_ANY.test(s) || IPV6_LIT.test(s)) return true;
    return set.has(s.toLowerCase());
  };
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
  if ('host' in out) out.host = '';
  if (host && out.name === host) out.name = maskedNameLabel(out);
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
  return events.map((e) => {
    if (!e || typeof e !== 'object') return e;
    const host = e.host;
    const out = { ...e, host: '' };
    // v2.601 AUTHZ-2601-01: 스킴이 붙은 host('https://10.0.0.5')는 오류 문구의 'connect … 10.0.0.5' 와
    //   글자가 달라 가려지지 않았다 — 표기 변형 전부로 가린다. 이름·deviceId 가 주소 자체인 행도 가린다.
    const own = [host, ...(hosts || [])].filter(Boolean);
    if (typeof out.error === 'string') out.error = scrubHosts(out.error, own);
    const match = addressMatcher(own);
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
  const scrubAll = (v) => scrubHosts(v, hs);
  const out = { ...poller };
  if (Array.isArray(out.inFlight)) {
    out.inFlight = out.inFlight.map((e) => {
      if (!e || typeof e !== 'object') return e;
      const o = { ...e };
      if ('host' in o) o.host = '';
      // 이름이 주소와 같으면(자기 host 든, host 없는 폴러라 등록부 주소 목록이든) 라벨로 바꾼다.
      if ((e.host && o.name === e.host) || (typeof o.name === 'string' && hs.includes(o.name))) o.name = maskedNameLabel(o);
      return o;
    });
  }
  if (Array.isArray(out.errors)) out.errors = out.errors.map((x) => (typeof x === 'string' ? scrubAll(x) : x));
  if (typeof out.error === 'string') out.error = scrubAll(out.error);
  if (typeof out.lastError === 'string') out.lastError = scrubAll(out.lastError);
  return out;
}
