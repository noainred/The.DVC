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
 * 서버 형태: 서비스태그가 ESXi 호스트와 일치하면 ESXi, 아니면 베어메탈(`findHostByServiceTag` — /idrac/:id/vcenter-host 와 같은 함수).
 * 권한·범위: 다른 iDRAC 상세 라우트와 같다(adminOnly + v2.629 범위 절단 — 범위 밖·귀속 없는 서버는 404).
 *   CSV 는 `data.csv` 권한 + 동시 1건(util/exportBusy — v2.575 규약).
 * 정직성: 결측은 null(CSV 빈 칸)이다 — 0 으로 채우지 않는다. 계열마다 보관 기간이 다르고(전력 DB 는 기본 90일) 그 사실을
 *   응답의 `retention` 으로 싣는다. 첫 관측 이전은 비워 둔다(firstTs).
 * ⚠ '/idrac/trend/*' 는 '/idrac/:id/…' 보다 **먼저** 등록한다(:id 가 'trend' 를 먹지 않게) — admin.js 가 registerIdracScan 앞에서 부른다.
 */
import { loadRegistry as loadIdracRegistry } from '../../idrac/registry.js';
import { findRemoteServer } from '../../collector/remoteInventory.js';
import { getInventory as getIdracInventory } from '../../idrac/invCache.js';
import { findHostByServiceTag } from '../../idrac/hostMatch.js';
import { store } from '../../store.js';
import { config } from '../../config.js';
import { getMetricsDb } from '../../metrics/db.js';
import { loadMetricsSettings } from '../../metrics/settings.js';
import { getDb as getPowerDb } from '../../idrac/db.js';
import { TREND_METRICS, TREND_SERIES_ENABLED, TREND_AIRFLOW_ENABLED, CPU_FALLBACK_METRICS, trendValuesOf, cpuFallbackDiag, currentCpuIndex } from '../../idrac/serverTrendSeries.js';
import { remotePowerEntries, getCollectorStatus } from '../../collector/state.js';
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
import { localStamp, fileStamp } from '../../util/dayKey.js';
import { acquireExport } from '../../util/exportBusy.js';
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

/** 요청 → { start, end, bucketMs, custom } | { error } (순수). 끝은 버킷 경계로 올린 배타 경계. */
export function parseWindow(q, { now = Date.now(), retentionDays = 365 } = {}) {
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
  return { start: Math.floor(start / bucketMs) * bucketMs, end, bucketMs, custom };
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
export function idracStateOf(s, { now = Date.now(), latest = null, localCycle = null, collector = null, showError = false } = {}) {
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
    };
    out.exportAt = numOrNull(s?.pulledAt);
  }
  return out;
}

async function seriesFor(s, win) {
  const id = String(s?.id || '');
  const errors = {};
  const out = { cpuPct: [], cpuTemp: [], gpuTemp: [], inletTemp: [], exhaustTemp: [], powerW: [] };
  const cpuParts = { telemetry: [], sensor: [], bmIdrac: [], history: [] };
  let firstTs = null;
  let cpuHistoryKey = null;
  try {
    const db = await getMetricsDb();
    const read = (k, metric) => {
      try { return db.historyRange(metric, id, win.start, win.end, win.bucketMs); }
      catch (e) { errors[k] = e?.message || String(e); return []; }
    };
    cpuParts.telemetry = read('cpuPct', TREND_METRICS.cpuPct);
    cpuParts.sensor = read('cpuPct', CPU_FALLBACK_METRICS.sensor);
    cpuParts.bmIdrac = read('cpuPct', CPU_FALLBACK_METRICS.bmIdrac);
    out.cpuTemp = read('cpuTemp', TREND_METRICS.cpuTemp);
    out.gpuTemp = read('gpuTemp', TREND_METRICS.gpuTemp);
    out.inletTemp = read('inletTemp', TREND_METRICS.inletTemp);
    out.exhaustTemp = read('exhaustTemp', TREND_METRICS.exhaustTemp);
    for (const metric of [...Object.values(TREND_METRICS), ...Object.values(CPU_FALLBACK_METRICS)]) {
      try { const m = db.metaKey?.(metric, id); if (m?.firstTs && (firstTs == null || m.firstTs < firstTs)) firstTs = m.firstTs; } catch { /* 첫 관측은 참고값 */ }
    }
  } catch (e) { errors.metrics = e?.message || String(e); }
  // 과거 구간: 중앙이 직접 수집한 베어메탈 사용률 원시 이력 중 **iDRAC 출처 행만**(엣지 수집분은 엣지 DB 에만 있어 여기서 못 읽는다 — 정직 기록).
  if (!s?.remote) {
    try {
      const { usageCpuRange } = await import('../../bmusage/db.js');
      const r = await usageCpuRange([s.serviceTag, s.id, s.fleetId], { agent: config.agent?.name || '', start: win.start, end: win.end, bucketMs: win.bucketMs, idracOnly: true });
      cpuParts.history = r.rows; cpuHistoryKey = r.key;
      if (r.rows.length && (firstTs == null || r.rows[0].ts < firstTs)) firstTs = r.rows[0].ts;
    } catch (e) { errors.cpuHistory = e?.message || String(e); }
  }
  const cpu = mergeCpuSeries(win, cpuParts);
  out.cpuPct = cpu.series;
  let power = { key: null, reason: 'no-server' };
  try {
    const pdb = await getPowerDb();
    power = powerKeyOf(s, { entries: remotePowerEntries(), hasSeries: (k) => (typeof pdb.latest === 'function' ? pdb.latest(k) != null : false) });
    out.powerW = power.key && pdb.bucketRange ? pdb.bucketRange(power.key, win.start, win.end, win.bucketMs) : [];
  } catch (e) { errors.powerW = e?.message || String(e); }
  return { points: mergeSeries(win, out), errors, firstTs, cpuSources: cpu.sources, cpuHistoryKey, power: { found: !!power.key, reason: power.reason } };
}

