/**
 * svcstatus/view.js — 감시 대상 + 저장된 측정 → 화면 행(순수 · v3.54). 메인 표 · 알림 · 엣지 설정이 **같은 행**을 본다(판정 복제 금지).
 *
 * 못 잼(unknown)의 사유는 확인한 것만 말한다(값이 없는 이유를 지어내지 않는다 — web.md):
 *   측정 기록 없음 · 측정이 멈춤 · 판정 중 · 담당 엣지 모름 · 엣지 [첫 보고 대기 | 보고 없음 | 버전 낮음 | 버전 모름 | 중앙에서 꺼짐 보고 | 보고에 이 대상이 없음].
 */
import { numOrNull } from '../util/numOrNull.js';
import { presentState, slowAtOf, SEVERITY, MEASURED_STATES } from './judge.js';
import { BUCKET_MS } from './db.js';
import { KIND_LABEL } from './targets.js';
import { classifyCvpEdge } from '../central/cvpEdge.js';

const n = numOrNull;
const t = (v) => String(v ?? '').trim();
export const STRIP_CELLS = 48;   // 24시간 · 30분 칸
const KIND_ORDER = { collector: 0, vcenter: 1, cvp: 2, storage: 3 };

/** 측정 단위 열쇠 — (대상 id, 주소, 포트). 주소 비교는 대소문자 무시. */
export const unitKey = (id, host, port) => `${t(id)}\u0001${t(host).toLowerCase()}\u0001${n(port) ?? ''}`;
/** 'host:port' — IPv6 는 대괄호. */
export function addressOf(host, port) {
  const h = t(host);
  if (!h) return '';
  const hh = h.includes(':') && !h.startsWith('[') ? `[${h}]` : h;
  return n(port) != null ? `${hh}:${port}` : hh;
}

const EDGE_REASON = { 'unknown-version': 'edge-unknown-version', 'old-version': 'edge-old-version', silent: 'edge-silent', waiting: 'edge-waiting' };

/**
 * 엣지가 재는 대상의 '값 없음' 사유.
 * @param {object} ctx `{ reports:Map<agent소문자,{at,disabled,ids:Set}>, versions:Map<agent소문자,ver>, minEdgeVersion, startedAt, intervalMs, staleMs, now }`
 */
export function edgeReasonOf(row, ctx = {}) {
  const key = t(row.by).toLowerCase();
  const rep = ctx.reports?.get?.(key) || null;
  const now = n(ctx.now) ?? Date.now();
  if (rep && now - n(rep.at) <= n(ctx.staleMs)) {
    if (rep.disabled) return 'edge-disabled';
    return 'edge-missing';
  }
  const k = classifyCvpEdge({ edgeVersion: ctx.versions?.get?.(key) || '', minVersion: ctx.minEdgeVersion || '0.0.0', sinceMs: rep ? n(rep.at) : ctx.startedAt, intervalMs: ctx.intervalMs, now });
  return EDGE_REASON[k] || 'edge-waiting';
}

/** 칸 묶음 → 24시간 띠(오래된 → 최근) + 성공률. */
export function stripOf(buckets = [], now = Date.now()) {
  const cur = Math.floor(now / BUCKET_MS) * BUCKET_MS;
  const first = cur - (STRIP_CELLS - 1) * BUCKET_MS;
  const cells = new Array(STRIP_CELLS).fill(null);
  let total = 0; let okN = 0;
  for (const b of buckets) {
    const at = n(b.b);
    if (at == null || at < first || at > cur) continue;
    const i = Math.round((at - first) / BUCKET_MS);
    const cnt = n(b.n) ?? 0;
    if (cnt <= 0) continue;
    cells[i] = Math.max(cells[i] ?? 0, n(b.worst) ?? 0);
    total += cnt; okN += n(b.ok_n) ?? 0;
  }
  return { strip: cells, avail24: total > 0 ? Math.round((okN / total) * 1000) / 10 : null };
}

