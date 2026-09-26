/**
 * 크로스-WAN(중앙↔수집서버/에이전트) 호출용 견고한 fetch.
 *
 * 중앙포탈이 엣지(수집서버)에 연결하거나 에이전트가 중앙에 push할 때, 고RTT(폴란드·미국동부
 * 800ms+)·NAT/방화벽 유휴 타임아웃·일시적 패킷손실로 '가끔' 연결이 실패한다. 단발 fetch는
 * 그 한 번의 일시 오류로 곧장 '연결 안 됨'이 되어 버린다(재시도 없음).
 *
 * 이 헬퍼는:
 *  1) 전용 디스패처로 vCenter 폴링 커넥션 풀과 분리 — vCenter 폴링이 풀을 포화시켜
 *     수집서버 연결이 굶는 현상을 막는다.
 *  2) keep-alive를 짧게 둬서 NAT 유휴 타임아웃으로 '죽은' 소켓을 재사용하다 나는
 *     ECONNRESET 빈도를 줄인다(잔여분은 재시도로 흡수).
 *  3) 일시적 오류(연결 리셋/타임아웃/5xx 게이트웨이)는 지수 백오프로 재시도한다.
 */

import { recordOutbound } from './outboundStats.js';
import { Agent } from 'undici';
import { ssrfLookup } from './ssrfLookup.js';   // v2.506: DNS 리바인딩(TOCTOU) 차단
import { ssrfBlockReason } from './ssrfBlock.js'; // v2.583: 리다이렉트 hop 마다 IP 리터럴 대상 검사

// TLS 검증은 기본 ON(보안). 과거 이 값은 `WAN_TLS_INSECURE === 'false' ? true : false`로,
// 이름과 반대로 '미설정=검증 off'였다 — 중앙↔엣지 구간은 수집 토큰·배포 사용자 자격증명이
// 흐르는 경로라 기본 무검증은 MITM 노출이었다(보안 점검 지적). 이제 기본 검증하고,
// 자체서명 https 엣지가 있는 사이트만 WAN_TLS_INSECURE=true로 명시적으로 낮춘다.
// (엣지 자기등록 URL은 기본 http라 대부분 영향 없음 — https 자체서명 엣지만 opt-out 필요.)
// connections: origin(중앙/엣지)당 동시 연결 상한. undici 기본은 무제한이라 여러 워커가 동시에
// 요청을 쏘면 연결이 수십 개까지 쌓이고 keep-alive로 한동안 남는다(소켓 폭증). 상한을 둬서 재사용·
// 큐잉으로 연결 수를 묶는다. WAN_MAX_CONNECTIONS로 조정(기본 6).
export const WAN_TLS_VERIFY = process.env.WAN_TLS_INSECURE !== 'true';
if (!WAN_TLS_VERIFY) {
  console.warn('[wan] ⚠ WAN_TLS_INSECURE=true — 중앙↔엣지 HTTPS 인증서 검증이 비활성입니다(자체서명 엣지 호환용). 가능하면 사설 CA를 신뢰시키고 이 옵션을 끄세요.');
}
// v2.506(감사 S1 #2): 기본 디스패처에 DNS 리바인딩 차단 lookup 을 단다. 이 에이전트를 쓰는
// 전 호출부(수집 서버 연결 테스트·동기화 등 dispatcher 미지정 경로 전부)가 한 번에 보호된다.
// `ipBlockReason` 은 공인 IP 와 RFC1918 을 허용하고 루프백/링크로컬/메타데이터/우회표기만
// 막으므로, GitHub 업그레이드 다운로드·중앙↔엣지 같은 정상 흐름에는 영향이 없다
// (루프백을 치는 resilientFetch 호출부가 없음을 grep 으로 확인했다).
const wanAgent = new Agent({
  connect: { rejectUnauthorized: WAN_TLS_VERIFY, lookup: ssrfLookup },
  connectTimeout: Number(process.env.WAN_CONNECT_TIMEOUT_MS) || 20_000,
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 30_000,
  connections: Number(process.env.WAN_MAX_CONNECTIONS) || 6,
});

