/**
 * tools/serverTemp.js — '서버 온도' 리포트 판정·집계(순수, v2.512).
 *
 * 사용자 요구(2026-09-15): "특수 기능의 'ESXi 온도' 를 '서버 온도' 로 바꾸고 **iDRAC 에서 수집된
 * 서버 온도**를 표시" + "법인의 **물리서버/가상화 서버를 분리**해서 보고 각각의 **평균 온도** 등
 * 부가기능" + "**5분 평균이 안 나오는 것**도 수정".
 *
 * ## 왜 ESXi 를 버리지 않고 합치는가 (정직한 설계 근거)
 *
 * 운영 화면 실측: ESXi 센서 보고 호스트 **655/655**. iDRAC 등록은 그보다 적을 수 있고, 위임(엣지)
 * 수집 서버는 센서가 늦거나 비어 있을 수 있다. iDRAC 로 **전면 교체하면 지금 보이던 호스트가
 * 사라진다** — 그래서 같은 장비는 iDRAC 값을 우선하고(BMC 가 흡기·배기·CPU 를 따로 준다),
 * iDRAC 이 없는 장비는 ESXi 센서로 남긴다. 각 행에 `source` 를 실어 어디서 온 값인지 밝힌다.
 *
 * ## 물리 / 가상화 구분
 *
 * iDRAC 서버의 `serviceTag` 가 vCenter 인벤토리의 ESXi 호스트와 일치하면 **가상화 서버**,
 * 아니면 **물리 서버**(베어메탈 — DB·파일서버 등)다. 판정은 `idrac/hostMatch.js` 와 같은 규약
 * (태그 소문자 trim 비교)을 쓴다. ESXi 에서만 온 행은 정의상 항상 가상화다.
 *
 * ## 5분 평균이 늘 비던 이유
 *
 * 라우트가 `now-5분` 창으로 `recentAvg` 를 조회하는데, 온도 샘플러 주기는 설정에서 최대 24시간까지
 * 올릴 수 있다(`metrics/settings.js` MAX_INTERVAL_MS). 주기가 5분을 넘으면 그 창에 표본이 하나도
 * 없어 **모든 행이 영구히 '—'** 가 된다(v2.451 의 34GB DB 사고 이후 주기를 늘린 현장에서 그렇다).
 * `avgWindowMs()` 가 창을 **샘플 주기의 2배 이상**으로 넓히고, 화면은 실제 창을 라벨에 적는다
 * ('5분 평균' 이라 적어 놓고 20분을 평균내면 그것도 거짓이므로).
 */

import { classifySensor } from '../idrac/roomTemp.js';

const r1 = (x) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(1)));
const lower = (s) => String(s ?? '').trim().toLowerCase();

/* ── 5분 평균 창 ──────────────────────────────────────────────────────────── */

export const BASE_AVG_WINDOW_MS = 5 * 60_000;

/**
 * 평균 창(ms) — 최소 5분, 그리고 **샘플 주기의 2배 이상**.
 * 2배인 이유: 정확히 1주기 창이면 지터·적재 지연으로 표본이 0개인 순간이 생긴다.
 */
export function avgWindowMs(sampleIntervalMs) {
  const iv = Number(sampleIntervalMs);
  if (!Number.isFinite(iv) || iv <= 0) return BASE_AVG_WINDOW_MS;
  return Math.max(BASE_AVG_WINDOW_MS, iv * 2);
}

/** 창 길이 → 사람이 읽는 라벨('5분' / '20분' / '2시간'). */
export function avgWindowLabel(ms) {
  const m = Math.round((Number(ms) || BASE_AVG_WINDOW_MS) / 60_000);
  if (m < 60) return `${m}분`;
  const h = Math.round((m / 60) * 10) / 10;
  return `${h % 1 === 0 ? h.toFixed(0) : h.toFixed(1)}시간`;
}

/* ── 센서 → 종류별 대표값 ─────────────────────────────────────────────────── */

/**
 * 센서 목록을 흡기/배기/CPU/최고로 요약(순수).
 * 입력은 두 형태를 모두 받는다 — iDRAC `{name: c}` 객체, ESXi `[{name, c}]` 배열.
 * 같은 종류가 여럿이면 **가장 높은 값**을 대표로 쓴다(열 문제는 최고값이 말한다 —
 * `idrac/serverTempSeries.js serverTempKinds` 와 같은 규약).
 */
export function summarizeSensors(sensors) {
  const out = { inlet: null, exhaust: null, cpu: null, max: null, count: 0 };
  const put = (name, raw) => {
    const c = Number(raw);
    if (!Number.isFinite(c)) return;
    out.count += 1;
    if (out.max == null || c > out.max) out.max = c;
    const kind = classifySensor(name);
    if (kind === 'other') return;
    if (out[kind] == null || c > out[kind]) out[kind] = c;
  };
  if (Array.isArray(sensors)) for (const s of sensors) put(s?.name, s?.c ?? s?.v ?? s?.value);
  else if (sensors && typeof sensors === 'object') for (const k of Object.keys(sensors)) put(k, sensors[k]);
  return out;
}

