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

import fs from 'node:fs';
import tls from 'node:tls';
import crypto from 'node:crypto';
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
  console.warn('[wan] ⚠ WAN_TLS_INSECURE=true — 중앙↔엣지 HTTPS 인증서 검증이 비활성입니다(자체서명 엣지 호환용). 가능하면 사설 CA를 신뢰시키고(WAN_TLS_CA_FILE) 이 옵션을 끄세요.');
}

/*
 * 2026-10-09 검토 S-09(그룹 J): 사설 CA 신뢰 — `WAN_TLS_CA_FILE`(PEM, 여러 인증서 가능).
 *   중앙 ↔ 엣지를 HTTPS 로 옮기면 대개 사내 CA 가 발급한 인증서를 쓴다. 예전에는 그 CA 를 믿게 할 방법이
 *   `WAN_TLS_INSECURE=true`(검증 통째 해제)뿐이라, HTTPS 로 옮겨도 중간자를 막지 못했다. 이 파일의 CA 를
 *   **기본 신뢰 목록에 더한다**(대체가 아니다 — GitHub 등 공인 인증서도 계속 검증된다).
 *   ⚠ 파일을 못 읽으면 기본 신뢰만 쓴다 — 사설 CA 서버와의 연결은 인증서 오류로 **실패한다(fail-closed)**.
 *     검증을 끄는 쪽으로 떨어지지 않는다. 그 사실을 기동 경고와 `wanTlsStatus()` 가 말한다.
 *   ⚠ `ca` 옵션을 주면 Node 는 기본 목록을 **대체**하므로 기본 목록(NODE_EXTRA_CA_CERTS 포함)을 앞에 붙인다.
 */
const CA_FILE_MAX_BYTES = 1048576;
const CA_CERTS_MAX = 200;
/** PEM 텍스트에서 인증서 블록만 뽑는다(선형 — 정규식 지연 반복 금지). */
function pemBlocks(text) {
  const out = [];
  const B = '-----BEGIN CERTIFICATE-----'; const E = '-----END CERTIFICATE-----';
  let i = 0;
  while (out.length < CA_CERTS_MAX) {
    const a = text.indexOf(B, i);
    if (a < 0) break;
    const b = text.indexOf(E, a + B.length);
    if (b < 0) break;
    out.push(text.slice(a, b + E.length));
    i = b + E.length;
  }
  return out;
}
/**
 * env → 추가 CA(순수에 가깝다 — 파일만 읽는다).
 * @returns {{file:string, ca:string[]|null, count:number, subjects:string[], error:string|null}}
 */
export function loadWanCa(env = process.env) {
  const file = String((env && env.WAN_TLS_CA_FILE) ?? '').trim();
  if (!file) return { file: '', ca: null, count: 0, subjects: [], error: null };
  try {
    const st = fs.statSync(file);
    if (st.size > CA_FILE_MAX_BYTES) throw new Error(`파일이 너무 큽니다(${st.size}바이트 — ${CA_FILE_MAX_BYTES} 이하)`);
    const blocks = pemBlocks(fs.readFileSync(file, 'utf8'));
    const subjects = [];
    for (const pem of blocks) {
      const x = new crypto.X509Certificate(pem);
      subjects.push(String(x.subject || '').replace(/\n/g, ', ').slice(0, 200));
    }
    if (!blocks.length) throw new Error('PEM 인증서(BEGIN CERTIFICATE)가 없습니다');
    const base = typeof tls.getCACertificates === 'function' ? tls.getCACertificates('default') : tls.rootCertificates;
    return { file, ca: [...base, ...blocks], count: blocks.length, subjects, error: null };
  } catch (e) {
    const why = e?.code === 'ENOENT' ? '파일이 없습니다' : e?.code === 'EACCES' ? '읽기 권한이 없습니다' : String(e?.message || e);
    return { file, ca: null, count: 0, subjects: [], error: `WAN_TLS_CA_FILE(${file}) 을(를) 쓰지 못했습니다 — ${why}` };
  }
}
const WAN_CA = loadWanCa();
if (WAN_CA.error) console.warn(`[wan] ⚠ ${WAN_CA.error} — 기본 신뢰 목록만 씁니다(사설 CA 로 발급된 중앙·엣지 인증서는 검증에 실패합니다).`);
else if (WAN_CA.count) console.log(`[wan] 사설 CA ${WAN_CA.count}개를 중앙↔엣지 TLS 신뢰 목록에 더했습니다(${WAN_CA.file}).`);
/*
 * v2.731(G2b A4-01): `ca` 배열이 아니라 **미리 만든 SecureContext 하나**를 넘긴다. `ca` 옵션을 주면 tls.connect 가 연결마다
 *   기본 목록(약 150~300개) + 사설 CA 를 다시 파싱해 새 컨텍스트를 만든다 — 실측 연결당 약 23ms **동기**(이벤트 루프 정지),
 *   미리 만든 컨텍스트는 0.3ms. 이제 이 신뢰를 통신 점검(요청마다 새 Agent)·업그레이드 다운로드도 쓰므로 그 비용이 곱해진다.
 *   의미는 같다(같은 CA 목록). 만들지 못하면(이론상 — 인증서는 위에서 하나씩 읽었다) 사설 CA 없이 기본 신뢰만 쓴다(fail-closed).
 */