const TRANSIENT_RE = /timed?\s?out|timeout|abort|reset|hang ?up|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|ETIMEDOUT|other side closed|socket|UND_ERR/i;
function isTransientErr(err) {
  const parts = [err?.code, err?.message, err?.name, err?.cause?.code, err?.cause?.message].filter(Boolean).join(' ');
  return TRANSIENT_RE.test(parts);
}
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 고RTT·간헐 네트워크에 견디는 fetch. 일시 오류는 지수 백오프로 재시도한다.
 * @param {string} url
 * @param {object} opts - { timeoutMs=20000, retries=2, retryBackoffMs=400, onRetry, ...fetchInit }
 * @returns {Promise<Response>} 최종 응답(성공 또는 재시도 소진 후의 마지막 응답). 연결 자체가
 *          끝까지 실패하면 마지막 오류를 throw 한다.
 */
/**
 * 리다이렉트 때 **버려야 하는 헤더** (v2.574 SEC-14).
 *
 * ⚠⚠ fetch 의 기본값은 `redirect: 'follow'` 이고, 표준이 교차 출처에서 자동으로 떼는 것은
 * `Authorization`·`Cookie`·`Proxy-Authorization` **뿐**이다. 이 저장소가 실어 보내는 것은
 * `X-Collector-Token`·`X-Central-Token` 같은 **커스텀 헤더**라 그대로 따라간다 —
 * 즉 엣지(또는 그 앞의 무엇)가 `302 Location: https://공격자/` 한 줄만 돌려주면
 * **중앙이 그 토큰을 공격자에게 보낸다**. 수집 토큰 유출 = 그 법인 수집 데이터 열람,
 * 중앙 토큰 유출 = 엣지→중앙 API 임의 호출이다.
 *
 * ⚠ `redirect:'manual'` 로 통째로 막지는 않는다 — GitHub 릴리스 자산 다운로드가 실제로
 *   `objects.githubusercontent.com` 으로 리다이렉트되므로 자동 업그레이드가 깨진다.
 *   그래서 **직접 따라가되 출처가 바뀌면 비밀 헤더를 뗀다**.
 * ⚠ 리바인딩 방어는 그대로다 — 같은 dispatcher 를 쓰므로 `ssrfLookup` 이 리다이렉트 대상에도 걸린다. 단 **호스트 이름일
 *   때만**이다(IP 리터럴은 lookup 을 타지 않는다) — 그래서 hop 마다 `ssrfBlockReason` 을 따로 본다(v2.583).
 */
const SECRET_HEADER_RE = /^(authorization|cookie|proxy-authorization|x-[\w-]*(token|key|secret|auth)|api-key)$/i;
const MAX_REDIRECTS = 5;

/** 헤더 입력(객체·배열·Headers)을 평범한 객체로 — 출처가 바뀌면 비밀만 뺀다. */
export function headersWithoutSecrets(headers) {
  const h = new Headers(headers || {});
  const dropped = [];
  for (const [k] of [...h]) if (SECRET_HEADER_RE.test(k)) { dropped.push(k); h.delete(k); }
  return { headers: h, dropped };
}

/** 같은 출처인가(scheme+host+port). 다르면 비밀 헤더를 뗀다. */
const sameOrigin = (a, b) => { try { return new URL(a).origin === new URL(b).origin; } catch { return false; } };

/**
 * 이 리다이렉트 한 번을 '같은 상대' 로 믿어도 되는가(v2.583 — 검증 에이전트 권고, 순수).
 * 같은 출처이거나 **같은 호스트 이름의 http → https 업그레이드**면 믿는다. 엣지 앞 리버스 프록시가 흔히
 * `308 http://edge → https://edge` 로 올리는데, 이것을 교차 출처로 보면 ① 토큰 헤더를 떼어 403 이 되고
 * ② v2.583 의 '본문 있는 교차 출처 307/308 거부' 가 멀쩡하던 POST push 를 실패시킨다.
 * 하향(https → http)·호스트 변경은 믿지 않는다.
 */
