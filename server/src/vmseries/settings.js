/**
 * vmseries/settings.js — 실시간 스파이크 수집 설정(v2.510). env 기본값 + CONFIG_DIR/vmseries.json 오버레이.
 *
 * 필드
 *  - enabled(bool)        : 수집 on/off. **기본 꺼짐(opt-in)** — 28 vCenter 전체에 실시간 QueryPerf 를
 *                           업그레이드만으로 시작하지 않는다(부하·디스크 모두 운영자가 켜는 결정).
 *  - intervalMin(number)  : 주기(분). 기본 50(사용자 결정). 하한 20(ESXi 실시간 버퍼 60분의 1/3 —
 *                           그 아래는 vCenter 부하만 늘고 얻는 게 없다), 상한 60(버퍼 = 여유 0).
 *  - retentionDays        : 스파이크 원본 보존(기본 60, 사용자 결정). 0 = 무제한.
 *  - thresholds           : { cpuPct, memPct, readyPct } — 지표별 임계(기본 50/50/5).
 *  - scope                : 'all' | 'selected'
 *  - targets              : { [vcenterId]: { all:true } | { clusters:[], folders:[], hosts:[], vms:[] } }
 *
 * 변경은 listeners 에 알린다 — 폴러의 적응형 타이머가 즉시 재무장한다(CLAUDE.md: 주기를 모듈 로드
 * 시 굳히지 말 것). 임계를 바꿔도 과거는 재계산되지 않는다(버린 표본은 없다) — 화면에 명시.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { makeJsonFileReader, READ_RETRY_MS } from '../util/jsonFileRead.js';   // 103회차 F21: 읽기 오류 ≠ 손상
import { makeSettingsLoadError } from '../util/settingsLoadError.js';
import { DEFAULT_THRESHOLDS } from './counters.js';
import { numOrNull } from '../util/numOrNull.js';

const FILE = path.join(config.configDir, 'vmseries.json');
const FIELDS = ['enabled', 'intervalMin', 'retentionDays', 'thresholds', 'scope', 'targets'];

export const VMSERIES_LIMITS = { minIntervalMin: 20, maxIntervalMin: 60, maxRetentionDays: 1830, maxTargetsPerVcenter: 5000 };

const listeners = new Set();
export function onVmSeriesSettingsChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }

// v2.631(EDGE2631-01): 손상 → 보존 → 기본값(env — 보통 꺼짐)을 /api/central/vmseries-config 가 200 으로 내려보내면 엣지가
//   그것을 영구 저장해 수집이 꺼진다. 로드 오류를 기억해 배포 라우트가 503(엣지는 직전 사본 유지)으로 답하게 한다.
const _loadErr = makeSettingsLoadError(() => FILE, { label: '실시간 스파이크 수집 설정', confirm: () => saveVmSeriesSettings({}) });
/*
 * 103회차 F21(재현 — EISDIR): 예전 catch 하나는 **읽기 오류**도 손상으로 보고 원본(수집 켜짐 · 범위 · 보존일 · 대상)을 `.corrupt.*` 로 옮겼다 — 이 파일은 호출마다
 *   읽어 다음 호출부터 env 기본값(보통 꺼짐 · 보존 60일)으로 돌았고, 관리자 저장(거절 없음)이 그 값 위에 썼다. 읽기 단계는 공용 읽기(30초 간격 재읽기):
 *   읽기 오류는 원본을 두고 · **마지막으로 읽은 값**으로 돌며 · 표지(readError — 배포 503 그대로)를 세우고 · 저장을 409 로 거절한다. parse 실패는 예전과 같다.
 *   정리(poller runVmSeriesPrune)는 로드 오류(손상 포함) 동안 상한 보존일로만 한다(83 R1 · 97 F14 와 같은 모양).
 */
const _reader = makeJsonFileReader(() => FILE, { parse: (t) => t, preserve: false, tag: 'vmseries' });
let _lastGood = null;
function readFile() {
  const rr = _reader.read();
  if (rr.kind === 'read-error') { _loadErr.readError(rr.error, { retryMs: READ_RETRY_MS }); return _lastGood ? { ..._lastGood } : {}; }
  if (rr.kind === 'missing') { _loadErr.missing(); _lastGood = null; return {}; }
  try {
    const j = JSON.parse(rr.value);
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('객체가 아닌 JSON 값');
    _loadErr.ok();
    _lastGood = j;
    return { ...j };
  } catch (e) { _loadErr.corrupt(e); preserveCorrupt(FILE, e.message); return {}; }
}
/** v2.631(EDGE2631-01): 설정 파일을 못 읽었으면 사유(배포 라우트가 503 으로 답한다), 읽었으면 null. */
export function vmSeriesSettingsLoadError() { readFile(); return _loadErr.get(); }

// v2.602(감사 TIM2602-02): 빈 값·숫자 아님은 dflt — 예전 Number('') === 0 이 env 빈 값을 보존 0(=무제한)으로 만들었다.
const clampInt = (v, lo, hi, dflt) => {
  const n0 = numOrNull(v);
  if (n0 == null) return dflt;
  const n = Math.floor(n0);
  return Math.max(lo, Math.min(hi, n));
};
const strList = (v, max) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, max) : []);

