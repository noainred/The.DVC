/**
 * iDRAC registry — the managed list of Dell servers whose power draw we collect
 * over Redfish. Stored in CONFIG_DIR/idrac.json (gitignored, 0600, holds
 * credentials) so it survives upgrades and stays outside the app dir.
 *
 * Each entry maps an iDRAC endpoint to one or more ESXi host names so the portal
 * can show "this host's server power" when a host is clicked. Edited through the
 * admin API; supports CSV/JSON bulk import.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { describeError } from '../util/errors.js';
import { fetchPower, fetchInventory } from './redfish.js';
import { testOme } from './ome.js';
import { expandIpList } from './iprange.js';

const FILE = path.join(config.configDir, 'idrac.json');

export function loadRegistry() {
  if (!fs.existsSync(FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(parsed?.servers) ? parsed.servers : [];
  } catch {
    return [];
  }
}

function saveRegistry(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ servers: list }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch { /* best effort */ }
}

/** Strip the password before returning an entry to the client. */
export function redact(s) {
  const { password, ...rest } = s;
  return { ...rest, hasPassword: Boolean(password) };
}

export function listRegistry() {
  return loadRegistry().map(redact);
}

/**
 * The set of ESXi host names an entry should match against, lower-cased.
 * Includes explicit hostNames plus the server name and service tag as
 * convenience aliases.
 */
export function matchKeys(entry) {
  const keys = new Set();
  for (const n of entry.hostNames || []) if (n) keys.add(String(n).trim().toLowerCase());
  if (entry.name) keys.add(String(entry.name).trim().toLowerCase());
  if (entry.serviceTag) keys.add(String(entry.serviceTag).trim().toLowerCase());
  return [...keys];
}

/** Validate + normalize an incoming server payload. Returns [entry, error]. */
function normalize(body, existing = null) {
  const e = existing ? { ...existing } : {};
  const id = String(body.id ?? e.id ?? '').trim();
  const name = String(body.name ?? e.name ?? '').trim();
  let host = String(body.host ?? e.host ?? '').trim();
  const username = String(body.username ?? e.username ?? '').trim();
  const type = (body.type ?? e.type ?? 'idrac') === 'ome' ? 'ome' : 'idrac';

  if (!id) return [null, 'id는 필수입니다.'];
  if (id.length > 128 || [...id].some((c) => c.charCodeAt(0) < 32)) return [null, 'id에 사용할 수 없는 문자가 있습니다.'];
  if (!name) return [null, 'name(서버 표시 이름)은 필수입니다.'];
  if (!host) return [null, type === 'ome' ? 'OME 주소(host)는 필수입니다.' : 'iDRAC 주소(host)는 필수입니다.'];
  if (!username) return [null, 'username은 필수입니다.'];

  // Accept a bare IP/hostname and normalize to https://host.
  if (!/^https?:\/\//.test(host)) host = `https://${host}`;
  host = host.replace(/\/+$/, '');

  // hostNames: ESXi host name(s) this iDRAC maps to. Accept array or
  // comma/space/newline-separated string. (OME auto-discovers devices, so
  // hostNames is optional/ignored there.)
  let hostNames = body.hostNames ?? e.hostNames ?? [];
  if (typeof hostNames === 'string') hostNames = hostNames.split(/[,\n\r]+/);
  hostNames = [...new Set((hostNames || []).map((h) => String(h).trim()).filter(Boolean))];

  const entry = {
    id, name, host, username, type,
    password: body.password ? String(body.password) : e.password || '',
    serviceTag: String(body.serviceTag ?? e.serviceTag ?? '').trim(),
    hostNames,
    enabled: body.enabled != null ? Boolean(body.enabled) : (e.enabled != null ? e.enabled : true),
  };
  return [entry, null];
}

export function addServer(body) {
  const list = loadRegistry();
  const [entry, err] = normalize(body);
  if (err) return { ok: false, reason: err };
  if (list.some((s) => s.id === entry.id)) return { ok: false, reason: `이미 존재하는 id: ${entry.id}` };
  list.push(entry);
  saveRegistry(list);
  return { ok: true, server: redact(entry) };
}

export function updateServer(id, body) {
  const list = loadRegistry();
  const idx = list.findIndex((s) => s.id === id);
  if (idx === -1) return { ok: false, reason: `없는 서버: ${id}` };
  const [entry, err] = normalize({ ...body, id }, list[idx]);
  if (err) return { ok: false, reason: err };
  list[idx] = entry;
  saveRegistry(list);
  return { ok: true, server: redact(entry) };
}

export function removeServer(id) {
  const list = loadRegistry();
  const next = list.filter((s) => s.id !== id);
  if (next.length === list.length) return { ok: false, reason: `없는 서버: ${id}` };
  saveRegistry(next);
  return { ok: true };
}

/**
 * Import a list of servers. `mode` 'merge' (default) upserts by id; 'replace'
 * swaps the whole registry. Returns { ok, mode, added, updated, skipped[], total }.
 */
export function importServers(incoming, mode = 'merge') {
  if (!Array.isArray(incoming)) return { ok: false, reason: 'servers 배열을 찾을 수 없습니다.' };
  const existing = loadRegistry();
  const result = mode === 'replace' ? [] : [...existing];
  let added = 0, updated = 0;
  const skipped = [];
  for (const raw of incoming) {
    const base = mode === 'replace' ? null : existing.find((s) => s.id === raw?.id);
    const [entry, err] = normalize(raw || {}, base);
    if (err) { skipped.push({ id: raw?.id || '(id 없음)', reason: err }); continue; }
    const idx = result.findIndex((s) => s.id === entry.id);
    if (idx >= 0) { result[idx] = entry; updated++; } else { result.push(entry); added++; }
  }
  saveRegistry(result);
  return { ok: true, mode, added, updated, skipped, total: result.length };
}

/**
 * Bulk-register Dell servers from an IP list that all share the same iDRAC
 * credentials. `ips` is free-form text (one per line; ranges and CIDR allowed).
 * Each IP becomes a server whose id/name/host is the IP and whose hostNames
 * includes the IP (so a host registered by IP auto-matches). Returns a summary
 * including the import result and any IP-parse errors.
 */
export function bulkAddByIps(body) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username) return { ok: false, reason: 'username은 필수입니다.' };
  if (!password) return { ok: false, reason: 'password는 필수입니다.' };

  const { ips, errors, truncated } = expandIpList(body.ips || '');
  if (!ips.length) return { ok: false, reason: 'IP를 한 개 이상 입력하세요.', ipErrors: errors };

  const prefix = String(body.namePrefix || '').trim();
  const servers = ips.map((ip) => ({
    id: ip,
    name: prefix ? `${prefix}${ip}` : ip,
    host: ip,
    username,
    password,
    hostNames: [ip],
    enabled: true,
  }));
  const result = importServers(servers, body.mode === 'replace' ? 'replace' : 'merge');
  return { ...result, expanded: ips.length, ipErrors: errors, truncated };
}

