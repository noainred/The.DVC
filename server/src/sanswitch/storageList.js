/**
 * sanswitch/storageList.js — 'SAN 스토리지 성능' 현황 · 상세의 **순수 조립 코어**(v2.948 · 설계 docs/design/san-storage-perf).
 *
 * 이 파일은 DB 를 읽지 않는다 — 라우트가 perfDb.storageSeriesMulti 결과 두 벌(최근 1시간 · 최근 7일(포트별 포함))을 넘기면
 * 어레이마다 지금 · 회선 사용률 · 24시간 평균/피크 · 7일 대비 · 디렉터별 · 팹별 · 상태를 만든다. 그래서 테스트가 입력을 직접 넣어 고정한다.
 *
 * 정직 규칙(설계 §3 · CLAUDE.md '못 읽은 값은 0 이 아니다'):
 *  · '지금' 은 **수집 주기 안에서 팹 A/B 표본이 다 모인 마지막 칸**이다 — 마지막 값이 이월 한계(carryMs) + 칸 폭보다 오래됐으면 null(stale).
 *  · 평균 · 피크는 값이 있는 칸만 — 부분 합(null) · 미래 칸은 넣지 않는다. 비교 구간에 값이 MIN_PREV_HOURS 미만이면 '7일 대비' 는 null.
 *  · 회선 사용률 = 송수신 합 ÷ 연결 포트 속도 합(portUsage.capBpsOf — 포트 사용량 탭 '포화도' 와 같은 계산). 속도를 모르는 포트는 분모에서
 *    빼고 개수를 밝힌다. FC 는 전이중이라 이론상 200% 까지 간다(화면 각주).
 *  · 디렉터 편중은 포트 사용량 탭 규칙(그룹 평균 ≥ IMBALANCE_MIN_BPS · 멤버 ≥ IMBALANCE_RATIO 배)을 **24시간 평균**으로 판정한다.
 *  · 디렉터를 못 읽은 포트는 '(구분 못 함)' 한 그룹이다 — 추정해서 나누지 않는다(directorOf).
 *  · 상태는 하나의 코드다(STATE_TEXT) — '값이 없는 이유' 를 한 문구로 덮지 않는다(perfDiag 규칙과 같은 정신).
 *
 * 입력 계약(라우트가 만든다 — 테스트가 같은 모양을 넣는다):
 *   agg1h  : storageSeriesMulti(ids, { hours:1, groupOf })            — buckets(60초) · series[{key, group, sum[], peak[], deviceIds, ports}]
 *   agg7d  : storageSeriesMulti(ids, { hours:168, groupOf, withPorts:true }) — buckets(1시간) · series[...+ portsDetail[{deviceId, port, name, speed, portType, avg[], peak[]}]]
 */
import { capBpsOf, IMBALANCE_MIN_BPS, IMBALANCE_RATIO } from './portUsage.js';
import { arraySerialOf } from './perfDb.js';
import { groupLabel, UNPARSED_GROUP } from './directorOf.js';
import { numOrNull } from '../util/numOrNull.js';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** 7일 대비의 비교 구간에 값이 있는 시간이 이보다 적으면 비교하지 않는다(설계 §3-7). */
export const MIN_PREV_HOURS = 6;

/** 상태 코드 → 화면 문구(짧게 — 긴 설명은 웹 sanStorageText 가 한다). */
export const STATE_TEXT = Object.freeze({
  ok: '정상',
  stale: '표본 지연 — 마지막 표본이 수집 주기의 2배보다 오래됨',
  'edge-missing': '엣지 미보고 — 표본이 아직 중앙에 오지 않음',
  'no-sample': '표본 없음',
  'partial-only': '측정 없음 — 부분 합 구간만',
});

