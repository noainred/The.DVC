/**
 * In-memory state for distributed collection on the CENTRAL portal: the merged
 * host→power map pulled from remote collector agents, plus per-collector status.
 * Kept dependency-free to avoid import cycles (service.js merges this in).
 */

const remoteByHost = new Map();   // hostLower -> { watts, ts, datacenter, collectorId, serverName, source }
const status = new Map();          // collectorId -> { at, ok, hosts, version, datacenter, error }

export function setRemoteHost(hostLower, sample) {
  remoteByHost.set(hostLower, sample);
}

export function remotePowerByHost() {
  return remoteByHost;
}

/** Drop remote hosts contributed by a collector before re-applying its export. */
export function clearCollectorHosts(collectorId) {
  for (const [k, v] of remoteByHost) if (v.collectorId === collectorId) remoteByHost.delete(k);
}

export function setCollectorStatus(collectorId, s) {
  status.set(collectorId, { at: Date.now(), ...s });
}

export function getCollectorStatus(collectorId) {
  return status.get(collectorId) || null;
}

export function allCollectorStatus() {
  return Object.fromEntries(status);
}
