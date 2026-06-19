/**
 * Collector-agent export. When this instance runs at a datacenter as a
 * collector, it exposes its locally-collected power so the central portal can
 * pull and merge it. Only LOCAL data (this instance's iDRAC/OME) is exported —
 * never re-exported remote data — so there are no pull loops.
 */

import { config, currentVersion } from '../config.js';
import { localPowerByHostName } from '../idrac/service.js';
import { getPollerStatus } from '../idrac/poller.js';
import { allOmeDevices } from '../idrac/omeCache.js';

export async function buildExport() {
  const byNameMap = await localPowerByHostName();
  // Dedupe to one row per source server (a host may appear under several keys).
  const seen = new Set();
  const byHost = [];
  for (const [host, r] of byNameMap) {
    byHost.push({ host, watts: r.watts, ts: r.ts, serverName: r.serverName, serverId: r.serverId });
    seen.add(r.serverId);
  }
  return {
    version: currentVersion(),
    datacenter: config.collector.datacenter || '',
    generatedAt: Date.now(),
    poller: getPollerStatus(),
    omeDevices: allOmeDevices().length,
    hosts: byHost.length,
    power: { byHost },
  };
}
