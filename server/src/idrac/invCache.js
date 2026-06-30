/**
 * Cache of the latest hardware/firmware inventory collected per iDRAC server.
 * Inventory is mostly static, so it is refreshed on a slow cadence and
 * persisted to CONFIG_DIR/idrac-inventory.json so it survives restarts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const FILE = path.join(config.configDir, 'idrac-inventory.json');

let cache = new Map(); // serverId -> inventory
let persistTimer = null;

// Load persisted inventory on first import.
try {
  if (fs.existsSync(FILE)) {
    const obj = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const [k, v] of Object.entries(obj || {})) cache.set(k, v);
  }
} catch { /* ignore */ }

function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(cache)), { mode: 0o600 });
    } catch { /* best effort */ }
  }, 10_000);
  persistTimer.unref?.();
}

export function setInventory(serverId, inv) {
  cache.set(serverId, inv);
  persistSoon();
}

export function getInventory(serverId) {
  return cache.get(serverId) || null;
}

/** True if inventory for this server is missing or older than maxAgeMs. */
export function inventoryStale(serverId, maxAgeMs) {
  const inv = cache.get(serverId);
  return !inv || (Date.now() - (inv.collectedAt || 0)) > maxAgeMs;
}

export function removeInventory(serverId) {
  if (cache.delete(serverId)) persistSoon();
}
