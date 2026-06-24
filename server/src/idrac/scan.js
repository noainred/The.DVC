/**
 * Scan an IP range for Dell iDRACs. Expands the IP list, probes each address'
 * Redfish endpoint with the given credentials (bounded concurrency + short
 * timeout), and returns only the confirmed iDRACs with their identity.
 */

import { expandIpList } from './iprange.js';
import { probeIdrac } from './redfish.js';

export async function scanForIdracs({ ips, username, password, concurrency = 32, perHostTimeout = 3000, max = 2048, onProgress = null }) {
  const { ips: list, errors, truncated } = expandIpList(ips);
  const targets = list.slice(0, max);

  const found = [];
  let unreachable = 0, notIdrac = 0, authFailed = 0;
  let idx = 0;
  let done = 0;
  // 진행률 콜백(스로틀): 너무 잦은 호출을 피하려 일정 개수마다만 보고.
  const total = targets.length;
  const step = Math.max(1, Math.floor(total / 100)); // 약 1%마다
  const report = () => { if (onProgress) { try { onProgress(done, total); } catch { /* ignore */ } } };

  async function worker() {
    while (idx < targets.length) {
      const ip = targets[idx++];
      const r = await probeIdrac(ip, username, password, perHostTimeout);
      if (!r.ok) unreachable++;
      else if (r.authFailed) authFailed++;
      else if (r.isIdrac) found.push({ ip, serviceTag: r.serviceTag || '', model: r.model || '', manufacturer: r.manufacturer || '', hostName: r.hostName || '' });
      else notIdrac++;
      done++;
      if (done % step === 0) report();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, targets.length || 1) }, worker);
  await Promise.all(workers);
  report(); // 최종 100%

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
