/**
 * forecastRowText.js — 인사이트 허브 › 용량예측 표의 칸 문구(순수, v2.601 감사 WEB2601-07).
 *
 * v2.598 부터 서버는 사용량을 못 읽은 DS 의 `usagePct` 를 null 로 준다 — 표가 `{x.usagePct}%` 로 그려
 * **'%' 만** 찍혔다. 또 `daysToLimit` 은 '증가 중이고 아직 한계 아래' 일 때만 값이 있어서, 이미 한계에 닿은
 * (current ≥ 용량) DS 도 null → **'안정'** 으로 보였다. 가장 급한 DS 를 가장 느긋하게 말한 셈이다.
 */

/** 사용률 칸 — 모르면 '—'(단위 없이). */
export function forecastPctText(v) {
  if (v == null || v === '' || !Number.isFinite(Number(v))) return '—';
  return `${Number(v)}%`;
}

/**
 * 한계 도달 칸의 종류. 'days'(N일 후) / 'full'(이미 한계 — 포화) / 'stable'(증가하지 않음).
 * @param {{daysToLimit:number|null, current:number, capacityGB:number, slopePerDay:number}} x
 */
export function forecastLimitKind(x) {
  if (x?.daysToLimit != null && Number.isFinite(Number(x.daysToLimit))) return 'days';
  const cur = Number(x?.current), cap = Number(x?.capacityGB);
  if (Number.isFinite(cur) && Number.isFinite(cap) && cap > 0 && cur >= cap) return 'full';
  return 'stable';
}
