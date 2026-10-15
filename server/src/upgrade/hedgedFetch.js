/**
 * upgrade/hedgedFetch.js — 업그레이드 메타데이터(versions.json · 서명 manifest) 받기: 앞 시도가 늦으면 **끊지 않고**
 * 다음 시도를 함께 보낸다(v2.740.1).
 *
 * ## 왜
 * 사용자 신고(v2.740 · 사내 저장소): '새 버전 확인' 을 누르면 화면이 20초 가까이 '확인 중' 에 멈췄다(캡처: `upgrade › check · 19초`,
 * 서버가 처리 중). 원인(재현): v2.736.3 이 전체 시한 60초 안에서 **시도마다 20초**를 기다리게 했다. 첫 응답이 늦는 저장소
 * (원본을 받아 오는 사내 미러, 첫 연결만 늦는 회선)에서는 첫 시도가 20초를 다 채운 뒤에야 재시도가 나가고, 재시도는 곧바로 답한다
 * — 첫 응답 25초 가짜 저장소에서 확인이 20.5초 걸렸다. v2.729 까지는 시도당 10초라 약 10초였다(그래서 '예전에는 안 그랬다').
 * 시도 시한을 다시 줄이면 '모든 요청이 12초 걸리는 저장소' 가 v2.730~v2.736.2 처럼 실패한다 — 그래서 시한을 줄이지 않고
 * **기다리는 동안 다음 시도를 함께 보낸다**.
 *
 * ## 규칙
 *  · 첫 시도를 보내고 `hedgeMs`(기본 3초 · env `UPGRADE_CHECK_HEDGE_MS`) 안에 응답(헤더)이 없으면 다음 시도를 **같이** 보낸다.
 *    최대 `maxAttempts`(3)번. 앞 시도는 끊지 않는다 — 모든 요청이 느린 저장소라면 그 앞 시도가 가장 먼저 끝난다.
 *  · 먼저 온 응답(재시도 대상 상태가 아닌 것)을 쓰고 나머지 시도는 끊는다.
 *  · 시도가 일시 오류(연결 거부·시한·재설정)나 재시도 대상 상태(408·425·429·5xx)로 끝나면 다음 시도를 짧은 대기(400ms·800ms) 뒤 곧바로 보낸다.
 *    일시 오류가 아닌 실패(차단 대역·인증서 거부·리다이렉트 거부)는 다시 보내지 않고 그대로 던진다.
 *  · v2.741(감사 RECENT-04): 429·503 이 `Retry-After`(초)를 주면 예전 재시도(resilientFetch — v2.617 ARCH-2)와 같은 규칙으로 그만큼 기다린다
 *    (`retryDelayMs` — 상한 30초 · 0~50% 흔들림). 그 응답을 받은 뒤에는 함께 보내기를 멈추고 순서대로(시도마다 `attemptMs` 시한) 보낸다 —
 *    과부하라고 말한 저장소에 같은 요청을 겹쳐 보내지 않게. 기다릴 시간이 전체 시한의 남은 시간보다 길면 기다리지 않고 그 응답으로
 *    결론을 낸다(호출부가 'HTTP 503' 이라고 말한다 — 시한 초과로 바꾸지 않는다).
 *  · 모든 시도가 끝났는데 쓸 응답이 없으면 마지막 재시도 대상 응답(호출부가 'HTTP 503' 처럼 상태로 말하게)을, 그것도 없으면 마지막 오류를 돌려준다.
 *  · 전체 시한(`signal`)이 끝나면 모든 시도를 끊는다 — 호출부가 `deadlineSignal` 로 시한 사유를 만든다(versionsDoc.js metaTimeoutReason).
 *  · `hedgeMs = 0` 이면 예전처럼 순서대로 보낸다(시도마다 `attemptMs` 시한) — 동시 요청을 싫어하는 저장소를 위한 탈출구.
 *
 * ## 무엇에만 쓰나
 * 작은 메타데이터(versions.json · manifest — 수 KB)에만 쓴다. **번들·설치 패키지(수백 MB) 다운로드에는 쓰지 말 것** — 같은 큰 파일을
 * 두세 번 받게 된다. 같은 요청을 최대 3번 보내는 것은 예전 재시도(최대 3번)와 같은 상한이다.
 */
import { resilientFetch, retryDelayMs, _internals as rfInternals } from '../util/resilientFetch.js';
import { numOrNull } from '../util/numOrNull.js';

/** 다음 시도를 함께 보내기까지 기다리는 시간 — 빈 값·비숫자 = 기본 3초, 0 이하 = 끔(순서대로), [1초, 30초]. */
export function hedgeMsOf(v = process.env.UPGRADE_CHECK_HEDGE_MS) {
  const n = numOrNull(v);
  if (n == null) return 3000;
  if (n <= 0) return 0;
  return Math.min(30_000, Math.max(1000, Math.floor(n)));
}
export const META_HEDGE_MS = hedgeMsOf(numOrNull(process.env.UPGRADE_CHECK_HEDGE_MS) ?? 3000);   // 같은 판정 — 기본값을 문서 생성기가 읽게 한 줄로

