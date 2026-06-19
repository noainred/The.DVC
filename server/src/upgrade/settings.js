/**
 * Runtime-editable auto-upgrade settings. Env vars provide the defaults; values
 * saved from the admin UI are persisted to config/upgrade.json (gitignored,
 * 0600 because it may hold a token) and take precedence. The manager reloads
 * these whenever they change.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(__dirname, '..', '..', 'config', 'upgrade.json');

// Fields editable from the portal (others, e.g. downloadDir, stay env-only).
const FIELDS = ['enabled', 'watchDir', 'installDir', 'packageName', 'remoteBase', 'token', 'pollIntervalMs', 'autoApply'];

function readFile() {
  if (!fs.existsSync(FILE)) return {};
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; }
}

/** Effective settings = env defaults overlaid with persisted overrides. */
export function loadSettings() {
  const eff = { ...config.upgrade };
  const persisted = readFile();
  for (const f of FIELDS) if (persisted[f] !== undefined) eff[f] = persisted[f];
  if (Array.isArray(persisted.edges)) eff.edges = persisted.edges;
  return eff;
}

function coerce(field, v) {
  if (field === 'enabled' || field === 'autoApply') return Boolean(v);
  if (field === 'pollIntervalMs') return Math.max(0, Number(v) || 0);
  return typeof v === 'string' ? v.trim() : v;
}

/** Persist a partial update and return the new effective settings. */
export function saveSettings(partial) {
  const next = readFile();
  for (const f of FIELDS) {
    if (partial[f] !== undefined) {
      // an empty token means "leave the saved token unchanged"
      if (f === 'token' && partial[f] === '') continue;
      next[f] = coerce(f, partial[f]);
    }
  }
  if (Array.isArray(partial.edges)) next.edges = partial.edges;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch { /* best effort */ }
  return loadSettings();
}

/** Strip the token before returning settings to the client. */
export function redactSettings(s) {
  return {
    enabled: s.enabled,
    watchDir: s.watchDir || '',
    installDir: s.installDir || '',
    packageName: s.packageName,
    remoteBase: s.remoteBase || '',
    pollIntervalMs: s.pollIntervalMs || 0,
    autoApply: s.autoApply,
    hasToken: Boolean(s.token),
    edges: (s.edges || []).map((e) => e.url),
  };
}
