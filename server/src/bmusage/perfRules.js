/**
 * bmusage/perfRules.js — 리눅스 성능 5단계(v2.929 예정) **알림 규칙 · 집중 모니터링 · 베이스라인 · 점검 소모품 · 변경 이벤트 · 구간 비교** 설정(설계 PROFILES §13·§14 · 아트보드 Alerts).
 *
 * ⚠ 파일을 나눈 이유: 베어메탈 사용률 설정(`bmusage-settings.json` · settings.js)은 엣지 배포(DISTRIBUTED_KEYS · 서명)와 묶여 있다 — 여기 값을 그 파일에 넣으면
 *   배포 서명이 바뀌어 구버전 엣지가 영원히 ‘적용 대기’ 가 된다(v2.919 `perf` 와 같은 판단). 그래서 **이 노드 전용 파일**(`bm-perf-rules.json`)이고
 *   엣지는 자기 화면에서 정한다. 중앙 → 엣지 배포는 다음 판(전 엣지가 이 판 이상일 때 — 정직 기록 · idrac-server.md v2.929).
 *
 * 규칙(아트보드 ⑨): 종류 6 — use(USE 판정 변화) · cross(교차 판정 성립) · focusEnd(집중 결론) · baseline(베이스라인 이탈) · health(점검 소모품) · profile(용도 점검 실패).
 *   열 — 켬 · 조건 · 지속(주기) · 재발 억제(분) · 채널(기존 알림 채널) · 이슈 자동 등록 · 자동 집중 · 법인 예외. **켠 규칙만 저장한다**(false 를 쌓지 않는다 — v2.550 ‘켠 법인만’ 과 같은 판단).
 * 파일 스토어 규약(perf-db.md v2.582): 원자 쓰기 · 손상 보존 · 손상이면 기본값(전부 꺼짐)으로 동작하고 저장은 거부하지 않되 화면이 loadError 로 말한다(settingsLoadError 등록).
 *   비밀 없음(채널 URL 은 alerts.json 에 있고 여기에는 채널 **이름**만 — 웹훅 URL 은 비밀이라 싣지 않는다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { makeSettingsLoadError } from '../util/settingsLoadError.js';
import { HEALTH_DEFAULTS } from './health.js';

const FILE = () => path.join(config.configDir, 'bm-perf-rules.json');

// 6단계: collect(수집 건강 — 서버가 아니라 이 수집 노드 한 칸: 주기 소요 · 성공률 · DB 상한 · 인증 정지).
export const RULE_IDS = Object.freeze(['use', 'cross', 'focusEnd', 'baseline', 'health', 'profile', 'collect']);
/** 규칙별 조건 선택지(웹 문구 표와 1:1). */
export const RULE_CONDS = Object.freeze({
  use: Object.freeze(['sat-err', 'bottleneck', 'errors']),
  cross: Object.freeze(['any']),
  focusEnd: Object.freeze(['not-ok', 'any']),
  baseline: Object.freeze(['band']),
  health: Object.freeze(['any', 'bad']),
  profile: Object.freeze(['bad']),
  collect: Object.freeze(['any', 'cycle', 'success', 'db', 'auth']),
});
/** 기존 알림 채널(alerts.js channels) — 새 채널을 만들지 않는다. */
export const CHANNELS = Object.freeze(['email', 'webhook', 'slack', 'teams']);
/** 베이스라인 이탈 감시 지표(1시간 롤업에 합·개수가 있는 열). */
export const BASELINE_METRICS = Object.freeze(['cpu_pct', 'mem_pct', 'disk_busy_pct', 'disk_await_ms', 'net_pct']);

