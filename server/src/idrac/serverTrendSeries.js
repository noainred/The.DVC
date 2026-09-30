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

export const TREND_SERIES_ENABLED = process.env.IDRAC_TREND_SERIES !== 'false';
export const TREND_METRICS = Object.freeze({ cpuPct: 'idracusage_cpu', cpuTemp: idracTempMetric('cpu'), gpuTemp: idracTempMetric('gpu') });

const pct = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null);

/** 최신 표본 → { cpuPct, cpuTemp, gpuTemp } (순수). temps 는 {name:℃} 객체. */
export function trendValuesOf(latest) {
  if (!latest || typeof latest !== 'object') return { cpuPct: null, cpuTemp: null, gpuTemp: null };
  const cpuPct = pct(latest.cpu) ?? pct(latest.cpuUsagePct);
  let gpuTemp = null;
  for (const [name, c] of Object.entries(latest.temps || {})) {
    if (typeof c !== 'number' || !Number.isFinite(c)) continue;
    if (roleOf({ name }) !== 'gpu') continue;
    if (gpuTemp == null || c > gpuTemp) gpuTemp = c;
  }
  return { cpuPct, cpuTemp: serverTempKinds(latest).cpu ?? null, gpuTemp };
}

/** 서버 목록 → metrics 행(순수 — 테스트로 고정). */
export function buildServerTrendRows(servers, {
  now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS, detail = TEMP_SERIES_DETAIL,
  latestOf = (s) => (s.remote ? s.sensors : getSensorSeries(s.id).latest),
  localCycle = sensorPollCycle(now),
} = {}) {
  const rows = [];
  for (const s of servers || []) {
    const id = String(s?.id || '').trim();
    if (!id) continue;
    let latest = null;
    try { latest = latestOf(s); } catch { latest = null; }
    if (sampleStaleReason(latest, { now, maxAgeMs, remote: !!s.remote, localCycle })) continue;
    const v = trendValuesOf(latest);
    if (v.cpuPct != null) rows.push({ metric: TREND_METRICS.cpuPct, k: id, v: v.cpuPct });
    if (v.cpuTemp != null && !detail) rows.push({ metric: TREND_METRICS.cpuTemp, k: id, v: v.cpuTemp });
    if (v.gpuTemp != null) rows.push({ metric: TREND_METRICS.gpuTemp, k: id, v: v.gpuTemp });
  }
  return rows;
}

/** 샘플러가 호출(부수효과는 여기만). */
export function serverTrendRows() {
  if (!TREND_SERIES_ENABLED) return [];
  const servers = analysisServersWithRemote();
  return servers?.length ? buildServerTrendRows(servers) : [];
}