function coerceTargets(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  const max = VMSERIES_LIMITS.maxTargetsPerVcenter;
  for (const [id, t] of Object.entries(v).slice(0, 200)) {
    const key = String(id || '').trim();
    if (!key || !t || typeof t !== 'object') continue;
    if (t.all === true) { out[key] = { all: true }; continue; }
    out[key] = { clusters: strList(t.clusters, max), folders: strList(t.folders, max), hosts: strList(t.hosts, max), vms: strList(t.vms, max) };
  }
  return out;
}

function coerceThresholds(v) {
  const t = (v && typeof v === 'object') ? v : {};
  const pct = (x, d) => { const n = Number(x); return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 10) / 10 : d; };
  return { cpuPct: pct(t.cpuPct, DEFAULT_THRESHOLDS.cpuPct), memPct: pct(t.memPct, DEFAULT_THRESHOLDS.memPct), readyPct: pct(t.readyPct, DEFAULT_THRESHOLDS.readyPct) };
}

function coerce(field, v) {
  const L = VMSERIES_LIMITS;
  if (field === 'enabled') return v === true;
  if (field === 'intervalMin') return clampInt(v, L.minIntervalMin, L.maxIntervalMin, 50);
  // 음수 보존일은 무제한(0)이 아니라 미지정 — 기본값(v2.602 TIM2602-02). 저장 경로는 이전 값을 유지한다(saveVmSeriesSettings).
  if (field === 'retentionDays') return numOrNull(v) != null && numOrNull(v) < 0 ? 60 : clampInt(v, 0, L.maxRetentionDays, 60);
  if (field === 'thresholds') return coerceThresholds(v);
  if (field === 'scope') return v === 'selected' ? 'selected' : 'all';
  if (field === 'targets') return coerceTargets(v);
  return v;
}

/** 유효 설정 = env 기본값 + 저장된 오버레이. */
export function loadVmSeriesSettings() {
  const L = VMSERIES_LIMITS;
  const eff = {
    enabled: process.env.VMSERIES_ENABLED === 'true',
    intervalMin: clampInt(process.env.VMSERIES_INTERVAL_MIN, L.minIntervalMin, L.maxIntervalMin, 50),
    retentionDays: coerce('retentionDays', process.env.VMSERIES_RETENTION_DAYS),
    thresholds: coerceThresholds({ cpuPct: process.env.VMSERIES_CPU_PCT, memPct: process.env.VMSERIES_MEM_PCT, readyPct: process.env.VMSERIES_READY_PCT }),
    scope: 'all',
    targets: {},
  };
  const persisted = readFile();
  for (const f of FIELDS) if (persisted[f] !== undefined) eff[f] = coerce(f, persisted[f]);
  return eff;
}

/** 부분 업데이트 저장 후 유효 설정 반환 + 리스너 통지. */
export function saveVmSeriesSettings(partial = {}) {
  const next = readFile();
  if (_loadErr.get()?.readError) throw Object.assign(new Error('실시간 스파이크 수집 설정 파일을 읽지 못한 상태라 저장하지 않았습니다 — 읽기 오류이고 원본은 그대로 있습니다. 파일 권한 · 소유자 · 디스크를 확인하세요(30초마다 다시 읽고, 읽히면 저장이 다시 열립니다).'), { status: 409, code: 'settings-unreadable', readError: true });   // 103회차 F21
  // v2.596(감사 CLAMP2596-02 — 재현): 화면이 빈 칸('')을 보내면 Number('')=0 이 되어 임계가 꺼지고(0) 보존일이 무제한(0)이
  //   됐다. 빈 값은 '미지정' 이다 — 그 필드·그 임계는 이전 값을 유지하고, 명시적 0 만 값으로 받는다(util/numOrNull).
  const cur = loadVmSeriesSettings();
  for (const f of FIELDS) {
    if (partial[f] === undefined) continue;
    if ((f === 'intervalMin' || f === 'retentionDays') && numOrNull(partial[f]) == null) continue;
    if (f === 'retentionDays' && numOrNull(partial[f]) < 0) continue;   // v2.602 TIM2602-02: 음수 = 미지정(이전 값)
    if (f === 'thresholds' && partial[f] && typeof partial[f] === 'object') {
      const t = { ...(cur.thresholds || {}) };
      for (const [k, x] of Object.entries(partial[f])) if (numOrNull(x) != null) t[k] = x;
      next[f] = coerce(f, t);
      continue;
    }
    next[f] = coerce(f, partial[f]);
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  _loadErr.ok();
  const eff = loadVmSeriesSettings();
  for (const cb of listeners) { try { cb(eff); } catch { /* 리스너 오류는 저장을 막지 않는다 */ } }
  return eff;
}

export const vmSeriesSettingsFile = () => FILE;

/** 테스트 전용(103회차). */
export function _resetVmSeriesSettingsForTest() { _lastGood = null; _reader.reset(); _loadErr.ok(); }
