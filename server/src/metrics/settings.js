/**
 * Runtime-editable metrics sampler settings (온도/용량/GPU 수집 주기·보존기간).
 * Env vars provide the defaults (config.temp); values saved from the portal are
 * persisted to config/metrics.json (gitignored) and take precedence. The sampler
 * reloads and reschedules itself whenever these change.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js'; // v2.478(감사 B5/S12): 원자적 쓰기 + 손상 시 preserveCorrupt — 크래시 1회로 설정이 소실되고 다음 저장이 빈 값으로 덮어쓰는 사고 방지
import { numOrNull } from '../util/numOrNull.js';

const FILE = path.join(config.configDir, 'metrics.json');

// Fields editable from the portal.
const FIELDS = ['sampleIntervalMs', 'retentionDays', 'rawRetentionDays', 'gpuUtilEnabled', 'gpuUtilIntervalSec'];

// Guardrails: don't let the UI set an interval so small it hammers vCenter.
const MIN_INTERVAL_MS = 10_000;   // 10초
const MAX_INTERVAL_MS = 86_400_000; // 24시간
const MIN_GPU_SEC = 20, MAX_GPU_SEC = 86_400;
// 숫자 필드 — 빈 값('', null, 숫자 아님)은 '미지정' 으로 본다(v2.598 L2598-02).
const NUMERIC = new Set(['sampleIntervalMs', 'retentionDays', 'rawRetentionDays', 'gpuUtilIntervalSec']);

function readFile() {
  if (!fs.existsSync(FILE)) return {};
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch (e) { preserveCorrupt(FILE, e.message); return {}; }
}

/** Effective settings = env defaults overlaid with persisted overrides. */
export function loadMetricsSettings() {
  // rawRetentionDays(v2.451): **원본(분 단위)** 보존기간. 롤업(시간당 평균·최소·최대)은
  // retentionDays 만큼 그대로 남는다. 0 = 원본도 retentionDays 를 따름(예전 동작).
  const eff = { sampleIntervalMs: config.temp.sampleIntervalMs, retentionDays: config.temp.retentionDays, rawRetentionDays: config.temp.rawRetentionDays, gpuUtilEnabled: true, gpuUtilIntervalSec: 60 };
  const persisted = readFile();
  // 로드에도 coerce 적용 — 손으로 고친/손상된 metrics.json의 0·문자열 주기가 그대로
  // setInterval에 흘러들면 Node가 1ms로 클램프해 초당 1000회 샘플러 틱이 돈다.
  // v2.598 L2598-02: 손으로 고친 파일의 빈 문자열·null 숫자는 '미지정' 이다(기본값 유지) — 예전엔 0 이 되어 보존 무제한이 됐다.
  for (const f of FIELDS) if (persisted[f] !== undefined && !(NUMERIC.has(f) && numOrNull(persisted[f]) == null)) eff[f] = coerce(f, persisted[f]);
  return eff;
}

function coerce(field, v) {
  if (field === 'sampleIntervalMs') return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Number(v) || MIN_INTERVAL_MS));
  if (field === 'retentionDays') return Math.max(0, Math.floor(Number(v) || 0));
  if (field === 'rawRetentionDays') return Math.max(0, Math.floor(Number(v) || 0));
  if (field === 'gpuUtilEnabled') return v !== false;
  if (field === 'gpuUtilIntervalSec') return Math.max(MIN_GPU_SEC, Math.min(MAX_GPU_SEC, Math.floor(Number(v) || 60)));
  return v;
}

/** Persist a partial update and return the new effective settings. */
export function saveMetricsSettings(partial) {
  const next = readFile();
  // v2.598 L2598-02·DB2598-05: 숫자 칸을 비워 저장하면('' · null) `Number('') === 0` 이 되어 보존 기간이 0(=무제한 —
  // prune 이 멈춘다) · 원본 보존 0(=롤업 기간을 따라 수년) · 주기는 하한(10초)으로 **조용히 저장됐다**(v2.596 이 같은
  // 화면의 VM 성능 칸만 고쳤다). 빈 값은 '미지정' — 이전 값을 유지하고, 명시적 0 만 값이다(v2.583 dropUnspecifiedNumbers 규약).
  for (const f of FIELDS) {
    if (partial[f] === undefined) continue;
    if (NUMERIC.has(f) && numOrNull(partial[f]) == null) continue;
    next[f] = coerce(f, partial[f]);
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return loadMetricsSettings();
}

export const METRICS_LIMITS = { minIntervalMs: MIN_INTERVAL_MS, maxIntervalMs: MAX_INTERVAL_MS, minGpuSec: MIN_GPU_SEC, maxGpuSec: MAX_GPU_SEC };
