/**
 * bmusage/trendQuery.js — 이 노드가 수집한 서버 1대의 추이(v2.922 · 3a). 라우트(`GET /tools/bm-usage/perf/:key/history`)와
 * 엣지 대행 응답(`GET /api/collector/bm-usage/trend`)이 같은 함수를 쓴다 — 중앙은 엣지 응답을 다시 계산하지 않는다.
 *
 *  · 해상도·창·결측·기준선은 trendWindow.js(순수). 데이터는 시간 단위 파일(monthStore)과 예전 표(마이그레이션 중 — db.readRule).
 *  · 1시간 롤업이 아직 안 만들어진 구간(마이그레이션 copy-raw 중 예전 원시 구간)은 **원시로 메우지 않는다**(historyRollup 원본 폴백 금지 —
 *    해상도를 바꾸지 않는다) — 결측 사유 'migrating' 으로 밝힌다.
 *  · 요청 경로의 큰 조회: 파일마다 키 선행 PK 선탐색(agent·key·ts) · 파일 사이 시간 기준 양보(forEachPeriod) · 점 상한(capPoints).
 */
import * as db from './db.js';
import * as month from './monthStore.js';
import { normalizeWindow, pickRes, toPoints, gapsOf, baselineOf, capPoints, RES_MS, SERVER_METRICS, DEVICE_METRICS } from './trendWindow.js';
import { STORE_DEFAULTS, effectiveRawDays } from './settings.js';
import { DAY_OFFSET_MIN } from '../util/dayKey.js';

const dayStart = (day) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) - DAY_OFFSET_MIN * 60_000;

/** 요청 검증(순수) — 지표·종류·장치 이름은 화이트리스트/패턴만. 실패면 { error }. */
export function parseTrendQuery(q = {}) {
  const kind = ['server', 'disk', 'nic', 'mount'].includes(String(q.kind || 'server')) ? String(q.kind || 'server') : null;
  if (!kind) return { error: 'kind 는 server·disk·nic·mount 중 하나입니다.' };
  const metric = String(q.metric || (kind === 'server' ? 'cpu_pct' : kind === 'nic' ? 'util_pct' : kind === 'mount' ? 'used_pct' : 'busy_pct'));
  const allowed = kind === 'server' ? SERVER_METRICS : DEVICE_METRICS[kind];
  if (!allowed.includes(metric)) return { error: `metric 이 이 종류(${kind})에 없습니다.` };
  const dev = kind === 'server' ? '' : String(q.dev || '').trim();
  if (kind !== 'server' && !/^[A-Za-z0-9._:/@+-]{1,256}$/.test(dev)) return { error: '장치(dev)가 필요합니다.' };
  const res = ['auto', '5m', '1h', '1d'].includes(String(q.res || 'auto')) ? String(q.res || 'auto') : 'auto';
  const num = (v) => (v == null || v === '' ? null : Number(v));
  return { kind, metric, dev, res, from: num(q.from), to: num(q.to) };
}

/**
 * @param {{agent:string, key:string, q:object, settings:object, now?:number}} p
 */
