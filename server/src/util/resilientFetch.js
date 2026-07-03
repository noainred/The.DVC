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

import { Agent } from 'undici';

// 수집서버/중앙도 자체서명 인증서일 수 있어 전역(vCenter)과 동일하게 검증 off. 단 커넥션 풀은 분리.
// connections: origin(중앙/엣지)당 동시 연결 상한. undici 기본은 무제한이라 여러 워커가 동시에
// 요청을 쏘면 연결이 수십 개까지 쌓이고 keep-alive로 한동안 남는다(소켓 폭증). 상한을 둬서 재사용·
// 큐잉으로 연결 수를 묶는다. WAN_MAX_CONNECTIONS로 조정(기본 6).
const wanAgent = new Agent({
  connect: { rejectUnauthorized: process.env.WAN_TLS_INSECURE === 'false' ? true : false },
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
export async function resilientFetch(url, { timeoutMs = 20_000, retries = 2, retryBackoffMs = 400, onRetry, dispatcher, ...init } = {}) {
  let lastErr;
  // dispatcher 옵션: 업그레이드 다운로드처럼 'TLS 검증 강제' 디스패처(upgradeAgent)를 넘겨야 하는
  // 경로는 wanAgent(검증 off) 대신 그 디스패처로 재시도한다(보안 보존).
  const disp = dispatcher || wanAgent;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...init, dispatcher: disp, signal: AbortSignal.timeout(timeoutMs) });
      if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        onRetry?.({ attempt: attempt + 1, status: res.status });
        // 재시도 전 이전 응답 본문을 취소 — undici는 미소진 본문이 연결을 붙잡아, 제한된
        // 커넥션풀(wanAgent connections:6)이 flapping 오리진의 5xx 재시도로 고갈된다.
        try { await res.body?.cancel?.(); } catch { /* */ }
        await sleep(retryBackoffMs * 2 ** attempt);
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
