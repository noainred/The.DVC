/**
 * Saved VM-provisioning jobs — every created job's spec is persisted so it can
 * be reloaded and reused later. Stored in CONFIG_DIR/provision-saved.json (ALL
 * jobs kept). Each entry carries an optional memo + tags. The portal lists a
 * page at a time (default 10) with an optional per-vCenter filter.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';

const FILE = path.join(config.configDir, 'provision-saved.json');

let cache = null;
function load() {
  if (cache) return cache;
  cache = [];
  try { if (fs.existsSync(FILE)) { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); cache = Array.isArray(j) ? j : (j.items || []); } } catch { cache = []; }
  return cache;
}
function persist() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
}
const cleanTags = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,\n]/)).map((s) => String(s).trim()).filter(Boolean).slice(0, 20);

/** Persist one provisioning spec (called whenever a job is created). */
export function addSaved({ spec, source, user, memo = '', tags = [] } = {}) {
  const list = load();
  const entry = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    createdBy: user?.username || 'unknown',
    name: spec?.namePattern || source?.name || 'job',
    vcenterId: source?.vcenterId || spec?.vcenterId || '',
    sourceId: source?.id || spec?.sourceId || '',
    sourceName: source?.name || '',
    count: Array.isArray(spec?.guest?.ipList) && spec.guest.ipList.length && !(spec.count > 0) ? spec.guest.ipList.length : (Number(spec?.count) || 0),
    spec, // full spec to reload into the form
    memo: String(memo || '').slice(0, 2000),
    tags: cleanTags(tags),
    lastRunAt: new Date().toISOString(),
  };
  list.unshift(entry);
  persist();
  return entry;
}

/** Distinct vCenters present in saved jobs (for the filter tabs). */
export function savedVcenters() {
  return [...new Set(load().map((e) => e.vcenterId).filter(Boolean))].sort();
}

/** Paginated list. { vcenterId?, limit=10, offset=0 } → { total, items, vcenters }. */
export function listSaved({ vcenterId = '', limit = 10, offset = 0 } = {}) {
  let items = load();
  if (vcenterId) items = items.filter((e) => e.vcenterId === vcenterId);
  const total = items.length;
  const lim = Math.max(1, Math.min(200, Number(limit) || 10));
  const off = Math.max(0, Number(offset) || 0);
  return { total, offset: off, limit: lim, items: items.slice(off, off + lim), vcenters: savedVcenters() };
}

export function getSaved(id) { return load().find((e) => e.id === id) || null; }

export function updateSaved(id, { memo, tags } = {}) {
  const e = load().find((x) => x.id === id);
  if (!e) return { ok: false, reason: '저장된 작업을 찾을 수 없습니다.' };
  if (memo !== undefined) e.memo = String(memo || '').slice(0, 2000);
  if (tags !== undefined) e.tags = cleanTags(tags);
  persist();
  return { ok: true, item: e };
}

export function removeSaved(id) {
  const list = load();
  const i = list.findIndex((e) => e.id === id);
  if (i < 0) return { ok: false, reason: '없는 작업' };
  list.splice(i, 1);
  persist();
  return { ok: true };
}