/**
 * Parse a CSV with header columns: name, host, username, password, serviceTag,
 * hostNames (hostNames may be ';'-separated). Returns an array of server objects.
 */
export function parseCsv(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const out = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const row = {};
    header.forEach((h, i) => { row[h] = (cells[i] || '').trim(); });
    if (!row.name && !row.host) continue;
    out.push({
      id: row.id || row.servicetag || row.name || row.host,
      name: row.name || row.host,
      host: row.host,
      username: row.username,
      password: row.password,
      serviceTag: row.servicetag || row.service_tag || '',
      hostNames: (row.hostnames || row.host_names || row.esxi || '').split(/[;|]/).map((s) => s.trim()).filter(Boolean),
    });
  }
  return out;
}

/** Test connectivity + read current power for a server (uses stored pw if blank). */
export async function testServer(body) {
  let entry = body;
  if (!entry.password && entry.id) {
    const saved = loadRegistry().find((s) => s.id === entry.id);
    if (saved) entry = { ...saved, ...body, password: body.password || saved.password };
  }
  if (!entry.host || !entry.username || !entry.password) {
    return { ok: false, reason: 'host/username/password가 필요합니다.' };
  }
  // normalize host the same way as save
  let host = String(entry.host).trim();
  if (!/^https?:\/\//.test(host)) host = `https://${host}`;
  const normalized = { ...entry, host: host.replace(/\/+$/, '') };
  const started = Date.now();
  try {
    if (entry.type === 'ome') {
      const r = await testOme(normalized);
      return { ok: true, ms: r.ms, devices: r.devices, auth: r.auth, watts: r.sampleWatts, type: 'ome' };
    }
    const r = await fetchPower(normalized);
    let info = null;
    try { info = await fetchInventory(normalized); } catch { /* power test still succeeds */ }
    return { ok: true, ms: Date.now() - started, watts: r.watts, model: r.model, serviceTag: r.serviceTag, powerState: r.powerState, info };
  } catch (err) {
    const d = describeError(err);
    return { ok: false, reason: d.message, hint: d.hint, code: d.code, ms: Date.now() - started };
  }
}
