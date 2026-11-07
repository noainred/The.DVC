/**
 * bmusage/slo.js — 리눅스 성능 6단계 **목표선(SLO)**(설계 PROFILES §16 D · 아트보드 Runbook ‘목표선’).
 *
 * 목표 = 지표 · 비교 기준(평균 · 피크 · p95) · 연산(< ≤ > ≥) · 값 · 목표 달성률(%) · 출처(개별 > 용도 > 역할 — 튜닝 권장값과 같은 우선순위).
 *   ‘역할’ 은 모든 서버의 기본(default) 목표다 — 용도 프로파일(airflow · gpdb)이 같은 지표 · 기준을 덮고, 서버 개별이 그것을 덮는다.
 * 달성률 = **목표 안에 있던 주기 수 ÷ 값이 있는 주기 수**(결측 주기는 분모에서 뺀다 — 그 수를 적는다) · 유지보수 창도 분모에서 빼야 하지만 **원천이 없다**
 *   (5단계 perfAlerts.maintenanceFor 와 같은 정직 기록 — 8단계 정비 창) → maintenance { source:'none', excluded:0 }.
 *   위반 시간 = 위반 주기 × 간격 · 최장 위반 = 연속 위반(결측 주기에서 끊는다 — 모르는 구간을 위반으로 잇지 않는다) · 일 추이 = 날마다 달성률(포탈 날짜) ·
 *   p95 기준 = 기간 안 주기 평균값의 95번째 백분위를 목표와 대 본다(달성률은 주기 평균으로 센다 — 화면이 그 사실을 말한다).
 * 해상도: 창이 20일 이하면 5분 원시(주기 그대로) · 그보다 길면 1시간 롤업(주기 대신 시간 — 화면이 ‘1시간 기준’ 이라고 말한다 · 추이 점 상한 6,000 때문).
 * 설정 파일 `bm-perf-slo.json`(이 노드 · 설정 소유자 등급 저장 · 감사 — 라우트) · 파일 스토어 규약(원자 쓰기 · 손상 보존 · 손상이면 기본값 + loadError).
 * 판정은 이 응답을 만드는 노드가 한다(튜닝 · 용도와 같은 규칙 — 4단계): 엣지 위임 서버도 계열은 엣지 대행(3a 추이)으로 읽고 목표 대조는 여기서.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { makeSettingsLoadError } from '../util/settingsLoadError.js';
import { numOrNull } from '../util/numOrNull.js';
import { dayKey, DAY_OFFSET_MIN } from '../util/dayKey.js';
import { RES_MS } from './trendWindow.js';

const n = numOrNull;
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const FILE = () => path.join(config.configDir, 'bm-perf-slo.json');
/** 목표 지표 화이트리스트(추이 열 — 웹 문구 표와 1:1). */
export const SLO_METRICS = Object.freeze(['cpu_pct', 'mem_pct', 'disk_busy_pct', 'disk_await_ms', 'disk_used_pct', 'net_pct', 'runq_per_core', 'swap_out_ps', 'psi_io_full10', 'psi_mem_full10', 'tcp_retrans_pct', 'net_drop_delta']);
export const SLO_BASES = Object.freeze(['avg', 'peak', 'p95']);
export const SLO_OPS = Object.freeze(['lt', 'le', 'gt', 'ge']);
export const SLO_PROFILES = Object.freeze(['airflow', 'gpdb']);
export const SLO_LIMITS = Object.freeze({ perScope: 12, servers: 500, value: [-1e9, 1e12], objectivePct: [1, 100] });
/** 기본 목표(역할 = 모든 서버) — 아트보드 표 그대로의 시작값(추정 · 현장이 고친다). */
export const SLO_DEFAULTS = Object.freeze({
  default: Object.freeze([
    Object.freeze({ id: 'd-await', metric: 'disk_await_ms', basis: 'peak', op: 'lt', value: 10, objectivePct: 99 }),
    Object.freeze({ id: 'd-runq', metric: 'runq_per_core', basis: 'avg', op: 'lt', value: 1, objectivePct: 99 }),
    Object.freeze({ id: 'd-swap', metric: 'swap_out_ps', basis: 'avg', op: 'le', value: 0, objectivePct: 99 }),
  ]),
  profiles: Object.freeze({ gpdb: Object.freeze([Object.freeze({ id: 'g-space', metric: 'disk_used_pct', basis: 'avg', op: 'lt', value: 75, objectivePct: 99 })]) }),
  servers: Object.freeze({}),
});
const _err = makeSettingsLoadError(FILE, { label: '베어메탈 성능 목표선(SLO)', confirm: () => writeFile(normalizeSlo({}, { strict: false }).value) });
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function fieldError(field, msg) { const e = new Error(`${field}: ${msg}`); e.status = 400; e.field = field; return e; }