/** 규칙 기본값(아트보드 표 그대로 — 꺼짐). */
export const RULE_DEFAULTS = Object.freeze({
  use: Object.freeze({ cond: 'sat-err', sustain: 2, repeatMin: 360, channels: ['email', 'webhook'], issue: false, autoFocus: false }),
  cross: Object.freeze({ cond: 'any', sustain: 1, repeatMin: 1440, channels: ['email'], issue: false, autoFocus: false }),
  focusEnd: Object.freeze({ cond: 'not-ok', sustain: 1, repeatMin: 0, channels: ['email', 'webhook'], issue: false, autoFocus: false }),
  baseline: Object.freeze({ cond: 'band', sustain: 3, repeatMin: 240, channels: ['webhook'], issue: false, autoFocus: false }),
  health: Object.freeze({ cond: 'any', sustain: 1, repeatMin: 720, channels: ['email'], issue: false, autoFocus: false }),
  profile: Object.freeze({ cond: 'bad', sustain: 1, repeatMin: 30, channels: ['email', 'webhook'], issue: false, autoFocus: false }),
  collect: Object.freeze({ cond: 'any', sustain: 2, repeatMin: 360, channels: ['email'], issue: false, autoFocus: false }),
});
export const LIMITS = Object.freeze({
  sustain: [1, 48], repeatMin: [0, 10_080], corpsOff: 200,
  daily: { alerts: [1, 1_000], issues: [1, 500], autoFocus: [1, 200], manualFocus: [1, 500] },
  focus: { intervalS: [30, 600], durationMin: [1, 60], corpMax: [1, 32], nodeMax: [1, 64], keepDays: [1, 90], autoSuppressMin: [5, 1_440] },
  baseline: { weeks: [2, 12], bandPct: [5, 300], minWeeks: [2, 12], maxMissingPct: [0, 90] },
  health: { chronyMs: [1, 600_000], fdPct: [10, 99], conntrackPct: [10, 99], dmesgErr24h: [0, 100_000], certDays: [1, 365] },
  changes: { keepDays: [7, 400] },
  // 6단계: maxServers — 서버 비교 한 화면의 서버 수 상한(설계 §15 ‘2~5대 · 상한 설정 · 기본 5’ — 바깥 한계 8: 열이 늘면 400 폭 · 엣지 요청이 그만큼 는다).
  compare: { diffPct: [1, 500], maxServers: [2, 8] },
  // 6단계 수집 건강 기준(보드 상태 · 알림 규칙 ‘수집 건강’ 행이 같은 값 — collectHealth.collectCells). dbCapGb 0 = 상한 없음(DB 칸은 판정 보류).
  collect: { cyclePct: [10, 100], successPct: [10, 100], dbPct: [10, 100], dbCapGb: [0, 10_000] },
});
export const DEFAULTS = Object.freeze({
  rules: {},
  // manualFocus(반증 F11): 사람이 누르는 집중도 법인당 하루 상한 — 누를 때마다 SSH · Redfish 를 분마다 연다(스냅샷 dailyCorpMax 와 같은 판단).
  daily: { alerts: 50, issues: 20, autoFocus: 10, manualFocus: 20 },
  // 집중 모니터링(§13): 기본 10분 × 1분 · 간격 하한 30초 · 길이 상한 60분 · 법인당 동시 5 · 30일 보관 · 자동 집중은 기본 꺼짐(법인 옵트인) · 같은 서버 재발 억제 30분.
  // nodeMax(반증 L11): 이 노드 전체 동시 집중 상한 — 법인 상한만 있으면 중앙 직접 수집(엣지 없는 법인 여럿)에서 법인 수 × 5 가 앞자리 대기로 슬롯을 먼저 가져간다.
  focus: { intervalS: 60, durationMin: 10, corpMax: 5, nodeMax: 10, keepDays: 30, autoCorps: [], autoSuppressMin: 30 },
  baseline: { weeks: 4, bandPct: 40, minWeeks: 4, maxMissingPct: 25 },
  health: { ...HEALTH_DEFAULTS },
  changes: { keepDays: 30 },
  compare: { diffPct: 20, maxServers: 5 },
  collect: { cyclePct: 80, successPct: 90, dbPct: 90, dbCapGb: 20 },
  // 유지보수 창 억제(Bareos · Veeam 스케줄) — 베어메탈 서버의 백업 창을 읽는 원천이 아직 없다(perfAlerts.maintenanceFor 머리말). 켜 두면 원천이 생길 때 바로 쓴다.
  maintenance: { backupWindows: true },
});

const _err = makeSettingsLoadError(FILE, { label: '베어메탈 성능 알림 규칙 · 집중 모니터링', confirm: () => writeFile(normalizeRules({}, { strict: false }).value) });
let _cache = null; let _mtime = '';
const mtimeOf = () => { try { const st = fs.statSync(FILE()); return `${st.mtimeMs}:${st.size}`; } catch { return ''; } };
function fieldError(field, msg) { const e = new Error(`${field}: ${msg}`); e.status = 400; e.field = field; return e; }
const VC_RE = /^[A-Za-z0-9._:@-]{1,128}$/;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);

