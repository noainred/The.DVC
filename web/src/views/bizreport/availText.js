// v2.707(C6) — VM 가용성(SLA) 문구. 판정은 서버 availability/analyze.js. 문구에 백틱·별표 금지(BoldText 는 **강조** 만 해석).
/** 가동률 표시 — 값이 없으면 '—'(단위를 붙이지 않는다). 99.9 처럼 소수 셋째 자리까지. */
export function pctText(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toFixed(3).replace(/\.?0+$/, '')}%` : '—';
}
/** 정지 시간 — 분·시간·일. */
export function downText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms === 0) return '0분';
  const m = Math.round(ms / 60_000);
  if (m < 1) return '1분 미만';
  if (m < 120) return `${m}분`;
  const h = ms / 3_600_000;
  if (h < 48) return `${Math.round(h * 10) / 10}시간`;
  return `${Math.round((h / 24) * 10) / 10}일`;
}
/** 목표 가동률이 허용하는 기간 중 정지 시간(분). */
export function allowedDownMin(targetPct, days) {
  const t = Number(targetPct); const d = Number(days);
  if (!Number.isFinite(t) || !Number.isFinite(d)) return null;
  return Math.round(((100 - t) / 100) * d * 1440 * 10) / 10;
}
export const TARGETS = Object.freeze([99, 99.5, 99.9, 99.95, 99.99]);
/** 측정 범위 안내 — 판정에서 빠진 VM 을 '가동 100%' 라 말하지 않는다. */
export function coverageNote(data) {
  if (!data) return null;
  if (data.logs && data.logs.enabled === false) return 'vCenter 이벤트 수집이 꺼져 있습니다(설정 › vCenter 로그 보관) — 가동률을 잴 수 없습니다.';
  const c = data.coverage || {};
  const parts = [];
  if (c.noEvents) parts.push(`이벤트를 받은 적 없는 vCenter 의 VM ${c.noEvents.toLocaleString()}대는 판정하지 않았습니다(가동 100% 가 아닙니다)`);
  if (c.partialWindow) parts.push(`이벤트 수집 시작이 기간 시작보다 늦은 VM ${c.partialWindow.toLocaleString()}대는 수집 시작부터만 쟀습니다`);
  if (c.inconsistent) parts.push(`전원 켬 이벤트를 놓친 VM ${c.inconsistent.toLocaleString()}대는 정지 시간을 알 수 없어 뺐습니다`);
  if (c.offAll) parts.push(`기간 내내 꺼져 있던 VM ${c.offAll.toLocaleString()}대는 서비스 중이 아니라 따로 셌습니다`);
  if (data.logs?.minSeverity && data.logs.minSeverity !== 'info') parts.push(`수집 최소 심각도가 ${data.logs.minSeverity} 라 정보 수준의 전원 이벤트가 쌓이지 않아 가동률이 실제보다 높게 나올 수 있습니다`);
  if (data.truncated) parts.push(`이벤트가 많아 최근 ${Number(data.readMax || 0).toLocaleString()}건까지만 봤습니다 — 앞쪽 정지가 빠졌을 수 있습니다`);
  return parts.length ? `${parts.join(' · ')}.` : null;
}
export const METHOD_NOTE = '정지 시간은 전원 끔·일시 정지부터 다음 전원 켬까지입니다. 게스트 재부팅·재설정·HA 재시작은 정지 시간을 이벤트로 알 수 없어 횟수로만 셉니다. 사람이 끈 정지(사용자 기록이 있는 전원 끔)가 계획 정지인지는 포탈이 알 수 없어, 그것을 뺀 가동률을 함께 보여 줍니다.';