let WAN_CA_CTX_ERROR = null;
let WAN_SECURE_CTX = null;
if (WAN_CA.ca) {
  try { WAN_SECURE_CTX = tls.createSecureContext({ ca: WAN_CA.ca }); } catch (e) {
    WAN_CA_CTX_ERROR = `WAN_TLS_CA_FILE(${WAN_CA.file}) 로 TLS 신뢰 목록을 만들지 못했습니다 — ${String(e?.message || e).slice(0, 200)}`;
    console.warn(`[wan] ⚠ ${WAN_CA_CTX_ERROR} — 기본 신뢰 목록만 씁니다.`);
  }
}
const WAN_CA_OPT = WAN_SECURE_CTX ? { secureContext: WAN_SECURE_CTX } : {};
/**
 * 중앙↔엣지 TLS 연결 옵션 — **사설 CA 신뢰의 단일 출처**(v2.731 G2b A4-01).
 *
 * v2.730 S-09 는 `WAN_TLS_CA_FILE` 을 이 파일의 두 디스패처에만 붙였다. 그런데 중앙↔엣지 구간에서 **자체 Agent 를
 * 만드는 경로**가 둘 더 있었다 — 통신 점검 `linkcheck/checks.js stepHttp`(수집 토큰·중앙 토큰을 싣는 링크)와
 * 업그레이드 `upgrade/upgradeAgent.js`(엣지 번들 push · 엣지가 중앙 /dl 을 받는 다운로드). 둘 다 기본 신뢰 목록만 써서
 * 사설 CA 로 발급한 정상 엣지·중앙을 'TLS 실패' 로 거부했고, 운영자에게 남은 길은 검증 해제(WAN_TLS_INSECURE·
 * UPGRADE_TLS_INSECURE)뿐이었다 — S-09 가 막으려던 바로 그 상태.
 *
 * 새 중앙↔엣지 클라이언트가 자체 Agent 를 만들면 connect 에 이 값을 펼친다(사본을 만들지 말 것 — 파일을 두 번 읽으면
 * 상태 보고와 실제 신뢰가 갈라진다). ⚠ 장비 TLS(vCenter·iDRAC…)는 `security/tlsTrust.js` 다 — 섞지 말 것.
 * 신뢰 목록은 기본 목록을 **앞에 붙인** 것이라(loadWanCa) GitHub 등 공인 인증서 검증은 그대로다. 사설 CA 가 있으면
 * `secureContext`(미리 만든 하나 — 위 주석), 없으면 아무것도 싣지 않는다(Node 기본 신뢰).
 * @param {{verify?: boolean}} [o]  검증 여부 — 기본은 WAN_TLS_VERIFY. 호출자가 자기 정책을 갖고 있으면 그 값을 준다
 *                                  (upgradeAgent 의 UPGRADE_TLS_INSECURE).
 * @returns {{rejectUnauthorized: boolean, secureContext?: import('node:tls').SecureContext}}
 */
