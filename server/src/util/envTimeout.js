/**
 * 엣지 워커의 요청 시한 env 정규화(v2.600 감사 추가 배정 · v2.613 DEPS2613-01 에 agent/ → util/ 로 이동, 옛 경로는 재수출).
 *
 * `Number(process.env.X) || 기본값` 형태는 음수(-1)를 그대로 통과시켜 **요청이 즉시 중단**되고, 2^31−1ms 를 넘는
 * 값은 Node 가 1ms 로 바꿔 같은 결과가 된다(v2.599 T2599-02 의 주기 env 와 같은 계열 — 그쪽은 config.js clampIntervalMs).
 * 요청 시한은 [1초, 10분] 이 기본 범위다(배포처럼 긴 작업은 max 를 넓혀 부른다). 빈 값·0·비숫자는 기본값.
 */
export function reqTimeoutMs(raw, def, { min = 1_000, max = 600_000 } = {}) {
  const v = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(v) || v <= 0) return def;
  return Math.min(max, Math.max(min, Math.round(v)));
}
