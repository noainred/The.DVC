/**
 * sanswitch/perfSettings.js — 포트 사용량(portperfshow) 수집 설정(v2.411, 사용자 요구
 * '설정에서 주기적으로 portperfshow 를 수행해서 포트 사용량 수집').
 *
 * 파일: CONFIG_DIR/sanswitch-perf-settings.json (자격증명 없음 — vault 대상 아님).
 * 원자적 쓰기 + 손상 시 preserveCorrupt 는 동일하게 지킨다(설정이 조용히 사라지지 않게).
 *
 * 하한을 두는 이유: portperfshow 는 매 수집마다 SSH 세션을 열고 sampleSeconds 동안 화면을
 * 받아쓴다. 주기를 60초 밑으로 내리면 스위치에 상시 세션이 붙어 있는 것과 같아지고, 128포트
 * × 스위치 수만큼 매번 DB 에 쓴다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { numOrNull } from '../util/numOrNull.js';

const FILE = path.join(config.configDir, 'sanswitch-perf-settings.json');

export const LIMITS = {
  intervalMs: { min: 60_000, max: 6 * 3600_000, def: 5 * 60_000 },
  sampleSeconds: { min: 3, max: 60, def: 8 },     // portperfshow 를 몇 초 동안 받아쓸지
  retentionDays: { min: 1, max: 3650, def: 90 },
};
const clamp = (v, l, def) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(l.max, Math.max(l.min, Math.round(n)));
};

// v2.599 LO2599-01: 숫자 칸을 비우고 저장하면(''·null·비숫자·0 이하) clamp 가 **기본값**을 줬다 — 예: 보존 3650일 →
// 90일 · 주기 1시간 → 5분(SAN 포트 사용량). v2.596 규약대로 빈 칸은 '미지정' 이고 **이전 값을 유지**한다(판정은 numOrNull — Number('')===0 함정).
function keepPrevBlankNumbers(input, prev) {
  const out = { ...(input && typeof input === 'object' ? input : {}) };
  for (const k of Object.keys(LIMITS)) {
    const n = numOrNull(out[k]);
    if (n == null || n <= 0) out[k] = prev[k];
  }
  return out;
}

let _cache = null;

export function loadPerfSettings() {
  if (_cache) return { ..._cache };
  let raw = {};
  try { if (fs.existsSync(FILE)) raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { preserveCorrupt(FILE); raw = {}; }
  _cache = normalizePerfSettings(raw);
  return { ..._cache };
}

/** 순수 정규화 — 하한/상한 clamp. 기본은 **꺼짐**(운영 스위치에 주기 접속을 임의로 만들지 않는다). */
export function normalizePerfSettings(input = {}) {
  return {
    enabled: input.enabled === true,
    intervalMs: clamp(input.intervalMs, LIMITS.intervalMs, LIMITS.intervalMs.def),
    sampleSeconds: clamp(input.sampleSeconds, LIMITS.sampleSeconds, LIMITS.sampleSeconds.def),
    retentionDays: clamp(input.retentionDays, LIMITS.retentionDays, LIMITS.retentionDays.def),
  };
}

// v2.591 L10: 값이 바뀌면 무장된 타이머를 즉시 재무장하게 알린다(v2.409 '값 변경 시 즉시 재무장' 규약 — vmseries·curuser 와 같은 형태).
//   없으면 주기를 길게 둔 뒤 줄여도 옛 주기(최대 6시간)가 지나야 새 주기가 먹었다.
const _listeners = new Set();
export function onPerfSettingsChange(cb) { _listeners.add(cb); return () => _listeners.delete(cb); }
function notifyChange() { for (const cb of _listeners) { try { cb(); } catch { /* 리스너 실패가 저장을 막지 않는다 */ } } }
export function savePerfSettings(input = {}) {
  _cache = normalizePerfSettings(keepPrevBlankNumbers(input, loadPerfSettings()));
  atomicWriteFileSync(FILE, JSON.stringify({ version: 1, ..._cache }, null, 2), { mode: 0o600 });
  notifyChange();
  return { ..._cache };
}

/**
 * 엣지: 중앙이 내려준 포트 사용량 설정 적용(v2.423). 중앙의 '설정 › 수집 서버 › SAN 스위치 포트 사용량'이 위임 스위치에도
 * 먹어야 한다 — 예전에는 엣지 로컬 설정(기본 꺼짐)만 봐서 중앙에서 켜도 엣지는 수집하지 않았다.
 * `SANSW_PERF_LOCAL=1` 이면 현장 설정을 지킨다(중앙 무시). 값이 같으면 파일을 다시 쓰지 않는다.
 * 반환: true = 바뀌어 적용됨.
 */
export function applyCentralPerfSettings(remote) {
  if (!remote || typeof remote !== 'object') return false;
  if (String(process.env.SANSW_PERF_LOCAL || '') === '1') return false;
  const next = normalizePerfSettings({ ...loadPerfSettings(), ...remote });
  const cur = loadPerfSettings();
  if (JSON.stringify(next) === JSON.stringify(cur)) return false;
  savePerfSettings(next);
  return true;
}

export function _resetForTest() { _cache = null; }