/** 정규화(엄격 = 저장 · 느슨 = 읽기). */
export function normalizeSlo(raw, { strict = true } = {}) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  let dropped = 0;
  const bad = (f, m) => { if (strict) throw fieldError(f, m); dropped += 1; };
  const goals = (list, field) => {
    if (list == null) return [];
    if (!Array.isArray(list)) { bad(field, '배열이어야 합니다'); return []; }
    if (list.length > SLO_LIMITS.perScope) bad(field, `${SLO_LIMITS.perScope}개까지입니다`);
    const out = []; const seen = new Set();
    for (const [i, g] of list.slice(0, SLO_LIMITS.perScope).entries()) {
      const f = `${field}[${i}]`;
      if (!g || typeof g !== 'object') { bad(f, '객체여야 합니다'); continue; }
      if (!SLO_METRICS.includes(g.metric)) { bad(`${f}.metric`, '모르는 지표입니다'); continue; }
      if (!SLO_BASES.includes(g.basis)) { bad(`${f}.basis`, 'avg · peak · p95 중 하나입니다'); continue; }
      if (!SLO_OPS.includes(g.op)) { bad(`${f}.op`, 'lt · le · gt · ge 중 하나입니다'); continue; }
      const v = typeof g.value === 'number' ? g.value : Number(g.value);
      if (!Number.isFinite(v) || v < SLO_LIMITS.value[0] || v > SLO_LIMITS.value[1]) { bad(`${f}.value`, '수여야 합니다'); continue; }
      const o = g.objectivePct == null || g.objectivePct === '' ? 99 : Number(g.objectivePct);
      if (!Number.isFinite(o) || o < SLO_LIMITS.objectivePct[0] || o > SLO_LIMITS.objectivePct[1]) { bad(`${f}.objectivePct`, '1~100 입니다'); continue; }
      const k = `${g.metric}|${g.basis}`;
      if (seen.has(k)) { bad(f, '같은 지표 · 기준이 두 번입니다'); continue; }
      seen.add(k);
      out.push({ id: /^[A-Za-z0-9-]{1,24}$/.test(String(g.id || '')) ? String(g.id) : crypto.randomBytes(4).toString('hex'), metric: g.metric, basis: g.basis, op: g.op, value: v, objectivePct: Math.round(o * 10) / 10 });
    }
    return out;
  };
  const prof = {}; const srv = {};
  const pin = r.profiles && typeof r.profiles === 'object' && !Array.isArray(r.profiles) ? r.profiles : {};
  for (const k of Object.keys(pin)) { if (!SLO_PROFILES.includes(k)) { bad(`profiles.${k}`, '모르는 용도입니다'); continue; } const gl = goals(pin[k], `profiles.${k}`); if (gl.length) prof[k] = gl; }
  const sin = r.servers && typeof r.servers === 'object' && !Array.isArray(r.servers) ? r.servers : {};
  const keys = Object.keys(sin);
  if (keys.length > SLO_LIMITS.servers) bad('servers', `${SLO_LIMITS.servers}대까지입니다`);
  for (const k of keys.slice(0, SLO_LIMITS.servers)) {
    if (BAD_KEYS.has(k) || !/^[^\s\u0000-\u001f]{1,256}$/.test(k)) { bad(`servers.${k.slice(0, 20)}`, '서버 키 형식이 다릅니다'); continue; }
    const gl = goals(sin[k], `servers.${k}`); if (gl.length) srv[k] = gl;
  }
  const hasDefault = Object.hasOwn(r, 'default');
  return { value: { v: 1, default: hasDefault ? goals(r.default, 'default') : SLO_DEFAULTS.default.map((g) => ({ ...g })), profiles: Object.hasOwn(r, 'profiles') ? prof : JSON.parse(JSON.stringify(SLO_DEFAULTS.profiles)), servers: srv, by: String(r.by || '').slice(0, 64), at: Number(r.at) || 0 }, dropped };
}
let _cache = null; let _mtime = '';
const mtimeOf = () => { try { const st = fs.statSync(FILE()); return `${st.mtimeMs}:${st.size}`; } catch { return ''; } };
function load() {
  const mt = mtimeOf();
  if (_cache && mt === _mtime) return _cache;
  _mtime = mt;
  if (!mt) { _err.missing(); _cache = normalizeSlo({}, { strict: false }).value; return _cache; }
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('객체가 아닙니다');
    _cache = normalizeSlo(raw, { strict: false }).value; _err.ok();
  } catch (e) {
    preserveCorrupt(FILE(), String(e?.message || e)); _err.corrupt(e);
    console.warn('[bmusage] bm-perf-slo.json 을 읽지 못해 기본 목표로 동작합니다 — 손상본은 보존했습니다');
    _cache = normalizeSlo({}, { strict: false }).value; _mtime = mtimeOf();
  }
  return _cache;
}
function writeFile(obj) { fs.mkdirSync(path.dirname(FILE()), { recursive: true }); atomicWriteFileSync(FILE(), JSON.stringify(obj, null, 2), { mode: 0o600 }); _cache = null; _mtime = ''; _err.ok(); }
export function loadSlo() { return JSON.parse(JSON.stringify(load())); }
export function sloLoadError() { load(); return _err.get(); }
export function saveSlo(body, { by = '' } = {}) {
  const prev = load();
  const { value } = normalizeSlo(body && typeof body === 'object' ? body : {}, { strict: true });
  writeFile({ ...value, by: String(by).slice(0, 64), at: Date.now() });
  return { value: loadSlo(), prev };
}
export function sloAuditSummary(prev, next) {
  const c = (x) => `d${(x?.default || []).length}·p${Object.values(x?.profiles || {}).flat().length}·s${Object.keys(x?.servers || {}).length}`;
  return JSON.stringify({ before: c(prev), after: c(next) }).slice(0, 300);
}

