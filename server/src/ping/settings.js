/**
 * ping/settings.js — Ping 모니터 측정 설정(v2.964 · 사용자 요청 "화면에서 주기 설정할 수 있게 · ping 은 중단없이 계속 ping").
 *
 * 무엇을 정하나(화면 '측정 설정' — 네트워크 › Ping 모니터링):
 *  · probeIntervalMs  — 대상마다 쉬지 않고 재는 간격(기본 1초). 대상마다 독립 루프라 느린 대상이 다른 대상을 막지 않는다.
 *  · summaryIntervalMs — 그 사이 잰 것을 한 줄(평균·최저·최고·손실)로 묶어 저장하는 주기(기본 = 예전 측정 주기 `PING_MON_INTERVAL_MS`, 1분).
 *  · timeoutMs        — 한 번 잴 때의 시한(기본 `PING_MON_TIMEOUT_MS`, 2.5초).
 *
 * 규약:
 *  · 기본값은 환경 변수(포탈 시작 시 env)이고, 화면에서 저장한 값이 있으면 그것이 이긴다(`source` 가 항목마다 'ui'|'env'|'default' 를 말한다).
 *    저장 파일은 `CONFIG_DIR/ping-settings.json`(원자적 쓰기). 못 읽으면(손상) 원본을 `.corrupt.<ts>` 로 보존하고 기본값으로 돌며 `loadError` 를 싣는다
 *    — 손상을 조용히 빈 값으로 넘겨 다음 저장이 덮어쓰지 않게(server/CLAUDE.md 규약과 같다).
 *  · 범위 밖·숫자 아님은 저장하지 않고 400 사유로 돌려준다(조용히 자르지 않는다). 요약 주기는 측정 간격 이상이어야 한다(칸에 측정이 0회인 줄을 만들지 않게).
 *  · 바뀌면 리스너(`onPingSettingsChange`)를 부른다 — 모니터가 재시작 없이 바로 새 값을 쓴다(루트 CLAUDE.md '사용자가 정하는 주기는 모듈 로드 때 굳히지 말 것').
 *  · 이 파일은 그 포탈(노드) 하나의 설정이다 — 엣지 노드 Ping 은 중앙이 재므로 중앙의 값이 적용된다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { numOrNull } from '../util/numOrNull.js';

const FILE = () => path.join(config.configDir, 'ping-settings.json');

/** 화면·API 범위 — 웹 `pingSettingsText.PING_SETTING_RANGES` 와 같은 값(서버 테스트가 대조한다). */
export const PING_SETTING_RANGES = Object.freeze({
  probeIntervalMs: Object.freeze({ min: 1_000, max: 60_000 }),
  summaryIntervalMs: Object.freeze({ min: 10_000, max: 3_600_000 }),
  timeoutMs: Object.freeze({ min: 200, max: 10_000 }),
});
const KEYS = Object.freeze(Object.keys(PING_SETTING_RANGES));
/** 범위 오류 문구용 화면 이름·단위. */
const LABEL = Object.freeze({ probeIntervalMs: '측정 간격', summaryIntervalMs: '요약(저장) 주기', timeoutMs: '시한' });

const clampTo = (v, { min, max }) => Math.min(max, Math.max(min, v));

/** env 기본값 — 포탈 시작 때의 env 를 범위 안으로(env 는 config.js 가 이미 읽었다 — 여기서 다시 굳히지 않고 부를 때마다 계산). */
export function envDefaults() {
  const probe = numOrNull(config.ping.probeIntervalMs);
  return {
    probeIntervalMs: { value: clampTo(probe ?? 1_000, PING_SETTING_RANGES.probeIntervalMs), source: config.ping.probeFromEnv ? 'env' : 'default' },
    summaryIntervalMs: { value: clampTo(numOrNull(config.ping.pollIntervalMs) ?? 60_000, PING_SETTING_RANGES.summaryIntervalMs), source: config.ping.intervalFromEnv ? 'env' : 'default' },
    timeoutMs: { value: clampTo(numOrNull(config.ping.timeoutMs) ?? 2_500, PING_SETTING_RANGES.timeoutMs), source: config.ping.timeoutFromEnv ? 'env' : 'default' },
  };
}

let _cache = null; let _tok = '';
let _loadError = null;
const _listeners = new Set();
const fileTok = () => { try { const st = fs.statSync(FILE()); return `${st.mtimeMs}:${st.size}`; } catch { return ''; } };

/** 저장된 화면 값(검사를 통과한 항목만) — 파일이 없으면 {}. */
function loadSaved() {
  const tok = fileTok();
  if (_cache && tok === _tok) return _cache;
  _tok = tok;
  if (!tok) { _cache = {}; _loadError = null; return _cache; }
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('객체가 아닙니다');
    const out = {};
    for (const k of KEYS) {
      const v = numOrNull(raw[k]);
      if (v != null && Number.isInteger(v) && v >= PING_SETTING_RANGES[k].min && v <= PING_SETTING_RANGES[k].max) out[k] = v;
    }
    if (out.summaryIntervalMs != null && out.probeIntervalMs != null && out.summaryIntervalMs < out.probeIntervalMs) delete out.summaryIntervalMs;
    out.updatedAt = numOrNull(raw.updatedAt);
    out.updatedBy = typeof raw.updatedBy === 'string' ? raw.updatedBy.slice(0, 64) : null;
    _cache = out; _loadError = null;
  } catch (e) {
    _loadError = { at: Date.now(), reason: safeLoadText(e, 200) || '설정 파일을 읽지 못했습니다(사유 미상)' };
    try { preserveCorrupt(FILE()); } catch { /* 보존 실패는 best effort */ }
    console.warn(`[ping] 측정 설정 파일을 읽지 못해 기본값(환경 변수)으로 동작합니다 — 원본을 보존했습니다: ${_loadError.reason}`);
    _cache = {}; _tok = fileTok();
  }
  return _cache;
}

