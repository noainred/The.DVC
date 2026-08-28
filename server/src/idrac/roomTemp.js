/**
 * 법인 전산실 운영 온도(v2.382) — **vCenter(법인) 단위**로 흡기·배기·CPU 온도 범위를 종합한다.
 *
 * ⚠ v2.381 정정: 처음에는 iDRAC 레지스트리 + sensorStore(Redfish)를 소스로 썼는데, 운영에서는
 *   iDRAC 등록이 없거나 인메모리 링버퍼가 비어 화면이 전부 0/'—' 로 나왔다(사용자 보고).
 *   실제로 온도는 **vCenter 스냅샷의 호스트 필드**에 이미 들어 있다 —
 *   `soapClient.parseTemps` 가 numericSensorInfo(sensorType=temperature)에서
 *   `tempC`(ambient/inlet 우선), `tempMaxC`(최댓값), `temps:[{name,c}]`(최대 12개)를 만든다.
 *   그래서 이 모듈은 **스냅샷을 1차 소스**로 쓰고(모든 vCenter·전 호스트가 대상),
 *   iDRAC sensorStore 값이 있으면 같은 호스트에 **보강**한다(Redfish 는 센서 종류가 더 풍부).
 *
 * 집계 단위: vCenter(= 법인). 스냅샷 vcenters 목록의 name 을 그대로 쓴다.
 *
 * 센서 분류(이름 기반 — 벤더 표준 이름이 없어 정규식으로 판별)
 *  - inlet   : Inlet / Intake / Ambient / Front   → 전산실 급기 온도(ASHRAE 대역과 직접 비교)
 *  - exhaust : Exhaust / Outlet / Exit / Rear     → 배기 온도
 *  - cpu     : CPU / CPU1 / Proc / Package / Die  → 프로세서 온도
 *  그 외(메모리·PSU·보드 등)는 other 로 세기만 하고 집계에서 제외한다.
 *
 * 정직성 규칙
 *  - 값이 없는 종류는 null(화면 '—'). 0 이나 추정값을 만들지 않는다.
 *  - temps 배열이 없고 tempC 만 있는 호스트는 **tempC 를 흡기로만** 인정한다
 *    (parseTemps 가 ambient/inlet 우선으로 고른 값이라 근거가 있다). 배기·CPU 는 미상.
 *  - 센서가 전혀 없는 호스트는 집계에서 빼고 그 수를 표기한다.
 */

import { getSensorSeries } from './sensorStore.js';
import { loadRegistry } from './registry.js';

/** 센서 이름 → 종류. 'CPU Inlet' 처럼 겹치면 inlet 이 우선(급기 판정이 더 중요). */
export function classifySensor(name) {
  const s = String(name || '');
  if (/inlet|intake|ambient|front/i.test(s)) return 'inlet';
  if (/exhaust|outlet|exit|rear/i.test(s)) return 'exhaust';
  // \bcpu\b 는 'CPU1 Temp'(숫자가 붙은 실제 센서명)를 놓친다 — cpu 뒤 숫자를 허용한다.
  if (/cpu\s*\d*/i.test(s) || /proc|package|\bdie\b|\bcore\b/i.test(s)) return 'cpu';
  return 'other';
}

/** ASHRAE A1 권장 급기 18~27℃ 기준 상태(흡기에만 의미). */
export function inletStatus(c) {
  if (c == null) return null;
  if (c < 15) return 'cold';
  if (c <= 18) return 'lowok';
  if (c <= 27) return 'ok';
  if (c <= 32) return 'warn';
  return 'hot';
}

const emptyAgg = () => ({ min: null, max: null, sum: 0, n: 0, servers: 0 });
function addAgg(a, c) {
  if (c == null || !Number.isFinite(c)) return;
  if (a.min == null || c < a.min) a.min = c;
  if (a.max == null || c > a.max) a.max = c;
  a.sum += c; a.n += 1;
}
const finishAgg = (a) => ({
  min: a.min, max: a.max,
  avg: a.n ? Math.round((a.sum / a.n) * 10) / 10 : null,
  count: a.n, servers: a.servers,
  range: a.min != null && a.max != null ? Math.round((a.max - a.min) * 10) / 10 : null,
});

/** iDRAC sensorStore 에서 이 호스트에 해당하는 최신 센서맵(있으면). 이름·IP 로 매칭. */
function idracSensorsFor(host, idracIndex) {
  if (!idracIndex.size) return null;
  const keys = [
    String(host.name || '').toLowerCase(),
    String(host.name || '').split('.')[0].toLowerCase(),   // FQDN → 짧은 이름
    String(host.managementIp || host.ip || '').trim(),
  ].filter(Boolean);
  for (const k of keys) {
    const id = idracIndex.get(k);
    if (!id) continue;
    const latest = getSensorSeries(id, { minutes: 60 })?.latest;
    if (latest && latest.temps && Object.keys(latest.temps).length) return latest.temps;
  }
  return null;
}

/** iDRAC 레지스트리 인덱스(이름/짧은이름/호스트 → serverId). 등록이 없으면 빈 Map. */
function buildIdracIndex() {
  const idx = new Map();
  try {
    for (const s of loadRegistry()) {
      if (s.type === 'ome' || s.enabled === false) continue;
      for (const k of [s.name, String(s.name || '').split('.')[0], s.host, s.serviceTag]) {
        const key = String(k || '').trim().toLowerCase();
        if (key && !idx.has(key)) idx.set(key, s.id);
      }
    }
  } catch { /* 레지스트리 없음 — 스냅샷만 사용 */ }
  return idx;
}

