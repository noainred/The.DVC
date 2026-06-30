/**
 * vCenter display order — a user-defined ordering applied to every "vCenter
 * 선택" list in the web (all dropdowns read /vcenters). Stored as an array of
 * vCenter ids in CONFIG_DIR/vcenter-order.json. Ids not present in the order go
 * to the end, preserving their original relative order.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const FILE = path.join(config.configDir, 'vcenter-order.json');

let cache = null;
function load() {
  if (cache) return cache;
  cache = [];
  try { if (fs.existsSync(FILE)) { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); cache = Array.isArray(j?.order) ? j.order.map(String) : []; } } catch { cache = []; }
  return cache;
}

export function getOrder() { return [...load()]; }

export function saveOrder(ids) {
  const order = Array.isArray(ids) ? [...new Set(ids.map((x) => String(x).trim()).filter(Boolean))] : [];
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ order }, null, 2), { mode: 0o600 });
  cache = order;
  return order;
}

/** Stable-sort items by the saved order. `idOf` extracts each item's vCenter id. */
export function sortByOrder(items, idOf = (x) => x.id) {
  const order = load();
  if (!order.length) return items;
  const rank = new Map(order.map((id, i) => [id, i]));
  return items
    .map((x, i) => [x, i])
    .sort((a, b) => {
      const ra = rank.has(idOf(a[0])) ? rank.get(idOf(a[0])) : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(idOf(b[0])) ? rank.get(idOf(b[0])) : Number.MAX_SAFE_INTEGER;
      return ra - rb || a[1] - b[1]; // ties keep original order
    })
    .map(([x]) => x);
}
