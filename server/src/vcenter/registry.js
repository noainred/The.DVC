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
import { fileURLToPath } from 'node:url';
import { VCenterClient } from './restClient.js';
import { describeError } from '../util/errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(__dirname, '..', '..', 'config', 'vcenters.json');

const REGIONS = ['Americas', 'EMEA', 'APAC'];

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

  if (!id || !/^[a-zA-Z0-9._-]+$/.test(id)) return [null, 'id는 영문/숫자/.-_ 만 허용됩니다.'];
  if (!name) return [null, 'name(표시 이름)은 필수입니다.'];
  if (!/^https?:\/\//.test(host)) return [null, 'host는 https://... 형식이어야 합니다.'];
  if (!username) return [null, 'username은 필수입니다.'];

  const loc = body.location || e.location || {};
  const region = REGIONS.includes(loc.region) ? loc.region : (loc.region || 'Unknown');

  const entry = {
    id, name, host, username,
    // keep existing password if not provided / blank
    password: body.password ? String(body.password) : e.password || '',
    location: {
      city: String(loc.city || '').trim(),
      country: String(loc.country || '').trim(),
      region,
      lat: loc.lat != null && loc.lat !== '' ? Number(loc.lat) : undefined,
      lon: loc.lon != null && loc.lon !== '' ? Number(loc.lon) : undefined,
    },
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
