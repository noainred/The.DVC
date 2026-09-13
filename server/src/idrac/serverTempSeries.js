/**
 * 서버별 iDRAC 온도 시계열(v2.504) — iDRAC 이 조사하는 온도를 **서버 단위로** 장기 적재한다.
 *
 * 사용자 요청(2026-09-13): "idrac 에서 조사하는 온도를 차트로 보이게 해줘" + 참고 화면으로
 * '특수 기능 › ESXi 온도' 의 `5년 추이` 차트를 첨부. 즉 ESXi 온도와 같은 방식의 추이 차트를
 * iDRAC 상세(센서 탭)에도 달아 달라는 요구다.
 *
 * ## 왜 이 모듈이 필요했나 — 그 전에는 데이터 자체가 없었다
 *
 * iDRAC 센서 값이 있던 곳은 두 군데뿐이었다:
 *  1. `sensorStore`(인메모리 24시간) — **중앙이 직접 수집하는 서버만**. 24시간을 넘는 기간은 그릴 수 없다.
 *  2. `roomTempSeries`(v2.384) — metrics DB 이지만 **법인 단위 집계**다. 서버 한 대의 추이가 아니다.
 *
 * 그래서 **위임(엣지) 수집 서버**는 중앙에 이력이 0 이고(엣지가 최신 스냅샷만 export 한다),
 * iDRAC 상세 화면은 값은 표로 보여주면서 차트는 빈 틀이 됐다(v2.493 에서 그 빈 틀을 없애고
 * '중앙 이력 없음' 으로 정직하게 표기했다 — 이 모듈이 그 '없음' 을 실제로 채운다).
 *
 * ## 저장량 — 왜 기본은 서버당 1계열인가 (v2.384 가 서버별 적재를 포기한 이유의 정면 대응)
 *
 * `metrics/sampler.js` 주석은 "965 서버 × 3종 × 시간당 = 연 2,500만 행" 이라 서버별 적재를
 * 하지 않았다고 적고 있었다. 이 계산은 **3종(흡기·배기·CPU)을 모두 쓸 때** 의 값이다.
 * 그래서 기본값은 **서버당 1계열(`idractemp_max` — 그 서버의 최고 온도)** 로 둔다:
 *
 *   기본(1계열): 965 서버 × 24시간 × 365일 ≈ **연 845만 행**
 *     → 이미 수용 중인 `temp_host`(ESXi 655 호스트 × 1계열 ≈ 연 574만 행)와 같은 규모다.
 *   상세(4계열, opt-in): 965 × 4 × 24 × 365 ≈ 연 3,380만 행 — 현장이 알고 켜야 한다.
 *
 * 상세 적재는 `IDRAC_TEMP_SERIES_DETAIL=true` 로만 켜진다(흡기·배기·CPU 라인이 따로 보인다).
 * 완전 비활성은 `IDRAC_TEMP_SERIES=false`.
 * 위 행 수는 **계산값(추정)** 이다 — 서버 대수와 보존기간에 그대로 비례하며, 시간당 롤업은
 * `(metric, k, hour)` upsert 라 샘플 주기를 줄여도 줄지 않는다.
 *
 * ## 정직성 규약
 *  - 값이 없는 종류는 **행을 만들지 않는다**(0 을 넣으면 '급냉' 으로 보인다 — roomTempSeries 와 동일).
 *  - 오래된 표본(기본 15분)은 제외한다. 죽은 서버의 마지막 온도를 매 분 새 타임스탬프로 다시 쓰면
 *    장기 차트가 평탄선이 된다(v2.387 에서 실제로 그랬다).
 *  - 타임스탬프가 없는 표본은 나이를 알 수 없으므로 stale 로 본다(추정으로 통과시키지 않는다).
 *  - 첫 관측 이전 구간은 화면이 소급 표시하지 않는다(조회 라우트가 `firstTs` 를 함께 준다).
 */

import { classifySensor, DEFAULT_MAX_AGE_MS } from './roomTemp.js';
import { getSensorSeries } from './sensorStore.js';
import { analysisServersWithRemote } from '../routes/admin/shared.js';

/** 켜짐/상세 여부 — 환경변수로만 바꾼다(현장이 저장량을 알고 결정해야 한다). */
export const TEMP_SERIES_ENABLED = process.env.IDRAC_TEMP_SERIES !== 'false';
export const TEMP_SERIES_DETAIL = process.env.IDRAC_TEMP_SERIES_DETAIL === 'true';

/** 메트릭 이름. `max` 는 항상, 나머지 3종은 상세 모드에서만 적재된다. */
export const IDRAC_TEMP_METRICS = ['idractemp_max', 'idractemp_inlet', 'idractemp_exhaust', 'idractemp_cpu'];
export const idracTempMetric = (kind) => `idractemp_${kind}`;

