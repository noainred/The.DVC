/**
 * Runtime-editable auto-upgrade settings. Env vars provide the defaults; values
 * saved from the admin UI are persisted to config/upgrade.json (gitignored,
 * 0600 because it may hold a token) and take precedence. The manager reloads
 * these whenever they change.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js'; // v2.538: 이 파일은 v2.537 까지 봉인 대상 미등록이었다(감사 M4 계열)

// Persisted in CONFIG_DIR (default app/server/config; set to e.g.
// /etc/vmware-portal to survive upgrades).
const FILE = path.join(config.configDir, 'upgrade.json');

// Fields editable from the portal (others, e.g. downloadDir, stay env-only).
const FIELDS = ['enabled', 'watchDir', 'installDir', 'packageName', 'remoteBase', 'token', 'pollIntervalMs', 'autoApply'];

function readFile() {
  if (!fs.existsSync(FILE)) return {};
  try { return openSecretsDeep(JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}); } catch (e) { if (fs.existsSync(FILE)) preserveCorrupt(FILE, e.message); return {}; }
}

/** Effective settings = env defaults overlaid with persisted overrides. */
export function loadSettings() {
  const eff = { ...config.upgrade };
  const persisted = readFile();
  for (const f of FIELDS) if (persisted[f] !== undefined) eff[f] = persisted[f];
  if (Array.isArray(persisted.edges)) eff.edges = persisted.edges;
  return eff;
}

export const POLL_MIN_MS = 60_000;
export const POLL_MAX_MS = 7 * 86_400_000;
export function clampPollMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, Math.round(n)));
}

function coerce(field, v) {
  if (field === 'enabled' || field === 'autoApply') return Boolean(v);
  // v2.591 L3: 0 = 끔. 그 밖은 1분~7일로 클램프한다 — 상한이 없어 24.8일(2^31−1ms)을 넘기면 setInterval 이 1ms 로 바뀌어
  //   원격 릴리스 소스에 초당 수백 요청이 나갔다(재현: 43,200분 저장 → 2초에 1,331회).
  if (field === 'pollIntervalMs') return clampPollMs(v);
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
  atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep(next), null, 2), { mode: 0o600 });
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
