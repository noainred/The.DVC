/**
 * idrac/serverTrendSeries.js — iDRAC 통합 추이(CPU 사용률 · CPU 온도 · GPU 온도)를 metrics DB 에 적재한다(v2.660).
 *
 * 사용자 제공 핸드오프 `design_handoff_idrac_trend`(특수 기능 › iDRAC 통합 추이)의 서버 쪽. 왜 필요한가:
 * `sensorStore` 는 인메모리 24시간뿐이고 metrics DB 의 iDRAC 계열은 기본 `idractemp_max` 하나라서 CPU 사용률·GPU 온도의
 * 7일·30일·1년·기간 지정 조회를 할 수 없었다. `serverTempSeries.js`(v2.504)와 **같은 대상·같은 신선도 판정**으로
 * 샘플러가 1분마다 행을 만들고, 보관은 metrics 설정(원본 `rawRetentionDays` · 롤업 `retentionDays`)을 따른다.
 *
 * 계열(모두 서버 id 키):
 *   idracusage_cpu — Dell 텔레메트리 SystemUsage CPU %(없으면 행을 만들지 않는다). dead-band 없음(사용률은 전량 — deadband.js 규약).
 *   idractemp_cpu  — CPU 온도 최댓값(roomTemp.classifySensor 'cpu'). serverTempSeries 상세 모드와 **같은 메트릭명**.
 *   idractemp_gpu  — GPU 온도 최댓값(sensorDetail.roleOf 'gpu' — 센서 상세 화면과 같은 판정).
 *   두 온도는 dead-band 0.5℃ 정책이다(metrics/deadband.js). 소비 전력은 기존 전력 DB(idrac/db.js)에 있다 — 중복 적재하지 않는다.
 *
 * 계열 수(연간 롤업 행 — 원본은 보존 설정을 따른다): 서버 1,000대 기준 CPU 온도 876만 · GPU 온도는 GPU 서버 수 × 8,760 ·
 * CPU 사용률은 텔레메트리 보고 서버 수 × 8,760. 원본 CPU 사용률은 1분 전량이라 보고 서버 1대당 연 52.6만 행이다.
 *
 * 정직성: 결측은 **행을 만들지 않는다**(0 을 넣으면 '급냉'/'유휴' 로 보인다). 오래된 표본은 sampleStaleReason 으로 거른다.
 * 켜기/끄기: `IDRAC_TREND_SERIES=false` 로만 끈다(기본 켜짐).
 *   ⚠ `IDRAC_TEMP_SERIES_DETAIL=true` 면 serverTempSeries 가 idractemp_cpu 를 이미 적재한다 — 여기서는 건너뛴다(두 번 적재 금지).
 */
import { getSensorSeries, sensorPollCycle } from './sensorStore.js';
import { sampleStaleReason, serverTempKinds, TEMP_SERIES_DETAIL, idracTempMetric } from './serverTempSeries.js';
import { DEFAULT_MAX_AGE_MS } from './roomTemp.js';
import { roleOf } from './sensorDetail.js';
import { analysisServersWithRemote } from '../insights/analysisServers.js';
import { findHostByServiceTag } from './hostMatch.js';
import { store, usageReadable } from '../store.js';
import { cpuIndexOf } from '../tools/serverSensors.js';
import { cpuLatestRows } from '../bmusage/cpuLatest.js';
import { numOrNull } from '../util/numOrNull.js';

