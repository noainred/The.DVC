/**
 * 엣지 '보류' 응답 읽기(순수 — 51회차 #3 사용자 결정). 엣지가 진행 중 작업을 기다리느라 번들 설치를 미뤘다고 답하면(upgrade/pushHold.js)
 * 중앙은 그 시간(waitMs — 엣지 시각이 아니라 남은 시간이라 시계 차에 흔들리지 않는다) 동안 같은 엣지에 다시 밀지 않는다(edgeSync holdUntil).
 * 아는 필드만 · 글자 · 수 상한(12시간 — 엣지 상한 UPGRADE_SCAN_DEFER_MAX_MS 의 최대값).
 */
export const PUSH_HOLD_MAX_MS = 12 * 3_600_000;
export function deferredOf(body) {
  if (!body || typeof body !== 'object' || body.deferred !== true) return {};
  const w = typeof body.waitMs === 'number' && Number.isFinite(body.waitMs) ? Math.min(PUSH_HOLD_MAX_MS, Math.max(0, Math.round(body.waitMs))) : null;
  return { deferred: true, ...(w != null ? { waitMs: w } : {}), ...(typeof body.reason === 'string' && body.reason ? { reason: body.reason.slice(0, 300) } : {}) };
}