/** 지금 적용되는 값 + 출처 · 범위 · 기본값 · 마지막 저장 · 읽기 오류. */
export function loadPingSettings() {
  const saved = loadSaved();
  const def = envDefaults();
  const eff = {}; const source = {};
  for (const k of KEYS) {
    if (saved[k] != null) { eff[k] = saved[k]; source[k] = 'ui'; } else { eff[k] = def[k].value; source[k] = def[k].source; }
  }
  // 화면 값과 env 값이 섞여 요약 주기 < 측정 간격이 되면 요약 주기를 측정 간격으로 올린다(칸에 측정 0회를 만들지 않는다).
  if (eff.summaryIntervalMs < eff.probeIntervalMs) eff.summaryIntervalMs = eff.probeIntervalMs;
  return {
    ...eff, source,
    defaults: Object.fromEntries(KEYS.map((k) => [k, def[k].value])),
    ranges: PING_SETTING_RANGES,
    updatedAt: saved.updatedAt ?? null, updatedBy: saved.updatedBy ?? null,
    loadError: _loadError,
  };
}

export function onPingSettingsChange(fn) {
  if (typeof fn !== 'function') return () => {};
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}
function notify(s) { for (const fn of _listeners) { try { fn(s); } catch (e) { console.warn(`[ping] 설정 변경 알림 실패: ${e?.message || e}`); } } }

/**
 * 저장 — patch 의 항목만 바꾼다(없는 항목은 그대로). `reset: true` 면 화면 값을 지우고 env 기본값으로 돌아간다.
 * 항목이 숫자(정수 ms)가 아니거나 범위 밖이면 저장하지 않고 { ok:false, field, reason }.
 */
export function savePingSettings(patch = {}, { actor = '' } = {}) {
  if (_loadError) return { ok: false, field: null, reason: `설정 파일을 읽지 못한 상태라 저장하지 않습니다(원본은 보존했습니다) — ${_loadError.reason}` };
  const cur = loadSaved();
  const next = patch?.reset === true ? {} : { ...Object.fromEntries(KEYS.filter((k) => cur[k] != null).map((k) => [k, cur[k]])) };
  if (patch?.reset !== true) {
    for (const k of KEYS) {
      if (!(k in (patch || {}))) continue;
      const raw = patch[k];
      if (raw === null || raw === '') { delete next[k]; continue; }   // 비우면 그 항목만 기본값으로
      const v = numOrNull(raw);
      const r = PING_SETTING_RANGES[k];
      if (v == null || !Number.isInteger(v)) return { ok: false, field: k, reason: `${LABEL[k]}은(는) 정수(ms)여야 합니다.` };
      if (v < r.min || v > r.max) return { ok: false, field: k, reason: `${LABEL[k]}은(는) ${r.min}~${r.max}ms 사이여야 합니다(입력 ${v}ms).` };
      next[k] = v;
    }
  }
  const def = envDefaults();
  const probe = next.probeIntervalMs ?? def.probeIntervalMs.value;
  const summary = next.summaryIntervalMs ?? def.summaryIntervalMs.value;
  if (summary < probe) return { ok: false, field: 'summaryIntervalMs', reason: `요약(저장) 주기(${summary}ms)는 측정 간격(${probe}ms) 이상이어야 합니다.` };
  const body = { ...next, updatedAt: Date.now(), updatedBy: String(actor || '').slice(0, 64) || null };
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    atomicWriteFileSync(FILE(), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  } catch (e) { return { ok: false, field: null, reason: `저장 실패: ${String(e?.message || e).slice(0, 200)}` }; }
  _cache = null; _tok = '';
  const s = loadPingSettings();
  notify(s);
  return { ok: true, settings: s };
}

/** 저장할 값으로 본 부하·저장 산수 — 화면은 이 값만 쓴다(숫자를 화면에서 다시 계산하지 않는다). */
export function pingLoadOf(s, targetCount) {
  const n = Math.max(0, Math.floor(numOrNull(targetCount) ?? 0));
  const probe = numOrNull(s?.probeIntervalMs) ?? 1_000;
  const summary = numOrNull(s?.summaryIntervalMs) ?? 60_000;
  return {
    targets: n,
    probesPerSec: Math.round((n * 1_000 / probe) * 100) / 100,
    probesPerSummary: Math.max(1, Math.floor(summary / probe)),
    rowsPerDay: Math.round(n * 86_400_000 / summary),
  };
}

/** 테스트용 — 캐시·리스너를 비운다. */
export function _resetPingSettingsForTest() { _cache = null; _tok = ''; _loadError = null; _listeners.clear(); }
