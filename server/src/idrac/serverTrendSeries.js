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
import { roleOf, summarizeSensors, expandCompact, SENSOR_COLLECTION_FRESH_MS, collectionCpuJudge } from './sensorDetail.js';
import { localSensorDetail, localCpuSensorDetail } from './sensorDetailCache.js';
import { analysisServersWithRemote, invForServer } from '../insights/analysisServers.js';
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
 * v2.665 — CPU 사용률은 **iDRAC 에서 온 값만** 쓴다(사용자 지시 "vcenter 에서 가져오지 말고 idarc 에서 가져오는걸로 수정해줘").
 * v2.661~2.664 는 Dell 텔레메트리(SystemUsage — Datacenter 라이선스 전용)가 없으면 bmusage(OS SSH 포함)와 vCenter ESXi 호스트
 * 값으로 채웠는데, 이 화면은 'iDRAC 통합 추이' 이고 출처가 다른 숫자가 섞이면 같은 서버의 다른 iDRAC 지표와 시각·의미가 맞지 않는다.
 * 순서(한 서버·한 주기에 한 계열만 적재):
 *   idracusage_cpu     — 텔레메트리 SystemUsage(1분 폴)
 *   idracusage_cpu_rs  — iDRAC Sensors 컬렉션의 CPU 사용률 센서(인벤토리 주기 — 기본 30분, `SENSOR_CPU_FRESH_MS` 안의 값만)
 *   idracusage_cpu_bm  — 베어메탈 사용률의 **iDRAC 경로 값만**(행의 출처 `src` 에 'os' 가 없는 것 — Enterprise 대체 경로 포함)
 * 어느 것도 없으면 **행을 만들지 않는다**(빈칸이 정직하다 — 화면이 이유를 말한다).
 * ⚠ 예전 계열 `idracusage_cpu_os`·`idracusage_cpu_vc`(`CPU_RETIRED_METRICS`)는 더 이상 쓰지도 읽지도 않는다 — `_os` 는 OS 값과
 *   iDRAC 값이 섞여 있어 나중에 가를 수 없다. 행은 보존 설정에 따라 저절로 지워진다.
 */
