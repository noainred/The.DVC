/**
 * Portal-embedded iDRAC power poller. On an interval it reads current power
 * from every enabled registered Dell server (Redfish) and appends a sample to
 * the time-series DB. Runs inside the portal process; failures are isolated per
 * server so one unreachable iDRAC never stalls the rest.
 */

import { config } from '../config.js';
import { loadRegistry } from './registry.js';
import { fetchPower } from './redfish.js';
import { getDb } from './db.js';
import { describeError } from '../util/errors.js';

let timer = null;
let lastRun = null; // { at, ok, failed, results: [{id, watts?, error?}] }

async function pollOnce() {
  const servers = loadRegistry().filter((s) => s.enabled !== false && s.host && s.username && s.password);
  if (!servers.length) { lastRun = { at: Date.now(), ok: 0, failed: 0, results: [] }; return; }
  const db = await getDb();
  const ts = Date.now();
  const results = [];
  await Promise.all(servers.map(async (s) => {
    try {
      const r = await fetchPower(s);
      db.insert(s.id, r.watts, ts);
      results.push({ id: s.id, name: s.name, watts: r.watts });
    } catch (err) {
      const d = describeError(err);
      results.push({ id: s.id, name: s.name, error: d.message });
    }
  }));
  // Retention pruning
  if (config.idrac.retentionDays > 0) {
    try { db.prune(ts - config.idrac.retentionDays * 86_400_000); } catch { /* best effort */ }
  }
  const failed = results.filter((r) => r.error).length;
  lastRun = { at: ts, ok: results.length - failed, failed, results };
  if (failed) console.warn(`[idrac] poll: ${results.length - failed}/${results.length} 성공`);
}

export function getPollerStatus() {
  return {
    enabled: config.idrac.enabled,
    intervalMs: config.idrac.pollIntervalMs,
    servers: loadRegistry().length,
    lastRun,
  };
}

/** Trigger an immediate poll (e.g. right after a registry change). */
export async function pollNow() {
  try { await pollOnce(); } catch (err) { console.error('[idrac] pollNow 실패:', err.message); }
  return lastRun;
}

export function startIdracPoller() {
  if (!config.idrac.enabled) { console.log('[idrac] poller disabled (IDRAC_ENABLED=false)'); return; }
  // initial run shortly after boot, then on the configured interval
  setTimeout(() => pollNow(), 3_000).unref?.();
  timer = setInterval(() => pollNow(), config.idrac.pollIntervalMs);
  timer.unref?.();
  console.log(`[idrac] poller started (every ${Math.round(config.idrac.pollIntervalMs / 1000)}s)`);
}
