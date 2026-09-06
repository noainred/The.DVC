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

export function savePerfSettings(input = {}) {
  _cache = normalizePerfSettings(input);
  atomicWriteFileSync(FILE, JSON.stringify({ version: 1, ..._cache }, null, 2), { mode: 0o600 });
  return { ..._cache };
}

export function _resetForTest() { _cache = null; }
