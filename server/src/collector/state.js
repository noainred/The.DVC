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

/** 등록되지 않은(제거된) 수집서버가 남긴 원격 호스트를 제거 — 전력 보고 수의 유령 항목 정리.
 *  activeCollectorIds(Set)에 없는 collectorId의 호스트를 비운다. 제거 수 반환. */
export function clearStaleRemote(activeCollectorIds) {
  let removed = 0;
  for (const [k, v] of remoteByHost) {
    if (!activeCollectorIds.has(v.collectorId)) { remoteByHost.delete(k); status.delete(v.collectorId); removed++; }
  }
  return removed;
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