/**
 * 정규화(엄격 = 저장 · 느슨 = 읽기). 켠 규칙만 남긴다. 숫자는 범위 밖이면 400(엄격) 또는 기본값(느슨 — 버린 수를 센다).
 * @returns {{ value:object, dropped:number }}
 */
export function normalizeRules(raw, { strict = true } = {}) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  let dropped = 0;
  const bad = (field, msg) => { if (strict) throw fieldError(field, msg); dropped += 1; };
  const int = (v, [lo, hi], field, def) => {
    if (v == null || v === '') return def;
    const x = typeof v === 'number' ? v : (typeof v === 'string' && /^-?\d{1,7}$/.test(v.trim()) ? Number(v) : NaN);
    if (Number.isInteger(x) && x >= lo && x <= hi) return x;
    bad(field, `${lo}~${hi} 의 정수여야 합니다`); return def;
  };
  const vcList = (v, field, max = LIMITS.corpsOff) => {
    if (v == null) return [];
    if (!Array.isArray(v)) { bad(field, '배열이어야 합니다'); return []; }
    const out = [...new Set(v.map((x) => String(x ?? '').trim()).filter(Boolean))];
    if (out.length > max || out.some((x) => !VC_RE.test(x) || BAD_KEYS.has(x))) { bad(field, `vCenter id 형식 · ${max}개까지입니다`); return out.filter((x) => VC_RE.test(x) && !BAD_KEYS.has(x)).slice(0, max); }
    return out;
  };
  const rules = {};
  const rin = r.rules && typeof r.rules === 'object' && !Array.isArray(r.rules) ? r.rules : {};
  for (const id of Object.keys(rin)) if (!RULE_IDS.includes(id)) bad(`rules.${id}`, '모르는 규칙입니다');
  for (const id of RULE_IDS) {
    const x = Object.hasOwn(rin, id) ? rin[id] : null;
    if (!x || typeof x !== 'object' || Array.isArray(x)) continue;
    if (x.on !== true) continue;   // 켠 규칙만 저장(false 를 쌓지 않는다)
    const d = RULE_DEFAULTS[id];
    const cond = x.cond == null ? d.cond : (RULE_CONDS[id].includes(x.cond) ? x.cond : (bad(`rules.${id}.cond`, `${RULE_CONDS[id].join('·')} 중 하나여야 합니다`), d.cond));
    let channels = d.channels;
    if (x.channels != null) {
      if (!Array.isArray(x.channels) || x.channels.some((c) => !CHANNELS.includes(c))) { bad(`rules.${id}.channels`, `${CHANNELS.join('·')} 만 쓸 수 있습니다`); channels = (Array.isArray(x.channels) ? x.channels : []).filter((c) => CHANNELS.includes(c)); }
      else channels = [...new Set(x.channels)];
    }
    rules[id] = {
      on: true, cond,
      sustain: int(x.sustain, LIMITS.sustain, `rules.${id}.sustain`, d.sustain),
      repeatMin: int(x.repeatMin, LIMITS.repeatMin, `rules.${id}.repeatMin`, d.repeatMin),
      channels,
      issue: x.issue === true,
      // 집중 결론 규칙은 그 자체가 집중의 끝이라 자동 집중을 걸지 않는다(되먹임 고리). 수집 건강은 서버가 아니라 노드 칸이라 집중 대상이 없다.
      autoFocus: id === 'focusEnd' || id === 'collect' ? false : x.autoFocus === true,
      corpsOff: vcList(x.corpsOff, `rules.${id}.corpsOff`),
    };
  }
  const sec = (name, defs, lim) => {
    const s = r[name] && typeof r[name] === 'object' && !Array.isArray(r[name]) ? r[name] : {};
    const out = {};
    for (const k of Object.keys(defs)) {
      if (Array.isArray(defs[k])) continue;
      if (typeof defs[k] === 'boolean') { out[k] = s[k] == null ? defs[k] : s[k] === true; continue; }
      out[k] = lim?.[k] ? int(s[k], lim[k], `${name}.${k}`, defs[k]) : defs[k];
    }
    return { s, out };
  };
  const daily = sec('daily', DEFAULTS.daily, LIMITS.daily).out;
  const fs0 = sec('focus', DEFAULTS.focus, LIMITS.focus);
  const focus = { ...fs0.out, autoCorps: vcList(fs0.s.autoCorps, 'focus.autoCorps') };
  const baseline = sec('baseline', DEFAULTS.baseline, LIMITS.baseline).out;
  if (baseline.minWeeks > baseline.weeks) { bad('baseline.minWeeks', '표본 주 수(weeks)보다 클 수 없습니다'); baseline.minWeeks = baseline.weeks; }
  const health = sec('health', DEFAULTS.health, LIMITS.health).out;
  const changes = sec('changes', DEFAULTS.changes, LIMITS.changes).out;
  const compare = sec('compare', DEFAULTS.compare, LIMITS.compare).out;
  const collect = sec('collect', DEFAULTS.collect, LIMITS.collect).out;
  const maintenance = sec('maintenance', DEFAULTS.maintenance, null).out;
  return {
    value: { v: 1, rules, daily, focus, baseline, health, changes, compare, collect, maintenance, by: String(r.by || '').slice(0, 64), at: Number(r.at) || 0 },
    dropped,
  };
}