export function wanTlsConnectOptions({ verify = WAN_TLS_VERIFY } = {}) {
  return { rejectUnauthorized: verify !== false, ...WAN_CA_OPT };
}
/** 중앙↔엣지 TLS 신뢰 상태(진단·자체점검용 — CA 원문은 싣지 않는다). */
export function wanTlsStatus() {
  return { verify: WAN_TLS_VERIFY, caFile: WAN_CA.file, caCount: WAN_CA_CTX_ERROR ? 0 : WAN_CA.count, caSubjects: WAN_CA.subjects.slice(0, 10), caError: WAN_CA.error || WAN_CA_CTX_ERROR };
}
// v2.506(감사 S1 #2): 기본 디스패처에 DNS 리바인딩 차단 lookup 을 단다. 이 에이전트를 쓰는
// 전 호출부(수집 서버 연결 테스트·동기화 등 dispatcher 미지정 경로 전부)가 한 번에 보호된다.
// `ipBlockReason` 은 공인 IP 와 RFC1918 을 허용하고 루프백/링크로컬/메타데이터/우회표기만
// 막으므로, GitHub 업그레이드 다운로드·중앙↔엣지 같은 정상 흐름에는 영향이 없다
// (루프백을 치는 resilientFetch 호출부가 없음을 grep 으로 확인했다).
const wanAgent = new Agent({
  connect: { ...wanTlsConnectOptions(), lookup: ssrfLookup },
  connectTimeout: Number(process.env.WAN_CONNECT_TIMEOUT_MS) || 20_000,
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 30_000,
  connections: Number(process.env.WAN_MAX_CONNECTIONS) || 6,
});

/*
 * v2.632(AX1-2632-03): 긴 시한 호출용 디스패처. undici Agent 의 기본 headersTimeout·bodyTimeout 은 **300초**라, 호출자가
 *   timeoutMs 를 그보다 길게 줘도(예: bmstor 중앙→엣지 수집 위임 — 서버 13대 이상이면 60초 + 20초×n 이 300초를 넘는다) 엣지가
 *   수집을 끝내고 헤더를 보내기 전에 'Headers Timeout Error' 로 끊겼다(v2.631 EDGE2631-02 의 비례 시한이 무효였다).
 *   이 디스패처는 두 시한을 normFetchTimeoutMs 상한(30분) + 여유로 두어 **호출자의 AbortSignal.timeout 이 시한을 정하게** 한다.
 *   TLS 검증·SSRF lookup·연결 상한은 wanAgent 와 같다. 선택은 dispatcherFor() 하나가 한다.
 */
export const UNDICI_DEFAULT_IO_TIMEOUT_MS = 300_000;
const LONG_IO_TIMEOUT_MS = 1_800_000 + 60_000;
const wanLongAgent = new Agent({
  connect: { ...wanTlsConnectOptions(), lookup: ssrfLookup },
  connectTimeout: Number(process.env.WAN_CONNECT_TIMEOUT_MS) || 20_000,
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 30_000,
  connections: Number(process.env.WAN_MAX_CONNECTIONS) || 6,
  headersTimeout: LONG_IO_TIMEOUT_MS,
  bodyTimeout: LONG_IO_TIMEOUT_MS,
});
/**
 * 호출자가 준 디스패처가 있으면 그것(보안 정책 — upgradeAgent 등), 없으면 시한이 undici 기본 입출력 시한(300초) 이하일 때
 * wanAgent, 넘으면 wanLongAgent. ⚠ 호출자 디스패처를 긴 시한으로 바꿔 주지 않는다 — 그 디스패처의 시한은 호출자 책임이다.
 */
export function dispatcherFor(dispatcher, timeoutMs) {
  if (dispatcher) return dispatcher;
  return Number(timeoutMs) > UNDICI_DEFAULT_IO_TIMEOUT_MS ? wanLongAgent : wanAgent;
}

const TRANSIENT_RE = /timed?\s?out|timeout|abort|reset|hang ?up|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|ETIMEDOUT|other side closed|socket|UND_ERR/i;
function isTransientErr(err) {
  const parts = [err?.code, err?.message, err?.name, err?.cause?.code, err?.cause?.message].filter(Boolean).join(' ');
  return TRANSIENT_RE.test(parts);
}
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * v2.620(RECENT2620-05): 재시도 대기는 호출자 signal 을 본다. v2.617 ARCH-2 로 Retry-After 대기가 최대 45초/회가 되면서
 *   호출자가 끊어도(abort) 대기·재시도가 계속 나갔다(재현 ra.mjs: abort 500ms 인데 80초 뒤 · 서버 3회). abort 면 즉시 그 사유로 던진다.
 */
