/**
 * Web-editable package source settings — lets an admin change the package
 * repository URL (PACKAGE_BASE_URL), download directory, and optional token
 * from the portal UI instead of environment variables. Persisted in
 * CONFIG_DIR/packages.json; falls back to config.packages (env) when unset.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const FILE = path.join(config.configDir, 'packages.json');

let cache = null;
function load() {
  if (cache) return cache;
  cache = {};
  try { if (fs.existsSync(FILE)) cache = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { cache = {}; }
  return cache;
}

/** Effective values: stored override > env/config default. */
export function getPackageBaseUrl() { return (load().baseUrl || '').trim() || config.packages.baseUrl; }
export function getPackageDir() { return (load().dir || '').trim() || config.packages.dir; }
export function getPackageToken() { return (load().token || '') || ''; }

export function getPackageSettings() {
  const s = load();
  return {
    baseUrl: getPackageBaseUrl(),
    dir: getPackageDir(),
    hasToken: Boolean(s.token),
    overridden: { baseUrl: Boolean(s.baseUrl), dir: Boolean(s.dir) },
    defaults: { baseUrl: config.packages.baseUrl, dir: config.packages.dir },
  };
}

export function savePackageSettings(body = {}) {
  const next = { ...load() };
  if (body.baseUrl !== undefined) next.baseUrl = String(body.baseUrl || '').trim();
  if (body.dir !== undefined) next.dir = String(body.dir || '').trim();
  if (body.token !== undefined && body.token !== '********') next.token = String(body.token || '');
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  cache = next;
  return getPackageSettings();
}