/**
 * 메인 행 만들기.
 * @param {Array} planRows targets.planTargets 의 rows
 * @param {Map} latestByKey unitKey → sv_latest 행(+ tid)
 * @param {Map} bucketsByTid tid → 칸 배열
 * @param {object} ctx `{ now, settings, staleMs, edge:{…edgeReasonOf ctx}, maskAddress:boolean }`
 */
export function buildRows(planRows = [], latestByKey = new Map(), bucketsByTid = new Map(), ctx = {}) {
  const now = n(ctx.now) ?? Date.now();
  const settings = ctx.settings || {};
  const staleMs = n(ctx.staleMs);
  const rows = [];
  for (const p of planRows) {
    const lat = p.host ? latestByKey.get(unitKey(p.id, p.host, p.port)) || null : null;
    let state; let reason = null;
    if (p.plan === 'problem') { state = 'problem'; reason = 'bad-address'; }
    else if (p.plan === 'off') { state = 'off'; reason = 'disabled'; }
    else if (p.plan === 'excluded') { state = 'excluded'; reason = 'excluded'; }
    else if (p.plan === 'demo-live') { state = 'off'; reason = 'demo-live'; }
    else if (p.plan === 'unassigned') { state = 'unknown'; reason = 'unassigned'; }
    else {
      const ps = presentState(lat, { now, staleMs });
      state = ps.state; reason = ps.reason;
      if (p.plan === 'edge' && (reason === 'no-data' || reason === 'stale')) reason = edgeReasonOf(p, { ...(ctx.edge || {}), now, staleMs });
    }
    if (p.held && state === 'unknown' && !reason) reason = 'registry-held';
    const fresh = lat && staleMs != null && now - n(lat.ts) <= staleMs;
    const measuredNow = MEASURED_STATES.includes(state) && state !== 'unknown';
    const base = lat ? n(lat.base_ms) : null;
    const { strip, avail24 } = lat ? stripOf(bucketsByTid.get(lat.tid) || [], now) : { strip: new Array(STRIP_CELLS).fill(null), avail24: null };
    let since = null;
    if (measuredNow) since = n(lat?.since_ts);
    else if (state === 'unknown' && reason === 'stale' && lat) since = n(lat.ts) + staleMs;   // '언제부터 못 잼' — 마지막 측정 + 멈춤 경계
    const localPort = lat ? n(lat.local_port) : null;
    const note = localPort != null && p.port != null && localPort !== p.port
      ? `엣지의 포트 설정이 중앙과 다릅니다(중앙 ${p.port} · 엣지 ${localPort}) — 엣지는 중앙이 준 ${p.port} 로 잽니다.` : '';
    const hide = !!ctx.maskAddress;
    rows.push({
      id: p.id, kind: p.kind, kindLabel: p.kindLabel || KIND_LABEL[p.kind] || p.kind, sub: p.sub || '', typeLabel: p.typeLabel || '',
      name: p.name, corp: { key: t(p.corp?.key), label: t(p.corp?.label) === '전역' ? '' : t(p.corp?.label) },
      host: hide ? '' : p.host, port: hide ? null : p.port, address: hide ? '' : (p.problem ? p.address : addressOf(p.host, p.port)),
      defaultPort: p.defaultPort, nonDefaultPort: !!p.nonDefaultPort,
      by: p.plan === 'unassigned' ? '' : (p.by === 'central' ? 'central' : p.by), byEdge: p.plan === 'edge',
      state, reason, failKind: lat && fresh && lat.ok === 0 ? t(lat.fk) || null : null,
      ms: lat && fresh && lat.ok === 1 ? n(lat.ms) : null,
      baseMs: base, slowAtMs: slowAtOf(base, settings),
      avail24, strip, since, lastTs: lat ? n(lat.ts) : null, failStreak: lat ? (n(lat.fail_streak) ?? 0) : 0,
      held: !!p.held, demo: !!p.demo, note,
      problem: p.problem || null,
      excluded: p.excluded || null,
      // 서버 전용(응답에서 뺀다) — 알림 · 상세가 쓴다
      _tid: lat ? lat.tid : null, _notified: lat ? (lat.notified ?? null) : null, _host: p.host, _port: p.port,
    });
  }
  rows.sort((a, b) => (SEVERITY[b.state] ?? 0) - (SEVERITY[a.state] ?? 0)
    || (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9)
    || a.corp.label.localeCompare(b.corp.label) || a.name.localeCompare(b.name));
  return rows;
}

