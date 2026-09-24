/**
 * views/tools/sanPowerText.js — SAN 스위치 '소비전력(PSU 합)' 표시 문구(v2.601, 감사 COL-2601-06).
 *
 * chassisshow 는 PSU 마다 'Power Usage' 를 주지만 일부 PSU 가 값을 내지 않을 수 있다. 서버는 **값을 보고한 PSU 만**
 * 더하므로 그대로 'N W' 라 적으면 부분 합이 전체 합처럼 보인다(조용히 낮은 값). 부분 합이면 'PSU N개 중 M개 합' 을 붙인다.
 * 근거는 서버의 powerPartial({read,total}) 이 있으면 그것, 없으면(구버전 엣지) 화면이 이미 받는 psuDetail 로 센다.
 */
export function powerPartialOf(health) {
  const h = health || {};
  const p = h.powerPartial;
  if (p && Number.isFinite(p.read) && Number.isFinite(p.total) && p.read < p.total) return { read: p.read, total: p.total };
  const d = Array.isArray(h.psuDetail) ? h.psuDetail : [];
  if (!d.length) return null;
  const read = d.filter((x) => x && x.powerW != null).length;
  return read && read < d.length ? { read, total: d.length } : null;
}

/** 표시 문구 — 값이 없으면 '' (행을 숨긴다 — 0 W 를 지어내지 않는다). */
export function powerText(health) {
  const h = health || {};
  if (h.powerWatts == null || !(Number(h.powerWatts) > 0)) return '';
  const part = powerPartialOf(h);
  return part ? `${h.powerWatts} W (PSU ${part.total}개 중 ${part.read}개 합 — 나머지는 값 없음)` : `${h.powerWatts} W`;
}
