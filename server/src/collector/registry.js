/**
 * Collector registry — the list of remote collector agents (one per datacenter)
 * the central portal pulls power from. Stored in CONFIG_DIR/collectors.json
 * (0600; holds per-agent tokens). Edited via the admin API.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const FILE = path.join(config.configDir, 'collectors.json');

export function loadCollectors() {
  if (!fs.existsSync(FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(parsed?.collectors) ? parsed.collectors : [];
  } catch {
    return [];
  }
}

function save(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ collectors: list }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch { /* best effort */ }
}

export function redact(c) {
  const { token, ...rest } = c;
  return { ...rest, hasToken: Boolean(token) };
}

export function listCollectors() {
  return loadCollectors().map(redact);
}

function normalize(body, existing = null) {
  const e = existing ? { ...existing } : {};
  const id = String(body.id ?? e.id ?? '').trim();
  const name = String(body.name ?? e.name ?? '').trim();
  let url = String(body.url ?? e.url ?? '').trim();
  const datacenter = String(body.datacenter ?? e.datacenter ?? '').trim();

  if (!id) return [null, 'id는 필수입니다.'];
  if (id.length > 128 || [...id].some((c) => c.charCodeAt(0) < 32)) return [null, 'id에 사용할 수 없는 문자가 있습니다.'];
  if (!name) return [null, 'name(표시 이름)은 필수입니다.'];
  if (!url) return [null, '수집 서버 URL은 필수입니다.'];
  if (!/^https?:\/\//.test(url)) url = `http://${url}`;
  url = url.replace(/\/+$/, '');

  const entry = {
    id, name, url, datacenter,
    token: body.token ? String(body.token) : e.token || '',
    enabled: body.enabled != null ? Boolean(body.enabled) : (e.enabled != null ? e.enabled : true),
  };
  return [entry, null];
}

export function addCollector(body) {
  const list = loadCollectors();
  const [entry, err] = normalize(body);
  if (err) return { ok: false, reason: err };
  if (list.some((c) => c.id === entry.id)) return { ok: false, reason: `이미 존재하는 id: ${entry.id}` };
  list.push(entry);
  save(list);
  return { ok: true, collector: redact(entry) };
}

export function updateCollector(id, body) {
  const list = loadCollectors();
  const idx = list.findIndex((c) => c.id === id);
  if (idx === -1) return { ok: false, reason: `없는 수집 서버: ${id}` };
  const [entry, err] = normalize({ ...body, id }, list[idx]);
  if (err) return { ok: false, reason: err };
  list[idx] = entry;
  save(list);
  return { ok: true, collector: redact(entry) };
}

export function removeCollector(id) {
  const list = loadCollectors();
  const next = list.filter((c) => c.id !== id);
  if (next.length === list.length) return { ok: false, reason: `없는 수집 서버: ${id}` };
  save(next);
  return { ok: true };
}