const mean = (arr) => { const v = arr.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const maxOf = (arr) => { let m = null; for (const v of arr) if (v != null && (m == null || v > m)) m = v; return m; };
const seriesKey = (s) => `${s.group ?? ''}\u0000${s.key}`;

/** 마지막 값이 있는 칸 — 한계(carryMs + 칸 폭) 안이면 '지금', 넘었으면 stale. */
export function nowOf(sum = [], buckets = [], { until, carryMs = 0, bucketMs = 0 } = {}) {
  let j = -1;
  for (let i = sum.length - 1; i >= 0; i--) if (sum[i] != null) { j = i; break; }
  if (j < 0) return null;
  const ts = buckets[j];
  const stale = Number.isFinite(until) && until - ts > carryMs + bucketMs;
  return stale ? { bps: null, ts, stale: true } : { bps: sum[j], ts, stale: false };
}

/** 24시간 창(끝 until 기준 — 시작은 열린 구간이라 1시간 칸이면 정확히 24칸)과 그 앞 구간의 칸 번호. */
export function windowIndexes(buckets = [], until) {
  const cur = []; const prev = [];
  for (let i = 0; i < buckets.length; i++) {
    const t = buckets[i];
    if (t > until) continue;
    if (t > until - DAY) cur.push(i); else prev.push(i);
  }
  return { cur, prev };
}

/** 7일 대비(%) — 둘 다 있고 비교 구간이 충분할 때만. */
export function delta7dOf(avg24, prevAvg, prevHours) {
  if (avg24 == null || prevAvg == null || !(prevAvg > 0) || prevHours < MIN_PREV_HOURS) return null;
  return Math.round(((avg24 - prevAvg) / prevAvg) * 100);
}

/**
 * 디렉터(컨트롤러)별 합산 + 편중 판정(순수).
 * @param {Array<{group:string|null, confidence:string, avg24:number|null, deviceId:string, port:number}>} portRows 포트별 24시간 평균(이미 해석된 그룹)
 */
export function directorsOf(portRows = [], { minBps = IMBALANCE_MIN_BPS, ratio = IMBALANCE_RATIO } = {}) {
  const by = new Map();
  for (const p of portRows) {
    const g = groupLabel(p.group);
    if (!by.has(g)) by.set(g, { group: g, confidence: p.confidence || 'none', ports: 0, unmeasured: 0, avg24: null, parsed: g !== UNPARSED_GROUP });
    const d = by.get(g);
    d.ports++;
    if (p.avg24 == null) d.unmeasured++;
    else d.avg24 = (d.avg24 ?? 0) + p.avg24;
    if (p.confidence === 'manual') d.confidence = 'manual';
  }
  const list = [...by.values()];
  const measured = list.filter((d) => d.avg24 != null);
  const groupMean = measured.length ? measured.reduce((a, d) => a + d.avg24, 0) / measured.length : null;
  for (const d of list) d.ratio = d.avg24 != null && groupMean > 0 ? Math.round((d.avg24 / groupMean) * 100) / 100 : null;
  let imbalance = null;
  if (groupMean != null && groupMean >= minBps && measured.length >= 2) {
    const top = measured.reduce((a, d) => (a == null || d.avg24 > a.avg24 ? d : a), null);
    if (top && top.ratio >= ratio) imbalance = { group: top.group, ratio: top.ratio };
  }
  list.sort((a, b) => (a.parsed === b.parsed ? a.group.localeCompare(b.group) : a.parsed ? -1 : 1));
  return { directors: list, imbalance, groupMean, unparsedPorts: by.get(UNPARSED_GROUP)?.ports || 0 };
}

/**
 * 어레이 행 전부 + 종류 개수. kind 는 'array' 만 행으로 만든다(호스트 HBA 는 개수만 — 법인 합산에서 수십~수천 개).
 * @param {object} p
 * @param {object} p.agg1h · p.agg7d — 위 입력 계약
 * @param {Map<string,{name:string,datacenterId:string,datacenterName:string,agent:string}>} p.deviceMeta
 * @param {Map<string,number|null>} p.deviceLastTs 장비별 마지막 표본 시각
 * @param {(key:string, dcId:string)=>'array'|'host'|'unknown'} p.kindOf
 * @param {(key:string, dcId:string)=>object|null} p.capacityOf 등록 스토리지 용량(시리얼 일치 때만)
 * @param {(port:{deviceId:string,port:number,name:string}, key:string)=>{group:string|null,confidence:string,vendor:string}} p.directorFor
 */
export function buildStorageRows({ agg1h, agg7d, deviceMeta, deviceLastTs, kindOf, capacityOf, directorFor, now = Date.now(), carryMs = 0,
  imbalance = { minBps: IMBALANCE_MIN_BPS, ratio: IMBALANCE_RATIO } } = {}) {
  const oneH = new Map((agg1h?.series || []).map((s) => [seriesKey(s), s]));
  const until1 = numOrNull(agg1h?.until) ?? now;
  const until7 = numOrNull(agg7d?.until) ?? now;
  const buckets7 = agg7d?.buckets || [];
  const { cur, prev } = windowIndexes(buckets7, until7);
  const counts = { array: 0, host: 0, unknown: 0 };
  const rows = [];
  const seen = new Set();
  const consider = (s, from1h) => {
    const k = seriesKey(s); if (seen.has(k)) return; seen.add(k);
    const dcId = s.group ?? '';
    const kind = kindOf(s.key, dcId);
    counts[kind] = (counts[kind] || 0) + 1;
    if (kind !== 'array') return;
    const s7 = from1h ? null : s;
    const s1 = oneH.get(k) || null;
    rows.push(rowOf({ s7, s1, dcId }));
  };
  for (const s of agg7d?.series || []) consider(s, false);
  for (const s of agg1h?.series || []) consider(s, true);   // 7일 집계에 없고 1시간에만 있는(방금 생긴) 시리즈

  function rowOf({ s7, s1, dcId }) {
    const key = (s7 || s1).key;
    const devIds = [...new Set([...(s7?.deviceIds || []), ...(s1?.deviceIds || [])].map(String))];
    const metaOf = (id) => deviceMeta?.get(id) || { name: id, datacenterId: dcId, datacenterName: dcId, agent: '' };
    const dcName = metaOf(devIds[0] || '').datacenterName || dcId || '(법인 미지정)';
    // 지금 · 스파크 — 1시간 집계(60초 칸)
    const nowV = s1 ? nowOf(s1.sum, agg1h.buckets, { until: until1, carryMs, bucketMs: agg1h.bucketMs || 0 }) : null;
    // 24시간 · 앞 6일 — 7일 집계(1시간 칸)
    const sum7 = s7?.sum || [];
    const avg24 = mean(cur.map((i) => sum7[i]));
    const peak24 = maxOf(cur.map((i) => (s7?.peak || [])[i]));
    const measured24 = cur.filter((i) => sum7[i] != null).length;
    const prevVals = prev.map((i) => sum7[i]).filter((v) => v != null);
    const prevAvg = prevVals.length ? prevVals.reduce((a, b) => a + b, 0) / prevVals.length : null;
    const delta7d = delta7dOf(avg24, prevAvg, prevVals.length);
    // 포트별 → 디렉터 · 팹 · 회선 용량
    const portRows = [];
    const fabrics = new Map();
    let speedSum = 0; let unknownSpeed = 0; const portsByDevice = {};
    for (const p of s7?.portsDetail || []) {
      const d = directorFor({ deviceId: String(p.deviceId), port: Number(p.port), name: p.name || '' }, key);
      const pAvg = mean(cur.map((i) => (p.avg || [])[i]));
      const pPeak = maxOf(cur.map((i) => (p.peak || [])[i]));
      const cap = capBpsOf(p.speed);
      if (cap == null) unknownSpeed++; else speedSum += cap;
      portsByDevice[p.deviceId] = (portsByDevice[p.deviceId] || 0) + 1;
      portRows.push({ deviceId: String(p.deviceId), deviceName: metaOf(String(p.deviceId)).name, port: Number(p.port), name: p.name || '', speed: p.speed || '',
        group: d.group, confidence: d.confidence, vendor: d.vendor, directorPort: d.port || '', avg24: pAvg, peak24: pPeak, capBps: cap,
        peakSatPct: cap && pPeak != null ? Math.round((pPeak / cap) * 1000) / 10 : null });
      const f = fabrics.get(String(p.deviceId)) || { deviceId: String(p.deviceId), name: metaOf(String(p.deviceId)).name, ports: 0, avg24: null, unmeasured: 0 };
      f.ports++; if (pAvg == null) f.unmeasured++; else f.avg24 = (f.avg24 ?? 0) + pAvg;
      fabrics.set(String(p.deviceId), f);
    }
    const dir = directorsOf(portRows, imbalance);
    const speedKnown = speedSum > 0 ? speedSum : null;
    const utilPct = nowV?.bps != null && speedKnown ? Math.round((nowV.bps / speedKnown) * 1000) / 10 : null;
    const vendor = portRows[0]?.vendor || null;
    // 상태
    const allEdge = devIds.length > 0 && devIds.every((id) => String(metaOf(id).agent || '').trim());
    const anyLast = devIds.some((id) => numOrNull(deviceLastTs?.get(id)) != null);
    let state = 'ok';
    if (allEdge && !anyLast) state = 'edge-missing';
    else if (!s7 || (s7.sum || []).every((v) => v == null)) state = (s7?.partialBuckets || 0) > 0 ? 'partial-only' : 'no-sample';
    else if (nowV == null || nowV.stale) state = 'stale';
    return {
      key, datacenterId: dcId, datacenterName: dcName, vendor, serial: arraySerialOf(key),
      capacity: capacityOf ? capacityOf(key, dcId) : null,
      switches: devIds.map((id) => ({ id, name: metaOf(id).name, agent: metaOf(id).agent || '', ports: portsByDevice[id] || 0 })),
      portCount: portRows.length || (s7?.ports || s1?.ports || []).length,
      speedSumBps: speedKnown, unknownSpeedPorts: unknownSpeed,
      now: nowV, utilPct, spark: s1 ? { buckets: agg1h.buckets, sum: s1.sum } : null,
      avg24, peak24, measured24, prevAvg, prevHours: prevVals.length, delta7d,
      directors: dir.directors, imbalance: dir.imbalance, unparsedPorts: dir.unparsedPorts,
      fabrics: [...fabrics.values()], ports: portRows,
      partialBuckets: s7?.partialBuckets || 0,
      state, stateText: STATE_TEXT[state] || state,
    };
  }
  rows.sort((a, b) => (b.now?.bps ?? -1) - (a.now?.bps ?? -1));
  return { rows, counts };
}

/** 어레이 행들의 KPI 합 — 측정된 것만 더하고 뺀 개수를 밝힌다(지금 합계는 라우트가 trafficTotal 로 따로 낸다 — 카드와 같은 함수).
 *  speedSumBps · unknownSpeedPorts 는 '지금' 값이 있는 행만(회선 사용률 분모 — v2.954 점검 B-5). */
export function rowTotals(rows = []) {
  let avg24 = null; let speedSum = 0; let unknownSpeed = 0; let imbalance = 0; let unmeasured = 0; let unparsed = 0;
  for (const r of rows) {
    if (r.avg24 == null) unmeasured++; else avg24 = (avg24 ?? 0) + r.avg24;
    // v2.954(점검 B-5): 회선 사용률 분모는 '지금' 값이 있는 행만 — 분자(지금 합계)에 들어가지 않는 어레이(stale · 표본 없음)의 포트 속도를 넣으면 사용률이 낮게 보인다.
    if (numOrNull(r.now?.bps) != null) {
      if (r.speedSumBps) speedSum += r.speedSumBps;
      unknownSpeed += r.unknownSpeedPorts || 0;
    }
    if (r.imbalance) imbalance++;
    if (r.unparsedPorts) unparsed++;
  }
  return { avg24, speedSumBps: speedSum > 0 ? speedSum : null, unknownSpeedPorts: unknownSpeed, imbalance, unmeasured, unparsedArrays: unparsed, arrays: rows.length };
}