/** 한 서버의 실효 목표(순수) — 같은 지표 · 기준은 개별 > 용도 > 역할(기본). */
export function effectiveGoals(cfg = {}, { key = '', apps = [] } = {}) {
  const by = new Map();
  for (const g of cfg.default || []) by.set(`${g.metric}|${g.basis}`, { ...g, source: 'default' });
  for (const a of apps) for (const g of cfg.profiles?.[a] || []) by.set(`${g.metric}|${g.basis}`, { ...g, source: `profile:${a}` });
  for (const g of (Object.hasOwn(cfg.servers || {}, key) ? cfg.servers[key] : []) || []) by.set(`${g.metric}|${g.basis}`, { ...g, source: 'server' });
  return [...by.values()];
}
const within = (v, op, x) => (op === 'lt' ? v < x : op === 'le' ? v <= x : op === 'gt' ? v > x : v >= x);
export function p95Of(vals) { const a = vals.filter(Number.isFinite).sort((x, y) => x - y); if (!a.length) return null; return a[Math.min(a.length - 1, Math.ceil(0.95 * a.length) - 1)]; }
/** 해상도(순수) — 20일 이하 5분 · 그 위 1시간. */
export function sloRes(from, to) { return to - from <= 20 * 86_400_000 ? '5m' : '1h'; }

/**
 * 한 목표 평가(순수). points = trendWindow.toPoints 모양.
 * @returns {{achievementPct, valid, expected, missing, within, violations:number, violationMs, longest, daily, status, p95, maintenance, bands}}
 */
export function evaluateGoal(goal, points = [], { from, to, stepMs, now = Date.now() } = {}) {
  const step = Math.max(1, n(stepMs) || RES_MS['5m']);
  const pick = (p) => (goal.basis === 'peak' ? (n(p.peak) ?? n(p.max) ?? n(p.avg)) : n(p.avg));
  const pts = (points || []).filter((p) => n(p?.t) != null && p.t >= from && p.t <= to).sort((a, b) => a.t - b.t);
  const vals = pts.map((p) => ({ t: p.t, v: pick(p) })).filter((x) => x.v != null);
  const expected = Math.max(0, Math.floor((Math.min(to, now) - from) / step));
  const valid = vals.length;
  let inCnt = 0; let viol = 0; let longest = null; let run = null; const bands = [];
  let prevT = null;
  for (const x of vals) {
    const ok = within(x.v, goal.op, goal.value);
    const gap = prevT != null && x.t - prevT > step * 1.5;   // 결측 주기 — 연속 위반을 끊는다
    if (ok) { inCnt += 1; if (run) { bands.push(run); run = null; } }
    else {
      viol += 1;
      if (run && !gap) { run.to = x.t + step; run.cycles += 1; }
      else { if (run) bands.push(run); run = { from: x.t, to: x.t + step, cycles: 1 }; }
    }
    prevT = x.t;
  }
  if (run) bands.push(run);
  for (const b of bands) if (!longest || b.cycles > longest.cycles) longest = b;
  const daily = new Map();
  for (const x of vals) { const d = dayKey(x.t) || ''; const c = daily.get(d) || { day: d, in: 0, n: 0 }; c.n += 1; if (within(x.v, goal.op, goal.value)) c.in += 1; daily.set(d, c); }
  const achievementPct = valid ? r1((inCnt / valid) * 100) : null;
  const p95 = goal.basis === 'p95' ? p95Of(vals.map((x) => x.v)) : null;
  const status = valid === 0 ? 'no-data' : (goal.basis === 'p95' ? (within(p95, goal.op, goal.value) ? 'met' : 'missed') : (achievementPct >= goal.objectivePct ? 'met' : 'missed'));
  return {
    achievementPct, valid, expected, missing: Math.max(0, expected - valid), within: inCnt, violations: viol, violationMs: viol * step,
    longest: longest ? { from: longest.from, to: longest.to, cycles: longest.cycles } : null,
    daily: [...daily.values()].map((d) => ({ day: d.day, pct: d.n ? r1((d.in / d.n) * 100) : null })),
    status, p95: r1(p95), maintenance: { source: 'none', excluded: 0 },
    bands: bands.slice(-500).map((b) => ({ from: b.from, to: b.to })),
  };
}
/** 이번 달(포탈 날짜) 창 — 1일 0시(포탈 시각 — util/dayKey 의 경계와 같은 오프셋) ~ 지금. */
export function monthWindow(now = Date.now()) {
  const d = dayKey(now);
  if (!d) return { from: now - 30 * 86_400_000, to: now };
  return { from: Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, 1) - DAY_OFFSET_MIN * 60_000, to: now };
}
export function _resetSloForTest() { _cache = null; _mtime = ''; _err.ok(); }
