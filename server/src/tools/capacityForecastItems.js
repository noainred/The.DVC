/**
 * tools/capacityForecastItems.js — 용량 고갈 예측 항목 계산(순수 · v3.31 정기 점검 보고 때 라우트에서 뽑았다 — 판정 코어 하나).
 * `/tools/capacity-forecast`(routes/api/toolsCapacity.js) 와 정기 점검 보고 리더(periodic/readers/vsphere.js capacityEta)가 같은 계산을 쓴다.
 *
 *  · 증가율은 롤업 추세(dsGrowthFor)의 점이 3개 이상일 때만 쓴다. 데모(mock)에서만 합성 증가율(synthesized 표지).
 *  · v2.599 RECENT2599-03: 사용량을 못 읽은 DS 는 '전량 여유' 로 계산하지 않는다 — 여유를 모르면 소진일도 모른다(null).
 */

/** FNV-1a 32비트 — routes/api/shared.js hash 와 같은 값(데모 합성 증가율이 화면과 보고서에서 같게). */
function fnv(s) { let h = 2166136261; const str = String(s); for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0); }

/**
 * @param {object[]} dss 데이터스토어(범위로 이미 거른 것)
 * @param {{byId:Map<string,{slope:number,points:number,firstTs:number}>}} growth dsGrowthFor 결과
 * @param {{mock?:boolean}} [o]
 * @returns {object[]} 소진 예상일이 가까운 순
 */
export function forecastItems(dss, growth, { mock = false } = {}) {
  const items = [];
  for (const d of dss || []) {
    const g = growth?.byId?.get?.(d.id) || null;
    let slope = null; let synthesized = false; // GB/day
    if (g && g.points >= 3) {
      slope = g.slope;
    } else if (mock) {
      synthesized = true; slope = Math.max(0, (d.capacityGB * 0.0008) + (fnv(d.id) % 5) * 0.2); // 합성 증가율
    }
    const freeGB = d.freeGB != null ? d.freeGB
      : d.usedGB != null && d.capacityGB > 0 ? Math.max(0, d.capacityGB - d.usedGB) : null;
    const daysToFull = freeGB != null && slope && slope > 0.01 ? Math.round(freeGB / slope) : null;
    items.push({ id: d.id, name: d.name, vcenterId: d.vcenterId, type: d.type, capacityGB: d.capacityGB, usedGB: d.usedGB, freeGB, usagePct: d.usagePct, growthGBperDay: slope == null ? null : Number(slope.toFixed(2)), daysToFull, synthesized, growthPoints: g?.points ?? 0, growthSince: g?.firstTs ?? null });
  }
  items.sort((a, b) => (a.daysToFull ?? Infinity) - (b.daysToFull ?? Infinity));
  return items;
}
