/**
 * vCenter registry — read/write the managed list of vCenters in
 * config/vcenters.json (the same file the live collector polls), with
 * validation, password redaction for API responses, and a connection test.
 *
 * Edited through the admin API so operators can register/manage vCenters from
 * the portal instead of hand-editing the file. The file is gitignored and
 * written 0600 because it holds credentials.
 */

import fs from 'node:fs';
import path from 'node:path';
import { VCenterClient } from './restClient.js';
import { describeError } from '../util/errors.js';
import { geocode } from './geocode.js';
import { config } from '../config.js';

// User registry lives in CONFIG_DIR (default app/server/config) so it can be
// kept outside the app dir (e.g. /etc/vmware-portal) to survive upgrades.
const FILE = path.join(config.configDir, 'vcenters.json');

const REGIONS = ['아시아', '중국', '유럽', '북미'];

export function loadRegistry() {
  if (!fs.existsSync(FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(parsed?.vcenters) ? parsed.vcenters : [];
  } catch {
    return [];
  }
}

function saveRegistry(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ vcenters: list }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch { /* best effort */ }
}

/** Strip secrets before sending an entry to the client. */
export function redact(vc) {
  const { password, ...rest } = vc;
  return { ...rest, hasPassword: Boolean(password) };
}

export function listRegistry() {
  return loadRegistry().map(redact);
}

/** Validate and normalize an incoming vCenter payload. Returns [entry, error]. */
function normalize(body, existing = null) {
  const e = existing ? { ...existing } : {};
  const id = String(body.id ?? e.id ?? '').trim();
  const name = String(body.name ?? e.name ?? '').trim();
  const host = String(body.host ?? e.host ?? '').trim();
  const username = String(body.username ?? e.username ?? '').trim();

  // id may come from an imported vcenters.json and can contain '/', '.', etc.
  // (it is URL-encoded on the client), so only reject empty/oversized/control chars.
  if (!id) return [null, 'id는 필수입니다.'];
  if (id.length > 128 || [...id].some((c) => c.charCodeAt(0) < 32)) return [null, 'id에 사용할 수 없는 문자가 있습니다.'];
  if (!name) return [null, 'name(표시 이름)은 필수입니다.'];
  if (!/^https?:\/\//.test(host)) return [null, 'host는 https://... 형식이어야 합니다.'];
  if (!username) return [null, 'username은 필수입니다.'];

  const loc = body.location || e.location || {};
  const region = REGIONS.includes(loc.region) ? loc.region : (loc.region || 'Unknown');
  const city = String(loc.city || '').trim();
  const country = String(loc.country || '').trim();
  let lat = loc.lat != null && loc.lat !== '' ? Number(loc.lat) : undefined;
  let lon = loc.lon != null && loc.lon !== '' ? Number(loc.lon) : undefined;
  // Auto-plot on the map: if no coordinates were given, derive them from the
  // city/country name via the offline geocoder.
  if ((lat == null || Number.isNaN(lat)) && (lon == null || Number.isNaN(lon)) && (city || country)) {
    const g = geocode(city, country);
    if (g) { lat = g.lat; lon = g.lon; }
  }

  // Per-vCenter collection tuning (for high-RTT / many-site environments).
  const intRaw = body.pollIntervalSec ?? e.pollIntervalSec;
  const toRaw = body.timeoutMs ?? e.timeoutMs;
  const pollIntervalSec = intRaw != null && intRaw !== '' ? Math.max(0, Math.round(Number(intRaw) || 0)) : 0; // 0 = global default
  const timeoutMs = toRaw != null && toRaw !== '' ? Math.max(0, Math.round(Number(toRaw) || 0)) : 0;          // 0 = 30s default
  const enabled = body.enabled !== undefined ? body.enabled !== false : (e.enabled !== false);
  // 수집 방식: 'direct'(중앙이 직접 폴링) | 'site'(현장 서버가 수집해 중앙으로 push)
  const collectMode = (body.collectMode ?? e.collectMode) === 'site' ? 'site' : 'direct';

  const entry = {
    id, name, host, username,
    // keep existing password if not provided / blank
    password: body.password ? String(body.password) : e.password || '',
    location: { city, country, region, lat, lon },
    enabled, pollIntervalSec, timeoutMs, collectMode,
  };
  return [entry, null];
}

export function addVcenter(body) {
  const list = loadRegistry();
  const [entry, err] = normalize(body);
  if (err) return { ok: false, reason: err };
  if (list.some((v) => v.id === entry.id)) return { ok: false, reason: `이미 존재하는 id: ${entry.id}` };
  list.push(entry);
  saveRegistry(list);
  return { ok: true, vcenter: redact(entry) };
}

export function updateVcenter(id, body) {
  const list = loadRegistry();
  const idx = list.findIndex((v) => v.id === id);
  if (idx === -1) return { ok: false, reason: `없는 vCenter: ${id}` };
  const [entry, err] = normalize({ ...body, id }, list[idx]);
  if (err) return { ok: false, reason: err };
  list[idx] = entry;
  saveRegistry(list);
  return { ok: true, vcenter: redact(entry) };
}

export function removeVcenter(id) {
  const list = loadRegistry();
  const next = list.filter((v) => v.id !== id);
  if (next.length === list.length) return { ok: false, reason: `없는 vCenter: ${id}` };
  saveRegistry(next);
  return { ok: true };
}

/**
 * Import an existing vcenters.json. `mode`:
 *   - 'merge'   : add new entries, update existing ones by id (default)
 *   - 'replace' : replace the whole registry with the imported list
 * Returns a summary { ok, mode, added, updated, skipped[], total }.
 */
export function importVcenters(incoming, mode = 'merge') {
  if (!Array.isArray(incoming)) return { ok: false, reason: 'vcenters 배열을 찾을 수 없습니다 ({ "vcenters": [...] } 형식 필요).' };
  const existing = loadRegistry();
  const result = mode === 'replace' ? [] : [...existing];
  let added = 0, updated = 0;
  const skipped = [];
  for (const raw of incoming) {
    const base = mode === 'replace' ? null : existing.find((v) => v.id === raw?.id);
    const [entry, err] = normalize(raw || {}, base);
    if (err) { skipped.push({ id: raw?.id || '(id 없음)', reason: err }); continue; }
    const idx = result.findIndex((v) => v.id === entry.id);
    if (idx >= 0) { result[idx] = entry; updated++; } else { result.push(entry); added++; }
  }
  saveRegistry(result);
  return { ok: true, mode, added, updated, skipped, total: result.length };
}

/**
 * Test connectivity to a vCenter (REST login). Uses the stored password when
 * the payload omits it (so you can re-test a saved entry without re-typing).
 */
export async function testConnection(body) {
  let entry = body;
  if (!entry.password && entry.id) {
    const saved = loadRegistry().find((v) => v.id === entry.id);
    if (saved) entry = { ...saved, ...body, password: body.password || saved.password };
  }
  if (!entry.host || !entry.username || !entry.password) {
    return { ok: false, reason: 'host/username/password가 필요합니다.' };
  }
  const client = new VCenterClient(entry);
  const started = Date.now();
  try {
    await client.login();
    await client.logout();
    return { ok: true, ms: Date.now() - started };
  } catch (err) {
    const d = describeError(err);
    return { ok: false, reason: d.message, hint: d.hint, code: d.code, ms: Date.now() - started };
  }
}
