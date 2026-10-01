/**
 * 서버 온도 › 센서 상세(v2.659) — iDRAC 서버별 센서 요약 목록 조립(순수 모듈).
 *
 * 쓰임새(사용자 요청 그대로):
 *  · 흡기(inlet) 센서 → **전산실 온도**(법인별로 묶는다 — 흡기 최고값 규약 v2.381)
 *  · CPU 온도 + **CPU 사용률**(베어메탈 사용률 최신값 재사용 — 사용자 선택) → CPU 부하
 *  · GPU 온도 → GPU 가 동작하는지의 **근거**(온도는 사용률이 아니다 — 화면이 그렇게 말한다, v2.650 규약)
 *
 * ⚠ 신선하지 않은 상세(엣지 보고가 끊김·폴러 정지)는 요약에서 빼고 `stale` 로 센다 — 며칠 전 값을 지금 값처럼
 *   보이지 않는다. 상세가 아예 없는 서버는 `none` 이다(수집 전·구버전 엣지·Redfish 미지원). 둘을 섞지 않는다.
 */

import { summarizeSensors, collectionCpuJudge, SENSOR_COLLECTION_FRESH_MS } from '../idrac/sensorDetail.js';
import { numOrNull } from '../util/numOrNull.js';

const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const low = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/**
 * 베어메탈 사용률 최신 행 색인 — key(서비스태그·fleetId·serverId) 소문자 → 가장 최근 행.
 * @param {object[]} rows  usage_latest(중앙) + 엣지 보관분 행({ key, ts, cpu_pct, src, _freshMs? })
 */
export function cpuIndexOf(rows = []) {
  const m = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== 'object') continue;
    const k = low(r.key);
    if (!k) continue;
    const prev = m.get(k);
    if (!prev || (numOrNull(r.ts) ?? -1) > (numOrNull(prev.ts) ?? -1)) m.set(k, r);
  }
  return m;
}

/**
 * 서버 한 대의 CPU 사용률. 순서: 베어메탈 사용률(bmusage) → iDRAC 텔레메트리(센서 폴러가 이미 읽는 SystemUsage) →
 * Sensors 컬렉션의 CPU 사용률 센서. **어느 것을 썼는지 `src` 로 밝힌다.** 오래된 값은 `stale`(값은 싣되 판정에 쓰지 않는다).
 * v2.680 A-03: 낡은 값은 **더 뒤 순서의 신선한 값이 하나도 없을 때만** 낸다(예전엔 낡은 bmusage 행이 신선한 텔레메트리를 가렸다).
 * v2.680 A-02: 컬렉션 센서 값은 `sensorAt`(컬렉션 시각)으로 통합 추이와 같은 경계(`collectionCpuJudge`)를 적용한다 —
 *   시각을 모르면 낡은 것으로 본다.
 */
export function cpuOf(s, { cpuIndex, telemetryOf = () => null, sensorPct = null, sensorAt = null, sensorFreshMs = SENSOR_COLLECTION_FRESH_MS, freshMs = 30 * 60_000, now = Date.now(), bmEnabled = null } = {}) {
  let fallback = null;
  const keep = (c) => { if (!fallback) fallback = c; };
  const keys = [s?.serviceTag, s?.id, s?.fleetId].map(low).filter(Boolean);
  for (const k of keys) {
    const row = cpuIndex?.get(k);
    if (!row) continue;
    const pct = numOrNull(row.cpu_pct);
    if (pct == null) continue;
    const at = numOrNull(row.ts);
    const fm = numOrNull(row._freshMs) || freshMs;
    const c = { pct: r1(pct), src: 'bmusage', via: row.src || '', at, state: at != null && now - at <= fm ? 'ok' : 'stale' };
    if (c.state === 'ok') return c;
    keep(c);
    break; // 같은 서버의 다른 키는 같은 값의 별칭이다 — 첫 값 있는 키만 본다(예전과 같다)
  }
  const tel = telemetryOf(s);
  if (tel && numOrNull(tel.pct) != null) {
    const c = { pct: r1(numOrNull(tel.pct)), src: 'telemetry', via: 'SystemUsage', at: numOrNull(tel.at), state: tel.fresh === false ? 'stale' : 'ok' };
    if (c.state === 'ok') return c;
    keep(c);
  }
  if (numOrNull(sensorPct) != null) {
    const j = collectionCpuJudge(sensorPct, sensorAt, { now, freshMs: sensorFreshMs });
    const c = { pct: r1(numOrNull(sensorPct)), src: 'sensor', via: '', at: j.at, state: j.stale ? 'stale' : 'ok' };
    if (c.state === 'ok') return c;
    keep(c);
  }
  if (fallback) return fallback;
  return { pct: null, src: null, via: '', at: null, state: bmEnabled === false ? 'off' : 'none' };
}

/**
 * @param {object} o
 * @param {object[]} o.servers  analysisServersWithRemote 결과(이미 범위로 거른 것)
 * @param {(s)=>({list,omitted,at,collection}|null)} o.detailOf  서버 → 센서 상세
 * @param {(s)=>object} o.cpuFor  서버·요약 → cpuOf 결과
 * @param {(id)=>string} o.dcName
 * @param {(s, at)=>number} o.maxAgeOf  서버·시각 → 신선도 경계(ms)
 */
