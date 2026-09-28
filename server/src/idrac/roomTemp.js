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

import { getSensorSeries, sensorPollCycle } from './sensorStore.js';
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

/**
 * v2.634 — 신선도 경계를 **폴 주기 소요에 맞춰 넓힌다**(2026-09-28 사용자 신고 '측정 서버 0/980 · 미갱신 975').
 * 한 서버의 표본은 한 주기에 한 번 온다. 주기가 D 만큼 걸리고 간격이 I 면, 같은 서버의 두 표본 사이는
 * 최악 약 2D + I 다(주기 앞쪽에서 읽힌 서버가 다음 주기 뒤쪽에서 읽히는 경우). 경계가 그보다 짧으면
 * **정상 서버가 '미갱신' 으로 빠진다** — 대상이 많거나 불통 iDRAC 이 많아 주기가 15분을 넘는 현장에서
 * 실제로 전부가 빠졌다. 상한(기본 2시간)은 남긴다 — 죽은 서버의 마지막 온도를 무기한 '현재' 로 쓰지
 * 않는다는 v2.387 의 목적은 그대로다. 주기 정보가 없으면 기본 경계 그대로다(추측으로 넓히지 않는다).
 */
const capEnv = process.env.ROOMTEMP_STALE_CAP_MS == null || process.env.ROOMTEMP_STALE_CAP_MS === '' ? NaN : Number(process.env.ROOMTEMP_STALE_CAP_MS);
export const STALE_CYCLE_CAP_MS = Math.max(DEFAULT_MAX_AGE_MS, Number.isFinite(capEnv) && capEnv > 0 ? Math.min(capEnv, 24 * 3600_000) : 2 * 3600_000);

export function effectiveMaxAgeMs(base, cycle, cap = STALE_CYCLE_CAP_MS) {
  if (!(base > 0)) return base;              // 0 이하 = 호출부가 검사를 끈 것
  if (!cycle) return base;
  const d = Number(cycle.durationMs); const i = Number(cycle.intervalMs);
  const dur = Number.isFinite(d) && d > 0 ? d : 0;
  const itv = Number.isFinite(i) && i > 0 ? i : 0;
  if (!dur && !itv) return base;
  return Math.max(base, Math.min(Math.max(base, cap), 2 * dur + itv));
}

/**
 * 한 서버 표본에 쓸 주기 정보. 원격(엣지) 표본은 **엣지가 보낸 자기 주기**(`cycleMs`·`intervalMs`)만 쓴다 —
 * 중앙 폴러의 주기를 엣지 서버에 적용하면 뜻이 다른 값이다. 구버전 엣지(필드 없음)는 null → 기본 경계.
 */
export function cycleOfSample(latest, { remote = false, localCycle = null } = {}) {
  if (remote) {
    const d = Number(latest?.cycleMs);
    if (latest?.cycleMs == null || !Number.isFinite(d)) return null;
    const i = Number(latest?.intervalMs);
    return { durationMs: d, intervalMs: latest?.intervalMs != null && Number.isFinite(i) ? i : null };
  }
  return localCycle;
}

/** 표본 하나에 적용할 경계(순수 — 호출부가 now·localCycle 을 준다). */
export function sampleMaxAgeMs(base, latest, { remote = false, localCycle = null } = {}) {
  return effectiveMaxAgeMs(base, cycleOfSample(latest, { remote, localCycle }));
}

/*
 * v2.621(감사 DATA-04 — 코드상 성립, 실장비 미확인): HPE iLO(v2.610 부터 같은 폴러로 Thermal 수집)는 섀시 흡기
 *   ('01-Inlet Ambient') 외에 **전원공급장치 흡기**('32-P/S 1 Inlet' 류)를 노출하는 것으로 알려져 있다. 그것이 흡기로
 *   분류되면 종류별 최댓값 규칙 때문에 서버 대표 흡기가 PSU 내부 온도가 되어 ASHRAE 판정이 주의·고온으로 뒤집히고
 *   ΔT(배기−흡기)가 음수가 된다. 전원공급장치 센서는 머리말의 약속대로 other 로 세고 흡기·배기 판정에서 뺀다.
 *   Dell 명칭('System Board Inlet Temp'·'PSU1 Temp')의 분류는 바뀌지 않는다(테스트 고정). HPE 실장비 응답을 보면 좁힐 것.
 */
const PSU_SENSOR_RE = /\bp\/?s\s*\d|\bp\/s\b|\bpsu\d*\b|power\s*supply/i;

export function classifySensor(name) {
  const s = String(name || '');
  if (PSU_SENSOR_RE.test(s)) return 'other';
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
export function roomTempReport(servers, { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS, localCycle = sensorPollCycle(now) } = {}) {
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
  // v2.634: 빠진 표본의 나이 분포 — '전부 경계를 막 넘었다'(주기 문제)와 '오래전에 멈췄다'(죽은 서버)를 가른다.
  let staleNewest = null; let staleOldest = null; let staleNoTs = 0; let effMax = maxAgeMs; let widened = 0;
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
      // v2.634: 경계는 그 표본을 만든 폴러의 주기에 맞춘다(effectiveMaxAgeMs 머리말).
      const lim = sampleMaxAgeMs(maxAgeMs, latest, { remote: !!s.remote, localCycle });
      if (lim > effMax) effMax = lim;
      if (lim > maxAgeMs) widened += 1;
      if (latest?.t == null || !Number.isFinite(at) || now - at > lim) {
        g.staleCount += 1; staleTotal += 1;
        if (latest?.t == null || !Number.isFinite(at)) staleNoTs += 1;
        else {
          const age = now - at;
          if (staleNewest == null || age < staleNewest) staleNewest = age;
          if (staleOldest == null || age > staleOldest) staleOldest = age;
        }
        continue;
      }
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
    // v2.634: 주기가 길어 경계를 넓힌 경우 그 최대값과 넓힌 서버 수. 화면이 '15분' 이라 적고 실제로는
    //   더 긴 경계를 쓰면 거짓이 된다.
    staleMsMax: effMax,
    staleWidened: widened,
    pollCycle: localCycle ? {
      durationMs: localCycle.durationMs ?? null, intervalMs: localCycle.intervalMs ?? null,
      lastDurationMs: localCycle.lastDurationMs ?? null, runningForMs: localCycle.runningForMs ?? null,
    } : null,
    totals: {
      groups: list.length, servers: totalServers, withData, noSensor: noSensorTotal, stale: staleTotal,
      staleNewestAgeMs: staleNewest, staleOldestAgeMs: staleOldest, staleNoTimestamp: staleNoTs,
      inlet: finishAgg(all.inlet), exhaust: finishAgg(all.exhaust), cpu: finishAgg(all.cpu),
    },
    thresholds: { recommendMin: 18, recommendMax: 27, warnMax: 32 },
    groups: list,
  };
}
