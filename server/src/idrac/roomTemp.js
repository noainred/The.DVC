/**
 * 법인 전산실 운영 온도(v2.383) — 흡기·배기·CPU 온도를 **법인(DataCenter)별로 종합**한다.
 *
 * ⚠ 데이터 소스 확정 경위(같은 실수 반복 금지)
 *  - v2.381: iDRAC 레지스트리 + sensorStore 만 봤다 → 위임(엣지) 환경에서 전부 빈 화면.
 *  - v2.382: vCenter 스냅샷 host.temps 로 바꿨다 → 이 환경의 ESXi 는 numericSensorInfo 를
 *            주지 않아 여전히 빈 화면.
 *  - v2.383(현재): **서버 분석 › 법인별 온도(/admin/idrac/temps)와 완전히 같은 소스**를 쓴다 —
 *    `analysisServersWithRemote(req)`(중앙 로컬 + 위임 엣지 병합, datacenterId 해석 포함)와
 *    `s.remote ? s.sensors : getSensorSeries(s.id).latest`. 그 화면은 실제로 서버 864/965·
 *    센서 3,747개를 보여주고 있으므로(사용자 스크린샷) 이 소스에는 데이터가 확실히 있다.
 *
 * 집계 단위: **법인(DataCenter)**. datacenterId 가 없으면 vCenter 로, 그것도 없으면 '(미지정)'.
 * (위임 환경에서는 서버의 vcenterId 가 비어 있는 경우가 많아 DataCenter 를 1순위로 둔다 —
 *  스크린샷의 VCENTER 열이 대부분 '—' 인 것과 일치.)
 *
 * 센서 분류(이름 기반)
 *  - inlet   : Inlet / Intake / Ambient / Front  → 급기(전산실) 온도. ASHRAE 대역과 직접 비교.
 *  - exhaust : Exhaust / Outlet / Exit / Rear    → 배기 온도.
 *  - cpu     : CPU / CPU1 / Proc / Package / Die → 프로세서 온도(실제 센서명이 'CPU1 Temp').
 *  그 외(DIMM·PSU·보드 등)는 other 로 세기만 하고 집계에서 제외한다.
 */

import { getSensorSeries } from './sensorStore.js';
import { listDatacenters } from '../datacenter/store.js';

/**
 * 법인 귀속이 없는 서버 그룹의 **예약 키**(v2.387).
 * 이전에는 빈 문자열('')을 썼는데, 시계열 적재에서 '전체 합계' 키도 '' 라 두 계열이 같은
 * (metric, k) 에 섞여 적재됐다(samples 는 무제약, samples_hourly upsert 는 n 누적 → 평균 왜곡).
 * 전체 합계는 '' 를 유지하고 미지정 그룹만 이 예약키로 분리한다.
 */
export const UNASSIGNED_KEY = '__unassigned__';

/**
 * 센서 표본의 신선도 상한 기본값(v2.387) — 이보다 오래된 표본은 집계에서 제외한다.
 * 이유: sensorStore 링버퍼는 개수(1440)로만 자르고 시간 만료가 없고, 원격(엣지) 인벤토리도
 * "실패한 pull 은 마지막 스냅샷을 유지" 정책이라, 죽은 서버/수집기의 마지막 온도가 무기한
 * latest 로 남는다. 그것을 '현재값'으로 집계하고 매 분 시계열에 새 타임스탬프로 재적재하면
 * 차트가 동결값 평탄선이 되어 실제 급등을 은폐한다(전력의 POWER_CURRENT_STALE_MS 와 같은 취지).
 */
export const DEFAULT_MAX_AGE_MS = Number(process.env.ROOMTEMP_STALE_MS) || 15 * 60_000;