export function trustedRedirect(cur, next) {
  if (sameOrigin(cur, next)) return true;
  try {
    const a = new URL(cur); const b = new URL(next);
    return a.protocol === 'http:' && b.protocol === 'https:' && a.hostname.toLowerCase() === b.hostname.toLowerCase();
  } catch { return false; }
}

/**
 * 리다이렉트를 **직접** 따라간다 — 출처가 바뀌는 순간 비밀 헤더를 뗀다(SEC-14).
 * 반환은 최종 응답이며, 뺀 헤더가 있으면 `res.__secretsDroppedOnRedirect` 로 밝힌다
 * (조용히 떼면 호출부가 '왜 401 이지' 를 영원히 모른다).
 */
async function fetchFollowing(url, init, disp, timeoutMs) {
  let cur = url;
  let headers = init.headers;
  let dropped = [];
  // v2.583(감사 확정): 호출자가 `redirect:'manual'`·`'error'` 를 줬으면 그 뜻을 따른다(예전엔 덮어써서 무시했다).
  const callerManual = init.redirect === 'manual' || init.redirect === 'error';
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(cur, { ...init, headers, dispatcher: disp, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!loc || callerManual) { if (dropped.length) res.__secretsDroppedOnRedirect = dropped; return res; }
    const next = new URL(loc, cur).href;
    // v2.583(감사 확정 — 반증 에이전트 재현): ① 리다이렉트 대상이 **IP 리터럴**이면 dispatcher 의 DNS lookup
    //   가드를 타지 않는다 — hop 마다 차단 대역을 직접 검사한다(루프백·링크로컬·메타데이터로 끌려가지 않게).
    const blocked = ssrfBlockReason(next);
    if (blocked) {
      try { await res.body?.cancel?.(); } catch { /* */ }
      throw new Error(`리다이렉트 대상이 차단 대역입니다(${blocked}): ${new URL(next).host}`);
    }
    // ② 307/308 은 표준상 **본문을 그대로 다시 보낸다** — 출처가 바뀌면 헤더는 떼도 본문(iDRAC 비밀번호 같은)이
    //   제3 출처로 갔다. 교차 출처 307/308 에 본문이 있으면 따라가지 않고 그 응답을 돌려준다(호출부는 3xx 를 실패로 본다).
    if (!trustedRedirect(cur, next) && (res.status === 307 || res.status === 308) && init.body != null) {
      res.__redirectRefused = `교차 출처 ${res.status} 에 요청 본문을 다시 보내지 않습니다(→ ${new URL(next).host})`;
      if (dropped.length) res.__secretsDroppedOnRedirect = dropped;
      return res;
    }
    if (!trustedRedirect(cur, next)) {
      const r = headersWithoutSecrets(headers);
      if (r.dropped.length) dropped = [...new Set([...dropped, ...r.dropped])];
      headers = r.headers;
    }
    try { await res.body?.cancel?.(); } catch { /* 본문이 없거나 이미 닫힘 */ }
    // 303 과 'POST → 302/301' 은 표준대로 GET 으로 바꾼다.
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && init.method && init.method !== 'GET' && init.method !== 'HEAD')) {
      init = { ...init, method: 'GET', body: undefined };
    }
    cur = next;
  }
  throw new Error(`리다이렉트가 ${MAX_REDIRECTS}회를 넘었습니다: ${url}`);
}

/**
 * v2.587 — 포탈 사이 호출(`/api/collector/*`·`/api/central/*`)은 결과를 `util/outboundStats.js` 에 남긴다
 * (데이터 흐름 지도). 기록은 최종 결과 1회(재시도 중간 결과가 아니다)이고, 기록 실패가 호출을 깨지 않는다.
 */
export async function resilientFetch(url, opts = {}) {
  const t0 = Date.now();
  try {
    const res = await resilientFetchInner(url, opts);
    try { recordOutbound(url, { status: res.status, bytes: Number(res.headers?.get?.('content-length')) || 0, ms: Date.now() - t0, method: opts.method }); } catch { /* 계측은 best-effort */ }
    return res;
  } catch (err) {
    try { recordOutbound(url, { error: String(err?.message || err), ms: Date.now() - t0, method: opts.method }); } catch { /* 계측은 best-effort */ }
    throw err;
  }
}

