/**
 * 작업 시한 — **단일 관문**(v2.607 감사 TIM2607-02 · LEFT2607-08).
 *
 * 왜 여기 있나: `withDeadline` 이 `proxy/sshExec.js` 와 `util/bulkRun.js` 에 두 벌이었고 둘 다 시한을 좁히지 않았다.
 *   `STORAGE_DEVICE_TIMEOUT_MS=3000000000`(초·µs 착각) 이면 poller 의 `Math.max(하한, env)` 가 3e9 를 그대로 넘기고,
 *   setTimeout 은 2^31−1ms 를 넘는 값을 **1ms** 로 바꿔 모든 장비 수집이 2ms 만에 '수집 타임아웃(3000000초)' 이 됐다
 *   (감사 재현). NaN·Infinity 도 1ms 다. v2.606 TIM2606-03 은 exec 시한(`execTimeoutMs`)만 좁혔고 세션 시한은 남았다.
 *   util/ 은 도메인을 import 하지 못하므로(arch2579 ②) 공용 코어를 여기 두고 sshExec 가 재수출한다.
 *
 * 규칙: 숫자(또는 숫자 문자열)가 아니거나 0 이하면 기본값, 그 밖은 [1초, 2시간] 에 가둔다. 상한 2시간은 모든 장비
 *   시한 기본값(수 분)과 세션 예산보다 훨씬 크다 — 장비 시한 > 세션 예산 관계(unitySshBudget2528)를 깨지 않는다.
 */
export const DEADLINE_MIN_MS = 1_000;
export const DEADLINE_MAX_MS = 7_200_000;
export const DEADLINE_DEFAULT_MS = 60_000;

export function deadlineMs(v, def = DEADLINE_DEFAULT_MS) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(DEADLINE_MAX_MS, Math.max(DEADLINE_MIN_MS, Math.round(n)));
}

/**
 * 장비당 타임아웃 헬퍼(v2.417) — AbortController 로 signal 을 만들어 fn(signal) 을 돌리고, 기한이
 * 지나면 abort 한다(withSsh 가 세션을 끊는다). 결과만 포기하는 Promise.race 대신 이걸 쓸 것.
 * 기한이 지나 fn 이 던지면 `${label}(N초)` 로 바꿔 던진다(N 은 좁힌 뒤의 값 — 실제로 기다린 시간).
 */
export async function withDeadline(ms, fn, label = '타임아웃') {
  const eff = deadlineMs(ms);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), eff); // unref 하지 않는다 — 대기 중인 수집을 반드시 끊어야 한다
  try { return await fn(ac.signal); }
  catch (e) { if (ac.signal.aborted) throw new Error(`${label}(${Math.round(eff / 1000)}초)`); throw e; }
  finally { clearTimeout(t); }
}