/* ── 물리 / 가상화 ────────────────────────────────────────────────────────── */

export const KIND_LABEL = { physical: '물리 서버', virtual: '가상화 서버' };

/** serviceTag → ESXi 호스트 Map(소문자 키). `idrac/hostMatch.js` 와 같은 비교 규약. */
export function hostsByServiceTag(hosts) {
  const m = new Map();
  for (const h of hosts || []) {
    const t = lower(h?.serviceTag);
    if (t) m.set(t, h);
  }
  return m;
}

/**
 * iDRAC 서버 1대의 구분 판정(순수).
 * @returns {{kind:'virtual'|'physical', host:object|null}}
 */
export function classifyServer(server, tagMap) {
  const host = tagMap.get(lower(server?.serviceTag)) || null;
  return { kind: host ? 'virtual' : 'physical', host };
}

/* ── 집계 ─────────────────────────────────────────────────────────────────── */

const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

/**
 * 행 묶음 → 통계(순수). **결측은 평균에서 제외**한다(0 으로 채우면 평균이 내려가 오판).
 * 계열별로 표본 수가 다를 수 있어 각 평균의 분모를 따로 센다.
 */
export function aggregate(rows) {
  const list = rows || [];
  const cur = list.map((r) => r.curC).filter((v) => Number.isFinite(v));
  const pick = (k) => list.map((r) => r[k]).filter((v) => Number.isFinite(v));
  const inlet = pick('inletC'); const exhaust = pick('exhaustC'); const cpu = pick('cpuC');
  const maxes = list.map((r) => r.maxC).filter((v) => Number.isFinite(v));
  return {
    servers: list.length,
    reporting: cur.length,
    avgC: r1(mean(cur)),
    minC: cur.length ? r1(Math.min(...cur)) : null,
    curMaxC: cur.length ? r1(Math.max(...cur)) : null,
    maxC: maxes.length ? r1(Math.max(...maxes)) : null,
    avgInletC: r1(mean(inlet)), inletN: inlet.length,
    avgExhaustC: r1(mean(exhaust)), exhaustN: exhaust.length,
    avgCpuC: r1(mean(cpu)), cpuN: cpu.length,
  };
}

/** physical/virtual/all 세 묶음을 한 번에. */
export function splitAggregate(rows) {
  const list = rows || [];
  return {
    all: aggregate(list),
    physical: aggregate(list.filter((r) => r.kind === 'physical')),
    virtual: aggregate(list.filter((r) => r.kind === 'virtual')),
  };
}

/* ── 리포트 ───────────────────────────────────────────────────────────────── */

/**
 * 서버 온도 리포트(순수 — 센서 조회 함수를 주입받는다).
 *
 * @param idracServers  analysisServersWithRemote() 결과(위임 엣지 포함)
 * @param hosts         스냅샷 ESXi 호스트(scope 적용 후)
 * @param latestOf      (server) => { t, temps } — 로컬은 sensorStore, 원격은 s.sensors
 * @param dcName        (datacenterId) => 표시 이름
 * @param maxAgeMs      이 나이를 넘은 iDRAC 표본은 stale 로 표시(0 이면 검사 안 함)
 * @returns { rows, summary, byDatacenter, counts }
 */
