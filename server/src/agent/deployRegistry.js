/**
 * Saved agent-deploy targets (CONFIG_DIR/agent-deploy-targets.json, 0600) so a
 * datacenter host's SSH + agent settings can be stored once and (re)deployed —
 * individually or in bulk — without re-entering everything each time.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

const FILE = path.join(config.configDir, 'agent-deploy-targets.json');
const SECRET_KEYS = ['password', 'privateKey'];
const FIELDS = ['host', 'port', 'username', 'password', 'privateKey', 'agentName',
  'centralUrl', 'centralToken', 'collectorToken', 'collectorDatacenter', 'installerPath', 'portalPort', 'autoUpgrade', 'enabled'];

let cache = null;

function load() {
  if (cache) return cache;
  try { if (fs.existsSync(FILE)) cache = JSON.parse(fs.readFileSync(FILE, 'utf8'))?.targets || []; } catch { cache = []; }
  if (!Array.isArray(cache)) cache = [];
  return cache;
}

function persist() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ targets: cache }, null, 2), { mode: 0o600 });
}

const redact = (t) => {
  const out = { ...t };
  for (const k of SECRET_KEYS) { out[`has${k[0].toUpperCase()}${k.slice(1)}`] = !!t[k]; delete out[k]; }
  return out;
};

export function listTargets() { return load().map(redact); }
export function getTargetRaw(id) { return load().find((t) => t.id === id) || null; }

export function saveTarget(body = {}) {
  if (!body.host) return { ok: false, reason: 'host는 필수입니다.' };
  const list = load();
  const existing = body.id ? list.find((t) => t.id === body.id) : null;
  const target = existing || { id: crypto.randomBytes(5).toString('hex'), enabled: true };
  for (const k of FIELDS) {
    if (body[k] === undefined) continue;
    // keep stored secret when UI sends an empty/redacted value
    if (SECRET_KEYS.includes(k) && (body[k] === '' || body[k] === '********')) continue;
    target[k] = body[k];
  }
  if (!existing) list.push(target);
  cache = list; persist();
  return { ok: true, target: redact(target) };
}

export function removeTarget(id) {
  const list = load();
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) return { ok: false, reason: '대상을 찾을 수 없습니다.' };
  cache = next; persist();
  return { ok: true };
}

export function recordResult(id, result) {
  const t = getTargetRaw(id);
  if (!t) return;
  t.lastResult = { at: Date.now(), ok: result.ok, active: result.active, reason: result.reason };
  persist();
}
