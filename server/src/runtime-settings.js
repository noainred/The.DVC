/**
 * Runtime-adjustable settings that can be changed from the portal UI (and
 * persisted), overriding the env defaults. Currently: the data source
 * (mock | live | auto). Stored in CONFIG_DIR/runtime.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const FILE = path.join(config.configDir, 'runtime.json');
const VALID_SOURCES = ['mock', 'live', 'auto'];

let cache = null;

function load() {
  if (cache) return cache;
  cache = {};
  try { if (fs.existsSync(FILE)) cache = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { cache = {}; }
  return cache;
}

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

/** Effective data source: UI override if set, else the env default. */
export function getDataSource() {
  const s = load();
  return VALID_SOURCES.includes(s.dataSource) ? s.dataSource : config.dataSource;
}

export function setDataSource(value) {
  const v = String(value || '').toLowerCase();
  if (!VALID_SOURCES.includes(v)) return { ok: false, reason: 'mock | live | auto 중 하나여야 합니다.' };
  load();
  cache.dataSource = v;
  save();
  return { ok: true, dataSource: v };
}

/** Whether the data source was overridden in the UI (vs. coming from env). */
export function isDataSourceOverridden() {
  return VALID_SOURCES.includes(load().dataSource);
}