/**
 * v2.606(TIM2606-01 2차 방어): 요청 시한을 한 번 더 좁힌다 — 숫자가 아닌 값('60000')은 AbortSignal.timeout 이
 * ERR_INVALID_ARG_TYPE 을 던지고, 0 이하는 RangeError, 2^31−1 초과는 약 1ms 에 abort 된다. 호출자 설정값을 전부
 * 쫓지 않아도 되도록 이 관문에서 숫자로 바꾸고 [100ms, 30분] 에 가둔다(숫자가 아니거나 0 이하면 기본 20초).
 */
export function normFetchTimeoutMs(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  if (!Number.isFinite(n) || n <= 0) return 20_000;
  return Math.min(1_800_000, Math.max(100, Math.round(n)));
}

/**
 * v2.617(ARCH-2): 재시도 대기. 429·503 이 `Retry-After`(초)를 주면 그것을 따른다(상한 30초) — 중앙의 큰 본문 해석 상한
 * (util/bigJsonGate.js)은 재시작 폭주 때 503 + Retry-After 로 엣지를 돌려보내는데, 예전에는 헤더를 읽지 않고 400ms·800ms 뒤
 * 재시도해 1.2초 안에 재시도를 다 써 버렸다(게이트가 막으려는 바로 그 구간). 여러 엣지가 같은 순간에 다시 오지 않게
 * 0~50% 흔들림을 더한다. HTTP-날짜 형식은 읽지 않는다(이 저장소의 서버는 초 단위만 보낸다).
 */
export function retryDelayMs(status, retryAfterHeader, baseMs, rand = Math.random) {
  if (status === 429 || status === 503) {
    const sec = Number(String(retryAfterHeader ?? '').trim());
    if (Number.isFinite(sec) && sec > 0) {
      const ms = Math.min(30_000, sec * 1000);
      return Math.round(Math.max(baseMs, ms) * (1 + 0.5 * rand()));
    }
  }
  return baseMs;
}

async function resilientFetchInner(url, { timeoutMs: rawTimeoutMs = 20_000, retries = 2, retryBackoffMs = 400, onRetry, dispatcher, ...init } = {}) {
  const timeoutMs = normFetchTimeoutMs(rawTimeoutMs);
  let lastErr;
  // dispatcher 옵션: 업그레이드 다운로드처럼 'TLS 검증 강제' 디스패처(upgradeAgent)를 넘겨야 하는
  // 경로는 wanAgent(검증 off) 대신 그 디스패처로 재시도한다(보안 보존).
  const disp = dispatcher || wanAgent;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchFollowing(url, init, disp, timeoutMs);
      if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        onRetry?.({ attempt: attempt + 1, status: res.status });
        // 재시도 전 이전 응답 본문을 취소 — undici는 미소진 본문이 연결을 붙잡아, 제한된
        // 커넥션풀(wanAgent connections:6)이 flapping 오리진의 5xx 재시도로 고갈된다.
        try { await res.body?.cancel?.(); } catch { /* */ }
        await sleep(retryDelayMs(res.status, res.headers?.get?.('retry-after'), retryBackoffMs * 2 ** attempt));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries && isTransientErr(err)) {
        onRetry?.({ attempt: attempt + 1, error: err.message });
        await sleep(retryBackoffMs * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * fetch가 아닌 임의 비동기 작업(클라이언트 ping·SSH 등)을 일시 오류에 한해 재시도한다.
 * 연결 테스트 버튼처럼 한 번의 블립으로 '연결 안 됨' 오판되는 것을 막는다.
 * @param {() => Promise<any>} fn
 * @param {object} opts - { retries=1, backoffMs=400 }
 */
export async function retryTransient(fn, { retries = 1, backoffMs = 400 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (attempt < retries && isTransientErr(err)) { await sleep(backoffMs * 2 ** attempt); continue; }
      throw err;
    }
  }
  throw lastErr;
}

// 테스트/진단용 노출.
export const _internals = { isTransientErr, RETRYABLE_STATUS, wanAgent };
