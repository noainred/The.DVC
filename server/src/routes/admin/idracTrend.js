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
import { TREND_METRICS, TREND_SERIES_ENABLED } from '../../idrac/serverTrendSeries.js';
import { siteNameOf } from '../../idrac/scanSite.js';
import { analysisServersWithRemote, scanSiteIndex, invForServer } from '../../insights/analysisServers.js';
import { listDatacenters } from '../../datacenter/store.js';
import { adminOnly } from './shared.js';
import { idracScopeOf, idracInScope, scopeIdracServers } from './idracCore.js';
import { requirePerm } from '../../auth/auth.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { localStamp, fileStamp } from '../../util/dayKey.js';
import { acquireExport } from '../../util/exportBusy.js';

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

async function seriesFor(id, win) {
  const errors = {};
  const out = { cpuPct: [], cpuTemp: [], gpuTemp: [], powerW: [] };
  let firstTs = null;
  try {
    const db = await getMetricsDb();
    for (const k of ['cpuPct', 'cpuTemp', 'gpuTemp']) {
      const metric = TREND_METRICS[k];
      try { out[k] = db.historyRange(metric, id, win.start, win.end, win.bucketMs); }
      catch (e) { errors[k] = e?.message || String(e); }
      try { const m = db.metaKey?.(metric, id); if (m?.firstTs && (firstTs == null || m.firstTs < firstTs)) firstTs = m.firstTs; } catch { /* 첫 관측은 참고값 */ }
    }
  } catch (e) { errors.metrics = e?.message || String(e); }
  try {
    const pdb = await getPowerDb();
    out.powerW = pdb.bucketRange ? pdb.bucketRange(id, win.start, win.end, win.bucketMs) : [];
  } catch (e) { errors.powerW = e?.message || String(e); }
  return { points: mergeSeries(win, out), errors, firstTs };
}

function kindOf(s) {
  const tag = String(s.serviceTag || getIdracInventory(s.id)?.system?.serviceTag || invForServer(s)?.system?.serviceTag || '').trim();
  const host = tag ? findHostByServiceTag(tag, store.get().hosts || []) : null;
  return { serviceTag: tag.toUpperCase(), kind: host ? 'esxi' : 'baremetal', host: host ? { id: host.id, name: host.name, vcenterId: host.vcenterId || '' } : null };
}

/** 선택 목록(범위 절단 후). 법인 이름은 DataCenter 목록에서, 사이트는 스캔 대역 이름. */
function serverRows(req) {
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
      remote: !!s.remote, dcSource: s.dcSource || '',
    };
  });
  return { rows, omitted: r.omitted, scoped: !!r.sc };
}

export function registerIdracTrend(adminRouter) {
  adminRouter.get('/idrac/trend/servers', adminOnly, (req, res) => {
    const { rows, omitted, scoped } = serverRows(req);
    res.json({ ok: true, servers: rows, retentionDays: trendRetentionDays(), powerRetentionDays: config.idrac.retentionDays || 0,
      enabled: TREND_SERIES_ENABLED, ...(scoped ? { scoped: true, omittedOutOfScope: omitted } : {}) });
  });

  adminRouter.get('/idrac/trend/export.csv', adminOnly, csvPerm, async (req, res) => {
    const keep = trendRetentionDays();
    const win = parseWindow(req.query, { retentionDays: keep });
    if (win.error) return res.status(400).json({ ok: false, reason: win.error });
    const { rows } = serverRows(req);
    let targets;
    if (req.query.scope === 'dc') {
      const corp = String(req.query.corp ?? ''); const site = String(req.query.site ?? '');
      targets = rows.filter((s) => s.corp === corp && s.site === site);
    } else {
      targets = rows.filter((s) => s.id === String(req.query.id ?? ''));
    }
    if (!targets.length) return res.status(404).json(NOT_FOUND);
    const lock = acquireExport('idrac-trend-csv', req);
    if (!lock.ok) return res.status(lock.status).json(lock.body);
    try {
      const COLS = { cpuPct: 'CPU 사용률(%)', cpuTemp: 'CPU 온도(℃)', gpuTemp: 'GPU 온도(℃)', powerW: '소비 전력(W)' };
      const cols = String(req.query.cols || 'cpuPct,cpuTemp,gpuTemp,powerW').split(',').filter((c) => COLS[c]);
      if (!cols.length) return res.status(400).json({ ok: false, reason: '내보낼 항목이 없습니다.' });
      const omitted = Math.max(0, targets.length - SERVER_EXPORT_MAX);
      const lines = [csvLine(['법인', '데이터센터', '서버', '서비스태그', '유형', '시각', ...cols.map((c) => COLS[c])])];
      for (const s of targets.slice(0, SERVER_EXPORT_MAX)) {
        const { points } = await seriesFor(s.id, win);
        for (const p of points) {
          lines.push(csvLine([s.corpName, s.site, s.name, s.serviceTag, s.kind === 'esxi' ? 'ESXi' : '베어메탈', localStamp(p.t), ...cols.map((c) => (p[c] == null ? '' : p[c]))]));
        }
        await new Promise((r) => setImmediate(r)); // 서버 사이 이벤트 루프 양보(v2.503 대량 export 규약)
      }
      const label = String(req.query.scope === 'dc' ? `${targets[0].corpName}-${targets[0].site}` : targets[0].name).replace(/[^\w.\-가-힣]+/g, '_').slice(0, 60);
      const period = win.custom ? `${fileStamp(win.start).slice(0, 8)}-${fileStamp(win.end).slice(0, 8)}` : (PRESETS[req.query.range] ? req.query.range : '24h');
      const fname = `idrac-trend_${label}_${period}_${fileStamp()}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="idrac-trend.csv"; filename*=UTF-8''${encodeURIComponent(fname)}`);
      if (omitted) res.setHeader('X-Omitted-Servers', String(omitted)); // 상한으로 뺀 대수(조용한 상한 금지)
      res.send(CSV_BOM + lines.join('\r\n') + '\r\n');
    } finally { lock.release(); }
  });

  adminRouter.get('/idrac/:id/trend', adminOnly, async (req, res) => {
    const id = String(req.params.id || '');
    const s = loadIdracRegistry().find((x) => x.id === id) || findRemoteServer(id);
    if (!s || hiddenByScope(req, s)) return res.status(404).json(NOT_FOUND);
    if (s.type === 'ome') return res.status(400).json({ ok: false, reason: 'OME 소스는 추이를 지원하지 않습니다.' });
    const keep = trendRetentionDays();
    const win = parseWindow(req.query, { retentionDays: keep });
    if (win.error) return res.status(400).json({ ok: false, reason: win.error });
    const k = kindOf(s);
    const { points, errors, firstTs } = await seriesFor(id, win);
    const errList = Object.entries(errors);
    if (errList.length) console.warn(`[idrac] 통합 추이 조회 일부 실패(${id}): ${errList.map(([a, b]) => `${a}=${b}`).join(' · ')}`); // 삼키지 않는다(v2.493)
    res.json({
      ok: true, id, ...k, remote: !!s.remote, start: win.start, end: win.end, bucketMs: win.bucketMs, custom: win.custom,
      retentionDays: keep, retention: { metricsDays: keep, powerDays: config.idrac.retentionDays || 0 },
      enabled: TREND_SERIES_ENABLED, firstTs, points, errors: errList.length ? errors : undefined,
    });
  });
}