/** 응답용 — 서버 전용 칸을 뺀다. */
export const publicRow = (r) => { const { _tid, _notified, _host, _port, ...rest } = r; return rest; };

export function countsOf(rows = []) {
  const c = { total: 0, ok: 0, slow: 0, down: 0, unknown: 0, off: 0, excluded: 0, problem: 0 };
  for (const r of rows) {
    if (c[r.state] != null) c[r.state] += 1;
    if (MEASURED_STATES.includes(r.state)) c.total += 1;
  }
  return c;
}

/**
 * 상세 추이 — 24시간은 원시 표본을 칸(stepMs)으로, 7일 · 30일은 30분 칸을 묶는다.
 * 칸 폭 ≥ 측정 주기 × 1.5(perf-db.md — 주기를 늘리면 칸이 비어 선이 끊긴다).
 */
export const RANGES = Object.freeze({ '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 });
export function stepFor(range, intervalMs) {
  const iv = n(intervalMs) ?? 60_000;
  if (range === '24h') return Math.max(6 * 60_000, Math.ceil((iv * 1.5) / 60_000) * 60_000);
  if (range === '7d') return 60 * 60_000;
  return 6 * 60 * 60_000;
}
export function seriesFromSamples(samples = [], { start, end, stepMs }) {
  const cells = [];
  for (let at = start; at < end; at += stepMs) cells.push({ ts: at, sum: 0, okN: 0, min: null, max: null, n: 0, fail: 0, worst: null });
  for (const s of samples) {
    const ts = n(s.ts); if (ts == null || ts < start || ts >= end) continue;
    const c = cells[Math.floor((ts - start) / stepMs)]; if (!c) continue;
    c.n += 1; c.worst = Math.max(c.worst ?? 0, n(s.st) ?? 0);
    if (s.ok === 1 && n(s.ms) != null) { const ms = n(s.ms); c.sum += ms; c.okN += 1; c.min = c.min == null ? ms : Math.min(c.min, ms); c.max = c.max == null ? ms : Math.max(c.max, ms); } else if (s.ok !== 1) c.fail += 1;
  }
  return cells.map((c) => ({ ts: c.ts, avg: c.okN ? Math.round((c.sum / c.okN) * 10) / 10 : null, min: c.min, max: c.max, n: c.n, fail: c.fail, worst: c.n ? c.worst : null }));
}
export function seriesFromBuckets(buckets = [], { start, end, stepMs }) {
  const cells = [];
  for (let at = start; at < end; at += stepMs) cells.push({ ts: at, sum: 0, msN: 0, max: null, n: 0, okN: 0, worst: null });
  for (const b of buckets) {
    const at = n(b.b); if (at == null || at < start || at >= end) continue;
    const c = cells[Math.floor((at - start) / stepMs)]; if (!c) continue;
    const cnt = n(b.n) ?? 0; if (cnt <= 0) continue;
    c.n += cnt; c.okN += n(b.ok_n) ?? 0; c.sum += n(b.ms_sum) ?? 0; c.msN += n(b.ms_n) ?? 0;
    if (n(b.ms_max) != null) c.max = Math.max(c.max ?? 0, n(b.ms_max));
    c.worst = Math.max(c.worst ?? 0, n(b.worst) ?? 0);
  }
  return cells.map((c) => ({ ts: c.ts, avg: c.msN ? Math.round((c.sum / c.msN) * 10) / 10 : null, min: null, max: c.max, n: c.n, fail: c.n - c.okN, worst: c.n ? c.worst : null }));
}