/** id → 서버 객체(중앙 등록 → 엣지 보고 순). */
function serverById(id) {
  return loadIdracRegistry().find((x) => x.id === id) || findRemoteServer(id);
}

function kindOf(s) {
  const tag = String(s.serviceTag || getIdracInventory(s.id)?.system?.serviceTag || invForServer(s)?.system?.serviceTag || '').trim();
  const host = tag ? findHostByServiceTag(tag, store.get().hosts || []) : null;
  return { serviceTag: tag.toUpperCase(), kind: host ? 'esxi' : 'baremetal', host: host ? { id: host.id, name: host.name, vcenterId: host.vcenterId || '' } : null };
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

function serverRows(req, { gpuKeys = null } = {}) {
  const idx = scanSiteIndex();
  const all = analysisServersWithRemote().filter((s) => s.type !== 'ome');
  const r = scopeIdracServers(req, all);
  const dcName = new Map(listDatacenters().map((d) => [String(d.id), d.name || d.id]));
  const rows = r.servers.map((s) => {
    const k = kindOf(s);
    const inv = invForServer(s);
    return {
      id: String(s.id), name: s.name || inv?.system?.hostName || s.id, corp: String(s.datacenterId || ''),
      corpName: s.datacenterId ? (dcName.get(String(s.datacenterId)) || String(s.datacenterId)) : '(법인 미지정)',
      site: siteNameOf(s, idx), serviceTag: k.serviceTag, kind: k.kind, model: s.model || inv?.system?.model || '',
      remote: !!s.remote, dcSource: s.dcSource || '', gpu: gpuFlagOf(s, gpuKeys),
    };
  });
  return { rows, omitted: r.omitted, scoped: !!r.sc };
}

const EXPORT_COLS = { cpuPct: 'CPU 사용률(%)', cpuTemp: 'CPU 온도(℃)', gpuTemp: 'GPU 온도(℃)', inletTemp: '흡기 온도(℃)', exhaustTemp: '배기 온도(℃)', powerW: '소비 전력(W)' };
const EXPORT_COLORS = { cpuPct: '3b82f6', cpuTemp: 'ef4444', gpuTemp: 'a855f7', inletTemp: '06b6d4', exhaustTemp: 'ec4899', powerW: 'f59e0b' };
// v2.662: 엑셀 차트 선 모양 — 기본은 흡기·배기 점선(화면 기본과 같다). 사용자 설정은 ?styles=k:모양:굵기:점,… 로 받고 허용 목록으로 거른다.
const EXPORT_DASH_DEFAULT = { inletTemp: 'dash', exhaustTemp: 'dash' };
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
  if (req.query.scope === 'dc' && req.query.gpuOnly === '1') targets = targets.filter((s) => s.gpu);
  if (!targets.length) { res.status(404).json(NOT_FOUND); return null; }
  const cols = String(req.query.cols || 'cpuPct,cpuTemp,gpuTemp,inletTemp,exhaustTemp,powerW').split(',').filter((c) => EXPORT_COLS[c]);
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
    const pk = powerKeyFor(r);
    const ps = pk ? power.get(pk) : null;
    out.powerW = ps && ps.count > 0 ? { avg: ps.avg, min: ps.min, max: ps.peak, n: ps.count, cur: null } : null;
    return out;
  });
}

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
    const now = Date.now();
    const since = Math.floor((now - hours * HOUR) / HOUR) * HOUR;
    const { rows, omitted, scoped } = serverRows(req, { gpuKeys: await gpuKeysFn() });
    const corp = String(req.query.corp ?? '*'); const site = String(req.query.site ?? '*');
    let targets = rows.filter((r) => (corp === '*' || r.corp === corp) && (site === '*' || r.site === site));
    if (req.query.gpuOnly === '1') targets = targets.filter((r) => r.gpu);
    const errors = {};
    const stats = {}; const latest = {};
    try {
      const db = await getMetricsDb();
      const read = (k, metrics) => {
        stats[k] = []; latest[k] = [];
        for (const m of metrics) {
          try { stats[k].push(db.statsSinceAll(m, since)); latest[k].push(db.latestAll(m)); } catch (e) { errors[k] = e?.message || String(e); }
        }
      };
      read('cpuPct', [TREND_METRICS.cpuPct, CPU_FALLBACK_METRICS.sensor, CPU_FALLBACK_METRICS.bmIdrac]);
      for (const k of ['cpuTemp', 'gpuTemp', 'inletTemp', 'exhaustTemp']) read(k, [TREND_METRICS[k]]);
      for (const k of ['cpuTemp', 'gpuTemp', 'inletTemp', 'exhaustTemp']) stats[k] = stats[k][0] || new Map();
    } catch (e) { errors.metrics = e?.message || String(e); }
    let power = new Map(); let powerKeyFor = () => null;
    try {
      const pdb = await getPowerDb();
      power = pdb.statsSince(since);
      const entries = remotePowerEntries();
      powerKeyFor = (r) => { const s = serverById(r.id); return s ? powerKeyOf(s, { entries, hasSeries: (k) => power.has(k) }).key : null; };
    } catch (e) { errors.powerW = e?.message || String(e); }
    const out = buildTableRows(targets, { stats, latest, power, powerKeyFor, since });
    res.json({ ok: true, hours, since, now, rows: out, total: out.length, errors,
      ...(scoped ? { scoped: true, omittedOutOfScope: omitted } : {}) });
  });

  adminRouter.get('/idrac/trend/export.csv', adminOnly, csvPerm, async (req, res) => {
    const job = exportJob(req, res, 'csv', await gpuKeysFn());
    if (!job) return;
    const { win, targets, cols, omitted, names } = job;
    const lock = acquireExport('idrac-trend-csv', req);
    if (!lock.ok) return res.status(lock.status).json(lock.body);
    try {
      const lines = [csvLine(['법인', '데이터센터', '서버', '서비스태그', '유형', '시각', ...cols.map((c) => EXPORT_COLS[c])])];
      for (const s of targets) {
        const srv = serverById(s.id);
        if (!srv) continue;
        const { points } = await seriesFor(srv, win);
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
      const head = ['법인', '데이터센터', '서버', '서비스태그', '유형', ...cols.flatMap((c) => [`${EXPORT_COLS[c]} 평균`, `${EXPORT_COLS[c]} 최대`]), 'CPU 사용률 출처', '시트'];
      const headRow = sum.addRow(head);
      headRow.font = { bold: true };
      sum.getRow(1).font = { bold: true, size: 14 };
      const charts = [];
      const used = new Set(['요약']);
      let sheetNo = 1;
      for (const s of targets) {
        const srv = serverById(s.id);
        if (!srv) continue;
        const { points, cpuSources } = await seriesFor(srv, win);
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

  adminRouter.get('/idrac/:id/trend', adminOnly, async (req, res) => {
    const id = String(req.params.id || '');
    const s = serverById(id);
    if (!s || hiddenByScope(req, s)) return res.status(404).json(NOT_FOUND);
    if (s.type === 'ome') return res.status(400).json({ ok: false, reason: 'OME 소스는 추이를 지원하지 않습니다.' });
    const keep = trendRetentionDays();
    const win = parseWindow(req.query, { retentionDays: keep });
    if (win.error) return res.status(400).json({ ok: false, reason: win.error });
    const k = kindOf(s);
    const { points, errors, firstTs, cpuSources, cpuHistoryKey, power } = await seriesFor(s, win);
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
      });
    } catch (e) { idracState = { error: e?.message || String(e) }; }
    const errList = Object.entries(errors);
    if (errList.length) console.warn(`[idrac] 통합 추이 조회 일부 실패(${id}): ${errList.map(([a, b]) => `${a}=${b}`).join(' · ')}`); // 삼키지 않는다(v2.493)
    res.json({
      ok: true, id, ...k, remote: !!s.remote, start: win.start, end: win.end, bucketMs: win.bucketMs, custom: win.custom,
      retentionDays: keep, retention: { metricsDays: keep, powerDays: config.idrac.retentionDays || 0 },
      enabled: TREND_SERIES_ENABLED, airflow: TREND_AIRFLOW_ENABLED, firstTs, points, cpuSources, cpuHistory: cpuHistoryKey ? true : undefined, power, cpuDiag, idracState,
      errors: errList.length ? errors : undefined,
    });
  });
}
