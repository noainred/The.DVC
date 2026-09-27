/**
 * 엣지 시계·늦게 도착한 결과 표지(순수 — vitest 고정, v2.631 감사 A6-2631-04 화면 부분).
 *
 * ① 엣지 시계 빠름: 중앙(`routes/central.js stampEdgeCollectedAt`, v2.630 A4-02)은 엣지가 보낸 수집 시각이 수신 시각보다
 *    5초 넘게 앞서면 수집 시각(collectedAt)을 **수신 시각으로 맞추고** 그 차이를 `edgeClockAheadMs` 로 싣는다. 화면이 말하지
 *    않으면 '방금 수집' 이 실제 수집 시각인 것처럼 읽힌다. 행에는 짧은 표지, 조치는 표 아래 **각주 1회**(v2.509 규약).
 * ② RMA 늦은 결과: 기한 초과로 '미회신' 종결된 잡에 나중에 실제 결과가 오면(v2.630 A4-03) `late:true` 다 — 명령은
 *    **이미 실행됐다**. '미회신' 이라 보고 다시 실행하면 두 번 실행된다.
 * 필드가 없으면(구버전 중앙·해당 없음) 아무것도 표시하지 않는다(값을 지어내지 않는다).
 */

function spanText(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}분`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}시간`;
  return `${Math.round(h / 24)}일`;
}

/** 스냅샷의 엣지 시계 빠름(ms). 숫자·양수가 아니면 null. */
export function edgeClockAheadOf(snap) {
  const v = snap?.edgeClockAheadMs;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** 행 짧은 표지 — { label, title } 또는 null. */
export function edgeClockAheadMark(snap) {
  const ms = edgeClockAheadOf(snap);
  if (ms == null) return null;
  return {
    label: `엣지 시계 +${spanText(ms)}`,
    title: `엣지 시계가 중앙보다 약 ${spanText(ms)} 빠릅니다 — 수집 시각은 중앙이 받은 시각으로 맞춰 표시합니다(실제 수집은 그보다 이를 수 있습니다).`,
  };
}

/** 표 아래 각주(1회) — 시계가 빠른 장비가 하나라도 있을 때만. @param {Array} snaps 스냅샷 목록 */
export function edgeClockFootnote(snaps, unit = '장비') {
  const n = (Array.isArray(snaps) ? snaps : []).filter((s) => edgeClockAheadOf(s) != null).length;
  if (!n) return '';
  return `엣지 시계 표지가 붙은 ${unit} ${n}대는 엣지 서버의 시계가 중앙보다 빠릅니다 — 수집 시각을 중앙이 받은 시각으로 맞춰 '방금' 처럼 보일 수 있습니다. 그 엣지 서버의 시각 동기(NTP)를 확인하세요.`;
}

/** RMA 결과·이력의 늦은 도착 배지 — { label, title } 또는 null. */
export function rmaLateMark(r) {
  if (!r || r.late !== true) return null;
  const after = typeof r.lateAfterMs === 'number' && Number.isFinite(r.lateAfterMs) && r.lateAfterMs > 0 ? ` (기한 뒤 약 ${spanText(r.lateAfterMs)})` : '';
  return {
    label: '늦게 도착',
    title: `기한 초과로 미회신 처리된 뒤 도착한 결과입니다${after} — 명령은 이미 실행됐습니다. 다시 실행하면 두 번 실행됩니다.`,
  };
}