export function classifySensor(name) {
  const s = String(name || '');
  if (/inlet|intake|ambient|front/i.test(s)) return 'inlet';
  if (/exhaust|outlet|exit|rear/i.test(s)) return 'exhaust';
  // \bcpu\b 는 'CPU1 Temp'(숫자 접미) 를 놓친다 — cpu 뒤 숫자를 허용한다(실측으로 확인).
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

/**
 * @param {Array} servers analysisServersWithRemote(req) 결과 — 로컬+원격 병합, datacenterId 해석됨
 * @param {{ now?: number }} opts
 *
 * servers 를 **주입받는다**(라우트가 shared.js 헬퍼로 만들어 넘김) — 이 모듈이 req 를 몰라도
 * 되고, 테스트에서 실데이터 모양만 맞춰 검증할 수 있다.
 */
export function roomTempReport(servers, { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  let dcName = new Map();
  try { dcName = new Map(listDatacenters().map((d) => [String(d.id), d.name || d.id])); } catch { /* 목록 없음 */ }

  const groups = new Map();
  const bucket = (key, label) => {
    const k = String(key || '');
    let g = groups.get(k);
    if (!g) {
      g = {
        id: k, name: label || (k ? (dcName.get(k) || k) : '(미지정)'),
        inlet: emptyAgg(), exhaust: emptyAgg(), cpu: emptyAgg(),
        hosts: [], hostCount: 0, noSensorCount: 0, otherSensorCount: 0, remoteCount: 0, staleCount: 0,
      };
      groups.set(k, g);
    }
    return g;
  };

  let totalServers = 0; let withData = 0; let noSensorTotal = 0; let staleTotal = 0;
  const all = { inlet: emptyAgg(), exhaust: emptyAgg(), cpu: emptyAgg() };

  for (const s of servers || []) {
    totalServers += 1;
    // 그룹 키: DataCenter 1순위 → vCenter → (미지정). 위임 환경은 vcenterId 가 빈 경우가 많다.
    const dcId = String(s.datacenterId || '').trim();
    const vcId = String(s.vcenterId || '').trim();
    const g = dcId ? bucket(dcId) : (vcId ? bucket(vcId, vcId) : bucket(UNASSIGNED_KEY, '(미지정)'));
    g.hostCount += 1;
    if (s.remote) g.remoteCount += 1;

    // /admin/idrac/temps 와 동일: 원격은 export 로 받은 s.sensors, 로컬은 sensorStore 최신값.
    const latest = s.remote ? s.sensors : getSensorSeries(s.id).latest;
    const temps = latest?.temps || {};
    const names = Object.keys(temps);
    if (!names.length) { g.noSensorCount += 1; noSensorTotal += 1; continue; }
    // 오래된 표본 제외(v2.387) — 죽은 서버의 마지막 온도를 '현재'로 쓰지 않는다.
    // maxAgeMs<=0 이면 검사하지 않는다(호출부가 명시적으로 끈 경우).
    // 타임스탬프가 아예 없는 표본은 나이를 알 수 없어 stale 로 취급한다(추정으로 통과시키지 않음).
    if (maxAgeMs > 0) {
      const at = Number(latest?.t);
      if (!Number.isFinite(at) || now - at > maxAgeMs) { g.staleCount += 1; staleTotal += 1; continue; }
    }

    const per = { inlet: null, exhaust: null, cpu: null };
    let other = 0;
    for (const name of names) {
      const c = Number(temps[name]);
      if (!Number.isFinite(c)) continue;
      const kind = classifySensor(name);
      if (kind === 'other') { other += 1; continue; }
      // 같은 종류가 여럿이면(CPU1·CPU2) 가장 높은 값을 그 서버의 대표값으로.
      if (per[kind] == null || c > per[kind]) per[kind] = c;
    }
    g.otherSensorCount += other;
    if (per.inlet == null && per.exhaust == null && per.cpu == null) { g.noSensorCount += 1; noSensorTotal += 1; continue; }

    withData += 1;
    for (const k of ['inlet', 'exhaust', 'cpu']) {
      if (per[k] == null) continue;
      addAgg(g[k], per[k]); g[k].servers += 1;
      addAgg(all[k], per[k]); all[k].servers += 1;
    }
    g.hosts.push({
      id: s.id, name: s.name || s.id, serviceTag: s.serviceTag || '',
      vcenterId: vcId, remote: !!s.remote,
      inlet: per.inlet, exhaust: per.exhaust, cpu: per.cpu,
      deltaT: per.inlet != null && per.exhaust != null ? Math.round((per.exhaust - per.inlet) * 10) / 10 : null,
      at: latest.t || null,
    });
  }

  const list = [...groups.values()].map((g) => {
    const ds = g.hosts.map((x) => x.deltaT).filter((x) => x != null);
    return {
      id: g.id, name: g.name,
      hostCount: g.hostCount, noSensorCount: g.noSensorCount, otherSensorCount: g.otherSensorCount,
      remoteCount: g.remoteCount, staleCount: g.staleCount,
      inlet: finishAgg(g.inlet), exhaust: finishAgg(g.exhaust), cpu: finishAgg(g.cpu),
      deltaAvg: ds.length ? Math.round((ds.reduce((a, b) => a + b, 0) / ds.length) * 10) / 10 : null,
      status: inletStatus(finishAgg(g.inlet).max),
      hosts: g.hosts.sort((a, b) => (b.inlet ?? -1) - (a.inlet ?? -1)).slice(0, 300),
    };
  }).sort((a, b) => (b.inlet.max ?? -999) - (a.inlet.max ?? -999) || a.name.localeCompare(b.name));

  return {
    generatedAt: now,
    source: 'idrac-analysis',   // /admin/idrac/temps 와 같은 소스임을 화면이 밝힐 수 있게
    staleMs: maxAgeMs,          // 화면이 '몇 분 이상 미갱신을 제외했는지' 정직하게 표기하도록
    totals: {
      groups: list.length, servers: totalServers, withData, noSensor: noSensorTotal, stale: staleTotal,
      inlet: finishAgg(all.inlet), exhaust: finishAgg(all.exhaust), cpu: finishAgg(all.cpu),
    },
    thresholds: { recommendMin: 18, recommendMax: 27, warnMax: 32 },
    groups: list,
  };
}
