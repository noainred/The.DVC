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
 * v2.733(점검 3회차 C2-07): 마지막 표본이 오래된 행의 표지 — 서버가 `stale:true` 이고 `lastTs`(마지막 버킷 시작)를 줄 때만.
 * 소진일은 이제 마지막 표본 시점에서 센다(예전에는 오늘부터 세어 멈춘 동안의 증가가 빠졌다 — 남은 시간을 더 길게 말했다).
 * 표지는 '그 뒤의 추세는 모른다' 를 말한다. lastTs 를 모르면(구버전 서버·데모 합성 행) 빈 문자열 — 지어내지 않는다.
 * @param {{stale?:boolean, lastTs?:number}} x  @param {number} now 기준 시각(서버 응답 generatedAt 우선)
 */
export function forecastStaleText(x, now = Date.now()) {
  if (!x || x.stale !== true) return '';
  const last = Number(x.lastTs), at = Number(now);
  if (x.lastTs == null || x.lastTs === '' || !Number.isFinite(last) || !Number.isFinite(at)) return '';
  const age = Math.max(0, at - last);
  const DAY = 86_400_000, HOUR = 3_600_000;
  return age >= DAY ? `마지막 표본 ${Math.floor(age / DAY)}일 전` : `마지막 표본 ${Math.floor(age / HOUR)}시간 전`;
}

/** 표지의 설명(title) — 한 벌. */
export const FORECAST_STALE_TITLE = '이 항목은 수집이 멈춘 뒤의 추세를 모릅니다. 포화까지 남은 기간은 마지막 표본 시점에서 센 값이고, 이미 지났을 추세면 0일입니다.';

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
