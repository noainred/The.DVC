/**
 * routes/admin/idracTrend.js — 특수 기능 › iDRAC 통합 추이(v2.660, 사용자 제공 핸드오프 design_handoff_idrac_trend).
 *
 *   GET /admin/idrac/trend/servers                         — 법인 → 데이터센터(스캔 대역) → 서버 선택 목록
 *   GET /admin/idrac/trend/export.csv?scope=server&id=…     — 단일 서버 CSV
 *   GET /admin/idrac/trend/export.csv?scope=dc&corp=…&site=… — 한 데이터센터(스캔 대역) 전체 CSV
 *   GET /admin/idrac/:id/trend?range=1h|6h|24h|7d|30d|90d|1y (또는 ?start=<ms>&end=<ms>)
 *
 * 데이터센터(사이트) = **그 서버 IP 를 포함하는 iDRAC 스캔 대역의 이름**(사용자 선택 — 법인 아래 사이트 필드는 저장소에
 *   없다). 판정은 idrac/scanSite.js 하나이고 서버 분석의 법인 보강과 같은 색인을 쓴다.
 * 서버 형태: 서비스태그 또는 (v2.666) 호스트네임(도메인 제거·대소문자 무시)이 ESXi 호스트와 일치하면 ESXi, 아니면 베어메탈(idrac/hostMatch.js).
 * v2.666: ESXi 로 매칭되면 그 호스트의 **vCenter CPU 사용률**을 별도 계열 `hostCpuPct` 로 싣는다 — iDRAC CPU(cpuPct)에 섞지 않는다.
 * 권한·범위: 다른 iDRAC 상세 라우트와 같다(adminOnly + v2.629 범위 절단 — 범위 밖·귀속 없는 서버는 404).
 *   CSV 는 `data.csv` 권한 + 동시 1건(util/exportBusy — v2.575 규약).
 * 정직성: 결측은 null(CSV 빈 칸)이다 — 0 으로 채우지 않는다. 계열마다 보관 기간이 다르고(전력 DB 는 기본 90일) 그 사실을
 *   응답의 `retention` 으로 싣는다. 첫 관측 이전은 비워 둔다(firstTs).
 * ⚠ '/idrac/trend/*' 는 '/idrac/:id/…' 보다 **먼저** 등록한다(:id 가 'trend' 를 먹지 않게) — admin.js 가 registerIdracScan 앞에서 부른다.
 */
import { loadRegistry as loadIdracRegistry } from '../../idrac/registry.js';
import { findRemoteServer, allRemoteServers } from '../../collector/remoteInventory.js';
import { getInventory as getIdracInventory } from '../../idrac/invCache.js';
import { buildHostMatchIndex, matchHostForServer } from '../../idrac/hostMatch.js';
import { resolveServerForHost, gpuCardsOf } from '../../idrac/serverForHost.js';
import { store } from '../../store.js';
import { config } from '../../config.js';
import { getMetricsDb } from '../../metrics/db.js';
import { loadMetricsSettings } from '../../metrics/settings.js';
import { getDb as getPowerDb } from '../../idrac/db.js';
import { TREND_METRICS, TREND_SERIES_ENABLED, TREND_AIRFLOW_ENABLED, CPU_FALLBACK_METRICS, trendValuesOf, cpuFallbackDiag, currentCpuIndex } from '../../idrac/serverTrendSeries.js';
import { remotePowerEntries, getCollectorStatus } from '../../collector/state.js';
import { pullerStatus } from '../../collector/puller.js';
import { getSensorSeries, sensorPollCycle } from '../../idrac/sensorStore.js';
import { sampleStaleReason } from '../../idrac/serverTempSeries.js';
import { sampleMaxAgeMs, DEFAULT_MAX_AGE_MS } from '../../idrac/roomTemp.js';
import { numOrNull } from '../../util/numOrNull.js';
import { siteNameOf } from '../../idrac/scanSite.js';
import { analysisServersWithRemote, scanSiteIndex, invForServer } from '../../insights/analysisServers.js';
import { listDatacenters } from '../../datacenter/store.js';
import { adminOnly } from './shared.js';
import { idracScopeOf, idracInScope, scopeIdracServers } from './idracCore.js';
import { requirePerm } from '../../auth/auth.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { localStamp, fileStamp, DAY_OFFSET_MIN } from '../../util/dayKey.js';
import { acquireExport } from '../../util/exportBusy.js';
import { snapMemo, sendCached } from '../../util/snapCache.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { addLineCharts, sheetRef, colLetter } from '../../util/xlsxChart.js';

const csvPerm = requirePerm('data.csv');
const hiddenByScope = (req, s) => { const sc = idracScopeOf(req); return !!sc && !idracInScope(sc, s); };
const NOT_FOUND = { ok: false, reason: '서버를 찾을 수 없습니다.' };

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
export const PRESETS = Object.freeze({ '1h': HOUR, '6h': 6 * HOUR, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, '90d': 90 * DAY, '1y': 365 * DAY });
/** 표본 ≤ 약 400 이 되도록 집계 단위를 고른다 — 화면(idracTrendText.js BUCKET_LABELS)과 같은 표. */
export const BUCKETS = Object.freeze([MIN, 5 * MIN, 30 * MIN, 2 * HOUR, 6 * HOUR, DAY]);
export const bucketOf = (span) => BUCKETS.find((ms) => span / ms <= 400) || DAY;
/** 조회 가능 기간(일) — 핸드오프 365일. metrics 롤업 보존이 더 짧으면 그 값(0 = 무제한은 365 그대로). */
export function trendRetentionDays(metricsRetentionDays = loadMetricsSettings().retentionDays, env = process.env) {
  const want = Number(env.IDRAC_TREND_RETENTION_DAYS);
  const base = Number.isFinite(want) && want >= 1 ? Math.min(3650, Math.floor(want)) : 365;
  const m = Number(metricsRetentionDays);
  return Number.isFinite(m) && m > 0 ? Math.min(base, m) : base;
}
export const SERVER_EXPORT_MAX = 300; // 데이터센터 CSV 한 번에 담는 서버 상한(넘으면 개수를 밝힌다)

/**
 * v2.680(A-07): 1일 버킷의 경계 오프셋(ms) — 포탈 날짜(util/dayKey.js, 기본 한국 시각 0시)에 맞춘다. 예전에는 UTC 0시(한국 09시)라
 * 'D 일' 점이 실제로는 D 09:00 ~ D+1 09:00 이었다. 시간당 롤업으로 묶으므로 1시간 정배수 오프셋만 쓴다(아니면 0 = 예전 UTC).
 */
export function dayBucketOffsetMs(offsetMin = DAY_OFFSET_MIN) {
  const off = Number(offsetMin) * MIN;
  return Number.isFinite(off) && off % HOUR === 0 ? off : 0;
}