function abortError(signal) {
  const r = signal?.reason;
  if (r instanceof Error) return r;
  return Object.assign(new Error('호출자가 요청을 취소했습니다'), { name: 'AbortError', code: 'ABORT_ERR' });
}
export function abortableSleep(ms, signal) {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(tm); reject(abortError(signal)); };
    const tm = setTimeout(() => { signal.removeEventListener?.('abort', onAbort); resolve(); }, ms);
    signal.addEventListener?.('abort', onAbort, { once: true });
  });
}

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

/** https → http 하향인가(순수). */
export function isDowngrade(cur, next) {
  try { return new URL(cur).protocol === 'https:' && new URL(next).protocol === 'http:'; } catch { return false; }
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
    // v2.620(RECENT2620-05): 호출자 signal 을 건별 시한으로 덮지 않고 합친다(예전엔 호출자 abort 가 진행 중 요청을 끊지 못했다).
    const sig = init.signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), init.signal]) : AbortSignal.timeout(timeoutMs);
    const res = await fetch(cur, { ...init, headers, dispatcher: disp, redirect: 'manual', signal: sig });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!loc || callerManual) { if (dropped.length) res.__secretsDroppedOnRedirect = dropped; return res; }
    const next = new URL(loc, cur).href;
    // S-09(그룹 J): HTTPS 로 시작한 요청은 평문으로 내려가지 않는다 — https → http 리다이렉트는 따라가지 않고 그 응답을
    //   돌려준다(호출부는 3xx 를 실패로 본다). 비밀 헤더는 출처가 바뀌어 어차피 떼지만, 응답 본문·요청 본문(303 전환 전)과
    //   그 뒤 요청이 평문 구간으로 나가는 것 자체가 하향이다. 같은 호스트의 http → https 상향은 예전대로 믿는다.
    if (isDowngrade(cur, next)) {
      res.__redirectRefused = `HTTPS 에서 평문 HTTP 로 내려가는 리다이렉트는 따라가지 않습니다(→ ${new URL(next).host})`;
      if (dropped.length) res.__secretsDroppedOnRedirect = dropped;
      try { await res.body?.cancel?.(); } catch { /* */ }
      return res;
    }
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
  const disp = dispatcherFor(dispatcher, timeoutMs);   // v2.632(AX1-2632-03)
  const callerSignal = init.signal || null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (callerSignal?.aborted) throw abortError(callerSignal); // v2.620(RECENT2620-05)
    try {
      const res = await fetchFollowing(url, init, disp, timeoutMs);
      if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        onRetry?.({ attempt: attempt + 1, status: res.status });
        // 재시도 전 이전 응답 본문을 취소 — undici는 미소진 본문이 연결을 붙잡아, 제한된
        // 커넥션풀(wanAgent connections:6)이 flapping 오리진의 5xx 재시도로 고갈된다.
        try { await res.body?.cancel?.(); } catch { /* */ }
        // v2.620(RECENT2620-05): 호출자가 끊으면 대기 중에도 즉시 끝낸다(abort 오류는 아래 catch 에서 재시도하지 않는다).
        await abortableSleep(retryDelayMs(res.status, res.headers?.get?.('retry-after'), retryBackoffMs * 2 ** attempt), callerSignal);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      // v2.620(RECENT2620-05): 호출자 취소는 일시 오류가 아니다 — 'abort' 문구가 TRANSIENT_RE 에 걸려 재시도되던 것을 막는다.
      if (callerSignal?.aborted) throw err;
      if (attempt < retries && isTransientErr(err)) {
        onRetry?.({ attempt: attempt + 1, error: err.message });
        await abortableSleep(retryBackoffMs * 2 ** attempt, callerSignal);
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
export const _internals = { isTransientErr, RETRYABLE_STATUS, wanAgent, wanLongAgent, pemBlocks };
