/**
 * Ephemeral remote-access mappings (created on-demand via /remote/quick-connect)
 * are removed 1 day after they were last used — the proxy frontend is torn down
 * and the registry entry deleted, so HAProxy doesn't accumulate stale ports.
 */

import { listMappings, getMapping, removeMapping } from './registry.js';
import { deprovision } from './provision.js';

const DAY_MS = Number(process.env.REMOTE_MAPPING_TTL_MS) || 24 * 60 * 60 * 1000;

export async function pruneExpiredMappings(now = Date.now()) {
  let removed = 0;
  for (const m of [...listMappings()]) {
    if (!m.ephemeral) continue; // admin-created persistent mappings are kept
    const last = Date.parse(m.lastUsedAt || m.createdAt) || 0;
    if (now - last < DAY_MS) continue;
    try { await deprovision(getMapping(m.id)); } catch { /* best effort */ }
    removeMapping(m.id);
    removed++;
    console.log(`[remote] 임시 매핑 만료 삭제: ${m.name} (${m.targetHost}:${m.targetPort}, owner=${m.owner || '-'})`);
  }
  return removed;
}

export function startMappingExpiry() {
  const timer = setInterval(() => { pruneExpiredMappings().catch(() => {}); }, 60 * 60 * 1000); // hourly
  timer.unref?.();
  pruneExpiredMappings().catch(() => {}); // run once at startup
}
