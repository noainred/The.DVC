/**
 * Glue between the iDRAC registry (which server maps to which ESXi host) and the
 * power-sample DB. Provides host-name → power lookups for the API and the
 * snapshot overlay.
 */

import { loadRegistry, matchKeys } from './registry.js';
import { getDb } from './db.js';

/** registry entry that owns a given ESXi host name (case-insensitive). */
export function findServerForHost(hostName) {
  if (!hostName) return null;
  const key = String(hostName).trim().toLowerCase();
  for (const s of loadRegistry()) {
    if (matchKeys(s).includes(key)) return s;
  }
  return null;
}

/**
 * Map of lower-cased ESXi host name -> latest power sample, used to overlay
 * real iDRAC watts onto the live/mock host snapshot.
 */
export async function latestPowerByHostName() {
  const db = await getDb();
  const latest = db.latestAll(); // Map<serverId, {watts, ts}>
  const out = new Map();
  for (const s of loadRegistry()) {
    const sample = latest.get(s.id);
    if (!sample) continue;
    for (const key of matchKeys(s)) {
      out.set(key, { watts: sample.watts, ts: sample.ts, serverId: s.id, serverName: s.name });
    }
  }
  return out;
}

/** Detailed power for one host: current reading + history series + server info. */
export async function hostPower(hostName, { hours = 24, limit = 1000 } = {}) {
  const server = findServerForHost(hostName);
  if (!server) return { matched: false };
  const db = await getDb();
  const since = Date.now() - hours * 3600_000;
  const history = db.history(server.id, since, limit);
  const latest = db.latest(server.id);
  return {
    matched: true,
    server: { id: server.id, name: server.name, host: server.host, serviceTag: server.serviceTag, enabled: server.enabled },
    current: latest ? { watts: latest.watts, ts: latest.ts } : null,
    history,
  };
}