export const TREND_SERIES_ENABLED = process.env.IDRAC_TREND_SERIES !== 'false';
export const TREND_METRICS = Object.freeze({
  cpuPct: 'idracusage_cpu', cpuTemp: idracTempMetric('cpu'), gpuTemp: idracTempMetric('gpu'),
  // v2.661 — 흡기·배기(사용자 요청 "흡기/배기 온도 카드 추가"). ⚠ `idractemp_inlet`·`idractemp_exhaust` 는 상세 모드
  //   (IDRAC_TEMP_SERIES_DETAIL) 전용이고 dead-band 없이 전량 저장이다(기존 화면이 원본을 step 없이 읽는다 — v2.660 주석).
  //   그래서 이 화면은 **자기 계열**을 따로 두고 온도 dead-band(0.5℃)를 쓴다. 롤업 행은 서버당 연 8,760 × 2 가 더 늘고,
  //   흡기·배기는 천천히 변해 원본 행은 dead-band 로 크게 줄어든다. `IDRAC_TREND_AIRFLOW=false` 로 끈다.
  inletTemp: 'idractrend_inlet', exhaustTemp: 'idractrend_exhaust',
});
export const TREND_AIRFLOW_ENABLED = process.env.IDRAC_TREND_AIRFLOW !== 'false';
/**
 * v2.661 — CPU 사용률 대체 계열. Dell 텔레메트리(SystemUsage)는 **Datacenter 라이선스** 전용이라 Enterprise 현장에서는
 * `idracusage_cpu` 가 비었다(사용자 신고 "CPU 온도·GPU 온도는 나오는데 CPU 사용률은 안 나와"). 이미 수집 중인 값으로 채운다:
 *   idracusage_cpu_os — 베어메탈 사용률(bmusage — OS SSH·iDRAC Enterprise 대체 경로)의 최신 CPU %(v2.659 센서 상세와 같은 행)
 *   idracusage_cpu_vc — 가상화 호스트면 vCenter 가 보고한 ESXi 호스트 CPU %(서비스태그 일치 · 연결된 호스트 · 신선한 vCenter 만)
 * **한 서버·한 주기에 한 계열만** 적재한다(텔레메트리 > bmusage > vCenter). 출처가 다른 값을 한 계열에 섞지 않으므로
 * 조회가 버킷마다 어느 출처를 썼는지 밝힐 수 있다(`cpuSources`). 측정 방식이 달라 출처가 바뀌는 구간에서 값이 튈 수 있다.
 */
export const CPU_FALLBACK_METRICS = Object.freeze({ os: 'idracusage_cpu_os', vcenter: 'idracusage_cpu_vc' });
export const CPU_SOURCES = Object.freeze(['telemetry', 'os', 'vcenter']);

const pct = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null);

/** 최신 표본 → { cpuPct, cpuTemp, gpuTemp } (순수). temps 는 {name:℃} 객체. */
export function trendValuesOf(latest) {
  if (!latest || typeof latest !== 'object') return { cpuPct: null, cpuTemp: null, gpuTemp: null, inletTemp: null, exhaustTemp: null };
  const cpuPct = pct(latest.cpu) ?? pct(latest.cpuUsagePct);
  let gpuTemp = null;
  for (const [name, c] of Object.entries(latest.temps || {})) {
    if (typeof c !== 'number' || !Number.isFinite(c)) continue;
    if (roleOf({ name }) !== 'gpu') continue;
    if (gpuTemp == null || c > gpuTemp) gpuTemp = c;
  }
  const kinds = serverTempKinds(latest);
  return { cpuPct, cpuTemp: kinds.cpu ?? null, gpuTemp, inletTemp: kinds.inlet ?? null, exhaustTemp: kinds.exhaust ?? null };
}