export function buildSensorRows({ servers = [], detailOf, cpuFor, dcName = (x) => x, maxAgeOf = () => 15 * 60_000, now = Date.now() } = {}) {
  const rows = [];
  const counts = { servers: 0, withDetail: 0, stale: 0, none: 0, sensors: 0, warnSensors: 0, critSensors: 0, unknownSensors: 0, serversWarn: 0, serversCrit: 0, gpuServers: 0, cpuRead: 0 };
  for (const s of servers) {
    if (!s || typeof s !== 'object') continue;
    counts.servers += 1;
    const d = detailOf(s);
    const at = numOrNull(d?.at);
    const fresh = !!d && d.list?.length > 0 && at != null && now - at <= maxAgeOf(s, at);
    const detailState = !d || !d.list?.length ? 'none' : (fresh ? 'ok' : 'stale');
    const sum = d?.list?.length ? summarizeSensors(d.list) : null;
    const cpu = cpuFor(s, sum);
    const dc = s.datacenterId || s.vcenterId || '';
    const row = {
      id: String(s.id), name: s.name || s.host || String(s.id), serviceTag: s.serviceTag || '', model: s.model || '',
      vendor: s.vendor || (s.type === 'hpe' ? 'hpe' : ''), remote: !!s.remote,
      vcenterId: s.vcenterId || '', datacenterId: dc, dcLabel: dc ? dcName(dc) : '(미귀속)',
      detailState, at, omitted: d?.omitted || 0,
      collection: d?.collection || null,
      summary: sum,
      cpu,
    };
    rows.push(row);
    if (detailState === 'none') { counts.none += 1; continue; }
    if (detailState === 'stale') { counts.stale += 1; continue; }
    counts.withDetail += 1;
    counts.sensors += sum.total;
    counts.warnSensors += sum.counts.warn;
    counts.critSensors += sum.counts.crit;
    counts.unknownSensors += sum.counts.unknown;
    if (sum.counts.crit) counts.serversCrit += 1; else if (sum.counts.warn) counts.serversWarn += 1;
    if (sum.gpuTempCount) counts.gpuServers += 1;
    if (cpu?.pct != null && cpu.state === 'ok') counts.cpuRead += 1;
  }
  // 법인(데이터센터)별 전산실 온도 — 신선한 흡기만. 흡기를 못 읽은 서버는 개수만 센다(0 으로 넣지 않는다).
  const byDc = new Map();
  for (const r of rows) {
    const g = byDc.get(r.datacenterId) || { datacenterId: r.datacenterId, label: r.dcLabel, servers: 0, inletN: 0, inletSum: 0, inletMax: null, noInlet: 0, cpuTempMax: null, gpuTempMax: null, warn: 0, crit: 0 };
    g.servers += 1;
    if (r.detailState === 'ok') {
      const v = r.summary?.inletC;
      if (v == null) g.noInlet += 1; else { g.inletN += 1; g.inletSum += v; g.inletMax = g.inletMax == null ? v : Math.max(g.inletMax, v); }
      const c = r.summary?.cpuTempMaxC; if (c != null) g.cpuTempMax = g.cpuTempMax == null ? c : Math.max(g.cpuTempMax, c);
      const gp = r.summary?.gpuTempMaxC; if (gp != null) g.gpuTempMax = g.gpuTempMax == null ? gp : Math.max(g.gpuTempMax, gp);
      g.warn += r.summary?.counts?.warn || 0; g.crit += r.summary?.counts?.crit || 0;
    } else g.noInlet += 1;
    byDc.set(r.datacenterId, g);
  }
  const byDatacenter = [...byDc.values()].map((g) => ({
    datacenterId: g.datacenterId, label: g.label, servers: g.servers, inletCount: g.inletN, noInlet: g.noInlet,
    inletAvgC: g.inletN ? r1(g.inletSum / g.inletN) : null, inletMaxC: g.inletMax,
    cpuTempMaxC: g.cpuTempMax, gpuTempMaxC: g.gpuTempMax, warnSensors: g.warn, critSensors: g.crit,
  })).sort((a, b) => String(a.label).localeCompare(String(b.label), 'ko', { numeric: true }));
  const fresh = rows.filter((r) => r.detailState === 'ok');
  const vals = (f) => fresh.map(f).filter((v) => v != null);
  const inlets = vals((r) => r.summary?.inletC);
  const summary = {
    ...counts,
    inletAvgC: inlets.length ? r1(inlets.reduce((a, b) => a + b, 0) / inlets.length) : null,
    inletMaxC: inlets.length ? Math.max(...inlets) : null,
    inletCount: inlets.length,
    cpuTempMaxC: vals((r) => r.summary?.cpuTempMaxC).reduce((a, b) => (a == null || b > a ? b : a), null),
    gpuTempMaxC: vals((r) => r.summary?.gpuTempMaxC).reduce((a, b) => (a == null || b > a ? b : a), null),
  };
  return { rows, summary, byDatacenter };
}
