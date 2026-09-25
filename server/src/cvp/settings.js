/**
 * cvp/settings.js — CloudVision(CVP) 수집 설정(v2.608). 파일: CONFIG_DIR/cvp-settings.json(비밀 없음).
 *
 * 규칙(루트 CLAUDE.md):
 *  - **기본 꺼짐(opt-in)** — 운영 CVP 에 주기 접속을 임의로 만들지 않는다.
 *  - 숫자 칸 **빈 값 = 이전 값 유지**(numOrNull ?? cur — 명시적 0 만 값이고, 하한이 0 보다 크면 하한으로 올라간다).
 *    `Number('') === 0` 이 clamp 를 거쳐 보존일·주기를 바꾸던 사고(v2.583·v2.596·v2.599)와 같은 계열을 막는다.
 *  - 값이 바뀌면 리스너로 알린다(무장된 적응 타이머 즉시 재무장 — v2.409).
 *  - 엣지는 중앙 값을 pull 해서 쓴다(`applyCentralSettings`) — 엣지가 자기 복사본을 고집하면 중앙에서 바꾼 값이 영원히 안 먹는다.
 *  - 로드 손상은 preserveCorrupt(설정이 조용히 사라지지 않게).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { numOrNull } from '../util/numOrNull.js';
import { clampSetting } from '../util/clampSetting.js'; // v2.613 DEPS2613-12 · RUNTIME2613-08: 숫자 설정 정규화는 하나(빈 칸 = 미지정)

const FILE = () => path.join(config.configDir, 'cvp-settings.json');

/**
 * 한계·기본값. rawRetentionDays 기본 **7일**(계약 초안은 30일이었다 — 행 수 계산으로 바꿨다: docs/CVP.md 용량 계산).
 */
export const LIMITS = Object.freeze({
  intervalMs: { min: 60_000, max: 24 * 3600_000, def: 5 * 60_000 },
  rawRetentionDays: { min: 1, max: 90, def: 7 },
  dailyRetentionDays: { min: 30, max: 3650, def: 730 },
  concurrency: { min: 1, max: 8, def: 2 },
  deviceTimeoutMs: { min: 30_000, max: 30 * 60_000, def: 120_000 },
});


/** 순수 정규화 — 빈 값·비숫자는 기본값. */
export function normalizeSettings(input = {}) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = { enabled: src.enabled === true };
  for (const [k, l] of Object.entries(LIMITS)) {
    out[k] = clampSetting(src[k], l); // v2.613 DEPS2613-12: 빈 값·비숫자는 기본값(numOrNull 판정)
  }
  return out;
}

/** 패치 병합(순수) — 빈 칸은 이전 값, 명시적 숫자만 반영. 반환은 정규화된 새 값. */
export function mergeSettings(cur, patch = {}) {
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const next = { ...cur };
  if (typeof p.enabled === 'boolean') next.enabled = p.enabled;
  for (const [k, l] of Object.entries(LIMITS)) {
    const n = numOrNull(p[k]);
    if (n == null) continue;            // 빈 칸·비숫자 = 미지정(이전 값 유지)
    next[k] = clampSetting(n, l);
  }
  return normalizeSettings(next);
}

let _cache = null;
export function loadSettings() {
  if (_cache) return { ..._cache };
  let raw = {};
  try {
    if (fs.existsSync(FILE())) raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  } catch (e) { preserveCorrupt(FILE(), e?.message); raw = {}; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { preserveCorrupt(FILE(), '객체가 아닌 JSON 값'); raw = {}; }
  _cache = normalizeSettings(raw);
  return { ..._cache };
}

const _listeners = new Set();
export function onSettingsChange(cb) { _listeners.add(cb); return () => _listeners.delete(cb); }
function notify() { for (const cb of _listeners) { try { cb(); } catch { /* 리스너 실패가 저장을 막지 않는다 */ } } }

export function saveSettings(patch = {}) {
  const cur = loadSettings();
  _cache = mergeSettings(cur, patch);
  atomicWriteFileSync(FILE(), JSON.stringify({ version: 1, ..._cache }, null, 2), { mode: 0o600 });
  if (JSON.stringify(cur) !== JSON.stringify(_cache)) notify();
  return { ..._cache };
}

/**
 * 엣지: 중앙이 내려준 설정 적용. 같으면 파일을 다시 쓰지 않는다. `CVP_SETTINGS_LOCAL=1` 이면 현장 설정을 지킨다.
 * @returns {boolean} 바뀌었는가
 */
export function applyCentralSettings(remote) {
  if (!remote || typeof remote !== 'object' || Array.isArray(remote)) return false;
  if (String(process.env.CVP_SETTINGS_LOCAL || '') === '1') return false;
  const cur = loadSettings();
  const next = normalizeSettings({ ...cur, ...remote });
  if (JSON.stringify(next) === JSON.stringify(cur)) return false;
  _cache = next;
  atomicWriteFileSync(FILE(), JSON.stringify({ version: 1, ..._cache }, null, 2), { mode: 0o600 });
  notify();
  return true;
}

export function _resetForTest() { _cache = null; }