export async function trendFor({ agent = '', key, q = {}, settings = {}, now = Date.now() } = {}) {
  const pq = parseTrendQuery(q);
  if (pq.error) return { __status: 400, ok: false, reason: pq.error };
  const win = normalizeWindow({ from: pq.from, to: pq.to, now });
  if (!win) return { __status: 400, ok: false, reason: 'from 이 to 보다 앞이어야 합니다.' };
  const st = settings.store || STORE_DEFAULTS;
  const keepDays = { raw: effectiveRawDays(settings), h1: st.hourlyDays, d1: settings.dailyRetentionDays, dev: st.devRawDays, dev1h: st.devHourlyDays };
  const kind = pq.kind === 'server' ? 'server' : pq.kind;
  const { res, reason: resReason } = pickRes({ ...win, now, req: pq.res, kind, keepDays });
  const stepMs = res === '5m' ? Math.max(RES_MS['5m'], Number(settings.intervalMs) || RES_MS['5m']) : RES_MS[res];
  let rows = []; let meta = {}; const extraGaps = [];
  const rule = await db.migrationReadRule();
  if (kind === 'server') {
    if (res === '5m') {
      const r = await db.rawRangeMerged({ key, agent, from: win.from, to: win.to, limit: 50_000 });
      rows = r.rows; meta = { missingPeriods: r.missingPeriods, filesCapped: r.filesCapped, truncatedRows: r.truncated };
    } else if (res === '1h') {
      const r = await month.readHourlyRange({ agent, key, from: win.from, to: win.to });
      rows = r.rows; meta = { missingPeriods: (r.missingPeriods || []).filter((x) => x.reason !== 'none'), filesCapped: r.filesCapped, truncatedRows: r.truncated };
      if (rule.hourlyPending && rule.legacyMaxTs != null && win.from <= rule.legacyMaxTs) extraGaps.push({ from: win.from, to: Math.min(win.to, month.hourOf(rule.legacyMaxTs) + RES_MS['1h']), reason: 'migrating' });
    } else {
      rows = await db.dailyRangeMerged({ key, agent, from: win.from, to: win.to });
    }
  } else if (kind === 'mount') {
    const r = await month.readMountDaily({ agent, key, mount: pq.dev, from: win.from, to: win.to });
    rows = r.rows; meta = { missingPeriods: (r.missingPeriods || []).filter((x) => x.reason !== 'none'), filesCapped: r.filesCapped };
  } else {
    const r = await month.readDeviceRange({ agent, key, kind, dev: pq.dev, from: win.from, to: win.to, res });
    rows = r.rows; meta = { missingPeriods: (r.missingPeriods || []).filter((x) => x.reason !== 'none'), filesCapped: r.filesCapped, truncatedRows: r.truncated };
  }
  const pts0 = toPoints(rows, { metric: pq.metric, res, kind: kind === 'server' ? 'server' : 'device', dayStart });
  const { points, truncated } = capPoints(pts0);
  const gaps = [...extraGaps, ...gapsOf(points, { from: win.from, to: win.to, stepMs })];
  // 피크 출처 — 원시면 행마다 · 롤업이면 마지막 출처(같은 시간 안 섞임은 피크 표본 수로 밝힌다)
  const srcs = [...new Set(rows.map((r) => r.peak_src).filter(Boolean))];
  return {
    ok: true, key, kind: pq.kind, metric: pq.metric, dev: pq.dev || null, ...win, res, resReason, stepMs,
    points, gaps, baseline: baselineOf(pq.metric, settings.perf), peakSrc: srcs,
    ...(truncated ? { truncated } : {}), ...(meta.truncatedRows ? { truncatedRows: true } : {}),
    ...(meta.missingPeriods?.length ? { missingPeriods: meta.missingPeriods } : {}), ...(meta.filesCapped ? { filesCapped: meta.filesCapped } : {}),
    ...(rule.phase !== 'none' && rule.phase !== 'done' ? { migration: rule.phase } : {}),
  };
}

/** 장치 목록 — 종류별 · 처음 본 순서(색 고정용) · 장치 상한 초과 수(최신값). */
export async function devicesFor({ agent = '', key } = {}) {
  const list = await db.deviceList(key, { agent });
  const out = { disk: [], nic: [], mount: [] };
  for (const d of list) if (out[d.kind]) out[d.kind].push({ dev: d.dev, ord: d.ord, color: d.ord - 1, firstTs: d.first_ts, lastTs: d.last_ts, ...(d.info ? { info: d.info } : {}) });
  const latest = (await db.latestUsage()).find((r) => String(r.key) === String(key) && String(r.agent || '') === String(agent)) || null;
  return { ok: true, key, devices: out, over: latest?.dev_over ?? null, peakSrc: latest?.peak_src ?? null, peakWindowS: latest?.peak_window_s ?? null };
}

/**
 * NIC 최신 5분 행(장치별 이력 — 대조 ⑤ 의 서버 쪽). 최근 3주기 안의 행 중 NIC 마다 마지막 것. 계측 창 길이(spanMs)는 수집 주기다
 *   (5분 값 = 직전 표본과의 차이 — 정확한 길이는 행에 없다 · 주기 ±여유는 대조의 alignPct 가 흡수한다 — 추정).
 */
export async function nicLatestFor({ agent = '', key, intervalMs = 300_000, now = Date.now() } = {}) {
  const iv = Math.max(60_000, Number(intervalMs) || 300_000);
  const from = now - 3 * iv;
  const byDev = new Map();
  await month.forEachPeriod('dev', from, now, (d) => {
    for (const r of d.prepare("SELECT * FROM usage_device_history WHERE agent=? AND key=? AND kind='nic' AND ts>=? AND ts<=? ORDER BY ts").all(String(agent), String(key), from, now)) byDev.set(r.dev, r);
  });
  const nics = [...byDev.values()].map((r) => ({ nic: r.dev, at: r.ts, spanMs: iv, rxBps: r.rx_bps, txBps: r.tx_bps, dropDelta: r.drop_delta, errDelta: r.err_delta, oper: r.oper, speedBps: r.speed_bps }));
  return { ok: true, key, nics };
}