function load() {
  const mt = mtimeOf();
  if (_cache && mt === _mtime) return _cache;
  _mtime = mt;
  if (!mt) { _err.missing(); _cache = normalizeRules({}, { strict: false }).value; return _cache; }
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('객체가 아닙니다');
    const { value, dropped } = normalizeRules(raw, { strict: false });
    if (dropped) console.warn(`[bmusage] bm-perf-rules.json 의 형식 밖 항목 ${dropped}개를 읽지 않았습니다(기본값으로)`);
    _cache = value;
    _err.ok();
  } catch (e) {
    preserveCorrupt(FILE(), String(e?.message || e));
    _err.corrupt(e);
    console.warn('[bmusage] bm-perf-rules.json 을 읽지 못해 기본값(알림 규칙 전부 꺼짐 · 자동 집중 꺼짐)으로 동작합니다 — 손상본은 보존했습니다');
    _cache = normalizeRules({}, { strict: false }).value;
    _mtime = mtimeOf();
  }
  return _cache;
}
function writeFile(obj) {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  atomicWriteFileSync(FILE(), JSON.stringify(obj, null, 2), { mode: 0o600 });
  _cache = null; _mtime = '';
  _err.ok();
  for (const fn of _listeners) { try { fn(); } catch { /* 구독자 오류는 저장을 막지 않는다 */ } }
}
const _listeners = new Set();
export function onPerfRulesChange(fn) { if (typeof fn === 'function') _listeners.add(fn); return () => _listeners.delete(fn); }

/** 현재 설정(사본). */
export function loadPerfRules() { return JSON.parse(JSON.stringify(load())); }
export function perfRulesLoadError() { load(); return _err.get(); }
/**
 * 저장(엄격 정규화 — 형식 밖은 400). 반환: 저장된 값 + 이전 값(감사 diff 용 — 비밀 없음).
 */
export function savePerfRules(body, { by = '' } = {}) {
  const prev = load();
  const { value } = normalizeRules({ ...(body && typeof body === 'object' ? body : {}) }, { strict: true });
  const next = { ...value, by: String(by).slice(0, 64), at: Date.now() };
  writeFile(next);
  return { ok: true, value: loadPerfRules(), prev };
}
/** 감사 요약 — 켠 규칙 id · 바뀐 절(비밀 없음 · 300자). */
export function rulesAuditSummary(prev, next) {
  const on = (x) => Object.keys(x?.rules || {}).sort().join(',');
  const changed = ['daily', 'focus', 'baseline', 'health', 'changes', 'compare', 'collect', 'maintenance'].filter((k) => JSON.stringify(prev?.[k]) !== JSON.stringify(next?.[k]));
  return JSON.stringify({ before: on(prev), after: on(next), changed }).slice(0, 300);
}
export function _resetPerfRulesForTest() { _cache = null; _mtime = ''; _err.ok(); _listeners.clear(); }
