/**
 * Per-IP user annotations (custom memo + tags) for the IP ledger. These are
 * operator-authored notes kept SEPARATELY from the vCenter VM/host notes, so
 * they survive snapshot refreshes. Stored in CONFIG_DIR/ipam-annotations.json,
 * keyed by IP address.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const FILE = path.join(config.configDir, 'ipam-annotations.json');

let cache = null;
let rev = 0; // 메모/태그 변경 리비전(대장 캐시 무효화 키)
export function annotationsRev() { return rev; }

function load() {
  if (cache) return cache;
  cache = {};
  try { if (fs.existsSync(FILE)) cache = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { cache = {}; }
  return cache;
}

/** Whole map { ip: { memo, tags[], updatedAt, updatedBy } }. */
export function getAnnotations() { return load(); }

/** One IP's annotation, or null. */
export function getAnnotation(ip) { return load()[String(ip)] || null; }

const cleanTags = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,\n]/))
  .map((s) => String(s).trim()).filter(Boolean).slice(0, 20);

/** Create/update/clear one IP's annotation. Empty memo + no tags removes it. */
export function setAnnotation(ip, { memo = '', tags = [] } = {}, user) {
  const key = String(ip || '').trim();
  if (!key) return { ok: false, reason: 'IP가 필요합니다.' };
  const data = load();
  const m = String(memo || '').trim().slice(0, 2000);
  const t = cleanTags(tags);
  if (!m && t.length === 0) {
    delete data[key];
  } else {
    data[key] = { memo: m, tags: t, updatedAt: new Date().toISOString(), updatedBy: user?.username || 'unknown' };
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  cache = data; rev++;
  return { ok: true, annotation: data[key] || null };
}
