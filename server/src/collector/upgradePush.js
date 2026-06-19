/**
 * Push an upgrade bundle from the central portal to registered collector agents.
 * Each agent applies it via its token-gated POST /api/collector/upgrade and
 * restarts. Best-effort and isolated per agent.
 */

import { loadCollectors } from './registry.js';
import { setCollectorStatus, getCollectorStatus } from './state.js';

export async function pushBundleToCollector(c, bytes, { restart = true, force = false, timeout = 180_000 } = {}) {
  const url = `${String(c.url).replace(/\/+$/, '')}/api/collector/upgrade?restart=${restart}${force ? '&force=true' : ''}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip', ...(c.token ? { 'X-Collector-Token': c.token } : {}) },
      body: bytes,
      signal: AbortSignal.timeout(timeout),
    });
    const body = await res.json().catch(() => ({}));
    return { id: c.id, name: c.name, ok: res.ok && body.ok !== false, status: res.status, ...body };
  } catch (err) {
    return { id: c.id, name: c.name, ok: false, reason: err.message };
  }
}

/**
 * Push to all enabled collectors (or a subset of ids). Records the outcome in
 * each collector's status so the admin UI can show upgrade results.
 */
export async function pushUpgradeToCollectors(bytes, { ids = null, force = false } = {}) {
  const list = loadCollectors().filter((c) => c.enabled !== false && c.url && (!ids || ids.includes(c.id)));
  const results = await Promise.all(list.map(async (c) => {
    const r = await pushBundleToCollector(c, bytes, { force });
    const prev = getCollectorStatus(c.id) || {};
    setCollectorStatus(c.id, { ...prev, upgrade: { at: Date.now(), ok: r.ok, version: r.version, reason: r.reason || r.error } });
    return r;
  }));
  return results;
}