export const CPU_FALLBACK_METRICS = Object.freeze({ sensor: 'idracusage_cpu_rs', bmIdrac: 'idracusage_cpu_bm' });
export const CPU_RETIRED_METRICS = Object.freeze({ os: 'idracusage_cpu_os', vcenter: 'idracusage_cpu_vc' });
export const CPU_SOURCES = Object.freeze(['telemetry', 'sensor', 'bmIdrac']);
/** Sensors 컬렉션은 인벤토리 주기(30분)로 읽는다 — 센서 상세 화면과 같은 75분을 '지금 값' 의 경계로 쓴다(v2.680: 값의 소유는 sensorDetail.js). */
export const SENSOR_CPU_FRESH_MS = SENSOR_COLLECTION_FRESH_MS;

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
  cpuIndex = null,          // bmusage 최신 행 색인(tools/serverSensors.js cpuIndexOf) — 없으면 그 경로를 쓰지 않는다
  detailOf = sensorCpuDetailOf, // (s) => { list, collAt } | null — iDRAC Sensors 컬렉션(v2.680 E-01: CPU 판정엔 퍼센트 센서만 펼친다)
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
      // 텔레메트리가 없으면 iDRAC 의 다른 경로만 본다 — 각자 자기 수집 시각으로 신선도를 판정한다.
      const sc = sensorCpuOf(s, { now, detailOf });
      if (sc.v != null) rows.push({ metric: CPU_FALLBACK_METRICS.sensor, k: id, v: sc.v });
      else {
        const bm = bmCpuOf(s, cpuIndex, now, { idracOnly: true });
        if (bm != null) rows.push({ metric: CPU_FALLBACK_METRICS.bmIdrac, k: id, v: bm });
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

/**
 * bmusage 행의 출처가 iDRAC 뿐인가(순수). `src` 는 지표별 출처의 합집합('os+idrac' 등 — bmusage/usage.js)이고 CPU 는
 * os > idrac > idrac-ent 순으로 고르므로, 'os' 가 들어 있으면 CPU 가 OS 값일 수 있다 → iDRAC 값으로 보지 않는다.
 * 출처를 모르는 행(빈 src)도 쓰지 않는다(지어내지 않는다).
 */
export function bmSrcIsIdrac(src) {
  const toks = String(src || '').split('+').map((t) => t.trim()).filter(Boolean);
  return toks.length > 0 && !toks.includes('os') && toks.some((t) => t === 'idrac' || t === 'idrac-ent');
}

/** bmusage 최신 행 → 신선한 CPU %(서비스태그 → id → fleetId 순, 대소문자 무시) | null. 순수. `idracOnly` 면 iDRAC 출처 행만. */
export function bmCpuOf(s, cpuIndex, now = Date.now(), { idracOnly = false } = {}) {
  const r = bmCpuRowOf(s, cpuIndex, now);
  if (!r || !r.fresh) return null;
  if (idracOnly && !bmSrcIsIdrac(r.src)) return null;
  return r.v;
}

/** bmusage 최신 행 요약 { v, at, fresh, src } | null(진단용 — 값이 있는 첫 키). */
export function bmCpuRowOf(s, cpuIndex, now = Date.now()) {
  if (!cpuIndex || typeof cpuIndex.get !== 'function') return null;
  let tag = s?.serviceTag; try { tag = serviceTagOf(s) || tag; } catch { /* 인벤토리 조회 실패 — 최상위 값만 */ }
  for (const k of [tag, s?.id, s?.fleetId]) {
    const key = typeof k === 'string' ? k.trim().toLowerCase() : '';
    if (!key) continue;
    const row = cpuIndex.get(key);
    if (!row) continue;
    const v = pct(numOrNull(row.cpu_pct));
    if (v == null) continue;
    const at = numOrNull(row.ts);
    const fresh = at != null && now - at <= (numOrNull(row._freshMs) || 30 * 60_000);
    return { v: Math.round(v * 10) / 10, at, fresh, src: String(row.src || '') };
  }
  return null;
}

/**
 * 서버의 iDRAC Sensors 컬렉션 → { list, collAt } | null. 로컬은 sensorDetailCache, 엣지 서버는 export 의 콤팩트 목록을 되돌린다.
 * CPU 사용률 센서는 컬렉션에서만 오므로 시각도 컬렉션 시각(sensorsAt/collAt)이다(Thermal 시각을 쓰면 낡은 값이 신선해 보인다).
 */
export function sensorDetailOf(s) {
  if (s?.remote) {
    const d = s.sensorDetail;
    if (!d || !Array.isArray(d.list)) return null;
    return { list: d.list.map(expandCompact).filter(Boolean), collAt: numOrNull(d.collAt) };
  }
  const d = localSensorDetail(String(s?.id || ''));
  if (!d) return null;
  return { list: d.list || [], collAt: numOrNull(d.collection?.sensorsAt) };
}

/**
 * v2.680 E-01: CPU 사용률 판정 전용 상세 — `sensorDetailOf` 와 같은 모양이지만 **퍼센트 센서만** 펼친다
 * (원격: 콤팩트 `k === 'percent'` 만 · 로컬: sensorDetailCache.localCpuSensorDetail). CPU 사용률 센서는 컬렉션의 퍼센트
 * 종류뿐이라 판정 결과는 전량 경로와 같다(테스트가 대조). 샘플러가 1분마다 전 서버를 돌 때 쓴다.
 */
export function sensorCpuDetailOf(s) {
  if (s?.remote) {
    const d = s.sensorDetail;
    if (!d || !Array.isArray(d.list)) return null;
    const list = [];
    for (const o of d.list) if (o && typeof o === 'object' && o.k === 'percent') { const x = expandCompact(o); if (x) list.push(x); }
    return { list, collAt: numOrNull(d.collAt) };
  }
  return localCpuSensorDetail(String(s?.id || ''));
}

/** Sensors 컬렉션의 CPU 사용률 → { v, at, name, stale } (순수 판정 — detailOf 주입). 값이 없으면 v:null. */
export function sensorCpuOf(s, { now = Date.now(), detailOf = sensorCpuDetailOf, freshMs = SENSOR_CPU_FRESH_MS } = {}) {
  let d = null; try { d = detailOf(s); } catch { d = null; }
  if (!d) return { v: null, at: null, name: '', stale: false, found: false };
  const sum = summarizeSensors(d.list || []);
  const raw = pct(numOrNull(sum.sensorCpuUsagePct));
  if (raw == null) return { v: null, at: d.collAt ?? null, name: '', stale: false, found: false };
  // 신선도 판정은 센서 상세 화면(tools/serverSensors.cpuOf)과 같은 함수 하나(v2.680 A-02).
  const j = collectionCpuJudge(raw, d.collAt, { now, freshMs });
  return { v: j.v, at: j.at, name: sum.sensorCpuUsageName || '', stale: j.stale, found: true };
}

/**
 * v2.663: 서버의 서비스태그 — 최상위 필드 → iDRAC 인벤토리(엣지 서버는 export 의 inv) 순. bmusage 행 키가 서비스태그라
 * 태그가 인벤토리에만 있는 엣지 서버도 찾으려면 이 순서여야 한다.
 */
export function serviceTagOf(s) {
  let inv = null; try { inv = invForServer(s); } catch { inv = null; }
  return String(s?.serviceTag || inv?.system?.serviceTag || '').trim();
}

// bmusage 최신 행 캐시 — 샘플러는 1분 주기이고 조회는 비동기라, 직전 주기에 받은 색인을 쓰고 다음 것을 미리 받는다.
let _cpuIdx = null; let _cpuLoading = null;
function refreshCpuIndex() {
  if (_cpuLoading) return;
  _cpuLoading = cpuLatestRows().then((r) => { _cpuIdx = cpuIndexOf(r.rows || []); })
    .catch(() => { /* 참고값 — 실패는 다음 주기에 다시 */ }).finally(() => { _cpuLoading = null; });
}

/** v2.663: 직전 주기의 bmusage 색인(진단용 — 없으면 null). */
export const currentCpuIndex = () => _cpuIdx;

/** 샘플러가 호출(부수효과는 여기만). */
export function serverTrendRows() {
  if (!TREND_SERIES_ENABLED) return [];
  refreshCpuIndex();
  const servers = analysisServersWithRemote();
  return servers?.length ? buildServerTrendRows(servers, { cpuIndex: _cpuIdx }) : [];
}

/**
 * v2.665: 지금 이 서버의 CPU 사용률을 iDRAC 의 어느 경로로 읽는지 · 못 읽으면 왜인지(순수 판정 — 과거 구간의 원인은 알 수 없다).
 * 순서: 텔레메트리 → Sensors 컬렉션 CPU 센서 → 베어메탈 사용률(iDRAC 경로).
 * @returns {{code:string, source?:string, at?:number|null, ageMs?:number|null, name?:string}}
 *   code: ok | sensor-stale(센서는 있는데 컬렉션이 오래됨) | bm-os-only(베어메탈 사용률 값이 OS 경로라 쓰지 않음) |
 *         bm-stale(베어메탈 사용률 값이 오래됨) | no-idrac-cpu(iDRAC 의 어느 경로에도 CPU 사용률이 없음)
 */
export function cpuFallbackDiag(s, { latest = null, cpuIndex = null, now = Date.now(), detailOf = sensorCpuDetailOf } = {}) {
  const v = latest ? trendValuesOf(latest) : null;
  if (v && v.cpuPct != null) return { code: 'ok', source: 'telemetry' };
  const sc = sensorCpuOf(s, { now, detailOf });
  if (sc.v != null) return { code: 'ok', source: 'sensor', at: sc.at, name: sc.name };
  const bm = bmCpuRowOf(s, cpuIndex, now);
  if (bm && bm.fresh && bmSrcIsIdrac(bm.src)) return { code: 'ok', source: 'bmIdrac', at: bm.at };
  if (sc.found && sc.stale) return { code: 'sensor-stale', at: sc.at, ageMs: sc.at != null ? now - sc.at : null, name: sc.name };
  if (bm && bm.fresh && !bmSrcIsIdrac(bm.src)) return { code: 'bm-os-only', src: bm.src };
  if (bm && !bm.fresh && bmSrcIsIdrac(bm.src)) return { code: 'bm-stale', at: bm.at, ageMs: bm.at != null ? now - bm.at : null };
  return { code: 'no-idrac-cpu' };
}
