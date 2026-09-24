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
import { DEFAULT_THRESHOLDS } from './counters.js';
import { numOrNull } from '../util/numOrNull.js';

const FILE = path.join(config.configDir, 'vmseries.json');
const FIELDS = ['enabled', 'intervalMin', 'retentionDays', 'thresholds', 'scope', 'targets'];

export const VMSERIES_LIMITS = { minIntervalMin: 20, maxIntervalMin: 60, maxRetentionDays: 1830, maxTargetsPerVcenter: 5000 };

const listeners = new Set();
export function onVmSeriesSettingsChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }

function readFile() {
  if (!fs.existsSync(FILE)) return {};
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch (e) { preserveCorrupt(FILE, e.message); return {}; }
}

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
  const eff = loadVmSeriesSettings();
  for (const cb of listeners) { try { cb(eff); } catch { /* 리스너 오류는 저장을 막지 않는다 */ } }
  return eff;
}

export const vmSeriesSettingsFile = () => FILE;
