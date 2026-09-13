/**
 * util/ssrfLookup.js — **DNS 리바인딩(TOCTOU) 차단용 공용 lookup 훅**(v2.506).
 *
 * ## 무엇이 문제였나
 *
 * 여러 호출부가 `ssrfBlockReasonResolved(url)` 로 이름을 해석해 IP 를 검사한 **뒤에 다시
 * 호스트명으로 접속**했다. 검사와 접속 사이에 DNS 응답이 바뀌면(공격자가 TTL 0 으로
 * 사내 IP → 169.254.169.254/127.0.0.1 로 리바인딩) 가드를 통과하고 내부에 접속한다.
 * 검사 자체는 맞지만 **검사한 값으로 접속하지 않는다**는 것이 결함이다(classic TOCTOU).
 *
 * `server/CLAUDE.md` 는 올바른 조치를 이렇게 적어 뒀다:
 *   "dns.lookup(타임아웃)+ipBlockReason 후 그 IP 로 직접 접속(uagmon 핀 패턴)"
 * 그 참조 구현은 **`uagmon/lib/uag.js:30-55`** 에 있다(`server/src` 밖의 독립 도구라 눈에 잘 안 띈다):
 *   `dns.promises.lookup` → `hostBlockReason(resolved.address)` → `https.request({ host: 해석IP,
 *   servername: 원호스트, headers:{ Host: 원호스트 } })`. 이 파일은 그 패턴을 **server/src 전역에
 *   쓸 수 있게** 일반화한 것이다.
 * `server/src` 안에는 이 패턴이 없었다 — `svcmon/checker.js:70` 은 "별도 작업으로 뺀다" 는 TODO
 * 주석으로만 갖고 있었고, 감사가 지적한 7개 접속부 전부가 미적용이었다.
 *
 * ## 왜 uagmon 처럼 'IP 로 바꿔치기' 하지 않고 `lookup` 훅을 쓰는가
 *
 * uagmon 방식(host=해석IP + servername/Host=원호스트)은 **한 곳**을 고칠 때는 정확하다. 하지만
 * 여기서 고칠 곳은 7개이고 접속 수단이 제각각이다(`net.connect`·`tls.connect`·`https.request`·
 * `http.request`·undici `fetch`). 수단마다 SNI·Host 를 손으로 다시 붙여야 하고, **한 곳만
 * 빠뜨리면 그 경로의 인증서 검증이 조용히 약해진다**. `lookup` 훅은 다섯 수단이 모두 받는
 * 공통 옵션이라 같은 한 줄로 끝나고, 원 호스트명을 그대로 두므로 SNI·Host·인증서 검증을
 * 애초에 건드리지 않는다.
 *
 * ## `lookup` 훅의 이점
 *
 * URL 의 호스트를 해석된 IP 로 바꿔 접속하면 **TLS SNI·인증서 검증·Host 헤더가 전부 깨진다**
 * (가상호스팅 대상은 404, 인증서는 이름 불일치). 그래서 각 접속부에 `servername`·`Host` 를
 * 손으로 다시 붙여야 하고, 한 곳만 빠뜨리면 조용히 검증이 약해진다.
 *
 * Node 의 `net.connect`/`tls.connect`/`https.request` 와 undici `Agent` 는 모두 **`lookup`
 * 옵션**을 받는다. 검증을 lookup 안에서 하면:
 *   · **TOCTOU 창이 0 이다** — 소켓이 실제로 쓸 바로 그 주소를 검사한다(검사 후 재해석 없음).
 *   · SNI·Host·인증서 검증은 원래 호스트명을 그대로 쓴다(접속 주소만 검증된 IP).
 *   · DNS 조회가 '가드용 1회 + 접속용 1회' 에서 **1회**로 줄어든다. `server/CLAUDE.md` 의
 *     "타임아웃 없는 DNS 조회를 핫패스에 넣지 말 것"(폴러 지연) 규칙과 충돌하지 않고
 *     오히려 조회 수를 줄인다.
 *   · 리다이렉트를 따라가는 클라이언트도 **매 홉마다** 이 lookup 을 타므로 자동으로 보호된다.
 *
 * ## 한계(정직하게)
 *  · **IP 리터럴 URL 은 이 훅을 타지 않는다** — lookup 은 이름일 때만 불린다. 그래서 저장·요청
 *    시점의 `ssrfBlockReason(url)`(동기, IP 리터럴 검사)을 **없애면 안 된다**. 이 훅은 그것을
 *    대체하는 것이 아니라 '이름이 IP 로 바뀌는 순간' 을 덮는 보완이다.
 *  · 프록시(HAProxy 등)를 경유하는 접속은 프록시 호스트만 검사된다 — 프록시 뒤 대상은
 *    프록시가 결정하므로 이 훅의 범위 밖이다(중계 경유 경로는 별도 신뢰 모델).
 *  · OS 리졸버(`dns.lookup`)를 쓴다 — `/etc/hosts` 와 검색 도메인을 존중한다. 사내 FQDN 이
 *    hosts 파일로 잡혀 있는 환경이 있어 `dns.Resolver`(순수 DNS)로 바꾸지 않았다.
 */

import dns from 'node:dns';
import { ipBlockReason } from '../collector/registry.js';

