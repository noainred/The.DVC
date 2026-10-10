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
  if (c.missedOff) parts.push(`마지막 기록은 켬인데 지금 꺼져 있는 VM ${c.missedOff.toLocaleString()}대는 언제 꺼졌는지 알 수 없어 뺐습니다`);
  if (c.clockSkew) parts.push(`vCenter 이벤트 시각이 포탈보다 앞서 측정 구간이 없는 VM ${c.clockSkew.toLocaleString()}대는 판정하지 않았습니다`);
  // v2.731(점검 r1 A2-01): 이벤트 수집이 멈춘 vCenter 는 멈춘 시각까지만 쟀다 — 수집하지 못한 꼬리를 '정지 없음 = 가동' 으로 세지 않았다.
  if (c.staleTail) {
    const age = Number.isFinite(c.tailMaxAgeMs) && c.tailMaxAgeMs > 0 ? `(가장 오래된 곳은 ${downText(c.tailMaxAgeMs)} 전)` : '';
    const src = c.tailFromLastEvent ? ` — 그중 ${Number(c.tailFromLastEvent).toLocaleString()}곳은 수집 성공 기록이 없어(포탈 재시작 직후이거나 수집이 계속 실패하는 중) 마지막으로 받은 이벤트 시각을 썼습니다` : '';
    parts.push(`이벤트 수집이 멈춘 vCenter ${Number(c.tailVcenters || 0).toLocaleString()}곳의 VM ${c.staleTail.toLocaleString()}대는 수집이 멈춘 시각까지만 쟀습니다${age} — 그 뒤의 정지는 알 수 없습니다(전원 기록이 없는 VM 은 지금 전원 상태가 측정 구간 내내 이어졌다고 봤습니다)${src}`);
  }
  if (c.stoppedEarly) parts.push(`이벤트 수집이 측정 기간 시작 전에 멈춘 vCenter 의 VM ${c.stoppedEarly.toLocaleString()}대는 판정하지 않았습니다(가동 100% 가 아닙니다)`);
  if (c.offAll) parts.push(`기간 내내 꺼져 있던 VM ${c.offAll.toLocaleString()}대는 서비스 중이 아니라 따로 셌습니다`);
  if (data.logs?.minSeverity && data.logs.minSeverity !== 'info') parts.push(`수집 최소 심각도가 ${data.logs.minSeverity} 라 정보 수준의 전원 이벤트가 쌓이지 않아 가동률이 실제보다 높게 나올 수 있습니다`);
  // v2.719(감사 B1-01): 잘리면 서버가 잘린 시점부터만 잰다 — '빠졌을 수 있다' 가 아니라 그 앞을 판정하지 않았다.
  if (data.truncated) parts.push(`이벤트가 많아 최근 ${Number(data.readMax || 0).toLocaleString()}건까지만 봤습니다 — 그보다 앞은 판정하지 않고 잘린 시점부터만 쟀습니다${c.readCut ? `(VM ${c.readCut.toLocaleString()}대)` : ''}`);
  return parts.length ? `${parts.join(' · ')}.` : null;
}
export const METHOD_NOTE = '정지 시간은 전원 끔·일시 정지부터 다음 전원 켬까지입니다. 게스트 재부팅·재설정·HA 재시작은 정지 시간을 이벤트로 알 수 없어 횟수로만 셉니다. 사람이 끈 정지(사용자 기록이 있는 전원 끔)가 계획 정지인지는 포탈이 알 수 없어, 그것을 뺀 가동률을 함께 보여 줍니다.';
/**
 * v2.720(감사 R2-03): 기간 중 생성된 VM 의 행 표지. 서버는 v2.719 B1-03 부터 첫 전원 기록이 '켬' 이면 첫 켬부터 잰다
 * (생성~첫 켬은 서비스 시작 전). '생성 뒤부터 잼' 이라고만 적으면 실제 측정 구간과 다른 기준을 말한다 — 서버가 준
 * 측정 시작 시각(windowFrom)을 함께 적는다. 시각을 모르면 시각 없이 말한다(지어내지 않는다).
 */
/**
 * v2.731(점검 1회차 A2-01): 그 VM 의 vCenter 이벤트 수집이 멈춰 측정 끝을 자른 행의 표지. 없으면 null.
 *   측정 끝(windowTo)이 지금이 아니므로 '그 뒤의 정지는 모른다' 를 행이 말한다(상단 coverageNote 는 개수만 말한다).
 */
export function tailCutText(row, fmt = (ts) => new Date(ts).toLocaleString('ko-KR')) {
  if (!row?.tailCut) return null;
  const to = Number(row.windowTo);
  return Number.isFinite(to) && to > 0 ? `수집 멈춤 — ${fmt(to)} 까지만 잼` : '수집 멈춤 — 멈춘 시각까지만 잼';
}

export function bornWindowText(row, fmt = (ts) => new Date(ts).toLocaleString('ko-KR')) {
  if (!row?.bornInWindow) return null;
  const from = Number(row.windowFrom);
  const base = '기간 중 생성 — 생성 이후만 잼(첫 기록이 켬이면 그 시각부터)';
  return Number.isFinite(from) && from > 0 ? `기간 중 생성 — ${fmt(from)} 부터 잼` : base;
}
