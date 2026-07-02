/**
 * Runtime-editable metrics sampler settings (온도/용량/GPU 수집 주기·보존기간).
 * Env vars provide the defaults (config.temp); values saved from the portal are
 * persisted to config/metrics.json (gitignored) and take precedence. The sampler
 * reloads and reschedules itself whenever these change.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const FILE = path.join(config.configDir, 'metrics.json');

// Fields editable from the portal.
const FIELDS = ['sampleIntervalMs', 'retentionDays', 'gpuUtilEnabled', 'gpuUtilIntervalSec'];

// Guardrails: don't let the UI set an interval so small it hammers vCenter.
const MIN_INTERVAL_MS = 10_000;   // 10초
const MAX_INTERVAL_MS = 86_400_000; // 24시간
const MIN_GPU_SEC = 20, MAX_GPU_SEC = 86_400;

function readFile() {
  if (!fs.existsSync(FILE)) return {};
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; }
}

/** Effective settings = env defaults overlaid with persisted overrides. */
export function loadMetricsSettings() {
  const eff = { sampleIntervalMs: config.temp.sampleIntervalMs, retentionDays: config.temp.retentionDays, gpuUtilEnabled: true, gpuUtilIntervalSec: 60 };
  const persisted = readFile();
  // 로드에도 coerce 적용 — 손으로 고친/손상된 metrics.json의 0·문자열 주기가 그대로
  // setInterval에 흘러들면 Node가 1ms로 클램프해 초당 1000회 샘플러 틱이 돈다.
  for (const f of FIELDS) if (persisted[f] !== undefined) eff[f] = coerce(f, persisted[f]);
  return eff;
}

function coerce(field, v) {
  if (field === 'sampleIntervalMs') return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Number(v) || MIN_INTERVAL_MS));
  if (field === 'retentionDays') return Math.max(0, Math.floor(Number(v) || 0));
  if (field === 'gpuUtilEnabled') return v !== false;
  if (field === 'gpuUtilIntervalSec') return Math.max(MIN_GPU_SEC, Math.min(MAX_GPU_SEC, Math.floor(Number(v) || 60)));
  return v;
}

/** Persist a partial update and return the new effective settings. */
export function saveMetricsSettings(partial) {
  const next = readFile();
  for (const f of FIELDS) if (partial[f] !== undefined) next[f] = coerce(f, partial[f]);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return loadMetricsSettings();
}

export const METRICS_LIMITS = { minIntervalMs: MIN_INTERVAL_MS, maxIntervalMs: MAX_INTERVAL_MS, minGpuSec: MIN_GPU_SEC, maxGpuSec: MAX_GPU_SEC };