/** 서버 목록 → metrics 행(순수 — 테스트로 고정). */
export function buildServerTrendRows(servers, {
  now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS, detail = TEMP_SERIES_DETAIL,
  latestOf = (s) => (s.remote ? s.sensors : getSensorSeries(s.id).latest),
  localCycle = sensorPollCycle(now),
  cpuIndex = null,          // bmusage 최신 행 색인(tools/serverSensors.js cpuIndexOf) — 없으면 그 대체를 쓰지 않는다
  hostCpuOf = () => null,   // (s) => 가상화 호스트 CPU %(신선·연결) | null
  airflow = TREND_AIRFLOW_ENABLED,
} = {}) {
  const rows = [];
  for (const s of servers || []) {
    const id = String(s?.id || '').trim();
    if (!id) continue;
    let latest = null;
    try { latest = latestOf(s); } catch { latest = null; }
    const stale = sampleStaleReason(latest, { now, maxAgeMs, remote: !!s.remote, localCycle });
    const v = stale ? { cpuPct: null, cpuTemp: null, gpuTemp: null, inletTemp: null, exhaustTemp: null } : trendValuesOf(latest);
    if (v.cpuPct != null) rows.push({ metric: TREND_METRICS.cpuPct, k: id, v: v.cpuPct });
    else {
      // 대체 CPU 는 iDRAC 표본의 신선도와 무관하다(각자 자기 출처의 신선도로 판정) — 센서가 끊긴 서버도 OS 값은 있을 수 있다.
      const os = bmCpuOf(s, cpuIndex, now);
      if (os != null) rows.push({ metric: CPU_FALLBACK_METRICS.os, k: id, v: os });
      else {
        let vc = null; try { vc = pct(hostCpuOf(s)); } catch { vc = null; }
        if (vc != null) rows.push({ metric: CPU_FALLBACK_METRICS.vcenter, k: id, v: vc });
      }
    }
    if (stale) continue;
    if (v.cpuTemp != null && !detail) rows.push({ metric: TREND_METRICS.cpuTemp, k: id, v: v.cpuTemp });
    if (v.gpuTemp != null) rows.push({ metric: TREND_METRICS.gpuTemp, k: id, v: v.gpuTemp });
    if (airflow && v.inletTemp != null) rows.push({ metric: TREND_METRICS.inletTemp, k: id, v: v.inletTemp });
    if (airflow && v.exhaustTemp != null) rows.push({ metric: TREND_METRICS.exhaustTemp, k: id, v: v.exhaustTemp });
  }
  return rows;
}

/** bmusage 최신 행 → 신선한 CPU %(서비스태그 → id → fleetId 순, 대소문자 무시) | null. 순수. */
export function bmCpuOf(s, cpuIndex, now = Date.now()) {
  if (!cpuIndex || typeof cpuIndex.get !== 'function') return null;
  for (const k of [s?.serviceTag, s?.id, s?.fleetId]) {
    const key = typeof k === 'string' ? k.trim().toLowerCase() : '';
    if (!key) continue;
    const row = cpuIndex.get(key);
    if (!row) continue;
    const v = pct(numOrNull(row.cpu_pct));
    const at = numOrNull(row.ts);
    const fresh = at != null && now - at <= (numOrNull(row._freshMs) || 30 * 60_000);
    if (v != null && fresh) return Math.round(v * 10) / 10;
  }
  return null;
}

/**
 * 서비스태그가 ESXi 호스트와 맞으면 그 호스트의 vCenter CPU %. `freshHosts` 는 샘플러가 낡은 vCenter(수집 실패 이월·
 * 위임 push 끊김·점검중)를 뺀 호스트 목록이다 — 그 밖의 호스트 값은 '지금 값' 이 아니라 쓰지 않는다(v2.620 SRV2620-03).
 */
export function hostCpuFrom(freshHosts) {
  const hosts = (freshHosts || []).filter((h) => h && usageReadable(h));
  return (s) => {
    const tag = String(s?.serviceTag || '').trim();
    if (!tag) return null;
    const h = findHostByServiceTag(tag, hosts);
    return h ? numOrNull(h.cpuUsagePct) : null;
  };
}

// bmusage 최신 행 캐시 — 샘플러는 1분 주기이고 조회는 비동기라, 직전 주기에 받은 색인을 쓰고 다음 것을 미리 받는다.
let _cpuIdx = null; let _cpuLoading = null;
function refreshCpuIndex() {
  if (_cpuLoading) return;
  _cpuLoading = cpuLatestRows().then((r) => { _cpuIdx = cpuIndexOf(r.rows || []); })
    .catch(() => { /* 대체값은 참고값 — 실패는 다음 주기에 다시 */ }).finally(() => { _cpuLoading = null; });
}

/** 샘플러가 호출(부수효과는 여기만). `freshHosts`: 낡은 vCenter 를 뺀 호스트(sampler.js). */
export function serverTrendRows({ freshHosts = null } = {}) {
  if (!TREND_SERIES_ENABLED) return [];
  refreshCpuIndex();
  const servers = analysisServersWithRemote();
  const hosts = freshHosts || (store.get()?.hosts || []);
  return servers?.length ? buildServerTrendRows(servers, { cpuIndex: _cpuIdx, hostCpuOf: hostCpuFrom(hosts) }) : [];
}
