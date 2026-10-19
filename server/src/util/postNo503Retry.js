/**
 * util/postNo503Retry.js — 엣지가 중앙으로 **큰 본문**을 올릴 때 503 은 호출 안에서 다시 보내지 않는 전송 헬퍼.
 *
 * v2.744(감사 LEFT-09): 본체가 `agent/edgeLogWorker.js`(엣지 로그 폴백 워커)에 있어서 cvp/push.js·sanswitch/perfPush.js·
 *   isidu/push.js 가 그 워커 모듈(config·adaptiveTimer·central404·agentNameHeader·centralReply 와 워커 상태)을 함께 끌어왔다.
 *   이 함수가 쓰는 것은 resilientFetch·retryDelayMs·abortableSleep 뿐이라 util/ 로 옮겼다 — **동작은 한 글자도 바꾸지 않았다**.
 *   `agent/edgeLogWorker.js` 는 import + export 로 재수출한다(v2.575 규약 — 재수출 한 줄 형태는 그 모듈 스코프에 이름을 만들지 않는다).
 *   ⚠ util/ 규약(arch2579 ②): 이 파일은 util/·node 내장만 import 한다.
 *
 * v2.742(감사 EDGE-03): 503 은 호출 안에서 다시 보내지 않는다(다음 주기에 맡긴다).
 *   중앙의 503 은 지속형(등록부·설정 파일 손상 · 중앙 DB 불가 — Retry-After 60초)이거나 큰 본문 해석 혼잡(bigJsonGate — 일시)이다.
 *   어느 쪽이든 같은 본문을 400·800ms(또는 Retry-After) 뒤 곧바로 다시 올리면 회선과 중앙 해석 부담만 늘고, 지속형이면 결과도 같다
 *   (예전에는 resilientFetch retries:2 로 한 호출에 3번 올렸다 — 재현). 이 함수를 쓰는 경로는 다음 주기에 다시 보낸다:
 *   isidu push(커서를 전진하지 않는다) · edge-log-result(회신이 없으면 중앙이 인출분을 대기로 되돌려 다음 폴에서 다시 가져간다) ·
 *   cvp-data·sanswitch-perf push(v2.743 LEFT-03).
 *   그 밖의 일시 상태(408·425·429·500·502·504)와 연결 오류는 **예전처럼** 호출 안에서 재시도한다 — resilientFetch 와 같은 대상·간격·
 *   Retry-After 규칙(retryDelayMs)이고 시도마다 resilientFetch(retries:0)를 그대로 쓴다(리다이렉트·TLS·SSRF 규칙을 복제하지 않는다).
 *
 * v2.744(감사 후속 FB-1): **GET 도 이 함수 하나**다 — 메서드·본문은 init 이 정한다(없으면 resilientFetch 의 기본 GET).
 *   중앙 puller 의 엣지 export 받기(collector/puller.js)가 같은 규칙의 GET 판 사본(fetchExportNo503Retry)을 두고 있었다 — 차이는
 *   재시도 로그(onRetry) 하나였다(로그 분석 규칙 collector-pull-retry 가 '[collector] X 재시도 N' 줄을 읽는다). 셋째 인자 onRetry 를
 *   받게 하고 그 사본을 지웠다. onRetry 를 주지 않는 호출부(cvp·sanswitch perf·isidu push · 엣지 로그 회신)는 예전과 같다.
 *   onRetry 는 다시 보내기 **직전에만** 부른다({attempt, status} 또는 {attempt, error}) — 503 과 마지막 시도에는 부르지 않는다.
 *   GET 으로 쓰는 쪽은 이름이 읽히게 같은 함수를 fetchNo503Retry 로도 내보낸다(두 이름 = 한 함수 — 규칙이 두 벌이 되지 않게).
 */
import { resilientFetch, retryDelayMs, abortableSleep, _internals as rfInternals } from './resilientFetch.js';

/**
 * @returns {Promise<Response>} 마지막 응답(503 이면 첫 503 응답) — 연결이 끝까지 실패하면 마지막 오류를 던진다.
 */
export async function postNo503Retry(url, init = {}, { retries = 2, backoffMs = 400, onRetry = null } = {}) {
  const note = (info) => { if (typeof onRetry !== 'function') return; try { onRetry(info); } catch { /* 로그 콜백 오류가 재시도를 막지 않는다 */ } };
  const { retries: _r, ...rest } = init;
  for (let attempt = 0; ; attempt++) {
    let res;
    try { res = await resilientFetch(url, { ...rest, retries: 0 }); }
    catch (e) {
      if (rest.signal?.aborted || attempt >= retries || !rfInternals.isTransientErr(e)) throw e;
      note({ attempt: attempt + 1, error: e.message });
      await abortableSleep(backoffMs * 2 ** attempt, rest.signal);
      continue;
    }
    if (res.status === 503 || !rfInternals.RETRYABLE_STATUS.has(res.status) || attempt >= retries) return res;
    note({ attempt: attempt + 1, status: res.status });
    try { await res.body?.cancel?.(); } catch { /* 미소진 본문 정리 */ }
    await abortableSleep(retryDelayMs(res.status, res.headers?.get?.('retry-after'), backoffMs * 2 ** attempt), rest.signal);
  }
}

/** GET 으로 쓰는 쪽의 이름(같은 함수 — v2.744 감사 후속 FB-1). */
export const fetchNo503Retry = postNo503Retry;
