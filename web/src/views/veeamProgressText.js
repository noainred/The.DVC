/**
 * views/veeamProgressText.js — Veeam 서버 '진행 상태' 표시 판정(v2.773). 서버가 준 progress(veeam/progress.js veeamProgress)를 그대로 그린다 —
 * 단계 판정은 서버 하나에서만 한다(웹에서 다시 판정하지 않는다).
 */
export const STEP_ICON = { ok: '✅', warn: '⚠️', bad: '❌', wait: '⏳', skip: '·' };
export const STEP_TONE = { ok: 'ok', warn: 'warn', bad: 'bad', wait: 'muted', skip: 'muted' };

/** 막힌 단계(서버 blockedAt)를 찾는다. 없거나 모르는 키면 null. */
export function blockedStep(progress) {
  const steps = Array.isArray(progress?.steps) ? progress.steps : [];
  const key = progress?.blockedAt;
  return key ? steps.find((s) => s?.key === key) || null : null;
}

/**
 * 상태 칸 아래 한 줄 — 앞 단계에서 막혔을 때만(마지막 '결과' 단계는 상태 칸이 이미 말한다).
 * @returns {{ text:string, tone:string }|null}
 */
export function progressHint(progress) {
  const b = blockedStep(progress);
  if (!b || b.key === 'result') return null;
  const steps = progress.steps;
  const idx = steps.indexOf(b) + 1;
  const verb = b.state === 'wait' ? '에서 기다리는 중' : '에서 막힘';
  return { text: `진행 ${idx}/${steps.length}단계 ‘${b.label}’${verb} — 진행 상태를 눌러 보세요`, tone: STEP_TONE[b.state] || 'muted' };
}