/** 요청 → { start, end, bucketMs, offsetMs, custom } | { error } (순수). 끝은 버킷 경계로 올린 배타 경계. */
export function parseWindow(q, { now = Date.now(), retentionDays = 365, offsetMin = DAY_OFFSET_MIN } = {}) {
  let start, end = now, custom = false;
  const has = (v) => v != null && v !== '';
  if (has(q?.start) || has(q?.end)) {
    custom = true;
    start = Number(q.start); end = Number(q.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { error: '시작·종료 시각이 올바르지 않습니다.' };
    if (end <= start) return { error: '종료 시각이 시작 시각보다 뒤여야 합니다.' };
    if (end - start < HOUR) return { error: '기간은 최소 1시간입니다.' };
    if (end > now + MIN) return { error: '종료 시각이 현재 이후입니다.' };
  } else {
    const span = PRESETS[q?.range] || DAY;
    start = end - span;
  }
  const floor = now - retentionDays * DAY;
  if (start < floor - MIN) return { error: `보관 기간(${retentionDays}일)을 넘었습니다 — ${localStamp(floor).slice(0, 10)} 이후만 조회할 수 있습니다.` };
  const bucketMs = bucketOf(end - start);
  const offsetMs = bucketMs === DAY ? dayBucketOffsetMs(offsetMin) : 0;
  return { start: Math.floor((start + offsetMs) / bucketMs) * bucketMs - offsetMs, end, bucketMs, offsetMs, custom };
}

/** 계열별 버킷 점 → 한 시간축(순수). 결측은 null. */
export function mergeSeries(win, series) {
  const maps = {};
  for (const [k, pts] of Object.entries(series)) {
    const m = new Map();
    for (const p of pts || []) {
      const t = Number(p.ts);
      const v = typeof p.v === 'number' ? p.v : typeof p.avg === 'number' ? p.avg : typeof p.watts === 'number' ? p.watts : null;
      if (Number.isFinite(t) && v != null && Number.isFinite(v)) m.set(t, Math.round(v * 10) / 10);
    }
    maps[k] = m;
  }
  const points = [];
  for (let t = win.start; t < win.end; t += win.bucketMs) {
    const pt = { t };
    for (const k of Object.keys(series)) pt[k] = maps[k].get(t) ?? null;
    points.push(pt);
  }
  return points;
}

/**
 * 소비 전력 계열의 DB 키(v2.661 — 사용자 신고 "소비 전력은 안 나와"). 중앙 등록 서버는 등록 id 그대로지만, **엣지가 수집해
 * 보낸 서버**의 전력은 puller 가 `rmt:<호스트>`(같은 호스트명이 다른 법인에도 있으면 `rmt:<수집서버>:<호스트>`)로 적재한다
 * (collector/state.js remoteSeriesKey). v2.660 은 원격 서버도 서버 id 로 찾아 전력이 늘 비었다.
 * 판정 순서: ① 지금 그 엣지가 보고 중인 항목(수집 서버 id + 엣지 서버 id 일치)의 dbKey ② 없으면(중앙 재시작 직후 첫 pull 전)
 * 법인 축 키 `rmt:<수집서버>:<이름>` 중 DB 에 계열이 있는 것. ⚠ 법인 축 없는 `rmt:<이름>` 을 추측으로 쓰지 않는다 — 같은 이름의
 * 다른 법인 서버일 수 있다(v2.605 CEN2605-03). 못 찾으면 null 이고 응답이 사유를 밝힌다.
 */
export function powerKeyOf(s, { entries = [], hasSeries = () => false } = {}) {
  if (!s) return { key: null, reason: 'no-server' };
  if (!s.remote) return { key: String(s.id), reason: 'local' };
  const col = String(s.collectorId || '');
  const hit = (entries || []).find((e) => e && String(e.collectorId || '') === col && e.serverId != null && String(e.serverId) === String(s.id));
  if (hit?.dbKey) return { key: String(hit.dbKey), reason: 'edge-report' };
  if (col) {
    for (const n of [s.name, s.serviceTag, ...(Array.isArray(s.hostNames) ? s.hostNames : [])]) {
      const h = typeof n === 'string' ? n.trim().toLowerCase() : '';
      if (!h) continue;
      const k = `rmt:${col}:${h}`;
      if (hasSeries(k)) return { key: k, reason: 'collector-axis' };
    }
  }
  return { key: null, reason: 'no-edge-report' };
}

/**
 * CPU 사용률 계열을 버킷마다 하나로 고른다(순수). v2.665 부터 **iDRAC 출처만** — 텔레메트리 > Sensors 컬렉션 CPU 센서 >
 * 베어메탈 사용률의 iDRAC 경로 값. 적재부터 한 주기에 한 계열만 쌓이지만 롤업 버킷 경계에서 두 출처가 한 버킷에 들어올 수 있어
 * 여기서 다시 고른다. 그 뒤 **아직 빈 버킷만** 베어메탈 사용률 원시 이력 중 iDRAC 출처 행(`history`)으로 채운다.
 * vCenter·OS 값(예전 `_vc`·`_os` 계열)은 읽지 않는다(사용자 지시 — serverTrendSeries.js CPU_RETIRED_METRICS).
 * 반환 `{ series:[{ts,v}], sources:{telemetry,sensor,bmIdrac,history} }` — 출처별 버킷 수(화면이 말한다).
 */
export function mergeCpuSeries(win, { telemetry = [], sensor = [], bmIdrac = [], history = [] } = {}) {
  const toMap = (pts) => {
    const m = new Map();
    for (const p of pts || []) {
      const t = Number(p?.ts); const v = typeof p?.v === 'number' ? p.v : typeof p?.avg === 'number' ? p.avg : null;
      if (Number.isFinite(t) && v != null && Number.isFinite(v) && v >= 0 && v <= 100) m.set(t, v);
    }
    return m;
  };
  const order = [['telemetry', toMap(telemetry)], ['sensor', toMap(sensor)], ['bmIdrac', toMap(bmIdrac)], ['history', toMap(history)]];
  const sources = { telemetry: 0, sensor: 0, bmIdrac: 0, history: 0 };
  const series = [];
  for (let t = win.start; t < win.end; t += win.bucketMs) {
    for (const [name, m] of order) {
      if (!m.has(t)) continue;
      series.push({ ts: t, v: m.get(t) }); sources[name] += 1; break;
    }
  }
  return { series, sources };
}

/**
 * v2.665: 이 서버의 iDRAC 표본이 지금 들어오고 있는가(순수 — 사용자 신고 "데이터가 수집되다가 지금은 안되고 있어").
 * 온도·전력은 iDRAC 표본이 신선할 때만 쌓이므로, 차트가 멈췄다면 표본 시각이 멈춘 것이다. 위임(엣지) 서버는
 * ① 중앙이 그 엣지에서 마지막으로 정상 pull 한 시각 ② 엣지가 보낸 표본 시각 을 나눠 보여야 어디서 멈췄는지 가를 수 있다
 * (① 이 멈췄으면 중앙↔엣지 통신, ① 은 도는데 ② 만 멈췄으면 엣지의 iDRAC 수집).
 * `error` 는 전체 범위 계정에만 싣는다(엣지 주소가 들어갈 수 있다).
 */
export function idracStateOf(s, { now = Date.now(), latest = null, localCycle = null, collector = null, showError = false, puller = null } = {}) {
  const remote = !!s?.remote;
  const at = numOrNull(latest?.t);
  const reason = sampleStaleReason(latest, { now, remote, localCycle });
  const maxAgeMs = sampleMaxAgeMs(DEFAULT_MAX_AGE_MS, latest, { remote, localCycle });
  const out = { remote, sampleAt: at, ageMs: at != null ? Math.max(0, now - at) : null, maxAgeMs, stale: reason || null };
  if (remote) {
    const c = collector || null;
    const lastOk = numOrNull(c?.at);
    out.collector = {
      id: String(s?.collectorId || ''),
      known: !!c,
      ok: c ? c.ok === true && !c.degraded : null,
      degraded: !!c?.degraded,
      lastOkAt: lastOk,
      lastOkAgeMs: lastOk != null ? Math.max(0, now - lastOk) : null,
      fails: numOrNull(c?.fails),
      version: c?.version ? String(c.version).slice(0, 40) : '',
      error: showError && c?.error ? String(c.error).slice(0, 300) : '',
      errorHidden: !showError && !!c?.error,
      // v2.693(2026-10-04 운영 사고): 'ok' 상태가 남아 있어도 정상 pull 이 주기보다 크게 오래됐으면 pull 자체가 돌지 않는 것이다 —
      //   화면이 'pull 은 정상' 이라 말하지 않게 판정을 함께 싣는다. 경계 = max(주기 × 3, 5분)(엣지 하나 실패는 c.ok=false 가 말한다).
      ...pullStaleOf(lastOk, puller, now),
    };
    out.exportAt = numOrNull(s?.pulledAt);
  }
  return out;
}

/** v2.693: 정상 pull 이 주기보다 크게 오래됐는가(순수). puller 를 모르면 판정하지 않는다(추측 금지). */
export function pullStaleOf(lastOkAt, puller, now = Date.now()) {
  const iv = Number(puller?.intervalMs);
  if (!(iv > 0) || lastOkAt == null) return { pullIntervalMs: iv > 0 ? iv : null, pullStale: false };
  const limit = Math.max(iv * 3, 5 * 60_000);
  const age = Math.max(0, now - Number(lastOkAt));
  return {
    pullIntervalMs: iv, pullStaleLimitMs: limit, pullStale: age > limit,
    pullerRunningForMs: numOrNull(puller?.runningForMs), pullerStuckReleases: numOrNull(puller?.stuckReleases) ?? 0,
  };
}

/** v2.666: 매칭된 ESXi 호스트의 vCenter CPU 사용률 계열(metrics/sampler.js HOST_CPU_METRIC). iDRAC CPU 와 다른 계열이다. */
export const HOST_CPU_METRIC = 'host_cpu_pct';
/**
 * v2.668: 매칭된 ESXi 호스트의 **GPU 사용률·GPU 메모리 점유** 계열(사용자 요청 "이 화면에서 수집한 GPU 사용량 붙여서 호스트 별로
 * 사용량을 같이"). GPU 모니터링이 이미 호스트 id 로 적재하는 계열(metrics/sampler.js `gpu_util`·`gpu_mem`)을 **읽기만** 한다 —
 * 새 수집은 없다. vCenter·게스트 출처라 iDRAC 계열(SERIES)과 섞지 않는다(v2.665 규약). GPU 온도는 iDRAC 계열이 이미 있다.
 */
export const HOST_GPU_METRICS = Object.freeze({ hostGpuPct: 'gpu_util', hostGpuMemPct: 'gpu_mem' });

async function seriesFor(s, win, { host = undefined } = {}) {
  const id = String(s?.id || '');
  const errors = {};
  const out = { cpuPct: [], cpuTemp: [], gpuTemp: [], inletTemp: [], exhaustTemp: [], powerW: [], hostCpuPct: [], hostGpuPct: [], hostGpuMemPct: [] };
  const matched = host !== undefined ? host : (() => { try { return kindOf(s).host; } catch { return null; } })();
  let hostCpuFirstTs = null;
  const hostGpuFirstTs = {};
  const cpuParts = { telemetry: [], sensor: [], bmIdrac: [], history: [] };
  let firstTs = null;
  let cpuHistoryKey = null;
  try {
    const db = await getMetricsDb();
    const read = (k, metric) => {
      try { return db.historyRange(metric, id, win.start, win.end, win.bucketMs, win.offsetMs || 0); }
      catch (e) { errors[k] = e?.message || String(e); return []; }
    };
    cpuParts.telemetry = read('cpuPct', TREND_METRICS.cpuPct);
    cpuParts.sensor = read('cpuPct', CPU_FALLBACK_METRICS.sensor);
    cpuParts.bmIdrac = read('cpuPct', CPU_FALLBACK_METRICS.bmIdrac);
    out.cpuTemp = read('cpuTemp', TREND_METRICS.cpuTemp);
    out.gpuTemp = read('gpuTemp', TREND_METRICS.gpuTemp);
    out.inletTemp = read('inletTemp', TREND_METRICS.inletTemp);
    out.exhaustTemp = read('exhaustTemp', TREND_METRICS.exhaustTemp);
    if (matched?.id) {
      try { out.hostCpuPct = db.historyRange(HOST_CPU_METRIC, String(matched.id), win.start, win.end, win.bucketMs, win.offsetMs || 0); }
      catch (e) { errors.hostCpuPct = e?.message || String(e); }
      try { hostCpuFirstTs = db.metaKey?.(HOST_CPU_METRIC, String(matched.id))?.firstTs ?? null; } catch { /* 참고값 */ }
      for (const [k, metric] of Object.entries(HOST_GPU_METRICS)) {
        try { out[k] = db.historyRange(metric, String(matched.id), win.start, win.end, win.bucketMs, win.offsetMs || 0); }
        catch (e) { errors[k] = e?.message || String(e); }
        try { hostGpuFirstTs[k] = db.metaKey?.(metric, String(matched.id))?.firstTs ?? null; } catch { /* 참고값 */ }
      }
    }
    for (const metric of [...Object.values(TREND_METRICS), ...Object.values(CPU_FALLBACK_METRICS)]) {
      try { const m = db.metaKey?.(metric, id); if (m?.firstTs && (firstTs == null || m.firstTs < firstTs)) firstTs = m.firstTs; } catch { /* 첫 관측은 참고값 */ }
    }
  } catch (e) { errors.metrics = e?.message || String(e); }
  // 과거 구간: 중앙이 직접 수집한 베어메탈 사용률 원시 이력 중 **iDRAC 출처 행만**(엣지 수집분은 엣지 DB 에만 있어 여기서 못 읽는다 — 정직 기록).
  if (!s?.remote) {
    try {
      const { usageCpuRange } = await import('../../bmusage/db.js');
      // v2.680(A-07): usageCpuRange 는 UTC 경계로 묶는다 — 오프셋 버킷이면 1분 단위로 받아 여기서 다시 묶는다(수집 주기 하한이 60초라
      //   1분 칸에 표본은 많아야 하나 — 평균이 표본 평균과 같다).
      const off = win.offsetMs || 0;
      const r = await usageCpuRange([s.serviceTag, s.id, s.fleetId], { agent: config.agent?.name || '', start: win.start, end: win.end, bucketMs: off ? MIN : win.bucketMs, idracOnly: true });
      cpuParts.history = off ? rebucketMean(r.rows, win) : r.rows; cpuHistoryKey = r.key;
      if (r.rows.length && (firstTs == null || r.rows[0].ts < firstTs)) firstTs = r.rows[0].ts;
    } catch (e) { errors.cpuHistory = e?.message || String(e); }
  }
  const cpu = mergeCpuSeries(win, cpuParts);
  out.cpuPct = cpu.series;
  let power = { key: null, reason: 'no-server' };
  try {
    const pdb = await getPowerDb();
    power = powerKeyOf(s, { entries: remotePowerEntries(), hasSeries: (k) => (typeof pdb.latest === 'function' ? pdb.latest(k) != null : false) });
    out.powerW = power.key && pdb.bucketRange ? pdb.bucketRange(power.key, win.start, win.end, win.bucketMs, win.offsetMs || 0) : [];
  } catch (e) { errors.powerW = e?.message || String(e); }
  return { points: mergeSeries(win, out), errors, firstTs, cpuSources: cpu.sources, cpuHistoryKey, power: { found: !!power.key, reason: power.reason }, hostCpuFirstTs, hostGpuFirstTs };
}

/** 점 [{ts,v}] → 오프셋 버킷 평균(순수 — A-07). */
export function rebucketMean(rows, win) {
  const off = win.offsetMs || 0; const B = win.bucketMs; const acc = new Map();
  for (const p of rows || []) {
    const t = Number(p?.ts); const v = p?.v;
    if (!Number.isFinite(t) || typeof v !== 'number' || !Number.isFinite(v)) continue;
    const b = Math.floor((t + off) / B) * B - off;
    const g = acc.get(b) || { s: 0, n: 0 }; g.s += v; g.n += 1; acc.set(b, g);
  }
  return [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([ts, g]) => ({ ts, v: g.s / g.n }));
}

/** id → 서버 객체(중앙 등록 → 엣지 보고 순). */
function serverById(id) {
  return loadIdracRegistry().find((x) => x.id === id) || findRemoteServer(id);
}
/**
 * v2.680(A-04): 요청 하나에서 여러 서버를 찾을 때 — 등록부를 **한 번만** 읽어 색인한다. serverById 를 행마다 부르면
 * loadIdracRegistry 가 매번 statSync + 등록부 전체 structuredClone 을 해서 1,135대 표 한 번에 약 2.6초 동기 정지였다(O(N²)).
 * 엣지 보고분도 한 번에 색인한다(같은 id 는 처음 것 — findRemoteServer 와 같은 순서).
 */
export function serverLookup({ registry = loadIdracRegistry(), remote = null } = {}) {
  const reg = new Map();
  for (const x of registry || []) if (x && !reg.has(String(x.id))) reg.set(String(x.id), x);
  let rem = null;
  const remoteMap = () => {
    if (rem) return rem;
    rem = new Map();
    for (const x of (remote || allRemoteServers()) || []) if (x && !rem.has(String(x.id))) rem.set(String(x.id), x);
    return rem;
  };
  return (id) => reg.get(String(id)) || remoteMap().get(String(id)) || null;
}

/**
 * v2.680(C-05): 범위 계정이면 **범위 밖 vCenter 의 ESXi 호스트와의 매칭은 없는 것으로** 본다 — 그 호스트의 이름·CPU·GPU 계열이
 * 범위 계정에 나가지 않게. 범위 밖 호스트가 있다는 사실도 말하지 않는다(kind 도 베어메탈로).
 */
export function scopeKind(k, sc) {
  if (!sc || !k?.host) return k;
  if (sc.allowed?.has?.(String(k.host.vcenterId || ''))) return k;
  return { ...k, kind: 'baremetal', host: null, matchedBy: null, hostAmbiguous: false, hostTagMismatch: false };
}

/**
 * v2.666: 서버 형태 판정 — 서비스태그가 ESXi 호스트와 같거나, 없으면 **호스트네임**(도메인 제거·대소문자 무시)이 같으면 ESXi
 * (사용자 요청 "hostname 이나 service tag 를 조회해서 매칭"). 색인은 스냅샷 호스트 배열마다 한 번 만든다(서버 목록이 서버 수만큼 부른다).
 * 이름 후보: iDRAC 등록 이름 · 등록 hostName · 인벤토리 system.hostName. IP 는 이름이 아니다(hostShortName 이 뺀다).
 */
const _hostIdx = new WeakMap();
function hostIndex() {
  const hosts = store.get().hosts || [];
  let idx = _hostIdx.get(hosts);
  if (!idx) { idx = buildHostMatchIndex(hosts); _hostIdx.set(hosts, idx); }
  return idx;
}
export function kindOf(s, { index = null, inv = undefined } = {}) {
  const inventory = inv !== undefined ? inv : (getIdracInventory(s.id) || invForServer(s));
  const tag = String(s.serviceTag || inventory?.system?.serviceTag || '').trim();
  const names = [s.name, s.hostName, inventory?.system?.hostName, ...(Array.isArray(s.hostNames) ? s.hostNames : [])];
  const m = matchHostForServer(index || hostIndex(), { serviceTag: tag, names });
  const host = m.host;
  return {
    serviceTag: tag.toUpperCase(), kind: host ? 'esxi' : 'baremetal',
    host: host ? { id: host.id, name: host.name, vcenterId: host.vcenterId || '' } : null,
    matchedBy: m.matchedBy, hostAmbiguous: m.ambiguous, hostTagMismatch: !!m.tagMismatch,
  };
}

/** v2.668: 매칭 호스트에 GPU 장치가 있는가(스냅샷 host.gpus). 모르면 null — 화면이 'GPU 없음' 을 단정하지 않게. */
export function hostHasGpu(host, hosts = null) {
  if (!host?.id) return null;
  const list = hosts || store.get().hosts || [];
  const h = list.find((x) => x.id === host.id);
  if (!h) return null;
  return Array.isArray(h.gpus) ? h.gpus.length > 0 : null;
}

/**
 * v2.676: 서버의 GPU 카드(모델별 장수) — ESXi 스냅샷(매칭 호스트 host.gpus)과 iDRAC 인벤토리(inv.gpus) 둘 다.
 * 모르면 null(못 읽음) · [] 는 '읽었고 0장'. iDRAC 인벤토리의 GPU 컬렉션을 못 읽었으면(collections.gpus==='failed') null 이다.
 */
export function gpuInfoOf(host, inv, hosts = null) {
  let esxi = null;
  if (host?.id) {
    const h = (hosts || store.get().hosts || []).find((x) => x.id === host.id);
    if (h) esxi = gpuCardsOf(Array.isArray(h.gpus) ? h.gpus : null);
  }
  const invFailed = inv?.collections?.gpus === 'failed';
  const idrac = inv && !invFailed ? gpuCardsOf(Array.isArray(inv.gpus) ? inv.gpus : null) : null;
  return { esxi, idrac };
}

/** 선택 목록(범위 절단 후). 법인 이름은 DataCenter 목록에서, 사이트는 스캔 대역 이름. */
/**
 * GPU 온도가 있는 서버(v2.661 — 사용자 요청 "GPU 온도가 있는 서버만 보는 기능"). 판정: 최신 센서에 GPU 역할 온도가 있거나
 * (센서 상세와 같은 roleOf 판정 — trendValuesOf) 추이 DB 에 GPU 온도 계열이 한 번이라도 적재됐다. 지금 iDRAC 이 응답하지 않는
 * GPU 서버를 목록에서 빼지 않으려고 DB 도 본다.
 */
function gpuFlagOf(s, gpuKeys) {
  try {
    const latest = s.remote ? s.sensors : getSensorSeries(String(s.id)).latest;
    if (trendValuesOf(latest).gpuTemp != null) return true;
  } catch { /* 센서 없음 */ }
  return gpuKeys ? gpuKeys(String(s.id)) : false;
}

/*
 * v2.687 — 서버 종류 선택(사용자 요청 "CPU 만 있는 서버, GPU 도 있는 서버, 가상화 서버, 베어메탈 서버 선택"). GPU 판정 근거는 셋이고
 * 하나라도 있으면 'gpu': ① GPU 온도(gpuFlagOf — 예전 'GPU 온도 있는 서버만' 의 기준) ② iDRAC 인벤토리 GPU ③ 매칭 ESXi 호스트의 GPU.
 * 'cpu'(CPU 만)는 **GPU 가 0 장이라고 읽은 근거가 있을 때만**이다 — 인벤토리 GPU 를 못 읽었고 온도도 없으면 'unknown'(판정 불가).
 * 못 읽은 서버를 CPU 만이라 하면 GPU 서버가 'CPU 만' 목록에 섞인다(거짓).
 */
export function gpuStateOf({ temp = false, esxi = null, idrac = null } = {}) {
  // gpuCardsOf 결과({cards,total}) — null 은 '목록을 못 읽음', total 0 은 '읽었고 0 장'.
  const n = (g) => (g && typeof g === 'object' && Number.isFinite(Number(g.total)) ? Number(g.total) : null);
  const e = n(esxi); const i = n(idrac);
  if (temp || (e != null && e > 0) || (i != null && i > 0)) return 'gpu';
  if (e === 0 || i === 0) return 'cpu';
  return 'unknown';
}
/** 종류 선택 판정(순수) — gpu: 'gpu'|'cpu'|'' · kind: 'esxi'|'baremetal'|''. 빈 값은 그 축을 거르지 않는다. 구버전 gpuOnly=1 은 gpu='gpu'. */
export function typeFilterOf(q = {}) {
  const gpu = q.gpuOnly === '1' ? 'gpu' : (q.gpu === 'gpu' || q.gpu === 'cpu' || q.gpu === 'unknown' ? q.gpu : '');
  const kind = q.kind === 'esxi' || q.kind === 'baremetal' ? q.kind : '';
  return { gpu, kind };
}
export function matchType(row, f) {
  if (f.gpu && (row.gpuState || (row.gpu ? 'gpu' : 'unknown')) !== f.gpu) return false;
  if (f.kind && row.kind !== f.kind) return false;
  return true;
}

function serverRows(req, { gpuKeys = null } = {}) {
  const hostMap = new Map((store.get().hosts || []).map((h) => [h.id, h]));
  const idx = scanSiteIndex();
  const all = analysisServersWithRemote().filter((s) => s.type !== 'ome');
  const r = scopeIdracServers(req, all);
  const dcName = new Map(listDatacenters().map((d) => [String(d.id), d.name || d.id]));
  const sc = idracScopeOf(req);
  const rows = r.servers.map((s) => {
    const k = scopeKind(kindOf(s), sc);
    const inv = invForServer(s);
    const temp = gpuFlagOf(s, gpuKeys);
    const h = k.host?.id ? hostMap.get(k.host.id) : null;
    const esxi = h ? gpuCardsOf(Array.isArray(h.gpus) ? h.gpus : null) : null;
    const idrac = inv && inv?.collections?.gpus !== 'failed' ? gpuCardsOf(Array.isArray(inv.gpus) ? inv.gpus : null) : null;
    return {
      id: String(s.id), name: s.name || inv?.system?.hostName || s.id, corp: String(s.datacenterId || ''),
      corpName: s.datacenterId ? (dcName.get(String(s.datacenterId)) || String(s.datacenterId)) : '(법인 미지정)',
      site: siteNameOf(s, idx), serviceTag: k.serviceTag, kind: k.kind, model: s.model || inv?.system?.model || '',
      remote: !!s.remote, dcSource: s.dcSource || '', gpu: temp, gpuState: gpuStateOf({ temp, esxi, idrac }),
      // v2.687: 매칭된 ESXi 호스트 id(범위 밖 호스트는 scopeKind 가 이미 null 로 바꿨다). 서버 표의 ESXi 계열 요약 키다.
      hostId: k.host?.id ? String(k.host.id) : null,
    };
  });
  return { rows, omitted: r.omitted, scoped: !!r.sc };
}

const EXPORT_COLS = { cpuPct: 'CPU 사용률(%)', cpuTemp: 'CPU 온도(℃)', gpuTemp: 'GPU 온도(℃)', inletTemp: '흡기 온도(℃)', exhaustTemp: '배기 온도(℃)', powerW: '소비 전력(W)', hostCpuPct: 'ESXi 호스트 CPU(vCenter, %)', hostGpuPct: 'ESXi 호스트 GPU 사용률(%)', hostGpuMemPct: 'ESXi 호스트 GPU 메모리(%)' };
const EXPORT_COLORS = { cpuPct: '3b82f6', cpuTemp: 'ef4444', gpuTemp: 'a855f7', inletTemp: '06b6d4', exhaustTemp: 'ec4899', powerW: 'f59e0b', hostCpuPct: '22c55e', hostGpuPct: '84cc16', hostGpuMemPct: '14b8a6' };
// v2.662: 엑셀 차트 선 모양 — 기본은 흡기·배기 점선(화면 기본과 같다). 사용자 설정은 ?styles=k:모양:굵기:점,… 로 받고 허용 목록으로 거른다.
const EXPORT_DASH_DEFAULT = { inletTemp: 'dash', exhaustTemp: 'dash', hostCpuPct: 'dot', hostGpuPct: 'dot', hostGpuMemPct: 'dot' };
export function parseExportStyles(q) {
  const out = {};
  for (const part of String(q || '').slice(0, 400).split(',')) {
    const [k, dash, width, dot] = part.split(':');
    if (!EXPORT_COLS[k] || !['solid', 'dash', 'dot', 'dashdot'].includes(dash)) continue;
    const w = Number(width);
    out[k] = { dash, width: Number.isInteger(w) && w >= 1 && w <= 4 ? w : 2, marker: dot === '1' };
  }
  return out;
}
const exportStyleOf = (styles, c) => styles[c] || { dash: EXPORT_DASH_DEFAULT[c] || 'solid', width: 2, marker: false };
/** 엑셀은 서버마다 시트·차트 1장이라 CSV 보다 상한이 작다(뺀 대수는 밝힌다). */
export const XLSX_SERVER_MAX = 40;
const CPU_SOURCE_LABEL = { telemetry: 'iDRAC 텔레메트리', sensor: 'iDRAC CPU 센서', bmIdrac: 'iDRAC 대체 경로', history: 'iDRAC 대체 경로 이력' };
export function cpuSourceText(src) {
  const parts = Object.entries(src || {}).filter(([, n]) => n > 0).map(([k, n]) => `${CPU_SOURCE_LABEL[k] || k} ${n}`);
  return parts.length ? parts.join(' · ') : '없음';
}
/** 엑셀 시트 이름 — 31자 · 금지 문자 제거 · 중복이면 (2)… 를 붙인다. */
export function uniqueSheetName(base, used) {
  const clean = String(base || '서버').replace(/[\[\]:*?\/\\']/g, '_').replace(/^\s+|\s+$/g, '').slice(0, 28) || '서버';
  let name = clean; let n = 2;
  while (used.has(name.toLowerCase())) { name = `${clean.slice(0, 26)}(${n})`; n += 1; }
  used.add(name.toLowerCase());
  return name;
}
function periodLabel(req, win) {
  if (win.custom) return `${localStamp(win.start)} ~ ${localStamp(win.end)}`;
  return PRESETS[req.query.range] ? String(req.query.range) : '24h';
}

/** CSV·엑셀 공통 — 기간·대상·항목·파일 이름. 오류면 응답을 보내고 null. */
function exportJob(req, res, ext, gpuKeys) {
  const keep = trendRetentionDays();
  const win = parseWindow(req.query, { retentionDays: keep });
  if (win.error) { res.status(400).json({ ok: false, reason: win.error }); return null; }
  const { rows } = serverRows(req, { gpuKeys });
  let targets;
  if (req.query.scope === 'dc') {
    const corp = String(req.query.corp ?? ''); const site = String(req.query.site ?? '');
    targets = rows.filter((s) => s.corp === corp && s.site === site);
  } else {
    targets = rows.filter((s) => s.id === String(req.query.id ?? ''));
  }
  if (req.query.scope === 'dc') { const tf = typeFilterOf(req.query); targets = targets.filter((s) => matchType(s, tf)); }
  if (!targets.length) { res.status(404).json(NOT_FOUND); return null; }
  const cols = String(req.query.cols || 'cpuPct,cpuTemp,gpuTemp,inletTemp,exhaustTemp,powerW,hostCpuPct,hostGpuPct,hostGpuMemPct').split(',').filter((c) => EXPORT_COLS[c]);
  if (!cols.length) { res.status(400).json({ ok: false, reason: '내보낼 항목이 없습니다.' }); return null; }
  const max = ext === 'xlsx' ? XLSX_SERVER_MAX : SERVER_EXPORT_MAX;
  const omitted = Math.max(0, targets.length - max);
  const label = String(req.query.scope === 'dc' ? `${targets[0].corpName}-${targets[0].site}` : targets[0].name).replace(/[^\w.\-가-힣]+/g, '_').slice(0, 60);
  const period = win.custom ? `${fileStamp(win.start).slice(0, 8)}-${fileStamp(win.end).slice(0, 8)}` : (PRESETS[req.query.range] ? req.query.range : '24h');
  const stamp = fileStamp();
  return { win, cols, omitted, targets: targets.slice(0, max),
    names: { full: `idrac-trend_${label}_${period}_${stamp}`, ascii: `idrac-trend_${period}_${stamp}` } };
}

/** GPU 온도 계열이 DB 에 한 번이라도 적재된 서버 id 집합(한 번에 읽는다). 실패하면 판정에 쓰지 않는다. */
async function gpuKeysFn() {
  try {
    const db = await getMetricsDb();
    if (typeof db.keysOf !== 'function') return null;
    const keys = db.keysOf(TREND_METRICS.gpuTemp);
    return (id) => keys.has(id);
  } catch { return null; }
}

function sendFile(res, names, ext, type, body, omitted) {
  res.setHeader('Content-Type', type);
  // ASCII 대체 이름에도 기간·시각을 싣는다(웹 downloadFile 이 filename= 을 먼저 읽는다 — 한글 라벨은 filename* 에만).
  res.setHeader('Content-Disposition', `attachment; filename="${names.ascii}.${ext}"; filename*=UTF-8''${encodeURIComponent(`${names.full}.${ext}`)}`);
  if (omitted) res.setHeader('X-Omitted-Servers', String(omitted)); // 상한으로 뺀 대수(조용한 상한 금지)
  res.send(body);
}

/*
 * v2.663 — 서버 표 · 조건 검색(사용자 요청 "데이터 센터 선택하면 전체 서버 리스트를 표 형식으로" + "최근 몇 시간 동안 CPU/GPU 온도
 * 몇 도 이상/이하, 소비 전력 몇 W 이상/이하 검색" — 선택: '최근 N시간 안에 한 번이라도' · 결과는 서버 목록).
 * 한 번에 읽는다 — 지표마다 전 키 요약 1쿼리(metrics statsSinceAll · 전력 statsSince). 서버마다 조회하지 않는다.
 * 조건 판정은 화면(idracTrendText.matchConds)이 한다 — 표 전체를 받으므로 조건을 바꿔도 다시 조회하지 않는다.
 * 정직성: 값이 없는 지표는 null(0 아님). 시간당 롤업 기준이라 창이 앞쪽으로 최대 1시간 넓다 — 응답 since 가 실제 시작을 밝힌다.
 */
export const TABLE_HOURS = Object.freeze({ min: 1, max: 720, def: 24 });
export function tableHoursOf(v) {
  if (v == null || v === '') return TABLE_HOURS.def;
  const n = Number(v);
  return Number.isInteger(n) && n >= TABLE_HOURS.min && n <= TABLE_HOURS.max ? n : null;
}
const TABLE_KEYS = ['cpuPct', 'cpuTemp', 'gpuTemp', 'inletTemp', 'exhaustTemp'];
/*
 * v2.687: 차트에만 있던 ESXi 계열(매칭 호스트의 vCenter CPU · GPU 사용률 · GPU 메모리)도 표·조건 검색 대상이다(사용자 요청 "여기서 볼 수 있는
 * 모든 차트에서 볼 수 있는 값의 변화를 조회"). iDRAC 계열(TABLE_KEYS)과 섞지 않는다 — 키가 서버 id 가 아니라 **매칭 호스트 id** 다.
 * 매칭 호스트가 없는 서버(베어메탈·범위 밖 호스트)는 null(판정 불가) — 0 이 아니다.
 */
export const TABLE_HOST_KEYS = Object.freeze({ hostCpuPct: HOST_CPU_METRIC, ...HOST_GPU_METRICS });
/** 여러 계열 요약을 하나로(CPU 사용률 — 샘플러가 서버·주기마다 한 출처만 적재하므로 합쳐도 이중 계수가 없다). */
export function mergeStats(list) {
  const xs = list.filter((x) => x && x.n > 0);
  if (!xs.length) return null;
  const n = xs.reduce((a, x) => a + x.n, 0);
  return { avg: Math.round((xs.reduce((a, x) => a + x.avg * x.n, 0) / n) * 10) / 10, min: Math.min(...xs.map((x) => x.min)), max: Math.max(...xs.map((x) => x.max)), n };
}
/** 순수 — 서버 행 + 지표 요약 → 표 행. 값이 없으면 null. cur 는 창 안에서 마지막으로 본 값만(오래된 값을 '현재' 라 하지 않는다). */
export function buildTableRows(rows, { stats = {}, latest = {}, power = new Map(), powerKeyFor = () => null, since = 0 } = {}) {
  return rows.map((r) => {
    const out = { ...r };
    for (const k of TABLE_KEYS) {
      const st = k === 'cpuPct' ? mergeStats((stats.cpuPct || []).map((m) => m.get(r.id))) : stats[k]?.get(r.id) || null;
      const cands = (latest[k] || []).map((m) => m.get(r.id)).filter((x) => x && x.ts >= since).sort((a, b) => b.ts - a.ts);
      out[k] = st ? { ...st, cur: cands[0] ? Math.round(cands[0].v * 10) / 10 : null } : null;
    }
    for (const k of Object.keys(TABLE_HOST_KEYS)) {
      const hid = r.hostId ? String(r.hostId) : null;
      const st = hid ? stats[k]?.get(hid) || null : null;
      const lt = hid ? (latest[k] || []).map((m) => m.get(hid)).find((x) => x && x.ts >= since) : null;
      out[k] = st ? { ...st, cur: lt ? Math.round(lt.v * 10) / 10 : null } : null;
    }
    const pk = powerKeyFor(r);
    const ps = pk ? power.get(pk) : null;
    out.powerW = ps && ps.count > 0 ? { avg: ps.avg, min: ps.min, max: ps.peak, n: ps.count, cur: null } : null;
    return out;
  });
}

/*
 * v2.687 — 서버 표에서 찾은 서버의 '언제 · 얼마나' (사용자 요청 "서버를 찾으면 어느 날 어느 시간에 얼마 만큼의 변화가 있었는지 리스트로").
 * 표와 **같은 창(시간 정렬 since ~ now)·같은 시간당 롤업**에서 시간별 평균·최대·최소를 준다 — 표의 최대가 목록의 어느 시간인지 그대로 맞는다.
 * 판정(조건·묶기)은 화면이 한다(idracTrendText.changeEpisodes — 표의 조건 판정과 한 벌). 값이 없는 시간은 행이 없다(0 으로 채우지 않는다).
 */
export const HOURLY_KEYS = Object.freeze(['cpuPct', 'cpuTemp', 'gpuTemp', 'inletTemp', 'exhaustTemp', 'powerW', 'hostCpuPct', 'hostGpuPct', 'hostGpuMemPct']);
/** 같은 시간 칸의 여러 출처(CPU 사용률 3계열 — 샘플러가 서버·주기마다 한 출처만 적재)를 하나로(순수). 평균은 출처 평균의 평균(참고값). */
export function mergeHourly(lists) {
  const m = new Map();
  for (const list of lists) for (const p of list || []) {
    const t = Number(p.ts);
    if (!Number.isFinite(t) || ![p.avg, p.min, p.max].every((x) => typeof x === 'number' && Number.isFinite(x))) continue;
    const g = m.get(t) || { sum: 0, n: 0, min: Infinity, max: -Infinity };
    g.sum += p.avg; g.n += 1; g.min = Math.min(g.min, p.min); g.max = Math.max(g.max, p.max); m.set(t, g);
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([ts, g]) => ({ ts, avg: Math.round((g.sum / g.n) * 10) / 10, min: Math.round(g.min * 10) / 10, max: Math.round(g.max * 10) / 10 }));
}

export const TABLE_MEMO_MS = 30_000;
export function registerIdracTrend(adminRouter) {
  adminRouter.get('/idrac/trend/servers', adminOnly, async (req, res) => {
    const { rows, omitted, scoped } = serverRows(req, { gpuKeys: await gpuKeysFn() });
    res.json({ ok: true, servers: rows, retentionDays: trendRetentionDays(), powerRetentionDays: config.idrac.retentionDays || 0,
      enabled: TREND_SERIES_ENABLED, ...(scoped ? { scoped: true, omittedOutOfScope: omitted } : {}) });
  });

  // v2.663: 서버 표 · 조건 검색. corp·site 에 '*' 를 주면 전체. 조건 판정은 화면이 한다(위 머리말).
  adminRouter.get('/idrac/trend/table', adminOnly, async (req, res) => {
    const hours = tableHoursOf(req.query.hours);
    if (hours == null) return res.status(400).json({ ok: false, reason: `기간은 ${TABLE_HOURS.min}~${TABLE_HOURS.max}시간 정수입니다.` });
    // v2.682(R3P-02): 같은 조건 요청은 계산 1회에 합류하고 30초 기억한다(동시 10건이 같은 계산을 직렬로 10번 하던 것).
    //   키 = 스냅샷 세대(첫 조각 — 세대가 바뀌면 옛 항목을 버린다) + 조건 + 범위 + 역할. 범위·역할이 다르면 다른 판본이다.
    const snap = store.get();
    const allowed = scopedVcenterIds(req.user, snap);
    const tf = typeFilterOf(req.query);
    const cond = [hours, String(req.query.corp ?? '*'), String(req.query.site ?? '*'), tf.gpu, tf.kind].map((x) => encodeURIComponent(String(x).slice(0, 200))).join('|');
    const role = `${req.user?.role || ''}${req.user?.superAdmin ? '+sa' : ''}`;
    const key = `${snap.generatedAt}|idrac-trend-table|${cond}|${allowed ? [...allowed].sort().join(',') : 'all'}|${role}`;
    try {
      const payload = await snapMemo('idrac-trend-table', key, TABLE_MEMO_MS, () => trendTablePayload(req, hours));
      sendCached(req, res, key, payload);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ ok: false, reason: e?.message || 'internal error' });
    }
  });
  async function trendTablePayload(req, hours) {
    const now = Date.now();
    const since = Math.floor((now - hours * HOUR) / HOUR) * HOUR;
    const { rows, omitted, scoped } = serverRows(req, { gpuKeys: await gpuKeysFn() });
    const corp = String(req.query.corp ?? '*'); const site = String(req.query.site ?? '*');
    let targets = rows.filter((r) => (corp === '*' || r.corp === corp) && (site === '*' || r.site === site));
    { const tf = typeFilterOf(req.query); targets = targets.filter((r) => matchType(r, tf)); }
    const errors = {};
    const stats = {}; const latest = {};
    try {
      const db = await getMetricsDb();
      // v2.680(E-02): 키마다 seek + 양보(statsSinceAllAsync) — 지표 파티션 전체를 동기로 훑지 않는다.
      const statsOf = (m) => (typeof db.statsSinceAllAsync === 'function' ? db.statsSinceAllAsync(m, since) : db.statsSinceAll(m, since));
      const read = async (k, metrics) => {
        stats[k] = []; latest[k] = [];
        for (const m of metrics) {
          try { stats[k].push(await statsOf(m)); latest[k].push(db.latestAll(m)); } catch (e) { errors[k] = e?.message || String(e); }
        }
      };
      await read('cpuPct', [TREND_METRICS.cpuPct, CPU_FALLBACK_METRICS.sensor, CPU_FALLBACK_METRICS.bmIdrac]);
      for (const k of ['cpuTemp', 'gpuTemp', 'inletTemp', 'exhaustTemp']) await read(k, [TREND_METRICS[k]]);
      for (const [k, m] of Object.entries(TABLE_HOST_KEYS)) await read(k, [m]);
      for (const k of ['cpuTemp', 'gpuTemp', 'inletTemp', 'exhaustTemp', ...Object.keys(TABLE_HOST_KEYS)]) stats[k] = stats[k][0] || new Map();
    } catch (e) { errors.metrics = e?.message || String(e); }
    let power = new Map(); let powerKeyFor = () => null;
    try {
      const pdb = await getPowerDb();
      power = pdb.statsSince(since);
      const entries = remotePowerEntries();
      const find = serverLookup();
      powerKeyFor = (r) => { const s = find(r.id); return s ? powerKeyOf(s, { entries, hasSeries: (k) => power.has(k) }).key : null; };
    } catch (e) { errors.powerW = e?.message || String(e); }
    const out = buildTableRows(targets, { stats, latest, power, powerKeyFor, since });
    return { ok: true, hours, since, now, rows: out, total: out.length, errors,
      ...(scoped ? { scoped: true, omittedOutOfScope: omitted } : {}) };
  }

  // v2.676: ESXi 호스트 → iDRAC 서버(호스트 상세 '통합 성능 모니터링'). 서비스태그·호스트네임·IP·MAC 을 각각 판정해 근거를 싣는다
  //   (idrac/serverForHost.js). 범위 계정은 범위 안 서버만 후보다(범위 밖 서버의 존재를 말하지 않는다).
  adminRouter.get('/idrac/trend/resolve-host', adminOnly, (req, res) => {
    const hostId = String(req.query.hostId || '').slice(0, 256);
    const hosts = store.get().hosts || [];
    const host = hostId ? hosts.find((h) => String(h.id) === hostId) : null;
    // v2.680(C-04): 범위 밖 vCenter 의 호스트는 없는 것과 같은 404 — 이름·vCenter·존재를 범위 계정에 말하지 않는다.
    const hsc = idracScopeOf(req);
    if (!host || (hsc && !hsc.allowed.has(String(host.vcenterId || '')))) return res.status(404).json({ ok: false, reason: 'no-host', message: '스냅샷에 그 ESXi 호스트가 없습니다(첫 수집 중이거나 삭제됨).' });
    const all = analysisServersWithRemote(req).filter((s) => s.type !== 'ome');
    const r = scopeIdracServers(req, all);
    const out = resolveServerForHost(host, r.servers, {
      invOf: (s) => invForServer(s),
      vcOf: (s) => String(s.vcenterId || s.mappedVcenterId || ''),
    });
    // 양방향 확인 — 그 서버에서 거꾸로 찾은 호스트(kindOf)가 이 호스트인가. 다르면 화면이 말한다(연결은 그대로 — 근거가 있다).
    let reverse = null;
    if (out.serverId) {
      const srv = r.servers.find((s) => String(s.id) === out.serverId);
      try { const k = srv ? scopeKind(kindOf(srv), hsc) : null; reverse = k ? { hostId: k.host?.id || null, same: k.host?.id === host.id } : null; } catch { reverse = null; }
    }
    res.json({ ok: true, hostId: host.id, hostName: host.name, vcenterId: host.vcenterId || '', ...out, reverse,
      ...(r.sc ? { scoped: true } : {}) });
  });

  adminRouter.get('/idrac/trend/export.csv', adminOnly, csvPerm, async (req, res) => {
    const job = exportJob(req, res, 'csv', await gpuKeysFn());
    if (!job) return;
    const { win, targets, cols, omitted, names } = job;
    const lock = acquireExport('idrac-trend-csv', req);
    if (!lock.ok) return res.status(lock.status).json(lock.body);
    try {
      const find = serverLookup(); const sc = idracScopeOf(req);
      const lines = [csvLine(['법인', '서비스', '서버', '서비스태그', '유형', '시각', ...cols.map((c) => EXPORT_COLS[c])])];
      for (const s of targets) {
        const srv = find(s.id);
        if (!srv) continue;
        const { points } = await seriesFor(srv, win, { host: scopeKind(kindOf(srv), sc).host });
        for (const p of points) {
          lines.push(csvLine([s.corpName, s.site, s.name, s.serviceTag, s.kind === 'esxi' ? 'ESXi' : '베어메탈', localStamp(p.t), ...cols.map((c) => (p[c] == null ? '' : p[c]))]));
        }
        await new Promise((r) => setImmediate(r)); // 서버 사이 이벤트 루프 양보(v2.503 대량 export 규약)
      }
      sendFile(res, names, 'csv', 'text/csv; charset=utf-8', CSV_BOM + lines.join('\r\n') + '\r\n', omitted);
    } finally { lock.release(); }
  });

  // v2.661: 엑셀(차트 포함) — 사용자 요청 "엑셀로 차트를 그려 내보내는 기능". 서버마다 시트 1장(데이터 + 꺾은선 차트) + 요약 시트.
  //   차트는 시트의 셀 범위를 참조한다(엑셀에서 값을 고치면 차트도 바뀐다). 결측 셀은 비워 둔다 — 차트는 선을 끊는다.
  adminRouter.get('/idrac/trend/export.xlsx', adminOnly, csvPerm, async (req, res) => {
    const job = exportJob(req, res, 'xlsx', await gpuKeysFn());
    if (!job) return;
    const { win, targets, cols, omitted, names } = job;
    const lineStyles = parseExportStyles(req.query.styles);
    const lock = acquireExport('idrac-trend-xlsx', req);
    if (!lock.ok) return res.status(lock.status).json(lock.body);
    try {
      const find = serverLookup(); const sc = idracScopeOf(req);
      const { default: ExcelJS } = await import('exceljs');
      const wb = new ExcelJS.Workbook();
      wb.creator = 'VMware Global Monitoring Portal';
      const sum = wb.addWorksheet('요약');
      sum.addRow(['iDRAC 통합 추이']);
      sum.addRow(['조회 기간', `${localStamp(win.start)} ~ ${localStamp(win.end)}`]);
      sum.addRow(['집계 단위', `${Math.round(win.bucketMs / 60_000)}분 평균`]);
      sum.addRow(['만든 시각', localStamp(Date.now())]);
      if (omitted) sum.addRow(['뺀 서버', `${omitted}대(엑셀은 서버 ${XLSX_SERVER_MAX}대까지 — 나머지는 CSV 로 내보내세요)`]);
      sum.addRow([]);
      const head = ['법인', '서비스', '서버', '서비스태그', '유형', ...cols.flatMap((c) => [`${EXPORT_COLS[c]} 평균`, `${EXPORT_COLS[c]} 최대`]), 'CPU 사용률 출처', '시트'];
      const headRow = sum.addRow(head);
      headRow.font = { bold: true };
      sum.getRow(1).font = { bold: true, size: 14 };
      const charts = [];
      const used = new Set(['요약']);
      let sheetNo = 1;
      for (const s of targets) {
        const srv = find(s.id);
        if (!srv) continue;
        const { points, cpuSources } = await seriesFor(srv, win, { host: scopeKind(kindOf(srv), sc).host });
        const name = uniqueSheetName(s.name || s.id, used);
        const ws = wb.addWorksheet(name);
        sheetNo += 1;
        ws.addRow(['시각', ...cols.map((c) => EXPORT_COLS[c])]).font = { bold: true };
        for (const p of points) ws.addRow([localStamp(p.t), ...cols.map((c) => (p[c] == null ? null : p[c]))]);
        ws.getColumn(1).width = 18;
        for (let i = 2; i <= cols.length + 1; i += 1) ws.getColumn(i).width = 14;
        ws.views = [{ state: 'frozen', ySplit: 1 }];
        const last = points.length + 1;
        if (points.length) {
          const ref = sheetRef(name);
          charts.push({
            sheet: sheetNo, title: `${s.name || s.id} · ${periodLabel(req, win)}`,
            catRef: `${ref}!$A$2:$A$${last}`,
            series: cols.map((c, i) => ({ nameRef: `${ref}!$${colLetter(i + 2)}$1`, ref: `${ref}!$${colLetter(i + 2)}$2:$${colLetter(i + 2)}$${last}`, color: EXPORT_COLORS[c], ...exportStyleOf(lineStyles, c), axis: c === 'powerW' ? 'secondary' : 'primary' })),
            y1: { title: '% · ℃', min: 0, max: 100 }, y2: { title: 'W', min: 0 },
            anchor: { fromCol: cols.length + 2, fromRow: 1, toCol: cols.length + 16, toRow: 26 },
          });
        }
        const st = (k) => { const v = points.map((p) => p[k]).filter((x) => typeof x === 'number'); return v.length ? [Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10, Math.max(...v)] : [null, null]; };
        sum.addRow([s.corpName, s.site, s.name, s.serviceTag, s.kind === 'esxi' ? 'ESXi' : '베어메탈', ...cols.flatMap((c) => st(c)), cpuSourceText(cpuSources), name]);
        await new Promise((r) => setImmediate(r));
      }
      sum.columns.forEach((c, i) => { c.width = i < 3 ? 18 : 14; });
      const raw = Buffer.from(await wb.xlsx.writeBuffer());
      const buf = await addLineCharts(raw, charts);
      sendFile(res, names, 'xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buf, omitted);
    } catch (e) {
      console.warn(`[idrac] 통합 추이 엑셀 내보내기 실패: ${e?.message || e}`);
      if (!res.headersSent) res.status(500).json({ ok: false, reason: `엑셀 파일을 만들지 못했습니다: ${String(e?.message || e).slice(0, 200)}` });
    } finally { lock.release(); }
  });

  // v2.687: 시간별 평균·최대·최소(서버 표 '변화 시각' 목록). hours 는 표와 같은 규칙(1~720), keys 는 HOURLY_KEYS 안에서만.
  adminRouter.get('/idrac/:id/trend/hourly', adminOnly, async (req, res) => {
    const id = String(req.params.id || '');
    const s = serverById(id);
    if (!s || hiddenByScope(req, s)) return res.status(404).json(NOT_FOUND);
    if (s.type === 'ome') return res.status(400).json({ ok: false, reason: 'OME 소스는 추이를 지원하지 않습니다.' });
    const hours = tableHoursOf(req.query.hours);
    if (hours == null) return res.status(400).json({ ok: false, reason: `기간은 ${TABLE_HOURS.min}~${TABLE_HOURS.max}시간 정수입니다.` });
    const want = String(req.query.keys || '').split(',').map((x) => x.trim()).filter((x) => HOURLY_KEYS.includes(x));
    const keys = want.length ? [...new Set(want)] : [...HOURLY_KEYS];
    const now = Date.now();
    // 표가 조회한 창을 그대로 쓴다(시간 경계를 넘긴 뒤 열어도 표의 판정과 같은 창) — 시간 정렬 + 최대 기간 안일 때만 받는다.
    const qs = Number(req.query.since);
    const since = Number.isInteger(qs) && qs % HOUR === 0 && qs <= now && qs >= now - (TABLE_HOURS.max + 1) * HOUR
      ? qs : Math.floor((now - hours * HOUR) / HOUR) * HOUR;
    const k = scopeKind(kindOf(s), idracScopeOf(req));
    const series = {}; const errors = {};
    try {
      const db = await getMetricsDb();
      const read = (metric, key) => db.historyRange(metric, key, since, now + HOUR, HOUR, 0);
      for (const key of keys) {
        if (key === 'powerW') continue;
        try {
          if (key === 'cpuPct') series[key] = mergeHourly([TREND_METRICS.cpuPct, CPU_FALLBACK_METRICS.sensor, CPU_FALLBACK_METRICS.bmIdrac].map((m) => read(m, id)));
          else if (TABLE_HOST_KEYS[key]) series[key] = k.host?.id ? mergeHourly([read(TABLE_HOST_KEYS[key], String(k.host.id))]) : null;
          else series[key] = mergeHourly([read(TREND_METRICS[key], id)]);
        } catch (e) { errors[key] = e?.message || String(e); series[key] = null; }
      }
    } catch (e) { errors.metrics = e?.message || String(e); }
    if (keys.includes('powerW')) {
      try {
        const pdb = await getPowerDb();
        const pk = powerKeyOf(s, { entries: remotePowerEntries(), hasSeries: (x) => (typeof pdb.latest === 'function' ? pdb.latest(x) != null : false) });
        series.powerW = pk.key && typeof pdb.hourlyStats === 'function' ? pdb.hourlyStats(pk.key, since, now + HOUR) : null;
      } catch (e) { errors.powerW = e?.message || String(e); series.powerW = null; }
    }
    res.json({ ok: true, id, hours, since, now, series, errors, host: k.host ? { id: k.host.id, name: k.host.name } : null });
  });

  adminRouter.get('/idrac/:id/trend', adminOnly, async (req, res) => {
    const id = String(req.params.id || '');
    const s = serverById(id);
    if (!s || hiddenByScope(req, s)) return res.status(404).json(NOT_FOUND);
    if (s.type === 'ome') return res.status(400).json({ ok: false, reason: 'OME 소스는 추이를 지원하지 않습니다.' });
    const keep = trendRetentionDays();
    const win = parseWindow(req.query, { retentionDays: keep });
    if (win.error) return res.status(400).json({ ok: false, reason: win.error });
    const k = scopeKind(kindOf(s), idracScopeOf(req));
    const { points, errors, firstTs, cpuSources, cpuHistoryKey, power, hostCpuFirstTs, hostGpuFirstTs } = await seriesFor(s, win, { host: k.host });
    // v2.665: 지금 CPU 사용률을 iDRAC 의 어느 경로로 읽는지 · 못 읽으면 왜인지 + iDRAC 표본이 지금 들어오는지(멈춤 진단).
    let cpuDiag = null; let idracState = null;
    const now = Date.now();
    let latest = null;
    try { latest = s.remote ? s.sensors : getSensorSeries(String(s.id)).latest; } catch { latest = null; }
    try { cpuDiag = cpuFallbackDiag(s, { latest, cpuIndex: currentCpuIndex(), now }); }
    catch (e) { cpuDiag = { code: 'error', reason: e?.message || String(e) }; }
    try {
      idracState = idracStateOf(s, {
        now, latest, localCycle: s.remote ? null : sensorPollCycle(now),
        collector: s.remote ? getCollectorStatus(s.collectorId) : null,
        showError: !idracScopeOf(req),
        puller: s.remote ? (() => { try { return pullerStatus(now); } catch { return null; } })() : null,
      });
    } catch (e) { idracState = { error: e?.message || String(e) }; }
    const errList = Object.entries(errors);
    if (errList.length) console.warn(`[idrac] 통합 추이 조회 일부 실패(${id}): ${errList.map(([a, b]) => `${a}=${b}`).join(' · ')}`); // 삼키지 않는다(v2.493)
    res.json({
      ok: true, id, ...k, remote: !!s.remote, start: win.start, end: win.end, bucketMs: win.bucketMs, custom: win.custom,
      retentionDays: keep, retention: { metricsDays: keep, powerDays: config.idrac.retentionDays || 0 },
      enabled: TREND_SERIES_ENABLED, airflow: TREND_AIRFLOW_ENABLED, firstTs, points, cpuSources, cpuHistory: cpuHistoryKey ? true : undefined, power, cpuDiag, idracState,
      hostCpu: k.host ? { hostId: k.host.id, hostName: k.host.name, matchedBy: k.matchedBy, firstTs: hostCpuFirstTs } : null,
      hostGpu: k.host ? { hostId: k.host.id, hostName: k.host.name, firstTs: hostGpuFirstTs, hasGpu: hostHasGpu(k.host) } : null,
      gpuCards: (() => { try { return gpuInfoOf(k.host, invForServer(s)); } catch { return null; } })(),
      errors: errList.length ? errors : undefined,
    });
  });
}