export function buildServerTempReport({
  idracServers = [], hosts = [], latestOf = () => null,
  dcName = (id) => id, now = Date.now(), maxAgeMs = 15 * 60_000,
} = {}) {
  const tagMap = hostsByServiceTag(hosts);
  const rows = [];
  const usedHostIds = new Set();
  const counts = { idrac: 0, esxi: 0, stale: 0, noSensors: 0 };

  for (const s of idracServers || []) {
    const id = String(s?.id ?? '').trim();
    if (!id) continue;
    let latest = null;
    try { latest = latestOf(s); } catch { latest = null; }
    const sum = summarizeSensors(latest?.temps);
    const { kind, host } = classifyServer(s, tagMap);
    // ⚠ 호스트 '점유' 는 **iDRAC 행을 실제로 만든 뒤**에만 한다. 센서가 없는 iDRAC 등록만으로
    //   점유하면 아래 ESXi 폴백이 막혀 그 호스트가 화면에서 통째로 사라진다(테스트로 고정).
    if (sum.max == null) { counts.noSensors += 1; continue; }
    if (host) usedHostIds.add(host.id);
    const at = Number(latest?.t);
    const stale = maxAgeMs > 0 && Number.isFinite(at) && now - at > maxAgeMs;
    if (stale) counts.stale += 1;
    counts.idrac += 1;
    rows.push({
      id, source: 'idrac', kind,
      name: String(s.name || s.hostName || s.ip || id),
      ip: s.ip || '', serviceTag: s.serviceTag || '',
      datacenterId: String(s.datacenterId || ''),
      vcenterId: host?.vcenterId || s.vcenterId || '',
      cluster: host?.cluster || '', hostName: host?.name || '',
      // 대표 온도는 흡기가 있으면 흡기(장비가 놓인 환경을 말한다), 없으면 최고값.
      curC: r1(sum.inlet ?? sum.max), maxC: r1(sum.max),
      inletC: r1(sum.inlet), exhaustC: r1(sum.exhaust), cpuC: r1(sum.cpu),
      sensors: sum.count, at: Number.isFinite(at) ? at : null, stale,
    });
  }

  // iDRAC 이 없는(또는 센서가 없는) ESXi 호스트는 vCenter 센서로 남긴다 — 교체가 아니라 보완.
  for (const h of hosts || []) {
    if (usedHostIds.has(h.id)) continue;
    if (h.tempC == null) continue;
    const sum = summarizeSensors(h.temps);
    counts.esxi += 1;
    rows.push({
      id: h.id, source: 'esxi', kind: 'virtual',
      name: h.name, ip: '', serviceTag: h.serviceTag || '',
      datacenterId: '', vcenterId: h.vcenterId || '',
      cluster: h.cluster || '', hostName: h.name,
      curC: r1(h.tempC), maxC: r1(h.tempMaxC ?? h.tempC),
      inletC: r1(sum.inlet), exhaustC: r1(sum.exhaust), cpuC: r1(sum.cpu),
      sensors: sum.count || (h.temps || []).length, at: null, stale: false,
    });
  }

  // 법인(iDRAC datacenterId) 기준 묶음 — 없으면 vCenter 로 대체해 '미분류' 를 줄인다.
  const byDc = new Map();
  for (const r of rows) {
    const key = r.datacenterId || r.vcenterId || '(미분류)';
    if (!byDc.has(key)) byDc.set(key, []);
    byDc.get(key).push(r);
  }
  const byDatacenter = [...byDc.entries()]
    .map(([key, list]) => ({ key, name: dcName(key) || key, ...splitAggregate(list) }))
    .sort((a, b) => (b.all.avgC ?? -Infinity) - (a.all.avgC ?? -Infinity));

  return { rows, summary: splitAggregate(rows), byDatacenter, counts };
}

/* ── 24시간 스파크라인 메트릭 선택(v2.556) ──────────────────────────────────── */

/**
 * 그 행의 24시간 추이를 어떤 시계열 메트릭에서 읽을지 고른다(순수).
 *
 * ⚠⚠ **표의 '현재온도' 와 스파크라인이 다른 계열일 수 있다 — 숨기지 않는다.**
 *   iDRAC 서버의 장기 이력은 기본 설정에서 **서버당 1계열(`idractemp_max` — 그 서버의 최고
 *   센서)** 만 적재된다(`idrac/serverTempSeries.js` 머리말 — 계열 수 × 24 × 365 행/년 이라
 *   흡기·배기·CPU 를 다 적재하면 4배다). 흡기 계열(`idractemp_inlet`)은
 *   `IDRAC_TEMP_SERIES_DETAIL=true` 일 때만 있다. 그런데 표의 '현재온도' 는 **흡기**다.
 *   그래서 라우트는 **실제로 쓴 메트릭을 응답(`metricByKey`)에 실어** 화면이 툴팁에
 *   '24시간 · 최고' / '24시간 · 흡기' 로 **구분해 적게** 한다. 이것을 지우고 한 문구로
 *   덮으면 사용자가 다른 계열을 같은 것으로 읽는다(루트 CLAUDE.md 정직성 규약).
 *
 * @param {'idrac'|'esxi'|'cluster'|'vc'} source  행의 출처(서버별 뷰는 r.source, 다른 뷰는 뷰 이름)
 * @param {{detail?: boolean}} opt  detail = 상세 계열 적재 여부(TEMP_SERIES_DETAIL)
 * @returns {string|null}  메트릭 이름. 모르는 source 는 **null**(추측해서 엉뚱한 계열을 주지 않는다)
 */
export function sparkMetricFor(source, { detail = false } = {}) {
  switch (String(source || '')) {
    case 'idrac': return detail ? 'idractemp_inlet' : 'idractemp_max';
    case 'esxi': return 'temp_host';
    case 'host': return 'temp_host';       // 'ESXi 호스트별' 뷰는 뷰 이름을 그대로 보낸다
    case 'cluster': return 'temp_cluster';
    case 'vc': return 'temp_vc';
    default: return null;
  }
}

/** detail 모드에서 흡기 계열이 비었을 때의 대체 메트릭(없으면 null). */
export function sparkMetricFallback(metric) {
  return metric === 'idractemp_inlet' ? 'idractemp_max' : null;
}
