/**
 * Scan an IP range for Dell iDRACs. Expands the IP list, probes each address'
 * Redfish endpoint with the given credentials (bounded concurrency + short
 * timeout), and returns only the confirmed iDRACs with their identity.
 */

import { expandIpList } from './iprange.js';
import { probeIdrac } from './redfish.js';

export async function scanForIdracs({ ips, username, password, concurrency = 32, perHostTimeout = 3000, max = 2048 }) {
  const { ips: list, errors, truncated } = expandIpList(ips);
  const targets = list.slice(0, max);

  const found = [];
  let unreachable = 0, notIdrac = 0, authFailed = 0;
  let idx = 0;

  async function worker() {
    while (idx < targets.length) {
      const ip = targets[idx++];
      const r = await probeIdrac(ip, username, password, perHostTimeout);
      if (!r.ok) { unreachable++; continue; }
      if (r.authFailed) { authFailed++; continue; }
      if (r.isIdrac) found.push({ ip, serviceTag: r.serviceTag || '', model: r.model || '', manufacturer: r.manufacturer || '', hostName: r.hostName || '' });
      else notIdrac++;
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, targets.length || 1) }, worker);
  await Promise.all(workers);

  found.sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
  return {
    scanned: targets.length,
    found,
    foundCount: found.length,
    unreachable,
    notIdrac,
    authFailed,
    truncated: truncated || list.length > max,
    ipErrors: errors,
  };
}
