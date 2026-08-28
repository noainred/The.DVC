/**
 * 법인 전산실 운영 온도(v2.381) — iDRAC 온도센서를 **법인(DataCenter)별로 종합**해
 * 한 페이지에서 흡기(inlet)·배기(exhaust)·CPU 세 가지의 범위(min~max)와 평균을 보여준다.
 *
 * 데이터 출처: iDRAC 폴러가 Redfish Thermal 에서 받아 sensorStore(인메모리 링버퍼, 최근 24시간)에
 * 넣는 서버별 센서맵. 추가 HTTP 호출을 하지 않는다(이미 수집된 값을 재사용).
 *
 * 센서 분류(이름 기반) — 벤더가 표준 이름을 주지 않아 정규식으로 판별한다:
 *  - inlet   : Inlet / Intake / Ambient  → 전산실 공급(급기) 온도. **가장 중요한 지표**
 *              (ASHRAE 권고 대역과 직접 비교 가능).
 *  - exhaust : Exhaust / Outlet / Exit   → 배기 온도. inlet 과의 차(ΔT)가 크면 부하·풍량 문제.
 *  - cpu     : CPU / Proc / Package / Die → 프로세서 다이 온도.
 *  이 셋 중 어디에도 안 맞는 센서(메모리·PSU·보드 등)는 **other 로 세기만 하고 집계에 넣지
 *  않는다** — 성격이 다른 센서를 섞으면 '전산실 온도' 의미가 무너진다.
 *
 * 정직성 규칙(허수 금지)
 *  - 값이 없는 종류는 null 로 두고 화면이 '—' 로 표시한다(0 이나 추정값을 만들지 않는다).
 *  - 표본이 오래된 서버(기본 15분 초과)는 stale 로 세고 집계에서 제외한다 — 죽은 서버의
 *    마지막 온도가 현재 범위처럼 보이면 안 된다.
 *  - 법인 귀속이 없는 서버는 '(미지정)' 그룹으로 따로 묶는다(임의 배정 금지).
 */

import { loadRegistry } from './registry.js';
import { getSensorSeries } from './sensorStore.js';
import { listDatacenters } from '../datacenter/store.js';

/** 센서 이름 → 종류. 우선순위 주의: 'CPU Inlet' 같은 이름은 inlet 으로 잡아야 한다. */
export function classifySensor(name) {
  const s = String(name || '');
  if (/inlet|intake|ambient/i.test(s)) return 'inlet';
  if (/exhaust|outlet|exit/i.test(s)) return 'exhaust';
  // ⚠ \bcpu\b 를 쓰면 실제 Dell 생서명 'CPU1 Temp'·'CPU2' 가 걸리지 않는다
  // (1 이 단어문자라 경계가 성립하지 않음 — 검증에서 실제로 분류 실패를 잡았다).
  // 'cpu' 뒤 숫자를 허용하고, die/core 는 단어 경계로 둔다('Diode'·'Corner' 오팡 방지).
  if (/cpu\s*\d*/i.test(s) || /proc|package|\bdie\b|\bcore\b/i.test(s)) return 'cpu';
  return 'other';
}

/** ASHRAE A1 권장 급기 온도(18~27℃) 기준 상태 판정 — inlet 에만 의미가 있다. */
export function inletStatus(c) {
  if (c == null) return null;
  if (c < 15) return 'cold';        // 과냉(에너지 낭비)
  if (c <= 18) return 'lowok';      // 권장 하단 근접
  if (c <= 27) return 'ok';         // ASHRAE A1 권장 대역
  if (c <= 32) return 'warn';       // 허용 상단 — 개선 필요
  return 'hot';                     // 위험
}

const STALE_MS = Number(process.env.ROOMTEMP_STALE_MS) || 15 * 60_000;

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

/**
 * 법인별 온도 종합.
 * @param {{ now?: number, allowedVcenterIds?: Set<string>|null }} opts
 *   allowedVcenterIds: 사용자 scope — 범위 밖 vCenter 귀속 서버는 제외(null=무제한).
 */
