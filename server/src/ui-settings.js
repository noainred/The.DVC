/**
 * Shared UI settings persisted server-side (CONFIG_DIR/ui.json) so layout
 * tweaks like the dashboard map height are the same for everyone, not just the
 * browser that changed them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const FILE = path.join(config.configDir, 'ui.json');
const DEFAULTS = { mapHeight: 420 };

export function loadUiSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveUiSettings(partial = {}) {
  const next = loadUiSettings();
  if (partial.mapHeight != null) {
    next.mapHeight = Math.max(240, Math.min(1200, Math.round(Number(partial.mapHeight)) || 420));
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  return next;
}