/**
 * 센서 최신값 → 종류별 대표 온도(순수).
 *
 * 같은 종류가 여럿이면(CPU1·CPU2) **가장 높은 값**을 대표로 쓴다 — 열 문제는 최고값이 말해준다.
 * `max` 는 종류 분류와 무관하게 **모든 온도 센서의 최댓값**이다(`other` 로 분류되는 센서도 포함).
 * 화면 머리글의 '최고 온도' 와 같은 값이라 사용자가 표와 차트를 대조할 수 있다.
 *
 * @returns {{inlet:number|null, exhaust:number|null, cpu:number|null, max:number|null, count:number}}
 */
export function serverTempKinds(latest) {
  const temps = latest?.temps || {};
  const out = { inlet: null, exhaust: null, cpu: null, max: null, count: 0 };
  for (const name of Object.keys(temps)) {
    const c = Number(temps[name]);
    if (!Number.isFinite(c)) continue;
    out.count += 1;
    if (out.max == null || c > out.max) out.max = c;
    const kind = classifySensor(name);
    if (kind === 'other') continue;
    if (out[kind] == null || c > out[kind]) out[kind] = c;
  }
  return out;
}

/**
 * 표본이 쓸 수 있는 것인가(순수). 반환은 사유 문자열 또는 null(통과).
 * `maxAgeMs <= 0` 이면 나이 검사를 하지 않는다(호출부가 명시적으로 끈 경우).
 */
export function sampleStaleReason(latest, { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  if (!latest || !latest.temps || !Object.keys(latest.temps).length) return 'no-sensors';
  if (maxAgeMs <= 0) return null;
  const at = Number(latest.t);
  if (!Number.isFinite(at)) return 'no-timestamp';
  if (now - at > maxAgeMs) return 'stale';
  return null;
}

/**
 * 서버 목록 → metrics 행 배열(순수 — 센서 조회 함수를 주입받는다).
 *
 * `servers` 는 `analysisServersWithRemote()` 결과를 기대한다 — **위임(엣지) 서버가 포함**되어야
 * 그 서버들도 차트를 갖는다(이 기능의 핵심 목적이다). 원격은 export 로 받은 `s.sensors`,
 * 로컬은 `sensorStore` 최신값을 쓴다(`routes/admin/idracCore.js /idrac/temps`·`roomTemp.js` 와 같은 규약).
 *
 * @returns {{rows:Array<{metric:string,k:string,v:number}>, servers:number, skipped:Object}}
 */
export function buildServerTempRows(servers, {
  now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS, detail = TEMP_SERIES_DETAIL,
  latestOf = (s) => (s.remote ? s.sensors : getSensorSeries(s.id).latest),
} = {}) {
  const rows = [];
  const skipped = { noSensors: 0, stale: 0, noTimestamp: 0 };
  let counted = 0;
  for (const s of servers || []) {
    const id = String(s?.id || '').trim();
    if (!id) continue;
    let latest = null;
    try { latest = latestOf(s); } catch { latest = null; }
    const bad = sampleStaleReason(latest, { now, maxAgeMs });
    if (bad === 'no-sensors') { skipped.noSensors += 1; continue; }
    if (bad === 'no-timestamp') { skipped.noTimestamp += 1; continue; }
    if (bad === 'stale') { skipped.stale += 1; continue; }
    const per = serverTempKinds(latest);
    if (per.max == null) { skipped.noSensors += 1; continue; }
    counted += 1;
    rows.push({ metric: idracTempMetric('max'), k: id, v: per.max });
    if (!detail) continue;
    for (const kind of ['inlet', 'exhaust', 'cpu']) {
      if (per[kind] == null) continue;      // 결측은 결측으로 — 0 을 넣지 않는다
      rows.push({ metric: idracTempMetric(kind), k: id, v: per[kind] });
    }
  }
  return { rows, servers: counted, skipped };
}

/**
 * 샘플러가 호출 — 비활성이면 빈 배열.
 * 서버 목록 조회(부수효과)는 여기서만 한다 — 위 `buildServerTempRows` 는 순수로 유지해 테스트로 고정한다.
 * `roomTempSeries.js` 와 같은 소스(`analysisServersWithRemote`)를 쓰므로 두 계열의 대상 집합이 같다.
 */
export function serverTempRows() {
  if (!TEMP_SERIES_ENABLED) return [];
  const servers = analysisServersWithRemote();
  if (!servers?.length) return [];
  return buildServerTempRows(servers).rows;
}