export function roomTempReport({ now = Date.now(), allowedVcenterIds = null } = {}) {
  const dcs = listDatacenters();
  const dcName = new Map(dcs.map((d) => [String(d.id), d.name || d.id]));

  const groups = new Map(); // dcKey -> { id, name, inlet, exhaust, cpu, servers[], stale, noSensor, otherSensors }
  const bucket = (id) => {
    const key = String(id || '');
    let g = groups.get(key);
    if (!g) {
      g = {
        id: key, name: key ? (dcName.get(key) || key) : '(미지정)',
        inlet: emptyAgg(), exhaust: emptyAgg(), cpu: emptyAgg(),
        servers: [], serverCount: 0, staleCount: 0, noSensorCount: 0, otherSensorCount: 0,
      };
      groups.set(key, g);
    }
    return g;
  };

  let totalServers = 0; let withData = 0; let staleTotal = 0;
  const all = { inlet: emptyAgg(), exhaust: emptyAgg(), cpu: emptyAgg() };

  for (const s of loadRegistry()) {
    if (s.type === 'ome') continue;                  // OME 는 관리 콘솔(자체 센서 아님)
    if (s.enabled === false) continue;
    // scope: 범위 제한 계정에는 허용 vCenter 에 귀속된 서버만.
    if (allowedVcenterIds) {
      const vc = String(s.vcenterId || '').trim();
      if (!vc || !allowedVcenterIds.has(vc)) continue;
    }
    totalServers += 1;
    const g = bucket(s.datacenterId);
    g.serverCount += 1;

    const series = getSensorSeries(s.id, { minutes: 0 });
    const latest = series.latest;
    if (!latest || !latest.temps || !Object.keys(latest.temps).length) { g.noSensorCount += 1; continue; }
    // 오래된 표본은 제외 — 죽은 서버의 마지막 온도를 '현재'로 보여주지 않는다.
    if (now - (latest.t || 0) > STALE_MS) { g.staleCount += 1; staleTotal += 1; continue; }

    // 서버 1대 안에서도 같은 종류 센서가 여러 개일 수 있다(CPU1/CPU2 등) → 종류별 대표값:
    // inlet/exhaust 는 최댓값(가장 더운 쪽이 운영 기준), cpu 도 최댓값(피크가 관심사).
    const per = { inlet: null, exhaust: null, cpu: null };
    let other = 0;
    for (const [name, c] of Object.entries(latest.temps)) {
      if (typeof c !== 'number') continue;
      const kind = classifySensor(name);
      if (kind === 'other') { other += 1; continue; }
      if (per[kind] == null || c > per[kind]) per[kind] = c;
    }
    g.otherSensorCount += other;
    if (per.inlet == null && per.exhaust == null && per.cpu == null) { g.noSensorCount += 1; continue; }

    withData += 1;
    for (const k of ['inlet', 'exhaust', 'cpu']) {
      if (per[k] == null) continue;
      addAgg(g[k], per[k]); g[k].servers += 1;
      addAgg(all[k], per[k]); all[k].servers += 1;
    }
    g.servers.push({
      id: s.id, name: s.name || s.host || s.id, host: s.host || '',
      vcenterId: s.vcenterId || '', model: s.model || '',
      inlet: per.inlet, exhaust: per.exhaust, cpu: per.cpu,
      deltaT: per.inlet != null && per.exhaust != null ? Math.round((per.exhaust - per.inlet) * 10) / 10 : null,
      at: latest.t,
    });
  }

  const list = [...groups.values()].map((g) => ({
    id: g.id, name: g.name,
    serverCount: g.serverCount, staleCount: g.staleCount, noSensorCount: g.noSensorCount,
    otherSensorCount: g.otherSensorCount,
    inlet: finishAgg(g.inlet), exhaust: finishAgg(g.exhaust), cpu: finishAgg(g.cpu),
    // ΔT(배기−흡기) 평균 — 냉각 효율의 실무 지표.
    deltaAvg: (() => {
      const ds = g.servers.map((x) => x.deltaT).filter((x) => x != null);
      return ds.length ? Math.round((ds.reduce((a, b) => a + b, 0) / ds.length) * 10) / 10 : null;
    })(),
    status: inletStatus(finishAgg(g.inlet).max),   // 법인 상태는 **가장 더운 흡기**로 판정(보수적)
    servers: g.servers.sort((a, b) => (b.inlet ?? -1) - (a.inlet ?? -1)),
  }))
    // 정렬: 흡기 최고가 높은 법인 먼저(문제 있는 곳이 위로), 데이터 없는 법인은 뒤로.
    .sort((a, b) => (b.inlet.max ?? -999) - (a.inlet.max ?? -999) || a.name.localeCompare(b.name));

  return {
    generatedAt: now,
    staleMs: STALE_MS,
    totals: {
      datacenters: list.length, servers: totalServers, withData, stale: staleTotal,
      inlet: finishAgg(all.inlet), exhaust: finishAgg(all.exhaust), cpu: finishAgg(all.cpu),
    },
    thresholds: { recommendMin: 18, recommendMax: 27, warnMax: 32 },
    datacenters: list,
  };
}