/** `dns.lookup` 이 `{all:true}` 로 불렸는지에 따라 콜백 인자 모양이 다르다 — 둘 다 다룬다. */
const isAllForm = (opts) => !!(opts && typeof opts === 'object' && opts.all);

/**
 * 주소 목록에서 차단 사유를 찾는다(순수). 하나라도 차단 대역이면 **전체를 거부**한다.
 *
 * 왜 '하나라도' 인가: 공격자는 A 레코드에 정상 IP 와 사내 IP 를 함께 실어, 클라이언트가
 * 어느 것을 고르든 한 번은 사내로 가게 만들 수 있다(멀티-A 리바인딩). 통과한 주소만 쓰도록
 * 걸러내는 것보다 거부가 안전하고, 정상 대상이 사내 대역을 섞어 광고하는 경우는 없다.
 *
 * @param {Array<{address:string, family?:number}>|string} addrs
 * @returns {string|null} 차단 사유 또는 null(허용)
 */
export function addressBlockReason(addrs) {
  const list = Array.isArray(addrs) ? addrs : [{ address: addrs }];
  for (const a of list) {
    const ip = typeof a === 'string' ? a : a?.address;
    if (!ip) continue;
    const r = ipBlockReason(ip);
    if (r) return r;
  }
  return null;
}

/** 차단 시 콜백에 넘길 오류 — 호출부가 사유를 사용자에게 그대로 보여줄 수 있게 코드를 붙인다. */
export function ssrfLookupError(hostname, reason) {
  const e = new Error(`차단된 대상입니다 — ${hostname} 의 DNS 해석 결과가 허용 대역이 아닙니다: ${reason}`);
  e.code = 'ESSRFBLOCKED';
  e.hostname = hostname;
  e.reason = reason;
  return e;
}

/**
 * 검증 lookup 을 만든다. `net.connect`/`tls.connect`/`https.request` 의 `lookup` 옵션과
 * undici `new Agent({ connect: { lookup } })` 에 그대로 넘길 수 있다.
 *
 * @param {object}   [o]
 * @param {number}   [o.timeoutMs=3000]  이 시간 안에 해석되지 않으면 오류로 끊는다. `dns.lookup` 에는
 *   타임아웃 옵션이 없어 타이머로 포기한다 — 해석 자체는 백그라운드에서 끝날 수 있지만 **호출부가
 *   기다리지 않는다**(폴러가 DNS 지연에 묶이는 것을 막는 것이 목적이다).
 * @param {Function} [o.lookupImpl=dns.lookup]  테스트 주입용.
 * @param {Function} [o.onBlock]  차단 시 호출(감사 로그용). 던지지 말 것.
 */
export function makeSsrfLookup({ timeoutMs = 3000, lookupImpl = dns.lookup, onBlock = null } = {}) {
  const limit = Math.max(250, Math.min(30_000, Number(timeoutMs) || 3000));
  return function ssrfLookup(hostname, options, callback) {
    // Node 는 `lookup(hostname, callback)` 형태로도 부를 수 있다.
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : (options || {});
    let done = false;
    const finish = (err, ...rest) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      cb(err, ...rest);
    };
    // ⚠ 이 타이머를 `unref()` 하지 않는다: unref 하면 이벤트 루프에 다른 활성 핸들이 없을 때
    // 타이머가 울리지 않아 **콜백이 영원히 안 불린다**(= 연결이 무한 대기). 실측으로 확인했다.
    // 최대 limit(기본 3초)만큼 프로세스 종료가 늦어질 수 있지만, 연결이 매달리는 것보다 낫다.
    const timer = setTimeout(() => {
      const e = new Error(`DNS 해석 시간 초과(${limit}ms): ${hostname}`);
      e.code = 'ETIMEDOUT';
      finish(e);
    }, limit);

    try {
      lookupImpl(hostname, opts, (err, address, family) => {
        if (err) return finish(err);
        const addrs = isAllForm(opts) ? address : [{ address, family }];
        const reason = addressBlockReason(addrs);
        if (reason) {
          try { if (onBlock) onBlock({ hostname, addrs, reason }); } catch { /* 로깅 실패가 차단을 막지 않게 */ }
          return finish(ssrfLookupError(hostname, reason));
        }
        return isAllForm(opts) ? finish(null, address) : finish(null, address, family);
      });
    } catch (e) { finish(e); }
  };
}

/**
 * 기본 인스턴스 — 대부분의 호출부는 이것을 쓰면 된다.
 * 차단은 드물고 원인 추적이 중요하므로 서버 로그에 1줄 남긴다(비밀 없음 — 호스트명·IP 만).
 */
export const ssrfLookup = makeSsrfLookup({
  onBlock: ({ hostname, reason }) => console.warn(`[ssrf] DNS 리바인딩 차단: ${hostname} — ${reason}`),
});

/**
 * undici `Agent` 의 `connect` 옵션에 합쳐 쓰는 헬퍼.
 * 기존 옵션(`rejectUnauthorized` 등)을 **덮지 않고** lookup 만 더한다 —
 * 자체서명 허용 같은 기존 동작을 실수로 되돌리지 않기 위해서다.
 */
export const withSsrfLookup = (connectOpts = {}) => ({ ...connectOpts, lookup: ssrfLookup });