const RETRYABLE = rfInternals.RETRYABLE_STATUS;
const isTransient = (err) => rfInternals.isTransientErr(err);
const cancelBody = (res) => { try { res?.body?.cancel?.()?.catch?.(() => {}); } catch { /* 본문이 없거나 이미 닫힘 */ } };
const abortErr = (signal) => {
  const r = signal?.reason;
  if (r instanceof Error) return r;
  const e = new Error('aborted'); e.name = 'AbortError'; return e;
};

/**
 * @param {string} url
 * @param {object} o
 *   - dispatcher, headers : resilientFetch 에 그대로
 *   - totalMs   : 전체 시한(시도 하나의 상한으로도 쓴다 — 실제 종료는 signal 이 정한다)
 *   - attemptMs : 순서대로 모드(hedgeMs 0)일 때 시도당 시한
 *   - hedgeMs   : 다음 시도를 함께 보내기까지(0 = 순서대로)
 *   - maxAttempts (3) · signal(전체 시한) · onAttempt(n) · fetchImpl(테스트)
 * @returns {Promise<{res: Response, attempts: number}>}
 */
export function hedgedFetch(url, {
  dispatcher, headers, totalMs, attemptMs, hedgeMs = META_HEDGE_MS, maxAttempts = 3, signal, onAttempt, fetchImpl = resilientFetch,
} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortErr(signal)); return; }
    const ctrls = new Set();
    let launched = 0;
    let running = 0;
    let failures = 0;
    let done = false;
    let timer = null;
    let lastErr = null;
    let lastRetryable = null;
    const hedging = hedgeMs > 0;
    let throttled = false;      // v2.741(RECENT-04): 429·503 을 받았다 — 더는 함께 보내지 않는다
    let noMore = false;         // v2.741: Retry-After 가 남은 시한보다 길다 — 새 시도를 보내지 않고 진행 중 시도·받은 응답으로 결론
    const startedAt = Date.now();
    const budgetMs = Number.isFinite(Number(totalMs)) && Number(totalMs) > 0 ? Number(totalMs) : null;

    const stop = () => { done = true; clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); };
    const abortAll = (keep) => { for (const c of ctrls) if (c !== keep) { try { c.abort(); } catch { /* */ } } };
    function onAbort() {
      if (done) return;
      stop(); abortAll(null); cancelBody(lastRetryable);
      reject(abortErr(signal));
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });

    const schedule = (ms) => { clearTimeout(timer); timer = setTimeout(launch, ms); };
    /**
     * 한 시도가 쓸 응답 없이 끝났다 — 남은 시도가 있으면 곧 다음을, 없고 진행 중인 시도도 없으면 결론을 낸다.
     * @param {Response|null} res 재시도 대상 응답(있으면 429·503 의 Retry-After 를 본다 — v2.741 RECENT-04)
     */
    const settleFailure = (res = null) => {
      failures += 1;
      const base = 400 * 2 ** (failures - 1);
      let wait = base;
      if (res && (res.status === 429 || res.status === 503)) {
        throttled = true;   // 과부하라고 말한 저장소 — 이제부터 함께 보내지 않는다(아래 launch 의 schedule(hedgeMs) 도 막는다)
        wait = retryDelayMs(res.status, res.headers?.get?.('retry-after'), base);
        // 기다릴 시간이 전체 시한의 남은 시간보다 길면 다음 시도는 시한에 끊길 뿐이다 — 보내지 않고 받은 응답으로 결론(호출부가 상태로 말한다).
        if (wait > base && budgetMs != null && Date.now() - startedAt + wait >= budgetMs) { noMore = true; clearTimeout(timer); }
      }
      if (!noMore && launched < maxAttempts) { schedule(wait); return; }
      if (running > 0) return;   // 앞서 보낸 시도가 아직 기다리는 중 — 그 결과를 본다
      stop();
      if (lastRetryable) resolve({ res: lastRetryable, attempts: launched });
      else reject(lastErr || new Error('응답이 없습니다'));
    };

    function launch() {
      if (done || noMore || launched >= maxAttempts) return;
      launched += 1; running += 1;
      onAttempt?.(launched);
      const ctrl = new AbortController();
      ctrls.add(ctrl);
      const sig = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
      // 함께 보내는 동안은 앞 시도를 끊지 않으므로 시한은 전체 시한 — 429·503 뒤(순서대로)에는 시도마다 시한(예전 재시도와 같다).
      const t = (hedging && !throttled) ? totalMs : (attemptMs || totalMs);
      fetchImpl(url, { dispatcher, headers, timeoutMs: t, retries: 0, signal: sig }).then((res) => {
        running -= 1; ctrls.delete(ctrl);
        if (done) { cancelBody(res); return; }
        if (RETRYABLE.has(res.status)) {
          cancelBody(lastRetryable); lastRetryable = res;
          settleFailure(res);
          return;
        }
        stop(); abortAll(ctrl); cancelBody(lastRetryable);
        resolve({ res, attempts: launched });
      }, (err) => {
        running -= 1; ctrls.delete(ctrl);
        if (done) return;
        if (signal?.aborted) { onAbort(); return; }
        lastErr = err;
        if (!isTransient(err)) {   // 차단 대역·인증서·리다이렉트 거부 — 다시 보내도 같다(예전 재시도와 같은 판정)
          stop(); abortAll(null); cancelBody(lastRetryable);
          reject(err);
          return;
        }
        settleFailure();
      });
      if (hedging && !throttled && launched < maxAttempts) schedule(hedgeMs);
    }

    launch();
  });
}
