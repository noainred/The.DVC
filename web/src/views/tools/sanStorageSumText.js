/**
 * SAN 스토리지 사용량 분석 창의 합계 판정(순수) — v2.721(감사 R1-02·R2-01·R2-02).
 *
 * 서버는 버킷이 전부 부분 합으로 비워진 계열에 avgTotal·peakAvg·peakTotal 을 함께 null 로 싣는다
 * (perfDb.js — 측정 없음). 예전 화면은 피크 보기에서 `s.peakAvg || 0` 이라 그 계열이 '0 bps' 로 그려지고
 * 제외 개수도 0 으로 셌다(평균 보기만 '—'). 두 보기가 같은 규칙을 쓰도록 null 을 그대로 둔다.
 * 법인 소계도 계열이 전부 측정 없음이면 서버가 null 로 준다 — 합계에서 빼고 개수를 밝힌다.
 */

/** 보기 기준(평균/피크)의 대표값 — 측정 없음은 null. */
export function perfAvgOf(s, peak) {
  if (!s) return null;
  return (peak ? s.peakAvg : s.avgTotal) ?? null;
}

/** 보기 기준의 최댓값 — 측정 없음은 null. */
export function perfMaxOf(s, peak) {
  if (!s) return null;
  return (peak ? s.peakTotal : s.maxTotal) ?? null;
}

/**
 * 법인 소계 행들의 전체 합계. 측정된 법인만 더하고, 전부 측정 없음이면 avg·max 는 null('—').
 * unmeasuredDcs: 값이 null 인 법인 수 · unmeasuredSeries: 법인 행들이 밝힌 측정 없음 계열 합.
 */
export function dcGrandTotals(dcTotals, peak) {
  let avg = null; let max = null; let unmeasuredDcs = 0; let unmeasuredSeries = 0; let storages = 0;
  for (const d of Array.isArray(dcTotals) ? dcTotals : []) {
    const a = perfAvgOf(d, peak);
    unmeasuredSeries += Number(d?.unmeasured) || 0;
    storages += Number(d?.storages) || 0;
    if (a == null) { unmeasuredDcs++; continue; }
    avg = (avg ?? 0) + a;
    const m = perfMaxOf(d, peak);
    if (m != null) max = (max ?? 0) + m;
  }
  return { avg, max, unmeasuredDcs, unmeasuredSeries, storages };
}

/** 법인 KPI 의 '측정 없음' 꼬리 — 없으면 빈 문자열. */
export function dcUnmeasuredNote(d) {
  const n = Number(d?.unmeasured) || 0;
  return n > 0 ? ` · 측정 없음 ${n}개(버킷이 전부 부분 합 — 트래픽 0 아님)` : '';
}

/** 전체 대비 비율(%) — 어느 쪽이든 측정 없음·0 이면 undefined(표시 안 함). */
export function dcSharePct(d, grandAvg, peak) {
  const a = perfAvgOf(d, peak);
  if (a == null || !grandAvg) return undefined;
  return Math.round((a / grandAvg) * 100);
}