/**
 * vCenter(법인)별 온도 종합.
 * @param {object} snap store 스냅샷
 * @param {{ allowedVcenterIds?: Set<string>|null }} opts scope(null=무제한)
 */
export function roomTempReport(snap, { allowedVcenterIds = null, now = Date.now() } = {}) {
  const vcName = new Map((snap?.vcenters || []).map((v) => [String(v.id), v.name || v.id]));
  const idracIndex = buildIdracIndex();

  const groups = new Map();
  const bucket = (id) => {
    const key = String(id || '');
    let g = groups.get(key);
    if (!g) {
      g = {
        id: key, name: key ? (vcName.get(key) || key) : '(미지정)',
        inlet: emptyAgg(), exhaust: emptyAgg(), cpu: emptyAgg(),
        hosts: [], hostCount: 0, noSensorCount: 0, otherSensorCount: 0, idracBoosted: 0,
      };
      groups.set(key, g);
    }
    return g;
  };

  let totalHosts = 0; let withData = 0; let idracBoostedTotal = 0;
  const all = { inlet: emptyAgg(), exhaust: emptyAgg(), cpu: emptyAgg() };

  for (const h of snap?.hosts || []) {
    if (allowedVcenterIds && !allowedVcenterIds.has(h.vcenterId)) continue;
    totalHosts += 1;
    const g = bucket(h.vcenterId);
    g.hostCount += 1;

    // 1) 스냅샷 센서 배열(주 소스) — soapClient.parseTemps 가 채운다.
    const per = { inlet: null, exhaust: null, cpu: null };
    let other = 0; let sensorSeen = 0;
    const take = (name, c) => {
      if (typeof c !== 'number' || !Number.isFinite(c)) return;
      sensorSeen += 1;
      const kind = classifySensor(name);
      if (kind === 'other') { other += 1; return; }
      // 같은 종류가 여럿이면(CPU1·CPU2 등) 가장 높은 값을 대표값으로.
      if (per[kind] == null || c > per[kind]) per[kind] = c;
    };
    for (const t of h.temps || []) take(t.name, t.c);

    // 2) iDRAC Redfish 센서로 보강(등록·수집이 있는 호스트만) — 종류가 더 풍부하다.
    const idracTemps = idracSensorsFor(h, idracIndex);
    if (idracTemps) {
      const before = { ...per };
      for (const [name, c] of Object.entries(idracTemps)) take(name, c);
      if (before.inlet !== per.inlet || before.exhaust !== per.exhaust || before.cpu !== per.cpu) {
        g.idracBoosted += 1; idracBoostedTotal += 1;
      }
    }

    // 3) 센서 배열이 없는 호스트: tempC 는 parseTemps 가 ambient/inlet 우선으로 고른 값이라
    //    **흡기로만** 인정한다(배기·CPU 로 추정하지 않는다).
    if (per.inlet == null && typeof h.tempC === 'number') { per.inlet = h.tempC; sensorSeen += 1; }

    g.otherSensorCount += other;
    if (per.inlet == null && per.exhaust == null && per.cpu == null) {
      if (!sensorSeen) g.noSensorCount += 1;
      continue;
    }
    withData += 1;
    for (const k of ['inlet', 'exhaust', 'cpu']) {
      if (per[k] == null) continue;
      addAgg(g[k], per[k]); g[k].servers += 1;
      addAgg(all[k], per[k]); all[k].servers += 1;
    }
    g.hosts.push({
      id: h.id, name: h.name || h.id, cluster: h.cluster || '', model: h.model || '',
      inlet: per.inlet, exhaust: per.exhaust, cpu: per.cpu,
      deltaT: per.inlet != null && per.exhaust != null ? Math.round((per.exhaust - per.inlet) * 10) / 10 : null,
      source: idracTemps ? 'vcenter+idrac' : 'vcenter',
    });
  }

  const list = [...groups.values()].map((g) => {
    const ds = g.hosts.map((x) => x.deltaT).filter((x) => x != null);
    return {
      id: g.id, name: g.name,
      hostCount: g.hostCount, noSensorCount: g.noSensorCount, otherSensorCount: g.otherSensorCount,
      idracBoosted: g.idracBoosted,
      inlet: finishAgg(g.inlet), exhaust: finishAgg(g.exhaust), cpu: finishAgg(g.cpu),
      deltaAvg: ds.length ? Math.round((ds.reduce((a, b) => a + b, 0) / ds.length) * 10) / 10 : null,
      status: inletStatus(finishAgg(g.inlet).max),   // 가장 더운 흡기로 보수적 판정
      hosts: g.hosts.sort((a, b) => (b.inlet ?? -1) - (a.inlet ?? -1)).slice(0, 200),
    };
  }).sort((a, b) => (b.inlet.max ?? -999) - (a.inlet.max ?? -999) || a.name.localeCompare(b.name));

  return {
    generatedAt: now,
    source: 'vcenter-snapshot',      // 화면이 데이터 출처를 밝힐 수 있게
    totals: {
      vcenters: list.length, hosts: totalHosts, withData,
      noSensor: totalHosts - withData, idracBoosted: idracBoostedTotal,
      inlet: finishAgg(all.inlet), exhaust: finishAgg(all.exhaust), cpu: finishAgg(all.cpu),
    },
    thresholds: { recommendMin: 18, recommendMax: 27, warnMax: 32 },
    vcenters: list,
  };
}
