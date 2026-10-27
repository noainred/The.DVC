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

/** v2.774: 초까지 — 'MM-DD HH:MM:SS'. 못 읽은 값이면 '—'. */
export function fmtSec(ms) {
  const n = Number(ms);
  if (ms == null || !Number.isFinite(n) || n <= 0) return '—';
  const d = new Date(n); const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * v2.774(사용자 요청 '마지막으로 체크한 시간 표시해줘'): 이 판정을 서버가 만든 시각. 화면은 자동으로 다시 읽지 않으므로 그 사실도 함께 말한다.
 * 서버가 시각을 싣지 않았으면(옛 서버) '' — 시각을 지어내지 않는다.
 */
export function progressCheckedText(progress) {
  const t = fmtSec(progress?.checkedAt);
  return t === '—' ? '' : `마지막 확인 ${t}`;
}
