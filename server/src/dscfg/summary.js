/**
 * dscfg/summary.js — v3.22.0 Hypervisor 분석 화면(docs/design/host-insight · vm-insight §10 '데이터스토어 — 곧 가득 · 경로')이 쓰는 도구 요약(순수).
 *   규약은 routes/api/toolSummary.js — 기존 라우트(`/tools/storage-paths` · `/tools/capacity-forecast`)의 `?summary=1` 이 같은 게이트 · 범위를 지난 뒤 부른다.
 *   판정은 도구 그대로(새 계산 금지): 경로 = analyzePaths 를 법인마다 **상한 없이**(totals · coverage 는 더하면 전체와 같다) ·
 *   용량 예측 = 라우트가 만든 items(소진 예상일 · 사용률 · 합성 여부) 그대로 법인별로 센다.
 */
import { analyzePaths } from './analyze.js';
import { numOrNull } from '../util/numOrNull.js';

/** '곧 가득' 을 세는 창(일) — 설계 host-insight §10(사용자 확정 '90일 안에 가득 찰 데이터스토어'). 도구 화면의 카드는 180일이라 둘 다 센다(fullWithin). */
export const FORECAST_SOON_DAYS = 90;
export const FORECAST_WINDOWS_DAYS = Object.freeze([30, 90, 180]);
/** '사용률 높음' 칸 — 설계 §10 '사용률 90% 이상'(포탈 사용률 경계 90 · vCenter 기본 데이터스토어 경보 경고선과 같은 값). 이상(≥). */
export const DS_HIGH_PCT = 90;

const idsOf = (snap, arrs) => {
  const ids = new Set((snap.vcenters || []).map((v) => v.id));
  for (const a of arrs) for (const x of a || []) if (x && x.vcenterId != null) ids.add(x.vcenterId);
  return ids;
};
const groupBy = (arr) => { const m = new Map(); for (const x of arr || []) { if (!x || typeof x !== 'object') continue; let a = m.get(x.vcenterId); if (!a) { a = []; m.set(x.vcenterId, a); } a.push(x); } return m; };

/**
 * 경로(멀티패스) — 법인별 줄 + 법인별 상위 N(죽은 경로가 많은 호스트).
 * @param snap { vcenters, hosts }(범위로 이미 거른 것)
 */
export function storagePathsSummaryByVc(snap, { vcName = new Map(), topN = 5 } = {}) {
  const by = groupBy(snap.hosts);
  const rows = [...idsOf(snap, [snap.hosts])].map((id) => {
    const p = analyzePaths(by.get(id) || [], { vcName, rowsMax: Infinity });
    const dead = p.rows.filter((r) => r.dead > 0)
      .sort((a, b) => b.dead - a.dead || b.singlePath - a.singlePath || String(a.name).localeCompare(String(b.name)))
      .slice(0, topN)
      .map((r) => ({ id: r.id, name: r.name, cluster: r.cluster, dead: r.dead, paths: r.paths ?? null, luns: r.luns ?? null, deadLuns: Array.isArray(r.deadLuns) ? r.deadLuns.slice(0, 10) : [], singlePath: r.singlePath }));
    return {
      vcenterId: id, name: vcName.get(id) || id, coverage: p.coverage, totals: p.totals,
      // 판정 밖 = 경로 값을 못 받은 호스트(끊긴 호스트는 도구가 처음부터 뺀다 — coverage.hosts 에 없다)
      notCollected: p.coverage.notCollected,
      top: { dead },
    };
  }).sort((a, b) => String(a.vcenterId).localeCompare(String(b.vcenterId)));
  return { topN, rows };
}

/**
 * 용량 고갈 예측 — 법인별 줄 + 법인별 상위 N(곧 가득 찰 데이터스토어).
 * @param items 라우트가 만든 항목(범위로 이미 거른 데이터스토어 — { id, name, vcenterId, usagePct, daysToFull, synthesized, ... })
 * @param snap  { vcenters }(범위로 이미 거른 것 — 데이터스토어가 없는 법인도 줄을 낸다)
 */
export function capacityForecastSummaryByVc(items, snap, { vcName = new Map(), topN = 5 } = {}) {
  const by = groupBy(items);
  const rows = [...idsOf(snap, [items])].map((id) => {
    const list = by.get(id) || [];
    const fullWithin = Object.fromEntries(FORECAST_WINDOWS_DAYS.map((d) => [String(d), 0]));
    let high = 0; let usageUnknown = 0; let noForecast = 0; let synthesized = 0;
    for (const d of list) {
      const u = numOrNull(d.usagePct);
      if (u == null) usageUnknown += 1; else if (u >= DS_HIGH_PCT) high += 1;
      const days = numOrNull(d.daysToFull);
      if (days == null) noForecast += 1;
      else for (const w of FORECAST_WINDOWS_DAYS) if (days <= w) fullWithin[String(w)] += 1;
      if (d.synthesized === true) synthesized += 1;
    }
    const soonest = list.filter((d) => numOrNull(d.daysToFull) != null)
      .sort((a, b) => a.daysToFull - b.daysToFull || String(a.name).localeCompare(String(b.name)))
      .slice(0, topN)
      .map((d) => ({ id: d.id, name: d.name, type: d.type ?? null, capacityGB: d.capacityGB ?? null, usedGB: d.usedGB ?? null, freeGB: d.freeGB ?? null, usagePct: numOrNull(d.usagePct),
        growthGBperDay: d.growthGBperDay ?? null, daysToFull: d.daysToFull, synthesized: d.synthesized === true }));
    return {
      vcenterId: id, name: vcName.get(id) || id, datastores: list.length,
      soon: fullWithin[String(FORECAST_SOON_DAYS)], fullWithin, high, usageUnknown,
      noForecast,        // 증가 추세 근거가 없어(이력 부족 · 여유 모름 · 증가 없음) 예상일이 없는 데이터스토어 — '가득 안 참' 이 아니다
      synthesized,       // 목(mock) 합성 증가율로 낸 예상일 수
      top: { soonest },
    };
  }).sort((a, b) => String(a.vcenterId).localeCompare(String(b.vcenterId)));
  return { topN, thresholds: { soonDays: FORECAST_SOON_DAYS, windowsDays: [...FORECAST_WINDOWS_DAYS], highPct: DS_HIGH_PCT }, rows };
}
